import { timingSafeEqual } from "node:crypto";

import { buildManifest, buildRowsPage, parsePageSize } from "./contract";
import { churn, createRng, generateDeployments, randomDeployment } from "./generate";
import { type DeploymentStore, LAYER_KEYS, isLayerKey } from "./store";
import {
  type FaultState,
  createFaultState,
  isRecord,
  parseDeploymentPatch,
  parseFaultPatch,
} from "./validate";

export interface ServerOptions {
  // Regenerates the fixture for POST /admin/reset.
  fixture: { count: number; seed: number };
  port: number;
  publicUrl: string;
  store: DeploymentStore;
  token: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function sha256(text: string): Buffer {
  return Buffer.from(new Bun.CryptoHasher("sha256").update(text).digest());
}

/** Constant-time bearer check (hashing first makes the lengths equal). */
function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(sha256(presented), sha256(token));
}

const UNAUTHORIZED = () => json({ error: "Missing or invalid bearer token." }, 401);

async function readJson(request: Request): Promise<unknown> {
  try {
    const body: unknown = await request.json();
    return body;
  } catch {
    return undefined;
  }
}

/** Latency, injected failures, and malformed bodies — contract routes only. */
async function withFaults(faults: FaultState, respond: () => Response): Promise<Response> {
  if (faults.latencyMs > 0) {
    await Bun.sleep(faults.latencyMs);
  }
  if (faults.failNext > 0) {
    faults.failNext -= 1;
    return json({ error: "Injected failure." }, faults.failStatus);
  }
  if (faults.malformedNext > 0) {
    faults.malformedNext -= 1;
    return new Response('{"type":"FeatureCollection","features":[{"type":"Feat', {
      headers: { "content-type": "application/json" },
    });
  }
  return respond();
}

export function startServer(options: ServerOptions) {
  const { fixture, publicUrl, store, token } = options;
  const faults = createFaultState();
  const rng = createRng(Date.now());

  return Bun.serve({
    fetch: () => json({ error: "Not found." }, 404),
    port: options.port,
    routes: {
      // Unauthenticated status page — handy to watch while json-data-manager syncs.
      "/": {
        GET: () =>
          json({
            faults,
            layers: Object.fromEntries(
              LAYER_KEYS.map((layer) => [
                layer,
                { ...store.revisions()[layer], featureCount: store.countLayer(layer) },
              ]),
            ),
            name: "deploy-source demo",
          }),
      },

      "/admin/churn": {
        POST: async (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          const body = await readJson(request);
          const requested = isRecord(body) ? body.count : undefined;
          const count =
            typeof requested === "number" && requested > 0 ? Math.min(requested, 500) : 10;
          return json({ events: churn(store, rng, count), revisions: store.revisions() });
        },
      },

      "/admin/deployments": {
        POST: async (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          const parsed = parseDeploymentPatch((await readJson(request)) ?? {});
          if ("error" in parsed) {
            return json(parsed, 400);
          }
          const id = `dep_n${Date.now().toString(36)}`;
          const deployment = { ...randomDeployment(rng, id, 9999), ...parsed.patch, id };
          return json({ deployment, layers: store.insert(deployment) }, 201);
        },
      },

      "/admin/deployments/:id": {
        DELETE: (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          const layers = store.remove(request.params.id);
          return layers === null ? json({ error: "Not found." }, 404) : json({ layers });
        },
        PATCH: async (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          const parsed = parseDeploymentPatch(await readJson(request));
          if ("error" in parsed) {
            return json(parsed, 400);
          }
          const layers = store.update(request.params.id, parsed.patch);
          return layers === null
            ? json({ error: "Not found." }, 404)
            : json({ deployment: store.get(request.params.id), layers });
        },
      },

      "/admin/faults": {
        GET: (request) => (authorized(request, token) ? json(faults) : UNAUTHORIZED()),
        PUT: async (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          const parsed = parseFaultPatch(await readJson(request));
          if ("error" in parsed) {
            return json(parsed, 400);
          }
          Object.assign(faults, parsed.patch);
          return json(faults);
        },
      },

      "/admin/reset": {
        POST: (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          Object.assign(faults, createFaultState());
          store.reset(generateDeployments(fixture.count, fixture.seed));
          return json({ revisions: store.revisions() });
        },
      },

      // The record deep link (manifest.recordUrlTemplate). Unauthenticated in
      // the demo so a browser can open it; shows the full record, notes included.
      "/deployments/:id": {
        GET: (request) => {
          const deployment = store.get(request.params.id);
          return deployment === null ? json({ error: "Not found." }, 404) : json(deployment);
        },
      },

      "/layers/:layer/rows": {
        GET: async (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          const { layer } = request.params;
          if (!isLayerKey(layer)) {
            return json({ error: `Unknown layer "${layer}".` }, 404);
          }
          const url = new URL(request.url);
          return withFaults(faults, () => {
            const page = buildRowsPage(
              store,
              layer,
              url.searchParams.get("cursor"),
              parsePageSize(url.searchParams.get("limit")),
            );
            return json(faults.truncate ? { ...page, cursor: null } : page);
          });
        },
      },

      "/manifest": {
        GET: async (request) => {
          if (!authorized(request, token)) {
            return UNAUTHORIZED();
          }
          return withFaults(faults, () => json(buildManifest(store, publicUrl)));
        },
      },
    },
  });
}
