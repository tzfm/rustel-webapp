// The render thread glue: one AudioWorkletProcessor around the renderer
// module. The scope has no TextDecoder, fetch or performance, and the file
// imports nothing at run time (the build inlines the bridge).
//
// Per quantum, in this order: read the ring tail, take a whole control
// snapshot, copy at most 64 records into the module inbox, write the control
// words, render, copy the output, publish telemetry. Every view exists before
// the first quantum. A view is made again only when the module memory grows.
// No object is created per quantum.

import {
  type Bridge,
  CONTROL,
  CONTROL_SEQ,
  CONTROL_WORDS,
  floatBits,
  lockRead,
  lockWrite,
  openBridge,
  QUANTA,
  QUANTUM,
  RING_TAIL,
  ringCopy,
  ringPending,
  ringRelease,
  STOP,
  T_PEAK,
  T_QUANTA,
  TELEMETRY,
  TELEMETRY_SEQ,
  TELEMETRY_WORDS,
} from "./bridge.ts";

/** Event records the module inbox holds. */
const INBOX_RECORDS = 64;
/** Voices the renderer plays at once. */
const VOICES = 64;
/** Quanta in one peak window. The reported peak spans one to two windows. */
const PEAK_WINDOW = 32;
/** Words of the renderer module telemetry block. */
const MODULE_TELEMETRY_WORDS = 8;
/** Control words with the stop word: 8 published words and 1 stop word. */
const MODULE_CONTROL_WORDS = CONTROL_WORDS + 1;

/** What the frame sends to the worklet port. */
export type ToWorklet = { type: "canonical"; bytes: Uint8Array } | { type: "allocations" };
/** What the worklet answers. */
export type FromWorklet =
  | { type: "canonical"; ok: boolean }
  | { type: "allocations"; count: number };

export interface WorkletOptions {
  module: WebAssembly.Module;
  buffer: SharedArrayBuffer;
  recordBytes: number;
}

interface DspExports {
  memory: WebAssembly.Memory;
  dsp_init(sampleRate: number, voiceCapacity: number): number;
  dsp_render(frame: number, records: number): number;
  dsp_allocations(): number;
  dsp_canonical_matches(): number;
}

/** Where the module keeps its areas, as `dsp_init` returns them. The layout
 * holds five u32 fields. */
interface Layout {
  recordBytes: number;
  inbox: number;
  control: number;
  output: number;
  telemetry: number;
}

/** Views into the module memory. They die when the memory grows. */
interface Views {
  memory: ArrayBuffer;
  bytes: Uint8Array;
  control: Uint32Array;
  mix: Float32Array;
  telemetry: Uint32Array;
}

function makeViews(memory: WebAssembly.Memory, layout: Layout): Views {
  const buffer = memory.buffer;
  return {
    memory: buffer,
    bytes: new Uint8Array(buffer),
    control: new Uint32Array(buffer, layout.control, MODULE_CONTROL_WORDS),
    mix: new Float32Array(buffer, layout.output, QUANTUM * 2),
    telemetry: new Uint32Array(buffer, layout.telemetry, MODULE_TELEMETRY_WORDS),
  };
}

class Renderer extends AudioWorkletProcessor {
  dsp: DspExports;
  layout: Layout;
  views: Views;
  bridge: Bridge;
  recordBytes: number;
  /** True when both modules agree on the size of a record. */
  sameSize: boolean;
  /** Scratch for one control snapshot and one telemetry block. */
  snapshot = new Int32Array(CONTROL_WORDS);
  telemetry = new Int32Array(TELEMETRY_WORDS);
  /** True after the canonical event check passed. */
  verified = false;
  quanta = 0;
  windowPeak = 0;
  lastWindowPeak = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const { module, buffer, recordBytes } = options.processorOptions as WorkletOptions;
    const dsp = new WebAssembly.Instance(module, {}).exports as unknown as DspExports;
    const address = dsp.dsp_init(sampleRate, VOICES);
    if (address === 0) {
      throw new Error("the renderer refused its arguments");
    }
    const fields = new Uint32Array(dsp.memory.buffer, address, 5);
    this.dsp = dsp;
    this.layout = {
      recordBytes: fields[0],
      inbox: fields[1],
      control: fields[2],
      output: fields[3],
      telemetry: fields[4],
    };
    this.views = makeViews(dsp.memory, this.layout);
    this.bridge = openBridge(buffer, recordBytes);
    this.recordBytes = recordBytes;
    this.sameSize = this.layout.recordBytes === recordBytes;
    this.port.onmessage = (event: MessageEvent<ToWorklet>) => this.handle(event.data);
  }

  handle(message: ToWorklet): void {
    if (message.type === "canonical") {
      // The engine module sends the bytes of its canonical event. The
      // renderer module compares them with its own. A different record size
      // fails the check before any copy.
      if (this.sameSize && message.bytes.length === this.recordBytes) {
        this.views.bytes.set(message.bytes, this.layout.inbox);
        this.verified = this.dsp.dsp_canonical_matches() === 1;
      }
      this.reply({ type: "canonical", ok: this.verified });
    } else {
      this.reply({ type: "allocations", count: this.dsp.dsp_allocations() });
    }
  }

  reply(message: FromWorklet): void {
    this.port.postMessage(message);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.verified) {
      return true;
    }
    if (this.dsp.memory.buffer !== this.views.memory) {
      this.views = makeViews(this.dsp.memory, this.layout);
    }
    const { bridge, views } = this;
    const { bytes, control, mix } = views;
    const words = bridge.words;

    // The tail comes before the snapshot. The Worker publishes control words
    // before the tail moves, so a record below this tail meets a snapshot at
    // least as new as its generation.
    const tail = Atomics.load(words, RING_TAIL);
    let records = 0;
    if (lockRead(words, CONTROL_SEQ, CONTROL, this.snapshot)) {
      control.set(this.snapshot);
      records = Math.min(ringPending(bridge, tail), INBOX_RECORDS);
      for (let index = 0; index < records; index += 1) {
        ringCopy(bridge, index, bytes, this.layout.inbox + index * this.recordBytes);
      }
      ringRelease(bridge, records);
    }
    // On a missed snapshot the module keeps the previous words and gets no
    // records: a record judged against old words is dropped as stale.
    control[CONTROL_WORDS] = Atomics.load(words, STOP);

    this.dsp.dsp_render(this.quanta * QUANTUM, records);

    const left = outputs[0][0];
    const right = outputs[0][1];
    let peak = 0;
    for (let frame = 0; frame < QUANTUM; frame += 1) {
      const l = mix[2 * frame];
      const r = mix[2 * frame + 1];
      left[frame] = l;
      right[frame] = r;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }

    this.quanta += 1;
    this.windowPeak = Math.max(this.windowPeak, peak);
    const shown = Math.max(this.windowPeak, this.lastWindowPeak);
    if (this.quanta % PEAK_WINDOW === 0) {
      this.lastWindowPeak = this.windowPeak;
      this.windowPeak = 0;
    }
    const telemetry = this.telemetry;
    telemetry[T_QUANTA] = this.quanta | 0;
    telemetry.set(views.telemetry, 1);
    telemetry[T_PEAK] = floatBits(shown);
    lockWrite(words, TELEMETRY_SEQ, TELEMETRY, telemetry);
    Atomics.store(words, QUANTA, this.quanta | 0);
    return true;
  }
}

registerProcessor("renderer", Renderer);
