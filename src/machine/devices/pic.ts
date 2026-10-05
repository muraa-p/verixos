/**
 * VerixOS - 8259A Programmable Interrupt Controller.
 *
 * A faithful pair of 8259A controllers in cascaded mode: the master's IRQ2
 * input is wired to the slave's cascade input, giving 16 hardware interrupt
 * lines.
 *
 * The controller implements the full initialisation sequence (ICW1-ICW4), both
 * operational command words (OCW2, OCW3), the interrupt mask, the In-Service
 * Register and the Interrupt Request Register. Interrupt priority resolution
 * follows the fixed fully-nested priority model in hardware default mode.
 *
 * Source: Intel 8259A Programmable Interrupt Controller datasheet; the
 * remapping requirement is described in the OSDev "Programmable Interrupt
 * Controller" chapter.
 */

import type { PortDevice } from '../io.ts';

/** Why an interrupt line became asserted. */
export interface IrqEvent {
  readonly irq: number;
  /** True when the event came from the cascade (slave) controller. */
  readonly fromSlave: boolean;
}

export class Pic8259 implements PortDevice {
  static readonly MASTER_COMMAND = 0x20;
  static readonly MASTER_DATA = 0x21;
  static readonly SLAVE_COMMAND = 0xa0;
  static readonly SLAVE_DATA = 0xa1;

  readonly name: string;
  readonly startPort: number;
  readonly portCount = 2;

  /** True for the slave, false for the master. */
  readonly isSlave: boolean;

  /** Lines 0-7 on this controller; the slave's are offset by 8 in the IRQ space. */
  private irr = 0;
  private isr = 0;

  private imrValue = 0xff;

  /** ICW sequence tracking. */
  private initStep = 0;
  private expectMaskMode = false;
  private vectorBase = 0;

  /** OCW3 read/write state. */
  private readIsrSelect = false;
  private pollMode = false;
  private pollIrq = -1;

  constructor(isSlave: boolean, startPort: number) {
    this.isSlave = isSlave;
    this.startPort = startPort;
    this.name = isSlave ? 'pic8259-slave' : 'pic8259-master';
  }

  private get base(): number {
    return this.isSlave ? 8 : 0;
  }

  /** Mask the command/data port pair. */
  static ports(isSlave: boolean): { startPort: number; portCount: number } {
    return {
      startPort: isSlave ? Pic8259.SLAVE_COMMAND : Pic8259.MASTER_COMMAND,
      portCount: 2,
    };
  }

  /**
   * Assert an interrupt line.
   *
   * Lines held off by the mask register are latched in the IRR but cannot
   * proceed until unmasked, which is exactly how a real PIC behaves: an
   * interrupt that arrives while masked is not lost, it is pending.
   *
   * Returns the IRQ number in system space (0-15) or -1 when masked.
   */
  raise(irq: number): number {
    const local = irq - this.base;
    if (local < 0 || local > 7) return -1;
    this.irr |= 1 << local;

    // The master must additionally gate IRQ2, because that line carries the
    // entire slave's interrupt output.
    if (this.isSlave && !(this.masterUnmasked(2) ?? false)) return -1;
    if (!this.isSlave && local !== 2 && (this.imrValue & (1 << local)) !== 0) return -1;

    // In hardware fully-nested mode only one interrupt is in service at a time;
    // higher-priority pending lines are blocked by the in-service register.
    if (this.isr !== 0) {
      const highestIsr = 31 - Math.clz32(this.isr);
      if (local > highestIsr) return -1;
    }
    return irq;
  }

  private masterUnmasked(irq: number): boolean | undefined {
    // The master is modelled separately; this hook is wired by `PicPair`.
    return this.masterMaskHook === undefined ? undefined : this.masterMaskHook(irq);
  }

  /** Installed by `PicPair` so the slave can consult the master's mask. */
  masterMaskHook: ((irq: number) => boolean) | undefined;

  /** True when the given local line is unmasked. */
  isUnmasked(local: number): boolean {
    return (this.imrValue & (1 << local)) === 0;
  }

  /**
   * Acknowledge the highest-priority pending, unmasked, not-in-service line.
   * Returns the system IRQ number or -1 when nothing can be delivered.
   */
  acknowledge(): number {
    if (this.pollMode) return -1;
    const deliverable = this.irr & ~this.imrValue;
    if (deliverable === 0) return -1;
    const irq = 31 - Math.clz32(deliverable);
    this.isr |= 1 << irq;
    this.irr &= ~(1 << irq);
    return this.base + irq;
  }

  /**
   * End Of Interrupt. Clears the highest in-service bit, as required by the
   * non-automatic-EOI mode used everywhere in VerixOS.
   */
  endOfInterrupt(): number {
    if (this.isr === 0) return -1;
    const irq = 31 - Math.clz32(this.isr);
    this.isr &= ~(1 << irq);
    return this.base + irq;
  }

  /** Vector number this controller delivers for `irq`. */
  vectorFor(irq: number): number {
    const local = irq - this.base;
    return this.vectorBase + local;
  }

  /** The vector offset programmed via ICW2. */
  get programmedVectorBase(): number {
    return this.vectorBase;
  }

  /**
   * Override the programmed vector base.
   *
   * `PicPair.programController` issues the real ICW sequence over the ports; this
   * setter lets the pairing logic keep the model in sync without reaching into
   * private state.
   */
  setVectorBase(base: number): void {
    this.vectorBase = base & 0xf8;
  }

  get inServiceRegister(): number {
    return this.isr;
  }

  get interruptRequestRegister(): number {
    return this.irr;
  }

  get mask(): number {
    return this.imrValue;
  }

  portRead(offset: number, _widthBytes: number): bigint {
    const isData = offset === 1;
    let value = 0;

    if (this.pollMode && isData) {
      const pending = this.irr & ~this.imrValue;
      if (pending === 0) {
        // Poll with no interrupt pending returns 0x80.
        this.pollMode = false;
        return 0x80n;
      }
      const irq = 31 - Math.clz32(pending);
      this.pollIrq = this.base + irq;
      return BigInt(this.pollIrq & 0x7f);
    }

    if (isData) {
      value = this.readIsrSelect ? this.isr : this.irr;
    } else {
      // Reading the command port of the master returns the slave's cascade bit.
      value = this.isSlave ? this.irr & 0xff : (this.slaveIrqPending() ? 0x04 : 0x00);
    }

    return BigInt(value & 0xff);
  }

  private slaveIrqPending(): boolean {
    return this.slavePendingHook?.() ?? false;
  }

  /** Installed by `PicPair`. */
  slavePendingHook: (() => boolean) | undefined;

  portWrite(offset: number, _widthBytes: number, value: bigint): void {
    const isData = offset === 1;
    const v = Number(value & 0xffn);

    if (this.initStep > 0) {
      this.handleInitWrite(isData, v);
      return;
    }

    if (isData) {
      this.imrValue = v;
      return;
    }

    // OCW2 / OCW3 discrimination: OCW2 has bit 4 set, OCW3 has bit 3 set and
    // bit 4 clear. When both are candidates, bit 5 (EOI mode) is decisive.
    const isOcw2 = (v & 0x08) !== 0 ? (v & 0x20) !== 0 || (v & 0x40) !== 0 : (v & 0x10) !== 0;

    if (isOcw2) {
      const eoiMode = (v >> 5) & 0x03;
      switch (eoiMode) {
        case 0: // Non-specific EOI
          this.endOfInterrupt();
          break;
        case 1: // Specific EOI, bits 0-2 give the line
          if (this.isr !== 0) {
            this.isr &= ~(1 << (v & 0x07));
          }
          break;
        case 3: // Rotate on non-specific EOI
          this.endOfInterrupt();
          this.irr = this.rotatePriority();
          break;
        default:
          break;
      }
      return;
    }

    // OCW3
    const select = (v >> 5) & 0x03;
    if (select === 1) {
      // Read ISR
      this.readIsrSelect = true;
    } else if (select === 2) {
      // Read IRR
      this.readIsrSelect = false;
    } else if (select === 3) {
      // Poll command
      this.pollMode = true;
      this.pollIrq = -1;
    }
  }

  private rotatePriority(): number {
    const lowest = 31 - Math.clz32(this.isr);
    if (this.irr === 0) return this.irr;
    const next = (lowest + 1) & 0x07;
    const rotated =
      ((this.irr >>> next) | (this.irr << (8 - next))) & 0xff;
    return rotated;
  }

  private handleInitWrite(isData: boolean, v: number): void {
    if (!isData) {
      // ICW1
      const icw4 = (v & 0x01) !== 0;
      const single = (v & 0x02) !== 0;
      const expectInit = (v & 0x10) !== 0;
      if (!expectInit) {
        // ICW1 bit 4 clear selects 8086/88 mode with edge triggering.
        this.initStep = 0;
        this.imrValue = 0;
        this.irr = 0;
        this.isr = 0;
        return;
      }
      void single;
      this.expectMaskMode = icw4;
      this.initStep = 2; // next data write supplies ICW2
      this.irr = 0;
      this.isr = 0;
      return;
    }

    switch (this.initStep) {
      case 2:
        // ICW2: vector address offset.
        this.vectorBase = v & 0xf8;
        this.initStep = 3;
        break;
      case 3: // ICW3: cascade identity
        this.initStep = 4;
        break;
      case 4: // ICW4
        this.initStep = this.expectMaskMode ? 5 : 0;
        if (!this.expectMaskMode) this.imrValue = 0;
        break;
      case 5:
        // ICW4 in 8086 mode: this byte is the initial mask.
        this.imrValue = v;
        this.initStep = 0;
        break;
      default:
        this.initStep = 0;
        break;
    }
  }

  /** True while the controller is mid-initialisation and will swallow writes. */
  get isInitialising(): boolean {
    return this.initStep > 0;
  }

  /** Force the mask. Used by the kernel to unmask specific lines. */
  setMask(mask: number): void {
    this.imrValue = mask & 0xff;
  }
}

/**
 * The cascaded pair, exposed as one unit. This is the interface the kernel
 * actually uses, because no real code talks to a single 8259A in isolation.
 */
export class PicPair {
  readonly master: Pic8259;
  readonly slave: Pic8259;

  /** Vector offset programmed by the kernel's remap. */
  static readonly DEFAULT_VECTOR_BASE = 0x20;

  constructor(vectorBase: number = PicPair.DEFAULT_VECTOR_BASE) {
    this.master = new Pic8259(false, Pic8259.MASTER_COMMAND);
    this.slave = new Pic8259(true, Pic8259.SLAVE_COMMAND);
    this.wire();
    this.remap(vectorBase);
  }

  private wire(): void {
    // The slave consults the master's mask for IRQ2.
    this.slave.masterMaskHook = (irq: number): boolean => {
      if (irq !== 2) return true;
      return this.master.isUnmasked(2);
    };
    // The master learns whether the slave has anything pending on IRQ2.
    this.master.slavePendingHook = (): boolean => {
      return (this.slave.interruptRequestRegister & ~this.slave.mask) !== 0;
    };
  }

  /**
   * Perform the standard remap: vectors 0x00-0x1F belong to CPU exceptions, so
   * hardware IRQs must start at 0x20. Without this, a timer interrupt lands on
   * vector 8 and is indistinguishable from a double fault.
   */
  remap(vectorBase: number): void {
    this.programController(this.master, vectorBase);
    this.programController(this.slave, vectorBase + 8);
  }

  private programController(pic: Pic8259, vectorBase: number): void {
    const cmd = pic.isSlave ? Pic8259.SLAVE_COMMAND : Pic8259.MASTER_COMMAND;
    const data = cmd + 1;
    // ICW1: expect ICW4, 8086/88 mode, edge triggered, cascade mode.
    this.writeRaw(cmd, 0x11);
    // ICW2: vector offset.
    this.writeRaw(data, vectorBase);
    // ICW3: cascade identity (master says "slave is on IRQ2"; slave says "I am 2").
    this.writeRaw(data, pic.isSlave ? 0x02 : 0x04);
    // ICW4: 8086/88 mode.
    this.writeRaw(data, 0x01);
    // Everything masked until the kernel deliberately unmasks.
    pic.setMask(0xff);
    pic.setVectorBase(vectorBase);
  }

  /**
   * Deliver the ICW sequence straight to a controller's ports.
   *
   * This bypasses the port bus because the PIC is programmed during kernel
   * initialisation, at which point the bus does not exist yet, and because the
   * sequence must be atomic with respect to the controller's init-step state.
   */
  private writeRaw(port: number, value: number): void {
    const pic = port === Pic8259.SLAVE_COMMAND || port === Pic8259.SLAVE_DATA ? this.slave : this.master;
    pic.portWrite(port - pic.startPort, 1, BigInt(value & 0xff));
  }

  /** Unmask one IRQ line across both controllers. */
  unmask(irq: number): void {
    if (irq >= 8) {
      this.slave.setMask(this.slave.mask & ~(1 << (irq - 8)));
      this.master.setMask(this.master.mask & ~0x04);
    } else {
      this.master.setMask(this.master.mask & ~(1 << irq));
    }
  }

  mask(irq: number): void {
    if (irq >= 8) {
      this.slave.setMask(this.slave.mask | (1 << (irq - 8)));
    } else {
      this.master.setMask(this.master.mask | (1 << irq));
    }
  }

  /** Deliver an interrupt line, returning the vector to invoke, or -1. */
  raise(irq: number): number {
    if (irq < 0 || irq > 15) return -1;
    if (irq === 2) return -1; // the cascade line is not a deliverable IRQ
    if (irq >= 8) {
      const delivered = this.slave.raise(irq);
      if (delivered < 0) return -1;
      return this.slave.programmedVectorBase + (irq - 8);
    }
    const delivered = this.master.raise(irq);
    if (delivered < 0) return -1;
    return this.master.programmedVectorBase + irq;
  }

  acknowledge(irq: number): void {
    if (irq >= 8) {
      this.slave.endOfInterrupt();
      // A slave interrupt must be followed by an EOI to the master as well.
      this.master.endOfInterrupt();
    } else {
      this.master.endOfInterrupt();
    }
  }

  /** Current state of both controllers, for the `verix irq` diagnostic. */
  dump(): string {
    return [
      `master: irr=0x${this.master.interruptRequestRegister.toString(16).padStart(2, '0')} isr=0x${this.master.inServiceRegister
        .toString(16)
        .padStart(2, '0')} mask=0x${this.master.mask.toString(16).padStart(2, '0')}`,
      `slave:  irr=0x${this.slave.interruptRequestRegister.toString(16).padStart(2, '0')} isr=0x${this.slave.inServiceRegister
        .toString(16)
        .padStart(2, '0')} mask=0x${this.slave.mask.toString(16).padStart(2, '0')}`,
    ].join('\n');
  }
}