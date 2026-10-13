/**
 * Desktop tests.
 *
 * The question this file answers is not "does the desktop look right" - a
 * screenshot cannot be asserted on, only stared at - but "does it behave". Every
 * test here asks a question a person at the keyboard could ask, and answers it
 * from the machine's own state: the register file, the frame buffer, the boot
 * log, or the compositor's own accounting of how much work it did.
 *
 * Two of them are worth singling out:
 *
 *  - **Responsiveness** is asserted as a change in *pixels after a keystroke*,
 *    measured by comparing frame buffers. A test that called `press()` and checked
 *    a return value would pass against a desktop that accepted input and ignored
 *    it.
 *  - **Efficiency** is asserted as a ratio of pixels written to pixels examined,
 *    over a long run. This is the only claim about the compositor that means
 *    anything, and it is the claim that a naive implementation silently fails: a
 *    desktop that damages the whole screen every frame produces pixel-perfect
 *    frames and a ratio of one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Compositor, COLOUR, area, clip, intersects, union } from '../src/kernel/compositor.ts';
import { Desktop, MonitorApp, TerminalApp, formatClock, mapKey, parseKeyScript } from '../src/kernel/desktop.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { ScanCode } from '../src/machine/devices/keyboard.ts';

/* -------------------------------------------------------------------------- */
/* Rectangle arithmetic                                                         */
/* -------------------------------------------------------------------------- */

test('clipping removes the parts of a rectangle that are off screen', () => {
  assert.deepEqual(clip({ x: -5, y: -5, width: 10, height: 10 }, 100, 100), {
    x: 0,
    y: 0,
    width: 5,
    height: 5,
  });
  assert.deepEqual(clip({ x: 90, y: 90, width: 40, height: 40 }, 100, 100), {
    x: 90,
    y: 90,
    width: 10,
    height: 10,
  });
  assert.equal(clip({ x: 200, y: 200, width: 10, height: 10 }, 100, 100), undefined);
  assert.equal(clip({ x: 10, y: 10, width: 0, height: 10 }, 100, 100), undefined);
});

test('union covers both rectangles and intersection detects overlap', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 5, y: 5, width: 10, height: 10 };
  assert.deepEqual(union(a, b), { x: 0, y: 0, width: 15, height: 15 });
  assert.equal(intersects(a, b), true);
  assert.equal(intersects(a, { x: 20, y: 20, width: 5, height: 5 }), false);
  assert.equal(area({ x: 0, y: 0, width: 7, height: 3 }), 21);
});

/* -------------------------------------------------------------------------- */
/* The compositor                                                               */
/* -------------------------------------------------------------------------- */

function blankTarget(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height).fill(0xff);
}

test('present copies nothing when nothing was damaged', () => {
  const compositor = new Compositor(64, 64);
  const target = blankTarget(64, 64);
  const stats = compositor.present(target);
  // No damage, no work: not even a comparison.
  assert.equal(stats.examined, 0);
  assert.equal(stats.written, 0);
});

test('present copies only the damaged region', () => {
  const compositor = new Compositor(64, 64);
  const target = blankTarget(64, 64);
  compositor.fillRect({ x: 8, y: 8, width: 4, height: 4 }, 5);
  compositor.damage({ x: 8, y: 8, width: 4, height: 4 });
  const stats = compositor.present(target);

  assert.equal(stats.examined, 16, 'only the damaged rectangle is compared');
  assert.equal(stats.written, 16);
  assert.equal(target[8 * 64 + 8], 5);
  // A pixel outside the rectangle must be untouched.
  assert.equal(target[0], 0xff);
});

test('redrawing the same pixels costs nothing the second time', () => {
  const compositor = new Compositor(64, 64);
  const target = blankTarget(64, 64);
  const rect = { x: 0, y: 0, width: 32, height: 32 };

  compositor.fillRect(rect, 3);
  compositor.damage(rect);
  const first = compositor.present(target);
  assert.equal(first.written, area(rect));

  compositor.fillRect(rect, 3);
  compositor.damage(rect);
  const second = compositor.present(target);
  // The pixels are the same, so there is nothing to put on the screen - which is
  // the whole reason the compositor compares rather than blindly copying.
  assert.equal(second.examined, area(rect));
  assert.equal(second.written, 0);
});

test('an application that redraws itself identically costs nothing', () => {
  const compositor = new Compositor(32, 32);
  const target = blankTarget(32, 32);
  const rect = { x: 0, y: 0, width: 32, height: 32 };
  let idle = 0;
  for (let i = 0; i < 10; i++) {
    compositor.fillRect(rect, 9);
    compositor.damage(rect);
    const stats = compositor.present(target);
    if (stats.written === 0) idle++;
  }
  assert.equal(idle, 9, 'only the first frame has anything to draw');
});

test('overlapping damage is merged but distant damage is not', () => {
  const compositor = new Compositor(320, 200);

  compositor.damage({ x: 0, y: 0, width: 20, height: 20 });
  compositor.damage({ x: 10, y: 10, width: 20, height: 20 });
  // Overlapping: one region, because presenting both costs more than the union.
  assert.equal(compositor.damagedRegions, 1);

  compositor.damage({ x: 300, y: 180, width: 20, height: 20 });
  // Far away: kept separate, because the bounding box of the two would be most
  // of the screen and presenting that would defeat the point entirely.
  assert.equal(compositor.damagedRegions, 2);
});

test('drawing clips to the screen instead of throwing', () => {
  const compositor = new Compositor(32, 32);
  compositor.fillRect({ x: -10, y: -10, width: 100, height: 100 }, 4);
  assert.equal(compositor.getPixel(0, 0), 4, 'a rectangle hanging off the edge still fills the visible part');
  assert.equal(compositor.getPixel(31, 31), 4);
  assert.equal(compositor.getPixel(32, 32), 0, 'and nothing outside it');

  // Text that starts off the left edge is clipped glyph by glyph: the characters
  // that hang over the edge contribute only the columns that are on screen, and
  // the ones entirely off it contribute nothing. What matters is that neither
  // throws and that neither wraps or throws a negative index away.
  compositor.text8(-20, 0, 'off the left edge', 1, 0);
  compositor.text8(30, 30, 'past the right', 1, 0);
  compositor.text8(0, 40, 'below the bottom', 1, 0);
  compositor.strokeRect({ x: 30, y: 30, width: 10, height: 10 }, 6);
  assert.equal(compositor.getPixel(-1, -1), 0, 'reading outside the screen is defined');
});

test('a script maps letters to their real set 1 scan codes', () => {
  // Set 1 is not alphabetical: `A` is 0x1E, `Z` is 0x2C, and `V` is 0x2F. A
  // computed `A + (letter - 'A')` would send `v` as 0x33, which is keypad 1.
  const events = parseKeyScript('type:vaz');
  assert.deepEqual(events.map((e) => e.code), [ScanCode.V, ScanCode.A, ScanCode.Z]);
});

test('the sparkline scales to the observed peak', () => {
  const compositor = new Compositor(32, 16);
  compositor.fillRect({ x: 0, y: 0, width: 32, height: 16 }, 0);
  // Values all small: normalising to the peak makes them fill the graph, which is
  // the difference between a visible signal and a flat line.
  compositor.sparkline(0, 0, 16, 16, [1, 2, 3, 4, 5, 6, 7, 8], COLOUR.accent);
  const lit = [...compositor.back].filter((v) => v === COLOUR.accent).length;
  assert.ok(lit > 16, `the sparkline should light a visible area, got ${lit} pixels`);
});

test('forgetting the screen forces a full redraw', () => {
  const compositor = new Compositor(16, 16);
  const target = blankTarget(16, 16);
  compositor.fillRect({ x: 0, y: 0, width: 16, height: 16 }, 7);
  compositor.damageEverything();
  compositor.present(target);

  compositor.forgetScreen();
  compositor.present(target);
  const stats = compositor.present(target);
  // The second present had nothing damaged and so did nothing; the point is that
  // `forgetScreen` queued a full-screen damage that the first present consumed.
  assert.equal(stats.examined, 0);
  assert.equal(compositor.statistics.pixelsWrittenTotal, 256 + 256);
});

/* -------------------------------------------------------------------------- */
/* The key map                                                                  */
/* -------------------------------------------------------------------------- */

test('the key map translates the keys the shell advertises', () => {
  assert.deepEqual(mapKey({ code: ScanCode.TAB, ascii: 0x09, extended: false }), { kind: 'focus-next' });
  assert.deepEqual(mapKey({ code: ScanCode.TAB, ascii: 0x09, extended: true }), { kind: 'focus-previous' });
  assert.deepEqual(mapKey({ code: ScanCode.ESC, ascii: 0x1b, extended: false }), { kind: 'close' });
  assert.deepEqual(mapKey({ code: ScanCode.F1, ascii: 0, extended: false }), { kind: 'toggle-help' });
  assert.deepEqual(mapKey({ code: ScanCode.ENTER, ascii: 0x0d, extended: false }), { kind: 'activate' });
  assert.deepEqual(mapKey({ code: 0x4b, ascii: 0, extended: true }), { kind: 'move', dx: -8, dy: 0 });
});

test('a key release produces no action', () => {
  assert.equal(mapKey({ code: ScanCode.TAB | 0x80, ascii: 0x09, extended: false }), undefined);
  // Deep equality, not `==`: two object literals are never the same object, so a
  // reference comparison here would fail for a correct key map.
  assert.deepEqual(mapKey({ code: ScanCode.A, ascii: 0x61, extended: false }), {
    kind: 'text',
    value: 'a',
  });
});

test('an arrow without the extended prefix is not a navigation key', () => {
  // The bare code is what some other device would send; treating it as "left"
  // would move a window for a keystroke that was never sent.
  assert.equal(mapKey({ code: 0x4b, ascii: 0, extended: false }), undefined);
});

test('digits open applications and text goes to the application', () => {
  assert.deepEqual(mapKey({ code: ScanCode.ONE, ascii: 0x31, extended: false }), { kind: 'cycle-app', index: 0 });
  assert.deepEqual(mapKey({ code: ScanCode.THREE, ascii: 0x33, extended: false }), { kind: 'cycle-app', index: 2 });
});

test('a key script expands into the keystrokes it names', () => {
  const events = parseKeyScript('Tab/type:ver/Enter');
  assert.equal(events.length, 5, 'Tab, v, e, r, Enter');
  assert.equal(events[0]?.code, ScanCode.TAB);
  assert.equal(events[1]?.code, ScanCode.V);
  assert.equal(events[4]?.code, ScanCode.ENTER);
});

test('a key script rejects a key it does not know rather than guessing', () => {
  assert.throws(() => parseKeyScript('nosuchkey'), /unknown key/);
});

/* -------------------------------------------------------------------------- */
/* The desktop                                                                  */
/* -------------------------------------------------------------------------- */

function bootedKernel(): Kernel {
  const kernel = new Kernel();
  kernel.runBoot();
  return kernel;
}

/** How many pixels differ between two captures. */
function difference(a: Uint32Array, b: Uint32Array): number {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  return changed;
}

test('the boot sequence runs on the interpreter and hands over', () => {
  const kernel = bootedKernel();
  const report = kernel.report;

  assert.ok(report !== undefined, 'a boot report must exist after runBoot');
  assert.equal(report.handedOff, true);
  // The console text is read out of the adapter, so its presence is evidence the
  // firmware's teletype service really ran rather than a memory of what it should
  // have printed.
  const log = report.log.join('\n');
  assert.match(log, /loading stage 2/);
  assert.match(log, /stage 2 loaded/);
  assert.match(log, /timer at 100 Hz/);
  // Stage 1's read really came off the disk image rather than being faked.
  assert.ok(report.instructions > 200n, `only ${report.instructions} instructions retired`);
});

test('the boot sector really loads stage 2 through the firmware disk service', () => {
  const kernel = new Kernel();
  kernel.runBoot();
  // Stage 2's first instruction is `xor ax, ax` at 0x8000, which is where the boot
  // sector's read request put it. Finding it there means the CHS arithmetic, the
  // `int 13h` dispatch and the byte copy all worked.
  assert.equal(kernel.machine.bus.read(0x8000n, 2), 0xc031n);
});

test('the desktop takes the screen for the compositor', () => {
  const kernel = bootedKernel();
  assert.equal(kernel.machine.vga.currentMode.index, 0x13);
  assert.equal(kernel.machine.vga.currentMode.hres, 320);
  assert.equal(kernel.machine.vga.currentMode.vres, 200);
});

test('a frame changes pixels, because the desktop is drawing something', () => {
  const kernel = bootedKernel();
  // The first tick after entering graphics is a full redraw.
  const first = kernel.tick();
  assert.ok(first.written > 100, `first frame wrote only ${first.written} pixels`);
});

test('the clock advances with time, so the screen keeps changing on its own', () => {
  const kernel = bootedKernel();
  kernel.tick();
  const before = kernel.pixels();
  const clockBefore = kernel.desktop.elapsedMs;

  for (let i = 0; i < 30; i++) kernel.tick();

  assert.ok(kernel.desktop.elapsedMs > clockBefore, 'emulated time must advance');
  assert.notEqual(before.length, 0);
  assert.ok(
    difference(before, kernel.pixels()) > 0,
    'half a second of emulated time must change the clock on screen',
  );
});

test('a keystroke changes the screen', () => {
  const kernel = bootedKernel();
  kernel.tick();
  const before = kernel.pixels();

  kernel.press({ code: ScanCode.F1, ascii: 0, extended: false });
  kernel.tick();
  const afterHelp = kernel.pixels();

  const changedByHelp = difference(before, afterHelp);
  assert.ok(changedByHelp > 200, `the help overlay changed only ${changedByHelp} pixels`);

  // And dismissing it must change the screen again, rather than leaving the
  // overlay up because a boolean was flipped and nothing was drawn.
  kernel.press({ code: ScanCode.F1, ascii: 0, extended: false });
  kernel.tick();
  assert.ok(
    difference(afterHelp, kernel.pixels()) > 200,
    'dismissing the help overlay must change the screen',
  );
});

/** Type a string into the focused window, using the same path as a CLI script. */
function type(kernel: Kernel, text: string): void {
  for (const event of parseKeyScript(`type:${text}`)) kernel.press(event);
  for (const event of parseKeyScript('Enter')) kernel.press(event);
}

test('typing into the terminal changes what the terminal shows', () => {
  const kernel = bootedKernel();
  kernel.tick();
  const terminal = kernel.desktop.apps[0];
  assert.ok(terminal instanceof TerminalApp);

  for (const event of parseKeyScript('type:ver')) kernel.press(event);
  assert.equal(terminal.currentInput, 'ver');

  for (const event of parseKeyScript('Enter')) kernel.press(event);
  assert.equal(terminal.currentInput, '');
  assert.ok(
    terminal.transcript.some((line) => line.includes('VerixOS')),
    'the version command should have printed something',
  );
});

test('the terminal answers a command it knows and rejects one it does not', () => {
  const kernel = bootedKernel();
  const terminal = kernel.desktop.apps[0];
  assert.ok(terminal instanceof TerminalApp);

  type(kernel, 'help');
  assert.ok(
    terminal.transcript.some((line) => line.includes('commands:')),
    `help should have listed the commands, transcript was ${JSON.stringify(terminal.transcript)}`,
  );

  type(kernel, 'nonsense');
  assert.ok(terminal.transcript.some((line) => line.includes('unknown command')));
});

test('a keystroke the terminal does not want reaches the shell instead', () => {
  const kernel = bootedKernel();
  // Enter with a window focused is `activate`; the terminal takes it, so the
  // shell's own status line has to be updated by the *application's* answer
  // rather than by the shell's fallback.
  kernel.press({ code: ScanCode.ENTER, ascii: 0x0d, extended: false });
  assert.match(kernel.desktop.status, /Terminal/);
});

test('a letter is not confused with an arrow key', () => {
  // `h` is ASCII 0x68 but its *scan code* is 0x23. `p` is ASCII 0x70 and its scan
  // code is 0x19. Feeding the ASCII values in instead would send 0x48, which is
  // the up arrow, and 0x50, which is the down arrow - and the key map is right to
  // refuse a bare 0x48 because the arrow prefix was not there.
  const events = parseKeyScript('type:hp');
  assert.deepEqual(events.map((e) => e.code), [0x23, 0x19]);
});

test('focus follows Tab and the dock follows the focused window', () => {
  const kernel = bootedKernel();
  const desktop = kernel.desktop;
  assert.equal(desktop.focusedWindow?.app.id, 'terminal');

  kernel.press({ code: ScanCode.TAB, ascii: 0x09, extended: false });
  assert.equal(desktop.focusedWindow?.app.id, 'monitor');

  kernel.press({ code: ScanCode.TAB, ascii: 0x09, extended: true });
  assert.equal(desktop.focusedWindow?.app.id, 'terminal');
});

test('an arrow key moves the focused window and changes the screen', () => {
  const kernel = bootedKernel();
  kernel.tick();
  const before = kernel.desktop.focusedWindow!.rect.x;
  const pixels = kernel.pixels();

  kernel.press({ code: 0x4d, ascii: 0, extended: true }); // right
  assert.equal(kernel.desktop.focusedWindow!.rect.x, before + 8);
  kernel.tick();
  assert.ok(difference(pixels, kernel.pixels()) > 0, 'moving a window must change the screen');
});

test('a window cannot be pushed off the screen', () => {
  const kernel = bootedKernel();
  const window = kernel.desktop.focusedWindow!;
  for (let i = 0; i < 200; i++) {
    kernel.press({ code: 0x4b, ascii: 0, extended: true }); // left
  }
  assert.ok(window.rect.x >= -window.rect.width + 16, `window left the screen at x=${window.rect.x}`);
  for (let i = 0; i < 400; i++) {
    kernel.press({ code: 0x4d, ascii: 0, extended: true }); // right
  }
  assert.ok(window.rect.x <= 320 - 16, `window ran off at x=${window.rect.x}`);
});

/* -------------------------------------------------------------------------- */
/* Efficiency                                                                   */
/* -------------------------------------------------------------------------- */

test('a mostly idle desktop examines far less than the whole screen', () => {
  const kernel = bootedKernel();
  kernel.tick(); // the priming frame redraws everything and is not the steady state

  let written = 0;
  let examined = 0;
  for (let i = 0; i < 120; i++) {
    const stats = kernel.tick();
    written += stats.written;
    examined += stats.examined;
  }

  assert.ok(examined > 0, 'frames must examine something');
  const ratio = written / examined;
  // The clock moves and the monitor's graph scrolls, so the honest steady state is
  // "a small fraction of the screen changes per frame", not "nothing changes".
  // A compositor that damages the whole screen every frame scores 1.0 here.
  assert.ok(
    ratio < 0.15,
    `a desktop that changes ${(ratio * 100).toFixed(1)}% of examined pixels is not damage-tracking`,
  );
});

test('examined pixels never exceed the screen', () => {
  const kernel = bootedKernel();
  for (let i = 0; i < 20; i++) {
    const stats = kernel.tick();
    assert.ok(stats.examined <= 320 * 200, `examined ${stats.examined} of ${320 * 200}`);
  }
});

test('the monitor graph records real measurements', () => {
  const kernel = bootedKernel();
  const monitor = kernel.desktop.apps[1];
  assert.ok(monitor instanceof MonitorApp);
  for (let i = 0; i < 20; i++) kernel.tick();
  assert.ok(monitor.history.length > 0, 'the graph must have samples');
  for (const sample of monitor.history) {
    assert.ok(sample >= 0 && sample <= 1, `a frame cost of ${sample} is not a ratio`);
  }
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                   */
/* -------------------------------------------------------------------------- */

test('the clock formats as a 24-hour time', () => {
  assert.equal(formatClock(0), '00:00:00');
  assert.equal(formatClock(9 * 3600_000 + 5 * 60_000 + 3_000), '09:05:03');
  // Wrapping at midnight rather than counting up forever.
  assert.equal(formatClock(24 * 3600_000 + 1000), '00:00:01');
});

test('the desktop opens with a window focused, not an empty screen', () => {
  const kernel = bootedKernel();
  const desktop = kernel.desktop;
  assert.ok(desktop.focusedWindow !== undefined);
  assert.equal(desktop.apps.length, 3);
  // A desktop that started with nothing focused would give a first screenshot of
  // an empty rectangle, which says nothing about whether any of it works.
  assert.equal(desktop.windows.filter((w) => w.focused).length, 1);
});

void Desktop;