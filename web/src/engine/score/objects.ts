// The objects of the pattern language which a score holds: the exact time
// value `Fraction`, `TimeSpan`, `Hap` and `State`. A hap goes to a predicate
// or to the function of an `arpWith`, a state goes to a custom query, a
// fraction goes to a time predicate. They cross the tape whole, so an exact
// value stays exact: a fraction holds its parts as BigInt.
//
// Source: `install/foundation/values.rs` (the hap, span and state tables) and
// `fraction/` (the parse rules of the engine fraction). Only the methods which
// a score or a rule of the engine needs are here.

const ZERO = 0n;
const ONE = 1n;

export interface Parts {
  s: bigint;
  n: bigint;
  d: bigint;
}

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== ZERO) [a, b] = [b, a % b];
  return a;
}

/** The fraction of a numerator and a denominator, lowest terms, sign on top. */
function normalise(numerator: bigint, denominator: bigint): Parts {
  if (denominator === ZERO) throw new Error("Division by Zero");
  const n = abs(numerator);
  const divisor = gcd(n, abs(denominator));
  const sign = (numerator < ZERO ? -ONE : ONE) * (denominator < ZERO ? -ONE : ONE);
  return { s: sign, n: n / divisor, d: abs(denominator) / divisor };
}

function parseInteger(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (Number.isNaN(Number(value))) throw new Error("Invalid argument");
  if (Number(value) % 1 !== 0) throw new Error("Parameters must be integer");
  return BigInt(value as number);
}

/** The text split into digit runs and single characters, as the engine fraction does. */
function tokens(text: string): string[] {
  const found: string[] = [];
  let digits = "";
  for (const character of text) {
    if (character === "_") continue;
    if (character >= "0" && character <= "9") {
      digits += character;
      continue;
    }
    if (digits !== "") found.push(digits);
    digits = "";
    if (!"\n\r  ".includes(character)) found.push(character);
  }
  if (digits !== "") found.push(digits);
  return found;
}

/** Read a fraction from text: `3/4`, `0.75`, `0.(3)`, `1 1/2`, `-2`. */
function parseString(text: string): Parts {
  const found = tokens(text);
  if (found.length === 0) throw new Error("Invalid argument");
  let at = 0;
  let sign = ONE;
  let v = ZERO;
  let w = ZERO;
  let x = ZERO;
  let y = ONE;
  let z = ONE;
  const number = (token: string | undefined, by: bigint): bigint => {
    if (token === undefined) throw new Error("Invalid argument");
    try {
      return BigInt(token) * by;
    } catch {
      throw new Error("Invalid argument");
    }
  };
  const is = (index: number, expected: string): boolean => found[index] === expected;
  if (is(at, "-")) {
    sign = -ONE;
    at += 1;
  } else if (is(at, "+")) at += 1;
  if (found.length === at + 1) {
    w = number(found[at], sign);
    at += 1;
  } else if (is(at + 1, ".") || is(at, ".")) {
    if (!is(at, ".")) {
      v = number(found[at], sign);
      at += 1;
    }
    at += 1;
    const finite =
      at + 1 === found.length ||
      (is(at + 1, "(") && is(at + 3, ")")) ||
      (is(at + 1, "'") && is(at + 3, "'"));
    if (finite) {
      const token = found[at];
      w = number(token, sign);
      y = 10n ** BigInt(token.length);
      at += 1;
    }
    if ((is(at, "(") && is(at + 2, ")")) || (is(at, "'") && is(at + 2, "'"))) {
      const token = found[at + 1];
      x = number(token, sign);
      z = 10n ** BigInt(token.length) - ONE;
      at += 3;
    }
  } else if (is(at + 1, "/") || is(at + 1, ":")) {
    w = number(found[at], sign);
    y = number(found[at + 2], ONE);
    at += 3;
  } else if (is(at + 3, "/") && is(at + 1, " ")) {
    v = number(found[at], sign);
    w = number(found[at + 2], sign);
    y = number(found[at + 4], ONE);
    at += 5;
  }
  if (found.length > at) throw new Error("Invalid argument");
  const d = y * z;
  if (d === ZERO) throw new Error("Division by Zero");
  const n = x + d * v + z * w;
  return { s: n < ZERO ? -ONE : ONE, n: abs(n), d: abs(d) };
}

/** The limit of the denominators the search for a number visits. */
const LIMIT = 10_000_000;

/**
 * Read a number as a fraction: a walk down the Stern-Brocot tree, in batches
 * of the same step. 1/3 stays 1/3 and not 3333333/10000000.
 */
function parseNumber(input: number): Parts {
  if (Number.isNaN(input)) throw new Error("Invalid argument");
  if (!Number.isFinite(input)) throw new RangeError("cannot convert NaN or Infinity to BigInt");
  const negative = input < 0;
  let value = Math.abs(input);
  let n = ZERO;
  let d = ONE;
  if (value % 1 === 0) {
    n = BigInt(value);
  } else if (value > 0) {
    let z = 1;
    let [a, b, c, e] = [0, 1, 1, 1];
    if (value >= 1) {
      z = 10 ** Math.floor(1 + Math.log10(value));
      value /= z;
    }
    while (b <= LIMIT && e <= LIMIT) {
      const mediant = (a + c) / (b + e);
      if (value === mediant) {
        if (b + e <= LIMIT) [n, d] = [BigInt(a + c), BigInt(b + e)];
        else if (e > b) [n, d] = [BigInt(c), BigInt(e)];
        else [n, d] = [BigInt(a), BigInt(b)];
        break;
      } else if (value > mediant) {
        const ratio = (value * b - a) / (c - value * e);
        const batch = Math.max(
          Math.min(Math.max(Math.floor(ratio) - 1, 1), Math.floor((LIMIT - b) / e) + 1),
          1,
        );
        a += batch * c;
        b += batch * e;
      } else {
        const ratio = (c - value * e) / (value * b - a);
        const batch = Math.max(
          Math.min(Math.max(Math.floor(ratio) - 1, 1), Math.floor((LIMIT - e) / b) + 1),
          1,
        );
        c += batch * a;
        e += batch * b;
      }
      if (b > LIMIT) [n, d] = [BigInt(c), BigInt(e)];
      else [n, d] = [BigInt(a), BigInt(b)];
    }
    n = BigInt(Number(n)) * BigInt(z);
    d = BigInt(Number(d));
  }
  if (d === ZERO) throw new Error("Division by Zero");
  return { s: negative ? -ONE : ONE, n, d };
}

/** The parts of the argument of a fraction method or the constructor. */
export function parse(first?: unknown, second?: unknown): Parts {
  if (first === undefined || first === null) return { s: ONE, n: ZERO, d: ONE };
  if (second !== undefined) {
    const n = parseInteger(first);
    const d = parseInteger(second);
    if (d === ZERO) throw new Error("Division by Zero");
    return { s: n * d < ZERO ? -ONE : ONE, n: abs(n), d: abs(d) };
  }
  if (typeof first === "object") {
    const object = first as Record<string | number, unknown>;
    let n: bigint;
    let d: bigint;
    if ("d" in object && "n" in object) {
      n = BigInt(object.n as bigint);
      d = BigInt(object.d as bigint);
      if ("s" in object) n *= BigInt(object.s as bigint);
    } else if (0 in object) {
      n = BigInt(object[0] as bigint);
      d = 1 in object ? BigInt(object[1] as bigint) : ONE;
    } else {
      throw new Error("Invalid argument");
    }
    if (d === ZERO) throw new Error("Division by Zero");
    return { s: n * d < ZERO ? -ONE : ONE, n: abs(n), d: abs(d) };
  }
  if (typeof first === "number") return parseNumber(first);
  if (typeof first === "string") return parseString(first);
  if (typeof first === "bigint") return { s: first < ZERO ? -ONE : ONE, n: abs(first), d: ONE };
  throw new Error("Invalid argument");
}

/** An exact rational number. The fields are BigInt, the sign is `s`. */
export class Fraction {
  s: bigint;
  n: bigint;
  d: bigint;

  constructor(first?: unknown, second?: unknown) {
    const parts = parse(first, second);
    const fraction = normalise(parts.s * parts.n, parts.d);
    this.s = fraction.s;
    this.n = fraction.n;
    this.d = fraction.d;
  }

  /** A fraction of two BigInt, for a result. */
  static of(numerator: bigint, denominator: bigint): Fraction {
    const fraction = normalise(numerator, denominator);
    return Object.assign(Object.create(Fraction.prototype) as Fraction, fraction);
  }

  abs(): Fraction {
    return Fraction.of(this.n, this.d);
  }

  neg(): Fraction {
    return Fraction.of(-this.s * this.n, this.d);
  }

  add(a?: unknown, b?: unknown): Fraction {
    const p = parse(a, b);
    return Fraction.of(this.s * this.n * p.d + p.s * this.d * p.n, this.d * p.d);
  }

  sub(a?: unknown, b?: unknown): Fraction {
    const p = parse(a, b);
    return Fraction.of(this.s * this.n * p.d - p.s * this.d * p.n, this.d * p.d);
  }

  mul(a?: unknown, b?: unknown): Fraction {
    const p = parse(a, b);
    return Fraction.of(this.s * p.s * this.n * p.n, this.d * p.d);
  }

  div(a?: unknown, b?: unknown): Fraction {
    const p = parse(a, b);
    return Fraction.of(this.s * p.s * this.n * p.d, this.d * p.n);
  }

  mod(a?: unknown, b?: unknown): Fraction {
    if (a === undefined) return Fraction.of((this.s * this.n) % this.d, ONE);
    const p = parse(a, b);
    if (p.n === ZERO && this.d === ZERO) throw new Error("Division by Zero");
    return Fraction.of((this.s * (p.d * this.n)) % (p.n * this.d), p.d * this.d);
  }

  equals(a?: unknown, b?: unknown): boolean {
    const p = parse(a, b);
    return this.s * this.n * p.d === p.s * p.n * this.d;
  }

  compare(a?: unknown, b?: unknown): number {
    const p = parse(a, b);
    const difference = this.s * this.n * p.d - p.s * p.n * this.d;
    return Number(ZERO < difference) - Number(difference < ZERO);
  }

  lt(a?: unknown, b?: unknown): boolean {
    return this.compare(a, b) < 0;
  }

  lte(a?: unknown, b?: unknown): boolean {
    return this.compare(a, b) <= 0;
  }

  gt(a?: unknown, b?: unknown): boolean {
    return this.compare(a, b) > 0;
  }

  gte(a?: unknown, b?: unknown): boolean {
    return this.compare(a, b) >= 0;
  }

  /** The largest whole number at most the value, in steps of `10^-places`. */
  floor(places = 0): Fraction {
    const scale = 10n ** BigInt(places);
    const top = scale * this.s * this.n;
    const quotient = top / this.d;
    const floored = top < ZERO && quotient * this.d !== top ? quotient - ONE : quotient;
    return Fraction.of(floored, scale);
  }

  ceil(places = 0): Fraction {
    const scale = 10n ** BigInt(places);
    const top = scale * this.s * this.n;
    const quotient = top / this.d;
    const ceiled = top > ZERO && quotient * this.d !== top ? quotient + ONE : quotient;
    return Fraction.of(ceiled, scale);
  }

  round(places = 0): Fraction {
    const scale = 10n ** BigInt(places);
    const top = scale * this.s * this.n * 2n + this.d;
    const bottom = this.d * 2n;
    const quotient = top / bottom;
    const rounded = top < ZERO && quotient * bottom !== top ? quotient - ONE : quotient;
    return Fraction.of(rounded, scale);
  }

  /** The nearest double. */
  valueOf(): number {
    return Number(this.s * this.n) / Number(this.d);
  }

  // The methods of the pattern language.

  sam(): Fraction {
    return this.floor();
  }

  nextSam(): Fraction {
    return this.sam().add(1);
  }

  wholeCycle(): TimeSpan {
    return new TimeSpan(this.sam(), this.nextSam());
  }

  cyclePos(): Fraction {
    return this.sub(this.sam());
  }

  eq(other: unknown): boolean {
    return this.compare(other) === 0;
  }

  ne(other: unknown): boolean {
    return this.compare(other) !== 0;
  }

  max(other: Fraction): Fraction {
    return this.gt(other) ? this : other;
  }

  min(other: Fraction): Fraction {
    return this.lt(other) ? this : other;
  }

  show(): string {
    return `${this.s * this.n}/${this.d}`;
  }
}

/** A span of time, from `begin` to `end`. */
export class TimeSpan {
  begin: Fraction;
  end: Fraction;

  constructor(begin?: unknown, end?: unknown) {
    this.begin = new Fraction(begin);
    this.end = new Fraction(end);
  }

  /** The span cut at every cycle line. */
  get spanCycles(): TimeSpan[] {
    const spans: TimeSpan[] = [];
    const { begin, end } = this;
    const endSam = end.sam();
    if (begin.equals(end)) return [new TimeSpan(begin, end)];
    let cursor = begin;
    while (end.gt(cursor)) {
      if (cursor.sam().equals(endSam)) {
        spans.push(new TimeSpan(cursor, this.end));
        break;
      }
      const next = cursor.nextSam();
      spans.push(new TimeSpan(cursor, next));
      cursor = next;
    }
    return spans;
  }

  get duration(): Fraction {
    return this.end.sub(this.begin);
  }

  withTime(map: (time: Fraction) => unknown): TimeSpan {
    if (typeof map !== "function") throw new TypeError("f is not a function");
    return new TimeSpan(map(this.begin), map(this.end));
  }

  /** The part both spans hold, or `undefined` when they only touch. */
  intersection(other: TimeSpan): TimeSpan | undefined {
    const begin = this.begin.max(other.begin);
    const end = this.end.min(other.end);
    if (begin.gt(end)) return undefined;
    if (begin.equals(end)) {
      // A point at the end of a span with a width is outside the span.
      if (begin.equals(this.end) && this.begin.lt(this.end)) return undefined;
      if (begin.equals(other.end) && other.begin.lt(other.end)) return undefined;
    }
    return new TimeSpan(begin, end);
  }

  intersection_e(other: TimeSpan): TimeSpan {
    const found = this.intersection(other);
    if (found === undefined) throw "TimeSpans do not intersect";
    return found;
  }

  equals(other: TimeSpan): boolean {
    return this.begin.equals(other.begin) && this.end.equals(other.end);
  }

  show(): string {
    return `${this.begin.show()} → ${this.end.show()}`;
  }
}

/** The value of a hap as text: an object as JSON, with `compact` as bare words. */
function render(value: unknown, compact: boolean): string {
  if (value === null || typeof value !== "object") return String(value);
  const json = JSON.stringify(value);
  if (!compact) return json;
  return json.slice(1, -1).replaceAll('"', "").replaceAll(",", " ");
}

/** A value of a pattern with its times. A hap without `whole` is analog. */
export class Hap {
  whole: TimeSpan | undefined;
  part: TimeSpan;
  value: unknown;
  context: Record<string, unknown>;
  stateful: boolean;

  constructor(
    whole?: TimeSpan,
    part?: TimeSpan,
    value?: unknown,
    context: Record<string, unknown> = {},
    stateful = false,
  ) {
    this.whole = whole;
    this.part = part as TimeSpan;
    this.value = value;
    this.context = context;
    this.stateful = stateful;
  }

  /** The length of the whole, scaled by the `clip` of the value. */
  get duration(): Fraction {
    const value = this.value as { duration?: unknown; clip?: unknown } | null | undefined;
    let duration =
      typeof value?.duration === "number"
        ? new Fraction(value.duration)
        : (this.whole as TimeSpan).end.sub((this.whole as TimeSpan).begin);
    if (typeof value?.clip === "number") duration = duration.mul(value.clip);
    return duration;
  }

  wholeOrPart(): TimeSpan {
    return this.whole ? this.whole : this.part;
  }

  withSpan(map: (span: TimeSpan) => TimeSpan): Hap {
    if (typeof map !== "function") throw new TypeError("f is not a function");
    const whole = this.whole ? map(this.whole) : undefined;
    return new Hap(whole, map(this.part), this.value, this.context);
  }

  withValue(map: (value: unknown) => unknown): Hap {
    if (typeof map !== "function") throw new TypeError("f is not a function");
    return new Hap(this.whole, this.part, map(this.value), this.context);
  }

  hasOnset(): boolean {
    if (this.whole === undefined) return false;
    return this.whole.begin.equals(this.part.begin);
  }

  /** Whether the tag is in the tags of the context. Nothing is `undefined`. */
  hasTag(tag: unknown): boolean | undefined {
    const tags = this.context?.tags as unknown[] | undefined | null;
    if (tags === undefined || tags === null) return undefined;
    return tags.includes(tag);
  }

  spanEquals(other: Hap): boolean {
    if (!this.whole && !other.whole) return true;
    return (this.whole as TimeSpan).equals(other.whole as TimeSpan);
  }

  equals(other: Hap): boolean {
    return this.spanEquals(other) && this.part.equals(other.part) && this.value === other.value;
  }

  show(compact = false): string {
    const rendered = render(this.value, Boolean(compact));
    if (this.whole === undefined) return `[ ~${this.part.show()} | ${rendered} ]`;
    const { whole, part } = this;
    const starts = whole.begin.equals(part.begin);
    const ends = whole.end.equals(part.end);
    let spans = "";
    if (!starts) spans += `${whole.begin.show()} ⇜ `;
    if (!(starts && ends)) spans += "(";
    spans += part.show();
    if (!(starts && ends)) spans += ")";
    if (!ends) spans += ` ⇝ ${whole.end.show()}`;
    return `[ ${spans} | ${rendered} ]`;
  }
}

/** What a query receives: a span and the controls of the query. */
export class State {
  span: TimeSpan;
  controls: Record<string, unknown>;

  constructor(span?: TimeSpan, controls: Record<string, unknown> = {}) {
    this.span = span as TimeSpan;
    this.controls = controls;
  }

  withSpan(map: (span: TimeSpan) => TimeSpan): State {
    if (typeof map !== "function") throw new TypeError("func is not a function");
    return new State(map(this.span), this.controls);
  }
}

/**
 * `Fraction(x)` is a call and `new Fraction(x)` works too. The two are one
 * function, and an instance of either is an instance of both.
 */
function fractionCall(first?: unknown, second?: unknown): Fraction {
  return new Fraction(first, second);
}
export const FractionFunction = Object.assign(fractionCall, { prototype: Fraction.prototype });
