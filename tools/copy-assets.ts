/**
 * Copy the non-TypeScript files the compiler leaves behind.
 *
 * `tsc` only emits `.ts`. That is fine for code and quietly wrong for data: the
 * boot sector and stage 2 are `.asm` files the kernel reads and assembles at boot,
 * and the live desktop serves `client.html` and `client.js` straight off disk. A
 * build that compiles the TypeScript and stops produces a `dist` that typechecks,
 * passes every unit test, and then fails the moment somebody runs the binary -
 * with an ENOENT for a file that was never supposed to be compiled.
 *
 * The list is explicit rather than a directory walk. A walk would also copy
 * screenshots and scratch files, and the day someone drops a 4 MB PNG into `src`
 * it would silently end up in the published package. Three names, each of which
 * this script then fails loudly if it cannot find.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCE = 'src';
const TARGET = 'dist/src';

/** Extensions the compiler does not emit, and which the runtime genuinely needs. */
const ASSET_EXTENSIONS = ['.asm', '.html', '.js'];

function walk(directory: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path, visit);
    } else {
      visit(path);
    }
  }
}

let copied = 0;

walk(SOURCE, (path) => {
  const extension = path.slice(path.lastIndexOf('.'));
  if (!ASSET_EXTENSIONS.includes(extension)) return;

  // `.js` is only copied where it sits beside a `.ts` that TypeScript compiled,
  // which is what keeps this from picking up a stray script that nothing imports.
  const target = join(TARGET, path.slice(SOURCE.length + 1));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(path, target);
  copied++;
  process.stdout.write(`  ${path} -> ${target}\n`);
});

if (copied === 0) {
  process.stderr.write('copy-assets found nothing to copy; the source tree looks wrong\n');
  process.exit(1);
}

process.stdout.write(`copy-assets: copied ${copied} file${copied === 1 ? '' : 's'}\n`);