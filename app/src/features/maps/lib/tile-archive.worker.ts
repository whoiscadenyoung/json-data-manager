/**
 * Tile-archive rebuild worker (issue #58 part 3; stage 2 adds the Postgres
 * path, issue #201) — one build per inbound "build" message: page the
 * dataset's geometry rows to exhaustion, assemble a GeoJSON
 * FeatureCollection, run `buildGeometryArchive` (part 1's package), upload
 * the blob through storage, and install it with the version captured BEFORE
 * generation — the `expectedVersion` guard (the component's, SQL edition for
 * PG: `install_tile_archive`) makes a build raced by edits self-discard, so
 * the trailing debounce here only bounds work, never correctness.
 *
 * WHICH backend a build targets is the dataset id's origin
 * (`isPostgresDatasetId`): uuid ids page `dataset_rows_for_tiles` through the
 * PG row-resolution seam (`forEachDatasetGeometryPage`, run on this worker's
 * OWN plain `createClient` — the cookie-bound browser client is a
 * main-thread object; importing the seam's chain here is safe because every
 * store call takes the override client and the browser client's cookie reads
 * are lazy closures that never fire on this path), while Convex ids keep the
 * byte-for-byte original path below.
 *
 * Runs inside a web worker: the standalone `ConvexClient` / supabase client
 * keep every page fetch and its `JSON.parse` off the main thread, and builds
 * serialize (promise-chained) so the CPU-bound tile math never interleaves.
 * Both clients authenticate by requesting the session's token from the main
 * thread over the message channel — see `fetchTokenFromMain` below.
 */
import {
  buildGeometryArchive,
  DEFAULT_MAX_ZOOM,
  type GeoJSONFeature,
} from "@caden/geometry-archive";
import { BoundedPool } from "@caden/maps/bounded-pool";
import type { TileArchiveBuildPhase } from "@caden/maps/build-scheduler";
import {
  feature,
  fetchGeometry,
  parseGeometry,
  resolveRow,
  utf8ByteLength,
  type ResolvedGeometryRow,
} from "@caden/maps/geometry-features";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ConvexClient } from "convex/browser";

import { env } from "#/env";
import { forEachDatasetGeometryPage } from "#/lib/dataset-rows";
import type { DatasetGeometryRow } from "#/lib/dataset-rows-pg";
import { forEachDatasetGeometryPage as forEachPgGeometryPage } from "#/lib/dataset-rows-pg";
import { isPostgresDatasetId } from "#/lib/dataset-source";
import {
  createGeometrySourceUrl,
  createTileArchiveUploadUrl,
  installTileArchive,
  tileDatasetInfo,
} from "#/lib/store/geometries";
import { api } from "#convex/_generated/api";

import { MAP_TILE_ARCHIVE_FORMAT, pgTileArchiveUploadPath } from "./pg-tile-archives";
import type {
  TileArchiveWorkerInbound,
  TileArchiveWorkerOutbound,
  TileTokenSource,
} from "./tile-archive";

/**
 * Minimum geometry-payload bytes an archive is worth building for — keep in
 * sync with `MAP_TILE_ARCHIVE_MIN_BYTES` in the component's `lib.ts` (and its
 * mirror in `@caden/maps/build-scheduler`). Applied here, after assembly, on the exact
 * payload size: a small dataset skips upload/install entirely and reports
 * `skipped`.
 */
const MAP_TILE_ARCHIVE_MIN_BYTES = 262_144; // 256 KB

/**
 * Geometry payload fetches in flight at once (issue #134's 8–16 band). Each
 * page's rows used to start fetching unbounded — a 40-page dataset ran
 * hundreds of concurrent fetches. Twelve overlaps page round trips without
 * thrashing the browser's per-origin connection pool.
 */
const GEOMETRY_FETCH_POOL_SIZE = 12;

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

/**
 * The standalone client authenticates through the main thread: its setAuth
 * fetcher round-trips a token request over the message channel (the worker
 * has no Better Auth session of its own). Since the sign-in gate (roadmap
 * 0.1) every data call — geometry paging, the schema read, the upload URL,
 * the install — is rejected without identity. The main thread replies with
 * null when signed out; the client then runs unauthenticated and builds
 * fail with the gate's sign-in error. The PG path requests the Supabase
 * access token the same way (source: "supabase") and fails the build
 * LOUDLY on null — an unauthenticated PG client would silently see zero
 * RLS-visible rows and build an empty archive, which the guard would then
 * happily install.
 */
let tokenRequestSeq = 0;
const pendingTokenRequests = new Map<number, (token: string | null) => void>();

async function fetchTokenFromMain(source: TileTokenSource): Promise<string | null> {
  return new Promise((resolve) => {
    tokenRequestSeq += 1;
    pendingTokenRequests.set(tokenRequestSeq, resolve);
    post({ requestId: tokenRequestSeq, source, type: "token-request" });
  });
}

function convexClient(): ConvexClient {
  // ARCHIVED at the stage-7 disconnect (issue #206): this branch built
  // `new ConvexClient(env.VITE_CONVEX_URL)` with a main-thread token round
  // trip — `VITE_CONVEX_URL` left `#/env` with the provider unmount, and no
  // Convex-origin dataset exists to build for, so the branch now fails
  // loudly instead of dialing a deployment the shell no longer wires.
  throw new Error(
    "Convex tile sources are archived in this build (stage 7 disconnect): only Postgres datasets build tile archives.",
  );
}

// One heavy build at a time: async page fetches may interleave, but the
// CPU-bound geojson-vt indexing serializes on this worker's single thread.
let buildQueue: Promise<void> = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<TileArchiveWorkerInbound>) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "token") {
    const resolve = pendingTokenRequests.get(message.requestId);
    if (resolve !== undefined) {
      pendingTokenRequests.delete(message.requestId);
      resolve(message.token);
    }
    return;
  }
  if (message.type !== "build") return;
  const { schemaId } = message;
  if (isPostgresDatasetId(schemaId)) {
    // The PG path never touches the Convex client (constructing one opens a
    // WebSocket this build has no use for); its supabase client is built
    // per build from a fresh token.
    buildQueue = buildQueue.then(async () => runPgBuild(schemaId)).catch(() => undefined);
    return;
  }
  // Re-assert auth per build so a client first created signed out
  // authenticates as soon as a session exists (sign-out reloads the page,
  // but sign-in does not).
  convexClient().setAuth(async () => await fetchTokenFromMain("convex"));
  buildQueue = buildQueue.then(async () => runBuild(schemaId)).catch(() => undefined); // runBuild reports its own error message; the queue keeps draining.
});

/**
 * Pages the dataset to exhaustion (`isDone`) and accumulates its features —
 * the cursor chain, page size, and completeness semantics live in the
 * row-resolution seam (`forEachDatasetGeometryPage`, run here on this
 * worker's own client). Rows resolve through {@link BoundedPool} so at most
 * {@link GEOMETRY_FETCH_POOL_SIZE} fetches are ever in flight, across pages
 * too: a page's fetches run while the next page's query is still in flight.
 * Exported for the pool-contract test (issue #134).
 */
export async function fetchAllGeometryFeatures(
  convex: ConvexClient,
  schemaId: string,
  onProgress?: (fetchedRows: number) => void,
): Promise<{ features: Array<GeoJSONFeature>; payloadBytes: number }> {
  const features: Array<GeoJSONFeature> = [];
  const pool = new BoundedPool(GEOMETRY_FETCH_POOL_SIZE);
  const rowTasks: Array<Promise<ResolvedGeometryRow | null>> = [];
  let fetchedRows = 0;
  await forEachDatasetGeometryPage(
    schemaId,
    (rows) => {
      fetchedRows += rows.length;
      if (onProgress !== undefined) onProgress(fetchedRows);
      for (const row of rows) {
        rowTasks.push(
          pool.run(async () => {
            return await resolveRow(row);
          }),
        );
      }
    },
    { convex },
  );
  const resolvedRows = await Promise.all(rowTasks);
  let payloadBytes = 0;
  for (const resolved of resolvedRows) {
    if (resolved === null) continue;
    features.push(feature(resolved.entryId, resolved.geometry));
    payloadBytes += resolved.bytes;
  }
  return { features, payloadBytes };
}

/**
 * Uploads the archive through the app's storage upload-url flow, issued for
 * THIS dataset (`scope`) — the install then presents the issuance token, and
 * an id that didn't come from a server-issued upload for this dataset is
 * rejected at `tile_archives.install` (issue #131).
 */
async function uploadArchive(
  convex: ConvexClient,
  schemaId: string,
  archive: Uint8Array,
): Promise<{ storageId: string; uploadId: string }> {
  const { storageUrl, uploadId } = await convex.mutation(api.cms.imports.generateUploadUrl, {
    scope: schemaId,
  });
  // The archive is one fresh buffer from `assembleArchive`, so an
  // ArrayBuffer-backed copy for the Blob part is the honest typing.
  const response = await fetch(storageUrl, {
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
  return { storageId: body.storageId, uploadId };
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
  const { storageId, uploadId } = await uploadArchive(convex, schemaId, archive);

  postPhase(schemaId, "installing");
  const outcome = await convex.mutation(api.cms.tile_archives.install, {
    bytes: archive.byteLength,
    expectedVersion,
    maxZoom: DEFAULT_MAX_ZOOM,
    schemaId,
    storageId,
    uploadId,
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
    const schema = await convex.query(api.cms.schemas.get, { schemaId });
    if (schema === null || schema.kind !== "geospatial" || schema.geometryType === undefined) {
      post({ reason: "not-geospatial", schemaId, type: "skipped", version: 0 });
      return;
    }
    const expectedVersion = schema.mapTileCacheVersion ?? 0;
    const total = schema.featureCount ?? 0,
      { features, payloadBytes } = await fetchAllGeometryFeatures(convex, schemaId, (done) => {
        if (total > 0) post({ done: Math.min(done, total), schemaId, total, type: "progress" });
      });
    if (payloadBytes < MAP_TILE_ARCHIVE_MIN_BYTES) {
      // The version rides along so the manager can memoize the skip —
      // without it a below-threshold dataset reads as stale forever and
      // refetches on every summaries update (issue #134).
      post({ reason: "below-threshold", schemaId, type: "skipped", version: expectedVersion });
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

// ---------------------------------------------------------------------------
// The Postgres path (stage 2, issue #201): same phases, same threshold, same
// skip memo messages, same terminal protocol — only the feed, the upload,
// and the install differ (§5.5 keyset RPC + §6 signed upload URL + §5.6 CAS).
// ---------------------------------------------------------------------------

/**
 * The worker's own supabase client, built per PG build from a FRESH access
 * token (a long-lived client would carry an expired bearer past the token's
 * hour; a fresh client costs nothing — there is no socket to re-establish).
 * `persistSession: false` keeps GoTrue away from localStorage, which a
 * worker scope does not have. The identity rides every request as the
 * Authorization header, so RLS scopes the dataset read, the geometry RPC,
 * the signed upload URL, and the install exactly as the signed-in user.
 */
async function pgSupabaseClient(): Promise<SupabaseClient> {
  const token = await fetchTokenFromMain("supabase");
  if (token === null) {
    throw new Error("Sign in to build tiles for Postgres datasets.");
  }
  return createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * Resolves one PG geometry row for the archive builder — the PG edition of
 * `resolveRow` (whose row shape this backend does not share): inline `source`
 * jsonb parses LOCALLY (stringified once for the #134 JSON-encoded byte
 * accounting, then validated), oversized payloads fetch through a Storage
 * signed URL (§6) resolved INSIDE the pool task so the URL round trip +
 * payload fetch count against the same bound. Throws on a malformed or
 * failed row — a build with unreadable geometry must fail loudly, never
 * install a partial archive.
 */
async function resolvePgRow(
  supabase: SupabaseClient,
  row: DatasetGeometryRow,
): Promise<ResolvedGeometryRow | null> {
  if (row.geometry !== null && row.geometry !== undefined) {
    const json = JSON.stringify(row.geometry);
    return {
      bytes: utf8ByteLength(json),
      entryId: row.entryId,
      geometry: parseGeometry(json, `Geometry row ${row.entryId}`),
    };
  }
  if (row.sourcePath === null || row.sourcePath === undefined) return null;
  const url = await createGeometrySourceUrl(supabase, row.sourcePath);
  const fetched = await fetchGeometry(url);
  return { bytes: fetched.bytes, entryId: row.entryId, geometry: fetched.geometry };
}

/**
 * The PG edition of {@link fetchAllGeometryFeatures}: pages
 * `dataset_rows_for_tiles` to exhaustion (`nextCursor === null`, the seam's
 * completeness rule) through the REAL seam (store RPC + cursor chain, on
 * this worker's client), resolving rows through {@link BoundedPool} so at
 * most {@link GEOMETRY_FETCH_POOL_SIZE} payload fetches are ever in flight,
 * across pages too. Exported for the pool-contract test (issue #134's PG
 * mirror).
 */
export async function fetchAllPgGeometryFeatures(
  supabase: SupabaseClient,
  datasetId: string,
  onProgress?: (fetchedRows: number) => void,
): Promise<{ features: Array<GeoJSONFeature>; payloadBytes: number }> {
  const features: Array<GeoJSONFeature> = [];
  const pool = new BoundedPool(GEOMETRY_FETCH_POOL_SIZE);
  const rowTasks: Array<Promise<ResolvedGeometryRow | null>> = [];
  let fetchedRows = 0;
  await forEachPgGeometryPage(
    datasetId,
    (rows) => {
      fetchedRows += rows.length;
      if (onProgress !== undefined) onProgress(fetchedRows);
      for (const row of rows) {
        rowTasks.push(
          pool.run(async () => {
            return await resolvePgRow(supabase, row);
          }),
        );
      }
    },
    { supabase },
  );
  const resolvedRows = await Promise.all(rowTasks);
  let payloadBytes = 0;
  for (const resolved of resolvedRows) {
    if (resolved === null) continue;
    features.push(feature(resolved.entryId, resolved.geometry));
    payloadBytes += resolved.bytes;
  }
  return { features, payloadBytes };
}

/**
 * Uploads the archive via a signed upload URL (design §6: "browser requests
 * a signed URL, PUTs the bytes, then writes the row/RPC") for a path unique
 * to this attempt — the install RPC then claims it.
 */
async function uploadPgArchive(
  supabase: SupabaseClient,
  datasetId: string,
  expectedVersion: number,
  archive: Uint8Array,
): Promise<string> {
  const path = pgTileArchiveUploadPath(datasetId, expectedVersion);
  const { signedUrl } = await createTileArchiveUploadUrl({ path }, { supabase });
  const response = await fetch(signedUrl, {
    body: new Blob([new Uint8Array(archive)], { type: "application/octet-stream" }),
    headers: { "Content-Type": "application/octet-stream" },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`Archive upload failed with HTTP ${response.status}`);
  }
  return path;
}

async function buildAndInstallPg(
  supabase: SupabaseClient,
  datasetId: string,
  expectedVersion: number,
  features: Array<GeoJSONFeature>,
): Promise<void> {
  postPhase(datasetId, "building");
  const archive = await buildGeometryArchive({
    features,
    maxZoom: DEFAULT_MAX_ZOOM,
  });

  postPhase(datasetId, "uploading");
  const path = await uploadPgArchive(supabase, datasetId, expectedVersion, archive);

  postPhase(datasetId, "installing");
  const installed = await installTileArchive(
    {
      builtVersion: expectedVersion,
      bytes: archive.byteLength,
      datasetId,
      expectedVersion,
      // The layout generation this builder produced — the #125 format gate
      // compares exactly this stamp (see pg-tile-archives.ts).
      format: MAP_TILE_ARCHIVE_FORMAT,
      maxZoom: DEFAULT_MAX_ZOOM,
      path,
    },
    { supabase },
  );
  if (installed) {
    post({
      builtVersion: expectedVersion,
      bytes: archive.byteLength,
      maxZoom: DEFAULT_MAX_ZOOM,
      schemaId: datasetId,
      type: "done",
    });
  } else {
    // Edits landed during the build — the CAS rejected the install (the
    // uploaded object is never claimed); a queued/stale-on-view rebuild
    // converges to fresh.
    post({ schemaId: datasetId, type: "stale-discarded" });
  }
}

async function runPgBuild(datasetId: string): Promise<void> {
  try {
    postPhase(datasetId, "fetching");
    const supabase = await pgSupabaseClient();
    const info = await tileDatasetInfo({ datasetId }, { supabase });
    if (info === null || !info.isGeospatial || info.geometryType === null) {
      post({ reason: "not-geospatial", schemaId: datasetId, type: "skipped", version: 0 });
      return;
    }
    const expectedVersion = info.mapTileCacheVersion;
    const total = info.featureCount,
      { features, payloadBytes } = await fetchAllPgGeometryFeatures(supabase, datasetId, (done) => {
        if (total > 0)
          post({ done: Math.min(done, total), schemaId: datasetId, total, type: "progress" });
      });
    if (payloadBytes < MAP_TILE_ARCHIVE_MIN_BYTES) {
      // The version rides along so the manager can memoize the skip (the
      // #134 rule, shared memo with the Convex path — id spaces are disjoint).
      post({
        reason: "below-threshold",
        schemaId: datasetId,
        type: "skipped",
        version: expectedVersion,
      });
      return;
    }
    await buildAndInstallPg(supabase, datasetId, expectedVersion, features);
  } catch (error) {
    post({
      message: error instanceof Error ? error.message : String(error),
      schemaId: datasetId,
      type: "error",
    });
  }
}
