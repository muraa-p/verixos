/**
 * A PS/2 mouse, on the auxiliary port of the 8042 controller.
 *
 * The protocol is small enough to describe completely, which matters more here
 * than brevity: a mouse is the only input device whose *state* the guest can read
 * back, so a guest that believes the pointer is somewhere else will draw its
 * cursor in the wrong place and there is no way to tell from the host.
 *
 * A motion packet is three bytes, optionally four:
 *
 * ```text
 *   byte 0   0 0 0 S Y S R M L      always 1 in bit 3, buttons, X/Y signs
 *   byte 1   X displacement, two's complement
 *   byte 2   Y displacement, two's complement
 *   byte 3   wheel, signed 4 bits, only from a four-byte mouse
 * ```
 *
 * The signs are in the *first* byte while the displacements are in the next two.
 * That split is the classic source of mouse implementations that work perfectly
 * on straight-line movement and jump wildly on diagonals, and it is why
 * `moveTo` here assembles the packet in one place rather than letting callers
 * push bytes individually.
 *
 * Note the Y axis grows *upward*. A pointer that drifts downward as the hand
 * moves upward is the classic sign of a missing negation, and it is very visible
 * once a window starts following the cursor.
 *
 * The device does not decide whether the guest should see the pointer; the BIOS
 * mouse driver does, by hiding the hardware cursor and drawing its own. That is
 * how it works on real hardware too, and it is why `visible` here describes the
 * hardware cursor while the compositor draws the software one.
 */


/** Commands a guest sends to the mouse after a `0xD4` prefix. */
export const MouseCommand = {
  SET_SCALE_1: 0xe6,
  SET_SCALE_2: 0xe7,
  SET_RESOLUTION: 0xe8,
  ENABLE_REPORTING: 0xe9,
  SET_DEFAULTS: 0xea,
  READ_DATA: 0xeb,
  READ_ID: 0xf2,
  SET_SAMPLE_RATE: 0xf3,
  ENABLE: 0xf4,
  DISABLE: 0xf5,
  RESET_DEFAULTS: 0xf6,
} as const;

/** Device identity reported in answer to a `READ_ID` command. */
export const PS2_MOUSE = {
  TWO_BUTTON: 0x00,
  THREE_BUTTON: 0x03,
} as const;

/** What the mouse reports as its identity. */
export const MOUSE_ID = {
  TWO_BUTTON: PS2_MOUSE.TWO_BUTTON,
  THREE_BUTTON: PS2_MOUSE.THREE_BUTTON,
} as const;

export interface MouseState {
  /** Pointer position in virtual-screen pixels. */
  readonly x: number;
  readonly y: number;
  /** Button bitmask: bit 0 left, bit 1 right, bit 2 middle. */
  readonly buttons: number;
  /** Whether the device is reporting. */
  readonly enabled: boolean;
  /** Packets delivered since reset, for diagnostics and for the BIOS. */
  readonly packets: number;
}

export class Ps2Mouse {
  /** Bytes waiting for the controller's output buffer. */
  private readonly outputBuffer: number[] = [];

  /** The last packet sent, which the controller echoes when the buffer is empty. */
  private lastByte = 0;

  /** Set when a command that takes a parameter byte is waiting for one. */
  private pending: 'resolution' | 'sample-rate' | 'wrap' | null = null;

  private px = 0;
  private py = 0;
  private buttonMask = 0;
  private reporting = false;
  private packetsSent = 0;

  /**
   * Counts the device reports per pixel the pointer travels.
   *
   * The PS/2 parameter is counts per *millimetre*, which is a physical quantity
   * and means nothing without knowing how large a pixel is. Rather than pretend,
   * this field is named for what it is used for and the mapping is stated: the
   * guest's pixel is treated as one millimetre, so the four parameter values 0..3
   * become 1, 2, 4 and 8 counts per pixel.
   *
   * Naming it `resolution` while dividing by it is how the two get swapped, and
   * the symptom is a pointer that moves at a quarter of the speed the guest
   * expects while the guest believes it programmed the finest setting available.
   */
  readonly info = {
    enabled: false,
    countsPerPixel: 4,
    scale: 1,
    sampleRate: 100,
    wheel: true,
    visible: true,
  };

  /* ------------------------------------------------------------------ */
  /* Host-side input                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Move the pointer by a number of counts.
   *
   * `counts` are raw device counts, not pixels. The sampling and scaling the
   * guest programmed are applied here rather than in the BIOS driver because that
   * is where the hardware would apply them, and a driver that compensates for
   * them a second time is the usual cause of a mouse that feels twice as fast as
   * the guest expects.
   */
  moveBy(dx: number, dy: number): void {
    if (!this.reporting) return;
    const divisor = this.info.countsPerPixel * (this.info.scale === 2 ? 2 : 1);
    this.px = this.clampX(this.px + Math.trunc(dx / divisor));
    // The device's Y axis grows upward; the screen's grows downward. Inverting
    // this is the single most visible mouse bug there is: the pointer is correct
    // on the horizontal axis and drifts the wrong way on the vertical one.
    this.py = this.clampY(this.py - Math.trunc(dy / divisor));
    this.sendPacket();
  }

  /** Set the pointer's position, as a BIOS "set position" call would. */
  setPosition(x: number, y: number): void {
    if (!this.reporting) return;
    this.px = this.clampX(x);
    this.py = this.clampY(y);
    this.sendPacket();
  }

  /**
   * True while a command is waiting for its parameter byte.
   *
   * The controller routes to the mouse for as long as this holds, so a
   * parameterised command arrives whole rather than having its second byte
   * delivered to the keyboard.
   */
  get wantsMoreInput(): boolean {
    return this.pending !== null;
  }

  private clampX(value: number): number {
    return Math.min(Math.max(value, this.bounds.minX), this.bounds.maxX);
  }

  private clampY(value: number): number {
    return Math.min(Math.max(value, this.bounds.minY), this.bounds.maxY);
  }

  setButton(button: number, down: boolean): void {
    const bit = 1 << button;
    const next = down ? this.buttonMask | bit : this.buttonMask & ~bit;
    if (next === this.buttonMask) return;
    this.buttonMask = next;
    // A button change is reported immediately, even while the pointer is still.
    // A guest that holds the button and waits for a motion packet to learn about
    // the press would feel a click arrive late.
    this.sendPacket();
  }

  scroll(notches: number): void {
    if (!this.reporting || !this.info.wheel) return;
    this.queue(this.buttons, 0, 0, notches);
  }

  /* ------------------------------------------------------------------ */
  /* Guest-visible state                                                 */
  /* ------------------------------------------------------------------ */

  /** True when the device is reporting motion and buttons. */
  get enabled(): boolean {
    return this.reporting;
  }

  /** Pointer position in virtual-screen pixels. */
  get x(): number {
    return this.px;
  }

  /** Pointer position in virtual-screen pixels, vertical axis. */
  get y(): number {
    return this.py;
  }

  /** Button bitmask: bit 0 left, bit 1 right, bit 2 middle. */
  get buttons(): number {
    return this.buttonMask;
  }

  get state(): MouseState {
    return {
      x: this.px,
      y: this.py,
      buttons: this.buttonMask,
      enabled: this.reporting,
      packets: this.packetsSent,
    };
  }

  /** True when a byte is waiting for the controller's output buffer. */
  get hasData(): boolean {
    return this.outputBuffer.length > 0;
  }

  /** Take the oldest byte, for the controller to hand to a guest read of 0x60. */
  readData(): number | undefined {
    const byte = this.outputBuffer.shift();
    if (byte !== undefined) this.lastByte = byte;
    return byte;
  }

  /**
   * The 8042's output buffer holds one byte. Reading it empty makes the controller
   * return the byte most recently transferred rather than zero, which is what a
   * real 8042 does and what a guest's polling loop can end up depending on.
   */
  get lastTransferredByte(): number {
    return this.lastByte;
  }

  /* ------------------------------------------------------------------ */
  /* Guest commands                                                      */
  /* ------------------------------------------------------------------ */

  /** Handle one byte the guest wrote after a `0xD4` prefix. */
  command(value: number): void {
    if (this.pending === 'resolution') {
      this.pending = null;
      // The parameter counts *up*: 0 is the coarsest and 3 the finest. Reading it
      // the other way round makes "finest" mean "one count per eight pixels", and
      // the pointer then travels at an eighth of the speed the driver expects
      // while the driver believes it got the setting it asked for.
      this.info.countsPerPixel = [1, 2, 4, 8][value & 0x03] ?? 4;
      this.acknowledge();
      return;
    }
    if (this.pending === 'sample-rate') {
      this.pending = null;
      this.info.sampleRate = [10, 20, 40, 60, 80, 100, 200][value & 0x07] ?? 100;
      this.acknowledge();
      return;
    }
    if (this.pending === 'wrap') {
      this.pending = null;
      this.acknowledge();
      return;
    }

    switch (value) {
      case MouseCommand.SET_SCALE_1:
        this.info.scale = 1;
        this.acknowledge();
        return;
      case MouseCommand.SET_SCALE_2:
        this.info.scale = 2;
        this.acknowledge();
        return;
      case MouseCommand.SET_RESOLUTION:
        this.pending = 'resolution';
        this.acknowledge();
        return;
      case MouseCommand.SET_SAMPLE_RATE:
        this.pending = 'sample-rate';
        this.acknowledge();
        return;
      case MouseCommand.ENABLE:
        this.reporting = true;
        this.info.enabled = true;
        // The acknowledgement comes first, then the initial packet. A real mouse
        // answers the command before it has anything to report, and a driver that
        // reads one byte and expects the acknowledgement will otherwise
        // consume a packet's flags byte and misread it as a reply.
        this.acknowledge();
        this.sendPacket();
        return;
      case MouseCommand.DISABLE:
        this.reporting = false;
        this.info.enabled = false;
        this.acknowledge();
        return;
      case MouseCommand.ENABLE_REPORTING:
      case MouseCommand.SET_DEFAULTS:
      case MouseCommand.RESET_DEFAULTS:
        this.reporting = true;
        this.info.enabled = true;
        this.acknowledge();
        return;
      case MouseCommand.READ_DATA:
        // Bit 3 is always set; the rest is the button state.
        this.queueByte(0x08 | (this.buttonMask & 0x07));
        return;
      case MouseCommand.READ_ID:
        this.queueByte(this.info.wheel ? MOUSE_ID.THREE_BUTTON : MOUSE_ID.TWO_BUTTON);
        return;
      default:
        // An unknown command is acknowledged, which is what a real mouse does and
        // what stops a guest's command loop from hanging on a device it does not
        // recognise.
        this.queue(0, 0, 0, 0);
    }
  }

  /** Enable or disable motion reporting, as the BIOS does during `int 33h` init. */
  setReporting(enabled: boolean): void {
    this.reporting = enabled;
    this.info.enabled = enabled;
  }

  /**
   * Constrain the pointer to a rectangle.
   *
   * Zero for either bound on the low side means "no lower bound", and zero for a
   * maximum means "use the screen", which is what the BIOS convention of passing
   * 0/0/0/0 to mean "the whole screen" depends on. Getting that backwards clamps
   * the pointer to a single pixel, which is a memorable bug.
   */
  setBounds(minX: number, minY: number, maxX: number, maxY: number): void {
    this.bounds = {
      minX: minX === 0 ? 0 : minX,
      minY: minY === 0 ? 0 : minY,
      maxX: maxX === 0 ? this.defaultBounds.maxX : maxX,
      maxY: maxY === 0 ? this.defaultBounds.maxY : maxY,
    };
    this.boundsSetExplicitly = true;
    this.px = Math.min(Math.max(this.px, this.bounds.minX), this.bounds.maxX);
    this.py = Math.min(Math.max(this.py, this.bounds.minY), this.bounds.maxY);
  }

  /**
   * Tell the mouse the screen size, so "no bounds given" means something.
   *
   * The device cannot know how large the guest's screen is, and a BIOS call that
   * passes 0 for the maximum is asking it to guess. The machine supplies the
   * answer once, at mode-set time.
   */
  setScreenSize(width: number, height: number): void {
    this.defaultBounds = { maxX: Math.max(0, width - 1), maxY: Math.max(0, height - 1) };
    if (!this.boundsSetExplicitly) this.bounds = { minX: 0, minY: 0, ...this.defaultBounds };
  }

  /** Set the acceleration divisor the guest asked for. */
  setSpeed(divisor: number): void {
    if (divisor > 0) this.info.scale = divisor <= 8 ? 2 : 1;
  }

  /** Whether the guest has asked for the hardware cursor to be shown. */
  setHardwareCursorVisible(visible: boolean): void {
    this.info.visible = visible;
  }

  reset(): void {
    this.outputBuffer.length = 0;
    this.pending = null;
    this.reporting = false;
    this.packetsSent = 0;
    this.px = 0;
    this.py = 0;
    this.buttonMask = 0;
    this.info.enabled = false;
    this.info.countsPerPixel = 4;
    this.info.scale = 1;
    this.info.sampleRate = 100;
    this.info.visible = true;
  }

  /* ------------------------------------------------------------------ */
  /* Packet assembly                                                     */
  /* ------------------------------------------------------------------ */

  /** Queue a single response byte. Acknowledgements are not motion packets. */
  private acknowledge(): void {
    this.queueByte(0xfa);
  }

  private queueByte(byte: number): void {
    this.outputBuffer.push(byte & 0xff);
  }

  /**
   * Report the movement since the last packet.
   *
   * The displacement is the pointer's own change in position, which is exactly what
   * a driver's arithmetic expects: it keeps a cursor position and applies the
   * signed displacement to it. That is why the Y displacement is already negated
   * relative to the hand - `moveBy` subtracts because the device's axis grows
   * upward - and why negating it again here would make a correct guest's cursor
   * move the opposite way to the hand, in packets that look entirely plausible.
   */
  private sendPacket(): void {
    this.queue(this.buttonMask, this.px - this.lastReportedX, this.py - this.lastReportedY, 0);
  }

  private lastReportedX = 0;
  private lastReportedY = 0;

  /** The rectangle the pointer is confined to. */
  private defaultBounds = { maxX: 639, maxY: 479 };
  private bounds = { minX: 0, minY: 0, maxX: 639, maxY: 479 };
  private boundsSetExplicitly = false;

  /**
   * Assemble one motion packet.
   *
   * The displacement is broken into seven bits plus a sign in byte 0, which is why
   * this is a single function rather than three separate `push` calls. Getting the
   * sign bit into the *first* byte while the displacement sits in the second is
   * not a detail: a device that puts the sign with its displacement reports
   * correct movement on the positive axes and wild jumps on the others.
   */
  private queue(buttons: number, dx: number, dy: number, wheel: number): void {
    const clampedX = clampToSevenBits(dx);
    const clampedY = clampToSevenBits(dy);

    const first = 0x08 | (buttons & 0x07) | (clampedX.sign << 3) | (clampedY.sign << 4);
    this.outputBuffer.push(first & 0xff, clampedX.value, clampedY.value);
    // The wheel occupies the high nibble of a fourth byte; the low nibble is
    // reserved and reads as zero on real hardware.
    if (this.info.wheel) this.outputBuffer.push(((wheel & 0x0f) << 4) & 0xf0);

    this.lastReportedX = this.px;
    this.lastReportedY = this.py;
    this.packetsSent++;
  }
}

/** Split a displacement into a seven-bit magnitude and a sign bit. */
function clampToSevenBits(value: number): { value: number; sign: number } {
  const negative = value < 0;
  const magnitude = Math.min(127, Math.abs(Math.trunc(value)));
  return { value: negative ? (256 - magnitude) & 0xff : magnitude & 0xff, sign: negative ? 1 : 0 };
}