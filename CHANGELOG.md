# Changelog

All notable changes to VerixOS are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because VerixOS is pre-1.0, entries under `0.x` carry no compatibility promise.
See [SECURITY.md](SECURITY.md) and [docs/abi.md](docs/abi.md) for what is and is
not guaranteed.

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/verixos/verixos/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/verixos/verixos/releases/tag/v0.1.0
