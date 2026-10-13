/**
 * VerixOS - 8042 PS/2 controller and keyboard.
 *
 * Models the controller's two ports (0x60 data, 0x64 status/command), the
 * keyboard command set, and scan code set 1 with the extended (E0) prefix.
 *
 * Scan code set 1 is used rather than set 2 because set 1 is what the 8042
 * translates to when translation is enabled, which is the default state after
 * `0xF6 Set Default`. Set 1 distinguishes make codes (key pressed) from break
 * codes (key released) by the high bit of the scan code.
 *
 * Source: IBM 8042 Technical Reference, OSDev "PS/2 Keyboard".
 */

/** 8042 status register bits (port 0x64). */
export const Ps2Status = {
  /** Output buffer full: a byte is waiting for the host to read at 0x60. */
  OUTPUT_BUFFER_FULL: 1 << 0,
  /** Input buffer full: the controller has not yet consumed the host's byte. */
  INPUT_BUFFER_FULL: 1 << 1,
  /** System flag: cleared by the host, set by the controller on system reset. */
  SYSTEM_FLAG: 1 << 2,
  /** 0 = the byte written to 0x60 was a command, 1 = it was data. */
  INPUT_BUFFER_COMMAND: 1 << 3,
  /** Keyboard inhibited. */
  KEYBOARD_INHIBIT: 1 << 4,
  /** 1 = the byte in the output buffer originated from the mouse. */
  AUX_DATA: 1 << 5,
  /** Translation enabled. */
  TRANSLATION: 1 << 6,
} as const;

/** 8042 commands (written to port 0x64). */
export const Ps2Command = {
  READ_FIRST_OB: 0x20,
  WRITE_INPUT_BUFFER: 0x60,
  DISABLE_SECOND_PORT: 0xa7,
  ENABLE_SECOND_PORT: 0xa8,
  READ_SECOND_OB: 0x20 | 0xa0,
  WRITE_SECOND_OB_INPUT: 0xd4,
  SELF_TEST: 0xaa,
  READ_INTERFACE_CONFIG: 0x20 | 0xa0,
  WRITE_INTERFACE_CONFIG: 0x60 | 0xa0,
} as const;

/** Keyboard commands (written to port 0x60). */
export const KeyboardCommand = {
  RESET: 0xff,
  SET_DEFAULTS: 0xf6,
  DISABLE_SCANNING: 0xf5,
  ENABLE_SCANNING: 0xf4,
  SET_TYPEMATIC: 0xf3,
  SET_LEDS: 0xed,
  ECHO: 0xee,
  GET_ID: 0xf2,
} as const;

/** Acknowledgement byte the keyboard returns for most commands. */
export const KEYBOARD_ACK = 0xfa;
/** Self-test pass and POST completion codes. */
export const KEYBOARD_SELF_TEST_PASS = 0xaa;

/**
 * Scan code set 1: make code per key. The extended (E0-prefixed) keys are in
 * `EXTENDED` and combine with the prefix.
 *
 * Source: OSDev "Scancode Set 1".
 */
export const ScanCode = {
  ESC: 0x01,
  ONE: 0x02,
  TWO: 0x03,
  THREE: 0x04,
  FOUR: 0x05,
  FIVE: 0x06,
  SIX: 0x07,
  SEVEN: 0x08,
  EIGHT: 0x09,
  NINE: 0x0a,
  ZERO: 0x0b,
  MINUS: 0x0c,
  EQUALS: 0x0d,
  BACKSPACE: 0x0e,
  TAB: 0x0f,
  Q: 0x10,
  W: 0x11,
  E: 0x12,
  R: 0x13,
  T: 0x14,
  Y: 0x15,
  U: 0x16,
  I: 0x17,
  O: 0x18,
  P: 0x19,
  LEFT_BRACKET: 0x1a,
  RIGHT_BRACKET: 0x1b,
  ENTER: 0x1c,
  LEFT_CTRL: 0x1d,
  A: 0x1e,
  S: 0x1f,
  D: 0x20,
  F: 0x21,
  G: 0x22,
  H: 0x23,
  J: 0x24,
  K: 0x25,
  L: 0x26,
  SEMICOLON: 0x27,
  APOSTROPHE: 0x28,
  GRAVE: 0x29,
  LEFT_SHIFT: 0x2a,
  BACKSLASH: 0x2b,
  Z: 0x2c,
  X: 0x2d,
  C: 0x2e,
  V: 0x2f,
  B: 0x30,
  N: 0x31,
  M: 0x32,
  COMMA: 0x33,
  PERIOD: 0x34,
  SLASH: 0x35,
  RIGHT_SHIFT: 0x36,
  NUMPAD_STAR: 0x37,
  LEFT_ALT: 0x38,
  SPACE: 0x39,
  CAPSLOCK: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NUMLOCK: 0x45,
  SCROLLLOCK: 0x46,
  NUMPAD_SEVEN: 0x47,
  NUMPAD_EIGHT: 0x48,
  NUMPAD_NINE: 0x49,
  NUMPAD_MINUS: 0x4a,
  NUMPAD_FOUR: 0x4b,
  NUMPAD_FIVE: 0x4c,
  NUMPAD_SIX: 0x4d,
  NUMPAD_PLUS: 0x4e,
  NUMPAD_ONE: 0x4f,
  NUMPAD_TWO: 0x50,
  NUMPAD_THREE: 0x51,
  NUMPAD_ZERO: 0x52,
  NUMPAD_PERIOD: 0x53,
  F11: 0x57,
  F12: 0x58,
  /** Set by the controller when a key is held long enough to repeat. */
  PRINT_SCREEN_MAKE: 0x2a,
} as const;

/** Scan codes that follow the 0xE0 extended prefix. */
export const ExtendedScanCode = {
  RIGHT_CTRL: 0x1d,
  RIGHT_ALT: 0x38,
  KEYPAD_ENTER: 0x1c,
  NUMPAD_DIVIDE: 0x35,
  HOME: 0x47,
  UP: 0x48,
  PAGE_UP: 0x49,
  LEFT: 0x4b,
  RIGHT: 0x4d,
  END: 0x4f,
  DOWN: 0x50,
  PAGE_DOWN: 0x51,
  INSERT: 0x52,
  DELETE: 0x53,
} as const;

/** Modifier byte layout used by the extended keys and by PS/2 mouse packets. */
export const Modifiers = {
  SHIFT: 1 << 0,
  RIGHT_SHIFT: 1 << 1,
  CTRL: 1 << 2,
  RIGHT_CTRL: 1 << 3,
  ALT: 1 << 4,
  RIGHT_ALT: 1 << 5,
} as const;

/** The BIOS keyboard ID the controller reports for a standard PS/2 keyboard. */
const DEFAULT_KEYBOARD_ID = [0xab, 0x83];

/** A decoded keyboard event, exposed to the driver layer. */
export interface KeyEvent {
  readonly makeCode: number;
  readonly breakCode: boolean;
  readonly extended: boolean;
}

/**
 * What the controller needs from the device on its auxiliary port.
 *
 * Deliberately narrow: the mouse never answers a port read itself. It hands over
 * bytes when it has them, and the controller decides which of them the guest gets,
 * because the output buffer holds one byte and both devices share it.
 */
export interface AuxPort {
  /** True when a byte is waiting. */
  readonly hasData: boolean;
  /** Take the oldest byte. */
  readData(): number | undefined;
  /** The most recent byte transferred, echoed when the buffer is empty. */
  readonly lastTransferredByte: number;
  /**
   * True while a command is still waiting for its parameter byte.
   *
   * Without this the controller cannot tell "the guest is sending the mouse's
   * resolution" from "the guest has finished and is talking to the keyboard", and
   * the second byte of every parameterised mouse command goes to the wrong device.
   */
  readonly wantsMoreInput: boolean;
  /** Handle a byte the guest wrote after a `0xD4` prefix. */
  command(value: number): void;
}

export class Ps2Keyboard {
  readonly name = 'ps2-keyboard';
  readonly startPort = 0x60;
  /**
   * 0x60 through 0x64.
   *
   * The controller's command register lives at 0x64, not 0x61, and a guest that
   * cannot reach it cannot drive the keyboard at all: enabling scanning is a write
   * of 0xF4 to the data port *followed by* 0xD4 to 0x64. Claiming two ports made
   * that second write fault, which is a #GP in the middle of boot for a device
   * that is perfectly present. The middle two are unimplemented and answer as
   * zeros, which is what an absent auxiliary port does on real hardware.
   */
  readonly portCount = 5;

  private status = Ps2Status.INPUT_BUFFER_FULL | Ps2Status.TRANSLATION;

  /** Bytes waiting for the host to read from port 0x60. */
  private readonly outputBuffer: number[] = [];

  /** Bytes the host has written to 0x60 awaiting the controller. */
  private readonly inputBuffer: number[] = [];

  /** True once the controller consumes the pending host write. */
  private hasPendingInput = false;

  private scanningEnabled = false;
  private leds = 0;
  private lastCommand: number | undefined;

  /** Currently held modifiers, as a bitmask of `Modifiers`. */
  heldModifiers = 0;

  /** Number of scan codes generated, for diagnostics. */
  scanCodesGenerated = 0;

  /**
   * The mouse on the auxiliary port, wired by the machine.
   *
   * The 8042 is one chip with two ports, and the keyboard and the mouse share its
   * single data register at 0x60 and single command register at 0x64. Routing is
   * therefore a property of the *controller*, which is what this class is, rather
   * than of either device - so the mouse is held here and the class routes to it
   * rather than each device pretending to own the ports.
   */
  aux: AuxPort | undefined;

  /**
   * True when the auxiliary clock is enabled, i.e. when the mouse may talk.
   *
   * A guest disables it with 0xA7 and re-enables with 0xA8. A mouse that ignores
   * this keeps reporting into a controller that is not listening, and the guest
   * sees packets arrive for a device it has switched off.
   */
  private auxClockEnabled = true;

  /** Set by a `0xD4` command; the next write to 0x60 is destined for the mouse. */
  private pendingAuxWrite = false;

  /** Byte most recently transferred on 0x60, echoed when the buffer is empty. */
  private lastTransferred = 0;

  constructor() {
    this.outputBuffer.push(...DEFAULT_KEYBOARD_ID);
  }

  /** Push a scan code as though a key were pressed (make code). */
  press(scanCode: number, extended = false): void {
    this.emit(scanCode, false, extended);
  }

  /** Push a scan code as though a key were released (break code). */
  release(scanCode: number, extended = false): void {
    this.emit(scanCode, true, extended);
  }

  /**
   * Inject a raw scan code sequence, e.g. `[ScanCode.LEFT_CTRL, ScanCode.C]`.
   * Used by tests and by the host key-mapping layer.
   */
  injectSequence(codes: readonly (number | { code: number; extended?: boolean })[]): void {
    for (const c of codes) {
      if (typeof c === 'number') this.press(c);
      else this.press(c.code, c.extended ?? false);
    }
  }

  private emit(scanCode: number, released: boolean, extended: boolean): void {
    if (!this.scanningEnabled) return;

    this.updateModifiers(scanCode, released, extended);

    if (extended) {
      this.status |= Ps2Status.OUTPUT_BUFFER_FULL;
      this.outputBuffer.push(0xe0);
    }
    const code = released ? (scanCode | 0x80) & 0xff : scanCode & 0xff;
    this.status |= Ps2Status.OUTPUT_BUFFER_FULL;
    this.outputBuffer.push(code);
    this.scanCodesGenerated++;
  }

  private updateModifiers(scanCode: number, released: boolean, extended: boolean): void {
    const set = (bit: number, on: boolean): void => {
      this.heldModifiers = on ? this.heldModifiers | bit : this.heldModifiers & ~bit;
    };

    switch (scanCode) {
      case ScanCode.LEFT_SHIFT:
        set(Modifiers.SHIFT, !released);
        break;
      case ScanCode.RIGHT_SHIFT:
        set(Modifiers.RIGHT_SHIFT, !released);
        break;
      case ScanCode.LEFT_CTRL:
        if (!extended) set(Modifiers.CTRL, !released);
        break;
      case ExtendedScanCode.RIGHT_CTRL:
        set(Modifiers.RIGHT_CTRL, !released);
        break;
      case ScanCode.LEFT_ALT:
        if (!extended) set(Modifiers.ALT, !released);
        break;
      case ExtendedScanCode.RIGHT_ALT:
        set(Modifiers.RIGHT_ALT, !released);
        break;
      default:
        break;
    }
  }

  /**
   * True when a byte is waiting at port 0x60, from either device.
   *
   * The output buffer belongs to the controller, so a byte queued by the mouse
   * counts just as much as one queued by the keyboard. A guest polling this bit
   * is asking "is there anything to read", not "did the keyboard say something".
   */
  get dataAvailable(): boolean {
    if (this.outputBuffer.length > 0) return true;
    return this.auxClockEnabled && this.aux?.hasData === true;
  }

  /** True when the last modifier state included any form of shift. */
  get shiftHeld(): boolean {
    return (this.heldModifiers & (Modifiers.SHIFT | Modifiers.RIGHT_SHIFT)) !== 0;
  }

  get ctrlHeld(): boolean {
    return (this.heldModifiers & (Modifiers.CTRL | Modifiers.RIGHT_CTRL)) !== 0;
  }

  get altHeld(): boolean {
    return (this.heldModifiers & (Modifiers.ALT | Modifiers.RIGHT_ALT)) !== 0;
  }

  get ledState(): number {
    return this.leds;
  }

  /**
   * True when the byte the next read of 0x60 will return came from the mouse.
   *
   * The controller prefers its own queued bytes, so this holds only when the
   * keyboard's buffer is empty and the mouse has something waiting. It has to be
   * answerable *before* the read: a guest polls bit 5 to learn whether the byte it
   * is about to take is a scancode or a motion packet, and a status bit that only
   * becomes correct afterwards tells it nothing it can act on.
   */
  private nextByteIsFromAux(): boolean {
    return this.outputBuffer.length === 0 && this.auxClockEnabled && this.aux?.hasData === true;
  }

  /** Keep bit 0 honest about the controller's one-byte output buffer. */
  private refreshOutputBufferFlag(): void {
    if (this.outputBuffer.length > 0 || this.nextByteIsFromAux()) {
      this.status |= Ps2Status.OUTPUT_BUFFER_FULL;
    } else {
      this.status &= ~Ps2Status.OUTPUT_BUFFER_FULL;
    }
  }

  portRead(offset: number): bigint {
    if (offset === 0) {
      // Data port. The keyboard's own bytes win, because a queued keystroke that
      // arrives before the mouse's next motion packet is the more urgent of the
      // two and a guest that read them in the other order would see typing
      // arrive after the click that preceded it.
      const own = this.outputBuffer.shift();
      const fromAux = own === undefined && this.auxClockEnabled ? this.aux?.readData() : undefined;
      const byte = own ?? fromAux;
      if (byte === undefined) {
        // An empty output buffer makes a real 8042 return the byte most recently
        // transferred rather than zero. Guests poll, and a zero is indistinguishable
        // from a legitimate answer.
        return BigInt(this.lastTransferred);
      }
      this.lastTransferred = byte & 0xff;
      if (own === undefined) this.status |= Ps2Status.AUX_DATA;
      else this.status &= ~Ps2Status.AUX_DATA;
      this.refreshOutputBufferFlag();
      return BigInt(byte);
    }

    // The buffer flags are refreshed *first*, so the value returned describes the
    // state as it is now rather than as it was before this method decided what
    // that state is.
    this.refreshOutputBufferFlag();
    // Bit 5 describes the byte that is waiting, not the byte that was last taken.
    // Setting it only on the way out leaves a polling driver unable to tell the
    // two devices apart until after it has already read the wrong one. With
    // nothing pending it is cleared: a guest looping on the status port would
    // otherwise go on seeing "from the mouse" after the mouse has gone quiet, and
    // read a stale byte as if it were a fresh packet.
    if (this.nextByteIsFromAux()) this.status |= Ps2Status.AUX_DATA;
    else this.status &= ~Ps2Status.AUX_DATA;

    // Status port: reflect the real state of the buffers.
    let value = this.status & ~(Ps2Status.INPUT_BUFFER_FULL | Ps2Status.INPUT_BUFFER_COMMAND);
    if (this.hasPendingInput) {
      value |= Ps2Status.INPUT_BUFFER_FULL;
      if (this.lastCommand !== undefined) value |= Ps2Status.INPUT_BUFFER_COMMAND;
    }
    return BigInt(value & 0xff);
  }

  portWrite(offset: number, _widthBytes: number, raw: bigint): void {
    const value = Number(raw & 0xffn);
    if (offset === 0) {
      // Data port. A `0xD4` to the command port has already decided where this goes,
      // which is the only way one register can serve two devices. The prefix covers
      // the command *and its parameters*: a guest sets a resolution with one `0xD4`,
      // a command byte and a parameter byte, and consuming only the first would send
      // the parameter to the keyboard, which acknowledges it and leaves the mouse at
      // its default - a mouse that ignores every setting it is given.
      if (this.pendingAuxWrite || this.aux?.wantsMoreInput === true) {
        this.pendingAuxWrite = false;
        if (this.auxClockEnabled) this.aux?.command(value);
        return;
      }
      // Otherwise: a command for the keyboard.
      this.inputBuffer.push(value);
      this.hasPendingInput = true;
      this.status |= Ps2Status.INPUT_BUFFER_FULL;
      this.lastCommand = value;
      return;
    }

    // Command port.
    switch (value) {
      case Ps2Command.READ_FIRST_OB:
        this.queue(...DEFAULT_KEYBOARD_ID);
        this.lastCommand = undefined;
        break;
      case Ps2Command.WRITE_INPUT_BUFFER: {
        const data = this.inputBuffer.shift();
        if (data !== undefined) this.handleKeyboardCommand(data);
        break;
      }
      case Ps2Command.SELF_TEST:
        this.queue(0x55);
        break;
      case Ps2Command.READ_INTERFACE_CONFIG:
        // Bit 0: keyboard clock disabled, bit 1: keyboard clock free-running.
        this.queue(0x00);
        break;
      case Ps2Command.WRITE_INTERFACE_CONFIG:
        break;
      case Ps2Command.WRITE_SECOND_OB_INPUT:
        // The next byte written to 0x60 goes to the mouse instead of the keyboard.
        // Nothing else changes, which is why the flag is the whole of it - and why
        // getting this wrong silently sends every mouse command to the keyboard,
        // which acknowledges them all and looks like a mouse that responds but
        // never moves.
        this.pendingAuxWrite = true;
        break;
      case Ps2Command.DISABLE_SECOND_PORT:
        // 0xA7 gates the auxiliary clock. A mouse that keeps talking anyway
        // delivers packets for a device the guest believes it has switched off,
        // and the guest's first move after disabling it is usually to drain the
        // buffer - which then never empties.
        this.auxClockEnabled = false;
        this.status |= Ps2Status.KEYBOARD_INHIBIT;
        break;
      case Ps2Command.ENABLE_SECOND_PORT:
        this.auxClockEnabled = true;
        this.status &= ~Ps2Status.KEYBOARD_INHIBIT;
        break;
      default:
        break;
    }
    this.hasPendingInput = this.inputBuffer.length > 0;
    if (!this.hasPendingInput) this.status &= ~Ps2Status.INPUT_BUFFER_FULL;
  }

  private handleKeyboardCommand(command: number): void {
    switch (command) {
      case KeyboardCommand.ENABLE_SCANNING:
        this.scanningEnabled = true;
        this.queue(KEYBOARD_ACK);
        break;
      case KeyboardCommand.DISABLE_SCANNING:
        this.scanningEnabled = false;
        this.queue(KEYBOARD_ACK);
        break;
      case KeyboardCommand.SET_DEFAULTS:
        this.scanningEnabled = true;
        this.leds = 0;
        this.queue(KEYBOARD_ACK);
        break;
      case KeyboardCommand.SET_LEDS:
        // The LED byte follows in a second write to port 0x60.
        this.leds = this.inputBuffer.shift() ?? 0;
        this.queue(KEYBOARD_ACK);
        break;
      case KeyboardCommand.RESET:
        this.scanningEnabled = true;
        this.queue(KEYBOARD_ACK);
        this.queue(KEYBOARD_SELF_TEST_PASS);
        break;
      case KeyboardCommand.GET_ID:
        this.queue(KEYBOARD_ACK);
        this.queue(...DEFAULT_KEYBOARD_ID);
        break;
      default:
        // Resynchronisation: the keyboard echoes an error code for commands
        // it does not understand rather than staying silent.
        this.queue(0xfa);
        break;
    }
  }

  private queue(...bytes: number[]): void {
    for (const b of bytes) this.outputBuffer.push(b & 0xff);
    this.status |= Ps2Status.OUTPUT_BUFFER_FULL;
  }

  /** Current LED nibble, for the `verix keyboard` diagnostic. */
  describe(): string {
    const ledNames = ['SCROLL', 'NUM', 'CAPS', undefined];
    const active = ledNames
      .map((name, bit) => (name !== undefined && (this.leds & (1 << bit)) !== 0 ? name : undefined))
      .filter((v): v is string => v !== undefined);
    return [
      `${this.name}: scanning=${this.scanningEnabled ? 'on' : 'off'}`,
      `leds=[${active.join(' ')}] modifiers=0x${this.heldModifiers.toString(16).padStart(2, '0')}`,
      `queued=${this.outputBuffer.length} scanCodes=${this.scanCodesGenerated}`,
    ].join('\n');
  }
}
