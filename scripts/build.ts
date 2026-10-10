// Builds the page: the three wasm modules, the five bundles, and the static files.
// Output: dist/app and dist/engine.
//
//     node scripts/build.ts
//
// The two origins reach the bundles as build-time constants. The environment
// variables APP_ORIGIN and ENGINE_ORIGIN replace the defaults.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

export const root = join(import.meta.dirname, "..");
export const DEFAULT_APP_ORIGIN = "http://127.0.0.1:8080";
export const DEFAULT_ENGINE_ORIGIN = "http://localhost:8081";

const release = join(root, "target/wasm32-unknown-unknown/release");

export interface Options {
  outDir: string;
  appOrigin: string;
  engineOrigin: string;
}

export function buildWasm(): void {
  execFileSync(join(root, "scripts/wasm-build"), ["all"], { stdio: "inherit" });
}

/** Writes the bundles and copies the static files. The wasm modules must exist. */
export async function bundle(options: Options): Promise<void> {
  const app = join(options.outDir, "app");
  const engine = join(options.outDir, "engine");
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  mkdirSync(engine, { recursive: true });

  const common = {
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    legalComments: "none",
    define: {
      __APP_ORIGIN__: JSON.stringify(options.appOrigin),
      __ENGINE_ORIGIN__: JSON.stringify(options.engineOrigin),
    },
    logLevel: "warning",
  } as const;
  // The editor is a second entry point which main.js loads with import(). The
  // page paints and wires its buttons before the editor file arrives.
  await build({
    ...common,
    entryPoints: ["main", "editor"].map((name) => join(root, `web/src/app/${name}.ts`)),
    splitting: true,
    outdir: app,
  });
  await build({
    ...common,
    entryPoints: ["frame", "worker", "worklet"].map((name) =>
      join(root, `web/src/engine/${name}.ts`),
    ),
    outdir: engine,
  });

  copyFileSync(join(root, "web/app/index.html"), join(app, "index.html"));
  copyFileSync(join(root, "web/app/style.css"), join(app, "style.css"));
  copyFileSync(join(root, "web/app/icon.svg"), join(app, "icon.svg"));
  copyFileSync(join(root, "web/engine/frame.html"), join(engine, "frame.html"));
  copyFileSync(join(release, "rustel_web_dsp.wasm"), join(engine, "dsp.wasm"));
  copyFileSync(join(release, "rustel_web_engine.wasm"), join(engine, "engine.wasm"));
  copyFileSync(join(release, "rustel_web_transpiler.wasm"), join(engine, "transpiler.wasm"));
}

export function origins(): { appOrigin: string; engineOrigin: string } {
  return {
    appOrigin: process.env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN,
    engineOrigin: process.env.ENGINE_ORIGIN ?? DEFAULT_ENGINE_ORIGIN,
  };
}

if (import.meta.main) {
  buildWasm();
  await bundle({ outDir: join(root, "dist"), ...origins() });
  console.log("built dist/app and dist/engine");
}
