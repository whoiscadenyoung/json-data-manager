import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { auth } from "./auth";
import { newestCompletedAttempt } from "./consumption";
import { resolveDataset } from "./derivedDatasets";
import { specDependencies, specStatus } from "./derivedSpec";
import { alreadyFrozenByRef, createFrozenVersion, type SchemaGeometryType } from "./versioning";

/**
 * The materialized publish (roadmap 5b, #100; docs/catalog-lifecycle-design.md
 * §6/§8.2, ADR 0008): execute a spec ONCE into a real, self-contained frozen
 * version dataset through the existing ingest path — never a virtual publish,
 * never a parallel bulk path.
 *
 * The act has two halves with one handoff point, and this module owns the
 * host half:
 *
 * 1. **Before the freeze** the CLIENT executes the spec (client-side bulk
 *    compute is roadmap §2's fixed boundary — the component can't even host
 *    such an action: components have no Node runtime), chunks the rows, and
 *    uploads each chunk, registering every storage id on the ATTEMPT row as
 *    it lands. The attempt (the `publishAttempts` table, the syncRuns
 *    pattern) is the durability layer the sync engine never needed: chunk
 *    production lives in a browser that can die, so a resumed browser
 *    re-executes the spec and uploads only the missing chunks. Deliberately
 *    NOT merged with the component's `imports` doc — two durability layers,
 *    one handoff (issue scope note).
 * 2. **The freeze** (`freeze`) is one transaction, the versioning.freezeVersion
 *    analog: re-check the publish key globally (a retried/killed publish
 *    cannot fork two v1s — "a ref never freezes twice"), create the frozen
 *    row already published via the shared `createFrozenVersion` core, and
 *    start the component's import workflow with the publish flow's
 *    `boundWrite` attestation. From there durability is already the
 *    workflow's — a killed browser loses nothing — so the attempt only
 *    mirrors the outcome (`pollImport`).
 *
 * Append-only: a republish is a NEW attempt with a NEW publish key and lands
 * as vN+1, a new immutable row; vN is never mutated and never merges back.
 * The read-only enforcement needs no code here: the frozen row carries
 * `lineage`, so the component's `assertDataWritable` rejects every write that
 * no host flow attests.
 *
 * Stage 8 (#104, decision D1): publish is creator-private. `start` refuses a
 * target the caller doesn't own (a draft or saved transform by another user
 * reads exactly as "nothing to publish was found at that id"), and every
 * client-driven step (plan/chunks/reset/freeze/attempt read) rides the
 * attempt's `createdBy` — a foreign attemptId reads as "no longer exists".
 * The auth choke point's per-id policy already bars foreign DRAFTS from every
 * wrapper; this module's checks close the host functions themselves (which
 * resolve ids directly, past any wrapper). The frozen row inherits the
 * draft's `publishedVisibility` (decision D2: the authoring-time choice
 * crosses the lifecycle line with the data).
 *
 * Recorded decisions this module pins:
 * - **Publish key scheme (the issue's open item):** the key is minted once
 *   per attempt (`pub_<time36><rand>`), stored on the attempt, and reused by
 *   every retry of THAT attempt — so retries dedupe and republishes fork.
 *   It deliberately does not hash content: a republish of identical rows is
 *   still a new version (append-only, never a silent no-op).
 * - **Staleness at freeze (the design doc's silence, decided):** the freeze
 *   re-runs the registry's compute-on-read health walk (`specStatus`) and
 *   REFUSES an orphaned or stale spec — freezing a spec whose declared
 *   columns have drifted would betray the lineage. Row-data drift between
 *   the client's execution and the freeze stays accepted (compute-on-read
 *   cannot see it; the recipe records what was actually executed).
 * - **Source versions in lineage (lifecycle §7):** each dependency's
 *   {datasetId, ref?, frozenAt?} at freeze time — a component source
 *   contributes its own lineage when it is itself a frozen version; a
 *   derived source contributes its newest completed attempt's publish key
 *   (the host-side chain the attempts table is).
 */

/** An attempt whose checkpoint hasn't moved for this long is dead (the
 * publishing browser is gone) and gets joined-with-revival rather than
 * blocking a new publish. The sync engine's value, for a client-driven run. */
const STALE_ATTEMPT_MS = 2 * 60 * 1000;

// Poll pacing for the post-freeze import watch (the tag flow's waitForImport
// values): bounded in-action polling, then a durable scheduler re-arm — the
// workflow keeps running server-side no matter what happens to the poller.
const POLL_INTERVAL_MS = 500,
  POLL_LIMIT = 120,
  // Touch the attempt's progress at most this often while polling (the stale
  // clock only needs to see liveness, not every 500 ms).
  PROGRESS_TOUCH_EVERY = 10;

// ---------------------------------------------------------------------------
// Attempt projections and small guards
// ---------------------------------------------------------------------------

/** The light attempt view the client orchestrator and the UI read. */
const attemptView = (attempt: {
  _creationTime: number;
  _id: Id<"publishAttempts">;
  chunkStorageIds: string[];
  datasetKey: string;
  datasetKind: "derived" | "draft";
  error?: string;
  finishedAt?: number;
  importId?: string;
  plannedChunkCount?: number;
  plannedTotalRows?: number;
  publishedSchemaId?: string;
  startedAt: number;
  status: "completed" | "failed" | "importing" | "uploading";
  title: string;
  versionLabel: string;
}) => ({
  _creationTime: attempt._creationTime,
  _id: attempt._id,
  chunkCount: attempt.chunkStorageIds.length,
  datasetKey: attempt.datasetKey,
  datasetKind: attempt.datasetKind,
  error: attempt.error,
  finishedAt: attempt.finishedAt,
  importId: attempt.importId,
  plannedChunkCount: attempt.plannedChunkCount,
  plannedTotalRows: attempt.plannedTotalRows,
  publishedSchemaId: attempt.publishedSchemaId,
  startedAt: attempt.startedAt,
  status: attempt.status,
  title: attempt.title,
  versionLabel: attempt.versionLabel,
});

const attemptViewValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("publishAttempts"),
  chunkCount: v.number(),
  datasetKey: v.string(),
  datasetKind: v.union(v.literal("derived"), v.literal("draft")),
  error: v.optional(v.string()),
  finishedAt: v.optional(v.number()),
  importId: v.optional(v.string()),
  plannedChunkCount: v.optional(v.number()),
  plannedTotalRows: v.optional(v.number()),
  publishedSchemaId: v.optional(v.string()),
  startedAt: v.number(),
  status: v.union(
    v.literal("uploading"),
    v.literal("importing"),
    v.literal("completed"),
    v.literal("failed"),
  ),
  title: v.string(),
  versionLabel: v.string(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One component schema read that tolerates a stored id that isn't a
 * well-formed component id (the registry's `resolveDataset` precedent — the
 * validator would throw, and "not a component dataset" is the answer that
 * keeps walks uniform over plain strings).
 */
async function tryGetSchema(
  ctx: { runQuery: QueryCtx["runQuery"] },
  schemaId: string,
): Promise<FunctionReturnType<typeof components.jsonCms.lib.getSchema>> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Start: resolve the target, join-or-revive the active attempt, mint the key
// ---------------------------------------------------------------------------

/** Resolves what `datasetKey` publishes: a saved registry row or a lifecycle-draft component dataset — the CALLER'S own (stage 8: ownership is part of resolution; a foreign row reads as absent). */
async function resolvePublishTarget(
  ctx: MutationCtx,
  actorId: string,
  datasetKey: string,
): Promise<{ description?: string; kind: "derived" | "draft"; spec?: unknown; title: string }> {
  const registryId = ctx.db.normalizeId("derivedDatasets", datasetKey);
  if (registryId !== null) {
    const row = await ctx.db.get(registryId);
    if (row !== null) {
      if (row.createdBy !== actorId) {
        throw new ConvexError("Nothing to publish was found at that id.");
      }
      if (row.status !== "saved") {
        throw new ConvexError(
          "Save this transform before publishing it — a builder autosave can't publish.",
        );
      }
      return { description: row.description, kind: "derived", spec: row.spec, title: row.title };
    }
  }
  const draft = await tryGetSchema(ctx, datasetKey);
  if (draft !== null) {
    if (draft.createdBy !== actorId) {
      throw new ConvexError("Nothing to publish was found at that id.");
    }
    if (draft.lifecycle !== "draft") {
      throw new ConvexError(
        "Only a draft dataset can be published here — already-published datasets go through their own version flows.",
      );
    }
    // The draft's publishedVisibility is re-resolved at freeze (the draft may
    // still be flipped while the attempt uploads) — it never rides the attempt.
    return { description: draft.description, kind: "draft", title: draft.title };
  }
  throw new ConvexError("Nothing to publish was found at that id.");
}

/** ~62 bits of randomness for idempotency keys (the tags.ts ref mint, widened). */
function randomKeySuffix(): string {
  const draw =
    typeof crypto !== "undefined" && crypto.getRandomValues !== undefined
      ? crypto.getRandomValues(new Uint32Array(2)).reduce((acc, word) => acc * 2 ** 32 + word, 0)
      : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  return draw.toString(36);
}

/**
 * Starts (or joins) the publish attempt for one draft or saved transform.
 * The publish key is minted HERE, once per attempt, and every retry of the
 * attempt reuses it — that is the whole idempotency scheme: retries dedupe,
 * new publishes fork (see the module doc).
 */
export const start = mutation({
  args: { datasetKey: v.string() },
  // Explicit handler return: Convex exposes the HANDLER's return type (the
  // `returns` validator only checks it), and the join branch only ever sees
  // the two non-terminal statuses — without the annotation the client's
  // resolved type could never name "completed"/"failed".
  handler: async (
    ctx,
    args,
  ): Promise<{
    alreadyRunning: boolean;
    attemptId: Id<"publishAttempts">;
    chunkCount: number;
    datasetKind: "derived" | "draft";
    plannedChunkCount?: number;
    status: "completed" | "failed" | "importing" | "uploading";
  }> => {
    const createdBy = await auth(ctx);
    const target = await resolvePublishTarget(ctx, createdBy, args.datasetKey);

    // Join-or-revive (the syncRuns pattern): one live attempt per dataset.
    const latest = await ctx.db
      .query("publishAttempts")
      .withIndex("by_dataset", (q) => q.eq("datasetKey", args.datasetKey))
      .order("desc")
      .first();
    if (latest !== null && (latest.status === "uploading" || latest.status === "importing")) {
      if (Date.now() - latest.lastProgressAt >= STALE_ATTEMPT_MS) {
        // Dead attempt (its browser is gone): touch the clock and revive the
        // right continuation — an uploading attempt waits for its client (the
        // reviving browser IS the continuation); an importing one re-arms the
        // host-side poll.
        await ctx.db.patch(latest._id, { lastProgressAt: Date.now() });
        if (latest.status === "importing") {
          await ctx.scheduler.runAfter(0, internal.publish.pollImport, { attemptId: latest._id });
        }
      }
      return {
        alreadyRunning: true,
        attemptId: latest._id,
        chunkCount: latest.chunkStorageIds.length,
        datasetKind: latest.datasetKind,
        plannedChunkCount: latest.plannedChunkCount,
        status: latest.status,
      };
    }

    // vN: the dataset's completed attempts so far, plus this one. Per-key and
    // naturally small (one row per publish click on ONE dataset).
    const prior = await ctx.db
      .query("publishAttempts")
      .withIndex("by_dataset", (q) => q.eq("datasetKey", args.datasetKey))
      .collect();
    const versionLabel = `v${prior.filter((attempt) => attempt.status === "completed").length + 1}`;
    const attemptId = await ctx.db.insert("publishAttempts", {
      chunkStorageIds: [],
      createdBy,
      datasetKey: args.datasetKey,
      datasetKind: target.kind,
      lastProgressAt: Date.now(),
      // ~62 bits of randomness over the millisecond stamp: the key is
      // GLOBAL and permanent (the freeze's cross-dataset by-ref lookup), so
      // the tag path's two-char mint would be one same-millisecond collision
      // away from adopting a stranger's frozen row as a version.
      publishKey: `pub_${Date.now().toString(36)}${randomKeySuffix()}`,
      spec: target.spec,
      startedAt: Date.now(),
      status: "uploading",
      title: target.title,
      versionLabel,
    });
    return {
      alreadyRunning: false,
      attemptId,
      chunkCount: 0,
      datasetKind: target.kind,
      plannedChunkCount: undefined,
      status: "uploading" as const,
    };
  },
  returns: v.object({
    alreadyRunning: v.boolean(),
    attemptId: v.id("publishAttempts"),
    chunkCount: v.number(),
    datasetKind: v.union(v.literal("derived"), v.literal("draft")),
    plannedChunkCount: v.optional(v.number()),
    status: v.union(
      v.literal("uploading"),
      v.literal("importing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
  }),
});

// ---------------------------------------------------------------------------
// The client-driven steps: plan, per-chunk registration, mismatch reset
// ---------------------------------------------------------------------------

/**
 * Guards the client-driven steps: only a live uploading attempt accepts
 * them — and only its OWNER (stage 8, #104): a foreign attemptId reads as
 * "no longer exists", never disclosing the attempt's state.
 */
async function uploadingAttempt(ctx: MutationCtx, actorId: string, attemptId: Id<"publishAttempts">) {
  const attempt = await ctx.db.get(attemptId);
  if (attempt === null || attempt.createdBy !== actorId) {
    throw new ConvexError("This publish attempt no longer exists.");
  }
  if (attempt.status !== "uploading") {
    throw new ConvexError(`This publish attempt is ${attempt.status} — its chunk phase is closed.`);
  }
  return attempt;
}

/**
 * Records what the client executed BEFORE it uploads: chunk count and total
 * rows always, and — for a derived publish — the frozen row's schema shape
 * (inferred from the executed rows), kind, geometry type, and the spec as
 * actually executed (the lineage recipe records these rows, not whatever the
 * registry row holds by freeze time).
 */
export const plan = mutation({
  args: {
    attemptId: v.id("publishAttempts"),
    chunkCount: v.number(),
    geometryType: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    schema: v.optional(v.any()),
    spec: v.optional(v.any()),
    totalRows: v.number(),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    await uploadingAttempt(ctx, actorId, args.attemptId);
    await ctx.db.patch(args.attemptId, {
      lastProgressAt: Date.now(),
      plannedChunkCount: args.chunkCount,
      plannedGeometryType: args.geometryType,
      plannedKind: args.kind,
      plannedSchema: args.schema,
      plannedTotalRows: args.totalRows,
      // Only a derived publish sends the spec; a draft publish keeps the
      // attempt's original (undefined) — the patch must not clobber it with
      // undefined either way, so it is set only when present.
      ...(args.spec === undefined ? {} : { spec: args.spec }),
    });
  },
  returns: v.null(),
});

/** Appends one uploaded chunk's storage id — the checkpoint a resumed browser resumes from. */
export const registerChunk = mutation({
  args: { attemptId: v.id("publishAttempts"), storageId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const attempt = await uploadingAttempt(ctx, actorId, args.attemptId);
    if (attempt.chunkStorageIds.includes(args.storageId)) {
      // Idempotent: a client replay of an unacked registration (flaky
      // network, Convex's own mutation replay) must not inflate the count
      // the freeze checks — a doubled registration would wedge the attempt
      // permanently above its plan.
      await ctx.db.patch(args.attemptId, { lastProgressAt: Date.now() });
      return;
    }
    await ctx.db.patch(args.attemptId, {
      chunkStorageIds: [...attempt.chunkStorageIds, args.storageId],
      lastProgressAt: Date.now(),
    });
  },
  returns: v.null(),
});

/**
 * Throws away the attempt's uploaded chunks: the client's re-execution
 * produced a different chunk count than the recorded plan (a source changed
 * mid-publish), so the old chunks no longer describe the publish. The
 * markCollected precedent — stale blobs are deleted best-effort and the
 * indexes restart from zero.
 */
export const resetUpload = mutation({
  args: { attemptId: v.id("publishAttempts") },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const attempt = await uploadingAttempt(ctx, actorId, args.attemptId);
    // The blobs live in the COMPONENT's storage (the client uploaded them
    // through the component's upload URL) — host `ctx.storage.delete` cannot
    // reach them, so the delete goes through the component's host-only
    // best-effort cleanup.
    await ctx.runMutation(components.jsonCms.host_support.deleteStorageBlobs, {
      storageIds: attempt.chunkStorageIds,
    });
    await ctx.db.patch(args.attemptId, {
      chunkStorageIds: [],
      lastProgressAt: Date.now(),
      plannedChunkCount: undefined,
      plannedGeometryType: undefined,
      plannedKind: undefined,
      plannedSchema: undefined,
      plannedTotalRows: undefined,
    });
  },
  returns: v.null(),
});

// ---------------------------------------------------------------------------
// The freeze: one transaction, the versioning.freezeVersion analog
// ---------------------------------------------------------------------------

/**
 * A freezeable attempt, narrowed to the fields the freeze reads.
 */
type FreezeableAttempt = {
  chunkStorageIds: string[];
  datasetKey: string;
  datasetKind: "derived" | "draft";
  /** The guard above threw unless this equals the registered chunk count. */
  plannedChunkCount?: number;
  plannedGeometryType?: string;
  plannedKind?: "geospatial" | "standard";
  plannedSchema?: unknown;
  plannedTotalRows?: number;
  publishKey: string;
  spec?: unknown;
  title: string;
  versionLabel: string;
};

/** The freeze's precondition check: already frozen (with its outcome), ready, or a thrown error. */
type FreezeCheck =
  | { attempt: FreezeableAttempt; kind: "ready" }
  | { importId?: string; kind: "frozen"; schemaId: string };

/** Reads the attempt and throws unless it is already frozen or ready to freeze — and the caller owns it (stage 8: a foreign attemptId reads as gone). */
async function freezeCheck(
  ctx: MutationCtx,
  actorId: string,
  attemptId: Id<"publishAttempts">,
): Promise<FreezeCheck> {
  const attempt = await ctx.db.get(attemptId);
  if (attempt === null || attempt.createdBy !== actorId) {
    throw new ConvexError("This publish attempt no longer exists.");
  }
  if (attempt.status === "importing" || attempt.status === "completed") {
    if (attempt.publishedSchemaId === undefined) {
      throw new ConvexError(
        "This publish attempt froze without a version record — start a new publish.",
      );
    }
    return {
      importId: attempt.importId,
      kind: "frozen",
      schemaId: attempt.publishedSchemaId,
    };
  }
  if (attempt.status !== "uploading") {
    throw new ConvexError("This publish attempt failed — start a new publish to retry.");
  }
  if (
    attempt.plannedChunkCount === undefined ||
    // Distinct ids, not raw length: registration is idempotent, so this is
    // defense in depth — a list inflated past its plan (a racing writer, a
    // pre-fix row) must refuse the freeze, never truncate or fork.
    new Set(attempt.chunkStorageIds).size !== attempt.plannedChunkCount
  ) {
    throw new ConvexError(
      "Not every chunk of this publish has landed yet — finish uploading before freezing.",
    );
  }
  return { attempt, kind: "ready" };
}

/**
 * Freezes the attempt's uploaded chunks into a new published version
 * dataset. Everything from the by-key re-check through `startImport` commits
 * atomically, so a retried or killed publish cannot fork two v1s and a
 * frozen row is never left half-registered on the attempt. Idempotent at the
 * attempt level too: freezing an attempt that already froze returns its
 * existing outcome.
 */
export const freeze = mutation({
  args: { attemptId: v.id("publishAttempts") },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const check = await freezeCheck(ctx, actorId, args.attemptId);
    if (check.kind === "frozen") {
      return { alreadyFrozen: true, importId: check.importId, schemaId: check.schemaId };
    }
    const attempt = check.attempt;

    // The idempotency point: the key is global and re-checked inside this
    // transaction (uniqueness by lookup — Convex has no unique index).
    const existing = await alreadyFrozenByRef(ctx, attempt.publishKey);
    if (existing !== null) {
      return { alreadyFrozen: true, importId: undefined, schemaId: existing._id };
    }

    const frozenAt = Date.now();
    const built =
      attempt.datasetKind === "draft"
        ? await draftFreezeInputs(ctx, attempt, frozenAt)
        : await derivedFreezeInputs(ctx, attempt, frozenAt);
    const { importId, schemaId } = await createFrozenVersion(ctx, {
      // The author rides with the visibility choice (stage 8): an
      // author-restricted frozen row must carry the author's identity or it
      // would be invisible to everyone, its author included. The freeze
      // checked ownership above, so the caller IS the attempt's creator.
      actorId,
      boundWrite: "publish",
      chunkStorageIds: attempt.chunkStorageIds,
      collectionsSourceSchemaId: attempt.datasetKind === "draft" ? attempt.datasetKey : undefined,
      geometryType: built.geometryType,
      kind: built.kind,
      lineage: built.lineage,
      publishedVisibility: built.publishedVisibility,
      schema: built.schema,
      source: built.source,
      total: attempt.plannedTotalRows ?? 0,
    });
    await ctx.db.patch(args.attemptId, {
      importId,
      lastProgressAt: frozenAt,
      publishedSchemaId: schemaId,
      status: "importing",
    });
    await ctx.scheduler.runAfter(0, internal.publish.pollImport, { attemptId: args.attemptId });
    return { alreadyFrozen: false, importId, schemaId };
  },
  returns: v.object({
    alreadyFrozen: v.boolean(),
    importId: v.optional(v.string()),
    schemaId: v.string(),
  }),
});

type AttemptDoc = {
  datasetKey: string;
  plannedGeometryType?: string;
  plannedKind?: "geospatial" | "standard";
  plannedSchema?: unknown;
  publishKey: string;
  spec?: unknown;
  title: string;
  versionLabel: string;
};

type FreezeInputs = {
  geometryType?: SchemaGeometryType;
  kind?: "geospatial" | "standard";
  lineage: {
    frozenAt: number;
    recipe?: unknown;
    snapshotRef: string;
    sourceKey?: string;
    sourceSchemaId?: string;
    sourceVersions?: Array<{ datasetId: string; frozenAt?: number; ref?: string }>;
    versionLabel: string;
  };
  /** The published-visibility control crossing the lifecycle line with the data (stage 8, decision D2): the draft's choice inherits onto the frozen row. */
  publishedVisibility?: "author" | "everyone";
  schema: Record<string, unknown>;
  source?: { name: string };
};

/**
 * A draft publish freezes the draft's own shape: its schema (with publish
 * wording), kind, geometry type, and collections — the freezeVersion shape
 * where the source is the draft itself. The lineage stays the narrow tag
 * form anchored on the draft's component id.
 */
async function draftFreezeInputs(
  ctx: MutationCtx,
  attempt: AttemptDoc,
  frozenAt: number,
): Promise<FreezeInputs> {
  const draft = await tryGetSchema(ctx, attempt.datasetKey);
  if (draft === null) {
    throw new ConvexError("The draft dataset was deleted before the publish froze.");
  }
  if (draft.lifecycle !== "draft") {
    throw new ConvexError(
      "This dataset is no longer a draft — start a new publish instead of freezing the old attempt.",
    );
  }
  return {
    geometryType: draft.geometryType,
    kind: draft.kind,
    lineage: {
      frozenAt,
      snapshotRef: attempt.publishKey,
      sourceSchemaId: attempt.datasetKey,
      versionLabel: attempt.versionLabel,
    },
    // Decision D2 (stage 8): the authoring-time visibility choice crosses the
    // lifecycle line with the data — an author-restricted draft publishes
    // into an author-restricted v1.
    publishedVisibility: draft.publishedVisibility,
    schema: {
      ...draft.schema,
      description: `Published ${attempt.versionLabel} of ${draft.title} — a materialized copy, read-only here.`,
    },
    source: draft.source,
  };
}

/**
 * A derived publish freezes what the client executed: the planned schema
 * shape, the recipe, and per-source versions — after the freeze-time health
 * gate refuses an orphaned or stale spec (the recorded decision; see the
 * module doc). No collections: a registry row belongs to none, and the
 * published row is found through the catalog reads like any dataset.
 */
async function derivedFreezeInputs(
  ctx: MutationCtx,
  attempt: AttemptDoc,
  frozenAt: number,
): Promise<FreezeInputs> {
  const spec = attempt.spec;
  if (!isRecord(spec) || attempt.plannedSchema === undefined || attempt.plannedKind === undefined) {
    throw new ConvexError(
      "This attempt never recorded a plan — execute the publish before freezing it.",
    );
  }
  const health = await specStatus(spec, resolveDataset(ctx));
  if (health.health !== "ready") {
    throw new ConvexError(
      `This transform can't publish right now (${health.health}): ${health.reason ?? "its sources have drifted since it was authored"}.`,
    );
  }
  return {
    geometryType: asGeometryType(attempt.plannedGeometryType),
    kind: attempt.plannedKind,
    lineage: {
      frozenAt,
      recipe: spec,
      snapshotRef: attempt.publishKey,
      sourceKey: attempt.datasetKey,
      sourceVersions: await sourceVersionsFor(ctx, spec),
      versionLabel: attempt.versionLabel,
    },
    schema: {
      ...(isRecord(attempt.plannedSchema) ? attempt.plannedSchema : {}),
      description: `Published ${attempt.versionLabel} — materialized from a transform recipe, read-only here.`,
    },
  };
}

/**
 * The geometry type literal guard across the host boundary: the attempt
 * stores the client-reported type as a plain string (the host-boundary id
 * rule), and the component's validator wants one of the six literals.
 * Anything else means "no geometry" — a standard dataset.
 */
const GEOMETRY_TYPE_NAMES = new Set([
  "LineString",
  "MultiLineString",
  "MultiPoint",
  "MultiPolygon",
  "Point",
  "Polygon",
]);

function asGeometryType(value: string | undefined): SchemaGeometryType | undefined {
  if (value === undefined || !GEOMETRY_TYPE_NAMES.has(value)) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to the six literals by the set above; the type derives from the component's validator.
  return value as SchemaGeometryType;
}

/**
 * Per-source versions for the lineage (lifecycle §7), resolved at freeze:
 * a component source contributes its own lineage when it is itself a frozen
 * version; a derived source contributes its newest completed attempt (the
 * host-side chain anchor); a plain live source records just its id — the
 * honest "read live, no frozen version" entry.
 */
async function sourceVersionsFor(
  ctx: MutationCtx,
  spec: Record<string, unknown>,
): Promise<Array<{ datasetId: string; frozenAt?: number; ref?: string }>> {
  const versions: Array<{ datasetId: string; frozenAt?: number; ref?: string }> = [];
  for (const id of specDependencies(spec)) {
    // oxlint-disable-next-line no-await-in-loop -- the walk stops at each source in order; each read decides the next hop.
    const dataset = await tryGetSchema(ctx, id);
    if (dataset !== null) {
      const lineage = dataset.lineage;
      versions.push({
        datasetId: id,
        frozenAt: lineage === undefined ? undefined : lineage.frozenAt,
        ref: lineage === undefined ? undefined : lineage.snapshotRef,
      });
      continue;
    }
    const registryId = ctx.db.normalizeId("derivedDatasets", id);
    if (registryId !== null) {
      // The NEWEST completed attempt is the source's head at this freeze —
      // stage 6's badge compares this record against the same head, so the
      // pre-stage-6 `.find(completed)` (which walked the ascending index and
      // grabbed the OLDEST) had to go; newestCompletedAttempt is the shared
      // decision (consumption.ts).
      const headAttempt = newestCompletedAttempt(
        // oxlint-disable-next-line no-await-in-loop -- the walk stops at each source in order; each read decides the next hop.
        await ctx.db
          .query("publishAttempts")
          .withIndex("by_dataset", (q) => q.eq("datasetKey", id))
          .collect(),
      );
      versions.push({
        datasetId: id,
        frozenAt: headAttempt === undefined ? undefined : headAttempt.finishedAt,
        ref: headAttempt === undefined ? undefined : headAttempt.publishKey,
      });
      continue;
    }
    // The health gate above already refused orphaned specs; this is the
    // defensive tail that keeps the walk total.
    versions.push({ datasetId: id });
  }
  return versions;
}

// ---------------------------------------------------------------------------
// The post-freeze watch: mirror the import workflow's outcome onto the attempt
// ---------------------------------------------------------------------------

export const getAttemptDoc = internalQuery({
  args: { attemptId: v.id("publishAttempts") },
  handler: async (ctx, args) => ctx.db.get(args.attemptId),
  // Same-module internal read — the doc type IS the validator's shape; keep
  // it loose to avoid re-declaring the full attempt validator here (the
  // sync.ts getRunDoc pattern).
  returns: v.any(),
});

/**
 * Best-effort delete of a half-built frozen row so its publish key stays
 * retryable (the tag flow's cleanupPartialVersion precedent): the failed
 * import's committed chunks vanish with the row — the append-only rule's
 * "never write into an existing version row" is what keeps the next
 * attempt's counts and extent exact.
 */
async function deletePartialFrozenVersion(
  ctx: Pick<MutationCtx, "runQuery" | "runMutation">,
  publishKey: string,
): Promise<void> {
  try {
    const partial = await alreadyFrozenByRef(ctx, publishKey);
    if (partial !== null) {
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
        boundWrite: "retire",
        schemaId: partial._id,
      });
    }
  } catch {
    // Cleanup is best-effort; the failure report still stands.
  }
}

export const markAttemptCompleted = internalMutation({
  args: { attemptId: v.id("publishAttempts") },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null || attempt.status !== "importing") {
      return;
    }
    await ctx.db.patch(args.attemptId, {
      finishedAt: Date.now(),
      lastProgressAt: Date.now(),
      status: "completed",
    });
    // Stage 6 (#101): the completion hook the freeze never had — the chain's
    // sequential delta and keep-N retention with pinning, recorded in their
    // own transaction (the delta's versionRows reads the entries the import
    // just finished landing). The tag path's after-ingest pattern
    // (tags.ts), moved to the publish-side completion point.
    await ctx.scheduler.runAfter(0, internal.consumption.afterPublishCompleted, {
      attemptId: args.attemptId,
    });
  },
  returns: v.null(),
});

export const markAttemptFailed = internalMutation({
  args: { attemptId: v.id("publishAttempts"), error: v.string() },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null || attempt.status === "completed" || attempt.status === "failed") {
      return;
    }
    await ctx.db.patch(args.attemptId, {
      error: args.error,
      finishedAt: Date.now(),
      lastProgressAt: Date.now(),
      status: "failed",
    });
    // The publish key stays retryable: a half-built frozen row goes away.
    // The chunk blobs clean through the component too — its own
    // handleImportComplete already deleted the leftovers an import knew
    // about; this sweep covers blobs that never reached an import.
    await deletePartialFrozenVersion(ctx, attempt.publishKey);
    if (attempt.chunkStorageIds.length > 0) {
      await ctx.runMutation(components.jsonCms.host_support.deleteStorageBlobs, {
        storageIds: attempt.chunkStorageIds,
      });
    }
  },
  returns: v.null(),
});

/** Keeps the stale-attempt clock honest while the poller is actively watching. */
export const touchAttempt = internalMutation({
  args: { attemptId: v.id("publishAttempts") },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null || attempt.status !== "importing") {
      return;
    }
    await ctx.db.patch(args.attemptId, { lastProgressAt: Date.now() });
  },
  returns: v.null(),
});

/**
 * Watches the frozen row's import workflow and mirrors its outcome onto the
 * attempt. Bounded in-action polling (the tag flow's waitForImport shape);
 * on cap exhaustion it re-arms itself durably — the import keeps running
 * server-side regardless, and the next poll picks up the result. A poller
 * killed by a restart is revived the same way by `start`'s stale check.
 */
export const pollImport = internalAction({
  args: { attemptId: v.id("publishAttempts") },
  // Explicit return type: the handler references `internal.publish.*`, whose
  // type resolves back through this module — inferring it would be circular.
  handler: async (ctx, args): Promise<null> => {
    const attempt: {
      importId?: string;
      publishKey: string;
      status: string;
    } | null = await ctx.runQuery(internal.publish.getAttemptDoc, { attemptId: args.attemptId });
    if (attempt === null || attempt.status !== "importing" || attempt.importId === undefined) {
      return null;
    }
    for (let poll = 0; poll < POLL_LIMIT; poll += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polling is inherently sequential.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      // oxlint-disable-next-line no-await-in-loop
      const status = await ctx.runQuery(components.jsonCms.lib.getImportStatus, {
        importId: attempt.importId,
      });
      if (status === null) {
        throw new ConvexError("The publish's import status doc disappeared mid-publish.");
      }
      if (status.status === "failed") {
        // oxlint-disable-next-line no-await-in-loop -- polling is inherently sequential.
        await ctx.runMutation(internal.publish.markAttemptFailed, {
          attemptId: args.attemptId,
          error: status.error ?? "The publish's import failed.",
        });
        return null;
      }
      if (status.status === "completed") {
        // oxlint-disable-next-line no-await-in-loop -- polling is inherently sequential.
        await ctx.runMutation(internal.publish.markAttemptCompleted, { attemptId: args.attemptId });
        return null;
      }
      if (poll % PROGRESS_TOUCH_EVERY === 0) {
        // oxlint-disable-next-line no-await-in-loop
        await ctx.runMutation(internal.publish.touchAttempt, { attemptId: args.attemptId });
      }
    }
    await ctx.scheduler.runAfter(POLL_INTERVAL_MS, internal.publish.pollImport, {
      attemptId: args.attemptId,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Reads: the progress row for the UI / the resuming client
// ---------------------------------------------------------------------------

export const attempt = query({
  args: { attemptId: v.id("publishAttempts") },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx);
    const row = await ctx.db.get(args.attemptId);
    // Creator-scoped since stage 8 (#104): an attempt names its dataset's
    // drafts/rows — a foreign attemptId reads as null, same as a missing one.
    if (row === null || row.createdBy !== viewer) {
      return null;
    }
    return attemptView(row);
  },
  returns: v.union(v.null(), attemptViewValidator),
});
