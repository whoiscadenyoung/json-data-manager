import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { auth } from "./auth";
import { syncRegistryReferenceEdges } from "./consumption";

/**
 * Projects — the working container (roadmap stage 7a, #102; lifecycle doc
 * §3-§4, ADR 0008). A project is the virtual working layer: imports and
 * drafts land IN it, and its artifacts are REFERENCES to real datasets /
 * derived specs / maps, never copies ("fork = add-to-project" — reuse-as-is
 * adds a reference; "references, not containment"). The component never
 * learns projects exist: everything here is app-side tables
 * (schema.ts `projects`/`projectArtifacts`) plus host-side component calls.
 *
 * The one flow that creates data, `createDraftDataset`, does three things in
 * ONE transaction: `auth(ctx)`, the component's `createSchema` with the
 * host-only `lifecycle: "draft"` flag (the exposeApi wrapper deliberately
 * omits it — nothing created through a wrapper can land as a draft), and the
 * membership insert. The component call is a subtransaction of this mutation
 * (guidelines), so the draft dataset and its membership row are born together
 * — a crash cannot orphan either. That is also why the draft flag rides the
 * schema doc from creation: `startImport` takes no lifecycle argument (the
 * component's lib.ts), so the existing client ingest flows
 * (`imports.generateUploadUrl`/`startImport`/`getImportStatus`, driven from
 * the create page and bulk-upload) are reused untouched — a draft's rows are
 * real component rows, resolvable through the row-resolution seam like any
 * dataset's, and invisible to catalog reads via the 5a server-side filter
 * (`isCatalogVisible`), which projects never touch.
 *
 * Reads are creator-scoped (`list` by the by_createdBy index, `get` answers
 * null to anyone but the creator) and — since stage 8 (#104) — WRITES are
 * too: `projectForWrite` verifies the caller IS the creator (the recorded
 * D1 decision: projects are per-creator private, no share grants), turning
 * the stamps into checks. The component-side global drafts toggle is
 * creator-scoped at the component read (`viewerId`) since stage 8; the
 * workspace's own reads pass the creator through.
 *
 * 7b (#103) grows this module by the two fork legs and nothing else: the
 * fork-as-reference edge (`addArtifact` mints one float consumerReferences
 * row per dataset membership; `removeArtifact` deletes it with the row) and
 * fork-as-spec (`forkAsSpec` — a saved identity transform over the published
 * source, born a project member). The bundle press itself lives in
 * bundles.ts; it only READS membership rows.
 */

/** Upper bounds per read — a project/workspace read stays bounded no matter the catalog. */
const MAX_PROJECTS = 200;
/** Display bound only: how many membership rows the workspace read renders. Correctness duties (duplicate rejection, removal) never read through it — they hit the by_artifact index exactly. */
const MAX_ARTIFACTS = 500;
/** Bound on how many projects may hold ONE artifact — a sharing-width cap, not a membership-size cap; the duplicate/removal lookups stay exact at any per-project membership size. */
const MAX_HOLDERS = 200;

const artifactKindValidator = v.union(v.literal("dataset"), v.literal("derived"), v.literal("map"));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Friendly title check at the mutation boundary (the component's createSchema enforces non-empty titles too, with a plainer message). */
function assertSchemaTitle(schema: unknown): void {
  if (!isRecord(schema) || typeof schema.title !== "string" || schema.title.trim() === "") {
    throw new ConvexError("Give the dataset a title.");
  }
}

/**
 * One component schema read that tolerates a stored id that isn't a
 * well-formed component id (the publish.ts precedent — "not a dataset" is
 * the answer that keeps the reference checks uniform over plain strings).
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

/** The map twin of `tryGetSchema`. */
async function tryGetMap(
  ctx: { runQuery: QueryCtx["runQuery"] },
  mapId: string,
): Promise<FunctionReturnType<typeof components.jsonCms.lib.getMap>> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.getMap, { mapId });
  } catch {
    return null;
  }
}

/**
 * The catalog visibility rule (decision D2), as a predicate: a draft or
 * author-only row is readable only by its creator. Shared by the artifact
 * and fork authoring checks.
 */
function datasetVisibleTo(
  doc: {
    createdBy?: string;
    lifecycle?: "draft" | "published";
    publishedVisibility?: "author" | "everyone";
  },
  actorId: string,
): boolean {
  if (doc.lifecycle === "draft" || doc.publishedVisibility === "author") {
    return doc.createdBy === actorId;
  }
  return true;
}

/**
 * The registry's draft/saved line as a predicate (the derivedDatasets.get
 * precedent): another user's builder autosave is invisible; saved rows are
 * the registry's catalog-visible side.
 */
function registryRowVisibleTo(
  row: { createdBy: string; status: "draft" | "saved" },
  actorId: string,
): boolean {
  return row.status === "saved" || row.createdBy === actorId;
}

/**
 * Throws unless `artifactId` names a real artifact of `kind` — and, since
 * stage 8 (#104), one VISIBLE to the caller (the project's creator): a
 * foreign builder autosave (a draft registry row) and a foreign draft or
 * author-visibility dataset read exactly as missing, so an invisible id can
 * never be written into a membership row (its existence would leak through
 * every later read of the project). A reference may still point at ANY
 * lifecycle state the caller can see (their own draft is exactly what lands
 * in a project; published datasets and frozen versions are what "fork =
 * add-to-project" references).
 */
async function assertArtifactExists(
  ctx: MutationCtx,
  actorId: string,
  kind: "dataset" | "derived" | "map",
  artifactId: string,
): Promise<void> {
  if (kind === "derived") {
    const id = ctx.db.normalizeId("derivedDatasets", artifactId);
    const row = id === null ? null : await ctx.db.get(id);
    if (row !== null && registryRowVisibleTo(row, actorId)) {
      return;
    }
    throw new ConvexError("No derived dataset was found at that id — it may have been deleted.");
  }
  if (kind === "dataset") {
    const dataset = await tryGetSchema(ctx, artifactId);
    if (dataset !== null && datasetVisibleTo(dataset, actorId)) {
      return;
    }
    throw new ConvexError("No dataset was found at that id — it may have been deleted.");
  }
  const map = await tryGetMap(ctx, artifactId);
  if (map !== null) {
    return;
  }
  throw new ConvexError("No map was found at that id — it may have been deleted.");
}

/**
 * The fork's source check (stage 8, #104): the id must resolve on one side
 * of the duality AND be visible to the forker — the registry rule for a
 * registry row (saved, or the forker's own), the catalog rule for a
 * component dataset. Invisible sources read exactly as missing ids.
 */
async function assertForkSourceVisible(
  ctx: MutationCtx,
  actorId: string,
  sourceDatasetId: string,
): Promise<void> {
  const registryId = ctx.db.normalizeId("derivedDatasets", sourceDatasetId);
  const registryRow = registryId === null ? null : await ctx.db.get(registryId);
  if (registryRow !== null) {
    if (registryRowVisibleTo(registryRow, actorId)) {
      return;
    }
    throw new ConvexError("No dataset was found at that id — it may have been deleted.");
  }
  const dataset = await tryGetSchema(ctx, sourceDatasetId);
  if (dataset !== null && datasetVisibleTo(dataset, actorId)) {
    return;
  }
  throw new ConvexError("No dataset was found at that id — it may have been deleted.");
}

/**
 * The membership insert plus the project's denormalized count, in-transaction
 * (the syncRegistryReferenceEdges pattern: a plain helper so the caller's
 * mutation commits both atomically).
 */
async function insertMembership(
  ctx: MutationCtx,
  project: Doc<"projects">,
  row: { addedBy: string; artifactId: string; artifactKind: "dataset" | "derived" | "map" },
): Promise<Id<"projectArtifacts">> {
  const inserted = await ctx.db.insert("projectArtifacts", {
    addedBy: row.addedBy,
    artifactId: row.artifactId,
    artifactKind: row.artifactKind,
    projectId: project._id,
  });
  await ctx.db.patch(project._id, { artifactCount: project.artifactCount + 1 });
  return inserted;
}

/**
 * The project row a membership mutation writes into, or the friendly
 * gone-error. Since stage 8 (#104, decision D1) this is the OWNERSHIP check:
 * only the project's creator may write into it — membership rows, drafts,
 * forks, presses all ride this one guard (the choke-point principle, one
 * code path for read-null vs write-throw: reads answer null via
 * `projects.get`, writes throw here). Shared with bundles.ts (whose press
 * writes into the same rows). Callers pass the client-sent id through
 * `projectIdArg` first — public functions take project ids as PLAIN
 * STRINGS (the derivedDatasets get/remove and maps.addDerivedLayer pattern:
 * router params are strings on the client, and `normalizeId` + the
 * existence check below validate), while the typed Id travels
 * in-transaction from here on.
 */
export async function projectForWrite(
  ctx: MutationCtx,
  actorId: string,
  projectId: Id<"projects">,
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  // The foreign and missing cases share one answer — an id's existence
  // never leaks to a non-creator.
  if (project === null || project.createdBy !== actorId) {
    throw new ConvexError("This project no longer exists — it may have been deleted.");
  }
  return project;
}

/** Decodes a client-sent project id; null when the string isn't a project id at all (same answer as a missing row). */
function projectIdArg(ctx: { db: QueryCtx["db"] }, projectId: string): Id<"projects"> | null {
  return ctx.db.normalizeId("projects", projectId);
}

export const create = mutation({
  args: { description: v.optional(v.string()), title: v.string() },
  handler: async (ctx, args) => {
    const createdBy = await auth(ctx),
      title = args.title.trim();
    if (title === "") {
      throw new ConvexError("Give the project a title.");
    }
    if (args.description !== undefined && args.description.trim() === "") {
      throw new ConvexError("Leave the description empty instead of blank.");
    }
    return ctx.db.insert("projects", {
      artifactCount: 0,
      createdBy,
      description: args.description,
      title,
    });
  },
  returns: v.id("projects"),
});

/**
 * Creates a lifecycle-draft component dataset AS A PROJECT MEMBER — the
 * in-project create/import entry point (issue #102's recorded decision:
 * import/create lands in the project, part of the flow, not a separate act).
 * Returns the new component schema id (a plain string across the host
 * boundary); the client then drives the ordinary import workflow against it
 * (`imports.startImport` — unchanged, it takes no lifecycle argument because
 * the flag lives on the schema doc this mutation writes).
 *
 * `lifecycle: "draft"` + `actorId` are host-flow-only fields the exposeApi
 * wrapper deliberately omits (client/index.ts createSchema), so this is a
 * DIRECT component call — the `createFrozenVersion` precedent
 * (versioning.ts), minus lineage plus the draft flag.
 */
export const createDraftDataset = mutation({
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
    projectId: v.string(),
    schema: v.any(),
    simplifyGeometry: v.optional(v.boolean()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, actorId, projectId);
    assertSchemaTitle(args.schema);
    const schemaId = await ctx.runMutation(components.jsonCms.lib.createSchema, {
      actorId,
      geometryType: args.geometryType,
      kind: args.kind,
      lifecycle: "draft",
      schema: args.schema,
      simplifyGeometry: args.simplifyGeometry,
      uiSchema: args.uiSchema,
    });
    await insertMembership(ctx, project, {
      addedBy: actorId,
      artifactId: schemaId,
      artifactKind: "dataset",
    });
    return schemaId;
  },
  returns: v.string(),
});

/**
 * Adds one existing artifact to a project — the reference insertion ("fork =
 * add-to-project", lifecycle §3). No component row, no catalog row, no copy
 * of anything (the issue's "forking-as-reference creates no catalog row").
 * Since 7b (#103), a dataset membership also mints ONE float
 * `consumerReferences` edge (consumerKind "fork", consumerId = the membership
 * row) — the version-reference leg: the fork floats the source's chain, and
 * stage 6's pin/sync/revert mutations operate on it like any consumer. Any
 * lifecycle state may be referenced — a draft (pulled into the project), a
 * published dataset or frozen version, a saved derived spec, a map.
 */
export const addArtifact = mutation({
  args: {
    artifactId: v.string(),
    artifactKind: artifactKindValidator,
    projectId: v.string(),
  },
  handler: async (ctx, args) => {
    const addedBy = await auth(ctx),
      projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, addedBy, projectId);
    await assertArtifactExists(ctx, addedBy, args.artifactKind, args.artifactId);
    // Uniqueness is an in-transaction by-ref re-check, not an index — Convex
    // has none (the publishKey precedent): a double-add lands once. The
    // by_artifact lookup answers EXACTLY at any membership size (its width is
    // how many projects hold this one artifact — MAX_HOLDERS — never the
    // project's membership count).
    const holders = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_artifact", (q) =>
        q.eq("artifactKind", args.artifactKind).eq("artifactId", args.artifactId),
      )
      .take(MAX_HOLDERS);
    if (holders.some((row) => row.projectId === projectId)) {
      throw new ConvexError("That artifact is already in this project.");
    }
    const membership = await insertMembership(ctx, project, {
      addedBy,
      artifactId: args.artifactId,
      artifactKind: args.artifactKind,
    });
    if (args.artifactKind === "dataset") {
      // The fork's version-reference edge, born with the membership in the
      // same transaction — float by default (the registry save path's
      // precedent; pin later through consumption.setReferenceMode).
      await ctx.db.insert("consumerReferences", {
        consumerId: membership,
        consumerKind: "fork",
        mode: "float",
        sourceDatasetId: args.artifactId,
      });
    }
    return membership;
  },
  returns: v.id("projectArtifacts"),
});

/**
 * Removes one membership row — and, in the same transaction, the fork's
 * consumer edges minted with it (a reference's version leg lives and dies
 * with the membership). Deliberately touches NOTHING else: the referenced
 * artifact stays exactly as it was (references, not containment — removing a
 * dataset from a project never deletes the dataset, and a draft stays
 * draft-side until its own publish flow crosses it).
 */
export const removeArtifact = mutation({
  args: {
    artifactId: v.string(),
    artifactKind: artifactKindValidator,
    projectId: v.string(),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, actorId, projectId);
    // Exact by_artifact lookup (the index carries both fields) — removal must
    // see the full membership set, never a display-bounded prefix (an
    // un-removable row past a .take cap would be the bug class the
    // membership-rows-not-an-array design exists to avoid).
    const holders = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_artifact", (q) =>
        q.eq("artifactKind", args.artifactKind).eq("artifactId", args.artifactId),
      )
      .take(MAX_HOLDERS);
    const membership = holders.find((row) => row.projectId === projectId);
    if (membership === undefined) {
      throw new ConvexError("That artifact isn't in this project.");
    }
    const edges = await ctx.db
      .query("consumerReferences")
      .withIndex("by_consumer", (q) => q.eq("consumerId", membership._id))
      .collect();
    for (const edge of edges) {
      // oxlint-disable-next-line no-await-in-loop -- one edge per membership, ordered and small.
      await ctx.db.delete(edge._id);
    }
    await ctx.db.delete(membership._id);
    await ctx.db.patch(project._id, { artifactCount: Math.max(0, project.artifactCount - 1) });
    return null;
  },
  returns: v.null(),
});

/**
 * Fork-as-spec (roadmap 7b, #103; lifecycle §3's "reuse-with-transforms
 * creates a derived spec over the published source"): creates a SAVED
 * derivedDatasets registry row whose spec is the identity over
 * `sourceDatasetId` — which may name a component dataset, a frozen version
 * row (both are component ids), or another registry row (derived-of-derived;
 * the id-duality rule) — plus the project membership, in ONE transaction,
 * with the save path's float reference edges. Saved, not a builder autosave,
 * so the fork is publishable day one (publish.start refuses autosaves); the
 * builder edits the spec from here. Never merges back: the fork's versions
 * hang from its own chain anchor (the registry row id).
 */
export const forkAsSpec = mutation({
  args: { projectId: v.string(), sourceDatasetId: v.string(), title: v.string() },
  handler: async (ctx, args) => {
    const addedBy = await auth(ctx),
      projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, addedBy, projectId);
    const title = args.title.trim();
    if (title === "") {
      throw new ConvexError("Give the fork a title.");
    }
    // The source must exist on one side of the id duality (component dataset
    // or registry row — the same resolution `assertArtifactExists` uses for
    // "derived" memberships) — and, since stage 8 (#104), be visible to the
    // forker: a fork over a foreign draft or author-visibility row would mint
    // a SAVED (catalog-visible) registry row naming an invisible id, seeding
    // a ghost spec over data the forker cannot read. The fork design says
    // "over the published source"; invisible sources read as missing.
    await assertForkSourceVisible(ctx, addedBy, args.sourceDatasetId);
    const registryRowId = await ctx.db.insert("derivedDatasets", {
      createdBy: addedBy,
      // The persisted edges, exactly as the save path denormalizes them (the
      // identity spec has exactly one dependency).
      dependsOn: [args.sourceDatasetId],
      sourceDatasetId: args.sourceDatasetId,
      // Identity transform over the source — the fork starts as reuse, and
      // the builder adds transforms from here (the spec shape
      // validateSpecShape accepts).
      spec: { operations: [], sourceDatasetId: args.sourceDatasetId },
      status: "saved",
      title,
    });
    await syncRegistryReferenceEdges(ctx, {
      registryId: registryRowId,
      spec: { operations: [], sourceDatasetId: args.sourceDatasetId },
    });
    await insertMembership(ctx, project, {
      addedBy,
      artifactId: registryRowId,
      artifactKind: "derived",
    });
    return registryRowId;
  },
  returns: v.id("derivedDatasets"),
});

/**
 * The project browser's read: the signed-in caller's own projects, newest
 * first (creator-scoped by the by_createdBy index — another user's projects
 * never enter this payload, the acceptance line for the container surface).
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await auth(ctx);
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_createdBy", (q) => q.eq("createdBy", viewer))
      .order("desc")
      .take(MAX_PROJECTS);
    return rows.map((row) => ({
      _creationTime: row._creationTime,
      _id: row._id,
      artifactCount: row.artifactCount,
      description: row.description,
      title: row.title,
    }));
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("projects"),
      artifactCount: v.number(),
      description: v.optional(v.string()),
      title: v.string(),
    }),
  ),
});

type DatasetSummary = FunctionReturnType<typeof components.jsonCms.lib.listSchemaSummaries>[number];
type ComponentMap = FunctionReturnType<typeof components.jsonCms.lib.listMaps>[number];
type Membership = Doc<"projectArtifacts">;

/** The workspace's per-artifact resolution: the reference, resolved — or `missing` when the artifact was deleted out from under the project (readers answer defensively, the mapLayers precedent). */
type ResolvedArtifact =
  | {
      addedAt: number;
      artifactId: string;
      artifactKind: "dataset" | "derived" | "map";
      _id: Id<"projectArtifacts">;
      state: { kind: "missing" };
    }
  | {
      addedAt: number;
      artifactId: string;
      artifactKind: "dataset" | "derived" | "map";
      _id: Id<"projectArtifacts">;
      state: { kind: "dataset"; summary: DatasetSummary };
    }
  | {
      addedAt: number;
      artifactId: string;
      artifactKind: "dataset" | "derived" | "map";
      _id: Id<"projectArtifacts">;
      state: {
        kind: "derived";
        row: {
          description?: string;
          sourceDatasetId?: string;
          status: "draft" | "saved";
          title: string;
        };
      };
    }
  | {
      addedAt: number;
      artifactId: string;
      artifactKind: "dataset" | "derived" | "map";
      _id: Id<"projectArtifacts">;
      state: { kind: "map"; map: ComponentMap };
    };

async function resolveArtifact(
  ctx: QueryCtx,
  membership: Membership,
  datasetById: Map<string, DatasetSummary>,
  mapById: Map<string, ComponentMap>,
  viewerId: string,
): Promise<ResolvedArtifact> {
  const base = {
    _id: membership._id,
    addedAt: membership._creationTime,
    artifactId: membership.artifactId,
    artifactKind: membership.artifactKind,
  };
  if (membership.artifactKind === "dataset") {
    const summary = datasetById.get(membership.artifactId);
    if (summary === undefined) {
      return { ...base, state: { kind: "missing" } };
    }
    return { ...base, state: { kind: "dataset", summary } };
  }
  if (membership.artifactKind === "map") {
    const map = mapById.get(membership.artifactId);
    if (map === undefined) {
      return { ...base, state: { kind: "missing" } };
    }
    return { ...base, state: { kind: "map", map } };
  }
  const registryId = ctx.db.normalizeId("derivedDatasets", membership.artifactId);
  const row = registryId === null ? null : await ctx.db.get(registryId);
  // Stage 8 (#104): the registry's draft/saved line is its visibility rule
  // (the derivedDatasets.get precedent) — a foreign builder autosave resolved
  // here would leak its title/description/source through this projection, so
  // it reads exactly as a deleted artifact (readers answer `missing`).
  if (row === null || (row.status !== "saved" && row.createdBy !== viewerId)) {
    return { ...base, state: { kind: "missing" } };
  }
  // The Transform-tab link target, browser-parity (the datasets browser's
  // DerivedDatasetCard links only when the source is a COMPONENT dataset —
  // a derived-of-derived source has no page): resolved here, server-side,
  // against the same summaries the workspace read already paid for.
  const sourceDatasetId = datasetById.has(row.sourceDatasetId) ? row.sourceDatasetId : undefined;
  return {
    ...base,
    state: {
      kind: "derived",
      row: {
        description: row.description,
        sourceDatasetId,
        status: row.status,
        title: row.title,
      },
    },
  };
}

/**
 * One workspace read: the project (title/description) plus every membership
 * row resolved to its artifact. null when the project doesn't exist OR
 * belongs to someone else — the creator-scoped read (see the module doc and
 * the schema comment): the membership carries drafts, so this query is where
 * "other users' views never show the drafts" is enforced for the workspace.
 *
 * No `returns` validator: the resolved dataset artifacts embed the
 * component's own summary projection, and re-declaring that shape host-side
 * would duplicate the component's validator (the recorded `users.profile`
 * precedent, users.ts).
 */
export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx),
      projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      return null;
    }
    const project = await ctx.db.get(projectId);
    if (project === null || project.createdBy !== viewer) {
      return null;
    }
    // The workspace DISPLAY read — bounded at MAX_ARTIFACTS. Correctness
    // duties never ride this prefix: duplicate rejection and removal hit the
    // by_artifact index exactly (see addArtifact/removeArtifact). Past the
    // cap the workspace renders the newest 500 rows while `artifactCount`
    // (maintained over the full set) keeps the true total.
    const memberships = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(MAX_ARTIFACTS);
    // Three catalog reads total (the same light reads list surfaces already
    // pay on every load), joined in-memory by id — never one component hop
    // per artifact. The creator's identity scopes them: a draft or
    // author-visibility row resolved here is the creator's own (stage 8 —
    // the workspace never sees another user's drafts, even by a stale
    // membership row pointing at one).
    const [summaries, draftSummaries, maps] = await Promise.all([
      ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, { viewerId: viewer }),
      ctx.runQuery(components.jsonCms.lib.listDraftSchemaSummaries, { viewerId: viewer }),
      ctx.runQuery(components.jsonCms.lib.listMaps, {}),
    ]);
    const datasetById = new Map<string, DatasetSummary>();
    for (const row of summaries) {
      datasetById.set(row._id, row);
    }
    for (const row of draftSummaries) {
      datasetById.set(row._id, row);
    }
    const mapById = new Map<string, ComponentMap>();
    for (const row of maps) {
      mapById.set(row._id, row);
    }
    const artifacts = await Promise.all(
      memberships.map(async (membership) =>
        resolveArtifact(ctx, membership, datasetById, mapById, viewer),
      ),
    );
    return {
      artifacts,
      project: {
        _creationTime: project._creationTime,
        _id: project._id,
        artifactCount: project.artifactCount,
        createdBy: project.createdBy,
        description: project.description,
        title: project.title,
      },
    };
  },
});
