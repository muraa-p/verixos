/**
 * VerixOS - x86-64 architectural contracts.
 *
 * This file is the normative definition of every architectural constant the rest
 * of the tree depends on. Nothing in this file executes logic; it exists so that
 * the CPU, the memory manager, the interrupt controller, the drivers and the
 * test suite all agree on the same numbers, with the same names.
 *
 * Anything that appears here should be traceable to a specific section of the
 * Intel SDM Volume 3 or Volume 2. The citation is given per group.
 */

/* -------------------------------------------------------------------------- */
/* General purpose registers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Register indices into `Cpu.regs`.
 *
 * The first eight indices deliberately match the x86-64 encoding order of the
 * legacy 16-bit registers (AX, CX, DX, BX, SP, BP, SI, DI) so that the legacy
 * name mapping below is a straight array lookup.
 */
export const Reg = {
  AX: 0,
  CX: 1,
  DX: 2,
  BX: 3,
  SP: 4,
  BP: 5,
  SI: 6,
  DI: 7,
  R8: 8,
  R9: 9,
  R10: 10,
  R11: 11,
  R12: 12,
  R13: 13,
  R14: 14,
  R15: 15,
} as const;

export type Reg = (typeof Reg)[keyof typeof Reg];

export const REG_COUNT = 16 as const;

/** 64-bit name for each register index, indexed by `Reg`. */
export const REG64_NAMES = [
  'rax',
  'rcx',
  'rdx',
  'rbx',
  'rsp',
  'rbp',
  'rsi',
  'rdi',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
  'r15',
] as const;

/** 32-bit name, or null when the register has no 32-bit-only form. */
export const REG32_NAMES = [
  'eax',
  'ecx',
  'edx',
  'ebx',
  'esp',
  'ebp',
  'esi',
  'edi',
  'r8d',
  'r9d',
  'r10d',
  'r11d',
  'r12d',
  'r13d',
  'r14d',
  'r15d',
] as const;

/** 16-bit name, or null when the register has no 16-bit form. */
export const REG16_NAMES = [
  'ax',
  'cx',
  'dx',
  'bx',
  'sp',
  'bp',
  'si',
  'di',
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
] as const;

/** 8-bit name, or null when the register has no 8-bit form. */
export const REG8_NAMES = [
  'al',
  'cl',
  'dl',
  'bl',
  'ah',
  'ch',
  'dh',
  'bh',
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
] as const;

/* -------------------------------------------------------------------------- */
/* Flags register (RFLAGS)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bit positions within RFLAGS.
 *
 * Source: Intel SDM Vol. 3, Table 3-1 "Flags Register Bit Positions".
 */
export const FlagBit = {
  CF: 0,
  /** Reserved, always 1. */
  ONE: 1,
  PF: 2,
  AF: 4,
  ZF: 6,
  SF: 7,
  TF: 8,
  IF: 9,
  DF: 10,
  OF: 11,
  /** IOPL, bits 12-13. */
  IOPL: 12,
  NT: 14,
  RF: 16,
  VM: 17,
  AC: 18,
  VIF: 19,
  VIP: 20,
  ID: 21,
} as const;

export type FlagBit = (typeof FlagBit)[keyof typeof FlagBit];

/** Bit 1 is architecturally always set when RFLAGS is read. */
export const RFLAGS_RESERVED_ONE = 1n << 1n;

/** The only flags bits a user-mode process may modify via POPF/POPFQ. */
export const RFLAGS_USER_MASK = 0x0000_0000_0000_25a5n & ~RFLAGS_RESERVED_ONE;

/* -------------------------------------------------------------------------- */
/* Control registers                                                            */
/* -------------------------------------------------------------------------- */

export const CR = {
  CR0: 0,
  CR2: 2,
  CR3: 3,
  CR4: 4,
} as const;

export type CR = (typeof CR)[keyof typeof CR];

/**
 * CR0 bits. Source: Intel SDM Vol. 3, Table 3-12 "CR0 Bits".
 */
export const CR0 = {
  PE: 1n << 0n,
  MP: 1n << 1n,
  EM: 1n << 2n,
  TS: 1n << 3n,
  ET: 1n << 4n,
  NE: 1n << 5n,
  WP: 1n << 16n,
  AM: 1n << 18n,
  NW: 1n << 29n,
  CD: 1n << 30n,
  PG: 1n << 31n,
} as const;

/**
 * CR4 bits. Source: Intel SDM Vol. 3, Table 3-13 "CR4 Bits".
 */
export const CR4 = {
  VME: 1n << 0n,
  PVI: 1n << 1n,
  TSD: 1n << 2n,
  DE: 1n << 3n,
  PSE: 1n << 4n,
  PAE: 1n << 5n,
  MCE: 1n << 6n,
  PGE: 1n << 7n,
  PCA: 1n << 8n,
  OSFXSR: 1n << 9n,
  OSXMMEXCPT: 1n << 10n,
  UMIP: 1n << 11n,
  LA57: 1n << 12n,
  SMEP: 1n << 20n,
  SMAP: 1n << 21n,
} as const;

/** Physical address width (in bits) implemented by this CPU model. */
export const PHYSICAL_ADDRESS_BITS = 40 as const;
export const MAX_PHYSICAL_ADDRESS = (1n << BigInt(PHYSICAL_ADDRESS_BITS)) - 1n;

/* -------------------------------------------------------------------------- */
/* Protected mode / segmentation                                                */
/* -------------------------------------------------------------------------- */

/** Privilege levels, 0 = most privileged. Source: SDM Vol. 3, Sec. 4.4. */
export const RING = {
  KERNEL: 0,
  USER: 3,
} as const;

export type Ring = (typeof RING)[keyof typeof RING];

/**
 * Segment selector layout. A selector is an index, a table indicator (TI) and
 * a requested privilege level (RPL). Source: SDM Vol. 3, Sec. 3.4.4.
 */
export const Selector = {
  INDEX_MASK: 0xfff8,
  TI: 0x4,
  RPL: 0x3,
} as const;

/**
 * Build a segment selector.
 *
 * The TI bit selects the descriptor table: 0 means GDT and 1 means LDT. The
 * default is the GDT, which is why the bit is *cleared* in that case.
 */
export function makeSelector(index: number, ring: Ring, table: 'gdt' | 'ldt' = 'gdt'): number {
  const ti = table === 'ldt' ? Selector.TI : 0;
  return ((index << 3) | ti | (ring & Selector.RPL)) & 0xffff;
}

export function selectorIndex(sel: number): number {
  return (sel & Selector.INDEX_MASK) >> 3;
}

export function selectorRing(sel: number): Ring {
  return (sel & Selector.RPL) as Ring;
}

/**
 * System segment descriptor access byte. The low nibble encodes type and the
 * high nibble encodes DPL plus the present bit.
 * Source: Intel SDM Vol. 3, Fig. 3-11 and Table 3-10.
 */
export const DescAccessByte = {
  TYPE_MASK: 0x0f,
  S: 0x10,
  DPL_SHIFT: 5,
  DPL_MASK: 0x60,
  P: 0x80,
} as const;

export const DescType = {
  /** 0x9 = 64-bit code, conforming. */
  CODE64_CONFORMING: 0x9,
  /** 0xA = legacy code, conforming. */
  CODE_CONFORMING: 0xa,
  /** 0xB = 32/64-bit code, non-conforming. */
  CODE_NONCONFORMING: 0xb,
  /** 0xC = data, read/write. */
  DATA_RW: 0xc,
  /** 0xD = data, read-only. */
  DATA_RO: 0xd,
  TSS_AVAILABLE: 0x9,
  TSS_BUSY: 0xb,
} as const;

/** A decoded 8-byte GDT entry. */
export interface SegmentDescriptor {
  base: bigint;
  limit: bigint;
  /** True when S=1 (code/data); false for system segments such as TSS/LDT. */
  readable: boolean;
  writable: boolean;
  /** True for 64-bit code segments (L bit). */
  long: boolean;
  /** True for conforming code segments. */
  conforming: boolean;
  /** True when DPL=0. */
  supervisor: boolean;
  present: boolean;
  accessed: boolean;
  granularity: boolean;
  /** Raw 8 bytes exactly as stored in the GDT. */
  raw: bigint;
}

export interface TaskStateSegment {
  rsp0: bigint;
  rsp1: bigint;
  rsp2: bigint;
  reserved1: bigint;
  ist: [bigint, bigint, bigint];
  reserved2: bigint;
  reserved3: bigint;
  reserved4: bigint;
  cr3: bigint;
  eip: bigint;
  eflags: bigint;
  cs: number;
  ss: number;
  es: number;
  ds: number;
  fs: number;
  gs: number;
  ldt: number;
  t: boolean;
  reserved5: bigint;
}

/* -------------------------------------------------------------------------- */
/* Paging                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * x86-64 uses four levels of paging tables, each entry 8 bytes wide, indexing
 * 512 children. Four levels give 9 + 9 + 9 + 9 = 36 bits of virtual address.
 * Source: Intel SDM Vol. 3, Sec. 4.5.
 */
export const PAGE_LEVELS = 4 as const;
export const ENTRIES_PER_TABLE = 512 as const;
export const PAGE_SIZE = 4096 as const;
export const LARGE_PAGE_SIZE = 2097152;

/**
 * Page table entry bits. Source: Intel SDM Vol. 3, Table 4-7 through 4-9.
 */
export const PTE = {
  P: 1n << 0n,
  RW: 1n << 1n,
  US: 1n << 2n,
  PWT: 1n << 3n,
  PCD: 1n << 4n,
  A: 1n << 5n,
  D: 1n << 6n,
  PS: 1n << 7n,
  /** In a PDPTE/PDE with PS=1, PAT occupies bit 12. */
  PAT_HUGE: 1n << 12n,
  NX: 1n << 63n,
  /** Physical frame number mask: bits 12..51 (bit 52 and above are reserved). */
  ADDR_MASK: 0x000f_ffff_ffff_0000n,
  /** Page offset mask within a 4 KiB page. */
  PAGE_OFFSET_MASK: 0xfffn,
  HUGE_OFFSET_MASK: 0x1f_ffffn,
} as const;

/** Bit patterns for the 4-level page walk, indexed by level. */
export const PTE_LEVEL_SHIFTS = [39n, 30n, 21n, 12n] as const;

/* -------------------------------------------------------------------------- */
/* Interrupts and exceptions                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Exception and interrupt vector numbers. Source: Intel SDM Vol. 3, Table 6-1
 * "Exception Class Vector Numbers".
 */
export const Vector = {
  DIVIDE_ERROR: 0,
  DEBUG: 1,
  NMI: 2,
  BREAKPOINT: 3,
  OVERFLOW: 4,
  BOUND_RANGE: 5,
  INVALID_OPCODE: 6,
  DEVICE_NOT_AVAILABLE: 7,
  DOUBLE_FAULT: 8,
  COPROCESSOR_SEGMENT_OVERRUN: 9,
  INVALID_TSS: 10,
  SEGMENT_NOT_PRESENT: 11,
  STACK_SEGMENT_FAULT: 12,
  GENERAL_PROTECTION: 13,
  PAGE_FAULT: 14,
  RESERVED_15: 15,
  X87_FP_EXCEPTION: 16,
  ALIGNMENT_CHECK: 17,
  MACHINE_CHECK: 18,
  SIMD_FP_EXCEPTION: 19,
  VIRTUALIZATION: 20,
  CONTROL_PROTECTION: 21,
  /** First user-defined "software IRQ" / IPI vector. */
  LOCAL_TIMER: 32,
  /** Timer interrupt, wired to the PIT through the legacy PIC. */
  TIMER: 20,
} as const;

export type Vector = (typeof Vector)[keyof typeof Vector];

export const EXCEPTION_NAMES: Readonly<Record<number, string>> = {
  0: '#DE Divide Error',
  1: '#DB Debug',
  2: 'NMI',
  3: '#BP Breakpoint',
  4: '#OF Overflow',
  5: '#BR Bound Range Exceeded',
  6: '#UD Invalid Opcode',
  7: '#NM Device Not Available',
  8: '#DF Double Fault',
  9: '#TS Coprocessor Segment Overrun',
  10: '#NP Invalid TSS',
  11: '#SS Segment Not Present',
  12: '#SP Stack-Segment Fault',
  13: '#GP General Protection',
  14: '#PF Page Fault',
  15: 'Reserved',
  16: '#MF x87 FP Exception',
  17: '#AC Alignment Check',
  18: '#MC Machine Check',
  19: '#XM SIMD FP Exception',
  20: '#VC VMMX Instruction',
  21: '#CP Control Protection',
};

/**
 * Page fault error-code bits. Source: Intel SDM Vol. 3, Table 4-14.
 */
export const PageFaultError = {
  P: 1 << 0,
  W: 1 << 1,
  US: 1 << 2,
  RSVD: 1 << 3,
  I_D: 1 << 4,
} as const;

export type AccessKind = 'read' | 'write' | 'execute';

/** Type attribute bits of an IDT gate. Source: Intel SDM Vol. 3, Table 6-8. */
export const GateType = {
  TASK: 0x5,
  INTERRUPT_16: 0x6,
  TRAP_16: 0x7,
  INTERRUPT_32: 0xe,
  TRAP_32: 0xf,
} as const;

export const IDT_ENTRY_BYTES = 16 as const;

/** Legacy PIC (8259A) interrupt request lines. */
export const IRQ = {
  TIMER: 0,
  KEYBOARD: 1,
  CASCADE: 2,
  COM2: 3,
  COM1: 4,
  LPT2: 5,
  FLOPPY: 6,
  RTC: 7,
  CMOS: 8,
  /** Free vectors above this point are available for our own IRQ lines. */
  IDE0: 14,
  IDE1: 15,
  USER_BASE: 16,
} as const;

export type IRQ = (typeof IRQ)[keyof typeof IRQ];

/** Total legacy IRQs on a standard dual-8259A pair. */
export const PIC_IRQ_COUNT = 16 as const;

/* -------------------------------------------------------------------------- */
/* Port I/O                                                                    */
/* -------------------------------------------------------------------------- */

export const PortWidth = {
  BYTE: 1,
  WORD: 2,
  DWORD: 4,
} as const;

export type PortWidth = (typeof PortWidth)[keyof typeof PortWidth];

/* -------------------------------------------------------------------------- */
/* Descriptor tables                                                            */
/* -------------------------------------------------------------------------- */

export const GDT_ENTRY_BYTES = 8 as const;

/** Physical address of the BIOS data area handed to stage 2. */
export const BDA_LOCATION = 0x400n;

/** Conventional load address of the boot sector and of stage 2. */
export const BOOT_SECTOR_LOAD_ADDRESS = 0x7c00n;
export const STAGE2_LOAD_ADDRESS = 0x8000n;
export const STAGE2_MAX_SECTORS = 32;

/**
 * Page table location used by stage 2. Four contiguous tables (PML4, PDPT, PD,
 * PT) of 4096 bytes each, immediately followed by a GDT and an IDT.
 *
 * These addresses must agree with `src/boot/stage2.asm`.
 */
export const BOOT_PAGE_TABLES_ADDRESS = 0x70_000n;
export const BOOT_GDT_ADDRESS = 0x80_000n;
export const BOOT_IDT_ADDRESS = 0x81_000n;

/** Identity-mapped region established by stage 2, in bytes. */
export const BOOT_IDENTITY_MAP_BYTES = 0x4000_0000n; // 1 GiB

/* -------------------------------------------------------------------------- */
/* Syscall ABI                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * VerixOS system call numbers. The calling convention is deliberately the
 * x86-64 System V one so that the transition cost is minimal:
 *
 *   rax = syscall number
 *   rdi, rsi, rdx, r10, r8, r9 = arguments 1..6
 *   rcx = return address
 *   r11 = saved RFLAGS
 *
 * Source for the register roles: Intel SDM Vol. 2, Sec. 3.1.2.5.
 */
export const Syscall = {
  EXIT: 0,
  YIELD: 1,
  GET_TID: 2,
  GET_PID: 3,
  WRITE: 4,
  READ: 5,
  OPEN: 6,
  CLOSE: 7,
  SEEK: 8,
  GETC: 9,
  PUTC: 10,
  /** Return a raw EFLAGS snapshot of the calling thread. */
  GET_FLAGS: 11,
  /** Faulting-in probe used by the test suite to validate the VMM. */
  MM_PROBE: 12,
  NOP: 13,
} as const;

export type Syscall = (typeof Syscall)[keyof typeof Syscall];

export const SYSCALL_NAMES: Readonly<Record<number, string>> = {
  0: 'exit',
  1: 'yield',
  2: 'get_tid',
  3: 'get_pid',
  4: 'write',
  5: 'read',
  6: 'open',
  7: 'close',
  8: 'seek',
  9: 'getc',
  10: 'putc',
  11: 'get_flags',
  12: 'mm_probe',
  13: 'nop',
};

/** Byte pattern written to 0xFFFF_0000_0000_0018 to trigger SYSCALL. */
export const SYSCALL_MAGIC_ADDRESS = 0xffff_0000_0000_0018n;