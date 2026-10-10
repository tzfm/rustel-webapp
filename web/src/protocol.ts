// The messages between the app page and the engine frame, and the handle of
// the app page for scripted runs. Both sides import this file. The page never
// sends the SharedArrayBuffer, since a buffer does not cross into a frame on
// another site.

/** A place in the score text. Both numbers count from 1, the column in UTF-16 code units. */
export interface Position {
  line: number;
  column: number;
}

/** App page to frame. Each message carries an id, and the frame answers the id.
 * The text is a score: the JavaScript of the pattern language. */
export type ToFrame =
  | { type: "play"; id: number; text: string }
  | { type: "set"; id: number; text: string }
  | { type: "stop"; id: number }
  | { type: "allocations"; id: number };

/** One snapshot of the engine, sent once for each animation frame. */
export interface Telemetry {
  type: "telemetry";
  /** The frame reports `crossOriginIsolated`. */
  isolated: boolean;
  /** State of the AudioContext. */
  audio: string;
  sampleRate: number;
  /** Frames rendered: quanta times 128. */
  frame: number;
  /** Low 32 bits of the generation the renderer plays. */
  generation: number;
  accepted: number;
  stale: number;
  refused: number;
  late: number;
  ringRefused: number;
  roleConflicts: number;
  flushed: number;
  /** Highest absolute sample of the last blocks, 0 to 1. */
  peak: number;
  /** Frames the event ring covers past the audio frame, from the position of
   * the engine. 0 while the engine does not play. */
  ahead: number;
}

/** Why the engine ended its Worker. */
export type Reason = "hang" | "trap" | "death";

/** A score stopped the Worker. The engine ended the Worker and promoted the
 * standby, and the sound goes on when `kept` is true. */
export interface Recovered {
  type: "recovered";
  reason: Reason;
  /** True when a score plays on after the recovery. */
  kept: boolean;
  /** Milliseconds from the last turn of the old Worker to the decision to end
   * the Worker. 0 for a trap or a death. */
  detectMs: number;
  /** Milliseconds from the decision to the first turn of the new Worker. */
  promoteMs: number;
}

/** The line the page shows after a recovery. */
export function recoveryText(reason: Reason, kept: boolean): string {
  const cause = {
    hang: "did not end",
    trap: "made the engine module trap",
    death: "killed the engine Worker",
  }[reason];
  return `A score ${cause}. ${kept ? "The earlier score plays on." : "No score plays."}`;
}

/** Frame to app page. */
export type FromFrame =
  | { type: "done"; id: number; generation: number }
  /** The engine refused the message. The position is in the score text, when the refusal has one. */
  | { type: "failed"; id: number; error: string; position?: Position }
  | { type: "allocations"; id: number; count: number }
  | Recovered
  /** The engine cannot run. The page stops. */
  | { type: "fatal"; error: string }
  | Telemetry;

/** The error of a refused message. The position is set when the answer has one. */
export type Refusal = Error & { position?: Position };

/** The handle of the app page for scripted runs: `window.__rustelBench`. */
export interface Bench {
  /** Puts the score text in the editor and sets the score. Resolves with the
   * generation, or rejects with the refusal. */
  evaluate(text: string): Promise<number>;
  /** Plays the text of the editor, or puts the text in the editor first. */
  play(text?: string): Promise<void>;
  stop(): Promise<void>;
  /** The latest telemetry object, or null before the engine runs. */
  telemetry(): Telemetry | null;
  /** The latest recovery, or null when none happened. */
  recovery(): Recovered | null;
  /** Resolves with the count of allocations the renderer made while rendering. */
  allocations(): Promise<number>;
}

declare global {
  interface Window {
    __rustelBench: Bench;
  }
}
