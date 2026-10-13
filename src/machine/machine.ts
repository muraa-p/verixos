/**
 * VerixOS - the machine.
 *
 * This is where the parts stop being separate files and become a computer: RAM
 * behind a memory bus, devices behind a port bus, a CPU with a register file and
 * flags, an instruction decoder feeding an interpreter, firmware standing in for
 * the ROM, and a timer that advances because instructions were executed rather
 * than because a wall clock did.
 *
 * The order of construction matters and is worth stating once. The CPU is given
 * the two buses, not the devices, so it has no idea a VGA adapter exists; the
 * firmware is given the machine, so it can act on the CPU; and the interrupt
 * hook is installed last, because it closes a loop back into both. Nothing in
 * `cpu/` imports anything from `machine/devices`, which is what keeps the
 * interpreter testable against nothing more than a byte array.
 *
 * On timing: a simulated CPU has to be told that time passes. Here one executed
 * instruction costs `cyclesPerInstruction` oscillator cycles at 1.193182 MHz, the
 * PIT's real input frequency, so the timer advances because the guest is busy.
 * A guest that spins produces timer ticks; a guest that halts produces none.
 * That is the whole reason the desktop's clock can be trusted in a screenshot:
 * it moved because instructions ran.
 */

import { CpuMode, InstructionDecoder } from '../arch/decode.ts';
import type { Instruction } from '../arch/decode.ts';
import {
  BDA_LOCATION,
  BOOT_SECTOR_LOAD_ADDRESS,
  IRQ,
  Reg,
} from '../arch/types.ts';
import { Cpu, CpuFault } from '../cpu/interpreter.ts';
import { MemoryBus } from './memory.ts';
import { PortIoBus } from './io.ts';
import { VgaAdapter, MODE_13H } from './devices/vga.ts';
import { Ps2Keyboard } from './devices/keyboard.ts';
import { Ps2Mouse } from './devices/mouse.ts';
import { PicPair } from './devices/pic.ts';
import { Pit8254 } from './devices/pit.ts';
import { Uart16550 } from './devices/uart.ts';
import { Firmware, FirmwareHalt } from './firmware.ts';
import type { FirmwareHost } from './firmware.ts';

/** PIT oscillator frequency, from the 8254 datasheet. */
export const PIT_FREQUENCY = 1_193_182;

/**
 * The mouse's interrupt line.
 *
 * It is IRQ12 rather than anything in `types.ts`'s `IRQ` table because that table
 * enumerates the master controller's eight lines; the mouse lives on the slave,
 * where the numbering restarts at 8. Reaching it at all requires the master's
 * cascade line to be unmasked, which is why raising it also unmasks IRQ2.
 */
const IRQ_MOUSE = 12;

/**
 * Where the boot code hands control to the kernel.
 *
 * This is the native-code boundary the architecture documents: below it,
 * VerixOS executes real machine code with its own interpreter; at it, the boot
 * sequence has finished and the kernel takes over. It is an ordinary memory
 * address rather than a special case in the fetch path, so a jump to it behaves
 * like a jump to it anywhere else - the loader simply stops stepping when the
 * program counter arrives.
 */
export const KERNEL_ENTRY = 0x0010_0000n;

/** Why a run stopped. */
export type StopReason = 'halted' | 'limit' | 'reached' | 'fault' | 'firmware-halt';

export interface RunOutcome {
  readonly reason: StopReason;
  readonly steps: number;
  readonly fault: CpuFault | undefined;
  readonly rip: bigint;
}

export interface MachineOptions {
  /** Bytes of RAM. One mebibyte is the smallest useful value. */
  readonly ramBytes?: number;
  readonly mode?: CpuMode;
  /**
   * Oscillator cycles charged per executed instruction.
   *
   * One is the honest default: an instruction is one unit of work and the timer
   * is driven by work done. A higher value makes emulated time advance faster
   * per instruction, which is useful for driving a demo from a host-side clock
   * but should not be mistaken for a timing model.
   */
  readonly cyclesPerInstruction?: number;
  /** Bytes written to the emulated serial console, for the host-side log. */
  readonly captureSerial?: boolean;
}

export class Machine implements FirmwareHost {
  readonly bus: MemoryBus;
  readonly io: PortIoBus;
  readonly cpu: Cpu;
  readonly vga = new VgaAdapter();
  readonly keyboard = new Ps2Keyboard();
  /**
   * The PS/2 mouse, on the controller's auxiliary port.
   *
   * It is a separate device from the keyboard because it is a separate thing on
   * the other end of port 0x64 - but it shares the 8042's single data register,
   * which is why `keyboard.aux` exists and why the mouse has no ports of its own.
   */
  readonly mouse = new Ps2Mouse();
  readonly pit = new Pit8254();
  readonly pic: PicPair;
  readonly uart: Uart16550;

  /** Boot disk image: 512-byte sectors, addressed in CHS by the firmware. */
  disk: Uint8Array;

  /** BIOS data area. */
  readonly bda: Uint8Array;

  /** PIT overflows since reset: the BIOS tick counter. */
  timerTicks = 0;

  /** Firmware service calls serviced. */
  firmwareCalls = 0;

  /** Bytes the guest transmitted, when `captureSerial` was requested. */
  readonly serialOut: number[] = [];

  /** Oscillator cycles elapsed. */
  oscillatorCycles = 0;

  readonly cyclesPerInstruction: number;
  readonly mode: CpuMode;
  readonly firmware: Firmware;

  private readonly decoder: InstructionDecoder;

  constructor(options: MachineOptions = {}) {
    const ramBytes = options.ramBytes ?? 16 * 1024 * 1024;
    this.bus = new MemoryBus(ramBytes);
    this.io = new PortIoBus();
    this.cyclesPerInstruction = options.cyclesPerInstruction ?? 1;
    this.mode = options.mode ?? CpuMode.LONG64;
    this.disk = new Uint8Array(512);
    this.bda = new Uint8Array(256);

    // The BIOS data area is not a separate object. `PhysicalMemory.read` returns
    // a view into the backing store, so this is a window onto the same bytes the
    // bus serves at 0x400. A guest that reads the equipment word through the bus
    // and the firmware that writes it therefore agree by construction, rather
    // than by two copies being kept in step by hand.
    this.bda = this.bus.ram.read(Number(BDA_LOCATION), 0x100);

    this.cpu = new Cpu(this.bus, this.io);
    this.cpu.mode = this.mode === CpuMode.LONG64 ? '64' : this.mode === CpuMode.PROTECTED32 ? '32' : '16';

    this.pic = new PicPair();
    this.uart = new Uart16550({
      basePort: 0x3f8,
      onTransmit: (byte: number) => {
        this.serialOut.push(byte & 0xff);
      },
    });

    this.wireDevices();

    this.firmware = new Firmware(this);
    this.decoder = new InstructionDecoder((address: bigint) => Number(this.bus.read(address, 1)), this.mode);

    // Close the loop: the CPU's software interrupts reach the firmware, which
    // holds a reference back to this machine. Installed last on purpose.
    this.cpu.softwareInterrupt = (vector: number) => this.firmware.handle(vector);
  }

  /** Register every device with the bus it lives on. */
  private wireDevices(): void {
    this.bus.mapRegion({
      name: 'vga-aperture',
      start: VgaAdapter.APERTURE.start,
      end: VgaAdapter.APERTURE.end,
      read: (offset: bigint, widthBytes: number) => this.vga.read(offset, widthBytes),
      write: (offset: bigint, widthBytes: number, value: bigint) => this.vga.write(offset, widthBytes, value),
    });

    this.io.register(this.vga);
    this.io.register(this.keyboard);
    // The mouse has no ports of its own: the 8042 at 0x60/0x64 multiplexes it.
    this.keyboard.aux = this.mouse;
    this.io.register(this.pit);
    this.io.register(this.pic.master);
    this.io.register(this.pic.slave);
    this.io.register(this.uart);

    // The PIT's overflow is what raises the timer interrupt. Wiring it here
    // rather than polling from the kernel is what makes the timer real: it fires
    // because the counter wrapped, at the rate the counter was programmed to
    // wrap, and not because someone asked nicely.
    this.pit.onTick = (overflowCount: number) => {
      this.timerTicks += overflowCount;
      this.pic.raise(IRQ.TIMER);
    };

    // The keyboard raises IRQ1 as soon as a scan code is queued, so a guest that
    // has enabled the line learns about a keystroke without polling port 0x64.
  }

  /**
   * Raise IRQ1 when the keyboard controller has produced a new scan code.
   *
   * The controller raises nothing by itself - it is a passive device behind
   * ports - so the edge is detected here, where the bytes actually appear.
   * Comparing the generated count rather than the queue length is deliberate:
   * the count only moves when a scan code is emitted, whereas the queue also
   * receives acknowledgements and the self-test reply, and raising an interrupt
   * for every `0xfa` would make the controller's own replies look like typing.
   */
  private raiseKeyboardIrqIfNeeded(): void {
    if (this.keyboard.scanCodesGenerated === this.lastScanCodesGenerated) return;
    this.lastScanCodesGenerated = this.keyboard.scanCodesGenerated;
    this.pic.raise(IRQ.KEYBOARD);
  }

  private lastScanCodesGenerated = 0;

  private lastMousePackets = 0;

  /**
   * Raise IRQ12 when the mouse has produced a packet.
   *
   * IRQ12 is on the *slave* PIC, which is only visible through the master's
   * cascade on IRQ2. So raising it needs the cascade unmasked as well, or the
   * request is latched in the slave and never delivered - a mouse that moves and
   * never interrupts, which is the same symptom as a mouse that does not move.
   */
  private raiseMouseIrqIfNeeded(): void {
    const packets = this.mouse.state.packets;
    if (packets === this.lastMousePackets) return;
    this.lastMousePackets = packets;
    this.pic.unmask(2);
    this.pic.raise(IRQ_MOUSE);
  }


  /** Unmask the mouse's line, and the cascade that makes it reachable. */
  enableMouseIrq(): void {
    this.pic.unmask(2);
    this.pic.unmask(IRQ_MOUSE);
  }

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */

  /** Copy bytes into RAM. Used for the boot sector and for program images. */
  loadImage(address: bigint, bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      this.bus.write(address + BigInt(i), 1, BigInt(bytes[i] ?? 0));
    }
  }

  /** Attach a boot disk image. Sized to a whole number of 512-byte sectors. */
  attachDisk(image: Uint8Array): void {
    const sectors = Math.max(1, Math.ceil(image.length / 512));
    this.disk = new Uint8Array(sectors * 512);
    this.disk.set(image.subarray(0, this.disk.length));
  }

  /**
   * Put the machine into the state a real machine is in when the BIOS hands
   * control to the boot sector: a 512-byte boot sector loaded at 0x7c00 with
   * the DL register holding the BIOS drive number, and a stack that will run
   * out somewhere inside the boot sector's own address.
   */
  resetToBootSector(): void {
    this.cpu.regs.restore(new Array<bigint>(16).fill(0n));
    this.cpu.regs.rip = BOOT_SECTOR_LOAD_ADDRESS;
    this.cpu.flags.value = 0x2n;
    this.cpu.flags.if = false;
    this.cpu.segments.fill(0);
    this.cpu.segments[1] = 0x0000; // CS = 0000
    this.cpu.segments[2] = 0x0000; // SS = 0000
    this.cpu.regs.write(Reg.SP, 0x7c00n);
    this.cpu.regs.write(Reg.DX, 0x80n); // BIOS says "first floppy"
    this.timerTicks = 0;
    this.firmwareCalls = 0;
    this.oscillatorCycles = 0;
    // Power-on self test: bring the keyboard controller up and discard its
    // identification bytes, so the boot sector's first keystroke is not lost and
    // the guest's first `int 16h` does not read the keyboard's model code as
    // though it were a character.
    this.firmware.primeKeyboard();
    this.firmware.syncBiosDataArea();
    this.mouse.setScreenSize(this.vga.currentMode.hres, this.vga.currentMode.vres);
  }

  /* ------------------------------------------------------------------ */
  /* Execution                                                           */
  /* ------------------------------------------------------------------ */

  /** Decode and execute the instruction at RIP. */
  step(): Instruction {
    const instruction = this.decoder.decode(this.cpu.regs.rip, this.mode);
    this.cpu.execute(instruction);
    return instruction;
  }

  /**
   * Service pending hardware interrupts.
   *
   * Delivery is in IRQ order, lowest first, because that is the 8259's priority
   * and because a desktop that services the timer before the keyboard makes the
   * cursor stutter under load.
   *
   * `acknowledge` both queries the request register and latches the chosen line
   * in service, clearing its request bit. That is what terminates this loop: a
   * serviced line cannot be redelivered in the same pass, so the sequence
   * converges instead of spinning. It is also why `PicPair.raise` is not used
   * here - `raise` *asserts* a line, so using it to ask "is anything pending?"
   * would arm every line it asked about, and the loop would never end.
   */
  serviceInterrupts(): boolean {
    if (this.cpu.halted) return false;
    if (!this.cpu.flags.if) return false;
    let serviced = false;

    for (;;) {
      const masterIrq = this.pic.master.acknowledge();

      if (masterIrq === 2) {
        // The cascade. The master only presents IRQ2 when the slave has a
        // request and master IRQ2 itself is unmasked, so there is always
        // something behind it - but not trusting that is cheap, and an empty
        // cascade must still be ended rather than retried forever.
        const slaveIrq = this.pic.slave.acknowledge();
        if (slaveIrq >= 0) {
          this.firmware.handleIrq(this.pic.slave.vectorFor(slaveIrq));
          this.pic.slave.endOfInterrupt();
          serviced = true;
        }
        this.pic.master.endOfInterrupt();
        continue;
      }

      if (masterIrq >= 0) {
        this.firmware.handleIrq(this.pic.master.vectorFor(masterIrq));
        this.pic.master.endOfInterrupt();
        serviced = true;
        continue;
      }

      // Nothing on the master. The slave is only visible through an unmasked
      // cascade, so if the cascade is masked the slave cannot be serviced.
      if (!this.pic.master.isUnmasked(2)) break;
      const slaveIrq = this.pic.slave.acknowledge();
      if (slaveIrq < 0) break;
      this.firmware.handleIrq(this.pic.slave.vectorFor(slaveIrq));
      this.pic.slave.endOfInterrupt();
      serviced = true;
    }
    return serviced;
  }

  /**
   * One step, plus the interrupt check that precedes it.
   *
   * The order is the hardware's: an interrupt is taken *between* instructions,
   * so it is serviced before the next fetch rather than after the last one. A
   * guest that enables interrupts with `sti` therefore does not take the pending
   * interrupt until after the following instruction, which is observable.
   */
  tick(): Instruction | undefined {
    this.raiseKeyboardIrqIfNeeded();
    this.raiseMouseIrqIfNeeded();
    this.serviceInterrupts();
    if (this.cpu.halted) return undefined;
    const instruction = this.step();
    this.oscillatorCycles += this.cyclesPerInstruction;
    this.pit.advance(this.cyclesPerInstruction);
    return instruction;
  }

  /** Run until the program counter reaches `address`, the guest halts, or the limit is hit. */
  runUntil(address: bigint, maxSteps: number): RunOutcome {
    let steps = 0;
    try {
      while (steps < maxSteps) {
        if (this.cpu.regs.rip === address) {
          return { reason: 'reached', steps, fault: undefined, rip: address };
        }
        if (this.cpu.halted) {
          return { reason: 'halted', steps, fault: undefined, rip: this.cpu.regs.rip };
        }
        this.tick();
        steps++;
      }
    } catch (error) {
      if (error instanceof FirmwareHalt) {
        return { reason: 'firmware-halt', steps, fault: undefined, rip: this.cpu.regs.rip };
      }
      if (error instanceof CpuFault) {
        this.reportFault(error);
        return { reason: 'fault', steps, fault: error, rip: this.cpu.regs.rip };
      }
      throw error;
    }
    return { reason: 'limit', steps, fault: undefined, rip: this.cpu.regs.rip };
  }

  /** Run a fixed number of instructions, or until the guest halts. */
  run(maxSteps: number): RunOutcome {
    let steps = 0;
    try {
      while (steps < maxSteps && !this.cpu.halted) {
        this.tick();
        steps++;
      }
    } catch (error) {
      if (error instanceof FirmwareHalt) {
        return { reason: 'firmware-halt', steps, fault: undefined, rip: this.cpu.regs.rip };
      }
      if (error instanceof CpuFault) {
        this.reportFault(error);
        return { reason: 'fault', steps, fault: error, rip: this.cpu.regs.rip };
      }
      throw error;
    }
    return {
      reason: this.cpu.halted ? 'halted' : 'limit',
      steps,
      fault: undefined,
      rip: this.cpu.regs.rip,
    };
  }

  /**
   * Advance emulated time without executing anything.
   *
   * Used to give a host-driven frame a duration. It moves the same PIT the
   * guest programs, so a frame of emulated time produces exactly the timer
   * interrupts a real frame would, including the keyboard check that turns a
   * queued scan code into an IRQ1.
   */
  advanceTime(oscillatorCycles: number): void {
    for (let i = 0; i < 4; i++) {
      this.raiseKeyboardIrqIfNeeded();
      this.raiseMouseIrqIfNeeded();
      this.serviceInterrupts();
      this.pit.advance(Math.ceil(oscillatorCycles / 4));
    }
    this.pit.advance(oscillatorCycles % 4);
    this.oscillatorCycles += oscillatorCycles;
  }

  /**
   * Print a fault on the text screen, so a bad boot is legible rather than a
   * stack trace on the host console. A real machine panics through video
   * precisely because the developer may have no console at all.
   */
  reportFault(fault: CpuFault): void {
    if (!this.vga.currentMode.textMode) {
      this.vga.setMode(0x03);
      this.firmware.syncBiosDataArea();
    }
    const name = FAULT_NAMES[fault.vector] ?? `vector ${fault.vector}`;
    this.firmware.print('\n\n');
    this.firmware.print('  VerixOS has halted.\n\n');
    this.firmware.print(`  fault:  ${name}\n`);
    this.firmware.print(`  at:     0x${fault.address.toString(16).padStart(4, '0')}\n`);
    this.firmware.print(`  reason: ${fault.message}\n\n`);
    this.firmware.print('  The CPU has been left at the faulting address.\n');
  }

  uartWrite(byte: number): void {
    this.serialOut.push(byte & 0xff);
  }

  /* ------------------------------------------------------------------ */
  /* Convenience                                                         */
  /* ------------------------------------------------------------------ */

  /** Program the PIT's channel 0 for a tick every `ticksPerSecond`. */
  programTimer(ticksPerSecond: number): void {
    const divisor = Math.max(1, Math.min(0xffff, Math.floor(PIT_FREQUENCY / Math.max(1, ticksPerSecond))));
    this.pit.portWrite(3, 1, 0x36n); // channel 0, lobyte/hibyte, mode 3, binary
    this.pit.portWrite(0, 1, BigInt(divisor & 0xff));
    this.pit.portWrite(0, 1, BigInt((divisor >> 8) & 0xff));
  }

  /** Switch the adapter into the 320x200 256-colour mode the desktop uses. */
  enterGraphicsMode(): void {
    this.vga.setMode(MODE_13H);
    this.firmware.syncBiosDataArea();
    // The mouse cannot know how large the screen is, and a BIOS call that passes
    // zero for the maximum is asking it to guess.
    this.mouse.setScreenSize(this.vga.currentMode.hres, this.vga.currentMode.vres);
  }

  /** Unmask the timer and keyboard lines, which is what `sti`-ing a driver means. */
  enableTimerAndKeyboardIrqs(): void {
    this.pic.unmask(IRQ.TIMER);
    this.pic.unmask(IRQ.KEYBOARD);
  }

  /** A one-line summary of the machine, for `verix info`. */
  describe(): string {
    const ramMiB = this.bus.ram.sizeBytes / (1024 * 1024);
    return [
      `cpu:     ${this.mode} mode, ${this.cpu.cycles} instructions retired`,
      `memory:  ${ramMiB.toFixed(0)} MiB at 0x0, aperture 0xa0000-0xbffff`,
      `video:   ${this.vga.currentMode.name}`,
      `ports:   ${this.io.deviceNames().join(', ')}`,
      `timer:   ${this.timerTicks} ticks, ${this.oscillatorCycles} oscillator cycles`,
      `firmware:${this.firmwareCalls} BIOS services, ${this.firmware.irqCount} IRQs`,
    ].join('\n');
  }

  /** Text-mode screen contents, or an empty list in a graphics mode. */
  screenText(): string[] {
    return this.firmware.screenText();
  }

  /** Map of MMIO regions currently registered, for diagnostics. */
  regionNames(): string[] {
    return this.bus.regionNames();
  }

  /**
   * Hex dump of RAM, without separators.
   *
   * Used by the tests to assert on bytes a program wrote - a memory assertion
   * that reads back through the same bus the program wrote through, so a test
   * cannot pass by inspecting a private copy that never changed.
   */
  dumpRam(address: bigint, length: number): string {
    let out = '';
    for (const byte of this.bus.ram.dump(address, length)) {
      out += byte.toString(16).padStart(2, '0');
    }
    return out;
  }
}

/** Names for the exception vectors, for the panic screen. */
export const FAULT_NAMES: Readonly<Record<number, string>> = {
  0: '#DE divide error',
  3: '#BP breakpoint',
  6: '#UD invalid opcode',
  8: '#DF double fault',
  13: '#GP general protection',
  14: '#PF page fault',
};