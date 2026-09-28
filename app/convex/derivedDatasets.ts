import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { auth } from "./auth";
import schema from "./schema";
import {
  findCycleToOrigin,
  schemaProperties,
  specDependencies,
  specStatus,
  validateSpecShape,
  type DerivedHealth,
  type DatasetResolver,
  type RegistryRowLike,
} from "./derivedSpec";

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
const docValidator = schema
  .doc("derivedDatasets")
  .extend({
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
 * turn).
 */
function resolveDataset(ctx: QueryCtx): DatasetResolver {
  return async (id) => {
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
  };
}

async function healthOf(
  ctx: QueryCtx,
  spec: unknown,
): Promise<{ health: DerivedHealth; reason?: string }> {
  return specStatus(isRecord(spec) ? spec : {}, resolveDataset(ctx));
}

function toSummary(row: Doc<"derivedDatasets">, health: { health: DerivedHealth; reason?: string }) {
  return {
    _creationTime: row._creationTime,
    _id: row._id,
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
 * Deliberately gated on authentication only, like every other write in the
 * app: schemas carry `createdBy` for attribution but nothing enforces
 * ownership, and per-user isolation is stage 8 (roadmap). Drafts carry the
 * same semantics — any signed-in editor may continue one, and the list
 * labels whose it is.
 *
 * Cycle rejection lives here (§3 lines 87-90): an update whose dependencies
 * reach back to itself through other registry rows is rejected before any
 * write. Only an update can close a cycle — a brand-new id cannot already
 * be referenced — so inserts skip the walk.
 */
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

    if (args.id !== undefined) {
      const id = ctx.db.normalizeId("derivedDatasets", args.id);
      if (id === null) {
        throw new ConvexError("This transform no longer exists — it may have been deleted.");
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
      return id;
    }

    return ctx.db.insert("derivedDatasets", {
      createdBy: authId,
      dependsOn: dependencies,
      description: args.description,
      sourceDatasetId: validated.spec.sourceDatasetId,
      spec: args.spec,
      status: args.status,
      title,
    });
  },
  returns: v.id("derivedDatasets"),
});

/**
 * Every registry row targeting one source dataset, newest first — the
 * Transform tab's list (specs authored over THIS dataset). Bounded; health
 * is computed per row at read time.
 */
export const listBySource = query({
  args: { sourceDatasetId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const rows = await ctx.db
      .query("derivedDatasets")
      .withIndex("by_source", (q) => q.eq("sourceDatasetId", args.sourceDatasetId))
      .order("desc")
      .take(200);
    return Promise.all(rows.map(async (row) => toSummary(row, await healthOf(ctx, row.spec))));
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
 * single.
 */
export const summaries = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const rows = await ctx.db
      .query("derivedDatasets")
      .withIndex("by_status_and_source", (q) => q.eq("status", "saved"))
      .take(500);
    return Promise.all(rows.map(async (row) => toSummary(row, await healthOf(ctx, row.spec))));
  },
  returns: v.array(summaryValidator),
});

/**
 * One full registry row by id, health included; null when the id is not a
 * registry row (unknown, deleted, or a component dataset id — the same
 * string-typed id space). The builder loads the row it opens for editing.
 */
export const get = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const id = ctx.db.normalizeId("derivedDatasets", args.id);
    if (id === null) {
      return null;
    }
    const row = await ctx.db.get(id);
    if (row === null) {
      return null;
    }
    const health = await healthOf(ctx, row.spec);
    return { ...row, health: health.health, healthReason: health.reason };
  },
  returns: v.union(v.null(), docValidator),
});

/** Deletes one registry row — a discarded draft or an obsolete spec. Dependents (if any) re-read as orphaned on their next read. */
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const id = ctx.db.normalizeId("derivedDatasets", args.id);
    // normalizeId still accepts the id of a deleted row (the format is
    // valid), so existence is checked before the delete — otherwise Convex
    // answers with a raw "Delete on non-existent doc".
    if (id === null || (await ctx.db.get(id)) === null) {
      throw new ConvexError("This transform no longer exists — it may have been deleted.");
    }
    await ctx.db.delete(id);
  },
  returns: v.null(),
});
