// Evaluates one score text for the Worker: transpile, run the body in the score
// host, apply the tempo, give the pattern to the engine. A score which fails is
// a refusal. The refusal is a value, so the Worker answers the refusal and the
// sound goes on. The file looks up no global name, so Node runs the file in the
// unit tests.

import type { Position } from "../protocol.ts";
import type { PatternObject } from "./score/binding.ts";
import { type ScoreHost, WRAPPER_LINES } from "./score/score.ts";
import type { Place, Transpiled, Transpiler } from "./transpiler.ts";

/** Lines the `Function` constructor puts before the body: `function anonymous(` and `) {`. */
const FUNCTION_LINES = 2;

/** What the evaluator asks of the engine. */
export interface Player {
  /** Sets the tempo. While playing, the tempo takes over after the lead of the engine. */
  setCps(cps: number, frame: number): void;
  /** Makes the pattern behind a handle the playing pattern. Returns the message of a refusal, or null. */
  setScore(handle: number, frame: number): string | null;
}

export type Outcome =
  | { ok: true }
  /** The position is in the score text. A refusal has none when the browser gives none. */
  | { ok: false; error: string; position?: Position };

export interface Parts {
  transpiler: Transpiler;
  host: ScoreHost;
  player: Player;
  /** The audio frame of the next quantum. */
  frame: () => number;
}

function refused(error: string, place?: Place): Outcome {
  if (place === undefined) return { ok: false, error };
  return { ok: false, error, position: { line: place.line + 1, column: place.column + 1 } };
}

function messageOf(error: unknown): string {
  try {
    return String((error as Error | undefined)?.message ?? error);
  } catch {
    return "The score threw a value which has no text.";
  }
}

/** The place of a UTF-8 byte offset in a text. */
export function placeOfByte(text: string, offset: number): Place {
  let line = 0;
  let column = 0;
  let bytes = 0;
  for (let at = 0; at < text.length && bytes < offset; ) {
    const code = text.codePointAt(at) as number;
    const units = code > 0xffff ? 2 : 1;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    at += units;
    if (code === 10) {
      line += 1;
      column = 0;
    } else {
      column += units;
    }
  }
  return { line, column };
}

/** The offset of a place in a text, or -1 when the text has no such place. */
function offsetOf(text: string, place: Place): number {
  let start = 0;
  for (let line = 0; line < place.line; line += 1) {
    const next = text.indexOf("\n", start);
    if (next < 0) return -1;
    start = next + 1;
  }
  const offset = start + place.column;
  return offset <= text.length ? offset : -1;
}

function placeOf(text: string, offset: number): Place {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length - 1, column: offset - (before.lastIndexOf("\n") + 1) };
}

/**
 * The place in `output` of a place in `body`. The body is the output with the
 * final return added, so one run of text is new. A place inside the run moves
 * to the start of the run.
 */
function outputPlace(transpiled: Transpiled, place: Place): Place | undefined {
  const { output, body } = transpiled;
  const added = body.length - output.length;
  let start = 0;
  while (start < output.length && output[start] === body[start]) start += 1;
  if (added < 0 || body.slice(start + added) !== output.slice(start)) return undefined;
  const offset = offsetOf(body, place);
  if (offset < 0) return undefined;
  return placeOf(output, offset < start ? offset : offset < start + added ? start : offset - added);
}

/** What Firefox adds to an error object. */
interface Located {
  fileName?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
}

/**
 * The place in the score text of an error from the score code, or undefined.
 * Firefox gives `fileName`, `lineNumber` and `columnNumber` on an error, both
 * numbers from 1, counted in the source of the `Function` which holds the
 * score. An error from the glue names another file and gets no place. The
 * mapping goes from the line of the `Function` to the line of the body, then
 * through the final return, then through the line map of the transpiler.
 */
export function errorPlace(
  error: unknown,
  transpiled: Transpiled,
  transpiler: Transpiler,
): Place | undefined {
  let found: Located;
  try {
    const { fileName, lineNumber, columnNumber } = error as Located;
    found = { fileName, lineNumber, columnNumber };
  } catch {
    return undefined;
  }
  const { fileName, lineNumber, columnNumber } = found;
  if (
    typeof fileName !== "string" ||
    !fileName.endsWith("> Function") ||
    typeof lineNumber !== "number" ||
    typeof columnNumber !== "number"
  ) {
    return undefined;
  }
  const line = lineNumber - 1 - FUNCTION_LINES - WRAPPER_LINES;
  const printed = outputPlace(transpiled, { line, column: columnNumber - 1 });
  return printed && transpiler.original(printed.line, printed.column);
}

/** Returns a function which evaluates score text. Two calls must not overlap. */
export function createEvaluator(parts: Parts): (text: string) => Promise<Outcome> {
  const { transpiler, host, player, frame } = parts;

  return async function evaluate(text) {
    let transpiled: Transpiled;
    try {
      transpiled = transpiler.run(text);
    } catch (error) {
      return refused(messageOf(error));
    }
    const [first] = transpiled.diagnostics;
    if (first !== undefined) {
      return refused(
        first.message,
        first.offset === null ? undefined : placeOfByte(text, first.offset),
      );
    }

    let pattern: PatternObject;
    try {
      pattern = await host.evaluate(transpiled.body, transpiled.awaits, transpiled.registrations);
    } catch (error) {
      // An exception out of a wasm frame is no exception of the score.
      if (host.binding.poisoned()) throw error;
      return refused(messageOf(error), errorPlace(error, transpiled, transpiler));
    }

    const { cps } = host.names.effects;
    if (cps !== undefined) player.setCps(cps, frame());
    const failure = player.setScore(pattern.handle, frame());
    return failure === null ? { ok: true } : refused(failure);
  };
}
