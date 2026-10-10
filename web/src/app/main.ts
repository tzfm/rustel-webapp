// The app page: a score editor, Play and Stop. The page talks to the engine
// frame by message only, and shows telemetry. The editor is a second file. The
// page paints and wires its buttons first, and the buttons wait for the editor.

import {
  type Bench,
  type FromFrame,
  type Recovered,
  type Refusal,
  recoveryText,
  type Telemetry,
  type ToFrame,
} from "../protocol.ts";
import type { Editor } from "./editor.ts";
import { effect, signal } from "./signals.ts";

const ENGINE_ORIGIN = __ENGINE_ORIGIN__;
/** Milliseconds the page waits for an answer of the frame. */
const ANSWER_MS = 20_000;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The page has no element ${id}.`);
  }
  return found as T;
}

const editorHost = element("editor");
const playButton = element<HTMLButtonElement>("play");
const stopButton = element<HTMLButtonElement>("stop");
const errorLine = element("error");
const statusLine = element("status");

// State of the page.
/** True when the editor has arrived. */
const ready = signal(false);
const playing = signal(false);
const latest = signal<Telemetry | null>(null);
const message = signal("");
/** The latest recovery of the engine, or null when none happened. */
const recovered = signal<Recovered | null>(null);
/** Why the engine is gone, or null while the engine runs. */
const broken = signal<string | null>(null);

const frame = document.createElement("iframe");
frame.id = "engine";
frame.title = "audio engine";
// A frame from another site gets isolation and the click of this page only
// when the page hands both over. Chromium needs the two names.
frame.allow = "cross-origin-isolated; autoplay";
frame.src = `${ENGINE_ORIGIN}/frame.html`;
const loaded = new Promise<void>((resolve) => {
  frame.addEventListener("load", () => resolve(), { once: true });
});
document.body.append(frame);

let nextId = 1;
const waiting = new Map<number, (reply: FromFrame) => void>();

/** Sends one message to the frame and resolves with its answer. */
function ask(build: (id: number) => ToFrame): Promise<FromFrame> {
  const reason = broken.get();
  if (reason !== null) {
    return Promise.reject(new Error(reason));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("The engine frame does not answer."));
    }, ANSWER_MS);
    waiting.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    loaded.then(() => frame.contentWindow?.postMessage(build(id), ENGINE_ORIGIN));
  });
}

addEventListener("message", (event: MessageEvent<FromFrame>) => {
  if (event.origin !== ENGINE_ORIGIN || event.source !== frame.contentWindow) {
    return;
  }
  const data = event.data;
  if (data.type === "telemetry") {
    latest.set(data);
  } else if (data.type === "recovered") {
    // A score stopped the Worker. The frame answers each waiting score on its own.
    recovered.set(data);
    message.set(recoveryText(data.reason, data.kept));
  } else if (data.type === "fatal") {
    broken.set(data.error);
    playing.set(false);
    message.set(data.error);
    // Every waiting task ends at once, so the real error stays on the error line.
    for (const answer of waiting.values()) {
      answer(data);
    }
    waiting.clear();
  } else {
    waiting.get(data.id)?.(data);
    waiting.delete(data.id);
  }
});

/** The error of an answer which is not the one the task waits for. */
function failureOf(reply: FromFrame): Refusal {
  if (reply.type === "failed") {
    return Object.assign(new Error(reply.error), { position: reply.position });
  }
  return new Error(
    reply.type === "fatal" ? reply.error : "The engine frame sent an unexpected answer.",
  );
}

/** The text of the error line: the message, and the place in the score when the refusal has one. */
function describe(error: Refusal): string {
  const { position } = error;
  return position === undefined
    ? error.message
    : `${error.message} (line ${position.line}, column ${position.column})`;
}

function generationOf(reply: FromFrame): number {
  if (reply.type !== "done") {
    throw failureOf(reply);
  }
  return reply.generation;
}

/** Sets the score. While playing, the sound changes after 3 quanta. Rejects
 * with the refusal. */
async function evaluate(text: string): Promise<number> {
  return generationOf(await ask((id) => ({ type: "set", id, text })));
}

async function play(text: string): Promise<void> {
  generationOf(await ask((id) => ({ type: "play", id, text })));
  playing.set(true);
}

async function stop(): Promise<void> {
  generationOf(await ask((id) => ({ type: "stop", id })));
  playing.set(false);
}

/** Asks the renderer for its count of allocations while rendering. */
async function allocations(): Promise<number> {
  const reply = await ask((id) => ({ type: "allocations", id }));
  if (reply.type !== "allocations") {
    throw failureOf(reply);
  }
  return reply.count;
}

/** The editor, once the editor file has arrived. */
let editor: Editor | undefined;

/** The editor. The buttons, the keys and the bench wait for the editor, so none calls this early. */
function theEditor(): Editor {
  if (editor === undefined) {
    throw new Error("The editor has not arrived.");
  }
  return editor;
}

/** Shows the outcome of a task on the error line. A refusal with a place in the
 * score also marks the place in the editor, when the editor still holds the score
 * the task `sent`. Returns the task. */
function show<T>(task: Promise<T>, sent?: string): Promise<T> {
  task.then(
    () => {
      message.set("");
      editor?.clearMark();
    },
    (error: Refusal) => {
      message.set(describe(error));
      const { position } = error;
      if (editor !== undefined && position !== undefined && editor.text() === sent) {
        editor.mark(position.line, position.column);
      } else {
        editor?.clearMark();
      }
    },
  );
  return task;
}

/** Sends the editor text: an update while playing, a play while stopped. */
function send(): void {
  const text = theEditor().text();
  const task: Promise<unknown> = playing.get() ? evaluate(text) : play(text);
  show(task, text);
}

function playClicked(): void {
  const text = theEditor().text();
  show(play(text), text);
}

playButton.addEventListener("click", playClicked);
stopButton.addEventListener("click", () => show(stop()));

const editorReady: Promise<Editor> = import("./editor.ts").then(({ createEditor }) => {
  const created = createEditor({
    parent: editorHost,
    text: editorHost.textContent ?? "",
    label: element("score-label").textContent ?? "",
    onPlay: send,
    onStop: () => show(stop()),
  });
  // The shadow root shows the editor. The text of the page goes.
  editorHost.replaceChildren();
  editor = created;
  ready.set(true);
  return created;
});
editorReady.catch((error: Error) => message.set(`The editor does not load. ${error.message}`));

function statusText(telemetry: Telemetry | null): string {
  if (telemetry === null) {
    return "Audio is off. Press Play to start the engine.";
  }
  if (telemetry.audio !== "running") {
    return `Audio is ${telemetry.audio}.`;
  }
  return [
    `frame ${telemetry.frame}`,
    `generation ${telemetry.generation}`,
    `accepted ${telemetry.accepted}`,
    `late ${telemetry.late}`,
    `peak ${telemetry.peak.toFixed(3)}`,
  ].join(", ");
}

effect(() => {
  statusLine.textContent = statusText(latest.get());
});
effect(() => {
  errorLine.textContent = message.get();
});
effect(() => {
  const unavailable = !ready.get() || broken.get() !== null;
  playButton.disabled = unavailable || playing.get();
  stopButton.disabled = unavailable || !playing.get();
});

const bench: Bench = {
  async evaluate(text) {
    const current = await editorReady;
    current.setText(text);
    const sent = current.text();
    return show(evaluate(sent), sent);
  },
  async play(text) {
    const current = await editorReady;
    if (text !== undefined) current.setText(text);
    const sent = current.text();
    return show(play(sent), sent);
  },
  stop: () => show(stop()),
  telemetry: () => latest.get(),
  recovery: () => recovered.get(),
  allocations,
};
window.__rustelBench = bench;
