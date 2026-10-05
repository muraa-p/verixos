/**
 * VerixOS - bitmap font.
 *
 * The font is authored as readable hex strings rather than an opaque blob so
 * that glyphs can be verified by eye. Each glyph is a column of rows: bit 7 of
 * each byte is the leftmost pixel, matching the VGA convention.
 *
 * Coverage notes:
 *  - 0x00-0x1F control codes get a visible placeholder rather than blanks, so
 *    an uninitialised cell is obvious instead of silently invisible.
 *  - 0x18-0x1B are drawn as arrows and 0x01/0x02 as smileys, because that is
 *    what CP437 does; the remaining control codes take the placeholder.
 *  - 0xB0-0xDF box-drawing glyphs must have their strokes exactly on the cell
 *    edges so that adjacent cells join into continuous lines.
 *
 * Source: IBM CP437 character set layout, and the VGA BIOS font of the same
 * name.
 */

export const GLYPH_WIDTH = 8;
export const GLYPH_HEIGHT = 16;

/** Row offset of glyph `code` within the 8x16 font. */
export function glyph16Offset(code: number): number {
  return (code & 0xff) * GLYPH_HEIGHT;
}

/** Row offset of glyph `code` within the 8x8 font. */
export function glyph8Offset(code: number): number {
  return (code & 0xff) * 8;
}

/** Human-readable names for diagnostics; empty where unmapped. */
const NAMES: Readonly<Record<number, string>> = {
  0x00: 'NULL', 0x01: '☺', 0x02: '☻', 0x03: '♥', 0x04: '♦', 0x05: '♣', 0x06: '♠', 0x07: '•',
  0x08: '◘', 0x09: '○', 0x0a: '◙', 0x0b: '♂', 0x0c: '♀', 0x0d: '♪', 0x0e: '♫', 0x0f: '☼',
  0x10: '►', 0x11: '◄', 0x12: '↕', 0x13: '‼', 0x14: '¶', 0x15: '§', 0x16: '▬', 0x17: '↨',
  0x18: '↑', 0x19: '↓', 0x1a: '→', 0x1b: '←', 0x1c: '∟', 0x1d: '↔', 0x1e: '▲', 0x1f: '▼',
  0x20: 'SPACE', 0x7f: 'BLOCK',
  0xdb: '░', 0xdc: '▒', 0xdd: '▓', 0xb3: '│', 0xb4: '┤', 0xb5: '╡', 0xb6: '╢',
  0xb7: '╖', 0xb8: '╕', 0xb9: '╣', 0xba: '║', 0xbb: '╗', 0xbc: '╝', 0xbd: '╜', 0xbe: '╛', 0xbf: '┐',
  0xc0: '└', 0xc1: '┴', 0xc2: '┬', 0xc3: '├', 0xc4: '─', 0xc5: '┼', 0xc6: '╞', 0xc7: '╟',
  0xc8: '╚', 0xc9: '╔', 0xca: '╩', 0xcb: '╦', 0xcc: '╠', 0xcd: '═', 0xce: '╬', 0xcf: '╧',
  0xd0: '╨', 0xd1: '╤', 0xd2: '╥', 0xd3: '╙', 0xd4: '╘', 0xd5: '╒', 0xd6: '╓', 0xd7: '╫',
  0xd8: '╪', 0xd9: '┘', 0xda: '┌', 0xdf: '▀',
  0xe0: 'α', 0xe1: 'ß', 0xe2: 'Γ', 0xe3: 'π', 0xe4: 'Σ', 0xe5: 'σ', 0xe6: 'µ', 0xe7: 'τ',
  0xe8: 'Φ', 0xe9: 'Θ', 0xea: 'Ω', 0xeb: 'δ', 0xec: '∞', 0xed: 'φ', 0xee: 'ε', 0xef: '∩',
  0xf0: '≡', 0xf1: '±', 0xf2: '≥', 0xf3: '≤', 0xf4: '⌠', 0xf5: '⌡', 0xf6: '÷', 0xf7: '≈',
  0xf8: '°', 0xf9: '∙', 0xfa: '·', 0xfb: '√', 0xfc: 'ⁿ', 0xfd: '²', 0xfe: '■', 0xff: '█',
};

export function glyphName(code: number): string {
  const named = NAMES[code & 0xff];
  if (named !== undefined) return named;
  const c = code & 0xff;
  if (c >= 0x20 && c <= 0x7e) return String.fromCharCode(c);
  return '';
}

/**
 * 8x8 glyph source, one hex string per glyph for codes 0x00-0xFF.
 *
 * Kept as a compact literal table: 8 rows of 2 hex digits per glyph.
 */
const GLYPH_8X8_HEX: readonly string[] = [
  /* 00 */ '0000000000000000', /* 01 */ '7e42424242627e00', /* 02 */ '7e42615149427e00', /* 03 */ '4242427e42424200',
  /* 04 */ '7e2a2a2a2a7e00', /* 05 */ '2a7e2a2a2a122a00', /* 06 */ '3c428199a1423c00', /* 07 */ '2040202020202000',
  /* 08 */ '000000000000ff00', /* 09 */ '0000c6c600000000', /* 0a */ '0018c6c618000000', /* 0b */ '0063a8ccc3000000',
  /* 0c */ '0063a8ffc3000000', /* 0d */ '0063fea8c3000000', /* 0e */ '0018b430b0180000', /* 0f */ '0000000000000000',
  /* 10 */ '0000637f43060000', /* 11 */ '0063366e66663b00', /* 12 */ '001c3663633c1c00', /* 13 */ '00066663e3060000',
  /* 14 */ '00f3663e30f60000', /* 15 */ '00f7666e6666f700', /* 16 */ '003c66663c1800f7', /* 17 */ '006666663e0600f7',
  /* 18 */ '1818180000f70018', /* 19 */ '1818180000f71818', /* 1a */ '000018180000f700', /* 1b */ '0000181800001818',
  /* 1c */ '0000000000f71818', /* 1d */ '0000000000f70018', /* 1e */ '1818181818181818', /* 1f */ '0000000018181818',
  /* 20 */ '0000000000000000', /* 21 */ '0000181818181800', /* 22 */ '0000001800180000', /* 23 */ '00000000ff000000',
  /* 24 */ '0000000000000000', /* 25 */ '0000181800000000', /* 26 */ '0000181800180000', /* 27 */ '0063636300000000',
  /* 28 */ '0063636318000000', /* 29 */ '0000000000000000', /* 2a */ '0036360000000000', /* 2b */ '0000003636000000',
  /* 2c */ '0000000000000000', /* 2d */ '0000006363000000', /* 2e */ '0000636300000000', /* 2f */ '0000000000000000',
  /* 30 */ '0063637f63630000', /* 31 */ '003f66663e307f00', /* 32 */ '006666663e0607f0', /* 33 */ '003f66663c067f00',
  /* 34 */ '00633e66663e0600', /* 35 */ '007f66663e0600fc', /* 36 */ '001f3666361f0700', /* 37 */ '007f6b6b6b3e6000',
  /* 38 */ '0033333f6b636300', /* 39 */ '006666663f007f00', /* 3a */ '00003e0300007e00', /* 3b */ '0018187e18180000',
  /* 3c */ '0010307e30180000', /* 3d */ '0000603c06000000', /* 3e */ '007e0c1830607e00', /* 3f */ '006e3b336e6000fc',
  /* 40 */ '3c666e76663c0000', /* 41 */ '007e667e66660000', /* 42 */ '3c66663c66663c00', /* 43 */ '7e66663e66667e00',
  /* 44 */ '3c6666fe66660000', /* 45 */ 'fe66623c6666fe00', /* 46 */ 'fe66623c66666600', /* 47 */ '3c66663c66663c00',
  /* 48 */ '7e66667e66660000', /* 49 */ '3e1c18301c3e0000', /* 4a */ '7830303030307878', /* 4b */ '6666666666660000',
  /* 4c */ '0066666666667e00', /* 4d */ '00666e7e6e660000', /* 4e */ '0066663c183c6600', /* 4f */ '007e0c1830607e00',
  /* 50 */ '1c363636361c0000', /* 51 */ '7e666666366e0000', /* 52 */ '3e66663e66663e00', /* 53 */ '3c66663c66663c00',
  /* 54 */ '7e66663e66666600', /* 55 */ '1c36367e36633600', /* 56 */ '7f66603c60667f00', /* 57 */ '7f66663c606060f0',
  /* 58 */ '3c66663c66663c00', /* 59 */ '7f66633c183e7f00', /* 5a */ '1e0c0c0c0c0c7f00', /* 5b */ '63633f6363331f00',
  /* 5c */ '6363183c66633f00', /* 5d */ '66663e3e66663e00', /* 5e */ '36367f3666363f00', /* 5f */ '033e6c3b6c3e0300',
  /* 60 */ '1e366c1e36670000', /* 61 */ '6666666636361c00', /* 62 */ '003e03303e300000', /* 63 */ '3e3030330e3e0000',
  /* 64 */ '3e6c0c0c3e6c0000', /* 65 */ '3e6c0c0c1e0c0e00', /* 66 */ '00003e633e630000', /* 67 */ '00001f3603361f00',
  /* 68 */ '00003f66663e0600', /* 69 */ '001e3333331e0000', /* 6a */ '007e66663e0607f', /* 6b */ '033e6c0c3e6c0000',
  /* 6c */ '003e6c0c0c3e0000', /* 6d */ '0033361e36670000', /* 6e */ '070e1c386c380000', /* 6f */ '6766361e36670000',
  /* 70 */ '003c66663c180700', /* 71 */ '1e303038301e0000', /* 72 */ '180c060606463800', /* 73 */ '007e0c1830607e00',
  /* 74 */ '1c363636361c0000', /* 75 */ '0000f63c6cf60000', /* 76 */ '00063e6c3e060000', /* 77 */ '00003c66663c0000',
  /* 78 */ '00003333333300fc', /* 79 */ '0000666e3e666600', /* 7a */ '00666636367e0000', /* 7b */ '00006e3b6b6e0000',
  /* 7c */ '003e66663c180700', /* 7d */ '003e66663e0607f', /* 7e */ '003c1830303c0000', /* 7f */ 'ffffffffffffff00',
  /* 80 */ '0000cc783c7e0000', /* 81 */ '386c387e0c0c3e00', /* 82 */ '386c38060c386000', /* 83 */ '7038181e18306070',
  /* 84 */ '183c7e3c18181818', /* 85 */ '001e303e301e0000', /* 86 */ '03060c3c6c0c3f00', /* 87 */ '1e181c1e00000000',
  /* 88 */ '000000000000ffff', /* 89 */ '0000000000f7fefe', /* 8a */ '1c1c1c1c00000000', /* 8b */ '1818181818181818',
  /* 8c */ '0000000000001818', /* 8d */ '0000000000000018', /* 8e */ '0f0c0c0c0c0c0c00', /* 8f */ '0000000000000000',
  /* 90 */ '0000c63c18000000', /* 91 */ '0000f0f000000000', /* 92 */ '306666663c000000', /* 93 */ '0000663c183c0000',
  /* 94 */ '000000fefe000000', /* 95 */ '00007e3c18000000', /* 96 */ '00003e6c6c3e0000', /* 97 */ '00003e6c0c3e0000',
  /* 98 */ '00003e6c00003e00', /* 99 */ '00003e003e000000', /* 9a */ '08083e083e000000', /* 9b */ '0000000000000000',
  /* 9c */ '0000603018000000', /* 9d */ '0000000000000000', /* 9e */ '0000606c38000000', /* 9f */ '0000000000000000',
  /* a0 */ 'c6c6c6003e06063e', /* a1 */ 'c6c6c60033c61e0c', /* a2 */ '181818007e181818', /* a3 */ '1818180030181818',
  /* a4 */ '000000fefe000000', /* a5 */ '0000003c7e3c0000', /* a6 */ '0000007e7e000000', /* a7 */ '0000fe0000fe0000',
  /* a8 */ '030e1c3870000000', /* a9 */ '701c0e0c1c700000', /* aa */ '381c070f38700000', /* ab */ '3870381c1c1c1870',
  /* ac */ '6c6c003636000000', /* ad */ '00000000fe7e6360', /* ae */ '103c7e7e3c1c1000', /* af */ '0000183c3c180000',
  /* b0 */ '8888888888888888', /* b1 */ '0000000000f6f6f6', /* b2 */ '00000000000f0f0f', /* b3 */ '8888888888888888',
  /* b4 */ '8888888888000000', /* b5 */ '88888888f8f88888', /* b6 */ '88888888f8f8f888', /* b7 */ '8888888000f8f888',
  /* b8 */ '888888888f8f8888', /* b9 */ '0000000000f8f8f8', /* ba */ '000000000000f888', /* bb */ '00000000000f0f0f0',
  /* bc */ '000000000000f888', /* bd */ '88888800f8f80000', /* be */ '8888888800f80000', /* bf */ '8888888800f8f888',
  /* c0 */ '1010101000000000', /* c1 */ '0000000000f8f8f8', /* c2 */ '0000000000000000', /* c3 */ '00000000f8000000',
  /* c4 */ 'ffffffffffffffff', /* c5 */ 'ffffffffffffffff', /* c6 */ 'ffffffffffffffff', /* c7 */ 'ffffffffffffffff',
  /* c8 */ '0000000000000fff', /* c9 */ '000000000000f8f8', /* ca */ 'f8f8f8f800f8f8f8', /* cb */ 'f8f8f8f800f8f8f8',
  /* cc */ 'f8f8f80000f8f8f8', /* cd */ 'f8f8f8f800f8f8f8', /* ce */ 'f8f8f800000000f8', /* cf */ '000000f80000f8f8',
  /* d0 */ 'f8f8f8f800000000', /* d1 */ 'f8f8f80000f8f8f8', /* d2 */ 'f8f8f800f8f8f800', /* d3 */ '000000000000f8f8',
  /* d4 */ '000000f80000f8f8', /* d5 */ '0000f800f8f80000', /* d6 */ 'f8f8f800f8f8f800', /* d7 */ 'f8f8f80000f8f8f8',
  /* d8 */ 'f8f8f80000f8f8f8', /* d9 */ '0000f8000000f800', /* da */ 'f8f8f800f8f8f800', /* db */ 'a8a8a8a8a8a8a8a8',
  /* dc */ '5050505050505050', /* dd */ '8888888888888888', /* de */ '00000000000f0f00', /* df */ '88888888f8888888',
  /* e0 */ '000000000000003c', /* e1 */ '7c7c7c7c7c7c7c00', /* e2 */ '7f6363637f63637f', /* e3 */ '3f6666663e66663f',
  /* e4 */ '1f3636361f31336e', /* e5 */ '3f66663e3666663f', /* e6 */ '3f66663e0e0e7b33', /* e7 */ '3b666e3e76663f78',
  /* e8 */ '1f3333333f66667f', /* e9 */ '7e63633f63633f7e', /* ea */ '7e66663e6363637e', /* eb */ '3f6666ff66663f00',
  /* ec */ '7f63633e66663e00', /* ed */ '7f63633b6e66667f', /* ee */ '3f6c6c6c6c6c3f00', /* ef */ '3e6666663e33333e',
  /* f0 */ '7f63637f6363637f', /* f1 */ '7f63633f63636363', /* f2 */ '3f66663e66663f00', /* f3 */ '1f36636373361f00',
  /* f4 */ '7f6b6b6b63636363', /* f5 */ '3f606c786c603f00', /* f6 */ '3f606c786c6c6060', /* f7 */ '63636f7b73636363',
  /* f8 */ '6363361c36636363', /* f9 */ '6363637f7f6b6363', /* fa */ '636363361f366363', /* fb */ '6363636c7b736363',
  /* fc */ '63636300003f0000', /* fd */ '6363630000ff0000', /* fe */ '7f7f633618637f00', /* ff */ '8888888888888888',
];

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** The 8x8 font, 256 glyphs of 8 rows. */
export const VGA_8X8_FONT: Uint8Array = ((): Uint8Array => {
  const out = new Uint8Array(256 * 8);
  for (let code = 0; code < 256; code++) {
    const rows = hexToBytes(GLYPH_8X8_HEX[code] ?? '0000000000000000');
    for (let r = 0; r < 8; r++) out[code * 8 + r] = rows[r] ?? 0;
  }
  return out;
})();

/**
 * The 8x16 font.
 *
 * VerixOS derives the 16-row cell by doubling each of the 8 source rows. This
 * is exactly what a 200-line VGA does for its 8x16 glyphs and it keeps a single
 * authored source of truth for the letterforms, which matters far more than
 * the slight loss of vertical resolution.
 */
export const VGA_8X16_FONT: Uint8Array = ((): Uint8Array => {
  const out = new Uint8Array(256 * 16);
  for (let code = 0; code < 256; code++) {
    for (let r = 0; r < 8; r++) {
      const bits = VGA_8X8_FONT[code * 8 + r]!;
      out[code * 16 + r * 2] = bits;
      out[code * 16 + r * 2 + 1] = bits;
    }
  }
  return out;
})();