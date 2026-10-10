// The tokenizer of score text needs no DOM: the tests feed the tokenizer lines and read
// the class of each token. Adjacent tokens of one class merge, as in the editor,
// and text with no class is left out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { StringStream } from "@codemirror/language";
import { scoreParser } from "../../src/app/tokens.ts";

type Token = [text: string, name: string];

function tokens(source: string): Token[] {
  const state = scoreParser.startState();
  const found: { text: string; name: string; end: number }[] = [];
  let offset = 0;
  for (const line of source.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const name = scoreParser.token(stream, state);
      assert.ok(stream.pos > stream.start, `the tokenizer stops at ${stream.pos} of ${line}`);
      if (name !== null) {
        const start = offset + stream.start;
        const last = found.at(-1);
        if (last?.name === name && last.end === start) {
          last.text += stream.current();
          last.end = offset + stream.pos;
        } else {
          found.push({ text: stream.current(), name, end: offset + stream.pos });
        }
      }
    }
    offset += line.length + 1;
  }
  return found.map(({ text, name }) => [text, name]);
}

const cases: [title: string, source: string, expected: Token[]][] = [
  [
    "a keyword and a number",
    "const x = 1",
    [
      ["const", "keyword"],
      ["1", "number"],
    ],
  ],
  [
    "a call, with a number",
    "setcps(0.5)",
    [
      ["setcps", "function"],
      ["(", "punctuation"],
      ["0.5", "number"],
      [")", "punctuation"],
    ],
  ],
  [
    "a call with white space before the bracket, and a method",
    'note ("c3").fast(2)',
    [
      ["note", "function"],
      ["(", "punctuation"],
      ['"', "string"],
      ["c3", "name"],
      ['"', "string"],
      [").", "punctuation"],
      ["fast", "function"],
      ["(", "punctuation"],
      ["2", "number"],
      [")", "punctuation"],
    ],
  ],
  ["a name which is not called has no class", "x.y", [[".", "punctuation"]]],
  [
    "a word of the language after a dot is a property",
    "p.default(1)",
    [
      [".", "punctuation"],
      ["default", "function"],
      ["(", "punctuation"],
      ["1", "number"],
      [")", "punctuation"],
    ],
  ],
  [
    "a word of the language before a bracket is a keyword",
    "if (x) return null",
    [
      ["if", "keyword"],
      ["(", "punctuation"],
      [")", "punctuation"],
      ["return", "keyword"],
      ["null", "keyword"],
    ],
  ],
  ["a label", "$: x", [["$", "punctuation"]]],
  [
    "operators: punctuation as in Studio, the others have no class",
    "x = a + b * 2 < 3",
    [
      ["*", "punctuation"],
      ["2", "number"],
      ["<", "punctuation"],
      ["3", "number"],
    ],
  ],
  [
    "digits inside a word",
    "a1 = 0x1f + 1.5e3",
    [
      ["0x1f", "number"],
      ["1.5e3", "number"],
    ],
  ],
  [
    "a single-quoted string is one string",
    "s('bd*2 hh')",
    [
      ["s", "function"],
      ["(", "punctuation"],
      ["'bd*2 hh'", "string"],
      [")", "punctuation"],
    ],
  ],
  [
    "a single-quoted string holds a double quote",
    `x('say "hi"')`,
    [
      ["x", "function"],
      ["(", "punctuation"],
      [`'say "hi"'`, "string"],
      [")", "punctuation"],
    ],
  ],
  [
    "an escaped quote does not end a string",
    String.raw`'a\'b' 1`,
    [
      [String.raw`'a\'b'`, "string"],
      ["1", "number"],
    ],
  ],
  [
    "a double-quoted string holds a single quote",
    `"a'b"`,
    [
      ['"', "string"],
      ["a", "name"],
      ["'", "string"],
      ["b", "name"],
      ['"', "string"],
    ],
  ],
  [
    "an escaped double quote does not end mini-notation",
    String.raw`"a\"b" 1`,
    [
      ['"', "string"],
      ["a", "name"],
      [String.raw`\"`, "string"],
      ["b", "name"],
      ['"', "string"],
      ["1", "number"],
    ],
  ],
  [
    "a backtick string holds both quotes",
    "`a\"b'c`",
    [
      ["`", "string"],
      ["a", "name"],
      ['"', "string"],
      ["b", "name"],
      ["'", "string"],
      ["c", "name"],
      ["`", "string"],
    ],
  ],
  [
    "mini-notation: names, numbers, the grammar",
    '"bd*2 hh(3,8) [a b]/2 <c d>!2"',
    [
      ['"', "string"],
      ["bd", "name"],
      ["*", "structure"],
      ["2", "number"],
      ["hh", "name"],
      ["(", "structure"],
      ["3", "number"],
      [",", "structure"],
      ["8", "number"],
      [")", "structure"],
      ["[", "structure"],
      ["a", "name"],
      ["b", "name"],
      ["]/", "structure"],
      ["2", "number"],
      ["<", "structure"],
      ["c", "name"],
      ["d", "name"],
      [">!", "structure"],
      ["2", "number"],
      ['"', "string"],
    ],
  ],
  [
    "mini-notation: the rest of the grammar",
    '"e?0.3 f@3 g:4 ~ - _ . h|i {j k}%4"',
    [
      ['"', "string"],
      ["e", "name"],
      ["?", "structure"],
      ["0.3", "number"],
      ["f", "name"],
      ["@", "structure"],
      ["3", "number"],
      ["g", "name"],
      [":", "structure"],
      ["4", "number"],
      ["~", "structure"],
      ["-", "structure"],
      ["_", "structure"],
      [".", "structure"],
      ["h", "name"],
      ["|", "structure"],
      ["i", "name"],
      ["{", "structure"],
      ["j", "name"],
      ["k", "name"],
      ["}%", "structure"],
      ["4", "number"],
      ['"', "string"],
    ],
  ],
  [
    "mini-notation: a note or sound name keeps its digits and marks",
    '"c#3 tr-808 808bd é2 -1 .5 3.5"',
    [
      ['"', "string"],
      ["c#3", "name"],
      ["tr-808", "name"],
      ["808bd", "name"],
      ["é2", "name"],
      ["-1", "number"],
      [".5", "number"],
      ["3.5", "number"],
      ['"', "string"],
    ],
  ],
  [
    "a line comment holds a string",
    'note("c3") // "x"',
    [
      ["note", "function"],
      ["(", "punctuation"],
      ['"', "string"],
      ["c3", "name"],
      ['"', "string"],
      [")", "punctuation"],
      ['// "x"', "comment"],
    ],
  ],
  [
    "a comment marker inside a string is no comment",
    's("a//b")',
    [
      ["s", "function"],
      ["(", "punctuation"],
      ['"', "string"],
      ["a", "name"],
      ["//", "structure"],
      ["b", "name"],
      ['"', "string"],
      [")", "punctuation"],
    ],
  ],
  [
    "a block comment on one line",
    "/* a */ 1",
    [
      ["/* a */", "comment"],
      ["1", "number"],
    ],
  ],
  [
    "a block comment goes on to the next line",
    "/* a\nb */ c(1)",
    [
      ["/* a", "comment"],
      ["b */", "comment"],
      ["c", "function"],
      ["(", "punctuation"],
      ["1", "number"],
      [")", "punctuation"],
    ],
  ],
  [
    "a backtick string goes on to the next line, with mini-notation",
    "`a b\n[c d]`",
    [
      ["`", "string"],
      ["a", "name"],
      ["b", "name"],
      ["[", "structure"],
      ["c", "name"],
      ["d", "name"],
      ["]", "structure"],
      ["`", "string"],
    ],
  ],
  [
    "a double-quoted string ends with its line",
    '"ab\nfoo(1)',
    [
      ['"', "string"],
      ["ab", "name"],
      ["foo", "function"],
      ["(", "punctuation"],
      ["1", "number"],
      [")", "punctuation"],
    ],
  ],
];

for (const [title, source, expected] of cases) {
  test(title, () => {
    assert.deepEqual(tokens(source), expected);
  });
}
