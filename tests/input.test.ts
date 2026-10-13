/**
 * Direct manipulation: what the pointer does to the desktop.
 *
 * These assert on positions, focus and the *pixels the compositor actually
 * touched*, never on "no exception was thrown". A window manager whose drag
 * handler silently fails to move anything is indistinguishable from a working one
 * to every test that does not look, and the symptom - a desktop that looks frozen
 * - is exactly what a person would report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel } from '../src/kernel/kernel.ts';
import { LAYOUT } from '../src/kernel/desktop.ts';

function booted(): Kernel {
  const kernel = new Kernel();
  kernel.runBoot();
  kernel.enableMouse();
  return kernel;
}

/**
 * Move the pointer onto a window's title bar.
 *
 * Uses the window's own `titleBar` rather than a hard-coded offset from its
 * rectangle. The title bar sits *above* the client area - it is part of the frame,
 * not part of the content - so an offset measured from the wrong edge lands in the
 * application's own pixels, which is where a test that looks plausible quietly
 * stops testing what it says it tests.
 */
function toTitleBar(kernel: Kernel, index = 0): void {
  const point = kernel.desktop.windows[index]!.titleBarPoint(8, 5);
  kernel.movePointer(point.x, point.y, 1);
}

/** A point inside a window's client area. */
function inBody(kernel: Kernel, index: number, dx: number, dy: number): { x: number; y: number } {
  return kernel.desktop.windows[index]!.titleBarPoint(dx, LAYOUT.windowTitleHeight + dy);
}

/**
 * Move the terminal out of the way of the other two windows.
 *
 * The desktop is laid out with the windows deliberately overlapping, so that
 * clicking is genuinely tested against a stack. But it means the two windows
 * behind it have no reachable pixel, and a test that wants to click one of them has
 * to separate them first - otherwise it clicks the terminal, asserts something
 * about the monitor, and passes for the wrong reason.
 */
function spreadOut(kernel: Kernel): void {
  const terminal = kernel.desktop.windows[0]!;
  terminal.moveTo({ x: 30, y: 128, width: 160, height: 50 });
}

function press(kernel: Kernel, button: number, nowMs: number): void {
  kernel.pointerButton(button, true, nowMs);
  kernel.pointerButton(button, false, nowMs);
}

function focused(kernel: Kernel): string | undefined {
  return kernel.desktop.focusedWindow?.app.id;
}

/**
 * Read the open menu through a call rather than a property.
 *
 * TypeScript narrows a property after an assertion that it is `undefined`, and then
 * rejects the code that waits for it to become something - which would make the
 * polling loop the type error and report it as such rather than as the real failure.
 */
function currentMenu(kernel: Kernel): { x: number; y: number; items: { label: string }[] } | undefined {
  return kernel.desktop.input.openMenu;
}

/**
 * A point on the work area that no window covers.
 *
 * Found by asking the desktop rather than by picking a corner, because the windows
 * are laid out to overlap and a hand-picked "obviously empty" point is empty only
 * until someone resizes one.
 */
function emptySpot(kernel: Kernel): { x: number; y: number } | undefined {
  for (let y = LAYOUT.topBarHeight + 2; y < LAYOUT.height - LAYOUT.statusBarHeight - 2; y += 3) {
    for (let x = LAYOUT.dockWidth + 2; x < LAYOUT.width - 2; x += 3) {
      if (kernel.desktop.input.hitTest(x, y).kind === 'desktop') return { x, y };
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Hit testing                                                                 */
/* -------------------------------------------------------------------------- */

test('the pointer reports what is under it', () => {
  const kernel = booted();
  const input = kernel.desktop.input;

  const tile = kernel.desktop.dockTiles()[1]!;
  assert.deepEqual(input.hitTest(tile.x + 2, tile.y + 2), { kind: 'dock', index: 1 });

  assert.deepEqual(input.hitTest(4, 2), { kind: 'start-button', index: 0 }, 'the logo in the top bar');
  assert.deepEqual(input.hitTest(200, 2), { kind: 'top-bar' }, 'the rest of the top bar');
  assert.deepEqual(input.hitTest(4, LAYOUT.height - 2), { kind: 'status-bar' });

  const window = kernel.desktop.windows[0]!;
  const onTitle = window.titleBarPoint(8, 5);
  assert.deepEqual(input.hitTest(onTitle.x, onTitle.y), { kind: 'title-bar', window });

  const inBody = window.titleBarPoint(20, LAYOUT.windowTitleHeight + 20);
  assert.deepEqual(input.hitTest(inBody.x, inBody.y), { kind: 'window', window });
});

test('an empty part of the desktop is reported as the desktop', () => {
  const kernel = booted();
  const spot = emptySpot(kernel);
  assert.ok(spot !== undefined, 'the windows cover the entire work area');
  assert.equal(kernel.desktop.input.hitTest(spot.x, spot.y).kind, 'desktop');
});

test('the pointer is clamped to the screen', () => {
  const kernel = booted();
  // A pointer dragged past the edge of the browser window must not report a
  // position outside the screen, or a window can be dragged off it and lost.
  kernel.movePointer(-500, -500, 1);
  assert.deepEqual({ x: kernel.desktop.input.pointer.x, y: kernel.desktop.input.pointer.y }, { x: 0, y: 0 });

  kernel.movePointer(99_999, 99_999, 1);
  assert.deepEqual(
    { x: kernel.desktop.input.pointer.x, y: kernel.desktop.input.pointer.y },
    { x: LAYOUT.width - 1, y: LAYOUT.height - 1 },
  );
});

test('the pointer is scaled into desktop pixels, not host pixels', () => {
  const kernel = booted();
  // At 3x, a pointer 300 host pixels right of the canvas is 100 desktop pixels in.
  kernel.movePointer(300, 150, 3);
  assert.deepEqual({ x: kernel.desktop.input.pointer.x, y: kernel.desktop.input.pointer.y }, { x: 100, y: 50 });
});

/* -------------------------------------------------------------------------- */
/* Clicking                                                                    */
/* -------------------------------------------------------------------------- */

test('clicking a dock icon gives that window the keyboard', () => {
  const kernel = booted();
  assert.equal(focused(kernel), 'terminal');

  const tile = kernel.desktop.dockTiles()[1]!;
  kernel.movePointer(tile.x + 4, tile.y + 4, 1);
  press(kernel, 0, 1000);

  assert.equal(focused(kernel), 'monitor', 'the clicked tile is focused');
});

test('clicking a window focuses it, whatever is underneath', () => {
  const kernel = booted();
  const monitor = kernel.desktop.windows[1]!;
  spreadOut(kernel);

  const point = inBody(kernel, 1, 20, 20);
  assert.equal(kernel.desktop.input.hitTest(point.x, point.y).kind, 'window', 'the monitor is reachable');

  kernel.movePointer(point.x, point.y, 1);
  press(kernel, 0, 1000);
  assert.equal(focused(kernel), monitor.app.id);
});

test('clicking empty desktop unfocuses everything', () => {
  const kernel = booted();
  const spot = emptySpot(kernel);
  assert.ok(spot !== undefined);
  kernel.movePointer(spot.x, spot.y, 1);
  press(kernel, 0, 1000);
  assert.equal(focused(kernel), undefined, 'no window has the keyboard');
});

test('the topmost window is the one a click reaches', () => {
  const kernel = booted();
  const top = kernel.desktop.windows[0]!;
  const lower = kernel.desktop.windows[1]!;

  // Put them on top of each other, with the terminal in front.
  top.moveTo(lower.rect);
  top.z = 99;
  lower.z = 1;

  const point = lower.titleBarPoint(20, LAYOUT.windowTitleHeight + 20);
  const hit = kernel.desktop.input.hitTest(point.x, point.y);
  assert.equal(hit.kind === 'window' || hit.kind === 'title-bar' ? hit.window : undefined, top);

  kernel.movePointer(point.x, point.y, 1);
  press(kernel, 0, 1000);
  assert.equal(focused(kernel), 'terminal', 'the front window, not the one behind it');
});

/* -------------------------------------------------------------------------- */
/* Dragging                                                                    */
/* -------------------------------------------------------------------------- */

test('dragging a title bar moves the window by exactly the pointer', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  const before = { ...window.rect };
  const grab = window.titleBarPoint(8, 5);

  kernel.movePointer(grab.x, grab.y, 1);
  kernel.pointerButton(0, true, 1000);
  kernel.movePointer(grab.x + 30, grab.y + 20, 1);
  kernel.pointerButton(0, false, 1200);

  assert.deepEqual(
    { x: window.rect.x, y: window.rect.y },
    { x: before.x + 30, y: before.y + 20 },
    'the window follows the pointer by the same delta',
  );
});

test('the grab point is remembered, so the window does not jump to the cursor', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  window.moveTo({ x: 100, y: 60, width: window.rect.width, height: window.rect.height });

  // Press near the right-hand end of the title bar, then move a few pixels. The
  // window is moved left first because at its starting place the right end of its
  // title bar is off the screen, the pointer is clamped, and the drag measures a
  // zero-length move that looks like "the window does not move".
  window.moveTo({ x: 30, y: 60, width: window.rect.width, height: window.rect.height });

  const grab = window.titleBarPoint(window.titleBar.width - 4, 6);
  assert.ok(grab.x < LAYOUT.width, 'the grab point is on the screen');
  kernel.movePointer(grab.x, grab.y, 1);
  kernel.pointerButton(0, true, 1000);
  kernel.movePointer(grab.x + 5, grab.y + 5, 1);

  assert.deepEqual(
    { x: window.rect.x, y: window.rect.y },
    { x: 30 + 5, y: 60 + 5 },
    'the point under the pointer is the one that stays put',
  );
  kernel.pointerButton(0, false, 1100);
});

test('a drag stops when the button is released', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  const grab = window.titleBarPoint(8, 5);
  kernel.movePointer(grab.x, grab.y, 1);
  kernel.pointerButton(0, true, 1000);
  kernel.movePointer(grab.x + 52, grab.y + 35, 1);
  const moved = { ...window.rect };

  kernel.pointerButton(0, false, 1100);
  kernel.movePointer(grab.x + 200, grab.y + 120, 1);

  assert.deepEqual(window.rect, moved, 'the window stays where it was dropped');
});

test('a window cannot be dragged off the top bar or entirely off the screen', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  const grab = window.titleBarPoint(8, 5);
  kernel.movePointer(grab.x, grab.y, 1);
  kernel.pointerButton(0, true, 1000);
  kernel.movePointer(0, 0, 1);
  kernel.pointerButton(0, false, 1100);

  assert.ok(window.rect.y >= LAYOUT.topBarHeight, `y ${window.rect.y} is behind the top bar`);
  assert.ok(window.rect.x < LAYOUT.width, 'some of the window is still reachable');
  assert.ok(window.rect.x + window.rect.width > 0, 'and it has not been pushed off the left');
});

test('dragging repaints where the window was, not only where it is', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  kernel.tick();

  const before = kernel.pixels();
  const grab = window.titleBarPoint(8, 5);
  kernel.movePointer(grab.x, grab.y, 1);
  kernel.pointerButton(0, true, 1000);
  kernel.movePointer(grab.x + 40, grab.y + 30, 1);
  const stats = kernel.tick();
  kernel.pointerButton(0, false, 1100);

  assert.ok(stats.written > 0, 'the frame did nothing at all');
  assert.notDeepEqual(kernel.pixels(), before, 'the screen did not change');
});

/* -------------------------------------------------------------------------- */
/* Double click and maximise                                                   */
/* -------------------------------------------------------------------------- */

test('a double click on a title bar maximises, and a second one restores', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  const original = { ...window.rect };

  toTitleBar(kernel);
  press(kernel, 0, 1000);
  press(kernel, 0, 1150);

  assert.equal(window.maximised, true);
  assert.ok(window.rect.width > original.width, 'it is wider than it was');
  assert.ok(window.rect.x >= LAYOUT.dockWidth, 'and clear of the dock');

  // The pointer is put back on the title bar before the second pair of clicks.
  // Maximising moved the window, so a pointer left where it was is now over the
  // desktop - and a second click there is a click on the background, not a second
  // click on the title bar. Real double-clicking means following the window.
  toTitleBar(kernel);
  press(kernel, 0, 2000);
  press(kernel, 0, 2150);

  assert.equal(window.maximised, false);
  assert.deepEqual(window.rect, original, 'restored to where it was, exactly');
});

test('two slow clicks are not a double click', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  const original = { ...window.rect };

  toTitleBar(kernel);
  press(kernel, 0, 1000);
  press(kernel, 0, 1900);

  assert.equal(window.maximised, false, 'a deliberate second click is just a second click');
  assert.deepEqual(window.rect, original);
});

/* -------------------------------------------------------------------------- */
/* Menus                                                                       */
/* -------------------------------------------------------------------------- */

test('right-clicking a window opens a menu for that window', () => {
  const kernel = booted();
  kernel.desktop.raiseWindow(kernel.desktop.windows[1]!);
  const point = inBody(kernel, 1, 20, 20);
  kernel.movePointer(point.x, point.y, 1);
  press(kernel, 2, 1000);

  const menu = kernel.desktop.input.openMenu;
  assert.ok(menu !== undefined, 'no menu opened');
  assert.deepEqual(
    menu.items.map((item) => item.label),
    ['Bring to front', 'Maximise', 'Close'],
  );
});

test('choosing a menu item runs it and closes the menu', () => {
  const kernel = booted();
  const monitor = kernel.desktop.windows[1]!;
  const terminal = kernel.desktop.windows[0]!;
  spreadOut(kernel);

  const point = inBody(kernel, 1, 20, 20);
  kernel.movePointer(point.x, point.y, 1);
  press(kernel, 2, 1000);
  assert.equal(
    kernel.desktop.input.hitTest(point.x, point.y).kind,
    'window',
    'the monitor is where the menu came from',
  );

  // Put the terminal back in front by hand, so "Bring to front" has work to do.
  terminal.z = monitor.z + 5;

  const menu = kernel.desktop.input.openMenu;
  assert.ok(menu !== undefined);
  // Click the first row, which is "Bring to front".
  kernel.movePointer(menu.x + 20, menu.y + 2 + 4, 1);
  press(kernel, 0, 1100);

  assert.equal(kernel.desktop.input.openMenu, undefined, 'the menu closed');
  assert.ok(
    monitor.z > terminal.z,
    `z stayed at ${monitor.z}, and the window in front is at ${terminal.z}`,
  );
});

test('closing a window gives its pixels back to the desktop', () => {
  const kernel = booted();
  const count = kernel.desktop.windows.length;
  const window = kernel.desktop.windows[1]!;
  kernel.tick();
  const before = kernel.pixels();

  kernel.desktop.closeWindow(window);

  assert.equal(kernel.desktop.windows.length, count - 1, 'one window fewer');
  const stats = kernel.tick();
  assert.ok(stats.written > 0, 'the area it occupied must be repainted');
  assert.notDeepEqual(kernel.pixels(), before);
});

test('the start menu lists the installed applications', () => {
  const kernel = booted();
  kernel.movePointer(4, 2, 1);
  press(kernel, 0, 1000);

  const menu = kernel.desktop.input.openMenu;
  assert.ok(menu !== undefined);
  assert.deepEqual(menu.items.map((item) => item.label), kernel.desktop.apps.map((app) => app.title));
});

/* -------------------------------------------------------------------------- */
/* Focus, raising and the pointer's own pixels                                */
/* -------------------------------------------------------------------------- */

test('raising a window repaints the title bar it took over', () => {
  const kernel = booted();
  const back = kernel.desktop.windows[1]!;
  const front = kernel.desktop.windows[0]!;
  spreadOut(kernel);
  // The clicked window starts *behind*. Raising something already at the front is
  // correctly a no-op, so a test that leaves it in front would see no change and
  // blame the wrong thing.
  front.z = 50;
  back.z = 1;

  const point = back.titleBarPoint(8, 5);
  assert.equal(kernel.desktop.input.hitTest(point.x, point.y).kind, 'title-bar');

  kernel.movePointer(point.x, point.y, 1);
  press(kernel, 0, 1000);

  assert.ok(back.z > front.z, `z is ${back.z}, and the window in front is at ${front.z}`);
  const stats = kernel.tick();
  assert.ok(stats.written > 0, 'two title bars changed colour, so something was drawn');
});

/**
 * A pixel on the bare desktop that does not change from one frame to the next.
 *
 * The desktop animates: the monitor's graph scrolls and the terminal's caret
 * blinks, so a "the screen looks the same" test fails for reasons that have
 * nothing to do with the pointer. This finds a spot and *proves* it is static
 * before asking anything of it, so a failure means the pointer changed something.
 */
function staticDesktopSpot(kernel: Kernel): { x: number; y: number; index: number; park: { x: number; y: number } } {
  for (let y = LAYOUT.topBarHeight + 4; y < LAYOUT.height - LAYOUT.statusBarHeight - 4; y += 2) {
    for (let x = LAYOUT.dockWidth + 4; x < LAYOUT.width - 4; x += 2) {
      if (kernel.desktop.input.hitTest(x, y).kind !== 'desktop') continue;
      // Park the pointer on the far side of the screen from the candidate, so that
      // "the pointer is elsewhere" is literally true of the pixel being measured.
      // Parking on top of the spot would capture it already covered, and then the
      // test would pass or fail for reasons that have nothing to do with the trail.
      const park = x < LAYOUT.width / 2 ? { x: LAYOUT.width - 3, y: LAYOUT.height - 3 } : { x: LAYOUT.dockWidth + 3, y: LAYOUT.topBarHeight + 3 };
      const index = y * LAYOUT.width + x;
      kernel.movePointer(park.x, park.y, 1);
      kernel.tick();
      const first = kernel.pixels()[index]!;
      kernel.tick();
      if (kernel.pixels()[index] === first) return { x, y, index, park };
    }
  }
  throw new Error('the desktop has no pixel that stays put, so nothing can be compared');
}

test('the pointer is drawn, and leaves no trace behind it', () => {
  const kernel = booted();
  const spot = staticDesktopSpot(kernel);

  kernel.movePointer(spot.park.x, spot.park.y, 1);
  kernel.tick();
  const bare = kernel.pixels()[spot.index]!;

  kernel.movePointer(spot.x, spot.y, 1);
  kernel.tick();
  assert.notEqual(kernel.pixels()[spot.index]!, bare, 'the pointer was not drawn');

  kernel.movePointer(spot.park.x, spot.park.y, 1);
  kernel.tick();
  assert.equal(
    kernel.pixels()[spot.index]!,
    bare,
    'the pixels the pointer covered were not put back',
  );
});

test('moving the pointer costs the pointer, not the screen', () => {
  const kernel = booted();
  kernel.movePointer(150, 90, 1);
  kernel.tick();

  // Measured as a difference, because the desktop is busy on its own: the monitor
  // window redraws every frame whether or not anything is touched. Comparing a
  // moving frame against a still one isolates what the pointer itself costs, and
  // a still comparison would just measure the monitor window.
  let still = 0;
  for (let i = 0; i < 12; i++) still += kernel.tick().examined;

  let moving = 0;
  for (let i = 0; i < 12; i++) {
    kernel.movePointer(60 + i * 3, 70 + i * 2, 1);
    moving += kernel.tick().examined;
  }

  const extra = moving / 12 - still / 12;
  // Two pointer rectangles, each about 16x22. Anything close to the whole screen
  // means the pointer's damage is not being tracked, and the trail test above is
  // the only thing standing between that and a visible smear.
  assert.ok(
    extra < 1500,
    `moving the pointer examined ${extra.toFixed(0)} extra pixels per frame over a still pointer`,
  );
});

test('a reset puts the desktop back the way it started', () => {
  const kernel = booted();
  const window = kernel.desktop.windows[0]!;
  const original = { ...window.rect };

  toTitleBar(kernel);
  press(kernel, 0, 1000);
  press(kernel, 0, 1150); // maximise
  assert.equal(window.maximised, true, 'the setup really did change something');

  // A context menu, then a start menu. Only one menu is open at a time, and a click
  // anywhere is consumed by dismissing it - including a click on the button that
  // opens another one. That is what makes a menu feel modal without being one, and
  // it means opening a second menu takes two clicks.
  const onWindow = window.titleBarPoint(20, LAYOUT.windowTitleHeight + 20);
  kernel.movePointer(onWindow.x, onWindow.y, 1);
  press(kernel, 2, 1300);
  assert.ok(currentMenu(kernel) !== undefined, 'the context menu did not open');

  kernel.movePointer(4, 2, 1);
  press(kernel, 0, 1400);
  assert.equal(currentMenu(kernel), undefined, 'the first click only dismissed it');

  press(kernel, 0, 1500);
  const open = currentMenu(kernel);
  assert.ok(open !== undefined, 'the second click opened the start menu');
  assert.equal(open.y, LAYOUT.topBarHeight, 'and it hangs below the top bar');

  kernel.resetDesktop();

  assert.equal(window.maximised, false, 'no longer maximised');
  assert.deepEqual(window.rect, original, 'back at its starting rectangle');
  assert.equal(currentMenu(kernel), undefined, 'no menu left open');
  assert.equal(kernel.desktop.input.pointer.x, 0, 'the pointer is back at the origin');
  assert.equal(kernel.desktop.input.pointer.buttons, 0, 'and no button is stuck down');
  assert.equal(focused(kernel), 'terminal', 'the first window has the keyboard again');
  assert.deepEqual(
    kernel.desktop.windows.map((w) => w.app.id),
    kernel.desktop.apps.map((app) => app.id),
    'and no window was lost',
  );
});