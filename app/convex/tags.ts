import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";

import { collectProjectionRows, SOURCE_KEY } from "./bindings";

/**
 * Tag ingest for bound datasets (docs/bound-datasets-design.md §6, roadmap
 * phase 3). The foreign app owns the version graph; json-cms only mirrors
 * it: each foreign snapshot becomes one frozen "version dataset" — a read-
 * only point-in-time copy with lineage fields on the component's `schemas`
 * doc and its own entries/geometries/tile archive.
 *
 * The flow mirrors the design exactly:
 *
 * 1. The foreign app snapshots its state into a file — here
 *    `createRestaurantSnapshot` serializes the joined tables to JSONL (one
 *    {data, geometry} row per line, the same transport the import pipeline
 *    consumes) and registers the tag in `restaurantSnapshots`. That file is
 *    the point-in-time truth: ingest never re-reads the live tables.
 * 2. `ingestSnapshots` is the design's PULL — an idempotent reconcile that
 *    ingests every snapshot without a frozen version yet. It goes through
 *    the existing import pipeline (chunk upload → startImport → durable
 *    workflow → per-chunk insert), so pagination, denormalized summaries,
 *    and tile-archive staleness all work unchanged. Re-ingesting a ref
 *    can't happen: the version lookup by `lineage.snapshotRef`
 *    short-circuits it, even across a re-bind to a recreated live dataset.
 *
 * Deltas between versions and the compare view are phase 4 — the ops shape
 * they need is the one datasetActivity already carries.
 */

// Snapshot files travel as JSONL with one projection row per line
// (JSON.stringify escapes newlines, so line-splitting is safe). Geometry
// travels whole — the component validates it against the dataset's type at
// import time, so ingest only sanity-checks the envelope.
type SnapshotRow = {
  data: Record<string, unknown>;
  geometry: Record<string, unknown>;
};

type PendingSnapshot = {
  fileStorageId: Id<"_storage">;
  label: string;
  ref: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProjectionRow(value: unknown): SnapshotRow | null {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.geometry)) {
    return null;
  }
  // Pass the geometry object through whole — rebuilding it here would drop
  // its coordinates (caught in end-to-end verification).
  return { data: value.data, geometry: value.geometry };
}

function parseSnapshotRows(text: string): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ConvexError(`Snapshot line ${index + 1} is not valid JSON.`);
    }
    const row = asProjectionRow(parsed);
    if (row === null) {
      throw new ConvexError(
        `Snapshot line ${index + 1} is not a {data, geometry} projection row.`,
      );
    }
    rows.push(row);
  }
  return rows;
}

// Mirrors the client importer's chunking intent (chunkRowsForImport): small
// enough that one chunk's rows fit a request body and one insert pass stays
// well inside the action's memory.
const SNAPSHOT_CHUNK_ROWS = 500,
  SNAPSHOT_CHUNK_BYTES = 768_000;

function chunkRows(rows: SnapshotRow[]): SnapshotRow[][] {
  const chunks: SnapshotRow[][] = [];
  let current: SnapshotRow[] = [],
    currentBytes = 0;
  for (const row of rows) {
    const rowBytes = JSON.stringify(row).length;
    if (
      current.length > 0 &&
      (current.length >= SNAPSHOT_CHUNK_ROWS ||
        currentBytes + rowBytes > SNAPSHOT_CHUNK_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

const snapshotValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("restaurantSnapshots"),
  createdAt: v.number(),
  fileStorageId: v.id("_storage"),
  label: v.string(),
  ref: v.string(),
  rowCount: v.number(),
});

/** The shared projection join, callable from an action. */
export const collectProjectionRowsQuery = internalQuery({
  args: {},
  handler: async (ctx) => collectProjectionRows(ctx),
  returns: v.array(
    v.object({
      data: v.record(v.string(), v.any()),
      geometry: v.object({ coordinates: v.array(v.number()), type: v.string() }),
    }),
  ),
});

/** Inserts the tag row for a snapshot whose file the action already stored. */
export const registerSnapshot = internalMutation({
  args: {
    fileStorageId: v.id("_storage"),
    label: v.string(),
    rowCount: v.number(),
  },
  handler: async (ctx, args) => {
    const createdAt = Date.now(),
      // Opaque foreign snapshot id — unique per snapshot, stable forever,
      // and the only thing ingest needs to have seen before.
      ref = `snap_${createdAt.toString(36)}${Math.floor(Math.random() * 1296)
        .toString(36)
        .padStart(2, "0")}`;
    await ctx.db.insert("restaurantSnapshots", {
      createdAt,
      fileStorageId: args.fileStorageId,
      label: args.label,
      ref,
      rowCount: args.rowCount,
    });
    return { label: args.label, ref, rowCount: args.rowCount };
  },
  returns: v.object({ label: v.string(), ref: v.string(), rowCount: v.number() }),
});

/**
 * The foreign app takes a snapshot: serializes the current state to a JSONL
 * file and registers the tag. Stands in for the design's "push hook on
 * snapshot creation" — the dashboard's snapshots card drives it, and
 * `bunx convex run tags:createRestaurantSnapshot '{"label":"v1"}'` works
 * too. Every call is a NEW foreign snapshot (a fresh ref): idempotency
 * belongs to ingest, not to the foreign app's timeline. An action because
 * file storage writes (`ctx.storage.store`) live on the action writer.
 */
export const createRestaurantSnapshot = action({
  args: { label: v.string() },
  // Explicit return type: this handler references `internal.tags.*`, whose
  // type resolves back through this module — inferring it would be circular.
  handler: async (ctx, args): Promise<{ label: string; ref: string; rowCount: number }> => {
    const label = args.label.trim();
    if (label === "") {
      throw new ConvexError("A snapshot label is required.");
    }
    // Explicit row type — the guidelines' workaround for the same-file
    // runQuery circularity (the query's type lands here via generated api).
    const rows: Awaited<ReturnType<typeof collectProjectionRows>> = await ctx.runQuery(
      internal.tags.collectProjectionRowsQuery,
      {},
    );
    const jsonl = rows.map((row) => JSON.stringify(row)).join("\n"),
      fileStorageId = await ctx.storage.store(new Blob([jsonl], { type: "application/jsonl" }));
    return await ctx.runMutation(internal.tags.registerSnapshot, {
      fileStorageId,
      label,
      rowCount: rows.length,
    });
  },
  returns: v.object({
    label: v.string(),
    ref: v.string(),
    rowCount: v.number(),
  }),
});

/** The foreign app's tag listing, newest first — the snapshots card's rows. */
export const listSnapshots = query({
  args: {},
  handler: async (ctx) => ctx.db.query("restaurantSnapshots").order("desc").take(200),
  returns: v.array(snapshotValidator),
});

const versionValidator = v.object({
  _creationTime: v.number(),
  entryCount: v.optional(v.number()),
  featureCount: v.optional(v.number()),
  lineage: v.optional(
    v.object({
      frozenAt: v.number(),
      snapshotRef: v.optional(v.string()),
      sourceSchemaId: v.string(),
      versionLabel: v.string(),
    }),
  ),
  schemaId: v.string(),
  title: v.string(),
});

/**
 * The frozen versions of one bound live dataset, newest first — a light
 * projection (no `schema`/`uiSchema` payloads) for the dataset page's
 * Versions list and the snapshots card's ingested-state join.
 */
export const listVersions = query({
  args: { sourceSchemaId: v.string() },
  handler: async (ctx, args) => {
    const versions = await ctx.runQuery(components.jsonCms.lib.listSchemaVersions, {
      sourceSchemaId: args.sourceSchemaId,
    });
    return versions.map((version) => ({
      _creationTime: version._creationTime,
      entryCount: version.entryCount,
      featureCount: version.featureCount,
      lineage: version.lineage,
      schemaId: version._id,
      title: version.title,
    }));
  },
  returns: v.array(versionValidator),
});

/** Fetchable URL for one snapshot file — the ingest's transport into the action. */
export const snapshotFileUrl = internalQuery({
  args: { fileStorageId: v.id("_storage") },
  handler: async (ctx, args) => ctx.storage.getUrl(args.fileStorageId),
  returns: v.union(v.null(), v.string()),
});

/**
 * The pull's worklist: snapshots with no frozen version yet, oldest first,
 * plus the live dataset their versions attach to. The already-ingested
 * lookup is global by ref (not scoped to this binding), so a snapshot
 * frozen under an older live dataset is never ingested twice.
 */
export const ingestPlan = internalQuery({
  args: {},
  handler: async (ctx) => {
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_source", (q) => q.eq("source", SOURCE_KEY))
      .first();
    if (binding === null) {
      throw new ConvexError(
        "No bound dataset to attach versions to — create it with a sync (dashboard → Sync now) first.",
      );
    }
    const snapshots = await ctx.db.query("restaurantSnapshots").take(500),
      pending: PendingSnapshot[] = [];
    for (const snapshot of snapshots) {
      // oxlint-disable-next-line no-await-in-loop -- keeps the plan loop readable; the listing is dashboard-bounded.
      const existing = await ctx.runQuery(components.jsonCms.lib.getSchemaVersionBySnapshotRef, {
        snapshotRef: snapshot.ref,
      });
      if (existing === null) {
        pending.push({
          fileStorageId: snapshot.fileStorageId,
          label: snapshot.label,
          ref: snapshot.ref,
        });
      }
    }
    return { sourceSchemaId: binding.schemaId, snapshots: pending };
  },
  returns: v.object({
    sourceSchemaId: v.string(),
    snapshots: v.array(
      v.object({ fileStorageId: v.id("_storage"), label: v.string(), ref: v.string() }),
    ),
  }),
});

/**
 * Freezes one snapshot: creates the version dataset (live dataset's schema
 * shape + read-only `source` marker + `lineage`), files it into the same
 * collections, and starts the import workflow over the uploaded chunks.
 * The by-ref re-check inside this transaction keeps a concurrent double
 * ingest from forking versions.
 */
export const freezeSnapshotVersion = internalMutation({
  args: {
    chunkStorageIds: v.array(v.string()),
    label: v.string(),
    ref: v.string(),
    sourceSchemaId: v.string(),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.runQuery(components.jsonCms.lib.getSchemaVersionBySnapshotRef, {
      snapshotRef: args.ref,
    });
    if (existing !== null) {
      return { alreadyFrozen: true, importId: undefined, schemaId: existing._id };
    }
    const live = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: args.sourceSchemaId,
    });
    if (live === null) {
      throw new ConvexError("The bound live dataset no longer exists — sync and retry.");
    }
    const frozenAt = Date.now(),
      // The version's description rides on the schema object (createSchema
      // reads it from there); the title stays the live dataset's.
      versionSchema = {
        ...live.schema,
        description: `Frozen snapshot "${args.label}" of ${live.title} — a point-in-time copy, read-only here.`,
      },
      schemaId = await ctx.runMutation(components.jsonCms.lib.createSchema, {
        geometryType: live.geometryType,
        kind: live.kind,
        lineage: {
          frozenAt,
          snapshotRef: args.ref,
          sourceSchemaId: args.sourceSchemaId,
          versionLabel: args.label,
        },
        schema: versionSchema,
        source: live.source,
      });
    const collections = await ctx.runQuery(components.jsonCms.lib.listCollectionsBySchema, {
      schemaId: args.sourceSchemaId,
    });
    for (const collection of collections) {
      // oxlint-disable-next-line no-await-in-loop -- one membership write per collection, ordered and trivial.
      await ctx.runMutation(components.jsonCms.lib.addSchemaToCollection, {
        collectionId: collection._id,
        schemaId,
      });
    }
    // An empty snapshot still gets an import doc — zero chunks complete
    // immediately, and status reads uniformly for every version.
    const importId = await ctx.runMutation(components.jsonCms.lib.startImport, {
      schemaId,
      storageIds: args.chunkStorageIds,
      total: args.total,
    });
    return { alreadyFrozen: false, importId, schemaId };
  },
  returns: v.object({
    alreadyFrozen: v.boolean(),
    importId: v.optional(v.string()),
    schemaId: v.string(),
  }),
});

const POLL_INTERVAL_MS = 500,
  POLL_LIMIT = 120;

/**
 * Reads and validates one snapshot file over its storage URL — the same
 * fetch-by-reference transport a remote (side-by-side) source would use.
 */
async function fetchSnapshotRows(
  ctx: Pick<ActionCtx, "runQuery">,
  fileStorageId: Id<"_storage">,
): Promise<SnapshotRow[]> {
  const fileUrl = await ctx.runQuery(internal.tags.snapshotFileUrl, { fileStorageId });
  if (fileUrl === null) {
    throw new ConvexError("Snapshot file is gone from storage.");
  }
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new ConvexError(`Snapshot file fetch failed: HTTP ${response.status}`);
  }
  return parseSnapshotRows(await response.text());
}

/** Uploads rows as chunk blobs the import workflow can read (the browser importer's path). */
async function uploadChunkBlobs(
  ctx: Pick<ActionCtx, "runMutation">,
  rows: SnapshotRow[],
): Promise<string[]> {
  const chunkStorageIds: string[] = [];
  for (const chunk of chunkRows(rows)) {
    // oxlint-disable-next-line no-await-in-loop -- chunks upload sequentially, mirroring the browser importer.
    const uploadUrl = await ctx.runMutation(components.jsonCms.lib.generateUploadUrl, {});
    // oxlint-disable-next-line no-await-in-loop
    const upload = await fetch(uploadUrl, {
      body: JSON.stringify(chunk),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!upload.ok) {
      throw new ConvexError(`Chunk upload failed: HTTP ${upload.status}`);
    }
    // oxlint-disable-next-line no-await-in-loop
    const body: unknown = await upload.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("storageId" in body) ||
      typeof body.storageId !== "string"
    ) {
      throw new ConvexError("Chunk upload did not return a storageId.");
    }
    chunkStorageIds.push(body.storageId);
  }
  return chunkStorageIds;
}

/**
 * Waits for the version's import workflow to settle and returns the frozen
 * dataset's entry count.
 */
async function waitForImport(
  ctx: Pick<ActionCtx, "runQuery">,
  importId: string,
  schemaId: string,
  fallbackCount: number,
): Promise<number> {
  for (let poll = 0; poll < POLL_LIMIT; poll += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling is inherently sequential.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    // oxlint-disable-next-line no-await-in-loop
    const status = await ctx.runQuery(components.jsonCms.lib.getImportStatus, {
      importId,
    });
    if (status === null) {
      throw new ConvexError("Import status doc disappeared.");
    }
    if (status.status === "failed") {
      throw new ConvexError(
        status.error === undefined ? "Snapshot import failed." : status.error,
      );
    }
    if (status.status === "completed") {
      // oxlint-disable-next-line no-await-in-loop
      const version = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
      return version === null ? fallbackCount : (version.entryCount ?? fallbackCount);
    }
  }
  throw new ConvexError("Snapshot import timed out.");
}

/** Best-effort delete of a half-built version so its ref stays retryable. */
async function cleanupPartialVersion(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  ref: string,
): Promise<void> {
  try {
    const partial = await ctx.runQuery(components.jsonCms.lib.getSchemaVersionBySnapshotRef, {
      snapshotRef: ref,
    });
    if (partial !== null) {
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, { schemaId: partial._id });
    }
  } catch {
    // Cleanup is best-effort; the caller's failure report still stands.
  }
}

type IngestOutcome =
  | { kind: "failed"; error: string }
  | { kind: "ingested"; entryCount: number; schemaId: string }
  | { kind: "skipped" };

/** Freezes one snapshot end to end: fetch file → upload chunks → freeze → await import. */
async function ingestOneSnapshot(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  snapshot: PendingSnapshot,
  sourceSchemaId: string,
): Promise<IngestOutcome> {
  try {
    const rows = await fetchSnapshotRows(ctx, snapshot.fileStorageId),
      chunkStorageIds = await uploadChunkBlobs(ctx, rows);
    const freeze = await ctx.runMutation(internal.tags.freezeSnapshotVersion, {
      chunkStorageIds,
      label: snapshot.label,
      ref: snapshot.ref,
      sourceSchemaId,
      total: rows.length,
    });
    if (freeze.alreadyFrozen || freeze.importId === undefined) {
      return { kind: "skipped" };
    }
    const entryCount = await waitForImport(ctx, freeze.importId, freeze.schemaId, rows.length);
    return { entryCount, kind: "ingested", schemaId: freeze.schemaId };
  } catch (error) {
    await cleanupPartialVersion(ctx, snapshot.ref);
    return {
      error: error instanceof Error ? error.message : "Snapshot ingest failed.",
      kind: "failed",
    };
  }
}

/**
 * The design's pull reconcile: ingest every snapshot the foreign app has
 * that json-cms hasn't frozen yet. Safe to call any time (dashboard button,
 * a cron later) — already-ingested snapshots are skipped, and a failed
 * ingest deletes its half-built version so the ref stays retryable.
 */
export const ingestSnapshots = action({
  args: {},
  // Explicit return type — same same-module `internal.tags.*` circularity
  // as createRestaurantSnapshot above.
  handler: async (ctx): Promise<{
    failed: Array<{ error: string; label: string; ref: string }>;
    ingested: Array<{ entryCount: number; label: string; ref: string; schemaId: string }>;
  }> => {
    const plan = await ctx.runQuery(internal.tags.ingestPlan, {}),
      ingested: Array<{
        entryCount: number;
        label: string;
        ref: string;
        schemaId: string;
      }> = [],
      failed: Array<{ error: string; label: string; ref: string }> = [];

    for (const snapshot of plan.snapshots) {
      // oxlint-disable-next-line no-await-in-loop -- snapshots ingest sequentially so a failure is attributable and memory stays bounded.
      const outcome = await ingestOneSnapshot(ctx, snapshot, plan.sourceSchemaId);
      if (outcome.kind === "ingested") {
        ingested.push({
          entryCount: outcome.entryCount,
          label: snapshot.label,
          ref: snapshot.ref,
          schemaId: outcome.schemaId,
        });
      } else if (outcome.kind === "failed") {
        failed.push({ error: outcome.error, label: snapshot.label, ref: snapshot.ref });
      }
    }

    return { failed, ingested };
  },
  returns: v.object({
    failed: v.array(v.object({ error: v.string(), label: v.string(), ref: v.string() })),
    ingested: v.array(
      v.object({
        entryCount: v.number(),
        label: v.string(),
        ref: v.string(),
        schemaId: v.string(),
      }),
    ),
  }),
});
