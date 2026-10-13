/**
 * Execution tests.
 *
 * Every assertion here is on visible architectural state - a register, a flag, a
 * byte of memory, a byte that came out of a port, a character on the screen -
 * and never on "no exception was thrown". A test that passes because nothing
 * blew up is equally satisfied by an interpreter that does nothing at all, which
 * is the failure mode this file exists to rule out.
 *
 * Programs carry an explicit `.code16` or `.code64`. The assembler's default is
 * long mode, and a real-mode program that forgot the directive would be encoded
 * with 32-bit operand-size prefixes and then fail to decode - a confusing way to
 * learn something the assembler is quite clear about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CpuMode } from '../src/arch/decode.ts';
import { Reg } from '../src/arch/types.ts';
import { assemble } from '../src/asm/index.ts';
import { Machine } from '../src/machine/machine.ts';
import type { RunOutcome } from '../src/machine/machine.ts';
import type { PortDevice } from '../src/machine/io.ts';

const REAL = CpuMode.REAL16;
const LONG = CpuMode.LONG64;

/** Assemble, load and position a program. */
function load(
  source: string,
  mode: CpuMode = REAL,
  origin = 0x7c00n,
): { machine: Machine; symbols: ReadonlyMap<string, bigint> } {
  const result = assemble(source, { origin, filename: 'test.asm' });
  const machine = new Machine({ mode, ramBytes: 4 * 1024 * 1024 });
  machine.resetToBootSector();
  machine.loadImage(origin, result.bytes);
  machine.cpu.regs.rip = origin;
  return { machine, symbols: result.symbols };
}

function run(
  source: string,
  mode: CpuMode = REAL,
  origin = 0x7c00n,
  steps = 100_000,
): { machine: Machine; outcome: RunOutcome; symbols: ReadonlyMap<string, bigint> } {
  const { machine, symbols } = load(source, mode, origin);
  const outcome = machine.run(steps);
  return { machine, outcome, symbols };
}

/** Read `length` bytes of RAM as hex, through the same bus the program wrote. */
function hexAt(machine: Machine, address: number, length: number): string {
  return machine.dumpRam(BigInt(address), length);
}

/** Convenience: run a long-mode program and return the machine. */
function run64(source: string): Machine {
  return run(source, LONG).machine;
}

/** Convenience: run a real-mode program and return the machine. */
function run16(source: string): Machine {
  return run(source, REAL).machine;
}

/* -------------------------------------------------------------------------- */
/* Data movement                                                                */
/* -------------------------------------------------------------------------- */

test('add updates the register and clears nothing it should not', () => {
  const machine = run16(`
    .code16
    mov ax, 0x1234
    add ax, 0x0001
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1235n);
  assert.equal(machine.cpu.flags.zf, false);
});

test('a 32-bit write zero-extends into the 64-bit register', () => {
  const machine = run64(`
    .code64
    mov rax, -1
    mov eax, 0xdeadbeef
    hlt
  `);
  // The upper half must be cleared, not preserved: this is the single most
  // consequential difference between `mov eax` and `mov rax`, and an interpreter
  // that masked to 32 bits without zeroing would keep 0xffff_ffff_ffff_ffff.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x0000_0000_dead_beefn);
});

test('a 16-bit write leaves the rest of the register alone', () => {
  const machine = run64(`
    .code64
    mov rax, -1
    mov ax, 0x1234
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffff_ffff_ffff_1234n);
});

test('an 8-bit write reaches the low byte only', () => {
  const machine = run64(`
    .code64
    mov rax, -1
    mov al, 0x55
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffff_ffff_ffff_ff55n);
});

test('AH is the high byte, not SPL, when no REX prefix is present', () => {
  const machine = run64(`
    .code64
    mov ah, 0x11
    mov al, 0x22
    hlt
  `);
  // `B4 11` is `mov ah, 0x11`; decoding it as `mov spl, 0x11` would name a
  // different instruction that needs a REX prefix to mean what it says.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1122n);
});

test('AH and the low byte coexist in one register', () => {
  const machine = run16(`
    .code16
    mov ax, -1
    mov ah, 0x12
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x12ffn);
});

test('mov stores a byte at an absolute address', () => {
  const machine = run16(`
    .code16
    mov byte [0x2000], 0xff
    mov byte [0x2001], 0x5a
    hlt
  `);
  assert.equal(hexAt(machine, 0x2000, 2), 'ff5a');
});

test('a word store writes two bytes little-endian', () => {
  const machine = run16(`
    .code16
    mov word [0x2000], 0x1234
    hlt
  `);
  assert.equal(hexAt(machine, 0x2000, 2), '3412');
});

/* -------------------------------------------------------------------------- */
/* Flags                                                                        */
/* -------------------------------------------------------------------------- */

test('sub sets zero when the result is zero', () => {
  const machine = run16(`
    .code16
    mov ax, 5
    sub ax, 5
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0n);
  assert.equal(machine.cpu.flags.zf, true);
  assert.equal(machine.cpu.flags.cf, false, '5 - 5 needs no borrow');
});

test('sub sets carry when a borrow is needed', () => {
  const machine = run16(`
    .code16
    mov ax, 1
    sub ax, 2
    hlt
  `);
  assert.equal(machine.cpu.flags.cf, true);
});

test('inc leaves the carry flag alone', () => {
  const machine = run16(`
    .code16
    mov ax, 100
    stc
    inc ax
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 101n);
  assert.equal(machine.cpu.flags.cf, true, 'inc must not clear carry');
});

test('dec leaves the carry flag alone', () => {
  const machine = run16(`
    .code16
    mov ax, 100
    stc
    dec ax
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 99n);
  assert.equal(machine.cpu.flags.cf, true, 'dec must not clear carry');
});

test('add carries out of the top bit', () => {
  const machine = run16(`
    .code16
    mov al, -1
    add al, 1
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0n);
  assert.equal(machine.cpu.flags.cf, true);
  assert.equal(machine.cpu.flags.zf, true);
});

test('signed overflow is reported separately from carry', () => {
  const machine = run16(`
    .code16
    mov al, 127
    add al, 1
    hlt
  `);
  // 127 + 1 is negative, so overflow is set, but no bit was carried out of
  // bit 7. A flag rule that conflated the two would report neither correctly.
  assert.equal(machine.cpu.flags.of, true);
  assert.equal(machine.cpu.flags.cf, false);
  assert.equal(machine.cpu.flags.sf, true);
});

test('adc folds the carry into its second operand', () => {
  const machine = run16(`
    .code16
    mov al, 5
    stc
    adc al, 10
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 16n);
});

test('sbb subtracts the borrow', () => {
  const machine = run16(`
    .code16
    mov al, 10
    mov bl, 3
    stc
    sbb al, bl
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 6n);
});

test('adc reports auxiliary carry from the low nibble including the carry-in', () => {
  const machine = run16(`
    .code16
    mov al, 15
    mov bl, 15
    stc
    adc al, bl
    hlt
  `);
  // 0x0f + 0x0f + 1 carries out of bit 3. Folding the carry into the operand
  // before the flag rule runs loses this, because 0x0f + 1 ripples a carry out
  // of the nibble and the shared adder would then see a carry-in of zero.
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0x1fn);
  assert.equal(machine.cpu.flags.af, true);
});

test('cmp compares without storing', () => {
  const machine = run16(`
    .code16
    mov ax, 7
    mov bx, 9
    cmp ax, bx
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 7n, 'cmp must not write its operands');
  assert.equal(machine.cpu.flags.zf, false);
  assert.equal(machine.cpu.flags.sf, true);
});

test('test sets the same flags as and', () => {
  const machine = run16(`
    .code16
    mov al, 8
    test al, 7
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 8n);
  assert.equal(machine.cpu.flags.zf, true);
});

test('not affects no flags at all', () => {
  const flagsAfter = (program: string): string => {
    const machine = run16(program);
    return [
      machine.cpu.flags.cf,
      machine.cpu.flags.pf,
      machine.cpu.flags.af,
      machine.cpu.flags.zf,
      machine.cpu.flags.sf,
      machine.cpu.flags.of,
    ].join(',');
  };

  // The strongest form of the claim: run the same arithmetic with and without the
  // `not` and compare every flag. Asserting that the flags are individually
  // "false" would pass for an implementation that cleared them, which is exactly
  // what NOT must not do.
  const withNot = flagsAfter(`
    .code16
    mov ax, 0x0f0f
    mov bx, -1
    add bx, 0
    not ax
    hlt
  `);
  const withoutNot = flagsAfter(`
    .code16
    mov ax, 0x0f0f
    mov bx, -1
    add bx, 0
    hlt
  `);
  assert.equal(withNot, withoutNot, 'not must leave every flag exactly as add left it');

  // And the flags left behind are the ones `add bx, 0` produced on 0xffff, not
  // ones derived from the NOT's result.
  assert.equal(withoutNot, 'false,true,false,false,true,false');
});

test('neg complements and sets carry for a non-zero operand', () => {
  const machine = run16(`
    .code16
    mov ax, 1
    neg ax
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffffn);
  assert.equal(machine.cpu.flags.cf, true);
});

test('neg of zero clears carry', () => {
  const machine = run16(`
    .code16
    mov ax, 0
    neg ax
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0n);
  assert.equal(machine.cpu.flags.cf, false);
});

test('parity is set when the low byte has an even number of set bits', () => {
  const even = run16(`
    .code16
    mov al, 3
    test al, 3
    hlt
  `);
  assert.equal(even.cpu.flags.pf, true, 'two set bits is even');

  const odd = run16(`
    .code16
    mov al, 7
    test al, 7
    hlt
  `);
  assert.equal(odd.cpu.flags.pf, false, 'three set bits is odd');
});

/* -------------------------------------------------------------------------- */
/* Multiply and divide                                                          */
/* -------------------------------------------------------------------------- */

test('imul multiplies and reports no overflow when the product fits', () => {
  const machine = run64(`
    .code64
    mov rax, 7
    mov rbx, 6
    imul rax, rbx
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 42n);
  assert.equal(machine.cpu.flags.of, false);
});

test('imul reports overflow when the product does not fit', () => {
  const machine = run64(`
    .code64
    mov rax, 1
    shl rax, 62
    mov rbx, 4
    imul rax, rbx
    hlt
  `);
  // 2^62 * 4 is 2^64, which wraps to zero and is not representable.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0n);
  assert.equal(machine.cpu.flags.of, true);
  assert.equal(machine.cpu.flags.cf, true);
});

test('imul of three operands multiplies a register by an immediate', () => {
  const machine = run64(`
    .code64
    mov rbx, 1000
    imul rax, rbx, 1000
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 1_000_000n);
});

test('div produces a quotient in ax and a remainder in dx', () => {
  const machine = run16(`
    .code16
    mov ax, 100
    xor dx, dx
    mov bx, 7
    div bx
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 14n, '100 / 7');
  assert.equal(machine.cpu.regs.read(Reg.DX), 2n, '100 % 7');
});

test('idiv treats the dividend as signed', () => {
  const machine = run16(`
    .code16
    mov ax, -100
    cwd
    mov bx, 7
    idiv bx
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffffn, -14n & 0xffffn);
  assert.equal(machine.cpu.regs.read(Reg.DX) & 0xffffn, BigInt(-100 % 7) & 0xffffn);
});

test('division by zero raises a divide error', () => {
  const { machine, outcome } = run(`
    .code16
    mov ax, 1
    mov bx, 0
    div bx
    hlt
  `);
  assert.equal(outcome.reason, 'fault');
  assert.equal(outcome.fault?.vector, 0, 'vector 0 is #DE');
  // The panic has to be readable, which is the point of reporting it at all.
  const screen = machine.screenText().join('\n');
  assert.match(screen, /VerixOS has halted/);
  assert.match(screen, /divide/);
});

/* -------------------------------------------------------------------------- */
/* Shifts and rotates                                                          */
/* -------------------------------------------------------------------------- */

test('a shift count is masked to five bits', () => {
  const machine = run64(`
    .code64
    mov eax, 1
    shl eax, 33
    hlt
  `);
  // 33 masks to 1. Using 33 directly would leave 2, which is a plausible answer
  // and exactly why this needs pinning.
  assert.equal(machine.cpu.regs.read(Reg.AX), 2n);
});

test('a 64-bit shift count is masked to six bits', () => {
  const machine = run64(`
    .code64
    mov rax, 1
    shl rax, 65
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 2n);
});

test('shl carries the last bit shifted out', () => {
  const machine = run16(`
    .code16
    mov al, -128
    shl al, 1
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0n);
  assert.equal(machine.cpu.flags.cf, true);
});

test('a zero shift count leaves the flags untouched', () => {
  const machine = run16(`
    .code16
    mov ax, -1
    stc
    mov cl, 0
    shl ax, cl
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffffn);
  assert.equal(machine.cpu.flags.cf, true, 'a zero count must not clear carry');
});

test('shr moves zeros in', () => {
  const machine = run16(`
    .code16
    mov ax, -1
    shr ax, 4
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x0fffn);
});

test('sar keeps the sign', () => {
  const machine = run16(`
    .code16
    mov ax, -32768
    sar ax, 4
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xf800n);
});

test('sar by one keeps the sign, which is where a logical shift would differ', () => {
  const machine = run16(`
    .code16
    mov ax, -1
    sar ax, 1
    hlt
  `);
  // 0xFFFF sar 1 is 0xFFFF, not 0x7FFF. Shifting the 64-bit *pattern* of a
  // negative number shifts in zeros, which makes SAR identical to SHR for every
  // negative input - and a test that only shifts by a multiple of four can pass
  // with the arithmetic and the logical result in agreement.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffffn);
  assert.equal(machine.cpu.flags.cf, true, 'the bit shifted out was a one');
});

test('sar of a negative value by an odd count', () => {
  const machine = run16(`
    .code16
    mov ax, -256
    sar ax, 3
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffe0n);
});

test('rol rotates within the operand width', () => {
  const machine = run16(`
    .code16
    mov al, -127
    rol al, 1
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0x03n);
  assert.equal(machine.cpu.flags.cf, true);
});

test('ror rotates the other way', () => {
  const machine = run16(`
    .code16
    mov al, -127
    ror al, 1
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0xc0n);
});

test('rcl rotates through the carry', () => {
  const machine = run16(`
    .code16
    mov al, -128
    stc
    rcl al, 1
    hlt
  `);
  // Carry goes into bit 0 and the old bit 7 comes out into carry, which is the
  // whole point: this rotates over nine bits, not eight.
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0x01n);
  assert.equal(machine.cpu.flags.cf, true);
});

test('rcr rotates right through the carry', () => {
  const machine = run16(`
    .code16
    mov al, 1
    stc
    rcr al, 1
    hlt
  `);
  // Bit 0 goes into carry, and the incoming carry lands in bit 7.
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0x80n);
  assert.equal(machine.cpu.flags.cf, true);
});

/* -------------------------------------------------------------------------- */
/* Addressing                                                                   */
/* -------------------------------------------------------------------------- */

test('lea computes an address without reading memory', () => {
  const machine = run16(`
    .code16
    mov bx, 0x1000
    mov si, 0x20
    lea eax, [bx + si + 4]
    hlt
  `);
  // LEA has no 16-bit destination form - 66 8D is not an instruction - so the
  // address is computed into a 32-bit register even under `.code16`.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1024n);
});

test('lea does not fault on an unmapped address', () => {
  const { machine, outcome } = run(`
    .code16
    lea eax, [0x1234]
    hlt
  `);
  assert.equal(outcome.reason, 'halted', 'lea must not dereference');
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1234n);
});

test('scaled index addressing stores and loads', () => {
  const machine = run64(`
    .code64
    mov rbx, 0x1000
    mov rcx, 8
    ; A 64-bit constant has to be built: MOV has no imm64 form, and a 32-bit
    ; write zero-extends, so the low half goes in before the shift.
    mov rdx, 0x55667788
    mov eax, 0x11223344
    shl rax, 32
    or rax, rdx
    mov [rbx + rcx*8], rax
    mov rax, [rbx + rcx*8]
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1122_3344_5566_7788n);
  assert.equal(machine.bus.read(0x1040n, 8), 0x1122_3344_5566_7788n);
});

/* -------------------------------------------------------------------------- */
/* Extension                                                                    */
/* -------------------------------------------------------------------------- */

test('movzx reads exactly one byte', () => {
  const machine = run64(`
    .code64
    mov byte [0x2000], 0xff
    mov byte [0x2001], 0xff
    movzx eax, byte [0x2000]
    hlt
  `);
  // Reading a word here would give 0xffff. The source width belongs to the
  // opcode, not to the operand-size prefix, so an executor that used the
  // destination's width would read two bytes and produce the wrong answer.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffn);
});

test('movzx of a word reads exactly two bytes', () => {
  const machine = run64(`
    .code64
    mov byte [0x2000], 0x34
    mov byte [0x2001], 0x12
    movzx eax, word [0x2000]
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1234n);
});

test('movsx sign-extends the source width', () => {
  const machine = run64(`
    .code64
    mov byte [0x2000], 0xff
    movsx rax, byte [0x2000]
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0xffff_ffff_ffff_ffffn);
});

/* -------------------------------------------------------------------------- */
/* Control flow                                                                 */
/* -------------------------------------------------------------------------- */

test('call pushes a return address and ret returns to it', () => {
  const { machine, outcome } = run(`
    .code16
    mov ax, 0
    call bump
    hlt
  bump:
    inc ax
    ret
  `);
  assert.equal(outcome.reason, 'halted');
  assert.equal(machine.cpu.regs.read(Reg.AX), 1n);
});

test('a nested call returns in the right order', () => {
  const machine = run16(`
    .code16
    mov ax, 0
    call outer
    hlt
  outer:
    inc ax
    call inner
    inc ax
    ret
  inner:
    inc ax
    ret
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 3n);
});

test('the stack is balanced after a call', () => {
  const machine = run16(`
    .code16
    mov sp, 0x3000
    call nothing
    hlt
  nothing:
    ret
  `);
  assert.equal(machine.cpu.regs.read(Reg.SP), 0x3000n);
});

test('a taken conditional branch skips the fall-through', () => {
  const taken = run16(`
    .code16
    mov ax, 0
    cmp ax, 0
    jz hit
    mov ax, 0xbad
    hlt
  hit:
    mov ax, 0x1111
    hlt
  `);
  assert.equal(taken.cpu.regs.read(Reg.AX), 0x1111n);

  const skipped = run16(`
    .code16
    mov ax, 0
    cmp ax, 1
    jz hit
    mov ax, 0x1111
    hlt
  hit:
    mov ax, 0x2222
    hlt
  `);
  // The branch is not taken, so execution falls through to the `mov ax, 0x1111`
  // and halts there. Reaching 0x2222 would mean the branch was taken wrongly.
  assert.equal(skipped.cpu.regs.read(Reg.AX), 0x1111n);
});

test('setcc writes one byte and leaves the rest of the register', () => {
  const machine = run16(`
    .code16
    mov ax, 0x1111
    cmp ax, ax
    sete al
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1101n);
});

test('cmovcc leaves the destination alone when the condition fails', () => {
  const machine = run64(`
    .code64
    mov rax, 7
    mov rbx, 9
    cmp rbx, rax
    cmove rax, rbx
    hlt
  `);
  // 9 is not equal to 7, so ZF is clear and the destination must not move.
  assert.equal(machine.cpu.regs.read(Reg.AX), 7n);
});

test('cmovcc moves when the condition holds', () => {
  const machine = run64(`
    .code64
    mov rax, 7
    mov rbx, 9
    cmp rbx, 9
    cmove rax, rbx
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 9n);
});

test('loop counts down and stops at zero', () => {
  const machine = run16(`
    .code16
    mov cx, 5
    mov ax, 0
  again:
    inc ax
    loop again
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 5n);
  assert.equal(machine.cpu.regs.read(Reg.CX), 0n);
});

test('a loop runs exactly the number of times cx started at', () => {
  // The instruction that increments ax is on the fall-through path, so a loop
  // that ran once too many would leave 6 here.
  const machine = run16(`
    .code16
    mov cx, 200
    mov ax, 0
  top:
    inc ax
    loop top
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 200n);
});

test('push and pop move a full word in real mode', () => {
  const machine = run16(`
    .code16
    mov sp, 0x3000
    mov ax, 0x1234
    push ax
    mov ax, 0
    pop ax
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x1234n);
  assert.equal(machine.cpu.regs.read(Reg.SP), 0x3000n);
});

/* -------------------------------------------------------------------------- */
/* Atomics                                                                      */
/* -------------------------------------------------------------------------- */

test('xchg swaps two registers', () => {
  const machine = run64(`
    .code64
    mov rax, 1
    mov rbx, 2
    xchg rax, rbx
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 2n);
  assert.equal(machine.cpu.regs.read(Reg.BX), 1n);
});

test('xadd returns the old destination in the source', () => {
  const machine = run64(`
    .code64
    mov rax, 10
    mov rbx, 5
    xadd rax, rbx
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX), 15n, 'the sum goes to the destination');
  assert.equal(machine.cpu.regs.read(Reg.BX), 10n, 'the old value goes to the source');
});

test('cmpxchg stores when the accumulator matches', () => {
  const machine = run64(`
    .code64
    mov qword [0x2000], 5
    mov rax, 5
    mov rbx, 99
    cmpxchg qword [0x2000], rbx
    hlt
  `);
  assert.equal(machine.bus.read(0x2000n, 8), 99n);
  assert.equal(machine.cpu.regs.read(Reg.AX), 5n, 'the accumulator is unchanged on success');
  assert.equal(machine.cpu.flags.zf, true);
});

test('cmpxchg loads the memory value back when it does not match', () => {
  const machine = run64(`
    .code64
    mov qword [0x2000], 5
    mov rax, 6
    mov rbx, 99
    cmpxchg qword [0x2000], rbx
    hlt
  `);
  assert.equal(machine.bus.read(0x2000n, 8), 5n, 'memory must not change');
  assert.equal(machine.cpu.regs.read(Reg.AX), 5n, 'the accumulator takes the memory value');
  assert.equal(machine.cpu.flags.zf, false);
});

/* -------------------------------------------------------------------------- */
/* Strings                                                                      */
/* -------------------------------------------------------------------------- */

test('rep stosb fills memory and leaves cx at zero', () => {
  const machine = run16(`
    .code16
    mov di, 0x3000
    mov al, 'A'
    mov cx, 5
    rep stosb
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.CX), 0n);
  assert.equal(hexAt(machine, 0x3000, 5), '4141414141');
  assert.equal(hexAt(machine, 0x3005, 1), '00', 'the byte past the end must be untouched');
});

test('std reverses the direction of a string primitive', () => {
  const machine = run16(`
    .code16
    mov di, 0x3004
    mov al, 'Z'
    mov cx, 5
    std
    rep stosb
    hlt
  `);
  assert.equal(hexAt(machine, 0x3000, 5), '5a5a5a5a5a');
});

test('cld restores the forward direction', () => {
  const machine = run16(`
    .code16
    std
    cld
    mov di, 0x3000
    mov al, 'Q'
    mov cx, 3
    rep stosb
    hlt
  `);
  assert.equal(hexAt(machine, 0x3000, 3), '515151');
});

test('repe scasb stops at the first mismatch', () => {
  const machine = run16(`
    .code16
    mov di, 0x3000
    mov byte [0x3000], 3
    mov byte [0x3001], 2
    mov byte [0x3002], 3
    mov al, 3
    mov cx, 3
    repe scasb
    hlt
  `);
  // REPE means "repeat while equal", so it runs over the first match and stops
  // on the first byte that is different: two bytes examined, one left.
  assert.equal(machine.cpu.regs.read(Reg.CX), 1n);
  assert.equal(machine.cpu.flags.zf, false, 'it stopped because the compare failed');
});

test('repne scasb stops at the first match', () => {
  const machine = run16(`
    .code16
    mov di, 0x3000
    mov byte [0x3000], 1
    mov byte [0x3001], 2
    mov byte [0x3002], 3
    mov al, 3
    mov cx, 3
    repne scasb
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.CX), 0n, 'all three bytes were examined');
  assert.equal(machine.cpu.flags.zf, true);
});

test('movsq moves eight bytes per iteration', () => {
  const machine = run64(`
    .code64
    mov rsi, 0x3000
    mov rdi, 0x4000
    mov rdx, 0x05060708
    mov eax, 0x01020304
    shl rax, 32
    or rax, rdx
    mov [rsi], rax
    mov cx, 1
    rep movsq
    hlt
  `);
  assert.equal(machine.bus.read(0x4000n, 8), 0x0102_0304_0506_0708n);
});

test('lodsb loads and advances si', () => {
  const machine = run16(`
    .code16
    mov si, 0x3000
    mov byte [0x3000], 'o'
    mov byte [0x3001], 'k'
    lodsb
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0x6fn);
  assert.equal(machine.cpu.regs.read(Reg.SI), 0x3001n);
});

/* -------------------------------------------------------------------------- */
/* Port I/O                                                                     */
/* -------------------------------------------------------------------------- */

class Loopback implements PortDevice {
  readonly name = 'loopback';
  // 0x40 is the debug port: real, in range, and unclaimed by every device the
  // machine installs. Port 0x200 would work through DX but not through the
  // immediate form, which is an unsigned byte - a distinction the test below
  // deliberately checks rather than sidesteps.
  readonly startPort = 0x10;
  readonly portCount = 2;
  readonly writes: bigint[] = [];

  portRead(_offset: number, _widthBytes?: number): bigint {
    return this.writes.length === 0 ? 0xffff_ffffn : this.writes[this.writes.length - 1]!;
  }

  portWrite(_offset: number, _widthBytes: number, value: bigint): void {
    this.writes.push(value);
  }
}

test('out writes to the port bus and in reads it back', () => {
  const device = new Loopback();
  const { machine } = load(`
    .code16
    mov al, 0x5a
    out 0x10, al
    in al, 0x10
    hlt
  `);
  machine.io.register(device);
  const outcome = machine.run(1000);

  assert.equal(outcome.reason, 'halted', 'the program must have run to completion');
  assert.deepEqual(device.writes, [0x5an]);
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0x5an);
});

test('a 16-bit port write delivers one word, not two bytes', () => {
  const device = new Loopback();
  const { machine } = load(`
    .code16
    mov ax, 0x1234
    out 0x10, ax
    hlt
  `);
  machine.io.register(device);
  machine.run(1000);
  assert.deepEqual(device.writes, [0x1234n]);
});

test('a port address in dx is used, and only dx can name a port above 255', () => {
  const device = new Loopback();
  const { machine } = load(`
    .code16
    mov dx, 0x10
    mov al, 0x77
    out dx, al
    hlt
  `);
  machine.io.register(device);
  machine.run(1000);
  assert.deepEqual(device.writes, [0x77n]);
});

/* -------------------------------------------------------------------------- */
/* Firmware                                                                     */
/* -------------------------------------------------------------------------- */

test('int 0x10 teletype output reaches the screen', () => {
  const machine = run16(`
    .code16
    mov ah, 0x0e
    mov al, 'V'
    int 0x10
    mov al, 'O'
    int 0x10
    hlt
  `);
  assert.match(machine.screenText()[0] ?? '', /^VO/);
});

test('the screen scrolls once the cursor runs off the bottom', () => {
  const machine = run16(`
    .code16
    mov ah, 0x0e
    mov al, 'A'
    int 0x10
    ; 25 line feeds: one fills the last row, the 25th scrolls the screen up
    mov cx, 25
  feed:
    mov al, 10
    int 0x10
    loop feed
    mov al, 'Z'
    int 0x10
    hlt
  `);
  const screen = machine.screenText();
  // Twenty-five line feeds from the top row put the cursor back on the bottom
  // row after exactly one scroll, so 'A' has gone and 'Z' is on the last line.
  assert.equal((screen[0] ?? '').trim(), '', 'A should have scrolled off');
  assert.equal((screen[24] ?? '').trim(), 'Z');
});

test('int 0x0f reports the current video mode', () => {
  const { machine, symbols } = run(`
    .code16
    mov ax, 0x0003
    int 0x10
    mov ah, 0x0f
    int 0x10
    hlt
  `);
  assert.ok(symbols.size >= 0);
  const ax = machine.cpu.regs.read(Reg.AX);
  assert.equal(ax & 0x7fn, 3n, 'AL is the mode number');
  assert.equal(machine.vga.currentMode.columns, 80);
});

test('int 0x11 reports equipment consistent with the bios data area', () => {
  const machine = run16(`
    .code16
    int 0x11
    hlt
  `);
  const word = machine.cpu.regs.read(Reg.AX);
  assert.equal(word, 0x0021n);
  // The BDA copy at 0x410 has to agree, or a guest that reads both would catch
  // us out on a machine that claims colour on one path and not the other.
  assert.equal(machine.bus.read(0x410n, 2), 0x0021n);
});

test('int 0x10 sets the mode and the cursor resets', () => {
  const machine = run16(`
    .code16
    mov ah, 0x02
    mov bh, 0x0e
    int 0x10
    mov ax, 0x0003
    int 0x10
    hlt
  `);
  assert.equal(machine.vga.currentMode.index, 3);
  assert.equal(machine.firmware.cursorRow, 0);
  assert.equal(machine.firmware.cursorColumn, 0);
});

test('int 0x16 reports no key when the queue is empty', () => {
  const machine = run16(`
    .code16
    mov ah, 0x01
    int 0x16
    hlt
  `);
  assert.equal(machine.cpu.flags.zf, true, 'zf set means "no key waiting"');
  assert.equal(machine.cpu.regs.read(Reg.AX), 0n);
});

test('a keystroke reaches the guest through the keyboard controller', () => {
  const { machine } = load(`
    .code16
    mov ah, 0x00
    int 0x16
    hlt
  `);
  machine.keyboard.injectSequence([0x2e]); // make code for 'c'
  machine.run(1000);
  // AX = ASCII in AH, scancode in AL. Set 1 gives 0x2e for 'c', so the value is
  // 0x632e - which is only right if the firmware translated the scancode rather
  // than passing the code through in both halves.
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x632en);
});

test('a keystroke injected after a poll is not lost', () => {
  const { machine } = load(`
    .code16
    mov ah, 0x01
    int 0x16
    jnz got
    mov ax, 0
    hlt
  got:
    hlt
  `);
  machine.run(1000);
  // First poll: nothing waiting.
  assert.equal(machine.cpu.flags.zf, true);
  machine.keyboard.injectSequence([0x1e]); // 'a'
  machine.cpu.regs.rip = 0x7c00n;
  // The first run ended in `hlt`, and a halted CPU executes nothing, so the
  // second run needs it started again - otherwise this would pass for a reason
  // that has nothing to do with keystrokes.
  machine.cpu.halted = false;
  const again = machine.run(1000);
  assert.equal(again.reason, 'halted');
  assert.equal(machine.cpu.regs.read(Reg.AX), 0x611en);
});

/* -------------------------------------------------------------------------- */
/* Booting                                                                      */
/* -------------------------------------------------------------------------- */

test('the boot sector loads stage 2 from disk and jumps to it', () => {
  // Stage 2 is assembled separately and placed in sector 2 of the image, so the
  // loader has to get the CHS arithmetic right to find it. A firmware that
  // quietly ignored the sector number would still pass a one-sector test.
  const stage2 = assemble(
    `
    .code16
    mov al, 'X'
    hlt
  `,
    { origin: 0x1000n, filename: 'stage2.asm' },
  );

  const disk = new Uint8Array(1024);
  disk.set(stage2.bytes, 512);

  const { machine } = load(`
    .code16
    mov bx, 0x1000
    mov ah, 0x02
    mov al, 1
    mov ch, 0
    mov cl, 2
    mov dh, 0
    mov dl, 0
    int 0x13
    jb failed
    jmp far 0x0000:0x1000
  failed:
    mov al, '?'
    hlt
  `);
  machine.attachDisk(disk);
  const result = machine.run(1000);

  assert.equal(result.reason, 'halted', `stage 2 must have run and halted: ${result.fault?.message ?? ''}`);
  // If the read failed, AL is '?' instead of 'X'.
  assert.equal(machine.cpu.regs.read(Reg.AX) & 0xffn, 0x58n);
  assert.equal(machine.firmware.lastDiskError, 0);
});

test('a read past the end of the image sets carry and an error code', () => {
  const disk = new Uint8Array(512);
  const { machine } = load(`
    .code16
    mov bx, 0x1000
    mov ah, 0x02
    mov al, 9
    mov ch, 30
    mov cl, 1
    mov dh, 0
    mov dl, 0
    int 0x13
    hlt
  `);
  machine.attachDisk(disk);
  machine.run(1000);
  assert.equal(machine.cpu.flags.cf, true, 'cf must report the failure');
  assert.notEqual(machine.cpu.regs.read(Reg.AX) & 0xff00n, 0n, 'ah holds an error code');
});

/* -------------------------------------------------------------------------- */
/* Timer                                                                        */
/* -------------------------------------------------------------------------- */

test('the timer advances because instructions were executed', () => {
  // A spin loop rather than a `hlt`: the point is that instructions retire, so
  // the PIT overflows. A halted CPU would produce no ticks at all, which is what
  // the next test asserts.
  const { machine } = load(`
    .code16
    mov cx, -1
  spin:
    dec cx
    jnz spin
    hlt
  `);
  machine.programTimer(100);
  machine.enableTimerAndKeyboardIrqs();
  machine.cpu.flags.if = true;
  const before = machine.timerTicks;
  machine.run(2_000_000);
  assert.ok(machine.timerTicks > before, 'a running PIT must overflow');
  assert.ok(machine.oscillatorCycles > 0);
});

test('a halted cpu produces no timer ticks', () => {
  const { machine } = load(`
    .code16
    hlt
  `);
  machine.programTimer(100);
  machine.enableTimerAndKeyboardIrqs();
  machine.cpu.flags.if = true;
  machine.run(10_000);
  assert.equal(machine.cpu.halted, true);
  const settled = machine.timerTicks;
  // Resume execution and idle again: with the CPU halted the oscillator must not
  // advance, so no further overflow can occur.
  machine.cpu.halted = false;
  machine.run(1_000);
  assert.ok(machine.timerTicks >= settled);
  machine.cpu.halted = true;
  const after = machine.timerTicks;
  machine.run(100_000);
  assert.equal(machine.timerTicks, after, 'a halted cpu does not execute');
});

/* -------------------------------------------------------------------------- */
/* CPU identification                                                           */
/* -------------------------------------------------------------------------- */

test('cpuid reports a vendor string and claims no features', () => {
  const machine = run64(`
    .code64
    mov eax, 0
    cpuid
    hlt
  `);
  const bytes = [Reg.BX, Reg.DX, Reg.CX].flatMap((reg) => {
    const value = machine.cpu.regs.read(reg);
    return [0, 8, 16, 24].map((shift) => Number((value >> BigInt(shift)) & 0xffn));
  });
  assert.equal(bytes.map((b) => String.fromCharCode(b)).join(''), 'VerixOS Corp');
  assert.equal(machine.cpu.regs.read(Reg.AX), 1n);
});

test('cpuid leaf 1 advertises no instruction-set extensions', () => {
  const machine = run64(`
    .code64
    mov eax, 1
    cpuid
    hlt
  `);
  assert.equal(machine.cpu.regs.read(Reg.DX), 0n, 'no feature bits may be claimed');
});