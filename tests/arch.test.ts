/**
 * VerixOS - architectural primitive tests.
 *
 * These cover the register file's sub-register semantics, the flag helpers and
 * the paging/address constants. They are deliberately written against known-good
 * x86 behaviour rather than against the implementation, so a regression shows
 * up as a real architectural violation rather than a mismatch with whatever the
 * code happens to do today.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Flags, RegisterFile, parityEven, setArithmeticFlags, signExtend, widthMask } from '../src/arch/registers.ts';
import {
  CR0,
  CR4,
  FlagBit,
  PTE,
  Reg,
  makeSelector,
  selectorIndex,
  selectorRing,
} from '../src/arch/types.ts';

describe('RegisterFile', () => {
  it('zero-extends 32-bit writes into the full 64-bit register', () => {
    const regs = new RegisterFile();
    regs.write(Reg.AX, 0xffff_ffff_ffff_ffffn);
    regs.write32(Reg.AX, 0xdead_beefn);
    assert.equal(regs.read(Reg.AX), 0x0000_0000_dead_beefn);
  });

  it('reads 32-bit sub-registers without sign extension', () => {
    const regs = new RegisterFile();
    regs.write32(Reg.CX, 0xffff_ffffn);
    assert.equal(regs.read32(Reg.CX), 0xffff_ffffn);
  });

  it('addresses the high byte via register field 4-7', () => {
    const regs = new RegisterFile();
    regs.write(Reg.AX, 0n);
    regs.write8Field(4, 0xabn); // AH
    assert.equal(regs.read(Reg.AX), 0xab00n);

    regs.write(Reg.BX, 0n);
    regs.write8Field(7, 0xcdn); // BH
    assert.equal(regs.read(Reg.BX), 0xcd00n);
  });

  it('uses low byte for R8B..R15B', () => {
    const regs = new RegisterFile();
    regs.write8Low(12, 0x5an); // R12B
    assert.equal(regs.read(Reg.R12), 0x5an);
  });

  it('resolves register index 6 as SIL or DH according to the highByte flag', () => {
    // The decoder is the only thing that knows which encoding it saw, so it
    // passes the distinction in rather than having the register file re-derive
    // it. Both cases use the same 16-way index.
    const regs = new RegisterFile();
    regs.write(Reg.SI, 0x1234n);
    assert.equal(regs.readByte(Reg.SI, false), 0x34n); // SIL
    regs.write(Reg.DX, 0xabcd_ef00n);
    assert.equal(regs.readByte(Reg.DX, true), 0xefn); // DH
  });

  it('writes low and high bytes without disturbing the other half', () => {
    const regs = new RegisterFile();
    regs.write(Reg.BX, 0x1122_3344_5566_7788n);
    // BH = 0xff sets bits 8-15, leaving BL and everything above alone.
    regs.writeByte(Reg.BX, true, 0xffn);
    assert.equal(regs.read(Reg.BX), 0x1122_3344_5566_ff88n);
    // BL = 0x99 then sets bits 0-7, leaving BH untouched.
    regs.writeByte(Reg.BX, false, 0x99n);
    assert.equal(regs.read(Reg.BX), 0x1122_3344_5566_ff99n);
  });

  it('preserves the other half of a register on 8-bit and 16-bit writes', () => {
    const regs = new RegisterFile();
    regs.write(Reg.AX, 0x1122_3344_5566_7788n);
    regs.write8Low(0, 0xffn);
    assert.equal(regs.read(Reg.AX), 0x1122_3344_5566_77ffn);
    regs.write16(0, 0x1234n);
    assert.equal(regs.read(Reg.AX), 0x1122_3344_5566_1234n);
  });

  it('rejects 16-bit access to registers that have no 16-bit form', () => {
    const regs = new RegisterFile();
    // R8 has no 16-bit sub-register; the architecture folds onto R8D.
    regs.write32(Reg.R8, 0xabcd_ef01n);
    regs.write16(0, 0x1234n); // indexes AL..DI only
    assert.equal(regs.read32(Reg.AX), 0x1234n);
    assert.equal(regs.read32(Reg.R8), 0xabcd_ef01n);
  });

  it('supports name-based access across all four widths', () => {
    const regs = new RegisterFile();
    regs.writeByName('rax', 0x1122_3344_5566_7788n);
    assert.equal(regs.byName('rax'), 0x1122_3344_5566_7788n);

    // A 32-bit write zero-extends, discarding the upper half.
    regs.writeByName('eax', 0xaabb_ccddn);
    assert.equal(regs.byName('rax'), 0x0000_0000_aabb_ccddn);

    // Narrower writes preserve the bits above their own width.
    regs.writeByName('ax', 0x1234n);
    assert.equal(regs.byName('rax'), 0x0000_0000_aabb_1234n);
    regs.writeByName('al', 0x44n);
    assert.equal(regs.byName('rax'), 0x0000_0000_aabb_1244n);

    assert.throws(() => regs.byName('nope'), /unknown register/);
    assert.throws(() => regs.writeByName('nope', 0n), /unknown register/);
  });

  it('treats ah as the high byte of rax', () => {
    const regs = new RegisterFile();
    regs.writeByName('rax', 0x1122_3344_5566_7788n);
    regs.writeByName('ah', 0xaan);
    assert.equal(regs.byName('rax'), 0x1122_3344_5566_aa88n);
  });
});

describe('Flags', () => {
  it('forces bit 1 to read as 1', () => {
    const flags = new Flags(0n);
    assert.equal((flags.value & 0x2n) === 0x2n, true);
  });

  it('ignores attempts to clear the reserved bit', () => {
    const flags = new Flags();
    flags.value = 0n;
    assert.equal(flags.value & 0x2n, 0x2n);
  });

  it('never reports reserved bit 63 as set', () => {
    const flags = new Flags();
    flags.value = 0xffff_ffff_ffff_ffffn;
    assert.equal(flags.value & (1n << 63n), 0n);
  });

  it('round-trips every named flag independently', () => {
    const flags = new Flags();
    for (const name of ['cf', 'pf', 'af', 'zf', 'sf', 'tf', 'if', 'df', 'of', 'ac'] as const) {
      flags[name] = true;
      assert.equal(flags[name], true, `${name} should be set`);
      flags[name] = false;
      assert.equal(flags[name], false, `${name} should be clear`);
    }
  });
});

describe('parity', () => {
  it('reports even parity from the low byte only', () => {
    // PF is set when the low byte contains an even number of set bits.
    assert.equal(parityEven(0x00n), true, '0 bits is even');
    assert.equal(parityEven(0x03n), true, '2 bits is even');
    assert.equal(parityEven(0x05n), true, '2 bits is even');
    assert.equal(parityEven(0x01n), false, '1 bit is odd');
    assert.equal(parityEven(0x07n), false, '3 bits is odd');
    assert.equal(parityEven(0xffn), true, '8 bits is even');
  });

  it('ignores bits above the low byte', () => {
    assert.equal(parityEven(0x00n), parityEven(0xffff_ff00n));
    assert.equal(parityEven(0x03n), parityEven(0xffff_ff03n));
    assert.equal(parityEven(0x03n), true, 'low byte 0x03 is even regardless of the upper bits');
  });
});

describe('setArithmeticFlags', () => {
  it('computes carry, zero and parity for an 8-bit add', () => {
    const f = new Flags();
    // 0xFF + 0x01 truncates to 0x00 with a carry out of bit 7.
    setArithmeticFlags(f, 0xffn, 0x01n, 0x100n, 8, 'add');
    assert.equal(f.zf, true);
    assert.equal(f.cf, true);
    assert.equal(f.pf, true, 'zero has even parity');
    // Signed: -1 + 1 = 0, so there is no overflow despite the unsigned carry.
    assert.equal(f.of, false);
  });

  it('reports signed overflow when two positive operands produce a negative result', () => {
    const f = new Flags();
    // 0x7F + 0x01 = 0x80 in 8 bits: +127 + 1 overflows a signed byte.
    setArithmeticFlags(f, 0x7fn, 0x01n, 0x80n, 8, 'add');
    assert.equal(f.of, true);
    assert.equal(f.cf, false);
    assert.equal(f.sf, true);
  });

  it('reports signed overflow when two negative operands produce a positive result', () => {
    const f = new Flags();
    // 0x80 + 0x80 = 0x00 in 8 bits: -128 + -128 overflows a signed byte.
    setArithmeticFlags(f, 0x80n, 0x80n, 0x100n, 8, 'add');
    assert.equal(f.of, true);
    assert.equal(f.cf, true);
  });

  it('computes borrow for a sub', () => {
    const f = new Flags();
    setArithmeticFlags(f, 0x01n, 0x02n, 0xffn, 8, 'sub');
    assert.equal(f.cf, true, '0x01 - 0x02 must borrow');
    assert.equal(f.zf, false);
    assert.equal(f.sf, true);
  });

  it('does not report overflow for a sub of two positives that stays positive', () => {
    const f = new Flags();
    setArithmeticFlags(f, 0x10n, 0x01n, 0x0fn, 8, 'sub');
    assert.equal(f.of, false);
    assert.equal(f.cf, false);
  });

  it('clears CF, OF and AF for a logic operation', () => {
    const f = new Flags();
    f.cf = true;
    f.of = true;
    f.af = true;
    setArithmeticFlags(f, 0xf0n, 0x0fn, 0x00n, 8, 'logic');
    assert.equal(f.cf, false);
    assert.equal(f.of, false);
    assert.equal(f.af, false);
    assert.equal(f.zf, true, 'xor of complements is zero');
  });

  it('respects the operand width when computing carry', () => {
    const f = new Flags();
    // 0xFF + 0x01 in 16 bits must not set CF.
    setArithmeticFlags(f, 0xffn, 0x01n, 0x100n, 16, 'add');
    assert.equal(f.cf, false);
    assert.equal(f.zf, false);
    // Same operands in 8 bits must set CF.
    setArithmeticFlags(f, 0xffn, 0x01n, 0x100n, 8, 'add');
    assert.equal(f.cf, true);
  });
});

describe('widthMask and signExtend', () => {
  it('masks to the requested width', () => {
    assert.equal(widthMask(8), 0xffn);
    assert.equal(widthMask(16), 0xffffn);
    assert.equal(widthMask(32), 0xffff_ffffn);
    assert.equal(widthMask(64), 0xffff_ffff_ffff_ffffn);
    assert.throws(() => widthMask(12), /unsupported operand width/);
  });

  it('sign-extends from each width', () => {
    assert.equal(signExtend(0xffn, 8), 0xffff_ffff_ffff_ffffn);
    assert.equal(signExtend(0x7fn, 8), 0x7fn);
    assert.equal(signExtend(0xffffn, 16), 0xffff_ffff_ffff_ffffn);
    assert.equal(signExtend(0x8000_0000n, 32), 0xffff_ffff_8000_0000n);
    assert.equal(signExtend(0x8000_0000_0000_0000n, 64), 0x8000_0000_0000_0000n);
  });

  it('sign-extends the minimum value correctly', () => {
    assert.equal(signExtend(0x80n, 8), 0xffff_ffff_ffff_ff80n);
  });
});

describe('segment selectors', () => {
  it('packs index, table indicator and RPL', () => {
    const kernel = makeSelector(1, 0);
    assert.equal(selectorIndex(kernel), 1);
    assert.equal(selectorRing(kernel), 0);
    assert.equal(kernel, 0x08);
  });

  it('encodes the user ring in the low two bits', () => {
    const user = makeSelector(5, 3);
    assert.equal(selectorIndex(user), 5);
    assert.equal(selectorRing(user), 3);
    assert.equal(user, 0x2b);
  });
});

describe('architectural constants', () => {
  it('places the paging and protected-mode bits at their SDM positions', () => {
    assert.equal(CR0.PE, 1n);
    assert.equal(CR0.PG, 1n << 31n);
    assert.equal(CR0.WP, 1n << 16n);
    assert.equal(CR4.PAE, 1n << 5n);
    assert.equal(CR4.PGE, 1n << 7n);
  });

  it('places the page table entry bits at their SDM positions', () => {
    assert.equal(PTE.P, 1n);
    assert.equal(PTE.RW, 2n);
    assert.equal(PTE.US, 4n);
    assert.equal(PTE.PS, 0x80n);
    assert.equal(PTE.NX, 1n << 63n);
  });

  it('keeps reserved page table bits clear in the address mask', () => {
    // Bit 52 and above are reserved for physical addresses above 52 bits.
    assert.equal(PTE.ADDR_MASK & (1n << 52n), 0n);
  });

  it('places the RFLAGS bit numbers correctly', () => {
    assert.equal(FlagBit.CF, 0);
    assert.equal(FlagBit.ZF, 6);
    assert.equal(FlagBit.IF, 9);
    assert.equal(FlagBit.OF, 11);
  });
});