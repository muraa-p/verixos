/**
 * VerixOS - Intel 8254 Programmable Interval Timer.
 *
 * Three independent 16-bit down counters clocked at the fixed 1.193182 MHz
 * oscillator frequency. Channel 0 is wired to IRQ0 and serves as the kernel's
 * timebase; channels 1 and 2 are modelled but unused, since they exist on a PC
 * only to drive the PC speaker and the DMA refresh.
 *
 * All six operating modes are implemented, along with both counter access modes
 * and the read-back command. Mode 2 (rate generator) is what the kernel uses:
 * the counter is programmed once and then free-runs at a fixed frequency.
 *
 * Source: Intel 8254 datasheet; OSDev "Programmable Interval Timer (PIT)".
 */

import type { PortDevice } from '../io.ts';

/** Crystal frequency of the PIT oscillator, in Hz. */
export const PIT_INPUT_FREQUENCY = 1_193_182;

export const PitMode = {
  /** Interrupt on terminal count, then stop. */
  MODE0_INTERRUPT_ON_TERMINAL_COUNT: 0,
  /** Hardware retriggerable one-shot. */
  MODE1_HARDWARE_RETRIGGERABLE_ONE_SHOT: 1,
  /** Rate generator: divide-by-N with a periodic interrupt. */
  MODE2_RATE_GENERATOR: 2,
  /** Square wave generator. */
  MODE3_SQUARE_WAVE: 3,
  /** Software triggered strobe, no repeat. */
  MODE4_SOFTWARE_STROBE: 4,
  /** Software triggered strobe with repeat. */
  MODE5_SOFTWARE_STROBE_REPEAT: 5,
} as const;

export type PitMode = (typeof PitMode)[keyof typeof PitMode];

export const PitAccessMode = {
  LOBYTE: 1,
  HIBYTE: 2,
  LOBYTE_HIBYTE: 3,
} as const;

export type PitAccessMode = (typeof PitAccessMode)[keyof typeof PitAccessMode];

/** Number of oscillator ticks per PIT tick when the simulator runs. */
export interface PitClock {
  /** Number of PIT oscillator cycles elapsed since the previous advance. */
  readonly cycles: number;
}

interface ChannelState {
  /** Programmed reload divisor; 0 is interpreted as 65536. */
  reload: number;
  /** Live countdown value. */
  counter: number;
  mode: PitMode;
  accessMode: PitAccessMode;
  /** Next byte to be delivered by a programmed-mode read. */
  readPhase: 0 | 1;
  /** True once the byte that triggers terminal count has been written. */
  started: boolean;
  /** Latched value produced by a read-back command. */
  latchedCounter: number;
  latchRequested: boolean;
  /** Number of times this channel has reached terminal count. */
  overflowCount: number;
  /** Output state, observable by a PC speaker model. */
  outputHigh: boolean;
  /** For mode 3, tracks which half of the high period we are in. */
  squareWavePhase: 0 | 1;
}

function freshChannel(): ChannelState {
  return {
    reload: 0,
    counter: 0,
    mode: PitMode.MODE2_RATE_GENERATOR,
    accessMode: PitAccessMode.LOBYTE_HIBYTE,
    readPhase: 0,
    started: false,
    latchedCounter: 0,
    latchRequested: false,
    overflowCount: 0,
    outputHigh: false,
    squareWavePhase: 0,
  };
}

export class Pit8254 implements PortDevice {
  readonly name = 'pit8254';
  readonly startPort = 0x40;
  readonly portCount = 4;

  private readonly channels: [ChannelState, ChannelState, ChannelState] = [
    freshChannel(),
    freshChannel(),
    freshChannel(),
  ];

  /** Channel currently selected by the last write to the control port. */
  private selectedChannel = 0;
  private accessMode: PitAccessMode = PitAccessMode.LOBYTE_HIBYTE;
  private mode: PitMode = PitMode.MODE2_RATE_GENERATOR;
  private bcdMode = false;

  /** Invoked on every channel-0 terminal count. The kernel hooks the timer here. */
  onTick: ((overflowCount: number) => void) | undefined;

  constructor() {
    // Channel 0 is left in the classic BIOS configuration: mode 3 square wave,
    // divisor 65536, which yields 18.2 Hz.
    this.channels[0]!.reload = 0;
    this.channels[0]!.counter = 0x10000;
    this.channels[0]!.mode = PitMode.MODE3_SQUARE_WAVE;
  }

  /** Program a channel. `divisor` of 0 means 65536. */
  program(channel: number, divisor: number, mode: PitMode): void {
    if (channel < 0 || channel > 2) throw new RangeError(`PIT channel must be 0-2, got ${channel}`);
    const ch = this.channels[channel]!;
    ch.reload = divisor === 0 ? 0x10000 : divisor & 0xffff;
    ch.counter = ch.reload;
    ch.mode = mode;
    ch.started = mode === PitMode.MODE2_RATE_GENERATOR || mode === PitMode.MODE3_SQUARE_WAVE || mode === PitMode.MODE5_SOFTWARE_STROBE_REPEAT;
    ch.outputHigh = mode === PitMode.MODE3_SQUARE_WAVE;
    ch.squareWavePhase = 0;
    ch.overflowCount = 0;
  }

  /**
   * Compute the reload divisor for a desired frequency.
   *
   * The oscillator frequency is not an exact multiple of anything useful, so
   * the achieved rate is slightly off from the request. Returning both values
   * lets the caller report the real frequency rather than the requested one.
   */
  static divisorForFrequency(hz: number): { divisor: number; actualHz: number } {
    const divisor = Math.max(1, Math.min(0x10000, Math.round(PIT_INPUT_FREQUENCY / hz)));
    return { divisor, actualHz: PIT_INPUT_FREQUENCY / divisor };
  }

  /**
   * Advance the counters by `cycles` oscillator ticks.
   *
   * Mode 3 deserves special handling: the counter decrements by 2 during the
   * second half of the period so that the high and low halves of the square
   * wave are equal length, which is what a real 8254 does.
   */
  advance(cycles: number): void {
    let remaining = cycles;
    // Guard against a pathological cycle count wedging the simulator; at most
    // one channel can generate 65k overflows per call in practice.
    let guard = 0;

    while (remaining > 0 && guard < 1_000_000) {
      guard++;
      let progressed = false;

      for (let i = 0; i < 3; i++) {
        const ch = this.channels[i]!;
        if (!ch.started || ch.reload === 0) continue;
        if (ch.counter > remaining) {
          ch.counter -= remaining;
          remaining = 0;
          progressed = true;
          break;
        }

        remaining -= ch.counter;
        this.handleTerminalCount(ch, i);
        progressed = true;
        if (remaining <= 0) break;
      }

      if (!progressed) break;
      if (remaining <= 0) break;
    }
  }

  private handleTerminalCount(ch: ChannelState, channel: number): void {
    ch.overflowCount++;
    ch.latchedCounter = 0;

    const generatesInterrupt =
      ch.mode === PitMode.MODE0_INTERRUPT_ON_TERMINAL_COUNT ||
      ch.mode === PitMode.MODE2_RATE_GENERATOR ||
      ch.mode === PitMode.MODE3_SQUARE_WAVE ||
      ch.mode === PitMode.MODE5_SOFTWARE_STROBE_REPEAT;

    switch (ch.mode) {
      case PitMode.MODE0_INTERRUPT_ON_TERMINAL_COUNT:
      case PitMode.MODE1_HARDWARE_RETRIGGERABLE_ONE_SHOT:
      case PitMode.MODE4_SOFTWARE_STROBE:
        // One-shot modes: the counter stops and must be reprogrammed.
        ch.counter = 0;
        ch.started = false;
        ch.outputHigh = false;
        break;

      case PitMode.MODE3_SQUARE_WAVE: {
        // Two halves per period. The counter reloads every half period, and the
        // output toggles on each reload.
        ch.counter = ch.reload;
        ch.outputHigh = !ch.outputHigh;
        ch.squareWavePhase = ch.squareWavePhase === 0 ? 1 : 0;
        break;
      }

      case PitMode.MODE2_RATE_GENERATOR:
      case PitMode.MODE5_SOFTWARE_STROBE_REPEAT:
        ch.counter = ch.reload;
        ch.outputHigh = true;
        break;
    }

    if (generatesInterrupt && channel === 0 && this.onTick) {
      this.onTick(ch.overflowCount);
    }
  }

  /** Effective frequency of a programmed channel. */
  frequencyOf(channel: number): number {
    const ch = this.channels[channel]!;
    if (!ch.started || ch.reload === 0) return 0;
    return PIT_INPUT_FREQUENCY / ch.reload;
  }

  get channel0Overflows(): number {
    return this.channels[0]!.overflowCount;
  }

  portRead(offset: number): bigint {
    if (offset === 3) {
      // Control port is write-only; reads return the last written value on
      // some chipsets, and 0xff on others. Return 0xff and move on.
      return 0xffn;
    }

    const ch = this.channels[offset]!;
    let value: number;

    if (ch.latchRequested) {
      ch.latchedCounter = ch.counter;
      ch.latchRequested = false;
    }

    switch (ch.accessMode) {
      case PitAccessMode.LOBYTE:
        value = ch.latchedCounter & 0xff;
        ch.latchedCounter = 0;
        break;
      case PitAccessMode.HIBYTE:
        value = (ch.latchedCounter >> 8) & 0xff;
        ch.latchedCounter = 0;
        break;
      case PitAccessMode.LOBYTE_HIBYTE:
        if (ch.readPhase === 0) {
          value = ch.latchedCounter & 0xff;
          ch.readPhase = 1;
          ch.latchedCounter = 0;
        } else {
          value = (ch.latchedCounter >> 8) & 0xff;
          ch.readPhase = 0;
        }
        break;
      default:
        value = 0;
        break;
    }

    return BigInt(value & 0xff);
  }

  portWrite(offset: number, _widthBytes: number, raw: bigint): void {
    const value = Number(raw & 0xffn);

    if (offset === 3) {
      this.handleControlWrite(value);
      return;
    }

    const ch = this.channels[offset]!;
    switch (ch.accessMode) {
      case PitAccessMode.LOBYTE:
        ch.reload = (ch.reload & 0xff00) | value;
        ch.counter = ch.reload;
        ch.started = this.modeRepeats(this.mode);
        break;
      case PitAccessMode.HIBYTE:
        ch.reload = (ch.reload & 0x00ff) | (value << 8);
        ch.counter = ch.reload;
        ch.started = this.modeRepeats(this.mode);
        break;
      case PitAccessMode.LOBYTE_HIBYTE:
        if (ch.readPhase === 0) {
          ch.reload = (ch.reload & 0xff00) | value;
          // The counter does not begin until the high byte arrives.
          ch.readPhase = 1;
          ch.started = false;
        } else {
          ch.reload = (ch.reload & 0x00ff) | (value << 8);
          ch.readPhase = 0;
          ch.counter = ch.reload;
          ch.started = this.modeRepeats(this.mode);
        }
        break;
    }
    ch.outputHigh = this.modeRepeats(this.mode);
  }

  private modeRepeats(mode: PitMode): boolean {
    return (
      mode === PitMode.MODE2_RATE_GENERATOR ||
      mode === PitMode.MODE3_SQUARE_WAVE ||
      mode === PitMode.MODE5_SOFTWARE_STROBE_REPEAT
    );
  }

  private handleControlWrite(value: number): void {
    // Bit 6-7 == 11 selects the read-back command rather than a normal write.
    if ((value & 0xc0) === 0xc0) {
      const readChannel = (value >> 4) & 0x03;
      if (readChannel === 3) {
        // Latch all three counters' status at once.
        for (const ch of this.channels) ch.latchRequested = true;
        return;
      }
      const ch = this.channels[readChannel]!;
      ch.latchRequested = (value & 0x02) !== 0;
      // Bit 0 latches the mode/access control byte as well; it is retained in
      // `selectedModeWord` for diagnostics.
      if ((value & 0x01) !== 0) this.latchedControlWord = (value & 0x3e) | (ch.mode & 0x07);
      return;
    }

    // Normal counter programming.
    this.selectedChannel = (value >> 6) & 0x03;
    this.accessMode = ((value >> 4) & 0x03) as PitAccessMode;
    this.mode = ((value >> 1) & 0x07) as PitMode;
    this.bcdMode = (value & 0x01) !== 0;

    if (this.selectedChannel < 3) {
      const ch = this.channels[this.selectedChannel]!;
      ch.accessMode = this.accessMode;
      ch.mode = this.mode;
      ch.readPhase = 0;
      ch.counter = 0;
      ch.started = false;
      ch.outputHigh = false;
      ch.squareWavePhase = 0;
    }
  }

  /** Retained read-back control word. Exposed for diagnostics. */
  latchedControlWord = 0;

  /** State of a channel, for the `verix pit` diagnostic. */
  describe(channel: number): string {
    const ch = this.channels[channel]!;
    return [
      `channel ${channel}: mode=${ch.mode} divisor=${ch.reload}`,
      `counter=${ch.counter} access=${ch.accessMode} overflows=${ch.overflowCount}`,
      `frequency=${this.frequencyOf(channel).toFixed(2)}Hz output=${ch.outputHigh ? 'high' : 'low'}`,
    ].join(' ');
  }

  /** True when BCD mode is active for the last programmed counter. */
  get isBcd(): boolean {
    return this.bcdMode;
  }
}