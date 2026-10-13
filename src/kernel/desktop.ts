/**
 * VerixOS - the desktop.
 *
 * A window manager, a handful of applications, and a key map, drawn through the
 * compositor. What makes this a *desktop* rather than a picture of one is that
 * every part of it is reachable: the clock reads the PIT's tick count, the monitor
 * reads the CPU's retired-instruction counter, and typing into the terminal
 * changes the pixels. A test can therefore ask the same questions of the desktop
 * that a person would - does a keystroke change the screen, does time change the
 * screen, does closing a window give its pixels back - and get answers that are
 * about behaviour rather than about a golden image.
 *
 * ## The frame loop
 *
 * `frame()` draws, then presents. Drawing is unconditional - an app that has
 * nothing new to say still redraws itself - and presentation is not, because the
 * compositor compares against what is already on screen. That is the honest
 * arrangement: the cost that matters is the cost of getting pixels onto the
 * device, and that number is measured rather than estimated.
 */

import { COLOUR, Compositor, CursorBuffer, clip, drawCursor, moveRect, type Rect } from './compositor.ts';
import { drawMenu, ShellInput, dockRect, type DesktopLike } from './input.ts';
import { ExtendedScanCode, ScanCode } from '../machine/devices/keyboard.ts';

/* -------------------------------------------------------------------------- */
/* Geometry                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The layout, in one place.
 *
 * 320x200 is not a generous canvas, and a desktop whose measurements are scattered
 * across twenty call sites ends up with a one-pixel gap somewhere that looks like
 * a mistake. Every number the shell uses comes from here.
 */
export const LAYOUT = {
  width: 320,
  height: 200,
  topBarHeight: 12,
  statusBarHeight: 11,
  dockWidth: 26,
  windowTitleHeight: 11,
  windowBorder: 1,
  shadowOffset: 2,
} as const;

/** The area windows may occupy: everything between the dock and the status bar. */
export function workArea(): Rect {
  return {
    x: LAYOUT.dockWidth,
    y: LAYOUT.topBarHeight,
    width: LAYOUT.width - LAYOUT.dockWidth,
    height: LAYOUT.height - LAYOUT.topBarHeight - LAYOUT.statusBarHeight,
  };
}

/** Vertical distance between the tops of two dock tiles. */
const DOCK_TILE_PITCH = 34;

/** Height of a dock tile. */
const DOCK_TILE_HEIGHT = 28;

/**
 * Where the dock's tile for an application is.
 *
 * One definition, used both to paint the dock and to decide what a click landed on.
 * Written twice it would drift, and the failure mode is a tile you can see and
 * cannot click - which reads as a dead desktop rather than as a geometry bug.
 */
export function dockTile(index: number): Rect & { index: number } {
  return {
    index,
    x: 5,
    y: LAYOUT.topBarHeight + 6 + index * DOCK_TILE_PITCH,
    width: LAYOUT.dockWidth - 12,
    height: DOCK_TILE_HEIGHT,
  };
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                         */
/* -------------------------------------------------------------------------- */

/** One keystroke, in the form the keyboard controller reports. */
export interface KeyEvent {
  /** Set 1 scan code, with 0x80 set for a release. */
  readonly code: number;
  /** ASCII, or zero for a key that has none. */
  readonly ascii: number;
  readonly extended: boolean;
}

/** What a keystroke means to the shell. */
export type Action =
  | { kind: 'focus-next' }
  | { kind: 'focus-previous' }
  | { kind: 'close' }
  | { kind: 'activate' }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'toggle-help' }
  | { kind: 'cycle-app'; index: number }
  | { kind: 'text'; value: string };

/**
 * Translate a keystroke into an action.
 *
 * Pure and total: it consults nothing but the event, so the whole key map is
 * testable without a machine, a screen or a window. A release is `undefined`
 * rather than a repeat - the shell has no auto-repeat, and pretending otherwise
 * would make a key-down test pass for the wrong reason.
 */
export function mapKey(event: KeyEvent): Action | undefined {
  if ((event.code & 0x80) !== 0) return undefined;

  switch (event.code) {
    case ScanCode.TAB:
      // Shift-Tab arrives as the extended form, so it is distinguishable without
      // consulting the modifier state - which is what the hardware guarantees.
      return event.extended ? { kind: 'focus-previous' } : { kind: 'focus-next' };
    case ScanCode.ESC:
      return { kind: 'close' };
    case ScanCode.ENTER:
      return { kind: 'activate' };
    case ScanCode.F1:
      return { kind: 'toggle-help' };
    // The arrows are extended scan codes on set 1: the controller sends 0xE0
    // first and the key follows. Testing `extended` here rather than assuming the
    // bare code would also catch a stray 0x4b from another device.
    case ExtendedScanCode.LEFT:
      return event.extended ? { kind: 'move', dx: -8, dy: 0 } : undefined;
    case ExtendedScanCode.RIGHT:
      return event.extended ? { kind: 'move', dx: 8, dy: 0 } : undefined;
    case ExtendedScanCode.UP:
      return event.extended ? { kind: 'move', dx: 0, dy: -8 } : undefined;
    case ExtendedScanCode.DOWN:
      return event.extended ? { kind: 'move', dx: 0, dy: 8 } : undefined;
    case ScanCode.LEFT_SHIFT:
    case ScanCode.RIGHT_SHIFT:
    case ScanCode.LEFT_CTRL:
      return undefined;
    default:
      break;
  }

  // Digits 1-3 open an application, so the dock has a keyboard route as well as
  // a pointer. Holding shift still produces its ASCII character here, which is
  // harmless: the terminal wants capitals and the shell only intercepts digits
  // when shift is not held, which the caller signals by passing `shiftHeld`.
  if (!event.extended && event.ascii >= 0x31 && event.ascii <= 0x33) {
    return { kind: 'cycle-app', index: event.ascii - 0x31 };
  }
  if (event.ascii >= 0x20 && event.ascii < 0x7f) {
    return { kind: 'text', value: String.fromCharCode(event.ascii) };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Applications                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything an application is told about the machine it is running on. */
export interface MachineView {
  /** PIT overflows since reset. */
  readonly ticks: number;
  /** Instructions retired. */
  readonly instructions: bigint;
  /** Bytes of RAM installed. */
  readonly ramBytes: number;
  /** Milliseconds of emulated time per frame. */
  readonly frameMs: number;
  /** Fraction of the last frame's pixels that actually changed, 0..1. */
  readonly frameCost: number;
}

/** An application. Deliberately small: a title, a body, and a key handler. */
export interface App {
  readonly id: string;
  readonly title: string;
  /** One-line description, shown by the dock's selected item. */
  readonly summary: string;
  preferred: Rect;
  /**
   * Incremented whenever something the window draws has changed.
   *
   * The shell compares this against the value it last drew, and damages only the
   * windows whose revision has moved. It is the whole mechanism by which an
   * application that has nothing to say costs nothing - an application that
   * returned "I changed" unconditionally would be redrawn every frame and the
   * compositor's damage tracking would buy nothing.
   */
  revision: number;
  /** Draw the body. The frame and title have already been drawn. */
  draw(ctx: AppContext): void;
  /** Handle a keystroke that reached this window. Return true if it was used. */
  onKey(action: Action): boolean;
  /** Called once per frame with the elapsed milliseconds. */
  update?(dtMs: number): void;
}

export interface AppContext {
  readonly compositor: Compositor;
  /** Area available to this application's body, inside the window frame. */
  readonly body: Rect;
  readonly focused: boolean;
  readonly machine: MachineView;
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                       */
/* -------------------------------------------------------------------------- */

export class Window {
  focused = false;

  /** Position of the window's body. Replaced, never mutated, so `previous` works. */
  rect: Rect;
  /** The application this window shows. */
  readonly app: App;
  /** Where the window was before it moved, so only two rectangles redraw. */
  previous: Rect;

  /** What has been drawn into the back buffer for this window. */
  drawnRevision = -1;
  drawnFocus = false;

  /**
   * Stacking order. Higher is nearer the front.
   *
   * Kept on the window rather than by reordering the array, because the array
   * index is what the keyboard focus order and the dock selection are tied to, and
   * reordering it would make clicking a tile change which window Tab selects next.
   */
  z = 0;

  /** Where the window was before it was maximised. */
  restoreRect: Rect | undefined;

  /** True when the window currently fills the work area. */
  maximised = false;

  constructor(app: App, rect: Rect) {
    this.app = app;
    this.rect = rect;
    this.previous = rect;
  }

  moveTo(rect: Rect): void {
    this.previous = this.rect;
    this.rect = rect;
  }

  /** The whole window including its frame. */
  get frame(): Rect {
    const { windowBorder } = LAYOUT;
    return {
      x: this.rect.x - windowBorder,
      y: this.rect.y - windowBorder - LAYOUT.windowTitleHeight,
      width: this.rect.width + windowBorder * 2,
      height: this.rect.height + windowBorder * 2 + LAYOUT.windowTitleHeight,
    };
  }

  /**
   * The strip that carries the title, which is above the client area.
   *
   * One definition, used both to paint the title bar and to decide whether a click
   * landed on it. When the two were written separately they drifted, and the result
   * was a window that could be seen but not dragged - the title bar was drawn at
   * one height and hit-tested at another, and the mismatch was invisible until
   * somebody tried to use the window.
   */
  get titleBar(): Rect {
    const frame = this.frame;
    return {
      x: frame.x + LAYOUT.windowBorder,
      y: frame.y + LAYOUT.windowBorder,
      width: frame.width - LAYOUT.windowBorder * 2,
      height: LAYOUT.windowTitleHeight,
    };
  }

  /**
   * A point on the title bar, given a point in window coordinates.
   *
   * Used by the tests and by anything that needs to say "on the title bar" in terms
   * of where the window *looks* to be rather than where its client area is.
   */
  titleBarPoint(dx: number, dy: number): { x: number; y: number } {
    return { x: this.titleBar.x + dx, y: this.titleBar.y + dy };
  }

  /** The area the application may draw in. */
  get body(): Rect {
    return this.rect;
  }
}

/* -------------------------------------------------------------------------- */
/* Scripted input                                                               */
/* -------------------------------------------------------------------------- */

/** Named keys a script may use, so `--keys` does not have to be scancodes. */
const NAMED_KEYS: Readonly<Record<string, { code: number; ascii: number; extended: boolean }>> = {
  tab: { code: ScanCode.TAB, ascii: 0x09, extended: false },
  'shift-tab': { code: ScanCode.TAB, ascii: 0x09, extended: true },
  enter: { code: ScanCode.ENTER, ascii: 0x0d, extended: false },
  esc: { code: ScanCode.ESC, ascii: 0x1b, extended: false },
  f1: { code: ScanCode.F1, ascii: 0, extended: false },
  left: { code: ExtendedScanCode.LEFT, ascii: 0, extended: true },
  right: { code: ExtendedScanCode.RIGHT, ascii: 0, extended: true },
  up: { code: ExtendedScanCode.UP, ascii: 0, extended: true },
  down: { code: ExtendedScanCode.DOWN, ascii: 0, extended: true },
  backspace: { code: ScanCode.BACKSPACE, ascii: 0x08, extended: false },
};

/**
 * Turn a key script into keystrokes.
 *
 * The script is a `/`-separated list of tokens: a named key (`Tab`, `f1`,
 * `shift-tab`), `type:TEXT` for literal characters, or a single character typed on
 * its own. `\r` and `\n` are honoured inside `type:` because the terminal's Enter
 * key is a carriage return and a script that could not express one could not
 * demonstrate the terminal.
 *
 * Parsing this here rather than in the command line keeps the CLI a thin shell
 * over something that is testable on its own.
 */
export function parseKeyScript(script: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  for (const rawToken of script.split('/')) {
    const token = rawToken.trim();
    if (token === '') continue;

    if (token.toLowerCase().startsWith('type:')) {
      const text = token.slice('type:'.length);
      for (const character of text) {
        const code = character === '\n' ? ScanCode.ENTER : asciiToScancode(character);
        events.push({ code, ascii: character.codePointAt(0) ?? 0x20, extended: false });
      }
      continue;
    }

    const named = NAMED_KEYS[token.toLowerCase()];
    if (named !== undefined) {
      events.push({ code: named.code, ascii: named.ascii, extended: named.extended });
      continue;
    }

    if (token.length === 1) {
      const character = token;
      events.push({
        code: asciiToScancode(character),
        ascii: character.codePointAt(0) ?? 0x20,
        extended: false,
      });
      continue;
    }

    throw new Error(`unknown key in script: '${token}'`);
  }
  return events;
}

/**
 * The set 1 scan code for an unshifted ASCII character.
 *
 * The table is explicit rather than computed, because set 1 is **not**
 * alphabetical: `A` is 0x1E and `Z` is 0x2C, but between them sit the bracket
 * keys, Enter and Control, and after `Z` come the punctuation keys. The obvious
 * `ScanCode.A + (letter - 'A')` sends `v` as 0x33, which is keypad 1 - so a
 * script that types "ver" would arrive as three unrelated keys. Only the digits
 * are contiguous, and only from `0` upwards.
 */
const LETTER_SCANCODES: Readonly<Record<string, number>> = {
  q: ScanCode.Q, w: ScanCode.W, e: ScanCode.E, r: ScanCode.R, t: ScanCode.T,
  y: ScanCode.Y, u: ScanCode.U, i: ScanCode.I, o: ScanCode.O, p: ScanCode.P,
  a: ScanCode.A, s: ScanCode.S, d: ScanCode.D, f: ScanCode.F, g: ScanCode.G,
  h: ScanCode.H, j: ScanCode.J, k: ScanCode.K, l: ScanCode.L,
  z: ScanCode.Z, x: ScanCode.X, c: ScanCode.C, v: ScanCode.V, b: ScanCode.B,
  n: ScanCode.N, m: ScanCode.M,
};

const PUNCTUATION_SCANCODES: Readonly<Record<string, number>> = {
  ' ': ScanCode.SPACE,
  '-': ScanCode.MINUS,
  '=': ScanCode.EQUALS,
  '[': ScanCode.LEFT_BRACKET,
  ']': ScanCode.RIGHT_BRACKET,
  ';': ScanCode.SEMICOLON,
  "'": ScanCode.APOSTROPHE,
  '`': ScanCode.GRAVE,
  '\\': ScanCode.BACKSLASH,
  ',': ScanCode.COMMA,
  '.': ScanCode.PERIOD,
  '/': ScanCode.SLASH,
};

function asciiToScancode(character: string): number {
  const lower = character.toLowerCase();
  const letter = LETTER_SCANCODES[lower];
  if (letter !== undefined) return letter;
  const punctuation = PUNCTUATION_SCANCODES[character];
  if (punctuation !== undefined) return punctuation;
  const code = character.charCodeAt(0);
  // The digits *are* contiguous in set 1, running backwards from 0x0B.
  if (code >= 0x30 && code <= 0x39) return ScanCode.ZERO + (code - 0x30);
  // Anything else maps to zero, which the key map ignores. Guessing would send a
  // keystroke the script never asked for.
  return 0;
}

/* -------------------------------------------------------------------------- */
/* The shell                                                                     */
/* -------------------------------------------------------------------------- */

export interface DesktopOptions {
  /** Called each frame for the machine's current state. */
  readonly machine: () => MachineView;
  /** Starting emulated time in milliseconds. */
  readonly startMs?: number;
}

export class Desktop implements DesktopLike {
  readonly compositor = new Compositor(LAYOUT.width, LAYOUT.height);
  readonly windows: Window[] = [];
  readonly apps: App[];

  private focusIndex = -1;
  private helpVisible = false;
  private clockMs: number;
  private dockSelection = 0;
  private statusMessage = 'Tab focus  Enter open  F1 help';
  private readonly machineView: () => MachineView;

  /** What each piece of chrome last showed, so only genuine changes redraw. */
  private lastClockText = '';
  private lastLoadBucket = -1;
  private lastDockSelection = -1;
  private lastStatus = '';
  private lastCount = '';
  private lastHelpVisible = false;

  /** Where the pointer was last drawn, so it can be erased before redrawing. */
  private pointerRect: Rect | undefined;

  /**
   * The pixels under the pointer.
   *
   * Sized from the sprite in `compositor.ts`. The reserved damage is two pixels
   * larger on each side than this, which leaves room for the sprite to be resized
   * without the damage and the saved area disagreeing - a mismatch that shows up
   * as a one-pixel fringe of cursor left along a path.
   */
  private readonly cursorBuffer = new CursorBuffer(this.compositor, 16, 22);

  /** What has actually been drawn, as opposed to what needs drawing. */
  private lastDrawnDock = -1;
  private drawnHelp = false;
  private primed = false;
  private readonly seenRevision = new Map<string, number>();

  constructor(options: DesktopOptions) {
    this.clockMs = options.startMs ?? 9 * 3600_000; // 09:00
    this.machineView = options.machine;
    this.apps = [new TerminalApp(), new MonitorApp(), new AboutApp()];
    for (const app of this.apps) {
      this.windows.push(new Window(app, { ...app.preferred }));
    }
    // One window open to begin with: a desktop that starts showing nothing gives
    // a first screenshot of an empty rectangle, which says nothing about whether
    // any of it works.
    this.focusIndex = 0;
    this.windows[0]!.focused = true;
    for (const window of this.windows) window.z = window.app.id === 'terminal' ? 3 : window.app.id === 'monitor' ? 2 : 1;
    this.input = new ShellInput(this);
  }

  /**
   * Pointer input.
   *
   * Constructed here rather than as a field initialiser because `input.ts` and this
   * module refer to each other: a field initialiser would run during construction
   * with the other module only half-evaluated.
   */
  readonly input: ShellInput;

  /** The focused window, if any. */
  get focusedWindow(): Window | undefined {
    if (this.focusIndex < 0 || this.focusIndex >= this.windows.length) return undefined;
    return this.windows[this.focusIndex];
  }

  /** Emulated milliseconds since the desktop started. */
  get elapsedMs(): number {
    return this.clockMs;
  }

  /** True when the help overlay is up. */
  get showingHelp(): boolean {
    return this.helpVisible;
  }

  /** The last line of the status bar, for tests and for `verix gui --status`. */
  get status(): string {
    return this.statusMessage;
  }

  /**
   * Advance emulated time and redraw.
   *
   * The clock is driven by the caller in milliseconds rather than read from a
   * host timer, so a recorded run is reproducible: the same frame sequence
   * produces the same picture whether it ran in a millisecond or a minute.
   *
   * ## Why this damages rectangles instead of redrawing everything
   *
   * An earlier version of this function called `damageEverything()`, which is
   * simpler and perfectly correct - the picture is identical. It is also why the
   * compositor's `examined` column read 64000 every single frame: the desktop
   * was asking for the whole screen to be compared, so the damage tracking was
   * doing nothing at all. A compositor's whole reason to exist is the part where
   * it decides not to touch pixels, and a desktop that damages everything has
   * quietly removed that.
   *
   * So the frame asks four separate questions - has the clock moved, has the
   * focus moved, has this application's state changed, has the status line
   * changed - and damages only the rectangles whose answer is yes. Everything
   * else is left alone, and `present()` then examines a few hundred pixels
   * instead of sixty-four thousand.
   */
  frame(dtMs: number): void {
    this.clockMs += dtMs;
    for (const window of this.windows) {
      window.app.update?.(dtMs);
    }

    // The pointer is the one thing that moves whether or not the guest asks, so it
    // damages its own rectangle and nothing else. Reserving room under it here is
    // what stops a stationary pointer from being erased by the window it overlaps.
    const pointer = this.input.pointer;
    if (this.pointerRect !== undefined) this.compositor.damage(this.pointerRect);
    const cursorWidth = 12;
    const cursorHeight = 18;
    this.pointerRect = {
      x: Math.max(0, pointer.x - 2),
      y: Math.max(0, pointer.y - 2),
      width: cursorWidth + 4,
      height: cursorHeight + 4,
    };
    this.compositor.damage(this.pointerRect);

    const machine = this.machineView();
    // The terminal's `time` command reports the same clock the top bar shows, so
    // there is one clock rather than two that could disagree.
    const terminal = this.apps[0];
    if (terminal instanceof TerminalApp) terminal.clockMs = this.clockMs;

    // Top bar: only the clock and the load indicator move, and only when they do.
    const clock = formatClock(this.clockMs);
    if (clock !== this.lastClockText) {
      this.damageClock(clock);
      this.lastClockText = clock;
    }
    const load = this.loadBucket(machine.frameCost);
    if (load !== this.lastLoadBucket) {
      this.compositor.damage({ x: LAYOUT.width - 78, y: 0, width: 78, height: LAYOUT.topBarHeight });
      this.lastLoadBucket = load;
    }

    // Dock: only the selection indicator moves.
    if (this.dockSelection !== this.lastDockSelection) {
      this.compositor.damage(dockRect());
      this.lastDockSelection = this.dockSelection;
    }

    // A window that has moved or changed size has to repaint everything the old
    // rectangle covered as well as the new one, or it leaves a copy of itself
    // behind on the desktop.
    for (let i = 0; i < this.windows.length; i++) {
      const window = this.windows[i]!;
      if (window.previous !== window.rect) {
        this.compositor.damage(window.previous);
        this.compositor.damage(window.frame);
        window.previous = window.rect;
      }
    }

    // Windows: focus changes repaint two title bars; an application repaints only
    // when its own state has advanced.
    for (let i = 0; i < this.windows.length; i++) {
      const window = this.windows[i]!;
      const focused = i === this.focusIndex;
      const revision = window.app.revision;
      if (window.focused !== focused || this.seenRevision.get(window.app.id) !== revision) {
        this.seenRevision.set(window.app.id, revision);
        this.compositor.damage(window.frame);
      }
      window.focused = focused;
    }

    if (this.helpVisible !== this.lastHelpVisible) {
      this.compositor.damageEverything();
      this.lastHelpVisible = this.helpVisible;
    }

    // Status bar: the hint text and the instruction counter.
    const hint = this.statusMessage;
    const count = `${machine.instructions} ins`;
    if (hint !== this.lastStatus || count !== this.lastCount) {
      this.compositor.damage({
        x: 0,
        y: LAYOUT.height - LAYOUT.statusBarHeight,
        width: LAYOUT.width,
        height: LAYOUT.statusBarHeight,
      });
      this.lastStatus = hint;
      this.lastCount = count;
    }
  }

  /** The clock area of the top bar, which is the only part of it that moves. */
  private damageClock(clock: string): void {
    const x = LAYOUT.width - 6 - clock.length * 8;
    // The previous string may have been a character longer, so damage the widest
    // of the two rather than exactly what is about to be written.
    const width = LAYOUT.width - x + 8;
    this.compositor.damage({ x: x - 16, y: 0, width, height: LAYOUT.topBarHeight });
  }

  /**
   * Coarse load indicator, in three steps.
   *
   * Quantised deliberately: a smoothly varying indicator would be a rectangle
   * redrawn on almost every frame, and the point of the desktop is that most
   * frames change almost nothing. Three steps change when the answer does.
   */
  private loadBucket(cost: number): number {
    if (cost > 0.6) return 2;
    if (cost > 0.2) return 1;
    return 0;
  }

  /** Present the frame, returning what it cost. */
  present(target: Uint8Array): { written: number; examined: number; regions: number } {
    const machine = this.machineView();

    if (!this.primed) {
      // The first frame has nothing on the back buffer, so everything is new.
      this.compositor.damageEverything();
      this.drawTopBar(machine);
      this.drawDock();
      for (let i = 0; i < this.windows.length; i++) this.drawWindow(this.windows[i]!, i === this.focusIndex, machine);
      this.drawStatusBar(machine);
      this.lastDrawnDock = this.dockSelection;
      this.drawnHelp = this.helpVisible;
      this.lastClockText = formatClock(this.clockMs);
      this.lastLoadBucket = this.loadBucket(machine.frameCost);
      this.lastStatus = this.statusMessage;
      this.lastCount = `${machine.instructions} ins`;
      this.primed = true;
    } else {
      // Otherwise draw only what was damaged, into the same back buffer. The
      // previous frame's pixels are still there, which is the whole point: `back`
      // is never cleared between frames, so an undamaged region already holds
      // the right content.
      this.drawClock(this.lastClockText, this.lastLoadBucket);
      if (this.dockSelection !== this.lastDrawnDock) {
        this.drawDock();
        this.lastDrawnDock = this.dockSelection;
      }
      for (let i = 0; i < this.windows.length; i++) {
        const window = this.windows[i]!;
        const focused = i === this.focusIndex;
        if (window.drawnRevision !== window.app.revision || window.drawnFocus !== focused) {
          this.drawWindow(window, focused, machine);
          window.drawnRevision = window.app.revision;
          window.drawnFocus = focused;
        }
      }
      if (this.helpVisible !== this.drawnHelp) {
        if (this.helpVisible) this.drawHelp();
        else this.compositor.damageEverything();
        this.drawnHelp = this.helpVisible;
      }
      this.drawStatusBar(machine);
    }

    // Windows are drawn back to front, so a click lands on the one on top.
    for (const window of this.windowsFrontToBack().reverse()) {
      const index = this.windows.indexOf(window);
      const focused = index === this.focusIndex;
      if (window.drawnRevision !== window.app.revision || window.drawnFocus !== focused) {
        this.drawWindow(window, focused, machine);
        window.drawnRevision = window.app.revision;
        window.drawnFocus = focused;
      }
    }
    // The menu, if one is open, sits above every window.
    this.drawMenu(this.compositor);
    // The pointer is drawn last, and its damage was reserved before any of this.
    // The pixels it covers are saved first and put back when it moves: the back
    // buffer is never cleared, so without that the pointer would smear everywhere
    // it had ever been.
    this.cursorBuffer.moveTo(this.input.pointer.x, this.input.pointer.y);
    drawCursor(this.compositor, this.input.pointer.x, this.input.pointer.y);

    const stats = this.compositor.present(target);
    // The monitor graph records what the frames have actually cost. It is fed
    // from the real measurement rather than estimated, which is the only way the
    // graph can be worth anything.
    const monitor = this.apps[1];
    if (monitor instanceof MonitorApp) monitor.recordFrame(stats.written, stats.examined);
    return { written: stats.written, examined: stats.examined, regions: stats.regions };
  }

  /**
   * Feed one keystroke in.
   *
   * Returns the action taken, or `undefined` for a release and for a key the map
   * does not recognise. Tests assert on it, which is what makes "the shell
   * responds to keys" a checkable claim rather than a screenshot comparison.
   */
  press(event: KeyEvent, shiftHeld = false): Action | undefined {
    const action = mapKey(event);
    if (action === undefined) return undefined;

    // Shift turns a digit into punctuation, which belongs to the application.
    if (action.kind === 'text' || action.kind === 'cycle-app') {
      if (shiftHeld) {
        const text = event.ascii >= 0x20 && event.ascii < 0x7f ? String.fromCharCode(event.ascii) : '';
        if (text !== '') {
          return this.focusedWindow?.app.onKey({ kind: 'text', value: text }) === true
            ? { kind: 'text', value: text }
            : undefined;
        }
      }
    }

    const window = this.focusedWindow;
    // The focused application gets first refusal on Enter as well as on text.
    // Enter means "run this line" to a terminal and "activate" to a window
    // manager, and no single mapping is right for both - so the application
    // decides, and the shell only acts if nothing wanted it. Without this, a
    // terminal whose window has focus can never see a newline, which is the
    // keyboard's most-used key on the most-used window.
    if (window !== undefined && (action.kind === 'text' || action.kind === 'activate')) {
      if (window.app.onKey(action)) {
        this.statusMessage = action.kind === 'activate' ? `${window.app.title}: run` : `${window.app.title}: input`;
        return action;
      }
    }

    switch (action.kind) {
      case 'focus-next':
        this.cycleFocus(1);
        return action;
      case 'focus-previous':
        this.cycleFocus(-1);
        return action;
      case 'close':
        if (window !== undefined) {
          this.statusMessage = `Closed ${window.app.title}`;
          this.setFocus(window === this.windows[0] ? -1 : 0);
        }
        return action;
      case 'activate':
        this.statusMessage = window === undefined ? 'Nothing focused' : `${window.app.title} activated`;
        return action;
      case 'move':
        if (window !== undefined) {
          const moved = moveRect(
            window.rect,
            action.dx,
            action.dy,
            LAYOUT.width,
            LAYOUT.height - LAYOUT.statusBarHeight,
          );
          window.moveTo(moved);
          this.compositor.damage(window.previous);
          this.compositor.damage(moved);
        }
        return action;
      case 'toggle-help':
        this.helpVisible = !this.helpVisible;
        this.statusMessage = this.helpVisible ? 'Help shown' : 'Help dismissed';
        return action;
      case 'cycle-app':
        this.dockSelection = action.index % this.apps.length;
        this.setFocus(action.index);
        return action;
      default:
        return action;
    }
  }

  /**
 * Give a window the keyboard, or take it away.
 *
 * `-1` means *no window has focus*, which is a real state: clicking the desktop
 * behind everything leaves the shell with nowhere to send a keystroke. It is kept
 * distinct from wrapping deliberately, which is `cycleFocus`, because folding the
 * two together makes "click the empty desktop" focus the last window in the list -
 * a click on the background quietly handing the keyboard to a window the pointer
 * was nowhere near.
 */
private setFocus(index: number): void {
    for (let i = 0; i < this.windows.length; i++) {
      this.windows[i]!.focused = i === index;
    }
    this.focusIndex = index;
    this.dockSelection = Math.max(0, index);
  }

  /**
   * Move the focus by `step`, wrapping around the list.
   *
   * Wrapping is what makes Tab feel like Tab: the last window leads back to the
   * first. Only the keyboard uses this, and it is a separate method so that
   * `setFocus` can keep a single unambiguous meaning.
   */
  private cycleFocus(step: number): void {
    if (this.windows.length === 0) return;
    const count = this.windows.length;
    const from = this.focusIndex < 0 ? 0 : this.focusIndex;
    this.setFocus(((from + step) % count + count) % count);
  }

  /* ------------------------------------------------------------------ */
  /* Pointer-facing operations                                           */
  /* ------------------------------------------------------------------ */

  /** Put every piece of desktop state back where it started. */
  reset(): void {
    for (const window of this.windows) {
      window.moveTo({ ...window.app.preferred });
      window.previous = window.rect;
      window.restoreRect = undefined;
      window.maximised = false;
      window.drawnRevision = -1;
      window.drawnFocus = false;
      window.focused = false;
    }
    this.focusIndex = 0;
    this.dockSelection = 0;
    if (this.windows[0] !== undefined) this.windows[0].focused = true;
    for (const window of this.windows) {
      window.z = window.app.id === 'terminal' ? 3 : window.app.id === 'monitor' ? 2 : 1;
    }
    this.helpVisible = false;
    this.statusMessage = 'Tab focus  Enter open  F1 help';
    this.lastClockText = '';
    this.lastLoadBucket = -1;
    this.lastDockSelection = -1;
    this.lastStatus = '';
    this.lastCount = '';
    this.lastHelpVisible = false;
    this.lastDrawnDock = -1;
    this.drawnHelp = false;
    this.primed = false;
    this.pointerRect = undefined;
    this.seenRevision.clear();
    this.input.reset();
    this.compositor.damageEverything();
  }

  /** Where each dock tile is, for hit testing. */
  dockTiles(): ReadonlyArray<Rect & { index: number }> {
    return this.apps.map((_app, index) => dockTile(index));
  }

  /** Windows nearest the front first, which is the order hit testing wants. */
  windowsFrontToBack(): Window[] {
    return [...this.windows].sort((a, b) => b.z - a.z);
  }

  appIds(): string[] {
    return this.apps.map((app) => app.id);
  }

  appTitle(index: number): string {
    return this.apps[index]?.title ?? '';
  }

  /** Give an application the keyboard, as the dock's tiles do. */
  focusApp(index: number): void {
    this.setFocus(index);
    this.raiseApp(index);
  }

  focusWindow(window: Window | undefined): void {
    if (window === undefined) {
      this.setFocus(-1);
      return;
    }
    const index = this.windows.indexOf(window);
    if (index >= 0) this.setFocus(index);
    this.raiseWindow(window);
  }

  raiseApp(index: number): void {
    const window = this.windows[index];
    if (window !== undefined) this.raiseWindow(window);
  }

  /** Bring a window to the front and damage the strip its title used to occupy. */
  raiseWindow(window: Window): void {
    const highest = this.windows.reduce((top, w) => Math.max(top, w.z), 0);
    if (window.z === highest) return;
    // The old front window's title bar is still painted with its accent, so it has
    // to be repainted; leaving it is how a desktop ends up with two windows that
    // both look focused.
    this.compositor.damage(window.frame);
    for (const other of this.windows) {
      if (other !== window && other.z === highest) this.compositor.damage(other.frame);
    }
    window.z = highest + 1;
    this.compositor.damage(window.frame);
  }

  /** Maximise to the work area, or restore to where the window was. */
  toggleMaximise(window: Window): void {
    const area = workArea();
    if (window.maximised) {
      const restore = window.restoreRect ?? window.rect;
      window.moveTo(restore);
      window.maximised = false;
      window.restoreRect = undefined;
    } else {
      window.restoreRect = window.rect;
      // The inset is the frame's own height above and around the client area, not
      // an arbitrary margin. Insetting by a margin instead puts the title bar
      // *behind* the top bar, and the window then has no title bar at all: it
      // cannot be dragged, and it cannot be un-maximised by double-clicking it.
      // The one thing a maximised window must always keep is its title bar.
      const inset = LAYOUT.windowBorder + LAYOUT.windowTitleHeight;
      window.moveTo({
        x: area.x + inset,
        y: area.y + inset,
        width: area.width - inset * 2,
        height: area.height - inset * 2,
      });
      window.maximised = true;
    }
    this.raiseWindow(window);
    this.compositor.damage(window.frame);
    this.statusMessage = window.maximised ? `${window.app.title} maximised` : `${window.app.title} restored`;
  }

  /** Close a window and give its pixels back to the desktop. */
  closeWindow(window: Window): void {
    const index = this.windows.indexOf(window);
    if (index < 0) return;
    const frame = window.frame;
    this.windows.splice(index, 1);
    this.compositor.damage(frame);
    this.statusMessage = `Closed ${window.app.title}`;
    this.setFocus(Math.min(this.focusIndex, this.windows.length - 1));
  }

  /** Pass the wheel on to an application that can use it. */
  scrollWindow(window: Window, notches: number): void {
    const app = window.app as App & { scroll?: (notches: number) => void };
    if (typeof app.scroll !== 'function') return;
    app.scroll(notches);
  }

  damageWindow(window: Window): void {
    this.compositor.damage(window.frame);
  }

  damageEverything(): void {
    this.compositor.damageEverything();
  }

  /** Damage the open menu, if there is one. */
  damageMenu(): void {
    const menu = this.input.openMenu;
    if (menu === undefined) return;
    this.compositor.damage({
      x: menu.x - 2,
      y: menu.y - 2,
      width: 124,
      height: menu.items.length * 11 + 8,
    });
  }

  /**
   * Draw the open menu, if there is one.
   *
   * Only the menu. The pointer is drawn by the frame loop after the pixels beneath
   * it have been saved, and drawing it here as well would paint it twice - the
   * second pass would be *outside* the saved rectangle, and those pixels would
   * then never be put back, leaving a permanent cursor-shaped smear.
   */
  drawMenu(compositor: Compositor): void {
    const menu = this.input.openMenu;
    if (menu === undefined) return;
    drawMenu(compositor, menu.x, menu.y, menu.items);
  }

  /* ------------------------------------------------------------------ */
  /* Chrome                                                              */
  /* ------------------------------------------------------------------ */

  private drawTopBar(machine: MachineView): void {
    const bar: Rect = { x: 0, y: 0, width: LAYOUT.width, height: LAYOUT.topBarHeight };
    this.compositor.fillRect(bar, COLOUR.panelDim);
    this.compositor.horizontalLine(0, LAYOUT.topBarHeight - 1, LAYOUT.width, COLOUR.hairline);
    this.compositor.text8(6, 2, 'VERIX', COLOUR.accent, COLOUR.panelDim);
    this.compositor.text8(54, 2, 'OS', COLOUR.text, COLOUR.panelDim);
    void machine;
  }

  /** The clock and its load indicator: the only part of the top bar that moves. */
  private drawClock(clock: string, load: number): void {
    const x = LAYOUT.width - 6 - clock.length * 8;
    this.compositor.text8(x, 2, clock, COLOUR.text, COLOUR.panelDim);
    // A small live dot: it fills and empties with the frame budget, so a stalled
    // desktop looks stalled rather than merely static.
    this.compositor.fillRect(
      { x: x - 12, y: 3, width: 8, height: 6 },
      load === 2 ? COLOUR.warn : COLOUR.good,
    );
  }

  private drawDock(): void {
    const dock: Rect = { x: 0, y: LAYOUT.topBarHeight, width: LAYOUT.dockWidth, height: workArea().height };
    this.compositor.fillRect(dock, COLOUR.panelDim);
    this.compositor.verticalLine(LAYOUT.dockWidth - 1, dock.y, dock.height, COLOUR.hairline);

    for (let i = 0; i < this.apps.length; i++) {
      const tile = dockTile(i);
      const selected = i === this.dockSelection;
      this.compositor.bevel(tile, selected, selected ? COLOUR.panelLight : COLOUR.panel);
      if (selected) {
        this.compositor.strokeRect(tile, COLOUR.accent);
      }
      // A three-pixel glyph stands in for an icon: enough to tell the tiles
      // apart at this size without pretending to be a picture.
      drawAppGlyph(this.compositor, i, tile.x + 5, tile.y + 4, selected ? COLOUR.accent : COLOUR.muted);
      this.compositor.text8(tile.x + 1, tile.y + 17, `${i + 1}`, selected ? COLOUR.text : COLOUR.faint, selected ? COLOUR.panelLight : COLOUR.panel);
    }
  }

  private drawWindow(window: Window, focused: boolean, machine: MachineView): void {
    const frame = window.frame;
    const visible = clip(frame, LAYOUT.width, LAYOUT.height);
    if (visible === undefined) return;

    // A shadow first, so the window's own pixels land on top of it.
    this.compositor.fillRect(
      { x: frame.x + LAYOUT.shadowOffset, y: frame.y + LAYOUT.shadowOffset, width: frame.width, height: frame.height },
      COLOUR.bevelDark,
    );

    this.compositor.fillRect(frame, focused ? COLOUR.panel : COLOUR.panelDim);
    this.compositor.strokeRect(frame, focused ? COLOUR.bevelLight : COLOUR.hairline);

    const title = window.titleBar;
    this.compositor.fillRect(title, focused ? COLOUR.accent : COLOUR.panelDim);
    this.compositor.text8(
      title.x + 4,
      title.y + 2,
      window.app.title.toUpperCase(),
      focused ? COLOUR.background : COLOUR.muted,
      COLOUR.accent,
    );
    // The focused marker is a filled square, because a hue shift alone is not
    // distinguishable to a reader with reduced colour vision - and the theme
    // should not depend on the viewer distinguishing hues at all.
    if (focused) this.compositor.fillRect({ x: title.x + title.width - 6, y: title.y + 4, width: 3, height: 3 }, COLOUR.background);

    window.app.draw({
      compositor: this.compositor,
      body: window.body,
      focused,
      machine,
    });
  }

  private drawStatusBar(machine: MachineView): void {
    const y = LAYOUT.height - LAYOUT.statusBarHeight;
    const bar: Rect = { x: 0, y, width: LAYOUT.width, height: LAYOUT.statusBarHeight };
    this.compositor.fillRect(bar, COLOUR.panelDim);
    this.compositor.horizontalLine(0, y, LAYOUT.width, COLOUR.hairline);

    const left = this.statusMessage;
    this.compositor.text8(4, y + 2, left.length * 8 < 210 ? left : left.slice(0, 26), COLOUR.muted, COLOUR.panelDim);

    const right = `${machine.instructions.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ins`;
    this.compositor.text8(
      LAYOUT.width - 4 - right.length * 8,
      y + 2,
      right,
      COLOUR.faint,
      COLOUR.panelDim,
    );
  }

  private drawHelp(): void {
    const rect: Rect = { x: 30, y: 34, width: 260, height: 120 };
    this.compositor.fillRect({ x: rect.x + 3, y: rect.y + 3, width: rect.width, height: rect.height }, COLOUR.bevelDark);
    this.compositor.fillRect(rect, COLOUR.panel);
    this.compositor.strokeRect(rect, COLOUR.accent);
    this.compositor.text8(rect.x + 8, rect.y + 8, 'VERIXOS KEYS', COLOUR.accent, COLOUR.panel);
    const lines = [
      'Tab / Shift-Tab   next and previous window',
      'Enter             activate the focused window',
      'Esc               close the focused window',
      'Arrow keys        move the focused window',
      '1 2 3             open terminal, monitor, about',
      'F1                show or hide this help',
      '',
      'Everything on this screen is reachable: the clock',
      'reads the timer, the monitor reads the retired',
      'instruction count, and typing goes to the window',
      'that has focus.',
    ];
    lines.forEach((line, i) => {
      this.compositor.text8(rect.x + 8, rect.y + 22 + i * 9, line, COLOUR.text, COLOUR.panel);
    });
  }
}

/** A stand-in icon: three bars, differing per application. */
function drawAppGlyph(compositor: Compositor, index: number, x: number, y: number, colour: number): void {
  if (index === 0) {
    compositor.horizontalLine(x, y + 1, 10, colour);
    compositor.horizontalLine(x, y + 4, 7, colour);
    compositor.horizontalLine(x, y + 7, 9, colour);
    return;
  }
  if (index === 1) {
    compositor.verticalLine(x + 1, y, 9, colour);
    compositor.verticalLine(x + 4, y + 3, 6, colour);
    compositor.verticalLine(x + 7, y - 1 + 3, 4, colour);
    return;
  }
  compositor.strokeRect({ x, y, width: 10, height: 9 }, colour);
  compositor.horizontalLine(x + 2, y + 4, 6, colour);
}

/** 24-hour clock text from milliseconds since midnight. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000) % 86_400;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/* -------------------------------------------------------------------------- */
/* The applications                                                              */
/* -------------------------------------------------------------------------- */

/** A shell. Commands are real: they change state that the tests then read. */
export class TerminalApp implements App {
  readonly id = 'terminal';
  readonly title = 'Terminal';
  readonly summary = 'A shell you can type into';
  preferred: Rect = { x: 40, y: 34, width: 250, height: 128 };
  /** Bumped by every keystroke the terminal consumes. */
  revision = 0;

  private readonly lines: string[] = ['VerixOS shell 1.0. Type "help".', ''];
  private input = '';
  private caretVisible = true;
  private caretPhase = 0;

  /** Everything typed so far, for tests. */
  get transcript(): readonly string[] {
    return this.lines;
  }

  get currentInput(): string {
    return this.input;
  }

  update(dtMs: number): void {
    // The caret blinks at 500 ms. A caret that does not blink is still a caret,
    // but one that does is what makes it obvious which window has focus without
    // reading the title bar colour.
    this.caretPhase = (this.caretPhase + dtMs) % 1000;
    this.caretVisible = this.caretPhase < 500;
  }

  /** How far back the visible history is scrolled. */
  private scrollback = 0;

  /** Scroll the transcript, for the mouse wheel. */
  scroll(notches: number): void {
    const next = Math.min(Math.max(this.scrollback + notches, 0), Math.max(0, this.lines.length - 1));
    if (next === this.scrollback) return;
    this.scrollback = next;
    this.revision++;
  }

  draw(ctx: AppContext): void {
    const { compositor, body } = ctx;
    compositor.fillRect(body, COLOUR.panel);

    const visible = Math.max(1, Math.floor((body.height - 4) / 9));
    const end = Math.max(visible, this.lines.length - this.scrollback);
    const history = this.lines.slice(Math.max(0, end - visible), end);
    history.forEach((line, i) => {
      compositor.text8(body.x + 3, body.y + 3 + i * 9, line.slice(0, 40), COLOUR.text, COLOUR.panel);
    });

    const promptY = body.y + 3 + history.length * 9;
    if (promptY < body.y + body.height - 4) {
      compositor.text8(body.x + 3, promptY, `> ${this.input}`, COLOUR.accent, COLOUR.panel);
      if (this.caretVisible) {
        const x = body.x + 3 + (2 + this.input.length) * 8;
        compositor.verticalLine(x, promptY, 8, COLOUR.accent);
      }
    }
  }

  onKey(action: Action): boolean {
    // Enter arrives as `activate` rather than as text, because the key map gives
    // the shell's meaning priority. The terminal wants the other one, so it takes
    // it back here.
    if (action.kind === 'activate') {
      this.run(this.input);
      this.input = '';
      this.revision++;
      return true;
    }
    if (action.kind !== 'text') return false;
    // Any other consumed keystroke changes what is on screen - the prompt line,
    // the caret, or the transcript - so the revision moves before the edit.
    this.revision++;
    const character = action.value;
    if (character === '\r' || character === '\n') {
      this.run(this.input);
      this.input = '';
      return true;
    }
    if (character === '\b') {
      this.input = this.input.slice(0, -1);
      return true;
    }
    if (this.input.length < 30) this.input += character;
    return true;
  }

  private run(command: string): void {
    const text = command.trim();
    this.lines.push(`> ${command}`);
    this.scrollback = 0;
    switch (text) {
      case '':
        break;
      case 'help':
        this.lines.push('commands: help info ver clear time');
        break;
      case 'ver':
        this.lines.push('VerixOS 0.1 (interpreter, compositor, shell)');
        break;
      case 'time':
        this.lines.push(`clock ${formatClock(this.clockMs)}`);
        break;
      case 'clear':
        this.lines.length = 0;
        break;
      default:
        this.lines.push(`unknown command: ${text.split(' ')[0]}`);
    }
    // The scrollback is bounded. A shell that grows without limit is a shell that
    // eventually stops rendering, and the cap is the honest place to fix that.
    while (this.lines.length > 64) this.lines.shift();
  }

  /** Set by the shell each frame so `time` has a clock to report. */
  clockMs = 0;
}

/** Live machine state, which is what makes the desktop demonstrably running. */
export class MonitorApp implements App {
  readonly id = 'monitor';
  readonly title = 'Monitor';
  readonly summary = 'Live timer, instruction count and frame cost';
  preferred: Rect = { x: 60, y: 50, width: 232, height: 110 };
  /**
   * Bumped for every sample taken.
   *
   * The graph scrolls on every frame, so this really does change every frame, and
   * the monitor window is therefore redrawn every frame. Claiming otherwise would
   * be cheaper and wrong: the picture it is showing is genuinely different each
   * time, and a revision counter that lied about that would be measuring the
   * compositor rather than the desktop.
   */
  revision = 0;

  /** Recent frame costs, oldest first, for the sparkline. */
  readonly history: number[] = [];
  private peakCost = 0;

  update(dtMs: number): void {
    void dtMs;
  }

  recordFrame(written: number, examined: number): void {
    const cost = examined === 0 ? 0 : written / examined;
    this.history.push(cost);
    this.revision++;
    while (this.history.length > 48) this.history.shift();
    this.peakCost = Math.max(this.peakCost, cost);
  }

  draw(ctx: AppContext): void {
    const { compositor, body, machine } = ctx;
    compositor.fillRect(body, COLOUR.panel);
    const left = body.x + 4;
    let y = body.y + 4;

    const row = (label: string, value: string, colour: number): void => {
      compositor.text8(left, y, label, COLOUR.muted, COLOUR.panel);
      compositor.text8(body.x + body.width - 4 - value.length * 8, y, value, colour, COLOUR.panel);
      y += 10;
    };

    row('timer ticks', machine.ticks.toLocaleString('en-US'), COLOUR.text);
    row('instructions', machine.instructions.toLocaleString('en-US'), COLOUR.accent);
    row('memory', `${(machine.ramBytes / (1024 * 1024)).toFixed(0)} MiB`, COLOUR.text);
    row('frame', `${machine.frameMs.toFixed(1)} ms`, COLOUR.text);

    y += 2;
    compositor.text8(left, y, 'pixels changed per frame', COLOUR.muted, COLOUR.panel);
    y += 10;

    const graphHeight = Math.max(8, body.y + body.height - 4 - y);
    compositor.fillRect({ x: left, y, width: body.width - 8, height: graphHeight }, COLOUR.panelDim);
    compositor.strokeRect({ x: left, y, width: body.width - 8, height: graphHeight }, COLOUR.hairline);
    compositor.sparkline(left + 1, y + 1, body.width - 10, graphHeight - 2, this.history, COLOUR.accent);

    const peak = `${(this.peakCost * 100).toFixed(0)}% peak`;
    compositor.text8(left, y + graphHeight + 1, peak, COLOUR.faint, COLOUR.panel);
  }

  onKey(): boolean {
    return false;
  }
}

/** Static information about the system, including what it does not do. */
export class AboutApp implements App {
  readonly id = 'about';
  readonly title = 'About';
  readonly summary = 'What this system is, and is not';
  preferred: Rect = { x: 46, y: 44, width: 232, height: 116 };
  /** Never changes: this window is drawn once and then left alone. */
  revision = 0;

  draw(ctx: AppContext): void {
    const { compositor, body } = ctx;
    compositor.fillRect(body, COLOUR.panel);
    const lines = [
      'VerixOS',
      '',
      `mode      ${ctx.machine.instructions >= 0n ? 'running' : 'stopped'}`,
      `ram       ${(ctx.machine.ramBytes / (1024 * 1024)).toFixed(0)} MiB`,
      `display   ${LAYOUT.width}x${LAYOUT.height} 256 colours`,
      '',
      'This desktop is drawn by the kernel',
      'compositor, from the same font the',
      'text console uses. Every pixel here',
      'came through the VGA adapter.',
    ];
    lines.forEach((line, i) => {
      const colour = i === 0 ? COLOUR.accent : COLOUR.text;
      compositor.text8(body.x + 4, body.y + 4 + i * 9, line, colour, COLOUR.panel);
    });
  }

  onKey(): boolean {
    return false;
  }
}