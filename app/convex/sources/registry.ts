import { ConvexError } from "convex/values";

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DEMO_SOURCES } from "../demoSources/sources";

/**
 * The bound-datasets source layer (docs/bound-datasets-design.md §4/§8): a
 * `BoundSource` is everything the sync machinery knows about a connected
 * external source — a descriptor for the dataset its projection is created
 * from (schema, kind, geometry), the declared field → projection mapping,
 * and one full-state read. Co-deployed sources read the host's own tables;
 * a remote source (phase 5, #78 — docs/remote-source-adapter-design.md)
 * reads another app's layer over HTTP from the sync's collect action
 * (remoteSources.ts), and the apply/sweep/finalize machinery is unchanged.
 *
 * Adding a bound source means adding one entry to `SOURCES` — no changes
 * anywhere else. The demo foreign app's sources live in ./demoSources and
 * join the registry through one spread.
 */

/** One row of a source's state, as the projection should materialize it. */
export type ProjectionRow = {
  // The foreign row's stable id — the projection's key. The sync applies
  // idempotently per key, so an interrupted run can neither duplicate nor
  // lose rows.
  key: string;
  data: Record<string, unknown>;
  // GeoJSON geometry — any type a remote layer declares. Null means "this
  // row has no geometry"; absent only for non-geospatial sources.
  geometry?: { coordinates: unknown; type: string } | null;
};

/** A co-deployed source's row: the local sources project Points only. */
export type LocalProjectionRow = ProjectionRow & {
  geometry?: { coordinates: number[]; type: string } | null;
};

/** One page of a local source's state: the rows plus the read's continuation. */
export type ProjectionRowPage = {
  // Null once the whole state has been read — the signal callers drain to.
  cursor: string | null;
  rows: LocalProjectionRow[];
};

/**
 * The declared projection mapping — where a row's key and fields come from.
 * Stored on the binding row for observability; the row builder below
 * implements it in code (the restaurantLocations join spans three tables,
 * which a purely declarative mapping can't express).
 */
export type SourceMapping = {
  // Where a projected row's key comes from, e.g. "restaurantLocations._id".
  entryKey: string;
  // Projection field → source path, e.g. { label: "locations.label" }.
  fields: Record<string, string>;
  geometry?: { kind: "latLng"; lat: string; lng: string };
};

export type SourceGeometryType =
  | "LineString"
  | "MultiLineString"
  | "MultiPoint"
  | "MultiPolygon"
  | "Point"
  | "Polygon";

export type SourceDataset = {
  description: string;
  geometryType?: SourceGeometryType;
  kind: "standard" | "geospatial";
  schema: Record<string, unknown>;
  title: string;
};

/** One field-level change inside a commit op — the design's [name, before, after]. */
export type CommitField = {
  after?: unknown;
  before?: unknown;
  name: string;
};

/** One entry's change in a commit: adds carry full after-state, deletes nothing, updates the touched fields. */
export type CommitOp = {
  entryKey: string;
  fields: CommitField[];
  geometryChanged: boolean;
  op: "add" | "delete" | "update";
};

/** One entry of the design's §8.2 commit feed (co-deployed form). */
export type CommitFeedEntry = {
  at: number;
  foreignCommitId: string;
  message: string;
  ops: CommitOp[];
  seq: number;
};

/** One registered foreign snapshot: its opaque ref, label, and stored file. */
export type SourceSnapshot = {
  fileStorageId: Id<"_storage">;
  label: string;
  ref: string;
};

interface SourceBase {
  dataset: SourceDataset;
  key: string;
  mapping: SourceMapping;
}

/** A co-deployed source: reads the host's own tables inside a query. */
export interface LocalSource extends SourceBase {
  transport: "local";
  /** The design's §8.1 state reader, co-deployed form: one page of rows. */
  listRows(ctx: Pick<QueryCtx, "db">, cursor: string | null): Promise<ProjectionRowPage>;
  /**
   * The design's §8.2 ordered commit feed — everything after `sinceSeq`,
   * ascending. Absent means the source has no commit log; sync for such a
   * source always takes the full-state path.
   */
  commitsSince?(ctx: Pick<QueryCtx, "db">, sinceSeq: number): Promise<CommitFeedEntry[]>;
  /** The newest commit this source has issued, or null when it has none. */
  newestCommit?(ctx: Pick<QueryCtx, "db">): Promise<CommitFeedEntry | null>;
  /**
   * Rebuilds a row's geometry from its (merged) data — the commit-tail apply
   * uses this to refresh geometry after field deltas touch it. Absent for
   * non-geospatial sources.
   */
  buildGeometry?(data: Record<string, unknown>): { coordinates: number[]; type: string } | null;
  /**
   * The design's §8.3 snapshot listing — the foreign app's registered
   * snapshots (tags), each a stored JSONL file of {data, geometry} rows.
   * Absent means the source takes no snapshots; tag ingest serves the one
   * registered source that has it.
   */
  listSnapshots?(ctx: Pick<QueryCtx, "db">): Promise<SourceSnapshot[]>;
}

/**
 * A remote source (#78): one layer of another app's HTTP contract
 * (`/manifest` + `/layers/{layer}/rows`). It has no commit feed in v1 — every
 * sync is a full-state pass, user-initiated, with the manifest's per-layer
 * `revision` as the staleness signal. `dataset` is only the fallback
 * descriptor; a bind creates the dataset from the live manifest.
 */
export interface RemoteSource extends SourceBase {
  /** Env var NAMES (resolved at call time) for the base URL and bearer secret. */
  env: { secret: string; url: string };
  /** The layer key in the remote manifest. */
  layer: string;
  transport: "http";
}

export type BoundSource = LocalSource | RemoteSource;

// The paging contract every co-deployed reader honors lives in
// ./sourcePaging (a dependency-free module, so ./demoSources can share it
// without an import cycle through this registry).
export { COMMIT_TAIL_PAGE } from "./sourcePaging";

// The deployment-data app's two geometry layers (demo stand-in:
// demo/deploy-source). json-cms holds one geometry per entry, so the
// centroid and the optional secondary route bind as two datasets keyed by
// the same deployment id.
const DEPLOYMENTS_ENV = {
  secret: "REMOTE_SOURCE_DEPLOYMENTS_SECRET",
  url: "REMOTE_SOURCE_DEPLOYMENTS_URL",
};

const deploymentCentroidsSource: RemoteSource = {
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

const deploymentRoutesSource: RemoteSource = {
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

/** The registry every bound source must be declared in. */
export const SOURCES: Record<string, BoundSource> = Object.fromEntries(
  [
    // The demo foreign app's co-deployed sources (./demoSources) — removable
    // with this line plus the folder and its schema.ts spread.
    ...DEMO_SOURCES,
    deploymentCentroidsSource,
    deploymentRoutesSource,
  ].map((source) => [source.key, source]),
);

export function getSource(key: string): BoundSource {
  const source = SOURCES[key];
  if (source === undefined) {
    throw new ConvexError(`Unknown bound source: ${key}`);
  }
  return source;
}

/** A co-deployed source — the query-side readers only ever serve these. */
export function getLocalSource(key: string): LocalSource {
  const source = getSource(key);
  if (source.transport !== "local") {
    throw new ConvexError(`Bound source ${key} is remote — it is read over HTTP, not by a query.`);
  }
  return source;
}

export function getRemoteSource(key: string): RemoteSource {
  const source = getSource(key);
  if (source.transport !== "http") {
    throw new ConvexError(`Bound source ${key} is not a remote source.`);
  }
  return source;
}

export function isRemoteSourceKey(key: string): boolean {
  const source = SOURCES[key];
  return source !== undefined && source.transport === "http";
}

/**
 * The primary co-deployed source — the first local source in registry order
 * (the dashboard's status badge and CLI checks read its binding), or null
 * when none is registered.
 */
export function primaryLocalSourceKey(): string | null {
  const source = Object.values(SOURCES).find((candidate) => candidate.transport === "local");
  return source === undefined ? null : source.key;
}

/** The registered source that takes snapshots (§8.3), or null when none does. */
export function snapshotSource(): LocalSource | null {
  const source = Object.values(SOURCES).find(
    (candidate): candidate is LocalSource =>
      candidate.transport === "local" && candidate.listSnapshots !== undefined,
  );
  return source === undefined ? null : source;
}

/** Every registered remote source, in registry order. */
export function remoteSources(): RemoteSource[] {
  return Object.values(SOURCES).filter(
    (source): source is RemoteSource => source.transport === "http",
  );
}

// Mirrors the client importer's chunking intent (and the snapshot ingest's):
// small enough that one chunk's rows fit a request body and one apply pass
// stays well inside action memory.
const CHUNK_ROW_LIMIT = 500,
  CHUNK_BYTE_LIMIT = 768_000;

/** Splits rows into storage-sized chunks by their JSON encoding. */
export function chunkByJsonBytes<T>(
  items: T[],
  rowLimit = CHUNK_ROW_LIMIT,
  byteLimit = CHUNK_BYTE_LIMIT,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [],
    currentBytes = 0;
  for (const item of items) {
    const itemBytes = JSON.stringify(item).length;
    if (
      current.length > 0 &&
      (current.length >= rowLimit || currentBytes + itemBytes > byteLimit)
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
