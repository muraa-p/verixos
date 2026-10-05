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
       * Operand width in bits: 8, 16, 32 or 64.
       *
       * Not derivable from `reg` alone, which is the reason this field exists at all.
       * `8B C3` and `48 8B C3` decode to the *same* `reg: Reg.RBX`, and they mean
       * different operations - a 32-bit move that zeroes the top half of the register,
       * and a 64-bit move that preserves it. An executor that reads only `reg` would
       * execute the 64-bit one for the 32-bit instruction, and a disassembler would
       * print `rax` for both. The width comes from the opcode (bytes), the
       * operand-size prefix and the mode (16/32/64), all of which the decoder has
       * already resolved by the time an operand is built.
       *
       * Optional so that `reg` alone stays usable where the width is genuinely
       * irrelevant, but every operand this decoder emits carries it.
       */
      readonly size?: number;
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
      /**
       * Address width: 16, 32 or 64.
       *
       * Independent of the *operand* width, and it is not derivable from the
       * operand-size prefix: 0x67 selects one and 0x66 the other, and real mode
       * defaults to 16 for both. 16-bit addressing is not 32-bit addressing with a
       * shorter displacement - it has four hard-wired register pairs, no scale
       * factor, and a field 6 that is a bare disp16 - so `[bx+si]` and `[rbx+rsi]` are
       * different instructions selected by the same ModRM byte in different modes.
       * Without this field the base and index print as 64-bit names for what is
       * really a 16-bit address, and an executor computes the wrong address.
       */
      readonly addressWidth: 16 | 32 | 64;
      /**
       * Width of the *value* this memory operand refers to, in bits.
       *
       * The address width says how to compute the address; this says how many bytes
       * are read or written there. They are independent, and so is the encoding:
       * `0F B6 03` is `movzx eax, byte [rbx]` and `0F B7 03` is `movzx eax, word
       * [rbx]`, both of which read a 32-bit destination whose source width is fixed
       * by the opcode and has nothing to do with the operand-size prefix. Without
       * this field the decoded form is not re-assemblable - `not [rbx]` does not say
       * whether the instruction touches four bytes or eight, and an assembler asked
       * to reproduce it has to guess.
       */
      readonly operandWidth: number;
    }
  | { readonly kind: 'rel'; readonly target: bigint }
  /**
   * A far pointer: `segment:offset`.
   *
   * Distinct from two separate operands because the pair is architecturally one
   * value - the offset is meaningless without the segment - and a representation
   * that allowed them to be confused with a memory operand would quietly accept
   * `call 0x1234:0x5678` as something it is not.
   */
  | { readonly kind: 'far'; readonly segment: number; readonly offset: bigint }
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
  /**
   * XADD and CMPXCHG, 0F C0/C1 and 0F B0/B1.
   *
   * Both are read-modify-write on a memory destination with an implicit accumulator
   * operand - EAX for XADD, AL/AX/EAX/RAX for CMPXCHG - and both are lockable, so
   * they need the accumulator to be named in the decoded form or an executor cannot
   * tell which register is the implicit one.
   */
  XADD: 'xadd',
  CMPXCHG: 'cmpxchg',

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
  /**
   * CMOVcc, 0F 40-4F.
   *
   * Separate from JCC and SETCC because the *destination* is a register: the
   * conditional move has to name where the value goes, and folding it into JCC would
   * lose the operand that makes it different from a branch.
   */
  CMOVCC: 'cmovcc',
  CALL: 'call',
  /**
   * The far forms, FF /3 and FF /5.
   *
   * Kept separate from CALL and JMP because they load a segment register and
   * flush the instruction and pipeline flushes differently; collapsing the two
   * would make a real-mode boot sector's initial far jump look like an ordinary
   * near jump that does the wrong thing.
   */
  CALLF: 'callf',
  JMPF: 'jmpf',
  /** Far return. In long mode this is the 32-bit form; see `farReturnMnemonic`. */
  RETF: 'retf',
  /** The REX.W form: pops an 8-byte return offset. Long mode only. */
  RETFQ: 'retfq',
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
  /**
   * RCL and RCR rotate through the carry flag rather than closing the loop, so they
   * are the multi-precision shift primitives: rotating a 64-bit value by 8 bits is
   * RCL rax, 1 with the upper half in the carry.
   */
  RCL: 'rcl',
  RCR: 'rcr',

  HLT: 'hlt',
  NOP: 'nop',
  /**
   * `F3 90`. Architecturally identical to `rep nop`, and the SDM gives it a name because
   * every spin-wait loop in a scheduler is built from it.
   */
  PAUSE: 'pause',
  CLI: 'cli',
  STI: 'sti',
  CLD: 'cld',
  STD: 'std',
  CLC: 'clc',
  STC: 'stc',
  CMC: 'cmc',
  LAHF: 'lahf',
  SAHF: 'sahf',
  /**
   * 0x98 in its three widths: CBW, CWDE, CDQE.
   *
   * REX.W is not ignored on this opcode the way it is on Jcc - it selects a different
   * instruction. CWDE sign-extends EAX into the 32-bit destination; CDQE sign-extends
   * EAX to a full 64-bit RAX. Naming both `cwde` makes `48 98` re-assemble to the
   * one-byte `98`, silently changing the width of the result.
   */
  CBW: 'cbw',
  CWDE: 'cwde',
  CDQE: 'cdqe',
  /** 0x99 in its three widths: CWD, CDQ, CQO. */
  CWD: 'cwd',
  CDQ: 'cdq',
  CQO: 'cqo',

  CPUID: 'cpuid',
  RDTSC: 'rdtsc',
  RDTSCP: 'rdtscp',
  /** `0F 32`. Reads a model-specific register, indexed by ECX. */
  RDMSR: 'rdmsr',
  /** `0F 30`. The write direction. */
  WRMSR: 'wrmsr',
  /** `0F 05`. The fast system-call entry, in long mode. */
  SYSCALL: 'syscall',
  /** `0F 07`. Its return. */
  SYSRET: 'sysret',
  /** `0F 09`. Writes back every dirty cache line. */
  WBINVD: 'wbinvd',
  /** `0F 06`. Clears CR0.TS, moving the FPU out of its emulated state. */
  CLTS: 'clts',
  /** `D7`. AL = [RBX + AL]: a 256-entry byte-table lookup. */
  XLATB: 'xlatb',
  UD2: 'ud2',

  IN: 'in',
  OUT: 'out',

  MOV_CR: 'mov_cr',
  LGDT: 'lgdt',
  LIDT: 'lidt',
  LTR: 'ltr',
  LLDT: 'lldt',
  /** `0F 01 /0`. The store direction of the GDTR pair, for UMIP-gated introspection. */
  SGDT: 'sgdt',
  /** `0F 01 /1`. The store direction of the IDTR pair. */
  SIDT: 'sidt',
  /** `0F 00 /0`. Reads the LDTR's selector into r/m16. */
  SLDT: 'sldt',
  /** `0F 00 /1`. Reads the TR's selector into r/m16. */
  STR: 'str',
  /** `0F 01 /4`. Reads CR0's low 16 bits - the 286-era machine status word. */
  SMSW: 'smsw',
  /** `0F 01 /6`. Writes CR0's low 16 bits. Also 286-era. */
  LMSW: 'lmsw',
  /** `0F 00 /4`. Tests a segment selector for readability without loading it. */
  VERR: 'verr',
  /** `0F 00 /5`. The same for writability. */
  VERW: 'verw',
  /** `0F 01 D0`. Reads an extended control register selected by ECX into EDX:EAX. */
  XGETBV: 'xgetbv',
  /** `0F 01 D1`. The write direction. */
  XSETBV: 'xsetbv',

  INT: 'int',
  INT3: 'int3',
  IRET: 'iret',

  MOVS: 'movs',
  STOS: 'stos',
  LODS: 'lods',
  SCAS: 'scas',
  CMPS: 'cmps',

  /**
   * The width-suffixed string primitives, as separate names.
   *
   * Each is a distinct instruction: `movsb` moves one byte and `movsq` moves eight,
   * from the same A4/A5 opcode pair, and a decoded form that reported only `movs`
   * could not say which. Separate names rather than a width field on the shared one,
   * because the whole point is that an executor should not be able to reach the
   * ambiguous case by forgetting to check.
   */
  MOVSB: 'movsb',
  MOVSW: 'movsw',
  MOVSD: 'movsd',
  MOVSQ: 'movsq',
  STOSB: 'stosb',
  STOSW: 'stosw',
  STOSD: 'stosd',
  STOSQ: 'stosq',
  LODSB: 'lodsb',
  LODSW: 'lodsw',
  LODSD: 'lodsd',
  LODSQ: 'lodsq',
  SCASB: 'scasb',
  SCASW: 'scasw',
  SCASD: 'scasd',
  SCASQ: 'scasq',
  CMPSB: 'cmpsb',
  CMPSW: 'cmpsw',
  CMPSD: 'cmpsd',
  CMPSQ: 'cmpsq',

  SWAPGS: 'swapgs',

  /** Segment push/pop, used by the 0x0F A0/A1 and A8/A9 forms. */
  PUSH_FS: 'push_fs',
  POP_FS: 'pop_fs',
  PUSH_GS: 'push_gs',
  POP_GS: 'pop_gs',
  /**
   * `0F 08`. Not to be confused with INVLPG at `0F 01 /7`, which invalidates a
   * single TLB entry and takes a memory operand - a completely different
   * instruction with a similarly shaped name.
   */
  INVD: 'invd',
  /** INVLPG m, `0F 01 /7`. Invalidates one TLB entry. */
  INVLPG: 'invlpg',
  /** String I/O: INS and OUTS, the port-addressed string primitives. */
  INS: 'ins',
  OUTS: 'outs',
  /**
   * The width-suffixed forms. INS and OUTS have one extra axis the other five string
   * primitives do not: their destination or source is a *port*, so only DX names the
   * port and the port number is never an operand at all.
   */
  INSB: 'insb',
  INSW: 'insw',
  INSD: 'insd',
  INSQ: 'insq',
  OUTSB: 'outsb',
  OUTSW: 'outsw',
  OUTSD: 'outsd',
  OUTSQ: 'outsq',
  /** Segment-register push/pop that are separate opcodes rather than ModRM. */
  PUSH_SEG: 'push_seg',
  POP_SEG: 'pop_seg',

  /** Decoded but deliberately not executed; the CPU raises #UD. */
  UNIMPLEMENTED: 'unimplemented',
} as const;

export type Mnemonic = (typeof Mnemonic)[keyof typeof Mnemonic];

/**
 * The twenty width-suffixed string primitives, five bases by four widths.
 *
 * Stated as a table rather than built by concatenating a suffix onto a base name,
 * because `MOVS + 'sq'` and `MOVSB + ...` happen to coincide today - the enum values
 * are the printed names - and that coincidence is what hides the mistake. The day a
 * mnemonic's printed form differs from its table value, concatenation silently yields
 * `movssq` and the disassembly stops being assemblable with no compile error.
 *
 * A base absent here has no width forms, which is a decoder bug rather than a runtime
 * condition, so the fallback returns the base unchanged and the length is still right.
 */
const STRING_WIDTHS: Readonly<
  Partial<Record<Mnemonic, Readonly<Record<'b' | 'sw' | 'sd' | 'sq', Mnemonic>>>>
> = {
  [Mnemonic.MOVS]: { b: Mnemonic.MOVSB, sw: Mnemonic.MOVSW, sd: Mnemonic.MOVSD, sq: Mnemonic.MOVSQ },
  [Mnemonic.CMPS]: { b: Mnemonic.CMPSB, sw: Mnemonic.CMPSW, sd: Mnemonic.CMPSD, sq: Mnemonic.CMPSQ },
  [Mnemonic.STOS]: { b: Mnemonic.STOSB, sw: Mnemonic.STOSW, sd: Mnemonic.STOSD, sq: Mnemonic.STOSQ },
  [Mnemonic.LODS]: { b: Mnemonic.LODSB, sw: Mnemonic.LODSW, sd: Mnemonic.LODSD, sq: Mnemonic.LODSQ },
  [Mnemonic.SCAS]: { b: Mnemonic.SCASB, sw: Mnemonic.SCASW, sd: Mnemonic.SCASD, sq: Mnemonic.SCASQ },
  [Mnemonic.INS]: { b: Mnemonic.INSB, sw: Mnemonic.INSW, sd: Mnemonic.INSD, sq: Mnemonic.INSQ },
  [Mnemonic.OUTS]: { b: Mnemonic.OUTSB, sw: Mnemonic.OUTSW, sd: Mnemonic.OUTSD, sq: Mnemonic.OUTSQ },
};

/**
 * `0F 00 /r`, the segment-descriptor group.
 *
 * The six selectors are not interchangeable and not contiguous in purpose: two *read*
 * the descriptor-table registers out (SLDT, STR), two *load* a selector (LLDT, LTR), and
 * two test a selector against the descriptor it names without loading anything at all
 * (VERR, VERW). All six take a register or a memory destination.
 *
 * A key is absent where the SDM says the selector is undefined, which is what leaves
 * `unimplemented` for /6 and /7 rather than a guess.
 */
const SEGMENT_TABLE_0F00: Readonly<Record<number, Mnemonic>> = {
  0: Mnemonic.SLDT,
  1: Mnemonic.STR,
  2: Mnemonic.LLDT,
  3: Mnemonic.LTR,
  4: Mnemonic.VERR,
  5: Mnemonic.VERW,
};

/**
 * `0F 01 /r`, the descriptor-table-base group.
 *
 * All five named members take a *memory* destination: the two stores (SGDT, SIDT) write
 * a limit-and-base pair out, the two loads (LGDT, LIDT) read one in, and INVLPG names a
 * single page. SMSW and LMSW are absent because their destination may also be a
 * register, which the decoder handles separately rather than forcing them through a
 * memory-only path - putting them here would mean dropping the register form, which is
 * the spelling `smsw eax` uses.
 *
 * /5 is undefined and /7's register form belongs to SWAPGS and RDTSCP, so neither
 * appears.
 */
const DESCRIPTOR_TABLE_0F01: Readonly<Record<number, Mnemonic>> = {
  0: Mnemonic.SGDT,
  1: Mnemonic.SIDT,
  2: Mnemonic.LGDT,
  3: Mnemonic.LIDT,
  4: Mnemonic.SMSW,
  6: Mnemonic.LMSW,
  7: Mnemonic.INVLPG,
};

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
  /**
   * Width in bits moved by a string primitive: 8, 16, 32 or 64.
   *
   * The operand size alone does not determine this. `A4` is always MOVSB whatever the
   * prefixes say, and `A5` is MOVSW, MOVSD or MOVSQ depending on them, so a decoded
   * string instruction carries its width separately from the operand size it was
   * decoded under. An executor that used `operandSize` would move eight bytes for an
   * `A4` in long mode, where the mode's default is 32.
   */
  readonly stringWidth: number | undefined;
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
    const { mnemonic, operands, aluOp, shiftOp, condition, sourceSize, stringWidth } = decoded;

    // `F3 90` is PAUSE, and the F3 in it is part of the instruction's *encoding*, not a
    // prefix hanging in front of a NOP. Reporting it as `rep` would print `rep pause`,
    // which re-assembles to `F3 F3 90` - two REP prefixes where the architecture has one,
    // and a decoder error on the machine the output is fed back to. So the mnemonic's
    // identity withdraws the prefix: PAUSE is spelled with the byte that PAUSE is.
    //
    // This is the same reason `int 3` is not reported as `cc`, and it is decided here
    // rather than in the printer so that `Instruction.rep` and the text agree - a
    // consumer reading the structured field would otherwise see a repeat on an
    // instruction that has no use for one.
    const rep = mnemonic === Mnemonic.PAUSE ? 'none' : this.ctx.rep;

    return {
      length,
      mnemonic,
      operands,
      operandSize: this.ctx.operandSize,
      addressSize: this.ctx.addressSize,
      rex: this.ctx.rex,
      lock: this.ctx.lock,
      rep,
      aluOp,
      shiftOp,
      condition,
      sourceSize,
      stringWidth,
      twoByte,
      hasRex: this.ctx.hasRex,
      origin: address,
      toString: () => formatInstruction(address, length, mnemonic, operands, condition, rep, this.ctx.lock),
    };
  }

  /**
   * A string primitive, named for the width it actually moves.
   *
   * The odd opcode of each pair is the byte form and the even one the wide form, so
   * the suffix comes from the opcode's low bit combined with the prefixes rather than
   * from the operand size alone: `A4` is always MOVSB, while `A5` is MOVSW by default,
   * MOVSD with 0x66, and MOVSQ with REX.W. Those last two are different instructions -
   * MOVSD moves four bytes and MOVSQ eight - and naming both `movs` hides it.
   */
  private stringOp(base: Mnemonic, opcode: number): ReturnType<InstructionDecoder['result']> {
    const os = this.ctx.operandSize;
    const byteForm = (opcode & 1) === 0;
    const key = byteForm ? 'b' : os === 16 ? 'sw' : os === 64 ? 'sq' : 'sd';
    return this.result(STRING_WIDTHS[base]?.[key] ?? base, [], { stringWidth: byteForm ? 8 : os });
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
    // The default operand size is a property of the *mode*, and only real mode is 16.
    // Protected 32-bit mode defaults to 32 just as long mode does - 64 bits there
    // needs REX.W - so grouping "not long" together as 16 makes every 32-bit
    // instruction decode as a 16-bit one. That is not a cosmetic error: it changes
    // the instruction's length whenever the operand is an immediate, and it makes
    // the disassembly of 32-bit code re-assemble with a 0x66 prefix.
    let operandSize: 8 | 16 | 32 | 64 = mode === CpuMode.REAL16 ? 16 : 32;
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
        addressWidth: 16,
        operandWidth: this.ctx.operandSize,
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
          addressWidth: size,
          operandWidth: this.ctx.operandSize,
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
          addressWidth: 64,
          operandWidth: this.ctx.operandSize,
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
        addressWidth: 32,
        operandWidth: this.ctx.operandSize,
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
      addressWidth: size,
      operandWidth: this.ctx.operandSize,
        };
  }

  /* ------------------------------------------------------------------ */
  /* Operand helpers                                                     */
  /* ------------------------------------------------------------------ */

  /** r/m operand: the memory operand if present, otherwise the rm register. */
  private rmOperand(size = this.ctx.operandSize): Operand {
    return this.rmFrom(this.readModrm(), size);
  }

  /**
   * The immediate of an arithmetic, test or multiply instruction.
   *
   * **No immediate in this group is ever 64 bits wide.** The SDM defines
   * `add rax, imm` as taking a sign-extended *imm32*, and the same holds for the
   * 80/81/83 group-1 forms, for `test`, for `imul r,r,imm` and for the F7 /0 form of
   * `test`. There is no imm64 anywhere in the group. Reusing the operand size as the
   * immediate width therefore reads eight bytes, swallows the first four bytes of the
   * following instruction, and reports a length four too long - after which every
   * subsequent instruction is decoded from the wrong address, with no error to say so.
   *
   * Signedness follows from the same rule: the 64-bit forms sign-extend, so their
   * immediate is signed, while the 8-, 16- and 32-bit forms are plain bit patterns with
   * nothing to sign-extend.
   */
  private aluImmediate(operandSize: number): { value: bigint; width: number } {
    if (operandSize === 64) return { value: this.immSigned(32), width: 32 };
    return { value: this.immUnsigned(operandSize), width: operandSize };
  }

  /**
   * A general-purpose register operand of an explicit width.
   *
   * Every register operand this decoder emits goes through here or through
   * `byteOperand`, so the width is recorded in exactly two places rather than being
   * restated - and forgotten - at each call site. A register operand without a width
   * is ambiguous between `mov eax, ebx` and `mov rax, rbx`, which are different
   * instructions with the same register indices.
   */
  private gpr(index: number, size: number): Operand {
    return { kind: 'reg', reg: index, size };
  }

  /**
   * The r/m operand for a ModRM byte that has already been read.
   *
   * Separate from `rmOperand` because a group opcode needs the `reg` field to pick
   * what the instruction *is* before it can build the operand, and reading the byte
   * a second time to get it would consume the following displacement.
   *
   * `size` overrides the operand size in effect, which two cases need and the default
   * gets wrong: the byte forms, whose r/m operand is eight bits whatever the prefix
   * says, and the MOVZX/MOVSX sources, whose width comes from the opcode. Left to the
   * default those produce a 32-bit-looking operand for a byte access - and for
   * `movzx` that spells an instruction that does not exist, since the SDM defines
   * MOVZX only from an 8- or 16-bit source.
   */
  private rmFrom(m: ModRm, size = this.ctx.operandSize): Operand {
    if (m.mem) return size === m.mem.operandWidth ? m.mem : { ...m.mem, operandWidth: size };
    return this.gpr(m.rm, size);
  }

  /** reg operand: the ModRM `reg` field. */
  private regOperand(): Operand {
    return this.gpr(this.readModrm().reg, this.ctx.operandSize);
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
      return { kind: 'reg', reg: field - 4, size: 8, highByte: true };
    }
    return { kind: 'reg', reg: field & 0x0f, size: 8, highByte: false };
  }

  /**
   * r/m8: an 8-bit register operand, or a memory operand.
   *
   * The `mod` check is not optional. Fields 4-7 mean AH/CH/DH/BH rather than
   * SPL/BPL/SIL/DIL, so resolving the field without consulting `mod` turns a
   * RIP-relative byte operand - ModRM 00 xxx 101, where 101 is the escape, not a
   * register - into BH, and then reads the displacement as the next instruction.
   */
  private byteRegisterOperand(): Operand {
    const m = this.readModrm();
    // Two separate reasons this cannot go through `rmFrom`, which handles the
    // register form as an ordinary 8-bit general-purpose register:
    //
    //  - The `mod` check is not optional. Fields 4-7 mean AH/CH/DH/BH rather than
    //    SPL/BPL/SIL/DIL, so resolving the field without consulting `mod` turns a
    //    RIP-relative byte operand - ModRM 00 xxx 101, where 101 is the escape, not a
    //    register - into BH, and then reads the displacement as the next instruction.
    //  - The register form must go through `byteOperand`, not `gpr`. `88 FC` is
    //    `mov ah, bh`, and only `byteOperand` knows that field 4 means AH without a
    //    REX prefix; routing it through `gpr` prints `mov spl, bh`, which is a
    //    different instruction requiring a prefix this one does not have.
    if (m.mem) return m.mem.operandWidth === 8 ? m.mem : { ...m.mem, operandWidth: 8 };
    return this.byteOperand(m.rm);
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

  /**
   * The `offset:segment` pair of a far control transfer.
   *
   * The offset comes first in the instruction stream and is the wider of the two:
   * 16 bits in 16-bit mode, 32 in 32-bit mode, and 32 in 64-bit mode even though
   * the default operand size there is 64 - the SDM is explicit that FF /3 and
   * FF /5 read a 16:32 or 16:64 pair and that the offset is *not* affected by
   * REX.W, because a far pointer with a 64-bit offset has no encoding.
   */
  private farPointer(): Operand {
    const width = this.ctx.mode === CpuMode.LONG64 ? 32 : this.ctx.operandSize;
    const offset = BigInt(width === 16 ? this.u16() : this.u32());
    return { kind: 'far', segment: this.u16(), offset };
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
    extra: {
      aluOp?: AluOp;
      shiftOp?: ShiftOp;
      condition?: number;
      sourceSize?: number;
      stringWidth?: number;
    } = {},
  ): {
    mnemonic: Mnemonic;
    operands: Operand[];
    aluOp: AluOp | undefined;
    shiftOp: ShiftOp | undefined;
    condition: number | undefined;
    sourceSize: number | undefined;
    stringWidth: number | undefined;
  } {
    return {
      mnemonic,
      operands,
      aluOp: extra.aluOp,
      shiftOp: extra.shiftOp,
      condition: extra.condition,
      sourceSize: extra.sourceSize,
      stringWidth: extra.stringWidth,
    };
  }

  /** ALU accumulator-immediate and accumulator-register forms, 0x00-0x3D. */
  private decodeOneByte(opcode: number): ReturnType<InstructionDecoder['result']> {
    const os = this.ctx.operandSize;
    const acc = (): Operand => this.gpr(Reg.AX, os);

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
            this.gpr(Reg.AX, 8),
            { kind: 'imm', value: this.immUnsigned(8), width: 8 },
          ], { aluOp });
        // op eAX, imm  (0x05 id) - no ModRM. The immediate is not the
        // operand width: see `aluImmediate`.
        case 5: {
          const immediate = this.aluImmediate(width);
          return this.result(mnemonic, [this.gpr(Reg.AX, width), { kind: 'imm', ...immediate }], { aluOp });
        }
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
          this.gpr((opcode & 7) | (this.rexB << 3), os),
        ]);
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        return this.result(Mnemonic.POP, [
          this.gpr((opcode & 7) | (this.rexB << 3), os),
        ]);

      case 0x68:
        return this.result(Mnemonic.PUSH, [{ kind: 'imm', value: this.immUnsigned(os), width: os }]);
      case 0x6a:
        return this.result(Mnemonic.PUSH, [{ kind: 'imm', value: this.immSigned(8), width: 8 }]);

      case 0x69: {
        this.readModrm();
        const dest = this.regOperand();
        const src = this.rmOperand();
        // 69 /r id is `imul r, r/m, imm32` even at a 64-bit operand size - the
        // immediate is sign-extended, never eight bytes wide.
        return this.result(Mnemonic.IMUL, [dest, src, { kind: 'imm', ...this.aluImmediate(os) }]);
      }
      case 0x6b: {
        this.readModrm();
        const dest = this.regOperand();
        const src = this.rmOperand();
        return this.result(Mnemonic.IMUL, [dest, src, { kind: 'imm', value: this.immSigned(8), width: 8 }]);
      }
      // 6C/6D are the INS pair and 6E/6F the OUTS pair, and each splits on 8 against
      // wide by the opcode's own low bit, exactly as A4/A5 does. The wide half's width
      // then comes from the operand size: `66 6D` is INSW, a bare 6D is INSD at the
      // default 32, and `48 6D` is INSQ. Hard-coding the wide half as INSW - on the
      // argument that only four string-port forms are "defined" - would name a 32-bit
      // port read `insw` and re-assemble it to a 16-bit one, trading a byte for a
      // wrong width.
      case 0x6c: case 0x6d:
        return this.stringOp(Mnemonic.INS, opcode);
      case 0x6e: case 0x6f:
        return this.stringOp(Mnemonic.OUTS, opcode);

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
        // 0x80/0x82 carry an unsigned byte immediate. 0x81 takes a
        // full-width immediate, but 0x83 always takes a sign-extended imm8 regardless
        // of the operand size - there is no imm32 encoding of the 0x83 form. And
        // "full-width" stops at 32: with REX.W the 0x81 form still takes an imm32, so
        // the immediate width and the destination width differ.
        const imm =
          opcode === 0x80 || opcode === 0x82
            ? { value: this.immUnsigned(8), width: 8 }
            : opcode === 0x83
              ? { value: this.immSigned(8), width: 8 }
              : this.aluImmediate(width);
        return this.result(mnemonic, [dest, { kind: 'imm', ...imm }], { aluOp });
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

      // 87 /r. Both operands are named even where the one-byte `90` form encodes the
      // accumulator implicitly - the decoded form has to say what the instruction
      // exchanges, not how briefly it says it. The encoder picks the short form when
      // it can, which is a length decision rather than a change of meaning.
      case 0x86: case 0x87: {
        const byteForm = opcode === 0x86;
        const m = this.readModrm();
        const rm = byteForm ? this.byteRegisterOperand() : this.rmFrom(m);
        const r = byteForm ? this.regOperand8() : this.gpr(m.reg, os);
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

      // MOV to and from a segment register. 0x8E loads (r/m16 -> Sreg) and 0x8C
      // stores (Sreg -> r/m16), with the segment number in the ModRM reg field -
      // the same slot a control register uses. `mov ds, ax` is the second
      // instruction of every boot sector, so this cannot be left out of a decoder
      // that claims to execute one.
      case 0x8c:
      case 0x8e: {
        const m = this.readModrm();
        // The segment number is only three bits wide, so reg 6 and 7 name nothing.
        // Reporting them as a segment would invent a register that does not exist.
        if (m.reg > 5) throw new DecodeError('no segment register for this ModRM reg field', this.ctx.origin, opcode);
        if (opcode === 0x8e) return this.result(Mnemonic.MOV, [{ kind: 'seg', seg: m.reg }, this.rmOperand()]);
        return this.result(Mnemonic.MOV, [this.rmOperand(), { kind: 'seg', seg: m.reg }]);
      }

      // Far jump and call: a literal `offset:segment` pair, not a relative branch
      // and not a memory operand. EA and 9A take the wider offset first.
      case 0xea:
        return this.result(Mnemonic.JMPF, [this.farPointer()]);
      case 0x9a:
        return this.result(Mnemonic.CALLF, [this.farPointer()]);

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
      // listed separately.
      //
      // Each is reported with its *width-suffixed* name, MOVSB/MOVSW/MOVSD/MOVSQ and
      // so on, and the width is taken from the opcode's own low bit rather than from
      // `os`. `A4` is `movsb` and `A5` is `movsw` by default; 0x66 turns `A5` into
      // `movsw` and REX.W turns `A5` into `movsq`. Reporting a bare `movs` records
      // none of that, and `movs` is not a mnemonic the assembler accepts - so the
      // disassembly cannot be re-assembled, and an executor cannot tell a byte move
      // from a quadword one.
      //
      // The REP/REPNE prefix is part of the instruction's behaviour rather than a
      // decoration on it, so it is reported on the decoded form. Dropping it turns
      // `rep stosq` into `stosq`: one iteration instead of a counted run.
      case 0xa4: case 0xa5:
        return this.stringOp(Mnemonic.MOVS, opcode);
      case 0xa6: case 0xa7:
        return this.stringOp(Mnemonic.CMPS, opcode);
      case 0xaa: case 0xab:
        return this.stringOp(Mnemonic.STOS, opcode);
      case 0xac: case 0xad:
        return this.stringOp(Mnemonic.LODS, opcode);
      case 0xae: case 0xaf:
        return this.stringOp(Mnemonic.SCAS, opcode);

      case 0xa8: case 0xa9: {
        const width = opcode === 0xa8 ? 8 : os;
        // A8/A9: `test al, imm8` and `test eAX, imm`. The wide form is imm32 with
        // REX.W, not imm64.
        const immediate = opcode === 0xa8 ? { value: this.immUnsigned(8), width: 8 } : this.aluImmediate(width);
        return this.result(Mnemonic.TEST, [acc(), { kind: 'imm', ...immediate }]);
      }

      case 0xb0: case 0xb1: case 0xb2: case 0xb3:
      case 0xb4: case 0xb5: case 0xb6: case 0xb7: {
        const reg = (opcode & 7) | (this.rexB << 3);
        return this.result(Mnemonic.MOV, [this.gpr(reg, 8), { kind: 'imm', value: this.immUnsigned(8), width: 8 }]);
      }

      case 0xb8: case 0xb9: case 0xba: case 0xbb:
      case 0xbc: case 0xbd: case 0xbe: case 0xbf: {
        const reg = (opcode & 7) | (this.rexB << 3);
        // B8+r has no 64-bit immediate form in the SDM, so REX.W here selects
        // `mov r/m64, imm32`, which is *sign-extended* - not a 64-bit move. Three
        // consequences, each of which has been a real bug:
        //   - the immediate is four bytes, so reading eight swallows the next
        //     instruction and reports a length four too long;
        //   - the immediate is signed here and unsigned below, because W is the whole
        //     difference between filling the upper 32 bits with the sign and not;
        //   - the register is 64 bits wide while the immediate is 32, so recording
        //     either number as both is what makes `mov rax, 1` decode as four bytes.
        if (this.ctx.hasRex && (this.ctx.rex & 0x08) !== 0) {
          return this.result(Mnemonic.MOV, [this.gpr(reg, 64), { kind: 'imm', value: this.immSigned(32), width: 32 }]);
        }
        if (os === 16) {
          return this.result(Mnemonic.MOV, [this.gpr(reg, 16), { kind: 'imm', value: this.immUnsigned(16), width: 16 }]);
        }
        // Without W this writes 32 bits and zeroes the top of the destination, so the
        // immediate is a plain bit pattern with nothing to sign-extend.
        return this.result(Mnemonic.MOV, [this.gpr(reg, 32), { kind: 'imm', value: this.immUnsigned(32), width: 32 }]);
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
        return this.result(shiftMnemonic(shiftOp), [dest, this.gpr(Reg.CX, 8)], { shiftOp });
      }

      case 0xc2:
        return this.result(Mnemonic.RET, [{ kind: 'imm', value: BigInt(this.u16()), width: 16 }]);
      case 0xc3:
        return this.result(Mnemonic.RET, []);
      // CA/CB are RETF: the near RET's own opcodes with CS and the stack frame pushed
      // by a far CALL. The immediate is the same unsigned 16-bit count C2 takes, added
      // to RSP after the far pop - which is why the count is unsigned here too even
      // though a far caller's frame is larger, since the count is added and never
      // sign-tested.
      case 0xca:
        return this.result(this.farReturnMnemonic(), [
          { kind: 'imm', value: BigInt(this.u16()), width: 16 },
        ]);
      case 0xcb:
        return this.result(this.farReturnMnemonic(), []);
      case 0xc9:
        return this.result(Mnemonic.LEAVE, []);
      case 0xd7:
        // XLATB: AL = [RBX + AL]. Both the table's base and the index are architectural
        // state rather than operands, so the instruction takes none and needs no ModRM
        // byte - which is the whole reason it exists as a one-byte opcode: a 256-entry
        // character-class table is indexed with one instruction instead of a load, an
        // add, and a store.
        return this.result(Mnemonic.XLATB, []);
      case 0xcc:
        return this.result(Mnemonic.INT3, []);
      case 0xcd:
        return this.result(Mnemonic.INT, [{ kind: 'imm', value: BigInt(this.u8()), width: 8 }]);
      case 0xcf:
        return this.result(Mnemonic.IRET, []);

      case 0xe0: case 0xe1: case 0xe2: {
        // No ModRM byte. LOOPNE/LOOPE/LOOP are a bare opcode followed by a signed
        // byte, and reading a ModRM here would swallow the displacement as if it were
        // an addressing mode - making every one of them three bytes long and leaving
        // the following instruction shifted by one. It also runs off the end of a
        // buffer whose last instruction is one of these, which is exactly what a boot
        // sector at the end of memory looks like.
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

      // IN and OUT split on *8 bits against everything else*, not on 16 against 32. The
      // map is E4/E5 for the immediate port, EC/ED for DX, and the low bit of each
      // pair selects the width; the 16-bit case comes from the 0x66 prefix. So EC is
      // `in al, dx` at any operand size, and ED is `in eax/ax/rax, dx`. Deciding from
      // `os` instead - as reading these two cases as a block invites - makes `EC`
      // decode as `in eax, dx`, which reads four bytes from the port and discards
      // three: the one I/O read a keyboard driver depends on.
      case 0xe4: case 0xe5: {
        const width = opcode === 0xe4 ? 8 : os;
        return this.result(Mnemonic.IN, [this.gpr(Reg.AX, width), { kind: 'imm', value: BigInt(this.u8()), width: 8 }]);
      }
      case 0xec: case 0xed: {
        const width = opcode === 0xec ? 8 : os;
        // The port operand is named DX at every data width - see the note on the OUT side.
        return this.result(Mnemonic.IN, [this.gpr(Reg.AX, width), this.gpr(Reg.DX, width)]);
      }
      case 0xe6: case 0xe7: {
        const width = opcode === 0xe6 ? 8 : os;
        return this.result(Mnemonic.OUT, [{ kind: 'imm', value: BigInt(this.u8()), width: 8 }, this.gpr(Reg.AX, width)]);
      }
      case 0xee: case 0xef: {
        const width = opcode === 0xee ? 8 : os;
        // The port operand is named DX whatever the data width, since the port number is in
        // the low half of DX and the high half is not part of it. Printing DL here
        // would be self-consistent nonsense and would not re-assemble, because the
        // assembler accepts only DX or an immediate as a port.
        return this.result(Mnemonic.OUT, [this.gpr(Reg.DX, width), this.gpr(Reg.AX, width)]);
      }

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
      //
      // The two opcodes share a ModRM layout but not a table. 0xFE is INC/DEC on
      // r/m8 and has no forms above reg 1; 0xFF is the near/far call, jump and push
      // set. The reg field is the whole distinction, so the two tables are written
      // out separately rather than shared - folding them together is how `ff e0`
      // (JMP rax) ends up decoded as PUSH rax, which differs in the one bit that
      // decides where control goes next.
      case 0xfe: {
        const m = this.readModrm();
        // `rmFrom`, not `byteOperand`: 0xFE is also the byte INC/DEC on *memory*, and
        // the r/m field 5 with mod 0 is the RIP-relative escape rather than BH.
        const rm = this.rmFrom(m);
        if (m.mem) {
          if (m.reg === 0) return this.result(Mnemonic.INC, [rm]);
          if (m.reg === 1) return this.result(Mnemonic.DEC, [rm]);
          return this.result(Mnemonic.UNIMPLEMENTED, [rm]);
        }
        const reg = this.byteOperand(m.rm);
        if (m.reg === 0) return this.result(Mnemonic.INC, [reg]);
        if (m.reg === 1) return this.result(Mnemonic.DEC, [reg]);
        return this.result(Mnemonic.UNIMPLEMENTED, [reg]);
      }
      case 0xff: {
        const m = this.readModrm();
        // The far forms take a pointer operand rather than an r/m operand, but the
        // ModRM byte is still present for them - it is how the instruction says
        // which of the six forms it is. So it is read first and only then decided.
        if (m.reg === 3) return this.result(Mnemonic.CALLF, [this.farPointer()]);
        if (m.reg === 5) return this.result(Mnemonic.JMPF, [this.farPointer()]);
        const rm = this.rmFrom(m);
        switch (m.reg) {
          case 0:
            return this.result(Mnemonic.INC, [rm]);
          case 1:
            return this.result(Mnemonic.DEC, [rm]);
          case 2:
            return this.result(Mnemonic.CALL, [rm]);
          case 4:
            return this.result(Mnemonic.JMP, [rm]);
          case 6:
            return this.result(Mnemonic.PUSH, [rm]);
          default:
            // reg 111 is not assigned.
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
      // 0x98 and 0x99 are one opcode with three instructions apiece, selected by the
      // operand width rather than by the opcode itself: 0x66 gives CBW/CWD, no prefix
      // gives CWDE/CDQ, and REX.W gives CDQE/CQE. The difference is not cosmetic -
      // CDQE sign-extends EAX into all 64 bits of RAX where CWDE leaves the top half
      // zero, and CQO writes RDX where CDQ writes the zeroed EDX.
      case 0x98:
        return this.result(os === 16 ? Mnemonic.CBW : os === 64 ? Mnemonic.CDQE : Mnemonic.CWDE, []);
      case 0x99:
        return this.result(os === 16 ? Mnemonic.CWD : os === 64 ? Mnemonic.CQO : Mnemonic.CDQ, []);
      // 90 is NOP when no REX.B is present and XCHG rAX, r8 when it is: REX.B turns the
      // opcode's low three bits into a register index, so `41 90` is `xchg rax, r8`.
      // Reading the byte alone as NOP leaves an exchange invisible in the disassembly.
      case 0x90:
        if (this.ctx.hasRex && (this.ctx.rex & 0x01) !== 0) {
          return this.result(Mnemonic.XCHG, [this.gpr(Reg.AX, os), this.gpr(Reg.R8, os)]);
        }
        // F3 90 is PAUSE, not `rep nop`. The two are architecturally the same instruction -
        // a hint to the CPU that it is in a spin-wait loop - and the SDM documents F3 90 as
        // PAUSE, so that is the spelling. The REP prefix cannot reach any other opcode
        // meaningfully, so the case is unambiguous rather than a preference: without it a
        // spin-wait loop full of `pause` disassembles to `rep nop` and re-assembles two
        // bytes shorter with no prefix, which is a different text for the same bytes and
        // hides which instruction the author wrote.
        if (this.ctx.rep === 'rep') return this.result(Mnemonic.PAUSE, []);
        return this.result(Mnemonic.NOP, []);
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
        return this.result(Mnemonic.XCHG, [
          this.gpr(Reg.AX, os),
          this.gpr((opcode & 7) | (this.rexB << 3), os),
        ]);

      default:
        throw new DecodeError('unsupported opcode', this.ctx.origin, opcode);
    }
  }

  /**
   * RETF or RETFQ, whichever the encoding means.
   *
   * A near return in long mode defaults to the stack-address size, 64 bits - but the SDM
   * draws that line explicitly and stops short of it for far returns: "This applies to
   * near returns, not far returns; the default operation size of far returns is 32
   * bits." So `CB` in long mode pops a 4-byte offset and `48 CB` pops 8. They are the
   * same opcode with a different amount of stack consumed, and reporting both as `retf`
   * would make the disassembly of one of them re-assemble to the other.
   *
   * The 0x66 prefix is *not* consulted here. In legacy modes it is what selects the
   * 16-bit far return, but long mode has no 16-bit far return to select - REX.W is the
   * only width control - so asking about it would report a width the mode cannot
   * execute.
   */
  private farReturnMnemonic(): Mnemonic {
    if (this.ctx.mode === CpuMode.LONG64 && (this.ctx.rex & 0x08) !== 0) return Mnemonic.RETFQ;
    return Mnemonic.RETF;
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
      return this.result(Mnemonic.CMOVCC, [this.regOperand(), this.rmOperand()], {
        condition: opcode & 0x0f,
      });
    }

    switch (opcode) {
      case 0x05:
        return this.result(Mnemonic.SYSCALL, []);
      case 0x07:
        return this.result(Mnemonic.SYSRET, []);
      case 0x08:
        // 0F 08 is INVD, the whole-cache invalidation. INVLPG is 0F 01 /7, and the two
        // names are similar enough that conflating them would hide a TLB bug behind a
        // cache-flush one.
        return this.result(Mnemonic.INVD, []);
      case 0x06:
        return this.result(Mnemonic.CLTS, []);
      case 0x09:
        return this.result(Mnemonic.WBINVD, []);
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
      case 0x30:
        return this.result(Mnemonic.WRMSR, []);
      case 0x31:
        return this.result(Mnemonic.RDTSC, []);
      case 0x32:
        return this.result(Mnemonic.RDMSR, []);

      case 0x00: {
        // Group 6 of `0F 00`: the segment-descriptor readers, writers and verifiers. All six
        // take a register *or* a memory destination - LLDT and LTR take a selector,
        // VERR and VERW take a selector to test without loading, and SLDT and STR read
        // the descriptor-table registers out. The operand is 16 bits regardless of the
        // operand-size prefix, which is why `rmFrom(m, 16)` and not the default width.
        const m = this.readModrm();
        const mnemonic = SEGMENT_TABLE_0F00[m.reg & 7];
        if (mnemonic === undefined) return this.result(Mnemonic.UNIMPLEMENTED, []);
        return this.result(mnemonic, [this.rmFrom(m, 16)]);
      }

      // Group 6 of `0F 01`: the descriptor-table base registers, plus four standalone
      // opcodes that share the ModRM byte without being part of the group.
        //
        // The four that hide here are why this group cannot be read as a table before
        // the mod=3 case is handled. With mod=3 the reg field stops selecting an
        // instruction and the whole byte *is* the opcode: D0 and D1 are XGETBV and
        // XSETBV, F8 is SWAPGS and F9 is RDTSCP. Read as the group they become LGDT and
        // SWAPGS instead - and an LGDT in a kernel's disassembly is a far more
        // plausible-looking mistake than a missing XGETBV, because the register being
        // moved by XGETBV and the operand LGDT needs both plausibly appear there.
        case 0x01: {
          const m = this.readModrm();
          if (m.isRegister) {
            // The comparison is against the byte with the mod bits already known to be
            // 11, so `F8` reads as the opcode it is rather than as the pair 38.
            switch (((m.mod & 3) << 6) | ((m.reg & 7) << 3) | (m.rm & 7)) {
              case 0xd0:
                return this.result(Mnemonic.XGETBV, []);
              case 0xd1:
                return this.result(Mnemonic.XSETBV, []);
              case 0xf8:
                return this.result(Mnemonic.SWAPGS, []);
              case 0xf9:
                return this.result(Mnemonic.RDTSCP, []);
              default:
                break;
            }
            // SMSW and LMSW are the group's r/m forms, so with mod=3 they name a register
            // - `smsw eax` is the common spelling and is a real instruction. The
            // destination takes the operand size, which is why this is the mode's
            // current size rather than a fixed 16: only the *memory* store is fixed at
            // 16 bits, and reporting a register destination as 16 would make
            // `smsw eax` print as `smsw ax`.
            if (m.reg === 4) return this.result(Mnemonic.SMSW, [this.gpr(m.rm & 7, this.ctx.operandSize)]);
            if (m.reg === 6) return this.result(Mnemonic.LMSW, [this.gpr(m.rm & 7, this.ctx.operandSize)]);
          }
          const mnemonic = DESCRIPTOR_TABLE_0F01[m.reg & 7];
          if (mnemonic === undefined || !m.mem) return this.result(Mnemonic.UNIMPLEMENTED, []);
          // The operand of a descriptor-table store holds a *limit and base*, not a
          // value of the operand size: 6 bytes in legacy modes and 10 in 64-bit mode.
          // So its width is not read off the prefixes, and it is reported at 16 bits
          // rather than invented.
          return this.result(mnemonic, [this.rmFrom(m, 16)]);
        }
      case 0xa0: case 0xa8:
        return this.result(Mnemonic.PUSH_FS, []);
      case 0xa1: case 0xa9:
        return this.result(Mnemonic.POP_FS, []);
      case 0xb6: case 0xb7: {
        // MOVZX r16/32/64, r/m8 (b6) or r/m16 (b7). The source width is fixed
        // by the opcode, not by the operand-size prefix - so `0F B6 C3` is a byte
        // source no matter what REX.W says, and reading it as a dword source produces
        // `movzx eax, ebx`, which the SDM does not define.
        const sourceSize = opcode === 0xb6 ? 8 : 16;
        this.readModrm();
        return this.result(Mnemonic.MOVZX, [this.regOperand(), this.rmOperand(sourceSize)], { sourceSize });
      }
      case 0xbe: case 0xbf: {
        // MOVSX r16/32/64, r/m8 (be) or r/m16 (bf) - same opcode-determined source
        // width as MOVZX.
        const sourceSize = opcode === 0xbe ? 8 : 16;
        this.readModrm();
        return this.result(Mnemonic.MOVSX, [this.regOperand(), this.rmOperand(sourceSize)], { sourceSize });
      }
      case 0xaf:
        this.readModrm();
        return this.result(Mnemonic.IMUL, [this.regOperand(), this.rmOperand()]);
      case 0xc0: case 0xc1: {
        // XADD r/m8, r8 and XADD r/m, r. The byte form is C0 and *not* F0 - F0 is
        // LOCK, a prefix, which is the whole reason the two are not contiguous. The
        // reg field is 8 bits wide in the C0 form whatever the operand-size prefix
        // says, so it cannot be read through the ordinary reg operand.
        this.readModrm();
        const byteForm = opcode === 0xc0;
        return this.result(Mnemonic.XADD, [
          byteForm ? this.byteRegisterOperand() : this.rmOperand(),
          byteForm ? this.regOperand8() : this.regOperand(),
        ]);
      }
      case 0xb0: case 0xb1: {
        // CMPXCHG r/m8, r8 and CMPXCHG r/m, r. The destination and the accumulator are
        // implicit in the SDM's description, so both are named in the decoded form:
        // the first operand is where the comparison writes, the second is the value
        // compared against it.
        this.readModrm();
        const byteForm = opcode === 0xb0;
        return this.result(Mnemonic.CMPXCHG, [
          byteForm ? this.byteRegisterOperand() : this.rmOperand(),
          byteForm ? this.regOperand8() : this.regOperand(),
        ]);
      }
      case 0x0d: case 0x18: case 0x1e: {
        // Prefetch and hint-nop forms; decoded so length is right. 0x1F is the
        // multi-byte NOP handled above, which is why it is not repeated here.
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

/**
 * The mnemonic for each shift/rotate group selector.
 *
 * All eight selectors are architecturally defined except /7, which the SDM marks
 * reserved: it assembles and decodes as nothing and raises #UD. RCL and RCR rotate
 * *through* the carry flag, which is why they are not the same as ROL and ROR - but
 * they are fully defined, so leaving them out of this table turns two real
 * instructions into `unimplemented` and loses the disassembly of the rotate group
 * used to implement multi-precision shifts.
 */
function shiftMnemonic(op: ShiftOp): Mnemonic {
  const table: Record<number, Mnemonic> = {
    0: Mnemonic.ROL,
    1: Mnemonic.ROR,
    2: Mnemonic.RCL,
    3: Mnemonic.RCR,
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

const REG_NAMES16: Readonly<Record<number, string>> = {
  0: 'ax', 1: 'cx', 2: 'dx', 3: 'bx', 4: 'sp', 5: 'bp', 6: 'si', 7: 'di',
  8: 'r8w', 9: 'r9w', 10: 'r10w', 11: 'r11w', 12: 'r12w', 13: 'r13w', 14: 'r14w', 15: 'r15w',
};

const REG_NAMES32: Readonly<Record<number, string>> = {
  0: 'eax', 1: 'ecx', 2: 'edx', 3: 'ebx', 4: 'esp', 5: 'ebp', 6: 'esi', 7: 'edi',
  8: 'r8d', 9: 'r9d', 10: 'r10d', 11: 'r11d', 12: 'r12d', 13: 'r13d', 14: 'r14d', 15: 'r15d',
};

/**
 * The name of a general-purpose register at a given width.
 *
 * The width is part of the name and not a decoration: `eax` and `rax` are the same
 * register index and different instructions, so printing `rax` for a 32-bit operand
 * misrepresents what the instruction does - a 32-bit `mov` writes RAX's low half and
 * zeroes its high half, while a 64-bit one preserves it.
 *
 * Width 8 and an absent width both fall through to the 64-bit name: 8-bit operands are
 * printed by `byteRegName`, which is the only table with SPL/BPL/SIL/DIL and R8B-R15B,
 * and a caller with no width wants the architectural name.
 */
export function regName(index: number, width?: number): string {
  if (width === 16) return REG_NAMES16[index] ?? REG_NAMES[index] ?? `r${index}`;
  if (width === 32) return REG_NAMES32[index] ?? REG_NAMES[index] ?? `r${index}`;
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

/**
 * The sixteen condition codes, in the SDM's own spelling.
 *
 * E and NE for conditions 4 and 5, rather than the equally valid Z and NZ. See
 * `formatInstruction`: the parser canonicalises to these, so this table is the
 * single place the spelling is decided.
 */
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

/**
 * The assembler's size keyword for a memory operand width.
 *
 * `byte`/`word`/`dword`/`qword` - the same spellings the parser accepts, so a printed
 * memory operand can be handed straight back to the assembler.
 */
function sizeKeyword(width: number): string {
  switch (width) {
    case 8:
      return 'byte';
    case 16:
      return 'word';
    case 32:
      return 'dword';
    case 64:
      return 'qword';
    default:
      return String(width);
  }
}

/**
 * Render one operand.
 *
 * Memory operands **always** carry their size keyword, even when the width is the one
 * the mode implies by default, so `not [rbx]` is never emitted in long mode where
 * `not dword [rbx]` means one instruction and the bare form is ambiguous.
 *
 * That is not decoration. This assembler refuses to infer a memory operand's size from
 * the mode, because a bare `mov [rbx], 1` that silently assembled to the wrong width
 * would be worse than an error. A disassembler whose output its own assembler rejects
 * is therefore broken, and suppressing the keyword "because the mode is known" hands
 * that responsibility to the reader - who is exactly the thing a disassembler exists to
 * serve. Register operands carry their width in the name and need no such help.
 */
export function formatOperand(op: Operand): string {
  switch (op.kind) {
    case 'reg':
      // 8-bit operands are printed from the byte tables, not from `regName`: SPL, SIL
      // and R8B-R15B only exist at that width, and an 8-bit operand printed as `rax`
      // would claim four times the register the instruction touches.
      if (op.highByte === true) return byteRegName(op.reg, true);
      if (op.size === 8) return byteRegName(op.reg, false);
      return regName(op.reg, op.size);
    case 'seg':
      return segName(op.seg);
    case 'imm':
      return op.value < 0n ? `-0x${(-op.value).toString(16)}` : `0x${op.value.toString(16)}`;
    case 'rel':
      return `0x${op.target.toString(16)}`;
    case 'far':
      // The field after the colon is a *selector*: an index into the descriptor table
      // with the RPL in the low two bits and the TI bit in bit 2. It is not a segment
      // register number, and the only selectors that are segment numbers are 0-7. A
      // selector of 0x1000 names no register at all, so printing it through `segName`
      // produces `seg4096` - a name that exists in no assembler and re-assembles to
      // nothing. The number is printed as the number it is, because that is what the
      // instruction loads into CS and what the CPU loads into the descriptor cache.
      //
      // `far` is part of the operand rather than the mnemonic because that is the one
      // place it is written: `jmp far 0x1000:0x1234`. Spelling it as the mnemonic
      // (`jmpf`) would need a second alias table to read back, and would leave the
      // operand looking like a bare expression, which the parser reads as a symbol.
      return `far 0x${op.segment.toString(16)}:0x${op.offset.toString(16)}`;
    case 'moffs':
      return `[0x${op.addr.toString(16)}]`;
    case 'mem': {
      const keyword = `${sizeKeyword(op.operandWidth)} `;
      if (op.ripRelative) {
        const d = op.disp;
        return `${keyword}[rip${d < 0n ? `-0x${(-d).toString(16)}` : `+0x${d.toString(16)}`}]`;
      }
      // The base and index are named at the *address* width, not the operand width and
      // not a fixed 64. All three modes are distinct: 16-bit addressing uses bx/si/di/bp
      // with no scale factor, 32-bit addressing uses ebx/esi and computes the effective
      // address in 32 bits, and long mode uses rbx/rsi and computes it in 64. Printing
      // `rbx` for a 32-bit form is not a harmless synonym - `[rbx]` does not exist in
      // protected 32-bit mode, and the text does not re-assemble because the assembler
      // will not accept a 64-bit register there.
      const name = (i: number): string => regName(i, op.addressWidth);
      const parts: string[] = [];
      if (op.base >= 0) parts.push(name(op.base));
      // 16-bit addressing has no scale factor, so printing `*1` would state a
      // multiplication that has no encoding.
      if (op.index >= 0) parts.push(op.addressWidth === 16 ? name(op.index) : `${name(op.index)}*${op.scale}`);
      if (parts.length === 0) return `${keyword}[0x${op.disp.toString(16)}]`;
      const d = op.disp;
      if (d < 0n) parts.push(`-0x${(-d).toString(16)}`);
      else if (d > 0n) parts.push(`0x${d.toString(16)}`);
      return `${keyword}[${parts.join('+')}]`;
    }
  }
}

export function formatInstruction(
  address: bigint,
  length: number,
  mnemonic: Mnemonic,
  operands: readonly Operand[],
  condition?: number,
  /** The repeat prefix in effect, if any. Only meaningful for string instructions. */
  rep: 'none' | 'rep' | 'repne' = 'none',
  /** True when a LOCK prefix was present. */
  lock = false,
): string {
  // Jcc, SETcc and CMOVcc are one instruction each with sixteen conditions, and the
  // map name is a prefix rather than a mnemonic: "jcc" + "e" is not "jcc", it is "je".
  //
  // The suffix table holds the SDM spellings - E/NE for conditions 4 and 5, not the
  // equally valid Z/NZ - and that choice is load-bearing rather than cosmetic. The
  // parser canonicalises every alias to the same spellings (`jz` -> `je`, `jnz` ->
  // `jne`, `cmovz` -> `cmove`), so the disassembly re-assembles to the identical
  // instruction. Emitting Z/NZ here instead would still assemble, but only because
  // two tables happened to agree, and the one place that decides it is this one.
  let name: string = mnemonic;
  if (condition !== undefined) {
    const suffix = CONDITION_NAMES[condition];
    if (mnemonic === Mnemonic.JCC) name = `j${suffix}`;
    else if (mnemonic === Mnemonic.SETCC) name = `set${suffix}`;
    else if (mnemonic === Mnemonic.CMOVCC) name = `cmov${suffix}`;
  } else if (mnemonic === Mnemonic.JMPF) {
    // `jmpf` and `jmp far` are the same instruction, and the spelling chosen here is
    // the one that reads back: the far-ness is an *operand*, printed by `formatOperand`
    // as `far 0x1000:0x1234`, so the mnemonic stays the ordinary `jmp` and the parser
    // recovers both the opcode and the pointer from one operand. A `jmpf` mnemonic
    // would need an alias to parse and would still lose the distinction between
    // `jmpf 0x1000:0x1234` and the register form `jmp 0x1000`.
    name = 'jmp';
  } else if (mnemonic === Mnemonic.CALLF) {
    name = 'call';
  } else if (mnemonic === Mnemonic.PUSH_SEG) {
    // 06/0E/16/1E are the one-byte PUSH segment opcodes, and the segment is the whole
    // operand - `push ds`, not `push ds, ax`. Spelling the instruction as `push_seg`
    // would need an alias to read back and would read as a different instruction from
    // `push`, which takes an r/m operand where the operand size is chosen by a prefix.
    // Printing `push` and letting the segment operand carry the distinction is what
    // makes the text re-assemble.
    name = 'push';
  } else if (mnemonic === Mnemonic.POP_SEG) {
    name = 'pop';
  }
  const text = operands.map(formatOperand).join(', ');
  // REP, REPNE and LOCK are part of the instruction rather than decoration on it, and
  // each is reported for the same reason: dropping one leaves text that re-assembles
  // to something shorter and semantically different, which is the worst kind of
  // round-trip failure because it looks like it worked. REP turns one iteration into a
  // counted run; LOCK is the whole atomicity of a kernel's increment-and-test.
  // LOCK is printed first, matching the prefix order the encoder emits.
  const prefix = `${lock ? 'lock ' : ''}${rep === 'rep' ? 'rep ' : rep === 'repne' ? 'repne ' : ''}`;
  const body = `${prefix}${name}${text ? ` ${text}` : ''}`;
  return `${body.padEnd(30, ' ')}  ; ${length} bytes @ 0x${address.toString(16)}`;
}
