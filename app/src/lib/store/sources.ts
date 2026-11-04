import { z } from "zod";

/**
 * The bound-datasets source layer, client half (docs/bound-datasets-design.md
 * §4/§8, issue #206; design doc §8.1 "sources.ts" alongside bindings.ts) —
 * the PG counterpart of `app/convex/sources/registry.ts` +
 * `app/convex/sources/remoteClient.ts` (READ-ONLY parity sources).
 *
 * A `BoundSource` is everything the sync machinery knows about a connected
 * external source: the descriptor its bound dataset is created from, the
 * declared field → projection mapping, and the state/commit readers the
 * engine's collect leg drains. The registry itself is CLIENT-side (the server
 * half stores only sync state — migration 0012's `remote_sources` row is a
 * check record, not a descriptor), so a source's rows are read here and
 * applied through the definer RPCs in `./bindings`.
 *
 * Transports:
 *   - "http"   — a remote source (docs/remote-source-adapter-design.md): the
 *     foreign app's `/manifest` + `/layers/{layer}/rows` contract, read with
 *     the validated/retrying client below (remoteClient.ts parity). No commit
 *     feed in v1 — every sync is a full-state pass.
 *   - "client" — a registered reader function pair (the co-deployed form's
 *     analogue: the Convex demo read host tables in-process, and the PG side
 *     keeps that seam open for a stand-in/demo source built over ordinary PG
 *     tables — the migration deliberately carries NO foreign-domain tables).
 *
 * The registry ships the two deployment-data layers (the Convex registry's
 * non-demo entries, parity verbatim); the demo foreign app's sources are NOT
 * carried (issue #206: "demoSources … NOT carried"). Tests and a rebuilt demo
 * inject sources with `registerSource`.
 *
 * All the engine invariants this module feeds are #127's (READ-ONLY parity:
 * app/convex/sources/sync.ts header): a state reader serves ONE PAGE per call
 * and reports its continuation (cursor null = exhausted) — the sync's collect
 * drains pages until the null cursor, because a truncated read would reach
 * finalize's sweep and delete rows past the cap. The commit tail drains page
 * by page until a SHORT page for the same reason.
 */

/** How many commits one `commitsSince` page carries (sourcePaging.ts parity). */
export const COMMIT_TAIL_PAGE = 500;

// ---------------------------------------------------------------------------
// Types (registry.ts parity)
// ---------------------------------------------------------------------------

/** One row of a source's state, as the projection should materialize it. */
export interface ProjectionRow {
  /** The foreign row's stable id — the projection's key. */
  key: string;
  data: Record<string, unknown>;
  /** GeoJSON geometry; null = the row has no geometry. */
  geometry?: { coordinates: unknown; type: string } | null;
}

/** One page of a source's state: the rows plus the read's continuation. */
export interface ProjectionRowPage {
  /** Null once the whole state has been read — the signal callers drain to. */
  cursor: string | null;
  rows: ProjectionRow[];
  /** The source's revision at read time — the FIRST page's value is what a sync records (remote sources; client sources may omit). */
  revision?: number;
}

/** The declared projection mapping — where a row's key and fields come from. */
export interface SourceMapping {
  /** Where a projected row's key comes from, e.g. "restaurantLocations._id". */
  entryKey: string;
  /** Projection field → source path. */
  fields: Record<string, string>;
  /** The geometry rebuild rule the commit-tail apply carries (lat/lng pair). */
  geometry?: { kind: "latLng"; lat: string; lng: string };
}

export type SourceGeometryType =
  | "LineString"
  | "MultiLineString"
  | "MultiPoint"
  | "MultiPolygon"
  | "Point"
  | "Polygon";

/** The descriptor a bound dataset is created from (the migration's binding_ensure p_dataset). */
export interface SourceDataset {
  description: string;
  geometryType?: SourceGeometryType;
  kind: "standard" | "geospatial";
  schema: Record<string, unknown>;
  title: string;
}

/** One field-level change inside a commit op — the design's [name, before, after]. */
export interface CommitField {
  after?: unknown;
  before?: unknown;
  name: string;
}

/** One entry's change in a commit: adds carry full after-state, deletes nothing, updates the touched fields. */
export interface CommitOp {
  entryKey: string;
  fields: CommitField[];
  geometryChanged: boolean;
  op: "add" | "delete" | "update";
}

/** One entry of the design's §8.2 commit feed. */
export interface CommitFeedEntry {
  at: number;
  foreignCommitId: string;
  message: string;
  ops: CommitOp[];
  seq: number;
}

interface SourceBase {
  dataset: SourceDataset;
  key: string;
  mapping: SourceMapping;
}

/** A remote source: one layer of another app's HTTP contract. */
export interface HttpSource extends SourceBase {
  /** Env var NAMES (resolved at call time from import.meta.env — the bundle exposes VITE_-prefixed vars; the Convex descriptors' names gain the prefix). */
  env: { secret: string; url: string };
  /** The layer key in the remote manifest. */
  layer: string;
  transport: "http";
}

/**
 * A client-read source (the co-deployed form's analogue): the readers run in
 * the browser over whatever backs the source (a stand-in/demo PG table via
 * supabase-js, a test stub). Same page contract as the HTTP transport.
 */
export interface ClientSource extends SourceBase {
  /** The design's §8.2 ordered commit feed — everything after `sinceSeq`, ascending; ONE PAGE (a page shorter than COMMIT_TAIL_PAGE ends the drain). Property (arrow) syntax: the collect loop detaches the feed before paging it, and method syntax makes that reference an unbound `this` (oxlint unbound-method). */
  commitsSince?: (sinceSeq: number) => Promise<CommitFeedEntry[]>;
  /** The design's §8.1 state reader: one page of rows. */
  listRows(cursor: string | null): Promise<ProjectionRowPage>;
  /** The newest commit this source has issued, or null when it has none. */
  newestCommit?(): Promise<CommitFeedEntry | null>;
  /** Rebuilds a row's geometry from its (merged) data — the commit-tail apply's geometry refresh. */
  buildGeometry?(data: Record<string, unknown>): { coordinates: unknown; type: string } | null;
  transport: "client";
}

export type BoundSource = HttpSource | ClientSource;

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The registry every bound source must be declared in. */
const SOURCES = new Map<string, BoundSource>();

// The deployment-data app's two geometry layers (the Convex registry's
// non-demo entries, verbatim — json-cms holds one geometry per entry, so the
// centroid and the optional secondary route bind as two datasets keyed by the
// same deployment id).
const DEPLOYMENTS_ENV = {
  secret: "VITE_REMOTE_SOURCE_DEPLOYMENTS_SECRET",
  url: "VITE_REMOTE_SOURCE_DEPLOYMENTS_URL",
};

const deploymentCentroidsSource: HttpSource = {
  dataset: {
    description: "Deployments from the deployment-data app. Bound dataset — read-only here.",
    geometryType: "Point",
    kind: "geospatial",
    schema: { properties: {}, type: "object" },
    title: "Deployments",
  },
  env: DEPLOYMENTS_ENV,
  key: "deployments.centroids",
  layer: "centroids",
  mapping: { entryKey: "deployments.id", fields: {} },
  transport: "http",
};

const deploymentRoutesSource: HttpSource = {
  dataset: {
    description:
      "Secondary route geometry for deployments that have one. Bound dataset — read-only here.",
    geometryType: "MultiLineString",
    kind: "geospatial",
    schema: { properties: {}, type: "object" },
    title: "Deployment routes",
  },
  env: DEPLOYMENTS_ENV,
  key: "deployments.routes",
  layer: "routes",
  mapping: { entryKey: "deployments.id", fields: {} },
  transport: "http",
};

SOURCES.set(deploymentCentroidsSource.key, deploymentCentroidsSource);
SOURCES.set(deploymentRoutesSource.key, deploymentRoutesSource);

/** Registers a source (the stand-in/demo seam: the shipped registry carries only the deployment layers). */
export function registerSource(source: BoundSource): void {
  SOURCES.set(source.key, source);
}

/** Drops a registered source (test teardown). */
export function unregisterSource(key: string): void {
  SOURCES.delete(key);
}

/** Every registered source, in registration order. */
export function registeredSources(): BoundSource[] {
  return [...SOURCES.values()];
}

export function getSource(key: string): BoundSource {
  const source = SOURCES.get(key);
  if (source === undefined) {
    throw new Error(`Unknown bound source: ${key}`);
  }
  return source;
}

/**
 * Splits rows into storage-sized chunks by their JSON encoding (registry.ts's
 * chunkByJsonBytes, verbatim constants: small enough that one chunk's rows
 * fit a request body and one apply pass stays well inside memory).
 */
export function chunkByJsonBytes<T>(items: T[]): T[][] {
  const CHUNK_ROW_LIMIT = 500,
    CHUNK_BYTE_LIMIT = 768_000;
  const chunks: T[][] = [];
  let current: T[] = [],
    currentBytes = 0;
  for (const item of items) {
    const itemBytes = JSON.stringify(item).length;
    if (
      current.length > 0 &&
      (current.length >= CHUNK_ROW_LIMIT || currentBytes + itemBytes > CHUNK_BYTE_LIMIT)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// The HTTP transport (remoteClient.ts parity: validated + retrying)
// ---------------------------------------------------------------------------

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

/** Resolves the source's base URL and secret from the bundle env. */
function remoteConfig(source: HttpSource): { baseUrl: URL; secret: string } {
  const bundleEnv: Record<string, unknown> = import.meta.env,
    url = bundleEnv[source.env.url],
    secret = bundleEnv[source.env.secret];
  if (typeof url !== "string" || url === "" || typeof secret !== "string" || secret === "") {
    throw new Error(
      `Remote source ${source.key} is not configured — set ${source.env.url} and ${source.env.secret}.`,
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
  source: HttpSource,
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
export async function fetchManifestLayer(source: HttpSource): Promise<RemoteManifestLayer> {
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
  source: HttpSource,
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
