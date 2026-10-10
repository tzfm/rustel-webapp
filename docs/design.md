# Design

How the page is built, for a reader who wants to change the code. The
[README](../README.md) has the short version.

## Parts

```text
app page (site A, 127.0.0.1)      engine frame (site B, localhost)
+-----------------------+         +-----------------------------------------+
| editor, Play, Stop,   | message | frame page: AudioContext, relays        |
| status line           | ------> | messages, checks the origin             |
|                       | <------ |      |                                  |
+-----------------------+telemetry|      | start, stop word                 |
                                  |      v                                  |
                                  | Worker (own policy, lockdown):          |
                                  |   transpiler.wasm: score text -> body   |
                                  |   score host: evaluates the body        |
                                  |   engine.wasm: a turn every 10 ms       |
                                  | standby Worker: the last good score     |
                                  |      |  records, control words,         |
                                  |      |  position, turn count            |
                                  |      v                                  |
                                  | SharedArrayBuffer: event ring, control  |
                                  | block, position, stop word, telemetry   |
                                  |      |  one quantum of 128 frames       |
                                  |      v                                  |
                                  | AudioWorklet: dsp.wasm                  |
                                  +-----------------------------------------+
```

The app page and the frame share messages only. The buffer stays inside the
frame. The frame compiles the three modules while the page loads and hands two
of them, the engine and the transpiler, to the Worker. The engine module also
holds the score binding behind one import, `host_call`. The Worker opens the
binding on the engine instance, so the instance the score builds patterns in is
the instance the scheduler turns.

The Worker does this at start, in this order:

1. The imports run. Each file of the glue takes the global names the file needs
   later when the file loads: `postMessage`, `setInterval`, `clearInterval`,
   `Atomics`, `WebAssembly`, the text coders and `FinalizationRegistry`.
2. The policy proof: one `import()` of a `data:` module must fail.
3. The lockdown. The lockdown deletes every global name off an allowlist of
   language names and freezes what stays. A failure of the proof or of the
   lockdown makes the Worker refuse every score.
4. The modules arrive from the frame. The Worker instantiates both.

For each score text the Worker transpiles the text, and a result with
diagnostics does not run. Else the Worker evaluates the body inside the
lockdown, sets the tempo the score asked for, and gives the pattern to the
engine with the current audio frame. A trap of the transpiler instance refuses
the score, and the Worker makes a new instance from the compiled module. The
transpiler refuses the syntax `import()` in a score. A score builds the call
from text, so the policy of the Worker is the wall for `import()`.

## Recovery

The frame starts two Workers with the same policy proof, lockdown and modules.
The first Worker plays. The second one, the standby, evaluates the last good
score and makes no event. A score is good when the Worker which plays has
answered `done` for the score. If the standby fails on a text the Worker which
plays accepted, the frame replaces the standby and the page hears nothing. The
sound does not change, and the standby only matters when the Worker which plays
fails. A replacement which fails on the text promotes to silence.

The Worker which plays counts its turns in a bridge word. After each turn the
Worker publishes the position in the bridge: the generation, the first frame
the ring lacks, the anchor of the mapping from seconds to cycles, the tempo, and
whether the engine plays. The frame looks at the turn count every 20 ms. No new
turn for 1 s while the engine plays or a score evaluates means the Worker hangs.
A `fatal` answer (a trap of the engine module) and an `error` event of the
Worker count at once. A background tab slows the timer of the frame, so a look
more than 250 ms after the look before never declares a hang. Such a look with a
higher count shows a Worker which runs. With the same count the look only starts
the clock, and a later look 1 s after the first, with the same count, declares
the hang.

The scheduler sends events up to 2 s ahead of the audio frame, so the ring still
holds about 1 s of sound when the frame sees a hang. A dense score is covered
less far ahead (see Limits). The frame ends the Worker and promotes the
standby. The frame first gives the right to publish in the bridge to the
standby. A word of the bridge names the one Worker allowed to write the control
words, the position and the ring, and the hand over waits for a turn in
progress. `terminate()` does not wait for the Worker to stop, and the word keeps
the old Worker out of the ring in every case. The standby reads the position,
adopts the position, and plays the last good score from the first frame the old
Worker did not cover, as the next generation. The renderer keeps the old events before this frame and
drops the rest, and the new generation plays every onset from this frame on. The
page gets one `recovered` message with the reason (`hang`, `trap` or `death`),
and the error line shows the reason. The frame then starts a new standby from
the compiled modules.

A score which was evaluating when the Worker failed is to blame, and the
standby plays the last good score. When no score was evaluating, the playing
score failed inside a turn, for example in a function the score calls at query
time. The standby would fail the same way, so the standby plays silence. A hang
in the first score of the page leaves nothing to play, and the sound is silent.
The stop word works in every state: the frame writes the stop word and answers
the stop itself, and a standby which takes over stays stopped while the stop
word is set.

The first turn after a start or a takeover reaches 0.5 s ahead, and the reach
grows by 0.5 s on each turn to 2 s. The first turn then does up to a quarter of
the work of a turn at the full horizon. This counts for a dense score, since the
records of the turn must reach the ring inside the lead.

A Play puts its first onset 896 frames (18.7 ms) after the audio frame the
Worker read. An update, a tempo change and the takeover of the standby use 384
frames (8 ms): old events cover the gap, and the lead is the delay from the edit
to the sound. Nothing sounds before a Play, so a longer lead only delays the
first sound. Headless Firefox calls the renderer for 4 quanta in a row (512
frames) every 10.67 ms. With 384 frames, 4 of 90 runs of the `scores` session
had a late first onset. The record missed the group of quanta which began on the
frame read, and the next group came 128 frames too late. With 896 frames the
next group is in time too, and 0 of 30 runs of the `scores` session and 0 of 30
runs of the `recovery` session had a late event. A Worker which stalls for more
than about 20 ms between the read of the frame and the push of the record still
makes a late first onset.

The renderer holds the events which wait for their onset and the events which
sound in one pool of 64, and refuses an event when the pool is full. The engine
sends an event only while the events the engine sent, from the send to the end
of the sound, number at most 60. A sample counts at least 0.3 s. A dense score is then
covered 60 events ahead, and the renderer refuses none. The new Worker of a
promotion counts the events of the old Worker which the renderer still holds.

## Editor

The editor is CodeMirror 6 with one tokenizer of its own, `web/src/app/tokens.ts`.
The tokenizer colours a score with the classes of the terminal Studio of the
engine: comment, string, number, punctuation, keyword and function (a word
followed by `(`). Inside a double-quoted or backtick string the tokenizer reads
mini-notation: names (a class of its own), numbers and the characters of the
grammar (colour of punctuation). A single-quoted string is one string. The
colours are custom properties in `web/app/style.css`, for light and for dark.
The editor has line numbers, undo and redo, bracket matching and no line
wrapping.

| Key | Action |
| --- | --- |
| Ctrl+Enter or Cmd+Enter | Plays the score, or replaces the sound while playing |
| Ctrl+. or Cmd+. | Stops |
| Tab, Shift+Tab | Indents and dedents by two spaces |
| Escape, then Tab | Moves focus out of the editor |
| Ctrl+m (Shift+Alt+m on macOS) | Toggles the Tab key between indent and focus |

When a failed answer carries a place in the score, the editor marks the
character at the place and scrolls the place into view. At the end of a line the
mark is a bar. The mark goes away on the next good answer or on the next edit.

The page allows no inline style: `style-src 'self'`. CodeMirror writes its style
rules at run time, and in a document they land in a style element, which the
policy blocks. So the editor lives in an open shadow root. There CodeMirror
adopts a constructed style sheet, which the policy does not govern. The colours
reach the shadow root as custom properties, which inherit through the root. The
browser test counts the policy violations of the app page in every session, and
the count must be 0.

The editor is a second file, `editor.js`, which `main.js` loads with `import()`.
The page paints first, with the score as text and the buttons off, and the
buttons switch on when the editor arrives.

## Headers

Both sites send the headers of `headers.json`. The answer which carries the
Worker script, `/worker.js` on the engine site, sends the `engineWorker`
headers. The content security policy of the Worker lives there, and
`'unsafe-eval'` exists on this answer only. The policy gives the Worker no
network: `default-src 'none'`. A real host must send the `engineWorker`
headers with `worker.js` and the `engine` headers with every other file of the
engine site. `scripts/serve.ts` does this for the dev server and the browser
test.

The policy of the app page allows images from its own site only
(`img-src 'self'`), for the icon `icon.svg`. A real host must serve the icon as
`image/svg+xml`, since the page sends `nosniff`.

A Worker script which comes without its policy header runs with no policy. The
Worker proves its policy at start: one `import()` of a `data:` module must
fail. If the import works, the Worker refuses every score.

## Gate

The gate stops at the first failing step. The Rust steps run first, then
biome, `tsc`, the unit tests, the conformance run, the build, the size check,
the leak check and the browser test. The transpiler step runs the module over
every committed score of the engine and compares each result with the native
transpiler. The conformance run transpiles each score with the module,
evaluates the result against the engine module and compares the haps with the
golden row of the engine. The browser test starts headless Firefox with a fresh
profile and a volume scale of 0, so nothing is audible. The test runs three
sessions.
The first plays real scores with the product headers, and then a hostile score
which tries to reach the network, the storage, shared memory and the timers. The test server counts
the requests on a canary path, and the count must stay 0. In the second the
test server sends the Worker script with no policy header, and the Worker must
refuse a score. In the third a score hangs the Worker, a hook makes the engine
module trap, and a hook kills the Worker, while a score plays. The standby must
take over each time. The test server puts the hook in front of the Worker script
in this session only.

    scripts/gate

## Where things are

| Path | Content |
| --- | --- |
| `crates/engine` | The Worker module: pattern text or a score pattern and the audio frame in, event records out. The score binding sits in `src/binding` |
| `crates/dsp` | The renderer module: event records in, 128 frames out per call |
| `crates/transpiler` | The transpiler module: score text in, the rewritten text, the text to evaluate, the diagnostics and the hints out, as JSON text |
| `crates/wire` | What the two modules agree on: the canonical event and the control words |
| `web/app`, `web/engine` | The HTML of the app page and of the engine frame, the style sheet and the icon |
| `web/src/app` | The app page: the page logic, the signal module, the editor (`editor.ts`) and the tokenizer of a score (`tokens.ts`) |
| `web/src/engine` | The frame, the Worker, the worklet and the bridge layout. `evaluate.ts` runs one score text and maps an error back to the score text. `transpiler.ts` holds the transpiler instance. `pair.ts` holds the Worker which plays and the standby, and `watchdog.ts` decides when a Worker hangs |
| `web/src/engine/score` | The score host: the surface of the pattern language, the value tape, the objects of a score and the lockdown of the Worker |
| `web/src/protocol.ts` | The messages between the app page and the frame, and the bench handle |
| `web/tests/unit` | Unit tests of the bridge, the signal module, the score host, the evaluator and the tokenizer |
| `web/tests/conformance` | The conformance run: each committed score of the engine against its golden row, and the list of scores which do not pass |
| `web/tests/browser` | The sequence of the browser test, which the test server adds to the built page, and the hook of the `recovery` session |
| `scripts` | The gate, the build, the dev server, the size check, the transpiler check and the browser test |
| `headers.json` | The headers of both sites and of the Worker script: isolation and content security policy |
| `size-budget.json` | The brotli size budget of each group of built files |

## Bench handle

`window.__rustelBench` on the app page drives the page from a script:
`evaluate(text)` puts the score text in the editor and sets the score,
`play(text?)`, `stop()`, `telemetry()`, `recovery()` and `allocations()`.

## Limits

- The Worker never frees a function of a score, so the table of score
  functions grows with each score. A promoted Worker starts with an empty table.
- A promoted Worker holds the last good score only. A name an earlier score
  registered is gone, and a score which needs the name fails in the standby. The
  standby then plays silence on the promotion.
- The standby is a second engine instance. The standby costs its wasm memory
  (7.1 MB for the engine and 1.2 MB for the transpiler after a score) and
  evaluates each good score a second time.
- The ring covers a sparse score 2 s ahead and a dense score 60 events ahead,
  since the renderer holds at most 64 events at once. The frame needs about 1 s
  to see a hang. A promotion of a score denser than about 60 events a second
  leaves a gap of silence, since the ring then covers less than the detect time.
  The renderer refused no event in the tests up to 6000 events a second. Events
  come late above about 1000 a second, which the Worker turns every 10 ms
  cannot serve.
- A promotion of a dense score with long overlapping notes loses a few events at
  times. The new Worker does not know how long the notes of the old Worker
  sound.
- A score which never ends, or a score which takes the Worker more than 1 s to
  evaluate or to query, is stopped. A slow machine stops a heavy score.
- Only Firefox gives a line and a column on an error object, so another
  browser shows the message of a score exception with no position.
- The tokenizer reads a template expression `${...}` as part of its string, and
  reads a regular expression literal as division.
