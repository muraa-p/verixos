/**
 * VerixOS - the kernel.
 *
 * This is the boundary the architecture documents. Below it, the boot sector and
 * stage 2 are machine code that VerixOS assembles itself and executes with its own
 * interpreter; they program the PIT, unmask the 8259 lines, enable interrupts and
 * publish a hand-off word, and every one of those goes through the same decoder
 * and the same executor as a user program would.
 *
 * At the boundary, control passes to the kernel runtime, which owns the desktop.
 * That ownership is real and visible: the kernel switches the adapter into
 * 320x200, installs its palette, and composites through the damage-tracked
 * compositor, so the boot log is still sitting in the text frame buffer when the
 * first frame is drawn and can be read back afterwards.
 *
 * ## What "responsive" means here
 *
 * The kernel does not own a wall clock. Each frame it is told how much emulated
 * time passed, and it advances the PIT by the matching number of oscillator cycles
 * so the timer interrupts the boot code programmed actually occur. A recording is
 * therefore reproducible: the same frame sequence with the same inputs produces
 * the same pixels, which is what makes the PNGs in `docs/` evidence rather than
 * decoration.
 */

import { CpuMode } from '../arch/decode.ts';
import { buildBootImage, BOOT_LOAD_ADDRESS, HANDOFF_ADDRESS, HANDOFF_MAGIC } from '../boot/index.ts';
import { Machine, PIT_FREQUENCY } from '../machine/machine.ts';
import { Desktop, type Action, type KeyEvent, type MachineView } from './desktop.ts';
import { installPalette } from './compositor.ts';

export interface KernelOptions {
  readonly ramBytes?: number;
  /** Emulated clock at boot, in milliseconds since midnight. */
  readonly startMs?: number;
  /** Frame interval in emulated milliseconds. Defaults to 60 Hz. */
  readonly frameMs?: number;
}

/** What the boot sequence did, read from the machine rather than assumed. */
export interface BootReport {
  /** True when stage 2 published the hand-off word. */
  readonly handedOff: boolean;
  /** Instructions retired by the boot code. */
  readonly instructions: bigint;
  /** Timer ticks the boot code's PIT programming produced. */
  readonly ticks: number;
  /** The console text the boot code printed. */
  readonly log: readonly string[];
  /** Why the machine stopped, in the runner's words. */
  readonly outcome: string;
}

/** What one frame cost. */
export interface FrameStats {
  readonly written: number;
  readonly examined: number;
  readonly regions: number;
}

export class Kernel {
  readonly machine: Machine;
  readonly desktop: Desktop;
  readonly frameMs: number;

  private bootReport: BootReport | undefined;
  private lastFrame: FrameStats = { written: 0, examined: 0, regions: 0 };
  private bootCapture: { pixels: Uint32Array; width: number; height: number } | undefined;

  constructor(options: KernelOptions = {}) {
    this.machine = new Machine({ mode: CpuMode.REAL16, ramBytes: options.ramBytes ?? 16 * 1024 * 1024 });
    this.frameMs = options.frameMs ?? 1000 / 60;
    this.desktop = new Desktop({
      machine: () => this.machineView(),
      ...(options.startMs === undefined ? {} : { startMs: options.startMs }),
    });
  }

  /** What the applications are told about the machine. */
  machineView(): MachineView {
    return {
      ticks: this.machine.timerTicks,
      instructions: this.machine.cpu.cycles,
      ramBytes: this.machine.bus.ram.sizeBytes,
      frameMs: this.frameMs,
      frameCost: this.lastFrame.examined === 0 ? 0 : this.lastFrame.written / this.lastFrame.examined,
    };
  }

  /** The boot report, once `runBoot` has run. */
get report(): BootReport | undefined {
    return this.bootReport;
  }

  /** Statistics for the most recent frame. */
  get lastFrameStats(): FrameStats {
    return this.lastFrame;
  }

  /**
   * Run the boot sequence and hand control to the desktop.
   *
   * Every step here is observable afterwards: the console text is read out of the
   * adapter rather than remembered from what the boot code was supposed to print,
   * and the hand-off is the word stage 2 actually wrote, not an assumption that it
   * got that far.
   */
  runBoot(maxSteps = 200_000): BootReport {
    const image = buildBootImage();

    this.machine.attachDisk(image.disk);
    this.machine.resetToBootSector();
    this.machine.loadImage(BOOT_LOAD_ADDRESS, image.bootSector);
    this.machine.cpu.regs.rip = BOOT_LOAD_ADDRESS;

    const outcome = this.machine.run(maxSteps);
    const log = this.machine.screenText().filter((line) => line.trim() !== '');
    const handedOff = this.machine.bus.read(HANDOFF_ADDRESS, 2) === BigInt(HANDOFF_MAGIC);

    this.bootReport = {
      handedOff,
      instructions: this.machine.cpu.cycles,
      ticks: this.machine.timerTicks,
      log,
      outcome: outcome.reason,
    };

    if (!handedOff) {
      // Without the hand-off the desktop would start over a machine that never
      // finished booting, and the first frame would look fine while every piece of
      // state behind it was wrong. Refusing is the honest response.
      throw new Error(
        `stage 2 did not hand over (${outcome.reason}); boot log: ${log.join(' | ') || '(nothing printed)'}`,
      );
    }

    // Capture the text screen *before* the kernel takes the frame buffer for the
    // compositor. Afterwards the adapter is in a graphics mode and the boot log no
    // longer exists in pixels, so this has to happen here rather than on demand -
    // a "boot screen" screenshot taken after the mode switch would show the
    // desktop and be captioned as the boot log, which is exactly the kind of
    // dishonest picture this project is trying not to produce.
    const textMode = this.machine.vga.currentMode;
    this.bootCapture = {
      pixels: this.machine.vga.renderToRgb(),
      width: textMode.hres,
      height: textMode.vres,
    };

    this.enterGraphics();
    return this.bootReport;
  }

  /** The boot console as the adapter rendered it, before the mode change. */
  get bootScreen():
    | { pixels: Uint32Array; width: number; height: number }
    | undefined {
    return this.bootCapture;
  }

  /** Take the screen for the compositor: 320x200, 256 colours, Verix palette. */
  enterGraphics(): void {
    this.machine.enterGraphicsMode();
    installPalette(this.machine.vga);
    this.desktop.compositor.forgetScreen();
    this.desktop.frame(0);
    this.present();
  }

  /**
   * Advance one frame.
   *
   * The PIT is advanced by the oscillator cycles the frame's duration represents,
   * *before* the frame is drawn, so the numbers the monitor shows are the ones
   * that were true while it was being drawn.
   */
  frame(dtMs: number = this.frameMs): void {
    const cycles = Math.round((dtMs / 1000) * PIT_FREQUENCY);
    this.machine.advanceTime(cycles);
    this.desktop.frame(dtMs);
  }

  /** Draw and present. Returns what the frame cost. */
  present(): FrameStats {
    this.lastFrame = this.desktop.present(this.machine.vga.framebuffer);
    return this.lastFrame;
  }

  /** One frame: advance, draw, present. */
  tick(dtMs: number = this.frameMs): FrameStats {
    this.frame(dtMs);
    return this.present();
  }

  /** Feed a keystroke to the desktop. */
  press(event: KeyEvent): Action | undefined {
    return this.desktop.press(event);
  }

  /** The adapter's pixels, as 0xRRGGBB. This is what a screenshot is. */
  pixels(): Uint32Array {
    return this.machine.vga.renderToRgb();
  }
}