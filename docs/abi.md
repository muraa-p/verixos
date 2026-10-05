# VerixOS kernel ABI

This is the contract between the VerixOS kernel and userland. Anything userland
is allowed to rely on is written down here. Anything not written down here is an
implementation detail and may change.

The ABI is frozen from version 0.1.0 onwards. See
[stability](#stability) for what that does and does not promise.

## Calling convention

VerixOS system calls use the x86-64 System V convention.

| Register | Role on entry | Role on return |
| --- | --- | --- |
| `rax` | Syscall number | Return value |
| `rdi` | Argument 1 | Clobbered |
| `rsi` | Argument 2 | Clobbered |
| `rdx` | Argument 3 | Clobbered |
| `r10` | Argument 4 | Clobbered |
| `r8` | Argument 5 | Clobbered |
| `r9` | Argument 6 | Clobbered |
| `rcx` | Return address, set by hardware | Clobbered |
| `r11` | Saved `RFLAGS`, set by hardware | Clobbered |
| `rsp` | User stack | Restored |
| `rip` | Resume address | Restored |
| `rbx`, `rbp`, `r12`–`r15` | Preserved by the ABI | Preserved |

Notes that matter in practice:

- **Argument 4 is `r10`, not `rcx`.** The syscall instruction destroys `rcx`, so
  the fourth argument has to move to `r10`. Code that follows the ordinary System
  V argument order will pass the wrong value here, and it is the single easiest
  mistake to make against this ABI.
- **Only `rax` carries the result.** There is no separate error register and no
  `errno` slot in the caller.
- **`rcx` and `r11` are clobbered.** Ordinary System V code preserves `rcx` and
  treats `r11` as caller-saved, so saving `rcx` across a wrapper is the caller's
  job.

## Syscall numbers

| Number | Name | Signature | Returns |
| --- | --- | --- | --- |
| 0 | `exit` | `exit(status: u64)` | Does not return |
| 1 | `yield` | `yield()` | `0` |
| 2 | `get_tid` | `get_tid()` | Current thread id |
| 3 | `get_pid` | `get_pid()` | Current process id |
| 4 | `write` | `write(fd: i64, buf: u64, len: u64)` | Bytes written, or negative errno |
| 5 | `read` | `read(fd: i64, buf: u64, len: u64)` | Bytes read, `0` at end of file, or negative errno |
| 6 | `open` | `open(path: u64, flags: u64)` | File handle, or negative errno |
| 7 | `close` | `close(handle: i64)` | `0`, or negative errno |
| 8 | `seek` | `seek(handle: i64, offset: i64, whence: u64)` | New absolute offset, or negative errno |
| 9 | `getc` | `getc()` | Byte `0`–`255`, or negative errno |
| 10 | `putc` | `putc(byte: u64)` | `0`, or negative errno |
| 11 | `get_flags` | `get_flags()` | Snapshot of the calling thread's `RFLAGS` |
| 12 | `mm_probe` | `mm_probe(addr: u64, len: u64)` | `0` if mapped and accessible, else negative errno |
| 13 | `nop` | `nop()` | `0` |

### Notes on individual calls

- **`exit`** does not return. The thread is removed from the scheduler and its
  address space is released. There is no `atexit`.
- **`yield`** gives up the remainder of the current thread's time slice. It
  returns `0` immediately; whether the caller actually ran again before someone
  else is not guaranteed.
- **`read`** returns `0` only at end of file. A short read — fewer bytes than
  requested, without reaching the end — is possible and must be handled.
- **`open`** returns a handle, not a descriptor. Handles are kernel-wide, small
  non-negative integers, and are not small dense integers starting at zero.
  Comparing them with `< 0` is the correct validity test.
- **`seek`** whence values: `0` = from the start, `1` = from the current offset,
  `2` = from the end. A negative resulting offset is an error, not a
  wrap-around.
- **`mm_probe`** is a faulting-in probe. It answers whether a virtual range is
  currently mapped and accessible with the caller's privileges, without
  dereferencing it. It exists for the test suite and for the shell's memory
  reporting. It does not make an unmapped range mapped.
- **`get_flags`** returns a raw `RFLAGS` value, not a decoded set. Bit 1 reads as
  1 and writes are discarded, and bit 63 reads as 0. This is a debugging
  convenience and userland should not build control flow on it.

## Argument marshalling

Arguments are passed by value in registers. There is no structure passing: a
structure or string is passed as a pointer to user virtual memory plus a length,
and the kernel reads through the pointer.

Rules the kernel applies to every pointer argument:

- The pointer is translated through the caller's address space with the caller's
  privileges. A kernel-space address passed by userland is a fault, not a
  privileged access.
- The claimed length must lie entirely within mapped, readable (or writable) user
  pages. A range that crosses into unmapped memory faults rather than being
  truncated.
- A length of `0` with a null pointer is valid and does nothing, so that the
  no-op case does not need a special branch at every call site.
- Strings are not null-terminated by the kernel; length is always explicit.
- The copy is made into kernel-owned memory before the result is computed, so a
  userland thread cannot change the bytes between the check and the use.

## Error convention

All errors are negative return values in `rax`. The value is the negation of a
POSIX-style errno:

| Value | Name | Meaning |
| --- | --- | --- |
| `-1` | `EPERM` | Operation not permitted |
| `-2` | `ENOENT` | No such file or directory |
| `-5` | `EIO` | I/O error |
| `-9` | `EBADF` | Bad file handle |
| `-12` | `ENOMEM` | Out of memory |
| `-13` | `EACCES` | Permission denied |
| `-14` | `EFAULT` | Bad address |
| `-22` | `EINVAL` | Invalid argument |
| `-24` | `EMFILE` | Too many open handles |
| `-28` | `ENOSPC` | No space left on the device |
| `-36` | `ENAMETOOLONG` | Path component too long |
| `-40` | `ELOOP` | Too many levels of symbolic links |

The complete list lives in one table in the kernel; this table documents the
subset userland currently depends on. New values may be added; existing values
never change.

The rule for userland is simple: **a result of zero or greater is a success and
carries a value; a negative result is a failure and carries nothing else.** Do
not interpret the magnitude of a negative value.

## VFS node operations

The VFS is presented to userland through syscalls, and internally as an
operations table. The internal table is the contract that matters for anyone
writing a filesystem, so it is documented here in full.

| Operation | Signature | Contract |
| --- | --- | --- |
| `lookup` | `lookup(parent, name)` → node | Resolve exactly one component. Returns `-ENOENT` if there is no such child. Must not resolve more than one component, must not follow a trailing `/`, and must reject a name containing `/` |
| `readdir` | `readdir(node)` → entries | Enumerate children. Returns `-ENOTDIR` if the node is not a directory. Entries are returned in a stable order for a given state of the filesystem, so that `ls` output is reproducible |
| `open` | `open(node, flags)` → handle | Acquire a handle. Rejects access not permitted by the node's mode, returning `-EACCES`. Returns `-EMFILE` when the handle table is full |
| `close` | `close(handle)` → 0 | Release a handle. `-EBADF` for an unknown handle. Closing twice is an error, not idempotent |
| `read` | `read(handle, buf, len, offset)` → count | Read at an explicit offset, so the handle carries no implicit position for this call. May return fewer bytes than requested. Returns `0` at end of file |
| `write` | `write(handle, buf, len, offset)` → count | Write at an explicit offset, extending the file if the offset is at or beyond the current length. Returns `-ENOSPC` when the backing store is full. Does not modify bytes beyond the written range |
| `seek` | `seek(handle, offset, whence)` → offset | Validate the result against the current length where the operation requires it. Returns `-EINVAL` for an unknown whence and for a resulting negative offset |
| `stat` | `stat(node)` → mode, size | Mode and current size in bytes. Returns the size as of the call; there is no notification when it changes |
| `truncate` | `truncate(node, size)` → 0 | Set the length. Growing extends and zero-fills; shrinking discards the tail. Returns `-EACCES` on a read-only node |

Cross-cutting requirements:

- Every operation returns a negative errno rather than throwing. Errors from
  below propagate unchanged unless a more specific error applies.
- Operations must not assume the caller validated anything. `read` and `write`
  are called with arbitrary offsets and lengths.
- No operation may block indefinitely. There is no sleeping in the VFS, which is
  what makes the current single-threaded execution model sufficient.
- Node lifetimes are managed by the backend, not the caller. A node returned by
  `lookup` remains valid until the tree is modified, and the VFS holds the
  reference.

## What userland may assume

This is the promise list. If any of these change, it is an ABI break and belongs
in [CHANGELOG.md](../CHANGELOG.md).

**Guaranteed**

1. Syscall numbers 0 through 9 never change meaning. New calls are allocated
   above them.
2. `rcx` and `r11` are clobbered by a system call; all other registers named in
   the convention table behave as stated.
3. `rbx`, `rbp` and `r12`–`r15` are preserved across a system call.
4. A non-negative return value is a success and carries a value. A negative
   return value is a failure and carries only an errno.
5. `read` returns `0` at end of file, and a short read is always possible.
6. `open` returns a kernel-wide handle, and `handle < 0` is the validity test.
7. Path resolution handles `.` and `..`, and `..` cannot escape a mount root.
8. A pointer argument is validated before use, and an invalid one faults the
   calling thread rather than reading kernel memory.
9. `mm_probe` does not modify the address space.
10. Errors are reported; nothing fails silently to a plausible-looking value.

**Not guaranteed**

1. **Ring 3 is not a security boundary.** It exists, and it is checked, but the
   kernel has not been audited. Do not treat it as protection against a hostile
   process.
2. **No atomicity across calls.** Two syscalls on the same object may interleave
   with another thread. VerixOS does not yet promise any locking for a single
   process either; a single-threaded process must serialise its own calls.
3. **No ordering between the handles and the filesystem.** A write followed by a
   `seek` and a `read` on the same handle is coherent. Anything more elaborate
   is not yet specified.
4. **No signal or interrupt delivery to userland.** An asynchronous event cannot
   interrupt userland execution.
5. **No CPU feature or performance guarantees.** The machine model implements the
   documented subset and models no timing.
6. **No stability guarantees at all before 1.0.** See below.

## Stability

VerixOS is at version 0.1.0 and provides no stability guarantees. The ABI is
documented and frozen in the sense above so that work in progress has something
stable to build against, not so that anything can depend on it externally.

Concretely, before 1.0:

- Syscall numbers may be added at any time, and new calls may gain arguments.
- Documented error values may be extended.
- Behaviour not written down in this document may change without notice.
- The ABI may be revised wholesale in a minor version bump.

The intention is that this document, once written, is the thing that has to change
whenever the ABI changes — not that it is stable today.
