# Security policy

## Supported versions

VerixOS is pre-1.0 software under active development. There is one supported
line, and it is experimental.

| Version | Supported | Security fixes |
| --- | --- | --- |
| 0.1.x | Yes, experimental | Best effort, on `main` |
| < 0.1 | No | None |

There are no long-term support branches. Fixes land on `main`. There is no
patch series for older versions, because there are no older versions worth
patching: every release so far has been unreleased work.

## No security guarantees

This is the most important section of this document.

**VerixOS provides no security guarantees of any kind.** It is pre-1.0, it is
experimental, and it should not be relied upon to protect anything.

Specifically:

- Ring 3 is not a security boundary. It is modelled and checked, but the kernel
  has not been audited and should not be assumed free of privilege-escalation
  bugs.
- There is no authentication, no access control, and no capability model.
- The machine model enforces bounds on memory and port access so that bugs are
  caught during development. That is a diagnostic property, not a defence
  against a hostile program.
- There is no hardening, no exploit mitigation, and no fuzzing programme.
- The simulator is not a security boundary for the host. It executes simulated
  code, but a bug in the interpreter is an ordinary memory-safety bug in
  TypeScript running in Node.
- VerixOS does not boot on bare-metal hardware, does not boot on your computer,
  and does not run anything you care about. If it did, none of the above would
  change.

What VerixOS *is* useful for is as a place to study and test operating system
concepts, and for that the absence of guarantees is not a problem.

## Reporting a vulnerability

If you believe you have found a genuine security-relevant defect, please report
it privately rather than opening a public issue.

**Use GitHub Security Advisories private reporting.** Go to the repository's
[Security tab](https://github.com/verixos/verixos/security), then
**Report a vulnerability**. This opens a private channel visible only to you and
the maintainers, and gives the report somewhere to live that is separate from the
issue tracker.

If private reporting is unavailable to you, contact a maintainer directly rather
than opening a public issue. Contact details are in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Please include:

- The kernel version, from `git describe` or the startup banner.
- Your host Node version, from `node --version`.
- The exact command and the image, if you built one.
- The full console output, in a code block.
- What you observed, and what you believe should happen instead.
- The Intel SDM section covering the behaviour, if you can identify it. In a
  kernel project whose machine model claims architectural fidelity, a wrong
  architectural behaviour is a security-relevant defect in the most direct
  sense.

Please do not:

- Open a public issue for an unfixed vulnerability.
- Include proof-of-concept code that damages data, accesses resources outside the
  simulated machine, or runs on the host.
- Disclose the issue publicly before it has been addressed or a fix has been
  agreed.

There is no bug bounty and no paid disclosure programme. If you need an SLA,
please say so in the report and we will tell you honestly what is realistic for a
volunteer project rather than committing to something we cannot meet.

## What is in scope

VerixOS has a wide attack surface of a very specific kind. The following count as
security-relevant defects and are in scope.

### Kernel correctness

- A kernel bug that allows a process to affect a process it should not be able to
  affect, including across address spaces.
- A missing or incorrect permission check on a memory, port or device access.
- An incorrect privilege-level check on an interrupt gate, syscall entry or
  segment load.
- Any path by which ring 3 gains ring 0.
- A use-after-free, double free, or out-of-bounds access in a kernel data
  structure.
- A page table or frame management bug that maps a page to the wrong frame, loses
  a page's permissions, or leaks a frame across address spaces.
- An unbounded or attacker-influenced loop in the kernel that never terminates.
- Any kernel path that dereferences a pointer from userland without validating
  it.

### Memory safety of the simulator

The machine model is part of the trusted computing base of this project: if it is
wrong, the kernel's reasoning is wrong. In scope:

- An access to an unmapped physical address, or an unclaimed I/O port, that
  silently succeeds instead of raising a fault.
- A bounds-check failure: an access that escapes the installed region it was
  validated against.
- A memory-safety defect in the interpreter, decoder or a device model that can be
  reached from simulated code — including anything that could affect the Node.js
  process itself.
- An instruction that decodes or executes in a way that violates the SDM in a way
  the kernel might rely on. Wrong flags, wrong sub-register merge semantics and
  wrong page-fault error codes all count.
- MMIO registration or port registration that permits overlapping claims.
- A device model that can be made to read or write outside its own allocated
  range.

### Memory disclosure in userland

- A process reading another process's memory.
- A process reading or writing kernel memory.
- A stale or uninitialised frame being returned to userland: this includes a
  kernel heap block whose contents are handed to userland without being zeroed,
  and a newly allocated frame whose previous contents remain visible.
- An initrd or ramdisk path that allows access outside the node it resolved to.
- A path traversal that escapes a mount root.

## What is out of scope

- Anything requiring an attacker to already have ring 0.
- Denial of service against the *host* through resource consumption. The
  simulator is single-threaded and deterministic; running it for a long time is
  not a vulnerability.
- Vulnerabilities in Node.js itself. Report those to the Node.js project.
- Vulnerabilities in dependencies. There are no runtime dependencies; devDependency
  issues go to the relevant package and are handled as supply-chain maintenance,
  not as VerixOS security issues.
- Physical attacks, side channels, and timing analysis. Timing is not modelled.
- Anything that requires the victim to run untrusted content in a configuration
  VerixOS does not claim to support.
- Missing hardening and missing best-practice mitigations, on the grounds that the
  project does not claim to implement them.
- Denial of service against simulated userland from simulated userland. There is
  no resource accounting; a runaway process wedging the simulator is expected
  behaviour at this stage.

## Security model, briefly

Stating this plainly, so that expectations are correct:

VerixOS simulates a machine. Simulated code runs inside a TypeScript process on
Node.js. The trust boundary that actually matters today is between the simulator
and the host, and it is only as strong as Node's memory safety and the absence of
bugs in the interpreter.

Within the simulated machine, ring separation exists so that the kernel can be
written as a real kernel and tested against real expectations. It is not a
security boundary and must not be relied on as one.

Anything that would let simulated code affect the host is the most serious class
of bug in this project, and the in-scope list above is written with that in mind.
