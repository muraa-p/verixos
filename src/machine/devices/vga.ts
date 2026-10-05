/**
 * VerixOS - VGA display adapter.
 *
 * Models the IBM VGA / compatible adapter register set: the CRTC, the
 * sequencer, the graphics controller, the attribute controller, the misc
 * output register, the feature control register and the 6-bit DAC palette.
 *
 * Two classes of display mode are implemented faithfully:
 *
 *  - **Text mode (0x03)**: 80x25 cells of character plus attribute, 16 colours,
 *    at 0xB8000. Attributes (blink, background intensity, 8-colour and
 *    16-colour foreground) are all decoded.
 *  - **Linear graphics modes (0x13 and Mode X)**: 8 bits per pixel with a
 *    256-entry palette, at 0xA0000. Mode X is the same geometry as 0x13 but
 *    with a 320-byte scanline, which is what a 320-pixel-wide linear layout
 *    requires and what makes row addressing cheap for the blitter.
 *
 * Planar 4-bit modes (0x0D, 0x0E, 0x12) are decoded for host rendering. They
 * are implemented because the guest can select them, and silently rendering
 * garbage for a mode it selected would be worse than not supporting it.
 *
 * Source: VGA hardware reference; Intel SDM Vol. 3 for the general I/O
 * programming-model background.
 */

import type { MmioRegion } from '../memory.ts';
import type { PortDevice } from '../io.ts';
import { MemoryMap } from '../memory.ts';
import { GLYPH_HEIGHT, GLYPH_WIDTH, VGA_8X16_FONT, glyph16Offset } from './font.ts';

/** Attribute controller byte in a text cell: blink in the high bit, else background intensity. */
export const TextAttribute = {
  FOREGROUND_MASK: 0x0f,
  BACKGROUND_MASK: 0x70,
  BACKGROUND_SHIFT: 4,
  BLINK_MASK: 0x80,
} as const;

/** The 16 standard EGA/VGA text colours as 0xRRGGBB. */
export const TEXT_PALETTE: readonly number[] = [
  0x000000, // 0 black
  0x0000aa, // 1 blue
  0x00aa00, // 2 green
  0x00aaaa, // 3 cyan
  0xaa0000, // 4 red
  0xaa00aa, // 5 magenta
  0xaa5500, // 6 brown
  0xaaaaaa, // 7 light grey
  0x555555, // 8 dark grey
  0x5555ff, // 9 light blue
  0x55ff55, // 10 light green
  0x55ffff, // 11 light cyan
  0xff5555, // 12 light red
  0xff55ff, // 13 light magenta
  0xffff55, // 14 yellow
  0xffffff, // 15 white
];

/** A single text-mode character cell. */
export interface TextCell {
  char: number;
  foreground: number;
  background: number;
  blink: boolean;
}

/** Description of a supported display mode. */
export interface VideoModeInfo {
  readonly index: number;
  readonly name: string;
  readonly textMode: boolean;
  readonly columns: number;
  readonly rows: number;
  /** Horizontal resolution in pixels. */
  readonly hres: number;
  /** Vertical resolution in pixels. */
  readonly vres: number;
  /** Bits per pixel for graphics modes; 4 for text attribute cells. */
  readonly bpp: number;
  /** True when the pixel data is organised as interleaved bit planes. */
  readonly planar: boolean;
  /** Physical base address of the framebuffer. */
  readonly base: bigint;
  /** Bytes per scanline. For planar modes this is the per-plane stride. */
  readonly stride: number;
  /** Total framebuffer size in bytes. */
  readonly size: number;
  /** Number of DAC entries. */
  readonly paletteEntries: number;
}

export const TEXT_MODE_80X25: VideoModeInfo = {
  index: 0x03,
  name: '80x25 16-colour text',
  textMode: true,
  columns: 80,
  rows: 25,
  hres: 80 * GLYPH_WIDTH,
  vres: 25 * GLYPH_HEIGHT,
  bpp: 4,
  planar: false,
  base: 0x000b_8000n,
  stride: 80 * 2,
  size: 80 * 25 * 2,
  paletteEntries: 16,
};

export const MODE_13H: VideoModeInfo = {
  index: 0x13,
  name: '320x200 256-colour',
  textMode: false,
  columns: 320,
  rows: 200,
  hres: 320,
  vres: 200,
  bpp: 8,
  planar: false,
  base: 0x000a_0000n,
  stride: 320,
  size: 320 * 200,
  paletteEntries: 256,
};

/** Mode X: identical geometry to 0x13 but with an explicit 320-byte scanline. */
export const MODE_X: VideoModeInfo = {
  ...MODE_13H,
  index: 0x13,
  name: '320x200 256-colour (Mode X, 320-byte scanline)',
  stride: 320,
};

/** 640x480 16-colour planar. */
export const MODE_12H: VideoModeInfo = {
  index: 0x12,
  name: '640x480 16-colour planar',
  textMode: false,
  columns: 640,
  rows: 480,
  hres: 640,
  vres: 480,
  bpp: 4,
  planar: true,
  base: 0x000a_0000n,
  stride: 640 / 8,
  size: 640 * 480 / 4,
  paletteEntries: 16,
};

/** 320x200 16-colour planar, the classic EGA mode. */
export const MODE_0EH: VideoModeInfo = {
  index: 0x0e,
  name: '320x200 16-colour planar',
  textMode: false,
  columns: 320,
  rows: 200,
  hres: 320,
  vres: 200,
  bpp: 4,
  planar: true,
  base: 0x000a_0000n,
  stride: 320 / 8,
  size: 320 * 200 / 2,
  paletteEntries: 16,
};

/** Every mode the adapter can be switched into by index. */
export const VIDEO_MODES: readonly VideoModeInfo[] = [
  TEXT_MODE_80X25,
  MODE_12H,
  MODE_0EH,
  MODE_X,
  MODE_13H,
];

/**
 * Largest buffer the adapter must be able to back. All supported modes fit in
 * the standard 128 KiB VGA aperture (0xA0000-0xBFFFF).
 */
const FRAMEBUFFER_BYTES = 0x20000;

const CRTC_PORT = 0x3d4;
const SEQ_PORT = 0x3c4;
const GDC_PORT = 0x3ce;
const ATTR_PORT = 0x3c0;
const MISC_READ_PORT = 0x3cc;
const MISC_WRITE_PORT = 0x3c2;
const FEATURE_PORT = 0x3da;
const DAC_WRITE_INDEX = 0x3c8;
const DAC_DATA_PORT = 0x3c9;
const DAC_READ_INDEX = 0x3c7;
const DAC_STATUS_PORT = 0x3c7;

export class VgaAdapter implements PortDevice, MmioRegion {
  readonly name = 'vga';
  readonly startPort = 0x3b0;
  readonly portCount = 0x2b; // 0x3b0 .. 0x3da

  /**
   * The framebuffer. Guest writes land here through the MMIO region, and the
   * host reads the same bytes to render a screenshot, so what you see is
   * literally what the kernel drew.
   */
  readonly framebuffer = new Uint8Array(FRAMEBUFFER_BYTES);

  /** 256-entry 24-bit palette, as 0xRRGGBB. */
  readonly palette = new Uint32Array(256);
  private readonly dacRaw = new Uint8Array(768);

  private mode: VideoModeInfo = TEXT_MODE_80X25;

  private readonly crtc = new Uint8Array(32);
  private readonly sequencer = new Uint8Array(8);
  private readonly graphicsController = new Uint8Array(16);
  private readonly attribute = new Uint8Array(32);
  private miscOutput = 0x67;

  private crtcIndex = 0;
  private seqIndex = 0;
  private gdcIndex = 0;
  private attrIndex = 0;
  private attrFlipFlop = false;
  private dacIndex = 0;
  private dacComponent = 0;

  /** Increment on every write that can change a pixel, so the host can skip redraws. */
  revision = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.mode = TEXT_MODE_80X25;
    this.crtc.fill(0);
    this.sequencer.fill(0);
    this.graphicsController.fill(0);
    this.attribute.fill(0);
    this.miscOutput = 0x67;
    this.crtcIndex = 0;
    this.seqIndex = 0;
    this.gdcIndex = 0;
    this.attrIndex = 0;
    this.attrFlipFlop = false;
    this.dacIndex = 0;
    this.dacComponent = 0;
    this.framebuffer.fill(0);
    this.loadDefaultPalette();
    this.revision++;
  }

  /**
   * Load the standard VGA power-on palette: the 16 text colours followed by a
   * 6-6-6 colour cube. The cube matters, because mode 0x13's 256 colours are
   * only useful if the guest can program the DAC, and it makes early graphics
   * output look correct before the kernel installs its own palette.
   */
  loadDefaultPalette(): void {
    for (let i = 0; i < 16; i++) {
      const rgb = TEXT_PALETTE[i]!;
      this.dacRaw[i * 3 + 0] = ((rgb >> 16) & 0xff) >> 2;
      this.dacRaw[i * 3 + 1] = ((rgb >> 8) & 0xff) >> 2;
      this.dacRaw[i * 3 + 2] = (rgb & 0xff) >> 2;
      this.palette[i] = rgb;
    }

    // The canonical VGA 6-bit cube: 16 grey levels then a 3x3x3 hue grid at
    // four intensity steps, which is how the original adapter populated 256
    // entries.
    const levels = [0, 0x2d, 0x57, 0x7d, 0xa0, 0xc6, 0xff];
    let index = 16;
    for (let step = 0; step < 15; step++) {
      const on = step % 3 !== 2;
      const scale = Math.floor(step / 3);
      const v = levels[scale]!;
      for (let hue = 0; hue < 3; hue++) {
        const comp = [v, v, v];
        if (on) comp[hue] = 0xff;
        this.dacRaw[index * 3 + 0] = comp[0]! >> 2;
        this.dacRaw[index * 3 + 1] = comp[1]! >> 2;
        this.dacRaw[index * 3 + 2] = comp[2]! >> 2;
        this.palette[index] =
          ((comp[0]! & 0xfc) << 16) | ((comp[1]! & 0xfc) << 8) | (comp[2]! & 0xfc);
        index++;
      }
    }
    // The final three entries are pure white in the original hardware.
    for (; index < 256; index++) {
      this.dacRaw[index * 3 + 0] = 0x3f;
      this.dacRaw[index * 3 + 1] = 0x3f;
      this.dacRaw[index * 3 + 2] = 0x3f;
      this.palette[index] = 0xffffff;
    }
  }

  get currentMode(): VideoModeInfo {
    return this.mode;
  }

  /** Switch to a supported mode by index or by mode descriptor. */
  setMode(mode: VideoModeInfo | number): void {
    const resolved = typeof mode === 'number' ? VIDEO_MODES.find((m) => m.index === mode) : mode;
    if (!resolved) throw new Error(`unsupported video mode: ${mode}`);
    this.mode = resolved;

    this.crtc.fill(0);
    // Horizontal display end (register 0x00) is the active width in characters
    // minus one, and register 0x12 is the scanline count minus one.
    this.crtc[0x00] = resolved.textMode ? resolved.columns - 1 : (resolved.hres / 8) - 1;
    this.crtc[0x12] = resolved.vres - 1;
    this.crtc[0x13] = resolved.textMode ? GLYPH_HEIGHT - 1 : 0;

    // Sequencer: enable the plane/extract enable and set the clock mode.
    this.sequencer[0x01] = 0x00;
    this.sequencer[0x02] = resolved.textMode ? 0x0d : 0x0f;
    this.sequencer[0x04] = resolved.textMode ? 0x00 : 0x01;

    // Graphics controller: mode register selects write-enable planes.
    this.graphicsController[0x05] = resolved.textMode ? 0x00 : resolved.planar ? 0x01 : 0x00;
    this.graphicsController[0x08] = 0xff;
    this.graphicsController[0x09] = 0x00;

    // Misc output: bit 0 selects graphics mode, bit 1 enables colour emulation.
    this.miscOutput = resolved.textMode ? (this.miscOutput & ~0x01) | 0x00 : this.miscOutput | 0x01;

    for (let i = 0; i < 16; i++) this.attribute[i] = i;
    this.attribute[0x04] = 0x01;
    this.attrFlipFlop = false;

    // Clear the framebuffer so stale pixels from the previous mode are not
    // displayed as garbage.
    this.framebuffer.fill(0);
    this.revision++;
  }

  /* ---------------------------------------------------------------------- */
  /* MMIO: the framebuffer aperture                                           */
  /* ---------------------------------------------------------------------- */

  get start(): bigint {
    return this.mode.base;
  }

  get end(): bigint {
    return this.mode.base + BigInt(this.mode.size);
  }

  /** VGA aperture covering both the graphics and text windows. */
  static readonly APERTURE = {
    start: MemoryMap.VGA_WINDOW_START,
    end: MemoryMap.VGA_WINDOW_END,
  };

  read(offset: bigint, widthBytes: number): bigint {
    const base = Number(this.mode.base);
    const addr = base + Number(offset);
    let value = 0n;
    for (let i = widthBytes - 1; i >= 0; i--) {
      value = (value << 8n) | BigInt(this.framebuffer[addr + i] ?? 0);
    }
    return value;
  }

  write(offset: bigint, widthBytes: number, value: bigint): void {
    const base = Number(this.mode.base);
    const addr = base + Number(offset);
    for (let i = 0; i < widthBytes; i++) {
      this.framebuffer[addr + i] = Number((value >> BigInt(8 * i)) & 0xffn);
    }
    this.revision++;
  }

  /* ---------------------------------------------------------------------- */
  /* Text mode access                                                        */
  /* ---------------------------------------------------------------------- */

  /** Read a text cell. Coordinates are character cells, not pixels. */
  getCell(column: number, row: number): TextCell {
    if (!this.mode.textMode) {
      throw new Error('getCell requires a text mode');
    }
    if (column < 0 || column >= this.mode.columns || row < 0 || row >= this.mode.rows) {
      throw new RangeError(`cell (${column},${row}) is outside ${this.mode.columns}x${this.mode.rows}`);
    }
    const index = row * this.mode.columns + column;
    const base = Number(this.mode.base);
    const char = this.framebuffer[base + index * 2] ?? 0x20;
    const attr = this.framebuffer[base + index * 2 + 1] ?? 0x07;
    return {
      char,
      foreground: attr & TextAttribute.FOREGROUND_MASK,
      background: (attr & TextAttribute.BACKGROUND_MASK) >> TextAttribute.BACKGROUND_SHIFT,
      blink: (attr & TextAttribute.BLINK_MASK) !== 0,
    };
  }

  /** Write a text cell. */
  setCell(column: number, row: number, cell: TextCell): void {
    if (!this.mode.textMode) throw new Error('setCell requires a text mode');
    if (column < 0 || column >= this.mode.columns || row < 0 || row >= this.mode.rows) {
      throw new RangeError(`cell (${column},${row}) is outside ${this.mode.columns}x${this.mode.rows}`);
    }
    const index = row * this.mode.columns + column;
    const base = Number(this.mode.base);
    let attr = (cell.foreground & 0x0f) | ((cell.background & 0x07) << TextAttribute.BACKGROUND_SHIFT);
    if (cell.blink || (cell.background & 0x08) !== 0) attr |= TextAttribute.BLINK_MASK;
    this.framebuffer[base + index * 2] = cell.char & 0xff;
    this.framebuffer[base + index * 2 + 1] = attr;
    this.revision++;
  }

  /**
   * Write an ASCII string starting at a cell.
   * Returns the column after the last character written.
   */
  writeText(column: number, row: number, text: string, foreground = 7, background = 0): number {
    let c = column;
    for (const ch of text) {
      if (c >= this.mode.columns) break;
      this.setCell(c, row, { char: ch.codePointAt(0) ?? 0x20, foreground, background, blink: false });
      c++;
    }
    return c;
  }

  /* ---------------------------------------------------------------------- */
  /* Graphics mode access                                                    */
  /* ---------------------------------------------------------------------- */

  /** Plot one pixel in a linear graphics mode. */
  setPixel(x: number, y: number, colour: number): void {
    if (this.mode.textMode) return;
    if (x < 0 || x >= this.mode.hres || y < 0 || y >= this.mode.vres) return;
    if (this.mode.planar) {
      this.setPlanarPixel(x, y, colour);
      return;
    }
    const base = Number(this.mode.base);
    this.framebuffer[base + y * this.mode.stride + x] = colour & 0xff;
    this.revision++;
  }

  getPixel(x: number, y: number): number {
    if (this.mode.textMode || x < 0 || x >= this.mode.hres || y < 0 || y >= this.mode.vres) return 0;
    if (this.mode.planar) return this.getPlanarPixel(x, y);
    const base = Number(this.mode.base);
    return this.framebuffer[base + y * this.mode.stride + x] ?? 0;
  }

  /**
   * Planar pixel write. Four bit planes are interleaved byte-by-byte across the
   * scanline, so pixel `x` lives in plane `x & 3` at bit `7 - (x >> 2)`.
   */
  private setPlanarPixel(x: number, y: number, colour: number): void {
    const base = Number(this.mode.base);
    const plane = x & 3;
    const byteOffset = base + y * this.mode.stride + (x >> 2);
    const bit = 7 - (x >> 2 & 7);
    const current = this.framebuffer[byteOffset] ?? 0;
    const next = (colour & (1 << plane)) !== 0 ? current | (1 << bit) : current & ~(1 << bit);
    this.framebuffer[byteOffset] = next & 0xff;
    this.revision++;
  }

  private getPlanarPixel(x: number, y: number): number {
    const base = Number(this.mode.base);
    const plane = x & 3;
    const byteOffset = base + y * this.mode.stride + (x >> 2);
    const bit = 7 - (x >> 2 & 7);
    const byte = this.framebuffer[byteOffset] ?? 0;
    return (byte >> bit) & 1 ? 1 << plane : 0;
  }

  /** Fill an axis-aligned rectangle. Clipped to the visible area. */
  fillRect(x: number, y: number, width: number, height: number, colour: number): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.mode.hres, x + width);
    const y1 = Math.min(this.mode.vres, y + height);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.setPixel(px, py, colour);
    }
  }

  /** Draw a single-pixel horizontal line, clipped. */
  drawHLine(x: number, y: number, length: number, colour: number): void {
    for (let i = 0; i < length; i++) this.setPixel(x + i, y, colour);
  }

  /** Draw a single-pixel vertical line, clipped. */
  drawVLine(x: number, y: number, length: number, colour: number): void {
    for (let i = 0; i < length; i++) this.setPixel(x, y + i, colour);
  }

  /**
   * Draw a 1-pixel rectangle outline using the built-in line primitives.
   *
   * These operate in palette index space. A desktop that wants theme colours
   * needs `drawRectRgb`, which resolves through the palette, so both paths are
   * offered rather than forcing the caller to remember which one takes indices.
   */
  drawRect(x: number, y: number, width: number, height: number, colour: number, filled = false): void {
    if (filled) {
      this.fillRect(x, y, width, height, colour);
      return;
    }
    if (width <= 0 || height <= 0) return;
    this.drawHLine(x, y, width, colour);
    this.drawHLine(x, y + height - 1, width, colour);
    this.drawVLine(x, y, height, colour);
    this.drawVLine(x + width - 1, y, height, colour);
  }

  /**
   * Resolve an 0xRRGGBB colour to the nearest palette index.
   *
   * The DAC holds 256 entries, so a theme colour may not have an exact index.
   * A full nearest-colour search runs once per colour and is cached, because
   * the desktop re-resolves the same handful of theme colours every frame.
   */
  private readonly colourIndexCache = new Map<number, number>();

  paletteIndexOf(rgb: number): number {
    const key = rgb & 0xffffff;
    const cached = this.colourIndexCache.get(key);
    if (cached !== undefined) return cached;

    const r = (key >> 16) & 0xff;
    const g = (key >> 8) & 0xff;
    const b = key & 0xff;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < 256; i++) {
      const entry = this.palette[i]!;
      // Weighted Euclidean distance, approximating perceptual sensitivity.
      const dr = ((entry >> 16) & 0xff) - r;
      const dg = ((entry >> 8) & 0xff) - g;
      const db = (entry & 0xff) - b;
      const distance = dr * dr * 3 + dg * dg * 6 + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
        if (distance === 0) break;
      }
    }

    this.colourIndexCache.set(key, best);
    return best;
  }

  /** Fill a rectangle with an 0xRRGGBB colour. */
  fillRectRgb(x: number, y: number, width: number, height: number, rgb: number): void {
    this.fillRect(x, y, width, height, this.paletteIndexOf(rgb));
  }

  drawRectRgb(x: number, y: number, width: number, height: number, rgb: number, filled = false): void {
    this.drawRect(x, y, width, height, this.paletteIndexOf(rgb), filled);
  }

  /** Set a DAC entry from a 24-bit colour. */
  setPaletteEntry(index: number, rgb: number): void {
    if (index < 0 || index > 255) throw new RangeError(`palette index out of range: ${index}`);
    this.dacRaw[index * 3 + 0] = ((rgb >> 16) & 0xff) >> 2;
    this.dacRaw[index * 3 + 1] = ((rgb >> 8) & 0xff) >> 2;
    this.dacRaw[index * 3 + 2] = (rgb & 0xff) >> 2;
    this.palette[index] = rgb;
    // Any cached mapping involving this entry is now potentially stale.
    this.colourIndexCache.clear();
    this.revision++;
  }

  /* ---------------------------------------------------------------------- */
  /* Host rendering                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Decode the framebuffer into 0xRRGGBB pixels, for screenshots.
   *
   * Text mode is rasterised through the 8x16 ROM font rather than dumped as
   * raw cell bytes, because a screenshot of raw text cells is not something a
   * human can look at.
   */
  renderToRgb(): Uint32Array {
    const { hres, vres } = this.mode;
    const out = new Uint32Array(hres * vres);
    const fbBase = Number(this.mode.base);

    if (this.mode.textMode) {
      for (let row = 0; row < this.mode.rows; row++) {
        for (let col = 0; col < this.mode.columns; col++) {
          const cell = this.getCell(col, row);
          const fgIndex = cell.foreground;
          const bgIndex = (cell.background & 0x07) | ((cell.blink ? 8 : 0) & 0x08);
          const fg = this.palette[fgIndex] ?? TEXT_PALETTE[fgIndex] ?? 0xffffff;
          const bg = this.palette[bgIndex] ?? TEXT_PALETTE[bgIndex] ?? 0x000000;
          const glyphStart = glyph16Offset(cell.char);
          for (let py = 0; py < GLYPH_HEIGHT; py++) {
            const bits = VGA_8X16_FONT[glyphStart + py] ?? 0;
            for (let px = 0; px < GLYPH_WIDTH; px++) {
              const lit = (bits >> (GLYPH_WIDTH - 1 - px)) & 1;
              const y = row * GLYPH_HEIGHT + py;
              const x = col * GLYPH_WIDTH + px;
              if (x < hres && y < vres) out[y * hres + x] = lit ? fg : bg;
            }
          }
        }
      }
      return out;
    }

    if (this.mode.planar) {
      for (let y = 0; y < vres; y++) {
        for (let x = 0; x < hres; x++) {
          const index = this.getPlanarPixel(x, y);
          out[y * hres + x] = this.palette[index] ?? 0x000000;
        }
      }
      return out;
    }

    for (let y = 0; y < vres; y++) {
      const rowStart = fbBase + y * this.mode.stride;
      for (let x = 0; x < hres; x++) {
        const index = this.framebuffer[rowStart + x] ?? 0;
        out[y * hres + x] = this.palette[index] ?? 0x000000;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Port I/O                                                               */
  /* ---------------------------------------------------------------------- */

  portRead(offset: number): bigint {
    const port = this.startPort + offset;

    switch (port) {
      case ATTR_PORT: {
        // Port 0x3C0 alternates between index and data. The flip-flop
        // determines whether a write sets the index or writes a register.
        if (!this.attrFlipFlop) {
          this.attrFlipFlop = true;
          return BigInt(this.attrIndex);
        }
        this.attrFlipFlop = false;
        return BigInt(this.attribute[this.attrIndex & 0x1f] ?? 0);
      }
      case MISC_READ_PORT:
        return BigInt(this.miscOutput);
      case FEATURE_PORT: {
        // Reading the feature control register returns 0xAA to confirm the
        // adapter is present and toggles the attribute flip-flop back, which is
        // required before any 0x3C0 write.
        this.attrFlipFlop = false;
        return 0xaan;
      }
      case DAC_READ_INDEX:
        return BigInt(this.dacIndex);
      case DAC_STATUS_PORT:
        return BigInt(this.dacComponent);
      default:
        break;
    }

    if (port === CRTC_PORT) return BigInt(this.crtcIndex & 0x1f);
    if (port === CRTC_PORT + 1) return BigInt(this.crtc[this.crtcIndex & 0x1f] ?? 0);
    if (port === SEQ_PORT) return BigInt(this.seqIndex & 7);
    if (port === SEQ_PORT + 1) return BigInt(this.sequencer[this.seqIndex & 7] ?? 0);
    if (port === GDC_PORT) return BigInt(this.gdcIndex & 0x0f);
    if (port === GDC_PORT + 1) return BigInt(this.graphicsController[this.gdcIndex & 0x0f] ?? 0);
    if (port === ATTR_PORT + 1) return BigInt(this.attribute[this.attrIndex & 0x1f] ?? 0);

    return 0xffn;
  }

  portWrite(offset: number, _widthBytes: number, raw: bigint): void {
    const port = this.startPort + offset;
    const value = Number(raw & 0xffn);

    switch (port) {
      case ATTR_PORT: {
        if (!this.attrFlipFlop) {
          this.attrIndex = value & 0x1f;
          this.attrFlipFlop = true;
          return;
        }
        this.attrFlipFlop = false;
        this.attribute[this.attrIndex & 0x1f] = value;
        this.revision++;
        return;
      }
      case MISC_WRITE_PORT:
        this.miscOutput = value;
        this.revision++;
        return;
      case FEATURE_PORT:
        // The feature control register only gates the horizontal retrace and
        // external colour comparators on real hardware; neither is observable
        // here, so the write is accepted and discarded.
        return;
      case CRTC_PORT:
        this.crtcIndex = value & 0x1f;
        return;
      case CRTC_PORT + 1:
        this.crtc[this.crtcIndex & 0x1f] = value;
        return;
      case SEQ_PORT:
        this.seqIndex = value & 7;
        return;
      case SEQ_PORT + 1:
        this.sequencer[this.seqIndex & 7] = value;
        this.revision++;
        return;
      case GDC_PORT:
        this.gdcIndex = value & 0x0f;
        return;
      case GDC_PORT + 1:
        this.graphicsController[this.gdcIndex & 0x0f] = value;
        this.revision++;
        return;
      case DAC_WRITE_INDEX:
        this.dacIndex = value & 0xff;
        this.dacComponent = 0;
        return;
      case DAC_DATA_PORT: {
        this.dacRaw[this.dacIndex * 3 + this.dacComponent] = value & 0x3f;
        this.dacComponent++;
        if (this.dacComponent === 3) {
          const i = this.dacIndex;
          const r = (this.dacRaw[i * 3 + 0]! & 0x3f) << 2;
          const g = (this.dacRaw[i * 3 + 1]! & 0x3f) << 2;
          const b = (this.dacRaw[i * 3 + 2]! & 0x3f) << 2;
          this.palette[i] = (r << 16) | (g << 8) | b;
          this.colourIndexCache.clear();
          this.dacComponent = 0;
          this.dacIndex = (this.dacIndex + 1) & 0xff;
          this.revision++;
        }
        return;
      }
      default:
        break;
    }

    if (port === ATTR_PORT + 1) {
      this.attribute[this.attrIndex & 0x1f] = value;
      this.revision++;
    }
  }

  describe(): string {
    return [
      `${this.name}: mode=0x${this.mode.index.toString(16).padStart(2, '0')} (${this.mode.name})`,
      `resolution=${this.mode.hres}x${this.mode.vres} bpp=${this.mode.bpp} planar=${this.mode.planar}`,
      `crtc00=0x${(this.crtc[0] ?? 0).toString(16)} crtc12=0x${(this.crtc[0x12] ?? 0).toString(16)} misc=0x${this.miscOutput.toString(16)}`,
      `revision=${this.revision}`,
    ].join('\n');
  }
}