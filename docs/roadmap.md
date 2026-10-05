# VerixOS roadmap

The plan is a vertical slice, not a breadth-first sweep. The current milestone is
a single path from reset vector to a graphical desktop, because a working end-to-end
path exercises every layer and exposes the interface problems while there is still
time to change them. Breadth comes afterwards, as horizontal bands.

Phases 0 to 6 make up the current milestone. Phases 7 to 9 are later and are
described at a level of detail appropriate to work that has not started.

Status values:

| Status | Meaning |
| --- | --- |
| Complete | Implemented and exercised |
| Partially done | Built out of dependency order; later phases' output exists, earlier wiring does not |
| In progress | Partially built; the remainder is being worked on |
| Not started | Designed and scoped, no implementation |
| Planned | Direction agreed, detail not yet written down |

---

## Current milestone: the vertical slice

The goal is one continuous path: **boot, paging, heap, interrupts, drivers,
scheduler, VFS, graphics, shell, desktop with applications.** Each phase below
feeds the next, and no phase is considered finished until the shell responds.

---

## Phase 0: the machine model

**Status: In progress** — roughly half done. The decoder and the device models are
complete; the interpreter, the descriptor tables and the page walk are not. See the
per-goal breakdown below.

The substrate everything else runs on. If this is not faithful, every later
phase is testing against a fiction.

### Goals

- Model x86-64 architectural state exactly: sixteen general-purpose registers, RIP,
  RFLAGS, CR0/CR2/CR3/CR4, and the correct sub-register semantics for 8/16/32/64-bit
  access. — **Complete**
- Implement a real instruction decoder and interpreter for the instruction classes
  the milestones need, raising `#UD` for anything undecodable. — **Decoder
  complete, interpreter not started**
- Provide a physical memory bus with MMIO regions and a separate port I/O bus,
  both strict about bounds, width and ownership. — **Complete**
- Provide device models: 8259A PIC, 8254 PIT, 16450 UART, PS/2 controller, VGA with
  CRTC and sequencer. — **Complete**
- Model descriptors: GDT with architectural descriptor encoding, IDT with 16-byte
  gates. — **Constants defined; no tables built or loaded**
- Implement the four-level page walk with real permission checks and real page
  fault error codes. — **PTE layout and CR bits defined; no translation**
- Implement exceptions and the dispatch path, including double fault. — **Vectors
  defined; no gate handling**
- Keep execution deterministic: a given image and input sequence must produce the
  same trace every run. — **By construction; not yet demonstrated end to end**

### Deliverable

A machine model that boots a hand-assembled 64-bit program, executes
instructions, takes a timer interrupt, faults on an unmapped access, and
produces a reproducible register and memory trace.

### Acceptance criteria

- 32-bit destination writes zero-extend into the full 64-bit register.
- High-byte forms `AH`, `CH`, `DH`, `BH` behave as specified.
- Arithmetic flags, including the defined and undefined-flag cases, match the SDM.
- An access to an unmapped physical address raises a fault; it does not read zero.
- An access to an unclaimed I/O port raises a fault; it is not a silent no-op.
- Overlapping port registrations are rejected at registration time.
- A byte write to a wider device register merges into the correct byte lanes.
- An undecodable instruction raises `#UD` with the faulting RIP.
- A non-present page access raises `#PF` with CR2 set and the correct error-code
  bits, for read, write and execute separately.
- Two runs of the same image with the same input produce identical traces.

---

## Phase 1: boot to kernel entry

**Status: Not started** — the assembler this phase depends on does not exist yet.

### Goals

- A 512-byte boot sector at `0x7C00` that loads stage 2 and jumps to it.
- Stage 2 at `0x8000` that performs the long-mode transition and hands over.
- Enable PAE, set the physical bit, enable long mode, load `CR3`.
- Build identity page tables and load the GDT.
- Install the IDT, enable interrupts, and enter the kernel.
- Keep the machine model and the assembly in agreement about the addresses they
  share, by declaring those addresses in one place.

### Deliverable

The machine model boots the VerixOS image and reaches `kmain` with interrupts
enabled, paging on, and a known memory map.

### Acceptance criteria

- The BIOS loads 512 bytes to `0x7C00` and stage 2 to `0x8000` via `INT 13h`.
- Stage 2 runs as 64-bit code with `CS.L` set.
- `CR0.PE`, `CR4.PAE` and `CR0.PG` are set; `CR3` points at the boot tables.
- Identity mappings cover the first 1 GiB, including stage 2's own code.
- `LGDT` and `LIDT` have executed before `STI`.
- After `STI`, a timer interrupt reaches an IDT handler.
- A repeat boot produces the same trace.

---

## Phase 2: memory management

**Status: Not started** — depends on Phase 1.

### Goals

- PMM: bitmap frame allocator over 4 KiB frames, with reserved regions for the
  boot structures.
- VMM: page table construction, allocation and deallocation, the higher-half
  mapping, and the page-fault path.
- Kernel heap on top of the PMM.
- Architecturally correct TLB invalidation after every PTE change.
- Kernel stacks mapped eagerly, so the fault path always has a stack.

### Deliverable

The kernel allocates and frees frames, allocates and frees pages, faults on a
demand-paged access and recovers, and heap-allocates without corruption.

### Acceptance criteria

- Every frame is accounted for; a full allocation run followed by a full free run
  returns the allocator to its initial state.
- Double-free is detected.
- Reserved frames are never handed out.
- A fault on a not-present page succeeds on retry with the same instruction.
- Copy-on-write faults produce a private copy and leave the original unmodified.
- A user-mode access to a supervisor page raises `#GP`; a kernel-mode access to a
  user page raises `#PF`.
- Instruction fetch from an NX page raises `#PF` with the instruction-fetch bit set.
- Page-table modification without a matching invalidation is impossible to write.
- Heap allocation, free, coalescing and fragmentation behaviour all behave as
  documented, and a stress test finds no corruption.

---

## Phase 3: interrupts and drivers

**Status: Partially done out of order.** The device models exist and are tested,
but the driver model, exception dispatch and interrupt wiring above them have not
been written. The kernel cannot yet use any of the devices.

### Goals

- Complete exception handling, including double fault and the panic path.
- Remap the PIC to `0x20` and `0x28` and manage masks.
- Driver model: registration, probe, bind, unbind.
- Port and MMIO claiming through the strict bus APIs.
- Drivers: 8254 PIT, 16450 UART, PS/2 keyboard, VGA text mode, VGA graphics mode.
- Interrupt wiring decoupled from resource binding.

### Deliverable

The kernel drives real devices through a documented driver interface: a periodic
tick, serial output, keyboard input, and text and graphics output.

### Acceptance criteria

- The PIC is remapped and IRQ 0 reaches the timer handler.
- Masks are applied while the controller is being initialised and per-driver
  thereafter.
- A probe on absent hardware returns false and has no side effects.
- Two drivers claiming the same port range fail at bind time.
- A port access that crosses the end of a device's range is an error.
- The UART driver round-trips a byte through the emulated 16450, including
  line status.
- The keyboard driver translates scancodes to a key code, including modifier
  state.
- The VGA text driver renders to the text window and handles cursor movement.
- The VGA graphics driver sets a mode and writes pixels, with CRTC and sequencer
  state modelled.
- Every driver has a test that constructs the device and exercises its interface.

---

## Phase 4: tasks and scheduling

**Status: Not started**

### Goals

- Process and thread objects: address space, kernel stack, priority, state.
- Ring 3 execution with a per-process address space and per-thread kernel stack.
- Preemptive round-robin scheduling on the PIT tick.
- Priority levels, FIFO within a level.
- Blocking on syscalls and wait queues.
- TSS-based ring transitions.

### Deliverable

Several user threads run concurrently, preempted by the timer, with isolated
address spaces, and a fault in one does not affect another.

### Acceptance criteria

- Two threads interleave, and the interleaving is reproducible for a given image.
- A thread that never yields is still preempted.
- Each thread's address space is private; a write in one is invisible to another.
- Switching address spaces changes `CR3` and switching threads changes `RSP`.
- A page fault in one thread leaves the others runnable and unaffected.
- A fault in kernel mode panics rather than terminating the thread.
- A blocked thread is not scheduled until it is woken.
- A higher-priority thread is scheduled in preference to a lower-priority one.
- Context switch cost is bounded and does not grow with thread count.

---

## Phase 5: filesystems

**Status: Not started**

### Goals

- VFS: node abstraction, operations table, mount table, path resolution.
- Initrd backend: read-only, built into the image.
- Ramdisk backend: mutable, layered over the initrd.
- Block-level interface so a later filesystem is possible.
- Wire `open`, `read`, `write`, `close` and `seek` to syscalls.

### Deliverable

Userland can create, read, write, list and delete files through syscalls, with
writes landing in a real filesystem rather than a special case.

### Acceptance criteria

- The operations table is the only interface the VFS uses; no backend type
  appears in the VFS.
- `..` cannot escape a mount root.
- `.` and `..` resolve correctly at every path depth.
- Reads and writes at arbitrary offsets behave as documented, including extending
  a file.
- `read` returns `0` at end of file and may return short.
- Writing into a read-only mount fails with the documented errno.
- A stack of initrd over ramdisk presents the expected view: initrd files are
  visible, writes go to the ramdisk layer.
- Errors from a backend propagate to the syscall unchanged.
- No VFS operation blocks indefinitely.

---

## Phase 6: userland and desktop

**Status: Not started**

### Goals

- First process creation and image loading.
- Shell with a command table, running entirely through syscalls.
- Graphics mode and a compositor with double buffering.
- Damage rectangles and input focus.
- An application model: windows, a message loop, an application.

### Deliverable

The vertical slice completes: the kernel boots, runs applications, composites
them to the screen, and the shell accepts input alongside a desktop.

### Acceptance criteria

- The shell starts as the first process and prints a prompt.
- `help`, `mem`, `ps`, `dev`, `ls`, `cd`, `cat`, `echo` and `clear` all work
  through syscalls only.
- An unknown command reports an unknown command and does not fall through.
- The shell's exit code is reported and is visible in the prompt.
- The compositor never presents a partially drawn frame.
- Only damaged regions are recomposed, and an occluded window does no work.
- Moving a window recomposes the union of its old and new rectangles.
- Exactly one window has input focus, and clicks change it.
- An application opens a window, receives events, updates and closes.
- The whole path is reproducible: the same input sequence produces the same
  frames.

---

## Phase 7: native backend

**Status: Planned**

This is the phase in which the TypeScript kernel becomes a native one. It is
placed here, after the vertical slice, because the subsystem design is only worth
freezing once the end-to-end path exists to constrain it.

### Goals

- A second implementation of the kernel entry points behind the native code
  registry, in Rust or Zig.
- A complete replacement of the TypeScript kernel implementation, so the two can
  be compared directly.
- Parity at the subsystem level: same memory map, same ABI, same driver model,
  same VFS interfaces.

### Deliverable

The native backend passes the same test suite as the TypeScript kernel and
produces the same observable behaviour.

### Acceptance criteria

- The registry boundary is unchanged; nothing above it moves.
- The syscall ABI is bit-for-bit identical, including error values.
- The memory map and page table layout are identical.
- The same tests pass against both backends.
- The two backends produce identical traces for the same image and input.
- Switching backends is a configuration change, not a rebuild of the design.

### Explicitly not in scope

Bare-metal boot. Bringing up a kernel on real hardware is a separate and much
larger piece of work, and nothing in Phase 7 depends on it.

---

## Phase 8: SMP and APIC

**Status: Planned**

### Goals

- Move from the legacy 8259A pair to the local APIC and IOAPIC.
- Model multiple CPUs, each with its own register file, `CR3` and per-CPU state.
- Inter-processor interrupts and a spinlock discipline.
- Per-CPU scheduling with affinity.
- Uniprocessor correctness preserved as the default.

### Deliverable

The kernel runs on multiple modelled CPUs with APIC-based interrupt routing.

### Acceptance criteria

- Two CPUs execute concurrently and both reach user mode.
- A timer interrupt on one CPU wakes a thread on another via an IPI.
- Per-CPU data structures are correct under concurrent access.
- Lock ordering is documented and enforced.
- The IOAPIC routes device interrupts to the intended CPU.
- An SMP-disabled configuration still works, and is the default.

---

## Phase 9: networking

**Status: Planned**

### Goals

- A modelled network device with an MMIO interface.
- A driver, then a minimal stack: link, network and transport layers.
- Sockets in userland through a syscall ABI extension.
- The `initrd`, `ramdisk` and block-device layering finally gets a block device.

### Deliverable

Userland can open a socket and exchange data over the emulated link.

### Acceptance criteria

- The network device is a driver using the existing driver model, with no
  special-casing.
- The stack sends and receives frames, and drops malformed ones without
  destabilising the kernel.
- Sockets are reachable from userland through documented syscalls.
- A block-device filesystem mounts on the block interface, with no change to the
  VFS.
- Network processing is bounded and cannot starve the scheduler.

---

## Sequencing notes

- Phases 0 to 3 are on the critical path and are being built in that order.
  Phase 4 depends on Phase 2 for address spaces and Phase 3 for the timer.
- Phase 5 depends on Phase 4 only for blocking semantics; the VFS itself can be
  built against the current uniprocessor model.
- Phase 6 depends on Phases 4 and 5 and is the last step of the current
  milestone.
- Phase 7 depends on the whole slice existing.
- Phases 8 and 9 are independent of each other and can be taken in either order.
