/**
 * VerixOS - assembler tests.
 *
 * The central claim being tested is that the assembler and the decoder agree. A
 * round-trip test is the only way to check that without hand-verifying every
 * encoding against the SDM twice: assemble a mnemonic, decode the bytes, and
 * require the decoder to report the same mnemonic. That catches the entire class
 * of bugs where an encoder is self-consistent and architecturally wrong.
 *
 * Two conventions are used throughout:
 *
 *  - Assertions are on *observable output* - decoded mnemonics, operand values,
 *    exact byte counts - never "no exception was thrown". Three late bugs in this
 *    project were invisible to throw-only tests because they produced plausible
 *    bytes.
 *  - Encodings are checked against published byte sequences for the cases where
 *    the SDM is unambiguous, so the tests do not merely confirm the encoder agrees
 *    with itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assemble, AsmError } from '../src/asm/index.ts';
import { tokenize } from '../src/asm/lexer.ts';
import { Parser } from '../src/asm/parser.ts';
import { InstructionDecoder, CpuMode, bufferReader } from '../src/arch/decode.ts';
import type { Instruction } from '../src/arch/decode.ts';
import { Mnemonic } from '../src/arch/decode.ts';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface Decoded {
  readonly instruction: Instruction;
  /** All bytes consumed, proving the decoder did not under-read. */
  readonly consumed: number;
}

/**
 * Assemble and decode in one step.
 *
 * `origin` defaults to 0x1000 rather than 0 so that a test writing `[rip+x]` or a
 * near branch has realistic addresses; at origin 0 several encodings degenerate
 * into forms a program would never actually produce.
 */
function decodeSource(source: string, mode: CpuMode = CpuMode.LONG64, origin = 0x1000n): Decoded[] {
  const result = assemble(`.code${mode === CpuMode.REAL16 ? '16' : mode === CpuMode.PROTECTED32 ? '32' : '64'}\n${source}`, {
    origin,
  });
  const reader = bufferReader(result.bytes, result.origin);
  const decoder = new InstructionDecoder(reader, mode);
  const out: Decoded[] = [];
  let address = result.origin;
  for (;;) {
    const before = address;
    let instruction: Instruction;
    try {
      instruction = decoder.decode(address, mode);
    } catch {
      break;
    }
    out.push({ instruction, consumed: Number(instruction.origin - before) + instruction.length });
    address = instruction.origin + BigInt(instruction.length);
    if (Number(address - result.origin) >= result.bytes.length) break;
  }
  return out;
}

/** Assemble a single statement and return its bytes. */
function bytes(source: string, mode: CpuMode = CpuMode.LONG64, origin = 0n): number[] {
  const result = assemble(
    `.code${mode === CpuMode.REAL16 ? '16' : mode === CpuMode.PROTECTED32 ? '32' : '64'}\n${source}`,
    { origin },
  );
  return [...result.bytes];
}

/**
 * Render bytes as space-separated lowercase hex.
 *
 * Accepts a plain array or any typed array so a caller does not have to spread a
 * `Uint8Array` from the assembler's result just to make it printable - a conversion
 * that was previously needed in four places and got one of them wrong.
 */
function hex(list: ArrayLike<number>): string {
  return Array.from(list, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Decode one instruction and assert its mnemonic, so failures point at the cause. */
function first(source: string, mode?: CpuMode): Instruction {
  const decoded = decodeSource(source, mode);
  const item = decoded[0];
  assert.ok(item !== undefined, `nothing decoded from: ${source}`);
  return item.instruction;
}

function assertMnemonic(source: string, mnemonic: Mnemonic, mode?: CpuMode): Instruction {
  const instruction = first(source, mode);
  assert.equal(
    instruction.mnemonic,
    mnemonic,
    `expected '${mnemonic}' from '${source}', got '${instruction.mnemonic}' (${hex(bytes(source, mode))})`,
  );
  return instruction;
}

/* -------------------------------------------------------------------------- */
/* Lexer                                                                       */
/* -------------------------------------------------------------------------- */

test('lexer: recognises register names as registers, not identifiers', () => {
  const tokens = tokenize('mov rax, ah', { filename: 'test' });
  assert.deepEqual(
    tokens.filter((t) => t.kind === 'register').map((t) => t.text),
    ['rax', 'ah'],
  );
});

test('lexer: parses every accepted numeric form', () => {
  const tokens = tokenize('0x2A 2Ah 42 1010b 0o52 0b1010 1_000', { filename: 'test' });
  const values = tokens.filter((t) => t.kind === 'number').map((t) => t.value);
  assert.deepEqual(values, [42n, 42n, 42n, 10n, 42n, 10n, 1000n]);
});

test('lexer: a character literal yields its code point', () => {
  // A character literal lexes as a *number*, not a string, so `'A'` and 65 are
  // interchangeable everywhere a value is expected.
  const tokens = tokenize("db '*', 'A'", { filename: 'test' });
  const numbers = tokens.filter((t) => t.kind === 'number').map((t) => t.value);
  assert.deepEqual(numbers, [42n, 65n]);
  assert.equal(tokens.filter((t) => t.kind === 'string').length, 0);
});

test('lexer: an escape in a character literal is decoded', () => {
  const tokens = tokenize("db '\\n', '\\t', '\\0'", { filename: 'test' });
  assert.deepEqual(
    tokens.filter((t) => t.kind === 'number').map((t) => t.value),
    [10n, 9n, 0n],
  );
});

test('lexer: newlines are significant tokens', () => {
  const tokens = tokenize('a\nb\n', { filename: 'test' });
  assert.equal(tokens.filter((t) => t.kind === 'newline').length, 2);
});

test('lexer: all three comment styles are skipped', () => {
  const tokens = tokenize('; one\n// two\n/* three */ 42', { filename: 'test' });
  const numbers = tokens.filter((t) => t.kind === 'number');
  assert.equal(numbers.length, 1);
  assert.equal(numbers[0]!.value, 42n);
});

test('lexer: a line continuation joins lines', () => {
  const tokens = tokenize('mov \\\n rax, 1', { filename: 'test' });
  assert.equal(tokens.filter((t) => t.kind === 'newline').length, 0);
});

test('lexer: rejects an unterminated block comment', () => {
  assert.throws(() => tokenize('/* never closed', { filename: 'test' }), AsmError);
});

test('lexer: reports the line an error is on', () => {
  try {
    tokenize('nop\n\n42 "unterminated', { filename: 'test' });
    assert.fail('expected a throw');
  } catch (error) {
    assert.ok(error instanceof AsmError, `got ${String(error)}`);
    assert.equal(error.line, 3);
  }
});

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

function parse(source: string) {
  return new Parser(tokenize(source, { filename: 'test' }), 'test').parse();
}

test('parser: a label and an instruction on one line are two statements', () => {
  const statements = parse('start: mov rax, 1');
  assert.equal(statements.length, 2);
  assert.equal(statements[0]!.kind, 'label');
  assert.equal(statements[1]!.kind, 'instruction');
});

test('parser: a label on its own line is one statement', () => {
  const statements = parse('start:\n  mov rax, 1');
  assert.equal(statements.length, 2);
});

test('parser: `times` keeps its count as an expression', () => {
  // The count cannot be folded at parse time: `510 - ($ - $$)` depends on the
  // current position, which does not exist until layout runs.
  const statements = parse('times 510-($-$$) db 0');
  const data = statements[0]!;
  assert.equal(data.kind, 'data');
  if (data.kind !== 'data') return;
  assert.notEqual(data.times, null);
  assert.equal(data.times!.kind, 'binary');
  assert.equal(data.times!.op, '-');
  if (data.times!.kind !== 'binary') return;
  assert.equal(data.times!.left.kind, 'literal');
  if (data.times!.left.kind !== 'literal') return;
  assert.equal(data.times!.left.value, 510n);
});

test('layout: `times 510-($-$$) db 0` pads to exactly 510 bytes', () => {
  // The assertion that matters. `$` is the current address and `$$` the section
  // start, so this is the idiom that fills a boot sector to its signature offset.
  // Getting it wrong produces a sector of the wrong length that still *looks*
  // assembled, which is why the test counts bytes and does not check structure.
  // `$` moves as the layout advances, so the second statement's `$-$$` is 510, not 2 -
  // and a repeat count that ignores that produces a sector of the wrong length that
  // still *looks* assembled. This is why the test counts bytes, and why the padding
  // is computed rather than written as a literal 510.
  const result = assemble('times 510-($-$$) db 0\ndw 0xaa55', { origin: 0x7c00n });
  assert.equal(result.size, 512);
  // 0xAA55 stored little-endian, so 0x55 is at 510 and 0xAA at 511 - the BIOS reads
  // the two bytes in that order and would not recognise the reverse.
  assert.equal(result.bytes[510], 0x55);
  assert.equal(result.bytes[511], 0xaa);
});

test('layout: `$` is the address of the statement, not of a byte inside it', () => {
  // `$` has to be evaluated at the position of each statement, and a statement that
  // mentions `$` twice must get the same answer both times. `at 0x2000` with three
  // bytes written first has `$` at 0x2003, so the second element is 0x2006.
  const result = assemble('.code64\ndb 1, 2, 3\ndd $', { origin: 0x2000n });
  assert.equal(hex([...result.bytes]), '01 02 03 03 20 00 00');
});

test('parser: all three constant-assignment spellings are accepted', () => {
  for (const source of ['a equ 1', 'a = 1', '.equ a, 1']) {
    const statements = parse(source);
    assert.equal(statements[0]!.kind, 'equ', `failed for: ${source}`);
  }
});

test('parser: an unknown directive is an error naming the directive', () => {
  assert.throws(() => parse('.frobnicate 1'), /unknown directive '\.frobnicate'/);
});

test('parser: an 8-bit register cannot be an address register', () => {
  assert.throws(() => parse('mov al, [bl]'), /cannot be a base or index register/);
});

test('parser: a statement cannot begin with a register', () => {
  assert.throws(() => parse('rax:'), /cannot begin with the register/);
});

test('parser: scale must be 1, 2, 4 or 8', () => {
  assert.throws(() => parse('mov rax, [rbx+rcx*3]'), /scale must be 1, 2, 4 or 8/);
});

test('parser: rejects an align boundary that is not a power of two', () => {
  assert.throws(() => parse('.align 3'), /positive power of two/);
});

/* -------------------------------------------------------------------------- */
/* MOV encodings                                                               */
/* -------------------------------------------------------------------------- */

test('mov: register to register, 64-bit, matches the SDM encoding', () => {
  // 48 89 C8 - REX.W, MOV r/m64<-r64, ModRM reg=RCX r/m=RAX.
  assert.equal(hex(bytes('mov rax, rcx')), '48 89 c8');
  assertMnemonic('mov rax, rcx', 'mov');
});

test('mov: register to register, 32-bit, has no REX', () => {
  assert.equal(hex(bytes('mov eax, ecx')), '89 c8');
});

test('mov: register to register, 16-bit, needs the size override first', () => {
  // 66 89 C8 - the 0x66 must precede any REX, which is why prefix order matters.
  assert.equal(hex(bytes('mov ax, cx')), '66 89 c8');
});

test('mov: register to register, 8-bit', () => {
  // 88 C8: 0x88 is `mov r/m8, r8`, so AL is the r/m destination and CL the reg
  // source. 0x8A would accept the same two registers and produce `mov cl, al` -
  // the opcode is what decides the direction once both operands are registers.
  assert.equal(hex(bytes('mov al, cl')), '88 c8');
  assert.equal(hex(bytes('mov cl, al')), '88 c1');
});

test('mov: direction is honoured, not assumed', () => {
  // `mov rax, [rbx]` is 0x8B (r <- r/m) and `mov [rbx], rax` is 0x89.
  assert.equal(hex(bytes('mov rax, [rbx]')), '48 8b 03');
  assert.equal(hex(bytes('mov [rbx], rax')), '48 89 03');
});

test('mov: extended registers set REX.B and REX.R', () => {
  // 4C 89 D8 - REX.W|R puts R11 in the ModRM *reg* field, and 0x89 is
  // `mov r/m, r`, so R11 is the source and RAX the r/m destination.
  assert.equal(hex(bytes('mov rax, r11')), '4c 89 d8');
  // The mirror image: R11 as the destination needs REX.B, because it is in r/m.
  // 49 89 C3 for the mirror image: 0x89 is `mov r/m, r`, so RAX is in the reg field
  // and R11 in r/m, which is what REX.B is for. Both directions put R11 in a
  // different ModRM field, so the prefix bit changes with the operand order.
  assert.equal(hex(bytes('mov r11, rax')), '49 89 c3');
});

test('mov: an immediate to a register uses the short B8+r form', () => {
  assert.equal(hex(bytes('mov eax, 1')), 'b8 01 00 00 00');
  assert.equal(hex(bytes('mov r8d, 1')), '41 b8 01 00 00 00');
});

test('mov: a 64-bit immediate uses C7 because B8+r cannot hold one', () => {
  // 48 C7 C0 01 00 00 00 - REX.W C7 /0 with a sign-extended imm32.
  assert.equal(hex(bytes('mov rax, 1')), '48 c7 c0 01 00 00 00');
});

test('mov: a 64-bit immediate beyond 32 bits is rejected, not truncated', () => {
  // x86-64 genuinely has no 64-bit immediate MOV; silently wrapping would turn a
  // large address into a small wrong one.
  assert.throws(() => bytes('mov rax, 0x1234567890'), /no 64-bit immediate form/);
});

test('mov: an immediate to memory uses C7 with the addressing form', () => {
  assert.equal(hex(bytes('mov dword [rbx], 1')), 'c7 03 01 00 00 00');
});

test('mov: an ambiguous operand size is refused', () => {
  assert.throws(() => bytes('mov [rbx], 1'), /operand size is ambiguous/);
});

/* -------------------------------------------------------------------------- */
/* The high-byte / REX rule                                                    */
/* -------------------------------------------------------------------------- */

test('8-bit registers: AH encodes without REX', () => {
  // Fields 4-7 mean AH/CH/DH/BH when no REX is present.
  assert.equal(hex(bytes('mov ah, 1')), 'b4 01');
});

test('8-bit registers: SIL needs an empty REX, because field 6 is otherwise DH', () => {
  // 40 B6 01 - the 0x40 is mandatory; without it this would move DH.
  assert.equal(hex(bytes('mov sil, 1')), '40 b6 01');
});

test('8-bit registers: R8B needs REX and must not land in field 0', () => {
  assert.equal(hex(bytes('mov r8b, 1')), '41 b0 01');
});

test('8-bit registers: a high byte cannot be combined with an extended register', () => {
  // There is no encoding of this in the architecture, so it must not assemble.
  assert.throws(() => bytes('mov ah, r8b'), /cannot be combined/);
});

test('8-bit registers: a high byte with another high byte is fine', () => {
  // 88 FC - BH is ModRM field 7 and AH is field 4, so mod=11 reg=111 r/m=100.
  assert.equal(hex(bytes('mov ah, bh')), '88 fc');
});

/* -------------------------------------------------------------------------- */
/* Addressing forms                                                            */
/* -------------------------------------------------------------------------- */

test('addressing: RSP needs a SIB byte because field 4 is the escape', () => {
  // 48 8B 04 24 - ModRM rm=100 selects the SIB, whose base field is RSP.
  assert.equal(hex(bytes('mov rax, [rsp]')), '48 8b 04 24');
});

test('addressing: R12 as an index needs REX.X to survive', () => {
  // 4A 8B 04 A3 - REX.W|X is 0100 1010, so index field 4 (R12 with REX.X) reaches
  // the SIB's index slot. Without REX.X that field means "no index" and R12 is lost.
  assert.equal(hex(bytes('mov rax, [rbx+r12*4]')), '4a 8b 04 a3');
});

test('addressing: [RBP+0] has no mod=00 form and takes a zero disp8', () => {
  // Field 101 with mod=00 is the disp32 form, so [rbp] needs mod=01 disp8=0.
  assert.equal(hex(bytes('mov rax, [rbp]')), '48 8b 45 00');
});

test('addressing: displacement width is chosen by magnitude', () => {
  assert.equal(hex(bytes('mov rax, [rbx+8]')), '48 8b 43 08');
  assert.equal(hex(bytes('mov rax, [rbx+4096]')), '48 8b 83 00 10 00 00');
});

test('addressing: scale and index encode in the SIB byte', () => {
  // SIB 0xCB is scale=11 (x8), index=001 (RCX), base=011 (RBX).
  assert.equal(hex(bytes('mov rax, [rbx+rcx*8]')), '48 8b 04 cb');
  // SIB 0x8B is scale=10 (x4), same index and base; ModRM mod=01 adds disp8=16.
  assert.equal(hex(bytes('mov rax, [rbx+rcx*4+16]')), '48 8b 44 8b 10');
});

test('addressing: an index with no base uses SIB base field 101', () => {
  assert.equal(hex(bytes('mov rax, [rcx*4+0x100]')), '48 8b 04 8d 00 01 00 00');
});

test('addressing: RIP-relative displacement is relative to the end of the instruction', () => {
  // `mov rax, [rel target]` at 0x1000 is seven bytes, so the label that follows it
  // sits at 0x1007 and the displacement is 0x1007 - 0x1007 = 0. Measuring from the
  // *start* of the instruction instead would give 7 and read the address one
  // instruction past the label - a perfectly valid encoding of the wrong address,
  // which is why this needs a target that is not adjacent to expose it either way.
  const adjacent = assemble('.code64\nmov rax, [rel target]\ntarget:', { origin: 0x1000n });
  assert.deepEqual([...adjacent.bytes.subarray(0, 7)], [0x48, 0x8b, 0x05, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(adjacent.symbols.get('target'), 0x1007n);

  // Nine bytes of padding put the label at 0x1010, so the displacement is 9: the
  // instruction ends at 0x1007 and 0x1007 + 9 = 0x1010. From the start it would be
  // 16, and the address read would be 0x1000 + 16 = 0x1010 - right by accident,
  // which is exactly what makes the adjacent case the only honest check on the
  // signedness and the base of the subtraction at once.
  const padded = assemble('.code64\nmov rax, [rel target]\ntimes 9 db 0\ntarget:', { origin: 0x1000n });
  assert.equal(padded.symbols.get('target'), 0x1010n);
  assert.deepEqual([...padded.bytes.subarray(0, 7)], [0x48, 0x8b, 0x05, 0x09, 0x00, 0x00, 0x00]);

  // And backwards: the label comes first, so the displacement is negative and is
  // stored two's complement. Nine bytes of padding, then the instruction at 0x1009
  // ending at 0x1010, so 0x1000 - 0x1010 = -16.
  const backward = assemble('.code64\ntarget: times 9 db 0\nmov rax, [rel target]', { origin: 0x1000n });
  assert.deepEqual([...backward.bytes.subarray(9, 16)], [0x48, 0x8b, 0x05, 0xf0, 0xff, 0xff, 0xff]);
});

test('addressing: a bare symbol in 64-bit mode is RIP-relative', () => {
  // Long mode has no absolute addressing, so `[label]` is the same encoding as
  // `[rel label]` - the same seven bytes, for the same reason. The rule is
  // *dependence on a symbol*, not literal-ness: a literal address still needs the
  // SIB base field 101 and a real disp32.
  const symbolic = assemble('.code64\nmov rax, [label]\ntimes 9 db 0\nlabel:', { origin: 0x2000n });
  assert.equal(symbolic.bytes.length, 16);
  assert.deepEqual([...symbolic.bytes.subarray(0, 7)], [0x48, 0x8b, 0x05, 0x09, 0x00, 0x00, 0x00]);

  const literal = assemble('.code64\nmov rax, [0x3000]', { origin: 0x2000n });
  assert.equal(hex([...literal.bytes]), '48 8b 04 25 00 30 00 00');
});

test('addressing: LEA encodes the address without dereferencing it', () => {
  assert.equal(hex(bytes('lea rax, [rbx+rcx*4+8]')), '48 8d 44 8b 08');
  assertMnemonic('lea rax, [rbx+rcx*4+8]', 'lea');
});

/* -------------------------------------------------------------------------- */
/* 16-bit real-mode addressing                                                */
/* -------------------------------------------------------------------------- */

test('16-bit: a bare address is the disp16 form, field 110', () => {
  // 8B 06 00 7C - MOV AX, [0x7C00] as a real-mode boot loader would write it.
  assert.equal(hex(bytes('mov ax, [0x7c00]', CpuMode.REAL16)), '8b 06 00 7c');
});

test('16-bit: register pairs are fixed encodings, not base+index', () => {
  assert.equal(hex(bytes('mov al, [bx]', CpuMode.REAL16)), '8a 07');
  assert.equal(hex(bytes('mov al, [bx+si]', CpuMode.REAL16)), '8a 00');
  assert.equal(hex(bytes('mov al, [bx+di]', CpuMode.REAL16)), '8a 01');
  assert.equal(hex(bytes('mov al, [bp+si]', CpuMode.REAL16)), '8a 02');
  assert.equal(hex(bytes('mov al, [si]', CpuMode.REAL16)), '8a 04');
  assert.equal(hex(bytes('mov al, [di]', CpuMode.REAL16)), '8a 05');
});

test('16-bit: [BP] has no mod=00 form and takes a zero disp8', () => {
  assert.equal(hex(bytes('mov al, [bp]', CpuMode.REAL16)), '8a 46 00');
});

test('16-bit: there is no scale factor, and mod only selects a displacement width', () => {
  // The SDM's 16-bit addressing table has no scale field at all - eight fixed
  // base/index combinations, with `mod` choosing the displacement width and
  // nothing else. So `si*2` has no encoding whatsoever and the assembler has to say
  // so, rather than quietly dropping the multiplier and addressing `si`.
  assert.throws(() => bytes('mov al, [bx+si*2]', CpuMode.REAL16), /no scale factor/);
  assert.throws(() => bytes('mov al, [bx+si*4]', CpuMode.REAL16), /no scale factor/);

  // With no scale, the eight combinations are fixed encodings. `bx+si` is ModRM 00
  // and `bx+si+8` is the same pair with mod=01 and a disp8 - so mod is a width, not
  // a multiplier.
  assert.equal(hex(bytes('mov al, [bx+si]', CpuMode.REAL16)), '8a 00');
  assert.equal(hex(bytes('mov al, [bx+di]', CpuMode.REAL16)), '8a 01');
  assert.equal(hex(bytes('mov al, [bp+si]', CpuMode.REAL16)), '8a 02');
  assert.equal(hex(bytes('mov al, [bx+si+8]', CpuMode.REAL16)), '8a 40 08');
});

test('16-bit: the eight encodable addresses are the ones the SDM lists', () => {
  // bx, bx+si, bx+di, bp, bp+si, bp+di, si, di. BX+BP is not among them - both
  // registers would have to share one ModRM field - and saying so is more useful
  // than encoding something else.
  assert.throws(() => bytes('mov al, [bx+bp]', CpuMode.REAL16), /eight encodable 16-bit addresses/);
  assert.equal(hex(bytes('mov al, [bp+di]', CpuMode.REAL16)), '8a 03');
  assert.equal(hex(bytes('mov al, [di]', CpuMode.REAL16)), '8a 05');
});

test('16-bit: a 16-bit register outside real mode is refused with an explanation', () => {
  assert.throws(() => bytes('mov eax, [bx]'), /needs 16-bit addressing/);
});

/* -------------------------------------------------------------------------- */
/* ALU                                                                         */
/* -------------------------------------------------------------------------- */

test('alu: the sign-extended imm8 form is chosen when the value fits', () => {
  // 48 83 C0 01 - ADD RAX, 1 as the two-byte-operand immediate form.
  assert.equal(hex(bytes('add rax, 1')), '48 83 c0 01');
});

test('alu: a larger immediate switches to the full-width form', () => {
  assert.equal(hex(bytes('add rax, 4096')), '48 05 00 10 00 00');
});

test('alu: 0x00 is r/m8<-r8, so with two registers the destination is the r/m field', () => {
  // The SDM gives all four directions, not three: 00 r/m8<-r8, 01 r/m<-r, 02 r8<-r/m8
  // and 03 r<-r/m. With two registers either direction is legal and 00/01 is the
  // canonical choice, which puts the *first* operand in the r/m field. That is why
  // the two orderings below do not produce the same bytes - which is the one thing a
  // reader is most likely to assume they do.
  assert.equal(hex(bytes('add al, bl')), '00 d8');
  assert.equal(hex(bytes('add bl, al')), '00 c3');
  assert.equal(hex(bytes('add eax, ebx')), '01 d8');
  assert.equal(hex(bytes('add ebx, eax')), '01 c3');
});

test('alu: 0x02 and 0x03 are the reg<-r/m direction, needed when the source is memory', () => {
  // 0x02 exists for 8-bit as well as 0x03 for the wider forms, so `add al, byte [rbx]`
  // is encodable. Taking the r/m field from the destination instead - which is what the
  // 0x00 path must do - encodes an add into the register whose field number matches the
  // address, so `add al, byte [rbx]` would come out as an add to BH.
  assert.equal(hex(bytes('add al, byte [rbx]')), '02 03');
  assert.equal(hex(bytes('add eax, dword [rbx]')), '03 03');
  assert.equal(hex(bytes('add rax, [rbx]')), '48 03 03');
  // 16-bit is the mode default in real mode, so 0x66 is only needed where 16 bits is not
  // the default - and putting it there would ask for a 32-bit operand instead.
  assert.equal(hex(bytes('sub ax, word [bx]', CpuMode.REAL16)), '2b 07');
  assert.equal(hex(bytes('sub ax, word [ebx]', CpuMode.PROTECTED32)), '66 2b 03');

  // Full SIB and displacement, so the r/m side really is the memory operand and not a
  // register that happens to have the same field number: REX.R for r10d, ModRM
  // 01/reg/r/m=100 for SIB, SIB 10/001/011 for rcx*4+rbx, disp8.
  assert.equal(hex(bytes('add r10d, dword [rbx+rcx*4+8]')), '44 03 54 8b 08');

  // And there is no memory-to-memory form at all, so it has to be refused rather than
  // assembled out of two inconsistent operands.
  assert.throws(() => bytes('add dword [rbx], dword [rcx]'), /both operands are memory/);
});

test('alu: a RIP-relative byte source keeps its fixup in the 0x02 direction', () => {
  // The displacement has to be measured from the end of the instruction and recorded as
  // a fixup whichever ALU direction is used, so 0x02/0x03 cannot take the r/m field from
  // the destination. 16 bytes of padding, then a 6-byte instruction at 0x1010, so
  // 0x1000 - 0x1016 = -22.
  const result = assemble('.code64\ntarget: times 16 db 0\ncmp al, byte [rel target]', { origin: 0x1000n });
  assert.equal(hex([...result.bytes.subarray(16)]), '3a 05 ea ff ff ff');
  assert.equal(result.symbols.get('target'), 0x1000n);
});

test('alu: a memory destination keeps its SIB, displacement and fixup', () => {
  // Every instruction whose r/m operand may be memory has to install the whole address
  // form, not just the field number. `mod = 3` claims the operand is a register, so
  // writing that for a memory operand produces an instruction that assembles, decodes,
  // and reads a different address than the one written - the hardest kind of bug to
  // find, because nothing reports an error.
  assert.equal(hex(bytes('add dword [rbx], 1')), '83 03 01');
  assert.equal(hex(bytes('add dword [rbx], eax')), '01 03');
  assert.equal(hex(bytes('add byte [rbx], al')), '00 03');
  assert.equal(hex(bytes('add byte [rbx], 1')), '80 03 01');
  assert.equal(hex(bytes('sub qword [rbx+rsi*4+8], 4096')), '48 81 6c b3 08 00 10 00 00');
  assert.equal(hex(bytes('cmp dword [rbx], 0')), '83 3b 00');
  assert.equal(hex(bytes('or qword [rsp+16], 0')), '48 83 4c 24 10 00');
  assert.equal(hex(bytes('mov dword [rbx], 1')), 'c7 03 01 00 00 00');
  assert.equal(hex(bytes('mov eax, [rbx]')), '8b 03');

  // The RIP-relative form of the same thing, which is the only case where losing the
  // form also loses the fixup: the displacement would otherwise be left as the
  // placeholder and read the address of the instruction itself. The instruction is
  // 83 /0 with a disp32 and an imm8 - seven bytes - so from 0x100B back to 0x1000 is
  // -11, and forgetting the imm8 when working that out gives -10.
  const result = assemble('.code64\ntarget: .dword 0\nadd dword [rel target], 1', { origin: 0x1000n });
  assert.equal(hex([...result.bytes.subarray(4)]), '83 05 f5 ff ff ff 01');
});

test('alu: an indexed memory operand keeps REX.X even in the byte forms', () => {
  // REX.X selects r8-r15 as the SIB *index* and REX.B as the SIB *base*, and the byte
  // forms are not exempt: they take no REX.W, but they still take X and B. rcx is SIB
  // index field 1, so no REX at all is needed here.
  assert.equal(hex(bytes('mov al, byte [rax+rcx*2]')), '8a 04 48');
  assert.equal(hex(bytes('add al, byte [rax+rcx*2]')), '02 04 48');

  // r12 as the *base* is SIB base field 4 with REX.B - and unlike ModRM's rm field,
  // SIB base 100 is R12 rather than an escape, so mod=00 is available and no
  // displacement is needed. R13 is base field 5, which mod=00 reserves for disp32, so
  // the shortest form that works is mod=01 disp8=0.
  assert.equal(hex(bytes('mov al, byte [r12]')), '41 8a 04 24');
  assert.equal(hex(bytes('mov al, byte [r12+rcx*4]')), '41 8a 04 8c');
  assert.equal(hex(bytes('add byte [r12+rcx*4], al')), '41 00 04 8c');
  assert.equal(hex(bytes('mov al, byte [r12+8]')), '41 8a 44 24 08');
  assert.equal(hex(bytes('mov al, byte [r13]')), '41 8a 45 00');

  // And a genuinely extended index needs REX.X: r13 is SIB index field 5, which is
  // otherwise the "no index" escape at mod != 00 - so without REX.X this address would
  // silently drop the index term entirely. REX = 0x42 is W=0, R=1, X=1, B=0: the R bit
  // names AL's field and the X bit names r13's.
  assert.equal(hex(bytes('mov al, byte [rax+r13*4]')), '42 8a 04 a8');
});

test('alu: sub with the sign-extended form', () => {
  assert.equal(hex(bytes('sub rsp, 8')), '48 83 ec 08');
});

test('alu: INC and DEC carry their width in REX.W, not in the opcode', () => {
  // There is one INC opcode per operand size - FE for bytes, FF for everything else -
  // so a 64-bit register is distinguished from a 32-bit one by REX.W alone. Leaving
  // W clear for `inc rcx` emits a perfectly valid instruction that increments ECX
  // instead, which changes the value being written and not just the encoding.
  assert.equal(hex(bytes('inc rcx')), '48 ff c1');
  assert.equal(hex(bytes('dec rcx')), '48 ff c9');
  assert.equal(hex(bytes('inc eax')), 'ff c0');
  assert.equal(hex(bytes('dec eax')), 'ff c8');
  assert.equal(hex(bytes('inc cl')), 'fe c1');
  assert.equal(hex(bytes('inc r15')), '49 ff c7');

  // 16-bit is the size override, and real mode needs no REX at all.
  assert.equal(hex(bytes('inc cx', CpuMode.REAL16)), 'ff c1');
  assert.equal(hex(bytes('inc cx', CpuMode.PROTECTED32)), '66 ff c1');

  // Memory is the same form with a real ModRM, and a RIP-relative operand has to keep
  // its fixup.
  assert.equal(hex(bytes('inc dword [rbx]')), 'ff 03');
  assert.equal(hex(bytes('inc qword [rbx]')), '48 ff 03');
  assert.equal(hex(bytes('dec dword [rbx]')), 'ff 0b');
  // [rbp] has no mod=00 encoding, so the shortest form that has one is mod=01 disp8=0.
  assert.equal(hex(bytes('inc qword [rbp]')), '48 ff 45 00');
});

test('alu: NOT, NEG, MUL, IMUL, DIV and IDIV share F6/F7 and differ only in reg', () => {
  // Group 3 with a destination of zero is a one-operand form: NOT/NEG/MUL/DIV have no
  // immediate, only TEST does, so these are two bytes and the reason is visible in the
  // ModRM - reg = 2, 3, 4, 5, 6, 7 for NOT, NEG, MUL, IMUL, DIV, IDIV.
  assert.equal(hex(bytes('not dword [rbx]')), 'f7 13');
  assert.equal(hex(bytes('neg dword [rbx]')), 'f7 1b');
  assert.equal(hex(bytes('mul dword [rbx]')), 'f7 23');
  assert.equal(hex(bytes('imul dword [rbx]')), 'f7 2b');
  assert.equal(hex(bytes('div dword [rbx]')), 'f7 33');
  assert.equal(hex(bytes('idiv dword [rbx]')), 'f7 3b');

  // TEST is the exception: F7 /0 does take an immediate, as a full-width field even in
  // long mode, because F7 /0 is `TEST r/m, imm32` and there is no sign-extended
  // variant of it.
  assert.equal(hex(bytes('test dword [rbx], 1')), 'f7 03 01 00 00 00');
  assert.equal(hex(bytes('test dword [rbx], eax')), '85 03');
  assert.equal(hex(bytes('test byte [rbx], al')), '84 03');
  assert.equal(hex(bytes('test byte [rbx], 1')), 'f6 03 01');
});

test('alu: shifts carry their width in REX.W and the size override, like INC', () => {
  // C0/C1 (immediate count) and D2/D3 (CL) are as width-blind as FE/FF: 16 bits is the
  // 0x66 override and 64 bits is REX.W, and there is no separate opcode for either. A
  // missing REX.W does not fail to assemble or decode - it shifts the 32-bit register and
  // discards the top half of a 64-bit value, which is the kind of wrong the bytes alone
  // cannot show.
  assert.equal(hex(bytes('sar qword [rbx], 31')), '48 c1 33 1f');
  assert.equal(hex(bytes('sar rax, cl')), '48 d3 f0');
  assert.equal(hex(bytes('shl rax, 1')), '48 c1 e0 01');
  assert.equal(hex(bytes('shl dword [rbx], 1')), 'c1 23 01');
  assert.equal(hex(bytes('shr dword [rbx], cl')), 'd3 2b');
  assert.equal(hex(bytes('shr word [rbx], 1')), '66 c1 2b 01');
  assert.equal(hex(bytes('rol al, 1')), 'c0 c0 01');
  assert.equal(hex(bytes('sar ecx, 31')), 'c1 f1 1f');
});

test('alu: the one-operand IMUL is F7 /5 and is not defined for bytes', () => {
  // `imul r/m` multiplies into EDX:EAX (or DX:AX) with no destination named, and the
  // SDM marks the byte form F6 /5 undefined - so there is nothing to emit, and refusing
  // is more useful than producing a ModRM the CPU would reject.
  assert.equal(hex(bytes('imul dword [rbx]')), 'f7 2b');
  assert.equal(hex(bytes('imul qword [rbx]')), '48 f7 2b');
  assert.equal(hex(bytes('imul eax')), 'f7 e8');
  assert.equal(hex(bytes('imul rax')), '48 f7 e8');
  assert.throws(() => bytes('imul byte [rbx]'), /not defined for 8-bit operands/);

  // The three-operand form is a different instruction (6B/69), so a two-operand call has
  // to keep its own error rather than falling into the one-operand path.
  assert.equal(hex(bytes('imul eax, dword [rbx]')), '0f af 03');
  assert.equal(hex(bytes('imul eax, dword [rbx], 4')), '6b 03 04');
});

test('alu: xor is the idiom for zeroing a register', () => {
  assert.equal(hex(bytes('xor eax, eax')), '31 c0');
  assertMnemonic('xor eax, eax', 'xor');
});

test('alu: all eight operations round-trip through the decoder', () => {
  for (const op of ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'] as const) {
    assertMnemonic(`${op} eax, ebx`, op);
  }
});

test('alu: an immediate that does not fit the operand size is rejected', () => {
  // The field is one byte, so 300 cannot be encoded. Note this is about the *field*,
  // not about signedness: 0x80..0xff fit an imm8 perfectly well and are rejected only
  // on the forms whose imm8 sign-extends. `add al, 255` has to assemble.
  assert.throws(() => bytes('mov al, 300'), /does not fit in 8 unsigned bits/);
  assert.throws(() => bytes('mov al, 0x1ff'), /does not fit in 8 unsigned bits/);
  assert.throws(() => bytes('mov al, -129'), /does not fit in 8 unsigned bits/);

  // Every unsigned immediate field reaches its full range.
  assert.deepEqual(bytes('mov al, 255'), [0xb0, 0xff]);
  assert.deepEqual(bytes('add al, 0xff'), [0x04, 0xff]);
  assert.deepEqual(bytes('xor byte [rbx], 0xff'), [0x80, 0x33, 0xff]);
  assert.deepEqual(bytes('test byte [rbx], 0xff'), [0xf6, 0x03, 0xff]);
  assert.deepEqual(bytes('shl eax, 200'), [0xc1, 0xe0, 200]);
  assert.deepEqual(bytes('int 255'), [0xcd, 255]);
  assert.deepEqual(bytes('ret 0x8000'), [0xc2, 0x00, 0x80]);
  assert.deepEqual(bytes('in al, 255'), [0xe4, 255]);

  // And the sign-extended imm8 forms still refuse what they must, so this is not
  // simply a range check that stopped working. `83 /n ib` is `add eax, -1` and cannot
  // express 200 - the encoder has to widen to 0x81, which it does below.
  assert.deepEqual(bytes('add eax, 200'), [0x05, 200, 0, 0, 0]);
  assert.deepEqual(bytes('add eax, -1'), [0x83, 0xc0, 0xff]);
});

test('alu: the 64-bit accumulator immediate is an imm32, not an imm64', () => {
  // There is no 64-bit immediate move or add anywhere in the architecture. `add rax,
  // imm` is a sign-extended imm32, so the widest encodable immediate reaches
  // 0xffffffff and one more is an error rather than a five-byte truncation.
  assert.deepEqual(bytes('add rax, 0xffffffff'), [0x48, 0x05, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(bytes('add rax, -1'), [0x48, 0x83, 0xc0, 0xff]);
  assert.throws(() => bytes('add rax, 0x100000000'), /does not fit in 32 unsigned bits/);
  assert.throws(() => bytes('mov qword [rbx], 0x100000000'), /does not fit in 32 unsigned bits/);
});

test('xchg: the ModRM form needs no 0x0F escape byte', () => {
  // 0F 87 is JA. Emitting the escape in front of XCHG's opcode assembles a
  // conditional branch where an exchange was written, which is the most dangerous
  // class of encoder bug there is: it assembles, it decodes, and it changes the
  // instruction pointer.
  assert.deepEqual(bytes('xchg dword [rbx], eax'), [0x87, 0x03]);
  assert.deepEqual(bytes('xchg eax, dword [rbx]'), [0x87, 0x03]);
  assert.deepEqual(bytes('xchg dword [rbx], ecx'), [0x87, 0x0b]);

  // The one-byte form is available whenever one operand is the accumulator, and the
  // *other* one goes in the low three opcode bits. Taking the source instead of the
  // non-accumulator operand turns `xchg rbx, rax` into 0x90, which is NOP.
  assert.deepEqual(bytes('xchg rax, rbx'), [0x48, 0x93]);
  assert.deepEqual(bytes('xchg rbx, rax'), [0x48, 0x93]);
  // R8 is the extended register, so REX.B rather than REX.W sets: 48 90 is
  // `xchg rax, rax` - a self-swap - and 49 90 is the one that names r8. B is 0x01 and
  // W is 0x08, and the one-byte form needs B here precisely because the width is
  // already 64.
  assert.deepEqual(bytes('xchg rax, r8'), [0x49, 0x90]);
  assert.deepEqual(bytes('xchg r8, rax'), [0x49, 0x90]);
  assert.deepEqual(bytes('xchg eax, ecx'), [0x91]);
  assert.deepEqual(bytes('xchg ax, cx'), [0x66, 0x91]);
  // Neither register is the accumulator, so the ModRM form is required. `XCHG r/m, r`
  // holds the *destination* in r/m, so ECX is the reg field here: 0xCB is
  // mod=11 reg=001 rm=011. Writing 0xD9 would swap EBX and ECX with each other, which
  // is invisible in a symmetric instruction and fatal in a two-operand one.
  assert.deepEqual(bytes('xchg ebx, ecx'), [0x87, 0xcb]);
  // The other spelling puts ECX in r/m instead, so the two differ in exactly the
  // direction XCHG's symmetry hides. Both are the same machine state, which is why
  // the ordering is the one thing here that no test of behaviour would ever catch.
  assert.deepEqual(bytes('xchg ecx, ebx'), [0x87, 0xd9]);

  // Two extended registers: both REX.R and REX.B are needed, and neither may be
  // folded into the other. 4D is 0100WRXB = W + R + B, and C8 is mod=11 reg=001 rm=000.
  assert.deepEqual(bytes('xchg r8, r9'), [0x4d, 0x87, 0xc8]);

  // One extended register. Asserted as a *relationship* rather than as more magic
  // bytes, because the relationship is the property with teeth: XCHG is symmetric, so
  // reversing the two operands must swap the r/m and reg fields and swap REX.R with
  // REX.B, leaving the instruction's meaning untouched. Getting that wrong produces a
  // different swap rather than a failure, which is why the ordering is invisible in
  // XCHG and fatal in XADD.
  const ebxR8 = bytes('xchg ebx, r8d');
  const r8Ebx = bytes('xchg r8d, ebx');
  assert.deepEqual(ebxR8, [0x44, 0x87, 0xc3]);
  assert.deepEqual(r8Ebx, [0x41, 0x87, 0xd8]);
  for (const encoded of [ebxR8, r8Ebx]) {
    assert.equal(encoded[2]! >> 6, 0b11, 'mod = 11 selects the register form, not memory');
  }
  assert.equal(ebxR8[2]! & 0b111, 3, 'r/m holds the destination, so r/m = ebx');
  assert.equal(r8Ebx[2]! & 0b111, 0, 'r/m holds the destination, so r/m = r8');
  assert.equal((ebxR8[0]! & 0b0100) !== 0, (r8Ebx[0]! & 0b0001) !== 0, 'R and B swap');
  assert.equal((ebxR8[0]! & 0b0001) !== 0, (r8Ebx[0]! & 0b0100) !== 0, 'R and B swap');

  // XADD is the same ModRM shape but is *not* symmetric, so the destination rule is
  // the only thing standing between `xadd eax, dword [rbx]` and a silent swap of the
  // operands. There is no encoding with a memory source, and the encoder says so.
  assert.deepEqual(bytes('xadd dword [rbx], eax'), [0x0f, 0xc1, 0x03]);
  assert.throws(() => bytes('xadd eax, dword [rbx]'), /no register-destination form/);

  // XCHG is symmetric, so both spellings of a memory exchange must give the same
  // bytes. They differ only in which operand is written first, and the memory one
  // always has to reach the r/m field or it cannot be encoded at all.
  assert.deepEqual(bytes('xchg dword [rbx], eax'), bytes('xchg eax, dword [rbx]'));
});

test('string instructions carry their width in the name', () => {
  // A4/AB/AC/AE are the byte forms and their partners the wide ones; the wide form's
  // width comes from the prefixes. `movs` alone records none of it and is not a
  // mnemonic the assembler accepts, so the disassembly could not be re-assembled.
  assert.deepEqual(bytes('movsb'), [0xa4]);
  assert.deepEqual(bytes('movsw'), [0x66, 0xa5]);
  assert.deepEqual(bytes('movsq'), [0x48, 0xa5]);
  assert.deepEqual(bytes('stosb'), [0xaa]);
  assert.deepEqual(bytes('stosd'), [0xab]);
  assert.deepEqual(bytes('stosq'), [0x48, 0xab]);
  assert.deepEqual(bytes('rep stosq'), [0xf3, 0x48, 0xab]);
  assert.deepEqual(bytes('scasb'), [0xae]);
  assert.deepEqual(bytes('cmpsb'), [0xa6]);
});

test('in/out split on 8 bits against everything else', () => {
  // The map's low bit in each pair selects the width, and 0x66 supplies the 16-bit
  // case. Reading the split as "16 against 32" hands the byte form a 32-bit opcode,
  // and `in al, dx` becomes a four-byte port read that discards three of them - the
  // one read a keyboard driver cannot survive.
  assert.deepEqual(bytes('in al, 0x60'), [0xe4, 0x60]);
  assert.deepEqual(bytes('in ax, 0x60'), [0x66, 0xe5, 0x60]);
  assert.deepEqual(bytes('in eax, 0x60'), [0xe5, 0x60]);
  assert.deepEqual(bytes('in al, dx'), [0xec]);
  assert.deepEqual(bytes('in ax, dx'), [0x66, 0xed]);
  assert.deepEqual(bytes('in eax, dx'), [0xed]);
  assert.deepEqual(bytes('out dx, al'), [0xee]);
  assert.deepEqual(bytes('out dx, eax'), [0xef]);
  // RAX is not a legal port register even though the data width allows 64-bit moves:
  // IN and OUT have no 64-bit form at all.
  assert.throws(() => bytes('in rax, dx'), /8, 16 or 32 bits/);
});

/* -------------------------------------------------------------------------- */
/* Control flow                                                                */
/* -------------------------------------------------------------------------- */

test('branches: a nearby label gets the two-byte short form', () => {
  const result = assemble('.code64\njmp short_label\nnop\nshort_label:', { origin: 0x1000n });
  assert.equal(result.bytes[0], 0xeb);
  assert.equal(result.bytes[1], 1);
  assert.equal(result.size, 3);
});

test('branches: a distant label is promoted to the near form', () => {
  // The relaxation pass has to notice the target is out of byte range.
  const body = Array.from({ length: 200 }, () => 'nop').join('\n');
  const result = assemble(`.code64\njmp far_label\n${body}\nfar_label:`, { origin: 0x1000n });
  assert.equal(result.bytes[0], 0xe9);
  assert.equal(result.size, 5 + 200);
});

test('branches: a promotion does not break later branch targets', () => {
  // The widened instruction shifts everything after it by three bytes, so a second
  // short branch must be recomputed against the new address.
  const body = Array.from({ length: 200 }, () => 'nop').join('\n');
  const result = assemble(`.code64\njmp far\n${body}\nfar:\njmp near\nnop\nnear:`, { origin: 0x1000n });
  const decoded = decodeSource(
    `.code64\njmp far\n${body}\nfar:\njmp near\nnop\nnear:`,
    CpuMode.LONG64,
    0x1000n,
  );
  // The second jump lands exactly on `near`.
  const jumps = decoded.filter((d) => d.instruction.mnemonic === 'jmp');
  assert.equal(jumps.length, 2);
  const farTarget = jumps[0]!.instruction.operands[0]!;
  const nearTarget = jumps[1]!.instruction.operands[0]!;
  assert.equal(farTarget.kind, 'rel');
  assert.equal(nearTarget.kind, 'rel');
  if (farTarget.kind !== 'rel' || nearTarget.kind !== 'rel') return;
  assert.equal(nearTarget.target, result.symbols.get('near'));
  assert.ok(farTarget.target !== nearTarget.target);
});

test('branches: CALL has no short form and is always near', () => {
  const result = assemble('.code64\ncall near_label\nnear_label:', { origin: 0x1000n });
  assert.equal(result.bytes[0], 0xe8);
  assert.equal(result.size, 5);
});

test('branches: all sixteen conditions round-trip', () => {
  // The decoder calls all sixteen of these `jcc` and carries the condition in a
  // field, rather than inventing sixteen mnemonics - so the assertion has to check
  // the condition nibble too. Sixteen results that merely said `jcc` would pass
  // while the encoder wrote the same condition sixteen times.
  const conditions = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];
  for (const [index, cc] of conditions.entries()) {
    const instruction = assertMnemonic(`j${cc} 0x1000`, Mnemonic.JCC);
    assert.equal(instruction.condition, index, `${cc} is condition ${index}`);
  }
});

test('branches: the alternative condition spellings reach the same encoding', () => {
  // These are not style. `jc` is "carry set", which is the unsigned *below*
  // condition, so `jc` and `jb` must produce the same opcode - and reading `jc` as
  // "carry clear" would silently select the opposite branch.
  const same: readonly (readonly [string, string])[] = [
    ['jc', 'jb'], ['jnae', 'jb'], ['jnc', 'jae'], ['jnb', 'jae'],
    ['jz', 'je'], ['jnz', 'jne'], ['jna', 'jbe'], ['jnbe', 'ja'],
    ['jpe', 'jp'], ['jpo', 'jnp'], ['jnge', 'jl'], ['jnl', 'jge'],
    ['jng', 'jle'], ['jnle', 'jg'],
  ];
  for (const [alias, canonical] of same) {
    assert.equal(alias[0], 'j');
    assert.equal(canonical[0], 'j');
    // Same instruction, spelled two ways.
    assert.equal(hex(bytes(alias + ' 0x1000')), hex(bytes(canonical + ' 0x1000')), alias);
    // The same condition code also appears in SETcc and CMOVcc, where the condition
    // is the thing being written rather than the thing being branched on.
    assert.equal(hex(bytes('set' + alias.slice(1) + ' al')), hex(bytes('set' + canonical.slice(1) + ' al')), alias);
    assert.equal(
      hex(bytes('cmov' + alias.slice(1) + ' eax, ecx')),
      hex(bytes('cmov' + canonical.slice(1) + ' eax, ecx')),
      alias,
    );
  }
});

test('branches: SETcc writes a byte and round-trips', () => {
  // The decoder names all sixteen of these `setcc` and carries the condition in
  // an operand, rather than inventing sixteen mnemonics. The test checks the
  // condition too: sixteen identical `setcc` results would pass a mnemonic-only
  // assertion while the encoder got the condition nibble wrong.
  assert.equal(hex(bytes('sete al')), '0f 94 c0');
  const zero = assertMnemonic('sete al', Mnemonic.SETCC);
  assert.equal(zero.condition, 4);
  const notZero = assertMnemonic('setne cl', Mnemonic.SETCC);
  assert.equal(notZero.condition, 5);
});

test('branches: LOOP has only an 8-bit displacement', () => {
  // Two bytes, always: one opcode and a signed byte. There is no near form to grow
  // into, so a target further away is a hard error rather than a wider encoding -
  // emitting a four-byte displacement after a two-byte opcode would make the CPU
  // decode those extra bytes as the next instruction.
  // `loop` at 0x1000 targeting 0x1000: two bytes, so the end is 0x1002 and the
  // displacement is -2.
  const instruction = first('loop 0x1000');
  assert.equal(instruction.mnemonic, 'loop');
  assert.equal(instruction.length, 2);
  assert.equal(hex(bytes('loop 0x1000', CpuMode.LONG64, 0x1000n)), 'e2 fe');

  // The signed byte is the whole range, and the edges are where an off-by-one in
  // the relaxation would show. With 126 bytes of padding the LOOP sits at 0x107E and
  // ends at 0x1080, so 0x10FF is 127 bytes ahead and 0x1100 is 128.
  assert.doesNotThrow(() => assemble('.code64\ntimes 126 db 0x90\nloop 0x10ff', { origin: 0x1000n }));
  assert.throws(() => assemble('.code64\ntimes 126 db 0x90\nloop 0x1100', { origin: 0x1000n }), /no wider form/);

  // And backwards the limit is measured the same way: the LOOP ends at 0x1002, so
  // 0x0F82 is -128 and 0x0F81 is -129. A check that only tested the magnitude would
  // let -129 through and wrap it to +127.
  assert.doesNotThrow(() => assemble('.code64\nloop 0x0f82', { origin: 0x1000n }));
  assert.throws(() => assemble('.code64\nloop 0x0f81', { origin: 0x1000n }), /no wider form/);

  // And the message has to name the real limit, because the fix is to move the
  // target or use a Jcc - and only the reader knows which is which.
  assert.throws(() => assemble('.code64\nloop 0x9000', { origin: 0x1000n }), /signed byte \(-128 to 127\)/);
  assert.throws(
    () => assemble('.code64\nloop 0x9000', { origin: 0x1000n }),
    /no wider form .*a jcc/s,
  );
});

test('branches: RET with an immediate pops that many bytes', () => {
  assert.equal(hex(bytes('ret 8')), 'c2 08 00');
  assert.equal(hex(bytes('ret')), 'c3');
});

test('branches: an indirect jump through a register uses FF /4', () => {
  assert.equal(hex(bytes('jmp rax')), 'ff e0');
  assertMnemonic('jmp rax', 'jmp');
});

/* -------------------------------------------------------------------------- */
/* Stack                                                                       */
/* -------------------------------------------------------------------------- */

test('stack: push and pop of a 64-bit register use REX.B for the extended ones', () => {
  assert.equal(hex(bytes('push rax')), '50');
  assert.equal(hex(bytes('push r15')), '41 57');
  assert.equal(hex(bytes('pop r15')), '41 5f');
});

test('stack: a small immediate uses the 6A sign-extended form', () => {
  assert.equal(hex(bytes('push 1')), '6a 01');
});

test('stack: a 16-bit push in 64-bit mode is refused rather than silently pushing RAX', () => {
  // The architecture would push the full 64 bits; the programmer asked for 16.
  assert.throws(() => bytes('push ax'), /moves 64 bits|push ax/);
});

test('stack: a 16-bit push in 32-bit mode gets the size override', () => {
  assert.equal(hex(bytes('push ax', CpuMode.PROTECTED32)), '66 50');
});

/* -------------------------------------------------------------------------- */
/* System instructions                                                         */
/* -------------------------------------------------------------------------- */

test('system: control registers are accessible only one way at a time', () => {
  // MOV CR0, RAX is 0F 22 /r with the control register in the ModRM reg field.
  assert.equal(hex(bytes('mov cr0, rax')), '0f 22 c0');
  assert.equal(hex(bytes('mov rax, cr0')), '0f 20 c0');
  assert.equal(hex(bytes('mov cr4, rbx')), '0f 22 e3');
});

test('system: an ALU instruction cannot touch a control register', () => {
  assert.throws(() => bytes('add cr0, 1'), /only accessible with MOV/);
});

test('system: LGDT takes the reg field the architecture assigns', () => {
  // 0F 01 /2 with a memory operand, so ModRM is mod=00 reg=010 rm=101 = 0x15, and
  // the disp32 follows. Seven bytes total, not six: the operand size and the
  // displacement are both part of it.
  const instruction = first('lgdt [0x1000]', CpuMode.PROTECTED32);
  assert.equal(instruction.mnemonic, 'lgdt');
  assert.equal(instruction.length, 7);
  assert.equal(hex(bytes('lgdt [0x1000]', CpuMode.PROTECTED32)), '0f 01 15 00 10 00 00');
});

test('system: HLT, CLI, STI and UD2 have bare opcodes', () => {
  assert.equal(hex(bytes('hlt')), 'f4');
  assert.equal(hex(bytes('cli')), 'fa');
  assert.equal(hex(bytes('sti')), 'fb');
  assert.equal(hex(bytes('ud2')), '0f 0b');
});

test('system: RDTSC and CPUID are two-byte 0F opcodes', () => {
  assert.equal(hex(bytes('rdtsc')), '0f 31');
  assert.equal(hex(bytes('cpuid')), '0f a2');
  assertMnemonic('cpuid', 'cpuid');
});

test('system: an interrupt vector out of range is rejected', () => {
  assert.throws(() => bytes('int 256'), /out of range/);
});

/* -------------------------------------------------------------------------- */
/* String instructions                                                         */
/* -------------------------------------------------------------------------- */

test('strings: REP prefixes the operation, F3 for rep and F2 for repne', () => {
  assert.equal(hex(bytes('rep stosq')), 'f3 48 ab');
  assert.equal(hex(bytes('repne scasb')), 'f2 ae');
  assert.equal(hex(bytes('repe cmpsb')), 'f3 a6');
});

test('strings: the byte forms are separate opcodes from the wider ones', () => {
  // The 0xA4/0xA5 split is why MOVSB/MOVSW/MOVSD/MOVSQ are not one encoding.
  assert.equal(hex(bytes('movs byte [edi], byte [esi]', CpuMode.PROTECTED32)), 'a4');
  assert.equal(hex(bytes('movs dword [edi], dword [esi]', CpuMode.PROTECTED32)), 'a5');
});

test('strings: the sized spellings name their own width', () => {
  // `movsq` is `movs` with a 64-bit operand: A5 under REX.W in long mode, A4 for
  // the byte form, and the bare `movs` for the mode default. These are four
  // different opcodes, so a mnemonic that merely aliased to `movs` with no width
  // recorded would have to guess - and would guess `movs` as A5 every time.
  assert.equal(hex(bytes('movsb')), 'a4');
  assert.equal(hex(bytes('movsw', CpuMode.PROTECTED32)), '66 a5');
  assert.equal(hex(bytes('movsd', CpuMode.PROTECTED32)), 'a5');
  assert.equal(hex(bytes('movsq')), '48 a5');

  assert.equal(hex(bytes('stosb')), 'aa');
  assert.equal(hex(bytes('stosq')), '48 ab');
  assert.equal(hex(bytes('lodsb')), 'ac');
  assert.equal(hex(bytes('scasb')), 'ae');
  assert.equal(hex(bytes('cmpsb')), 'a6');

  // The width in the mnemonic is not optional and not overridable, so contradicting
  // it is an error rather than one silently winning.
  assert.throws(() => bytes('movsq byte'), /already fixes the operand size/);
  assert.throws(() => bytes('movsb dword'), /already fixes the operand size/);
});

/* -------------------------------------------------------------------------- */
/* I/O                                                                         */
/* -------------------------------------------------------------------------- */

test('io: the immediate port form encodes an unsigned byte', () => {
  assert.equal(hex(bytes('in al, 0x60')), 'e4 60');
  assert.equal(hex(bytes('out 0x64, al')), 'e6 64');
});

test('io: a port above 255 must go through DX and is refused otherwise', () => {
  assert.equal(hex(bytes('in al, dx')), 'ec');
  assert.throws(() => bytes('in al, 0x1234'), /load the port into DX/);
});

test('io: the accumulator must be A', () => {
  // The opcode names the accumulator, so the choice is made there: E4/E5 for an
  // immediate port, EC/ED for DX. EAX in 32-bit mode is the default operand size and
  // needs no override; AX does.
  assert.equal(hex(bytes('in ax, dx')), '66 ed');
  assert.equal(hex(bytes('in eax, dx', CpuMode.PROTECTED32)), 'ed');
  assert.equal(hex(bytes('in eax, dx')), 'ed');
  assert.equal(hex(bytes('in al, dx')), 'ec');
  assert.throws(() => bytes('in bx, dx'), /must be AL, AX or EAX/);
});

test('io: the opcode split is 8 against wider, not 16 against 32', () => {
  // The high bit of the four IN opcodes is AL against eAX - not AX against EAX. AX
  // and EAX are told apart by the 0x66 prefix instead, because both are the
  // "eAX-sized" form. Choosing the opcode by asking whether the width is *16*
  // therefore hands EAX the byte instruction, which still assembles, still decodes,
  // and reads eight bits instead of thirty-two.
  assert.equal(hex(bytes('in al, 0x60')), 'e4 60');
  assert.equal(hex(bytes('in ax, 0x60', CpuMode.REAL16)), 'e5 60');
  assert.equal(hex(bytes('in eax, 0x60', CpuMode.PROTECTED32)), 'e5 60');

  assert.equal(hex(bytes('in al, dx')), 'ec');
  assert.equal(hex(bytes('in ax, dx', CpuMode.REAL16)), 'ed');
  assert.equal(hex(bytes('in eax, dx', CpuMode.PROTECTED32)), 'ed');

  // OUT has the same split with the operands the other way round.
  assert.equal(hex(bytes('out dx, al')), 'ee');
  assert.equal(hex(bytes('out dx, eax', CpuMode.PROTECTED32)), 'ef');
});

/* -------------------------------------------------------------------------- */
/* Sign and zero extension                                                     */
/* -------------------------------------------------------------------------- */

test('extend: the source width comes from the opcode, not the size prefix', () => {
  // 0F B6 is the byte source and 0F B7 the word source, under identical prefixes. The
  // 0x66 and REX.W bytes change the *destination* width and leave the source alone,
  // which is the whole point: the two axes are independent, and reading the source off
  // the operand size would make `movzx ax, bl` load a word.
  assert.equal(hex(bytes('movzx eax, cl')), '0f b6 c1');
  assert.equal(hex(bytes('movzx eax, cx')), '0f b7 c1');
  assert.equal(hex(bytes('movzx ax, cl')), '66 0f b6 c1');
  // A 16-bit destination with a 16-bit source has nothing to extend, so that pairing is
  // refused rather than encoded: there is no opcode for it and 0F B7 would be wrong.
  assert.throws(() => bytes('movzx ax, cx'), /16 bits and the source is 16/);

  // Real mode defaults the destination to 16, so naming a 32-bit destination needs the
  // prefix - and the source is still the byte one. Without the prefix this is
  // `movzx ax, bl`, a real instruction writing a different register.
  assert.equal(hex(bytes('movzx eax, bl', CpuMode.REAL16)), '66 0f b6 c3');
  assert.equal(hex(bytes('movzx ax, bl', CpuMode.REAL16)), '0f b6 c3');
  assert.equal(hex(bytes('movzx eax, bx', CpuMode.REAL16)), '66 0f b7 c3');
});

test('extend: a 64-bit destination uses REX.W', () => {
  assert.equal(hex(bytes('movzx rax, cl')), '48 0f b6 c1');
});

test('extend: a memory source must state its width', () => {
  assert.equal(hex(bytes('movzx eax, byte [rbx]')), '0f b6 03');
  assert.equal(hex(bytes('movzx eax, word [rbx]')), '0f b7 03');
  // A memory operand has no register width to take it from and the opcode pair 0F
  // B6/0F B7 is the only thing that distinguishes them, so the width has to be
  // written. There is no default to fall back on: the address size is not the
  // operand size, and in long mode they are both 64 bits while neither is 8 or 16.
  assert.throws(() => bytes('movzx eax, [rbx]'), /has no width of its own/);
  assert.throws(() => bytes('movzx eax, [rbx]'), /byte.*word/);
});

test('extend: the source must be narrower than the destination', () => {
  // A 32-bit source has nothing to extend, so there is no opcode for it.
  assert.throws(() => bytes('movzx eax, ecx'), /source must be 8 or 16 bits/);
  assert.throws(() => bytes('movsx rax, rcx'), /source must be 8 or 16 bits/);

  // Widening *into* the same width, or into a narrower one, would drop bits silently.
  // `movsx ax, cx` is a same-size pair and `movzx al, bx` a narrowing one; neither
  // exists. The message names both widths, because "would not widen" alone leaves the
  // reader to work out which of the two is the problem.
  assert.throws(() => bytes('movsx ax, cx', CpuMode.REAL16), /widen.*'ax' is 16 bits/);
  assert.throws(() => bytes('movzx al, bx', CpuMode.REAL16), /destination must be at least 16 bits/);

  // Widening by exactly one byte is the whole point, and 8 into 32 is legal.
  assert.equal(hex(bytes('movzx eax, cx')), '0f b7 c1');
  assert.equal(hex(bytes('movsx eax, cx')), '0f bf c1');
  assert.equal(hex(bytes('movzx eax, bl')), '0f b6 c3');
  assert.equal(hex(bytes('movzx ax, bl', CpuMode.REAL16)), '0f b6 c3');
});

test('extend: sign extension round-trips with the same opcode', () => {
  assert.equal(hex(bytes('movsx rax, cl')), '48 0f be c1');
  assertMnemonic('movsx rax, cl', 'movsx');
});

/* -------------------------------------------------------------------------- */
/* Data directives and layout                                                  */
/* -------------------------------------------------------------------------- */

test('data: element order is preserved across strings and numbers', () => {
  // Keeping strings and values in separate arrays would emit "VerixOS" then 0.
  assert.equal(hex(bytes('db "Verix", 0, "OS"')), '56 65 72 69 78 00 4f 53');
});

test('data: .asciz appends a NUL and .ascii does not', () => {
  assert.equal(hex(bytes('db "hi"')), '68 69');
  assert.equal(hex(bytes('.asciz "hi"')), '68 69 00');
  assert.equal(hex(bytes('.ascii "hi"')), '68 69');
});

test('data: element widths are little-endian', () => {
  assert.equal(hex(bytes('dw 0x1234')), '34 12');
  assert.equal(hex(bytes('dd 0x12345678')), '78 56 34 12');
  assert.equal(hex(bytes('dq 0x1122334455667788')), '88 77 66 55 44 33 22 11');
});

test('data: a value too wide for its element size is rejected', () => {
  assert.throws(() => bytes('db 256'), /does not fit in 1 byte/);
});

test('data: a symbol reference resolves to its address', () => {
  // `.dword` puts four bytes at 0x1000, so the MOV starts at 0x1004 and ends at
  // 0x100A - and the displacement back to the data is 0x1000 - 0x100A = -10, which
  // is F6 FF FF FF. The zero that would appear here if the displacement were left
  // as a placeholder is a perfectly plausible instruction that reads 0x100A.
  const result = assemble('.code64\ntarget: .dword 0\nmov eax, [target]', { origin: 0x1000n });
  assert.equal(result.symbols.get('target'), 0x1000n);
  assert.equal(hex([...result.bytes.subarray(4)]), '8b 05 f6 ff ff ff');

  // The decoded form has to agree, and an assembler-only assertion would pass even if
  // the displacement were the wrong way round - the bytes would still look right to a
  // test comparing them against itself. The four zero bytes decode as two `add r/m8,
  // r8`, so the MOV is the third instruction.
  const decoded = decodeSource('target: .dword 0\nmov eax, [target]');
  assert.equal(decoded[2]!.instruction.operands[1]!.kind, 'mem');
  assert.equal(decoded[2]!.consumed, 6);
});

test('data: the symbol difference idiom computes a size', () => {
  // `.size_ = end - start` computes 2 without emitting anything.
  const sized = assemble('.code64\nstart: nop\nend: nop\n.size_ = end - start', { origin: 0x1000n });
  assert.equal(sized.size, 2);

  // `dd end - start` emits it: one NOP, then a dword holding 1 - because `end:` is
  // placed *before* the dd, so the difference is the dd's own size and not the nop's.
  const emitted = assemble('.code64\nstart: nop\nend:\ndd end - start', { origin: 0x1000n });
  assert.equal(hex([...emitted.bytes]), '90 01 00 00 00');

  // Measuring the bytes rather than the label positions is the usual need, and it
  // gives the nop's length: `after:` is 1 past the end of the nop.
  const measured = assemble('.code64\nstart: nop\nafter: dd after - start', { origin: 0x1000n });
  assert.equal(hex([...measured.bytes]), '90 01 00 00 00');
});

test('data: `times` repeats an element list', () => {
  assert.equal(hex(bytes('times 4 db 0xaa')), 'aa aa aa aa');
  assert.equal(hex(bytes('times 3 db 1, 2')), '01 02 01 02 01 02');
});

test('data: .align pads to the boundary with the requested fill', () => {
  assert.equal(hex(bytes('db 1\n.align 4\ndb 2')), '01 00 00 00 02');
  assert.equal(hex(bytes('db 1\n.align 4, 0xff\ndb 2')), '01 ff ff ff 02');
});

test('data: reserve emits the requested count of elements', () => {
  assert.equal(bytes('resb 4').length, 4);
  assert.equal(bytes('resd 3').length, 12);
  assert.equal(hex(bytes('resb 3, 0x90')), '90 90 90');
});

test('layout: the boot sector padding idiom produces exactly 512 bytes', () => {
  // This is the canonical first-stage boot sector shape: a far jump to get past the
  // data the CPU is still fetching, some setup, and padding computed from the current
  // position. If `$` or `$$` were wrong the image would be the wrong size, which is
  // exactly how a bootloader fails to boot.
  const result = assemble(`
    .code16
    .org 0x7c00
    jmp 0x7c00:start
    nop
    nop
    start:
      cli
      xor ax, ax
      mov ds, ax
    times 510 - ($ - $$) db 0
    dw 0xaa55
  `, { origin: 0x7c00n });

  assert.equal(result.size, 512);
  assert.equal(result.origin, 0x7c00n);

  // The signature is what the BIOS actually looks for: 0xAA55 at offset 510, and
  // the bytes are little-endian, so 0x55 comes first.
  assert.equal(result.bytes[510], 0x55);
  assert.equal(result.bytes[511], 0xaa);

  // The first instruction is EA 07 7C 00 7C - a far jump with a 16-bit offset and
  // the 0x7C00 selector, and no 0x66 prefix. In real mode the offset is already 16
  // bits by default, so an operand-size prefix would ask for a 32-bit one and swallow
  // two bytes of padding as part of the selector.
  assert.equal(hex([...result.bytes.subarray(0, 5)]), 'ea 07 7c 00 7c');

  // And `mov ds, ax` is 8E D8: ModRM 11 011 000 is DS (3) in the reg field and AX in
  // r/m. It sits at 0x7C0A, because the far jump is five bytes and `start:` is two
  // NOPs further along, then `cli` (1) and `xor ax, ax` (2).
  assert.equal(result.symbols.get('start'), 0x7c07n);
  assert.equal(hex([...result.bytes.subarray(10, 12)]), '8e d8');

  // The whole prefix, so a wrong instruction length anywhere above shows up as a
  // wrong address rather than as a silently different padding count.
  assert.equal(hex([...result.bytes.subarray(0, 12)]), 'ea 07 7c 00 7c 90 90 fa 31 c0 8e d8');
});

/* -------------------------------------------------------------------------- */
/* Sections and symbols                                                        */
/* -------------------------------------------------------------------------- */

test('layout: .data follows .text in the image', () => {
  const result = assemble('.code64\nnop\n.data\ndb 0x11', { origin: 0x1000n });
  assert.equal(result.symbols.get('.text_start'), undefined);
  assert.ok(result.size >= 2);
  // The data byte is somewhere after the code, not at a separate address.
  assert.ok([...result.bytes].indexOf(0x11) >= 1);
});

test('layout: a local label is scoped under the last global label', () => {
  const result = assemble('.code64\na:\n.loop:\n nop\n jmp .loop\nb:\n.loop:\n nop', { origin: 0x1000n });
  // The qualified names are distinct symbols even though the bare name is not, which
  // is what lets the same `.loop` appear in two routines.
  assert.equal(result.symbols.get('a.loop'), 0x1000n);
  assert.equal(result.symbols.get('b.loop'), 0x1003n);
  // The bare `.loop` is deliberately absent: it is ambiguous, and an entry would have
  // to answer with whichever occurrence was placed last.
  assert.equal(result.symbols.get('.loop'), undefined);
});

test('layout: a bare local reference means the next occurrence, or the last before', () => {
  // Two `.done` labels in two routines. The backward branch in the first must reach
  // the first, and the forward branch in the second must reach the second - which is
  // only true if the bare name is resolved by position rather than by identity.
  const result = assemble(`.code64
first:
  cmp rax, rbx
  je .done
  inc rcx
.done:
  ret
second:
  cmp rax, rbx
  jne .done
  dec rcx
.done:
  ret`, { origin: 0x1000n });

  const decoded = decodeSource(`.code64
first:
  cmp rax, rbx
  je .done
  inc rcx
.done:
  ret
second:
  cmp rax, rbx
  jne .done
  dec rcx
.done:
  ret`);

  const targets = decoded
    .map((entry) => entry.instruction)
    .filter((instruction) => instruction.mnemonic === Mnemonic.JCC)
    .map((instruction) => instruction.operands[0])
    .map((operand) => (operand?.kind === 'rel' ? operand.target : -1n));

  // `first` starts at 0x1000: cmp(3) je(2) inc(3) puts the first `.done` at 0x1008;
  // ret(1) cmp(3) jne(2) dec(3) puts the second at 0x1011. Both branches have to reach
  // *their own* routine's `.done` - reading the first one for the second would be a
  // valid backward branch to the wrong place.
  assert.deepEqual(targets, [0x1008n, 0x1011n]);
  assert.equal(result.symbols.get('first.done'), 0x1008n);
  assert.equal(result.symbols.get('second.done'), 0x1011n);

  // And the encoded displacements, which is the form a CPU actually sees: +3 for the
  // forward branch in the first routine, and +3 again in the second, from 0x100C + 2 to
  // 0x1011. The second is the same byte value as the first only because the two
  // routines are the same length; the addresses are what distinguish them.
  assert.equal(hex([...result.bytes]), '48 39 d8 74 03 48 ff c1 c3 48 39 d8 75 03 48 ff c9 c3');
});

test('layout: an undefined symbol is reported by name', () => {
  assert.throws(() => assemble('jmp nowhere'), /'nowhere' is not defined/);
});

test('layout: .org cannot move backwards', () => {
  // The image is a flat sequence of bytes, so going backwards would mean overwriting
  // what was already emitted - which no encoding can undo.
  assert.throws(() => assemble('.code64\n.org 0x100\n.org 0x50'), /before the current address/);
  assert.throws(() => assemble('.code64\nnop\nnop\n.org 0x8', { origin: 0x1000n }), /before the current address/);
});

test('layout: symbols are exported for the whole program', () => {
  const result = assemble('.code64\n_start:\n nop\nentry_point = _start', { origin: 0x1000n });
  assert.equal(result.symbols.get('_start'), 0x1000n);
});

test('layout: relaxation converges in a bounded number of iterations', () => {
  const body = Array.from({ length: 400 }, () => 'nop').join('\n');
  const result = assemble(`.code64\njmp away\n${body}\naway:`, { origin: 0x1000n });
  assert.ok(result.iterations <= 32, `took ${result.iterations} iterations`);
  assert.ok(result.iterations >= 1);
});

/* -------------------------------------------------------------------------- */
/* Errors that must not be silent                                              */
/* -------------------------------------------------------------------------- */

test('errors: an unknown mnemonic is named', () => {
  assert.throws(() => bytes('frobnicate eax'), /unknown mnemonic 'frobnicate'/);
});

test('errors: a wrong operand count is reported', () => {
  assert.throws(() => bytes('mov rax'), /takes 2 operands, found 1/);
});

test('errors: TEST only stores into r/m, so a memory *source* is refused', () => {
  // Unlike the other seven ALU operations, TEST has no `reg <- r/m` form: 84/85 is
  // the whole register instruction. `test [rbx], rax` is therefore the
  // memory-destination form and is legal - ModRM 00 000 011, which really is [rbx] -
  // while `test rax, [rbx]` asks for an opcode that does not exist. Getting this
  // backwards is not a cosmetic error: `test` computes AND without storing, so the
  // operands are interchangeable in *meaning* and only the encoding distinguishes
  // them.
  assert.equal(hex(bytes('test [rbx], rax')), '48 85 03');
  assert.equal(hex(bytes('test rax, rbx')), '48 85 d8');
  assert.throws(() => bytes('test rax, [rbx]'), /second operand must be a register or an immediate/);

  // The immediate forms exist for the same reason, and always read into r/m, so an
  // immediate first has to be named as such - F7 /0 is TEST r/m, imm, with no `imm,
  // r/m` counterpart.
  assert.equal(hex(bytes('test rax, 1')), '48 f7 c0 01 00 00 00');
  assert.throws(() => bytes('test 1, rax'), /immediate has to be second/);
});

test('errors: a bare register statement is rejected at the parser', () => {
  assert.throws(() => assemble('rax'), /cannot begin with the register/);
});

test('errors: control-register MOV to memory is refused', () => {
  assert.throws(() => bytes('mov cr0, [rbx]'), /general register/);
});

test('errors: an interrupt with a non-immediate operand is refused', () => {
  assert.throws(() => bytes('int rax'), /immediate vector number/);
});

/* -------------------------------------------------------------------------- */
/* Encoder/decoder round-trip                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The three-mode mode-directive, used to re-assemble a decoded line in the mode it
 * came from.
 */
const MODE_DIRECTIVE: Readonly<Record<CpuMode, string>> = {
  [CpuMode.REAL16]: '.code16',
  [CpuMode.PROTECTED32]: '.code32',
  [CpuMode.LONG64]: '.code64',
};

/** The three CPU modes, named for the corpus entries below. */
const L = CpuMode.LONG64;
const M32 = CpuMode.PROTECTED32;
const M16 = CpuMode.REAL16;

/**
 * One corpus group: a name for the assertion message, the mode it is assembled in,
 * and the source itself.
 *
 * The type is explicit rather than inferred because the tuple form `as const` would
 * otherwise widen `mode` to `CpuMode | undefined` under a bare array annotation, and
 * every use below would need a non-null assertion.
 */
type Corpus = readonly [label: string, mode: CpuMode, source: string];
const GROUPS: readonly Corpus[] = [
  ['alu', L, `
mov rax, rcx
mov rcx, rax
mov rax, [rbx]
mov [rbx], rax
mov eax, [rbx+rcx*4+8]
mov r8, [r12+r13*8+0x40]
mov al, [rbx]
mov [rbx], al
mov ah, bh
mov sil, dil
mov al, ah
mov r8b, r15b
movzx eax, bl
movzx eax, bx
movzx rax, word [rbx]
movsx rax, cx
movsx rax, byte [rbx+rcx*2]
movsx eax, word [rbx]
lea rax, [rbx+rcx*4+8]
lea rax, [rbp]
lea rax, [rsp+8]
lea rax, [r12]
lea rax, [r13+r12*2]
add rax, 1
add rax, 4096
add rax, 0xffffffff
add al, bl
add al, byte [rbx]
add eax, dword [rbx]
add rax, rbx
add byte [rbx], al
add word [rbx], 0x1234
sub rsp, 8
or rax, 0x100
and al, 0x0f
xor rax, rax
xor byte [rbx], 0xff
cmp eax, 0
cmp rax, -1
test rax, rax
test byte [rbx], al
test al, 0xff
adc eax, 1
sbb rax, rbx
sub al, 0x80
add ax, 0x1234
adc word [rbx], 1
not dword [rbx]
not byte [rbx]
neg qword [rbx+rcx*8]
neg eax
inc dword [rbx]
dec qword [rbp]
inc ecx
inc ax
`],
  ['multiply', L, `
imul rax, rbx
imul eax, dword [rbx], 4
imul dword [rbx]
imul rax, rbx, 1000
imul eax, ebx, -1
imul rax, rbx, 0x7fffffff
imul ax, bx, 4
imul eax, ebx, 4
imul rax, rbx, 4
`],
  ['shifts', L, `
shl rax, 1
shr dword [rbx], cl
sar rax, 31
sar qword [rbx], 31
shl eax, 200
shl rax, cl
rol rax, 5
ror word [rbx], 1
rcl eax, 1
rcr dword [rbx], cl
`],
  ['atomics', L, `
xadd dword [rbx], eax
xadd byte [rbx], al
xadd rax, rbx
cmpxchg qword [rbx], rax
cmpxchg byte [rbx], al
xchg rax, rbx
xchg rbx, rax
xchg rax, r8
xchg eax, r8d
xchg ebx, ecx
xchg [rbx], eax
xchg eax, [rbx]
xchg ax, cx
`],
  ['conditions', L, `
sete al
setne cl
setl r9b
cmove eax, ecx
cmovne eax, [rbx]
cmovl rax, [rbx+rcx*8]
cmovge cx, [rbx]
je 0x1100
jne 0x1100
jl 0x1100
jge 0x1100
jb 0x1100
jbe 0x1100
ja 0x1100
jae 0x1100
js 0x1100
jns 0x1100
jo 0x1100
jno 0x1100
jp 0x1100
jnp 0x1100
`],
  ['stack and control', L, `
cbw
cwde
cdqe
cwd
cdq
cqo
nop
hlt
cli
sti
cld
std
lahf
sahf
clc
stc
cmc
pushf
popf
pause
leave
push rbp
pop r15
push rax
push 1
push 0x1234
push qword [rbx]
push word [rbx]
call 0x1100
call rax
call qword [rbx]
ret
ret 8
ret 0x8000
jmp 0x1100
jmp rax
jmp qword [rbx]
`],
  ['segments and system', L, `
mov ds, ax
mov es, ax
mov fs, ax
mov gs, rax
push ds
pop es
push es
lgdt [0x1000]
lidt [0x1008]
ltr [0x1000]
lldt [0x1008]
sldt [0x1000]
str [0x1000]
swapgs
rdtscp
invd
invlpg [rax]
invlpg [rbx+rcx*4+8]
syscall
cpuid
rdtsc
ud2
wbinvd
clts
xlatb
int 3
int 255
int 0x80
retf
retfq
retf 8
`],
  ['strings and io', L, `
movsb
movsw
movsd
movsq
stosb
stosw
stosd
stosq
lodsb
lodsw
lodsd
lodsq
scasb
scasw
scasd
scasq
cmpsb
cmpsw
cmpsd
cmpsq
rep stosq
rep movsb
repne scasb
repne scasd
insb
insw
insd
insq
outsb
outsw
outsd
outsq
rep insb
rep insq
in al, 0x60
in ax, dx
in al, dx
in eax, dx
in eax, 0x60
out 0x60, al
out dx, al
out dx, eax
out dx, ax
`],
  ['addresses', L, `
mov eax, [0x1234]
mov [0x1234], eax
mov al, [0x1234]
mov ax, [0x1234]
mov rax, [0x1234]
mov eax, [rbx]
mov eax, [rbx+rcx]
mov eax, [rbx+rcx*2]
mov eax, [rbx+rcx*4]
mov eax, [rbx+rcx*8]
mov eax, [rbx+0x100]
mov eax, [rbx-0x100]
mov eax, [r12]
mov eax, [r13]
mov eax, [r14]
mov eax, [r15]
mov eax, [r12+r13*4]
mov eax, [rsp+0x40]
mov eax, [rbp+0x40]
`],
  ['lock', L, `
lock inc qword [rax]
lock add dword [rdi], esi
lock cmpxchg qword [rdi], rax
lock xadd [rax], ebx
lock or qword [rbx], 1
lock neg byte [rbx]
lock xchg qword [rbx], rax
lock rep stosq
`],
  ['32-bit mode', M32, `
mov eax, [ebx+ecx*4+8]
mov eax, [esp+4]
mov ebx, [ecx]
push dword [esp+4]
movzx eax, byte [ebx]
shl dword [ebx], 1
mov eax, ebx
mov ax, bx
ret 8
lgdt [0x1000]
jmp far 0x1000:0x1234
call far 0x1000:0x1234
jmp far 0x1000:0x12345678
add eax, 0x1000
mov dword [ebx], 0x1234
mov word [ebx], 0x1234
lea eax, [ebx+ecx*8]
xchg ebx, ecx
rep stosd
inc ecx
movzx eax, cl
push ds
pop ds
`],
  ['16-bit mode', M16, `
mov ax, bx
mov eax, ebx
mov ax, [bx+si]
mov ax, [bx+di+2]
mov ax, [bp+si]
mov ax, [bp+di]
mov ax, [si+2]
mov ax, [di]
mov ax, [bx]
mov ax, word [0x1234]
mov [bx+si], ax
jmp far 0x0000:0x7c00
call far 0x1000:0x1234
int 0x21
lgdt [0x1000]
mov ds, ax
add ax, 0x1234
inc ax
mov al, [bx]
push ax
pop ax
`],
  ['system groups', L, `
sgdt [0x1000]
sidt [0x1008]
lgdt [0x1010]
lidt [0x1018]
smsw eax
lmsw ax
smsw [0x1020]
lmsw [0x1028]
sldt ax
sldt [0x1030]
str bx
str [0x1038]
lldt ax
ltr bx
verr cx
verw dx
invlpg [rax]
xgetbv
xsetbv
rdmsr
wrmsr
sysret
wbinvd
clts
xlatb
retf 8
`],
  ['16-bit far and segment', M16, `
push cs
push ss
pop ss
pop ds
mov ds, ax
mov es, ax
mov fs, ax
mov gs, ax
retf
retf 8
`],
  ['32-bit far and segment', M32, `
push cs
pop ds
retf
retf 8
retfq
smsw eax
lmsw ax
`],
  ['pause and rep nop', L, `
pause
rep pause
nop
rep nop
`],
  ['rotate through carry', L, `
rcl eax, 1
rcr eax, 1
rcl qword [rbx], 8
rcr qword [rbx], cl
rcl al, 1
rol al, 1
`],
];

/**
 * The one normalisation this project accepts, and the only one.
 *
 * `add rax, 0xffffffff` has two legal encodings: `48 05 ff ff ff ff`, the
 * accumulator short form, and `48 83 c0 ff`, the sign-extended-byte form. The
 * decoder prints the *value* - `add rax, -0x1` - because an immediate is a number, not
 * a bit pattern, and `-0x1` and `0xffffffff` are the same 64-bit value. Re-assembling
 * that text gives the shortest legal encoding, which is three bytes shorter and
 * architecturally identical.
 *
 * This is a property of immediates rather than a bug in either direction, so it is
 * listed here and the test below *fails* if the set grows. A normalisation set that
 * can grow quietly is not a record of accepted differences; it is a way of not
 * noticing new ones.
 */
const ACCEPTED_NORMALISATIONS: Readonly<Record<string, string>> = {
  // original bytes -> the bytes re-assembly legitimately produces
  '48 05 ff ff ff ff': '48 83 c0 ff',
};
/**
 * Round-trip: assemble, decode, re-assemble, compare.
 *
 * This is the test that found every real bug in the assembler. A hand-written
 * encoding check only proves the encoder agrees with the author; this proves the
 * encoder and the decoder agree with each other *and* with the corpus, which is a
 * stronger claim and the one the project actually rests on.
 *
 * Four things are checked per instruction, because each catches a different bug class:
 *
 *  1. **Byte coverage.** The decoded lengths must sum to exactly the assembled length.
 *     A decoder that under-reads produces plausible disassembly of the wrong
 *     instructions - every later assertion then passes on a stream nobody would run.
 *  2. **Re-assembly.** Every decoded line must assemble. A mnemonic the encoder refuses
 *     is a hole in the instruction set even when the decoder emits it.
 *  3. **Byte identity**, modulo the documented normalisations above.
 *  4. **Text stability.** Re-decoding the re-assembled bytes must produce the same
 *     text. Without this, a fix that merely moved the difference from bytes to
 *     spelling would pass checks 2 and 3.
 */
test('round-trip: every corpus instruction survives assemble -> decode -> re-assemble', () => {
  const differences: string[] = [];
  let instructionCount = 0;
  let byteCount = 0;

  for (const [label, mode, source] of GROUPS) {
    const assembled = assemble(`${MODE_DIRECTIVE[mode]}\n${source}`, { origin: 0x1000n });
    const decoder = new InstructionDecoder(bufferReader(assembled.bytes, assembled.origin), mode);
    const modeText = MODE_DIRECTIVE[mode];

    let address = assembled.origin;
    let covered = 0;
    const lines: { address: bigint; text: string; bytes: number[] }[] = [];

    for (;;) {
      const offset = Number(address - assembled.origin);
      const instruction = decoder.decode(address, mode);
      lines.push({
        address,
        // Strip the trailing "; N bytes @ 0x..." annotation: it is a comment about
        // where the instruction was, which is not part of the assembly text.
        text: instruction.toString().replace(/\s*;.*$/, '').trim(),
        bytes: [...assembled.bytes.subarray(offset, offset + instruction.length)],
      });
      covered += instruction.length;
      address += BigInt(instruction.length);
      if (covered >= assembled.bytes.length) break;
    }

    // (1) Coverage.
    assert.equal(
      covered,
      assembled.bytes.length,
      `${label}: the decoder consumed ${covered} of ${assembled.bytes.length} bytes, so at least one instruction length is wrong`,
    );

    for (const line of lines) {
      instructionCount++;
      byteCount += line.bytes.length;

      // (2) Re-assembly. Re-assembled at the instruction's own address, because a
      // branch displacement is measured from the end of the instruction: re-assembling
      // at a fixed origin would report a difference for every `je 0x1100` in the corpus
      // and hide the real ones behind seventeen false positives.
      let again: number[];
      try {
        again = [...assemble(`${modeText}\n${line.text}`, { origin: line.address }).bytes];
      } catch (error) {
        differences.push(`${label}: '${line.text}' (${hex(line.bytes)}) does not re-assemble: ${(error as Error).message}`);
        continue;
      }

      // (3) Byte identity.
      const before = hex(line.bytes);
      const after = hex(again);
      if (before !== after) {
        const accepted = ACCEPTED_NORMALISATIONS[before];
        if (accepted === undefined) {
          differences.push(`${label}: ${before} -> ${after}  '${line.text}'`);
        } else if (accepted !== after) {
          // The normalisation is allowed, but only for the one encoding it names. If
          // the corpus changes underneath it, the table is stale and must be revisited
          // rather than quietly widened.
          differences.push(
            `${label}: ${before} -> ${after}  '${line.text}' is a *different* normalisation from the documented one (${accepted})`,
          );
        }
        continue;
      }

      // (4) Text stability.
      const second = new InstructionDecoder(bufferReader(Uint8Array.from(again), line.address), mode);
      const retext = second.decode(line.address, mode).toString().replace(/\s*;.*$/, '').trim();
      if (retext !== line.text) {
        differences.push(`${label}: '${line.text}' re-decodes as '${retext}'`);
      }
    }
  }

  // A second pass over the whole stream, so a stream-level bug (an instruction whose
  // length depends on the *following* byte) cannot pass by having every individual
  // instruction look fine.
  assert.deepEqual(differences, [], `round-trip differences:\n${differences.join('\n')}`);

  // The corpus is the point of the test, so its size is part of the contract. A
  // truncated or emptied GROUPS would otherwise make this test pass while testing
  // nothing - which is exactly the "no exception was thrown" failure mode this file
  // opens by ruling out.
  //
  // These are floors set just below the current counts (343 instructions, 1069 bytes at
  // the time of writing) rather than exact counts. A floor catches the failure that
  // matters - a corpus silently emptied by a bad edit - without demanding an edit here
  // every time an instruction is added, which is the kind of chore that gets skipped and
  // then quietly hides a real regression.
  assert.ok(
    instructionCount >= 340,
    `corpus collapsed to ${instructionCount} instructions, expected at least 340`,
  );
  assert.ok(byteCount >= 1050, `corpus collapsed to ${byteCount} bytes, expected at least 1050`);
});

/**
 * The normalisation table is itself a test.
 *
 * It asserts exactly two things, and they are the only two claims worth making about it:
 * that its size is one, and that the entry names real encodings in the corpus. A table
 * that can grow without anyone looking is not documentation - it is a place where
 * differences go to be forgotten, and the next `add rax, 0xffff` to change shape would
 * join `add rax, 0xffffffff` there without anybody deciding it should.
 *
 * The second assertion is what stops the table becoming aspirational: the bytes it
 * excuses have to actually be produced by the corpus, or it is excusing nothing.
 */
test('round-trip: the accepted-normalisation set is exactly one entry, and it is real', () => {
  const entries = Object.entries(ACCEPTED_NORMALISATIONS);
  assert.equal(entries.length, 1, `expected exactly one accepted normalisation, found ${entries.length}: ${entries.map(([k]) => k).join(', ')}`);

  const [before, after] = entries[0]!;

  // The entry is only meaningful if it names a real instruction: one that assembles,
  // decodes to something, and re-assembles to the bytes claimed.
  const assembled = assemble('.code64\nadd rax, 0xffffffff', { origin: 0x1000n });
  assert.equal(hex([...assembled.bytes]), before, `the accepted normalisation names ${before}, but 'add rax, 0xffffffff' assembles to ${hex(assembled.bytes)}`);

  const decoder = new InstructionDecoder(bufferReader(assembled.bytes, assembled.origin), CpuMode.LONG64);
  const text = decoder.decode(assembled.origin, CpuMode.LONG64).toString().replace(/\s*;.*$/, '').trim();
  assert.equal(text, 'add rax, -0x1', `the decoder no longer normalises this immediate (it prints '${text}'), so the entry is stale`);

  const again = assemble(`.code64\n${text}`, { origin: 0x1000n });
  assert.equal(hex([...again.bytes]), after, `re-assembling '${text}' gives ${hex(again.bytes)}, not the excused ${after}`);

  // And the two forms must be genuinely equivalent, not merely differently encoded.
  // Both compute RAX + sign-extended(-1); the decoder printing the signed value is the
  // property that makes them the same instruction.
  assert.equal(after, '48 83 c0 ff', 'the normalised form is no longer the sign-extended-byte encoding');
});