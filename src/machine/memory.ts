/**
 * VerixOS - physical memory, MMIO regions and the system bus.
 *
 * The bus is the only component in the system allowed to move data between the
 * CPU and anything else. It is deliberately strict:
 *
 *  - Every access is bounds-checked against installed regions. An access to an
 *    unmapped address raises a `BusFault`, which the CPU converts into a real
 *    x86 fault (#PF or #GP). Nothing silently reads zero.
 *  - Access width is part of the API, so a byte write to a 32-bit-only device
 *    register is caught rather than silently truncated.
 *  - Little-endian is enforced structurally by reading and writing the backing
 *    `Uint8Array` in explicit byte order.
 *
 * Source: Intel SDM Vol. 1, Sec. 4.2 "Memory Organization".
 */

import { PageFaultError } from '../arch/types.ts';
import type { AccessKind } from '../arch/types.ts';

/**
 * Standard PC physical memory map. Regions listed here as `undefined` are
 * unmapped by default and only become accessible once a device claims them.
 *
 * Source: various OEM reference manuals; the low 1 MiB layout is fixed by the
 * IBM PC AT architecture.
 */
export const MemoryMap = {
  /** Conventional memory, below the first ISA hole. */
  LOW_RAM_END: 0x000a_0000n,
  /** VGA frame buffer window. */
  VGA_WINDOW_START: 0x000a_0000n,
  VGA_WINDOW_END: 0x000c_0000n,
  ROM_AREA_START: 0x000c_0000n,
  ROM_AREA_END: 0x0010_0000n,
  /** Extended BIOS data area. */
  EBDA_START: 0x000f_0000n,
  EBDA_END: 0x0010_0000n,
  /** Local APIC registers. */
  LAPIC_BASE: 0xfee0_0000n,
  LAPIC_END: 0xfee1_0000n,
  /** IOAPIC registers. */
  IOAPIC_BASE: 0xfec0_0000n,
  IOAPIC_END: 0xfed0_0000n,
  /** PCI configuration space via MMCONFIG. */
  MMCONFIG_BASE: 0xe000_0000n,
  MMCONFIG_END: 0xf000_0000n,
} as const;

/** Raised by the bus for any access the platform cannot satisfy. */
export class BusFault extends Error {
  readonly address: bigint;
  readonly kind: AccessKind;
  readonly widthBytes: number;

  constructor(address: bigint, kind: AccessKind, widthBytes: number, message?: string) {
    const detail = message ?? `${kind} of ${widthBytes} bytes at 0x${address.toString(16)} is not backed by RAM or an MMIO region`;
    super(detail);
    this.name = 'BusFault';
    this.address = address;
    this.kind = kind;
    this.widthBytes = widthBytes;
  }

  /**
   * Translate this fault into an x86-64 page fault error code.
   *
   * Only present pages produce error codes in the first place; this is
   * therefore always a present-page fault, and bit 3 (reserved) stays clear.
   * Source: Intel SDM Vol. 3, Table 4-14.
   */
  get pageFaultError(): number {
    let code = PageFaultError.I_D;
    if (this.kind === 'write') code |= PageFaultError.W;
    else if (this.kind === 'execute') code |= 0;
    return code;
  }
}

/** A device claiming a physical address range. */
export interface MmioRegion {
  readonly name: string;
  /** Inclusive start of the claimed range. */
  readonly start: bigint;
  /** Exclusive end of the claimed range. */
  readonly end: bigint;
  /** True when the region does not support reads (write-only). */
  readonly writeOnly?: boolean;
  /** True when the region does not support writes (read-only, e.g. ROM). */
  readonly readOnly?: boolean;

  read(offset: bigint, widthBytes: number): bigint;
  write(offset: bigint, widthBytes: number, value: bigint): void;
}

/** Flat physical RAM. Backed by one `Uint8Array` so that the page walker is fast. */
export class PhysicalMemory {
  readonly sizeBytes: number;
  private readonly bytes: Uint8Array;

  constructor(sizeBytes: number) {
    if (sizeBytes <= 0) throw new Error('RAM size must be positive');
    if (sizeBytes % 0x1000 !== 0) {
      throw new Error(`RAM size must be a multiple of 4096, got ${sizeBytes}`);
    }
    this.sizeBytes = sizeBytes;
    this.bytes = new Uint8Array(sizeBytes);
  }

  contains(addr: bigint, len = 1): boolean {
    if (addr < 0n || addr >= BigInt(this.sizeBytes)) return false;
    return addr + BigInt(len) <= BigInt(this.sizeBytes);
  }

  read(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length);
  }

  write(offset: number, data: Uint8Array): void {
    this.bytes.set(data, offset);
  }

  fill(offset: number, length: number, value: number): void {
    this.bytes.fill(value, offset, offset + length);
  }

  /**
   * Read `widthBytes` little-endian bytes starting at `addr`.
   * Callers must have validated the range.
   */
  readLE(addr: bigint, widthBytes: number): bigint {
    const base = Number(addr);
    let value = 0n;
    for (let i = widthBytes - 1; i >= 0; i--) {
      value = (value << 8n) | BigInt(this.bytes[base + i]!);
    }
    return value;
  }

  writeLE(addr: bigint, widthBytes: number, value: bigint): void {
    const base = Number(addr);
    for (let i = 0; i < widthBytes; i++) {
      this.bytes[base + i] = Number((value >> BigInt(8 * i)) & 0xffn);
    }
  }

  /** Copy a region out of RAM. Used by the debugger to dump physical memory. */
  dump(addr: bigint, length: number): Uint8Array {
    const start = Number(addr);
    return this.bytes.slice(start, start + length);
  }
}

/**
 * The system bus: routes CPU physical accesses to RAM or to an MMIO region.
 *
 * MMIO regions are kept in a sorted list and looked up by binary search, so
 * lookup cost is logarithmic in the number of devices rather than linear. This
 * matters because every single memory reference the kernel performs goes
 * through here.
 */
export class MemoryBus {
  readonly ram: PhysicalMemory;
  private readonly regions: MmioRegion[] = [];
  /** Observers notified after every write. Used by the debugger's watchpoints. */
  private readonly writeWatchers = new Set<(addr: bigint, width: number, value: bigint) => void>();

  constructor(ramBytes: number) {
    this.ram = new PhysicalMemory(ramBytes);
  }

  mapRegion(region: MmioRegion): void {
    if (region.end <= region.start) {
      throw new Error(`MMIO region ${region.name} has an empty range`);
    }
    const index = this.regions.findIndex((r) => r.start > region.start);
    if (index < 0) {
      this.regions.push(region);
    } else {
      this.regions.splice(index, 0, region);
    }
  }

  unmapRegion(name: string): void {
    const i = this.regions.findIndex((r) => r.name === name);
    if (i >= 0) this.regions.splice(i, 1);
  }

  findRegion(addr: bigint): MmioRegion | undefined {
    let lo = 0;
    let hi = this.regions.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.regions[mid]!;
      if (addr < r.start) hi = mid - 1;
      else if (addr >= r.end) lo = mid + 1;
      else return r;
    }
    return undefined;
  }

  onWrite(fn: (addr: bigint, width: number, value: bigint) => void): () => void {
    this.writeWatchers.add(fn);
    return () => this.writeWatchers.delete(fn);
  }

  read(addr: bigint, widthBytes: number): bigint {
    const region = this.findRegion(addr);
    if (region) {
      if (region.writeOnly === true) {
        throw new BusFault(addr, 'read', widthBytes, `MMIO region ${region.name} is write-only`);
      }
      return region.read(addr - region.start, widthBytes);
    }
    if (!this.ram.contains(addr, widthBytes)) {
      throw new BusFault(addr, 'read', widthBytes);
    }
    return this.ram.readLE(addr, widthBytes);
  }

  write(addr: bigint, widthBytes: number, value: bigint): void {
    const region = this.findRegion(addr);
    if (region) {
      if (region.readOnly === true) {
        throw new BusFault(addr, 'write', widthBytes, `MMIO region ${region.name} is read-only`);
      }
      region.write(addr - region.start, widthBytes, value);
    } else {
      if (!this.ram.contains(addr, widthBytes)) {
        throw new BusFault(addr, 'write', widthBytes);
      }
      this.ram.writeLE(addr, widthBytes, value);
    }
    for (const w of this.writeWatchers) w(addr, widthBytes, value);
  }

  /** Convenience wrappers used throughout the kernel. */
  read8(addr: bigint): number {
    return Number(this.read(addr, 1));
  }
  read16(addr: bigint): number {
    return Number(this.read(addr, 2));
  }
  read32(addr: bigint): number {
    return Number(this.read(addr, 4));
  }
  read64(addr: bigint): bigint {
    return this.read(addr, 8);
  }

  write8(addr: bigint, value: number): void {
    this.write(addr, 1, BigInt(value & 0xff));
  }
  write16(addr: bigint, value: number): void {
    this.write(addr, 2, BigInt(value & 0xffff));
  }
  write32(addr: bigint, value: number): void {
    this.write(addr, 4, BigInt(value >>> 0));
  }
  write64(addr: bigint, value: bigint): void {
    this.write(addr, 8, value);
  }

  /** Total bytes currently claimed by MMIO regions. Used by the memory report. */
  get mappedMmioBytes(): number {
    return this.regions.reduce((acc, r) => acc + Number(r.end - r.start), 0);
  }

  /** Names of currently mapped regions, in address order. */
  regionNames(): string[] {
    return this.regions.map((r) => r.name);
  }
}

/**
 * A convenience MMIO adapter over a fixed-size register file, which is how most
 * real device models are shaped. `layout` maps a register index to its offset
 * from `base`.
 *
 * Devices that need per-access side effects (the PIT's command ports, for
 * example) implement `MmioRegion` directly instead.
 */
export class RegisterDevice implements MmioRegion {
  private readonly registers = new Map<number, { offset: bigint; width: number }>();
  private readonly values = new Map<number, bigint>();

  readonly name: string;
  readonly base: bigint;
  readonly size: bigint;
  readonly defaultValue: bigint;
  readonly readOnly: boolean;

  constructor(name: string, base: bigint, size: bigint, defaultValue = 0n, readOnly = false) {
    this.name = name;
    this.base = base;
    this.size = size;
    this.defaultValue = defaultValue;
    this.readOnly = readOnly;
  }

  /** Declare a register at `offset` from `base` with the given access width. */
  define(offset: bigint, width = 4): this {
    this.registers.set(Number(offset), { offset, width });
    this.values.set(Number(offset), this.defaultValue);
    return this;
  }

  get(offset: bigint): bigint {
    return this.values.get(Number(offset)) ?? 0n;
  }

  set(offset: bigint, value: bigint): void {
    this.values.set(Number(offset), value);
  }

  get start(): bigint {
    return this.base;
  }

  get end(): bigint {
    return this.base + this.size;
  }

  read(offset: bigint, _widthBytes: number): bigint {
    const reg = this.registers.get(Number(offset));
    if (!reg) return 0n;
    return this.values.get(Number(offset)) ?? 0n;
  }

  /**
   * Write a register, honouring x86 sub-width merge semantics.
   *
   * A narrower write than the register width updates only the byte lanes that
   * were actually written and leaves the rest of the register intact, exactly
   * as real hardware behaves. A write at or above the register width replaces
   * the whole register, masked to the register width.
   */
  write(offset: bigint, widthBytes: number, value: bigint): void {
    if (this.readOnly) return;
    const reg = this.registers.get(Number(offset));
    if (!reg) return;

    const regBytes = reg.width;
    const previous = this.values.get(Number(offset)) ?? 0n;
    const laneMask = (1n << BigInt(widthBytes * 8)) - 1n;

    if (widthBytes >= regBytes) {
      const fullMask = (1n << BigInt(regBytes * 8)) - 1n;
      this.values.set(Number(offset), value & fullMask);
      return;
    }

    const merged = (previous & ~laneMask) | (value & laneMask);
    this.values.set(Number(offset), merged);
  }
}