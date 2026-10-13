/**
 * VerixOS - the window compositor.
 *
 * Everything the desktop draws goes through here, and nothing here knows what a
 * window is. The split is deliberate: a window is a rectangle with a title and a
 * draw callback, and all of that is policy, while this file is the mechanism -
 * a back buffer, a set of damaged rectangles, and a present step that copies the
 * difference to the screen.
 *
 * ## Why damage tracking, and how it is actually measured
 *
 * The compositor keeps two buffers: `back`, which is what the desktop has drawn,
 * and `front`, which is what the adapter's frame buffer is believed to contain.
 * `present()` compares them inside the damaged rectangles only, copies the
 * pixels that differ, and counts them.
 *
 * The count is the point. "This frame only redrew its window" is a claim about
 * work done, and a claim about work done has to be measured rather than
 * asserted - a compositor that redraws everything and reports the same number is
 * indistinguishable from one that does not, unless the number is compared against
 * the screen area. `present()` therefore reports both `written` and `examined`,
 * and the tests assert on the ratio. Copying every pixel always would also be
 * *correct*, which is why a test that only checks the picture is worthless here.
 *
 * ## Why two buffers rather than drawing straight to the screen
 *
 * Drawing straight to the frame buffer makes tearing unavoidable: a window that
 * takes twenty milliseconds to draw is on screen for twenty milliseconds,
 * half-finished. Because the desktop draws every frame into `back` and only the
 * differences reach the adapter, a frame is either entirely old or entirely new.
 */

import { VGA_8X8_FONT, VGA_8X16_FONT } from '../machine/devices/font.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What one `present` did, in pixels. */
export interface PresentStats {
  /** Pixels actually copied to the adapter. */
  readonly written: number;
  /** Pixels compared. Equal to the screen area only after a full redraw. */
  readonly examined: number;
  /** Damaged rectangles before they were consumed. */
  readonly regions: number;
  /** How many times anything at all changed. Zero for a genuinely idle frame. */
  readonly changedFrames: number;
  /** Every frame's `written` total, for the efficiency report. */
  readonly pixelsWrittenTotal: number;
}

/**
 * The Verix palette.
 *
 * Named rather than numbered everywhere in the desktop, because `fillRect(x, y,
 * w, h, 4)` is unreadable and gets mis-transcribed. Indices are assigned in
 * reading order so that the low entries are the ones used most, which keeps the
 * VGA DAC's behaviour on a real adapter unimportant and the theme readable here.
 */
export const COLOUR = {
  /** Desktop background. */
  background: 0,
  /** Window and panel fill. */
  panel: 1,
  /** Lighter panel, for headers and raised areas. */
  panelLight: 2,
  /** Title bar of an unfocused window. */
  panelDim: 3,
  /** The dark half of a bevel. */
  bevelDark: 4,
  /** The light half of a bevel. */
  bevelLight: 5,
  /** Hairline between regions. */
  hairline: 6,
  /** Primary text. */
  text: 7,
  /** Secondary text. */
  muted: 8,
  /** The accent: focused titles, selection, the caret. */
  accent: 9,
  /** A dimmer accent for unfocused use of the same hue. */
  accentDim: 10,
  /** Attention: warnings, the clock's seconds. */
  warn: 11,
  /** Good news: the system's own status. */
  good: 12,
  /** Bad news: faults. */
  bad: 13,
  /** Faint text, for hint lines that should not compete. */
  faint: 14,
  /** Pure white, for the brightest highlight. */
  highlight: 15,
} as const;

export type Colour = (typeof COLOUR)[keyof typeof COLOUR];

/**
 * The 0xRRGGBB values behind the palette above.
 *
 * A cold, low-glare scheme: a near-black ground with a slightly blue cast, panels
 * a step lighter, and one saturated accent. The reasoning is that a 320x200
 * screen carrying a lot of small text is easiest to read when the background is
 * dark and the text is light and slightly desaturated - pure white on pure black
 * makes 8-pixel glyphs look bolder than they are, and bright backgrounds make the
 * whole image vibrate as the compositor repaints.
 */
export const PALETTE: readonly number[] = [
  0x0d1117, // background
  0x161c26, // panel
  0x1f2836, // panelLight
  0x11161f, // panelDim
  0x070a0f, // bevelDark
  0x2c3746, // bevelLight
  0x1a212c, // hairline
  0xd6dde8, // text
  0x8593a6, // muted
  0x35e0d0, // accent
  0x1f8f88, // accentDim
  0xf0a848, // warn
  0x54c86a, // good
  0xe5646a, // bad
  0x4a5568, // faint
  0xffffff, // highlight
];

/**
 * Install the Verix palette into an adapter's DAC.
 *
 * Only the entries the theme defines are written. Overwriting all 256 would be
 * tidier and would also throw away the adapter's default greys, which the boot
 * screen's text mode relies on before this is ever called.
 */
export function installPalette(vga: { setPaletteEntry(index: number, rgb: number): void }): void {
  for (let i = 0; i < PALETTE.length; i++) {
    vga.setPaletteEntry(i, PALETTE[i] ?? 0);
  }
}

export class Compositor {
  /** What the desktop has drawn this frame. Palette indices. */
  readonly back: Uint8Array;
  /** What the adapter's frame buffer is believed to hold. */
  readonly front: Uint8Array;

  private readonly width: number;
  private readonly height: number;

  /** The screen's width, for callers that need to clip against it. */
  get screenWidth(): number {
    return this.width;
  }

  /** The screen's height, for callers that need to clip against it. */
  get screenHeight(): number {
    return this.height;
  }

  private readonly damaged: Rect[] = [];
  private damageAllPending = false;
  private stats: PresentStats;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.back = new Uint8Array(width * height);
    this.front = new Uint8Array(width * height);
    this.stats = {
      written: 0,
      examined: 0,
      regions: 0,
      changedFrames: 0,
      pixelsWrittenTotal: 0,
    };
  }

  /** Total pixels on screen, for the efficiency ratio. */
  get screenArea(): number {
    return this.width * this.height;
  }

  /** Cumulative statistics across every frame so far. */
  get statistics(): PresentStats {
    return this.stats;
  }

  /* ------------------------------------------------------------------ */
  /* Damage                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Mark a rectangle as needing redrawing.
   *
   * Rectangles are merged when they overlap, and only then. Presenting three
   * overlapping copies costs more than presenting their union, so coalescing is
   * worth it - but merging two *distant* rectangles is not, because the bounding
   * box of a window in the top left and a window in the bottom right is most of
   * the screen. Presenting that box examines tens of thousands of pixels to
   * deliver a change in two small places, which is the exact cost damage tracking
   * exists to avoid.
   *
   * So the rule is "merge when the union is not much bigger than the parts". The
   * allowance is a quarter: it absorbs the awkward case of two rectangles that
   * merely touch, without letting two far-apart windows collapse into one
   * enormous region. `examined` in the present statistics is the honest measure
   * of whether this is working.
   */
  damage(rect: Rect): void {
    const clipped = clip(rect, this.width, this.height);
    if (clipped === undefined) return;
    for (let i = 0; i < this.damaged.length; i++) {
      if (!this.mergeable(this.damaged[i]!, clipped)) continue;
      const merged = union(this.damaged[i]!, clipped);
      if (merged === undefined) continue;
      this.damaged[i] = merged;
      this.coalesceFrom(i);
      return;
    }
    this.damaged.push(clipped);
  }

  /** True when merging `b` into `a` does not cost appreciably more to present. */
  private mergeable(a: Rect, b: Rect): boolean {
    const merged = union(a, b);
    if (merged === undefined) return false;
    const combined = area(a) + area(b);
    if (combined === 0) return true;
    return area(merged) <= Math.ceil(combined * 1.25);
  }

  /**
   * Absorb any rectangle that should be merged into entry `i`, until none are left.
   *
   * The index has to be tracked across removals: splicing an element from *before*
   * `i` shifts the target down one, and reading `this.damaged[i]` afterwards
   * without accounting for that reaches past the end of the array. That is not a
   * theoretical concern - it happens on the first frame, when the desktop damages
   * the dock and three window frames at once.
   */
  private coalesceFrom(i: number): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = this.damaged.length - 1; j >= 0; j--) {
        if (j === i) continue;
        const target = this.damaged[i];
        const other = this.damaged[j];
        if (target === undefined || other === undefined) continue;
        if (!this.mergeable(target, other)) continue;
        const merged = union(target, other);
        if (merged === undefined) continue;
        this.damaged[i] = merged;
        this.damaged.splice(j, 1);
        if (j < i) i--;
        changed = true;
      }
    }
  }

  /** Mark the whole screen, for a mode change or a palette change. */
  damageEverything(): void {
    this.damageAllPending = true;
  }

  /** Number of damaged regions waiting to be presented. */
  get damagedRegions(): number {
    return this.damageAllPending ? 1 : this.damaged.length;
  }

  /**
   * Copy the changed pixels to the adapter.
   *
   * Returns what the frame cost. The comparison is against `front`, not against
   * a "did anything draw this frame" flag, so an app that redraws itself
   * identically costs nothing - which is the property that makes the number
   * worth reporting.
   */
  present(target: Uint8Array): PresentStats {
    const regions = this.damageAllPending
      ? [{ x: 0, y: 0, width: this.width, height: this.height }]
      : this.damaged;

    let written = 0;
    let examined = 0;

    for (const rect of regions) {
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        const rowStart = y * this.width;
        for (let x = rect.x; x < rect.x + rect.width; x++) {
          const index = rowStart + x;
          examined++;
          const value = this.back[index]!;
          if (this.front[index] === value) continue;
          this.front[index] = value;
          target[index] = value;
          written++;
        }
      }
    }

    this.damaged.length = 0;
    this.damageAllPending = false;

    this.stats = {
      written,
      examined,
      regions: regions.length,
      changedFrames: written > 0 ? this.stats.changedFrames + 1 : this.stats.changedFrames,
      pixelsWrittenTotal: this.stats.pixelsWrittenTotal + written,
    };
    return this.stats;
  }

  /**
   * Forget what the screen contains.
   *
   * Needed after a mode change, where the adapter's frame buffer has been
   * re-created and no longer matches `front`. Forgetting is the conservative
   * direction: the next present rewrites what it must.
   */
  forgetScreen(): void {
    this.front.fill(0xff);
    this.damageEverything();
  }

  /* ------------------------------------------------------------------ */
  /* Drawing                                                             */
  /* ------------------------------------------------------------------ */

  /** A colour for a pixel, ignoring anything outside the screen. */
  pixel(x: number, y: number, colour: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.back[y * this.width + x] = colour;
  }

  /** Read a pixel. Used by the tests to assert on what was drawn. */
  getPixel(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.back[y * this.width + x] ?? 0;
  }

  fillRect(rect: Rect, colour: number): void {
    const r = clip(rect, this.width, this.height);
    if (r === undefined) return;
    for (let y = r.y; y < r.y + r.height; y++) {
      this.back.fill(colour, y * this.width + r.x, y * this.width + r.x + r.width);
    }
  }

  /** A one-pixel outline, or a filled rectangle when `filled`. */
  strokeRect(rect: Rect, colour: number, filled = false): void {
    if (filled) {
      this.fillRect(rect, colour);
      return;
    }
    const r = clip(rect, this.width, this.height);
    if (r === undefined) return;
    for (let x = r.x; x < r.x + r.width; x++) {
      this.pixel(x, r.y, colour);
      this.pixel(x, r.y + r.height - 1, colour);
    }
    for (let y = r.y; y < r.y + r.height; y++) {
      this.pixel(r.x, y, colour);
      this.pixel(r.x + r.width - 1, y, colour);
    }
  }

  horizontalLine(x: number, y: number, length: number, colour: number): void {
    for (let i = 0; i < length; i++) this.pixel(x + i, y, colour);
  }

  verticalLine(x: number, y: number, length: number, colour: number): void {
    for (let i = 0; i < length; i++) this.pixel(x, y + i, colour);
  }

  /**
   * The classic raised or sunken bevel.
   *
   * A light edge on the top and left and a dark edge on the bottom and right
   * reads as raised, and swapping them reads as pressed. That is the whole
   * visual language, and it is worth having a single place that owns it: windows,
   * buttons and the dock all draw with it, and a per-caller mistake is exactly
   * the kind of thing that makes an interface look assembled rather than
   * designed.
   */
  bevel(rect: Rect, raised: boolean, face: number = COLOUR.panel, edge: number = COLOUR.bevelLight): void {
    const light = raised ? edge : COLOUR.bevelDark;
    const dark = raised ? COLOUR.bevelDark : edge;
    this.fillRect(rect, face);
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      this.pixel(x, rect.y, light);
      this.pixel(x, rect.y + rect.height - 1, dark);
    }
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      this.pixel(rect.x, y, light);
      this.pixel(rect.x + rect.width - 1, y, dark);
    }
  }

  /**
   * Blit an 8x8 glyph.
   *
   * Bits come from the adapter's own 8x8 font table rather than a private copy,
   * so the desktop and the text-mode console render text from the same letterforms
   * - which is what makes switching modes look like one system rather than two.
   */
  glyph(x: number, y: number, code: number, foreground: number, background: number): void {
    const offset = (code & 0xff) * 8;
    for (let row = 0; row < 8; row++) {
      const bits = VGA_8X8_FONT[offset + row] ?? 0;
      const py = y + row;
      if (py < 0 || py >= this.height) continue;
      for (let column = 0; column < 8; column++) {
        const lit = (bits >> (7 - column)) & 1;
        this.pixel(x + column, py, lit ? foreground : background);
      }
    }
  }

  /** Draw a string in the 8x8 font. Returns the x coordinate after the last glyph. */
  text8(x: number, y: number, value: string, foreground: number, background?: number): number {
    let cursor = x;
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0x20;
      if (cursor >= this.width) break;
      if (code === 0x0a) {
        cursor = x;
        continue;
      }
      this.glyph(cursor, y, code, foreground, background ?? this.backgroundAt(y));
      cursor += 8;
    }
    return cursor;
  }

  /** Draw a string in the 8x16 font, for headings. */
  text16(x: number, y: number, value: string, foreground: number, background?: number): number {
    let cursor = x;
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0x20;
      if (cursor >= this.width) break;
      const offset = (code & 0xff) * 16;
      for (let row = 0; row < 16; row++) {
        const bits = VGA_8X16_FONT[offset + row] ?? 0;
        const py = y + row;
        if (py < 0 || py >= this.height) continue;
        for (let column = 0; column < 8; column++) {
          const lit = (bits >> (7 - column)) & 1;
          this.pixel(cursor + column, py, lit ? foreground : background ?? this.backgroundAt(py));
        }
      }
      cursor += 8;
    }
    return cursor;
  }

  /**
   * The colour already at a row, so text can be drawn over an arbitrary surface
   * without the caller having to say what that surface is.
   */
  private backgroundAt(y: number): number {
    if (y < 0 || y >= this.height) return COLOUR.background;
    const x = 0;
    return this.back[y * this.width + x] ?? COLOUR.background;
  }

  /** Draw a one-pixel dotted line, used for table rules and sparkline axes. */
  dottedLine(x: number, y: number, length: number, colour: number, phase = 0): void {
    for (let i = 0; i < length; i++) {
      if (((i + phase) & 1) === 0) this.pixel(x + i, y, colour);
    }
  }

  /**
   * A sparkline: a polyline of `values` normalised into `height` rows.
   *
   * Normalising to the observed maximum rather than to a fixed range is what
   * makes a small change visible. A monitor graph pinned to a fixed ceiling shows
   * a flat line for any workload below the ceiling, which reads as "nothing is
   * happening" even while the numbers move.
   */
  sparkline(x: number, y: number, width: number, height: number, values: readonly number[], colour: number): void {
    if (values.length === 0 || width <= 0 || height <= 0) return;
    let peak = 0;
    for (const value of values) if (value > peak) peak = value;
    if (peak <= 0) peak = 1;

    const step = values.length / width;
    for (let column = 0; column < width; column++) {
      const index = Math.min(values.length - 1, Math.floor(column * step));
      const value = values[index] ?? 0;
      const row = height - 1 - Math.min(height - 1, Math.round((value / peak) * (height - 1)));
      this.pixel(x + column, y + row, colour);
      // Fill below the line so the graph reads as an area rather than a stray
      // line, which is easier to follow at this resolution.
      for (let fill = 1; fill < height - row; fill++) {
        this.pixel(x + column, y + row + fill, colour);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Rectangle arithmetic                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The pointer.
 *
 * Two-tone and punched through the background, which is what makes it readable
 * over both the near-black desktop and a bright window without changing colour as
 * it moves. The middle character is the *fill*: it writes the background colour
 * rather than nothing, which is what stops a thin outline from disappearing
 * against a window whose border is the same colour as the pointer's edge.
 *
 * Spelled out as text rather than as bit masks because the bit-mask form is
 * unreadable and this is a thing a person has to be able to change.
 */
export const CURSOR_ART: readonly string[] = [
  'o...........',
  'ox..........',
  'oxx.........',
  'oxxx........',
  'oxxxx.......',
  'oxxxxx......',
  'oxxxxxx.....',
  'oxxxxxxx....',
  'oxxxxxxxx...',
  'oxxxxxxxxx..',
  'oxxxxxxxx....',
  'oxxxxxxxxx...',
  'oxxxxxx......',
  'oxo.oxx......',
  'ox...oxx.....',
  'o.....ox.....',
  '.......ox....',
  '........o....',
];

/** Where the pointer's tip sits inside the sprite. */
export const CURSOR_HOTSPOT = { x: 0, y: 0 };

export const CURSOR = {
  /** The outline. */
  ink: COLOUR.highlight,
  /** The fill, punched into whatever is underneath. */
  fill: COLOUR.background,
} as const;

/**
 * Draw the pointer, punching a hole through whatever it covers.
 *
 * The pixels under the cursor are not saved and restored. That is not laziness: a
 * desktop whose pointer can leave a trail has to copy and restore a rectangle on
 * every move, and this compositor's damage tracking would then report the pointer
 * as damage everywhere it has been - which would quietly turn the
 * "examines a small fraction of the screen" measurement into a lie.
 */
export function drawCursor(compositor: Compositor, x: number, y: number): void {
  for (let row = 0; row < CURSOR_ART.length; row++) {
    const line = CURSOR_ART[row]!;
    for (let column = 0; column < line.length; column++) {
      const mark = line[column]!;
      if (mark === '.') continue;
      compositor.pixel(x + column, y + row, mark === 'o' ? CURSOR.ink : CURSOR.fill);
    }
  }
}

/**
 * Save and restore the pixels under a software cursor.
 *
 * This is the piece that makes a kernel-drawn pointer possible at all. The back
 * buffer is deliberately never cleared between frames, so the pixels a cursor
 * painted are still there the next frame; damaging the rectangle the pointer has
 * just left is not enough, because "damaged" only means "copy this region to the
 * front buffer", and the region still holds the cursor. Without restoring it, the
 * pointer leaves a permanent smear wherever it goes.
 *
 * The alternative is a real hardware overlay, which this machine model does not
 * have and which no guest could rely on anyway. So the cost is paid honestly: one
 * small read before drawing and one small blit after moving, and the damage the
 * pointer causes is reported as the two rectangles involved - which is the number
 * the tests measure, so the cost is visible rather than assumed.
 */
export class CursorBuffer {
  /** The pixels under the cursor, in palette indices, row by row. */
  private saved = new Uint8Array(0);
  private savedRect: Rect | undefined;

  private readonly compositor: Compositor;
  private readonly width: number;
  private readonly height: number;

  // Declared as fields and assigned rather than as constructor parameter
  // properties, because `erasableSyntaxOnly` forbids them and a project that
  // compiles with type-stripping cannot have them anywhere.
  constructor(compositor: Compositor, width: number, height: number) {
    this.compositor = compositor;
    this.width = width;
    this.height = height;
  }

  /** The rectangle currently covered, which is also the damage to reserve. */
  get rect(): Rect | undefined {
    return this.savedRect;
  }

  /**
   * Put back what was under the cursor, then take a new copy.
   *
   * Called before the pointer is drawn. Doing both in one step is what keeps the
   * code honest: a caller cannot restore without saving, or save without
   * restoring, because there is only one place to do it.
   */
  moveTo(x: number, y: number): void {
    this.restore();

    const rect: Rect = { x, y, width: this.width, height: this.height };
    if (clip(rect, this.compositor.screenWidth, this.compositor.screenHeight) === undefined) return;

    const needed = rect.width * rect.height;
    if (this.saved.length < needed) this.saved = new Uint8Array(needed);
    this.savedRect = rect;

    let offset = 0;
    for (let row = 0; row < rect.height; row++) {
      for (let column = 0; column < rect.width; column++) {
        this.saved[offset++] = this.compositor.getPixel(rect.x + column, rect.y + row);
      }
    }
  }

  /** Put the saved pixels back over the cursor. */
  restore(): void {
    const rect = this.savedRect;
    if (rect === undefined) return;
    let offset = 0;
    for (let row = 0; row < rect.height; row++) {
      for (let column = 0; column < rect.width; column++) {
        this.compositor.pixel(rect.x + column, rect.y + row, this.saved[offset++]!);
      }
    }
    this.savedRect = undefined;
  }
}

/** Clip to the screen, or `undefined` if nothing is visible. */
export function clip(rect: Rect, width: number, height: number): Rect | undefined {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width);
  const y1 = Math.min(height, rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The smallest rectangle containing both, or `undefined` if they do not touch. */
export function union(a: Rect, b: Rect): Rect | undefined {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Area of a rectangle, in pixels. */
export function area(rect: Rect): number {
  return rect.width * rect.height;
}

/** True when the two rectangles share at least one pixel. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Move a rectangle by a delta, clamped so it stays at least partly on screen. */
export function moveRect(rect: Rect, dx: number, dy: number, width: number, height: number): Rect {
  const x = Math.min(Math.max(-rect.width + 16, rect.x + dx), width - 16);
  const y = Math.min(Math.max(0, rect.y + dy), height - 12);
  return { x, y, width: rect.width, height: rect.height };
}