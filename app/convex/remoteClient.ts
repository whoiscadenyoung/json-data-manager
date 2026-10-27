import { z } from "zod";

import type { ProjectionRow, RemoteSource, SourceGeometryType } from "./sources";

/**
 * The HTTP side of remote bound sources (#78, docs/remote-source-adapter-design.md
 * §3): typed, validated reads of a foreign app's `/manifest` and
 * `/layers/{layer}/rows`. Plain functions — the sync's collect action and
 * remoteSources.ts' actions call them; nothing here touches the database.
 *
 * The transport is untrusted: every response is zod-validated, so a
 * malformed page throws (and fails the run loudly) instead of reaching the
 * apply. 429/5xx and network errors retry with backoff; any other status is
 * a contract error and fails at once.
 */

const MAX_ATTEMPTS = 3,
  RETRY_BASE_MS = 250,
  REQUEST_TIMEOUT_MS = 30_000,
  ROWS_PAGE_SIZE = 500;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const GEOMETRY_TYPES = [
  "LineString",
  "MultiLineString",
  "MultiPoint",
  "MultiPolygon",
  "Point",
  "Polygon",
] as const satisfies readonly SourceGeometryType[];

const layerSchema = z.object({
  description: z.string().optional(),
  featureCount: z.number().int().nonnegative().optional(),
  geometryType: z.enum(GEOMETRY_TYPES),
  key: z.string().min(1),
  revision: z.number(),
  schema: z.record(z.string(), z.unknown()),
  schemaVersion: z.string().min(1),
  title: z.string().min(1),
});

const manifestSchema = z.object({
  apiVersion: z.literal(1),
  layers: z.array(layerSchema),
  recordUrlTemplate: z.string().optional(),
  title: z.string().optional(),
});

const featureSchema = z.object({
  geometry: z.object({ coordinates: z.unknown(), type: z.enum(GEOMETRY_TYPES) }).nullable(),
  id: z.union([z.string().min(1), z.number()]),
  properties: z.record(z.string(), z.unknown()).nullable(),
  type: z.literal("Feature"),
});

const rowsPageSchema = z.object({
  cursor: z.string().min(1).nullable(),
  features: z.array(featureSchema),
  revision: z.number(),
  type: z.literal("FeatureCollection"),
});

export type RemoteLayer = z.infer<typeof layerSchema>;

export interface RemoteManifestLayer {
  layer: RemoteLayer;
  recordUrlTemplate?: string;
}

export interface RemoteRowsPage {
  cursor: string | null;
  revision: number;
  rows: ProjectionRow[];
}

/** Resolves the source's base URL and secret from the deployment's env. */
function remoteConfig(source: RemoteSource): { baseUrl: URL; secret: string } {
  const url = process.env[source.env.url],
    secret = process.env[source.env.secret];
  if (url === undefined || url === "" || secret === undefined || secret === "") {
    throw new Error(
      `Remote source ${source.key} is not configured — set ${source.env.url} and ${source.env.secret} on the Convex deployment.`,
    );
  }
  // A trailing slash makes relative paths resolve under the base path.
  return { baseUrl: new URL(url.endsWith("/") ? url : `${url}/`), secret };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type FetchOutcome = { body: unknown; kind: "ok" } | { kind: "retry"; reason: string };

/** One request: ok (parsed JSON), retryable, or a thrown contract error. */
async function fetchOnce(url: URL, secret: string, path: string): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
  } catch (error) {
    return { kind: "retry", reason: error instanceof Error ? error.message : "network error" };
  } finally {
    clearTimeout(timer);
  }
  if (RETRY_STATUSES.has(response.status)) {
    return { kind: "retry", reason: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
  try {
    const body: unknown = await response.json();
    return { body, kind: "ok" };
  } catch {
    throw new Error(`${path} returned a malformed JSON body.`);
  }
}

async function remoteGet(
  source: RemoteSource,
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const { baseUrl, secret } = remoteConfig(source);
  const url = new URL(path, baseUrl);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  let lastReason = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      // oxlint-disable-next-line no-await-in-loop -- retries are sequential by definition.
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
    // oxlint-disable-next-line no-await-in-loop -- retries are sequential by definition.
    const outcome = await fetchOnce(url, secret, path);
    if (outcome.kind === "ok") {
      return outcome.body;
    }
    lastReason = outcome.reason;
  }
  throw new Error(`${path} failed after ${MAX_ATTEMPTS} attempts (${lastReason}).`);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** The source's layer from the remote manifest; throws when the layer is missing. */
export async function fetchManifestLayer(source: RemoteSource): Promise<RemoteManifestLayer> {
  const parsed = manifestSchema.safeParse(await remoteGet(source, "manifest"));
  if (!parsed.success) {
    throw new Error(`The remote manifest is invalid — ${describeIssues(parsed.error)}.`);
  }
  const layer = parsed.data.layers.find((candidate) => candidate.key === source.layer);
  if (layer === undefined) {
    throw new Error(`The remote manifest has no "${source.layer}" layer.`);
  }
  return { layer, recordUrlTemplate: parsed.data.recordUrlTemplate };
}

/** One page of the source's layer, as projection rows (feature id → key). */
export async function fetchRowsPage(
  source: RemoteSource,
  cursor: string | null,
): Promise<RemoteRowsPage> {
  const params: Record<string, string> = { limit: String(ROWS_PAGE_SIZE) };
  if (cursor !== null) {
    params.cursor = cursor;
  }
  const parsed = rowsPageSchema.safeParse(
    await remoteGet(source, `layers/${encodeURIComponent(source.layer)}/rows`, params),
  );
  if (!parsed.success) {
    throw new Error(`A remote rows page is invalid — ${describeIssues(parsed.error)}.`);
  }
  return {
    cursor: parsed.data.cursor,
    revision: parsed.data.revision,
    rows: parsed.data.features.map((feature) => ({
      data: feature.properties ?? {},
      geometry: feature.geometry,
      key: String(feature.id),
    })),
  };
}
