/**
 * VerixOS - register file and RFLAGS.
 *
 * The register file models the x86-64 architectural register state: sixteen
 * 64-bit general purpose registers plus RIP. Sub-register access (8/16/32-bit)
 * follows the architectural rules exactly, in particular:
 *
 *  - 32-bit writes always zero-extend into the full 64-bit register. This is
 *    the single most common source of emulator bugs, so it is enforced here in
 *    one place rather than at every call site.
 *  - Only AX, CX, DX and BX have a high-byte form (AH, CH, DH, BH). The
 *    encoding `reg = 4..7` selects the high byte of RAX..RBX respectively.
 *  - Only AX, CX, DX, BX, SI and DI have 16-bit forms.
 *
 * Source: Intel SDM Vol. 1, Sec. 3.4.1.1 "General-Purpose Registers".
 */

import {
  REG8_NAMES,
  REG16_NAMES,
  REG32_NAMES,
  REG64_NAMES,
  REG_COUNT,
  FlagBit,
  RFLAGS_RESERVED_ONE,
  Reg,
} from './types.ts';



export class RegisterFile {
  /** General purpose registers, indexed by `Reg`. */
  readonly regs: BigUint64Array = new BigUint64Array(REG_COUNT);

  /** Instruction pointer. Separated from `regs` for fast target dispatch. */
  rip = 0n;

  /**
   * Debug-index-enable target address. When `enable` is set, RIP loads from
   * this address after every instruction. Source: Intel SDM Vol. 3, Sec. 4.17.
   */
  debugDr = new Array<bigint>(8).fill(0n) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  debugEnable = false;
  debugControl = 0n;

  constructor(initial?: Partial<Record<string, bigint>>) {
    if (!initial) return;
    for (const key of Object.keys(initial)) {
      const value = initial[key];
      if (value === undefined) continue;
      const index = Reg[key as keyof typeof Reg];
      if (typeof index === 'number') this.write(index, value);
    }
  }

  read(index: Reg): bigint {
    return this.regs[index]!;
  }

  write(index: Reg, value: bigint): void {
    this.regs[index] = value & 0xffff_ffff_ffff_ffffn;
  }

  /**
   * Read the low byte of one of the sixteen registers, with no REX semantics.
   *
   * This is `read8Low` under the old name. It is kept because "index 4 means
   * SPL" is the only interpretation that is valid for an executor: an index of
   * 4 from the decoder is always RSP's low byte or RAX's high byte depending on
   * `highByte`, never both.
   */
  read8(index: number): bigint {
    return this.read8Low(index);
  }

  /**
   * Read an 8-bit sub-register, choosing between the low byte and AH/CH/DH/BH.
   *
   * `high` must come from the decoder's `highByte` operand flag rather than be
   * re-derived here: for index 4-7 the same field means AH/CH/DH/BH with no REX
   * prefix and SPL/BPL/SIL/DIL with one, and the register file has no way to
   * tell which encoding it is being asked about.
   */
  readByte(index: number, high: boolean): bigint {
    const reg = index & 0x0f;
    if (high) return (this.regs[reg]! >> 8n) & 0xffn;
    return this.read8Low(reg);
  }

  /** Low byte of each of the sixteen registers: AL, CL, DL, BL, SPL..DIL, R8B..R15B. */
  read8Low(index: number): bigint {
    const reg = index & 0x0f;
    return this.regs[reg]! & 0xffn;
  }

  /** Write the low byte of one of the sixteen registers. */
  write8Low(index: number, value: bigint): void {
    const reg = index & 0x0f;
    this.regs[reg] = (this.regs[reg]! & ~0xffn) | (value & 0xffn);
  }

  /**
   * Write the high byte (AH/CH/DH/BH) of RAX-RBX. `index` is the host register.
   */
  write8High(index: number, value: bigint): void {
    const reg = index & 0x03;
    this.regs[reg] = (this.regs[reg]! & ~0xff00n) | ((value & 0xffn) << 8n);
  }

  /**
   * Read a raw 3-bit byte register field, where 4-7 select the high byte.
   *
   * This is the pre-REX convention: encoding a field of 6 as DH is exactly what
   * a REX-less `mov dh, ...` means. The executor should use `readByte` with the
   * decoder's `highByte` flag; this accessor exists for name-based lookup and for
   * tools that hold a raw field rather than a decoded operand.
   */
  read8Field(index: number): bigint {
    const reg = index & 0x0f;
    // Fields 0-3 are the low byte of RAX-RBX; 4-7 are the high byte of the
    // same four registers (AH/CH/DH/BH); 8-15 are the low byte of R8-R15.
    if (reg < 4) return this.regs[reg]! & 0xffn;
    if (reg < 8) return (this.regs[reg - 4]! >> 8n) & 0xffn;
    return this.regs[reg]! & 0xffn;
  }

  /**
   * Write an 8-bit sub-register, choosing between the low byte and AH/CH/DH/BH.
   * Mirror of `readByte`; `high` comes from the decoder's `highByte` flag.
   */
  writeByte(index: number, high: boolean, value: bigint): void {
    if (high) {
      this.write8High(index, value);
      return;
    }
    this.write8Low(index, value);
  }

  /**
   * Write to a raw 3-bit byte register field, where 4-7 select the high byte.
   * Counterpart to `read8Field`.
   */
  write8Field(index: number, value: bigint): void {
    const reg = index & 0x0f;
    const byte = value & 0xffn;
    if (reg < 4) {
      this.regs[reg] = (this.regs[reg]! & ~0xffn) | byte;
      return;
    }
    if (reg < 8) {
      const host = reg - 4;
      this.regs[host] = (this.regs[host]! & ~0xff00n) | (byte << 8n);
      return;
    }
    this.regs[reg] = (this.regs[reg]! & ~0xffn) | byte;
  }

  /**
   * Read a 16-bit sub-register. Only AX, CX, DX, BX, SP, BP, SI and DI have a
   * 16-bit form; passing any other index is a programming error.
   */
  read16(index: number): bigint {
    const reg = index & 0x07;
    return this.regs[reg]! & 0xffffn;
  }

  write16(index: number, value: bigint): void {
    const reg = index & 0x07;
    this.regs[reg] = (this.regs[reg]! & ~0xffffn) | (value & 0xffffn);
  }

  /**
   * Read a 32-bit sub-register. Never sign-extends: the result is always
   * zero-extended, which matches the value a 32-bit destination would hold.
   */
  read32(index: Reg): bigint {
    return this.regs[index]! & 0xffff_ffffn;
  }

  /** Write a 32-bit sub-register, zero-extending into the full 64-bit register. */
  write32(index: Reg, value: bigint): void {
    this.regs[index] = value & 0xffff_ffffn;
  }

  /** Read a 64-bit register by name, for readable debug output. */
  byName(name: string): bigint {
    const idx = REG64_NAMES.indexOf(name.toLowerCase() as (typeof REG64_NAMES)[number]);
    if (idx < 0) throw new Error(`unknown register: ${name}`);
    return this.regs[idx]!;
  }

  writeByName(name: string, value: bigint): void {
    const lower = name.toLowerCase();
    const i64 = REG64_NAMES.indexOf(lower as (typeof REG64_NAMES)[number]);
    if (i64 >= 0) {
      this.write(i64 as Reg, value);
      return;
    }
    const i32 = REG32_NAMES.indexOf(lower as (typeof REG32_NAMES)[number]);
    if (i32 >= 0) {
      this.write32(i32 as Reg, value);
      return;
    }
    const i16 = REG16_NAMES.indexOf(lower as (typeof REG16_NAMES)[number]);
    if (i16 >= 0) {
      this.write16(i16, value);
      return;
    }
    // REG8_NAMES is indexed in the raw-field convention (4-7 are AH/CH/DH/BH),
    // which is exactly what a name lookup needs: 'ah' resolves to field 4.
    const i8 = REG8_NAMES.indexOf(lower as (typeof REG8_NAMES)[number]);
    if (i8 >= 0) {
      this.write8Field(i8, value);
      return;
    }
    if (lower === 'rip') {
      this.rip = value & 0xffff_ffff_ffff_ffffn;
      return;
    }
    throw new Error(`unknown register: ${name}`);
  }

  /** True when this register index names a 32-bit-invalid form (RSP/RBP). */
  static requiresSByteDisp(index: number): boolean {
    return (index & 0x07) === Reg.SP || (index & 0x07) === Reg.BP;
  }

  snapshot(): bigint[] {
    return Array.from(this.regs);
  }

  restore(values: readonly bigint[]): void {
    for (let i = 0; i < REG_COUNT; i++) {
      this.regs[i] = (values[i] ?? 0n) & 0xffff_ffff_ffff_ffffn;
    }
  }
}

/**
 * Bit mask for a value that may legally be stored in RFLAGS.
 *
 * Bit 63 is architecturally reserved and always reads as 0; software can write
 * it but reading it back yields 0. Modelling that with an explicit mask means
 * POPF/POPFQ of an arbitrary 64-bit value behaves the way real hardware does,
 * instead of leaving a phantom flag set that later code would honour.
 */
const RFLAGS_STORABLE_MASK = 0x7fff_ffff_ffff_ffffn;

/**
 * Apply the two fixed rules that govern RFLAGS:
 *
 *  - Bit 1 reads as 1 and any write to it is discarded. Software depends on
 *    this to locate its own stack frame.
 *  - Bit 63 is reserved and always reads as 0.
 */
function normaliseFlags(v: bigint): bigint {
  return (v & RFLAGS_STORABLE_MASK) | RFLAGS_RESERVED_ONE;
}

/**
 * RFLAGS, modelled as named accessors over a 64-bit value rather than as raw
 * bit arithmetic at every use site.
 *
 * Two bits deserve special mention:
 *
 *  - Bit 1 reads as 1 and writes are discarded.
 *  - Bit 63 reads as 0. It is reserved and must not be stored.
 */
export class Flags {
  private bits = 0n;

  constructor(initial = 0x2n) {
    this.bits = normaliseFlags(initial);
  }

  get value(): bigint {
    return this.bits;
  }

  /** Restore RFLAGS wholesale, normalising the two architecturally fixed bits. */
  set value(v: bigint) {
    this.bits = normaliseFlags(v);
  }

  private get(bit: FlagBit): boolean {
    return (this.bits & (1n << BigInt(bit))) !== 0n;
  }

  private set(bit: FlagBit, on: boolean): void {
    const mask = 1n << BigInt(bit);
    this.bits = on ? this.bits | mask : this.bits & ~mask;
  }

  get cf(): boolean {
    return this.get(FlagBit.CF);
  }
  set cf(v: boolean) {
    this.set(FlagBit.CF, v);
  }

  get pf(): boolean {
    return this.get(FlagBit.PF);
  }
  set pf(v: boolean) {
    this.set(FlagBit.PF, v);
  }

  get af(): boolean {
    return this.get(FlagBit.AF);
  }
  set af(v: boolean) {
    this.set(FlagBit.AF, v);
  }

  get zf(): boolean {
    return this.get(FlagBit.ZF);
  }
  set zf(v: boolean) {
    this.set(FlagBit.ZF, v);
  }

  get sf(): boolean {
    return this.get(FlagBit.SF);
  }
  set sf(v: boolean) {
    this.set(FlagBit.SF, v);
  }

  get tf(): boolean {
    return this.get(FlagBit.TF);
  }
  set tf(v: boolean) {
    this.set(FlagBit.TF, v);
  }

  /** Interrupt enable flag; `CLI`/`STI` manipulate this. */
  get if(): boolean {
    return this.get(FlagBit.IF);
  }
  set if(v: boolean) {
    this.set(FlagBit.IF, v);
  }

  get df(): boolean {
    return this.get(FlagBit.DF);
  }
  set df(v: boolean) {
    this.set(FlagBit.DF, v);
  }

  get of(): boolean {
    return this.get(FlagBit.OF);
  }
  set of(v: boolean) {
    this.set(FlagBit.OF, v);
  }

  get ac(): boolean {
    return this.get(FlagBit.AC);
  }
  set ac(v: boolean) {
    this.set(FlagBit.AC, v);
  }

  /** Snapshot used by the debugger and by `get_flags`. */
  toObject(): Record<string, boolean> {
    return {
      cf: this.cf,
      pf: this.pf,
      af: this.af,
      zf: this.zf,
      sf: this.sf,
      tf: this.tf,
      if: this.if,
      df: this.df,
      of: this.of,
      ac: this.ac,
    };
  }
}

/**
 * Full arithmetic-flag update shared by ADD, SUB, INC, DEC, CMP, NEG, SHR and
 * friends. Keeping this in one place is what makes flag behaviour consistent
 * across the interpreter.
 */
export function setArithmeticFlags(
  flags: Flags,
  a: bigint,
  b: bigint,
  result: bigint,
  width: number,
  operation: 'add' | 'sub' | 'logic',
): void {
  const mask = widthMask(width);
  const x = a & mask;
  const y = b & mask;
  const r = result & mask;
  const signBit = 1n << BigInt(width - 1);

  flags.zf = r === 0n;
  flags.pf = parityEven(r);
  flags.sf = (r & signBit) !== 0n;

  switch (operation) {
    case 'add': {
      flags.cf = x + y > mask;
      flags.af = (x & 0x0fn) + (y & 0x0fn) > 0x0fn;
      flags.of = (x & signBit) === (y & signBit) && (r & signBit) !== (x & signBit);
      break;
    }
    case 'sub': {
      // SUB sets CF when a borrow is required, i.e. when a < b unsigned.
      flags.cf = x < y;
      flags.af = (x & 0x0fn) < (y & 0x0fn);
      flags.of = (x & signBit) !== (y & signBit) && (r & signBit) !== (x & signBit);
      break;
    }
    case 'logic': {
      // Logic operations clear CF, OF and AF. The SDM specifies AF as undefined;
      // real hardware clears it and so do we, so behaviour is deterministic.
      flags.cf = false;
      flags.of = false;
      flags.af = false;
      break;
    }
  }
}

/** True when `v` has an even number of set bits in its low byte (parity flag). */
export function parityEven(v: bigint): boolean {
  let x = Number(v & 0xffn);
  let count = 0;
  while (x !== 0) {
    count += x & 1;
    x >>= 1;
  }
  return (count & 1) === 0;
}

/** Mask with the low `width` bits set. */
export function widthMask(width: number): bigint {
  switch (width) {
    case 8:
      return 0xffn;
    case 16:
      return 0xffffn;
    case 32:
      return 0xffff_ffffn;
    case 64:
      return 0xffff_ffff_ffff_ffffn;
    default:
      throw new Error(`unsupported operand width: ${width}`);
  }
}

/** Sign-extend the low `width` bits of `v` to a full 64-bit value. */
export function signExtend(v: bigint, width: number): bigint {
  if (width >= 64) return v & 0xffff_ffff_ffff_ffffn;
  const signBit = 1n << (BigInt(width) - 1n);
  const masked = v & ((1n << BigInt(width)) - 1n);
  return ((masked ^ signBit) - signBit) & 0xffff_ffff_ffff_ffffn;
}

/** Interpret `v` as a signed integer of the given width, as a JS number. */
export function toSigned(v: bigint, width: number): number {
  // signExtend yields the 64-bit two's-complement value; narrowing to a JS
  // number by shifting right by the sign-extension distance preserves sign.
  const shift = BigInt(64 - Math.min(width, 63));
  const narrowed = signExtend(v, width) >> shift;
  return Number(narrowed);
}

/** Human-readable register dump, used by the debugger and by panic output. */
export function formatRegisters(regs: RegisterFile, flags: Flags): string {
  const lines: string[] = [];
  const pairs: [Reg, Reg][] = [
    [Reg.AX, Reg.BX],
    [Reg.CX, Reg.DX],
    [Reg.SI, Reg.DI],
    [Reg.BP, Reg.SP],
    [Reg.R8, Reg.R9],
    [Reg.R10, Reg.R11],
    [Reg.R12, Reg.R13],
    [Reg.R14, Reg.R15],
  ];
  for (const [hi, lo] of pairs) {
    const hiName = REG64_NAMES[hi]!.padStart(3, ' ');
    const loName = REG64_NAMES[lo]!.padStart(3, ' ');
    lines.push(
      `${hiName}=${regs.read(hi).toString(16).padStart(16, '0')} ${loName}=${regs.read(lo).toString(16).padStart(16, '0')}`,
    );
  }
  lines.push(`rip=${regs.rip.toString(16).padStart(16, '0')} rflags=${flags.value.toString(16).padStart(16, '0')}`);
  const f = flags.toObject();
  lines.push(
    `flags=[${Object.entries(f)
      .filter(([, on]) => on)
      .map(([name]) => name.toUpperCase())
      .join(' ')}]`,
  );
  return lines.join('\n');
}