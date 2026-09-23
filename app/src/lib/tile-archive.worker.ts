/**
 * Tile-archive rebuild worker (issue #58 part 3) — one build per inbound
 * "build" message: page the dataset's geometry rows to exhaustion, assemble a
 * GeoJSON FeatureCollection, run `buildGeometryArchive` (part 1's package),
 * upload the blob through the app's storage upload-url flow, and install it
 * via the app-level `tile_archives.install` wrapper with the version captured
 * BEFORE generation — part 2's `expectedVersion` guard makes a build raced by
 * edits self-discard, so the trailing debounce here only bounds work, never
 * correctness.
 *
 * Runs inside a web worker: the standalone `ConvexClient` keeps every page
 * fetch and its `JSON.parse` off the main thread, and builds serialize
 * (promise-chained) so the CPU-bound tile math never interleaves.
 */
import {
  buildGeometryArchive,
  DEFAULT_MAX_ZOOM,
  type GeoJSONFeature,
  type GeoJSONGeometry,
} from "@caden/geometry-archive";
import { ConvexClient } from "convex/browser";

import { env } from "#/env";
import { api } from "#convex/_generated/api";

import { forEachDatasetGeometryPage, type DatasetGeometryRow } from "./dataset-rows";
import type {
  TileArchiveBuildPhase,
  TileArchiveWorkerInbound,
  TileArchiveWorkerOutbound,
} from "./tile-archive";

/**
 * Minimum geometry-payload bytes an archive is worth building for — keep in
 * sync with `MAP_TILE_ARCHIVE_MIN_BYTES` in the component's `lib.ts` (and its
 * mirror in `./tile-archive`). Applied here, after assembly, on the exact
 * payload size: a small dataset skips upload/install entirely and reports
 * `skipped`.
 */
const MAP_TILE_ARCHIVE_MIN_BYTES = 262_144; // 256 KB

// Worker scope (`DedicatedWorkerGlobalScope`) isn't available to name under
// the app's DOM-lib tsconfig, but `self.postMessage` / `self.addEventListener`
// used here are the same calls on the narrow worker surface this module uses —
// at runtime `self` IS the worker scope.
function post(message: TileArchiveWorkerOutbound): void {
  // Worker-scope `postMessage` takes (message, transfer) — the `targetOrigin`
  // second argument this lint rule wants does not exist in worker scope.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(message);
}

function postPhase(schemaId: string, phase: TileArchiveBuildPhase): void {
  post({ phase, schemaId, type: "phase" });
}

let client: ConvexClient | undefined;

function convexClient(): ConvexClient {
  client ??= new ConvexClient(env.VITE_CONVEX_URL);
  return client;
}

// One heavy build at a time: async page fetches may interleave, but the
// CPU-bound geojson-vt indexing serializes on this worker's single thread.
let buildQueue: Promise<void> = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<TileArchiveWorkerInbound>) => {
  const message = event.data;
  if (!message || message.type !== "build") return;
  const { schemaId } = message;
  buildQueue = buildQueue.then(async () => runBuild(schemaId)).catch(() => undefined); // runBuild reports its own error message; the queue keeps draining.
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const GEOMETRY_TYPES_WITH_COORDINATES = new Set([
  "MultiPoint",
  "MultiLineString",
  "MultiPolygon",
  "Point",
  "LineString",
  "Polygon",
]);

function isGeometry(value: unknown): value is GeoJSONGeometry {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "GeometryCollection") return "geometries" in value;
  return GEOMETRY_TYPES_WITH_COORDINATES.has(value.type) && "coordinates" in value;
}

function parseGeometry(json: string, source: string): GeoJSONGeometry {
  const value: unknown = JSON.parse(json);
  if (!isGeometry(value)) {
    throw new Error(`${source} did not parse to a GeoJSON geometry object.`);
  }
  return value;
}

async function fetchGeometry(url: string): Promise<{ bytes: number; geometry: GeoJSONGeometry }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Geometry payload fetch failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  return { bytes: text.length, geometry: parseGeometry(text, `Geometry payload ${url}`) };
}

function feature(entryId: string, geometry: GeoJSONGeometry): GeoJSONFeature {
  // `_id` is the archive lib's app convention: it becomes the tile feature's
  // `entryId` property — the join key part 4 maps a tile click back through.
  return { _id: entryId, geometry, properties: null, type: "Feature" };
}

interface ResolvedGeometryRow {
  bytes: number;
  entryId: string;
  geometry: GeoJSONGeometry;
}

async function resolveRow(row: DatasetGeometryRow): Promise<ResolvedGeometryRow | null> {
  if (row.geometryJson !== undefined) {
    return {
      bytes: row.geometryJson.length,
      entryId: row.entryId,
      geometry: parseGeometry(row.geometryJson, `Geometry row ${row.entryId}`),
    };
  }
  if (row.geometryUrl === undefined) return null;
  const fetched = await fetchGeometry(row.geometryUrl);
  return { bytes: fetched.bytes, entryId: row.entryId, geometry: fetched.geometry };
}

/**
 * Pages the dataset to exhaustion (`isDone`) and accumulates its features —
 * the cursor chain, page size, and completeness semantics live in the
 * row-resolution seam (`forEachDatasetGeometryPage`, run here on this
 * worker's own client). Rows within a page resolve in parallel; each batch
 * is settled together with every other page's batch once the sequential
 * paging ends.
 */
async function fetchAllGeometryFeatures(
  convex: ConvexClient,
  schemaId: string,
): Promise<{ features: Array<GeoJSONFeature>; payloadBytes: number }> {
  const features: Array<GeoJSONFeature> = [],
    pageRowBatches: Array<Promise<Array<ResolvedGeometryRow | null>>> = [];
  let payloadBytes = 0;
  await forEachDatasetGeometryPage(
    schemaId,
    (rows) => {
      pageRowBatches.push(Promise.all(rows.map(resolveRow)));
    },
    { convex },
  );
  const resolvedRows = await Promise.all(pageRowBatches);
  for (const resolved of resolvedRows.flat()) {
    if (resolved === null) continue;
    features.push(feature(resolved.entryId, resolved.geometry));
    payloadBytes += resolved.bytes;
  }
  return { features, payloadBytes };
}

async function uploadArchive(convex: ConvexClient, archive: Uint8Array): Promise<string> {
  const uploadUrl = await convex.mutation(api.imports.generateUploadUrl, {});
  // The archive is one fresh buffer from `assembleArchive`, so an
  // ArrayBuffer-backed copy for the Blob part is the honest typing.
  const response = await fetch(uploadUrl, {
    body: new Blob([new Uint8Array(archive)], { type: "application/octet-stream" }),
    headers: { "Content-Type": "application/octet-stream" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Archive upload failed with HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("storageId" in body) ||
    typeof body.storageId !== "string"
  ) {
    throw new Error("Archive upload did not return a storageId.");
  }
  return body.storageId;
}

async function buildAndInstall(
  convex: ConvexClient,
  schemaId: string,
  expectedVersion: number,
  features: Array<GeoJSONFeature>,
): Promise<void> {
  postPhase(schemaId, "building");
  const archive = await buildGeometryArchive({
    features,
    maxZoom: DEFAULT_MAX_ZOOM,
  });

  postPhase(schemaId, "uploading");
  const storageId = await uploadArchive(convex, archive);

  postPhase(schemaId, "installing");
  const outcome = await convex.mutation(api.tile_archives.install, {
    bytes: archive.byteLength,
    expectedVersion,
    maxZoom: DEFAULT_MAX_ZOOM,
    schemaId,
    storageId,
  });
  if (outcome === "installed") {
    post({
      builtVersion: expectedVersion,
      bytes: archive.byteLength,
      maxZoom: DEFAULT_MAX_ZOOM,
      schemaId,
      type: "done",
    });
  } else {
    // Edits landed during the build — the guard deleted the incoming blob;
    // a queued/stale-on-view rebuild converges to fresh.
    post({ schemaId, type: "stale-discarded" });
  }
}

async function runBuild(schemaId: string): Promise<void> {
  try {
    const convex = convexClient();
    postPhase(schemaId, "fetching");
    const schema = await convex.query(api.schemas.get, { schemaId });
    if (schema === null || schema.kind !== "geospatial" || schema.geometryType === undefined) {
      post({ reason: "not-geospatial", schemaId, type: "skipped" });
      return;
    }
    const expectedVersion = schema.mapTileCacheVersion ?? 0;
    const { features, payloadBytes } = await fetchAllGeometryFeatures(convex, schemaId);
    if (payloadBytes < MAP_TILE_ARCHIVE_MIN_BYTES) {
      post({ reason: "below-threshold", schemaId, type: "skipped" });
      return;
    }
    await buildAndInstall(convex, schemaId, expectedVersion, features);
  } catch (error) {
    post({
      message: error instanceof Error ? error.message : String(error),
      schemaId,
      type: "error",
    });
  }
}
