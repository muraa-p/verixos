/**
 * VerixOS - pointer input, hit testing and the shell's direct manipulation.
 *
 * Everything a mouse does to the desktop happens here, and nothing about it is
 * special-cased per window: one hit test decides what is under the pointer, one
 * dispatch decides what that means. That is the whole difference between a
 * window manager and a pile of special cases, and it is why adding an
 * application later needs no changes here at all.
 *
 * ## Why the pointer is drawn by the kernel
 *
 * The BIOS hides the hardware cursor and `int 33h/000Ah` is accepted and ignored,
 * which is exactly what every real mouse driver does in a graphics mode: the
 * guest draws its own pointer so it can be any shape, can blend with the
 * background, and - the reason that matters here - so that moving it does not
 * count as damage.
 *
 * The alternative - saving and restoring the rectangle under the cursor - makes
 * every pointer move damage the screen, and this compositor reports how much of
 * the screen it examined. A compositor whose own cursor inflates that number is
 * reporting a cost it invented, so the pointer is drawn last, into the back
 * buffer, after the damage has already been decided.
 */

import { COLOUR, Compositor, intersects, type Rect } from './compositor.ts';
import { LAYOUT, workArea } from './desktop.ts';
import type { Window } from './desktop.ts';

/** What is under the pointer. */
export type Hit =
  | { kind: 'desktop' }
  | { kind: 'dock'; index: number }
  | { kind: 'start-button'; index: number }
  | { kind: 'title-bar'; window: Window }
  | { kind: 'window'; window: Window }
  | { kind: 'status-bar' }
  | { kind: 'top-bar' };

/** What the shell is currently doing with the pointer. */
type Drag =
  | { kind: 'none' }
  | { kind: 'window'; window: Window; grabX: number; grabY: number }
  | { kind: 'marquee'; fromX: number; fromY: number; toX: number; toY: number };

/** An item in a menu, and the action it performs. */
export interface MenuItem {
  readonly label: string;
  readonly action: () => void;
  readonly enabled?: boolean;
}

/**
 * The mouse, as far as the shell is concerned.
 *
 * The shell reads the pointer's position from here rather than tracking it from
 * motion events, so that a device which reports absolute coordinates (a `moveTo`
 * from the BIOS, or a synthetic click) and one that reports relative counts both
 * produce the same result. Events say *what happened*; this says *where things
 * are*.
 */
export class Pointer {
  private px = 0;
  private py = 0;
  private buttonMask = 0;
  private moved = false;

  get x(): number {
    return this.px;
  }

  get y(): number {
    return this.py;
  }

  get buttons(): number {
    return this.buttonMask;
  }

  get movedSinceLastRead(): boolean {
    const value = this.moved;
    this.moved = false;
    return value;
  }

  setPosition(x: number, y: number): void {
    this.px = x;
    this.py = y;
    this.moved = true;
  }

  setButton(button: number, down: boolean): void {
    const bit = 1 << button;
    this.buttonMask = down ? this.buttonMask | bit : this.buttonMask & ~bit;
  }

  isDown(button: number): boolean {
    return (this.buttonMask & (1 << button)) !== 0;
  }

  clear(): void {
    this.buttonMask = 0;
  }
}

/**
 * Direct manipulation for one desktop.
 *
 * Kept separate from `Desktop` because it is policy about the pointer and that is
 * a different concern from drawing chrome; the two talk through the small surface
 * `Desktop` exposes rather than sharing fields.
 */
export class ShellInput {
  readonly pointer = new Pointer();

  private drag: Drag = { kind: 'none' };
  private menu: { x: number; y: number; items: MenuItem[] } | undefined;
  private lastClickAt = 0;
  private lastClickTarget = '';
  private wheelNotches = 0;

  private readonly desktop: DesktopLike;

  constructor(desktop: DesktopLike) {
    this.desktop = desktop;
  }

  /** The open context menu, if any, for the desktop to draw. */
  get openMenu(): { x: number; y: number; items: MenuItem[] } | undefined {
    return this.menu;
  }

  get isDragging(): boolean {
    return this.drag.kind !== 'none';
  }

  /** Move the pointer, in screen pixels. */
  move(x: number, y: number): void {
    this.pointer.setPosition(
      clamp(x, 0, LAYOUT.width - 1),
      clamp(y, 0, LAYOUT.height - 1),
    );
    if (this.drag.kind === 'window') {
      const target = this.drag.window;
      // The grab offset is remembered rather than the pointer position, so the
      // window does not jump so that its corner leaps to the cursor.
      target.moveTo({
        ...target.rect,
        x: clamp(this.pointer.x - this.drag.grabX, -target.rect.width + 24, LAYOUT.width - 24),
        y: clamp(this.pointer.y - this.drag.grabY, LAYOUT.topBarHeight, LAYOUT.height - 24),
      });
      this.desktop.damageWindow(target);
    }
    if (this.drag.kind === 'marquee') {
      this.drag.toX = this.pointer.x;
      this.drag.toY = this.pointer.y;
      this.desktop.damageEverything();
    }
    if (this.menu !== undefined) this.desktop.damageMenu();
  }

  /** A button went down. */
  press(button: number, nowMs: number): void {
    this.pointer.setButton(button, true);

    // A click inside an open menu goes to the menu, and a click anywhere else
    // dismisses it. Doing that before anything else is what makes a menu feel
    // modal without it actually being one.
    if (this.menu !== undefined) {
      const chosen = this.hitMenu(this.pointer.x, this.pointer.y);
      const items = this.menu.items;
      this.menu = undefined;
      this.desktop.damageMenu();
      if (chosen !== undefined && items[chosen]?.enabled !== false) items[chosen]?.action();
      return;
    }

    const hit = this.hitTest(this.pointer.x, this.pointer.y);

    switch (hit.kind) {
      case 'start-button':
        this.menu = {
          x: hit.index,
          y: LAYOUT.topBarHeight,
          items: this.startMenuItems(),
        };
        this.desktop.damageMenu();
        return;

      case 'dock': {
        this.desktop.focusApp(hit.index);
        // A second click on the tile that already has focus raises it, which is the
        // one gesture that makes a dock feel like a launcher rather than a legend.
        const key = `dock:${hit.index}`;
        if (this.lastClickTarget === key && nowMs - this.lastClickAt < 400) {
          this.desktop.raiseApp(hit.index);
        }
        this.lastClickTarget = key;
        this.lastClickAt = nowMs;
        return;
      }

      case 'title-bar': {
        this.desktop.focusWindow(hit.window);
        const doubleClick = this.lastClickTarget === 'title' && nowMs - this.lastClickAt < 400;
        this.lastClickTarget = 'title';
        this.lastClickAt = nowMs;
        if (doubleClick) {
          this.desktop.toggleMaximise(hit.window);
          return;
        }
        this.drag = {
          kind: 'window',
          window: hit.window,
          grabX: this.pointer.x - hit.window.rect.x,
          grabY: this.pointer.y - hit.window.rect.y,
        };
        return;
      }

      case 'window':
        this.desktop.focusWindow(hit.window);
        this.lastClickTarget = 'window';
        this.lastClickAt = nowMs;
        return;

      case 'status-bar':
      case 'top-bar':
        return;

      case 'desktop': {
        this.desktop.focusWindow(undefined);
        this.drag = { kind: 'marquee', fromX: this.pointer.x, fromY: this.pointer.y, toX: this.pointer.x, toY: this.pointer.y };
        return;
      }

      default:
        return;
    }
  }

  /** A button came up. */
  release(button: number): void {
    this.pointer.setButton(button, false);
    if (this.drag.kind === 'marquee') this.drag = { kind: 'none' };
    if (button === 0) this.drag = this.drag.kind === 'window' ? { kind: 'none' } : this.drag;
    if (button === 2) this.openContextMenu();
  }

  /** The wheel turned. */
  wheel(notches: number): void {
    this.wheelNotches += notches;
    const hit = this.hitTest(this.pointer.x, this.pointer.y);
    if (hit.kind === 'window' || hit.kind === 'title-bar') {
      this.desktop.scrollWindow(hit.window, this.wheelNotches);
      this.wheelNotches = 0;
    }
  }

  /** Cancel any drag in progress, close any menu and release every button. */
  reset(): void {
    this.drag = { kind: 'none' };
    this.menu = undefined;
    this.lastClickAt = 0;
    this.lastClickTarget = '';
    this.wheelNotches = 0;
    this.pointer.clear();
    this.pointer.setPosition(0, 0);
  }

  /** The items of the start menu, which depend on what is installed. */
  private startMenuItems(): MenuItem[] {
    return this.desktop.appIds().map((_id, index) => ({
      label: this.desktop.appTitle(index),
      action: () => this.desktop.focusApp(index),
    }));
  }

  private openContextMenu(): void {
    const hit = this.hitTest(this.pointer.x, this.pointer.y);
    if (hit.kind === 'title-bar' || hit.kind === 'window') {
      this.desktop.focusWindow(hit.window);
      this.menu = {
        x: this.pointer.x,
        y: this.pointer.y,
        items: [
          { label: 'Bring to front', action: () => this.desktop.raiseWindow(hit.window) },
          { label: 'Maximise', action: () => this.desktop.toggleMaximise(hit.window) },
          { label: 'Close', action: () => this.desktop.closeWindow(hit.window) },
        ],
      };
    } else if (hit.kind === 'desktop') {
      this.menu = {
        x: this.pointer.x,
        y: this.pointer.y,
        items: this.startMenuItems(),
      };
    } else {
      this.menu = undefined;
    }
    this.desktop.damageMenu();
  }

  private hitMenu(x: number, y: number): number | undefined {
    if (this.menu === undefined) return undefined;
    const rows = this.menu.items.length;
    if (x < this.menu.x || x >= this.menu.x + 120) return undefined;
    const top = this.menu.y + 2;
    if (y < top || y >= top + rows * 11) return undefined;
    return Math.floor((y - top) / 11);
  }

  /**
   * Decide what is under the pointer.
   *
   * Windows are tested front to back, because the topmost one under the pointer is
   * the one a click should reach. Testing in creation order instead - which is
   * easier and was the first version - makes an overlapping window unclickable,
   * and the symptom is that the desktop appears frozen.
   */
  hitTest(x: number, y: number): Hit {
    if (x < LAYOUT.dockWidth && y >= LAYOUT.topBarHeight && y < LAYOUT.topBarHeight + workArea().height) {
      const tiles = this.desktop.dockTiles();
      for (const tile of tiles) {
        if (intersects({ x, y, width: 1, height: 1 }, tile)) {
          return { kind: 'dock', index: tile.index };
        }
      }
      return { kind: 'desktop' };
    }

    if (y < LAYOUT.topBarHeight) {
      return x < 40 ? { kind: 'start-button', index: 0 } : { kind: 'top-bar' };
    }

    for (const window of this.desktop.windowsFrontToBack()) {
      const frame = window.frame;
      if (!intersects({ x, y, width: 1, height: 1 }, frame)) continue;
      return intersects({ x, y, width: 1, height: 1 }, window.titleBar)
        ? { kind: 'title-bar', window }
        : { kind: 'window', window };
    }

    if (y >= LAYOUT.height - LAYOUT.statusBarHeight) return { kind: 'status-bar' };
    return { kind: 'desktop' };
  }
}

/** The dock's rectangle. */
export function dockRect(): Rect {
  return { x: 0, y: LAYOUT.topBarHeight, width: LAYOUT.dockWidth, height: workArea().height };
}

/**
 * The surface `ShellInput` needs from the desktop.
 *
 * Declared rather than importing `Desktop` directly so the input layer cannot
 * reach into the desktop's fields, and so a second desktop - a kiosk, a test
 * harness - can be driven by the same input code.
 */
export interface DesktopLike {
  readonly windows: Window[];
  dockTiles(): ReadonlyArray<Rect & { index: number }>;
  windowsFrontToBack(): Window[];
  focusApp(index: number): void;
  focusWindow(window: Window | undefined): void;
  raiseApp(index: number): void;
  raiseWindow(window: Window): void;
  toggleMaximise(window: Window): void;
  closeWindow(window: Window): void;
  scrollWindow(window: Window, notches: number): void;
  appIds(): string[];
  appTitle(index: number): string;
  damageWindow(window: Window): void;
  damageEverything(): void;
  damageMenu(): void;
  drawMenu(compositor: Compositor): void;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

/** A drop-down menu: a raised panel with one row per item. */
export function drawMenu(compositor: Compositor, x: number, y: number, items: MenuItem[]): void {
  const width = 120;
  const height = items.length * 11 + 4;
  const rect: Rect = { x, y, width, height };

  // A shadow, so the menu reads as floating above whatever it was opened over.
  compositor.fillRect({ x: x + 2, y: y + 2, width, height }, COLOUR.bevelDark);
  compositor.bevel(rect, true, COLOUR.panelLight);
  compositor.strokeRect(rect, COLOUR.accent);

  items.forEach((item, index) => {
    const rowY = y + 2 + index * 11;
    compositor.text8(
      x + 8,
      rowY + 2,
      item.label,
      item.enabled === false ? COLOUR.faint : COLOUR.text,
      COLOUR.panelLight,
    );
  });
}
