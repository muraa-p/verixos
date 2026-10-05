/**
 * VerixOS - 16550-compatible UART (serial communications controller).
 *
 * Modelled at the register level: the divisor latch, interrupt enable and
 * identification registers, line control and modem control, and both status
 * registers. Byte-level framing is intentionally not simulated, because no
 * VerixOS driver programs the divisor for anything other than the 115200 8N1
 * configuration the host console already uses, and modelling bit timing would
 * add cost without adding fidelity where it matters.
 *
 * The device is bidirectional with respect to the host: transmitted bytes are
 * handed to a sink callback, and received bytes are pushed in by the host.
 * That keeps the simulator free to interleave console output with simulated
 * time, which is the whole point of running an OS deterministically.
 *
 * Source: National Semiconductor PC16550D datasheet, Section 2.
 */

/** Register offsets within the 8-byte UART register file. */
export const UartRegister = {
  /** Receive Buffer Register (read) / Transmit Holding Register (write). */
  RBR_THR: 0,
  /** Interrupt Enable Register (DLAB=0) / Divisor Latch Low (DLAB=1). */
  IER_DLL: 1,
  /** Interrupt Identification Register (read) / FIFO Control Register (write). */
  IIR_FCR: 2,
  /** Line Control Register. */
  LCR: 3,
  /** Modem Control Register. */
  MCR: 4,
  /** Line Status Register. */
  LSR: 5,
  /** Modem Status Register. */
  MSR: 6,
  /** Scratch Register. */
  SCR: 7,
} as const;

/** LSR bits. Source: 16550D datasheet, Table 3. */
export const LsrBit = {
  /** Data Ready: a received byte is waiting in the RBR. */
  DATA_READY: 1 << 0,
  OVERRUN_ERROR: 1 << 1,
  PARITY_ERROR: 1 << 2,
  FRAMING_ERROR: 1 << 3,
  BREAK_INTERRUPT: 1 << 4,
  /** Transmit Holding Register Empty. */
  THR_EMPTY: 1 << 5,
  /** Transmitter completely empty (shift register drained too). */
  TRANSMITTER_EMPTY: 1 << 6,
} as const;

/** IIR interrupt identification values. */
export const IirInterrupt = {
  MODEM_STATUS: 0x00,
  THR_EMPTY: 0x02,
  RECEIVE_DATA_AVAILABLE: 0x04,
  RECEIVER_LINE_STATUS: 0x06,
  CHARACTER_TIMEOUT: 0x0c,
  NONE: 0x01,
} as const;

export const IcrBit = {
  RECEIVE_DATA_AVAILABLE: 1 << 0,
  THR_EMPTY: 1 << 1,
  RECEIVER_LINE_STATUS: 1 << 2,
  MODEM_STATUS: 1 << 3,
} as const;

export interface UartOptions {
  readonly name?: string;
  readonly basePort: number;
  /** Baud rate the divisor latch is programmed to. Purely informational. */
  readonly baudRate?: number;
  /** Called with every byte the guest transmits. */
  readonly onTransmit?: (byte: number) => void;
  /** Called when a transmitted byte empties the THR and the interrupt is enabled. */
  readonly onTransmitEmpty?: () => void;
  /** Called when a byte is pushed into the receiver. */
  readonly onReceive?: (byte: number) => void;
}

export class Uart16550 {
  readonly name: string;
  readonly startPort: number;
  readonly portCount = 8;

  /** Receives bytes pushed from the host. */
  private readonly rxBuffer: number[] = [];

  private interruptEnabledValue = 0;
  private lcr = 0x03; // 8N1
  private mcr = 0;
  private fcr = 0;
  private scratch = 0;
  private divisorLow = 1;
  private divisorHigh = 0;

  private lsrValue = LsrBit.THR_EMPTY | LsrBit.TRANSMITTER_EMPTY;
  private msrValue = 0x30; // DSR and CTS asserted by default

  private readonly onTransmit: ((byte: number) => void) | undefined;
  private readonly onTransmitEmpty: (() => void) | undefined;
  private readonly onReceive: ((byte: number) => void) | undefined;

  /** Counters for the `verix uart` diagnostic. */
  bytesTransmitted = 0;
  bytesReceived = 0;

  constructor(options: UartOptions) {
    this.name = options.name ?? `uart16550@0x${options.basePort.toString(16)}`;
    this.startPort = options.basePort;
    this.onTransmit = options.onTransmit;
    this.onTransmitEmpty = options.onTransmitEmpty;
    this.onReceive = options.onReceive;
  }

  /** True when the divisor latch is being accessed rather than the FIFOs. */
  private get dlab(): boolean {
    return (this.lcr & 0x80) !== 0;
  }

  /** Push a byte from the host into the receiver. */
  pushInput(byte: number): void {
    this.rxBuffer.push(byte & 0xff);
    this.bytesReceived++;
    this.lsrValue |= LsrBit.DATA_READY;
    this.onReceive?.(byte & 0xff);
  }

  /** True when the guest can read a byte without blocking. */
  get hasInput(): boolean {
    return this.rxBuffer.length > 0;
  }

  portRead(offset: number): bigint {
    switch (offset) {
      case UartRegister.RBR_THR: {
        if (this.dlab) return BigInt(this.divisorLow & 0xff);
        const byte = this.rxBuffer.shift();
        if (byte === undefined) return 0n;
        if (this.rxBuffer.length === 0) this.lsrValue &= ~LsrBit.DATA_READY;
        return BigInt(byte);
      }
      case UartRegister.IER_DLL: {
        if (this.dlab) return BigInt(this.divisorHigh & 0xff);
        return BigInt(this.interruptEnabledValue & 0x0f);
      }
      case UartRegister.IIR_FCR:
        return BigInt(this.currentIir());
      case UartRegister.LCR:
        return BigInt(this.lcr & 0xff);
      case UartRegister.MCR:
        return BigInt(this.mcr & 0xff);
      case UartRegister.LSR:
        return BigInt(this.lsrValue & 0xff);
      case UartRegister.MSR:
        return BigInt(this.msrValue & 0xff);
      case UartRegister.SCR:
        return BigInt(this.scratch & 0xff);
      default:
        return 0n;
    }
  }

  /**
   * Interrupt Identification Register.
   *
   * The register encodes the highest-priority pending interrupt with a 0 bit
   * and no interrupt with a 1 bit. Priority runs from receiver line status
   * (highest) down through received data, character timeout and THR empty
   * (lowest), which is the ordering a driver must respect when sharing an
   * interrupt line between causes.
   */
  private currentIir(): number {
    const pending = this.interruptEnabledValue & this.lsrValue;
    if (pending & LsrBit.BREAK_INTERRUPT) return IirInterrupt.RECEIVER_LINE_STATUS;
    if (pending & LsrBit.OVERRUN_ERROR) return IirInterrupt.RECEIVER_LINE_STATUS;
    if (this.dlab) return IirInterrupt.NONE;
    if (pending & LsrBit.DATA_READY) {
      return IirInterrupt.RECEIVE_DATA_AVAILABLE | (this.fcr & 0x01 ? 0x40 : 0x00);
    }
    if (pending & LsrBit.THR_EMPTY) return IirInterrupt.THR_EMPTY;
    return IirInterrupt.NONE;
  }

  portWrite(offset: number, _widthBytes: number, raw: bigint): void {
    const value = Number(raw & 0xffn);
    switch (offset) {
      case UartRegister.RBR_THR: {
        if (this.dlab) {
          this.divisorLow = value;
          return;
        }
        this.bytesTransmitted++;
        this.onTransmit?.(value);
        // Writing the THR clears the THR-empty condition immediately.
        this.lsrValue |= LsrBit.THR_EMPTY;
        this.onTransmitEmpty?.();
        break;
      }
      case UartRegister.IER_DLL:
        if (this.dlab) this.divisorHigh = value;
        else this.interruptEnabledValue = value & 0x0f;
        break;
      case UartRegister.IIR_FCR:
        // Writing bit 0 clears the receiver FIFO; bit 1 clears the transmit FIFO.
        if ((value & 0x02) !== 0) {
          this.rxBuffer.length = 0;
          this.lsrValue &= ~LsrBit.DATA_READY;
        }
        this.fcr = value;
        break;
      case UartRegister.LCR:
        this.lcr = value;
        break;
      case UartRegister.MCR:
        this.mcr = value & 0x1f;
        break;
      case UartRegister.LSR:
        // LSR bits 0-4 are cleared by writing a 1 to them (W1C).
        this.lsrValue &= ~(value & 0x1f);
        break;
      case UartRegister.MSR:
        // High bits of MSR are W1C as well.
        this.msrValue &= value | 0xf0;
        break;
      case UartRegister.SCR:
        this.scratch = value;
        break;
      default:
        break;
    }
  }

  /** Apply a modem line-state change, for hosts that model carrier detect. */
  setModemStatus(value: number): void {
    // Lower nibble of MSR reflects high nibble; set delta bits on change.
    const previous = this.msrValue & 0x0f;
    const delta = (value & 0x0f) ^ previous;
    this.msrValue = (value & 0xf0) | (this.msrValue & 0xf0) | delta;
  }

  /** IRQ line number for this UART when interrupts are enabled. */
  get irq(): number {
    return this.name.includes('0x3f8') ? 4 : 3;
  }

  get interruptEnabledMask(): number {
    return this.interruptEnabledValue;
  }

  set interruptEnabledMask(v: number) {
    this.interruptEnabledValue = v & 0x0f;
  }

  describe(): string {
    return [
      `${this.name}: divisor=${((this.divisorHigh << 8) | this.divisorLow) >>> 0}`,
      `lcr=0x${this.lcr.toString(16)} mcr=0x${this.mcr.toString(16)} ier=0x${this.interruptEnabledValue.toString(16)}`,
      `lsr=0x${this.lsrValue.toString(16).padStart(2, '0')} tx=${this.bytesTransmitted} rx=${this.bytesReceived} pending=${this.rxBuffer.length}`,
    ].join('\n');
  }
}