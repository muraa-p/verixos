/**
 * VerixOS - instruction encoder.
 *
 * Turns a parsed `InstructionStatement` into bytes. This is the mirror of
 * `src/arch/decode.ts`: if the two disagree about any encoding, the assembler
 * emits code the CPU decodes as a *different* instruction. The round-trip tests
 * in `tests/asm.test.ts` assert exactly that, by assembling each mnemonic and
 * checking the decoder reads back the same one.
 *
 * ## Byte order is structural, not conventional
 *
 * An x86 encoding is laid out in a fixed order:
 *
 *     [legacy prefixes] [REX] [opcode] [ModRM] [SIB] [disp] [imm]
 *
 * The tempting way to write an encoder is to push bytes as they are discovered,
 * but that puts the ModRM *before* the opcode in every handler that emits the
 * opcode last, which is most of them. So this encoder fills in a `Frame` and
 * serialises it once at the end. Byte order is then a property of `serialize()`
 * rather than of the order the code happens to run in, and no handler can get it
 * wrong.
 *
 * ## One helper for the r/m side
 *
 * Almost every bug in a hand-written x86 encoder is a ModRM `mod` field of 3 on
 * an instruction whose r/m operand turned out to be memory, which silently
 * reinterprets the ModRM byte as a register number. So `rm()` is the only way to
 * obtain an r/m field: it returns `mod`, the SIB and displacement bytes, and the
 * REX.X/REX.B contributions together, for a register and for memory alike, and
 * there is no way to get a `mod` without also getting the addressing form.
 *
 * ## The decisions that actually bite
 *
 *  - **REX comes after 0x66/0xF2/0xF3 but before the opcode.** Any byte in
 *    0x40-0x4F after a legacy prefix is REX, so an instruction needing both an
 *    operand-size override and REX must emit `66` first.
 *
 *  - **An empty REX is a real instruction.** `mov sil, 1` must emit `40`, not
 *    nothing: without it ModRM field 6 means DH rather than SIL. The same applies
 *    to every use of SPL, BPL, SIL, DIL or R8B-R15B.
 *
 *  - **AH/CH/DH/BH forbid REX entirely.** There is no encoding of `mov ah, r8b`.
 *    That is an architectural fact, not an assembler limitation, so it is an
 *    error rather than a silent truncation.
 *
 *  - **`mov rax, imm64` does not exist.** `B8+r` holds at most an imm32, so even
 *    `C7` with a sign-extended imm32 cannot reach above 2^31. Reported, not
 *    fudged.
 *
 *  - **An ambiguous operand size is an error.** `mov [rbx], 1` has no inherent
 *    size, and guessing 32 bits when the author meant 64 is exactly the kind of
 *    silent wrongness worth refusing.
 *
 *  - **Branch and RIP-relative displacements are fixups.** Both are measured from
 *    the *end* of the instruction, so computing one requires already knowing the
 *    length, which is the thing being computed. The encoder reserves the bytes and
 *    reports the target; the assembler patches it once the length is settled.
 *
 * Source: Intel SDM Vol. 2, Chapters 2-3; Vol. 1, Sec. 4.5 (addressing).
 */

import { byteRegisterField, evaluateExpression } from './ast.ts';
import type { Expression, InstructionStatement, MemoryRef, Operand, RegisterRef } from './ast.ts';
import { CpuMode } from '../arch/decode.ts';
import { Reg } from '../arch/types.ts';
import { AsmError } from './lexer.ts';

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A displacement the assembler patches once the instruction length is known.
 *
 * `offset` is where the placeholder bytes sit inside the instruction, and
 * `target` is the absolute address they should resolve to. Both branch
 * displacements and RIP-relative memory operands are relative to the *end* of the
 * instruction, so the assembler computes `target - (address + length)`.
 */
export interface Fixup {
  readonly offset: number;
  readonly width: 1 | 2 | 4;
  readonly target: bigint;
  /** True for a RIP-relative memory operand rather than a branch. */
  readonly ripRelative: boolean;
}

export interface EncodeContext {
  readonly filename: string;
  readonly line: number;
  readonly mode: CpuMode;
  /** Address of the instruction's first byte. */
  readonly address: bigint;
  /** Resolves a symbol to an absolute address. Throws if it is unknown. */
  readonly resolve: (name: string) => bigint;
  /**
   * Displacement width the assembler has settled on for this statement's branch,
   * or null when the statement contains none.
   *
   * The choice is circular - the displacement is measured from the end of the
   * instruction, so the width changes the length, which changes the distance -
   * so the encoder is told rather than deciding. The assembler promotes the width
   * when the real distance does not fit and encodes again.
   */
  readonly branchWidth: 8 | 16 | 32 | null;
}

export interface EncodeResult {
  readonly bytes: number[];
  readonly fixups: readonly Fixup[];
  /** Displacement width used, or null when the statement had no branch. */
  readonly branchWidth: 8 | 16 | 32 | null;
  /**
   * Whether a branch displacement that turned out to be too wide could be widened.
   *
   * LOOP, LOOPE and LOOPNE have no near form at all - every one of them is a single
   * opcode with a fixed 8-bit displacement and nothing to promote to. Without this
   * flag the relaxation loop would widen one anyway and emit four bytes of
   * displacement after a two-byte instruction, which decodes as something else
   * entirely. It has to come from the encoder, because only the encoder knows which
   * instructions have a wider form at all.
   */
  readonly branchWidens: boolean;
}

/* -------------------------------------------------------------------------- */
/* Frame                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An encoding under construction.
 *
 * Serialising in a fixed order is the entire point. `dispStart` records where the
 * displacement bytes begin so a fixup can point at its own placeholder, which
 * matters because an immediate may follow the displacement in the same
 * instruction.
 */
class Frame {
  readonly prefixes: number[] = [];
  rex: number | null = null;
  readonly opcode: number[] = [];
  modrm: number | null = null;
  sib: number | null = null;
  readonly disp: number[] = [];
  readonly imm: number[] = [];
  private dispStart = -1;

  /** Byte length of everything serialised so far. */
  length(): number {
    return this.prefixes.length
      + (this.rex === null ? 0 : 1)
      + this.opcode.length
      + (this.modrm === null ? 0 : 1)
      + (this.sib === null ? 0 : 1)
      + this.disp.length
      + this.imm.length;
  }

  appendDisp(bytes: readonly number[]): number {
    if (this.dispStart < 0) this.dispStart = this.length();
    this.disp.push(...bytes);
    return this.dispStart;
  }

  serialize(): number[] {
    const out: number[] = [...this.prefixes];
    if (this.rex !== null) out.push(this.rex);
    out.push(...this.opcode);
    if (this.modrm !== null) out.push(this.modrm);
    if (this.sib !== null) out.push(this.sib);
    out.push(...this.disp);
    out.push(...this.imm);
    return out;
  }
}

/**
 * The r/m side of an instruction: ModRM `mod` and `rm`, any SIB and displacement
 * bytes, and the REX.X and REX.B contributions that the memory form needs.
 */
interface RmForm {
  readonly mod: number;
  /** Three-bit r/m field, or 4 meaning "a SIB byte follows". */
  readonly rm: number;
  readonly sib: number | null;
  readonly disp: readonly number[];
  readonly x: number;
  readonly b: number;
  /**
   * Set when `disp` is a RIP-relative displacement, and holding the address it points
   * at.
   *
   * The field is left as four zero bytes in `disp` and filled in by the assembler,
   * because the value depends on where the instruction ends and the encoder is
   * encoding before the relaxation loop has settled. Optional rather than always
   * present because only this one addressing mode needs it, and an explicit
   * `ripTarget: null` on every other form would be noise.
   */
  readonly ripTarget?: bigint;
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

const ALU_OPS: Readonly<Record<string, number>> = {
  add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7,
};

const SHIFT_OPS: Readonly<Record<string, number>> = {
  rol: 0, ror: 1, rcl: 2, rcr: 3, shl: 4, shr: 5, sar: 6,
};

/** Group 3: TEST shares the 0xF6/0xF7 encodings with NOT, NEG, MUL and DIV. */
const GROUP3_OPS: Readonly<Record<string, number>> = {
  test: 0, not: 2, neg: 3, mul: 4, imul: 5, div: 6, idiv: 7,
};

/**
 * Condition-code suffixes, indexed to the value encoded in Jcc/SETcc/CMOVcc.
 *
 * The SDM numbers the sixteen conditions in exactly this order, so the position in
 * this array *is* the encoding - which is why it is a positional table and not a
 * lookup. `jnz`, `jne` and `jnz`'s AT&T form all land on index 4 because they are
 * one condition with three names; see `CONDITION_SYNONYMS` in the parser for the
 * spelling that gets them there.
 */
const CONDITION_NAMES: readonly string[] = [
  'o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g',
];

const SIZE_BITS: Readonly<Record<string, number>> = {
  byte: 8, word: 16, dword: 32, qword: 64, fword: 48, tword: 80,
};

const SCALE_BITS: Readonly<Record<number, number>> = { 1: 0, 2: 1, 4: 2, 8: 3 };

/** Base or index fields that force a SIB byte, because field 4 is the escape. */
const SIB_REQUIRED: ReadonlySet<string> = new Set(['rsp', 'r12', 'esp', 'r12d']);

/** Legal 32/64-bit base and index registers. */
const ADDRESS_REGISTERS: Readonly<Record<string, number>> = {
  rax: 0, rcx: 1, rdx: 2, rbx: 3, rsp: 4, rbp: 5, rsi: 6, rdi: 7,
  r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, r13: 13, r14: 14, r15: 15,
  eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7,
  r8d: 8, r9d: 9, r10d: 10, r11d: 11, r12d: 12, r13d: 13, r14d: 14, r15d: 15,
};

/**
 * The four 16-bit address registers, and *only* those four names.
 *
 * `ebx`, `ebp`, `esi` and `edi` name the same registers and are legal in 32- and
 * 64-bit addressing, where they are the ordinary `[ebx]` with ModRM field 3 - so they
 * must not appear here, or `[ebx]` gets refused in exactly the mode where it is most
 * common. They are also *not* 16-bit address registers in real mode: `[ebx]` there
 * needs the 0x67 address-size prefix to reach 32-bit addressing, which this encoder
 * does not emit, so it is refused with that reason rather than silently encoded as
 * `[bx]`.
 */
const ADDRESS16_REGISTERS: Readonly<Record<string, number>> = {
  bx: 3, bp: 5, si: 6, di: 7,
};

/** Whether a register name is one of the 32/64-bit base or index registers. */
function baseIs32Or64(name: string | null): boolean {
  return name !== null && name in ADDRESS_REGISTERS;
}

/**
 * The 16-bit addressing table: `[rm field, base, index]`, with -1 for absent.
 *
 * 16-bit addressing is not 32-bit addressing with a narrower displacement. It is
 * a separate encoding with four hard-wired register pairs in fields 0-3 and four
 * single registers in 4-7, and it has **no scale factor at all** - the `mod`
 * field selects only the displacement width (00 none, 01 disp8, 10 disp16), so
 * `si*2` is not merely unusual but unencodable. Field 6 is overloaded too:
 * mod=00 makes it a bare disp16 rather than `[bp]`.
 *
 * SI and DI appear in the *index* column for the same architectural reason - a
 * 16-bit address can only name them there - so `[si]` normalises to (none, si)
 * before the lookup. See `memoryForm16`.
 *
 * This is why the real-mode boot path needs its own addressing code rather than a
 * parameterised version of the 32-bit one.
 */
const ADDRESS16: readonly (readonly [number, number, number])[] = [
  [0, 3, 6], // bx + si
  [1, 3, 7], // bx + di
  [2, 5, 6], // bp + si
  [3, 5, 7], // bp + di
  [4, -1, 6], // si
  [5, -1, 7], // di
  [6, 5, -1], // bp        (only reachable with mod != 00)
  [7, 3, -1], // bx
  [6, -1, -1], // bare disp16
];

/** Instructions with a bare opcode, no operands and no ModRM. */
const SIMPLE_OPCODES: Readonly<Record<string, readonly number[]>> = {
  nop: [0x90],
  int3: [0xcc],
  hlt: [0xf4],
  cli: [0xfa],
  sti: [0xfb],
  cld: [0xfc],
  std: [0xfd],
  clc: [0xf8],
  stc: [0xf9],
  cmc: [0xf5],
  lahf: [0x9f],
  sahf: [0x9e],
  pushf: [0x9c],
  popf: [0x9d],
  cbw: [0x66, 0x98],
  cwd: [0x66, 0x99],
  cwde: [0x98],
  cdq: [0x99],
  cdqe: [0x48, 0x98],
  cqo: [0x48, 0x99],
  ud2: [0x0f, 0x0b],
  cpuid: [0x0f, 0xa2],
  // XGETBV and XSETBV take no ModRM byte: the escape already spent it on the opcode
  // position. D0 and D1 are the whole instruction, which is why they cannot be
  // expressed as a reg field of `0F 01` - they *are* the ModRM byte.
  xgetbv: [0x0f, 0x01, 0xd0],
  xsetbv: [0x0f, 0x01, 0xd1],
  rdtsc: [0x0f, 0x31],
  rdtscp: [0x0f, 0x01, 0xf9],
  rdmsr: [0x0f, 0x32],
  wrmsr: [0x0f, 0x30],
  syscall: [0x0f, 0x05],
  sysret: [0x0f, 0x07],
  swapgs: [0x0f, 0x01, 0xf8],
  wbinvd: [0x0f, 0x09],
  clts: [0x0f, 0x06],
  invd: [0x0f, 0x08],
  pause: [0xf3, 0x90],
  xlatb: [0xd7],
  leave: [0xc9],
};

/**
 * The instructions whose memory destination is implied rather than written down.
 *
 * Only the string primitives are here. Each of them takes no operands in the usual
 * spelling - `rep stosq` rather than `stosq rdi, rax` - because the fixed registers
 * are part of the instruction, so the destination `[RDI]` has to be taken from the
 * mnemonic rather than read off the operand list.
 *
 * `ins`/`outs` are absent because this assembler spells those as the separate
 * `insb`/`insw`/`outb`/`outw` mnemonics, which the destination test cannot see
 * either. That is a gap in the set, not a claim that LOCK is illegal on them.
 */
const IMPLICIT_MEMORY_DESTINATION: ReadonlySet<string> = new Set([
  'movs', 'stos', 'lods', 'scas', 'cmps',
]);

/**
 * The one-byte segment push opcodes, keyed by the register's number.
 *
 * POP is the same table plus one: 06/07 are ES, 0E/0F are CS, 16/17 are SS and 1E/1F
 * are DS. The pairing is exact rather than incidental - the opcode's low three bits
 * are the register, and adding one sets them, so a table with both would be two copies
 * of the same fact with one copy free to drift.
 */
const SEGMENT_PUSH_POP: Readonly<Record<number, number>> = {
  0: 0x06, // ES
  1: 0x0e, // CS
  2: 0x16, // SS
  3: 0x1e, // DS
};

/* -------------------------------------------------------------------------- */
/* Little-endian helpers                                                       */
/* -------------------------------------------------------------------------- */

function bytesOf(value: bigint, width: number): number[] {
  const v = BigInt.asUintN(width * 8, value);
  const out: number[] = [];
  for (let i = 0; i < width; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

function signedRange(width: number): readonly [bigint, bigint] {
  const bits = BigInt(width * 8);
  return [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
}

function fitsIn(value: bigint, width: number): boolean {
  const [min, max] = signedRange(width);
  return value >= min && value <= max;
}

function isSize(bits: number | undefined): bits is 8 | 16 | 32 | 64 {
  return bits === 8 || bits === 16 || bits === 32 || bits === 64;
}

/* -------------------------------------------------------------------------- */
/* Encoder                                                                     */
/* -------------------------------------------------------------------------- */

export class Encoder {
  private readonly stmt: InstructionStatement;
  private readonly ctx: EncodeContext;
  private readonly frame = new Frame();
  private readonly fixups: Fixup[] = [];
  private branchWidth: 8 | 16 | 32 | null = null;
  /**
   * Whether the relaxation loop may widen this instruction's branch displacement.
   * False only for LOOP and its relatives, which have no wider form to widen into.
   */
  private branchWidens = true;

  constructor(stmt: InstructionStatement, ctx: EncodeContext) {
    this.stmt = stmt;
    this.ctx = ctx;
  }

  encode(): EncodeResult {
    const { mnemonic } = this.stmt;

    const simple = SIMPLE_OPCODES[mnemonic];
    if (simple !== undefined) {
      this.requireNoOperands();
      this.frame.opcode.push(...simple);
      return this.result();
    }

    if (mnemonic.startsWith('j') && CONDITION_NAMES.includes(mnemonic.slice(1))) {
      return this.encodeJcc(CONDITION_NAMES.indexOf(mnemonic.slice(1)));
    }
    if (mnemonic.startsWith('set') && CONDITION_NAMES.includes(mnemonic.slice(3))) {
      return this.encodeSetcc(CONDITION_NAMES.indexOf(mnemonic.slice(3)));
    }
    if (mnemonic.startsWith('cmov') && CONDITION_NAMES.includes(mnemonic.slice(4))) {
      return this.encodeCmov(CONDITION_NAMES.indexOf(mnemonic.slice(4)));
    }

    switch (mnemonic) {
      case 'ret':
        return this.encodeRet();
      case 'retf':
      case 'retfq':
        return this.encodeRetf(mnemonic === 'retfq');
      case 'push':
      case 'pop':
        return this.encodePushPop(mnemonic === 'push');
      case 'jmp':
        return this.encodeJmp();
      case 'call':
        return this.encodeCall();
      case 'loop':
      case 'loope':
      case 'loopne':
        return this.encodeLoop(mnemonic);
      case 'lea':
        return this.encodeLea();
      case 'mov':
        return this.encodeMov();
      case 'movzx':
      case 'movsx':
        return this.encodeMovExtend();
      case 'movs':
      case 'stos':
      case 'lods':
      case 'scas':
      case 'cmps':
      case 'ins':
      case 'outs':
        return this.encodeString(mnemonic);
      case 'int':
        return this.encodeInt();
      case 'sgdt':
      case 'sidt':
      case 'lgdt':
      case 'lidt':
      case 'ltr':
      case 'lldt':
      case 'sldt':
      case 'str':
      case 'verr':
      case 'verw':
        return this.encodeDescriptor(mnemonic);
      case 'smsw':
      case 'lmsw':
        return this.encodeMachineStatus(mnemonic);
      case 'invlpg':
        return this.encodeInvlpg();
      case 'in':
      case 'out':
        return this.encodeIo(mnemonic === 'in');
      case 'xadd':
      case 'cmpxchg':
      case 'xchg':
        return this.encodeXchgFamily(mnemonic);
      case 'imul':
        return this.encodeImul();
      case 'inc':
        return this.encodeIncDec(0);
      case 'dec':
        return this.encodeIncDec(1);
      default:
        break;
    }

    if (mnemonic in ALU_OPS) return this.encodeAlu();
    if (mnemonic in SHIFT_OPS) return this.encodeShift();
    if (mnemonic in GROUP3_OPS) return this.encodeGroup3();

    this.fail(`unknown mnemonic '${mnemonic}'`);
  }

  private result(): EncodeResult {
    this.lockPrefix();
    return {
      bytes: this.frame.serialize(),
      fixups: this.fixups,
      branchWidth: this.branchWidth,
      branchWidens: this.branchWidens,
    };
  }

  /**
   * Emit the LOCK prefix, if one was written.
   *
   * LOCK is a statement-level property, like REP, so it belongs here rather than in
   * the twenty-odd encoders that could need it. Handling it in only the string
   * primitives - where it was - means `lock inc qword [rax]` assembles to `48 ff 00`
   * with the prefix quietly gone, and the disassembly of `f0 ff 00` prints the same
   * text. In a kernel that is a data race written in assembly: the atomicity the
   * author asked for is not in the binary, and nothing reports its absence.
   *
   * The one precondition is a *memory destination*. LOCK raises #UD on an instruction
   * that does not write memory, because there is no access for it to serialise, and
   * that is a hard rule rather than a style preference. `lock inc ecx` is refused
   * here rather than left to fault in long mode, where LOCK is a no-op on locked
   * memory and so the mistake would never announce itself.
   *
   * There is deliberately no list of lockable mnemonics. The SDM names the
   * instructions for which LOCK is *useful* - the eight ALU operations, INC/DEC/NEG/
   * NOT, the atomics, XCHG and the string primitives - and separately permits LOCK on
   * any instruction with a memory destination. Those are different questions, and the
   * destination test answers the architectural one. Refusing `lock mov [rax], rbx`
   * would be refusing something the hardware accepts, and a name list would have to
   * be kept in step with the opcode tables forever to avoid doing that by accident.
   */
  private lockPrefix(): void {
    if (!this.stmt.locked) return;
    // The string primitives are the one family whose memory operand is not written
    // down: `rep stosq` names no operands at all, because its destination is RDI and
    // its source is an accumulator. They do write memory, so LOCK applies - and
    // `lock rep stosq` is how a kernel publishes a structure without an observer
    // seeing it half-built - but operand 0 is absent, so the test below cannot see
    // the destination and would otherwise reject a legitimate atomic clear.
    const impliedMemoryDestination = IMPLICIT_MEMORY_DESTINATION.has(this.stmt.mnemonic);
    // Operand 0 is the destination for every other instruction that can carry one,
    // including the single-operand forms: INC, DEC, NOT, NEG and one-operand IMUL all
    // write r/m. XADD and CMPXCHG are `r/m, r`, so their destination is likewise
    // operand 0 - taking the source would approve `lock xadd eax, dword [rbx]`.
    if (!impliedMemoryDestination && this.stmt.operands[0]?.kind !== 'memory') {
      this.fail(`cannot be locked: LOCK needs a memory destination, and operand 0 is not memory`);
    }
    this.frame.prefixes.push(0xf0);
  }

  /* ------------------------------------------------------------------ */
  /* Diagnostics and shared helpers                                     */
  /* ------------------------------------------------------------------ */

  private fail(message: string): never {
    throw new AsmError(`${this.stmt.mnemonic}: ${message}`, this.ctx.filename, this.ctx.line, 1);
  }

  private requireNoOperands(): void {
    if (this.stmt.operands.length > 0) {
      this.fail(`takes no operands, found ${this.stmt.operands.length}`);
    }
  }

  private expectCount(count: number): void {
    if (this.stmt.operands.length !== count) {
      this.fail(`takes ${count} operand${count === 1 ? '' : 's'}, found ${this.stmt.operands.length}`);
    }
  }

  private operand(index: number): Operand {
    const operand = this.stmt.operands[index];
    if (operand === undefined) this.fail(`operand ${index + 1} is missing`);
    return operand;
  }

  private evaluate(expr: Expression): bigint {
    try {
      return evaluateExpression(expr, (name) => this.ctx.resolve(name), `operand of '${this.stmt.mnemonic}'`);
    } catch (error) {
      if (error instanceof AsmError) this.fail(error.message);
      throw error;
    }
  }

  /**
   * Effective operand size in bits.
   *
   * An explicit `byte`/`word`/`qword` keyword wins. Otherwise the size comes from
   * the widest non-byte register operand, which is how `mov ax, [bx]` and
   * `add eax, [rbx]` are expected to behave. An instruction with only memory and
   * immediate operands has no inherent size at all, and defaulting it is how
   * `mov [rbx], 1` silently becomes a 32-bit store when 64 bits were meant, so it
   * is refused instead.
   */
  private operandSize(): 8 | 16 | 32 | 64 {
    const override = this.stmt.sizeOverride;
    if (override !== null) {
      const bits = SIZE_BITS[override];
      if (!isSize(bits)) this.fail(`a ${override} operand is not supported`);
      return bits;
    }

    let sawByte = false;
    for (const operand of this.stmt.operands) {
      // A keyword written against an individual operand states that operand's
      // width, which is the instruction's width whenever the operand is a memory
      // one. This is what makes `movzx eax, byte [rbx]` unambiguous.
      if (operand.kind === 'memory' && operand.size !== null) {
        const bits = SIZE_BITS[operand.size];
        if (!isSize(bits)) this.fail(`a ${operand.size} operand is not supported`);
        return bits;
      }
      if (operand.kind !== 'register') continue;
      if (operand.reg.size === 8) {
        sawByte = true;
        continue;
      }
      return operand.reg.size;
    }
    if (sawByte) return 8;
    if (this.ctx.mode === CpuMode.REAL16) return 16;
    this.fail('the operand size is ambiguous: write `byte`, `word`, `dword` or `qword` before the operand');
  }

  /**
   * The width of one operand, in bits.
   *
   * For `movzx`/`movsx` this is the *source* width, and it is the one thing the
   * opcode has to be chosen from, so it cannot be left implicit: `movzx eax, bl`
   * and `movzx eax, bx` are different opcodes (0F B6 and 0F B7) and nothing else
   * in the instruction distinguishes them.
   */
  private sourceWidth(operand: Operand): 8 | 16 {
    if (operand.size !== null) {
      const bits = SIZE_BITS[operand.size];
      if (bits === 8 || bits === 16) return bits;
      this.fail(`'${operand.size}' is not a source width: movzx and movsx read 8 or 16 bits`);
    }
    if (operand.kind === 'register') {
      if (operand.reg.size === 8) return 8;
      if (operand.reg.size === 16) return 16;
      this.fail(
        `a movzx or movsx source must be 8 or 16 bits; '${operand.reg.name}' is ${operand.reg.size} bits`,
      );
    }
    if (operand.kind === 'memory') {
      this.fail(
        'a memory source has no width of its own: write `byte` or `word` before it, as in `movzx eax, byte [rbx]`',
      );
    }
    this.fail('movzx and movsx take a register or memory source, not an immediate');
  }

  /**
   * Build the REX byte, or null when none is needed - the common case.
   *
   * The layout is `0100WRXB`: bit 3 is W, bit 2 is R, bit 1 is X, bit 0 is B. The
   * three extension bits sit in *different* places, so folding them all into bit 0
   * - which looks harmless and is not - silently corrupts any instruction using
   * R8-R15 as a ModRM reg field or a SIB index, and the damage is invisible until
   * the instruction reads the wrong register.
   *
   * `force` covers the 8-bit registers where an *empty* REX is mandatory, because
   * without one ModRM field 6 means DH rather than SIL.
   */
  private rex(w: boolean, r: number, x: number, b: number, force: boolean): number | null {
    if (this.ctx.mode !== CpuMode.LONG64) {
      if (r > 7 || x > 7 || b > 7) this.fail('extended registers (r8-r15) require 64-bit mode');
      return null;
    }
    if (!force && !w && r < 8 && x < 8 && b < 8) return null;
    const wrxb = ((w ? 1 : 0) << 3) | (((r >> 3) & 1) << 2) | (((x >> 3) & 1) << 1) | ((b >> 3) & 1);
    return 0x40 | wrxb;
  }

  private setRex(w: boolean, r: number, x: number, b: number, force = false): void {
    this.frame.rex = this.rex(w, r, x, b, force);
  }

  private setModrm(mod: number, reg: number, rm: number): void {
    this.frame.modrm = ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7);
  }

  private setOpcode(...bytes: readonly number[]): void {
    this.frame.opcode.push(...bytes);
  }

  /**
   * The 0x66 operand-size override prefix, when the operand size needs one.
   *
   * The prefix is needed exactly when the requested width differs from the mode's
   * default, and the default is 16 in real mode and 32 everywhere else. That gives
   * three cases per mode and the one-sided form this replaced missed two of them:
   *
   *   real mode      16 needs none,  32 needs 0x66
   *   protected 32   16 needs 0x66,  32 needs none
   *   long mode      16 needs 0x66,  32 needs none, 64 needs REX.W
   *
   * Checking only `size === 16` means `mov eax, ebx` under `.code16` assembles to
   * `89 d8`, which is `mov ax, bx` - a real instruction with half the width, and a
   * round trip that reports success while silently changing the operand.
   *
   * 8 bits is excluded because there is nothing to override: every byte operation has
   * its own opcode (FE/FF for INC/DEC, 0F B6 for MOVZX), so a 0x66 in front of one
   * would not narrow anything - it would just be a stray prefix the CPU skips.
   *
   * 64 bits is excluded because REX.W carries it, and a 0x66 in front of a REX.W
   * would toggle back to 32.
   */
  private sizeOverridePrefix(size: number): void {
    if (size === 8) return;
    const def = this.ctx.mode === CpuMode.REAL16 ? 16 : 32;
    if (size !== def && size !== 64) this.frame.prefixes.push(0x66);
  }

  /**
   * Push a **sign-extended** immediate, range-checked against the field it will occupy.
   *
   * Signedness is not a convenience here - it is part of the instruction's definition,
   * and getting it wrong refuses legal instructions. The SDM splits the immediates in
   * half: `83 /n ib` sign-extends its imm8 and so only reaches -128..127, while `80 /n
   * ib` is a plain bit pattern and reaches 0..255. So `xor byte [rbx], 0xff` encodes
   * fine and `add eax, -1` does, but `add eax, 255` on the `83` form does not and has
   * to be written differently.
   *
   * Use this only where the SDM says the field sign-extends: `83 /n ib`, `6A ib`,
   * `6B /r ib`, and the 64-bit full-width forms, which take a sign-extended imm32.
   */
  private setImm(value: bigint, width: 1 | 2 | 4 | 8): void {
    if (!fitsIn(value, width)) {
      const [min, max] = signedRange(width);
      this.fail(`immediate ${value} does not fit in ${width * 8} bits (range ${min} to ${max})`);
    }
    this.frame.imm.push(...bytesOf(value, width));
  }

  /**
   * Push an **unsigned** immediate: a bit pattern, not a sign-extended quantity.
   *
   * This is the majority of the SDM's immediate forms - `04+op*8 ib`, `80 /n ib`,
   * `F6 /0 ib`, `B0+r ib`, `C6 /0 ib`, `C0/C1 /n ib`, `C2 iw`, `CD ib` and the
   * 16-/32-bit full-width forms all interpret the field as a raw value. The difference
   * is observable at the range check: a shift count of 200 (`C1 /4 ib`) and an
   * interrupt vector of 255 (`CD ib`) are both ordinary instructions that a signed
   * check would refuse, since neither field is ever sign-extended.
   *
   * A value already in range for both readings is unchanged by choosing this over
   * `setImm`, so the only effect is on what is *accepted*, never on what is emitted.
   */
  private setImmUnsigned(value: bigint, width: 1 | 2 | 4 | 8): void {
    const max = (1n << BigInt(width * 8)) - 1n;
    if (value < 0n || value > max) {
      this.fail(`immediate ${value} does not fit in ${width * 8} unsigned bits (range 0 to ${max})`);
    }
    this.frame.imm.push(...bytesOf(value, width));
  }

  /* ------------------------------------------------------------------ */
  /* The r/m side                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The addressing form for the r/m operand.
   *
   * This is the single source of `mod`, so an instruction whose r/m operand is
   * memory cannot accidentally get `mod=3`. `byte` selects the 8-bit register
   * numbering, where AH/CH/DH/BH are fields 4-7 rather than the low bytes of
   * RSP/RBP/RSI/RDI.
   */
  private rm(operand: Operand, byte: boolean): RmForm {
    if (operand.kind === 'register') {
      if (byte) {
        const ref = byteRegisterField(operand.reg);
        return { mod: 3, rm: ref.field & 7, sib: null, disp: [], x: 0, b: ref.field & 8 };
      }
      return { mod: 3, rm: operand.reg.index & 7, sib: null, disp: [], x: 0, b: operand.reg.index & 8 };
    }
    if (operand.kind !== 'memory') this.fail('expected a register or memory operand');
    return this.memoryForm(operand.mem);
  }

  /**
   * Install an r/m form into the frame: ModRM, a SIB byte if the form needs one, and
   * the displacement.
   *
   * Every instruction whose r/m operand may be memory has to come through here. Writing
   * `setModrm(3, reg, form.rm)` instead is not a shortcut: `mod = 3` says the operand
   * is a *register*, so the SIB byte and displacement are never appended and a memory
   * operand silently becomes the register of the same field number. `add dword [rbx], 1`
   * would emit `83 C3 01` - `add ebx, 1` - which decodes, runs, and corrupts a
   * different address than the one written.
   *
   * For a form that really is a register, `form.mod` is 3, `sib` is null and `disp` is
   * empty, so this is exactly the register encoding; there is no reason to reach for
   * `setModrm` directly.
   *
   * This is also the single place a memory operand's displacement is appended, so it
   * is the single place a RIP-relative one can be turned into a fixup.
   */
  private setRm(form: RmForm, regField: number): void {
    this.setModrm(form.mod, regField, form.rm);
    if (form.sib !== null) this.frame.sib = form.sib;
    const offset = this.frame.appendDisp(form.disp);
    if (form.ripTarget !== undefined) this.recordFixup(offset, 4, form.ripTarget, true);
  }

  /**
   * Resolve an 8-bit register to its ModRM field and whether it forces a REX.
   *
   * AH/CH/DH/BH occupy fields 4-7 without REX; SPL/BPL/SIL/DIL occupy the same
   * fields with one. The two are mutually exclusive, which is why the conflict is
   * checked before encoding rather than discovered afterwards.
   */
  private byteRegister(reg: RegisterRef): { field: number; needRex: boolean } {
    const { field, highByte } = byteRegisterField(reg);
    return { field, needRex: highByte ? false : reg.needsRex };
  }

  /**
   * Reject a high-byte register combined with an extended one.
   *
   * The architecture has no encoding for `mov ah, r8b`: REX would redefine field 4
   * as SPL's host register. So this is an error, checked once up front because
   * otherwise it would surface as a silently wrong encoding.
   */
  private checkByteRegisters(): void {
    let high = false;
    let extended = false;
    for (const operand of this.stmt.operands) {
      if (operand.kind !== 'register' || operand.reg.size !== 8) continue;
      if (operand.reg.highByte) high = true;
      else if (operand.reg.needsRex) extended = true;
    }
    if (high && extended) {
      this.fail('a high-byte register (AH/CH/DH/BH) cannot be combined with SPL/BPL/SIL/DIL or R8B-R15B: there is no encoding that needs no REX prefix yet uses extended registers');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Addressing forms                                                   */
  /* ------------------------------------------------------------------ */

  private addressRegister(name: string): number {
    const value = ADDRESS_REGISTERS[name];
    if (value === undefined) this.fail(`'${name}' cannot be used in an address`);
    return value;
  }

  /**
   * The SIB scale field for a scale factor.
   *
   * The parser already restricts scales to 1, 2, 4 and 8, so an unknown value here
   * would mean the two tables had drifted apart rather than that the source was
   * wrong - which is worth a distinct message.
   */
  private scaleBits(scale: number): number {
    const bits = SCALE_BITS[scale];
    if (bits === undefined) this.fail(`scale ${scale} is not encodable`);
    return bits;
  }

  /**
   * The ModRM/SIB/displacement for a 32/64-bit memory operand.
   *
   * Three cases carry real constraints:
   *
   *  - `rsp`/`r12` as a base is ModRM field 4, the SIB escape, so a SIB byte is
   *    mandatory. Conversely an index field of 4 means "no index" only while
   *    REX.X is clear; setting REX.X would turn it into r12.
   *  - `rbp`/`r13` with a zero displacement has no mod=00 form, because field 101
   *    with mod=00 is the disp32 form. `[rbp]` therefore has no encoding at all and
   *    the shortest available is mod=01 with a zero displacement byte.
   *  - Long mode has no absolute addressing, so a bare symbol becomes
   *    RIP-relative. A literal bare address uses the SIB with base field 101, which
   *    is the only way to say "no registers" in 64-bit code.
   */
  private memoryForm32(mem: MemoryRef): RmForm {
    const disp = this.evaluate(mem.displacement);

    if (mem.ripRelative) {
      if (this.ctx.mode !== CpuMode.LONG64) {
        this.fail('RIP-relative addressing exists only in 64-bit mode; write the absolute address');
      }
      // mod=00, rm=101: the disp32 that follows is measured from the end of the
      // instruction, so a fixup stands in for it. The address is captured now and
      // the bytes are left zero for `setRm` to hand to the assembler.
      return { mod: 0, rm: 5, sib: null, disp: bytesOf(0n, 4), x: 0, b: 0, ripTarget: disp };
    }

    if (mem.base === null && mem.index !== null) {
      // No base is SIB base field 101 with mod=00, which the architecture defines
      // as "disp32 follows and nothing is added".
      const indexField = this.addressRegister(mem.index);
      return {
        mod: 0,
        rm: 4,
        sib: (this.scaleBits(mem.scale) << 6) | ((indexField & 7) << 3) | 5,
        disp: bytesOf(disp, 4),
        x: indexField & 8,
        b: 0,
      };
    }

    if (mem.base === null) {
      if (this.ctx.mode === CpuMode.LONG64) {
        // Scale 0, index field 4 (no index), base field 5 (disp32) - which is what
        // every other assembler emits for `[absolute]`. The SDM says the scale field is
        // *ignored* when the index field is 4, so 0xA5 decodes to the same address, but
        // encoding it as a scale of four states a multiplication that is not happening,
        // and makes the output fail a byte-for-byte comparison with NASM or GAS for no
        // gain. The parser may well have written a scale of 1 here; it just has nowhere
        // to go.
        return { mod: 0, rm: 4, sib: (this.scaleBits(1) << 6) | (4 << 3) | 5, disp: bytesOf(disp, 4), x: 0, b: 0 };
      }
      return { mod: 0, rm: 5, sib: null, disp: bytesOf(disp, 4), x: 0, b: 0 };
    }

    const baseField = this.addressRegister(mem.base);
    const indexField = mem.index === null ? null : this.addressRegister(mem.index);
    // RSP cannot be an index: SIB index field 100 means RSP when mod != 00 and
    // "no index" when mod == 00, so there is no encoding where it scales
    // anything. R12 *can* be an index - REX.X turns field 100 into r12 - so it is
    // only in the table because it is a forced-SIB *base*.
    if (mem.index === 'rsp' || mem.index === 'esp') {
      this.fail(`'${mem.index}' cannot be an index register`);
    }

    const baseForcesSib = SIB_REQUIRED.has(mem.base);
    // [rbp+0] has no mod=00 encoding, so take the shortest form that has one.
    const baseNeedsDisp = (baseField & 7) === 5 && disp === 0n;

    let mod: number;
    let dispBytes: readonly number[];
    if (baseNeedsDisp) {
      mod = 1;
      dispBytes = bytesOf(0n, 1);
    } else if (disp === 0n) {
      mod = 0;
      dispBytes = [];
    } else if (fitsIn(disp, 1)) {
      mod = 1;
      dispBytes = bytesOf(disp, 1);
    } else {
      mod = 2;
      dispBytes = bytesOf(disp, 4);
    }

    const needsSib = baseForcesSib || indexField !== null;
    return {
      mod,
      rm: needsSib ? 4 : baseField & 7,
      sib: needsSib
        ? (this.scaleBits(mem.scale) << 6) | (((indexField ?? 4) & 7) << 3) | (baseField & 7)
        : null,
      disp: dispBytes,
      x: indexField === null ? 0 : indexField & 8,
      b: baseField & 8,
    };
  }

  /**
   * The ModRM/displacement for a 16-bit address.
   *
   * There is no SIB byte here, and there is no scale either: the `mod` field does
   * nothing but choose between no displacement, disp8 and disp16. `bp` is
   * separately constrained because field 110 with mod=00 is the bare disp16 form
   * rather than BP.
   */
  private memoryForm16(mem: MemoryRef): RmForm {
    const disp = this.evaluate(mem.displacement);
    if (!fitsIn(disp, 2)) {
      this.fail(`displacement ${disp} does not fit in a 16-bit address; prefix the operand with 'dword' to use 32-bit addressing`);
    }

    // 16-bit addressing has no scale factor. The `mod` field here does nothing but
    // choose a displacement width, so there is no bit left over to mean "times
    // two" and `[bx+si*2]` has no encoding whatsoever. An earlier version of this
    // file borrowed `mod` for the scale, which produced bytes that decoded as a
    // completely different address - a silent corruption rather than an error.
    if (mem.scale !== 1) {
      this.fail(
        `16-bit addressing has no scale factor, so '${describeAddress(mem)}' cannot be encoded; use a 32-bit register to get one`,
      );
    }

    let base = mem.base === null ? null : this.address16Register(mem.base);
    let index = mem.index === null ? null : this.address16Register(mem.index);

    // A 16-bit address can only name SI and DI in the index column - `[si]` means
    // `[+si]`. Moving it there means the table has one canonical entry per
    // combination instead of two.
    if (base === 6 || base === 7) {
      if (index !== null) this.fail(`'${mem.index}' cannot be combined with '${mem.base}' in a 16-bit address`);
      index = base;
      base = null;
    }

    const entry = ADDRESS16.find((row) => row[1] === (base ?? -1) && row[2] === (index ?? -1));
    if (entry === undefined) {
      this.fail(`'${describeAddress(mem)}' is not one of the eight encodable 16-bit addresses (bx, bx+si, bx+di, bp, bp+si, bp+di, si, di)`);
    }
    const rmField = entry![0];

    // Field 6 is overloaded, and the two uses are told apart by `mod`. With
    // mod=00 the SDM does *not* mean `[bp]` - it means a bare disp16. So `[bp]`
    // is the form that needs a displacement forced in, and it takes the smallest
    // one that fits; the bare form keeps mod=00 and always writes 16 bits.
    const isBareDisp = base === null && index === null;
    const needsForcedDisp = rmField === 6 && !isBareDisp;

    let mod: number;
    let dispBytes: readonly number[];
    if (isBareDisp) {
      mod = 0;
      dispBytes = bytesOf(disp, 2);
    } else if (disp === 0n && !needsForcedDisp) {
      mod = 0;
      dispBytes = [];
    } else if (fitsIn(disp, 1)) {
      mod = 1;
      dispBytes = bytesOf(disp, 1);
    } else {
      mod = 2;
      dispBytes = bytesOf(disp, 2);
    }

    return { mod, rm: rmField, sib: null, disp: dispBytes, x: 0, b: 0 };
  }

  private address16Register(name: string): number {
    const value = ADDRESS16_REGISTERS[name];
    if (value === undefined) {
      this.fail(`'${name}' cannot be used in a 16-bit address; the encodable registers are bx, bp, si and di`);
    }
    return value;
  }

  /** Choose between 16-bit and 32/64-bit addressing for a memory operand. */
  private memoryForm(mem: MemoryRef): RmForm {
    const baseIs16 = mem.base !== null && mem.base in ADDRESS16_REGISTERS;
    const indexIs16 = mem.index !== null && mem.index in ADDRESS16_REGISTERS;

    if (baseIs16 || indexIs16) {
      if (this.ctx.mode !== CpuMode.REAL16) {
        const which = baseIs16 ? mem.base : mem.index;
        this.fail(`'${which}' needs 16-bit addressing, which only exists in real mode; use a 32- or 64-bit register here`);
      }
      return this.memoryForm16(mem);
    }

    // A 32-bit register name in real mode asks for 32-bit addressing, which needs the
    // 0x67 address-size prefix. This encoder does not emit it, so say so rather than
    // quietly using the 16-bit register of the same number.
    if (this.ctx.mode === CpuMode.REAL16 && !mem.ripRelative) {
      const which = baseIs32Or64(mem.base) ? mem.base : mem.index;
      if (which !== null && which !== undefined) {
        this.fail(`'${which}' is a 32-bit address register, and reaching 32-bit addressing in real mode needs a 0x67 address-size prefix; write 'bx', 'bp', 'si' or 'di' instead`);
      }
      return this.memoryForm16(mem);
    }

    if (this.ctx.mode === CpuMode.REAL16 && !mem.ripRelative) {
      return this.memoryForm16(mem);
    }

    return this.memoryForm32(mem);
  }

  /* ------------------------------------------------------------------ */
  /* Branches                                                           */
  /* ------------------------------------------------------------------ */

  /** The displacement width for a near branch in this mode. */
  private nearWidth(): 16 | 32 {
    return this.ctx.mode === CpuMode.REAL16 ? 16 : 32;
  }

  /**
   * Emit a relative branch at the width the assembler settled on.
   *
   * A fixup stands in for the displacement because it is measured from the end of
   * the instruction. A single displacement byte is requested simply by asking for
   * width 8; the near form is the opcode plus a two- or four-byte placeholder.
   */
  private emitBranch(target: bigint, shortOpcode: number | null, nearOpcode: readonly number[]): void {
    const width = this.ctx.branchWidth;
    if (width === null) this.fail('the assembler did not assign a branch width');
    this.branchWidth = width;

    if (width === 8) {
      if (shortOpcode === null) this.fail('this branch has no short form');
      this.setOpcode(shortOpcode);
      this.recordFixup(this.frame.appendDisp(bytesOf(0n, 1)), 1, target, false);
      return;
    }

    const near = this.nearWidth();
    this.setOpcode(...nearOpcode);
    const bytes = near === 16 ? 2 : 4;
    this.recordFixup(this.frame.appendDisp(bytesOf(0n, bytes)), bytes, target, false);
  }

  private recordFixup(offset: number, width: 1 | 2 | 4, target: bigint, ripRelative: boolean): void {
    if (this.fixups.length > 0) {
      // An instruction has at most one displacement: one memory operand or one
      // branch target. Anything else means the frame is being filled in wrongly.
      this.fail('internal error: more than one displacement in one instruction');
    }
    this.fixups.push({ offset, width, target, ripRelative });
  }

  private branchTarget(): bigint {
    this.expectCount(1);
    const operand = this.operand(0);
    if (operand.kind !== 'immediate') this.fail('needs a target');
    return this.evaluate(operand.value);
  }

  private encodeJcc(condition: number): EncodeResult {
    const target = this.branchTarget();
    this.emitBranch(target, 0x70 + condition, [0x0f, 0x80 + condition]);
    return this.result();
  }

  /**
   * A far jump or call: EA (JMP) or 9A (CALL), then `offset:segment` immediates.
   *
   * The offset is written first and is the wider of the two, which is the opposite
   * of the order they are written in the source. In 64-bit mode the offset is still
   * only 32 bits: the SDM is explicit that REX.W does not widen a far pointer,
   * because there is no 16:64 form to widen it into.
   */
  private encodeFarTransfer(operand: Operand, opcode: 0xea | 0x9a): EncodeResult {
    if (operand.kind !== 'far') this.fail('expected a segment:offset operand');

    const offset = this.evaluate(operand.offset);
    const segment = this.evaluate(operand.segment);
    if (!fitsIn(segment, 2)) this.fail(`a segment selector must be 16 bits, found ${segment}`);
    if (segment < 0n) this.fail(`a segment selector cannot be negative, found ${segment}`);

    // The offset width follows the *operand size*, not the address size, and in long
    // mode it is 32 regardless - so 0x66 selects a 16-bit offset there and does not
    // select a 64-bit one.
    const width: 16 | 32 =
      this.ctx.mode === CpuMode.LONG64 ? 32 : this.ctx.mode === CpuMode.REAL16 ? 16 : 32;
    if (!fitsIn(offset, width)) {
      this.fail(`the offset of a far transfer is ${width} bits in this mode; ${offset} does not fit`);
    }

    // No 0x66 here. The prefix would be needed only to *narrow* the offset from the
    // mode's default, and there is nothing to narrow from: the width above is already
    // the mode's default, so emitting the prefix would select a 32-bit offset in
    // 16-bit real mode and read two bytes of whatever follows as a segment selector.
    this.setOpcode(opcode);
    this.frame.imm.push(...bytesOf(offset, width === 16 ? 2 : 4));
    this.frame.imm.push(...bytesOf(segment, 2));
    return this.result();
  }

  private encodeJmp(): EncodeResult {
    const operand = this.operand(0);
    if (operand.kind === 'immediate') {
      this.expectCount(1);
      this.emitBranch(this.evaluate(operand.value), 0xeb, [0xe9]);
      return this.result();
    }

    this.expectCount(1);

    // `jmp 0x7c00:start` is the first instruction of every real-mode boot sector:
    // the CPU's fetch unit is still reading the sector linearly when the first
    // bytes execute, so control has to be moved to the far end of it before
    // anything else can run. It is a fixed-pointer form, EA, not a relative branch.
    if (operand.kind === 'far') return this.encodeFarTransfer(operand, 0xea);

    if (operand.kind === 'register') {
      const size = operand.reg.size;
      if (size === 8) this.fail('does not take an 8-bit register');
      if (size === 16) this.fail('does not take a 16-bit register; an indirect jump must match the code segment width');
      // As with PUSH, an indirect JMP defaults to a 64-bit operand in long mode, so
      // REX.W is redundant. REX.B is not: it is how r8-r15 are named.
      void size;
      this.setRex(false, 0, 0, operand.reg.index, operand.reg.needsRex);
      this.setOpcode(0xff);
      this.setModrm(3, 4, operand.reg.index & 7);
      return this.result();
    }

    if (operand.kind !== 'memory') this.fail('invalid operand');
    const size = this.stackOperandSize();
    this.sizeOverridePrefix(size);
    this.setRm(this.rm(operand, false), 4);
    this.setOpcode(0xff);
    return this.result();
  }

  private encodeCall(): EncodeResult {
    this.expectCount(1);
    const operand = this.operand(0);

    if (operand.kind === 'far') return this.encodeFarTransfer(operand, 0x9a);

    if (operand.kind === 'immediate') {
      // CALL rel has no short form, so the width is the near width throughout.
      const near = this.nearWidth();
      this.branchWidth = near === 16 ? 16 : 32;
      this.setOpcode(0xe8);
      const bytes = near === 16 ? 2 : 4;
      this.recordFixup(this.frame.appendDisp(bytesOf(0n, bytes)), bytes, this.evaluate(operand.value), false);
      return this.result();
    }

    if (operand.kind === 'register') {
      if (operand.reg.size === 8) this.fail('does not take an 8-bit register');
      // An indirect CALL is 64 bits wide by default in long mode, so REX.W would be
      // redundant here too. See the note in `encodeJmp`.
      this.setRex(false, 0, 0, operand.reg.index, operand.reg.needsRex);
      this.setOpcode(0xff);
      this.setModrm(3, 2, operand.reg.index & 7);
      return this.result();
    }

    const size = this.stackOperandSize();
    this.sizeOverridePrefix(size);
    this.setRm(this.rm(operand, false), 2);
    this.setOpcode(0xff);
    return this.result();
  }

  private encodeLoop(mnemonic: string): EncodeResult {
    this.expectCount(1);
    const operand = this.operand(0);
    if (operand.kind !== 'immediate') this.fail('needs a target');
    // LOOP and its relatives have only an 8-bit displacement: one opcode, two bytes,
    // no near form. `branchWidens = false` is what tells the relaxation loop that
    // an out-of-range target is an error to report rather than something to grow -
    // otherwise it would emit a four-byte displacement after a two-byte opcode and
    // the CPU would decode the extra bytes as the next instruction.
    this.branchWidth = 8;
    this.branchWidens = false;
    const opcode = mnemonic === 'loop' ? 0xe2 : mnemonic === 'loope' ? 0xe1 : 0xe0;
    this.setOpcode(opcode);
    this.recordFixup(this.frame.appendDisp(bytesOf(0n, 1)), 1, this.evaluate(operand.value), false);
    return this.result();
  }

  private encodeRet(): EncodeResult {
    if (this.stmt.operands.length === 0) {
      this.setOpcode(0xc3);
      return this.result();
    }
    this.expectCount(1);
    const operand = this.operand(0);
    if (operand.kind !== 'immediate') this.fail('the operand must be an immediate');
    this.setOpcode(0xc2);
    // C2 iw: the count is added to RSP as-is. Unsigned.
    this.setImmUnsigned(this.evaluate(operand.value), 2);
    return this.result();
  }

  /**
   * RETF, the far return.
   *
   * Structurally identical to RET - an optional unsigned 16-bit frame count followed by
   * a pop of the return segment and the return offset - but the pop is two values wide
   * and the offset's width is chosen by REX.W rather than the 0x66 prefix. That last
   * part is why `retfq` is a separate mnemonic here: REX.W is the only thing that
   * distinguishes them, and the alternative, deriving it from the mode, would be wrong
   * in both directions - long mode's RETF defaults to a 16-bit pop.
   */
  private encodeRetf(wide: boolean): EncodeResult {
    // Only W matters here: the instruction has no ModRM byte, so there is no register for
    // R, X or B to extend, and passing zeros is the only way to say so.
    if (wide) this.setRex(true, 0, 0, 0);
    if (this.stmt.operands.length === 0) {
      this.setOpcode(0xcb);
      return this.result();
    }
    this.expectCount(1);
    const operand = this.operand(0);
    if (operand.kind !== 'immediate') this.fail('the operand must be an immediate');
    this.setOpcode(0xca);
    // Same signedness as RET's: added to RSP after the far pop, never sign-tested.
    this.setImmUnsigned(this.evaluate(operand.value), 2);
    return this.result();
  }

  private encodeSetcc(condition: number): EncodeResult {
    this.checkByteRegisters();
    this.expectCount(1);
    const operand = this.operand(0);
    if (operand.kind === 'immediate') this.fail('needs a register or memory operand');
    const form = this.rm(operand, true);
    this.setRex(false, 0, form.x, form.b, operand.kind === 'register' && operand.reg.needsRex);
    this.setOpcode(0x0f, 0x90 + condition);
    this.setRm(form, 0);
    return this.result();
  }

  private encodeCmov(condition: number): EncodeResult {
    this.expectCount(2);
    const dest = this.operand(0);
    const src = this.operand(1);
    if (dest.kind !== 'register') this.fail('the destination must be a register');
    if (dest.reg.size === 8) this.fail('is not defined for 8-bit operands');
    if (src.kind !== 'register' && src.kind !== 'memory') this.fail('the source must be a register or memory');
    const size = this.operandSize();
    if (src.kind === 'register' && src.reg.size !== size) this.fail('both operands must be the same size');

    const form = this.rm(src, false);
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, dest.reg.index, form.x, form.b, dest.reg.needsRex);
    this.setOpcode(0x0f, 0x40 + condition);
    this.setRm(form, dest.reg.index);
    return this.result();
  }

  /* ------------------------------------------------------------------ */
  /* Arithmetic and logic                                               */
  /* ------------------------------------------------------------------ */

  private encodeAlu(): EncodeResult {
    this.checkByteRegisters();
    const op = ALU_OPS[this.stmt.mnemonic]!;
    this.expectCount(2);
    const dest = this.operand(0);
    const src = this.operand(1);

    if (dest.kind === 'control' || src.kind === 'control') {
      this.fail('the control registers are only accessible with MOV');
    }

    const size = this.operandSize();
    const byteForm = size === 8;
    const form = this.rm(dest, byteForm);

    // r/m, imm
    if (src.kind === 'immediate') {
      const value = this.evaluate(src.value);

      // The accumulator forms `0x04+op*8` and `0x05+op*8` encode an operation on
      // AL or eAX with an immediate and no ModRM byte at all. They are what every
      // hand-written assembler emits for `add rax, ...`, and they are shorter than
      // the general 0x80/0x81/0x83 forms. Two rules decide whether to use them:
      // the destination must really be the accumulator, and - because the byte
      // form takes an imm8 while the wide form takes a full imm16/32 - they only
      // save bytes when the immediate does *not* fit in a sign-extended byte.
      if (dest.kind === 'register' && dest.reg.index === 0 && !dest.reg.needsRex) {
        if (byteForm && !byteNeedRex(dest)) {
          this.setOpcode(0x04 + (op << 3));
          // 04+op*8 ib is a plain bit pattern, so `add al, 0xff` is `04 ff`.
          this.setImmUnsigned(value, 1);
          return this.result();
        }
        if (!byteForm && !fitsIn(value, 1)) {
          this.sizeOverridePrefix(size);
          this.setRex(size === 64, 0, 0, 0, false);
          this.setOpcode(0x05 + (op << 3));
          // The wide accumulator form is imm16 or imm32, never imm64 - at 64 bits it
          // is a sign-extended imm32, so `add rax, 0xffffffff` and `add rax, -1` are
          // the same instruction and both must assemble.
          this.setImmUnsigned(value, size === 16 ? 2 : 4);
          return this.result();
        }
      }

      this.sizeOverridePrefix(size);
      if (byteForm) {
        this.setRex(false, op, form.x, form.b, byteNeedRex(dest));
        this.setOpcode(0x80);
        this.setRm(form, op);
        // 80 /n ib is unsigned, and this is the *only* 8-bit immediate form of the
        // group: there is no byte version of 0x83, whose imm8 sign-extends and so
        // cannot reach 0x80..0xff. `xor byte [rbx], 0xff` is an ordinary instruction.
        this.setImmUnsigned(value, 1);
        return this.result();
      }
      this.setRex(size === 64, op, 0, form.b, byteNeedRex(dest));
      // 0x83 is the sign-extended imm8 form and is two bytes shorter.
      if (fitsIn(value, 1)) {
        this.setOpcode(0x83);
        this.setRm(form, op);
        this.setImm(value, 1);
        return this.result();
      }
      this.setOpcode(0x81);
      this.setRm(form, op);
      this.setImmUnsigned(value, size === 16 ? 2 : 4);
      return this.result();
    }

    // A memory source with a register destination is the other direction, 0x02 r8<-r/m8
    // and 0x03 r<-r/m. Note that both widths have both directions - 0x02 is *not* the
    // byte-only `r8<-r/m8` form that its absence from 0x01/0x03's symmetry suggests -
    // so `add al, byte [rbx]` is 0x02 /r with the register in the reg field and the
    // memory operand in r/m. Taking the r/m field from the *destination* instead, as
    // the 0x00/0x01 path must, encodes an add into the register whose field number
    // matches the address, which assembles, decodes, and reads a different address.
    if (dest.kind === 'register' && src.kind === 'memory') {
      const source = this.rm(src, byteForm);
      if (byteForm) {
        const reg = this.byteRegister(this.requireByteRegister(dest));
        this.setRex(false, reg.field, source.x, source.b, reg.needRex);
        this.setOpcode(0x02 + (op << 3));
        this.setRm(source, reg.field);
        return this.result();
      }
      this.sizeOverridePrefix(size);
      this.setRex(size === 64, dest.reg.index, source.x, source.b, dest.reg.needsRex);
      this.setOpcode(0x03 + (op << 3));
      this.setRm(source, dest.reg.index);
      return this.result();
    }

    if (dest.kind === 'memory' && src.kind === 'memory') {
      // There is no memory-to-memory ALU form, and saying so here is better than a
      // ModRM byte built from two inconsistent operands.
      this.fail('both operands are memory; there is no memory-to-memory form, so move one of them into a register first');
    }

    // r/m, r. The destination is the r/m field and the source the reg field, whatever
    // order the source text used - which is also why `add al, bl` and `add bl, al`
    // produce different bytes: 0x00 does not exist in a `reg <- r/m` direction, so the
    // operand written second cannot be the destination.
    if (byteForm) {
      const reg = this.byteRegister(this.requireByteRegister(src));
      this.setRex(false, reg.field, form.x, form.b, byteNeedRex(dest) || reg.needRex);
      this.setOpcode(0x00 + (op << 3));
      this.setRm(form, reg.field);
      return this.result();
    }

    // r/m, r for 16, 32 and 64 bits. The base is 0x01 and not 0x02: the four ALU
    // families are 0x00 r/m8<-r8, 0x01 r/m<-r, 0x02 r8<-r/m8 and 0x03 r<-r/m, and
    // reaching for 0x02 here would emit a *byte* opcode under a REX.W that widens it,
    // producing an instruction that decodes as something else entirely.
    if (src.kind !== 'register') this.fail('the source must be a register');
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, src.reg.index, 0, form.b, src.reg.needsRex);
    this.setOpcode(0x01 + (op << 3));
    this.setRm(form, src.reg.index);
    return this.result();
  }

  private encodeGroup3(): EncodeResult {
    this.checkByteRegisters();
    const op = GROUP3_OPS[this.stmt.mnemonic]!;
    const isTest = this.stmt.mnemonic === 'test';
    if (!isTest) this.expectCount(1);

    const dest = this.operand(0);
    if (dest.kind === 'control') this.fail('the control registers are only accessible with MOV');

    // Checked here rather than left to `rm`, because for the other seven operations
    // either operand order is encodable and `rm`'s generic message is the right one.
    // TEST has only 84/85 and F6/F7 /0 - all of which write into r/m - so an immediate
    // or a `reg <- r/m` order is not a missing encoding, it is a direction the
    // instruction does not have. Saying that is the difference between a reader who
    // knows what to do and one left guessing which operand was meant.
    if (isTest && dest.kind === 'immediate') {
      this.fail(
        "TEST has only the 'r/m, r' direction, so an immediate has to be second: write 'test r/m, value'",
      );
    }

    const size = this.operandSize();
    const byteForm = size === 8;
    const form = this.rm(dest, byteForm);

    if (isTest) {
      this.expectCount(2);
      const src = this.operand(1);
      if (src.kind === 'control') this.fail('the control registers are only accessible with MOV');
      if (byteForm) {
        if (src.kind === 'immediate') {
          this.setRex(false, 0, form.x, form.b, byteNeedRex(dest));
          this.setOpcode(0xf6);
          this.setRm(form, 0);
          // F6 /0 ib is unsigned, like every other 8-bit immediate in the map.
          this.setImmUnsigned(this.evaluate(src.value), 1);
          return this.result();
        }
        const reg = this.byteRegister(this.requireByteRegister(src));
        this.setRex(false, reg.field, form.x, form.b, byteNeedRex(dest) || reg.needRex);
        this.setOpcode(0x84);
        this.setRm(form, reg.field);
        return this.result();
      }

      this.sizeOverridePrefix(size);
      if (src.kind === 'immediate') {
        this.setRex(size === 64, 0, 0, form.b, byteNeedRex(dest));
        this.setOpcode(0xf7);
        this.setRm(form, 0);
        const value = this.evaluate(src.value);
        // F7 /0 id is imm16 or imm32; at 64 bits it is a sign-extended imm32.
        this.setImmUnsigned(value, size === 16 ? 2 : 4);
        return this.result();
      }
      // TEST has no `reg <- r/m` form: 0x84/0x85 take a register or nothing at all, and
      // F6 /0 and F7 /0 take only an immediate. So `test rax, [rbx]` asks for an
      // opcode that does not exist, while `test [rbx], rax` is the memory-destination
      // form and is perfectly ordinary.
      if (src.kind !== 'register') this.fail('the second operand must be a register or an immediate');
      this.setRex(size === 64, src.reg.index, 0, form.b, src.reg.needsRex);
      this.setOpcode(0x85);
      this.setRm(form, src.reg.index);
      return this.result();
    }

    if (size === 8) {
      this.setRex(false, op, form.x, form.b, byteNeedRex(dest));
      this.setOpcode(0xf6);
      this.setRm(form, op);
      return this.result();
    }
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, op, 0, form.b, byteNeedRex(dest));
    this.setOpcode(0xf7);
    this.setRm(form, op);
    return this.result();
  }

  private encodeShift(): EncodeResult {
    this.checkByteRegisters();
    const op = SHIFT_OPS[this.stmt.mnemonic]!;
    this.expectCount(2);
    const dest = this.operand(0);
    const count = this.operand(1);

    const size = this.operandSize();
    const byteForm = size === 8;
    const form = this.rm(dest, byteForm);

    if (count.kind === 'register') {
      if (count.reg.index !== 1 || count.reg.size !== 8) this.fail('the shift count must be CL');
      const cl = this.byteRegister(count.reg);
      // D2/D3 carry no width either, exactly like FE/FF: 16 bits is the size override
      // and 64 is REX.W. Without them `sar rax, cl` shifts a 32-bit register, which
      // discards the top half of the value and is indistinguishable from the correct
      // encoding in the bytes alone.
      this.sizeOverridePrefix(size);
      this.setRex(size === 64, op, form.x, form.b, byteNeedRex(dest) || cl.needRex);
      this.setOpcode(byteForm ? 0xd2 : 0xd3);
      this.setRm(form, op);
      return this.result();
    }

    if (count.kind !== 'immediate') this.fail('the count must be CL or an immediate');
    const value = this.evaluate(count.value);
    if (value < 0n || value > 255n) this.fail(`the shift count ${value} is out of range (0 to 255)`);
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, op, form.x, form.b, byteNeedRex(dest));
    this.setOpcode(byteForm ? 0xc0 : 0xc1);
    this.setRm(form, op);
    // The shift count is masked to five bits (or six with 0x66) by the CPU, so the
    // field is an unsigned magnitude: `shl eax, 200` is a real instruction, and
    // rejecting it for exceeding the signed range of a byte is a range check that
    // disagrees with the SDM.
    this.setImmUnsigned(value, 1);
    return this.result();
  }

  private encodeIncDec(op: 0 | 1): EncodeResult {
    this.checkByteRegisters();
    this.expectCount(1);
    const dest = this.operand(0);
    const size = this.operandSize();
    const byteForm = size === 8;
    const form = this.rm(dest, byteForm);
    // REX.W is what distinguishes the 64-bit register from the 32-bit one, and in
    // long mode there is no separate opcode to carry it - `inc rcx` is `48 FF C1` and
    // `inc ecx` is `FF C1`. Leaving W clear for a 64-bit operand produces a valid
    // instruction for the wrong register, which is why this cannot fall out of the
    // general "default to the mode" rule the other single-operand forms use.
    // 16-bit is the size override, and it is the one width the opcode cannot express -
    // FE is the byte form and FF is everything else, so `inc cx` in protected mode
    // needs a 0x66 in front or it increments ECX.
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, op, 0, form.b, byteNeedRex(dest));
    this.setOpcode(byteForm ? 0xfe : 0xff);
    this.setRm(form, op);
    return this.result();
  }

  private encodeImul(): EncodeResult {
    this.checkByteRegisters();
    const count = this.stmt.operands.length;
    if (count < 1 || count > 3) this.fail(`takes 1, 2 or 3 operands, found ${count}`);

    // One operand is the F7 /5 form: EDX:EAX (or DX:AX) times the r/m operand, with
    // no destination named. The SDM marks the byte form F6 /5 undefined, so there is
    // nothing to encode for a width of 8 and saying so is more useful than emitting a
    // ModRM the CPU would reject.
    if (count === 1) {
      const only = this.operand(0);
      if (only.kind === 'control') this.fail('the control registers are only accessible with MOV');
      const size = this.operandSize();
      if (size === 8) this.fail('the one-operand form is not defined for 8-bit operands; use the two-operand form');
      const form = this.rm(only, false);
      this.sizeOverridePrefix(size);
      this.setRex(size === 64, 5, form.x, form.b, false);
      this.setOpcode(0xf7);
      this.setRm(form, 5);
      return this.result();
    }

    const dest = this.operand(0);
    const src = this.operand(1);
    if (dest.kind !== 'register') this.fail('the destination must be a register');
    const size = dest.reg.size;
    if (size === 8) this.fail('is not defined for 8-bit operands');

    if (count === 3) {
      const immediate = this.operand(2);
      if (immediate.kind !== 'immediate') this.fail('the third operand must be an immediate');
      const value = this.evaluate(immediate.value);
      const form = this.rm(src, false);
      this.sizeOverridePrefix(size);
      this.setRex(size === 64, dest.reg.index, form.x, form.b, dest.reg.needsRex);
      // 0x6B is the imm8 form, two bytes shorter than 0x69.
      this.setOpcode(fitsIn(value, 1) ? 0x6b : 0x69);
      this.setRm(form, dest.reg.index);
      if (fitsIn(value, 1)) this.setImm(value, 1);
      else if (size === 64) this.setImmUnsigned(value, 4);
      else this.setImmUnsigned(value, size === 16 ? 2 : 4);
      return this.result();
    }

    if (size === 16) this.fail('the two-operand form does not support 16-bit operands; use the three-operand form');

    if (src.kind === 'memory') {
      const form = this.memoryForm(src.mem);
      this.setRex(size === 64, dest.reg.index, form.x, form.b, dest.reg.needsRex);
      this.setOpcode(0x0f, 0xaf);
      this.setRm(form, dest.reg.index);
      return this.result();
    }

    if (src.kind !== 'register') this.fail('the source must be a register or memory');
    if (src.reg.size !== size) this.fail('both operands must be the same size');
    this.setRex(size === 64, dest.reg.index, 0, src.reg.index, dest.reg.needsRex || src.reg.needsRex);
    this.setOpcode(0x0f, 0xaf);
    this.setModrm(3, dest.reg.index, src.reg.index);
    return this.result();
  }

  /* ------------------------------------------------------------------ */
  /* Moves                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * MOV, in all four operand shapes.
   *
   * The direction matters because x86 numbers these from the hardware's point of
   * view, not the assembler's: `0x89` reads "move r/m to r" and `0x8B` reads "move
   * r to r/m". So `mov rax, [rbx]` is 0x8B, `mov [rbx], rax` is 0x89, and
   * `mov rax, rbx` is 0x89 with the operands on the opposite sides from the source
   * text. Getting this backwards produces code that runs and does the wrong thing.
   */
  private encodeMov(): EncodeResult {
    this.checkByteRegisters();
    this.expectCount(2);
    const dest = this.operand(0);
    const src = this.operand(1);

    if (dest.kind === 'control' || src.kind === 'control') {
      return this.encodeMovControl(dest, src);
    }

    if (dest.kind === 'segment' || src.kind === 'segment') {
      return this.encodeMovSegment(dest, src);
    }

    if (src.kind === 'immediate') {
      return this.encodeMovImmediate(dest, this.evaluate(src.value));
    }

    const size = this.operandSize();
    const byteForm = size === 8;

    // mov r/m, r
    if (!byteForm && src.kind === 'register' && (dest.kind === 'memory' || dest.kind === 'register')) {
      const form = this.rm(dest, false);
      this.sizeOverridePrefix(size);
      this.setRex(size === 64, src.reg.index, form.x, form.b, src.reg.needsRex);
      this.setOpcode(0x89);
      this.setRm(form, src.reg.index);
      return this.result();
    }

    // The 8-bit forms number their operands from the hardware's point of view, and
    // the two are not interchangeable: 0x88 is `mov r/m8, r8`, so the register is
    // the *source*, while 0x8A is `mov r8, r/m8`, so it is the *destination*.
    // The register always occupies the ModRM reg field and the other operand the
    // r/m field, so the opcode alone decides which way the value moves.
    if (byteForm) {
      const sourceIsRegister = src.kind === 'register';
      const reg = this.byteRegister(this.requireByteRegister(sourceIsRegister ? src : dest));
      const other = sourceIsRegister ? dest : src;
      if (other.kind === 'register') {
        // Register to register: both 0x88 and 0x8A accept it, so only the field
        // assignment carries the direction. Deciding from the destination would
        // swap the two - `mov cl, al` becoming `mov al, cl` - with nothing in the
        // bytes to say so.
        const destReg = this.byteRegister(other.reg);
        this.setRex(false, reg.field, 0, 0, reg.needRex || destReg.needRex);
        this.setOpcode(0x88);
        this.setModrm(3, reg.field, destReg.field);
        return this.result();
      }
      if (other.kind !== 'memory') this.fail('invalid operand');
      const form = this.rm(other, true);
      // The opcode carries the direction, and it is decided by which operand is the
      // memory one - not by width, and not by the destination. A memory *destination*
      // means the value moves into memory, which is 0x88 (`mov r/m8, r8`); a memory
      // *source* is 0x8A (`mov r8, r/m8`). Emitting 0x8A unconditionally turns
      // `mov [rbx], al` into `mov al, [rbx]`: a load where a store was written, which
      // assembles, decodes, and runs without a word of complaint.
      this.setRex(false, reg.field, form.x, form.b, reg.needRex);
      this.setOpcode(sourceIsRegister ? 0x88 : 0x8a);
      this.setRm(form, reg.field);
      return this.result();
    }

    // mov r, r/m
    const form = this.rm(src, false);
    if (dest.kind !== 'register') this.fail('the destination must be a register');
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, dest.reg.index, form.x, form.b, dest.reg.needsRex);
    this.setOpcode(0x8b);
    this.setRm(form, dest.reg.index);
    return this.result();
  }

  /**
   * `mov r/m, imm`.
   *
   * For a register destination the short `B8+r` form is available at 16 and 32
   * bits and is always preferred. It cannot hold a 64-bit immediate, so a 64-bit
   * destination uses `REX.W C7 /0 id`, and a value outside the signed 32-bit range
   * has no encoding whatsoever - reported, not truncated, because truncating turns
   * a typo into a wrong address.
   */
  private encodeMovImmediate(dest: Operand, value: bigint): EncodeResult {
    const size = this.operandSize();

    if (size === 8) {
      if (dest.kind === 'register') {
        const ref = this.byteRegister(dest.reg);
        this.setRex(false, 0, 0, ref.field, ref.needRex);
        this.setOpcode(0xb0 + (ref.field & 7));
        // B0+r ib is unsigned.
        this.setImmUnsigned(value, 1);
        return this.result();
      }
      if (dest.kind !== 'memory') this.fail('invalid destination');
      const form = this.rm(dest, false);
      this.setRex(false, 0, form.x, form.b, false);
      this.setOpcode(0xc6);
      this.setRm(form, 0);
      // C6 /0 ib is unsigned, so `mov byte [rbx], 0xff` is two bytes, not four.
      this.setImmUnsigned(value, 1);
      return this.result();
    }

    if (dest.kind === 'register') {
      const reg = dest.reg;
      if (size === 64) {
        if (!fitsIn(value, 4)) {
          this.fail(`a 64-bit destination cannot be loaded with ${value}: x86-64 has no 64-bit immediate form. Build the value with a shift or an add`);
        }
        this.setRex(true, 0, 0, reg.index, reg.needsRex);
        this.setOpcode(0xc7);
        this.setModrm(3, 0, reg.index & 7);
        this.setImm(value, 4);
        return this.result();
      }
      this.sizeOverridePrefix(size);
      this.setRex(false, 0, 0, reg.index, reg.needsRex);
      this.setOpcode(0xb8 + (reg.index & 7));
      this.setImm(value, size === 16 ? 2 : 4);
      return this.result();
    }

    if (dest.kind !== 'memory') this.fail('invalid destination');
    const form = this.rm(dest, false);
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, 0, form.x, form.b, false);
    this.setOpcode(0xc7);
    this.setRm(form, 0);
    // C7 /0 id: imm16 or imm32, sign-extended at 64 bits. There is no imm64 form of
    // MOV at all, which is why a full 64-bit constant has to come from memory.
    this.setImmUnsigned(value, size === 16 ? 2 : 4);
    return this.result();
  }

  /**
   * MOV to and from a control register.
   *
   * These have exactly one shape each - `0F 22 /r` writes, `0F 20 /r` reads -
   * with the control register number in the ModRM reg field and the general
   * register in r/m. There is no memory form and no immediate form, and unlike the
   * general MOV the operand order is not reversed, because the architecture defines
   * these encodings to take the control register on the reg side.
   */
  private encodeMovControl(dest: Operand, src: Operand): EncodeResult {
    if (dest.kind === 'control') {
      if (src.kind !== 'register') this.fail('a control register can only be loaded from a general register');
      this.setOpcode(0x0f, 0x22);
      this.setModrm(3, dest.index & 7, src.reg.index & 7);
      return this.result();
    }
    if (dest.kind !== 'register') this.fail('a control register can only be stored to a general register');
    if (src.kind !== 'control') this.fail('invalid control register operand');
    this.setOpcode(0x0f, 0x20);
    this.setModrm(3, src.index & 7, dest.reg.index & 7);
    return this.result();
  }

  /**
   * MOV to and from a segment register: 0x8E /r loads, 0x8C /r stores.
   *
   * The segment number goes in the ModRM *reg* field, which is the same slot a
   * control register uses and for the same reason - it identifies the thing being
   * moved rather than being moved itself. Only the 16-bit form exists outside 64-bit
   * mode, where `mov ds, eax` has no encoding at all: the SDM restricts 0x8E to
   * r/m16 and to FS and GS when REX.W is present.
   */
  private encodeMovSegment(dest: Operand, src: Operand): EncodeResult {
    if (dest.kind === 'segment') {
      if (src.kind !== 'register') this.fail('a segment register can only be loaded from a 16-bit register');
      if (src.reg.size !== 16 && !(src.reg.size === 64 && (dest.seg === 4 || dest.seg === 5))) {
        this.fail(
          `a segment register takes 16 bits, and '${src.reg.name}' is ${src.reg.size}; ` +
            'in 64-bit mode REX.W is only defined for FS and GS',
        );
      }
      this.sizeOverridePrefix(src.reg.size);
      this.setRex(src.reg.size === 64, dest.seg, 0, src.reg.index, src.reg.needsRex);
      this.setOpcode(0x8e);
      this.setModrm(3, dest.seg, src.reg.index & 7);
      return this.result();
    }

    if (dest.kind !== 'register') this.fail('a segment register can only be stored to a register');
    if (src.kind !== 'segment') this.fail('invalid segment register operand');
    if (dest.reg.size !== 16 && !(dest.reg.size === 64 && (src.seg === 4 || src.seg === 5))) {
      this.fail(
        `a segment register is 16 bits wide, so storing it into '${dest.reg.name}' ` +
          `(${dest.reg.size} bits) would need a 64-bit form that does not exist; ` +
          'in 64-bit mode REX.W is only defined for FS and GS',
      );
    }
    this.sizeOverridePrefix(dest.reg.size);
    this.setRex(dest.reg.size === 64, src.seg, 0, dest.reg.index, dest.reg.needsRex);
    this.setOpcode(0x8c);
    this.setModrm(3, src.seg, dest.reg.index & 7);
    return this.result();
  }

  /**
   * MOVZX and MOVSX.
   *
   * Two details are easy to get wrong. The destination width comes from the
   * destination register - REX.W for 64-bit, 0x66 for 16-bit, neither otherwise -
   * while the *source* width comes from the opcode, 0xB6 for a byte and 0xB7 for a
   * word, and not from the operand-size prefix. And a memory source has to state
   * its width, because `movzx eax, [rbx]` does not say whether the source was a
   * byte or a word.
   */
  private encodeMovExtend(): EncodeResult {
    this.checkByteRegisters();
    this.expectCount(2);
    const dest = this.operand(0);
    const src = this.operand(1);

    if (dest.kind !== 'register') this.fail('the destination must be a register');
    if (dest.reg.size === 8) this.fail('the destination must be at least 16 bits');

    // The opcode is chosen from the source width - 0F B6 for a byte, 0F B7 for a
    // word - so it has to be decided before anything else. Real mode is the one
    // place it can be inferred, because everything there is 16 bits by default.
    let sourceSize: 8 | 16;
    let form: RmForm;
    if (src.kind === 'memory' && src.size === null && this.stmt.sizeOverride === null && this.ctx.mode === CpuMode.REAL16) {
      sourceSize = 16;
      form = this.memoryForm(src.mem);
    } else {
      sourceSize = this.sourceWidth(src);
      form = src.kind === 'memory' ? this.memoryForm(src.mem) : this.rm(src, false);
    }

    if (dest.reg.size <= sourceSize) {
      this.fail(
        `movzx and movsx widen; '${dest.reg.name}' is ${dest.reg.size} bits and the source is ${sourceSize}`,
      );
    }

    // Through `sizeOverridePrefix` rather than a bare push, because real mode is already
    // 16 bits wide by default: a 0x66 there would ask for a 32-bit destination, which
    // is not what `movzx ax, bl` says.
    this.sizeOverridePrefix(dest.reg.size);
    this.setRex(dest.reg.size === 64, dest.reg.index, form.x, form.b, dest.reg.needsRex);
    // 0F B6 /r is the byte source and 0F B7 /r the word source. Both need the
    // two-byte 0F opcode escape - a bare B6 is MOV r8, imm8 instead.
    //
    // MOVSX is the same pair with bit 3 set, so the opcode is 0xB6 for a byte
    // source plus 8 when sign-extending plus 1 for a word source. Getting that
    // wrong does not fail loudly: MOVSX simply assembles as MOVZX and every
    // value comes out zero-filled instead of sign-filled.
    const wordSource = sourceSize === 16 ? 1 : 0;
    const signExtend = this.stmt.mnemonic === 'movsx' ? 8 : 0;
    this.setOpcode(0x0f, 0xb6 | signExtend | wordSource);
    this.setRm(form, dest.reg.index);
    return this.result();
  }

  private encodeLea(): EncodeResult {
    this.expectCount(2);
    const dest = this.operand(0);
    const src = this.operand(1);
    if (dest.kind !== 'register') this.fail('the destination must be a register');
    if (src.kind !== 'memory') this.fail('the source must be a memory operand');
    const size = dest.reg.size;
    if (size === 8) this.fail('does not support 8-bit operands');
    if (size === 16) this.fail('does not support 16-bit operands; use a 32-bit register');
    const form = this.memoryForm(src.mem);
    this.setRex(size === 64, dest.reg.index, form.x, form.b, dest.reg.needsRex);
    this.setOpcode(0x8d);
    this.setRm(form, dest.reg.index);
    return this.result();
  }

  private encodeXchgFamily(mnemonic: string): EncodeResult {
    this.checkByteRegisters();
    this.expectCount(2);
    const dest = this.operand(0);
    const src = this.operand(1);
    const size = this.operandSize();
    const byteForm = size === 8;

    // XCHG alone, and only for two registers, has a one-byte form. XADD and CMPXCHG do
    // not: `0F 90` is SETO, so routing them through the short form would emit a byte
    // that tests a condition rather than swapping anything.
    if (mnemonic === 'xchg' && !byteForm) {
      const short = this.shortXchg(dest, src);
      if (short !== null) {
        for (const prefix of short.prefixes) this.frame.prefixes.push(prefix);
        // REX.B carries the extended half of the register in the opcode's low three
        // bits, and REX.W sets the width - which is what makes `48 93` `xchg rax, rbx`.
        // REX.W is the *only* reason the short form exists at 64 bits.
        //
        // `setRex` takes whole register indices and extracts bit 3 itself, so this
        // passes the index unshifted. Pre-shifting here is the quieter of the two
        // mistakes available: `rex` masks with `>> 3` again, an index of 8 becomes 0,
        // and `xchg rax, r8` assembles to `48 90` - `xchg rax, rax`, a self-swap that
        // is a valid instruction and so reports no problem at all.
        this.setRex(size === 64, 0, 0, short.register, false);
        this.setOpcode(0x90 + (short.register & 7));
        return this.result();
      }
    }
    // XCHG has no byte form at all - 86/87 are the whole instruction - while XADD and
    // CMPXCHG each have two, and the byte opcode is not simply the wide one: XADD is
    // C0 for bytes and C1 for the rest, CMPXCHG is B0 and B1. Choosing the wide opcode
    // for a byte operand emits an instruction the CPU decodes as the wider form.
    if (mnemonic === 'xchg' && byteForm) this.fail('is not defined for 8-bit operands');

    const opcode: readonly number[] =
      mnemonic === 'xadd'
        ? byteForm
          ? [0x0f, 0xc0]
          : [0x0f, 0xc1]
        : mnemonic === 'cmpxchg'
          ? byteForm
            ? [0x0f, 0xb0]
            : [0x0f, 0xb1]
          : [0x87];
    // `0F 87` is JA, a conditional branch. Putting a 0x0F in front of XCHG's ModRM
    // opcode assembles a store-and-jump instead of an exchange: same register names,
    // same operand count, and a completely different effect on the instruction
    // pointer. XADD and CMPXCHG really do need the escape byte; XCHG does not.

    // The ModRM form holds one operand in r/m and one in the reg field, and the two
    // instructions here differ in which operand that is.
    //
    // XADD and CMPXCHG are `r/m, r` and are not symmetric: the destination is always
    // the r/m operand, so `xadd eax, dword [rbx]` has no encoding whatsoever and the
    // memory source has to be refused rather than quietly swapped.
    //
    // XCHG is symmetric, so `xchg [rbx], eax` and `xchg eax, [rbx]` are the same
    // instruction and the only rule left is that the memory operand must reach the
    // r/m field - a memory operand cannot be encoded in the reg field at all. Taking
    // the destination unconditionally puts a register in r/m when the source is
    // memory, and `xchg eax, dword [rbx]` becomes `87 c0`: `xchg eax, eax`, a
    // self-swap that assembles, decodes and runs without complaint.
    let rmSide = dest;
    let regSide = src;
    if (mnemonic === 'xchg' && dest.kind !== 'memory' && src.kind === 'memory') {
      rmSide = src;
      regSide = dest;
    }
    if (rmSide.kind !== 'register' && rmSide.kind !== 'memory') this.fail('invalid destination');
    if (regSide.kind !== 'register') {
      // The other operand has to be a register. For XADD and CMPXCHG this is the
      // "no memory source" case; saying so beats letting the encoder put a memory
      // operand in the reg field, which cannot be expressed.
      this.fail(
        mnemonic === 'xchg'
          ? 'the other operand must be a register'
          : 'the source must be a register: this instruction has no register-destination form',
      );
    }

    const form = this.rm(rmSide, byteForm);
    if (byteForm) {
      const reg = this.byteRegister(this.requireByteRegister(regSide));
      this.setRex(false, reg.field, form.x, form.b, reg.needRex || byteNeedRex(rmSide));
      this.setOpcode(...opcode);
      this.setRm(form, reg.field);
      return this.result();
    }

    const regField = regSide.reg.index;
    this.sizeOverridePrefix(size);
    this.setRex(size === 64, regField, form.x, form.b, regSide.reg.needsRex);
    this.setOpcode(...opcode);
    this.setRm(form, regField);
    return this.result();
  }

  /**
   * The `0x90+r` one-byte XCHG, or null when it cannot be used.
   *
   * It exists at every operand width including 64-bit, where `48 93` is `xchg rax, rbx`
   * - REX.W widens the operand and REX.B reaches r8-r15, so the one-byte form is not
   * limited to 32-bit the way the encodings for `mov r32, imm32` are. The ModRM reg
   * field holds the *second* operand, which is the opposite side from the source
   * syntax, so the caller must place `register` in the REX.B position rather than in
   * the opcode's low three bits alone.
   */
  private shortXchg(dest: Operand, src: Operand): { prefixes: number[]; register: number } | null {
    if (dest.kind !== 'register' || src.kind !== 'register') return null;
    const size = dest.reg.size;
    if (size !== 16 && size !== 32 && size !== 64) return null;
    if (src.reg.size !== size) return null;
    // `90+rb` only encodes an exchange with the accumulator, so exactly one operand
    // must be AX.
    if (dest.reg.index !== Reg.AX && src.reg.index !== Reg.AX) return null;
    // The *non*-accumulator operand is the one in the opcode's low three bits - and
    // therefore the one in REX.B when it is r8-r15. Taking it from the source
    // unconditionally is why `xchg rbx, rax` has to be handled by direction: with AX
    // as the source, the destination is the encoded register, and picking the source
    // emits `90`, which is NOP. Getting this wrong is silent - NOP is a valid
    // instruction and decodes cleanly as one.
    const other = dest.reg.index === Reg.AX ? src : dest;
    return {
      prefixes: size === 16 && this.ctx.mode !== CpuMode.REAL16 ? [0x66] : [],
      register: other.reg.index,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Stack                                                              */
  /* ------------------------------------------------------------------ */

  /** The stack width implied by the mode. */
  private stackOperandSize(): 16 | 32 | 64 {
    if (this.ctx.mode === CpuMode.REAL16) return 16;
    if (this.ctx.mode === CpuMode.PROTECTED32) return 32;
    return 64;
  }

  private encodePushPop(isPush: boolean): EncodeResult {
    this.expectCount(1);
    const operand = this.operand(0);
    const base = isPush ? 0x50 : 0x58;

    if (operand.kind === 'register') {
      const reg = operand.reg;
      if (reg.size === 8) this.fail('does not take an 8-bit register');
      if (reg.size === 16) {
        if (this.ctx.mode !== CpuMode.LONG64) {
          // The prefix is only needed where 16 is *not* the mode's default operand
          // size, so this asks rather than assumes. Unconditionally emitting 0x66
          // makes real mode's `push ax` - the second instruction of half the BIOS
          // code in the world - assemble to `66 50`, which is `push eax`: the same
          // opcode, twice the width, pushing four bytes onto a stack the caller
          // expects to be two bytes shorter.
          this.sizeOverridePrefix(16);
          this.setOpcode(base + (reg.index & 7));
          return this.result();
        }
        this.fail('in 64-bit mode a 16-bit operand size still moves the whole 64-bit register, so writing `push ax` would silently push RAX; name the 64-bit register explicitly');
      }
      // PUSH and POP default to a 64-bit operand in long mode, so REX.W would be
      // redundant here. It is not merely untidy to emit it: `48 50` and `50` are
      // the same instruction, but every toolchain emits the shorter form, and a
      // byte-for-byte comparison against a reference image should agree with them.
      // REX.B is still needed, and is what selects r8-r15.
      this.setRex(false, 0, 0, reg.index, reg.needsRex);
      this.setOpcode(base + (reg.index & 7));
      return this.result();
    }

    if (operand.kind === 'immediate') {
      if (!isPush) this.fail('takes a register or a memory operand');
      const value = this.evaluate(operand.value);
      if (fitsIn(value, 1)) {
        this.setOpcode(0x6a);
        this.setImm(value, 1);
        return this.result();
      }
      const size = this.stackOperandSize();
      this.sizeOverridePrefix(size);
      this.setOpcode(0x68);
      // 68 is a bit pattern at 16 and 32 bits, and a sign-extended imm32 at 64.
      this.setImmUnsigned(value, size === 16 ? 2 : 4);
      return this.result();
    }

    if (operand.kind === 'memory') {
      const size = this.stmt.sizeOverride === 'word' ? 16 : this.stackOperandSize();
      this.sizeOverridePrefix(size);
      this.setRm(this.rm(operand, false), isPush ? 6 : 7);
      this.setOpcode(0xff);
      return this.result();
    }

    // Segment registers have their own opcodes - 06/0E/16/1E push and 07/0F/17/1F pop -
    // rather than a ModRM form, and the set is smaller than MOV's: only ES, CS, SS and
    // DS have one. FS and GS need the two-byte 0F A0/A8 and A1/A9 instead, because the
    // one-byte opcode space was already full by the time they were added to the
    // architecture. Refusing them with that reason is more useful than refusing them
    // with "invalid operand", because `push fs` is exactly what a kernel writes when it
    // is saving per-CPU state and needs to know which encoding to use instead.
    if (operand.kind === 'segment') {
      // CS has a PUSH but no POP, and the reason is not an omission in the opcode map:
      // POP CS does not exist, because loading CS changes the code segment and
      // invalidates the instruction pipeline the pop is itself executing from. The SDM
      // states it directly - "The POP instruction cannot pop a value into the CS
      // register" - and RETF is how a far return gets there instead.
      //
      // Encoding it anyway would emit a bare 0x0F, which is not POP CS but the escape
      // byte introducing the two-byte opcode map. So `pop cs` does not merely decode to
      // the wrong thing, it produces a byte stream whose length depends on whatever
      // instruction happens to follow: the failure lands on the *next* instruction, far
      // from its cause.
      if (operand.seg === 1 && !isPush) {
        this.fail(
          'POP CS is not an instruction: loading CS would invalidate the prefetch the pop is executing from. Use RETF to return far.',
        );
      }
      const opcode = SEGMENT_PUSH_POP[operand.seg];
      if (opcode === undefined) {
        this.fail(
          `'${operand.seg === 4 ? 'fs' : 'gs'}' has no one-byte push/pop opcode; it uses the two-byte 0F forms, which this assembler does not yet encode`,
        );
      }
      // The operand size follows the same default as a register push, and in long mode
      // that default is 64: PUSH DS there moves the whole 64-bit value, so a 0x66 in
      // front would push 2 bytes instead. Both are real instructions and the difference
      // is the size of the caller's stack frame, so it is the operand size that decides
      // it, not the register's own width.
      this.sizeOverridePrefix(this.stackOperandSize());
      this.setOpcode(isPush ? opcode : opcode + 1);
      return this.result();
    }

    this.fail('invalid operand');
  }

  /* ------------------------------------------------------------------ */
  /* Strings, I/O and system instructions                               */
  /* ------------------------------------------------------------------ */

  /**
   * The string primitives.
   *
   * Their width comes from the operand-size prefix, so `movs` with no operand is
   * mode-relative while `movs byte [edi], byte [esi]` pins it. The byte forms are
   * separate opcodes from the wider ones, which is why the table has two entries
   * per mnemonic rather than one entry plus a size flag.
   */
  private encodeString(mnemonic: string): EncodeResult {
    const width = this.stringWidth();

    if (this.stmt.prefix === 'repne') this.frame.prefixes.push(0xf2);
    else if (this.stmt.prefix !== 'none') this.frame.prefixes.push(0xf3);

    const opcodes: Readonly<Record<string, readonly number[]>> = {
      movs: [0xa4, 0xa5],
      cmps: [0xa6, 0xa7],
      stos: [0xaa, 0xab],
      lods: [0xac, 0xad],
      scas: [0xae, 0xaf],
      // INS and OUTS are string primitives with the port in DX instead of a memory
      // operand, and split the same way: 6C/6E are the byte halves and 6D/6F the wide
      // ones, whose width then comes from the operand-size prefix like A5's.
      ins: [0x6c, 0x6d],
      outs: [0x6e, 0x6f],
    };
    const table = opcodes[mnemonic];
    if (table === undefined) this.fail(`unknown string instruction '${mnemonic}'`);

    this.sizeOverridePrefix(width);
    this.setRex(width === 64, 0, 0, 0, false);
    this.setOpcode(width === 8 ? table[0]! : table[1]!);
    return this.result();
  }

  private stringWidth(): 8 | 16 | 32 | 64 {
    const explicit = this.stmt.operands[0];
    if (explicit !== undefined) {
      if (explicit.kind === 'register' && explicit.reg.size !== 8) return explicit.reg.size;
      if (explicit.kind === 'immediate' && explicit.value.kind === 'literal') {
        const bits = Number(explicit.value.value);
        if (isSize(bits)) return bits;
      }
    }
    if (this.stmt.sizeOverride !== null) {
      const bits = SIZE_BITS[this.stmt.sizeOverride];
      if (isSize(bits)) return bits;
    }
    if (this.ctx.mode === CpuMode.REAL16) return 16;
    if (this.ctx.mode === CpuMode.PROTECTED32) return 32;
    return 64;
  }

  /**
   * IN and OUT.
   *
   * The accumulator must be A - the port number in DX shares the operand-size
   * prefix's register selection, so AX/EAX is the only option. The immediate port
   * form encodes an unsigned byte, which is why a port above 255 has to go
   * through DX rather than being rejected.
   */
  private encodeIo(isIn: boolean): EncodeResult {
    this.expectCount(2);
    const acc = isIn ? this.operand(0) : this.operand(1);
    const port = isIn ? this.operand(1) : this.operand(0);

    if (acc.kind !== 'register' || acc.reg.index !== 0) {
      this.fail('the accumulator must be AL, AX or EAX');
    }
    const width = acc.reg.size;
    if (!isSize(width) || width === 64) this.fail('supports 8, 16 or 32 bits');

    this.sizeOverridePrefix(width);

    if (port.kind === 'immediate') {
      const value = this.evaluate(port.value);
      if (value < 0n || value > 255n) {
        this.fail(`port ${value} is out of range: the immediate form encodes an unsigned byte, so load the port into DX instead`);
      }
      // The opcode's high bit distinguishes AL from eAX, not 16 from 32: E4/EC are the
      // byte forms and E5/ED cover both AX and EAX, separated by the 0x66 prefix. The
      // distinction the SDM makes is 8-bit against everything else, so asking whether
      // the width is *16* here would hand EAX the byte opcode - which is still a valid
      // instruction, just not the one that was written.
      this.setOpcode((isIn ? 0xe4 : 0xe6) + (width === 8 ? 0 : 1));
      // The port number is an unsigned byte. Checked rather than truncated, so
      // `in al, 300` is an error instead of silently becoming `in al, 44`.
      this.setImmUnsigned(value, 1);
      return this.result();
    }

    // The port register is DX, always, and its size says nothing about the data width:
    // `in al, dx` transfers one byte through the low half of DX, so accepting DL as a
    // port operand would be accepting a register the CPU cannot use. What matters is
    // that it is DX, so the check is on the index alone and the width is left to the
    // instruction as a whole - otherwise `in al, dx` is refused for being 8 bits wide
    // against a 16-bit DX, which is the ordinary spelling of the byte form.
    if (port.kind !== 'register' || port.reg.index !== Reg.DX) {
      this.fail('the port must be an immediate, or DX or EDX');
    }
    this.setOpcode((isIn ? 0xec : 0xee) + (width === 8 ? 0 : 1));
    return this.result();
  }

  private encodeInt(): EncodeResult {
    this.expectCount(1);
    const operand = this.operand(0);
    if (operand.kind !== 'immediate') this.fail('the operand must be an immediate vector number');
    const value = this.evaluate(operand.value);
    if (value < 0n || value > 255n) this.fail(`interrupt vector ${value} is out of range`);
    this.setOpcode(0xcd);
    // CD ib is a vector number, so unsigned - `int 255` is a legal instruction.
    this.setImmUnsigned(value, 1);
    return this.result();
  }

  /**
   * The `0F 00` and `0F 01` system groups, which are two tables and not one.
   *
   * They are easy to confuse because they share a layout and both have six named
   * members, and the confusion is not symmetric: reading the `0F 00` table with the
   * `0F 01` numbers turns `sldt` into `sgdt` and `str` into `sidt`, which *assembles*.
   * That is the dangerous failure - a kernel debugging a descriptor table gets a store
   * where it asked for a read, the disassembly looks plausible, and the bug surfaces
   * much later as corrupted descriptor state.
   *
   * So each table is keyed by mnemonic and holds its own opcode byte alongside its own
   * reg field, and a mnemonic that appears in neither cannot be encoded at all.
   */
  private static readonly SYSTEM_GROUPS: Readonly<Record<string, { readonly opcode: 0x00 | 0x01; readonly reg: number }>> = {
    // `0F 00 /r` - the segment-descriptor group. Every member takes a register or a
    // memory destination, and the operand is 16 bits whatever the prefixes say.
    sldt: { opcode: 0x00, reg: 0 },
    str: { opcode: 0x00, reg: 1 },
    lldt: { opcode: 0x00, reg: 2 },
    ltr: { opcode: 0x00, reg: 3 },
    verr: { opcode: 0x00, reg: 4 },
    verw: { opcode: 0x00, reg: 5 },
    // `0F 01 /r` - the descriptor-table-base group. All five members named here take a
    // memory destination, because what they name is a limit-and-base pair rather than a
    // value of the operand size: 6 bytes in legacy modes, 10 in 64-bit mode.
    sgdt: { opcode: 0x01, reg: 0 },
    sidt: { opcode: 0x01, reg: 1 },
    lgdt: { opcode: 0x01, reg: 2 },
    lidt: { opcode: 0x01, reg: 3 },
    // SMSW and LMSW are absent from this half deliberately: they take a register as
    // well as memory, and `smsw eax` is the common spelling. encodeSystemRmw handles
    // them, because putting them here would force them through a memory-only path.
    invlpg: { opcode: 0x01, reg: 7 },
  };

  private encodeDescriptor(mnemonic: string): EncodeResult {
    this.expectCount(1);
    const operand = this.operand(0);
    const entry = Encoder.SYSTEM_GROUPS[mnemonic];
    if (entry === undefined) this.fail(`unknown instruction '${mnemonic}'`);

    // The two halves differ in whether a register is a legal destination, and the
    // difference is about what the instruction moves rather than a stylistic choice.
    // `0F 00` moves a *selector* - a 16-bit number that fits in a register - so all six
    // of its members accept one. `0F 01` moves a *limit and base pair*, a 6- or 10-byte
    // structure that no register holds, so its members are memory-only.
    const selectorGroup = entry.opcode === 0x00;
    if (!selectorGroup && operand.kind !== 'memory') {
      this.fail('needs a memory operand holding the limit and base');
    }
    if (selectorGroup && operand.kind !== 'memory' && operand.kind !== 'register') {
      this.fail(`needs a register or memory operand; ${mnemonic} is '0F 00 /${entry.reg}'`);
    }

    if (selectorGroup && operand.kind === 'register') {
      // A selector is 16 bits and 16 bits is what the destination receives, so the
      // operand size is the register's own width rather than the mode's default. REX.B
      // is the only extension needed: the r/m field names the destination and the reg
      // field still selects the instruction.
      if (operand.reg.size !== 16) this.fail('the selector destination must be a 16-bit register');
      const defaultSize = this.ctx.mode === CpuMode.LONG64 ? 32 : this.stackOperandSize();
      if (16 !== defaultSize) this.frame.prefixes.push(0x66);
      this.setRex(false, 0, 0, operand.reg.needsRex ? 1 : 0);
      this.setOpcode(0x0f, 0x00);
      this.setModrm(3, entry.reg, operand.reg.index);
      return this.result();
    }

    // No REX.W: a selector destination is 16 bits and a limit-and-base pair is a
    // fixed-size structure - 10 bytes in 64-bit mode, 6 in legacy - so in neither case
    // would a 64-bit operand size widen the store. It would make the *address* 64-bit,
    // which is a different instruction rather than a wider one.
    this.setOpcode(0x0f, entry.opcode);
    this.setRm(this.rm(operand, false), entry.reg);
    return this.result();
  }

  private encodeInvlpg(): EncodeResult {
    this.expectCount(1);
    const operand = this.operand(0);
    if (operand.kind !== 'memory') this.fail('needs a memory operand');
    this.setOpcode(0x0f, 0x01);
    this.setRm(this.rm(operand, false), 7);
    return this.result();
  }

  /**
   * SMSW and LMSW, the two `0F 01` members whose destination may also be a register.
   *
   * They are kept out of `SYSTEM_GROUPS` because that table's members are all
   * memory-only, and putting them in it would mean dropping `smsw eax` - which is the
   * spelling a debugger uses, since reading a control register's low half into a
   * register is the only way to inspect it without a memory location to write.
   *
   * The width handling is the SDM's, and it is not the usual one. SMSW's store is
   * *always* 16 bits to memory regardless of the operand size, while a register
   * destination takes the operand size - so `smsw rax` writes 64 bits and
   * `smsw [rax]` writes 16. The two cannot both be described by one width, which is
   * exactly why they get their own encoder rather than a flag.
   */
  private encodeMachineStatus(mnemonic: string): EncodeResult {
    this.checkByteRegisters();
    this.expectCount(1);
    const operand = this.operand(0);
    const isStore = mnemonic === 'smsw';
    const regField = isStore ? 4 : 6;
    const toMemory = operand.kind === 'memory';

    if (toMemory) {
      // A memory destination is 16 bits wide whatever the prefixes say, so REX.W is not
      // forwarded here: it would make the *address* 64-bit, which is a different
      // instruction rather than a wider store.
      this.setOpcode(0x0f, 0x01);
      this.setRm(this.rm(operand, false), regField);
      return this.result();
    }

    if (operand.kind !== 'register') this.fail('needs a register or memory operand');
    if (operand.reg.size !== 16 && operand.reg.size !== 32) {
      // SMSW's register form is r/m16 or r/m32 and nothing else. A 64-bit destination
      // is not `smsw rax`: REX.W on this opcode has no meaning, because CR0 is only 64
      // bits wide to begin with and its upper half does not exist. Accepting it would
      // emit a REX.W the CPU reads as an extension for no purpose.
      this.fail('the destination must be a 16- or 32-bit register');
    }
    // The register's own width is the operand size, the same channel every other
    // register-destination instruction uses - `smsw ax` is 16 bits because AX is, not
    // because a size keyword appeared. In long mode the default is 32, so a 16-bit
    // destination needs the 0x66 prefix; outside long mode the default is the stack
    // size, so a 32-bit one needs it.
    const defaultSize = this.ctx.mode === CpuMode.LONG64 ? 32 : this.stackOperandSize();
    if (operand.reg.size !== defaultSize) this.frame.prefixes.push(0x66);
    // Only B is needed: the r/m field names the destination, and the reg field still
    // selects SMSW or LMSW, so R and X have nothing to extend.
    this.setRex(false, 0, 0, operand.reg.needsRex ? 1 : 0);
    this.setOpcode(0x0f, 0x01);
    // mod=3: the r/m field names the destination register directly.
    this.setModrm(3, regField, operand.reg.index);
    return this.result();
  }

  /* ------------------------------------------------------------------ */
  /* Operand checks                                                     */
  /* ------------------------------------------------------------------ */

  private requireByteRegister(operand: Operand): RegisterRef {
    if (operand.kind !== 'register') this.fail('expected a register');
    if (operand.reg.size !== 8) this.fail(`expected an 8-bit register, found a ${operand.reg.size}-bit one`);
    return operand.reg;
  }
}

/** Whether an 8-bit operand forces a REX prefix to mean what was written. */
function byteNeedRex(operand: Operand): boolean {
  return operand.kind === 'register' && !operand.reg.highByte && operand.reg.needsRex;
}

function describeAddress(mem: MemoryRef): string {
  const parts: string[] = [];
  if (mem.base !== null) parts.push(mem.base);
  if (mem.index !== null) parts.push(`${mem.index}*${mem.scale}`);
  return parts.join('+') === '' ? 'the address' : `[${parts.join('+')}]`;
}

/** Encode one statement. */
export function encodeInstruction(stmt: InstructionStatement, ctx: EncodeContext): EncodeResult {
  return new Encoder(stmt, ctx).encode();
}