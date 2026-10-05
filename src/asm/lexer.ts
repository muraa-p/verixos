/**
 * VerixOS - assembler lexer.
 *
 * Turns assembly source into a flat token stream. Newlines are significant:
 * unlike C-family languages, assembly has no statement terminator, so the lexer
 * emits an explicit `Newline` token and the parser uses it to close statements.
 *
 * Two decisions here are load-bearing for everything downstream:
 *
 *  - **Registers are lexed as registers, not as identifiers.** In `mov rax, [rbx]`
 *    the parser must not have to wonder whether `rbx` is a label. More subtly,
 *    `ah` and `spl` are both perfectly good label names, and only the fact that
 *    they are *not* what was written in `[ah]` distinguishes them. Recognising
 *    them here means the parser can report "unknown register" at the point of
 *    the mistake rather than silently producing a memory reference.
 *
 *  - **Numbers keep their spelling.** `0x10`, `10h` and `16` are the same value,
 *    but `$10` is an immediate while `10` might be an address. The parser needs
 *    to see the text, so `Token` carries both `text` and `value`.
 *
 * Source: NASM syntax, which is the closest match to what a real-mode boot sector
 * needs. Intel and AT&T syntax are both supported by the parser on top of this.
 */

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * An assembly error, carrying the source position.
 *
 * Assembler errors are useless without a line number, so the position travels
 * with the message rather than being printed at the throw site and lost.
 */
export class AsmError extends Error {
  readonly line: number;
  readonly column: number;
  readonly filename: string;

  constructor(message: string, filename: string, line: number, column: number) {
    super(`${filename}:${line}:${column}: ${message}`);
    this.name = 'AsmError';
    this.filename = filename;
    this.line = line;
    this.column = column;
  }
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

export const TokenKind = {
  /** A label, a mnemonic, or a bare symbol. */
  Identifier: 'identifier',
  /** `.org`, `.byte`, ... - an identifier introduced by a dot. */
  Directive: 'directive',
  /** An integer or character constant. */
  Number: 'number',
  /** A register name. */
  Register: 'register',
  /** A quoted string. `text` holds the decoded contents. */
  String: 'string',
  /** One of the single-character operators. */
  Punctuation: 'punctuation',
  Newline: 'newline',
  EndOfInput: 'end-of-input',
} as const;

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

export interface Token {
  readonly kind: TokenKind;
  /** Exact source spelling, for diagnostics and for `exactOptionalPropertyTypes`. */
  readonly text: string;
  /** Integer value; zero for non-numeric tokens. */
  readonly value: bigint;
  /** Zero-based byte offset into the source. */
  readonly offset: number;
  /** One-based line number. */
  readonly line: number;
  /** One-based column number. */
  readonly column: number;
}

/* -------------------------------------------------------------------------- */
/* Register names                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every register name the lexer recognises, in the spelling a programmer writes.
 *
 * The 8-bit names are the awkward part. In 64-bit mode there are sixteen byte
 * registers, not eight: `al cl dl bl spl bpl sil dil r8b..r15b`. Fields 4-7 mean
 * AH/CH/DH/BH only when no REX prefix is present, and mean SPL/BPL/SIL/DIL only
 * when one is. Both spellings must therefore be lexable, and the *encoder* has to
 * decide which of the two a given instruction needs.
 */
export const REGISTER_NAMES: readonly string[] = [
  'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
  'eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
  'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d',
  'ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di',
  'al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh',
  'spl', 'bpl', 'sil', 'dil',
  'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b',
];

const REGISTER_SET = new Set(REGISTER_NAMES);

/** Control registers the assembler can name. The kernel needs CR0 and CR4. */
export const CONTROL_REGISTER_NAMES: readonly string[] = ['cr0', 'cr2', 'cr3', 'cr4'];

const CONTROL_REGISTER_SET = new Set(CONTROL_REGISTER_NAMES);

/* -------------------------------------------------------------------------- */
/* Lexer                                                                       */
/* -------------------------------------------------------------------------- */

/** Characters that may appear in a symbol, after the first. */
function isSymbolTail(ch: string): boolean {
  return /[A-Za-z0-9_.$@]/.test(ch);
}

/** Characters that may start a symbol. `$` is excluded: it marks an immediate. */
function isSymbolHead(ch: string): boolean {
  return /[A-Za-z_.]/.test(ch);
}

const SINGLE_CHAR_PUNCTUATION = new Set(['+', '-', '*', '/', '%', '(', ')', '[', ']', ',', ':', '$', '=', '?', '<', '>', '|', '&', '^', '~', '!']);

/** Escapes recognised in a character or string literal. */
function decodeEscape(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '0':
      return '\0';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'v':
      return '\v';
    case 'a':
      return '\x07';
    case 'e':
      return '\x1b';
    case '\\':
      return '\\';
    case "'":
      return "'";
    case '"':
      return '"';
    case '`':
      return '`';
    default:
      // An unrecognised escape is passed through as the literal character, which
      // matches what nasm does and avoids erroring on `\q` in someone's strings.
      return ch;
  }
}

/**
 * Parse an integer literal.
 *
 * The accepted forms are the ones real assembly actually uses, because a
 * bootloader written in NASM will contain all of them: `0x2A`, `2Ah`, `42`,
 * `1010b`, `0o52` and `'*'`. NASM also allows `_` as a digit separator, which is
 * worth supporting since it makes memory maps readable.
 */
export function parseNumber(text: string, filename: string, line: number, column: number): bigint {
  const cleaned = text.replace(/_/g, '');
  const lower = cleaned.toLowerCase();

  const fail = (why: string): never => {
    throw new AsmError(`invalid numeric literal '${text}': ${why}`, filename, line, column);
  };

  // Character literal.
  if (text.length >= 3 && text.startsWith("'") && text.endsWith("'")) {
    const body = text.slice(1, -1);
    const decoded = body.length === 0 ? '' : unescape(body, filename, line, column);
    if (decoded.length !== 1) {
      fail(`a character literal must hold exactly one character, found ${decoded.length}`);
    }
    return BigInt(decoded.codePointAt(0) ?? 0);
  }

  // Radix-prefixed forms. These are checked before the trailing-suffix forms
  // because `0b1010` would otherwise be read as decimal `0` with a trailing `b`.
  if (lower.startsWith('0x')) {
    const digits = lower.slice(2);
    if (digits.length === 0 || !/^[0-9a-f]+$/.test(digits)) fail('expected hexadecimal digits after 0x');
    return BigInt(`0x${digits}`);
  }
  if (lower.startsWith('0o')) {
    const digits = lower.slice(2);
    if (digits.length === 0 || !/^[0-7]+$/.test(digits)) fail('expected octal digits after 0o');
    return BigInt(`0o${digits}`);
  }
  if (lower.startsWith('0b')) {
    const digits = lower.slice(2);
    if (digits.length === 0 || !/^[01]+$/.test(digits)) fail('expected binary digits after 0b');
    return BigInt(`0b${digits}`);
  }

  // Suffix forms: `2Ah` for hex, `1010b` for binary. NASM requires at least one
  // digit before the suffix so that the register name `ah` is not read as hex.
  if (/^[0-9][0-9a-f]*h$/.test(lower)) {
    return BigInt(`0x${lower.slice(0, -1)}`);
  }
  if (/^[01]+b$/.test(lower)) {
    return BigInt(`0b${lower.slice(0, -1)}`);
  }

  if (/^[0-9]+$/.test(lower)) return BigInt(lower);

  return fail('not a number');
}

function unescape(body: string, filename: string, line: number, column: number): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      throw new AsmError('trailing backslash in literal', filename, line, column);
    }
    // \xNN and \NNN are handled here; everything else is a named escape.
    if (next === 'x' || next === 'X') {
      const hex = body.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{1,2}$/.test(hex)) {
        throw new AsmError('\\x needs one or two hexadecimal digits', filename, line, column);
      }
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 1 + hex.length;
      continue;
    }
    out += decodeEscape(next);
    i += 1;
  }
  return out;
}

export interface LexOptions {
  readonly filename: string;
}

/**
 * Tokenise assembly source.
 *
 * Not a class: lexing is a single pass with no state beyond the cursor, and a
 * closure keeps the position bookkeeping from leaking into a mutable object.
 */
export function tokenize(source: string, options: LexOptions): Token[] {
  const { filename } = options;
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let lineStart = 0;

  const columnAt = (at: number): number => at - lineStart + 1;

  const push = (kind: TokenKind, text: string, value: bigint, start: number, startLine: number): void => {
    tokens.push({ kind, text, value, offset: start, line: startLine, column: columnAt(start) });
  };

  while (offset < source.length) {
    const ch = source[offset]!;

    // Line continuation: a backslash at end of line joins the lines.
    if (ch === '\\' && (source[offset + 1] === '\n' || (source[offset + 1] === '\r' && source[offset + 2] === '\n'))) {
      offset += source[offset + 1] === '\r' ? 3 : 2;
      line++;
      lineStart = offset;
      continue;
    }

    if (ch === '\r') {
      // Normalise CRLF to a single newline token.
      offset++;
      if (source[offset] === '\n') offset++;
      push(TokenKind.Newline, '\n', 0n, offset - 1, line);
      line++;
      lineStart = offset;
      continue;
    }

    if (ch === '\n') {
      push(TokenKind.Newline, '\n', 0n, offset, line);
      offset++;
      line++;
      lineStart = offset;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      offset++;
      continue;
    }

    // Comments. `;` runs to end of line, `//` as well, and `/* */` spans lines.
    if (ch === ';') {
      while (offset < source.length && source[offset] !== '\n' && source[offset] !== '\r') offset++;
      continue;
    }
    if (ch === '/' && source[offset + 1] === '/') {
      while (offset < source.length && source[offset] !== '\n' && source[offset] !== '\r') offset++;
      continue;
    }
    if (ch === '/' && source[offset + 1] === '*') {
      const startLine = line;
      const start = offset;
      offset += 2;
      for (;;) {
        if (offset >= source.length) {
          throw new AsmError('unterminated block comment', filename, startLine, columnAt(start));
        }
        if (source[offset] === '*' && source[offset + 1] === '/') {
          offset += 2;
          break;
        }
        if (source[offset] === '\n') {
          line++;
          lineStart = offset + 1;
        }
        offset++;
      }
      continue;
    }

    const startLine = line;
    const start = offset;

    // Character or string literal.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      offset++;
      let body = '';
      for (;;) {
        if (offset >= source.length || source[offset] === '\n' || source[offset] === '\r') {
          throw new AsmError('unterminated literal', filename, startLine, columnAt(start));
        }
        const c = source[offset]!;
        if (c === quote) {
          offset++;
          break;
        }
        if (c === '\\') {
          body += c;
          offset++;
          if (offset >= source.length) {
            throw new AsmError('unterminated literal', filename, startLine, columnAt(start));
          }
          body += source[offset]!;
          offset++;
          continue;
        }
        body += c;
        offset++;
      }
      const text = source.slice(start, offset);
      if (quote === "'") {
        const decoded = unescape(body, filename, startLine, columnAt(start));
        if (decoded.length !== 1) {
          throw new AsmError(
            `a character literal must hold exactly one character, found ${decoded.length}`,
            filename,
            startLine,
            columnAt(start),
          );
        }
        push(TokenKind.Number, text, BigInt(decoded.codePointAt(0) ?? 0), start, startLine);
      } else {
        push(TokenKind.String, unescape(body, filename, startLine, columnAt(start)), 0n, start, startLine);
      }
      continue;
    }

    // Symbols, directives and registers.
    if (isSymbolHead(ch)) {
      while (offset < source.length && isSymbolTail(source[offset]!)) offset++;
      const text = source.slice(start, offset);

      if (REGISTER_SET.has(text)) {
        push(TokenKind.Register, text, 0n, start, startLine);
        continue;
      }
      if (CONTROL_REGISTER_SET.has(text)) {
        // Lexed as identifiers and resolved by the parser, because `cr0` is
        // ambiguous with a symbol until the mnemonic says otherwise.
        push(TokenKind.Identifier, text, 0n, start, startLine);
        continue;
      }
      if (text.startsWith('.')) {
        push(TokenKind.Directive, text, 0n, start, startLine);
        continue;
      }
      push(TokenKind.Identifier, text, 0n, start, startLine);
      continue;
    }

    // Numbers. A digit can only start a number here because symbols may not begin
    // with a digit.
    if (/[0-9]/.test(ch)) {
      while (offset < source.length && /[0-9A-Za-z_]/.test(source[offset]!)) offset++;
      const text = source.slice(start, offset);
      // A trailing `:` would mean a local label, but a number cannot be one, so
      // this is unambiguously a literal.
      const value = parseNumber(text, filename, startLine, columnAt(start));
      push(TokenKind.Number, text, value, start, startLine);
      continue;
    }

    if (SINGLE_CHAR_PUNCTUATION.has(ch)) {
      offset++;
      push(TokenKind.Punctuation, ch, 0n, start, startLine);
      continue;
    }

    throw new AsmError(`unexpected character '${ch}'`, filename, startLine, columnAt(start));
  }

  push(TokenKind.EndOfInput, '<end of input>', 0n, offset, line);
  return tokens;
}