// When does a Worker count as hung? The frame page looks at the turn count of
// the Worker every 20 ms and asks this function. The function reads no clock and
// no buffer, so Node tests the function.
//
// The rule: a Worker hangs when two looks see the same turn count, the looks are
// at least `HANG_MS` apart, and the Worker is busy. A look which comes after a
// long pause is a first look only. The pause is the timer of the frame page,
// which a background tab slows, and the pause says nothing about the Worker. The
// look after the pause starts the clock and cannot fire. A look after a long
// pause with a higher count shows a Worker which runs.

/** Milliseconds between two looks with the same turn count after which a busy Worker counts as hung. */
export const HANG_MS = 1000;
/** Milliseconds between two looks after which the later look follows a pause. The timer looks every 20 ms. */
export const PAUSE_MS = 250;

/** What the frame page remembers between two looks. */
export interface Pulse {
  /** The turn count at the last look. */
  turns: number;
  /** The time the clock of the count started: the last change, or the first look after a pause. */
  since: number;
  /** The time of the last look. */
  seen: number;
  /** True after a look which followed a pause and saw the same count. */
  armed: boolean;
}

export interface Look {
  pulse: Pulse;
  hung: boolean;
}

/** The pulse of a first look. */
export function pulseAt(turns: number, now: number): Pulse {
  return { turns, since: now, seen: now, armed: false };
}

/**
 * One look at the Worker. `busy` is true while the engine plays or a score
 * evaluates. An idle Worker has no work which hangs, so the time of an idle look
 * does not count.
 */
export function look(pulse: Pulse, turns: number, now: number, busy: boolean): Look {
  if (turns !== pulse.turns || !busy) {
    return { pulse: pulseAt(turns, now), hung: false };
  }
  if (now - pulse.seen > PAUSE_MS && !pulse.armed) {
    return { pulse: { turns, since: now, seen: now, armed: true }, hung: false };
  }
  return { pulse: { ...pulse, seen: now }, hung: now - pulse.since >= HANG_MS };
}
