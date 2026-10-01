import { exposeApi } from "@caden/json-cms";
import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { auth } from "./auth";

export const {
  listSchemas: list,
  listSchemaSummaries: listSummaries,
  // The opt-in drafts view (roadmap 5a, #99): `listSummaries` filters drafts
  // server-side, so this is the only host read that returns them — the
  // datasets browser's drafts toggle subscribes to it. Since stage 8 (#104)
  // the drafts come back creator-scoped (the choke point's identity rides
  // the wrapper as `viewerId`): user B's toggle never lists user A's drafts.
  listDraftSchemaSummaries: listDraftSummaries,
  getSchema: get,
  getSourceFileUrl,
  createSchema: create,
  updateSchema: update,
} = exposeApi(components.jsonCms, { auth });

/**
 * The widest list bound a host-side fold may pass (issue #128): the
 * component's enumerations require a `limit` and cap it at this — the
 * component's own `LIST_LIMIT_MAX`. Host folds that must see a whole catalog
 * (the closure walk, the tile-cache buster, profiles) pass this ceiling; a
 * catalog past it was already unreachable before #128 (the old unbounded
 * collect blew the per-execution read cap long before a thousand datasets).
 */
export const CATALOG_READ_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Dataset deletion with the host-side cascade (issue #128)
//
// The component's delete covers only its own tables; every HOST row keyed by
// the deleted dataset id used to be orphaned by any delete path. Every host
// caller now goes through `deleteDatasetCascading`, which runs the
// component's (batched) delete and then drains — bounded batches per hop,
// self-rescheduling until done (the unbindCleanup precedent, #127 defect
// 10) — the tables the review named:
//
// - `consumerReferences` naming the id as source (a dataset's float/pin
//   edges; pinned edges on a deleted dataset dangle by definition),
// - `projectArtifacts` memberships naming it as a dataset artifact (each
//   membership's fork edge goes with it — the removeArtifact precedent —
//   and the project's denormalized `artifactCount` is kept honest),
// - `derivedDatasets.dependsOn` arrays naming it (the row itself survives
//   and re-reads as orphaned through its spec — the documented dependent
//   behavior),
// - `versionPolicies` keyed by the id (a live dataset's own policy store),
// - `tagDeltas` keyed by the id as chain anchor,
// - `publishAttempts` keyed by the id as datasetKey (a draft's attempts),
// - `datasetActivity` rows under a binding that still names the id (the
//   unbind flow's own cleanup owns the rest of a binding's children).
//
// Chain data of PUBLISHED rows is deliberately untouched: a frozen
// version's retirement cascades only rows keyed by the version's own id —
// its chain's policy/deltas/attempts hang from the ANCHOR (the draft's or
// registry row's id) and must survive the version.
// ---------------------------------------------------------------------------

/** Rows deleted per table per cascade hop — bounded, rescheduled until drained (the unbindCleanup precedent). */
const CASCADE_BATCH = 200;

const cascadePhaseValidator = v.union(
  v.literal("consumerRefs"),
  v.literal("artifacts"),
  v.literal("dependsOn"),
  v.literal("policies"),
  v.literal("tagDeltas"),
  v.literal("attempts"),
  v.literal("activity"),
);
type CascadePhase =
  | "activity"
  | "artifacts"
  | "attempts"
  | "consumerRefs"
  | "dependsOn"
  | "policies"
  | "tagDeltas";

/** Which host artifact table answers for the deleted id — a component dataset ("dataset") or a derivedDatasets registry row ("derived"). */
const cascadeArtifactKind = v.union(v.literal("dataset"), v.literal("derived"));
export type CascadeArtifactKind = "dataset" | "derived";

/**
 * Schedules the host cascade for one already-deleted (or deleted elsewhere)
 * id. Split from `deleteDatasetCascading` so flows that delete their own row
 * — `derivedDatasets.remove` — share the same cleanup without routing a
 * registry id into the component's delete.
 */
export async function scheduleHostCascade(
  ctx: { scheduler: MutationCtx["scheduler"] },
  opts: { artifactKind?: CascadeArtifactKind; schemaId: string },
): Promise<void> {
  // The cascade runs in its own transaction chain — a component delete may
  // itself still be draining across its own scheduled hops; host rows don't
  // depend on it being finished, only on the id.
  await ctx.scheduler.runAfter(0, internal.schemas.deleteCascadeStep, {
    artifactKind: opts.artifactKind ?? "dataset",
    cursor: undefined,
    phase: "consumerRefs" as const,
    schemaId: opts.schemaId,
  });
}

/**
 * The one entry point for deleting a dataset (component rows AND the host
 * rows keyed by it). `boundWrite` carries the host-only attestation for the
 * flows the component's read-only gate knows (unbind/retire/sync) — client
 * callers never pass it.
 */
export async function deleteDatasetCascading(
  ctx: {
    runMutation: MutationCtx["runMutation"];
    scheduler: MutationCtx["scheduler"];
  },
  opts: { artifactKind?: CascadeArtifactKind; boundWrite?: string; schemaId: string },
): Promise<void> {
  await ctx.runMutation(
    components.jsonCms.lib.deleteSchema,
    opts.boundWrite === undefined
      ? { schemaId: opts.schemaId }
      : { boundWrite: opts.boundWrite, schemaId: opts.schemaId },
  );
  await scheduleHostCascade(ctx, {
    artifactKind: opts.artifactKind,
    schemaId: opts.schemaId,
  });
}

/** The cascade's drain order — one bounded table per phase. */
const CASCADE_PHASE_ORDER: CascadePhase[] = [
  "consumerRefs",
  "artifacts",
  "dependsOn",
  "policies",
  "tagDeltas",
  "attempts",
  "activity",
];

type CascadeDrain =
  /** The table hit its batch cap — resume this phase (with its cursor). */
  | { status: "more"; cursor?: string }
  /** The table is drained past this phase's batch — advance. */
  | { status: "next" };

/** The shared batch-cap verdict: a full batch means the table may have more rows. */
function fullBatch(count: number): CascadeDrain {
  return count === CASCADE_BATCH ? { status: "more" } : { status: "next" };
}

/** Deletes one artifact membership with everything minted alongside it: the fork's version-reference edge (born WITH the membership — projects.addArtifact) and the project's denormalized `artifactCount` decrement. */
async function deleteArtifactMembership(ctx: MutationCtx, membership: Doc<"projectArtifacts">) {
  const edges = await ctx.db
    .query("consumerReferences")
    .withIndex("by_consumer", (q) => q.eq("consumerId", membership._id))
    .take(CASCADE_BATCH);
  await Promise.all(edges.map(async (edge) => ctx.db.delete(edge._id)));
  await ctx.db.delete(membership._id);
  const project = await ctx.db.get(membership.projectId);
  if (project !== null) {
    await ctx.db.patch(project._id, {
      artifactCount: Math.max(0, project.artifactCount - 1),
    });
  }
}

/** Drains one phase's table (bounded). Deleting is monotone — a hit cap always leaves fewer rows behind — so the rescheduling loop converges (the unbindCleanup argument). */
// oxlint-disable-next-line eslint/complexity -- one honest branch per table; splitting the drain would scatter the per-table caps away from their scans.
async function drainCascadeTable(
  ctx: MutationCtx,
  artifactKind: CascadeArtifactKind,
  schemaId: string,
  phase: CascadePhase,
  cursor?: string,
): Promise<CascadeDrain> {
  switch (phase) {
    case "consumerRefs": {
      const rows = await ctx.db
        .query("consumerReferences")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", schemaId))
        .take(CASCADE_BATCH);
      await Promise.all(rows.map(async (row) => ctx.db.delete(row._id)));
      return fullBatch(rows.length);
    }
    case "artifacts": {
      const memberships = await ctx.db
        .query("projectArtifacts")
        .withIndex("by_artifact", (q) =>
          q.eq("artifactKind", artifactKind).eq("artifactId", schemaId),
        )
        .take(CASCADE_BATCH);
      await Promise.all(
        memberships.map(async (membership) => deleteArtifactMembership(ctx, membership)),
      );
      return fullBatch(memberships.length);
    }
    case "dependsOn": {
      // Registry rows whose persisted edges name the deleted id: remove the
      // dead edge, keep the row (its spec still names the id and re-reads as
      // orphaned — the documented dependent behavior). Paged with a cursor
      // so a big registry never re-scans its prefix.
      const page = await ctx.db
        .query("derivedDatasets")
        .paginate({ cursor: cursor ?? null, numItems: CASCADE_BATCH });
      await Promise.all(
        page.page
          .filter((row) => row.dependsOn.includes(schemaId))
          .map(async (row) =>
            ctx.db.patch(row._id, {
              dependsOn: row.dependsOn.filter((dependency) => dependency !== schemaId),
            }),
          ),
      );
      return page.isDone ? { status: "next" } : { status: "more", cursor: page.continueCursor };
    }
    case "policies": {
      const rows = await ctx.db
        .query("versionPolicies")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", schemaId))
        .take(CASCADE_BATCH);
      await Promise.all(rows.map(async (row) => ctx.db.delete(row._id)));
      return fullBatch(rows.length);
    }
    case "tagDeltas": {
      const rows = await ctx.db
        .query("tagDeltas")
        .withIndex("by_source", (q) => q.eq("sourceSchemaId", schemaId))
        .take(CASCADE_BATCH);
      await Promise.all(rows.map(async (row) => ctx.db.delete(row._id)));
      return fullBatch(rows.length);
    }
    case "attempts": {
      const rows = await ctx.db
        .query("publishAttempts")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", schemaId))
        .take(CASCADE_BATCH);
      await Promise.all(rows.map(async (row) => ctx.db.delete(row._id)));
      return fullBatch(rows.length);
    }
    case "activity": {
      // Activity history is keyed by BINDING (no by-schema index), so the
      // drain goes through each binding that still names the deleted id.
      const bindings = await ctx.db
        .query("datasetBindings")
        .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
        .take(CASCADE_BATCH);
      let full = false;
      await Promise.all(
        bindings.map(async (binding) => {
          const activity = await ctx.db
            .query("datasetActivity")
            .withIndex("by_bindingId", (q) => q.eq("bindingId", binding._id))
            .take(CASCADE_BATCH);
          if (activity.length === CASCADE_BATCH) {
            full = true;
          }
          await Promise.all(activity.map(async (row) => ctx.db.delete(row._id)));
        }),
      );
      return full || bindings.length === CASCADE_BATCH ? { status: "more" } : { status: "next" };
    }
  }
  // The union above is exhaustive; this tail only tells the type system (and
  // the consistent-return rule) that every path answers.
  return { status: "next" };
}

/** One cascade hop: drains tables in order until one hits its batch cap (resume there) or every table is clean (null — done). */
async function runCascadePhase(
  ctx: MutationCtx,
  args: {
    artifactKind: CascadeArtifactKind;
    cursor?: string;
    phase: CascadePhase;
    schemaId: string;
  },
): Promise<{ cursor?: string; phase: CascadePhase } | null> {
  let index = CASCADE_PHASE_ORDER.indexOf(args.phase),
    cursor: string | undefined = args.cursor;
  while (index >= 0 && index < CASCADE_PHASE_ORDER.length) {
    const phase = CASCADE_PHASE_ORDER[index];
    // oxlint-disable-next-line no-await-in-loop -- one bounded table per hop; each drain decides the next.
    const drained = await drainCascadeTable(ctx, args.artifactKind, args.schemaId, phase, cursor);
    if (drained.status === "more") {
      return { cursor: drained.cursor, phase };
    }
    cursor = undefined;
    index += 1;
  }
  return null;
}

/** The cascade's self-rescheduling continuation (issue #128). */
export const deleteCascadeStep = internalMutation({
  args: {
    artifactKind: cascadeArtifactKind,
    cursor: v.optional(v.string()),
    phase: cascadePhaseValidator,
    schemaId: v.string(),
  },
  handler: async (ctx, args) => {
    const next = await runCascadePhase(ctx, args);
    if (next !== null) {
      await ctx.scheduler.runAfter(0, internal.schemas.deleteCascadeStep, {
        ...next,
        artifactKind: args.artifactKind,
        schemaId: args.schemaId,
      });
    }
  },
  returns: v.null(),
});

/**
 * Deletes a dataset: the component's rows (the component's own batched
 * cascade — entries, geometries, references, blobs, memberships, layers)
 * plus every host row keyed by the id (see `deleteDatasetCascading`).
 * Signed-in-wide, like the exposeApi wrapper it replaces (trusted
 * collaborators; #124 owns any per-user restriction).
 */
export const remove = mutation({
  args: { schemaId: v.string() },
  handler: async (ctx, args) => {
    // The same operation gate the exposeApi wrapper ran (auth.ts's
    // isolation check + read-only denial — bound datasets delete only
    // through the attested unbind/retire flows): the wrapper became this
    // hand-written mutation so the host cascade runs with it (issue #128),
    // and the policy had to come along.
    await auth(ctx, { fn: "deleteSchema", schemaId: args.schemaId, type: "delete" });
    await deleteDatasetCascading(ctx, { schemaId: args.schemaId });
  },
  returns: v.null(),
});

/**
 * Creates the dataset an import is about to fill, as a lifecycle DRAFT
 * (issue #129): the import flow creates the dataset BEFORE its rows land, so
 * the row must not be catalog-visible until that import completes — a failed
 * or abandoned import then leaves an invisible draft (the creator's drafts
 * view lists it for Retry/Discard) instead of an empty, published dataset.
 * Hand-written (the `remove` pattern) because the exposeApi `createSchema`
 * wrapper deliberately cannot carry `lifecycle` — no client path may create a
 * draft — while this one is import-scoped and ALWAYS does.
 */
export const createDraftForImport = mutation({
  args: {
    geometryType: v.optional(
      v.union(
        v.literal("Point"),
        v.literal("MultiPoint"),
        v.literal("LineString"),
        v.literal("MultiLineString"),
        v.literal("Polygon"),
        v.literal("MultiPolygon"),
      ),
    ),
    kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    schema: v.any(),
    simplifyGeometry: v.optional(v.boolean()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx, { fn: "createSchema", type: "create" });
    return ctx.runMutation(components.jsonCms.lib.createSchema, {
      ...args,
      actorId,
      lifecycle: "draft" as const,
    });
  },
  returns: v.string(),
});

/**
 * Flips an import-created draft to published once its import COMPLETES
 * (issue #129) — the client calls this when the import status turns
 * "completed". Creator-only through the isolation check (a draft is visible
 * to nobody else), and the component's `setSchemaLifecycle` refuses bound
 * datasets, whose lifecycle belongs to their sync flow. In-project drafts
 * never take this path: a project draft stays a draft until the project's
 * own publish (lifecycle §3).
 */
export const markImportComplete = mutation({
  args: { schemaId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx, { fn: "markImportComplete", schemaId: args.schemaId, type: "update" });
    await ctx.runMutation(components.jsonCms.lib.setSchemaLifecycle, {
      lifecycle: "published",
      schemaId: args.schemaId,
    });
  },
  returns: v.null(),
});

/**
 * The largest `mapTileCacheVersion` across all datasets — the cache-buster for
 * the client's persisted light-state cache (issue #58 part 5). Any
 * geometry-affecting write bumps some dataset's version (part 2), so this one
 * number changes exactly when persisted client state may be stale: a mismatch
 * against the persisted buster discards it, while unchanged datasets (the
 * common case) keep their persisted instant-open.
 *
 * Runs the fold server-side so the client pays one number over the wire, not
 * every schema row — over the summaries projection (issue #53), so the
 * component→host hop doesn't carry `schema`/`uiSchema` payloads either.
 *
 * Drafts (roadmap 5a, #99) are excluded: they ride the draft-filtered
 * `listSchemaSummaries`, which is correct while they're invisible (nothing
 * persisted renders a draft). When 5b's publish births a published version
 * row (the draft itself is never flipped), that row's archive version enters
 * this fold and the buster changes once — exactly when the dataset becomes
 * consumer-visible, which is when stale persisted state must be discarded.
 */
export const maxTileCacheVersion = query({
  args: {},
  handler: async (ctx) => {
    const viewerId = await auth(ctx);
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, {
      limit: CATALOG_READ_LIMIT,
      viewerId,
    });
    let max = 0;
    for (const schema of schemas) {
      max = Math.max(max, schema.mapTileCacheVersion ?? 0);
    }
    return max;
  },
  returns: v.number(),
});

/**
 * The creator's published-visibility control (stage 8, #104 — decision D2 on
 * the issue): "author" narrows every catalog read of this dataset to its
 * creator, "everyone" restores the default. Creator-only, enforced HERE —
 * the component's `setSchemaVisibility` is deliberately unexposed, so this
 * host mutation is the only writer (the `lifecycle`/`boundWrite` pattern:
 * host flows resolve identity at the choke point, component flows stay
 * identity-less). Denials read as "not found" so an id's existence never
 * leaks.
 */
export const setVisibility = mutation({
  args: {
    schemaId: v.string(),
    visibility: v.union(v.literal("author"), v.literal("everyone")),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    let doc: FunctionReturnType<typeof components.jsonCms.lib.getSchema>;
    try {
      doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: args.schemaId });
    } catch {
      // A string that isn't a well-formed component id — the same "not
      // found" as an unknown id (the projects.ts tryGetSchema precedent).
      doc = null;
    }
    if (doc === null || doc.createdBy !== actorId) {
      throw new ConvexError("That dataset doesn't exist or you don't have access to it.");
    }
    await ctx.runMutation(components.jsonCms.lib.setSchemaVisibility, {
      publishedVisibility: args.visibility,
      schemaId: args.schemaId,
    });
  },
  returns: v.null(),
});

/**
 * The creator's edit-policy control (issue #124, ADR 0010): "locked" makes
 * every write on this dataset creator-only, "open" restores the
 * trusted-collaborator default (existing rows never migrate — absent reads
 * as open). Creator-only and enforced HERE, exactly like `setVisibility`
 * above — the component's `setEditPolicy` is deliberately unexposed, so this
 * host mutation is the only writer. Locking is itself a write the policy
 * gates, so only the creator can flip it either way; denials read as "not
 * found" so an id's existence never leaks. This mutation carries NO
 * operation into `auth` on purpose: the policy check it enforces is its own
 * creator rule (routing it through the choke point's write gate would make
 * unlocking a locked dataset self-denying — the flip must predate the
 * policy it changes).
 */
export const setEditPolicy = mutation({
  args: {
    editPolicy: v.union(v.literal("open"), v.literal("locked")),
    schemaId: v.string(),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    let doc: FunctionReturnType<typeof components.jsonCms.lib.getSchema>;
    try {
      doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: args.schemaId });
    } catch {
      // A string that isn't a well-formed component id — the same "not
      // found" as an unknown id (the setVisibility precedent above).
      doc = null;
    }
    if (doc === null || doc.createdBy !== actorId) {
      throw new ConvexError("That dataset doesn't exist or you don't have access to it.");
    }
    await ctx.runMutation(components.jsonCms.lib.setEditPolicy, {
      editPolicy: args.editPolicy,
      schemaId: args.schemaId,
    });
  },
  returns: v.null(),
});

/**
 * One-off maintenance for the denormalized dataset summaries (issue #54):
 * stamps `entryCount` onto every dataset and `kind` onto pre-field collection
 * membership rows inside the component. Idempotent — rerun any time drift is
 * suspected (it recomputes from source). Internal on purpose: no app surface
 * drives it, and a signed-in gate would be theater — internal functions are
 * already unreachable by clients. The sign-in gate (roadmap 0.1) rejected
 * its old `convex run` path only because that ran it as a PUBLIC function
 * with no identity; internal functions run via the CLI with admin auth
 * (the seed.ts precedent).
 *
 * Run with: `bunx convex run schemas:backfillSummaries` (from app/)
 */
export const backfillSummaries = internalMutation({
  args: {},
  handler: async (ctx) => ctx.runMutation(components.jsonCms.lib.backfillDatasetSummaries, {}),
  returns: v.object({
    membershipsPatched: v.number(),
    schemasPatched: v.number(),
  }),
});
