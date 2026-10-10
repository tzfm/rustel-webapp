// Serves the built files on two origins, so the app page and the engine frame
// are two sites. Both servers send the headers of headers.json. The answer
// which carries the Worker script of the engine site sends the `engineWorker`
// headers: the policy of the Worker lives there. Used by scripts/dev.ts and
// scripts/browser-test.ts.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { extname, join, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

export interface Site {
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Directory of the built files. */
  root: string;
}

type Headers = Record<string, string>;

/** The path of the Worker script on the engine site. */
export const WORKER_PATH = "/worker.js";

/** Answers one request with the headers of its site, or of the Worker script
 * for its path. `omit` names headers to leave out. */
export type Send = (
  status: number,
  type: string,
  body: string | Uint8Array,
  omit?: string[],
) => void;

export type Kind = "app" | "engine";

/** The path of a request. A request line which is no address gives an empty path, and the answer is 404. */
function pathOf(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

/** Ways for a test to look at the traffic. */
export interface Hooks {
  /** Sees each request first. Returns true when the request is answered. */
  intercept?: (kind: Kind, request: IncomingMessage, send: Send) => Promise<boolean>;
  /** Sees each upgrade request, as a WebSocket sends one. The server then closes the connection. */
  upgrade?: (kind: Kind, request: IncomingMessage) => void;
}

export interface Running {
  appOrigin: string;
  engineOrigin: string;
  close(): Promise<void>;
}

/** Starts both servers. */
export async function serve(
  sites: { app: Site; engine: Site },
  hooks: Hooks = {},
): Promise<Running> {
  const headers: { app: Headers; engine: Headers; engineWorker: Headers } = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "headers.json"), "utf8"),
  );
  const origins = { app: "", engine: "" };

  // A header value holds {appOrigin} and {engineOrigin} as placeholders.
  const fill = (value: string) =>
    value.replaceAll("{appOrigin}", origins.app).replaceAll("{engineOrigin}", origins.engine);

  const start = async (kind: Kind, site: Site) => {
    const server = createServer(async (request, reply) => {
      const path = pathOf(request);
      const set = kind === "engine" && path === WORKER_PATH ? headers.engineWorker : headers[kind];
      const send: Send = (status, type, body, omit = []) => {
        const sent = Object.fromEntries(
          Object.entries(set)
            .filter(([name]) => !omit.includes(name))
            .map(([name, value]) => [name, fill(value)]),
        );
        reply.writeHead(status, { ...sent, "Content-Type": type, "Cache-Control": "no-store" });
        reply.end(body);
      };
      try {
        if (hooks.intercept && (await hooks.intercept(kind, request, send))) {
          return;
        }
        const file = join(site.root, path === "/" ? "index.html" : path);
        if (!file.startsWith(site.root + sep)) {
          send(404, "text/plain", "not found");
          return;
        }
        send(200, TYPES[extname(file)] ?? "application/octet-stream", await readFile(file));
      } catch {
        send(404, "text/plain", "not found");
      }
    });
    server.on("upgrade", (request, socket) => {
      hooks.upgrade?.(kind, request);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(site.port, site.host, resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`The ${kind} server has no port.`);
    }
    origins[kind] = `http://${site.host}:${address.port}`;
    return server;
  };

  const servers = [await start("app", sites.app), await start("engine", sites.engine)];
  return {
    appOrigin: origins.app,
    engineOrigin: origins.engine,
    close: async () => {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
