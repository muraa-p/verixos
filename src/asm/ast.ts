/**
 * VerixOS - assembler AST.
 *
 * The intermediate form between the parser and the encoder. It is deliberately
 * small and deliberately *unresolved*: a label reference is a name, not an
 * address, because addresses are not known until pass two.
 *
 * The split matters more than it looks. Resolving names during parsing would
 * make forward references impossible, and every real program - including a boot
 * sector that jumps over its own data - needs them.
 */

import { AsmError } from './lexer.ts';

/* -------------------------------------------------------------------------- */
/* Registers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A resolved register reference.
 *
 * `highByte` and `needsRex` exist because 8-bit registers cannot be numbered
 * cleanly. Field 4 means "the high byte of RAX" in a REX-less encoding and "the
 * low byte of RSP" in an encoding with one, and the encoder must be able to
 * choose. See the note in `lexer.ts` on the sixteen 8-bit registers.
 */
export interface RegisterRef {
  /**
   * The name as written, lowercased.
   *
   * Carried rather than reconstructed, because a diagnostic that says "cannot move
   * a 16-bit value into 32 bits" without naming the register forces the reader to
   * go and find which of the two operands it meant.
   */
  readonly name: string;
  /** Host register index 0-15, matching `Reg` in `src/arch/types.ts`. */
  readonly index: number;
  /** Operand width in bits. */
  readonly size: 8 | 16 | 32 | 64;
  /** AH, CH, DH or BH. Mutually exclusive with `needsRex`. */
  readonly highByte: boolean;
  /** SPL, BPL, SIL, DIL or R8B-R15B. Mutually exclusive with `highByte`. */
  readonly needsRex: boolean;
}

const R64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'] as const;
const R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'] as const;
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'] as const;
const R8_LOW = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'] as const;
const R8_HIGH = ['ah', 'ch', 'dh', 'bh'] as const;

function indexOfName(table: readonly string[], name: string): number {
  return table.indexOf(name);
}

/**
 * Look up a register name.
 *
 * Returns undefined for a name that is not a register. The lexer has already
 * guaranteed that anything register-shaped arrives as a `Register` token, so in
 * practice this only fails on control registers, which the parser routes
 * elsewhere.
 */
export function lookupRegister(name: string): RegisterRef | undefined {
  const lower = name.toLowerCase();

  const i64 = indexOfName(R64, lower);
  if (i64 >= 0) return { name: lower, index: i64, size: 64, highByte: false, needsRex: false };

  const i32 = indexOfName(R32, lower);
  if (i32 >= 0) return { name: lower, index: i32, size: 32, highByte: false, needsRex: false };

  const i16 = indexOfName(R16, lower);
  if (i16 >= 0) return { name: lower, index: i16, size: 16, highByte: false, needsRex: false };

  const i8 = indexOfName(R8_LOW, lower);
  // Fields 4-7 are the only ones that force a REX prefix.
  if (i8 >= 0) return { name: lower, index: i8, size: 8, highByte: false, needsRex: i8 >= 4 };

  const i8h = indexOfName(R8_HIGH, lower);
  if (i8h >= 0) return { name: lower, index: i8h, size: 8, highByte: true, needsRex: false };

  return undefined;
}

/** The `mov`-style register field for an 8-bit operand, plus whether REX is needed. */
export function byteRegisterField(ref: RegisterRef): { field: number; highByte: boolean } {
  if (ref.highByte) return { field: ref.index + 4, highByte: true };
  return { field: ref.index & 0x0f, highByte: false };
}

/* -------------------------------------------------------------------------- */
/* Expressions                                                                 */
/* -------------------------------------------------------------------------- */

/** Binary operators. Precedence lives in the parser, not here. */
export type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>';

/** Prefix operators, which take exactly one operand. */
export type UnaryOperator = '-' | '~';

/**
 * An address expression, kept as a tree rather than a folded value.
 *
 * An earlier version folded expressions into a literal, a symbol-with-offset or a
 * symbol difference, and that was a mistake: `510 - ($ - $$)` has no
 * representation in that algebra, so the fold silently dropped the 510. The
 * visible symptom was a boot sector padded with the wrong number of bytes - a
 * bug that survives every test that does not check the image length, which is to
 * say the image itself.
 *
 * The tree is cheap and total: `evaluateExpression` below is the only thing that
 * reduces it, and it does so once addresses are known.
 */
export type Expression =
  | { readonly kind: 'literal'; readonly value: bigint }
  | { readonly kind: 'symbol'; readonly name: string; readonly offset: bigint }
  | {
      readonly kind: 'binary';
      readonly op: BinaryOperator;
      readonly left: Expression;
      readonly right: Expression;
    }
  | { readonly kind: 'unary'; readonly op: UnaryOperator; readonly operand: Expression };

export function literalExpression(value: bigint): Expression {
  return { kind: 'literal', value };
}

export function symbolExpression(name: string, offset = 0n): Expression {
  return { kind: 'symbol', name, offset };
}

export function binaryExpression(op: BinaryOperator, left: Expression, right: Expression): Expression {
  return { kind: 'binary', op, left, right };
}

export function unaryExpression(op: UnaryOperator, operand: Expression): Expression {
  return { kind: 'unary', op, operand };
}

/** True when the expression mentions no symbol, so it is layout-independent. */
export function isConstantExpression(expr: Expression): boolean {
  switch (expr.kind) {
    case 'literal':
      return true;
    case 'symbol':
      return false;
    case 'binary':
      return isConstantExpression(expr.left) && isConstantExpression(expr.right);
    case 'unary':
      return isConstantExpression(expr.operand);
    default:
      return false;
  }
}

/**
 * Every symbol name the expression mentions, including repeats.
 *
 * Used to reject an expression whose symbols are not yet known, rather than
 * discovering it halfway through layout where the error has no useful position.
 */
export function symbolsInExpression(expr: Expression): string[] {
  switch (expr.kind) {
    case 'symbol':
      return [expr.name];
    case 'binary':
      return [...symbolsInExpression(expr.left), ...symbolsInExpression(expr.right)];
    case 'unary':
      return symbolsInExpression(expr.operand);
    default:
      return [];
  }
}

/**
 * Evaluate an expression once symbol addresses are known.
 *
 * `resolve` is supplied by the assembler, which is where the symbol table and the
 * constants table live. Arithmetic is BigInt throughout, so `end - start` is exact
 * and `<<` cannot overflow into a float.
 */
export function evaluateExpression(expr: Expression, resolve: (name: string) => bigint, where: string): bigint {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'symbol':
      return resolve(expr.name) + expr.offset;
    case 'binary': {
      const left = evaluateExpression(expr.left, resolve, where);
      const right = evaluateExpression(expr.right, resolve, where);
      switch (expr.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          if (right === 0n) throw new AsmError('division by zero', where, 0, 0);
          return left / right;
        case '%':
          if (right === 0n) throw new AsmError('division by zero', where, 0, 0);
          return left % right;
        case '&':
          return left & right;
        case '|':
          return left | right;
        case '^':
          return left ^ right;
        case '<<':
          return left << right;
        case '>>':
          return left >> right;
        default:
          throw new AsmError(`cannot evaluate expression (${where})`, '<expression>', 0, 0);
      }
    }
    case 'unary': {
      const value = evaluateExpression(expr.operand, resolve, where);
      // Both of these are unbounded in the BigInt sense; the caller range-checks
      // the result against the destination width, which is where a wrap belongs.
      return expr.op === '-' ? -value : ~value;
    }
    default:
      throw new AsmError(`cannot evaluate expression (${where})`, '<expression>', 0, 0);
  }
}

/* -------------------------------------------------------------------------- */
/* Operands                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A memory operand.
 *
 * Kept in symbolic form because `[label + rax*4]` is normal assembly and the
 * label cannot be resolved until pass two.
 */
export interface MemoryRef {
  readonly base: string | null;
  readonly index: string | null;
  /** 1, 2, 4 or 8. */
  readonly scale: 1 | 2 | 4 | 8;
  /** Displacement, which may be symbolic. */
  readonly displacement: Expression;
  /** True when written `[rel label]` or `[label]` with no registers. */
  readonly ripRelative: boolean;
  /** True when the operand is exactly one symbol with no base or index. */
  readonly absoluteSymbol: boolean;
}

/**
 * One operand.
 *
 * `size` is the keyword written against *this* operand, if any. It lives here
 * rather than on the instruction because the two are genuinely different: `movzx
 * eax, byte [rbx]` states the width of the second operand only, and a single
 * statement-level field cannot express that. The statement-level `sizeOverride`
 * remains for the `byte ptr` spelling, which prefixes the whole instruction.
 */
export interface OperandBase {
  /** `byte`, `word`, `dword`, `qword` written against this operand, or null. */
  readonly size: SizeKeyword | null;
}

export type Operand =
  | (OperandBase & { readonly kind: 'register'; readonly reg: RegisterRef })
  | (OperandBase & { readonly kind: 'immediate'; readonly value: Expression })
  /** A control register operand, for mov cr0, rax. */
  | (OperandBase & { readonly kind: 'control'; readonly index: number })
  /** A segment register operand, for mov ds, ax. */
  | (OperandBase & { readonly kind: 'segment'; readonly seg: number })
  /**
   * `segment:offset`, for `jmp 0x7c00:start`.
   *
   * One operand rather than two because the pair is architecturally indivisible: an
   * offset without a segment is not an address in real mode, and splitting them would
   * let `jmp start` and `jmp 0:start` be written identically while meaning different
   * things.
   */
  | (OperandBase & {
      readonly kind: 'far';
      readonly segment: Expression;
      readonly offset: Expression;
    })
  | (OperandBase & { readonly kind: 'memory'; readonly mem: MemoryRef });

/**
 * Segment register numbers, in ModRM `reg` field order.
 *
 * The numbering is the hardware's, not a choice: ES=0, CS=1, SS=2, DS=3, FS=4,
 * GS=5, so writing it out as an enum-like table is the only honest form. Anything
 * derived from it - the `8E` and `8C` group encoding, segment overrides - must use
 * these indices rather than their own numbering.
 */
export const SEGMENT_REGISTERS: Readonly<Record<string, number>> = {
  es: 0,
  cs: 1,
  ss: 2,
  ds: 3,
  fs: 4,
  gs: 5,
};

/* -------------------------------------------------------------------------- */
/* Statements                                                                  */
/* -------------------------------------------------------------------------- */

/** Instruction size keywords: `byte`, `word`, `dword`, `qword`. */
export type SizeKeyword = 'byte' | 'word' | 'dword' | 'qword' | 'fword' | 'tword';

export interface InstructionStatement {
  readonly kind: 'instruction';
  /** Mnemonic as written, lowercased. */
  readonly mnemonic: string;
  readonly operands: readonly Operand[];
  /** Explicit size override, from `byte ptr` / `dword [rbx]`. */
  readonly sizeOverride: SizeKeyword | null;
  /** `rep`, `repe`/`repz`, `repne`/`repnz`, or none. */
  readonly prefix: 'none' | 'rep' | 'repe' | 'repne';
  /** `lock`, when written. */
  readonly locked: boolean;
  /** Line number, for diagnostics and for the section walk. */
  readonly line: number;
}

export interface LabelStatement {
  readonly kind: 'label';
  readonly name: string;
  /** A global label: `name:` rather than `.name:`. */
  readonly global: boolean;
  readonly line: number;
}

/** A constant definition: `.equ name, value`, `name equ value`, or `name = value`. */
export interface EquStatement {
  readonly kind: 'equ';
  readonly name: string;
  readonly value: Expression;
  readonly line: number;
}

/**
 * One element of a data directive.
 *
 * Kept as a single ordered list rather than parallel `values` and `strings` arrays,
 * because `db "Verix", 0, "OS"` must emit in that order and two arrays cannot
 * remember the interleaving.
 */
export type DataElement = Expression | string;

export interface DataStatement {
  readonly kind: 'data';
  /** `db`, `dw`, `dd`, `dq`, `.ascii`, `.asciz` or `.string`. */
  readonly directive: string;
  /** Element width in bytes for `db`/`dw`/`dd`/`dq`; 1 for string directives. */
  readonly elementSize: 1 | 2 | 4 | 8;
  readonly elements: readonly DataElement[];
  /** True for `.asciz`/`.string`, which append a NUL after each string. */
  readonly nullTerminate: boolean;
  /**
   * Repeat count from `times n`, or null.
   *
   * An expression rather than a literal because the boot sector idiom
   * `times 510 - ($ - $$) db 0` depends on the current position, which is not
   * known until layout runs.
   */
  readonly times: Expression | null;
  readonly line: number;
}

export interface ReserveStatement {
  readonly kind: 'reserve';
  readonly elementSize: 1 | 2 | 4 | 8;
  readonly count: Expression;
  readonly fill: Expression | null;
  readonly line: number;
}

export interface AlignStatement {
  readonly kind: 'align';
  /** Alignment boundary in bytes; always a power of two. */
  readonly boundary: number;
  readonly fill: Expression | null;
  readonly line: number;
}

export interface OrgStatement {
  readonly kind: 'org';
  readonly address: Expression;
  readonly line: number;
}

/** `.code16`, `.code32`, `.code64`. */
export interface ModeStatement {
  readonly kind: 'mode';
  readonly mode: 16 | 32 | 64;
  readonly line: number;
}

/** `.text`, `.data`, `.section name`. */
export interface SectionStatement {
  readonly kind: 'section';
  readonly name: 'text' | 'data';
  readonly line: number;
}

export type Statement =
  | InstructionStatement
  | LabelStatement
  | EquStatement
  | DataStatement
  | ReserveStatement
  | AlignStatement
  | OrgStatement
  | ModeStatement
  | SectionStatement;

export type { AsmError };