/**
 * VerixOS - assembler parser.
 *
 * Consumes the token stream and produces `Statement` nodes. Everything symbolic
 * is preserved unresolved, so forward references work.
 *
 * ## The one genuinely fiddly part: what counts as a label
 *
 * Assembly has no statement terminator, so `foo` alone on a line could declare
 * the label `foo` or be an instruction missing its mnemonic. NASM resolves this
 * by position: an identifier followed by a colon is a label, and whatever
 * follows on the same line belongs to it. `start: mov rax, 1` is one line and
 * produces two statements, which is why `parseStatement` writes into a list
 * rather than returning a single node.
 *
 * Source: NASM syntax, because it is what real-mode boot code is written in.
 * The Intel and AT&T spellings are mapped onto it by `MNEMONIC_ALIASES`.
 */

import { AsmError, TokenKind } from './lexer.ts';
import type { Token } from './lexer.ts';
import {
  binaryExpression,
  evaluateExpression,
  isConstantExpression,
  literalExpression,
  lookupRegister,
  SEGMENT_REGISTERS,
  symbolExpression,
  symbolsInExpression,
  unaryExpression,
} from './ast.ts';
import type {
  BinaryOperator,
  DataElement,
  Expression,
  MemoryRef,
  Operand,
  SizeKeyword,
  Statement,
} from './ast.ts';

/**
 * Mnemonic spellings that map onto a canonical name.
 *
 * Two groups live here: the `iret`/`retf` spellings that differ only in which stack
 * the CPU expects to find, and the sized string primitives. The last group is the
 * longer one because it is purely mechanical - `movsb` is `movs` with an operand
 * size of 8 - and folding it into the canonical name would lose the size, leaving the
 * encoder to guess the width from the mode. Condition-code synonyms are separate, in
 * `CONDITION_SYNONYMS`, because there are three families of them and one table per
 * family reads worse than one table keyed by the whole mnemonic.
 */
const MNEMONIC_ALIASES: Readonly<Record<string, string>> = {
  iretd: 'iret',
  iretl: 'iret',
  iretq: 'iret',
  lret: 'retf',
  int3: 'int3',
  xlat: 'xlatb',

  movsb: 'movs',
  movsw: 'movs',
  movsd: 'movs',
  movsq: 'movs',
  cmpsb: 'cmps',
  cmpsw: 'cmps',
  cmpsd: 'cmps',
  cmpsq: 'cmps',
  stosb: 'stos',
  stosw: 'stos',
  stosd: 'stos',
  stosq: 'stos',
  lodsb: 'lods',
  lodsw: 'lods',
  lodsd: 'lods',
  lodsq: 'lods',
  scasb: 'scas',
  scasw: 'scas',
  scasd: 'scas',
  scasq: 'scas',
  insb: 'ins',
  insw: 'ins',
  insd: 'ins',
  insq: 'ins',
  outsb: 'outs',
  outsw: 'outs',
  outsd: 'outs',
  outsq: 'outs',
};

/**
 * Alternative spellings of a condition code, mapped to the SDM's own name for the
 * same condition.
 *
 * These are keyed by the *suffix* only, because Jcc, SETcc and CMOVcc all take one
 * and there is no reason to write out the same three families three times. They are
 * not merely style: `jc` means "carry set", and carry set is the *unsigned* below
 * condition, so `jc` and `jb` encode to the same bits while reading `jc` as "carry
 * clear" would silently select the opposite condition. Collapsing them means the
 * encoder only ever sees the SDM spelling, which is what makes its positional
 * `CONDITION_NAMES` lookup a statement about the encoding rather than about spelling.
 *
 * The ones with no entry are already canonical. `jmp` is not affected: `mp` is not a
 * condition suffix, so the family match fails and the mnemonic is left alone.
 */
const CONDITION_SUFFIX: Readonly<Record<string, string>> = {
  // Unsigned below. `nae` reads as two conditions and is one: not above or equal.
  c: 'b', nae: 'b',
  // Unsigned above or equal. `nc` is the negated carry, and carry is the only borrow
  // signal an unsigned comparison has, so "not carry" is "above or equal".
  nb: 'ae', nc: 'ae',
  z: 'e',
  nz: 'ne',
  na: 'be',
  nbe: 'a',
  // Parity, named both ways: `pe` is "parity even", `po` is "parity odd", and the SDM
  // calls them `p` and `np`.
  pe: 'p', po: 'np',
  // Signed.
  nge: 'l', nl: 'ge', ng: 'le', nle: 'g',
};

/** A mnemonic of the form `j`/`set`/`cmov` followed by a condition code. */
const CONDITION_FAMILY = /^(?:j|set|cmov)([a-z]+)$/;

/** `movs`/`cmps`/`stos`/`lods`/`scas`/`ins`/`outs` followed by the letter naming the width. */
const SIZED_STRING = /^(?:movs|cmps|stos|lods|scas|ins|outs)([bwdq])$/;

const STRING_SUFFIX_SIZE: Readonly<Record<string, SizeKeyword>> = {
  b: 'byte',
  w: 'word',
  d: 'dword',
  q: 'qword',
};

const SIZE_KEYWORDS: Readonly<Record<string, SizeKeyword>> = {
  byte: 'byte',
  word: 'word',
  dword: 'dword',
  qword: 'qword',
  fword: 'fword',
  tword: 'tword',
};

/**
 * Data directive element widths, in bytes.
 *
 * Both spellings are accepted for each width: the NASM abbreviation (`db`) and the
 * GNU one named after the size keyword (`.byte`). They are the same instruction
 * and refusing half of them would only make the assembler harder to use - the
 * cost is one table entry each, and the distinction is not one worth an error
 * message.
 */
const DATA_DIRECTIVES: Readonly<Record<string, 1 | 2 | 4 | 8>> = {
  db: 1,
  byte: 1,
  dw: 2,
  word: 2,
  dd: 4,
  dword: 4,
  dq: 8,
  qword: 8,
};

const RESERVE_DIRECTIVES: Readonly<Record<string, 1 | 2 | 4 | 8>> = {
  resb: 1,
  resw: 2,
  resd: 4,
  resq: 8,
  zero: 1,
  space: 1,
};

const CONTROL_REGISTER = /^cr[0-7]$/;

/** A memory base or index register must be 32 or 64 bits; SP and BP need a SIB. */
const REQUIRES_SIB = new Set(['rsp', 'r12', 'esp', 'r12d', 'sp', 'bp', 'r13', 'r13d']);

export class Parser {
  private readonly tokens: readonly Token[];
  private readonly filename: string;
  private cursor = 0;
  private readonly out: Statement[] = [];

  constructor(tokens: readonly Token[], filename: string) {
    this.tokens = tokens;
    this.filename = filename;
  }

  /* ------------------------------------------------------------------ */
  /* Token access                                                       */
  /* ------------------------------------------------------------------ */

  private peek(ahead = 0): Token {
    const index = Math.min(this.cursor + ahead, this.tokens.length - 1);
    return this.tokens[index]!;
  }

  private get current(): Token {
    return this.peek(0);
  }

  private next(): Token {
    const token = this.current;
    if (this.cursor < this.tokens.length - 1) this.cursor++;
    return token;
  }

  private fail(message: string, token: Token = this.current): never {
    throw new AsmError(message, this.filename, token.line, token.column);
  }

  private at(kind: TokenKind, text?: string): boolean {
    const token = this.current;
    if (token.kind !== kind) return false;
    return text === undefined || token.text === text;
  }

  private accept(kind: TokenKind, text?: string): boolean {
    if (!this.at(kind, text)) return false;
    this.next();
    return true;
  }

  private expect(kind: TokenKind, what: string): Token {
    if (!this.at(kind)) this.fail(`expected ${what}, found ${describeToken(this.current)}`);
    return this.next();
  }

  private skipNewlines(): void {
    while (this.at(TokenKind.Newline)) this.next();
  }

  /**
   * Assert that the statement is over.
   *
   * Newlines are deliberately *not* consumed here. The main loop skips them, so a
   * directive that swallowed its own trailing newline would leave the loop looking
   * at the next instruction as though it were a stray continuation of the
   * directive. That is exactly how `.code64` on its own line broke everything after
   * it before this was fixed.
   */
  private endOfStatement(): void {
    if (this.at(TokenKind.EndOfInput) || this.at(TokenKind.Newline)) return;
    this.fail(`unexpected ${describeToken(this.current)} at the end of the statement`);
  }

  /* ------------------------------------------------------------------ */
  /* Entry point                                                        */
  /* ------------------------------------------------------------------ */

  parse(): readonly Statement[] {
    this.skipNewlines();
    while (!this.at(TokenKind.EndOfInput)) {
      const before = this.cursor;
      this.parseStatement();
      // Guarantee forward progress. A statement that consumes nothing is a parser
      // bug, and looping on one would hang the assembler rather than fail it.
      if (this.cursor === before) {
        this.fail(`parser made no progress at ${describeToken(this.current)}`);
      }
      this.skipNewlines();
    }
    return this.out;
  }

  private emit(statement: Statement): void {
    this.out.push(statement);
  }

  private parseStatement(): void {
    // `times n <statement>` repeats. Handled before labels so that the boot
    // sector's `times 510-($-$$) db 0` padding idiom works.
    if (this.at(TokenKind.Identifier, 'times')) {
      this.next();
      const count = this.parseExpression();
      // The comma is optional. NASM writes `times 4 db 0` and this is the idiom the
      // boot sector padding uses, so requiring a comma would reject the one line
      // every real-mode assembler starts with.
      this.accept(TokenKind.Punctuation, ',');
      const mark = this.out.length;
      this.parseStatement();
      const inner = this.out[mark];
      if (inner === undefined) this.fail('times must be followed by a statement');
      if (inner.kind === 'data' && inner.times === null) {
        this.out[mark] = { ...inner, times: count };
      } else if (inner.kind === 'reserve') {
        this.out[mark] = { ...inner, count };
      } else {
        this.fail(`'times' cannot repeat a ${inner.kind}`);
      }
      return;
    }

    // A label: an identifier (or `.local`) immediately followed by a colon.
    if (this.at(TokenKind.Identifier) || this.at(TokenKind.Directive)) {
      const token = this.current;
      const isLocal = token.text.startsWith('.');
      const colon = this.peek(1);
      if (colon.kind === TokenKind.Punctuation && colon.text === ':') {
        this.next();
        this.next();
        this.emit({ kind: 'label', name: token.text, global: !isLocal, line: token.line });
        // The statement may follow on the same line or the next one.
        this.skipNewlines();
        if (this.at(TokenKind.EndOfInput)) return;
        this.parseStatement();
        return;
      }

      // `.name = value` is a constant assignment, and the lexer cannot tell it from
      // a directive without this look: it classifies every `.`-leading word as a
      // directive because that is true of 99% of them. The `=` is what decides it,
      // so the decision has to be made here rather than in the tokenizer.
      if (isLocal && colon.kind === TokenKind.Punctuation && colon.text === '=') {
        this.next();
        this.next();
        const value = this.parseExpression();
        this.endOfStatement();
        this.emit({ kind: 'equ', name: token.text, value, line: token.line });
        return;
      }
    }

    if (this.at(TokenKind.Directive)) {
      this.parseDirective();
      return;
    }
    if (this.at(TokenKind.Identifier)) {
      this.parseIdentifierStatement();
      return;
    }
    if (this.at(TokenKind.Register)) {
      this.fail(`a statement cannot begin with the register '${this.current.text}'`);
    }
    this.fail(`unexpected ${describeToken(this.current)}`);
  }

  /**
   * Reduce a mnemonic spelling to the one the encoder dispatches on.
   *
   * Condition codes first, then the general alias table. The order matters only for
   * the three families - `set` overlaps nothing in `MNEMONIC_ALIASES` - but putting
   * the condition rewrite first means a future alias entry cannot accidentally
   * shadow a condition code, since `jz` and `je` are the same instruction and only
   * one of them can be a spelling of the other.
   */
  private canonicalMnemonic(raw: string): string {
    const family = CONDITION_FAMILY.exec(raw);
    if (family !== null) {
      const suffix = family[1]!;
      const canonical = CONDITION_SUFFIX[suffix];
      if (canonical !== undefined) return raw.slice(0, raw.length - suffix.length) + canonical;
    }
    return MNEMONIC_ALIASES[raw] ?? raw;
  }

  /* ------------------------------------------------------------------ */
  /* Directives                                                         */
  /* ------------------------------------------------------------------ */

  private parseDirective(): void {
    const token = this.next();
    const name = token.text.toLowerCase();

    switch (name) {
      case '.org':
        this.emit({ kind: 'org', address: this.parseExpression(), line: token.line });
        this.endOfStatement();
        return;
      case '.equ':
      case '.set': {
        const name = this.expect(TokenKind.Identifier, 'a symbol name').text;
        // `.equ name, value` is the usual spelling; `name equ value` needs no
        // comma. Accepting both costs one line and saves a confusing error.
        this.accept(TokenKind.Punctuation, ',');
        this.emit({ kind: 'equ', name, value: this.parseExpression(), line: token.line });
        this.endOfStatement();
        return;
      }
      case '.align':
      case '.balign':
        this.emit(this.parseAlign(token));
        return;
      case '.code16':
      case '.code32':
      case '.code64':
        this.endOfStatement();
        this.emit({ kind: 'mode', mode: Number(name.slice(5)) as 16 | 32 | 64, line: token.line });
        return;
      case '.text':
      case '.data':
        this.endOfStatement();
        this.emit({ kind: 'section', name: name.slice(1) as 'text' | 'data', line: token.line });
        return;
      case '.section': {
        const sectionToken = this.expect(TokenKind.Identifier, 'a section name');
        const section = sectionToken.text.toLowerCase();
        if (section !== 'text' && section !== 'data') {
          // A real .bss would need zero-filled output that is not written to the
          // image. Claiming to support it and emitting it as data would be worse
          // than saying so.
          this.fail(
            section === 'bss'
              ? "there is no '.bss': the image is emitted as bytes, so uninitialised storage has to live in '.data' with '.zero'"
              : `unknown section '.${section}'; this assembler has text and data`,
            sectionToken,
          );
        }
        this.endOfStatement();
        this.emit({ kind: 'section', name: section, line: token.line });
        return;
      }
      case '.global':
      case '.globl':
      case '.extern':
        // Symbol visibility is meaningless in a flat single-file image. Accepted
        // and ignored so source shared with a real toolchain still assembles.
        this.expect(TokenKind.Identifier, 'a symbol name');
        this.endOfStatement();
        return;
      case '.asciz':
      case '.string':
      case '.ascii':
        this.emit(this.parseStrings(token, name !== '.ascii'));
        return;
      case '.incbin':
        this.fail('.incbin is not supported: the assembler has no filesystem access');
        return;
      default:
        break;
    }

    // Directives exist under both spellings, and the tables are written without the
    // leading dot so that `db` and `.byte` can share one entry. A name written with
    // a dot is looked up bare as well, which is what makes `.dword` resolve.
    const bare = name.startsWith('.') ? name.slice(1) : name;

    const elementSize = DATA_DIRECTIVES[bare];
    if (elementSize !== undefined) {
      this.emit(this.parseData(token, bare, elementSize));
      return;
    }

    const reserveSize = RESERVE_DIRECTIVES[bare];
    if (reserveSize !== undefined) {
      const count = this.parseExpression();
      const fill = this.accept(TokenKind.Punctuation, ',') ? this.parseExpression() : null;
      this.endOfStatement();
      this.emit({ kind: 'reserve', elementSize: reserveSize, count, fill, line: token.line });
      return;
    }

    this.fail(`unknown directive '${token.text}'`, token);
  }

  private parseAlign(token: Token): Statement {
    const expr = this.parseExpression();
    // The boundary has to be decidable now: layout needs a number, and deferring
    // it would mean a label could silently become a page alignment.
    if (!isConstantExpression(expr)) {
      this.fail('.align needs a literal power of two, not an expression', token);
    }
    const boundary = Number(evaluateExpression(expr, () => 0n, 'an .align boundary'));
    if (boundary <= 0 || (boundary & (boundary - 1)) !== 0) {
      this.fail(`.align needs a positive power of two, found ${boundary}`, token);
    }
    const fill = this.accept(TokenKind.Punctuation, ',') ? this.parseExpression() : null;
    this.endOfStatement();
    return { kind: 'align', boundary, fill, line: token.line };
  }

  private parseStrings(token: Token, nullTerminate: boolean): Statement {
    return {
      kind: 'data',
      directive: token.text.toLowerCase(),
      elementSize: 1,
      elements: this.parseElementList(),
      nullTerminate,
      times: null,
      line: token.line,
    };
  }

  private parseData(token: Token, directive: string, elementSize: 1 | 2 | 4 | 8): Statement {
    return {
      kind: 'data',
      directive,
      elementSize,
      elements: this.parseElementList(),
      nullTerminate: false,
      times: null,
      line: token.line,
    };
  }

  /** A comma-separated list of string literals and expressions, in source order. */
  private parseElementList(): DataElement[] {
    const elements: DataElement[] = [];
    for (;;) {
      if (this.at(TokenKind.String)) elements.push(this.next().text);
      else elements.push(this.parseExpression());
      if (!this.accept(TokenKind.Punctuation, ',')) break;
      this.skipNewlines();
    }
    this.endOfStatement();
    return elements;
  }

  /* ------------------------------------------------------------------ */
  /* Identifier-led statements                                           */
  /* ------------------------------------------------------------------ */

  /**
   * A line starting with an identifier: a mnemonic, or `name equ value`.
   *
   * `name = value` is a constant assignment rather than a comparison, which is
   * why `=` is checked before any operand is parsed.
   */
  private parseIdentifierStatement(): void {
    const token = this.current;
    const second = this.peek(1);

    if (second.kind === TokenKind.Identifier && second.text.toLowerCase() === 'equ') {
      this.next();
      this.next();
      const value = this.parseExpression();
      this.endOfStatement();
      this.emit({ kind: 'equ', name: token.text, value, line: token.line });
      return;
    }

    if (second.kind === TokenKind.Punctuation && second.text === '=') {
      this.next();
      this.next();
      const value = this.parseExpression();
      this.endOfStatement();
      this.emit({ kind: 'equ', name: token.text, value, line: token.line });
      return;
    }

    // NASM spells the data and reservation directives without a leading dot:
    // `db`, `dw`, `resb`. `parseDirective` only sees `.`-prefixed tokens, so
    // without this branch `db 0` would be read as an instruction named `db` and
    // fail much later, in the encoder, with a message pointing at the wrong file.
    const bare = token.text.toLowerCase();
    if (DATA_DIRECTIVES[bare] !== undefined || RESERVE_DIRECTIVES[bare] !== undefined) {
      this.parseBareDirective();
      return;
    }

    this.emit(this.parseInstruction());
  }

  /** `db`/`dw`/`dd`/`dq` and `resb`/`resw`/`resd`/`resq`. */
  private parseBareDirective(): void {
    const token = this.next();
    const name = token.text.toLowerCase();

    const elementSize = DATA_DIRECTIVES[name];
    if (elementSize !== undefined) {
      this.emit(this.parseData(token, name, elementSize));
      return;
    }

    const reserveSize = RESERVE_DIRECTIVES[name];
    if (reserveSize === undefined) {
      this.fail(`unknown directive '${token.text}'`, token);
    }
    const count = this.parseExpression();
    const fill = this.accept(TokenKind.Punctuation, ',') ? this.parseExpression() : null;
    this.endOfStatement();
    this.emit({ kind: 'reserve', elementSize: reserveSize, count, fill, line: token.line });
  }

  private parseInstruction(): Statement {
    let prefix: 'none' | 'rep' | 'repe' | 'repne' = 'none';
    let locked = false;

    // Prefixes are written as separate words *before* the mnemonic: `rep stosq`,
    // `lock xadd`. Reading them after the mnemonic - which an earlier version of
    // this parser did - makes `rep` itself the mnemonic and reports "unknown
    // mnemonic 'rep'" for the single most common string idiom there is.
    for (;;) {
      const token = this.current;
      if (token.kind !== TokenKind.Identifier) break;
      const word = token.text.toLowerCase();
      if (word === 'lock') {
        locked = true;
        this.next();
        continue;
      }
      if (word === 'rep') {
        prefix = 'rep';
        this.next();
        continue;
      }
      if (word === 'repe' || word === 'repz') {
        prefix = 'repe';
        this.next();
        continue;
      }
      if (word === 'repne' || word === 'repnz') {
        prefix = 'repne';
        this.next();
        continue;
      }
      break;
    }

    if (!this.at(TokenKind.Identifier)) {
      this.fail(`'${describeToken(this.current)}' is not an instruction`);
    }
    const mnemonicToken = this.next();
    const raw = mnemonicToken.text.toLowerCase();
    const mnemonic = this.canonicalMnemonic(raw);

    // `byte ptr [rax]` and bare `dword [rbx]` before the first operand set the
    // size for the whole instruction.
    let sizeOverride: SizeKeyword | null = this.parseSizeKeyword();

    // A sized string primitive names its own width in the mnemonic: `movsq` is
    // `movs` with a 64-bit operand. Recording that as the operand size rather than
    // as a new mnemonic means the width reaches the encoder through the one
    // channel every other size already uses, instead of a second one that would
    // have to be kept in step.
    const stringSuffix = raw.match(SIZED_STRING);
    if (stringSuffix !== null) {
      const implied = STRING_SUFFIX_SIZE[stringSuffix[1]!];
      if (implied === undefined) this.fail(`'${raw}' is not a string instruction`, mnemonicToken);
      if (sizeOverride !== null && sizeOverride !== implied) {
        this.fail(
          `'${raw}' already fixes the operand size at ${implied}; the '${sizeOverride}' keyword contradicts it`,
          mnemonicToken,
        );
      }
      sizeOverride = implied;
    }

    const operands: Operand[] = [];
    if (!this.at(TokenKind.Newline) && !this.at(TokenKind.EndOfInput)) {
      for (;;) {
        operands.push(this.parseOperand());
        if (!this.accept(TokenKind.Punctuation, ',')) break;
        this.skipNewlines();
      }
    }
    this.endOfStatement();

    return { kind: 'instruction', mnemonic, operands, sizeOverride, prefix, locked, line: mnemonicToken.line };
  }

  /* ------------------------------------------------------------------ */
  /* Operands                                                           */
  /* ------------------------------------------------------------------ */

  private parseOperand(): Operand {
    // A size keyword may qualify the individual operand: `movzx eax, byte [rbx]`
    // says the *source* is a byte, which is the whole point of that instruction.
    // The keyword belongs to this operand rather than to the statement, because
    // the statement's two operands regularly have different widths.
    const size = this.parseSizeKeyword();
    const sizeKeyword: SizeKeyword | null = size;

    // A control register: `mov cr0, rax`. ModRM's r/m field 4-7 selects the
    // control-register space only when a ModRM byte is present at all, so this
    // cannot be folded into the ordinary register case.
    if (this.at(TokenKind.Identifier) && CONTROL_REGISTER.test(this.current.text.toLowerCase())) {
      const token = this.next();
      if (sizeKeyword !== null) {
        this.fail(`'${token.text}' has a fixed size; the keyword '${sizeKeyword}' does not apply to it`, token);
      }
      return { kind: 'control', index: Number(token.text.slice(2)), size: null };
    }

    // A segment register. `mov ds, ax` is the second instruction of every boot
    // sector, so this is not an exotic form; it is recognised here rather than
    // falling through to an expression, where `ds` would be taken for a label.
    if (this.at(TokenKind.Identifier)) {
      const seg = SEGMENT_REGISTERS[this.current.text.toLowerCase()];
      if (seg !== undefined) {
        this.next();
        return { kind: 'segment', seg, size: sizeKeyword };
      }
    }

    // `segment:offset`, optionally written with a leading `far` keyword.
    //
    // The colon is what distinguishes a far pointer from a label that happens to be
    // followed by something else, and the whole thing has to be read before the `:`
    // so the left side is an expression rather than a symbol. `far` is a keyword
    // rather than a symbol because `jmp far 0x1000:0x1234` has to be distinguishable
    // from `jmp far_label`; requiring the colon does exactly that, and a failed
    // attempt rewinds so a label genuinely named `far` still works.
    if (!this.at(TokenKind.Punctuation, '[')) {
      const mark = this.cursor;
      try {
        if (this.at(TokenKind.Identifier) && this.current.text.toLowerCase() === 'far') {
          this.next();
        }
        const segment = this.parseExpression();
        if (this.at(TokenKind.Punctuation, ':')) {
          this.next();
          const offset = this.parseExpression();
          return { kind: 'far', segment, offset, size: sizeKeyword };
        }
      } catch {
        // Not a far pointer after all. Rewind and let the ordinary expression path
        // report the error, so the message is about the operand rather than about a
        // speculative parse that failed.
      }
      this.cursor = mark;
    }

    if (this.at(TokenKind.Register)) {
      const token = this.next();
      const reg = lookupRegister(token.text);
      if (reg === undefined) this.fail(`unknown register '${token.text}'`, token);
      // `word ax` is redundant rather than wrong - x86 spells word registers by
      // name - so it is accepted. `byte rax` is nonsense and is refused.
      if (sizeKeyword !== null && sizeKeyword !== 'byte' && reg.size !== 8) {
        this.fail(
          `'${token.text}' is already a ${reg.size}-bit register, so the '${sizeKeyword}' keyword is redundant`,
          token,
        );
      }
      if (sizeKeyword !== null && sizeKeyword === 'byte' && reg.size !== 8) {
        this.fail(`'byte ${token.text}' is a mismatch: ${token.text} is ${reg.size} bits wide`, token);
      }
      return { kind: 'register', reg, size: sizeKeyword };
    }

    // `$expr` is the value of expr. A bare number is the address of that number's
    // storage, which is why the dollar is load-bearing: `mov al, $5` and
    // `mov al, [5]` differ by whether the value 5 or the address 5 is meant.
    if (this.at(TokenKind.Punctuation, '$')) {
      this.next();
      return { kind: 'immediate', value: this.parseExpression(), size: sizeKeyword };
    }

    if (this.at(TokenKind.Punctuation, '[')) {
      return { kind: 'memory', mem: this.parseMemory(), size: sizeKeyword };
    }

    return { kind: 'immediate', value: this.parseExpression(), size: sizeKeyword };
  }

  /**
   * A `byte` / `word` / `dword` / `qword` keyword, or null.
   *
   * The `ptr` that usually follows it is skipped, so `dword ptr [rbx]` and
   * `dword [rbx]` are the same operand.
   */
  private parseSizeKeyword(): SizeKeyword | null {
    if (!this.at(TokenKind.Identifier)) return null;
    const keyword = this.current.text.toLowerCase();
    const size = SIZE_KEYWORDS[keyword];
    if (size === undefined) return null;
    this.next();
    if (this.at(TokenKind.Identifier, 'ptr')) this.next();
    return size;
  }

  /**
   * `[base + index*scale + disp]`, with NASM's conveniences:
   *
   *  - `[label]` with no registers is an address. In 64-bit mode with no base
   *    register the only absolute encoding available is RIP-relative, so that is
   *    what it means.
   *  - `[rel label]` asks for RIP-relative explicitly, which matters when
   *    disambiguating from an absolute address in 32-bit code.
   */
  private parseMemory(): MemoryRef {
    const open = this.expect(TokenKind.Punctuation, '[');
    this.skipNewlines();

    let explicitRel = false;
    if (this.at(TokenKind.Identifier, 'rel')) {
      this.next();
      explicitRel = true;
    }
    if (this.at(TokenKind.Identifier, 'strict')) {
      this.fail('the `strict` keyword is not implemented; omit it', open);
    }

    let base: string | null = null;
    let index: string | null = null;
    let scale: 1 | 2 | 4 | 8 = 1;
    const terms: Expression[] = [];

    for (;;) {
      if (this.at(TokenKind.Register)) {
        const token = this.next();
        const reg = lookupRegister(token.text);
        if (reg === undefined) this.fail(`unknown register '${token.text}'`, token);
        // 8-bit registers are never addressable. 16-bit ones are - bx, bp, si and
        // di are the only registers 16-bit addressing can name - and the encoder
        // rejects them outside real mode with a specific message, so they are
        // accepted here rather than rejected on a guess about the mode.
        if (reg.size === 8) {
          this.fail(`'${token.text}' cannot be a base or index register`, token);
        }
        const name = token.text.toLowerCase();

        // A register followed by `*` is an index, not a base. The token has just
        // been consumed, so the `*` is the *next* one - peek(0), not peek(1).
        if (this.peek(0).kind === TokenKind.Punctuation && this.peek(0).text === '*') {
          if (index !== null) this.fail('an address can have at most one index register', token);
          index = name;
          this.next();
          const factor = this.expect(TokenKind.Number, 'a scale factor of 1, 2, 4 or 8');
          const value = Number(factor.value);
          if (value !== 1 && value !== 2 && value !== 4 && value !== 8) {
            this.fail(`scale must be 1, 2, 4 or 8, found ${value}`, factor);
          }
          scale = value as 1 | 2 | 4 | 8;
        } else {
          if (base !== null) {
            // Two plain registers means the second was written without a scale;
            // treating it as an implicit index of scale 1 is what programmers mean.
            if (index !== null) this.fail('an address can have at most one index register', token);
            index = name;
          } else {
            base = name;
          }
        }
      } else if (!this.at(TokenKind.Punctuation, ']') && !this.at(TokenKind.Punctuation, '+') && !this.at(TokenKind.Punctuation, '-')) {
        // Each term is parsed at multiplicative precedence so that it stops at
        // the next top-level `+` or `-`. Letting it run at full precedence would
        // swallow the separator and then hit the next register, which cannot
        // start an expression - the failure would point at a register that is
        // perfectly legal in the address.
        terms.push(this.parseBinary(BINARY_PRECEDENCE['*']));
      }

      if (this.accept(TokenKind.Punctuation, '+')) {
        this.skipNewlines();
        continue;
      }
      if (this.accept(TokenKind.Punctuation, '-')) {
        this.skipNewlines();
        terms.push(unaryExpression('-', this.parseBinary(BINARY_PRECEDENCE['*'])));
        continue;
      }
      break;
    }

    // Newlines are skipped *inside* the brackets so an address can wrap, but not
    // after the closing one: doing so would consume the line break and leave
    // `endOfStatement` looking at the next line's first token.
    this.expect(TokenKind.Punctuation, ']');

    const displacement = combineTerms(terms);
    const noRegisters = base === null && index === null;
    // Whether the displacement names a symbol, not whether it is a bare literal.
    // The two are not the same question: `end - start` is symbol-dependent in
    // form yet a compile-time constant in value, and treating it as an address
    // would emit a displacement computed from wherever the linker put things.
    const symbolDependent = symbolsInExpression(displacement).length > 0;

    return {
      base,
      index,
      scale,
      displacement,
      // RIP-relative is the only way to name an address with no base register in
      // 64-bit mode, so a bare symbol means it implicitly.
      ripRelative: explicitRel || (noRegisters && symbolDependent),
      absoluteSymbol: noRegisters && symbolDependent,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Expressions                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * A full constant expression, parsed by precedence climbing.
   *
   * Precedence, loosest first: `|` then `^` then `&` then the shifts, then
   * additive `+`/`-`, then multiplicative `*`/`/`/`%`, then the unary operators.
   * That is C's order and NASM's, and it matters here because the boot sector
   * writes `510 - ($ - $$)` while a page-aligned buffer needs `buffer & ~0xfff`.
   *
   * The tree is built here and reduced later, when addresses exist. See the note
   * on `Expression` in `ast.ts` for why nothing is folded at this stage.
   */
  private parseExpression(): Expression {
    return this.parseBinary(1);
  }

  /**
   * The binary operator at the cursor, or null if there is not one.
   *
   * Does not consume. The two shift operators need a second character of
   * lookahead, which is also why `<<` and `<` cannot be confused.
   */
  private peekOperator(): BinaryOperator | null {
    const token = this.current;
    if (token.kind !== TokenKind.Punctuation) return null;
    const after = this.peek(1);
    if (after.kind === TokenKind.Punctuation) {
      if (token.text === '<' && after.text === '<') return '<<';
      if (token.text === '>' && after.text === '>') return '>>';
    }
    return OPERATOR_PUNCTUATION.has(token.text) ? (token.text as BinaryOperator) : null;
  }

  private consumeOperator(op: BinaryOperator): void {
    if (op === '<<' || op === '>>') {
      this.next();
      this.next();
      return;
    }
    this.next();
  }

  private parseBinary(minPrecedence: number): Expression {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peekOperator();
      if (op === null) break;
      const precedence = BINARY_PRECEDENCE[op];
      // A looser operator belongs to an enclosing call, so stop and let it have
      // the token. This is what makes the tree left-associative.
      if (precedence < minPrecedence) break;
      this.consumeOperator(op);
      this.skipNewlines();
      left = binaryExpression(op, left, this.parseBinary(precedence + 1));
    }
    return left;
  }

  /** `-x`, `~x` and the no-op `+x`. */
  private parseUnary(): Expression {
    if (this.at(TokenKind.Punctuation, '-')) {
      this.next();
      return unaryExpression('-', this.parseUnary());
    }
    if (this.at(TokenKind.Punctuation, '~')) {
      this.next();
      return unaryExpression('~', this.parseUnary());
    }
    if (this.at(TokenKind.Punctuation, '+')) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.current;

    if (this.at(TokenKind.Number)) {
      this.next();
      return literalExpression(token.value);
    }
    if (this.at(TokenKind.Punctuation, '(')) {
      this.next();
      const inner = this.parseExpression();
      this.expect(TokenKind.Punctuation, ')');
      return inner;
    }
    if (this.at(TokenKind.Punctuation, '$')) {
      // `$` is the current address and `$$` the start of the current section.
      // Both exist because the boot sector's padding idiom needs them:
      // `times 510 - ($ - $$) db 0`.
      this.next();
      if (this.at(TokenKind.Punctuation, '$')) {
        this.next();
        return symbolExpression('$$');
      }
      return symbolExpression('$');
    }
    if (this.at(TokenKind.Identifier)) {
      this.next();
      return symbolExpression(token.text);
    }
    // A `.`-leading word in an expression is a reference to a local label, not a
    // directive. `jmp .retry` has to resolve like any other symbol, and the
    // tokenizer cannot make that call on its own.
    if (this.at(TokenKind.Directive)) {
      this.next();
      return symbolExpression(token.text);
    }
    this.fail(`expected an expression, found ${describeToken(token)}`, token);
  }
}

/* -------------------------------------------------------------------------- */
/* Expression helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Registers that cannot be a bare ModRM base and therefore force a SIB byte. */
export { REQUIRES_SIB };

/**
 * Operator precedence, loosest binding first.
 *
 * C's order and NASM's. `~` is a prefix operator and so is deliberately absent
 * from this table - it can never be the left operand of a binary operator, and
 * listing it would let `a ~ b` parse.
 */
const BINARY_PRECEDENCE: Readonly<Record<BinaryOperator, number>> = {
  '|': 1,
  '^': 2,
  '&': 3,
  '<<': 4,
  '>>': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const OPERATOR_PUNCTUATION: ReadonlySet<string> = new Set(Object.keys(BINARY_PRECEDENCE));

function combineTerms(terms: readonly Expression[]): Expression {
  if (terms.length === 0) return literalExpression(0n);
  let acc = terms[0]!;
  for (let i = 1; i < terms.length; i++) acc = binaryExpression('+', acc, terms[i]!);
  return acc;
}

function describeToken(token: Token): string {
  switch (token.kind) {
    case TokenKind.EndOfInput:
      return 'end of input';
    case TokenKind.Newline:
      return 'end of line';
    default:
      return `'${token.text}'`;
  }
}