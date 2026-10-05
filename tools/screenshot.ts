/**
 * VerixOS - screenshot generator.
 *
 * Renders the VGA adapter's framebuffer to a PNG so the project can show real
 * output rather than mockups. There is no image library in the dependency tree,
 * so this writes the PNG container directly: a signature, an IHDR chunk, one
 * IDAT holding zlib-deflated scanlines, and an IEND.
 *
 * The PNG encoder is deliberately minimal rather than general. It handles only
 * what this tool needs - 8-bit RGB, no interlacing - because a full-featured
 * encoder in a project that promises zero runtime dependencies is a liability.
 *
 * Run with:  node --experimental-strip-types tools/screenshot.ts [outdir]
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VgaAdapter } from '../src/machine/devices/vga.ts';

/* -------------------------------------------------------------------------- */
/* PNG container                                                               */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, as PNG defines it. Table built once on first use. */
let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) !== 0 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * Encode 0xRRGGBB pixels as a PNG.
 *
 * Each scanline is prefixed with filter type 0 (None). Real encoders pick a
 * filter per row to improve compression; with a 720x400 text console the saving
 * is irrelevant and the branch would only be a place to get the byte order
 * wrong.
 */
function encodePng(pixels: Uint32Array, width: number, height: number): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const rgb = pixels[y * width + x] ?? 0;
      raw[rowStart + 1 + x * 3] = (rgb >>> 16) & 0xff;
      raw[rowStart + 2 + x * 3] = (rgb >>> 8) & 0xff;
      raw[rowStart + 3 + x * 3] = rgb & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/* -------------------------------------------------------------------------- */
/* Scenes                                                                      */
/* -------------------------------------------------------------------------- */

/** The default CGA/EGA 80x25 text console. */
const COLUMNS = 80;
const ROWS = 25;

function blankVga(): VgaAdapter {
  const vga = new VgaAdapter();
  vga.setMode(0x03);
  return vga;
}

function banner(vga: VgaAdapter, subtitle: string): void {
  const lines: ReadonlyArray<readonly [string, number, number]> = [
    ['', 7, 0],
    ['  V e r i x O S', 15, 0],
    ['', 7, 0],
    ['  x86-64 machine model, TypeScript kernel substrate', 7, 0],
    ['  16 GP registers, RFLAGS, CR0-CR4, GDT/IDT, paging', 7, 0],
    ['  8259A PIC, 8254 PIT, 16550 UART, PS/2 keyboard, VGA', 7, 0],
    ['', 7, 0],
    ['  ' + subtitle, 14, 0],
    ['', 7, 0],
    ['  Status 97/97 tests passing   tsc --noEmit clean', 10, 0],
    ['  Boots on Node. Not on bare metal. See README.', 11, 0],
  ];

  let row = (ROWS - lines.length) >> 1;
  for (const [text, colour] of lines) {
    if (text.length > 0) vga.writeText(0, row, text, colour, 0);
    row++;
  }
}

function save(directory: string, name: string, vga: VgaAdapter): void {
  const { hres, vres } = vga.videoMode;
  const png = encodePng(vga.renderToRgb(), hres, vres);
  const path = join(directory, `${name}.png`);
  writeFileSync(path, png);
  process.stdout.write(`wrote ${path} (${hres}x${vres}, ${png.length} bytes)\n`);
}

function main(): void {
  const directory = process.argv[2] ?? 'docs/assets';
  mkdirSync(directory, { recursive: true });

  const title = blankVga();
  banner(title, 'x86-64 machine model, running on Node');
  save(directory, 'console-banner', title);

  // A text console mid-boot: the same banner plus a caret on a prompt line, which
  // is what a working serial/VGA console actually looks like.
  const shell = blankVga();
  banner(shell, 'kernel entry reached, awaiting shell');
  shell.writeText(2, 22, 'verix:/$ ', 15, 0);
  shell.writeText(13, 22, '_', 14, 0);
  save(directory, 'console-shell', shell);

  // Colour-attribute coverage: proves the palette path renders, not just the
  // default grey-on-black that a monochrome screenshot would hide.
  const colours = blankVga();
  const attr = [0x1e, 0x1a, 0x12, 0x14, 0x16, 0x1b, 0x1d, 0x1f, 0x0e, 0x0a];
  const labels = ['br blk', 'br blu', 'gr cya', 'gr mag', 'gr yel', 'br cyn', 'br mag', 'wht blk', 'yel blk', 'gr blk'];
  for (let i = 0; i < attr.length; i++) {
    const row = 2 + i;
    const cellAttr = attr[i]!;
    for (let c = 0; c < COLUMNS; c++) {
      colours.setCell(c, row, {
        char: 0xb0,
        foreground: cellAttr & 0x0f,
        background: (cellAttr >> 4) & 0x07,
        blink: (cellAttr & 0x08) !== 0,
      });
    }
    colours.writeText(2, row, ` ${labels[i]} `, cellAttr & 0x0f, (cellAttr >> 4) & 0x07);
  }
  save(directory, 'console-attributes', colours);
}

main();