/**
 * VerixOS - x86/x86-64 instruction decoder.
 *
 * Produces a decoded `Instruction` from a byte stream. The decoder is pure: it
 * reads through an injected `ByteReader` and never touches machine state, so it
 * can be unit-tested against hand-written byte sequences in isolation from the
 * CPU, the memory manager and the devices.
 *
 * ## Why the ModRM byte is read first, always
 *
 * Most x86 opcodes are followed immediately by a ModRM byte whose middle three
 * bits are the `reg` field. Any decoder that inspects `reg` before consuming
 * ModRM is reading stale state. `readModrm` is therefore called at the very top
 * of the per-opcode dispatch, before any operand is constructed, and it stores
 * the decoded `mod`/`reg`/`rm`/memory-operand for the rest of the dispatch to
 * use. Getting this order wrong produces subtly wrong operand selection rather
 * than a decode failure, which is the worst kind of bug to find later.
 *
 * ## Modes
 *
 *  - 16-bit real mode: boot sector and stage 2 pre-transition
 *  - 32-bit protected mode: the legacy BIOS call convention
 *  - 64-bit long mode: the kernel
 *
 * Source: Intel SDM Vol. 2, Chapters 2-3 (instruction format and opcode map).
 */

import { REG8_NAMES, Reg } from './types.ts';

export const CpuMode = {
  REAL16: 'real16',
  PROTECTED32: 'protected32',
  LONG64: 'long64',
} as const;

export type CpuMode = (typeof CpuMode)[keyof typeof CpuMode];

/**
 * Decoded operand forms.
 *
 * `reg` fields hold the final register index *after* REX extension, so the
 * executor never applies REX itself.
 */
export type Operand =
  | {
      readonly kind: 'reg';
      readonly reg: number;
      /**
       * True when this names a *high* byte sub-register (AH/CH/DH/BH).
       *
       * A plain 16-way register index cannot express these: index 6 is RSI's low
       * byte (SIL) once a REX prefix is present, but it is DH when no REX prefix
       * is present. The decoder therefore resolves the encoding to the *host*
       * register in `reg` - so `mov ah, ...` decodes to `reg: Reg.AX` - and sets
       * this flag, leaving the executor to pick the accessor rather than
       * re-deriving the distinction from the prefix bytes.
       *
       * Optional and always written by this decoder's own helpers; it is left
       * optional so that the many ordinary 16/32/64-bit register operands can be
       * written without noise. Absent means "not a high byte sub-register".
       */
      readonly highByte?: boolean;
    }
  | { readonly kind: 'imm'; readonly value: bigint; readonly width: number }
  | {
      readonly kind: 'mem';
      readonly base: number;
      readonly index: number;
      readonly scale: number;
      readonly disp: bigint;
      readonly ripRelative: boolean;
      readonly sizeOverride: '16' | '32' | '64';
    }
  | { readonly kind: 'rel'; readonly target: bigint }
  | { readonly kind: 'seg'; readonly seg: number }
  | { readonly kind: 'moffs'; readonly addr: bigint };

export const Mnemonic = {
  ADD: 'add',
  OR: 'or',
  ADC: 'adc',
  SBB: 'sbb',
  AND: 'and',
  SUB: 'sub',
  XOR: 'xor',
  CMP: 'cmp',

  INC: 'inc',
  DEC: 'dec',
  NOT: 'not',
  NEG: 'neg',
  MUL: 'mul',
  IMUL: 'imul',
  DIV: 'div',
  IDIV: 'idiv',

  MOV: 'mov',
  MOVZX: 'movzx',
  MOVSX: 'movsx',
  LEA: 'lea',
  XCHG: 'xchg',

  PUSH: 'push',
  POP: 'pop',
  PUSHF: 'pushf',
  POPF: 'popf',
  PUSHA: 'pusha',
  POPA: 'popa',
  LEAVE: 'leave',

  JMP: 'jmp',
  JCC: 'jcc',
  SETCC: 'setcc',
  CALL: 'call',
  RET: 'ret',
  LOOP: 'loop',
  LOOPE: 'loope',
  LOOPNE: 'loopne',

  TEST: 'test',
  SHL: 'shl',
  SHR: 'shr',
  SAR: 'sar',
  ROL: 'rol',
  ROR: 'ror',

  HLT: 'hlt',
  NOP: 'nop',
  CLI: 'cli',
  STI: 'sti',
  CLD: 'cld',
  STD: 'std',
  CLC: 'clc',
  STC: 'stc',
  CMC: 'cmc',
  LAHF: 'lahf',
  SAHF: 'sahf',
  CWDE: 'cwde',
  CDQ: 'cdq',

  CPUID: 'cpuid',
  RDTSC: 'rdtsc',
  UD2: 'ud2',

  IN: 'in',
  OUT: 'out',

  MOV_CR: 'mov_cr',
  LGDT: 'lgdt',
  LIDT: 'lidt',
  LTR: 'ltr',

  INT: 'int',
  INT3: 'int3',
  IRET: 'iret',

  MOVS: 'movs',
  STOS: 'stos',
  LODS: 'lods',
  SCAS: 'scas',
  CMPS: 'cmps',

  SYSCALL: 'syscall',
  SWAPGS: 'swapgs',

  /** Segment push/pop, used by the 0x0F A0/A1 and A8/A9 forms. */
  PUSH_FS: 'push_fs',
  POP_FS: 'pop_fs',
  PUSH_GS: 'push_gs',
  POP_GS: 'pop_gs',
  /** Standalone INVLPG (0x0F 0x01 /7). */
  INVLGDT: 'invlgdt',
  /** String I/O: INS and OUTS, the port-addressed string primitives. */
  INS: 'ins',
  OUTS: 'outs',
  /** Segment-register push/pop that are separate opcodes rather than ModRM. */
  PUSH_SEG: 'push_seg',
  POP_SEG: 'pop_seg',

  /** Decoded but deliberately not executed; the CPU raises #UD. */
  UNIMPLEMENTED: 'unimplemented',
} as const;

export type Mnemonic = (typeof Mnemonic)[keyof typeof Mnemonic];

export const AluOp = { ADD: 0, OR: 1, ADC: 2, SBB: 3, AND: 4, SUB: 5, XOR: 6, CMP: 7 } as const;
export type AluOp = (typeof AluOp)[keyof typeof AluOp];

export const ShiftOp = { ROL: 0, ROR: 1, RCL: 2, RCR: 3, SHL: 4, SHR: 5, SAR: 6, RESERVED: 7 } as const;
export type ShiftOp = (typeof ShiftOp)[keyof typeof ShiftOp];

/** A decoded ModRM byte together with its resolved memory operand, if any. */
export interface ModRm {
  readonly mod: number;
  /** Middle three bits, already extended by REX.R. */
  readonly reg: number;
  /** Low three bits, already extended by REX.B. Only meaningful when mod=3. */
  readonly rm: number;
  /** Present when mod != 3. */
  readonly mem: Extract<Operand, { kind: 'mem' }> | undefined;
  /** True when the ModRM byte selects register form. */
  readonly isRegister: boolean;
}

export interface Instruction {
  readonly length: number;
  readonly mnemonic: Mnemonic;
  readonly operands: readonly Operand[];
  /** Effective operand size in bits: 8, 16, 32 or 64. */
  readonly operandSize: number;
  /** Effective address size in bits: 16, 32 or 64. */
  readonly addressSize: number;
  readonly rex: number;
  readonly lock: boolean;
  readonly rep: 'none' | 'rep' | 'repne';
  readonly aluOp: AluOp | undefined;
  readonly shiftOp: ShiftOp | undefined;
  /** Condition index 0-15 for Jcc and SETcc. */
  readonly condition: number | undefined;
  /**
   * Source operand width for MOVZX/MOVSX. Fixed by the opcode (8 or 16) rather
   * than by the operand-size prefix, so the executor needs it separately.
   */
  readonly sourceSize: number | undefined;
  /** True when the instruction was 0x0F-prefixed. */
  readonly twoByte: boolean;
  /** True when any REX prefix was present. */
  readonly hasRex: boolean;
  readonly origin: bigint;
  toString(): string;
}

export class DecodeError extends Error {
  readonly address: bigint;
  readonly opcode: number;

  constructor(message: string, address: bigint, opcode: number) {
    super(`${message} at 0x${address.toString(16)} (opcode 0x${opcode.toString(16).padStart(2, '0')})`);
    this.name = 'DecodeError';
    this.address = address;
    this.opcode = opcode;
  }
}

export type ByteReader = (addr: bigint) => number;

/** Reader over a flat buffer, for tests and for disassembly. */
export function bufferReader(bytes: Uint8Array, origin: bigint): ByteReader {
  return (addr: bigint): number => {
    const offset = Number(addr - origin);
    if (offset < 0 || offset >= bytes.length) {
      throw new DecodeError('instruction fetch ran past the end of the buffer', addr, 0);
    }
    return bytes[offset]!;
  };
}

interface Prefixes {
  operandSize: 8 | 16 | 32 | 64;
  addressSize: 16 | 32 | 64;
  rex: number;
  hasRex: boolean;
  lock: boolean;
  rep: 'none' | 'rep' | 'repne';
}

/** Decoded ModRM state, cached for the duration of one instruction. */
interface Ctx extends Prefixes {
  mode: CpuMode;
  origin: bigint;
}

export class InstructionDecoder {
  private cursor = 0n;
  private readonly reader: ByteReader;
  private ctx: Ctx;
  private modrm: ModRm | undefined;

  constructor(reader: ByteReader, mode: CpuMode = CpuMode.LONG64) {
    this.reader = reader;
    this.ctx = {
      mode,
      origin: 0n,
      operandSize: 32,
      addressSize: 64,
      rex: 0,
      hasRex: false,
      lock: false,
      rep: 'none',
    };
  }

  decode(address: bigint, mode?: CpuMode): Instruction {
    this.cursor = address;
    this.modrm = undefined;

    const prefixes = this.readPrefixes(mode ?? this.ctx.mode);
    this.ctx = {
      ...prefixes,
      mode: mode ?? this.ctx.mode,
      origin: address,
    };

    let opcode = this.u8();
    let twoByte = false;
    if (opcode === 0x0f) {
      twoByte = true;
      opcode = this.u8();
    }

    const decoded = twoByte
      ? this.decodeTwoByte(opcode)
      : this.decodeOneByte(opcode);

    const length = Number(this.cursor - address);
    const { mnemonic, operands, aluOp, shiftOp, condition, sourceSize } = decoded;

    return {
      length,
      mnemonic,
      operands,
      operandSize: this.ctx.operandSize,
      addressSize: this.ctx.addressSize,
      rex: this.ctx.rex,
      lock: this.ctx.lock,
      rep: this.ctx.rep,
      aluOp,
      shiftOp,
      condition,
      sourceSize,
      twoByte,
      hasRex: this.ctx.hasRex,
      origin: address,
      toString: () => formatInstruction(address, length, mnemonic, operands, condition),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Byte fetching                                                       */
  /* ------------------------------------------------------------------ */

  private u8(): number {
    const v = this.reader(this.cursor) & 0xff;
    this.cursor += 1n;
    return v;
  }

  private u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  private u32(): number {
    const lo = this.u16();
    const hi = this.u16();
    return (lo | (hi << 16)) >>> 0;
  }

  private u64(): bigint {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(this.u8()) << BigInt(8 * i);
    return v;
  }

  private immSigned(width: number): bigint {
    switch (width) {
      case 8:
        return BigInt.asIntN(8, BigInt(this.u8()));
      case 16:
        return BigInt.asIntN(16, BigInt(this.u16()));
      case 32:
        return BigInt.asIntN(32, BigInt(this.u32()));
      case 64:
        return BigInt.asIntN(64, this.u64());
      default:
        throw new DecodeError(`unsupported immediate width ${width}`, this.cursor, 0);
    }
  }

  private immUnsigned(width: number): bigint {
    switch (width) {
      case 8:
        return BigInt(this.u8());
      case 16:
        return BigInt(this.u16());
      case 32:
        return BigInt(this.u32());
      case 64:
        return this.u64();
      default:
        throw new DecodeError(`unsupported immediate width ${width}`, this.cursor, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Prefixes                                                            */
  /* ------------------------------------------------------------------ */

  private readPrefixes(mode: CpuMode): Prefixes {
    const long = mode === CpuMode.LONG64;
    let operandSize: 8 | 16 | 32 | 64 = long ? 32 : 16;
    let addressSize: 16 | 32 | 64 =
      mode === CpuMode.REAL16 ? 16 : mode === CpuMode.PROTECTED32 ? 32 : 64;
    let rex = 0;
    let hasRex = false;
    let lock = false;
    let rep: Prefixes['rep'] = 'none';

    for (;;) {
      const b = this.reader(this.cursor) & 0xff;
      switch (b) {
        case 0x66:
          operandSize = operandSize === 16 ? 32 : 16;
          this.cursor += 1n;
          continue;
        case 0x67:
          addressSize = addressSize === 32 ? 16 : 32;
          this.cursor += 1n;
          continue;
        case 0xf0:
          lock = true;
          this.cursor += 1n;
          continue;
        case 0xf2:
          rep = 'repne';
          this.cursor += 1n;
          continue;
        case 0xf3:
          rep = 'rep';
          this.cursor += 1n;
          continue;
        // Segment overrides are consumed and ignored: VerixOS runs flat, and a
        // stray override must not change an operand's meaning.
        case 0x2e:
        case 0x36:
        case 0x3e:
        case 0x26:
        case 0x64:
        case 0x65:
          this.cursor += 1n;
          continue;
        default:
          break;
      }
      // REX is only meaningful as the *last* prefix before the opcode.
      if (long && b >= 0x40 && b <= 0x4f) {
        rex = b & 0x0f;
        hasRex = true;
        this.cursor += 1n;
      }
      break;
    }

    if (hasRex && (rex & 0x08) !== 0) operandSize = 64;

    return { operandSize, addressSize, rex, hasRex, lock, rep };
  }

  private get rexR(): number {
    return (this.ctx.rex & 0x04) >> 2;
  }
  private get rexX(): number {
    return (this.ctx.rex & 0x02) >> 1;
  }
  private get rexB(): number {
    return this.ctx.rex & 0x01;
  }

  /* ------------------------------------------------------------------ */
  /* ModRM / SIB / displacement                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Consume the ModRM byte and everything that follows it, resolving the memory
   * operand when the addressing mode calls for one.
   */
  private readModrm(): ModRm {
    if (this.modrm) return this.modrm;
    const byte = this.u8();
    const mod = (byte >> 6) & 3;
    const reg = ((byte >> 3) & 7) | (this.rexR << 3);
    const rmRaw = byte & 7;

    if (mod === 3) {
      const rm = rmRaw | (this.rexB << 3);
      this.modrm = { mod, reg, rm, mem: undefined, isRegister: true };
      return this.modrm;
    }

    const mem = this.decodeMemory(mod, rmRaw);
    this.modrm = { mod, reg, rm: rmRaw | (this.rexB << 3), mem, isRegister: false };
    return this.modrm;
  }

  /**
   * Decode the memory operand: SIB byte where present, then displacement.
   *
   * The three address widths have genuinely different rules, so they are
   * handled separately:
   *
   *  - 16-bit uses a fixed table of eight addressing modes indexed by rm.
   *  - 32/64-bit use SIB. `rm=100` means "a SIB byte follows", not RSP.
   *  - In 64-bit, `mod=00, rm=101` is RIP-relative. Treating it as an absolute
   *    address is the classic long-mode trap: it converts every
   *    position-independent access into a wild jump.
   */
  private decodeMemory(mod: number, rmRaw: number): Extract<Operand, { kind: 'mem' }> {
    const size = this.ctx.addressSize;

    if (size === 16) {
      const table: ReadonlyArray<readonly [number, number, number]> = [
        [Reg.BX, Reg.SI, 1],
        [Reg.BX, Reg.DI, 1],
        [Reg.BP, Reg.SI, 1],
        [Reg.BP, Reg.DI, 1],
        [Reg.SI, -1, 1],
        [Reg.DI, -1, 1],
        [-1, -1, 1],
        [Reg.BX, -1, 1],
      ];
      let entry = table[rmRaw]!;
      let disp = 0n;
      if (mod === 1) {
        disp = this.immSigned(8);
      } else if (mod === 2) {
        disp = this.immSigned(16);
      } else if (rmRaw === 6) {
        disp = BigInt(this.u16());
      }
      return {
        kind: 'mem',
        base: entry[0],
        index: entry[1],
        scale: entry[2],
        disp,
        ripRelative: false,
        sizeOverride: '16',
      };
    }

    let base = -1;
    let index = -1;
    let scale = 1;
    let ripRelative = false;
    let disp = 0n;

    if (rmRaw === 4) {
      const sib = this.u8();
      scale = 1 << ((sib >> 6) & 3);
      const indexField = (sib >> 3) & 7;
      const baseField = sib & 7;
      index = indexField | (this.rexX << 3);
      // index field 100 means "no index" unless REX.X extends it to R12.
      if (indexField === 4 && this.rexX === 0) index = -1;
      base = baseField | (this.rexB << 3);
      // SIB with base field 101 and mod=00 has no base register at all, so the
      // whole address is the disp32 that follows. That displacement still has
      // to be consumed: without it the instruction length comes out short, the
      // next instruction is fetched from the middle of this one, and every
      // absolute address reached through a SIB byte decodes wrongly.
      if (mod === 0 && baseField === 5) {
        base = -1;
        return {
          kind: 'mem',
          base,
          index,
          scale,
          disp: this.immSigned(32),
          ripRelative: false,
          sizeOverride: size === 64 ? '64' : '32',
        };
      }
    } else if (rmRaw === 5 && mod === 0) {
      if (size === 64) {
        // RIP-relative. The displacement is relative to the *end* of the
        // instruction, which the CPU resolves once the length is known.
        return {
          kind: 'mem',
          base: -1,
          index: -1,
          scale,
          disp: this.immSigned(32),
          ripRelative: true,
          sizeOverride: '64',
        };
      }
      // 32-bit absolute address.
      return {
        kind: 'mem',
        base: -1,
        index: -1,
        scale,
        disp: this.immSigned(32),
        ripRelative: false,
        sizeOverride: '32',
      };
    } else {
      base = rmRaw | (this.rexB << 3);
    }

    if (mod === 1) {
      disp = this.immSigned(8);
    } else if (mod === 2) {
      disp = this.immSigned(32);
    }

    return {
      kind: 'mem',
      base,
      index,
      scale,
      disp,
      ripRelative,
      sizeOverride: size === 64 ? '64' : '32',
    };
  }

  /* ------------------------------------------------------------------ */
  /* Operand helpers                                                     */
  /* ------------------------------------------------------------------ */

  /** r/m operand: the memory operand if present, otherwise the rm register. */
  private rmOperand(): Operand {
    const m = this.readModrm();
    if (m.mem) return m.mem;
    return { kind: 'reg', reg: m.rm };
  }

  /** reg operand: the ModRM `reg` field. */
  private regOperand(): Operand {
    return { kind: 'reg', reg: this.readModrm().reg };
  }

  /**
   * Resolve a raw 8-bit register *field* into an operand.
   *
   * This is the one place the AH/CH/DH/BH-versus-SPL/BPL/SIL/DIL rule lives. With
   * no REX prefix, fields 4-7 mean the high byte of RAX-RBX. With any REX prefix
   * present - even an empty `REX = 0x40` - the same fields mean the low byte of
   * RSP/RBP/RSI/RDI, and fields 8-15 mean R8B-R15B. Re-deriving this at each
   * call site is exactly how `mov [rax], sil` and `mov [rax], dh` get swapped,
   * so the rule is centralised here and both the r/m and reg sides call it.
   */
  private byteOperand(field: number): Operand {
    if (!this.ctx.hasRex && field >= 4 && field <= 7) {
      return { kind: 'reg', reg: field - 4, highByte: true };
    }
    return { kind: 'reg', reg: field & 0x0f, highByte: false };
  }

  /** r/m8: an 8-bit register operand, or a memory operand. */
  private byteRegisterOperand(): Operand {
    return this.byteOperand(this.readModrm().rm);
  }

  /** The ModRM `reg` field as an 8-bit register operand. */
  private regOperand8(): Operand {
    return this.byteOperand(this.readModrm().reg);
  }

  /** Relative branch target, computed from the end of the displacement. */
  private relTarget(width: 8 | 16 | 32): bigint {
    const disp = this.immSigned(width);
    return this.cursor + disp;
  }

  private rel(): Operand {
    return { kind: 'rel', target: this.relTarget(8) };
  }

  /* ------------------------------------------------------------------ */
  /* Dispatch                                                            */
  /* ------------------------------------------------------------------ */

  private result(
    mnemonic: Mnemonic,
    operands: Operand[],
    extra: { aluOp?: AluOp; shiftOp?: ShiftOp; condition?: number; sourceSize?: number } = {},
  ): {
    mnemonic: Mnemonic;
    operands: Operand[];
    aluOp: AluOp | undefined;
    shiftOp: ShiftOp | undefined;
    condition: number | undefined;
    sourceSize: number | undefined;
  } {
    return {
      mnemonic,
      operands,
      aluOp: extra.aluOp,
      shiftOp: extra.shiftOp,
      condition: extra.condition,
      sourceSize: extra.sourceSize,
    };
  }

  /** ALU accumulator-immediate and accumulator-register forms, 0x00-0x3D. */
  private decodeOneByte(opcode: number): ReturnType<InstructionDecoder['result']> {
    const os = this.ctx.operandSize;
    const acc = (): Operand => ({ kind: 'reg', reg: Reg.AX });

    // 0x00-0x3D: the eight ALU operations in six addressing forms each.
    //
    // The ALU opcodes are exactly those where bit 6 is clear and the low three
    // bits are <= 5. Matching on that range rather than "opcode <= 0x3D" matters:
    // the wider test also swallows 0x06/0x07 (PUSH/POP ES) and 0x27/0x2F/0x37/0x3F
    // (PUSHA/POPA), which are not ALU instructions at all.
    if ((opcode & 0xc0) === 0 && (opcode & 7) <= 5) {
      const aluOp = ((opcode >> 3) & 7) as AluOp;
      const form = opcode & 7;
      const mnemonic = aluMnemonic(aluOp);
      const byteForm = (form & 1) === 0;
      const width = byteForm ? 8 : this.ctx.operandSize;

      switch (form) {
        // op r/m, r  (0x00 /r, 0x01 /r)
        case 0:
        case 1: {
          this.readModrm();
          const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
          const r = byteForm ? this.regOperand8() : this.regOperand();
          return this.result(mnemonic, [rm, r], { aluOp });
        }
        // op r, r/m  (0x02 /r, 0x03 /r)
        case 2:
        case 3: {
          this.readModrm();
          const r = byteForm ? this.regOperand8() : this.regOperand();
          const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
          return this.result(mnemonic, [r, rm], { aluOp });
        }
        // op al, imm8  (0x04 ib) - no ModRM
        case 4:
          return this.result(mnemonic, [
            { kind: 'reg', reg: Reg.AX },
            { kind: 'imm', value: this.immUnsigned(8), width: 8 },
          ], { aluOp });
        // op eAX, imm  (0x05 id) - no ModRM
        case 5:
          return this.result(mnemonic, [
            { kind: 'reg', reg: Reg.AX },
            { kind: 'imm', value: this.immUnsigned(width), width },
          ], { aluOp });
        default:
          break;
      }
    }

    switch (opcode) {
      case 0x0f:
        return this.result(Mnemonic.UNIMPLEMENTED, []);

      // Segment push/pop: 06/0E/16/1E push, 07/0F/17/1F pop.
      // These are separate opcodes, not ALU forms, and must be matched before
      // any range-based ALU test can swallow them.
      case 0x06: case 0x0e: case 0x16: case 0x1e:
        return this.result(Mnemonic.PUSH_SEG, [{ kind: 'seg', seg: segmentForPush(opcode) }]);
      case 0x07: case 0x0f: case 0x17: case 0x1f:
        return this.result(Mnemonic.POP_SEG, [{ kind: 'seg', seg: segmentForPush(opcode - 1) }]);
      case 0x26: case 0x2e: case 0x36: case 0x3e:
        return this.result(Mnemonic.PUSH_SEG, [{ kind: 'seg', seg: segmentForPrefix(opcode) }]);
      case 0x27: case 0x2f: case 0x37: case 0x3f:
        return this.result(Mnemonic.POP_SEG, [{ kind: 'seg', seg: segmentForPrefix(opcode - 1) }]);

      // 0x50-0x57 push r, 0x58-0x5F pop r
      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57:
        return this.result(Mnemonic.PUSH, [
          { kind: 'reg', reg: (opcode & 7) | (this.rexB << 3) },
        ]);
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        return this.result(Mnemonic.POP, [
          { kind: 'reg', reg: (opcode & 7) | (this.rexB << 3) },
        ]);

      case 0x68:
        return this.result(Mnemonic.PUSH, [{ kind: 'imm', value: this.immUnsigned(os), width: os }]);
      case 0x6a:
        return this.result(Mnemonic.PUSH, [{ kind: 'imm', value: this.immSigned(8), width: 8 }]);

      case 0x69: {
        this.readModrm();
        const dest = this.regOperand();
        const src = this.rmOperand();
        return this.result(Mnemonic.IMUL, [dest, src, { kind: 'imm', value: this.immUnsigned(os), width: os }]);
      }
      case 0x6b: {
        this.readModrm();
        const dest = this.regOperand();
        const src = this.rmOperand();
        return this.result(Mnemonic.IMUL, [dest, src, { kind: 'imm', value: this.immSigned(8), width: 8 }]);
      }
      case 0x6c: case 0x6d:
        return this.result(Mnemonic.INS, []);
      case 0x6e: case 0x6f:
        return this.result(Mnemonic.OUTS, []);

      // Short conditional jumps.
      case 0x70: case 0x71: case 0x72: case 0x73:
      case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b:
      case 0x7c: case 0x7d: case 0x7e: case 0x7f:
        return this.result(Mnemonic.JCC, [this.rel()], { condition: opcode & 0x0f });

      case 0x80: case 0x81: case 0x82: case 0x83: {
        const m = this.readModrm();
        const aluOp = m.reg as AluOp;
        const mnemonic = aluMnemonic(aluOp);
        const width = opcode === 0x80 || opcode === 0x82 ? 8 : os;
        const dest = width === 8 ? this.byteRegisterOperand() : this.rmOperand();
        // 0x80/0x82 carry an unsigned byte immediate. 0x81 takes a full-width
        // immediate, but 0x83 always takes a sign-extended imm8 regardless of
        // the operand size - there is no imm32 encoding of the 0x83 form.
        const imm =
          opcode === 0x80 || opcode === 0x82
            ? this.immUnsigned(8)
            : opcode === 0x83
              ? this.immSigned(8)
              : this.immSigned(width);
        return this.result(mnemonic, [dest, { kind: 'imm', value: imm, width }], { aluOp });
      }

      // 0x84-0x8B: the byte forms (even opcode) carry an 8-bit reg operand, so
      // they must resolve it through regOperand8. Using regOperand() here loses
      // the AH/CH/DH/BH versus SPL/BPL/SIL/DIL distinction entirely.
      case 0x84: case 0x85: {
        const byteForm = opcode === 0x84;
        this.readModrm();
        const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
        const r = byteForm ? this.regOperand8() : this.regOperand();
        return this.result(Mnemonic.TEST, [rm, r]);
      }

      case 0x86: case 0x87: {
        const byteForm = opcode === 0x86;
        this.readModrm();
        const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
        const r = byteForm ? this.regOperand8() : this.regOperand();
        return this.result(Mnemonic.XCHG, [rm, r]);
      }

      case 0x88: case 0x89: {
        const byteForm = opcode === 0x88;
        this.readModrm();
        const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
        const r = byteForm ? this.regOperand8() : this.regOperand();
        return this.result(Mnemonic.MOV, [rm, r]);
      }
      case 0x8a: case 0x8b: {
        const byteForm = opcode === 0x8a;
        this.readModrm();
        const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
        const r = byteForm ? this.regOperand8() : this.regOperand();
        return this.result(Mnemonic.MOV, [r, rm]);
      }

      case 0x8d: {
        const m = this.readModrm();
        if (!m.mem) throw new DecodeError('LEA requires a memory operand', this.ctx.origin, opcode);
        return this.result(Mnemonic.LEA, [this.regOperand(), m.mem]);
      }

      case 0x8f:
        this.readModrm();
        return this.result(Mnemonic.POP, [this.rmOperand()]);

      // MOV accumulator <-> moffs
      case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
        const addrSize = this.ctx.addressSize;
        const addr =
          addrSize === 16 ? BigInt(this.u16()) : addrSize === 32 ? BigInt(this.u32()) : this.u64();
        const moffs: Operand = { kind: 'moffs', addr };
        const toAcc = (opcode & 2) === 0;
        return toAcc
          ? this.result(Mnemonic.MOV, [acc(), moffs])
          : this.result(Mnemonic.MOV, [moffs, acc()]);
      }

      // String primitives. 0xA4/0xA5 are MOVS, 0xA6/0xA7 are CMPS - grouping
      // them together would silently mis-execute the compare, so each pair is
      // listed separately. Width follows the operand-size prefix and the
      // direction flag, both of which the executor owns.
      case 0xa4: case 0xa5:
        return this.result(Mnemonic.MOVS, []);
      case 0xa6: case 0xa7:
        return this.result(Mnemonic.CMPS, []);
      case 0xaa: case 0xab:
        return this.result(Mnemonic.STOS, []);
      case 0xac: case 0xad:
        return this.result(Mnemonic.LODS, []);
      case 0xae: case 0xaf:
        return this.result(Mnemonic.SCAS, []);

      case 0xa8: case 0xa9: {
        const width = opcode === 0xa8 ? 8 : os;
        return this.result(Mnemonic.TEST, [acc(), { kind: 'imm', value: this.immUnsigned(width), width }]);
      }

      case 0xb0: case 0xb1: case 0xb2: case 0xb3:
      case 0xb4: case 0xb5: case 0xb6: case 0xb7: {
        const reg = (opcode & 7) | (this.rexB << 3);
        return this.result(Mnemonic.MOV, [{ kind: 'reg', reg }, { kind: 'imm', value: this.immUnsigned(8), width: 8 }]);
      }

      case 0xb8: case 0xb9: case 0xba: case 0xbb:
      case 0xbc: case 0xbd: case 0xbe: case 0xbf: {
        const reg = (opcode & 7) | (this.rexB << 3);
        if (this.ctx.hasRex && (this.ctx.rex & 0x08) !== 0) {
          return this.result(Mnemonic.MOV, [{ kind: 'reg', reg }, { kind: 'imm', value: this.immUnsigned(64), width: 64 }]);
        }
        if (os === 16) {
          return this.result(Mnemonic.MOV, [{ kind: 'reg', reg }, { kind: 'imm', value: this.immUnsigned(16), width: 16 }]);
        }
        return this.result(Mnemonic.MOV, [{ kind: 'reg', reg }, { kind: 'imm', value: this.immUnsigned(32), width: 32 }]);
      }

      case 0xc0: case 0xc1: {
        const m = this.readModrm();
        const shiftOp = m.reg as ShiftOp;
        const width = opcode === 0xc0 ? 8 : os;
        const dest = width === 8 ? this.byteRegisterOperand() : this.rmOperand();
        return this.result(shiftMnemonic(shiftOp), [dest, { kind: 'imm', value: this.immUnsigned(8), width: 8 }], { shiftOp });
      }
      // 0xC6/0xC7: MOV r/m, imm. The immediate width follows the operand size,
      // except that a 64-bit operand still takes a *sign-extended* imm32 - the
      // imm64 encoding of this instruction does not exist.
      case 0xc6: case 0xc7: {
        const byteForm = opcode === 0xc6;
        this.readModrm();
        const dest = byteForm ? this.byteRegisterOperand() : this.rmOperand();
        const immWidth = byteForm ? 8 : os === 64 ? 32 : os;
        const imm = immWidth === 32 ? this.immSigned(32) : this.immUnsigned(immWidth);
        return this.result(Mnemonic.MOV, [dest, { kind: 'imm', value: imm, width: immWidth }]);
      }

      case 0xd0: case 0xd1: {
        const m = this.readModrm();
        const shiftOp = m.reg as ShiftOp;
        const width = opcode === 0xd0 ? 8 : os;
        const dest = width === 8 ? this.byteRegisterOperand() : this.rmOperand();
        return this.result(shiftMnemonic(shiftOp), [dest], { shiftOp });
      }
      case 0xd2: case 0xd3: {
        const m = this.readModrm();
        const shiftOp = m.reg as ShiftOp;
        const width = opcode === 0xd2 ? 8 : os;
        const dest = width === 8 ? this.byteRegisterOperand() : this.rmOperand();
        return this.result(shiftMnemonic(shiftOp), [dest, { kind: 'reg', reg: Reg.CX }], { shiftOp });
      }

      case 0xc2:
        return this.result(Mnemonic.RET, [{ kind: 'imm', value: BigInt(this.u16()), width: 16 }]);
      case 0xc3:
        return this.result(Mnemonic.RET, []);
      case 0xc9:
        return this.result(Mnemonic.LEAVE, []);
      case 0xcc:
        return this.result(Mnemonic.INT3, []);
      case 0xcd:
        return this.result(Mnemonic.INT, [{ kind: 'imm', value: BigInt(this.u8()), width: 8 }]);
      case 0xcf:
        return this.result(Mnemonic.IRET, []);

      case 0xe0: case 0xe1: case 0xe2: {
        this.readModrm();
        const mnemonic =
          opcode === 0xe0 ? Mnemonic.LOOPNE : opcode === 0xe1 ? Mnemonic.LOOPE : Mnemonic.LOOP;
        return this.result(mnemonic, [this.rel()]);
      }

      case 0xe8:
        return this.result(Mnemonic.CALL, [
          { kind: 'rel', target: this.relTarget(os === 16 ? 16 : 32) },
        ]);
      case 0xe9:
        return this.result(Mnemonic.JMP, [
          { kind: 'rel', target: this.relTarget(os === 16 ? 16 : 32) },
        ]);
      case 0xeb:
        return this.result(Mnemonic.JMP, [this.rel()]);

      // in al, imm8 / in ax, imm8 / in al, dx / in ax, dx
      case 0xe4: case 0xe5:
        return this.result(Mnemonic.IN, [{ kind: 'reg', reg: Reg.AX }, { kind: 'imm', value: BigInt(this.u8()), width: 8 }]);
      case 0xec: case 0xed:
        return this.result(Mnemonic.IN, [{ kind: 'reg', reg: Reg.AX }, { kind: 'reg', reg: Reg.DX }]);
      // out imm8, al / out imm8, ax / out dx, al / out dx, ax
      case 0xe6: case 0xe7:
        return this.result(Mnemonic.OUT, [{ kind: 'imm', value: BigInt(this.u8()), width: 8 }, { kind: 'reg', reg: Reg.AX }]);
      case 0xee: case 0xef:
        return this.result(Mnemonic.OUT, [{ kind: 'reg', reg: Reg.DX }, { kind: 'reg', reg: Reg.AX }]);

      case 0xf4:
        return this.result(Mnemonic.HLT, []);
      case 0xf5:
        return this.result(Mnemonic.CMC, []);
      case 0xf8:
        return this.result(Mnemonic.CLC, []);
      case 0xf9:
        return this.result(Mnemonic.STC, []);
      case 0xfa:
        return this.result(Mnemonic.CLI, []);
      case 0xfb:
        return this.result(Mnemonic.STI, []);
      case 0xfc:
        return this.result(Mnemonic.CLD, []);
      case 0xfd:
        return this.result(Mnemonic.STD, []);

      // Group 3: 0xF6 / 0xF7 - TEST/NOT/NEG/MUL/IMUL/DIV/IDIV
      case 0xf6: case 0xf7: {
        const m = this.readModrm();
        const byteForm = opcode === 0xf6;
        const width = byteForm ? 8 : os;
        switch (m.reg) {
          case 0: {
            const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
            // With a 64-bit operand the immediate is always a sign-extended
            // 32-bit value; there is no imm64 encoding of this instruction.
            const immWidth = width === 64 ? 32 : width;
            const imm = immWidth === 32 ? this.immSigned(32) : this.immUnsigned(immWidth);
            return this.result(Mnemonic.TEST, [rm, { kind: 'imm', value: imm, width: immWidth }]);
          }
          case 2:
            return this.result(Mnemonic.NOT, [byteForm ? this.byteRegisterOperand() : this.rmOperand()]);
          case 3:
            return this.result(Mnemonic.NEG, [byteForm ? this.byteRegisterOperand() : this.rmOperand()]);
          case 4:
            return this.result(Mnemonic.MUL, [byteForm ? this.byteRegisterOperand() : this.rmOperand()]);
          case 5:
            return this.result(Mnemonic.IMUL, [byteForm ? this.byteRegisterOperand() : this.rmOperand()]);
          case 6:
            return this.result(Mnemonic.DIV, [byteForm ? this.byteRegisterOperand() : this.rmOperand()]);
          case 7:
            return this.result(Mnemonic.IDIV, [byteForm ? this.byteRegisterOperand() : this.rmOperand()]);
          default:
            return this.result(Mnemonic.UNIMPLEMENTED, []);
        }
      }

      // Group 5: 0xFE / 0xFF - INC/DEC/CALL/JMP/PUSH
      case 0xfe: case 0xff: {
        const m = this.readModrm();
        const byteForm = opcode === 0xfe;
        const rm = byteForm ? this.byteRegisterOperand() : this.rmOperand();
        switch (m.reg) {
          case 0:
            return this.result(Mnemonic.INC, [rm]);
          case 1:
            return this.result(Mnemonic.DEC, [rm]);
          case 2:
            return this.result(Mnemonic.CALL, [rm]);
          case 3:
            return this.result(Mnemonic.JMP, [rm]);
          case 4:
            return this.result(Mnemonic.PUSH, [rm]);
          case 6:
            return this.result(Mnemonic.PUSH, [rm]);
          default:
            return this.result(Mnemonic.UNIMPLEMENTED, [rm]);
        }
      }

      case 0x60:
        return this.result(Mnemonic.PUSHA, []);
      case 0x61:
        return this.result(Mnemonic.POPA, []);
      case 0x9c:
        return this.result(Mnemonic.PUSHF, []);
      case 0x9d:
        return this.result(Mnemonic.POPF, []);
      case 0x9e:
        return this.result(Mnemonic.SAHF, []);
      case 0x9f:
        return this.result(Mnemonic.LAHF, []);
      case 0x98:
        return this.result(Mnemonic.CWDE, []);
      case 0x99:
        return this.result(Mnemonic.CDQ, []);
      case 0x90:
        return this.result(Mnemonic.NOP, []);
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
        return this.result(Mnemonic.XCHG, [
          { kind: 'reg', reg: Reg.AX },
          { kind: 'reg', reg: (opcode & 7) | (this.rexB << 3) },
        ]);

      default:
        throw new DecodeError('unsupported opcode', this.ctx.origin, opcode);
    }
  }

  private decodeTwoByte(opcode: number): ReturnType<InstructionDecoder['result']> {
    // Jcc rel16/rel32
    if (opcode >= 0x80 && opcode <= 0x8f) {
      return this.result(Mnemonic.JCC, [{ kind: 'rel', target: this.relTarget(this.ctx.operandSize === 16 ? 16 : 32) }], {
        condition: opcode & 0x0f,
      });
    }
    // SETcc r/m8
    if (opcode >= 0x90 && opcode <= 0x9f) {
      this.readModrm();
      return this.result(Mnemonic.SETCC, [this.byteRegisterOperand()], { condition: opcode & 0x0f });
    }
    // CMOVcc r, r/m
    if (opcode >= 0x40 && opcode <= 0x4f) {
      this.readModrm();
      return this.result(Mnemonic.UNIMPLEMENTED, [this.regOperand(), this.rmOperand()], {
        condition: opcode & 0x0f,
      });
    }

    switch (opcode) {
      case 0x05:
        return this.result(Mnemonic.SYSCALL, []);
      case 0x07:
        return this.result(Mnemonic.SWAPGS, []);
      case 0x08:
        return this.result(Mnemonic.INVLGDT, []);
      case 0x0b:
        return this.result(Mnemonic.UD2, []);
      case 0x1f: {
        // Multi-byte NOP. The ModRM (and SIB, and displacement) must be
        // consumed so the instruction length is correct.
        this.readModrm();
        return this.result(Mnemonic.NOP, []);
      }
      case 0xa2:
        return this.result(Mnemonic.CPUID, []);
      case 0x31:
        return this.result(Mnemonic.RDTSC, []);
      case 0x01: {
        // Group 6, the descriptor-table instructions. The reg field selects
        // which one; LGDT/LIDT/LTR/LLDT all take a memory operand holding a
        // 10-byte descriptor bound.
        const m = this.readModrm();
        switch (m.reg) {
          case 2:
            return this.result(Mnemonic.LGDT, m.mem ? [m.mem] : []);
          case 3:
            return this.result(Mnemonic.LIDT, m.mem ? [m.mem] : []);
          case 4:
            return this.result(Mnemonic.LTR, m.mem ? [m.mem] : []);
          default:
            return this.result(Mnemonic.UNIMPLEMENTED, []);
        }
      }
      case 0xa0: case 0xa8:
        return this.result(Mnemonic.PUSH_FS, []);
      case 0xa1: case 0xa9:
        return this.result(Mnemonic.POP_FS, []);
      case 0xb6: case 0xb7: {
        // MOVZX r16/32/64, r/m8 (b6) or r/m16 (b7). The source width is fixed
        // by the opcode, not by the operand-size prefix.
        this.readModrm();
        const src = this.rmOperand();
        return this.result(Mnemonic.MOVZX, [this.regOperand(), src], {
          sourceSize: opcode === 0xb6 ? 8 : 16,
        });
      }
      case 0xbe: case 0xbf: {
        // MOVSX r16/32/64, r/m8 (be) or r/m16 (bf)
        this.readModrm();
        const src = this.rmOperand();
        return this.result(Mnemonic.MOVSX, [this.regOperand(), src], {
          sourceSize: opcode === 0xbe ? 8 : 16,
        });
      }
      case 0xaf:
        this.readModrm();
        return this.result(Mnemonic.IMUL, [this.regOperand(), this.rmOperand()]);
      case 0x0d: case 0x18: case 0x1e: case 0x1f: {
        // Prefetch and hint-nop forms; decoded so length is right.
        this.readModrm();
        return this.result(Mnemonic.NOP, []);
      }
      case 0x38:
        // Three-byte opcode map. VerixOS uses none of it; decode the ModRM to
        // keep length accounting honest, then report unimplemented.
        this.readModrm();
        return this.result(Mnemonic.UNIMPLEMENTED, []);
      default:
        throw new DecodeError('unsupported 0x0F opcode', this.ctx.origin, opcode);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Mnemonic mapping helpers                                                    */
/* -------------------------------------------------------------------------- */

function aluMnemonic(op: AluOp): Mnemonic {
  const table: Record<number, Mnemonic> = {
    0: Mnemonic.ADD,
    1: Mnemonic.OR,
    2: Mnemonic.ADC,
    3: Mnemonic.SBB,
    4: Mnemonic.AND,
    5: Mnemonic.SUB,
    6: Mnemonic.XOR,
    7: Mnemonic.CMP,
  };
  return table[op] ?? Mnemonic.UNIMPLEMENTED;
}

function shiftMnemonic(op: ShiftOp): Mnemonic {
  const table: Record<number, Mnemonic> = {
    0: Mnemonic.ROL,
    1: Mnemonic.ROR,
    4: Mnemonic.SHL,
    5: Mnemonic.SHR,
    6: Mnemonic.SAR,
  };
  return table[op] ?? Mnemonic.UNIMPLEMENTED;
}

const REG_NAMES = [
  'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
] as const;

export function regName(index: number): string {
  return REG_NAMES[index] ?? `r${index}`;
}

/**
 * Segment selector indices used by the `seg` operand form.
 *
 * VerixOS runs with a flat memory model, so these are not physical segments; the
 * index exists so `push es` decodes to something an executor and a disassembler
 * can both round-trip.
 */
export const SEG_ES = 0;
export const SEG_CS = 1;
export const SEG_SS = 2;
export const SEG_DS = 3;
export const SEG_FS = 4;
export const SEG_GS = 5;

export const SEG_NAMES = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'] as const;

export function segName(index: number): string {
  return SEG_NAMES[index] ?? `seg${index}`;
}

/**
 * Segment register for the one-byte push/pop opcodes.
 *
 * `0x06 ES`, `0x0E CS`, `0x16 SS`, `0x1E DS`. The instruction encodings sit
 * inside the numeric range that the ALU opcodes also occupy, which is why they
 * must be matched by exact value rather than by range.
 */
export function segmentForPush(opcode: number): number {
  switch (opcode) {
    case 0x06:
      return SEG_ES;
    case 0x0e:
      return SEG_CS;
    case 0x16:
      return SEG_SS;
    case 0x1e:
      return SEG_DS;
    default:
      return SEG_DS;
  }
}

/**
 * Segment register for the one-byte `ES CS SS DS FS GS` opcodes.
 *
 * `0x26 ES`, `0x2E CS`, `0x36 SS`, `0x3E DS`, `0x64 FS`, `0x65 GS`.
 */
export function segmentForPrefix(opcode: number): number {
  switch (opcode) {
    case 0x26:
      return SEG_ES;
    case 0x2e:
      return SEG_CS;
    case 0x36:
      return SEG_SS;
    case 0x3e:
      return SEG_DS;
    case 0x64:
      return SEG_FS;
    case 0x65:
      return SEG_GS;
    default:
      return SEG_DS;
  }
}

export const CONDITION_NAMES = [
  'o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a',
  's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g',
] as const;

/**
 * Human-readable 8-bit register name.
 *
 * With `high` set the index is RAX-RBX and the name is AH/CH/DH/BH; otherwise it
 * is the 16-way low-byte encoding AL/CL/DL/BL, SPL/BPL/SIL/DIL, R8B-R15B.
 */
export function byteRegName(index: number, high: boolean): string {
  if (high) return REG8_NAMES[(index & 0x03) + 4] ?? `b${index}`;
  const names = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'];
  return names[index] ?? `b${index}`;
}

export function formatOperand(op: Operand): string {
  switch (op.kind) {
    case 'reg':
      return op.highByte === true ? byteRegName(op.reg, true) : regName(op.reg);
    case 'seg':
      return segName(op.seg);
    case 'imm':
      return op.value < 0n ? `-0x${(-op.value).toString(16)}` : `0x${op.value.toString(16)}`;
    case 'rel':
      return `0x${op.target.toString(16)}`;
    case 'moffs':
      return `[0x${op.addr.toString(16)}]`;
    case 'mem': {
      if (op.ripRelative) {
        const d = op.disp;
        return `[rip${d < 0n ? `-0x${(-d).toString(16)}` : `+0x${d.toString(16)}`}]`;
      }
      const parts: string[] = [];
      if (op.base >= 0) parts.push(regName(op.base));
      if (op.index >= 0) parts.push(`${regName(op.index)}*${op.scale}`);
      if (parts.length === 0) return `[0x${op.disp.toString(16)}]`;
      const d = op.disp;
      if (d < 0n) parts.push(`-0x${(-d).toString(16)}`);
      else if (d > 0n) parts.push(`0x${d.toString(16)}`);
      return `[${parts.join('+')}]`;
    }
  }
}

export function formatInstruction(
  address: bigint,
  length: number,
  mnemonic: Mnemonic,
  operands: readonly Operand[],
  condition?: number,
): string {
  // `jcc`/`setcc` are the map names, not the assembler spellings. Naively
  // appending the condition suffix yields "jcce" and "sete"; the assembler mnemonics
  // are "je" and "setz", so the prefix has to be replaced rather than extended.
  let name: string = mnemonic;
  if (condition !== undefined) {
    const suffix = CONDITION_NAMES[condition];
    if (mnemonic === Mnemonic.JCC) name = `j${suffix}`;
    else if (mnemonic === Mnemonic.SETCC) name = `set${suffix}`;
  }
  const text = operands.map(formatOperand).join(', ');
  const body = `${name}${text ? ` ${text}` : ''}`;
  return `${body.padEnd(30, ' ')}  ; ${length} bytes @ 0x${address.toString(16)}`;
}