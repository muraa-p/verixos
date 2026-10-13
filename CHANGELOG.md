# Changelog

All notable changes to VerixOS are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because VerixOS is pre-1.0, entries under `0.x` carry no compatibility promise.
See [SECURITY.md](SECURITY.md) and [docs/abi.md](docs/abi.md) for what is and is
not guaranteed.

## [Unreleased]

### The system boots, and there is a desktop

The largest change since the assembler landed: machine code is now executed. A
512-byte boot sector, written in assembly and assembled by this project, loads
stage 2 off a disk image through the firmware's `int 13h`; stage 2 programs the
PIT, unmasks the timer and keyboard lines on the 8259 pair, enables interrupts and
publishes a hand-off word; the kernel runtime takes it from there and runs a
windowing desktop at 320x200.

Every new subsystem's correctness claim is a measurement rather than a sentence.
The compositor reports how many pixels it wrote and how many it examined, and the
test suite asserts the ratio, so a regression to "redraw the whole screen every
frame" fails a build instead of passing a screenshot review.

### Added

**Instruction interpreter** (`src/cpu/interpreter.ts`)

- Executes decoded instructions against the register file, flags, memory bus and
  port bus. Covers the data-movement, ALU, shift, rotate, atomic, control-flow,
  string, system and I/O-string families the assembler can produce.
- A REP string primitive is one instruction: the whole iteration runs inside a
  single fetch, so RIP advances by the instruction's length once, not once per byte.
- Descriptor-table loads and stores read and write the six- or ten-byte
  pseudo-descriptor the SDM specifies rather than a word of the operand size.
- `SYSCALL`/`SYSCRET` enter and leave through `IA32_LSTAR` as long mode does, so
  the guest runs its own entry stub rather than calling a host function.
- An MSR the kernel has not programmed faults, because that is how feature
  discovery is supposed to work.

**Firmware** (`src/machine/firmware.ts`)

- `int 10h` (video: modes, cursor, scroll, teletype, string writes),
  `int 11h`, `int 12h`, `int 13h` (CHS read and verify), `int 14h`, `int 15h`,
  `int 16h` with set-1 scancode-to-ASCII translation, `int 17h` and `int 1Ah`.
- The BIOS data area is a live window onto the same RAM the bus serves, so
  `int 11h` and a guest reading `0x410` cannot disagree.
- Power-on self test primes the keyboard controller and discards its
  identification bytes, so the first keystroke is not lost and the first `int 16h`
  does not read the keyboard's model code as a character.

**Machine** (`src/machine/machine.ts`)

- Wires RAM, the port bus, the VGA aperture, the PIC pair, the PIT, the PS/2
  keyboard and the UART, and closes the loop from firmware back into the CPU.
- Time advances because instructions were executed: one instruction costs one
  oscillator cycle at the PIT's real 1.193182 MHz. A spinning guest produces
  ticks; a halted one produces none.
- `runBoot` reads the console out of the adapter and the hand-off out of memory,
  and refuses to continue if stage 2 did not finish.

**Boot path** (`src/boot/`)

- `boot.asm`: 512 bytes at `0x7C00`, ending in the `0x55AA` signature, loading
  stage 2 through `int 13h` and jumping to it.
- `stage2.asm`: programs the PIT for 100 Hz, unmasks IRQ0 and IRQ1, enables
  keyboard scanning with the two-write PS/2 sequence, enables interrupts and
  publishes the hand-off word.

**Kernel, compositor and desktop** (`src/kernel/`)

- Damage-tracked compositor with double buffering, rectangle coalescing that
  merges overlapping damage but keeps distant damage separate, and a measured
  `written`/`examined` count on every present.
- Window manager with a dock, focus cycling, keyboard-moved windows, bevelled
  frames and a status bar; three applications: a terminal that runs real commands,
  a live system monitor that graphs measured frame cost, and an about window.
- `parseKeyScript` turns `Tab/type:ver/Enter` into keystrokes, so a recorded run
  is reproducible.

**CLI** (`src/cli.ts`)

- `verix boot`, `verix gui`, `verix run`, `verix screen`, `verix info`.
- `verix gui --check` turns "the desktop is visible and responsive" into an exit
  code. CI runs it, so the claim is gated rather than asserted.

### Fixed

Twenty-three real bugs, each of which produced plausible output and would have
passed a test that only checked that something happened.

**Interpreter**

- A 16-bit or 8-bit register write zeroed the upper bits of the register. The
  SDM leaves them undefined and in practice preserved; writing them through cost
  any pointer held above 16 bits its high half on every `mov ax, ...`.
- `sar` shifted in zeros. `signExtend` returns the 64-bit *pattern* of a negative
  number, and `>>` on that pattern is a logical shift, so `sar` behaved as `shr`
  for every negative input. A test that shifted by four passed by luck; shifting
  by one did not.
- Signed `imul`, `idiv` and `div` operated on the same patterns, so two negative
  operands produced a huge positive product. `signedValue` now separates "the
  value" from "the bits".
- `inc` and `dec` cleared the carry flag, because they share the adder with `add`
  and nothing restored it.
- `adc` and `sbb` reported the wrong auxiliary carry when the low nibble of the
  second operand was `0x0f`, because folding the carry in first ripples it out of
  the nibble.
- `rcl` and `rcr` asked `widthMask` for 9, 17, 33 and 65 bits and threw.
- A shift count of zero cleared the carry flag instead of leaving it alone.
- `in` and `out` used the mode's default operand size rather than the transfer
  width, so `in al, dx` in long mode put four bytes on the bus.
- The port operand of `in`/`out` was decoded at the data width, printing `dl`
  where the architecture says `DX`.
- `mov ds, ax` faulted, which made every real-mode boot routine impossible.
- Control-register moves (`0F 20`/`0F 22`) did not decode at all, though the
  assembler could emit them.
- `jmpf`, `callf`, `iret`, segment push/pop, string I/O, the descriptor-table
  instructions, `smsw`/`lmsw`, `verr`/`verw`, `sldt`/`str`, `xgetbv`/`xsetbv`,
  `swapgs`, `invlpg`, `rdmsr`/`wrmsr`, `syscall`/`sysret` and the no-op system
  instructions all decoded and then faulted when executed.

**Decoder**

- The `B0+r` family names its register in the opcode and has no ModRM byte, so it
  bypassed the high-byte rule: `B4 11` decoded as `mov spl, 0x11` rather than
  `mov ah, 0x11`, a different instruction that needs a REX prefix.
- Descriptor-table operands were reported at 16 bits. They are pseudo-descriptors
  of six or ten bytes, so an executor would have fetched two bytes where the
  hardware fetches ten.

**Assembler**

- `.data` was placed at the origin instead of after `.text`. The emitted image had
  the right length and every string overwrote instructions: a boot sector built
  that way boots and then executes its own message text.
- A second reference to the same forward label was treated as a final address.
  `pending` is a `Set`, so `call print` twice added nothing new, the layout pass
  concluded nothing had been guessed, and the range check measured a displacement
  to address zero. Any routine calling a helper more than once failed to
  assemble.
- `mov eax, 0xdeadbeef` and `mov al, -1` were both refused. Those immediates fill
  the destination rather than extending it, so the full unsigned range applies;
  the decoder accepted what the encoder would not, which broke the round trip.
- `cwd` assembled as `66 99`, which is `cwde`. The `98`/`99` family is the one
  encoding decided by the mode's default operand size, and it had been written
  down as a fixed byte sequence.
- A bare symbolic address in a non-64-bit mode was treated as RIP-relative and
  refused, which made `mov word [handoff], magic` impossible in real mode.

**Devices**

- The PS/2 keyboard claimed only ports `0x60`-`0x61`, so the controller's command
  register at `0x64` faulted. Enabling scanning needs that register: a boot sector
  that cannot reach it can never receive a keystroke.
- Importing the screenshot tool ran it, so anything that wanted its PNG encoder
  wrote six images as a side effect.

### Documentation

- README: the status table, the test count and the visuals now describe a system
  that boots and runs, and the "what does not work yet" section names what is
  genuinely absent rather than what was absent last month.

### Instruction set: decoder completion and a full assembler

The instruction decoder was brought to coverage of every instruction class the
milestones need, and the assembler was written from scratch and then checked
against the decoder by a round-trip oracle. The oracle found sixteen real bugs,
each of which produced plausible bytes and would therefore have passed a test
that only compared the encoder against itself.

### Added

**Instruction decoder** (`src/arch/decode.ts`)

- `CMOVcc` at all sixteen conditions, `XADD`, and `CMPXCHG`, including their
  byte-register forms.
- `CBW`, `CWD`, `CWDE`, `CDQ` and `CDQE` as five distinct mnemonics. `48 98` is
  `cdqe` and `98` is `cwde`, so collapsing them would make one re-assemble to
  the other and silently change the width of the result.
- Width-suffixed string primitives: `movsb`/`movsw`/`movsd`/`movsq` and the same
  four for `stos`, `lods`, `scas` and `cmps`, each carrying its own width rather
  than reporting an operand size that the encoding never stated.
- `RCL` and `RCR` in the shift group, which were decoding as `unimplemented`.
- Both `0F 00` and `0F 01` system groups against their SDM tables, including
  `SGDT`, `SIDT`, `SLDT`, `STR`, `LLDT`, `LTR`, `VERR`, `VERW`, `SMSW`, `LMSW`,
  `INVLPG`, `XGETBV` and `XSETBV`.
- `SYSRET`, `WBINVD`, `CLTS`, `XLATB`, `RDMSR` and `WRMSR`.
- `RETF` and `RETFQ` as separate mnemonics. The SDM draws the line explicitly for
  far returns, so `CB` and `48 CB` in long mode move different amounts of the
  stack and must not print the same.
- `PAUSE` reported without a repeat prefix. `F3 90` is one instruction whose
  encoding contains the `F3`; printing it as `rep nop` re-assembled to `90`, and
  `rep pause` would have re-assembled to `F3 F3 90`, a decoder error.
- `INS` and `OUTS` at all four widths, split on the operand size exactly as
  `MOVS` is, rather than existing only as 8- and 16-bit forms.
- `XCHG` at all three widths plus the `90+rb` short form, with the ModRM r/m
  field chosen by which operand is memory.
- Far pointers as a single operand carrying a selector and an offset, printing as
  `jmp far 0x1000:0x1234`, plus `CALLF`/`JMPF`/`RETF`.

**Assembler** (`src/asm/`)

- A lexer, a recursive-descent parser, an AST, an encoder and a two-pass
  assembler, with no runtime dependencies and no non-erasable syntax.
- All three CPU modes, selected by `.code16`, `.code32` and `.code64`, with the
  mode's own default operand size and address width honoured throughout.
- An expression evaluator with full C operator precedence, string and character
  literals, and the usual arithmetic and bitwise operators.
- Labels resolved in two passes, with forward references allowed: an unresolved
  reference gets a provisional value and a widening loop runs until the byte
  layout is stable. Convergence is refused while any reference is still
  provisional, so an undefined label reports that it is not defined rather than
  encoding a zero displacement.
- Branch-width relaxation that is iterative and monotone rather than a guess: a
  branch starts at its shortest form and widens when a displacement does not fit,
  which means no pass can narrow it again and produce oscillation.
- Segment, directive and data-section support, with `.org` unable to move
  backwards and no `.bss`, because a section that is not in the image cannot be
  addressed by an offset in it.

**Round-trip oracle** (`tests/asm.test.ts`)

- A 343-instruction, 1069-byte corpus across seventeen groups and all three modes,
  asserting four things per instruction: that decoded lengths sum to exactly the
  assembled length, that every decoded line re-assembles, that the bytes are
  identical modulo one documented normalisation, and that the text is stable
  across a second decode.
- A second test pinning the normalisation set to exactly one entry and checking
  that the entry names encodings the corpus really produces, so a new difference
  cannot be added to the table without anyone deciding to.
- Corpus size floors, so an emptied corpus fails the test rather than passing it
  vacuously.

### Fixed

- Real-mode `push ax` emitted a `0x66`, assembling to `push eax`. The operand-size
  prefix was unconditional rather than conditional on the mode's default size.
- The `0F 01` group was numbered from the wrong SDM table. `SLDT`, `STR` and
  `LTR` were placed at the selectors `/0`, `/1` and `/4` of `0F 01`, where the SDM
  has `SGDT`, `SIDT` and `SMSW`; the correct group is `0F 00`. The failure was
  asymmetric and therefore dangerous - `sldt` would have assembled to `sgdt`, a
  store where a read was asked for.
- `XGETBV` and `XSETBV` decoded as `LGDT`, because they share the `0F 01` ModRM
  byte with the group without being part of it.
- `0F 07` decoded as `SWAPGS` rather than `SYSRET`.
- `0F 09`, `0F 06`, `0F 30`, `0F 32` and `0F D7` were not decoded at all, though
  the encoder produced all five.
- `SMSW` and `LMSW` reported their register destination as 16 bits regardless of
  the operand size, so `smsw eax` printed as `smsw ax`.
- Protected 32-bit mode used 16 as its default operand size, so `mov eax, ebx` in
  `.code32` was a 16-bit instruction.
- `POP CS` was encodable. It is not an instruction - the SDM states that the pop
  cannot target CS - and `0x0F` is the escape byte, so the bytes it emitted had an
  instruction length that depended on whatever followed.
- `PAUSE` reported its `F3` as a repeat prefix, producing text that re-assembled
  to two `F3` bytes.

## [0.1.0] - Unreleased

Initial foundation work: the architectural contracts and the machine layer that
every later subsystem depends on, plus the repository scaffolding and
documentation.

### Added

**Architectural contracts** (`src/arch/types.ts`)

- Normative definitions for every architectural constant the tree depends on, so
  that the CPU, the memory manager, the interrupt controller, the drivers and the
  test suite all agree on the same numbers under the same names.
- Register indices matching the x86-64 encoding order of the legacy 16-bit
  registers, with 8/16/32/64-bit name tables and the null entries for forms a
  register does not have.
- RFLAGS bit positions, including the reserved bit that reads as 1, and the mask of
  bits a user-mode process may modify via `POPF`/`POPFQ`.
- Control register indices, CR0 and CR4 bit masks, and a 40-bit physical address
  width.
- Segment selector layout, privilege levels, system segment descriptor access-byte
  encoding and descriptor type constants, with decoded descriptor and TSS shapes.
- Four-level paging constants: four levels of 512 entries, 4 KiB and 2 MiB page
  sizes, page table entry bit masks, physical frame address mask, and the per-level
  index shifts at 39, 30, 21 and 12.
- Exception and interrupt vector numbers, exception names, page fault error-code
  bits, and IDT gate types. IDT entries are 16 bytes; GDT entries are 8 bytes.
- Legacy PIC interrupt request line assignments and the free-vector boundary, with
  IRQ 2 identified as the cascade rather than a device.
- Port I/O access widths.
- Boot addresses: BDA at `0x400`, boot sector at `0x7C00`, stage 2 at `0x8000` with
  a 32-sector limit, boot page tables at `0x70000`, boot GDT at `0x80000`, boot IDT
  at `0x81000`, and the 1 GiB identity-mapped region established by stage 2.
- System call numbers 0 through 13 and their names, documented with the System V
  register roles, and the magic address at `0xFFFF_0000_0000_0018` that triggers
  the syscall path.

**Register file and flags** (`src/arch/registers.ts`)

- A register file of sixteen 64-bit general-purpose registers plus RIP, backed by a
  `BigUint64Array`, with debug-register support.
- Correct sub-register semantics: 32-bit writes zero-extend into the full 64-bit
  register, enforced in one place rather than at every call site; high-byte forms
  resolve to `AH`/`CH`/`DH`/`BH` only; 16-bit access is restricted to the registers
  that have a 16-bit form.
- Register access by name across all widths, for readable debugger and panic output.
- `RFLAGS` as named accessors over a 64-bit value, forcing the reserved bit on
  read and rejecting stores to it.
- Shared arithmetic-flag update for add, subtract and logic operations, so flag
  behaviour is consistent across the interpreter, with parity, sign, zero, carry,
  auxiliary and overflow computed in one place.
- Width masking, sign extension and signed conversion helpers.
- A human-readable register and flag dump used by the debugger and by panic output.

**Physical memory and the system bus** (`src/machine/memory.ts`)

- The standard PC physical memory map, covering the conventional memory boundary,
  the VGA window, the ROM area, the EBDA, and the LAPIC, IOAPIC and MMCONFIG
  apertures.
- Flat physical RAM backed by a single `Uint8Array`, with explicit little-endian
  reads and writes, bounds-checked subarray access, and a dump facility.
- A system bus that routes CPU accesses to RAM or to an MMIO region, keeping
  regions sorted and looked up by binary search.
- Strict access discipline: every access is bounds-checked, an unmapped access
  raises a typed `BusFault` rather than reading zero, access width is part of the
  API, and `BusFault` converts itself into a page fault error code.
- Read-only and write-only region enforcement, plus write watchers for debugger
  watchpoints.
- A register-file MMIO adapter for the common case, implementing x86 sub-width
  merge semantics so that a narrow write updates only the byte lanes written.

**Port I/O bus** (`src/machine/io.ts`)

- A separate 16-bit port address space, with devices claiming contiguous ranges.
- Strict port discipline matching the memory bus: an unclaimed port raises a typed
  `PortFault` rather than being a silent no-op, an access crossing the end of a
  device's range is an error, and overlapping registrations are rejected at
  registration time rather than producing a device that shadows another.
- Registration returns a closure that releases the range.
- Owner lookup, device name enumeration and a claimed-port count for diagnostics.
- A helper that masks port read results to the access width.

**Repository and documentation**

- `package.json` declaring Node.js >= 22.6 as the engine floor, the scripts used by
  development and CI, zero runtime dependencies, TypeScript and `@types/node` as
  the only devDependencies, and `GPL-3.0-or-later` as the licence.
- A strict `tsconfig.json`: `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, `noUnusedParameters`, `useUnknownInCatchVariables`,
  `isolatedModules` and `verbatimModuleSyntax`, together with
  `erasableSyntaxOnly` so that non-erasable syntax is a compile error under
  Node's native TypeScript support, and `allowImportingTsExtensions` with
  `rewriteRelativeImportExtensions` so the tree runs unbuilt.
- `.gitignore` covering build output, dependencies, runtime artefacts, editor noise
  and simulation recordings.
- `README.md` with an honest description of the project and its stage, a per
  subsystem status table, quick start, repository layout, architecture diagram, and
  an explicit limitations section.
- `ARCHITECTURE.md` covering design goals and non-goals, layering, the physical
  memory map, the native code boundary, memory management, the interrupt model, the
  scheduling model, the VFS, the syscall ABI, the driver model, userland, the boot
  sequence, extension points, and a design trade-off table.
- `docs/abi.md` as the kernel ABI reference: calling convention, syscall numbers,
  argument marshalling, error convention, VFS node operations, and the promise
  list stating what userland may assume.
- `docs/roadmap.md` as a phased plan from the machine model through to a native
  backend, SMP and networking, with goals, deliverables and acceptance criteria per
  phase.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` and `CHANGELOG.md`.
- Continuous integration covering type checking on Node 22 and 24, the test suite,
  a build with artifact upload, and a boot smoke test.

### Notes

- The milestone this work serves is a single vertical slice: boot, paging, heap,
  interrupts, drivers, scheduler, VFS, graphics, shell, and a graphical desktop with
  applications. See [docs/roadmap.md](docs/roadmap.md).
- The TypeScript kernel is executed by the machine model's runtime. VerixOS does not
  boot on bare metal and is not QEMU-compatible. The native code registry is the one
  documented boundary between machine code and TypeScript kernel code; a future
  native backend replaces the implementation behind that boundary and not the
  subsystem design.

[Unreleased]: https://github.com/muraa-p/verixos/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/muraa-p/verixos/releases/tag/v0.1.0
