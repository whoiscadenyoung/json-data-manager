import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { auth } from "./auth";
import { specDependencies } from "./derivedSpec";
import {
  commitOpValidator,
  DEFAULT_KEEP_VERSIONS,
  diffVersionRows,
  previousVersionOf,
  versionRowsBounded,
  versionsToRetire,
} from "./versioning";

/** The db types the read-side and write-side helpers take (structural picks, the versionRows pattern). */
type ReadDb = QueryCtx["db"];
type WriteDb = MutationCtx["db"];
type RunQuery = QueryCtx["runQuery"];
type RunMutation = MutationCtx["runMutation"];

/** One component chain version doc, as `listSchemaVersions` returns it. */
type ComponentVersionDoc = FunctionReturnType<
  typeof components.jsonCms.lib.listSchemaVersions
>[number];

/** One component schema doc, as `getSchema` returns it (null when gone). */
type ComponentSchemaDoc = FunctionReturnType<typeof components.jsonCms.lib.getSchema>;

/**
 * One version row as the chain reads see it — the versioning cores'
 * `FrozenVersion` plus the label the head/badge need (full component docs
 * carry it required; plain-object tests may omit it).
 */
export type ChainVersion = {
  _id: string;
  lineage?: { frozenAt: number; snapshotRef?: string; versionLabel?: string };
};

/**
 * Versioned consumption (roadmap stage 6, #101; lifecycle doc §7, ADR 0008):
 * pin/float references, the "source published vN" badge, the consumed-by
 * projection, chain retention policy, and the sync/revert mutations — the
 * consumer-facing half of the catalog lifecycle.
 *
 * The two chain anchors the 5b asymmetry laid down decide every read here
 * (app/convex/schema.ts, `publishAttempts`): a DRAFT-published chain anchors
 * on a component row (`lineage.sourceSchemaId` — versions read through
 * `listSchemaVersions`), a DERIVED-published chain on the host registry id
 * (`lineage.sourceKey` — versions are the completed `publishAttempts`, one
 * frozen row each). `chainVersionsFor` resolves either into the shared
 * `FrozenVersion` shape so the versioning cores (previousVersionOf,
 * versionsToRetire, diffVersionRows) drive both — no new versioning system.
 *
 * The badge is the `sourceUpdatedAt` binding-badge pattern generalized: a
 * published row's `lineage.sourceVersions` records what each source
 * contributed AT ITS FREEZE; drift is that record vs the source chain's
 * current head (only completed attempts are heads — an in-flight
 * uploading/importing attempt never badges). Propagation through a derived
 * chain is transitive BY CONSTRUCTION: republishing S gives S a new head, so
 * D over S drifts, and syncing D re-publishes via the 5b state machine whose
 * new attempt freezes with re-recorded sourceVersions — exactly what D's own
 * consumers compare against. No notify machinery exists or is needed.
 *
 * What a consumer reference stores (the issue's recorded decision): a mode —
 * pin | float — plus, when pinned, the durable version identity (the frozen
 * row's global snapshotRef + that row's id). Stage-2 registry source
 * references gain the mode app-side: the save path writes one float row per
 * saved spec dependency (compute-on-read IS float semantics), and
 * sync/revert/pin mutate it. The table is first-class (schema.ts) so stage
 * 7's fork-as-reference mints rows here instead of overloading anything.
 *
 * Recorded scopes: sync on a REFERENCE consumer repins to head; sync on a
 * DERIVED consumer re-runs the spec through `publishDataset` (the client
 * orchestrator — this module never re-executes anything); revert repins to
 * the prior version (the catalog is append-only — nothing tears a published
 * version down). Since 7b (#103), maps hold float references on their
 * dataset layers (the bundle press mints them; the workspace's layer reads
 * resolve through them) and project forks hold float references per
 * membership — the projection names every kind it knows.
 *
 * Stage 8 (#104, decisions D1/D2): the reference and chain-policy MUTATIONS
 * are ownership-checked — a reference is writable by its consumer's owner (a
 * derived registry row's creator, or the project of a fork membership), a
 * chain's policy by the chain anchor's owner. The recorded exceptions: MAP
 * edges stay signed-in-writable (maps are shared catalog artifacts — the
 * component's maps table carries no creator stamp) and binding-store anchors
 * keep the tag path's signed-in-wide semantics (legacy rows may predate
 * creator stamping entirely). On the read side, `consumedBy` stops leaking
 * fork consumers' PROJECT TITLES across users (a fork edge surfaces only to
 * its own project's creator) and `sourceBadges` stops disclosing invisible
 * rows — a foreign draft or author-visibility source contributes no title,
 * and a badge read for a row the viewer can't see answers empty.
 */

/** A resolved chain head — what a consumer's recorded ref compares against. */
export type ChainHead = {
  /** The chain anchor the head hangs from (`storedDelta` keys deltas on it). */
  anchorId: string;
  frozenAt: number;
  ref: string;
  schemaId: string;
  versionLabel: string;
};

/** One badge row: a consumed source, what was recorded at freeze, and the head now. */
export type SourceBadge = {
  headRef?: string;
  headSchemaId?: string;
  headVersionLabel?: string;
  recordedRef?: string;
  recordedSchemaId?: string;
  recordedVersionLabel?: string;
  sourceDatasetId: string;
  /** The source's chain anchor — the client keys `storedDelta` reads on it. */
  sourceAnchorId?: string;
  /** The consumed source's display name, resolved host-side (component or registry row — the client stays dumb). */
  sourceTitle?: string;
  state: "current" | "drift" | "live" | "missing";
};

/** Upper bound per query call — a badge/consumed-by read stays bounded no matter the catalog. */
const MAX_CONSUMERS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Pure selection cores (unit-tested in consumption.test.ts with plain
// objects, the versioning.test.ts shape): head selection per chain kind,
// the chain-anchor rule, and the drift decision.
// ---------------------------------------------------------------------------

/** A chain head as the pure cores return it — the resolver attaches `anchorId`. */
export type ChainHeadCore = Omit<ChainHead, "anchorId">;

/**
 * A component chain's head: the newest version (by freeze time) that carries
 * a snapshot ref. Versions arrive newest-creation-first; freeze time decides.
 */
export function headOfComponentChain(versions: ChainVersion[]): ChainHeadCore | undefined {
  let head: ChainHeadCore | undefined;
  for (const version of versions) {
    const lineage = version.lineage;
    if (lineage === undefined || lineage.snapshotRef === undefined) {
      continue;
    }
    if (head === undefined || lineage.frozenAt > head.frozenAt) {
      head = {
        frozenAt: lineage.frozenAt,
        ref: lineage.snapshotRef,
        schemaId: version._id,
        versionLabel: lineage.versionLabel ?? "?",
      };
    }
  }
  return head;
}

/** The structural slice of a publish attempt the attempt-chain cores read. */
export interface AttemptVersionLike {
  _creationTime: number;
  finishedAt?: number;
  publishKey: string;
  publishedSchemaId?: string;
  status: string;
  title: string;
  versionLabel: string;
}

/**
 * The NEWEST completed attempt that produced a frozen row — only completed
 * attempts count (an in-flight uploading/importing attempt is never a head,
 * the publish path's own rule); newest by finish time with creation time as
 * the tie-break (the attempts index walks ascending, so the tie-break is
 * what makes the newest attempt win). Shared with
 * `publish.sourceVersionsFor`, whose freeze-time source record must be this
 * same attempt — the head a consumer's badge compares against.
 */
export function newestCompletedAttempt<T extends AttemptVersionLike>(
  attempts: readonly T[],
): T | undefined {
  let newest: T | undefined,
    newestFrozenAt = -1,
    newestCreationTime = -1;
  for (const attempt of attempts) {
    if (attempt.status !== "completed" || attempt.publishedSchemaId === undefined) {
      continue;
    }
    const frozenAt = attempt.finishedAt ?? attempt._creationTime;
    if (
      newest === undefined ||
      frozenAt > newestFrozenAt ||
      (frozenAt === newestFrozenAt && attempt._creationTime > newestCreationTime)
    ) {
      newest = attempt;
      newestCreationTime = attempt._creationTime;
      newestFrozenAt = frozenAt;
    }
  }
  return newest;
}

/** A derived chain's head: the newest completed attempt's frozen row (see `newestCompletedAttempt`). */
export function headOfAttemptChain(
  attempts: readonly AttemptVersionLike[],
): ChainHeadCore | undefined {
  const newest = newestCompletedAttempt(attempts);
  if (newest === undefined || newest.publishedSchemaId === undefined) {
    return undefined;
  }
  return {
    frozenAt: newest.finishedAt ?? newest._creationTime,
    ref: newest.publishKey,
    schemaId: newest.publishedSchemaId,
    versionLabel: newest.versionLabel,
  };
}

/**
 * The chain anchor a dataset's versions hang from: the lineage's component
 * anchor (`sourceSchemaId`) for a draft-published row, the host registry id
 * (`sourceKey`) for a derived-published row, and the dataset itself for
 * anything that is not a frozen version (a live dataset's versions anchor on
 * it directly — the tag path's shape).
 */
export function chainAnchorOf(
  lineage: { sourceKey?: string; sourceSchemaId?: string } | undefined,
  datasetId: string,
): string {
  if (lineage === undefined) {
    return datasetId;
  }
  return lineage.sourceSchemaId ?? lineage.sourceKey ?? datasetId;
}

/**
 * The drift decision (the issue's semantics): a consumer badges when the
 * version it recorded differs from the source chain's current head. No head
 * at all means either a live source that was never published ("live" —
 * nothing to compare) or a recorded version whose chain vanished ("missing"
 * — retired or deleted; never a crash).
 *
 * A LIVE-READ source (no ref recorded — a stage-2 spec reading a dataset
 * that isn't itself a frozen version) drifts only when the head froze AFTER
 * the consumer did: a head that already existed at freeze time is already
 * reflected in the frozen rows, and nagging about it would badge forever
 * with no clearing path. Re-publishing the consumer after the source's
 * latest publish clears it — sync stays meaningful for live consumers too.
 */
export function badgeStateOf(
  recorded: { ref?: string },
  head: ChainHeadCore | undefined,
  consumerFrozenAt?: number,
): SourceBadge["state"] {
  if (head === undefined) {
    return recorded.ref === undefined ? "live" : "missing";
  }
  if (recorded.ref === undefined) {
    if (consumerFrozenAt !== undefined && head.frozenAt <= consumerFrozenAt) {
      return "current";
    }
    return "drift";
  }
  return recorded.ref === head.ref ? "current" : "drift";
}

// ---------------------------------------------------------------------------
// Convex helpers: chain resolution and policy reads, shared by the queries,
// the mutations, and the publish-completion hook.
// ---------------------------------------------------------------------------

/**
 * One component schema read that tolerates a stored id that isn't a
 * well-formed component id (the publish.ts precedent — the validator would
 * throw, and "not a component dataset" is the answer that keeps walks
 * uniform over plain strings).
 */
async function tryGetSchema(
  ctx: { runQuery: RunQuery },
  schemaId: string,
): Promise<ComponentSchemaDoc> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  } catch {
    return null;
  }
}

/** A component chain's frozen versions — [] when the anchor isn't a component id. */
async function componentChainVersions(
  ctx: { runQuery: RunQuery },
  anchorId: string,
): Promise<ComponentVersionDoc[]> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.listSchemaVersions, {
      sourceSchemaId: anchorId,
    });
  } catch {
    return [];
  }
}

/**
 * A derived chain's COMPLETED attempts — [] when the anchor isn't a registry
 * row. The status filter is the name's promise (#126): a failed or in-flight
 * attempt is not a version, and letting one into the feed made retention
 * under-count keeps and could steal a delta's `previous` slot.
 */
async function completedAttemptsFor(
  ctx: { db: ReadDb },
  anchorId: string,
): Promise<Doc<"publishAttempts">[]> {
  const registryId = ctx.db.normalizeId("derivedDatasets", anchorId);
  if (registryId === null) {
    return [];
  }
  return ctx.db
    .query("publishAttempts")
    .withIndex("by_dataset", (q) => q.eq("datasetKey", anchorId))
    .filter((q) => q.eq(q.field("status"), "completed"))
    .collect();
}

/**
 * The completed attempts whose frozen row STILL EXISTS (#126): retiring a
 * version deletes the component row but leaves its attempt — an unfiltered
 * feed handed the dead id back to `versionsToRetire` on every later publish,
 * where `deleteSchema` threw "Schema not found" and rolled back the whole
 * completion hook. Existence (not a `retiredAt` marker) is the filter on
 * purpose: it self-heals every attempt a retirement path has already orphaned
 * (retention, manual retire, the publish sweep) with no marker to backfill.
 * Attempt counts per anchor are retention-bounded in practice; this feed runs
 * once per publish/revert, not inside the per-consumer badge loops.
 */
async function survivingAttemptsFor(
  ctx: { db: ReadDb; runQuery: RunQuery },
  anchorId: string,
): Promise<Doc<"publishAttempts">[]> {
  const attempts = await completedAttemptsFor(ctx, anchorId),
    surviving: Doc<"publishAttempts">[] = [];
  for (const attempt of attempts) {
    if (attempt.publishedSchemaId === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one existence read per attempt, ordered like the chain.
    if ((await tryGetSchema(ctx, attempt.publishedSchemaId)) === null) {
      continue;
    }
    surviving.push(attempt);
  }
  return surviving;
}

/**
 * One chain's versions in the shared `FrozenVersion` shape: the component
 * rows when the anchor is a component id, else the SURVIVING completed
 * attempts' published rows (the attempt IS the version record for a derived
 * chain — publishKey = snapshotRef, publishedSchemaId = the frozen row id).
 * Both feeds drop straight into the versioning cores.
 */
async function chainVersionsFor(
  ctx: { db: ReadDb; runQuery: RunQuery },
  anchorId: string,
): Promise<ChainVersion[]> {
  const versions = await componentChainVersions(ctx, anchorId);
  if (versions.length > 0) {
    return versions;
  }
  const attempts = await survivingAttemptsFor(ctx, anchorId);
  return attempts.map((attempt) => ({
    _id: attempt.publishedSchemaId ?? "",
    lineage: {
      frozenAt: attempt.finishedAt ?? attempt._creationTime,
      snapshotRef: attempt.publishKey,
    },
  }));
}

/**
 * Resolves one source dataset's current chain head, across both anchors.
 * Shared beyond this module from 7b (#103): the bundle press's layer
 * resolutions (`bundles.layerResolutions`) resolve a map's dataset-layer
 * targets through the same heads, so a float layer and a drift badge can
 * never disagree about what "head" is.
 */
export async function resolveSourceHead(
  ctx: { db: ReadDb; runQuery: RunQuery },
  sourceDatasetId: string,
): Promise<ChainHead | undefined> {
  const source = await tryGetSchema(ctx, sourceDatasetId),
    anchor = chainAnchorOf(source === null ? undefined : source.lineage, sourceDatasetId);
  const componentHead = headOfComponentChain(await componentChainVersions(ctx, anchor));
  if (componentHead !== undefined) {
    return { ...componentHead, anchorId: anchor };
  }
  const attemptHead = headOfAttemptChain(await completedAttemptsFor(ctx, anchor));
  return attemptHead === undefined ? undefined : { ...attemptHead, anchorId: anchor };
}

/** The unified retention-policy read: the binding store (the tag path's) first, then the publish-chain store, then the defaults. */
async function resolvePolicyForAnchor(
  ctx: { db: ReadDb },
  anchorId: string,
): Promise<{ keep: number; pinnedRefs: string[]; store: "binding" | "chain" | "defaults" }> {
  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_schema", (q) => q.eq("schemaId", anchorId))
    .first();
  if (binding !== null) {
    return {
      keep: binding.keepVersions ?? DEFAULT_KEEP_VERSIONS,
      pinnedRefs: binding.pinnedRefs ?? [],
      store: "binding",
    };
  }
  const row = await ctx.db
    .query("versionPolicies")
    .withIndex("by_dataset", (q) => q.eq("datasetKey", anchorId))
    .first();
  if (row !== null) {
    return {
      keep: row.keepVersions ?? DEFAULT_KEEP_VERSIONS,
      pinnedRefs: row.pinnedRefs ?? [],
      store: "chain",
    };
  }
  return { keep: DEFAULT_KEEP_VERSIONS, pinnedRefs: [], store: "defaults" };
}

/**
 * Pins (or unpins) one frozen version's ref into the policy store its chain
 * uses: the binding row when the chain anchor carries one (the tag path's
 * store — `tags.setVersionPinned` delegates here for its lifted
 * derived-side branch), else the publish-chain `versionPolicies` row
 * (upserted — absence reads as defaults, never a required backfill).
 * Plain helper, not a mutation: callers run it inside their own transaction.
 */
export async function pinRefIntoPolicyStore(
  ctx: { db: WriteDb },
  args: { anchorId: string; pinned: boolean; ref: string },
): Promise<void> {
  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_schema", (q) => q.eq("schemaId", args.anchorId))
    .first();
  if (binding !== null) {
    const pinnedRefs = new Set(binding.pinnedRefs ?? []);
    if (args.pinned) {
      pinnedRefs.add(args.ref);
    } else {
      pinnedRefs.delete(args.ref);
    }
    await ctx.db.patch(binding._id, { pinnedRefs: [...pinnedRefs] });
    return;
  }
  const row = await ctx.db
    .query("versionPolicies")
    .withIndex("by_dataset", (q) => q.eq("datasetKey", args.anchorId))
    .first();
  const pinnedRefs = new Set(row !== null ? (row.pinnedRefs ?? []) : []);
  if (args.pinned) {
    pinnedRefs.add(args.ref);
  } else {
    pinnedRefs.delete(args.ref);
  }
  const next = [...pinnedRefs];
  if (row !== null) {
    await ctx.db.patch(row._id, { pinnedRefs: next });
  } else {
    await ctx.db.insert("versionPolicies", { datasetKey: args.anchorId, pinnedRefs: next });
  }
}

/**
 * The component's delete-on-missing answer (`deleteSchema`, json-cms lib):
 * the one error a retirement may honestly hit — the row is already gone, so
 * the retirement already happened and the loop must move on (#126) instead of
 * aborting the whole completion hook.
 */
function isSchemaGone(error: unknown): boolean {
  const text =
    error instanceof ConvexError
      ? String(error.data)
      : error instanceof Error
        ? error.message
        : String(error);
  return text.includes("Schema not found");
}

/**
 * Enforces the chain's keep-N-with-pinning policy through the shared cores:
 * resolve policy (unified store read) → versionsToRetire → retire through the
 * component's read-only gate. Runs after every publish completion (the tag
 * path's after-ingest pattern) so publish chains stay bounded exactly like
 * bound-dataset versions. A stale id in the feed never aborts the hook — the
 * delete's not-found answer is skipped (defense in depth over the surviving
 * feed; #126's silent-stop failure mode was exactly this throw).
 */
async function enforceRetentionForAnchor(
  ctx: { db: ReadDb; runMutation: RunMutation; runQuery: RunQuery },
  anchorId: string,
): Promise<number> {
  const policy = await resolvePolicyForAnchor(ctx, anchorId),
    versions = await chainVersionsFor(ctx, anchorId),
    retired = versionsToRetire(versions, policy.keep, policy.pinnedRefs);
  let retiredCount = 0;
  for (const version of retired) {
    if (version.id === "") {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- ordered retirements under the write budget (the versioning.enforceRetention pattern).
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
        boundWrite: "retire",
        schemaId: version.id,
      });
      retiredCount += 1;
    } catch (error) {
      if (isSchemaGone(error)) {
        continue;
      }
      throw error;
    }
  }
  return retiredCount;
}

/**
 * Records the sequential delta for a freshly completed publish chain version
 * into `tagDeltas` (keyed by the chain anchor), closing the 5b gap: the
 * freeze recorded neither delta nor retention. Same cores and table as the
 * tag path's recordVersionDelta — only the chain resolution is stage 6's
 * (both anchors). A retired previous version records nothing (diffing
 * against rows that no longer exist would fabricate a mass add). A side at
 * the diff limit marks the stored delta `truncated` (#126) — never a
 * silently-truncated record served as truth.
 */
async function recordChainDelta(
  ctx: { db: WriteDb; runQuery: RunQuery },
  args: { anchor: string; toRef?: string; toSchemaId: string },
): Promise<void> {
  const versions = await chainVersionsFor(ctx, args.anchor),
    target = versions.find((version) => version._id === args.toSchemaId);
  if (target === undefined || target.lineage === undefined) {
    return;
  }
  const previous = previousVersionOf(versions, args.toSchemaId, target.lineage.frozenAt);
  if (previous === undefined || previous.id === "") {
    return;
  }
  const previousRow = await tryGetSchema(ctx, previous.id);
  if (previousRow === null) {
    return;
  }
  const [before, after] = await Promise.all([
    versionRowsBounded(ctx, previous.id),
    versionRowsBounded(ctx, args.toSchemaId),
  ]);
  const truncated = before.truncated || after.truncated;
  await ctx.db.insert("tagDeltas", {
    at: Date.now(),
    fromRef: previous.ref,
    ops: diffVersionRows(before.rows, after.rows),
    sourceSchemaId: args.anchor,
    toRef: args.toRef,
    ...(truncated ? { truncated: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// Stage-8 ownership guards (shared by the reference and chain-policy mutations)
// ---------------------------------------------------------------------------

/** The friendly denial every guard here shares — indistinguishable from a gone row, so an id's existence never leaks. */
function referenceDenied(): ConvexError<string> {
  return new ConvexError("This reference no longer exists.");
}

/**
 * Whether the caller may mutate one consumer reference (stage 8, #104): the
 * derived consumer's registry row must be theirs, a fork's edge belongs to
 * the membership's project's creator, and a MAP edge is the recorded
 * exception — maps are shared catalog artifacts (no creator stamp exists on
 * the component's maps table), so any signed-in viewer may adjust its layer
 * pins. `auth(ctx)` has already guaranteed the caller is signed in.
 */
async function assertConsumerWritable(
  ctx: { db: ReadDb },
  actorId: string,
  ref: Doc<"consumerReferences">,
): Promise<void> {
  if (ref.consumerKind === "derived") {
    const row = await registryRowFor(ctx, ref.consumerId);
    if (row === null || row.createdBy !== actorId) {
      throw referenceDenied();
    }
    return;
  }
  if (ref.consumerKind === "fork") {
    const membershipId = ctx.db.normalizeId("projectArtifacts", ref.consumerId);
    const membership = membershipId === null ? null : await ctx.db.get(membershipId);
    const project = membership === null ? null : await ctx.db.get(membership.projectId);
    if (project === null || project.createdBy !== actorId) {
      throw referenceDenied();
    }
    return;
  }
}

/**
 * Whether the caller may write one chain's policy store (stage 8, #104): the
 * anchor's owner — a registry row's creator, or a component row's creator.
 * Legacy component rows with NO creator stamp (pre-ADR-0007 ingest, system
 * actors) stay signed-in-writable (the recorded lenient rule: deny only a
 * DEFINED creator mismatch), and binding-store anchors keep the tag path's
 * semantics. Denied anchors read as a gone reference.
 */
export async function assertChainAnchorWritable(
  ctx: { db: ReadDb; runQuery: RunQuery },
  actorId: string,
  anchorId: string,
): Promise<void> {
  const registryId = ctx.db.normalizeId("derivedDatasets", anchorId);
  if (registryId !== null) {
    const row = await ctx.db.get(registryId);
    if (row !== null) {
      if (row.createdBy !== actorId) {
        throw referenceDenied();
      }
      return;
    }
  }
  const doc = await tryGetSchema(ctx, anchorId);
  if (doc !== null && doc.createdBy !== undefined && doc.createdBy !== actorId) {
    throw referenceDenied();
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const sourceBadgeValidator = v.object({
  headRef: v.optional(v.string()),
  headSchemaId: v.optional(v.string()),
  headVersionLabel: v.optional(v.string()),
  recordedRef: v.optional(v.string()),
  recordedSchemaId: v.optional(v.string()),
  recordedVersionLabel: v.optional(v.string()),
  sourceDatasetId: v.string(),
  sourceAnchorId: v.optional(v.string()),
  sourceTitle: v.optional(v.string()),
  state: v.union(v.literal("current"), v.literal("drift"), v.literal("live"), v.literal("missing")),
});

/**
 * One published row's per-source badges, from its `lineage.sourceVersions`.
 * The recorded version's own row resolves through the GLOBAL by-ref lookup —
 * a publishKey is the frozen row's snapshotRef for both chain kinds, so the
 * recorded schema id (the diff's "pinned" side) comes back for either.
 */
/**
 * The visibility rule the badge reads apply (stage 8, #104 — mirrors the
 * component's `isVisibleToViewer`): a foreign DRAFT or a foreign
 * `publishedVisibility: "author"` row contributes nothing to a badge read —
 * neither its titles nor its source graph.
 */
function rowVisibleToViewer(
  doc: {
    createdBy?: string;
    lifecycle?: "draft" | "published";
    publishedVisibility?: "author" | "everyone";
  },
  viewerId: string,
): boolean {
  if (doc.lifecycle === "draft" || doc.publishedVisibility === "author") {
    return doc.createdBy === viewerId;
  }
  return true;
}

/**
 * Whether the viewer may read a dataset-keyed projection at all (stage 8,
 * #104): the chain/consumer reads (chainVersions, storedDelta,
 * retentionPolicy, consumedBy) are keyed by a dataset id like the catalog's
 * by-id reads, so an invisible row answers there the same as everywhere
 * else — a foreign DRAFT or a foreign `publishedVisibility: "author"` row
 * contributes nothing, its existence never leaking. The id duality applies:
 * a registry row resolves through the registry's own draft/saved line
 * (drafts private, saved catalog-visible). An id that resolves to neither
 * table answers visible — the projection then comes back empty anyway, the
 * same answer an unknown id always gave.
 */
export async function sourceVisibleToViewer(
  ctx: { db: ReadDb; runQuery: RunQuery },
  datasetId: string,
  viewerId: string,
): Promise<boolean> {
  const row = await tryGetSchema(ctx, datasetId);
  if (row !== null) {
    return rowVisibleToViewer(row, viewerId);
  }
  const registryId = ctx.db.normalizeId("derivedDatasets", datasetId);
  const registry = registryId === null ? null : await ctx.db.get(registryId);
  if (registry !== null) {
    return registry.status === "saved" || registry.createdBy === viewerId;
  }
  return true;
}

// oxlint-disable-next-line eslint/complexity -- the per-field badge assembly is flat on purpose; splitting it would scatter the recorded/head pairing the drift decision reads together.
async function badgesForDatasetRow(
  ctx: { db: ReadDb; runQuery: RunQuery },
  schemaId: string,
  viewerId: string,
): Promise<SourceBadge[]> {
  const row = await tryGetSchema(ctx, schemaId),
    recorded = row === null || row.lineage === undefined ? undefined : row.lineage.sourceVersions;
  // An invisible row (a foreign draft, an author-restricted row) badges as
  // nothing — its source graph is content too (stage 8).
  if (recorded === undefined || (row !== null && !rowVisibleToViewer(row, viewerId))) {
    return [];
  }
  const badges: SourceBadge[] = [];
  for (const source of recorded) {
    // oxlint-disable-next-line no-await-in-loop -- the walk resolves each source in order; each read decides the next hop.
    const head = await resolveSourceHead(ctx, source.datasetId);
    let recordedRow: ComponentSchemaDoc = null;
    if (source.ref !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- see above.
      recordedRow = await ctx.runQuery(components.jsonCms.lib.getSchemaVersionBySnapshotRef, {
        snapshotRef: source.ref,
      });
    }
    const badge: SourceBadge = {
      sourceDatasetId: source.datasetId,
      state: badgeStateOf(
        source,
        head,
        row === null || row.lineage === undefined ? undefined : row.lineage.frozenAt,
      ),
    };
    if (head !== undefined) {
      badge.headRef = head.ref;
      badge.headSchemaId = head.schemaId;
      badge.headVersionLabel = head.versionLabel;
      badge.sourceAnchorId = head.anchorId;
    }
    if (source.ref !== undefined) {
      badge.recordedRef = source.ref;
    }
    if (recordedRow !== null && recordedRow !== undefined) {
      badge.recordedSchemaId = recordedRow._id;
      if (recordedRow.lineage !== undefined) {
        badge.recordedVersionLabel = recordedRow.lineage.versionLabel;
      }
    }
    // The source's display name, resolved host-side across the id duality
    // (component dataset or registry row — the consumedBy precedent). A
    // source the viewer cannot see (a foreign draft, an author-visibility
    // row) contributes no title — the badge stays, the name doesn't leak
    // (stage 8, #104).
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const sourceDoc = await tryGetSchema(ctx, source.datasetId);
    if (sourceDoc !== null) {
      if (rowVisibleToViewer(sourceDoc, viewerId)) {
        badge.sourceTitle = sourceDoc.title;
      }
    } else {
      // oxlint-disable-next-line no-await-in-loop -- see above.
      badge.sourceTitle = await registryTitleFor(ctx, source.datasetId);
    }
    badges.push(badge);
  }
  return badges;
}

/** One registry consumer's badges: its head completed attempt's frozen row is the consumer. */
async function badgesForRegistryConsumer(
  ctx: { db: ReadDb; runQuery: RunQuery },
  registryId: string,
  viewerId: string,
): Promise<SourceBadge[]> {
  const head = headOfAttemptChain(await completedAttemptsFor(ctx, registryId));
  if (head === undefined) {
    return [];
  }
  return badgesForDatasetRow(ctx, head.schemaId, viewerId);
}

/**
 * Per-consumer source-drift badges, keyed by consumer id. Two id spaces ride
 * one query (the browser's visible rows are the callers): `registryIds` —
 * derived-dataset registry rows (a card's consumer is its head completed
 * attempt) — and `schemaIds` — component rows with `lineage.sourceVersions`
 * (published rows, the dataset page's own consumer). Bounded per call.
 */
export const sourceBadges = query({
  args: { registryIds: v.array(v.string()), schemaIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    const byRegistryId: Record<string, SourceBadge[]> = {};
    for (const registryId of args.registryIds.slice(0, MAX_CONSUMERS)) {
      // oxlint-disable-next-line no-await-in-loop -- one consumer per hop; each read decides the next.
      byRegistryId[registryId] = await badgesForRegistryConsumer(ctx, registryId, viewerId);
    }
    const bySchemaId: Record<string, SourceBadge[]> = {};
    for (const schemaId of args.schemaIds.slice(0, MAX_CONSUMERS)) {
      // oxlint-disable-next-line no-await-in-loop -- see above.
      bySchemaId[schemaId] = await badgesForDatasetRow(ctx, schemaId, viewerId);
    }
    return { byRegistryId, bySchemaId };
  },
  returns: v.object({
    byRegistryId: v.record(v.string(), v.array(sourceBadgeValidator)),
    bySchemaId: v.record(v.string(), v.array(sourceBadgeValidator)),
  }),
});

const consumedByValidator = v.object({
  consumers: v.array(
    v.object({
      changed: v.boolean(),
      consumerId: v.string(),
      consumerKind: v.string(),
      mode: v.union(v.literal("float"), v.literal("pin")),
      pinnedRef: v.optional(v.string()),
      pinnedSchemaId: v.optional(v.string()),
      // The consumerReferences row id — what the sync/revert/pin mutations
      // take. Undefined for consumers surfaced by the registry scan alone
      // (saved before stage 6 wrote edges): they float by construction and
      // carry no row to mutate until their next save.
      referenceId: v.optional(v.string()),
      title: v.string(),
    }),
  ),
  // The honesty field: which consumer kinds this projection knows. Maps and
  // collections reference datasets but hold NO version reference — they join
  // additively when a stage gives them one, and the UI says so.
  knownConsumerKinds: v.array(v.string()),
});

/**
 * The consumed-by projection for one dataset (lifecycle §7): every consumer
 * that holds a reference on this dataset, with its pin/float state and
 * whether a new head awaits it. Union of the `consumerReferences` edges (the
 * authoritative leg — the save path, the 7b fork/map legs, and the one-off
 * backfill below) and the bounded saved-registry scan, which exists only for
 * rows saved before stage 6 wrote edges; its take(500) is the summaries
 * projection's documented bound, not a correctness cap, and
 * `backfillConsumerReferences` retires the need for it entirely. Deduped by
 * consumer id.
 */
export const consumedBy = query({
  args: { datasetId: v.string() },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    // The source's own visibility gates the whole projection (stage 8): a
    // foreign draft or author-restricted row names no consumers to a caller
    // who cannot see the row — the same empty answer an unknown id gives.
    if (!(await sourceVisibleToViewer(ctx, args.datasetId, viewerId))) {
      return { consumers: [], knownConsumerKinds: ["derived", "fork", "map"] };
    }
    const refs = await ctx.db
      .query("consumerReferences")
      .withIndex("by_source", (q) => q.eq("sourceDatasetId", args.datasetId))
      .take(MAX_CONSUMERS);
    const savedRows = await ctx.db
      .query("derivedDatasets")
      .withIndex("by_status_and_source", (q) => q.eq("status", "saved"))
      .take(500);
    const consumers = new Map<
      string,
      {
        changed: boolean;
        consumerId: string;
        consumerKind: string;
        mode: "float" | "pin";
        pinnedRef?: string;
        pinnedSchemaId?: string;
        referenceId?: string;
        title: string;
      }
    >();
    for (const ref of refs) {
      // The consumer must still exist (and, for a registry consumer, be
      // catalog-visible): a deleted transform's stale edge (removed deletes
      // its edges now, but rows deleted before that shipped leave orphans), a
      // saved row the builder demoted to draft by re-autosaving, a removed
      // project membership, and a deleted map all resolve to nothing here —
      // drafts are invisible to catalog consumers (lifecycle §3). Since
      // stage 8 (#104) the viewer rides along too: a FORK consumer surfaces
      // only to its own project's creator — one user's consumed-by read
      // never discloses another user's project title.
      // oxlint-disable-next-line no-await-in-loop -- one consumer per hop; each read decides the next.
      const title = await consumerTitleFor(ctx, ref, viewerId);
      if (title === null) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const changed = await referenceChangedFor(ctx, ref, args.datasetId);
      consumers.set(ref.consumerId, {
        changed,
        consumerId: ref.consumerId,
        consumerKind: ref.consumerKind,
        mode: ref.mode,
        pinnedRef: ref.pinnedRef,
        pinnedSchemaId: ref.pinnedSchemaId,
        referenceId: ref._id,
        title,
      });
    }
    for (const row of savedRows) {
      if (!row.dependsOn.includes(args.datasetId) || consumers.has(row._id)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const changed = await registryRowChangedFor(ctx, row, args.datasetId);
      consumers.set(row._id, {
        changed,
        consumerId: row._id,
        consumerKind: "derived",
        mode: "float",
        title: row.title,
      });
    }
    return {
      consumers: [...consumers.values()],
      knownConsumerKinds: ["derived", "fork", "map"],
    };
  },
  returns: consumedByValidator,
});

/**
 * The consumer's display title per kind (7b): registry rows answer their own
 * title (and must still be saved — the visibility rule above), fork consumers
 * answer their membership's project's — SINCE STAGE 8 (#104) only to that
 * project's creator (a foreign fork drops out of the projection entirely, so
 * a consumed-by read never discloses another user's project titles) — map
 * consumers the map's name (maps are shared catalog artifacts). A gone
 * consumer (deleted row, removed membership, deleted map) answers null and
 * drops out of the projection — the defensive read every kind shares.
 */
async function consumerTitleFor(
  ctx: { db: ReadDb; runQuery: RunQuery },
  ref: Doc<"consumerReferences">,
  viewerId: string,
): Promise<string | null> {
  if (ref.consumerKind === "derived") {
    const row = await registryRowFor(ctx, ref.consumerId);
    if (row === null || row.status !== "saved") {
      return null;
    }
    return row.title;
  }
  if (ref.consumerKind === "fork") {
    return forkConsumerTitle(ctx, ref.consumerId, viewerId);
  }
  try {
    const map = await ctx.runQuery(components.jsonCms.lib.getMap, { mapId: ref.consumerId });
    return map === null ? null : map.name;
  } catch {
    // A consumerId that isn't a well-formed component map id — the
    // id-duality rule's "not a map" answer.
    return null;
  }
}

/**
 * A fork consumer's project title, only for that project's creator (stage 8,
 * #104): one user's consumed-by read never discloses another user's project
 * titles — a foreign fork drops out of the projection like a gone consumer.
 */
async function forkConsumerTitle(
  ctx: { db: ReadDb },
  consumerId: string,
  viewerId: string,
): Promise<string | null> {
  const membershipId = ctx.db.normalizeId("projectArtifacts", consumerId);
  const membership = membershipId === null ? null : await ctx.db.get(membershipId);
  if (membership === null) {
    return null;
  }
  const project = await ctx.db.get(membership.projectId);
  if (project === null || project.createdBy !== viewerId) {
    return null;
  }
  return project.title;
}

/**
 * The consumer's registry row, when the id is one — deleted transforms and
 * component ids answer null (the id-duality rule: each side asks its own
 * tables in turn). Source resolution below uses the title-only variant
 * because a published row's lineage may outlive its source registry row and
 * still deserves its name.
 */
async function registryRowFor(ctx: { db: ReadDb }, consumerId: string) {
  const registryId = ctx.db.normalizeId("derivedDatasets", consumerId);
  if (registryId === null) {
    return null;
  }
  return ctx.db.get(registryId);
}

/** The consumer's display title, when it is a registry row (component consumers join in later stages). */
async function registryTitleFor(ctx: { db: ReadDb }, consumerId: string) {
  const registryId = ctx.db.normalizeId("derivedDatasets", consumerId);
  if (registryId === null) {
    return undefined;
  }
  const row = await ctx.db.get(registryId);
  return row === null ? undefined : row.title;
}

/** Whether a pinned/float reference row awaits a new head of `datasetId`. */
async function referenceChangedFor(
  ctx: { db: ReadDb; runQuery: RunQuery },
  ref: Doc<"consumerReferences">,
  datasetId: string,
): Promise<boolean> {
  const head = await resolveSourceHead(ctx, datasetId);
  if (ref.mode === "pin") {
    return badgeStateOf({ ref: ref.pinnedRef }, head) !== "current";
  }
  // Float is at head by definition — unless the consumer's own published
  // rows recorded this source BEFORE it moved (the lineage badge's signal).
  return registryRowChangedFor(ctx, { _id: ref.consumerId }, datasetId);
}

/** Whether one registry row's head published row recorded `datasetId` at a ref that has since moved. */
async function registryRowChangedFor(
  ctx: { db: ReadDb; runQuery: RunQuery },
  row: { _id: string },
  datasetId: string,
): Promise<boolean> {
  const head = headOfAttemptChain(await completedAttemptsFor(ctx, row._id));
  if (head === undefined) {
    return false;
  }
  const published = await tryGetSchema(ctx, head.schemaId),
    recorded =
      published === null || published.lineage === undefined
        ? undefined
        : published.lineage.sourceVersions;
  if (recorded === undefined) {
    return false;
  }
  const source = recorded.find((entry) => entry.datasetId === datasetId),
    sourceHead = await resolveSourceHead(ctx, datasetId);
  const state = badgeStateOf(
    source ?? {},
    sourceHead,
    published === null || published.lineage === undefined ? undefined : published.lineage.frozenAt,
  );
  return state === "drift" || state === "missing";
}

const chainVersionValidator = v.object({
  entryCount: v.optional(v.number()),
  frozenAt: v.number(),
  schemaId: v.string(),
  snapshotRef: v.optional(v.string()),
  title: v.string(),
  versionLabel: v.string(),
});

/**
 * One chain's versions, newest freeze first — the light rows the dataset
 * page's Versions list renders for PUBLISH chains (both anchors; bound live
 * datasets keep `tags.listVersions`). Attempt-chain rows carry the attempt's
 * title and label; their frozen rows are the same append-only rows every
 * other version read sees.
 */
export const chainVersions = query({
  args: { anchorId: v.string() },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    // An invisible anchor (a foreign draft, an author-restricted row) reads
    // as a chain with no versions — titles and refs never leak (stage 8).
    if (!(await sourceVisibleToViewer(ctx, args.anchorId, viewerId))) {
      return [];
    }
    const componentVersions = await componentChainVersions(ctx, args.anchorId);
    if (componentVersions.length > 0) {
      const rows = componentVersions.map((version) => {
        const row = {
          entryCount: version.entryCount,
          frozenAt: version.lineage === undefined ? 0 : version.lineage.frozenAt,
          schemaId: version._id,
          snapshotRef: version.lineage === undefined ? undefined : version.lineage.snapshotRef,
          title: version.title,
          versionLabel: version.lineage === undefined ? "?" : version.lineage.versionLabel,
        };
        return row;
      });
      return newestFirst(rows).slice(0, MAX_CONSUMERS);
    }
    // The SURVIVING attempts only (#126): a retired version's attempt row
    // lingers, but it is not a version — listing it offered a Retire button
    // on a row that was already gone.
    const rows = (await survivingAttemptsFor(ctx, args.anchorId)).map((attempt) => ({
      entryCount: undefined,
      frozenAt: attempt.finishedAt ?? attempt._creationTime,
      schemaId: attempt.publishedSchemaId ?? "",
      snapshotRef: attempt.publishKey,
      title: attempt.title,
      versionLabel: attempt.versionLabel,
    }));
    return newestFirst(rows).slice(0, MAX_CONSUMERS);
  },
  returns: v.array(chainVersionValidator),
});

/** Newest freeze first — `.toSorted()` isn't in the lib app/convex typechecks against, so a fresh throwaway copy sorts in place. */
function newestFirst<T extends { frozenAt: number }>(rows: T[]): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; see above.
  return rows.sort((a, b) => b.frozenAt - a.frozenAt);
}

/**
 * The analysis layer's resolve-then-feed leg (roadmap stage 9, #105; AC 1
 * "published queries resolve the pinned/floating version per stage-6
 * semantics"): for each dataset an analysis wants to register, the CONCRETE
 * component row the row-resolution seam should page. Server-side first and
 * through the same `resolveSourceHead` core the 7b layer resolutions use,
 * so an analysis and a map layer can never disagree about what head is.
 *
 * The per-id rule (recorded — the stage-6 semantics applied to a query's
 * table list):
 * - "identity": read the NAMED row itself. A frozen version row carries
 *   `lineage` — it IS an immutable dataset (stage 6's "a version is an
 *   ordinary dataset to the seam"); floating away from rows the author can
 *   see would be the stale-id leak in reverse. Also the answer when no
 *   chain exists at all (a draft, a plain live dataset).
 * - "float": a live chain anchor (the tag path's bound dataset) — read the
 *   chain's head, exactly what a float reference means everywhere else.
 * - "registry": the id is a derivedDatasets row — not a component dataset;
 *   the v1 analysis surface authors over component datasets only and
 *   reports this distinctly (the row has no entries to page).
 * - "missing": not a component dataset, or not visible to the caller —
 *   indistinguishable, the stage-8 rule.
 */
export const analysisTargets = query({
  args: { datasetIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    const targets: Array<{
      datasetId: string;
      resolvedSchemaId?: string;
      status: "float" | "identity" | "missing" | "registry";
      title?: string;
    }> = [];
    for (const datasetId of args.datasetIds.slice(0, MAX_CONSUMERS)) {
      // One target per hop; each read decides the next (the badge shape).
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const row = await tryGetSchema(ctx, datasetId);
      if (row === null) {
        const registryId = ctx.db.normalizeId("derivedDatasets", datasetId);
        if (registryId === null) {
          targets.push({ datasetId, status: "missing" });
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const registryRow = await ctx.db.get(registryId);
        // Stage 8: a registry row reads as "registry" only when the caller
        // may see it — saved rows are catalog-visible, drafts are the
        // creator's. A foreign draft answers "missing", its existence never
        // leaking (the derivedDatasets.get rule).
        targets.push({
          datasetId,
          status:
            registryRow === null ||
            registryRow.status === "saved" ||
            registryRow.createdBy === viewerId
              ? "registry"
              : "missing",
        });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- see above.
      if (!(await sourceVisibleToViewer(ctx, datasetId, viewerId))) {
        targets.push({ datasetId, status: "missing" });
        continue;
      }
      if (row.lineage !== undefined) {
        targets.push({
          datasetId,
          resolvedSchemaId: datasetId,
          status: "identity",
          title: row.title,
        });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const head = await resolveSourceHead(ctx, datasetId);
      targets.push(
        head === undefined
          ? { datasetId, resolvedSchemaId: datasetId, status: "identity", title: row.title }
          : {
              datasetId,
              resolvedSchemaId: head.schemaId,
              status: "float",
              title: row.title,
            },
      );
    }
    return targets;
  },
  returns: v.array(
    v.object({
      datasetId: v.string(),
      resolvedSchemaId: v.optional(v.string()),
      status: v.union(
        v.literal("float"),
        v.literal("identity"),
        v.literal("missing"),
        v.literal("registry"),
      ),
      title: v.optional(v.string()),
    }),
  ),
});

/** The chain's resolved retention policy — which store answered rides along so the UI can say. */
export const retentionPolicy = query({
  args: { anchorId: v.string() },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    // An invisible anchor's policy answers the defaults — indistinguishable
    // from a chain with no stored policy (stage 8, same rule as above).
    const policy = (await sourceVisibleToViewer(ctx, args.anchorId, viewerId))
      ? await resolvePolicyForAnchor(ctx, args.anchorId)
      : { keep: DEFAULT_KEEP_VERSIONS, pinnedRefs: [], store: "defaults" as const };
    return { keepVersions: policy.keep, pinnedRefs: policy.pinnedRefs, store: policy.store };
  },
  returns: v.object({
    keepVersions: v.number(),
    pinnedRefs: v.array(v.string()),
    store: v.union(v.literal("binding"), v.literal("chain"), v.literal("defaults")),
  }),
});

/**
 * The STORED sequential delta for a consecutive pair (the common pinned →
 * head case), recorded at publish completion — the scale note's preference
 * over recomputing. Null when no stored delta covers the pair (an older
 * pair, or a retired previous version) and the caller falls back to the
 * on-demand `tags.getVersionDelta`.
 */
export const storedDelta = query({
  args: { anchorId: v.string(), fromRef: v.string(), toRef: v.string() },
  handler: async (ctx, args) => {
    const viewerId = await auth(ctx);
    // An invisible anchor's diff is content — it answers null like a missing
    // delta pair (stage 8, same rule as chainVersions).
    if (!(await sourceVisibleToViewer(ctx, args.anchorId, viewerId))) {
      return null;
    }
    const deltas = await ctx.db
      .query("tagDeltas")
      .withIndex("by_source", (q) => q.eq("sourceSchemaId", args.anchorId))
      .take(MAX_CONSUMERS);
    const match = deltas.find(
      (delta) => delta.fromRef === args.fromRef && delta.toRef === args.toRef,
    );
    if (match === undefined) {
      return null;
    }
    return {
      added: match.ops.filter((op) => op.op === "add").length,
      ops: match.ops,
      removed: match.ops.filter((op) => op.op === "delete").length,
      // The honesty flag (#126): true when a side sat at the diff limit, so
      // the UI can say the counts cover the first VERSION_DIFF_LIMIT rows.
      truncated: match.truncated === true,
      updated: match.ops.filter((op) => op.op === "update").length,
    };
  },
  returns: v.union(
    v.null(),
    v.object({
      added: v.number(),
      ops: v.array(commitOpValidator),
      removed: v.number(),
      truncated: v.boolean(),
      updated: v.number(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Mutations: chain policy, reference sync/revert/pin
// ---------------------------------------------------------------------------

/** Sets the chain's keep-N retention count (binding store first) and enforces it immediately. */
export const setChainKeep = mutation({
  args: { anchorId: v.string(), keep: v.number() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    if (args.keep < 1) {
      throw new ConvexError("Keep at least one version.");
    }
    await assertChainAnchorWritable(ctx, actorId, args.anchorId);
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.anchorId))
      .first();
    if (binding !== null) {
      await ctx.db.patch(binding._id, { keepVersions: args.keep });
    } else {
      const row = await ctx.db
        .query("versionPolicies")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", args.anchorId))
        .first();
      if (row !== null) {
        await ctx.db.patch(row._id, { keepVersions: args.keep });
      } else {
        await ctx.db.insert("versionPolicies", {
          datasetKey: args.anchorId,
          keepVersions: args.keep,
        });
      }
    }
    await enforceRetentionForAnchor(ctx, args.anchorId);
  },
  returns: v.null(),
});

/** Pins (or unpins) one frozen version against its chain's policy store — both chain kinds. Creator-checked via the chain anchor (stage 8). */
export const setChainVersionPinned = mutation({
  args: { pinned: v.boolean(), schemaId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
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
    const anchor = chainAnchorOf(schema.lineage, args.schemaId);
    if (anchor === args.schemaId) {
      throw new ConvexError("This version's lineage names no chain anchor to pin it under.");
    }
    await assertChainAnchorWritable(ctx, actorId, anchor);
    await pinRefIntoPolicyStore(ctx, { anchorId: anchor, pinned: args.pinned, ref });
  },
  returns: v.null(),
});

/** Floats (or pins to the source's current head) one consumer reference. */
export const setReferenceMode = mutation({
  args: { mode: v.union(v.literal("float"), v.literal("pin")), referenceId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const referenceId = ctx.db.normalizeId("consumerReferences", args.referenceId);
    if (referenceId === null) {
      throw referenceDenied();
    }
    const ref = await ctx.db.get(referenceId);
    if (ref === null) {
      throw referenceDenied();
    }
    await assertConsumerWritable(ctx, actorId, ref);
    if (args.mode === "float") {
      await ctx.db.patch(referenceId, {
        mode: "float",
        pinnedRef: undefined,
        pinnedSchemaId: undefined,
      });
      return;
    }
    const head = await resolveSourceHead(ctx, ref.sourceDatasetId);
    if (head === undefined) {
      throw new ConvexError("The source has no published versions to pin yet — publish it first.");
    }
    await ctx.db.patch(referenceId, {
      mode: "pin",
      pinnedRef: head.ref,
      pinnedSchemaId: head.schemaId,
    });
  },
  returns: v.null(),
});

/**
 * Sync on a REFERENCE consumer: repin to the source chain's current head.
 * (The issue decision — "update the stored reference from its pinned ref to
 * the new head's ref", mode preserved. A float reference is at head by
 * definition, so syncing one is an honest no-op.) This is a policy-store
 * write ONLY — it never touches the component and never re-executes
 * anything; a derived consumer's sync is `publishDataset`, not this.
 */
export const syncReference = mutation({
  args: { referenceId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const referenceId = ctx.db.normalizeId("consumerReferences", args.referenceId);
    if (referenceId === null) {
      throw referenceDenied();
    }
    const ref = await ctx.db.get(referenceId);
    if (ref === null) {
      throw referenceDenied();
    }
    await assertConsumerWritable(ctx, actorId, ref);
    if (ref.mode !== "pin") {
      return { mode: "float" as const, pinnedRef: undefined };
    }
    const head = await resolveSourceHead(ctx, ref.sourceDatasetId);
    if (head === undefined) {
      throw new ConvexError(
        "The source chain has no versions to sync to — its pinned version may have been retired.",
      );
    }
    if (head.ref !== ref.pinnedRef) {
      await ctx.db.patch(referenceId, { pinnedRef: head.ref, pinnedSchemaId: head.schemaId });
    }
    return { mode: "pin" as const, pinnedRef: head.ref };
  },
  returns: v.object({
    mode: v.union(v.literal("float"), v.literal("pin")),
    pinnedRef: v.optional(v.string()),
  }),
});

/**
 * Revert on a REFERENCE consumer: repin to the PRIOR version of the pinned
 * ref's chain (previousVersionOf semantics). The pinned version must still
 * exist — a retired pin resolves as the honest error, never a crash. The
 * catalog is append-only: nothing is torn down, the reference just points
 * back.
 */
export const revertReference = mutation({
  args: { referenceId: v.string() },
  // oxlint-disable-next-line eslint/complexity -- each guard is one honest error message; splitting the revert would separate the checks from what they protect.
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const referenceId = ctx.db.normalizeId("consumerReferences", args.referenceId);
    if (referenceId === null) {
      throw referenceDenied();
    }
    const ref = await ctx.db.get(referenceId);
    if (ref === null) {
      throw referenceDenied();
    }
    await assertConsumerWritable(ctx, actorId, ref);
    if (ref.mode !== "pin" || ref.pinnedRef === undefined) {
      throw new ConvexError("Only a pinned reference can revert — a float one is at head.");
    }
    // The full by-ref read (not a light {_id} lookup): revert needs the
    // pinned row's lineage for its chain anchor and freeze time.
    const pinnedRow = await ctx.runQuery(components.jsonCms.lib.getSchemaVersionBySnapshotRef, {
      snapshotRef: ref.pinnedRef,
    });
    if (pinnedRow === null || pinnedRow.lineage === undefined) {
      throw new ConvexError(
        "The pinned version no longer exists — it may have been retired. Sync to head instead.",
      );
    }
    const anchor = chainAnchorOf(pinnedRow.lineage, pinnedRow._id),
      chain = await chainVersionsFor(ctx, anchor),
      previous = previousVersionOf(chain, pinnedRow._id, pinnedRow.lineage.frozenAt);
    if (previous === undefined || previous.id === "" || previous.ref === undefined) {
      throw new ConvexError("This is the chain's first version — there is nothing to revert to.");
    }
    const previousRow = await tryGetSchema(ctx, previous.id);
    if (previousRow === null) {
      throw new ConvexError(
        "The prior version has been retired and can no longer be pinned — sync to head instead.",
      );
    }
    await ctx.db.patch(referenceId, { pinnedRef: previous.ref, pinnedSchemaId: previous.id });
    return { pinnedRef: previous.ref };
  },
  returns: v.object({ pinnedRef: v.string() }),
});

// ---------------------------------------------------------------------------
// Internal: the registry-save reference sync and the publish-completion hook
// ---------------------------------------------------------------------------

/**
 * Re-syncs one saved registry row's reference edges to its spec's
 * dependencies: surviving edges keep their mode, new edges land float,
 * removed edges' rows go. Plain helper so `derivedDatasets.save` runs it
 * in-transaction (the save and its edges commit atomically); the
 * internalMutation below is the same operation for any future server-side
 * caller. SAVED writers only — the save path gates that (builder autosaves
 * never surface as consumers, lifecycle §3).
 */
export async function syncRegistryReferenceEdges(
  ctx: { db: WriteDb },
  args: { registryId: string; spec: unknown },
): Promise<void> {
  const registryId = ctx.db.normalizeId("derivedDatasets", args.registryId);
  if (registryId === null || (await ctx.db.get(registryId)) === null) {
    return;
  }
  const dependencies = specDependencies(isRecord(args.spec) ? args.spec : {}),
    existing = await ctx.db
      .query("consumerReferences")
      .withIndex("by_consumer", (q) => q.eq("consumerId", args.registryId))
      .collect();
  for (const dependency of dependencies) {
    if (existing.some((ref) => ref.sourceDatasetId === dependency)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one edge per dependency, ordered like the spec's own walk.
    await ctx.db.insert("consumerReferences", {
      consumerId: args.registryId,
      consumerKind: "derived",
      mode: "float",
      sourceDatasetId: dependency,
    });
  }
  for (const ref of existing) {
    if (!dependencies.includes(ref.sourceDatasetId)) {
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await ctx.db.delete(ref._id);
    }
  }
}

/** The internal wrapper over the edge-sync (see the helper above). */
export const syncRegistryReferences = internalMutation({
  args: { registryId: v.id("derivedDatasets"), spec: v.any() },
  handler: async (ctx, args) =>
    syncRegistryReferenceEdges(ctx, { registryId: args.registryId, spec: args.spec }),
  returns: v.null(),
});

/**
 * One-off migration for rows saved BEFORE stage 6 shipped edges (the
 * `schemas.backfillSummaries` precedent): syncs every registry row's
 * reference edges so the indexed `by_source` leg of `consumedBy` is
 * authoritative and the bounded back-compat scan stops finding anything.
 * Idempotent — rerun any time drift is suspected. Internal on purpose: no
 * app surface drives it.
 *
 * Run with: `bunx convex run consumption:backfillConsumerReferences` (from app/)
 */
export const backfillConsumerReferences = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("derivedDatasets").take(1000);
    let backfilled = 0;
    for (const row of rows) {
      // oxlint-disable-next-line no-await-in-loop -- one row's edges per hop, ordered; idempotent per row.
      await syncRegistryReferenceEdges(ctx, { registryId: row._id, spec: row.spec });
      backfilled += 1;
    }
    return backfilled;
  },
  returns: v.number(),
});

/**
 * The publish-completion hook (the tag path's after-ingest pattern, at the
 * publish side): the delta against the chain's previous version + keep-N
 * retention with pinning. Scheduled by `publish.markAttemptCompleted` so the
 * heavy version reads run in their own transaction, after the import —
 * versionRows reads entries, and recording before they landed would diff
 * against empty versions.
 */
export const afterPublishCompleted = internalMutation({
  args: { attemptId: v.id("publishAttempts") },
  handler: async (ctx, args): Promise<null> => {
    const attempt = await ctx.db.get(args.attemptId);
    if (
      attempt === null ||
      attempt.status !== "completed" ||
      attempt.publishedSchemaId === undefined
    ) {
      return null;
    }
    const row = await tryGetSchema(ctx, attempt.publishedSchemaId);
    if (row === null || row.lineage === undefined) {
      return null;
    }
    const anchor = chainAnchorOf(row.lineage, attempt.publishedSchemaId);
    await recordChainDelta(ctx, {
      anchor,
      toRef: row.lineage.snapshotRef,
      toSchemaId: attempt.publishedSchemaId,
    });
    await enforceRetentionForAnchor(ctx, anchor);
    return null;
  },
  returns: v.null(),
});
