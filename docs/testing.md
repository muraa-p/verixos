# Testing VerixOS

Everything here runs inside a single Node process. You do not need to reboot, use a
virtual machine, or write anything to a disk.

## The short version

```sh
npm install
npm run check      # typecheck + full test suite
```

That is the whole feedback loop. `npm run check` exits non-zero on any failure,
which is what CI runs.

## Why it is safe

VerixOS is a simulator: it models a CPU, memory, and devices as JavaScript objects
and interprets x86-64 machine code against them. It is software *describing*
hardware, not software *driving* hardware.

Concretely, there is no code path in `src/` that can reach a physical device:

- No raw disk or USB access. There is no disk driver.
- No host driver loading, so nothing can be installed into your machine.
- No file writes outside the project directory. The one script that writes files,
  `tools/screenshot.ts`, writes PNGs into `docs/assets/`.
- No privileged operation of any kind. It runs as your normal user account.

The realistic worst case is a Node process spinning one CPU core. `Ctrl+C` always
works.

If you are cloning other operating system projects for comparison, note that most
of them *do* require a VM or a USB write. VerixOS does not, and never will in its
current architecture.

## What to run

| Command | What it does |
| --- | --- |
| `npm test` | The full suite on Node's built-in test runner, TAP output |
| `npm run typecheck` | `tsc --noEmit` under a strict configuration. Silent means clean. |
| `npm run check` | Both of the above, in sequence. The CI command. |
| `npm run test:watch` | Re-runs affected tests on save |
| `npm run screenshot` | Regenerates `docs/assets/*.png` from the VGA adapter |

`npm start` currently fails with a "module not found" for `src/cli.ts`. That file
has not been written yet; see [Limitations](https://github.com/muraa-p/verixos#limitations).

## The suites

| File | Covers |
| --- | --- |
| `tests/arch.test.ts` | Architectural constants, register file sub-register semantics, flag bits, page table entry layout, selector encoding |
| `tests/decode.test.ts` | Instruction decoding against hand-written byte sequences, including instruction-length accounting |
| `tests/vga.test.ts` | VGA aperture addressing, text cells, MMIO offsets, and rendered pixels |

A note on `decode.test.ts`: when it asserts a specific byte layout, the comment
cites why those bytes are what they are, because a decoder that merely agrees with
itself is worth nothing. Several assertions in it were wrong when first written and
the encoder was correct; those were corrected rather than the other way round.

## Manual exploration

You do not need a running kernel to poke at the machine model. The decoder and the
VGA adapter are both directly usable:

```sh
# Disassemble a byte stream. Works in any mode.
node --experimental-strip-types --no-warnings -e "
import('./src/arch/decode.ts').then(m => {
  const bytes = Uint8Array.from([0x48, 0x31, 0xc0, 0x48, 0x89, 0xc3]);
  const d = new m.InstructionDecoder(m.bufferReader(bytes, 0x401000n), m.CpuMode.LONG64);
  let rip = 0x401000n;
  while (rip < 0x401000n + BigInt(bytes.length)) {
    const i = d.decode(rip);
    console.log(i.toString());
    rip += BigInt(i.length);
  }
});
"
```

```sh
# Draw to the VGA adapter and render it to a PNG.
node --experimental-strip-types --no-warnings -e "
import('./src/machine/devices/vga.ts').then(m => {
  const vga = new m.VgaAdapter();
  vga.setMode(0x03);
  vga.writeText(2, 2, 'hello from the VGA adapter', 15, 0);
  console.log('cell(2,2) =', vga.getCell(2, 2));
  console.log('distinct rendered colours =', new Set(vga.renderToRgb()).size);
});
"
```

## How to report a failure that matters

The most valuable bug report is one that says: *here is the byte sequence, here is
what I expected the architecture to do, here is what happened instead.* For
decoder work that is easy to produce, and it is the kind of report that leads to a
real fix rather than a style debate.

Useful things to include:

- Node version (`node --version`) and OS
- The exact command you ran
- The byte sequence or input that reproduces it
- Expected versus actual, in architectural terms

## When a test looks wrong

Some VerixOS tests encode architectural rules that surprise people, and a few
encode rules that look wrong but are not:

- **Register field 6 is `DH` without REX and `SIL` with it.** Even an empty
  `REX = 0x40` changes the meaning. The decoder resolves this and carries a
  `highByte` flag; the register file has no way to re-derive it, so the flag is
  passed in rather than guessed.
- **`SIB` index field `100` means "no index"** unless REX.X promotes it to R12.
- **`mod=00, rm=101` is RIP-relative in 64-bit mode**, not an absolute address.
  Treating it as absolute is the classic long-mode trap.
- **Instruction length must be exact.** If it is short, the next instruction is
  fetched from the middle of the current one. The sequential-decode tests in
  `decode.test.ts` check total byte coverage precisely because of this.