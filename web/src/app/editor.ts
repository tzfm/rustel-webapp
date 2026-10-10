// The score editor: CodeMirror 6 with the colours of `tokens.ts`. The module
// knows no protocol. The page hands over the functions the play and stop keys
// call, and the editor hands back a small handle.
//
// The app page allows no inline style: `style-src 'self'`. CodeMirror makes its
// style rules at run time. In a document CodeMirror writes them into a style
// element, which the policy blocks. In a shadow root CodeMirror adopts a
// constructed style sheet, which the policy does not govern. So the editor
// lives in a shadow root. The colours reach the shadow root as custom
// properties, which inherit through the root. `style.css` sets them for light
// and for dark.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import {
  EditorState,
  type Extension,
  findClusterBreak,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  WidgetType,
} from "@codemirror/view";
import { scoreColours } from "./tokens.ts";

export interface EditorOptions {
  /** The element the editor fills. The editor makes an open shadow root in the element. */
  parent: HTMLElement;
  /** The text at the start. */
  text: string;
  /** The accessible name of the text area. */
  label: string;
  /** Ctrl+Enter and Cmd+Enter. */
  onPlay(): void;
  /** Ctrl+. and Cmd+. */
  onStop(): void;
}

export interface Editor {
  text(): string;
  /** Replaces the whole text. The mark goes away. */
  setText(text: string): void;
  focus(): void;
  /** Marks the character at a place and scrolls the place into view. Both numbers count from 1,
   * the column in UTF-16 code units. A place past the end of the text goes to the end. */
  mark(line: number, column: number): void;
  clearMark(): void;
}

/** The range of the mark. An empty range at the end of a line shows as a tick. */
const setMark = StateEffect.define<{ from: number; to: number } | null>();

/** A bar where a character should be: the mark of an error at the end of a line. */
class Tick extends WidgetType {
  toDOM(): HTMLElement {
    const tick = document.createElement("span");
    tick.className = "score-error-tick";
    return tick;
  }
}

const characterMark = Decoration.mark({ class: "score-error" });
const tickMark = Decoration.widget({ widget: new Tick(), side: 1 });

/** The mark of an error. The next change of the text clears the mark. */
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMark)) {
        const range = effect.value;
        if (range === null) {
          return Decoration.none;
        }
        const decoration =
          range.to > range.from
            ? characterMark.range(range.from, range.to)
            : tickMark.range(range.from);
        return Decoration.set([decoration]);
      }
    }
    return transaction.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// The colours are custom properties of `style.css`, so a rule here holds no colour value.
const theme = EditorView.theme({
  "&": {
    color: "var(--editor-fg)",
    backgroundColor: "var(--editor-bg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    maxHeight: "24rem",
    overflow: "hidden",
  },
  "&.cm-focused": { outline: "2px solid var(--focus)", outlineOffset: "1px" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, monospace",
    lineHeight: "1.4",
    overflow: "auto",
  },
  // Six lines high at the start, as the text box was.
  ".cm-content": { caretColor: "var(--editor-fg)", minHeight: "calc(6 * 1.4em + 8px)" },
  ".cm-gutters": {
    backgroundColor: "var(--editor-gutter-bg)",
    color: "var(--editor-gutter-fg)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--editor-match)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--editor-mismatch)" },
  ".score-error": {
    backgroundColor: "var(--editor-error-bg)",
    textDecoration: "underline wavy var(--editor-error)",
    textUnderlineOffset: "3px",
  },
  ".score-error-tick": {
    display: "inline-block",
    height: "1.2em",
    verticalAlign: "text-bottom",
    borderLeft: "2px solid var(--editor-error)",
  },
});

/**
 * Makes the editor in `options.parent`.
 *
 * Tab indents, by two spaces. A keyboard user leaves the editor with Escape and
 * then Tab, or with Ctrl+m (Shift+Alt+m on macOS), which toggles the tab focus
 * mode. The CodeMirror example for the Tab key names both ways, and
 * `docs/design.md` does too.
 */
export function createEditor(options: EditorOptions): Editor {
  const play = () => {
    options.onPlay();
    return true;
  };
  const stop = () => {
    options.onStop();
    return true;
  };
  const extensions: Extension[] = [
    lineNumbers(),
    history(),
    bracketMatching(),
    EditorState.tabSize.of(2),
    indentUnit.of("  "),
    // The keys of the page come first: Ctrl+Enter and Cmd+Enter insert a blank line otherwise.
    keymap.of([
      { key: "Ctrl-Enter", run: play },
      { key: "Cmd-Enter", run: play },
      { key: "Ctrl-.", run: stop },
      { key: "Cmd-.", run: stop },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    scoreColours,
    markField,
    theme,
    EditorView.contentAttributes.of({
      "aria-label": options.label,
      spellcheck: "false",
      autocapitalize: "off",
      autocorrect: "off",
    }),
  ];
  const root = options.parent.attachShadow({ mode: "open" });
  const view = new EditorView({
    root,
    parent: root,
    state: EditorState.create({ doc: options.text, extensions }),
  });

  return {
    text: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus: () => view.focus(),
    mark(line, column) {
      const { doc } = view.state;
      const row = doc.line(Math.min(Math.max(line, 1), doc.lines));
      const from = row.from + Math.min(Math.max(column - 1, 0), row.length);
      const to = from < row.to ? row.from + findClusterBreak(row.text, from - row.from) : from;
      view.dispatch({
        effects: [setMark.of({ from, to }), EditorView.scrollIntoView(from, { y: "center" })],
      });
    },
    clearMark() {
      if (view.state.field(markField).size > 0) {
        view.dispatch({ effects: setMark.of(null) });
      }
    },
  };
}
