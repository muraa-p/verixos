/**
 * VerixOS - the boot image.
 *
 * Builds the disk image the firmware boots: stage 1 at LBA 0, stage 2 following
 * it, and nothing else. Both stages are assembled by VerixOS's own assembler at
 * load time rather than checked in as binaries, so the image cannot drift from
 * the source that produced it - a checked-in 512-byte blob is a blob nobody can
 * read, and a boot path nobody can read is not a boot path.
 *
 * The assertions in `buildBootImage` are on the bytes: a boot sector that is not
 * exactly 512 bytes, or that does not end in 0x55AA, would still "run" on a
 * loader that ignores both, so those are checked rather than assumed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assemble } from '../asm/index.ts';

/** Where the two stages live, relative to this file. */
const SOURCE_DIRECTORY = join(import.meta.dirname, '.');

/** Stage 1 is loaded at the address the BIOS loads it at. */
export const BOOT_LOAD_ADDRESS = 0x7c00n;

/** Stage 2 goes here, which is the conventional address for it. */
export const STAGE2_LOAD_ADDRESS = 0x8000n;

/** The word stage 2 writes when it is ready to hand over. */
export const HANDOFF_ADDRESS = 0x7e00n;
export const HANDOFF_MAGIC = 0xc0de;

/** Sectors per 512-byte block. */
export const SECTORS_PER_STAGE = 4;

export interface BootImage {
  /** The 512-byte boot sector, which is also sector 0 of the disk. */
  readonly bootSector: Uint8Array;
  /** Stage 2's bytes, as assembled. */
  readonly stage2: Uint8Array;
  /** A complete disk image: stage 1 then stage 2, padded to a whole number of sectors. */
  readonly disk: Uint8Array;
  /** The text of the two sources, for `verix boot --show`. */
  readonly sources: { readonly boot: string; readonly stage2: string };
}

/** Read and assemble both stages. */
export function buildBootImage(): BootImage {
  const bootSource = readFileSync(join(SOURCE_DIRECTORY, 'boot.asm'), 'utf8');
  const stage2Source = readFileSync(join(SOURCE_DIRECTORY, 'stage2.asm'), 'utf8');

  const boot = assemble(bootSource, { origin: BOOT_LOAD_ADDRESS, filename: 'boot.asm' });
  const stage2 = assemble(stage2Source, { origin: STAGE2_LOAD_ADDRESS, filename: 'stage2.asm' });

  if (boot.size !== 512) {
    throw new Error(`the boot sector must be exactly 512 bytes, got ${boot.size}`);
  }
  if (boot.bytes[510] !== 0x55 || boot.bytes[511] !== 0xaa) {
    throw new Error('the boot sector does not end in the 0x55AA signature');
  }

  const totalSectors = 1 + SECTORS_PER_STAGE;
  const disk = new Uint8Array(totalSectors * 512);
  disk.set(boot.bytes, 0);
  disk.set(stage2.bytes.subarray(0, SECTORS_PER_STAGE * 512), 512);

  return {
    bootSector: boot.bytes,
    stage2: stage2.bytes,
    disk,
    sources: { boot: bootSource, stage2: stage2Source },
  };
}

/** A hex dump of bytes, for `verix boot --show` and for test failure messages. */
export function hexDump(bytes: Uint8Array, bytesPerLine = 16): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const slice = bytes.subarray(offset, offset + bytesPerLine);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const text = Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(4, '0')}  ${hex.padEnd(bytesPerLine * 3 - 1, ' ')}  |${text}|`);
  }
  return lines.join('\n');
}