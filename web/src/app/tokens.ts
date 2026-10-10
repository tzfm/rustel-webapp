// The colouring of a score. A score is JavaScript, and a double-quoted or
// backtick string in a score is mini-notation. One stream tokenizer reads both.
//
// The classes are the classes of the terminal Studio of the engine, so both
// hosts colour a score the same way: comment, string, number, punctuation,
// keyword and function (a word followed by `(`). Text with no class keeps
// the colour of the editor. Studio has no class for an operator, so `*`, `/`,
// `<`, `>`, `!` and `@` are punctuation, and the other operator characters have
// no class.
//
// Two classes are new. `name` is a note or sound name inside a mini-notation
// string. `structure` marks the characters of the mini-notation grammar. Its
// colour is the colour of punctuation, and its node type is its own, so bracket
// matching keeps the brackets of the code apart from the brackets of a string.
//
// The state of the tokenizer goes from line to line for a block comment and a
// backtick string. A string with another quote ends with its line. A template
// expression `${...}` is not parsed.

import {
  HighlightStyle,
  StreamLanguage,
  type StreamParser,
  type StringStream,
  syntaxHighlighting,
} from "@codemirror/language";
import { Tag, tags } from "@lezer/highlight";

/** The words of the language. The list is short on purpose, as in Studio. */
const KEYWORDS = new Set(
  (
    "async await break case catch class const continue default delete do else export extends " +
    "false finally for from function if import in instanceof let new null of return static " +
    "switch this throw true try typeof undefined var void while yield"
  ).split(" "),
);

/** The punctuation of code, as Studio has the set. */
const PUNCTUATION = ".()[]{}<>*!@/";
/** The characters of the mini-notation grammar which are no part of a word. */
const STRUCTURE = "[]<>(){},|*/!?:@%";

/** A word of a score: letters, digits, `_` and `$`. */
const WORD = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
const NUMBER = /^(0[xX][\da-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?)/;
/** A run of the characters a mini-notation word is made of. The engine reads the same run. */
const STEP = /^[\p{L}0-9~\-#.^_]+/u;
const STEP_NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;
/** A run with no letter and no digit: a rest, an elongation, a foot separator or a range. */
const STEP_MARK = /^[~\-._]+$/;

/** The rest of a line starts with a call: optional white space, then `(`. */
const CALL = /^\s*\(/;

const nameTag = Tag.define("miniName");
const callTag = tags.function(tags.variableName);

interface State {
  /** The quote of the string the tokenizer is in, or "" outside a string. */
  quote: "" | '"' | "'" | "`";
  /** True inside a block comment. */
  block: boolean;
}

/** Takes the match of `pattern` at the position of the stream. Returns the text, or "" for no match. */
function take(stream: StringStream, pattern: RegExp): string {
  const found = pattern.exec(stream.string.slice(stream.pos));
  stream.pos += found === null ? 0 : found[0].length;
  return found === null ? "" : found[0];
}

function blockComment(stream: StringStream, state: State): string {
  while (!stream.eol()) {
    if (stream.match("*/")) {
      state.block = false;
      break;
    }
    stream.next();
  }
  return "comment";
}

/** The inside of a single-quoted string: one class for the whole string. */
function singleQuoted(stream: StringStream, state: State): string {
  while (!stream.eol()) {
    const character = stream.next();
    if (character === "\\") {
      stream.next();
    } else if (character === state.quote) {
      state.quote = "";
      break;
    }
  }
  return "string";
}

/** The inside of a double-quoted or backtick string: mini-notation. */
function mini(stream: StringStream, state: State): string | null {
  if (stream.eatSpace()) {
    return null;
  }
  const character = stream.peek() ?? "";
  if (character === "\\") {
    stream.next();
    stream.next();
    return "string";
  }
  if (character === state.quote) {
    stream.next();
    state.quote = "";
    return "string";
  }
  if (STRUCTURE.includes(character)) {
    stream.next();
    return "structure";
  }
  const word = take(stream, STEP);
  if (word !== "") {
    if (STEP_MARK.test(word)) {
      return "structure";
    }
    return STEP_NUMBER.test(word) ? "number" : "name";
  }
  stream.next();
  return "string";
}

function code(stream: StringStream, state: State): string | null {
  if (stream.eatSpace()) {
    return null;
  }
  if (stream.match("//")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match("/*")) {
    state.block = true;
    return blockComment(stream, state);
  }
  const character = stream.peek() ?? "";
  if (character === "'" || character === '"' || character === "`") {
    stream.next();
    state.quote = character;
    return "string";
  }
  if (take(stream, NUMBER) !== "") {
    return "number";
  }
  const word = take(stream, WORD);
  if (word !== "") {
    if (word === "$") {
      return "punctuation";
    }
    // A word after a dot is a property name, even when the language owns the word.
    const property = stream.string[stream.start - 1] === ".";
    if (!property && KEYWORDS.has(word)) {
      return "keyword";
    }
    return CALL.test(stream.string.slice(stream.pos)) ? "function" : null;
  }
  stream.next();
  return PUNCTUATION.includes(character) ? "punctuation" : null;
}

/** The parser of score text. Exported for the unit test. */
export const scoreParser = {
  name: "score",
  startState: () => ({ quote: "", block: false }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    // A string with a single or double quote ends with its line.
    if (stream.sol() && state.quote !== "`") {
      state.quote = "";
    }
    if (state.block) {
      return blockComment(stream, state);
    }
    if (state.quote === "'") {
      return singleQuoted(stream, state);
    }
    return state.quote === "" ? code(stream, state) : mini(stream, state);
  },
  tokenTable: { function: callTag, name: nameTag, structure: tags.punctuation },
} satisfies StreamParser<State>;

/** One colour for each class, as custom properties which `style.css` sets for light and for dark. */
const scoreHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "var(--tok-comment)" },
  { tag: tags.string, color: "var(--tok-string)" },
  { tag: tags.number, color: "var(--tok-number)" },
  { tag: tags.punctuation, color: "var(--tok-punctuation)" },
  { tag: tags.keyword, color: "var(--tok-keyword)" },
  { tag: callTag, color: "var(--tok-function)" },
  { tag: nameTag, color: "var(--tok-name)" },
]);

/** The language of a score and the colours of its classes. */
export const scoreColours = [
  StreamLanguage.define(scoreParser),
  syntaxHighlighting(scoreHighlight),
];
