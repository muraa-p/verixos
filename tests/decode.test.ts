/**
 * VerixOS - instruction decoder tests.
 *
 * These verify the decoder against byte sequences whose encodings are fixed by
 * the Intel SDM. Where a test asserts a specific byte layout, the comment cites
 * why those bytes are what they are, because a decoder that merely happens to
 * agree with itself is worth nothing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AluOp,
  CpuMode,
  DecodeError,
  InstructionDecoder,
  Mnemonic,
  ShiftOp,
  bufferReader,
} from '../src/arch/decode.ts';
import { Reg } from '../src/arch/types.ts';

/** Decode a byte sequence in 64-bit mode from address zero. */
function decode64(bytes: number[]): ReturnType<InstructionDecoder['decode']> {
  return new InstructionDecoder(bufferReader(Uint8Array.from(bytes), 0n)).decode(0n, CpuMode.LONG64);
}

/** Decode a byte sequence in 16-bit real mode. */
function decode16(bytes: number[]): ReturnType<InstructionDecoder['decode']> {
  return new InstructionDecoder(bufferReader(Uint8Array.from(bytes), 0n)).decode(0n, CpuMode.REAL16);
}

/** Decode a byte sequence in 32-bit protected mode. */
function decode32(bytes: number[]): ReturnType<InstructionDecoder['decode']> {
  return new InstructionDecoder(bufferReader(Uint8Array.from(bytes), 0n)).decode(0n, CpuMode.PROTECTED32);
}

describe('decoder: instruction length', () => {
  it('measures a no-operand instruction', () => {
    assert.equal(decode64([0x90]).length, 1); // nop
    assert.equal(decode64([0xf4]).length, 1); // hlt
    assert.equal(decode64([0xfc]).length, 1); // cld
  });

  it('counts legacy prefixes', () => {
    // 66 90 is the two-byte NOP.
    assert.equal(decode64([0x66, 0x90]).length, 2);
    // f3 0f 1f ... multi-byte nop with modrm
    assert.equal(decode64([0xf3, 0x0f, 0x1f, 0x00]).length, 4);
  });

  it('counts a REX prefix', () => {
    // 48 89 c0 = mov rax, rax
    const insn = decode64([0x48, 0x89, 0xc0]);
    assert.equal(insn.length, 3);
    assert.equal(insn.operandSize, 64);
  });

  it('counts a SIB byte and displacement', () => {
    // 48 8d 44 8b 08 = lea rax, [rbx+rcx*4+8]
    assert.equal(decode64([0x48, 0x8d, 0x44, 0x8b, 0x08]).length, 5);
  });
});

describe('decoder: no-operand instructions', () => {
  const cases: [number[], Mnemonic][] = [
    [[0xf4], Mnemonic.HLT],
    [[0xfa], Mnemonic.CLI],
    [[0xfb], Mnemonic.STI],
    [[0xfc], Mnemonic.CLD],
    [[0xfd], Mnemonic.STD],
    [[0xf8], Mnemonic.CLC],
    [[0xf9], Mnemonic.STC],
    [[0xf5], Mnemonic.CMC],
    [[0xcc], Mnemonic.INT3],
    [[0xc3], Mnemonic.RET],
    [[0xc9], Mnemonic.LEAVE],
    [[0x9c], Mnemonic.PUSHF],
    [[0x9d], Mnemonic.POPF],
  ];

  for (const [bytes, expected] of cases) {
    it(`decodes ${expected} from ${bytes.map((b) => b.toString(16)).join(' ')}`, () => {
      assert.equal(decode64(bytes).mnemonic, expected);
    });
  }

  it('decodes CPUID and RDTSC from the two-byte map', () => {
    assert.equal(decode64([0x0f, 0xa2]).mnemonic, Mnemonic.CPUID);
    assert.equal(decode64([0x0f, 0x31]).mnemonic, Mnemonic.RDTSC);
    assert.equal(decode64([0x0f, 0x0b]).mnemonic, Mnemonic.UD2);
  });

  it('rejects an unknown opcode', () => {
    assert.throws(() => decode64([0x0f, 0xff]), DecodeError);
  });
});

describe('decoder: MOV', () => {
  it('decodes mov r64, imm32 - there is no imm64 form of B8', () => {
    // B8+rd has exactly two forms: without REX.W it is `mov r32, imm32`, and with
    // REX.W it is `mov r/m64, imm32` *sign-extended*. There is no eight-byte immediate
    // for this opcode, so reading eight bytes here would swallow the four bytes of the
    // next instruction and report a length that is four too long. The register is 64
    // bits wide and the immediate is 32, and conflating those is exactly the mistake.
    const insn = decode64([0x48, 0xb8, 1, 2, 3, 4]);
    assert.equal(insn.mnemonic, Mnemonic.MOV);
    assert.equal(insn.length, 6);
    assert.equal(insn.operandSize, 64);
    assert.deepEqual(insn.operands[0], { kind: 'reg', reg: Reg.AX, size: 64 });
    assert.deepEqual(insn.operands[1], { kind: 'imm', value: 0x0403_0201n, width: 32 });

    // Sign extension, which is the whole content of the W bit on this opcode: an imm32
    // with the top bit set fills the upper half of the destination. Little-endian, so
    // `fe ff ff ff` is the imm32 0xfffffffe - writing `ff ff ff fe` here would be
    // 0xfeffffff, which has a different sign bit position entirely.
    const negative = decode64([0x48, 0xb8, 0xfe, 0xff, 0xff, 0xff]);
    assert.equal(negative.length, 6);
    assert.deepEqual(negative.operands[1], { kind: 'imm', value: -2n, width: 32 });

    // The same opcode without REX.W writes 32 bits and is therefore unsigned: the very
    // same four immediate bytes mean 0xfffffffe there, not -2.
    const unsigned = decode64([0xb8, 0xfe, 0xff, 0xff, 0xff]);
    assert.equal(unsigned.length, 5);
    assert.equal(unsigned.operandSize, 32);
    assert.deepEqual(unsigned.operands[0], { kind: 'reg', reg: Reg.AX, size: 32 });
    assert.deepEqual(unsigned.operands[1], { kind: 'imm', value: 0xfffffffen, width: 32 });

    // There is no 64-bit immediate move anywhere in the architecture, so the assembler
    // refuses `mov rax, 0x1122...` rather than inventing an encoding. The C7 /0 form
    // also takes a 32-bit immediate, sign-extended - seven bytes, not eleven - and a
    // full 64-bit constant has to come from memory.
    const c7 = decode64([0x48, 0xc7, 0xc0, 0x88, 0x77, 0x66, 0x55]);
    assert.equal(c7.length, 7);
    assert.deepEqual(c7.operands[1], { kind: 'imm', value: 0x5566_7788n, width: 32 });
  });

  it('zero-extends a 32-bit immediate into the register encoding', () => {
    // B8+rd id: without REX.W the immediate is exactly 4 bytes.
    const insn = decode64([0xb8, 0xff, 0xff, 0xff, 0xff]);
    assert.equal(insn.length, 5);
    assert.equal(insn.operandSize, 32);
  });

  it('decodes mov r/m, r and mov r, r/m both directions', () => {
    // 48 89 c0 = mov rax, rax
    const a = decode64([0x48, 0x89, 0xc0]);
    assert.equal(a.operands[0]?.kind, 'reg');
    assert.equal(a.operands[1]?.kind, 'reg');
    // 48 8b c0 = mov rax, rax (opposite direction, same encoding modulo ModRM)
    const b = decode64([0x48, 0x8b, 0xc0]);
    assert.equal(b.mnemonic, Mnemonic.MOV);
  });

  it('decodes an 8-bit immediate move to a register', () => {
    const insn = decode64([0xb0, 0x41]); // mov al, 0x41
    assert.equal(insn.length, 2);
    assert.equal(insn.operands[0]?.kind, 'reg');
    if (insn.operands[1]?.kind === 'imm') assert.equal(insn.operands[1].value, 0x41n);
  });

  it('applies REX.B to select r8-r15', () => {
    // 49 c7 c0 01 00 00 00 = mov r8, 1
    const insn = decode64([0x49, 0xc7, 0xc0, 0x01, 0x00, 0x00, 0x00]);
    assert.equal(insn.operands[0]?.kind, 'reg');
    if (insn.operands[0]?.kind === 'reg') assert.equal(insn.operands[0].reg, Reg.R8);
  });

  it('applies REX.R to select an extended reg field', () => {
    // 4c 89 c0 = mov rax, r8  (REX.WRB = 0x4c, reg field 0 + REX.R*8 = r8)
    const insn = decode64([0x4c, 0x89, 0xc0]);
    assert.equal(insn.operands[1]?.kind, 'reg');
    if (insn.operands[1]?.kind === 'reg') assert.equal(insn.operands[1].reg, Reg.R8);
  });

  it('selects sil rather than dh when a REX prefix is present', () => {
    // 0xF0 = mod=11, reg=110, rm=000. For 8-bit operands reg field 6 is DH
    // with no REX prefix and SIL once any REX prefix is present, even an empty
    // REX = 0x40. The register index is RSI (6) either way; only highByte moves.
    const insn = decode64([0x40, 0x88, 0xf0]);
    assert.equal(insn.hasRex, true);
    assert.equal(insn.operands[0]?.kind, 'reg');
    if (insn.operands[0]?.kind === 'reg') {
      assert.equal(insn.operands[0].reg, Reg.AX);
      assert.equal(insn.operands[0].highByte, false);
    }
    if (insn.operands[1]?.kind === 'reg') {
      assert.equal(insn.operands[1].reg, Reg.SI);
      assert.equal(insn.operands[1].highByte, false);
    }
  });

  it('uses dh when no REX prefix is present', () => {
    const insn = decode64([0x88, 0xf0]); // mov al, dh
    assert.equal(insn.hasRex, false);
    if (insn.operands[1]?.kind === 'reg') {
      assert.equal(insn.operands[1].reg, Reg.DX);
      assert.equal(insn.operands[1].highByte, true);
    }
  });
});

describe('decoder: addressing modes', () => {
  it('decodes [base] with mod=00', () => {
    // 48 8b 03 = mov rax, [rbx]
    const insn = decode64([0x48, 0x8b, 0x03]);
    assert.equal(insn.operands[1]?.kind, 'mem');
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].base, Reg.BX);
      assert.equal(insn.operands[1].ripRelative, false);
      assert.equal(insn.operands[1].disp, 0n);
    }
  });

  it('decodes an 8-bit signed displacement with mod=01', () => {
    // 48 8b 43 08 = mov rax, [rbx+8]
    const insn = decode64([0x48, 0x8b, 0x43, 0x08]);
    assert.equal(insn.length, 4);
    if (insn.operands[1]?.kind === 'mem') assert.equal(insn.operands[1].disp, 8n);
  });

  it('sign-extends a negative 8-bit displacement', () => {
    // 48 8b 43 f8 = mov rax, [rbx-8]
    const insn = decode64([0x48, 0x8b, 0x43, 0xf8]);
    if (insn.operands[1]?.kind === 'mem') assert.equal(insn.operands[1].disp, -8n);
  });

  it('decodes a 32-bit displacement with mod=10', () => {
    const insn = decode64([0x48, 0x8b, 0x83, 0x78, 0x56, 0x34, 0x12]);
    assert.equal(insn.length, 7);
    if (insn.operands[1]?.kind === 'mem') assert.equal(insn.operands[1].disp, 0x1234_5678n);
  });

  it('decodes a SIB with scale, index and displacement', () => {
    // 48 8d 44 8b 08 = lea rax, [rbx+rcx*4+8]
    const insn = decode64([0x48, 0x8d, 0x44, 0x8b, 0x08]);
    assert.equal(insn.mnemonic, Mnemonic.LEA);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].base, Reg.BX);
      assert.equal(insn.operands[1].index, Reg.CX);
      assert.equal(insn.operands[1].scale, 4);
      assert.equal(insn.operands[1].disp, 8n);
    }
  });

  it('decodes a SIB with no index register', () => {
    // 48 8b 04 25 00 00 00 00 = mov rax, [0]
    const insn = decode64([0x48, 0x8b, 0x04, 0x25, 0, 0, 0, 0]);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].base, -1);
      assert.equal(insn.operands[1].index, -1);
      assert.equal(insn.operands[1].disp, 0n);
    }
  });

  it('treats index field 100 as no-index when REX.X is clear', () => {
    // 48 8b 04 20 = mov rax, [rax]. SIB byte 0x20 is scale=1, index=100, base=000.
    // Index field 100 is the "no index" encoding unless REX.X promotes it to R12.
    const insn = decode64([0x48, 0x8b, 0x04, 0x20]);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].index, -1);
      assert.equal(insn.operands[1].base, Reg.AX);
    }
  });

  it('treats index field 100 as r12 when REX.X is set', () => {
    // 4a 8b 04 20 = mov r8, [r12]: REX.X promotes the no-index encoding to R12.
    const insn = decode64([0x4a, 0x8b, 0x04, 0x20]);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].index, Reg.R12);
      assert.equal(insn.operands[1].base, Reg.AX);
    }
  });

  it('marks mod=00 rm=101 as RIP-relative in 64-bit mode', () => {
    // 48 8b 05 10 00 00 00 = mov rax, [rip+0x10]
    const insn = decode64([0x48, 0x8b, 0x05, 0x10, 0x00, 0x00, 0x00]);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].ripRelative, true);
      assert.equal(insn.operands[1].base, -1);
    }
  });

  it('treats mod=00 rm=101 as an absolute address in 32-bit mode', () => {
    // 8b 05 10 00 00 00 = mov eax, [0x10] in 32-bit mode
    const insn = decode32([0x8b, 0x05, 0x10, 0x00, 0x00, 0x00]);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].ripRelative, false);
      assert.equal(insn.operands[1].disp, 0x10n);
    }
  });

  it('decodes 16-bit addressing modes from the fixed table', () => {
    // 8b 00 = mov eax, [bx+si]
    const insn = decode16([0x8b, 0x00]);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].base, Reg.BX);
      assert.equal(insn.operands[1].index, Reg.SI);
      assert.equal(insn.operands[1].addressWidth, 16);
    }
  });

  it('decodes a 16-bit displacement-only mode', () => {
    // 8b 06 34 12 = mov eax, [0x1234] in 16-bit mode
    const insn = decode16([0x8b, 0x06, 0x34, 0x12]);
    assert.equal(insn.length, 4);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].base, -1);
      assert.equal(insn.operands[1].disp, 0x1234n);
    }
  });
});

describe('decoder: ALU group', () => {
  it('selects the operation from bits 3-5 of the opcode', () => {
    const ops: [number, AluOp][] = [
      [0x01, AluOp.ADD],
      [0x09, AluOp.OR],
      [0x11, AluOp.ADC],
      [0x19, AluOp.SBB],
      [0x21, AluOp.AND],
      [0x29, AluOp.SUB],
      [0x31, AluOp.XOR],
      [0x39, AluOp.CMP],
    ];
    for (const [opcode, expected] of ops) {
      const insn = decode64([0x48, opcode, 0xc0]); // op rax, rax
      assert.equal(insn.aluOp, expected, `opcode ${opcode.toString(16)}`);
    }
  });

  it('does not mistake PUSH ES for an ALU instruction', () => {
    // 06 is PUSH ES, not an ALU form. Decoding it as an ALU opcode would
    // produce a bogus instruction with a wrong length.
    const insn = decode16([0x06]);
    assert.notEqual(insn.mnemonic, Mnemonic.ADD);
    assert.equal(insn.length, 1);
  });

  it('does not mistake PUSHA/POPA for an ALU instruction', () => {
    for (const opcode of [0x60, 0x61]) {
      const insn = decode16([opcode]);
      assert.equal(insn.length, 1);
      assert.notEqual(insn.aluOp !== undefined, true);
    }
  });

  it('decodes the sign-extended 0x83 immediate form', () => {
    // 48 83 c0 ff = add rax, -1
    const insn = decode64([0x48, 0x83, 0xc0, 0xff]);
    assert.equal(insn.mnemonic, Mnemonic.ADD);
    if (insn.operands[1]?.kind === 'imm') assert.equal(insn.operands[1].value, -1n);
  });

  it('decodes the group-1 byte-immediate form', () => {
    // 80 c0 05 = add al, 5
    const insn = decode64([0x80, 0xc0, 0x05]);
    assert.equal(insn.length, 3);
    assert.equal(insn.aluOp, AluOp.ADD);
  });
});

describe('decoder: control flow', () => {
  it('computes a short jump target relative to the next instruction', () => {
    // 74 05 = jz +5. Next instruction is at 2, so target is 7.
    const insn = decode64([0x74, 0x05]);
    assert.equal(insn.mnemonic, Mnemonic.JCC);
    assert.equal(insn.condition, 4);
    assert.equal(insn.operands[0]?.kind, 'rel');
    if (insn.operands[0]?.kind === 'rel') assert.equal(insn.operands[0].target, 7n);
  });

  it('handles a backwards short jump', () => {
    // eb fe = jmp -2. Next instruction is at 2, so target is 0.
    const insn = decode64([0xeb, 0xfe]);
    if (insn.operands[0]?.kind === 'rel') assert.equal(insn.operands[0].target, 0n);
  });

  it('decodes a near call with a 32-bit displacement', () => {
    // e8 00 00 00 00 = call +0; instruction length 5, next is at 5
    const insn = decode64([0xe8, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(insn.length, 5);
    if (insn.operands[0]?.kind === 'rel') assert.equal(insn.operands[0].target, 5n);
  });

  it('decodes the near Jcc from the two-byte map', () => {
    // 0f 84 00 00 00 00 = jz rel32
    const insn = decode64([0x0f, 0x84, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(insn.twoByte, true);
    assert.equal(insn.length, 6);
    assert.equal(insn.condition, 4);
    if (insn.operands[0]?.kind === 'rel') assert.equal(insn.operands[0].target, 6n);
  });

  it('decodes an immediate return', () => {
    // c2 08 00 = ret 8
    const insn = decode64([0xc2, 0x08, 0x00]);
    assert.equal(insn.length, 3);
    assert.equal(insn.operands[0]?.kind, 'imm');
    if (insn.operands[0]?.kind === 'imm') assert.equal(insn.operands[0].value, 8n);
  });
});

describe('decoder: shifts', () => {
  it('selects the shift operation from the reg field', () => {
    const cases: [number, Mnemonic][] = [
      [0x00, Mnemonic.ROL],
      [0x01, Mnemonic.ROR],
      [0x04, Mnemonic.SHL],
      [0x05, Mnemonic.SHR],
      [0x06, Mnemonic.SAR],
    ];
    for (const [reg, expected] of cases) {
      // 48 c1 /reg ib - the imm8 is part of the encoding, not optional.
      const insn = decode64([0x48, 0xc1, 0xc0 | (reg << 3), 0x01]); // shift rax, 1
      assert.equal(insn.length, 4);
      assert.equal(insn.mnemonic, expected);
      assert.equal(insn.shiftOp, (reg as ShiftOp));
    }
  });

  it('decodes shift-by-cl', () => {
    // 48 d3 e0 = shl rax, cl
    const insn = decode64([0x48, 0xd3, 0xe0]);
    assert.equal(insn.mnemonic, Mnemonic.SHL);
    assert.equal(insn.length, 3);
  });
});

/**
 * Instruction-length accounting is the decoder's highest-consequence duty. If
 * `length` is short, the CPU fetches its next instruction from the middle of this
 * one and the trace diverges in a way that looks like a memory fault, so each
 * test here checks the length as well as the operands.
 */
describe('decoder: sequential decode over a byte stream', () => {
  /** Decode every instruction in `bytes` from `base`, requiring exact coverage. */
  function disassemble(bytes: number[], base = 0x401_000n): string[] {
    const buffer = Uint8Array.from(bytes);
    const decoder = new InstructionDecoder(bufferReader(buffer, base), CpuMode.LONG64);
    const lines: string[] = [];
    let rip = base;
    const end = base + BigInt(buffer.length);
    while (rip < end) {
      const insn = decoder.decode(rip);
      lines.push(insn.toString());
      rip += BigInt(insn.length);
    }
    assert.equal(
      rip - base,
      BigInt(buffer.length),
      `decoding consumed ${rip - base} of ${buffer.length} bytes; lengths are wrong`,
    );
    return lines;
  }

  it('consumes the disp32 of a SIB operand with no base register', () => {
    // 48 8b 04 25 78 56 34 12 = mov rax, [0x12345678].
    // SIB 0x25 has base field 101 with mod=00, which means "no base, the address
    // is the disp32 that follows". Failing to consume that disp32 makes the
    // instruction four bytes short.
    const insn = decode64([0x48, 0x8b, 0x04, 0x25, 0x78, 0x56, 0x34, 0x12]);
    assert.equal(insn.length, 8);
    if (insn.operands[1]?.kind === 'mem') {
      assert.equal(insn.operands[1].base, -1);
      assert.equal(insn.operands[1].disp, 0x1234_5678n);
      assert.equal(insn.operands[1].ripRelative, false);
    }
  });

  it('accounts for every byte of a mixed stream', () => {
    const lines = disassemble([
      0x48, 0x31, 0xc0, // xor rax, rax
      0x48, 0x89, 0xc3, // mov rbx, rax
      0x48, 0xc7, 0xc7, 0x00, 0x00, 0x00, 0x00, // mov rdi, 0
      0x0f, 0x1f, 0x40, 0x00, // nop dword [rax]
      0x65, 0x48, 0x8b, 0x04, 0x25, 0x78, 0x56, 0x34, 0x12, // mov rax, fs:[0x12345678]
      0xf3, 0xab, // rep stosd - the 0xF3 supplies no width, so the default applies
      0x48, 0x0f, 0xaf, 0xc1, // imul rax, rcx
      0x0f, 0x84, 0x0a, 0x00, 0x00, 0x00, // je +0xa
    ]);
    assert.match(lines[0]!, /^xor rax, rax/);
    // The size keyword is not optional: without it `mov rax, [0x12345678]` is ambiguous,
    // and this assembler refuses ambiguous memory operands rather than guessing.
    assert.match(lines[4]!, /^mov rax, qword \[0x12345678\]/);
    // `f3 ab` has no REX.W, so the default operand size applies and this is `stosd`,
    // not the 64-bit `stosq` the comment in the fixture claims. A4/AB/AC/AE pair
    // A5/AD/AF by opcode, and the *wide* member of the pair is the 32-bit one here.
    assert.match(lines[5]!, /^rep stosd/);
    assert.match(lines[7]!, /^je 0x401030/);
  });

  it('keeps the REP prefix on a string operation', () => {
    // f3 ab = rep stosq, the canonical memset idiom. Dropping the prefix would
    // turn it into a single store.
    const insn = decode64([0xf3, 0xab]);
    assert.equal(insn.mnemonic, Mnemonic.STOSD);
    assert.equal(insn.stringWidth, 32);
    assert.equal(insn.rep, 'rep');
    assert.equal(insn.length, 2);
    // And the prefix reaches the text, which is what makes it re-assemblable.
    assert.match(insn.toString(), /^rep stosd/);

    // REX.W is what makes it the 64-bit form: `48 a5` is movsq and `f3 48 ab` is
    // rep stosq. Reading the width off `operandSize` alone gets 32 here, because
    // long mode's *default* operand size is 32 and the byte opcode A4 overrides it
    // only in the other direction.
    assert.equal(decode64([0xf3, 0x48, 0xab]).mnemonic, Mnemonic.STOSQ);
    assert.equal(decode64([0xf3, 0x48, 0xab]).stringWidth, 64);
    assert.equal(decode64([0xf3, 0x66, 0xab]).mnemonic, Mnemonic.STOSW);
    assert.equal(decode64([0xf3, 0xaa]).mnemonic, Mnemonic.STOSB);
  });

  it('spells conditional jumps and sets as the assembler does', () => {
    // "jcce" and "setcce" are map names, not mnemonics. Any assembler consuming this
    // disassembly has to see je and sete.
    const jcc = decode64([0x0f, 0x84, 0x00, 0x00, 0x00, 0x00]);
    assert.match(jcc.toString(), /^je /);
    const setcc = decode64([0x0f, 0x94, 0xc0]);
    assert.match(setcc.toString(), /^sete /);
    const shortJump = decode64([0x74, 0xf2]);
    assert.match(shortJump.toString(), /^je /);

    // The spelling is the SDM's E/NE, not the Z/NZ that NASM also accepts, and the
    // choice is what makes the disassembly re-assemble to the same bytes: the parser
    // canonicalises jz and jnz to je and jne. So every condition suffix the decoder can
    // emit has to be one the parser folds *back* to itself.
    assert.match(decode64([0x0f, 0x85, 0x00, 0x00, 0x00, 0x00]).toString(), /^jne /);
    assert.match(decode64([0x0f, 0x95, 0xc0]).toString(), /^setne /);
  });
});

describe('decoder: group 3', () => {
  it('decodes NOT, NEG, MUL, IMUL, DIV and IDIV', () => {
    const cases: [number, Mnemonic][] = [
      [2, Mnemonic.NOT],
      [3, Mnemonic.NEG],
      [4, Mnemonic.MUL],
      [5, Mnemonic.IMUL],
      [6, Mnemonic.DIV],
      [7, Mnemonic.IDIV],
    ];
    for (const [reg, expected] of cases) {
      const insn = decode64([0x48, 0xf7, 0xc0 | (reg << 3)]);
      assert.equal(insn.mnemonic, expected, `reg ${reg}`);
    }
  });

  it('decodes TEST with an immediate in group 3', () => {
    // 48 f7 c0 01 00 00 00 = test rax, 1
    const insn = decode64([0x48, 0xf7, 0xc0, 0x01, 0x00, 0x00, 0x00]);
    assert.equal(insn.mnemonic, Mnemonic.TEST);
    assert.equal(insn.length, 7);
  });
});

describe('decoder: MOVZX and MOVSX', () => {
  it('records the source width for MOVZX', () => {
    // 0f b6 02 = movzx eax, byte [rdx]
    const insn = decode64([0x0f, 0xb6, 0x02]);
    assert.equal(insn.mnemonic, Mnemonic.MOVZX);
    assert.equal(insn.sourceSize, 8);
    assert.equal(insn.length, 3);
  });

  it('records a 16-bit source width for the b7 form', () => {
    // 0f b7 02 = movzx eax, word [rdx]
    const insn = decode64([0x0f, 0xb7, 0x02]);
    assert.equal(insn.sourceSize, 16);
  });

  it('records the source width for MOVSX', () => {
    assert.equal(decode64([0x0f, 0xbe, 0x02]).sourceSize, 8);
    assert.equal(decode64([0x0f, 0xbf, 0x02]).sourceSize, 16);
  });
});

describe('decoder: port I/O and system instructions', () => {
  it('decodes in and out with an immediate port', () => {
    const insn = decode64([0xe4, 0x60]); // in al, 0x60
    assert.equal(insn.mnemonic, Mnemonic.IN);
    assert.equal(insn.length, 2);
    const out = decode64([0xe6, 0x60]); // out 0x60, al
    assert.equal(out.mnemonic, Mnemonic.OUT);
  });

  it('decodes in and out through dx', () => {
    assert.equal(decode64([0xec]).mnemonic, Mnemonic.IN);
    assert.equal(decode64([0xee]).mnemonic, Mnemonic.OUT);
  });

  it('decodes int and iret', () => {
    assert.equal(decode64([0xcd, 0x13]).mnemonic, Mnemonic.INT); // int 0x13
    assert.equal(decode64([0xcf]).mnemonic, Mnemonic.IRET);
  });

  it('decodes LGDT and LIDT as memory operands', () => {
    const lgdt = decode64([0x0f, 0x01, 0x15, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(lgdt.mnemonic, Mnemonic.LGDT);
    assert.equal(lgdt.operands[0]?.kind, 'mem');
  });
});

describe('decoder: operand size prefixes', () => {
  it('defaults to 32-bit operands in long mode', () => {
    assert.equal(decode64([0x8b, 0xc0]).operandSize, 32);
  });

  it('switches to 16-bit operands with a 0x66 prefix', () => {
    assert.equal(decode64([0x66, 0x8b, 0xc0]).operandSize, 16);
  });

  it('switches to 64-bit operands with REX.W', () => {
    assert.equal(decode64([0x48, 0x8b, 0xc0]).operandSize, 64);
  });

  it('gives REX.W precedence over the 0x66 prefix', () => {
    assert.equal(decode64([0x66, 0x48, 0x8b, 0xc0]).operandSize, 64);
  });
});

describe('decoder: operand widths', () => {
  it('distinguishes mov eax from mov rax, which share a register index', () => {
    // 8B C3 and 48 8B C3 differ by one prefix byte and mean different operations: the
    // first writes RBX's low 32 bits and zeroes its top half, the second writes all 64.
    // A register operand that records only the index cannot tell an executor which one
    // it is holding, so the width has to be carried on the operand itself.
    const narrow = decode64([0x8b, 0xc3]);
    const wide = decode64([0x48, 0x8b, 0xc3]);
    assert.deepEqual(narrow.operands[1], { kind: 'reg', reg: Reg.BX, size: 32 });
    assert.deepEqual(wide.operands[1], { kind: 'reg', reg: Reg.BX, size: 64 });
    assert.notDeepEqual(narrow.operands[1], wide.operands[1]);
  });

  it('records the width the 0x66 prefix selects', () => {
    assert.deepEqual(decode64([0x66, 0x8b, 0xc3]).operands[1], { kind: 'reg', reg: Reg.BX, size: 16 });
  });

  it('records a real-mode default of 16 bits', () => {
    // Real mode defaults to 16-bit operands, so an unprefixed 8B C3 is a 16-bit move -
    // the same bytes as the 32-bit long-mode instruction above and a different one.
    assert.deepEqual(decode16([0x8b, 0xc3]).operands[1], { kind: 'reg', reg: Reg.BX, size: 16 });
  });

  it('records 8 bits for the byte forms', () => {
    // SPL, SIL and R8B-R15B exist only at this width, so an 8-bit operand printed or
    // executed as a 64-bit register is wrong in a way no other width difference is.
    // 88 /r is `mov r/m8, r8`, so the rm field is the destination and the reg field is
    // the source: ModRM E0 is mod 11, reg 110, rm 000 - AL and SI.
    assert.deepEqual(decode64([0x88, 0xe0]).operands[1], { kind: 'reg', reg: Reg.AX, size: 8, highByte: true });
    assert.deepEqual(decode64([0x40, 0x88, 0xe0]).operands[1], { kind: 'reg', reg: Reg.SP, size: 8, highByte: false });
    // REX.B extends the rm field, so the destination becomes R8B.
    assert.deepEqual(decode64([0x41, 0x88, 0xe0]).operands[0], { kind: 'reg', reg: Reg.R8, size: 8, highByte: false });
  });

  it('records the address width, which is not the operand width', () => {
    // 8B 07 is `mov ax, [bx]` in real mode and `mov eax, [rdi]` in long mode: the same
    // ModRM rm field, read through two unrelated address tables, with different operand
    // defaults. The address width decides *how* the field is read, so an operand that
    // records only the operand size cannot express the difference at all.
    const realPair = decode16([0x8b, 0x00]).operands[1]; // rm 000 -> [bx+si]
    assert.equal(realPair?.kind, 'mem');
    if (realPair?.kind === 'mem') {
      assert.equal(realPair.addressWidth, 16);
      assert.equal(realPair.base, Reg.BX);
      assert.equal(realPair.index, Reg.SI);
      assert.equal(realPair.scale, 1);
    }

    // rm 111 is the seventh row of the 16-bit table, which is [bx]. In 64-bit addressing
    // the same field 7 is plainly rdi - the two address tables have nothing to do with
    // each other, which is the strongest argument for recording the address width:
    // `8B 07` reads `[bx]` here and `[rdi]` below, and only the mode says which.
    const real = decode16([0x8b, 0x07]).operands[1];
    if (real?.kind === 'mem') {
      assert.equal(real.addressWidth, 16);
      assert.equal(real.base, Reg.BX);
      assert.equal(real.index, -1);
    }

    const long = decode64([0x8b, 0x07]).operands[1];
    if (long?.kind === 'mem') {
      // 64-bit addressing, even though the operand is 32-bit: the two widths are chosen
      // by different prefixes and default independently in long mode.
      assert.equal(long.addressWidth, 64);
      assert.equal(long.base, Reg.DI);
      assert.equal(long.index, -1);
    }
  });

  it('gives a RIP-relative operand a 64-bit address width', () => {
    const mem = decode64([0x8b, 0x05, 0x00, 0x00, 0x00, 0x00]).operands[1];
    assert.equal(mem?.kind, 'mem');
    if (mem?.kind === 'mem') {
      assert.equal(mem.ripRelative, true);
      assert.equal(mem.addressWidth, 64);
    }
  });
});

describe('decoder: read-modify-write groups', () => {
  it('decodes CMOVcc with the condition in the low four opcode bits', () => {
    // 0F 40-4F is one instruction with sixteen conditions, so the condition has to be
    // recorded rather than folded into sixteen mnemonics - the same shape as Jcc and
    // SETcc. The destination is in the reg field and the source in r/m.
    //
    // 0F 44 is CMOVZ, because the condition table is the standard one and 4 is E/Z -
    // CMOVO is 0F 40. Reading the condition as "0F 4x is all one thing" is how 44 and
    // 40 get swapped.
    const z = decode64([0x0f, 0x44, 0xc1]);
    assert.equal(z.mnemonic, Mnemonic.CMOVCC);
    assert.equal(z.condition, 4);
    assert.deepEqual(z.operands, [
      { kind: 'reg', reg: Reg.AX, size: 32 },
      { kind: 'reg', reg: Reg.CX, size: 32 },
    ]);

    assert.equal(decode64([0x0f, 0x40, 0xc1]).condition, 0);
    assert.match(decode64([0x0f, 0x40, 0xc1]).toString(), /^cmovo/);
    assert.equal(decode64([0x0f, 0x45, 0x03]).condition, 5);
    // SDM spelling, consistent with Jcc and SETcc: NE, not the NZ NASM also accepts.
    assert.match(decode64([0x0f, 0x45, 0x03]).toString(), /^cmovne/);
    assert.match(z.toString(), /^cmove/);
  });

  it('names the CMOVcc source as a memory operand when mod is not 3', () => {
    const mem = decode64([0x0f, 0x4c, 0x04, 0xcb]).operands[1];
    assert.equal(mem?.kind, 'mem');
  });

  it('decodes XADD, whose byte opcode is C0 and not the wide C1', () => {
    // 0F C0 is XADD r/m8, r8 and 0F C1 is XADD r/m, r - F0 is LOCK, a prefix, which is
    // why the two are not adjacent. Reading C0 with a 32-bit operand size makes an
    // 8-bit atomic add look like a 32-bit one.
    //
    // ModRM C3 is mod 11, so both operands are registers and neither gets an address
    // form; ModRM 03 is mod 00 and therefore memory.
    const byte = decode64([0x0f, 0xc0, 0xc3]);
    assert.equal(byte.mnemonic, Mnemonic.XADD);
    assert.deepEqual(byte.operands[0], { kind: 'reg', reg: Reg.BX, size: 8, highByte: false });
    assert.deepEqual(byte.operands[1], { kind: 'reg', reg: Reg.AX, size: 8, highByte: false });

    const byteMem = decode64([0x0f, 0xc0, 0x03]);
    assert.equal(byteMem.operands[0]?.kind, 'mem');
    assert.deepEqual(byteMem.operands[1], { kind: 'reg', reg: Reg.AX, size: 8, highByte: false });

    const wide = decode64([0x0f, 0xc1, 0x03]);
    assert.equal(wide.mnemonic, Mnemonic.XADD);
    assert.equal(wide.operands[0]?.kind, 'mem');
    assert.deepEqual(wide.operands[1], { kind: 'reg', reg: Reg.AX, size: 32 });
  });

  it('decodes CMPXCHG, whose byte opcode is B0 and not the wide B1', () => {
    // Same shape, different opcodes. CMPXCHG r/m8, r8 is defined by the SDM - it is
    // not one of the byte forms that are left undefined, so refusing it would be
    // refusing a real instruction.
    const byte = decode64([0x0f, 0xb0, 0xc3]);
    assert.equal(byte.mnemonic, Mnemonic.CMPXCHG);
    assert.deepEqual(byte.operands[0], { kind: 'reg', reg: Reg.BX, size: 8, highByte: false });
    assert.deepEqual(byte.operands[1], { kind: 'reg', reg: Reg.AX, size: 8, highByte: false });

    const wide = decode64([0x48, 0x0f, 0xb1, 0x03]);
    assert.equal(wide.mnemonic, Mnemonic.CMPXCHG);
    assert.equal(wide.operands[0]?.kind, 'mem');
    assert.deepEqual(wide.operands[1], { kind: 'reg', reg: Reg.AX, size: 64 });
  });
});

describe('decoder: disassembly text', () => {
  it('renders a readable instruction', () => {
    const insn = decode64([0x48, 0x8d, 0x44, 0x8b, 0x08]);
    const text = insn.toString();
    assert.match(text, /lea/);
    assert.match(text, /rbx/);
    assert.match(text, /rcx\*4/);
    assert.match(text, /bytes/);
  });

  it('prints the register width the instruction actually uses', () => {
    // `mov eax, ecx` and `mov rax, rcx` differ only in REX.W, so printing rax for both
    // misstates what the instruction does to the top half of the register.
    assert.match(decode64([0x0f, 0x44, 0xc1]).toString(), /eax/);
    assert.match(decode64([0x48, 0x0f, 0x44, 0xc1]).toString(), /rax/);
  });

  it('prints an 8-bit register by its byte name, including the R8B-R15B set', () => {
    assert.match(decode64([0x0f, 0x94, 0xc0]).toString(), /sete al/);
    // REX.B extends the rm field, so rm 100 becomes R12B - the whole point of the
    // 64-bit register file's byte half being separately named.
    assert.match(decode64([0x41, 0x0f, 0x94, 0xc4]).toString(), /sete r12b/);
    assert.match(decode64([0x41, 0x0f, 0x94, 0xc3]).toString(), /sete r11b/);
    // And the high byte names survive where there is no REX at all.
    assert.match(decode64([0x88, 0xe0]).toString(), /ah/);
  });

  it('prints 16-bit addressing with 16-bit register names and no scale factor', () => {
    // 16-bit addressing has no scale factor at all, so `[bx+si*1]` states a
    // multiplication with no encoding, and the registers are bx and si rather than rbx
    // and rsi.
    assert.match(decode16([0x8b, 0x00]).toString(), /\[bx\+si\]/);
    assert.doesNotMatch(decode16([0x8b, 0x00]).toString(), /rbx|\*1/);
  });
});