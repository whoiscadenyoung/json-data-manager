import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { auth } from "./auth";
import { syncRegistryReferenceEdges } from "./consumption";
import {
  findCycleToOrigin,
  schemaProperties,
  specDependencies,
  specStatus,
  validateSpecShape,
  type DerivedHealth,
  type DatasetResolver,
  type ReferencedDataset,
  type RegistryRowLike,
} from "./derivedSpec";
import schema from "./schema";
import { scheduleHostCascade } from "./schemas";

/**
 * The derived-dataset registry's functions (roadmap stage 2, #95; ADR 0005
 * §10.2). The table (see schema.ts) stores transform specs — Convex is
 * uninvolved in computation: the client executes specs with the stage 1
 * engine over rows from the row-resolution seam (docs/derived-datasets-design.md
 * §5). What the server owns is exactly what the design gives it: the catalog
 * of specs, save-time cycle rejection over the persisted `dependsOn` edges
 * (§3 lines 87-90), and read-time staleness (§6 lines 143-144 — decided as
 * compute-on-read, centralized in derivedSpec.ts's `specStatus`; see that
 * module doc for why there is no import-completion hook to mark on).
 *
 * Attribution follows schemas.createdBy (ADR 0007): `auth(ctx)`'s identity
 * subject — the Better Auth user id, = users.authId.
 */

/** Read-time health, computed per row by `specStatus` — the one staleness signal stages 3-6 consume. */
const healthValidator = v.object({
  health: v.union(v.literal("orphaned"), v.literal("ready"), v.literal("stale")),
  reason: v.optional(v.string()),
});

/** The list/badge projection: everything a row list renders, health included. */
const summaryValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("derivedDatasets"),
  // Stage 9 (#105): whether the stored spec carries a sql operation — the
  // Analyze tab's list filter, computed HERE so the projection stays light
  // (specs are `v.any()` storage; a list never ships them wholesale).
  carriesSql: v.boolean(),
  createdBy: v.string(),
  description: v.optional(v.string()),
  health: healthValidator.fields.health,
  healthReason: v.optional(v.string()),
  sourceDatasetId: v.string(),
  status: v.union(v.literal("draft"), v.literal("saved")),
  title: v.string(),
});

/**
 * A full row — the builder's `get`, spec included. Derived from the table's
 * own validator (the guidelines' `schema.doc` rule) so stage 5's additive
 * fields can't silently break this returns validator; only the computed
 * health fields are appended here.
 */
const docValidator = schema.doc("derivedDatasets").extend({
  health: healthValidator.fields.health,
  healthReason: v.optional(v.string()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves one referenced dataset id for the walks: a registry row
 * (derived-of-derived edges), a component dataset's declared structure, or
 * nothing. A registry id is told apart from a component id by
 * `normalizeId` — both are plain strings in storage (the id-duality trap:
 * every dependency walk stays uniform over strings and asks each table in
 * turn). Exported for the publish flow's freeze-time health gate (roadmap
 * 5b), which runs the same `specStatus` walk over the same resolver.
 *
 * The optional `cache` is the per-call memo (issue #128): a list computing
 * health for N rows resolves the same source ids repeatedly, and every miss
 * is a component round trip — one shared cache makes the reads proportional
 * to DISTINCT ids, not rows. Fresh per query execution, so reads stay
 * transaction-fresh.
 */
export function resolveDataset(
  ctx: QueryCtx,
  cache?: Map<string, ReferencedDataset>,
): DatasetResolver {
  return async (id) => {
    const hit = cache === undefined ? undefined : cache.get(id);
    if (hit !== undefined) {
      return hit;
    }
    const resolved = await resolveDatasetUncached(ctx, id);
    if (cache !== undefined) {
      cache.set(id, resolved);
    }
    return resolved;
  };
}

async function resolveDatasetUncached(ctx: QueryCtx, id: string): Promise<ReferencedDataset> {
  const registryId = ctx.db.normalizeId("derivedDatasets", id);
  if (registryId !== null) {
    const row = await ctx.db.get(registryId);
    if (row !== null) {
      return { kind: "registry", spec: row.spec, title: row.title };
    }
  }
  try {
    const dataset = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: id });
    if (dataset !== null) {
      return {
        kind: "component",
        properties: schemaProperties(dataset.schema),
        title: dataset.title,
      };
    }
  } catch {
    // A stored id that isn't a well-formed component id fails to decode —
    // the same "not a dataset" as a null read. Health computation must
    // never be the thing that crashes a list.
  }
  return { kind: "missing" };
}

async function healthOf(
  ctx: QueryCtx,
  spec: unknown,
  cache?: Map<string, ReferencedDataset>,
): Promise<{ health: DerivedHealth; reason?: string }> {
  return specStatus(isRecord(spec) ? spec : {}, resolveDataset(ctx, cache));
}

/** Structural read: does the stored spec carry a sql operation? (The summary projection's one spec peek — the derivedSpec tolerance rule, kept local and narrow.) */
function specCarriesSql(spec: unknown): boolean {
  if (!isRecord(spec) || !Array.isArray(spec.operations)) {
    return false;
  }
  return spec.operations.some((operation) => isRecord(operation) && operation.kind === "sql");
}

function toSummary(
  row: Doc<"derivedDatasets">,
  health: { health: DerivedHealth; reason?: string },
) {
  return {
    _creationTime: row._creationTime,
    _id: row._id,
    carriesSql: specCarriesSql(row.spec),
    createdBy: row.createdBy,
    description: row.description,
    health: health.health,
    healthReason: health.reason,
    sourceDatasetId: row.sourceDatasetId,
    status: row.status,
    title: row.title,
  };
}

/** The registry row's walks-only view, for the save-time cycle check. */
async function registryRowFor(ctx: QueryCtx, id: string): Promise<RegistryRowLike | null> {
  const registryId = ctx.db.normalizeId("derivedDatasets", id);
  if (registryId === null) {
    return null;
  }
  const row = await ctx.db.get(registryId);
  return row === null ? null : { dependsOn: row.dependsOn };
}

/**
 * Creates or updates one registry row — the builder's autosave (status
 * "draft") and its explicit Save (status "saved") both land here. Returns
 * the row id, which the client keeps for subsequent autosaves.
 *
 * Ownership (stage 8, #104 — decision D1): UPDATES are creator-only — a
 * builder autosave never lands on another user's row (the pre-stage-8
 * "any signed-in editor may continue one" stance is retired). Inserts stay
 * attribution-only (a new row is born the caller's). Draft rows are
 * creator-private on every read (`get` answers null, `listBySource` hides
 * them); SAVED rows are catalog-visible like published datasets — the
 * draft/saved split is this registry's draft/published line.
 *
 * Cycle rejection lives here (§3 lines 87-90): an update whose dependencies
 * reach back to itself through other registry rows is rejected before any
 * write. Only an update can close a cycle — a brand-new id cannot already
 * be referenced — so inserts skip the walk.
 */
/**
 * Stage 8 (#104): every dataset a spec reads — its source and each
 * operation's lookup dataset, exactly `specDependencies`' walk — must be
 * VISIBLE to the author before a row (draft or saved) may reference it. A
 * spec authored over an invisible id would mint catalog-visible registry
 * rows (and, once saved, consumerReferences edges) naming data the author
 * cannot read — the same authoring-boundary rule `assertArtifactExists` and
 * `forkAsSpec` apply on the project side. The registry leg follows this
 * module's draft/saved line (another user's autosave reads as missing, the
 * `get` precedent); the component leg follows the catalog visibility rule
 * (decision D2). Ids that resolve to NEITHER table stay the health system's
 * domain — orphaned, never blocked — exactly as before this stage.
 */
async function assertSpecDependenciesVisible(
  ctx: MutationCtx,
  actorId: string,
  datasetIds: string[],
): Promise<void> {
  await Promise.all(
    [...new Set(datasetIds)].map(async (datasetId) => {
      const registryId = ctx.db.normalizeId("derivedDatasets", datasetId);
      const registryRow = registryId === null ? null : await ctx.db.get(registryId);
      if (registryRow !== null) {
        if (registryRow.status !== "saved" && registryRow.createdBy !== actorId) {
          throw new ConvexError("That transform doesn't exist or you don't have access to it.");
        }
        return;
      }
      let doc: FunctionReturnType<typeof components.jsonCms.lib.getSchema> = null;
      try {
        doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: datasetId });
      } catch {
        // Not a well-formed component id — the unknown-id tolerance above.
        return;
      }
      if (
        doc !== null &&
        (doc.lifecycle === "draft" || doc.publishedVisibility === "author") &&
        doc.createdBy !== actorId
      ) {
        throw new ConvexError("That dataset doesn't exist or you don't have access to it.");
      }
    }),
  );
}

export const save = mutation({
  args: {
    description: v.optional(v.string()),
    // Present when patching an existing row (the client keeps the id the
    // first autosave minted); absent for a brand-new transform.
    id: v.optional(v.string()),
    // The serializable TransformSpec, stored shapeless (see schema.ts) —
    // checked structurally, never narrowed to today's operation union.
    spec: v.any(),
    status: v.union(v.literal("draft"), v.literal("saved")),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const authId = await auth(ctx),
      title = args.title.trim();
    if (title === "") {
      throw new ConvexError("Give the transform a title.");
    }
    if (args.description !== undefined && args.description.trim() === "") {
      throw new ConvexError("Leave the description empty instead of blank.");
    }
    const validated = validateSpecShape(args.spec);
    if (!validated.ok) {
      throw new ConvexError(validated.reason);
    }
    const dependencies = specDependencies(validated.spec);
    await assertSpecDependenciesVisible(ctx, authId, dependencies);

    if (args.id !== undefined) {
      const id = ctx.db.normalizeId("derivedDatasets", args.id);
      if (id === null) {
        throw new ConvexError("This transform no longer exists — it may have been deleted.");
      }
      // Stage 8: only the row's creator may continue it — a foreign id reads
      // exactly as a missing one.
      const existing = await ctx.db.get(id);
      if (existing === null) {
        throw new ConvexError("This transform no longer exists — it may have been deleted.");
      }
      if (existing.createdBy !== authId) {
        throw new ConvexError("That transform doesn't exist or you don't have access to it.");
      }
      const cycle = await findCycleToOrigin(id, dependencies, async (dep) =>
        registryRowFor(ctx, dep),
      );
      if (cycle !== undefined) {
        throw new ConvexError(
          "Saving this transform would create a circular dependency — it reads from a dataset that (through other derived datasets) reads from this one.",
        );
      }
      await ctx.db.patch(id, {
        dependsOn: dependencies,
        description: args.description,
        // Kept in lockstep with the spec so a retargeted spec never files
        // under a dataset it no longer reads (listBySource/health key off
        // this column).
        sourceDatasetId: validated.spec.sourceDatasetId,
        spec: args.spec,
        status: args.status,
        title,
      });
      await syncConsumerReferences(ctx, id, args.spec, args.status);
      return id;
    }

    const inserted = await ctx.db.insert("derivedDatasets", {
      createdBy: authId,
      dependsOn: dependencies,
      description: args.description,
      sourceDatasetId: validated.spec.sourceDatasetId,
      spec: args.spec,
      status: args.status,
      title,
    });
    await syncConsumerReferences(ctx, inserted, args.spec, args.status);
    return inserted;
  },
  returns: v.id("derivedDatasets"),
});

/**
 * Stage 6 (#101): the saved spec's source references gain the pin/float mode
 * app-side (the issue's recorded decision) — one `consumerReferences` row per
 * dependency, written through consumption's edge-sync so surviving edges
 * keep their mode, new edges land float, and removed edges' rows go. SAVED
 * writes only: builder autosaves never surface as consumers (drafts are
 * invisible to catalog consumers, lifecycle §3). In-transaction via the
 * plain helper, so the save and its edges commit atomically.
 */
async function syncConsumerReferences(
  ctx: MutationCtx,
  registryId: string,
  spec: unknown,
  status: "draft" | "saved",
): Promise<void> {
  if (status !== "saved") {
    return;
  }
  await syncRegistryReferenceEdges(ctx, { registryId, spec });
}

/** Upper bound per read of `listBySource` — the same documented bound the read always had, now served per index leg. */
const LIST_BY_SOURCE_MAX = 200;

/**
 * Every registry row targeting one source dataset, newest first — the
 * Transform tab's list (specs authored over THIS dataset). Bounded; health
 * is computed per row at read time over one shared resolution memo (issue
 * #128). Draft rows are the caller's own since stage 8 (#104) — another
 * user's autosaves are invisible; SAVED rows stay catalog-visible for every
 * signed-in viewer (they are this registry's published side).
 *
 * Since issue #128 the two visibility legs are served by INDEXES (no filter
 * after the take): saved rows read `by_status_and_source` (status leads),
 * the caller's own rows read `by_source_and_creator` — another user's
 * drafts can no longer push visible rows out of the take window (the old
 * read filtered `by_source` after take(200)).
 */
export const listBySource = query({
  args: { sourceDatasetId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx),
      cache = new Map<string, ReferencedDataset>(),
      [saved, own] = await Promise.all([
        ctx.db
          .query("derivedDatasets")
          .withIndex("by_status_and_source", (q) =>
            q.eq("status", "saved").eq("sourceDatasetId", args.sourceDatasetId),
          )
          .order("desc")
          .take(LIST_BY_SOURCE_MAX),
        ctx.db
          .query("derivedDatasets")
          .withIndex("by_source_and_creator", (q) =>
            q.eq("sourceDatasetId", args.sourceDatasetId).eq("createdBy", viewer),
          )
          .order("desc")
          .take(LIST_BY_SOURCE_MAX),
      ]);
    // Merge the legs, dedupe (the caller's own saved rows appear in both),
    // newest first, and bound the union to the same documented cap.
    const seen = new Set<string>(),
      rows = [...saved, ...own]
        .filter((row) => {
          if (seen.has(row._id)) {
            return false;
          }
          seen.add(row._id);
          return true;
        })
        // oxlint-disable-next-line unicorn/no-array-sort -- `.toSorted()` isn't in the lib app/convex typechecks against (the consumption.ts newestFirst precedent); this is a fresh throwaway copy.
        .sort((a, b) => b._creationTime - a._creationTime)
        .slice(0, LIST_BY_SOURCE_MAX);
    return Promise.all(
      rows.map(async (row) => toSummary(row, await healthOf(ctx, row.spec, cache))),
    );
  },
  returns: v.array(summaryValidator),
});

/**
 * The catalog projection — the datasets browser's derived cards. SAVED rows
 * only: an 800ms-debounced autosave must never surface in the catalog as a
 * finished derived dataset (drafts are invisible to catalog consumers,
 * lifecycle doc §3; the Transform tab reads drafts via listBySource).
 * Bounded well below catalog scale; stage 3's consumers (map layers,
 * exports) read the same projection so the derived-badge merge point stays
 * single. Health runs over one shared per-call memo (issue #128), so N rows
 * over the same sources resolve each source once.
 *
 * Measured read ceiling (issue #128 AC 3): with 500 saved rows the read is
 * bounded by the take(500) — its per-row cost is one thin registry doc plus
 * the resolver's component reads, MEMOIZED per distinct id. 500 rows over
 * 500 DISTINCT sources would still make 500 component `getSchema` reads
 * (full schema payloads — up to ~200 KB each), which is why the fixture in
 * derivedDatasets.test.ts shares sources: the common catalog (many specs
 * over few sources) collapses to a handful of component reads. A catalog
 * of 500 specs over 500 distinct fat schemas is the documented ceiling —
 * past it, `summaries` must gain pagination (the take is the bound today).
 */
export const summaries = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const cache = new Map<string, ReferencedDataset>(),
      rows = await ctx.db
        .query("derivedDatasets")
        .withIndex("by_status_and_source", (q) => q.eq("status", "saved"))
        .take(500);
    return Promise.all(
      rows.map(async (row) => toSummary(row, await healthOf(ctx, row.spec, cache))),
    );
  },
  returns: v.array(summaryValidator),
});

/**
 * One full registry row by id, health included; null when the id is not a
 * registry row (unknown, deleted, or a component dataset id — the same
 * string-typed id space). The builder loads the row it opens for editing.
 * Creator-scoped for DRAFTS since stage 8 (#104) — another user's autosave
 * reads exactly as a missing row; saved rows stay catalog-visible (the
 * draft/saved split is the registry's draft/published line, so a saved
 * spec's shape is readable like any published dataset's page).
 */
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx);
    const id = ctx.db.normalizeId("derivedDatasets", args.id);
    if (id === null) {
      return null;
    }
    const row = await ctx.db.get(id);
    if (row === null || (row.status !== "saved" && row.createdBy !== viewer)) {
      return null;
    }
    const health = await healthOf(ctx, row.spec);
    return { ...row, health: health.health, healthReason: health.reason };
  },
  returns: v.union(v.null(), docValidator),
});

/**
 * Deletes one registry row — a discarded draft or an obsolete spec. Dependents
 * (if any) re-read as orphaned on their next read. Creator-only since stage 8
 * (#104): a foreign row reads exactly as a missing one.
 *
 * Since issue #128 the row's HOST rows go with it too (the same cascade a
 * component dataset's delete runs): the edges naming it as a SOURCE (specs
 * and forks reading this transform), its project memberships (artifactKind
 * "derived"), the chain's `versionPolicies`/`tagDeltas`/`publishAttempts`
 * (all keyed by the row id — a derived chain's anchor IS the registry row),
 * and other rows' `dependsOn` edges naming it. The component's map layers
 * pointing at the id deliberately stay (the json-cms component schema.ts
 * dangling-derived-layer rule, packages/json-cms/src/component/schema.ts —
 * mapLayers readers answer "deleted derived dataset" defensively).
 */
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const id = ctx.db.normalizeId("derivedDatasets", args.id);
    // normalizeId still accepts the id of a deleted row (the format is
    // valid), so existence is checked before the delete — otherwise Convex
    // answers with a raw "Delete on non-existent doc".
    if (id === null) {
      throw new ConvexError("This transform no longer exists — it may have been deleted.");
    }
    const row = await ctx.db.get(id);
    if (row === null) {
      throw new ConvexError("This transform no longer exists — it may have been deleted.");
    }
    if (row.createdBy !== actorId) {
      throw new ConvexError("That transform doesn't exist or you don't have access to it.");
    }
    // Stage 6 (#101): the transform's reference edges go with it — a deleted
    // row must not haunt its sources' consumed-by lists as a ghost consumer.
    // (consumedBy also guards on read, which covers edges orphaned before
    // this cleanup shipped.)
    const edges = await ctx.db
      .query("consumerReferences")
      .withIndex("by_consumer", (q) => q.eq("consumerId", id))
      .collect();
    for (const edge of edges) {
      // oxlint-disable-next-line no-await-in-loop -- one edge per hop, ordered with the row delete.
      await ctx.db.delete(edge._id);
    }
    await ctx.db.delete(id);
    // The rest of the host cleanup, in its own rescheduled chain (issue #128).
    await scheduleHostCascade(ctx, { artifactKind: "derived", schemaId: id });
  },
  returns: v.null(),
});
