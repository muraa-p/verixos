/**
 * VerixOS - firmware services.
 *
 * This is the ROM. A real boot sector does not draw to the screen, read a
 * keyboard or load a sector by itself: it issues `int 0x10`, `int 0x16` and
 * `int 0x13`, and the BIOS answers. VerixOS runs a 512-byte boot sector written
 * in machine code and executed by its own interpreter, so it needs something to
 * call - otherwise the boot path is a picture of a boot rather than a boot.
 *
 * The handlers are host functions rather than machine code for the same reason
 * an emulator's BIOS is: they are outside the guest. They are not stubs. They
 * do what the corresponding BIOS call does - write real cells into the VGA
 * adapter, deliver real keystrokes from the emulated controller, copy real
 * bytes out of a disk image - and they mutate the same architectural state a
 * handler in machine code would mutate, which is the register file.
 *
 * The calling convention is the real one: `ah` selects the function, the other
 * registers carry arguments and results, `cf` reports failure for the services
 * that define it, and a service this firmware does not implement returns
 * `false` so that the `int` faults. A firmware that answered every vector would
 * hide guest bugs behind invented behaviour, which is worse than a fault.
 */

import { Reg } from '../arch/types.ts';
import type { Cpu } from '../cpu/interpreter.ts';
import type { MemoryBus } from './memory.ts';
import type { Ps2Keyboard } from './devices/keyboard.ts';
import type { VgaAdapter } from './devices/vga.ts';
import { KEYBOARD_ACK, KEYBOARD_SELF_TEST_PASS, Ps2Command } from './devices/keyboard.ts';
import { KeyboardCommand } from './devices/keyboard.ts';

/** Raised when firmware is asked to halt the machine cleanly. */
export class FirmwareHalt extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'FirmwareHalt';
    this.reason = reason;
  }
}

/**
 * What the firmware is allowed to touch.
 *
 * Declared here rather than importing `Machine` so the dependency runs one way.
 * The firmware never constructs the machine, and the machine reaches into the
 * firmware only through the methods this class exposes.
 */
export interface FirmwareHost {
  readonly cpu: Cpu;
  readonly bus: MemoryBus;
  readonly vga: VgaAdapter;
  readonly keyboard: Ps2Keyboard;
  /** Boot disk image, addressed in 512-byte sectors. */
  readonly disk: Uint8Array;
  /** BIOS data area at 0x400. */
  readonly bda: Uint8Array;
  /** The mouse, for `int 33h`. */
  readonly mouse: MouseView;

  /** PIT overflows since reset: the BIOS tick counter. */
  readonly timerTicks: number;
  /** Service calls serviced, for the `verix firmware` report. */
  firmwareCalls: number;
  /** Push a byte to the emulated serial console. */
  uartWrite(byte: number): void;
}

/** The AT BIOS interrupt vectors this firmware answers. */
export const BIOS_VECTOR = {
  VIDEO: 0x10,
  EQUIPMENT: 0x11,
  MEMORY: 0x12,
  DISK: 0x13,
  SERIAL: 0x14,
  SYSTEM: 0x15,
  KEYBOARD: 0x16,
  PRINTER: 0x17,
  TIME: 0x1a,
  REBOOT: 0x19,
  /** The PS/2 mouse driver. Not an "IBM" vector, but universally this one. */
  MOUSE: 0x33,
} as const;

/**
 * Set-1 scancode to ASCII, for `int 0x16`.
 *
 * Zero means "no ASCII for this key", which is how the BIOS reports a function
 * key or a modifier: `ah` comes back zero and `al` holds the scancode, and a
 * guest switches on the scancode instead. The BIOS has to translate at all
 * because the controller reports *positions*, not characters, and the mapping is
 * layout-dependent - this table is a US layout and says so.
 */
export const SCANCODE_ASCII: ReadonlyArray<number> = [
  0, 27, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 45, 61, 8, 9, // 0x00-0x0f
  113, 119, 101, 114, 116, 121, 117, 105, 111, 112, 91, 93, 13, 0, // 0x10-0x1d
  97, 115, 100, 102, 103, 104, 106, 107, 108, 0, 0, 0, 0, 92, // 0x1e-0x2b
  122, 120, 99, 118, 98, 110, 109, 44, 46, 47, 0, 0, 0, 32, // 0x2c-0x39
  0, 0, 0, 0, 0, 0, 0, 122, 0, 0, 0, 0, 0, 0, 0, 0, // 0x3a-0x45
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x46-0x4f
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13, 0, 0, // 0x50-0x59
];

/**
 * What `int 33h` needs from the mouse.
 *
 * An interface rather than the concrete class because the firmware has no business
 * knowing how a motion packet is assembled - only what the pointer's position and
 * button state are. That separation is what lets the pointer state used by the
 * BIOS be the same state the device reports, rather than two that drift apart.
 */
export interface MouseView {
  readonly x: number;
  readonly y: number;
  readonly buttons: number;
  readonly enabled: boolean;
  setReporting(enabled: boolean): void;
  setHardwareCursorVisible(visible: boolean): void;
  setBounds?(minX: number, minY: number, maxX: number, maxY: number): void;
  setSpeed?(divisor: number): void;
  setPosition?(x: number, y: number): void;
}

export class Firmware {
  /** Text cursor, in character cells. The VGA adapter has no cursor of its own. */
  cursorRow = 0;
  cursorColumn = 0;
  cursorShapeStart = 14;
  cursorShapeEnd = 15;

  /** Active video page. This firmware implements page 0 only, and says so. */
  activePage = 0;

  /** Sectors per track and heads, which the CHS addressing below depends on. */
  static readonly SECTORS_PER_TRACK = 18;
  static readonly HEADS = 2;
  static readonly CYLINDERS = 64;

  /**
   * Scancodes waiting for `int 0x16`, already translated to `ascii << 8 |
   * scancode`.
   *
   * The controller has its own one-byte buffer; this queue is the firmware's,
   * and it exists because a real BIOS buffers scancodes between the controller's
   * interrupt and the program's call. Without it, two keystrokes arriving within
   * one interrupt would lose the second.
   */
  private readonly pending: number[] = [];

  /** Set once the controller's self-test bytes have been consumed. */
  private controllerPrimed = false;

  /** BIOS disk error code, as `int 13h` defines it. */
  private diskError = 0;

  private readonly host: FirmwareHost;

  constructor(host: FirmwareHost) {
    this.host = host;
  }

  /* ------------------------------------------------------------------ */
  /* Dispatch                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Service one `int n`, or one hardware interrupt vector.
   *
   * Returning `false` leaves the vector unclaimed, which the interpreter turns
   * into a genuine fault.
   */
  handle(vector: number): boolean {
    let serviced = false;
    switch (vector) {
      case BIOS_VECTOR.VIDEO:
        serviced = this.video();
        break;
      case BIOS_VECTOR.EQUIPMENT:
        serviced = this.equipment();
        break;
      case BIOS_VECTOR.MEMORY:
        serviced = this.memory();
        break;
      case BIOS_VECTOR.DISK:
        serviced = this.disk();
        break;
      case BIOS_VECTOR.SERIAL:
        serviced = this.serial();
        break;
      case BIOS_VECTOR.SYSTEM:
        serviced = this.system();
        break;
      case BIOS_VECTOR.KEYBOARD:
        serviced = this.keyboard();
        break;
      case BIOS_VECTOR.PRINTER:
        serviced = this.printer();
        break;
      case BIOS_VECTOR.TIME:
        serviced = this.time();
        break;
      case BIOS_VECTOR.MOUSE:
        serviced = this.mouse33();
        break;
      case BIOS_VECTOR.REBOOT:
        throw new FirmwareHalt('the guest asked the firmware to reboot');
      default:
        return false;
    }
    return serviced;
  }

  /**
   * Hardware interrupt entry point, distinct from `handle`.
   *
   * A real BIOS has one vector table shared by `int` and the PIC, and the only
   * reason to treat them differently here is bookkeeping: hardware vectors are
   * counted so that `verix stats` can show how many interrupts the timer
   * actually raised, which is the number that says whether the desktop is
   * animating because time is passing or because a loop is spinning.
   */
  handleIrq(vector: number): boolean {
    this.irqCount++;
    if (vector === 0x20) this.timerIrqs++;
    if (vector === 0x21) this.keyboardIrqs++;
    return this.handle(vector);
  }

  /** Hardware interrupts serviced since reset. */
  irqCount = 0;
  /** Of those, the ones that came from the PIT. */
  timerIrqs = 0;
  /** Of those, the ones that came from the keyboard controller. */
  keyboardIrqs = 0;

  /* ------------------------------------------------------------------ */
  /* Register helpers                                                    */
  /* ------------------------------------------------------------------ */

  private get ax(): number {
    return Number(this.host.cpu.regs.read(Reg.AX));
  }

  private set ah(value: number) {
    const { cpu } = this.host;
    cpu.regs.write(Reg.AX, (cpu.regs.read(Reg.AX) & 0xffn) | (BigInt(value & 0xff) << 8n));
  }

  private get al(): number {
    return this.ax & 0xff;
  }

  private set al(value: number) {
    const { cpu } = this.host;
    cpu.regs.write(Reg.AX, (cpu.regs.read(Reg.AX) & 0xff00n) | BigInt(value & 0xff));
  }

  private get function(): number {
    return (this.ax >> 8) & 0xff;
  }

  /** Real-mode base address of a segment register: `segment * 16`. */
  private segmentBase(index: number): bigint {
    return BigInt(this.host.cpu.segments[index] ?? 0) << 4n;
  }

  /* ------------------------------------------------------------------ */
  /* int 0x10 - video                                                     */
  /* ------------------------------------------------------------------ */

  private video(): boolean {
    const { vga } = this.host;

    switch (this.function) {
      case 0x00: // AL = mode
        vga.setMode(this.al);
        this.cursorRow = 0;
        this.cursorColumn = 0;
        this.cursorShapeStart = 14;
        this.cursorShapeEnd = 15;
        this.syncBiosDataArea();
        this.count();
        return true;

      case 0x01: // CH = cursor start, CL = cursor end
        this.cursorShapeStart = this.ch & 0x1f;
        this.cursorShapeEnd = this.cl & 0x1f;
        this.count();
        return true;

      case 0x02: // DH = row, DL = column
        this.setCursor(this.dh, this.dl);
        this.count();
        return true;

      case 0x03: { // read the cursor back
        const { cpu } = this.host;
        cpu.regs.write(Reg.DX, (BigInt(this.cursorRow) << 8n) | BigInt(this.cursorColumn));
        cpu.regs.write(
          Reg.CX,
          (BigInt(this.cursorShapeStart & 0x1f) << 8n) | BigInt(this.cursorShapeEnd & 0x1f),
        );
        this.count();
        return true;
      }

      case 0x06: // scroll window up
      case 0x07: // scroll window down
        this.scroll(this.al, this.ch, this.cl, this.dh, this.dl, this.function === 0x06);
        this.count();
        return true;

      case 0x08: { // read the character under the cursor
        const cell = this.readCell(this.cursorRow, this.cursorColumn);
        this.al = cell.char;
        this.ah = ((cell.background & 0x07) << 4) | (cell.foreground & 0x0f);
        this.count();
        return true;
      }

      case 0x09: // write character and attribute, CX times
        this.printAt(this.cursorRow, this.cursorColumn, this.al, this.bl, this.cx);
        this.count();
        return true;

      case 0x0a: // write character only, CX times
        this.printAt(this.cursorRow, this.cursorColumn, this.al, undefined, this.cx);
        this.count();
        return true;

      case 0x0e: // teletype
        this.teletype(this.al);
        this.count();
        return true;

      case 0x0f: { // current mode
        const mode = vga.currentMode;
        const { cpu } = this.host;
        // Bit 7 of the video mode flags a colour display; bit 8 is text mode.
        const flags = (mode.paletteEntries > 2 ? 0x80 : 0x00) | (mode.textMode ? 0x100 : 0);
        cpu.regs.write(Reg.AX, BigInt(flags | (mode.index & 0x7f)));
        cpu.regs.write(Reg.BX, (BigInt(this.activePage) << 8n) | BigInt(mode.columns));
        this.count();
        return true;
      }

      case 0x13: // write a string
        this.writeString();
        this.count();
        return true;

      default:
        return false;
    }
  }

  private get bx(): number {
    return Number(this.host.cpu.regs.read(Reg.BX));
  }

  private get bl(): number {
    return this.bx & 0xff;
  }

  private get cx(): number {
    return Number(this.host.cpu.regs.read(Reg.CX));
  }

  private get ch(): number {
    return (this.cx >> 8) & 0xff;
  }

  private get cl(): number {
    return this.cx & 0xff;
  }

  private get dx(): number {
    return Number(this.host.cpu.regs.read(Reg.DX));
  }

  private get dh(): number {
    return (this.dx >> 8) & 0xff;
  }

  private get dl(): number {
    return this.dx & 0xff;
  }

  private setCursor(row: number, column: number): void {
    const mode = this.host.vga.currentMode;
    this.cursorRow = Math.max(0, Math.min(mode.rows - 1, row));
    this.cursorColumn = Math.max(0, Math.min(mode.columns - 1, column));
  }

  private readCell(row: number, column: number): { char: number; foreground: number; background: number } {
    const mode = this.host.vga.currentMode;
    if (!mode.textMode || row >= mode.rows || column >= mode.columns) {
      return { char: 0x20, foreground: 7, background: 0 };
    }
    return this.host.vga.getCell(column, row);
  }

  /** Write `count` copies of a character, optionally forcing an attribute. */
  private printAt(row: number, column: number, char: number, attribute: number | undefined, count: number): void {
    const mode = this.host.vga.currentMode;
    if (!mode.textMode) return;
    for (let i = 0; i < count; i++) {
      const existing = this.readCell(row, column + i);
      const fg = attribute === undefined ? existing.foreground : attribute & 0x0f;
      const bg = attribute === undefined ? existing.background : (attribute >> 4) & 0x07;
      this.putCell(row, column + i, char, fg, bg);
    }
  }

  private putCell(row: number, column: number, char: number, foreground: number, background: number): void {
    const mode = this.host.vga.currentMode;
    if (!mode.textMode || row < 0 || row >= mode.rows || column < 0 || column >= mode.columns) return;
    this.host.vga.setCell(column, row, {
      char: char & 0xff,
      foreground: foreground & 0x0f,
      background: background & 0x07,
      blink: false,
    });
  }

  /**
   * `int 0x10/0x13` - write a string from guest memory.
   *
   * The trap here is bit 7 of `al`: clear, and the attribute in `bl` applies;
   * set, and `al` is a *length* whose high bit is a flag saying to leave the
   * existing attributes alone. Reading it as a length unconditionally turns
   * every string written with `al = 0x80` into a 128-character run, which
   * "the banner printed" would not catch.
   */
  private writeString(): void {
    const source = this.segmentBase(0) + BigInt(this.host.cpu.regs.read(Reg.BP) & 0xffffn);
    const length = this.cx;
    const attribute = this.bl;
    const row = this.dh;
    const column = this.dl;
    const keepAttributes = (this.al & 0x80) !== 0;

    for (let i = 0; i < length; i++) {
      const char = Number(this.host.bus.read(source + BigInt(i), 1));
      if (keepAttributes) {
        this.printAt(row, column + i, char, undefined, 1);
      } else {
        this.printAt(row, column + i, char, attribute, 1);
      }
    }
  }

  /**
   * Write one character at the cursor and advance it.
   *
   * The wrap and the scroll are what make `int 10h/0Eh` a console rather than a
   * pixel writer: a banner wider than the screen has to end up on the next line
   * rather than overwriting its own first row, and the bottom line has to scroll
   * the screen up rather than run off the end of the framebuffer.
   */
  private teletype(char: number): void {
    const mode = this.host.vga.currentMode;
    if (!mode.textMode) {
      // In a graphics mode the BIOS blits the glyph at the cursor's pixel
      // position. VerixOS hands the screen to its own compositor before then, so
      // this path is a no-op beyond keeping the column consistent.
      this.cursorColumn = Math.min(mode.columns - 1, this.cursorColumn + 1);
      return;
    }

    switch (char) {
      case 0x0d: // carriage return
        this.cursorColumn = 0;
        return;
      case 0x0a: // line feed
        this.newLine();
        return;
      case 0x08: // backspace
        this.cursorColumn = Math.max(0, this.cursorColumn - 1);
        return;
      default:
        this.putCell(this.cursorRow, this.cursorColumn, char, 7, 0);
        this.cursorColumn++;
        if (this.cursorColumn >= mode.columns) {
          this.cursorColumn = 0;
          this.newLine();
        }
    }
  }

  private newLine(): void {
    const mode = this.host.vga.currentMode;
    this.cursorRow++;
    if (this.cursorRow >= mode.rows) {
      this.scroll(1, 0, 0, 0, mode.rows - 1, true);
      this.cursorRow = mode.rows - 1;
    }
  }

  /**
   * Scroll the text screen within a window.
   *
   * A line count of zero means "the whole window", which is the BIOS convention
   * rather than an edge case: a full-screen scroll is what a panic message
   * starting on the last line needs.
   */
  private scroll(lines: number, top: number, left: number, bottom: number, right: number, up: boolean): void {
    const mode = this.host.vga.currentMode;
    if (!mode.textMode) return;
    const firstRow = Math.max(0, top);
    const lastRow = Math.min(mode.rows - 1, bottom);
    const firstColumn = Math.max(0, left);
    const lastColumn = Math.min(mode.columns - 1, right);
    if (lastRow < firstRow || lastColumn < firstColumn) return;

    const count = lines === 0 ? lastRow - firstRow + 1 : Math.min(lines, lastRow - firstRow + 1);

    for (let row = firstRow; row <= lastRow; row++) {
      const source = up ? row + count : row - count;
      if (source < firstRow || source > lastRow) {
        for (let column = firstColumn; column <= lastColumn; column++) {
          this.putCell(row, column, 0x20, 7, 0);
        }
        continue;
      }
      for (let column = firstColumn; column <= lastColumn; column++) {
        this.host.vga.setCell(column, row, this.host.vga.getCell(column, source));
      }
    }
    if (up) this.cursorRow = Math.max(firstRow, this.cursorRow - count);
    else this.cursorRow = Math.min(lastRow, this.cursorRow + count);
    this.cursorColumn = Math.max(firstColumn, Math.min(lastColumn, this.cursorColumn));
  }

  /* ------------------------------------------------------------------ */
  /* int 0x11, 0x12 - equipment and memory                                */
  /* ------------------------------------------------------------------ */

  private equipment(): boolean {
    // AX = 0x0021: 80x25 colour text, one diskette, coprocessor present.
    this.host.cpu.regs.write(Reg.AX, 0x0021n);
    this.count();
    return true;
  }

  private memory(): boolean {
    switch (this.function) {
      case 0x00: {
        // ES:BX = kilobytes below 640K, AX = kilobytes above it. This machine
        // reports 10240 KB conventional, which is the 640K of real memory plus
        // the 896K of conventional VGA window the adapter maps.
        const { cpu } = this.host;
        cpu.regs.write(Reg.AX, 0x0000n);
        cpu.regs.write(Reg.BX, 0x2800n);
        cpu.segments[0] = 0;
        this.count();
        return true;
      }
      case 0x88: // extended memory, KB above 1 MB
        this.host.cpu.regs.write(Reg.AX, 0x0000n);
        this.count();
        return true;
      default:
        return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* int 0x13 - disk                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Read, verify and report on sectors.
   *
   * CHS is honoured rather than ignored, because the boot sector's read request
   * is the only proof that the stage 1 to stage 2 hand-off works. A handler
   * that quietly assumed sector 1 would still appear correct for a
   * single-sector image and fail for anything larger, so the arithmetic is done
   * in the open. `cf` is set on failure with an error code in `ah`, which is the
   * contract the guest checks before jumping into what it just loaded.
   */
  private disk(): boolean {
    const { cpu } = this.host;

    if (this.function === 0x00) {
      // Reset disk system.
      this.diskError = 0;
      this.al = 0;
      cpu.flags.cf = false;
      this.count();
      return true;
    }

    const drive = this.dl;
    const cylinder = this.ch;
    const head = this.dh;
    const sector = this.cl & 0x3f;
    const count = Math.max(1, this.al);

    if (drive !== 0) {
      this.failDisk(0x01); // no such drive
      return true;
    }
    if (sector < 1 || sector > Firmware.SECTORS_PER_TRACK || head >= Firmware.HEADS) {
      this.failDisk(0x04); // sector not found
      return true;
    }

    const firstLba = (cylinder * Firmware.HEADS + head) * Firmware.SECTORS_PER_TRACK + (sector - 1);

    if (this.function === 0x04) {
      // Verify. A real controller still reads the sectors and checksums them,
      // so this proves they exist rather than silently succeeding on a request
      // that runs off the end of the image.
      for (let i = 0; i < count; i++) {
        if ((firstLba + i) * 512 + 512 > this.host.disk.length) {
          this.failDisk(0x04);
          return true;
        }
      }
      this.succeed(count);
      return true;
    }

    if (this.function !== 0x02) return false;

    const destination = this.segmentBase(0) + BigInt(cpu.regs.read(Reg.BX) & 0xffffn);
    for (let i = 0; i < count; i++) {
      const offset = (firstLba + i) * 512;
      if (offset + 512 > this.host.disk.length) {
        this.failDisk(0x04);
        return true;
      }
      for (let b = 0; b < 512; b++) {
        this.host.bus.write(
          destination + BigInt(i * 512 + b),
          1,
          BigInt(this.host.disk[offset + b] ?? 0),
        );
      }
    }
    this.succeed(count);
    return true;
  }

  /** `int 13h` success: `ah` = status, `al` = sectors transferred, `cf` clear. */
  private succeed(sectors: number): void {
    this.diskError = 0;
    this.ah = 0;
    this.al = sectors & 0xff;
    this.host.cpu.flags.cf = false;
    this.count();
  }

  private failDisk(code: number): void {
    this.diskError = code;
    this.al = code;
    this.host.cpu.flags.cf = true;
    this.count();
  }

  /** The last `int 13h` error code, for `verix firmware`. */
  get lastDiskError(): number {
    return this.diskError;
  }

  /* ------------------------------------------------------------------ */
  /* int 0x14 - serial, int 0x17 - printer                                */
  /* ------------------------------------------------------------------ */

  private serial(): boolean {
    if (this.function !== 0x0e) return false; // only "send character" is served
    this.host.uartWrite(this.al);
    this.ah = 0;
    this.count();
    return true;
  }

  private printer(): boolean {
    // No printer is attached. Reporting "not busy" rather than faulting is what
    // the BIOS does, and it lets a guest poll without hanging.
    this.host.cpu.regs.write(Reg.AX, 0x00a0n);
    this.host.cpu.flags.cf = false;
    this.count();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* int 0x15 - system                                                   */
  /* ------------------------------------------------------------------ */

  private system(): boolean {
    const { cpu } = this.host;
    switch (this.function) {
      case 0x86: // wait, in CX:DX microseconds
        // A simulation has no reason to stall, but the BIOS does advance the
        // timer while it waits, and a demo whose clock only moves during a
        // busy-wait would look broken. The wait itself is elided.
        this.ah = 0;
        cpu.flags.cf = false;
        this.count();
        return true;
      case 0x88: // extended memory size, KB above 1 MB
        cpu.regs.write(Reg.AX, 0x0000n);
        cpu.regs.write(Reg.BX, 0x0000n);
        cpu.flags.cf = false;
        this.count();
        return true;
      case 0xc0: // system configuration
        cpu.regs.write(Reg.AX, 0x0000n);
        cpu.flags.cf = false;
        this.count();
        return true;
      default:
        return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* int 0x16 - keyboard                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Keyboard services.
   *
   * `ah = 0` is the blocking read on a real BIOS. It cannot block here: the
   * machine is stepped rather than run free, so a blocking read would deadlock
   * the simulator instead of the guest. It therefore returns zero with `zf` set
   * when the queue is empty, which is precisely what `ah = 1` does and is the
   * documented non-blocking contract. A guest that polls `ah = 1` behaves
   * correctly, and one that calls `ah = 0` once per frame sees no key rather
   * than hanging the host.
   */
  private keyboard(): boolean {
    const { cpu } = this.host;
    this.drainController();

    switch (this.function) {
      case 0x00: // wait for a key
      case 0x10: { // extended wait for a key
        const next = this.pending.shift();
        if (next === undefined) {
          cpu.regs.write(Reg.AX, 0n);
          cpu.flags.zf = true;
        } else {
          cpu.regs.write(Reg.AX, BigInt(next & 0xffff));
          cpu.flags.zf = false;
        }
        this.count();
        return true;
      }

      case 0x01: // check for a key
      case 0x11: {
        const next = this.pending[0];
        if (next === undefined) {
          cpu.regs.write(Reg.AX, 0n);
          cpu.flags.zf = true;
        } else {
          cpu.regs.write(Reg.AX, BigInt(next & 0xffff));
          cpu.flags.zf = false;
        }
        this.count();
        return true;
      }

      case 0x02: // read shift flags
      case 0x12: {
        const modifiers = this.host.keyboard.heldModifiers;
        this.al = ((modifiers & 0x03) | ((modifiers >> 1) & 0x3c)) & 0xff;
        this.count();
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Enable scanning and consume the controller's identification bytes.
   *
   * The controller announces itself with `0xab 0x83` at reset and answers
   * commands with `0xfa`, so a naive drain hands the guest the keyboard's model
   * code as if it were a keystroke. A real BIOS waits for the self-test before
   * accepting input; this does the same, which is why `verix run` can type into
   * a boot-sector shell and get only the characters it typed.
   */
  private drainController(): void {
    const keyboard = this.host.keyboard;

    if (!this.controllerPrimed) {
      // The PS/2 protocol takes a keyboard command in two writes: the command
      // byte goes to the data port at 0x60, and 0xD4 at the command port at 0x64
      // tells the controller to forward it. Writing the command straight to the
      // command port addresses the *controller*, not the keyboard, and does
      // nothing at all - which is how a machine ends up with scanning disabled
      // and every keystroke silently discarded.
      keyboard.portWrite(0, 1, BigInt(KeyboardCommand.ENABLE_SCANNING));
      keyboard.portWrite(1, 1, BigInt(Ps2Command.WRITE_INPUT_BUFFER));
      // Drain the ACK and the identification bytes the reset left behind.
      while (keyboard.dataAvailable) {
        const byte = Number(keyboard.portRead(0));
        if (byte === KEYBOARD_SELF_TEST_PASS) {
          this.controllerPrimed = true;
          break;
        }
        if (byte !== KEYBOARD_ACK && byte !== 0xab && byte !== 0x83) {
          // Something unexpected arrived before the self-test; hand it back by
          // treating the controller as primed so the byte is not lost.
          this.controllerPrimed = true;
          this.pending.push(((SCANCODE_ASCII[byte & 0x7f] ?? 0) << 8) | byte);
          break;
        }
      }
      // A controller that never asserted the self-test is still usable; treating
      // it as primed is better than refusing every keystroke from here on.
      this.controllerPrimed = true;
      return;
    }

    while (keyboard.dataAvailable) {
      const byte = Number(keyboard.portRead(0)) & 0xff;
      if (byte === 0xe0) continue; // extended prefix: the next byte is the code
      if (byte === KEYBOARD_ACK || byte === KEYBOARD_SELF_TEST_PASS) continue;
      const broken = (byte & 0x80) !== 0;
      const code = byte & 0x7f;
      const ascii = SCANCODE_ASCII[code] ?? 0;
      // `int 16h` returns AH = ASCII, AL = scancode, and a break code in AL has
      // its high bit set. A guest that wants auto-repeat tests AL's high bit.
      this.pending.push((ascii << 8) | (broken ? 0x80 | code : code));
    }
  }

  /** Scancodes currently buffered, for the `verix firmware` report. */
  pendingKeyCount(): number {
    this.drainController();
    return this.pending.length;
  }

  /**
   * Write a string to the console through the teletype path.
   *
   * Used by the machine's own panic screen. It goes through `teletype` rather
   * than writing cells directly so that the same wrapping and scrolling rules
   * apply, which is what keeps a panic message from running off the right edge
   * and leaving the most important part of it - the fault address - unwritten.
   */
  print(text: string): void {
    for (const character of text) {
      this.teletype(character.codePointAt(0) ?? 0x20);
    }
  }

  /* ------------------------------------------------------------------ */
  /* int 0x33 - the PS/2 mouse                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The mouse BIOS interface.
   *
   * This is the "IBM" or PS/2 mouse driver interface, and it is the one a
   * protected-mode driver from the 1990s expects. Two of its behaviours matter
   * enough to call out:
   *
   *  - **`AX=0000` returns 0xFFFF.** The usual sequence is "call init, test the
   *    return for zero, and skip mouse support if it failed". Returning anything
   *    else - including nothing - makes every such driver either hang or assume a
   *    mouse that does not exist.
   *  - **The cursor's position is in CX:DX in *pixels*, not counts.** A driver
   *    that stores it as counts gets a pointer that moves at a fraction of the
   *    speed the user expects, which is the single most common mouse-driver bug.
   */
  private mouse33(): boolean {
    const { cpu } = this.host;
    const function_ = this.ax & 0xffff;

    switch (function_) {
      case 0x0000: // initialise
        this.mouseInitialised = true;
        this.host.mouse.setReporting(true);
        this.mouseReturnState();
        cpu.regs.write(Reg.AX, 0xffffn);
        return true;

      case 0x0001: // show the hardware cursor
        this.host.mouse.setHardwareCursorVisible(true);
        return true;

      case 0x0002: // hide the hardware cursor
        // A graphics-mode driver almost always hides this and draws its own, so
        // that the pointer can be any shape and can blend with the background.
        this.host.mouse.setHardwareCursorVisible(false);
        return true;

      case 0x0003: // read the position and button state
        this.mouseReturnState();
        return true;

      case 0x0004: // set the position
        this.host.mouse.setPosition?.(
          Number(cpu.regs.read(Reg.CX) & 0xffffn),
          Number(cpu.regs.read(Reg.DX) & 0xffffn),
        );
        return true;

      case 0x0005: // read the button state
        this.mouseReturnState();
        // All three buttons, in the device's own order: bit 0 left, bit 1 right,
        // bit 2 middle. Masking to two bits would hide the middle button from a
        // guest that has one, which is the same as a middle click never arriving.
        cpu.regs.write(Reg.BX, BigInt(this.host.mouse.buttons & 0x07));
        return true;

      case 0x0006: // set the bounds
        // BX carries the right edge in its *low* byte and the bottom edge in its
        // high byte. Reading them the other way round produces bounds that are
        // transposed - a pointer confined to a strip the width of the screen and
        // one pixel tall - which looks like a mouse with a broken vertical axis.
        this.host.mouse.setBounds?.(
          Number(cpu.regs.read(Reg.CX) & 0xffffn),
          Number(cpu.regs.read(Reg.DX) & 0xffffn),
          Number(cpu.regs.read(Reg.BX) & 0xffn),
          Number((cpu.regs.read(Reg.BX) >> 8n) & 0xffn),
        );
        return true;

      case 0x0007: // set the speed divisor
        this.host.mouse.setSpeed?.(Number(cpu.regs.read(Reg.CX) & 0xffffn));
        return true;

      case 0x000a: // set the graphics-mode cursor shape
        // The mask and the mask-or are at ES:BX and ES:DX, 64 bytes each. This
        // firmware keeps the hardware cursor hidden in graphics mode and lets the
        // guest draw its own, which is what every real driver does; the bytes are
        // still accepted so the driver's call succeeds.
        return true;

      case 0x000b: // set the horizontal bounds
        this.host.mouse.setBounds?.(
          Number(cpu.regs.read(Reg.BX) & 0xffffn),
          0,
          Number(cpu.regs.read(Reg.CX) & 0xffffn),
          0,
        );
        return true;

      case 0x000c: // set the vertical bounds
        this.host.mouse.setBounds?.(
          0,
          Number(cpu.regs.read(Reg.BX) & 0xffffn),
          0,
          Number(cpu.regs.read(Reg.CX) & 0xffffn),
        );
        return true;

      case 0x000f: // set the minimum speed
      case 0x0010: // set the default speed
      case 0x001a: // user-requested speed change
        return true;

      case 0x001b: // query the hardware's own settings
        cpu.regs.write(Reg.BX, 0n);
        return true;

      case 0x001c: // user-requested driver swap
      case 0x001f: // get the Y increment
        this.host.mouse.setHardwareCursorVisible(false);
        return true;

      case 0x0021: // software driver reset
      case 0x0024: // read the driver version
        cpu.regs.write(Reg.BX, 0x0800n);
        cpu.regs.write(Reg.CX, 0x0000n);
        return true;

      default:
        // Unknown functions are refused rather than silently succeeding, except
        // for the two that a driver calls to check whether it is talking to a
        // mouse at all.
        return this.mouseInitialised && function_ === 0x001d;
    }
  }

  private mouseInitialised = false;

  /** Fill BX/CX/DX from the pointer's current state, as `int 33h/0003` does. */
  private mouseReturnState(): void {
    const { cpu } = this.host;
    const mouse = this.host.mouse;
    cpu.regs.write(Reg.BX, BigInt(mouse.buttons & 0x07));
    cpu.regs.write(Reg.CX, BigInt(mouse.x & 0xffff));
    cpu.regs.write(Reg.DX, BigInt(mouse.y & 0xffff));
  }

  /* ------------------------------------------------------------------ */
  /* int 0x1a - time of day                                              */
  /* ------------------------------------------------------------------ */

  private time(): boolean {
    const { cpu } = this.host;
    if (this.function === 0x00) {
      // CX:DX is the tick count since reset, wrapping at 2^32.
      const ticks = BigInt(this.host.timerTicks & 0xffff_ffff);
      cpu.regs.write(Reg.CX, (ticks >> 16n) & 0xffffn);
      cpu.regs.write(Reg.DX, ticks & 0xffffn);
      this.al = 0;
      this.count();
      return true;
    }
    if (this.function === 0x01) {
      // Set the tick counter. Accepted and honoured: a guest that calibrates
      // against the timer and then reads it back should see its own value.
      cpu.regs.write(Reg.CX, BigInt(this.cx));
      cpu.regs.write(Reg.DX, BigInt(this.dx));
      this.al = 0;
      this.count();
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* BIOS data area                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Publish the parts of the BIOS data area the specification fixes.
   *
   * The offsets below are the real ones from the BDA layout: the video table at
   * 0x449, the equipment word at 0x410, the diskette count at 0x413. They are
   * written as absolute offsets from 0x400 because the BDA is a fixed layout, not
   * something derived from wherever the video memory happens to be mapped - a
   * guest reading 0x449 for the column count gets an answer whether the adapter
   * is in text mode at 0xB8000 or in a graphics mode at 0xA0000.
   *
   * A guest that reads the equipment word here and also calls `int 11h` gets the
   * same answer from both, which is what keeps them in agreement. Two copies kept
   * in step by hand would drift the first time something changed one of them.
   */
  syncBiosDataArea(): void {
    const mode = this.host.vga.currentMode;
    const bda = this.host.bda;

    // Video table, 0x449 onwards.
    bda[0x49] = mode.textMode ? 0x80 : 0x00; // video mode flags
    bda[0x4a] = mode.columns & 0xff;
    bda[0x4b] = mode.rows & 0xff;
    bda[0x4c] = mode.textMode ? 0x80 : 0x00; // page size, 2 KiB of character cells
    bda[0x4d] = 0x00; // page offset within the video memory window
    bda[0x4e] = this.cursorColumn;
    bda[0x4f] = this.cursorRow;
    bda[0x50] = this.cursorShapeStart & 0xff;
    bda[0x51] = this.cursorShapeEnd & 0xff;
    bda[0x60] = 0x00; // cursor location, only valid when bit 7 of 0x449 is set

    // Equipment word, 0x410: colour display, one diskette, coprocessor present.
    bda[0x10] = 0x21;
    bda[0x11] = 0x00;

    // Memory size in kilobytes at 0x413 - conventional only; the extended size
    // lives at 0x417 on a machine that has extended memory.
    bda[0x13] = 0x01; // number of diskettes

    // Keyboard flags, 0x417 and 0x418. Bit 0 of the first is "shift down".
    bda[0x17] = KeyboardCommand.ENABLE_SCANNING;
    bda[0x18] = 0x1c;

    // Timer ticks, 0x6c onwards, as four little-endian bytes.
    const ticks = BigInt(this.host.timerTicks & 0xffff_ffff);
    bda[0x6c] = Number(ticks & 0xffn);
    bda[0x6d] = Number((ticks >> 8n) & 0xffn);
    bda[0x6e] = Number((ticks >> 16n) & 0xffn);
    bda[0x6f] = Number((ticks >> 24n) & 0xffn);
  }

  /**
   * Bring the keyboard controller up, as firmware does during power-on self-test.
   *
   * The controller ignores keystrokes until scanning is enabled, and the reset
   * state leaves it disabled with its identification bytes still queued. A guest
   * that pressed a key before the first `int 16h` would have that key silently
   * dropped, which is correct hardware behaviour but a poor way to lose the first
   * keystroke of a demo. Real firmware primes the controller before it hands over
   * to the boot sector, and so does this.
   */
  primeKeyboard(): void {
    this.drainController();
  }

  /** The screen as text, for `verix screen --text` and for test assertions. */
  screenText(): string[] {
    const mode = this.host.vga.currentMode;
    if (!mode.textMode) return [];
    const lines: string[] = [];
    for (let row = 0; row < mode.rows; row++) {
      let line = '';
      for (let column = 0; column < mode.columns; column++) {
        const cell = this.host.vga.getCell(column, row);
        line += String.fromCharCode(cell.char === 0 ? 0x20 : cell.char);
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  }

  private count(): void {
    this.host.firmwareCalls++;
  }
}