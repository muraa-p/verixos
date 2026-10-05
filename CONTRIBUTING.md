# Contributing to VerixOS

Thank you for considering contributing. VerixOS is early, the design is still
moving, and honest disagreement about architecture is more valuable than a patch.

This document covers the practical side. For the design itself, read
[ARCHITECTURE.md](ARCHITECTURE.md) first — a patch that contradicts the
architecture document without discussing it will not be merged.

## Prerequisites

- Node.js >= 22.6. The project relies on Node's native TypeScript type stripping,
  which is why the floor is 22.6 and why there is no build step before you can
  run it.
- `git`.

That is the entire list. There is no Rust toolchain, no assembler, no emulator and
no Python requirement, and adding one would be a change to the project's core
premise.

## Getting set up

```sh
git clone https://github.com/verixos/verixos
cd verixos
npm install
```

The two devDependencies are TypeScript and `@types/node`. There are no runtime
dependencies, and there will not be any.

## Running the tests

```sh
npm run typecheck
npm test
```

`npm run typecheck` runs `tsc --noEmit` and prints nothing on success. It must be
clean; the configuration is strict and CI enforces it.

`npm test` runs the suites on Node's built-in test runner with native type
stripping. `npm run test:watch` runs the same suites in watch mode.

The full check, which is what CI runs:

```sh
npm run check
```

Other useful scripts:

| Script | What it does |
| --- | --- |
| `npm start` | Runs the CLI (`src/cli.ts`) |
| `npm run build` | Compiles to `dist/` |
| `npm run image` | Builds a bootable image under `images/` |
| `npm run clean` | Removes `dist/` and `images/` |

Run the boot path the way CI does before you open a pull request:

```sh
node --experimental-strip-types --no-warnings src/cli.ts boot --smoke
```

It must exit zero.

## Code style

### TypeScript

The project is TypeScript in strict mode, with a deliberately strict
configuration. `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`, `useUnknownInCatchVariables`, `isolatedModules` and
`verbatimModuleSyntax` are all on. Do not relax them to make a change easier, and
do not add `any` or a non-null assertion to silence the compiler — fix the type.

The one hard rule, and the reason for several others:

**No enums. Use `as const` objects.**

The project runs as native TypeScript on Node, which uses *erasable syntax only*.
An `enum` emits runtime code and therefore cannot be erased, so it will not run.
The pattern used throughout the tree is:

```ts
export const Reg = {
  AX: 0,
  CX: 1,
  DX: 2,
  BX: 3,
} as const;

export type Reg = (typeof Reg)[keyof typeof Reg];
```

This gives the same inference an enum would — the value union is derived from the
object, and the object is the namespace — and it erases to nothing. `tsconfig.json`
sets `erasableSyntaxOnly` precisely to make a violation a compile error rather
than a runtime surprise.

The same reasoning rules out other TypeScript features that emit code:
parameter properties, namespaces and non-declare class field initialisers are
also not erasable. Prefer explicit field declarations and constructor assignment.

### Imports

Relative imports must carry the explicit `.ts` extension:

```ts
import { BusFault } from '../machine/memory.ts';
```

Not `../machine/memory.js` and not `../machine/memory`. The configuration sets
`allowImportingTsExtensions` with `rewriteRelativeImportExtensions`, so the
compiler rewrites the extension for the emitted output and Node resolves the `.ts`
source directly. This is what lets the tree run unbuilt.

### Comments

Two rules.

**Comments explain why, and cite the architecture when behaviour is
architectural.** Any comment that describes how the hardware behaves must carry
the reference — volume and section:

```ts
// 32-bit writes always zero-extend into the full 64-bit register.
// Source: Intel SDM Vol. 1, Sec. 3.4.1.1.
```

Where a value comes from the SDM, cite the table as well as the section. Where a
decision is a design decision rather than an architectural requirement, say so in
the comment and put the reasoning in [ARCHITECTURE.md](ARCHITECTURE.md).

**Comments must be sentences.** Not sentence fragments, and not declarations of
the obvious. A comment that restates the code is worse than no comment.

### Dependencies

No runtime dependencies. Ever. This is a design commitment, not an oversight:
VerixOS should be cloneable, runnable and auditable with a Node install and
nothing else. If you believe a dependency is unavoidable, open an issue and make
the argument before writing the code.

DevDependencies should stay minimal too. If `node:built-in` can do it, it should.

### Style conventions

- Two-space indentation, single quotes, semicolons, trailing commas in
  multi-line literals. `.editorconfig` enforces the whitespace rules.
- Prefer `bigint` for physical and virtual addresses. They are modelled as 64-bit
  quantities and mixing in `number` silently loses precision above 2^53.
- Prefer explicit units in names: `read32`, `offsetBytes`, `sizeBytes`, `widthBytes`.
- Errors thrown from the machine layer are typed (`BusFault`, `PortFault`) rather
  than constructed ad hoc at each call site.
- Silent failure is a defect. An unmapped address, an unclaimed port, an unknown
  opcode and an unexpected argument all raise rather than returning a default.

## Commit messages

Conventional Commits. The format is enforced by review rather than by tooling,
but it should be followed exactly:

```text
<type>(<scope>): <subject>

<optional body>

<optional footer>
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`,
`chore`.

Scopes follow the tree: `arch`, `machine`, `cpu`, `boot`, `kernel`, `pmm`,
`vmm`, `heap`, `drivers`, `devices`, `vfs`, `syscall`, `user`, `tools`.

Rules:

- The subject is imperative, lower case, no trailing period, under 72 characters.
- One logical change per commit. A commit that fixes a bug and reformats a file
  is two commits.
- The body explains why, not what. The diff already says what.
- Reference the issue in the footer with `Fixes #123` or `Refs #123`.
- Architectural corrections get a body that cites the SDM, for the same reason
  the code comment does:

```text
fix(vmm): zero-extend on 32-bit destination writes

The SDM specifies that a write to a 32-bit destination zeroes bits 63:32 of
the full register. We were sign-extending, which corrupted pointers stored
with a 32-bit store.

Source: Intel SDM Vol. 1, Sec. 3.4.1.1.

Fixes #214
```

## Branch naming

```text
<type>/<short-description>
```

Short, lower-case, hyphenated description. Examples:

```text
feat/vmm-demand-paging
fix/pic-remap-idt-clash
docs/abi-error-convention
test/pit-frequency
```

Branches are expected to be short-lived. If a branch needs to live longer than a
few days, that is usually a sign the change wants splitting up or discussing
first.

## Pull requests

1. Open an issue before a large change. Architectural changes in particular —
   the memory map, the syscall ABI, the driver model — are much cheaper to
   discuss before they are written than after.
2. Branch from `main`.
3. Keep the change focused. One PR, one concern.
4. Make sure `npm run check` and the boot smoke test pass locally.
5. Update the documentation your change makes wrong. This is part of the change,
   not a follow-up. Architectural changes update [ARCHITECTURE.md](ARCHITECTURE.md);
   ABI changes update [docs/abi.md](docs/abi.md); user-visible changes update
   [README.md](README.md).
6. In the PR description, say what problem the change solves, how you tested it,
   and anything a reviewer should look at closely.
7. Expect review comments. Review here is about correctness and architectural
   fit, not about preference.

If a PR is substantial, expect it to go through more than one round. That is
normal for kernel work and is not a judgement of the work.

## Definition of done

A change is done when all of the following are true:

- `npm run typecheck` is clean under the existing strict configuration.
- `npm test` passes, and any new behaviour is covered by a test.
- `node --experimental-strip-types --no-warnings src/cli.ts boot --smoke` exits
  zero if the change touches anything on the boot path.
- Documentation affected by the change is updated in the same PR.
- New architectural constants carry an SDM citation, and new architectural
  behaviour carries a comment that says so.
- No runtime dependency has been introduced.
- The change is in scope, and does not silently redesign something. If it does,
  it is an issue and a design discussion first.

## Tests are required

**Any change to kernel behaviour requires a corresponding test.** This is not
negotiable and it is the single most important rule in this document.

The reasons are specific to this project:

- The machine model is deterministic, so behaviour is exactly reproducible and a
  test can assert on it. There is no flakiness excuse available.
- Several behaviours are byte-exact architectural requirements — flag results,
  page fault error codes, sub-register merge semantics. "It seemed to work" is not
  evidence; an assertion against the SDM's specified value is.
- The kernel is being written by several people at once. A test is how one
  contributor's change is prevented from silently breaking another's.

What a test should assert:

- **The specified value, not merely a plausible one.** If the SDM says the error
  code for a user-mode write to a supervisor page is a particular bit
  combination, assert that bit combination.
- **The failure path, not only the success path.** A negative test that the
  operation is refused is frequently more valuable than the positive one.
- **The invariant**, where that is the thing that matters. If a change must not
  leak frames, assert that the allocator's state after a full allocate-and-free
  cycle equals its initial state.

Tests live in `tests/` and are named `<area>.test.ts`. Use `node:test` and
`node:assert` — they are built in, and using anything else would mean a
dependency.

## Reporting bugs

Bug reports are more useful than patches at this stage, and much easier to act
on. Use the bug report template, and please include:

- Your kernel version, from `git describe` or the startup banner.
- Your host Node version, from `node --version`.
- The exact command you ran.
- The full console output, in a code block, not a screenshot.
- Whether `npm test` passes on the same checkout.

If the bug is in the machine model rather than the kernel, that is especially
valuable, because a wrong machine model invalidates the reasoning of everything
above it. If you can say which SDM section the behaviour should follow, that is
the most useful thing you can include.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). In short:
be decent, assume good faith, and assume that people are working on this in their
spare time.

## Licence

Contributions are accepted under the GNU General Public License, version 3 or (at
your option) any later version, matching the rest of the project. See
[LICENSE](LICENSE).
