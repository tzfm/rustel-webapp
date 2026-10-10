// Builds the page, then serves the page on two origins with the headers of
// headers.json. The app page is on 127.0.0.1 and the engine frame is on
// localhost, so the two are different sites.
//
//     node scripts/dev.ts

import { join } from "node:path";
import { buildWasm, bundle, origins, root } from "./build.ts";
import { serve } from "./serve.ts";

const { appOrigin, engineOrigin } = origins();
const dist = join(root, "dist");

buildWasm();
await bundle({ outDir: dist, appOrigin, engineOrigin });

const site = (origin: string, name: string) => {
  const url = new URL(origin);
  return { host: url.hostname, port: Number(url.port), root: join(dist, name) };
};
const running = await serve({ app: site(appOrigin, "app"), engine: site(engineOrigin, "engine") });
console.log(`open ${running.appOrigin}/ in Firefox`);
