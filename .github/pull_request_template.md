## What this changes

<!-- One or two sentences. What is the problem being solved, and what does this
     pull request do about it? Link the issue with "Fixes #123" if there is one. -->

## Why this way

<!--
     For anything with a design decision in it, explain the choice and the
     alternatives you rejected. If this touches the memory map, the syscall ABI,
     the native code boundary, the driver model, or the VFS operations table,
     say so explicitly here and say which document changes with it.

     The corresponding entry in ARCHITECTURE.md's design trade-off table is the
     right place for the reasoning if the decision is durable.
-->

## Architectural reference

<!--
     If this describes or changes hardware behaviour, cite the Intel SDM volume,
     section and table. The codebase's convention is that any comment describing
     architectural behaviour carries this reference, and the same applies to the
     reasoning behind the change.

     Example: Intel SDM Vol. 3, Sec. 4.5, Table 4-7.
-->

## Testing

<!--
     Kernel changes require a corresponding test. Please describe what the test
     asserts and why that is the right thing to assert.

     Prefer asserting the value the SDM specifies over asserting that the output
     merely looked plausible. Please include the failure path, not just the
     success path.
-->

- [ ] New or changed behaviour is covered by a test
- [ ] The test asserts the specified value, not a merely plausible one
- [ ] Negative and error paths are covered where they apply
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `node --experimental-strip-types --no-warnings src/cli.ts boot --smoke` passes, or this change does not touch the boot path

## Documentation

- [ ] `ARCHITECTURE.md` updated if the design changed
- [ ] `docs/abi.md` updated if the syscall or VFS contract changed
- [ ] `README.md` updated if a status or limitation changed
- [ ] `docs/roadmap.md` updated if phase status changed
- [ ] `CHANGELOG.md` updated if this is user-visible

## Constraints

- [ ] No runtime dependency was added
- [ ] No non-erasable TypeScript syntax was added (`enum`, namespaces, parameter properties)
- [ ] Relative imports carry an explicit `.ts` extension
- [ ] New architectural constants carry an SDM citation
- [ ] This change is in scope and does not silently redesign something

## Screenshots or traces

<!--
     For anything with observable output, a console trace is much better than a
     screenshot. If the change affects graphics, include both.
-->
