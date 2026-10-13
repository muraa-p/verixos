/**
 * VerixOS - the command line.
 *
 * The tool a person uses to look at the system, which means it has to be quick
 * and it has to be honest. Three commitments shape it:
 *
 *  - **Nothing here fakes a result.** `verix gui` writes PNGs of the adapter's
 *    own frame buffer; `verix run` prints the machine's real register file after
 *    executing real instructions. If a stage fails, the command says which one and
 *    why, because a tool that reports success for a system that does not work is
 *    worse than no tool.
 *  - **The numbers are measurements.** `verix gui --stats` reports how many
 *    pixels each frame actually changed, and `verix gui --check` turns the same
 *    measurement into a pass or a fail. A claim about performance that cannot be
 *    turned into an exit code is a decoration.
 *  - **Nothing runs on the host's machine.** VerixOS runs inside its own
 *    `Machine` object with its own memory, its own devices and its own timer. The
 *    only host resources involved are the terminal and, when asked, a directory of
 *    PNG files. Nothing is installed, no driver is loaded and nothing outside the
 *    process is touched.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { CpuMode, InstructionDecoder, bufferReader } from './arch/decode.ts';
import { assemble } from './asm/index.ts';
import { formatRegisters } from './arch/registers.ts';
import { hexDump } from './boot/index.ts';
import { Machine } from './machine/machine.ts';
import { Kernel } from './kernel/kernel.ts';
import { createDesktopHost } from './host/server.ts';
import { parseKeyScript } from './kernel/desktop.ts';
import { encodePng } from '../tools/screenshot.ts';

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                             */
/* -------------------------------------------------------------------------- */

interface Args {
  readonly command: string;
  readonly positional: string[];
  readonly flags: ReadonlyMap<string, string>;
}

/**
 * Parse `argv` into a command, positional arguments and `--flag value` options.
 *
 * Hand-rolled because the tool has no dependencies and because the alternative -
 * a parsing library - would be the only one in a project whose whole point is
 * having none. `--flag=value` is accepted alongside `--flag value` because the
 * first form is what people paste.
 */
function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      if (equals >= 0) {
        flags.set(argument.slice(2, equals), argument.slice(equals + 1));
        continue;
      }
      const name = argument.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, 'true');
      }
      continue;
    }
    if (command === '') command = argument;
    else positional.push(argument);
  }
  return { command, positional, flags };
}

function flagNumber(args: Args, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} needs a number, got '${raw}'`);
  return value;
}

/**
 * Parse an address, accepting hex with or without the `0x`.
 *
 * `BigInt('7c00')` throws, and `--origin` is documented as hex, so taking it
 * literally would make the documented form the one that fails. Everything the
 * assembler and the machine use is an address, so every address flag goes through
 * here rather than each re-deciding whether its input is hex.
 */
function flagAddress(args: Args, name: string, fallback: bigint): bigint {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const text = raw.trim().toLowerCase();
  const digits = text.startsWith('0x') ? text.slice(2) : text;
  if (!/^[0-9a-f]+$/.test(digits)) {
    throw new Error(`--${name} needs a hexadecimal address, got '${raw}'`);
  }
  return BigInt(`0x${digits}`);
}

/* -------------------------------------------------------------------------- */
/* Output                                                                       */
/* -------------------------------------------------------------------------- */

function heading(text: string): void {
  process.stdout.write(`\n${text}\n${'-'.repeat(text.length)}\n`);
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                     */
/* -------------------------------------------------------------------------- */

function commandHelp(): number {
  process.stdout.write(`
VerixOS - an operating system you can run, look at and test without installing anything

  verix boot [options]          Run the boot sequence and print what it did
  verix gui [options]           Boot, then run the desktop and report frame costs
  verix run <file.asm> [opts]   Assemble a program, execute it, print the result
  verix screen                  Print the text-mode console
  verix info                    Describe the machine
  verix help                    This message

  Through npm, put '--' before the flags: 'npm start -- gui --frames 60'.
  npm claims '--frames' as its own configuration option otherwise.

boot options:
  --smoke           One line of output and an exit code, for CI

gui options:
  --frames <n>     Frames to render (default 120)
  --out <dir>      Directory for the PNGs (default: no files, report only)
  --every <n>      Write a PNG every n frames (default: 30)
  --scale <n>      Integer upscale factor for the PNGs (default:3)
  --keys <script>  Keystrokes, '/'-separated: Tab/Enter/Esc/f1/up/type:TEXT
  --boot-frame     Also write the text-mode boot screen as boot.png
  --stats          Print the frame-cost table
  --check          Exit non-zero unless every frame changed something

run options:
  --steps <n>      Instruction limit (default 100000)
  --mode <mode>    real16, protected32 or long64 (default real16)
  --origin <hex>   Load address (default 7c00)
  --trace          Print every instruction as it executes
  --bytes <n>      Bytes of the assembled image to dump

Examples:
  verix boot
  verix gui --frames 60 --out out --keys "Tab/type:ver/Enter"
  verix run examples/hello.asm --trace
`);
  return 0;
}

function commandBoot(args: Args): number {
  const kernel = new Kernel();
  const report = kernel.runBoot();

  // `--smoke` exists for CI, and it prints one line rather than a report because a
  // build log is not a place to read a boot log. It asserts the same things the
  // verbose form does and exits with the same status: the whole point is that the
  // automated check and the human-facing command cannot disagree about whether
  // the machine booted.
  if (args.flags.has('smoke')) {
    const frame = kernel.tick();
    const healthy = report.handedOff && frame.written > 0;
    process.stdout.write(
      `boot smoke: ${healthy ? 'ok' : 'FAILED'} - ${report.instructions} instructions, ` +
        `${report.log.length} console lines, first frame ${frame.written} pixels\n`,
    );
    return healthy ? 0 : 1;
  }

  heading('Boot');
  process.stdout.write(`handed off      ${report.handedOff}\n`);
  process.stdout.write(`stopped because ${report.outcome}\n`);
  process.stdout.write(`instructions    ${report.instructions}\n`);
  process.stdout.write(`timer ticks     ${report.ticks}\n`);

  heading('Console');
  for (const line of report.log) process.stdout.write(`  ${line}\n`);

  heading('Machine after boot');
  process.stdout.write(`${kernel.machine.describe()}\n`);

  heading('Desktop');
  const frame = kernel.tick();
  process.stdout.write(`first frame wrote ${frame.written} of ${frame.examined} pixels examined\n`);
  return report.handedOff ? 0 : 1;
}

function commandInfo(): number {
  const machine = new Machine({ mode: CpuMode.REAL16, ramBytes: 16 * 1024 * 1024 });
  process.stdout.write(`${machine.describe()}\n`);
  heading('Memory regions');
  for (const name of machine.regionNames()) process.stdout.write(`  ${name}\n`);
  heading('Port devices');
  for (const name of machine.io.deviceNames()) process.stdout.write(`  ${name}\n`);
  return 0;
}

function commandScreen(): number {
  const kernel = new Kernel();
  const report = kernel.runBoot();
  for (const line of kernel.machine.screenText()) process.stdout.write(`${line}\n`);
  return report.handedOff ? 0 : 1;
}

function commandGui(args: Args): number {
  const frames = Math.max(1, flagNumber(args, 'frames', 120));
  const every = Math.max(1, flagNumber(args, 'every', 30));
  const scale = Math.max(1, flagNumber(args, 'scale', 3));
  const out = args.flags.get('out');
  const writeBootFrame = args.flags.has('boot-frame');
  const keys = parseKeyScript(args.flags.get('keys') ?? '');
  const wantStats = args.flags.has('stats');
  const check = args.flags.has('check');

  const kernel = new Kernel();
  const report = kernel.runBoot();

  heading('Boot');
  process.stdout.write(`handed off      ${report.handedOff}\n`);
  for (const line of report.log) process.stdout.write(`  ${line}\n`);

  if (out !== undefined) mkdirSync(out, { recursive: true });

  if (writeBootFrame && out !== undefined) {
    // Rendered from the adapter in text mode, captured before the kernel switched
    // the display to graphics. It is a real capture of what the boot code printed,
    // not a reconstruction of the log from memory.
    const capture = kernel.bootScreen;
    if (capture === undefined) {
      process.stderr.write('verix: no boot screen was captured\n');
      return 1;
    }
    writePng(join(out, 'boot.png'), capture.pixels, capture.width, capture.height, scale);
    process.stdout.write(`wrote ${join(out, 'boot.png')}\n`);
  }

  // Keystrokes are delivered spread through the run rather than all at the end,
  // so a recording shows the desktop responding while it runs.
  const perKey = Math.max(1, Math.floor(frames / (keys.length + 1)));
  let nextKey = 0;

  const statistics: Array<{ frame: number; written: number; examined: number }> = [];
  let framesWithNoChange = 0;
  let totalWritten = 0;
  let totalExamined = 0;
  let wrote = 0;

  for (let i = 0; i < frames; i++) {
    if (nextKey < keys.length && i > 0 && i % perKey === 0) {
      kernel.press(keys[nextKey]!);
      nextKey++;
    }
    const stats = kernel.tick();
    totalWritten += stats.written;
    totalExamined += stats.examined;
    if (stats.written === 0) framesWithNoChange++;

    if (wantStats) statistics.push({ frame: i, ...stats });
    if (out !== undefined && (i + 1) % every === 0) {
      const name = join(out, `frame-${String(i + 1).padStart(4, '0')}.png`);
      writePng(name, kernel.pixels(), 320, 200, scale);
      wrote++;
    }
  }

  const lastName = join(out ?? '.', `frame-${String(frames).padStart(4, '0')}.png`);
  if (out !== undefined && frames % every !== 0) {
    writePng(lastName, kernel.pixels(), 320, 200, scale);
    wrote++;
  }

  heading('Desktop');
  process.stdout.write(`frames          ${frames}\n`);
  process.stdout.write(`keys sent       ${nextKey}\n`);
  process.stdout.write(`pixels written  ${totalWritten}\n`);
  process.stdout.write(`pixels examined ${totalExamined}\n`);
  process.stdout.write(
    `change ratio    ${totalExamined === 0 ? 'n/a' : `${((totalWritten / totalExamined) * 100).toFixed(2)}%`}\n`,
  );
  process.stdout.write(`idle frames     ${framesWithNoChange}\n`);
  if (wrote > 0) process.stdout.write(`images written  ${wrote}\n`);

  if (wantStats) {
    heading('Frame costs');
    process.stdout.write('  frame   written  examined\n');
    for (const entry of statistics.slice(0, 20)) {
      process.stdout.write(
        `  ${String(entry.frame).padStart(5)}  ${String(entry.written).padStart(7)}  ${String(entry.examined).padStart(8)}\n`,
      );
    }
    if (statistics.length > 20) process.stdout.write(`  ... and ${statistics.length - 20} more\n`);
  }

  // `--check` is the testable form of the whole thing: a desktop that stops
  // changing is not responsive, and a desktop whose frames change nothing at all
  // is not being drawn.
  if (check) {
    heading('Check');
    const problems: string[] = [];
    if (!report.handedOff) problems.push('stage 2 did not hand over');
    if (totalWritten === 0) problems.push('no frame changed a single pixel');
    if (framesWithNoChange === frames) problems.push('every frame was idle');
    if (problems.length === 0) {
      process.stdout.write(`pass: ${totalWritten} pixels changed across ${frames} frames\n`);
      return 0;
    }
    for (const problem of problems) process.stdout.write(`FAIL: ${problem}\n`);
    return 1;
  }
  return 0;
}

function commandRun(args: Args): number {
  const path = args.positional[0];
  if (path === undefined) {
    process.stderr.write('verix run needs a file: verix run <file.asm>\n');
    return 2;
  }
  const source = readFileSync(path, 'utf8');
  const steps = Math.max(1, flagNumber(args, 'steps', 100_000));
  const origin = flagAddress(args, 'origin', 0x7c00n);
  const modeName = (args.flags.get('mode') ?? 'real16').toLowerCase();
  const mode =
    modeName === 'long64' ? CpuMode.LONG64 : modeName === 'protected32' ? CpuMode.PROTECTED32 : CpuMode.REAL16;

  let image: { bytes: Uint8Array; size: number };
  try {
    image = assemble(source, { origin, filename: path });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const machine = new Machine({ mode, ramBytes: 16 * 1024 * 1024 });
  machine.resetToBootSector();
  machine.loadImage(origin, image.bytes);
  machine.cpu.regs.rip = origin;

  heading('Assembled');
  process.stdout.write(`${image.size} bytes at 0x${origin.toString(16)}\n`);
  const dumpBytes = flagNumber(args, 'bytes', 0);
  if (dumpBytes > 0) process.stdout.write(`${hexDump(image.bytes.subarray(0, dumpBytes))}\n`);

  heading('Execution');
  const trace = args.flags.has('trace');
  let executed = 0;
  const startedAt = process.hrtime.bigint();
  try {
    while (executed < steps && !machine.cpu.halted) {
      const address = machine.cpu.regs.rip;
      const instruction = machine.step();
      if (trace) process.stdout.write(`  0x${address.toString(16).padStart(5, '0')}  ${instruction.toString()}\n`);
      executed++;
    }
  } catch (error) {
    process.stdout.write(`  fault: ${(error as Error).message}\n`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  heading('Result');
  process.stdout.write(`stopped        ${machine.cpu.halted ? 'halted' : `after ${executed} instructions`}\n`);
  process.stdout.write(`rip            0x${machine.cpu.regs.rip.toString(16)}\n`);
  process.stdout.write(`elapsed        ${elapsedMs.toFixed(1)} ms (${Math.round(executed / Math.max(elapsedMs, 0.001))} ins/ms)\n`);
  process.stdout.write(`\n${formatRegisters(machine.cpu.regs, machine.cpu.flags)}\n`);

  const screen = machine.screenText();
  if (screen.some((line) => line.trim() !== '')) {
    heading('Console');
    for (const line of screen) process.stdout.write(`${line}\n`);
  }
  return machine.cpu.halted ? 0 : 1;
}

/**
 * `verix desktop` - a live, clickable window.
 *
 * This is the interactive one. It boots the machine, shows the boot console for a
 * moment, then serves the desktop to a browser over a local WebSocket and opens it.
 * Every click and keystroke in that window goes through the same emulator a guest
 * program sees: the mouse becomes PS/2 packets and IRQ12, the keyboard becomes
 * set 1 scan codes, and the shell hit-tests them.
 */
function commandDesktop(args: Args): Promise<number> {
  const fps = Math.max(1, flagNumber(args, 'fps', 30));
  const bootHoldMs = Math.max(0, flagNumber(args, 'boot-hold', 1800));
  const port = flagNumber(args, 'port', 0);
  const noBrowser = args.flags.has('no-open');

  const kernel = new Kernel();
  const report = kernel.runBoot();
  kernel.enableMouse();

  const host = createDesktopHost({ kernel, fps, bootHoldMs, port });
  host.showBootConsole();

  process.stdout.write(`
VerixOS desktop
===============
  boot    ${report.handedOff ? 'handed over' : 'FAILED'} in ${report.instructions} instructions
  machine ${report.instructions} instructions, ${kernel.machine.bus.ram.sizeBytes / (1024 * 1024)} MiB
  frame   ${320}x${200} at ${fps} fps

  Click a dock icon, drag a title bar, right-click for a menu.
  Ctrl+C here stops the machine; the browser window closes with it.

`);

  return new Promise<number>((resolve) => {
    const shutdown = (code: number): void => {
      void host.close().then(() => {
        process.stdout.write('\nVerixOS stopped.\n');
        resolve(code);
      });
    };

    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

    void host.listen().then(() => {
      process.stdout.write(`  open    ${host.url}\n\n`);
      if (!noBrowser) openBrowser(host.url);
    });
  });
}

/**
 * Open a URL in the user's browser.
 *
 * Best-effort by design: a machine with no browser, or a headless one, should still
 * be able to run the desktop and read the URL printed above. Failing to launch a
 * browser is therefore reported and ignored rather than fatal.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (error) {
    process.stdout.write(`  (could not open a browser: ${(error as Error).message})\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Images                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Write a PNG, optionally nearest-neighbour upscaled.
 *
 * Upscaling by an integer factor is the only scaling that keeps a 320x200 screen
 * legible without inventing pixels that were not there: anything fractional would
 * resample, and a screenshot that is not what the adapter produced is not a
 * screenshot.
 */
function writePng(
  path: string,
  pixels: Uint32Array,
  width: number,
  height: number,
  scale: number,
): void {
  if (scale <= 1) {
    writeFileSync(path, encodePng(pixels, width, height));
    return;
  }
  const outWidth = width * scale;
  const outHeight = height * scale;
  const scaled = new Uint32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const sourceRow = Math.floor(y / scale) * width;
    for (let x = 0; x < outWidth; x++) {
      scaled[y * outWidth + x] = pixels[sourceRow + Math.floor(x / scale)] ?? 0;
    }
  }
  writeFileSync(path, encodePng(scaled, outWidth, outHeight));
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run a command.
 *
 * Async because `desktop` only finishes when the machine is stopped, which happens
 * on a signal rather than at the end of a function. Every other command resolves
 * immediately, so awaiting the result uniformly costs nothing and avoids two
 * different error-handling shapes.
 */
async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case '':
      case 'help':
      case '--help':
        return commandHelp();
      case 'boot':
        return commandBoot(args);
      case 'gui':
      case 'desktop':
        return commandGui(args);
      case 'live':
      case 'window':
        return commandDesktop(args);
      case 'run':
        return commandRun(args);
      case 'screen':
        return commandScreen();
      case 'info':
        return commandInfo();
      case 'disasm': {
        // Disassembly is the decoder's own text, so what is printed here is
        // exactly what a debugger would show.
        const path = args.positional[0];
        if (path === undefined) {
          process.stderr.write('verix disasm needs a file and an address: verix disasm <file> <hex-address>\n');
          return 2;
        }
        const origin = BigInt(args.positional[1] ?? '0');
        const bytes = readFileSync(path);
        const decoder = new InstructionDecoder(bufferReader(bytes, origin), CpuMode.LONG64);
        let address = origin;
        while (address < origin + BigInt(bytes.length)) {
          const instruction = decoder.decode(address);
          const raw: number[] = [];
          for (let i = 0; i < instruction.length; i++) {
            raw.push(Number(bytes[Number(address - origin) + i] ?? 0));
          }
          process.stdout.write(
            `${raw.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(24)}  ${instruction.toString()}\n`,
          );
          address += BigInt(instruction.length);
        }
        return 0;
      }
      default:
        process.stderr.write(`unknown command '${args.command}'. Try 'verix help'.\n`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`verix: ${(error as Error).message}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));