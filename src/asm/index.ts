/**
 * VerixOS - assembler public API.
 *
 * The pipeline is `tokenize` -> `Parser` -> `Encoder`, driven by `assemble`.
 * Only `assemble` and `Assembler` are needed to build an image; the rest is
 * exported so tooling can inspect a single stage, and so the tests can drive the
 * decoder/encoder round trip directly.
 */

export { AsmError, TokenKind, tokenize } from './lexer.ts';
export type { Token } from './lexer.ts';

export {
  binaryExpression,
  byteRegisterField,
  evaluateExpression,
  isConstantExpression,
  literalExpression,
  lookupRegister,
  symbolExpression,
  symbolsInExpression,
  unaryExpression,
} from './ast.ts';
export type {
  BinaryOperator,
  DataElement,
  DataStatement,
  Expression,
  InstructionStatement,
  MemoryRef,
  Operand,
  RegisterRef,
  SizeKeyword,
  Statement,
  UnaryOperator,
} from './ast.ts';

export { Parser } from './parser.ts';
export { Encoder, encodeInstruction } from './encoder.ts';
export type { EncodeContext, EncodeResult, Fixup } from './encoder.ts';

export { Assembler, SECTION_ORDER, assemble, hexDump } from './assembler.ts';
export type { AssembleOptions, AssembleResult, SectionName } from './assembler.ts';