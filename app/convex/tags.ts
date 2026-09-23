import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { auth } from "./auth";
import { chunkByJsonBytes, getSource, SOURCE_KEY } from "./sources";
import {
  DEFAULT_KEEP_VERSIONS,
  commitOpValidator,
  diffVersionRows,
  versionRows,
} from "./versioning";

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
 * The freeze/retention/delta cores themselves live in ./versioning
 * (roadmap 0.3's extraction) — this module is the tag path's caller: the
 * snapshot registry and transport, the pull reconcile, and the binding-
 * backed retention policy (`datasetBindings` rows resolved into the keep/
 * pinned values the shared core takes). The compare view reuses the same
 * cores' diff.
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
      throw new ConvexError(`Snapshot line ${index + 1} is not a {data, geometry} projection row.`);
    }
    rows.push(row);
  }
  return rows;
}

// Mirrors the sync engine's chunking intent (chunkByJsonBytes in sources.ts)
// via the same shared helper: small enough that one chunk's rows fit a
// request body and one insert pass stays well inside the action's memory.
const SNAPSHOT_CHUNK_ROWS = 500,
  SNAPSHOT_CHUNK_BYTES = 768_000;

function chunkRows(rows: SnapshotRow[]): SnapshotRow[][] {
  return chunkByJsonBytes(rows, SNAPSHOT_CHUNK_ROWS, SNAPSHOT_CHUNK_BYTES);
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
  handler: async (ctx) => {
    const rows = await getSource(SOURCE_KEY).listRows(ctx);
    // Snapshot files keep the {data, geometry} transport shape (no key) —
    // the file is the point-in-time state the import pipeline consumes.
    return rows.flatMap(({ data, geometry }) =>
      geometry === null || geometry === undefined
        ? []
        : [{ data, geometry: { coordinates: geometry.coordinates, type: geometry.type } }],
    );
  },
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
 * snapshot creation" — the dashboard's snapshots card drives it. Every call
 * is a NEW foreign snapshot (a fresh ref): idempotency belongs to ingest,
 * not to the foreign app's timeline. An action because file storage writes
 * (`ctx.storage.store`) live on the action writer.
 */
export const createRestaurantSnapshot = action({
  args: { label: v.string() },
  // Explicit return type: this handler references `internal.tags.*`, whose
  // type resolves back through this module — inferring it would be circular.
  handler: async (ctx, args): Promise<{ label: string; ref: string; rowCount: number }> => {
    await auth(ctx);
    const label = args.label.trim();
    if (label === "") {
      throw new ConvexError("A snapshot label is required.");
    }
    // Explicit row type — the guidelines' workaround for the same-file
    // runQuery circularity (the query's type lands here via generated api).
    const rows: Array<{
      data: Record<string, unknown>;
      geometry: { coordinates: number[]; type: string };
    }> = await ctx.runQuery(internal.tags.collectProjectionRowsQuery, {});
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
  handler: async (ctx) => {
    await auth(ctx);
    return ctx.db.query("restaurantSnapshots").order("desc").take(200);
  },
  returns: v.array(snapshotValidator),
});

/**
 * Retires one frozen version dataset: deletes it through the component's
 * read-only gate with the host's retirement attestation. The snapshot row
 * and its file stay — the version can always be re-frozen from the same ref
 * (delete the snapshot itself for that to stop being possible). Versions are
 * independent datasets, so unbinding/deleting the live dataset never touches
 * them; each retires on its own here (or later, through a retention policy).
 */
export const retireVersion = mutation({
  args: { schemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: args.schemaId,
    });
    if (schema === null) {
      throw new ConvexError("Version dataset not found.");
    }
    if (schema.lineage === undefined) {
      throw new ConvexError("Only a frozen version dataset can be retired here.");
    }
    await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
      boundWrite: "retire",
      schemaId: args.schemaId,
    });
  },
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
    await auth(ctx);
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
      throw new ConvexError(status.error === undefined ? "Snapshot import failed." : status.error);
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
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
        boundWrite: "retire",
        schemaId: partial._id,
      });
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
    const freeze = await ctx.runMutation(internal.versioning.freezeVersion, {
      boundWrite: "tag-ingest",
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
    // The design's §6 delta-at-ingest: diff the new version against the
    // previous one into the commits' ops shape, then apply the retention
    // policy (keep-N unpinned versions, oldest retire first) — the shared
    // cores in ./versioning, driven by the binding's policy below.
    await ctx.runMutation(internal.versioning.recordVersionDelta, {
      sourceSchemaId,
      toSchemaId: freeze.schemaId,
      toRef: snapshot.ref,
    });
    await ctx.runMutation(internal.tags.enforceBindingRetention, { sourceSchemaId });
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
  handler: async (
    ctx,
  ): Promise<{
    failed: Array<{ error: string; label: string; ref: string }>;
    ingested: Array<{ entryCount: number; label: string; ref: string; schemaId: string }>;
  }> => {
    await auth(ctx);
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

// ---------------------------------------------------------------------------
// Version retention policy (#77): the tag path's store for the shared
// versioning core's (keep, pinned) inputs — the binding row — plus the
// trigger that enforces it after every ingest. The selection/retire logic
// itself lives in ./versioning; the compare view below reuses its diff.
// ---------------------------------------------------------------------------

/**
 * A binding's retention policy with the defaults filled in — the one
 * resolution shared by the settings read, the pin mutation, and the
 * enforce trigger.
 */
function retentionPolicyOf(binding: Doc<"datasetBindings"> | null): {
  keep: number;
  pinnedRefs: string[];
} {
  return {
    keep:
      binding !== null && binding.keepVersions !== undefined
        ? binding.keepVersions
        : DEFAULT_KEEP_VERSIONS,
    pinnedRefs: binding !== null && binding.pinnedRefs !== undefined ? binding.pinnedRefs : [],
  };
}

/**
 * The tag path's retention trigger: resolves the binding's policy (keep-N
 * unpinned versions, pinned refs exempt, default DEFAULT_KEEP_VERSIONS)
 * and enforces it through the shared core in one transaction. Runs after
 * every ingest, so version storage stays bounded no matter how often the
 * foreign app snapshots.
 */
export const enforceBindingRetention = internalMutation({
  args: { sourceSchemaId: v.string() },
  // Explicit return type — the same same-module `internal.*` circularity as
  // createRestaurantSnapshot above (the handler references
  // `internal.versioning.*`, whose generated type resolves back through
  // this module).
  handler: async (ctx, args): Promise<number> => {
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.sourceSchemaId))
      .first();
    const policy = retentionPolicyOf(binding);
    return await ctx.runMutation(internal.versioning.enforceRetention, {
      keep: policy.keep,
      pinnedRefs: policy.pinnedRefs,
      sourceSchemaId: args.sourceSchemaId,
    });
  },
  returns: v.number(),
});

/** Pins (or unpins) one frozen version — pinned versions never auto-retire. */
export const setVersionPinned = mutation({
  args: { pinned: v.boolean(), schemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: args.schemaId,
    });
    if (schema === null || schema.lineage === undefined) {
      throw new ConvexError("Only a frozen version dataset can be pinned.");
    }
    const ref = schema.lineage.snapshotRef;
    if (ref === undefined) {
      throw new ConvexError("This version has no snapshot ref to pin.");
    }
    const sourceSchemaId =
      schema.lineage !== undefined ? schema.lineage.sourceSchemaId : schema._id;
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", sourceSchemaId))
      .first();
    if (binding === null) {
      throw new ConvexError("The source binding no longer exists.");
    }
    const pinned = new Set(retentionPolicyOf(binding).pinnedRefs);
    if (args.pinned) {
      pinned.add(ref);
    } else {
      pinned.delete(ref);
    }
    await ctx.db.patch(binding._id, { pinnedRefs: [...pinned] });
  },
  returns: v.null(),
});

/** Sets the keep-N retention count and enforces it immediately. */
export const setKeepVersions = mutation({
  args: { keep: v.number(), sourceSchemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    if (args.keep < 1) {
      throw new ConvexError("Keep at least one version.");
    }
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.sourceSchemaId))
      .first();
    if (binding === null) {
      throw new ConvexError("The source binding no longer exists.");
    }
    await ctx.db.patch(binding._id, { keepVersions: args.keep });
    await ctx.runMutation(internal.tags.enforceBindingRetention, {
      sourceSchemaId: args.sourceSchemaId,
    });
  },
  returns: v.null(),
});

/** The binding's retention settings + a version's pin state, for the UI. */
export const retentionSettings = query({
  args: { sourceSchemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.sourceSchemaId))
      .first();
    const policy = retentionPolicyOf(binding);
    return { keepVersions: policy.keep, pinnedRefs: policy.pinnedRefs };
  },
  returns: v.object({ keepVersions: v.number(), pinnedRefs: v.array(v.string()) }),
});

/** Light entry rows for one version — the compare overlay's base features. */
export const versionEntries = query({
  args: { schemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    return versionRows(ctx, args.schemaId);
  },
  returns: v.array(v.object({ data: v.record(v.string(), v.any()), key: v.string() })),
});

/**
 * The delta between any two frozen versions, computed on demand into the
 * commits' ops shape — the compare view's add/remove/modify overlay. The
 * ingest's stored sequential deltas (tagDeltas) are the historical record;
 * this is the always-correct arbitrary-pair path.
 */
export const getVersionDelta = query({
  args: { aSchemaId: v.string(), bSchemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const [before, after] = await Promise.all([
      versionRows(ctx, args.aSchemaId),
      versionRows(ctx, args.bSchemaId),
    ]);
    const ops = diffVersionRows(before, after);
    return {
      added: ops.filter((op) => op.op === "add").length,
      ops,
      removed: ops.filter((op) => op.op === "delete").length,
      updated: ops.filter((op) => op.op === "update").length,
    };
  },
  returns: v.object({
    added: v.number(),
    ops: v.array(commitOpValidator),
    removed: v.number(),
    updated: v.number(),
  }),
});
