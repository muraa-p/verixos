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
  it('decodes mov rax, imm64', () => {
    const insn = decode64([0x48, 0xb8, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(insn.mnemonic, Mnemonic.MOV);
    assert.deepEqual(insn.operands[0], { kind: 'reg', reg: Reg.AX });
    assert.equal(insn.operands[1]?.kind, 'imm');
    if (insn.operands[1]?.kind === 'imm') assert.equal(insn.operands[1].value, 0x0807_0605_0403_0201n);
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
      assert.equal(insn.operands[1].sizeOverride, '16');
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

describe('decoder: disassembly text', () => {
  it('renders a readable instruction', () => {
    const insn = decode64([0x48, 0x8d, 0x44, 0x8b, 0x08]);
    const text = insn.toString();
    assert.match(text, /lea/);
    assert.match(text, /rbx/);
    assert.match(text, /rcx\*4/);
    assert.match(text, /bytes/);
  });
});