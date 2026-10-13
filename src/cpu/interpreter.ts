/**
 * VerixOS - the instruction interpreter.
 *
 * The decoder turns bytes into an `Instruction`; this turns an `Instruction` into
 * changes in architectural state. The split is deliberate and is the reason both
 * halves can be tested independently: the decoder is checked by round-tripping
 * against the assembler, and the interpreter is checked by executing assembled
 * code and asserting on the register file, the memory bus and the port bus.
 *
 * Three rules hold everywhere in this file and are worth stating once rather than
 * repeating at each of the hundred call sites below.
 *
 *  1. **Every write is masked to the operand's own width.** A 32-bit write to a
 *     64-bit register is not "write these 32 bits"; it is "write these 32 bits and
 *     zero the upper half", and a 8/16-bit write leaves the upper bits alone. The
 *     masking is done in one place (`writeGpr`) so a hundred instruction cases
 *     cannot each get it subtly wrong.
 *
 *  2. **Flags are computed by `setArithmeticFlags`, never inline.** That function
 *     encodes the carry, auxiliary-carry and overflow rules for add, subtract and
 *     logic, and it is shared by the tests that check flag behaviour against the
 *     SDM's truth tables. Computing a flag at a call site would create a second
 *     source of truth for the same rule.
 *
 *  3. **A memory operand's width comes from `operandWidth`, not from the operand
 *     size.** They are independent: `0F B6 03` is `movzx eax, byte [rbx]`, a
 *     32-bit destination reading one byte. An executor that used the operand size
 *     would read four bytes from `[rbx]` and compute a different value.
 */

import { Reg } from '../arch/types.ts';
import {
  Flags,
  RegisterFile,
  fitsSigned,
  setArithmeticFlags,
  signExtend,
  signedValue,
  widthMask,
} from '../arch/registers.ts';
import { Mnemonic, AluOp, ShiftOp } from '../arch/decode.ts';
import type { Instruction, Operand } from '../arch/decode.ts';

/** The subset of a memory bus the CPU needs. */
export interface CpuBus {
  read(addr: bigint, widthBytes: number): bigint;
  write(addr: bigint, widthBytes: number, value: bigint): void;
}

/** The subset of a port bus the CPU needs. */
export interface CpuIo {
  read(port: number, widthBytes: number): bigint;
  write(port: number, value: bigint, widthBytes: number): void;
}

/**
 * A decoded instruction together with the address it was decoded at.
 *
 * The interpreter needs the length for return addresses and for RIP-relative
 * addressing, and the address for the same reason; both are fields of the
 * `Instruction` already, so this alias is documentation rather than a wrapper.
 */
export type Executable = Instruction;

export class CpuFault extends Error {
  readonly vector: number;
  readonly address: bigint;

  constructor(vector: number, address: bigint, message: string) {
    super(`${message} at 0x${address.toString(16)}`);
    this.name = 'CpuFault';
    this.vector = vector;
    this.address = address;
  }
}

export const FAULT = {
  DIVIDE: 0,
  BREAKPOINT: 3,
  INVALID_OPCODE: 6,
  DOUBLE: 8,
  GENERAL_PROTECTION: 13,
  PAGE: 14,
} as const;

/** Control registers, as architectural state rather than as a mock. */
export interface ControlRegisters {
  cr0: bigint;
  cr2: bigint;
  cr3: bigint;
  cr4: bigint;
}

export class Cpu {
  readonly regs = new RegisterFile();
  readonly flags = new Flags();
  readonly control: ControlRegisters = { cr0: 0n, cr2: 0n, cr3: 0n, cr4: 0n };

  /** Segment registers: index 0 ES, 1 CS, 2 SS, 3 DS, 4 FS, 5 GS. */
  readonly segments = new Uint16Array(6);

  /**
   * Flat-mode segment bases.
   *
   * VerixOS runs everything in a flat address space, so a base of zero for every
   * segment is not a simplification that loses information - it is the same
   * choice the hardware makes once protected mode sets up a flat GDT, and it is
   * what makes `mov al, [bx]` and `mov al, [rbx]` differ only in address width.
   */
  readonly segmentBases = new BigUint64Array(6);

  /** Set by HLT; cleared by an interrupt the machine delivers. */
  halted = false;

  /**
   * Software-interrupt hook.
   *
   * `int n` is the boundary between the guest and the firmware. On real hardware
   * it vectors through the IDT to a handler that eventually executes `iret`; in
   * this model the firmware's handlers are host functions, exactly as an
   * emulator's BIOS is, and they mutate architectural state (the register file)
   * the same way a handler in machine code would. Returning `true` means the call
   * was serviced and execution resumes at the following instruction; returning
   * `false` (or there being no hook) makes the `int` a genuine fault, which is what
   * should happen for a vector nothing claims.
   */
  softwareInterrupt: ((vector: number) => boolean) | undefined;

  /** Monotonic instruction counter, used by the clock and by RDTSC. */
  cycles = 0n;

  private readonly bus: CpuBus;
  private readonly io: CpuIo;

  constructor(bus: CpuBus, io: CpuIo) {
    this.bus = bus;
    this.io = io;
  }

  /**
   * Execute one decoded instruction.
   *
   * Advancing RIP is each case's job, because the amount differs: most advance by
   * the instruction length, branches set it outright, and a REP string prefix
   * rewrites its own address rather than falling through.
   */
  execute(insn: Executable): void {
    this.cycles += 1n;
    switch (insn.mnemonic) {
      case Mnemonic.ADD:
      case Mnemonic.OR:
      case Mnemonic.ADC:
      case Mnemonic.SBB:
      case Mnemonic.AND:
      case Mnemonic.SUB:
      case Mnemonic.XOR:
      case Mnemonic.CMP:
        this.execAlu(insn);
        return;
      case Mnemonic.MOV:
        this.execMov(insn);
        return;
      case Mnemonic.MOVZX:
        this.execMovExtend(insn, false);
        return;
      case Mnemonic.MOVSX:
        this.execMovExtend(insn, true);
        return;
      case Mnemonic.LEA:
        this.execLea(insn);
        return;
      case Mnemonic.XCHG:
        this.execXchg(insn);
        return;
      case Mnemonic.TEST:
        this.execTest(insn);
        return;
      case Mnemonic.INC:
      case Mnemonic.DEC:
        this.execIncDec(insn);
        return;
      case Mnemonic.NOT:
      case Mnemonic.NEG:
        this.execNotNeg(insn);
        return;
      case Mnemonic.MUL:
      case Mnemonic.IMUL:
        if (insn.operands.length === 2) this.execImul2(insn);
        else if (insn.operands.length === 3) this.execImul3(insn);
        else this.execMul(insn, insn.mnemonic === Mnemonic.IMUL);
        return;
      case Mnemonic.DIV:
      case Mnemonic.IDIV:
        this.execDiv(insn, insn.mnemonic === Mnemonic.IDIV);
        return;
      case Mnemonic.SHL:
      case Mnemonic.SHR:
      case Mnemonic.SAR:
      case Mnemonic.ROL:
      case Mnemonic.ROR:
      case Mnemonic.RCL:
      case Mnemonic.RCR:
        this.execShift(insn);
        return;
      case Mnemonic.PUSH:
        this.execPush(insn);
        return;
      case Mnemonic.POP:
        this.execPop(insn);
        return;
      case Mnemonic.PUSHF:
        this.push(this.flags.value & (insn.operandSize === 16 ? 0xffffn : 0xffff_ffffn), insn);
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.POPF:
        this.popFlags(insn);
        return;
      case Mnemonic.PUSHA:
        this.execPusha(insn);
        return;
      case Mnemonic.POPA:
        this.execPopa(insn);
        return;
      case Mnemonic.LEAVE:
        this.execLeave(insn);
        return;
      case Mnemonic.JMP:
        this.execJmp(insn);
        return;
      case Mnemonic.JMPF:
        this.execJmpF(insn);
        return;
      case Mnemonic.JCC:
        this.execJcc(insn);
        return;
      case Mnemonic.SETCC:
        this.execSetcc(insn);
        return;
      case Mnemonic.CMOVCC:
        this.execCmov(insn);
        return;
      case Mnemonic.CALL:
        this.execCall(insn);
        return;
      case Mnemonic.CALLF:
        this.execCallF(insn);
        return;
      case Mnemonic.RET:
        this.execRet(insn);
        return;
      case Mnemonic.RETF:
      case Mnemonic.RETFQ:
        this.execRetf(insn);
        return;
      case Mnemonic.IRET:
        this.execIret(insn);
        return;
      case Mnemonic.PUSH_FS:
      case Mnemonic.PUSH_GS:
      case Mnemonic.PUSH_SEG:
        this.execPushSegment(insn);
        return;
      case Mnemonic.POP_FS:
      case Mnemonic.POP_GS:
      case Mnemonic.POP_SEG:
        this.execPopSegment(insn);
        return;
      case Mnemonic.LOOP:
      case Mnemonic.LOOPE:
      case Mnemonic.LOOPNE:
        this.execLoop(insn);
        return;
      case Mnemonic.HLT:
        this.halted = true;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.NOP:
      case Mnemonic.PAUSE:
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.CLI:
        this.flags.if = false;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.STI:
        this.flags.if = true;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.CLD:
        this.flags.df = false;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.STD:
        this.flags.df = true;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.CLC:
        this.flags.cf = false;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.STC:
        this.flags.cf = true;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.CMC:
        this.flags.cf = !this.flags.cf;
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.LAHF:
        this.flags.value = (this.flags.value & 0xffff_ffff_ffff_ff00n) | (BigInt(this.lahfByte()) & 0xffn);
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.SAHF:
        this.sahf(this.flagsToByte());
        this.regs.rip += BigInt(insn.length);
        return;
      case Mnemonic.CBW:
        this.regs.write(Reg.AX, signExtend(this.regs.read(Reg.AX) & 0xffn, 8));
        this.advance(insn);
        return;
      case Mnemonic.CWDE:
        this.regs.write(Reg.AX, signExtend(this.regs.read(Reg.AX) & 0xffffn, 16) & 0xffff_ffffn);
        this.advance(insn);
        return;
      case Mnemonic.CDQE:
        this.regs.write(Reg.AX, signExtend(this.regs.read(Reg.AX) & 0xffff_ffffn, 32));
        this.advance(insn);
        return;
      case Mnemonic.CWD:
        this.regs.write(Reg.DX, (this.regs.read(Reg.AX) & 0x8000n) !== 0n ? 0xffffn : 0n);
        this.advance(insn);
        return;
      case Mnemonic.CDQ:
        this.regs.write(
          Reg.DX,
          (this.regs.read(Reg.AX) & 0x8000_0000n) !== 0n ? 0xffff_ffffn : 0n,
        );
        this.advance(insn);
        return;
      case Mnemonic.CQO:
        this.regs.write(
          Reg.DX,
          (this.regs.read(Reg.AX) & 0x8000_0000_0000_0000n) !== 0n ? widthMask(64) : 0n,
        );
        this.advance(insn);
        return;
      case Mnemonic.XADD:
        this.execXadd(insn);
        return;
      case Mnemonic.CMPXCHG:
        this.execCmpxchg(insn);
        return;
      case Mnemonic.MOV_CR:
        this.execMovCr(insn);
        return;
      case Mnemonic.LGDT:
      case Mnemonic.LIDT:
        this.execLoadDescriptorTable(insn);
        return;
      case Mnemonic.SGDT:
      case Mnemonic.SIDT:
        this.execStoreDescriptorTable(insn);
        return;
      case Mnemonic.LLDT:
      case Mnemonic.LTR:
        this.execLoadHiddenSegment(insn);
        return;
      case Mnemonic.SLDT:
      case Mnemonic.STR:
        this.execStoreHiddenSegment(insn);
        return;
      case Mnemonic.SMSW:
        this.execMachineStatus(insn, false);
        return;
      case Mnemonic.LMSW:
        this.execMachineStatus(insn, true);
        return;
      case Mnemonic.VERR:
      case Mnemonic.VERW:
        this.execVerifySegment(insn);
        return;
      case Mnemonic.XGETBV:
        this.execXgetbv(insn);
        return;
      case Mnemonic.XSETBV:
        this.execXsetbv(insn);
        return;
      case Mnemonic.SWAPGS:
        this.execSwapgs(insn);
        return;
      case Mnemonic.INVD:
      case Mnemonic.INVLPG:
      case Mnemonic.WBINVD:
      case Mnemonic.CLTS:
        // No-ops on a machine with one coherent cache and no FPU. They still
        // retire an instruction, so they cost time, which is observable through
        // the PIT and is why they are not simply skipped.
        this.advance(insn);
        return;
      case Mnemonic.RDMSR:
        this.execRdmsr(insn);
        return;
      case Mnemonic.WRMSR:
        this.execWrmsr(insn);
        return;
      case Mnemonic.SYSCALL:
        this.execSyscall(insn);
        return;
      case Mnemonic.SYSRET:
        this.execSysret(insn);
        return;
      case Mnemonic.CPUID:
        this.execCpuid(insn);
        return;
      case Mnemonic.RDTSC:
        this.execRdtsc(insn);
        return;
      case Mnemonic.RDTSCP:
        this.execRdtscp(insn);
        return;
      case Mnemonic.IN:
        this.execIn(insn);
        return;
      case Mnemonic.OUT:
        this.execOut(insn);
        return;
      case Mnemonic.XLATB:
        this.execXlatb(insn);
        return;
      case Mnemonic.MOVSB:
      case Mnemonic.MOVSW:
      case Mnemonic.MOVSD:
      case Mnemonic.MOVSQ:
      case Mnemonic.STOSB:
      case Mnemonic.STOSW:
      case Mnemonic.STOSD:
      case Mnemonic.STOSQ:
      case Mnemonic.LODSB:
      case Mnemonic.LODSW:
      case Mnemonic.LODSD:
      case Mnemonic.LODSQ:
      case Mnemonic.SCASB:
      case Mnemonic.SCASW:
      case Mnemonic.SCASD:
      case Mnemonic.SCASQ:
      case Mnemonic.CMPSB:
      case Mnemonic.CMPSW:
      case Mnemonic.CMPSD:
      case Mnemonic.CMPSQ:
      case Mnemonic.INS:
      case Mnemonic.INSB:
      case Mnemonic.INSW:
      case Mnemonic.INSD:
      case Mnemonic.INSQ:
      case Mnemonic.OUTS:
      case Mnemonic.OUTSB:
      case Mnemonic.OUTSW:
      case Mnemonic.OUTSD:
      case Mnemonic.OUTSQ:
        this.execString(insn);
        return;
      case Mnemonic.INT:
      case Mnemonic.INT3: {
        const vector =
          insn.mnemonic === Mnemonic.INT3
            ? FAULT.BREAKPOINT
            : Number((insn.operands[0] as { value: bigint }).value);
        if (this.softwareInterrupt?.(vector) === true) {
          // The firmware handled it and left the register file in whatever state
          // the service produced, so execution resumes after the `int`.
          this.advance(insn);
          return;
        }
        throw new CpuFault(vector, insn.origin, 'software interrupt');
      }
      case Mnemonic.UD2:
        throw new CpuFault(FAULT.INVALID_OPCODE, insn.origin, 'ud2');
      case Mnemonic.UNIMPLEMENTED:
        throw new CpuFault(FAULT.INVALID_OPCODE, insn.origin, 'unimplemented instruction');
      default:
        throw new CpuFault(
          FAULT.INVALID_OPCODE,
          insn.origin,
          `the interpreter does not implement '${insn.mnemonic}'`,
        );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Operand access                                                     */
  /* ---------------------------------------------------------------- */

  private advance(insn: Executable): void {
    this.regs.rip += BigInt(insn.length);
  }

  /**
   * The effective address of a memory operand.
   *
   * RIP-relative addressing is resolved here rather than in the decoder because
   * the displacement is measured from the *end* of the instruction, and the end
   * is only known once decoding has finished. Using the instruction's own start
   * would be wrong by its length, which for a two-byte opcode with a SIB byte and
   * a displacement is a large error at a small distance.
   */
  private addressOf(op: Extract<Operand, { kind: 'mem' }>): bigint {
    if (op.ripRelative) {
      return (this.regs.rip + BigInt(op.disp)) & widthMask(64);
    }
    let base = op.base >= 0 ? this.regs.read(op.base as Reg) : 0n;
    let index = op.index >= 0 ? this.regs.read(op.index as Reg) : 0n;
    if (op.addressWidth === 32) {
      base &= 0xffff_ffffn;
      index &= 0xffff_ffffn;
    } else if (op.addressWidth === 16) {
      base &= 0xffffn;
      index &= 0xffffn;
    }
    return (base + index * BigInt(op.scale) + op.disp) & widthMask(64);
  }

  private readMem(op: Extract<Operand, { kind: 'mem' }>): bigint {
    const bytes = op.operandWidth / 8;
    return this.bus.read(this.addressOf(op), bytes);
  }

  private writeMem(op: Extract<Operand, { kind: 'mem' }>, value: bigint): void {
    const bytes = op.operandWidth / 8;
    this.bus.write(this.addressOf(op), bytes, value & widthMask(op.operandWidth));
  }

  /**
   * Read a general-purpose register at a stated width.
   *
   * The high-byte case is the AH/CH/DH/BH family, which is *not* the low byte of
   * the register whose index it shares once a REX prefix is present. The decoder
   * resolves which one it is and sets `highByte`; re-deriving it here from the
   * prefix bytes would be a second implementation of the same rule.
   */
  private readGpr(op: Extract<Operand, { kind: 'reg' }>): bigint {
    const size = op.size ?? 64;
    if (op.highByte === true) return this.regs.readByte(op.reg as Reg, true);
    if (size === 8) return this.regs.readByte(op.reg as Reg, false);
    return this.regs.read(op.reg as Reg) & widthMask(size);
  }

  private writeGpr(op: Extract<Operand, { kind: 'reg' }>, value: bigint): void {
    const size = op.size ?? 64;
    if (op.highByte === true) {
      this.regs.writeByte(op.reg as Reg, true, value & 0xffn);
      return;
    }
    if (size === 8) {
      this.regs.writeByte(op.reg as Reg, false, value & 0xffn);
      return;
    }
    // The register file always holds 64 bits, so writing one of them means
    // deciding what happens to the other 48. For a 32-bit write the SDM says the
    // upper half is zeroed, and masking to 32 bits does that because the
    // register is stored wide. For a 16-bit write the upper 48 are *undefined*,
    // and in practice preserved - so the merge has to be explicit. Writing the
    // masked value straight through would silently zero a register's high half
    // on every `mov ax, ...`, which corrupts any pointer held above 16 bits.
    if (size === 16) {
      const reg = op.reg as Reg;
      this.regs.write(reg, (this.regs.read(reg) & ~0xffffn) | (value & 0xffffn));
      return;
    }
    this.regs.write(op.reg as Reg, value & widthMask(size));
  }

  private readOperand(op: Operand): bigint {
    switch (op.kind) {
      case 'reg':
        return this.readGpr(op);
      case 'mem':
        return this.readMem(op);
      case 'imm':
        return op.value;
      case 'moffs': {
        const bytes = this.currentMoffsWidth;
        return this.bus.read(op.addr, bytes / 8);
      }
      case 'seg':
        // A segment register holds a *selector*, not an address. Reading it yields
        // the visible half of that selector; the base and limit live in the
        // descriptor cache, which this model keeps flat.
        return BigInt(this.segments[op.seg] ?? 0);
      case 'cr':
        // Only the `mov r64, crN` direction reaches this, and `execMovCr` handles
        // it; a second path to the same register would be one more way for the
        // two directions to disagree about what CR0 contains.
        return this.readControlRegister(op.index);
      default:
        throw new CpuFault(FAULT.GENERAL_PROTECTION, this.regs.rip, `cannot read ${op.kind}`);
    }
  }

  private writeOperand(op: Operand, value: bigint): void {
    switch (op.kind) {
      case 'reg':
        this.writeGpr(op, value);
        return;
      case 'mem':
        this.writeMem(op, value);
        return;
      case 'seg':
        // `mov ds, ax` and friends. Every real-mode boot routine starts with four
        // of these, so an interpreter that cannot perform them cannot run a boot
        // routine at all - and, worse, would fail at the fourth instruction with a
        // message about a segment that has nothing wrong with it.
        this.segments[op.seg] = Number(value & 0xffffn);
        this.segmentBases[op.seg] = 0n;
        return;
      default:
        throw new CpuFault(FAULT.GENERAL_PROTECTION, this.regs.rip, `cannot write ${op.kind}`);
    }
  }

  /** Width of a MOV moffs operand, set by `execMov` before it reads or writes. */
  private currentMoffsWidth = 64;

  /* ---------------------------------------------------------------- */
  /* ALU                                                                */
  /* ---------------------------------------------------------------- */

  private execAlu(insn: Executable): void {
    const op = insn.aluOp ?? AluOp.ADD;
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    if (dst.kind !== 'reg' && dst.kind !== 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'ALU destination is not writable');
    }
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.kind === 'reg' ? (dst.size ?? 64) : 64);
    const a = this.readOperand(dst);
    const b = this.readOperand(src);
    const carryIn = this.flags.cf;

    // ADC and SBB fold the incoming carry into their second operand. Doing it
    // here, before the flag computation, means the overflow and carry rules in
    // `setArithmeticFlags` see the value the hardware's adder actually sees.
    let effective = b;
    if ((op === AluOp.ADC || op === AluOp.SBB) && carryIn) {
      effective = (b + 1n) & widthMask(width);
    }

    const result = this.applyAlu(op, a, effective, width);

    // The auxiliary carry is the one flag the `b + 1` trick above cannot get
    // right: when the low nibble of `b` is 0x0f the increment ripples out of the
    // nibble and the shared routine sees a carry-in of zero. AF is defined on the
    // *original* operands plus the carry, so it is recomputed directly here.
    if ((op === AluOp.ADC || op === AluOp.SBB) && carryIn) {
      const lowA = a & 0x0fn;
      const lowB = b & 0x0fn;
      this.flags.af = op === AluOp.ADC ? lowA + lowB + 1n > 0x0fn : lowA < lowB + 1n;
    }

    if (op !== AluOp.CMP) this.writeOperand(dst, result);
    this.advance(insn);
  }

  private applyAlu(op: AluOp, a: bigint, b: bigint, width: number): bigint {
    const mask = widthMask(width);
    const x = a & mask;
    const y = b & mask;
    switch (op) {
      case AluOp.ADD:
      case AluOp.ADC: {
        const r = (x + y) & mask;
        setArithmeticFlags(this.flags, x, y, r, width, 'add');
        return r;
      }
      case AluOp.SUB:
      case AluOp.SBB:
      case AluOp.CMP: {
        const r = (x - y) & mask;
        setArithmeticFlags(this.flags, x, y, r, width, 'sub');
        return r;
      }
      case AluOp.OR: {
        const r = x | y;
        setArithmeticFlags(this.flags, x, y, r, width, 'logic');
        return r;
      }
      case AluOp.AND: {
        const r = x & y;
        setArithmeticFlags(this.flags, x, y, r, width, 'logic');
        return r;
      }
      case AluOp.XOR: {
        const r = x ^ y;
        setArithmeticFlags(this.flags, x, y, r, width, 'logic');
        return r;
      }
      default:
        throw new CpuFault(FAULT.INVALID_OPCODE, this.regs.rip, 'unknown ALU operation');
    }
  }

  private execMov(insn: Executable): void {
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    if (dst.kind === 'moffs') this.currentMoffsWidth = insn.operandSize;
    if (src.kind === 'moffs') this.currentMoffsWidth = insn.operandSize;
    this.writeOperand(dst, this.readOperand(src));
    this.advance(insn);
  }

  private execMovExtend(insn: Executable, signed: boolean): void {
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    // The source width is a property of the opcode, not of the operand-size
    // prefix, so the decoder passes it separately. Receiving it as `operandWidth`
    // instead would read four bytes from `[rbx]` for `movzx eax, byte [rbx]`.
    const sourceWidth = insn.sourceSize ?? (src.kind === 'reg' ? (src.size ?? 8) : 8);
    let value = this.readOperand(src) & widthMask(sourceWidth);
    if (signed) value = signExtend(value, sourceWidth);
    this.writeOperand(dst, value);
    this.advance(insn);
  }

  private execLea(insn: Executable): void {
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    if (src.kind !== 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'LEA source is not memory');
    }
    // LEA computes the address and never dereferences it, which is what makes it
    // the standard way to do arithmetic without touching memory.
    const width = dst.kind === 'reg' ? (dst.size ?? 64) : 64;
    this.writeOperand(dst, this.addressOf(src) & widthMask(width));
    this.advance(insn);
  }

  private execXchg(insn: Executable): void {
    const a = insn.operands[0]!;
    const b = insn.operands[1]!;
    const va = this.readOperand(a);
    const vb = this.readOperand(b);
    this.writeOperand(a, vb);
    this.writeOperand(b, va);
    this.advance(insn);
  }

  private execTest(insn: Executable): void {
    const a = this.readOperand(insn.operands[0]!);
    const b = this.readOperand(insn.operands[1]!);
    const dst = insn.operands[0]!;
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.kind === 'reg' ? (dst.size ?? 64) : 64);
    // TEST computes the same flags as AND and discards the result, which is why
    // it shares `applyAlu` rather than having its own flag rules.
    this.applyAlu(AluOp.AND, a, b, width);
    this.advance(insn);
  }

  private execIncDec(insn: Executable): void {
    const dst = insn.operands[0]!;
    if (dst.kind !== 'reg' && dst.kind !== 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'INC/DEC needs a writable operand');
    }
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.size ?? 64);
    const a = this.readOperand(dst);
    const carryIn = this.flags.cf;
    const delta = insn.mnemonic === Mnemonic.INC ? 1n : widthMask(width);
    const r = this.applyAlu(AluOp.ADD, a, delta, width);
    this.writeOperand(dst, r);
    // INC/DEC leave CF alone. `applyAlu` computes it because it shares the adder
    // with ADD, so it is restored from the value saved before the operation. The
    // SDM calls this out explicitly; forgetting it turns a loop counter increment
    // into a silent borrow that corrupts every later comparison.
    this.flags.cf = carryIn;
    this.advance(insn);
  }

  private execNotNeg(insn: Executable): void {
    const dst = insn.operands[0]!;
    if (dst.kind !== 'reg' && dst.kind !== 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'NOT/NEG needs a writable operand');
    }
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.size ?? 64);
    const a = this.readOperand(dst) & widthMask(width);
    if (insn.mnemonic === Mnemonic.NOT) {
      // NOT affects no flags at all, which is the whole reason it is not `xor x, -1`.
      this.writeOperand(dst, (~a) & widthMask(width));
      this.advance(insn);
      return;
    }
    const r = this.applyAlu(AluOp.SUB, 0n, a, width);
    this.writeOperand(dst, r);
    // NEG sets CF unless the operand was zero, which is the same as saying a
    // borrow occurred - and `sub 0, a` computes exactly that, but it is restated
    // here because the SDM defines NEG's carry as "the operand was non-zero".
    this.flags.cf = a !== 0n;
    this.advance(insn);
  }

  private execMul(insn: Executable, signed: boolean): void {
    const src = insn.operands[0]!;
    const width = src.kind === 'mem' ? src.operandWidth : (src.kind === 'reg' ? (src.size ?? 64) : 64);
    const a = this.regs.read(Reg.AX) & widthMask(width);
    const b = this.readOperand(src) & widthMask(width);
    // Signed multiplication works on values, not on the 64-bit patterns a
    // register holds. Multiplying the patterns of two negative operands produces
    // a huge positive number whose low half looks plausible and whose overflow
    // flags are all wrong.
    const full = signed ? signedValue(a, width) * signedValue(b, width) : a * b;
    this.storeMulResult(full, width);
    // MUL and IMUL set CF and OF together when the result does not fit the
    // destination: the low half for MUL, the low word/half/quad for IMUL.
    const upperNonZero = signed ? !fitsSigned(full, width) : full > widthMask(width);
    this.flags.cf = upperNonZero;
    this.flags.of = upperNonZero;
    this.advance(insn);
  }

  private execImul2(insn: Executable): void {
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.kind === 'reg' ? (dst.size ?? 64) : 64);
    const a = this.readOperand(dst);
    const b = this.readOperand(src);
    const full = signedValue(a, width) * signedValue(b, width);
    this.writeOperand(dst, full & widthMask(width));
    this.flags.of = !fitsSigned(full, width);
    this.flags.cf = this.flags.of;
    this.advance(insn);
  }

  private execImul3(insn: Executable): void {
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    const immOp = insn.operands[2]!;
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.kind === 'reg' ? (dst.size ?? 64) : 64);
    const a = this.readOperand(src);
    const raw = immOp.kind === 'imm' ? immOp.value : this.readOperand(immOp);
    const imm = signedValue(raw, immOp.kind === 'imm' ? immOp.width : width);
    const full = signedValue(a, width) * imm;
    this.writeOperand(dst, full & widthMask(width));
    this.flags.of = !fitsSigned(full, width);
    this.flags.cf = this.flags.of;
    this.advance(insn);
  }

  private storeMulResult(full: bigint, width: number): void {
    const mask = widthMask(width);
    switch (width) {
      case 8:
        this.regs.write(Reg.AX, full & 0xffffn);
        return;
      case 16:
        this.regs.write(Reg.AX, full & 0xffffn);
        this.regs.write(Reg.DX, (full >> 16n) & 0xffffn);
        return;
      case 32:
        this.regs.write(Reg.AX, full & 0xffff_ffffn);
        this.regs.write(Reg.DX, (full >> 32n) & 0xffff_ffffn);
        return;
      default:
        this.regs.write(Reg.AX, full & mask);
        this.regs.write(Reg.DX, (full >> 64n) & mask);
        return;
    }
  }

  private execDiv(insn: Executable, signed: boolean): void {
    const src = insn.operands[0]!;
    const width = src.kind === 'mem' ? src.operandWidth : (src.kind === 'reg' ? (src.size ?? 64) : 64);
    const divisor = this.readOperand(src) & widthMask(width);

    if (width === 8) {
      const dividend = this.regs.read(Reg.AX) & 0xffffn;
      this.divide(dividend, divisor, 8, signed, 0xffffn);
      this.regs.write(Reg.AX, (this.regs.read(Reg.AX) & 0xff00n) | (this.divQuotient & 0xffn));
      this.regs.write(Reg.AX, (this.regs.read(Reg.AX) & 0xff00n) | ((this.divRemainder & 0xffn) << 8n));
      this.advance(insn);
      return;
    }

    const mask = widthMask(width);
    const lo = this.regs.read(Reg.AX) & mask;
    const hi = this.regs.read(Reg.DX) & mask;
    // Signed division takes a 2*width-bit dividend. Building it from the sign of
    // the high half is what makes `idiv` of a negative value work at all: the
    // halves are unsigned bit patterns, so -100 arrives as 0xFFFFFFFF_0000009C
    // and has to be brought back to -100 before anything is divided.
    const dividend = signed
      ? signedValue(hi, width) * (1n << BigInt(width)) + lo
      : (hi << BigInt(width)) | lo;
    this.divide(dividend, divisor, width, signed, mask);
    this.regs.write(Reg.AX, this.divQuotient & mask);
    this.regs.write(Reg.DX, this.divRemainder & mask);
    this.advance(insn);
  }

  private divQuotient = 0n;
  private divRemainder = 0n;

  private divide(dividend: bigint, divisor: bigint, width: number, signed: boolean, mask: bigint): void {
    if (divisor === 0n) {
      throw new CpuFault(FAULT.DIVIDE, this.regs.rip, 'division by zero');
    }
    if (signed) {
      // The divisor is a `width`-bit bit pattern, so it has to become a signed
      // value before it can divide anything. Dividing by the pattern of -7 would
      // divide by 65529 and produce a quotient no x86 can produce.
      const signedDivisor = signedValue(divisor, width);
      const q = dividend / signedDivisor;
      const r = dividend % signedDivisor;
      this.checkDivRange(q, width, signed, mask);
      this.divQuotient = q & mask;
      this.divRemainder = r & mask;
      return;
    }
    const q = dividend / divisor;
    const r = dividend % divisor;
    this.checkDivRange(q, width, signed, mask);
    this.divQuotient = q & mask;
    this.divRemainder = r & mask;
  }

  private checkDivRange(q: bigint, width: number, signed: boolean, mask: bigint): void {
    if (signed) {
      const min = -(1n << BigInt(width - 1));
      const max = (1n << BigInt(width - 1)) - 1n;
      if (q < min || q > max) {
        throw new CpuFault(FAULT.DIVIDE, this.regs.rip, 'signed division overflow');
      }
    } else if (q > mask) {
      throw new CpuFault(FAULT.DIVIDE, this.regs.rip, 'unsigned division overflow');
    }
  }

  private execShift(insn: Executable): void {
    const dst = insn.operands[0]!;
    if (dst.kind !== 'reg' && dst.kind !== 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'shift needs a writable operand');
    }
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.size ?? 64);
    const countOp = insn.operands[1];
    // A shift count is masked to five bits (six in 64-bit operand size). That is
    // not a suggestion: the hardware ignores the high bits, so `shl eax, 33`
    // shifts by one and an executor that used 33 would produce a different - and
    // unreachable - answer. Reading CL as the whole of RCX is safe because the
    // mask keeps only bits below it, which CL and RCX share.
    const countMask = width === 64 ? 0x3fn : 0x1fn;
    const count = countOp === undefined ? 1n : this.readOperand(countOp) & countMask;
    if (count === 0n) {
      // A zero count leaves every flag untouched, which is observable and is
      // specified; treating it as a zero-bit shift would clear CF.
      this.advance(insn);
      return;
    }
    const a = this.readOperand(dst) & widthMask(width);
    const result = this.shift(insn.shiftOp ?? ShiftOp.SHL, a, count, width, this.flags.cf);
    this.writeOperand(dst, result);
    this.advance(insn);
  }

  private shift(op: ShiftOp, value: bigint, count: bigint, width: number, cf: boolean): bigint {
    const mask = widthMask(width);
    const bits = BigInt(width);
    const n = count;
    switch (op) {
      case ShiftOp.SHL: {
        const r = (value << n) & mask;
        this.flags.cf = ((value << (n - 1n)) & (1n << (bits - 1n))) !== 0n && n <= bits;
        this.setShiftFlags(r, width);
        return r;
      }
      case ShiftOp.SHR: {
        const r = (value >> n) & mask;
        this.flags.cf = n <= bits ? ((value >> (n - 1n)) & 1n) === 1n : false;
        this.setShiftFlags(r, width);
        return r;
      }
      case ShiftOp.SAR: {
        // An arithmetic shift has to start from the signed *value*. Shifting the
        // 64-bit pattern of a negative number shifts in zeros, so SAR behaves
        // exactly like SHR for every negative input - which is why a test that
        // only shifts by a multiple of four can pass by accident.
        const signed = signedValue(value, width);
        const r = (signed >> n) & mask;
        this.flags.cf = n <= bits ? ((signed >> (n - 1n)) & 1n) === 1n : false;
        this.setShiftFlags(r, width);
        return r;
      }
      case ShiftOp.ROL: {
        const k = Number(n % bits);
        const r = ((value << BigInt(k)) | (value >> BigInt(width - k))) & mask;
        this.flags.cf = (r & 1n) === 1n;
        this.flags.of = ((r & (1n << (bits - 1n))) !== 0n) !== this.flags.cf;
        return r;
      }
      case ShiftOp.ROR: {
        const k = Number(n % bits);
        const r = ((value >> BigInt(k)) | (value << BigInt(width - k))) & mask;
        this.flags.cf = (r & (1n << (bits - 1n))) !== 0n;
        this.flags.of = ((r & (1n << (bits - 1n))) !== 0n) !== ((r & (1n << (bits - 2n))) !== 0n);
        return r;
      }
      case ShiftOp.RCL: {
        // The carry participates, so the rotation is over width+1 bits with the
        // carry as the extra low bit. That is what makes it the
        // multi-precision primitive and why it is not implemented as two shifts.
        // The extra bit is why this cannot use `widthMask`, which only knows
        // about 8, 16, 32 and 64.
        const total = BigInt(width + 1);
        const wideMask = (1n << total) - 1n;
        const k = count % total;
        const wide = ((value << 1n) | (cf ? 1n : 0n)) & wideMask;
        const rotated = ((wide << k) | (wide >> (total - k))) & wideMask;
        this.flags.cf = (rotated & 1n) === 1n;
        return (rotated >> 1n) & mask;
      }
      case ShiftOp.RCR: {
        const total = BigInt(width + 1);
        const wideMask = (1n << total) - 1n;
        const k = count % total;
        const wide = ((value << 1n) | (cf ? 1n : 0n)) & wideMask;
        const rotated = ((wide >> k) | (wide << (total - k))) & wideMask;
        this.flags.cf = (rotated & 1n) === 1n;
        return (rotated >> 1n) & mask;
      }
      default:
        throw new CpuFault(FAULT.INVALID_OPCODE, this.regs.rip, 'reserved shift operation');
    }
  }

  private setShiftFlags(result: bigint, width: number): void {
    this.flags.zf = result === 0n;
    this.flags.sf = (result & (1n << BigInt(width - 1))) !== 0n;
    this.flags.pf = (BigInt(countBits(result & 0xffn)) & 1n) === 0n;
    this.flags.af = false;
  }

  /* ---------------------------------------------------------------- */
  /* Stack                                                              */
  /* ---------------------------------------------------------------- */

  private stackWidth(_insn: Executable): number {
    return this.mode === '16' ? 16 : 64;
  }

  /** Set by the machine so the interpreter knows the mode's stack width. */
  mode: '16' | '32' | '64' = '64';

  private push(value: bigint, insn: Executable): void {
    const width = this.stackWidth(insn);
    const bytes = width / 8;
    const sp = (this.regs.read(Reg.SP) - BigInt(bytes)) & widthMask(64);
    this.regs.write(Reg.SP, sp);
    this.bus.write(sp, bytes, value & widthMask(width));
  }

  private pop(insn: Executable): bigint {
    const width = this.stackWidth(insn);
    const bytes = width / 8;
    const sp = this.regs.read(Reg.SP) & widthMask(64);
    const value = this.bus.read(sp, bytes);
    this.regs.write(Reg.SP, (sp + BigInt(bytes)) & widthMask(64));
    return value;
  }

  private execPush(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind === 'imm') {
      this.push(op.value, insn);
    } else if (op.kind === 'seg') {
      this.push(BigInt(this.segments[op.seg] ?? 0), insn);
    } else {
      this.push(this.readOperand(op), insn);
    }
    this.advance(insn);
  }

  private execPop(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind === 'seg') {
      this.segments[op.seg] = Number(this.pop(insn) & 0xffffn);
    } else {
      this.writeOperand(op, this.pop(insn));
    }
    this.advance(insn);
  }

  private popFlags(insn: Executable): void {
    const value = this.pop(insn);
    const mask = insn.operandSize === 16 ? 0xffffn : 0xffff_ffffn;
    this.flags.value = (this.flags.value & ~mask) | (value & mask);
    // Bit 1 is architecturally 1 and the register file forces it; POPF cannot
    // clear it, and an executor that wrote the popped value verbatim could.
    this.flags.value |= 0x2n;
    this.advance(insn);
  }

  private execPusha(insn: Executable): void {
    const width = insn.operandSize === 16 ? 16 : 32;
    const order = [Reg.AX, Reg.CX, Reg.DX, Reg.BX];
    const sp = this.regs.read(Reg.SP);
    for (const r of order) this.push(this.regs.read(r), insn);
    this.push(sp, insn);
    for (const r of [Reg.BP, Reg.SI, Reg.DI]) this.push(this.regs.read(r), insn);
    void width;
    this.advance(insn);
  }

  private execPopa(insn: Executable): void {
    this.pop(insn);
    this.regs.write(Reg.DI, this.pop(insn));
    this.regs.write(Reg.SI, this.pop(insn));
    this.regs.write(Reg.BP, this.pop(insn));
    this.pop(insn);
    this.regs.write(Reg.BX, this.pop(insn));
    this.regs.write(Reg.DX, this.pop(insn));
    this.regs.write(Reg.CX, this.pop(insn));
    this.regs.write(Reg.AX, this.pop(insn));
    this.advance(insn);
  }

  private execLeave(insn: Executable): void {
    this.regs.write(Reg.SP, this.regs.read(Reg.BP));
    this.regs.write(Reg.BP, this.pop(insn));
    this.advance(insn);
  }

  /* ---------------------------------------------------------------- */
  /* Control flow                                                       */
  /* ---------------------------------------------------------------- */

  private jumpTarget(op: Operand): bigint {
    if (op.kind === 'rel') return op.target;
    if (op.kind === 'reg' || op.kind === 'mem') return this.readOperand(op);
    if (op.kind === 'far') return op.offset;
    throw new CpuFault(FAULT.GENERAL_PROTECTION, this.regs.rip, 'unsupported jump operand');
  }

  private execJmp(insn: Executable): void {
    const op = insn.operands[0]!;
    const target = this.jumpTarget(op);
    if (op.kind === 'far') this.segments[1] = op.segment;
    this.regs.rip = target;
  }

  private execJcc(insn: Executable): void {
    const op = insn.operands[0]!;
    const condition = insn.condition ?? 0;
    if (this.conditionHolds(condition)) {
      this.regs.rip = this.jumpTarget(op);
    } else {
      this.advance(insn);
    }
  }

  private execSetcc(insn: Executable): void {
    const op = insn.operands[0]!;
    const condition = insn.condition ?? 0;
    this.writeOperand(op, this.conditionHolds(condition) ? 1n : 0n);
    this.advance(insn);
  }

  private execCmov(insn: Executable): void {
    const op = insn.operands[0]!;
    const condition = insn.condition ?? 0;
    if (this.conditionHolds(condition)) {
      this.writeOperand(op, this.readOperand(insn.operands[1]!));
    }
    this.advance(insn);
  }

  private execCall(insn: Executable): void {
    const op = insn.operands[0]!;
    this.push(this.regs.rip + BigInt(insn.length), insn);
    this.regs.rip = this.jumpTarget(op);
  }

  /**
   * `call far`: push CS and the return address, then load both.
   *
   * The order matters. The SDM pushes CS first and RIP second, so the return
   * sequence pops the offset and then the selector; pushing them the other way
   * round produces a return address made of two halves of the wrong registers,
   * which surfaces much later as an instruction fetch from the wrong place.
   */
  private execCallF(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind !== 'far') {
      // `call far [mem]` is a real encoding too; the descriptor supplies both
      // halves, and in this model the memory operand's two words are read as
      // offset then selector to match the instruction's own operand order.
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'unsupported far call operand');
    }
    this.push(BigInt(this.segments[1] ?? 0), insn);
    this.push(this.regs.rip + BigInt(insn.length), insn);
    this.segments[1] = op.segment;
    this.regs.rip = op.offset;
  }

  /**
   * `jmp far`.
   *
   * Unlike a far call this pushes nothing: it replaces both CS and RIP and the
   * old return address is simply gone. That is the whole difference between the
   * two, and getting it wrong turns a dispatcher into a stack leak.
   */
  private execJmpF(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind !== 'far') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'unsupported far jump operand');
    }
    this.segments[1] = op.segment;
    this.regs.rip = op.offset;
  }

  /**
   * `iret`: pop the interrupt frame.
   *
   * In long mode the frame is RIP, CS, RFLAGS and, when the privilege level
   * changes, RSP and SS. This model has one privilege level, so the stack
   * pointer is not reloaded - but the flag restore *is*, because `cli`/`sti`
   * around an interrupt handler would otherwise leave interrupts disabled
   * forever after the first return to user level.
   */
  private execIret(insn: Executable): void {
    const wide = insn.operandSize === 64;
    const rip = this.pop(insn);
    const cs = this.pop(insn);
    const flags = this.pop(insn);
    this.regs.rip = rip;
    this.segments[1] = Number(cs & 0xffffn);
    this.flags.value = flags | 0x2n;
    void wide;
  }

  /** `push fs`, `push gs` and the ModRM forms of the same operation. */
  private execPushSegment(insn: Executable): void {
    const index = this.segmentIndex(insn);
    this.push(BigInt(this.segments[index] ?? 0), insn);
    this.advance(insn);
  }

  private execPopSegment(insn: Executable): void {
    const index = this.segmentIndex(insn);
    this.segments[index] = Number(this.pop(insn) & 0xffffn);
    this.advance(insn);
  }

  /**
   * Which segment register a segment push or pop names.
   *
   * The dedicated opcodes (`0F A0`-`0F AB`) carry no operand, so the mnemonic
   * says which one; the ModRM forms take a segment register as their operand.
   * Both routes end here so the two encodings cannot drift apart.
   */
  private segmentIndex(insn: Executable): number {
    switch (insn.mnemonic) {
      case Mnemonic.PUSH_FS:
      case Mnemonic.POP_FS:
        return 4;
      case Mnemonic.PUSH_GS:
      case Mnemonic.POP_GS:
        return 5;
      default: {
        const op = insn.operands[0];
        if (op !== undefined && op.kind === 'seg') return op.seg;
        if (op !== undefined && op.kind === 'reg') return op.reg;
        throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'no segment register named');
      }
    }
  }

  private execRet(insn: Executable): void {
    this.regs.rip = this.pop(insn);
    const op = insn.operands[0];
    if (op !== undefined) {
      this.regs.write(Reg.SP, (this.regs.read(Reg.SP) + this.readOperand(op)) & widthMask(64));
    }
  }

  private execRetf(insn: Executable): void {
    const offset = this.pop(insn);
    const segment = this.pop(insn);
    this.segments[1] = Number(segment & 0xffffn);
    this.regs.rip = offset;
    const op = insn.operands[0];
    if (op !== undefined) {
      this.regs.write(Reg.SP, (this.regs.read(Reg.SP) + this.readOperand(op)) & widthMask(64));
    }
  }

  private execLoop(insn: Executable): void {
    const counter = (this.regs.read(Reg.CX) - 1n) & widthMask(64);
    this.regs.write(Reg.CX, counter);
    let taken = counter !== 0n;
    if (taken && insn.mnemonic === Mnemonic.LOOPE) taken = this.flags.zf;
    if (taken && insn.mnemonic === Mnemonic.LOOPNE) taken = !this.flags.zf;
    if (taken) {
      this.regs.rip = this.jumpTarget(insn.operands[0]!);
    } else {
      this.advance(insn);
    }
  }

  /**
   * Condition codes, in the SDM's own numbering.
   *
   * The spellings are irrelevant here - by the time an instruction reaches the
   * interpreter the decoder has already chosen a condition index - so this is the
   * one place where the sixteen conditions are *values* rather than names.
   */
  private conditionHolds(index: number): boolean {
    const f = this.flags;
    switch (index) {
      case 0x0:
        return f.of;
      case 0x1:
        return !f.of;
      case 0x2:
        return f.cf;
      case 0x3:
        return !f.cf;
      case 0x4:
        return f.zf;
      case 0x5:
        return !f.zf;
      case 0x6:
        return f.cf || f.zf;
      case 0x7:
        return !f.cf && !f.zf;
      case 0x8:
        return f.sf;
      case 0x9:
        return !f.sf;
      case 0xa:
        return f.pf;
      case 0xb:
        return !f.pf;
      case 0xc:
        return f.sf !== f.of;
      case 0xd:
        return f.sf === f.of;
      case 0xe:
        return f.zf || f.sf !== f.of;
      case 0xf:
        return !f.zf && f.sf === f.of;
      default:
        return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Atomics, system and string                                         */
  /* ---------------------------------------------------------------- */

  private execXadd(insn: Executable): void {
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.kind === 'reg' ? (dst.size ?? 64) : 64);
    const a = this.readOperand(dst);
    const b = this.readOperand(src);
    const result = this.applyAlu(AluOp.ADD, a, b, width);
    // XADD stores the *original* destination into the source register and the sum
    // into the destination, which is what makes it usable as a fetch-and-add.
    this.writeOperand(src, a);
    this.writeOperand(dst, result);
    this.advance(insn);
  }

  private execCmpxchg(insn: Executable): void {
    const dst = insn.operands[0]!;
    const src = insn.operands[1]!;
    const width = dst.kind === 'mem' ? dst.operandWidth : (dst.kind === 'reg' ? (dst.size ?? 64) : 64);
    const accumulator = this.regs.read(Reg.AX) & widthMask(width);
    const value = this.readOperand(dst);
    // CMPXCHG compares the accumulator with the destination and branches on the
    // result: equal loads the source among the flags being set, unequal loads the
    // destination back into the accumulator. Both halves must use the *same*
    // subtraction so ZF means what the SDM says it means.
    const compared = this.applyAlu(AluOp.CMP, accumulator, value, width);
    void compared;
    if (this.flags.zf) {
      this.writeOperand(dst, this.readOperand(src));
    } else {
      this.writeRegByWidth(Reg.AX, value, width);
    }
    this.advance(insn);
  }

  private writeRegByWidth(reg: Reg, value: bigint, width: number): void {
    if (width === 32) {
      this.regs.write(reg, value & 0xffff_ffffn);
      return;
    }
    this.regs.write(reg, value & widthMask(width));
  }

  /** The one place a control register is read, so MOV_CR has a single source. */
  private readControlRegister(index: number): bigint {
    switch (index) {
      case 0:
        return this.control.cr0;
      case 2:
        return this.control.cr2;
      case 3:
        return this.control.cr3;
      default:
        return this.control.cr4;
    }
  }

  private execMovCr(insn: Executable): void {
    const first = insn.operands[0]!;
    const second = insn.operands[1]!;
    const isStore = first.kind === 'cr';
    const cr = isStore ? first : second;
    const gpr = isStore ? second : first;
    if (cr.kind !== 'cr') {
      throw new CpuFault(FAULT.INVALID_OPCODE, insn.origin, 'mov to a control register needs one');
    }
    const value = isStore ? this.readOperand(gpr) : 0n;

    // The debug registers are architectural state that a guest can read and
    // write even though this model never stops the program to use them, so they
    // get a store rather than a fault. Refusing them would make every debugger's
    // first instruction fail for no useful reason.
    if (cr.debug === true) {
      this.debugRegisters[cr.index] = value;
      this.advance(insn);
      return;
    }

    switch (cr.index) {
      case 0:
        this.control.cr0 = value;
        break;
      case 2:
        this.control.cr2 = value;
        break;
      case 3:
        this.control.cr3 = value;
        break;
      case 4:
        this.control.cr4 = value;
        break;
      default:
        throw new CpuFault(
          FAULT.INVALID_OPCODE,
          insn.origin,
          `control register ${cr.index} does not exist`,
        );
    }
    if (!isStore) {
      switch (cr.index) {
        case 0:
          this.writeOperand(gpr, this.control.cr0);
          break;
        case 2:
          this.writeOperand(gpr, this.control.cr2);
          break;
        case 3:
          this.writeOperand(gpr, this.control.cr3);
          break;
        default:
          this.writeOperand(gpr, this.control.cr4);
      }
    }
    this.advance(insn);
  }

  /** DR0-DR7. Written and read like the control registers, never used here. */
  readonly debugRegisters = new BigUint64Array(8);

  /** Model-specific registers the kernel may program. */
  readonly msrs = new Map<number, bigint>();

  /** GDTR and IDTR: limit and base, exactly as the pseudo-descriptor holds them. */
  readonly tables = { gdt: { limit: 0n, base: 0n }, idt: { limit: 0n, base: 0n } };

  /**
   * `lgdt` and `lidt`.
   *
   * The operand is a pseudo-descriptor, not a value of the operand size: two
   * bytes of limit followed by a base of four or eight bytes. Reading it as a
   * word and sign-extending would put a descriptor table at address 0x0000FFFF
   * or wherever the limit byte happened to land, and the failure would surface
   * much later as an unreadable segment.
   */
  private execLoadDescriptorTable(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind !== 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'descriptor load needs memory');
    }
    const address = this.addressOf(op);
    const long = this.mode === '64';
    const limit = this.bus.read(address, 2);
    const base = long ? this.bus.read(address + 2n, 8) : this.bus.read(address + 2n, 4);
    const table = insn.mnemonic === Mnemonic.LGDT ? this.tables.gdt : this.tables.idt;
    table.limit = limit;
    table.base = base;
    this.advance(insn);
  }

  /** `sgdt` and `sidt`: the mirror image, and equally fixed at 6 or 10 bytes. */
  private execStoreDescriptorTable(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind !== 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'descriptor store needs memory');
    }
    const address = this.addressOf(op);
    const long = this.mode === '64';
    const table = insn.mnemonic === Mnemonic.SGDT ? this.tables.gdt : this.tables.idt;
    this.bus.write(address, 2, table.limit);
    this.bus.write(address + 2n, long ? 8 : 4, table.base);
    this.advance(insn);
  }

  /**
   * `lldt` and `ltr`.
   *
   * A flat model has one base and one limit for every segment, so loading a
   * selector records which one the guest asked for and installs the flat
   * mapping. That is a real simplification and it is a documented one: a guest
   * that loads a selector other than the null one and then expects a segmentation
   * fault for an out-of-range address will not get one, because there is no
   * range. What *is* preserved is the observable register - the loaded selector
   * reads back - which is what guest code actually tests.
   */
  private execLoadHiddenSegment(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind === 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'a segment load takes a selector, not an address');
    }
    const selector = Number(this.readOperand(op) & 0xffffn);
    const isTask = insn.mnemonic === Mnemonic.LTR;
    const index = isTask ? 6 : 7; // TR is index 6, LDTR index 7
    this.hidden[index] = selector;
    this.segmentBases[index] = 0n;
    this.segmentLimits[index] = widthMask(this.mode === '16' ? 16 : this.mode === '32' ? 32 : 64);
    this.advance(insn);
  }

  private execStoreHiddenSegment(insn: Executable): void {
    const op = insn.operands[0]!;
    if (op.kind === 'mem') {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'a segment store takes a selector, not an address');
    }
    const isTask = insn.mnemonic === Mnemonic.STR;
    this.writeOperand(op, BigInt(this.hidden[isTask ? 6 : 7] ?? 0));
    this.advance(insn);
  }

  /**
   * Loaded selectors for the segments without visible registers: index 6 is the
   * task register and index 7 the local descriptor table register.
   */
  readonly hidden = new Uint16Array(8);

  /** Segment limits, parallel to `segmentBases`. */
  readonly segmentLimits = new BigUint64Array(8);

  /** `smsw` and `lmsw`: CR0's low sixteen bits, the 286 machine status word. */
  private execMachineStatus(insn: Executable, loading: boolean): void {
    const op = insn.operands[0]!;
    if (loading) {
      const word = this.readOperand(op) & 0xffffn;
      // LMSW can only clear bits: it cannot set PE, which is what makes it
      // possible to return to real mode and what forbids leaving protected mode
      // through it.
      const allowed = word & ~this.CR0_PE;
      this.control.cr0 = (this.control.cr0 & ~0xffffn) | allowed;
    } else {
      this.writeOperand(op, this.control.cr0 & 0xffffn);
    }
    this.advance(insn);
  }

  /** CR0.PE, needed so LMSW's "cannot set protection enable" rule is checkable. */
  private readonly CR0_PE = 1n << 0n;

  /** `verr` and `verw`: a segment-validity probe that answers in ZF alone. */
  private execVerifySegment(insn: Executable): void {
    const op = insn.operands[0]!;
    const selector = this.readOperand(op) & 0xffffn;
    // The null selector is always valid; every other selector is valid in a flat
    // model because every selector that is in range resolves to the flat mapping.
    const index = Number(selector >> 3n);
    this.flags.zf = selector === 0n || index < this.hidden.length;
    void insn;
    this.advance(insn);
  }

  private execXgetbv(insn: Executable): void {
    if (this.control.cr4 === 0n) {
      // XGETBV with CR4.OSXSAVE clear is #UD, and reporting that is better than
      // returning a value from a feature that was never enabled.
      throw new CpuFault(FAULT.INVALID_OPCODE, insn.origin, 'xgetbv with CR4.OSXSAVE clear');
    }
    const selector = Number(this.cpu_ecx() & 0x3n);
    this.regs.write(Reg.AX, this.xcr0 & 0xffff_ffffn);
    this.regs.write(Reg.DX, (this.xcr0 >> 32n) & 0xffff_ffffn);
    void selector;
    this.advance(insn);
  }

  private execXsetbv(insn: Executable): void {
    if (this.control.cr4 === 0n) {
      throw new CpuFault(FAULT.INVALID_OPCODE, insn.origin, 'xsetbv with CR4.OSXSAVE clear');
    }
    this.xcr0 = (this.regs.read(Reg.DX) << 32n) | this.regs.read(Reg.AX);
    this.advance(insn);
  }

  /** XCR0. Zero means "no extended state", which is the honest value here. */
  xcr0 = 0n;

  private cpu_ecx(): bigint {
    return this.regs.read(Reg.CX);
  }

  /**
   * `swapgs`.
   *
   * One of the two instructions that can fault without an error code, because it
   * is on the path the kernel uses to enter an entry stub. The GS base is real
   * here - it is what makes per-thread data reachable - so the exchange is real.
   */
  private execSwapgs(insn: Executable): void {
    const gs = this.segmentBases[5] ?? 0n;
    this.segmentBases[5] = this.gsKernelBase;
    this.gsKernelBase = gs;
    this.advance(insn);
  }

  private gsKernelBase = 0n;

  /**
   * Model-specific registers.
   *
   * A real CPU faults when ECX names an MSR that does not exist, and so does
   * this one: a guest that probes for a feature by reading a reserved MSR gets
   * #GP, which is how feature discovery is supposed to work. Writing one that
   * the kernel has programmed succeeds.
   */
  private execRdmsr(insn: Executable): void {
    const index = Number(this.cpu_ecx());
    const value = this.msrs.get(index);
    if (value === undefined) {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, `MSR ${index} is not implemented`);
    }
    this.regs.write(Reg.AX, value & 0xffff_ffffn);
    this.regs.write(Reg.DX, (value >> 32n) & 0xffff_ffffn);
    this.advance(insn);
  }

  private execWrmsr(insn: Executable): void {
    const index = Number(this.cpu_ecx());
    const value = (this.regs.read(Reg.DX) << 32n) | this.regs.read(Reg.AX);
    this.msrs.set(index, value);
    this.advance(insn);
  }

  /**
   * `syscall`.
   *
   * Long mode's fast system call: load the argument registers, jump to the
   * address in IA32_LSTAR, and leave a return address in RCX. Modelling the
   * entry sequence rather than calling a host function is the point - the guest
   * genuinely runs its own entry stub, and `sysret` genuinely comes back to the
   * instruction after the `syscall`.
   */
  private execSyscall(insn: Executable): void {
    const lstar = this.msrs.get(0xc8);
    if (lstar === undefined || lstar === 0n) {
      throw new CpuFault(FAULT.GENERAL_PROTECTION, insn.origin, 'IA32_LSTAR has not been programmed');
    }
    const returnAddress = this.regs.rip + BigInt(insn.length);
    this.regs.write(Reg.CX, returnAddress);
    // R11 carries RFLAGS in and out. Storing the *current* flags into R11 is what
    // SYSCALL does, and SYSCRET reading them back from there is what makes the
    // pair symmetric; using any other scratch register would leave one direction
    // restoring a value the other never saved.
    this.regs.write(Reg.R11, this.flags.value);
    this.flags.if = false;
    this.flags.tf = false;
    this.regs.rip = lstar;
  }

  private execSysret(insn: Executable): void {
    const rcx = this.regs.read(Reg.CX);
    // Bit 63 of RCX is RFLAGS.WP, which sysretq honours and sysret ignores.
    if ((rcx >> 63n) & 1n) {
      this.control.cr3 = this.regs.read(Reg.R11);
    }
    this.flags.value = this.regs.read(Reg.R11);
    this.regs.rip = rcx & 0xffff_ffff_ffffn;
    this.advance(insn);
  }

  private execCpuid(insn: Executable): void {
    const leaf = this.regs.read(Reg.AX) & 0xffff_ffffn;
    if (leaf === 0n) {
      // Leaf 0 reports the vendor ID, which the SDM fixes at EBX, EDX, ECX (in
      // that order) as little-endian bytes. Twelve characters is not a stylistic
      // choice: the register triple holds exactly twelve bytes, which is why a
      // vendor string is a fixed-width field and not free text.
      this.regs.write(Reg.AX, 1n); // highest basic leaf
      this.regs.write(Reg.BX, 0x6972_6556n); // "Veri"
      this.regs.write(Reg.DX, 0x2053_4f78n); // "xOS "
      this.regs.write(Reg.CX, 0x7072_6f43n); // "Corp"
      this.advance(insn);
      return;
    }
    if (leaf === 1n) {
      // Family/model/stepping. Every feature bit is left clear: advertising SSE
      // or the TSC would be a false claim about what the interpreter executes,
      // and a guest that trusted it would take an #UD on the first SSE opcode.
      this.regs.write(Reg.AX, 0x0000_0601n); // family 6, model 1
      this.regs.write(Reg.BX, 0n);
      this.regs.write(Reg.CX, 0n);
      this.regs.write(Reg.DX, 0n);
      this.advance(insn);
      return;
    }
    this.regs.write(Reg.AX, 0n);
    this.regs.write(Reg.BX, 0n);
    this.regs.write(Reg.CX, 0n);
    this.regs.write(Reg.DX, 0n);
    this.advance(insn);
  }

  private execRdtsc(insn: Executable): void {
    this.regs.write(Reg.AX, this.cycles & 0xffff_ffffn);
    this.regs.write(Reg.DX, (this.cycles >> 32n) & 0xffff_ffffn);
    this.advance(insn);
  }

  private execRdtscp(insn: Executable): void {
    this.execRdtsc(insn);
    this.regs.write(Reg.CX, 0n);
  }

  private execIn(insn: Executable): void {
    const dst = insn.operands[0]!;
    const portOp = insn.operands[1]!;
    // The transfer width comes from the *accumulator operand*, not from
    // `operandSize`. `in al, dx` in long mode has an operand size of 32 - that
    // is the mode's default and it governs nothing here - but transfers exactly
    // one byte, because the opcode says so. Reading the operand size would put
    // four bytes on the bus for an instruction the hardware reads one.
    const width = this.dataWidth(dst);
    const port = Number(this.readOperand(portOp) & 0xffffn);
    this.writeOperand(dst, this.io.read(port, width / 8));
    this.advance(insn);
  }

  private execOut(insn: Executable): void {
    const portOp = insn.operands[0]!;
    const src = insn.operands[1]!;
    const width = this.dataWidth(src);
    const port = Number(this.readOperand(portOp) & 0xffffn);
    this.io.write(port, this.readOperand(src), width / 8);
    this.advance(insn);
  }

  /** Width of a transfer operand, which for I/O strings comes from the suffix. */
  private dataWidth(op: Operand): number {
    if (op.kind === 'reg') return op.size ?? 64;
    if (op.kind === 'mem') return op.operandWidth;
    return 64;
  }

  private execXlatb(insn: Executable): void {
    const base = this.regs.read(Reg.BX) & 0xffff_ffff_ffff_ffffn;
    const index = this.regs.read(Reg.AX) & 0xffn;
    const value = this.bus.read((base + index) & widthMask(64), 1);
    this.regs.write(Reg.AX, (this.regs.read(Reg.AX) & 0xffff_ffff_ffffff00n) | (value & 0xffn));
    this.advance(insn);
  }

  private execString(insn: Executable): void {
    const width = insn.stringWidth ?? insn.operandSize;
    const bytes = width / 8;
    const delta = this.flags.df ? -BigInt(bytes) : BigInt(bytes);
    const mnemonic = insn.mnemonic;
    const isRep = insn.rep !== 'none';

    // A REP prefix repeats until CX reaches zero (REP) or until ZF satisfies the
    // terminator (REPNE). SCAS and CMPS are the two that terminate early, which is
    // what makes them the string *comparison* primitives.
    const terminatesOnZf =
      mnemonic === Mnemonic.SCASB || mnemonic === Mnemonic.SCASW ||
      mnemonic === Mnemonic.SCASD || mnemonic === Mnemonic.SCASQ ||
      mnemonic === Mnemonic.CMPSB || mnemonic === Mnemonic.CMPSW ||
      mnemonic === Mnemonic.CMPSD || mnemonic === Mnemonic.CMPSQ;

    const one = (): void => {
      switch (mnemonic) {
        case Mnemonic.MOVSB:
        case Mnemonic.MOVSW:
        case Mnemonic.MOVSD:
        case Mnemonic.MOVSQ: {
          const value = this.bus.read(this.regs.read(Reg.SI), bytes);
          this.bus.write(this.regs.read(Reg.DI), bytes, value);
          this.regs.write(Reg.SI, (this.regs.read(Reg.SI) + delta) & widthMask(64));
          this.regs.write(Reg.DI, (this.regs.read(Reg.DI) + delta) & widthMask(64));
          return;
        }
        case Mnemonic.STOSB:
        case Mnemonic.STOSW:
        case Mnemonic.STOSD:
        case Mnemonic.STOSQ: {
          this.bus.write(this.regs.read(Reg.DI), bytes, this.regs.read(Reg.AX) & widthMask(width));
          this.regs.write(Reg.DI, (this.regs.read(Reg.DI) + delta) & widthMask(64));
          return;
        }
        case Mnemonic.LODSB:
        case Mnemonic.LODSW:
        case Mnemonic.LODSD:
        case Mnemonic.LODSQ: {
          const value = this.bus.read(this.regs.read(Reg.SI), bytes);
          this.regs.write(Reg.AX, value & widthMask(width));
          this.regs.write(Reg.SI, (this.regs.read(Reg.SI) + delta) & widthMask(64));
          return;
        }
        case Mnemonic.SCASB:
        case Mnemonic.SCASW:
        case Mnemonic.SCASD:
        case Mnemonic.SCASQ: {
          const value = this.bus.read(this.regs.read(Reg.DI), bytes);
          this.applyAlu(AluOp.CMP, this.regs.read(Reg.AX) & widthMask(width), value, width);
          this.regs.write(Reg.DI, (this.regs.read(Reg.DI) + delta) & widthMask(64));
          return;
        }
        case Mnemonic.CMPSB:
        case Mnemonic.CMPSW:
        case Mnemonic.CMPSD:
        case Mnemonic.CMPSQ: {
          const a = this.bus.read(this.regs.read(Reg.SI), bytes);
          const b = this.bus.read(this.regs.read(Reg.DI), bytes);
          this.applyAlu(AluOp.CMP, a, b, width);
          this.regs.write(Reg.SI, (this.regs.read(Reg.SI) + delta) & widthMask(64));
          this.regs.write(Reg.DI, (this.regs.read(Reg.DI) + delta) & widthMask(64));
          return;
        }
        // INS and OUTS are the two string primitives whose other end is a port.
        // The port is never an operand: DX names it, which is why these five
        // variants exist separately from the other four families and why a
        // decoded `insw` cannot be confused with a port-taking `in`.
        case Mnemonic.INS:
        case Mnemonic.INSB:
        case Mnemonic.INSW:
        case Mnemonic.INSD:
        case Mnemonic.INSQ: {
          const port = Number(this.regs.read(Reg.DX) & 0xffffn);
          const value = this.io.read(port, bytes);
          this.bus.write(this.regs.read(Reg.DI), bytes, value);
          this.regs.write(Reg.DI, (this.regs.read(Reg.DI) + delta) & widthMask(64));
          return;
        }
        case Mnemonic.OUTS:
        case Mnemonic.OUTSB:
        case Mnemonic.OUTSW:
        case Mnemonic.OUTSD:
        case Mnemonic.OUTSQ: {
          const port = Number(this.regs.read(Reg.DX) & 0xffffn);
          const value = this.bus.read(this.regs.read(Reg.SI), bytes);
          this.io.write(port, value, bytes);
          this.regs.write(Reg.SI, (this.regs.read(Reg.SI) + delta) & widthMask(64));
          return;
        }
        default:
          throw new CpuFault(FAULT.INVALID_OPCODE, insn.origin, 'unknown string primitive');
      }
    };

    if (!isRep) {
      one();
      this.advance(insn);
      return;
    }

    let count = this.regs.read(Reg.CX);
    while (count !== 0n) {
      one();
      count -= 1n;
      if (terminatesOnZf) {
        const satisfied = insn.rep === 'repne' ? this.flags.zf : !this.flags.zf;
        if (satisfied) break;
      }
    }
    this.regs.write(Reg.CX, count);
    // A REP instruction consumed the whole iteration in one `execute` call, so RIP
    // advances exactly once by the instruction's own length - not once per byte.
    this.advance(insn);
  }

  /* ---------------------------------------------------------------- */
  /* Flags helpers                                                      */
  /* ---------------------------------------------------------------- */

  private flagsToByte(): number {
    const f = this.flags;
    let b = 0;
    if (f.cf) b |= 0x01;
    if (f.pf) b |= 0x04;
    if (f.af) b |= 0x10;
    if (f.zf) b |= 0x40;
    if (f.sf) b |= 0x80;
    return b;
  }

  private sahf(byte: number): void {
    this.flags.cf = (byte & 0x01) !== 0;
    this.flags.pf = (byte & 0x04) !== 0;
    this.flags.af = (byte & 0x10) !== 0;
    this.flags.zf = (byte & 0x40) !== 0;
    this.flags.sf = (byte & 0x80) !== 0;
  }

  private lahfByte(): number {
    return this.flagsToByte();
  }
}

function countBits(v: bigint): number {
  let n = 0;
  let x = v;
  while (x !== 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
