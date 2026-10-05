/**
 * VerixOS - assembler driver.
 *
 * Orchestrates the three stages and owns everything they deliberately do not:
 * symbol addresses, section layout, and the iterative resolution of labels.
 *
 * ## Why this is not a simple two-pass assembler
 *
 * A relative branch's displacement is measured from the end of the instruction,
 * so the displacement's width determines the instruction's length, which
 * determines where every later instruction lives. A `jmp` to a nearby label is
 * two bytes; the same `jmp` to a distant one is five. Since that changes the
 * addresses of everything after it, the choice cannot be made once and cached -
 * a "select short or near, then commit" design is wrong for exactly the programs
 * that branch the most.
 *
 * The fix is to iterate until addresses stop moving, which is what NASM does. This
 * implementation follows the same shape but adds a bound and a divergence report,
 * because an unbounded relaxation loop on a pathological input would hang the
 * assembler instead of failing it. Section layout is folded into the same
 * iteration since section bases depend on sizes, which depend on the encoding,
 * which depends on addresses.
 *
 * ## What "assembled" means here
 *
 * The output is a flat image with one contiguous byte range plus a symbol table.
 * There is no relocation, no object file and no linker, because there is exactly
 * one program to build. `.data` therefore sits immediately after `.text` rather
 * than at a separately loadable address, and `.org` inside a section is the way
 * to place something explicitly.
 *
 * Source: NASM's relaxation algorithm; Intel SDM Vol. 2 for the encodings.
 */

import { tokenize } from './lexer.ts';
import { AsmError } from './lexer.ts';
import { Parser } from './parser.ts';
import { encodeInstruction } from './encoder.ts';
import type { Fixup } from './encoder.ts';
import { CpuMode } from '../arch/decode.ts';
import type { Expression, Statement } from './ast.ts';
import { evaluateExpression } from './ast.ts';

/** Sections, in output order. `.bss` does not exist here; see `parser.ts`. */
export const SECTION_ORDER = ['text', 'data'] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

export interface AssembleOptions {
  /**
   * Base address of the first byte of `.text`.
   *
   * A boot sector passes 0x7C00. The default of 0 suits a flat binary that will be
   * relocated, or a test that only cares about relative structure.
   */
  readonly origin?: bigint;
  /**
   * Maximum relaxation iterations.
   *
   * Each iteration either grows an instruction or moves an address. Real programs
   * settle in two or three; the default of 32 leaves ample headroom while still
   * bounding a divergent input.
   */
  readonly maxIterations?: number;
  /** Included in diagnostics so errors name the source. */
  readonly filename?: string;
}

export interface AssembleResult {
  /** The image: `.text` followed by `.data`. */
  readonly bytes: Uint8Array;
  /** Address of the first byte of `.text`. */
  readonly origin: bigint;
  /** Every label, as an absolute address. */
  readonly symbols: ReadonlyMap<string, bigint>;
  /** Where each section starts, for diagnostics and for image tooling. */
  readonly sections: Readonly<Record<SectionName, bigint>>;
  /** Number of relaxation iterations used. */
  readonly iterations: number;
  /** Total image size in bytes. */
  readonly size: number;
}

/** Per-section mutable state during layout. */
interface SectionState {
  /** Address of the section's first byte, or null when not yet positioned. */
  base: bigint | null;
  /** Bytes emitted so far. */
  bytes: number[];
}

/** Per-statement result of a layout pass. */
interface Placed {
  readonly section: SectionName;
  /** Address of the statement's first byte. */
  readonly address: bigint;
  /** Bytes the statement contributes. */
  readonly length: number;
  /** Relocations to apply once the section bases are final. */
  readonly fixups: readonly Fixup[];
  /**
   * Instruction ordinal within the pass, matching the key used for branch widths.
   *
   * Statements are not identified by array index because `.global` and friends emit
   * nothing while instructions do, so the ordinal counts only instructions - which
   * is exactly the population that has branches.
   */
  readonly ordinal: number;
  /** Set when a branch turned out to need a wider displacement. */
  readonly neededWidth: 8 | 16 | 32 | null;
  /**
   * Whether a wider displacement is available at all.
   *
   * LOOP has none, so a `neededWidth` on such an instruction is unsatisfiable rather
   * than a request. Widening it anyway would produce bytes the CPU decodes as
   * something else entirely.
   */
  readonly branchWidens: boolean;
}

/** A branch whose displacement width has been settled. */
interface BranchRecord {
  /** Displacement width chosen for this branch. */
  width: 8 | 16 | 32;
  /** Statement index within the current pass, used to match across passes. */
  ordinal: number;
}

export class Assembler {
  private readonly statements: readonly Statement[];
  private readonly filename: string;
  private readonly origin: bigint;
  private readonly maxIterations: number;

  /**
   * Symbolic constants from `.equ` and `=`.
   *
   * These are position-independent, so they are resolved once up front rather than
   * each pass. A constant may reference a label, which is only known after layout,
   * so constant *evaluation* is deferred to resolution time while the *mapping* is
   * fixed here.
   */
  private readonly constants = new Map<string, Expression>();

  constructor(source: string, options: AssembleOptions = {}) {
    this.filename = options.filename ?? '<source>';
    this.origin = options.origin ?? 0n;
    this.maxIterations = options.maxIterations ?? 32;
    this.statements = new Parser(tokenize(source, { filename: this.filename }), this.filename).parse();
  }

  assemble(): AssembleResult {
    const symbols = new Map<string, bigint>();
    // Branch widths survive across iterations; that is the whole point of relaxing
    // rather than starting over.
    const branches = new Map<number, BranchRecord>();
    // Addresses of `.local` labels, from the previous iteration. See the note on
    // `resolveIn` in `layoutPass` for why a forward reference needs these.
    let previousLocals: ReadonlyMap<string, readonly bigint[]> = new Map();

    let iterations = 0;
    let previousAddresses = '';

    for (; iterations < this.maxIterations; iterations++) {
      const pass = this.layoutPass(symbols, branches, previousLocals);

      // A stable signature of every address is the cheapest reliable test for
      // convergence. Comparing section sizes alone is not enough: a `.org` can move
      // a section without changing its size.
      const signature = this.addressSignature(pass);
      let widestNeeded: 8 | 16 | 32 | null = null;
      for (const placed of pass.placed) {
        if (placed.neededWidth === null) continue;
        widestNeeded = widestNeeded === null ? placed.neededWidth : maxWidth(widestNeeded, placed.neededWidth);
      }

      if (signature === previousAddresses) {
        // Addresses have stopped moving. If a name is still unresolved, no further
        // pass will resolve it, so it is a real typo rather than a forward reference.
        // Reporting it here - with the name - is the difference between a message
        // pointing at the problem and a timeout.
        const unresolved = [...pass.pending];
        if (unresolved.length > 0) {
          const names = unresolved.map((name) => `'${name}'`).join(', ');
          throw new AsmError(
            `${names} ${unresolved.length === 1 ? 'is' : 'are'} not defined`,
            this.filename,
            0,
            0,
          );
        }
        if (widestNeeded === null) {
          return this.emit(pass, symbols, iterations + 1);
        }
      }

      if (widestNeeded !== null) {
        // Grow every branch that needs it in this pass. Widening is monotone, so the
        // loop cannot oscillate: a branch only ever moves further from short.
        for (const placed of pass.placed) {
          if (placed.ordinal < 0 || placed.neededWidth === null) continue;
          const current = branches.get(placed.ordinal)?.width ?? 8;
          const next = maxWidth(current, placed.neededWidth);
          branches.set(placed.ordinal, { width: next, ordinal: placed.ordinal });
        }
      }

      previousAddresses = signature;
      previousLocals = pass.localOccurrences;
    }

    // Running out of iterations is a real failure, not a warning: emitting a
    // half-relaxed image would place branches and labels at addresses that are
    // wrong, and the resulting binary would crash in a way that points nowhere near
    // the assembler.
    throw new AsmError(
      `the layout did not settle after ${this.maxIterations} iterations; this usually means a branch depends on the size of itself`,
      this.filename,
      0,
      0,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Layout                                                             */
  /* ------------------------------------------------------------------ */

  private layoutPass(
    symbols: Map<string, bigint>,
    branches: Map<number, BranchRecord>,
    previousLocals: ReadonlyMap<string, readonly bigint[]>,
  ): LayoutPass {
    const state: Record<SectionName, SectionState> = {
      text: { base: null, bytes: [] },
      data: { base: null, bytes: [] },
    };

    // Both sections start at the origin on the first pass, which makes every address
    // wrong but consistently so. Relaxation then converges: a branch that appeared
    // short at the origin either stays short once the addresses are real, or widens.
    for (const section of SECTION_ORDER) state[section].base = this.origin;

    const placed: Placed[] = [];
    const labelAddresses = new Map<string, bigint>();
    /**
     * Names used before they were placed.
     *
     * A reference to a label further down the file is ordinary, not an error - it is
     * the only way a boot sector can jump over its own data. So an unknown name is
     * answered with zero and remembered here. The pass converges only once this is
     * empty, which by then means the name genuinely does not exist.
     */
    const pending = new Set<string>();

    /**
     * Addresses of `.local` occurrences seen so far this pass, in program order,
     * keyed by the bare name.
     *
     * `symbols` maps each local label to just its *last* address, which is all a
     * globally unique name needs - but a local label is not globally unique. `jmp
     * .done` inside two different routines must reach a different address each time,
     * and which one it means is positional: the first occurrence at or after the
     * reference, falling back to the most recent one before it. So locals are kept as
     * ordered lists and picked from by address.
     */
    const localOccurrences = new Map<string, bigint[]>();

    let section: SectionName = 'text';
    let mode: CpuMode = CpuMode.LONG64;
    /** Most recent global label, so `.local` names are scoped under it. */
    let localPrefix = '';
    let ordinal = 0;

    const here = (): bigint => state[section].base! + BigInt(state[section].bytes.length);

    /**
     * The first entry of a list that is at or after `at`, or null if there is none.
     *
     * Equal addresses count: a label on the same address as the instruction that
     * references it is a zero-displacement branch, not a reference to the next copy of
     * it.
     */
    const atOrAfter = (list: readonly bigint[], at: bigint): bigint | null => {
      for (const candidate of list) {
        if (candidate >= at) return candidate;
      }
      return null;
    };

    /**
     * The occurrence of a local label a reference at `at` means.
     *
     * Two sources, and choosing between them is the whole difficulty.
     *
     * `localOccurrences` holds the occurrences *this pass has already walked past*, at
     * this pass's own addresses - so it is authoritative for a backward reference, and
     * for a forward reference whose target happens to have been reached already. It is
     * not authoritative for a forward reference whose target comes later in the file,
     * because it cannot tell "no occurrence at or after this point" from "no occurrence
     * at or after this point *yet*". Reading it that way is the bug this function
     * exists to prevent: the most recent earlier occurrence is returned, the layout
     * settles on it, and the branch silently jumps to the wrong copy of the label.
     *
     * `previousLocals` holds every occurrence from the previous pass, so it can answer
     * the forward case - with addresses that are a pass out of date, which the
     * relaxation loop then corrects. It is therefore the fallback for exactly the case
     * the current list cannot judge, and the current list is preferred wherever it can
     * give a real answer.
     *
     * The last entry is what a backward reference with no occurrence ahead of it means,
     * so that case is answered from whichever list is longer-known, never from zero:
     * zero would encode as a displacement back to the start of the image, which is a
     * valid branch to the wrong place.
     */
    const localAt = (name: string, at: bigint): bigint | null => {
      const placed = localOccurrences.get(name);
      if (placed !== undefined && placed.length > 0) {
        const ahead = atOrAfter(placed, at);
        if (ahead !== null) return ahead;

        const known = previousLocals.get(name);
        if (known !== undefined && known.length > 0) {
          return atOrAfter(known, at) ?? known[known.length - 1]!;
        }
        return placed[placed.length - 1]!;
      }

      const known = previousLocals.get(name);
      if (known === undefined || known.length === 0) return null;
      return atOrAfter(known, at) ?? known[known.length - 1]!;
    };

    const resolveIn = (name: string, at: bigint): bigint => {
      // `$` and `$$` are position-dependent and cannot live in the symbol table,
      // because the same expression means a different address in a loop-free
      // second use. The boot sector padding idiom depends on them.
      if (name === '$') return at;
      if (name === '$$') return state[section].base!;

      // A bare `.name` is resolved by position, not by identity. See `localAt`.
      if (name.startsWith('.')) {
        const chosen = localAt(name, at);
        if (chosen !== null) return chosen;
        // No occurrence anywhere. Recorded so convergence waits, and answered with
        // zero so the instruction can still be measured. If the layout settles while
        // this is still pending, the name really does not exist.
        pending.add(name);
        return 0n;
      }

      const found = symbols.get(name);
      if (found !== undefined) return found;
      const constant = this.constants.get(name);
      if (constant !== undefined) return this.evaluateConstant(constant, symbols, undefined, new Set(), at);
      pending.add(name);
      return 0n;
    };

    for (let statementIndex = 0; statementIndex < this.statements.length; statementIndex++) {
      const statement = this.statements[statementIndex]!;
      switch (statement.kind) {
        case 'label': {
          const address = here();
          if (statement.name.startsWith('.')) {
            // Filed under the qualified name only. The bare `.name` is deliberately
            // *not* an entry in `symbols`: it is ambiguous by construction, and the
            // table would then answer with whichever occurrence was placed last
            // rather than the one a given reference means. The list below is what
            // answers for it, keyed by the bare name.
            const qualified = localPrefix + statement.name;
            symbols.set(qualified, address);
            labelAddresses.set(qualified, address);
            const list = localOccurrences.get(statement.name);
            if (list === undefined) localOccurrences.set(statement.name, [address]);
            else list.push(address);
          } else {
            symbols.set(statement.name, address);
            labelAddresses.set(statement.name, address);
            // NASM scopes a leading-dot label under the last plain label, which is
            // what makes `.loop` reusable inside two different routines without
            // colliding.
            localPrefix = statement.name;
          }
          break;
        }

        case 'mode':
          mode = statement.mode === 16 ? CpuMode.REAL16 : statement.mode === 32 ? CpuMode.PROTECTED32 : CpuMode.LONG64;
          break;

        case 'section':
          section = statement.name;
          break;

        case 'equ':
          this.constants.set(statement.name, statement.value);
          break;

        case 'org': {
          const position = here();
          const target = this.evaluateConstant(statement.address, symbols, resolveIn, new Set(), position);
          const cursor = state[section];
          // Compared against where the section has *reached*, not against where it
          // started. Comparing with the base silently accepts `.org` for an address
          // the section has already passed, and the bytes it should have filled are
          // then never written - which for a boot sector means the signature
          // address is never reached.
          if (target < position) {
            throw new AsmError(
              `.org 0x${target.toString(16)} is before the current address 0x${position.toString(16)}; output cannot be moved backwards`,
              this.filename,
              statement.line,
              0,
            );
          }
          // Emitting from a later origin means the gap is real bytes of padding, not
          // an addressing trick, so they are written out.
          this.padTo(cursor, target - cursor.base!, statement.line);
          break;
        }

        case 'align': {
          const boundary = BigInt(statement.boundary);
          const cursor = state[section];
          const position = BigInt(cursor.bytes.length) % boundary;
          const padding = position === 0n ? 0n : boundary - position;
          const fill = statement.fill === null ? 0 : Number(this.evaluateConstant(statement.fill, symbols, resolveIn, new Set(), here()) & 0xffn);
          for (let i = 0n; i < padding; i++) cursor.bytes.push(fill);
          break;
        }

        case 'data': {
          const produced = this.emitData(statement, state[section], symbols, resolveIn);
          placed.push({
            section,
            address: here() - BigInt(produced),
            length: produced,
            fixups: [],
            ordinal: -1,
            neededWidth: null,
            branchWidens: true,
          });
          break;
        }

        case 'reserve': {
          const count = this.evaluateConstant(statement.count, symbols, resolveIn, new Set(), here());
          if (count < 0n) {
            throw new AsmError(`cannot reserve a negative number of elements (${count})`, this.filename, statement.line, 0);
          }
          const fill = statement.fill === null
            ? 0
            : Number(this.evaluateConstant(statement.fill, symbols, resolveIn, new Set(), here()) & 0xffn);
          const cursor = state[section];
          const total = Number(count) * statement.elementSize;
          for (let i = 0; i < total; i++) cursor.bytes.push(fill);
          placed.push({
            section,
            address: here() - BigInt(total),
            length: total,
            fixups: [],
            ordinal: -1,
            neededWidth: null,
            branchWidens: true,
          });
          break;
        }

        case 'instruction': {
          const address = here();
          const branchWidth = branches.get(ordinal)?.width ?? 8;
          const guessesBefore = pending.size;
          const result = encodeInstruction(statement, {
            filename: this.filename,
            line: statement.line,
            mode,
            address,
            resolve: (name) => resolveIn(name, address),
            branchWidth,
          });

          for (const byte of result.bytes) state[section].bytes.push(byte);

          // Decide whether this branch is still short enough. Only a branch that is
          // out of range needs widening; a RIP-relative memory operand has a fixed
          // 4-byte displacement regardless of distance.
          //
          // A distance computed from a placeholder is not evidence of anything, so
          // an instruction that referenced an unplaced symbol is left at its current
          // width and judged again next pass. Widening is monotone, which means a
          // wrong promotion here could never be undone.
          let neededWidth: 8 | 16 | 32 | null = null;
          const guessed = pending.size !== guessesBefore;
          if (result.branchWidth !== null && !guessed) {
            const near: 8 | 16 | 32 = mode === CpuMode.REAL16 ? 16 : 32;
            if (result.branchWidth === 8) {
              for (const fixup of result.fixups) {
                if (fixup.ripRelative) continue;
                const end = address + BigInt(result.bytes.length);
                const delta = fixup.target - end;
                if (delta < -128n || delta > 127n) {
                  neededWidth = near;
                  break;
                }
              }
            } else if (result.branchWidth === 16) {
              for (const fixup of result.fixups) {
                if (fixup.ripRelative) continue;
                const end = address + BigInt(result.bytes.length);
                const delta = fixup.target - end;
                if (delta < -32768n || delta > 32767n) {
                  // In 16-bit real mode there is no 32-bit branch displacement, so
                  // this is genuinely unreachable rather than something to widen to.
                  throw new AsmError(
                    'a branch displacement of more than 16 bits is not representable in 16-bit mode',
                    this.filename,
                    statement.line,
                    0,
                  );
                }
              }
            }

            // An out-of-range displacement on an instruction with no wider form is
            // unreachable code, not something to relax. Reported with the distance
            // and the reachable range, because the fix in the source is almost always
            // to invert the loop or use a short branch, and that is not obvious from
            // the number alone.
            if (neededWidth !== null && !result.branchWidens) {
              let distance = 0n;
              for (const fixup of result.fixups) {
                if (fixup.ripRelative) continue;
                distance = fixup.target - (address + BigInt(result.bytes.length));
              }
              throw new AsmError(
                `'${statement.mnemonic}' reaches ${distance} bytes away but its displacement is a signed byte ` +
                  `(-128 to 127), and it has no wider form to grow into. Shorten the distance, invert the ` +
                  'condition so the branch is not taken, or replace it with a jcc, which does have a near form.',
                this.filename,
                statement.line,
                0,
              );
            }
          }

          placed.push({
            section,
            address,
            length: result.bytes.length,
            fixups: result.fixups,
            ordinal,
            neededWidth,
            branchWidens: result.branchWidens,
          });
          ordinal++;
          break;
        }

        default:
          break;
      }
    }

    return { state, placed, labelAddresses, localOccurrences, pending };
  }

  /* ------------------------------------------------------------------ */
  /* Emission                                                           */
  /* ------------------------------------------------------------------ */

  private emit(pass: LayoutPass, symbols: Map<string, bigint>, iterations: number): AssembleResult {
    const { state } = pass;

    // Lay the sections out end to end. `.text` starts at the origin; `.data`
    // follows it, aligned to 16 bytes so a structure in data is not guaranteed to
    // straddle a boundary by accident.
    const textBase = state.text.base ?? this.origin;
    const textSize = BigInt(state.text.bytes.length);
    const dataBase = state.data.base ?? textBase + textSize + 0x10n - (textSize % 0x10n);

    const bases: Record<SectionName, bigint> = { text: textBase, data: dataBase };

    // Patch every fixup now that the instruction length is final.
    for (const item of pass.placed) {
      const sectionBytes = state[item.section].bytes;
      // A fixup's offset is counted from the start of its own instruction, because
      // the encoder only ever sees the instruction. The instruction in turn sits at
      // `item.address`, which is absolute, so the two have to be added - and the sum
      // has to be taken back into section coordinates before it can index the section
      // buffer. Getting this wrong is invisible in the bytes: the displacement field
      // was already zero, so writing zero over it leaves it looking right.
      const start = Number(item.address - bases[item.section]);
      for (const fixup of item.fixups) {
        // `item.address` and `fixup.target` are both absolute, so the end of the
        // instruction is absolute too. Mixing in a section base here would compute
        // `target - (address - base)`, which is wrong by exactly the base - and at
        // origin 0x1000 that is a displacement 4096 too large, so every forward
        // branch looks out of range while no branch is anywhere near it.
        const end = item.address + BigInt(item.length);
        const target = fixup.target;
        // Both a branch and a RIP-relative displacement are relative to the end of
        // the instruction, which is why they share this code.
        const delta = target - end;
        const width = fixup.width;
        const encoded = BigInt.asUintN(width * 8, delta);
        if (fixup.offset + width > item.length) {
          throw new AsmError(
            `internal error: a ${width}-byte displacement at offset ${fixup.offset} does not fit a ` +
              `${item.length}-byte instruction`,
            this.filename,
            0,
            0,
          );
        }
        for (let i = 0; i < width; i++) {
          const at = start + fixup.offset + i;
          if (at >= sectionBytes.length) {
            throw new AsmError('internal error: a relocation landed outside its section', this.filename, 0, 0);
          }
          sectionBytes[at] = Number((encoded >> BigInt(8 * i)) & 0xffn);
        }
        // A displacement that does not fit its field after all would mean the
        // relaxation loop failed to converge, which is worth catching here rather
        // than emitting silently truncated bytes.
        if (width === 1 && (delta < -128n || delta > 127n)) {
          throw new AsmError(
            `a branch displacement of ${delta} does not fit in a signed byte after relaxation`,
            this.filename,
            0,
            0,
          );
        }
      }
    }

    const total = BigInt(state.text.bytes.length) + BigInt(state.data.bytes.length);
    const image = new Uint8Array(Number(total));
    image.set(state.text.bytes, 0);
    image.set(state.data.bytes, state.text.bytes.length);

    return {
      bytes: image,
      origin: bases.text,
      symbols: new Map(symbols),
      sections: bases,
      iterations,
      size: image.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private emitData(
    statement: Extract<Statement, { kind: 'data' }>,
    cursor: SectionState,
    symbols: Map<string, bigint>,
    resolve: (name: string, at: bigint) => bigint,
  ): number {
    const bytes: number[] = [];
    // The address this statement occupies, which is what `$` means inside it. Taken
    // before anything is appended, because `$` is the position of the statement
    // rather than of any byte within it.
    const at = cursor.base! + BigInt(cursor.bytes.length);
    // The count is evaluated here rather than in the parser because it may depend
    // on the position, which only exists once layout is running. `times 510 - ($ - $$)`
    // is the canonical case.
    const repeat =
      statement.times === null ? 1n : this.evaluateConstant(statement.times, symbols, resolve, new Set(), at);
    if (repeat < 0n) {
      throw new AsmError(`'times' needs a non-negative count, found ${repeat}`, this.filename, statement.line, 0);
    }

    for (let iteration = 0n; iteration < repeat; iteration++) {
      for (const element of statement.elements) {
        if (typeof element === 'string') {
          // Strings are emitted byte by byte from their code points. A code point
          // above 0xFF cannot be represented, and truncating it would produce a
          // silently corrupted string, so it is an error.
          for (const ch of element) {
            const code = ch.codePointAt(0)!;
            if (code > 0xff) {
              throw new AsmError(
                `the character '${ch}' (U+${code.toString(16).toUpperCase().padStart(4, '0')}) has no single-byte encoding`,
                this.filename,
                statement.line,
                0,
              );
            }
            bytes.push(code);
          }
          if (statement.nullTerminate) bytes.push(0);
          continue;
        }

        const value = this.evaluateConstant(element, symbols, resolve, new Set(), at);
        bytes.push(...encodeScalar(value, statement.elementSize, statement.line, this.filename));
      }
    }

    for (const byte of bytes) cursor.bytes.push(byte);
    return bytes.length;
  }

  /**
   * Evaluate an expression once the pass has a symbol table.
   *
   * Three kinds of name can appear, in priority order:
   *
   *   1. `$` and `$$`, which depend on where the expression sits and so are only
   *      answerable through `resolve`.
   *   2. Labels, from `symbols`.
   *   3. Constants from `equ`/`=`, which may themselves mention other constants.
   *
   * A constant may not be defined in terms of a label. Allowing it would make the
   * value of a constant depend on layout, which means re-evaluating it on every
   * pass, and `equ` exists precisely to promise a value that does not move.
   *
   * `at` is the address the expression is being evaluated *at*, which is the only
   * thing `$` can mean. It is passed rather than read from the pass because an
   * expression may be evaluated from several places - a `times` count, a data
   * element, an `.org` target - and each has its own position.
   */
  private evaluateConstant(
    expr: Expression,
    symbols: Map<string, bigint>,
    resolve?: (name: string, at: bigint) => bigint,
    seen: Set<string> = new Set(),
    at: bigint = 0n,
  ): bigint {
    const lookup = (name: string): bigint => this.resolveName(name, symbols, resolve, seen, at);
    return evaluateExpression(expr, lookup, 'an expression');
  }

  private resolveName(
    name: string,
    symbols: Map<string, bigint>,
    resolve: ((name: string, at: bigint) => bigint) | undefined,
    seen: Set<string>,
    at: bigint,
  ): bigint {
    if (resolve !== undefined && (name === '$' || name === '$$')) {
      return resolve(name, at);
    }

    const label = symbols.get(name);
    if (label !== undefined) return label;

    if (this.constants.has(name)) {
      // Cycle detection is what makes the recursion here safe. `a equ b` with
      // `b equ a` would otherwise be a stack overflow rather than a message.
      if (seen.has(name)) {
        throw new AsmError(`'${name}' is defined in terms of itself: ${[...seen, name].join(' -> ')}`, this.filename, 0, 0);
      }
      seen.add(name);
      try {
        return this.evaluateConstant(this.constants.get(name)!, symbols, resolve, seen, at);
      } finally {
        seen.delete(name);
      }
    }

    throw new AsmError(`'${name}' is not defined`, this.filename, 0, 0);
  }

  private padTo(cursor: SectionState, count: bigint, line: number): void {
    if (count < 0n) {
      throw new AsmError(`cannot pad by a negative amount (${count})`, this.filename, line, 0);
    }
    for (let i = BigInt(cursor.bytes.length); i < count; i++) cursor.bytes.push(0);
  }

  /**
   * A stable fingerprint of every address in the current pass.
   *
   * Label addresses are folded in alongside the placed items. They are redundant
   * in the common case - a label sits at the start of the item after it - but not
   * for a label at the very end of a section, and a convergence test that can miss
   * a moving symbol is not a convergence test.
   */
  private addressSignature(pass: LayoutPass): string {
    const items = pass.placed.map((item) => `${item.section}:${item.address.toString(16)}:${item.length}`);
    const labels = [...pass.labelAddresses].map(([name, address]) => `${name}=${address.toString(16)}`);
    // Local labels go in as well. Their qualified names are already in `labelAddresses`,
    // but a bare `.done` resolves by *index*, so the order and count of the
    // occurrences matter to the result and a signature that omitted them could call
    // two passes identical when they resolve references differently.
    const locals: string[] = [];
    for (const [name, list] of pass.localOccurrences) {
      locals.push(`${name}@${list.map((a) => a.toString(16)).join(',')}`);
    }
    return [...items, ...labels, ...locals].join('|');
  }
}

interface LayoutPass {
  readonly state: Record<SectionName, SectionState>;
  readonly placed: readonly Placed[];
  /** Symbol values this pass actually computed, in insertion order. */
  readonly labelAddresses: ReadonlyMap<string, bigint>;
  /** Every `.local` occurrence in program order, keyed by its bare name. */
  readonly localOccurrences: ReadonlyMap<string, readonly bigint[]>;
  /**
   * Names referenced but not yet defined.
   *
   * Non-empty on the first pass whenever a symbol is used before it is declared,
   * which is normal and expected - a boot sector jumps over its own data. The loop
   * must not treat that as convergence, and must not report it as an error until
   * the layout has stopped moving.
   */
  readonly pending: ReadonlySet<string>;
}

function maxWidth(a: 8 | 16 | 32, b: 8 | 16 | 32): 8 | 16 | 32 {
  return a >= b ? a : b;
}

/**
 * Little-endian encoding of one scalar data element.
 *
 * Both the signed and the unsigned range are accepted, because `db 0xFF` and
 * `db -1` name the same byte and assemblers routinely write either. What is
 * rejected is a value needing more bits than the element has, since truncating
 * it would silently produce a different number than the source says.
 */
function encodeScalar(value: bigint, size: 1 | 2 | 4 | 8, line: number, filename: string): number[] {
  const bits = BigInt(size * 8);
  if (value < -(1n << (bits - 1n)) || value > (1n << bits) - 1n) {
    const range = size === 1 ? '0 to 255' : `-${1n << (bits - 1n)} to ${(1n << bits) - 1n}`;
    throw new AsmError(`the value ${value} does not fit in ${size} byte${size === 1 ? '' : 's'} (${range})`, filename, line, 0);
  }
  const v = BigInt.asUintN(size * 8, value);
  const out: number[] = [];
  for (let i = 0; i < size; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

/** Assemble source text into a flat image. */
export function assemble(source: string, options: AssembleOptions = {}): AssembleResult {
  return new Assembler(source, options).assemble();
}

/** Format a byte array as a classic `xxd`-style dump. */
export function hexDump(bytes: Uint8Array, origin: bigint, bytesPerLine = 16): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const chunk = bytes.subarray(offset, offset + bytesPerLine);
    const hex: string[] = [];
    for (let i = 0; i < bytesPerLine; i++) {
      const byte = chunk[i];
      hex.push(byte === undefined ? '   ' : byte.toString(16).padStart(2, '0'));
    }
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${(origin + BigInt(offset)).toString(16).padStart(8, '0')}  ${hex.join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}
