// Names the build and the runtimes add, which the TypeScript libraries lack.

// Build-time constants from scripts/build.ts.
declare const __APP_ORIGIN__: string;
declare const __ENGINE_ORIGIN__: string;

// The AudioWorkletGlobalScope names the worklet uses.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
