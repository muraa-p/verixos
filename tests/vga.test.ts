/**
 * VerixOS - VGA adapter tests.
 *
 * These exist because the adapter had a silent failure mode that no assertion
 * caught: the framebuffer was indexed by absolute physical address while being
 * only 128 KiB long, so every write to the text buffer at 0xB8000 landed past the
 * end of the array. `Uint8Array` discards out-of-range writes and reads back
 * zero, so the console accepted text and displayed a blank screen forever. The
 * tests below assert on the *rendered pixels* and on the framebuffer indices, not
 * merely on the absence of an exception, because that is exactly what the bug
 * failed to produce.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODE_13H,
  MODE_X,
  TEXT_MODE_80X25,
  VgaAdapter,
} from '../src/machine/devices/vga.ts';

describe('VGA: aperture addressing', () => {
  it('keeps every framebuffer index inside the array for all supported modes', () => {
    for (const mode of [TEXT_MODE_80X25, MODE_13H, MODE_X]) {
      const vga = new VgaAdapter();
      vga.setMode(mode);
      const windowOffset = Number(vga.videoMode.base) - 0xa_0000;
      assert.ok(
        windowOffset + mode.size <= 0x2_0000,
        `${mode.name}: window ends at aperture offset ${windowOffset + mode.size}, past the 128 KiB framebuffer`,
      );
      assert.ok(windowOffset >= 0, `${mode.name}: window starts before the aperture`);
    }
  });

  it('maps the text buffer to aperture offset 0x18000, not to offset 0', () => {
    // 0xB8000 - 0xA0000. Getting this wrong is what silently blanks the console.
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    assert.equal(Number(vga.videoMode.base) - 0xa_0000, 0x1_8000);
  });

  it('round-trips a text cell through the framebuffer', () => {
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    vga.setCell(3, 4, { char: 0x5a, foreground: 14, background: 1, blink: false });
    const cell = vga.getCell(3, 4);
    assert.equal(cell.char, 0x5a);
    assert.equal(cell.foreground, 14);
    assert.equal(cell.background, 1);
  });

  it('writes the attribute byte alongside the character byte', () => {
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    vga.setCell(0, 0, { char: 0x41, foreground: 12, background: 4, blink: false });
    // Cell (0,0) is the first cell of the text buffer: char then attribute.
    assert.equal(vga.framebuffer[0x1_8000], 0x41);
    assert.equal(vga.framebuffer[0x1_8001], (12 & 0x0f) | ((4 & 0x07) << 4));
  });

  it('treats MMIO offsets as aperture-relative', () => {
    // The bus passes address - region.start, and the region starts at 0xA0000,
    // so the offset the adapter sees is already the framebuffer index.
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    vga.write(0x1_8000n, 2, 0x4142n);
    assert.equal(vga.framebuffer[0x1_8000], 0x42);
    assert.equal(vga.framebuffer[0x1_8001], 0x41);
    assert.equal(vga.read(0x1_8000n, 2), 0x4142n);
  });
});

describe('VGA: rendering', () => {
  it('lights pixels for a written character', () => {
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    vga.writeText(0, 0, 'V', 15, 0);
    const pixels = vga.renderToRgb();
    const lit = pixels.reduce((n, p) => (p !== 0 ? n + 1 : n), 0);
    assert.ok(lit > 0, 'rendering a non-blank cell produced an entirely black screen');
  });

  it('renders foreground and background colours differently', () => {
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    vga.writeText(0, 0, 'A', 15, 1);
    const pixels = vga.renderToRgb();
    const distinct = new Set(pixels).size;
    // Foreground colour, background colour, and ideally an anti-alias-free
    // glyph shape. Two is the floor: at least one lit pixel and one unlit one.
    assert.ok(distinct >= 2, `expected foreground and background to differ, saw ${distinct} colour(s)`);
  });

  it('renders nothing but the background for a space', () => {
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    vga.writeText(0, 0, ' ', 15, 0);
    const pixels = vga.renderToRgb();
    assert.equal(pixels.reduce((n, p) => (p !== 0 ? n + 1 : n), 0), 0);
  });

  it('fills the framebuffer with the mode 0x13 palette indices', () => {
    const vga = new VgaAdapter();
    vga.setMode(MODE_13H);
    vga.setPixel(10, 10, 0xc0);
    assert.equal(vga.getPixel(10, 10), 0xc0);
    const pixels = vga.renderToRgb();
    assert.equal(pixels[10 * MODE_13H.hres + 10], vga.palette[0xc0]);
  });

  it('addresses planar pixels through interleaved bit planes', () => {
    const vga = new VgaAdapter();
    vga.setMode(MODE_X);
    vga.setPixel(4, 0, 0x0f);
    assert.equal(vga.getPixel(4, 0), 0x0f);
    vga.setPixel(4, 0, 0x01);
    assert.equal(vga.getPixel(4, 0), 0x01);
    assert.equal(vga.getPixel(5, 0), 0x00);
  });

  it('ignores pixel writes in text mode', () => {
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    vga.setPixel(5, 5, 0xff);
    assert.equal(vga.getPixel(5, 5), 0);
  });

  it('bumps the revision counter so a host renderer can skip redraws', () => {
    const vga = new VgaAdapter();
    vga.setMode(TEXT_MODE_80X25);
    const before = vga.revision;
    vga.writeText(0, 0, 'x');
    assert.ok(vga.revision > before, 'revision did not advance after a visible write');
  });
});