import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { auth } from "./auth";
import { createChainMemo, resolveSourceHead, syncRegistryReferenceEdges } from "./consumption";
import {
  datasetVisibleTo,
  projectRoleFor,
  projectRoleValidator,
  roleAtLeast,
  type ProjectRole,
} from "./projectAccess";
import { CATALOG_READ_LIMIT } from "./schemas";
import { authIdForUser } from "./users";

/**
 * Projects — the collaborative working container (roadmap stage 7a, #102;
 * lifecycle doc §3-§4, ADR 0008; collaborative since phase 1 of the
 * project-workspace design, ADR 0011). A project is the virtual working
 * layer: imports and drafts land IN it, and its artifacts are REFERENCES to
 * real datasets / derived specs / maps, never copies ("fork = add-to-project"
 * — reuse-as-is adds a reference; "references, not containment"). The
 * component never learns projects exist: everything here is app-side tables
 * (schema.ts `projects`/`projectArtifacts`/`projectMembers`) plus host-side
 * component calls.
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
 * Access is ROLE-based (ADR 0011, superseding stage 8's per-creator D1
 * decision): a `projectMembers` row — owner | editor | viewer — is the whole
 * grant, born with the project (the creator's owner row inserts in the same
 * transaction as the project row and can never be demoted or removed, so a
 * project always has an owner). Reads answer to any member (`list` walks the
 * caller's by_user membership rows; `get` answers null to non-members —
 * the membership carries drafts, so this query is where "other users' views
 * never show the drafts" is enforced for the workspace), writes answer to
 * editor-and-up (`projectForWrite`), member management and deletion answer
 * to the owner alone. The component-side global drafts toggle stays
 * creator-scoped at the component read (`viewerId`); the workspace's own
 * read widens draft RESOLUTION by membership instead (see `get`).
 *
 * 7b (#103) grows this module by the two fork legs and nothing else: the
 * fork-as-reference edge (`addArtifact` mints one float consumerReferences
 * row per dataset membership; `removeArtifact` deletes it with the row) and
 * fork-as-spec (`forkAsSpec` — a saved identity transform over the published
 * source, born a project member). The bundle press itself lives in
 * bundles.ts; it only READS membership rows and rides the same role guard.
 */

/** Upper bounds per read — a project/workspace read stays bounded no matter the catalog. */
const MAX_PROJECTS = 200;
/** Display bound only: how many membership rows the workspace read renders. Correctness duties (duplicate rejection, removal) never read through it — they hit the by_artifact index exactly. */
const MAX_ARTIFACTS = 500;
/** Bound on how many projects may hold ONE artifact — a sharing-width cap, not a membership-size cap; the duplicate/removal lookups stay exact at any per-project membership size. */
const MAX_HOLDERS = 200;

const artifactKindValidator = v.union(
  v.literal("dataset"),
  v.literal("derived"),
  v.literal("layer"),
  v.literal("map"),
);

/** The membership kinds, as the callers that slice by kind name them (phase 3 adds the layers entity). */
type ArtifactKind = "dataset" | "derived" | "layer" | "map";

/**
 * The member-role pair (phase 2 of the project-workspace design): "owned" is
 * the workspace's own working copy (member-editable per ADR 0011), "linked"
 * a versioned row the project references — its view pinned to a version, with
 * explicit sync.
 */
type ArtifactRole = "owned" | "linked";

/** The per-member "keep in sync" checkbox: manual = pinned, auto = floats on the source's head. */
type ArtifactSyncMode = "manual" | "auto";

const artifactSyncModeValidator = v.union(v.literal("manual"), v.literal("auto"));

/**
 * The stored `role` of one membership row, with the pre-field answer: rows
 * minted before phase 2 carried no role, and what the row IS decides — drafts
 * were (and are) the member-editable working copies, everything else a
 * reference. `resolved` is the same draft-ness `assertArtifactExists` resolves;
 * an unresolvable (deleted) artifact answers "linked" — the honest default for
 * a reference row, and display-only either way.
 */
function artifactRoleOf(
  membership: Pick<Doc<"projectArtifacts">, "role" | "artifactKind">,
  resolved: { draft: boolean } | undefined,
): ArtifactRole {
  if (membership.role !== undefined) {
    return membership.role;
  }
  return resolved !== undefined && resolved.draft ? "owned" : "linked";
}

/**
 * The stored `syncMode`, with the pre-field answer: every row minted before
 * phase 2 floated its version edge, which is exactly "auto" behavior.
 */
function artifactSyncModeOf(
  membership: Pick<Doc<"projectArtifacts">, "syncMode">,
): ArtifactSyncMode {
  return membership.syncMode ?? "auto";
}

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
 * The registry's draft/saved line as a predicate (the derivedDatasets.get
 * precedent): another user's builder autosave is invisible; saved rows are
 * the registry's catalog-visible side. The COMPONENT dataset rule it once
 * sat beside (`datasetVisibleTo`) left for projectAccess.ts in phase 1 of
 * the project-workspace design — it is now the shared member-aware rule both
 * this module and the auth choke point run (ADR 0011).
 */
function registryRowVisibleTo(
  row: { createdBy: string; status: "draft" | "saved" },
  actorId: string,
): boolean {
  return row.status === "saved" || row.createdBy === actorId;
}

/**
 * Throws unless `artifactId` names a real artifact of `kind` — and, since
 * stage 8 (#104), one VISIBLE to the caller: a foreign builder autosave (a
 * draft registry row) and a foreign draft or author-visibility dataset read
 * exactly as missing, so an invisible id can never be written into a
 * membership row (its existence would leak through every later read of the
 * project). Since phase 1 (ADR 0011) the dataset rule is the shared
 * member-aware one: a project-held draft is visible to the project's
 * members, not its creator alone (projectAccess.datasetVisibleTo). A
 * reference may still point at ANY lifecycle state the caller can see (their
 * own draft is exactly what lands in a project; published datasets and
 * frozen versions are what "fork = add-to-project" references).
 *
 * Returns the resolved artifact's draft-ness — the input `addArtifact`'s
 * role decision reads (draft → owned, else linked; phase 2) — so the
 * membership insert needs no second component read. A "layer" has no
 * resolution yet (phase 3 introduces the entity): it reads exactly as
 * missing, the same answer every consumer gives it.
 */
async function assertArtifactExists(
  ctx: MutationCtx,
  actorId: string,
  kind: ArtifactKind,
  artifactId: string,
): Promise<{ draft: boolean }> {
  if (kind === "derived") {
    const id = ctx.db.normalizeId("derivedDatasets", artifactId);
    const row = id === null ? null : await ctx.db.get(id);
    if (row !== null && registryRowVisibleTo(row, actorId)) {
      return { draft: row.status === "draft" };
    }
    throw new ConvexError("No derived dataset was found at that id — it may have been deleted.");
  }
  if (kind === "dataset") {
    const dataset = await tryGetSchema(ctx, artifactId);
    if (dataset !== null && (await datasetVisibleTo(ctx, artifactId, dataset, actorId))) {
      return { draft: dataset.lifecycle === "draft" };
    }
    throw new ConvexError("No dataset was found at that id — it may have been deleted.");
  }
  if (kind === "layer") {
    // Phase 3's entity — nothing resolves one yet, so a layer id is not a
    // real artifact today and the reference is refused with the same shape
    // the other missing kinds use.
    throw new ConvexError("No layer was found at that id — it may have been deleted.");
  }
  const map = await tryGetMap(ctx, artifactId);
  if (map !== null) {
    return { draft: false };
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
  if (dataset !== null && (await datasetVisibleTo(ctx, sourceDatasetId, dataset, actorId))) {
    return;
  }
  throw new ConvexError("No dataset was found at that id — it may have been deleted.");
}

/**
 * The membership insert plus the project's denormalized count, in-transaction
 * (the syncRegistryReferenceEdges pattern: a plain helper so the caller's
 * mutation commits both atomically). Every insert stamps the phase-2 role
 * pair explicitly — the optional fields exist only for rows minted before
 * this phase (see the schema comment), never for new ones.
 */
async function insertMembership(
  ctx: MutationCtx,
  project: Doc<"projects">,
  row: {
    addedBy: string;
    artifactId: string;
    artifactKind: ArtifactKind;
    role: ArtifactRole;
    syncMode: ArtifactSyncMode;
  },
): Promise<Id<"projectArtifacts">> {
  const inserted = await ctx.db.insert("projectArtifacts", {
    addedBy: row.addedBy,
    artifactId: row.artifactId,
    artifactKind: row.artifactKind,
    projectId: project._id,
    role: row.role,
    syncMode: row.syncMode,
  });
  await ctx.db.patch(project._id, { artifactCount: project.artifactCount + 1 });
  return inserted;
}

/**
 * The project row a write mutation writes into, or the friendly gone-error.
 * Since phase 1 of the project-workspace design (ADR 0011) this is the ROLE
 * check: the caller must hold AT LEAST `minRole` in the project (editor —
 * the default — for everything that writes content; owner for member
 * management and deletion), where stage 8 (#104, decision D1) had checked
 * the creator stamp alone. One code path for read-null vs write-throw: reads
 * answer null via `projects.get`/`projectForRead`, writes throw here, and a
 * non-member gets the SAME answer a missing project gives — an id's
 * existence never leaks to an outsider (a viewer-role member DOES get the
 * honest write denial, since the workspace read already told them they
 * belong). Shared with bundles.ts (whose press writes into the same rows).
 * Callers pass the client-sent id through `projectIdArg` first — public
 * functions take project ids as PLAIN STRINGS (the derivedDatasets
 * get/remove and maps.addDerivedLayer pattern: router params are strings on
 * the client, and `normalizeId` + the existence check below validate), while
 * the typed Id travels in-transaction from here on.
 */
export async function projectForWrite(
  ctx: MutationCtx,
  actorId: string,
  projectId: Id<"projects">,
  minRole: ProjectRole = "editor",
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  if (project === null) {
    throw new ConvexError("This project no longer exists — it may have been deleted.");
  }
  const role = await projectRoleFor(ctx, projectId, actorId);
  if (role === null || !roleAtLeast(role, minRole)) {
    throw new ConvexError("This project no longer exists — it may have been deleted.");
  }
  return project;
}

/**
 * The project row a member-scoped read answers for, or null when the caller
 * holds no role in it — the read twin of `projectForWrite` (any role,
 * viewer included, is enough to READ; the workspace carries drafts, so this
 * null is also where "other users' views never show the drafts" holds for
 * the container surfaces). bundles.ts's project-scoped reads ride this too.
 */
export async function projectForRead(
  ctx: Pick<QueryCtx, "db">,
  viewerId: string,
  projectId: Id<"projects">,
): Promise<Doc<"projects"> | null> {
  const project = await ctx.db.get(projectId);
  if (project === null) {
    return null;
  }
  return (await projectRoleFor(ctx, projectId, viewerId)) === null ? null : project;
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
    // The creator's owner row is born WITH the project, in the same
    // transaction (the draft+membership pattern): the membership rows are
    // the whole grant (ADR 0011), so a project and its first grant cannot
    // exist apart. setRole/removeMember refuse to touch this row, which is
    // what keeps "a project always has an owner" true without any
    // last-owner election logic.
    const projectId = await ctx.db.insert("projects", {
      artifactCount: 0,
      createdBy,
      description: args.description,
      title,
    });
    await ctx.db.insert("projectMembers", { projectId, role: "owner", userId: createdBy });
    return projectId;
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
      role: "owned",
      syncMode: "manual",
    });
    return schemaId;
  },
  returns: v.string(),
});

/**
 * Adds one existing artifact to a project — the reference insertion ("fork =
 * add-to-project", lifecycle §3). No component row, no catalog row, no copy
 * of anything (the issue's "forking-as-reference creates no catalog row").
 *
 * Phase 2 of the project-workspace design gives the membership its role pair:
 * a DRAFT lands "owned" (the workspace's own working copy — ADR 0011 makes
 * project-held drafts member-editable, which is the "modify" side of the
 * model's link-XOR-modify line); everything versioned lands "linked" (a
 * published dataset, a saved derived row, a map). A linked DATASET membership
 * mints its version-reference edge PINNED at the source chain's current head —
 * the design's "linked add mints a pin edge at head (today it floats)" —
 * unless the add asked to keep it in sync (`syncMode: "auto"`), which floats
 * the edge live. `syncMode: "manual"` with no head to pin (a published row
 * that was never version-frozen) falls back to float: there is nothing to pin
 * yet, and float is the only honest state — the first Sync/keep-in-sync flip
 * pins it. Any lifecycle state may be referenced — a draft (pulled into the
 * project), a published dataset or frozen version, a saved derived spec, a map.
 */
export const addArtifact = mutation({
  args: {
    artifactId: v.string(),
    artifactKind: artifactKindValidator,
    projectId: v.string(),
    syncMode: v.optional(artifactSyncModeValidator),
  },
  handler: async (ctx, args) => {
    const addedBy = await auth(ctx),
      projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, addedBy, projectId);
    const resolved = await assertArtifactExists(ctx, addedBy, args.artifactKind, args.artifactId);
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
    const syncMode = args.syncMode ?? "manual",
      role: ArtifactRole = resolved.draft ? "owned" : "linked";
    const membership = await insertMembership(ctx, project, {
      addedBy,
      artifactId: args.artifactId,
      artifactKind: args.artifactKind,
      role,
      syncMode,
    });
    if (args.artifactKind === "dataset") {
      // The version-reference edge, born with the membership in the same
      // transaction. Owned members (drafts) float — their working copy IS the
      // project's view, and the sync surface refuses them. Linked members pin
      // at head unless the add asked to keep them in sync.
      let edgeMode: "float" | "pin" = "float";
      let pinned: { ref?: string; schemaId?: string } = {};
      if (role === "linked" && syncMode === "manual") {
        const head = await resolveSourceHead(ctx, args.artifactId);
        if (head !== undefined) {
          edgeMode = "pin";
          pinned = { ref: head.ref, schemaId: head.schemaId };
        }
      }
      await ctx.db.insert("consumerReferences", {
        consumerId: membership,
        consumerKind: "fork",
        mode: edgeMode,
        sourceDatasetId: args.artifactId,
        pinnedRef: pinned.ref,
        pinnedSchemaId: pinned.schemaId,
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
 * The per-member "keep in sync" checkbox (phase 2 of the project-workspace
 * design): sets one LINKED member's `syncMode` and moves its version edge to
 * match — "auto" floats the edge live on the source's head; "manual" pins it
 * at the CURRENT head ("stop following, freeze where we are"). Editor-and-up
 * (a reference's sync preference is a content write, ADR 0011). The link-XOR-
 * modify guard: an OWNED member is refused — it is the project's working copy,
 * edited in place, with no version relationship to configure; maps are refused
 * too (no version chains until phase 3 retires them into projects).
 */
export const setMemberSync = mutation({
  args: {
    artifactId: v.string(),
    artifactKind: artifactKindValidator,
    projectId: v.string(),
    syncMode: artifactSyncModeValidator,
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw goneProject();
    }
    // Editor-and-up: the sync preference is a content write on the project's
    // reference state (the project row itself is not needed past the guard).
    await projectForWrite(ctx, actorId, projectId);
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
    if (membership.role === "owned") {
      throw new ConvexError(
        "Owned members are edited in place — keep-in-sync applies to linked references only.",
      );
    }
    if (args.artifactKind === "map") {
      throw new ConvexError("Maps don't carry version chains to sync yet.");
    }
    if (args.artifactKind === "layer") {
      throw new ConvexError("Layers aren't referenceable yet.");
    }
    const edge = await ctx.db
      .query("consumerReferences")
      .withIndex("by_consumer", (q) => q.eq("consumerId", membership._id))
      .first();
    if (edge === null) {
      throw new ConvexError(
        "This member has no version reference to configure — only linked datasets carry one today.",
      );
    }
    if (args.syncMode === "auto") {
      await ctx.db.patch(edge._id, {
        mode: "float",
        pinnedRef: undefined,
        pinnedSchemaId: undefined,
      });
      await ctx.db.patch(membership._id, { syncMode: "auto" });
      return null;
    }
    const head = await resolveSourceHead(ctx, membership.artifactId);
    if (head === undefined) {
      throw new ConvexError("The source has no published versions to pin yet — publish it first.");
    }
    await ctx.db.patch(edge._id, {
      mode: "pin",
      pinnedRef: head.ref,
      pinnedSchemaId: head.schemaId,
    });
    await ctx.db.patch(membership._id, { syncMode: "manual" });
    return null;
  },
  returns: v.null(),
});

/**
 * Which of the CALLER's projects hold one artifact — the "Add to project"
 * sheets' Added badges (the browser/detail entry points, phase 2). Scoped to
 * the viewer's own memberships: a project they hold no role in contributes
 * nothing, so another user's workspace never leaks through a dataset they can
 * see. Bounded at MAX_HOLDERS like every by_artifact lookup.
 */
export const holdingProjects = query({
  args: { artifactId: v.string(), artifactKind: artifactKindValidator },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx);
    const holders = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_artifact", (q) =>
        q.eq("artifactKind", args.artifactKind).eq("artifactId", args.artifactId),
      )
      .take(MAX_HOLDERS);
    const mine: Id<"projects">[] = [];
    for (const row of holders) {
      // oxlint-disable-next-line no-await-in-loop -- short-circuit membership checks, one per holder, bounded by MAX_HOLDERS.
      const role = await projectRoleFor(ctx, row.projectId, viewer);
      if (role !== null) {
        mine.push(row.projectId);
      }
    }
    return mine;
  },
  returns: v.array(v.id("projects")),
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
      // Born in this project: the workspace's own fork, member-publishable —
      // owned (phase 2), never the linked/pinned kind.
      role: "owned",
      syncMode: "manual",
    });
    return registryRowId;
  },
  returns: v.id("derivedDatasets"),
});

/**
 * The project browser's read: every project the signed-in caller BELONGS to,
 * newest first (ADR 0011 — the by_user index on projectMembers answers; the
 * old by_createdBy scan answered only to creators). Each row carries the
 * caller's own role so the browser can badge Owner/Editor/Viewer without a
 * second query. Dangling membership rows (a project deleted under a member —
 * `remove` cascades, so this needs a crash or a future bug to exist) are
 * skipped, not crashed on.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await auth(ctx);
    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", viewer))
      .take(MAX_PROJECTS);
    const rows = (
      await Promise.all(
        memberships.map(async (membership) => ({
          membership,
          project: await ctx.db.get(membership.projectId),
        })),
      )
    ).filter((row): row is { membership: Doc<"projectMembers">; project: Doc<"projects"> } => {
      return row.project !== null;
    });
    return (
      rows
        // oxlint-disable-next-line unicorn/no-array-sort -- freshly built throwaway array; .toSorted() isn't in the lib app/convex typechecks against (the projects.test.ts note).
        .sort((a, b) => b.project._creationTime - a.project._creationTime)
        .map((row) => ({
          _creationTime: row.project._creationTime,
          _id: row.project._id,
          artifactCount: row.project.artifactCount,
          description: row.project.description,
          role: row.membership.role,
          title: row.project.title,
        }))
    );
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("projects"),
      artifactCount: v.number(),
      description: v.optional(v.string()),
      role: projectRoleValidator,
      title: v.string(),
    }),
  ),
});

type DatasetSummary = FunctionReturnType<typeof components.jsonCms.lib.listSchemaSummaries>[number];
type ComponentMap = FunctionReturnType<typeof components.jsonCms.lib.listMaps>[number];
type Membership = Doc<"projectArtifacts">;

/**
 * One LINKED dataset member's version-reference state (phase 2): the edge the
 * workspace's Sync/Revert actions drive (by id, through
 * `consumption.syncReference`/`revertReference`), its mode, and the
 * "update available" answer — a pinned edge whose source chain's head has
 * moved. Float edges are always current (live IS head); a pin whose chain has
 * NO head at all (every version retired) reads as not-up-to-date, and Sync
 * gives the honest error.
 */
type MemberSyncState = {
  headRef?: string;
  headVersionLabel?: string;
  mode: "float" | "pin";
  pinnedRef?: string;
  referenceId: Id<"consumerReferences">;
  upToDate: boolean;
};

/** The role/sync pair every artifact row carries (see artifactRoleOf/artifactSyncModeOf for the pre-field defaults). `sync` is populated for LINKED dataset members only — the union keeps it optional at the base so every consumer reads one shape. */
type ResolvedArtifactBase = {
  addedAt: number;
  artifactId: string;
  artifactKind: ArtifactKind;
  _id: Id<"projectArtifacts">;
  role: ArtifactRole;
  syncMode: ArtifactSyncMode;
  sync?: MemberSyncState;
};

/** The workspace's per-artifact resolution: the reference, resolved — or `missing` when the artifact was deleted out from under the project (readers answer defensively, the mapLayers precedent). */
type ResolvedArtifact =
  | (ResolvedArtifactBase & { state: { kind: "missing" } })
  | (ResolvedArtifactBase & { state: { kind: "dataset"; summary: DatasetSummary } })
  | (ResolvedArtifactBase & {
      state: {
        kind: "derived";
        row: {
          description?: string;
          sourceDatasetId?: string;
          status: "draft" | "saved";
          title: string;
        };
      };
    })
  | (ResolvedArtifactBase & { state: { kind: "map"; map: ComponentMap } });

/**
 * The version-reference state of one dataset membership, for the workspace's
 * sync column: the membership's fork edge plus the source chain's head, only
 * resolved when the edge is PINNED (a float is current by definition —
 * resolving its head would be a component read per row for a badge that can
 * never show).
 */
async function memberSyncStateOf(
  ctx: QueryCtx,
  membership: Membership,
  memo: ReturnType<typeof createChainMemo>,
): Promise<MemberSyncState | undefined> {
  const edge = await ctx.db
    .query("consumerReferences")
    .withIndex("by_consumer", (q) => q.eq("consumerId", membership._id))
    .first();
  if (edge === null) {
    return undefined;
  }
  if (edge.mode === "float") {
    return { mode: "float", referenceId: edge._id, upToDate: true };
  }
  const head = await resolveSourceHead(ctx, edge.sourceDatasetId, memo);
  return {
    headRef: head === undefined ? undefined : head.ref,
    headVersionLabel: head === undefined ? undefined : head.versionLabel,
    mode: "pin",
    pinnedRef: edge.pinnedRef,
    referenceId: edge._id,
    upToDate: head !== undefined && head.ref === edge.pinnedRef,
  };
}

/** The dataset arm of `resolveArtifact`: role from the summary's lifecycle, and the sync projection for LINKED members. */
async function resolveDatasetArtifact(
  ctx: QueryCtx,
  membership: Membership,
  summary: DatasetSummary,
  memo: ReturnType<typeof createChainMemo>,
): Promise<ResolvedArtifact> {
  const base = {
    _id: membership._id,
    addedAt: membership._creationTime,
    artifactId: membership.artifactId,
    artifactKind: membership.artifactKind,
    syncMode: artifactSyncModeOf(membership),
  };
  const role = artifactRoleOf(membership, { draft: summary.lifecycle === "draft" });
  const sync = role === "linked" ? await memberSyncStateOf(ctx, membership, memo) : undefined;
  return {
    ...base,
    role,
    state: { kind: "dataset", summary },
    ...(sync === undefined ? {} : { sync }),
  };
}

/** The registry-row arm: visibility first (stage 8's leak rule), then the role and the Transform-tab link target. */
function resolveDerivedArtifact(
  membership: Membership,
  row: Doc<"derivedDatasets">,
  viewerId: string,
  datasetById: Map<string, DatasetSummary>,
): ResolvedArtifact {
  const base = {
    _id: membership._id,
    addedAt: membership._creationTime,
    artifactId: membership.artifactId,
    artifactKind: membership.artifactKind,
    syncMode: artifactSyncModeOf(membership),
  };
  // Stage 8 (#104): the registry's draft/saved line is its visibility rule
  // (the derivedDatasets.get precedent) — a foreign builder autosave resolved
  // here would leak its title/description/source through this projection, so
  // it reads exactly as a deleted artifact (readers answer `missing`).
  if (row.status !== "saved" && row.createdBy !== viewerId) {
    return { ...base, role: artifactRoleOf(membership, undefined), state: { kind: "missing" } };
  }
  // The Transform-tab link target, browser-parity (the datasets browser's
  // DerivedDatasetCard links only when the source is a COMPONENT dataset —
  // a derived-of-derived source has no page): resolved here, server-side,
  // against the same summaries the workspace read already paid for.
  const sourceDatasetId = datasetById.has(row.sourceDatasetId) ? row.sourceDatasetId : undefined;
  return {
    ...base,
    role: artifactRoleOf(membership, { draft: row.status === "draft" }),
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

async function resolveArtifact(
  ctx: QueryCtx,
  membership: Membership,
  datasetById: Map<string, DatasetSummary>,
  mapById: Map<string, ComponentMap>,
  viewerId: string,
  memo: ReturnType<typeof createChainMemo>,
): Promise<ResolvedArtifact> {
  const base = {
    _id: membership._id,
    addedAt: membership._creationTime,
    artifactId: membership.artifactId,
    artifactKind: membership.artifactKind,
    syncMode: artifactSyncModeOf(membership),
  };
  if (membership.artifactKind === "dataset") {
    const summary = datasetById.get(membership.artifactId);
    return summary === undefined
      ? { ...base, role: artifactRoleOf(membership, undefined), state: { kind: "missing" } }
      : resolveDatasetArtifact(ctx, membership, summary, memo);
  }
  if (membership.artifactKind === "map") {
    const map = mapById.get(membership.artifactId);
    return map === undefined
      ? { ...base, role: artifactRoleOf(membership, undefined), state: { kind: "missing" } }
      : { ...base, role: artifactRoleOf(membership, undefined), state: { kind: "map", map } };
  }
  if (membership.artifactKind === "layer") {
    // Phase 3's entity: nothing resolves one yet, so the row reads exactly as
    // a deleted artifact until the layers table lands.
    return { ...base, role: artifactRoleOf(membership, undefined), state: { kind: "missing" } };
  }
  const registryId = ctx.db.normalizeId("derivedDatasets", membership.artifactId);
  const row = registryId === null ? null : await ctx.db.get(registryId);
  return row === null
    ? { ...base, role: artifactRoleOf(membership, undefined), state: { kind: "missing" } }
    : resolveDerivedArtifact(membership, row, viewerId, datasetById);
}

/**
 * One workspace read: the project (title/description) plus every membership
 * row resolved to its artifact, and the caller's own role. null when the
 * project doesn't exist OR the caller holds no role in it — the member-scoped
 * read (see the module doc and the schema comment): the membership carries
 * drafts, so this query is where "other users' views never show the drafts"
 * is enforced for the workspace. Since phase 1 (ADR 0011) draft RESOLUTION is
 * membership-scoped rather than identity-scoped: a project-held draft was
 * born (or added) into this project, so every member may see it — the two
 * identity-scoped component reads cover the caller's own rows, and the rest
 * resolve through the by-ids host read, fed ONLY this project's membership
 * ids (the role check above is what authorizes the whole payload).
 *
 * Phase 2 of the project-workspace design: every artifact row also carries
 * its role pair (`role`/`syncMode`, the pre-field defaults derived in
 * artifactRoleOf/artifactSyncModeOf), and LINKED dataset members carry
 * `sync` — the version-reference state the workspace's Sync/Revert actions
 * and "update available" badge render from.
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
    const role = project === null ? null : await projectRoleFor(ctx, projectId, viewer);
    if (project === null || role === null) {
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
    // Three identity-scoped catalog reads (the same light reads list
    // surfaces already pay on every load), joined in-memory by id — never
    // one component hop per artifact. The caller's identity scopes them: a
    // draft or author-visibility row resolved here is the caller's own —
    // until the by-ids pass below adds the project-held rows other members
    // created, which ADR 0011 makes workspace-visible by design.
    const [summaries, draftSummaries, maps] = await Promise.all([
      ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, {
        limit: CATALOG_READ_LIMIT,
        viewerId: viewer,
      }),
      ctx.runQuery(components.jsonCms.lib.listDraftSchemaSummaries, {
        limit: CATALOG_READ_LIMIT,
        viewerId: viewer,
      }),
      ctx.runQuery(components.jsonCms.lib.listMaps, { limit: CATALOG_READ_LIMIT }),
    ]);
    const datasetById = new Map<string, DatasetSummary>();
    for (const row of summaries) {
      datasetById.set(row._id, row);
    }
    for (const row of draftSummaries) {
      datasetById.set(row._id, row);
    }
    // The member-visible drafts the identity-scoped reads can never return:
    // resolved by id from THIS project's membership rows only. Junk ids
    // (a membership row can name any string) simply come back absent —
    // resolveArtifact answers "missing", exactly as for a deleted artifact.
    const unresolved = memberships
      .filter((membership) => membership.artifactKind === "dataset")
      .map((membership) => membership.artifactId)
      .filter((artifactId) => !datasetById.has(artifactId))
      .slice(0, MAX_ARTIFACTS);
    if (unresolved.length > 0) {
      const memberDrafts = await ctx.runQuery(components.jsonCms.lib.getSchemaSummaries, {
        schemaIds: unresolved,
      });
      for (const row of memberDrafts) {
        datasetById.set(row._id, row);
      }
    }
    const mapById = new Map<string, ComponentMap>();
    for (const row of maps) {
      mapById.set(row._id, row);
    }
    // The per-call resolution memo (issue #128): the linked members' chain
    // heads resolve once per DISTINCT source, not once per row.
    const memo = createChainMemo();
    const artifacts = await Promise.all(
      memberships.map(async (membership) =>
        resolveArtifact(ctx, membership, datasetById, mapById, viewer, memo),
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
        // The caller's own role — the page badges it and gates its controls
        // on it (Owner/Editor/Viewer), so no second query is needed.
        role,
        title: project.title,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Collaboration (phase 1 of the project-workspace design, ADR 0011):
// edit the project, delete it, manage its members.
// ---------------------------------------------------------------------------

/** The gone-error every project-scoped mutation shares (the `projectIdArg` answer). */
function goneProject(): ConvexError<string> {
  return new ConvexError("This project no longer exists — it may have been deleted.");
}

/** The member row one (project, user) pair answers with, or null — the exact by-ref lookup the membership mutations re-check (Convex has no unique indexes; the addArtifact precedent). */
async function memberRowFor(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  userId: string,
): Promise<Doc<"projectMembers"> | null> {
  return ctx.db
    .query("projectMembers")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .filter((q) => q.eq(q.field("userId"), userId))
    .first();
}

/**
 * Edits the project's own fields — title and/or description. Editor-and-up
 * (ADR 0011: shaping the workspace is a content write, not member
 * management). Same blank-field rules as `create` — the title is the only
 * required field, and blank is refused rather than silently trimmed away
 * (the UI-polish rule).
 */
export const update = mutation({
  args: {
    description: v.optional(v.string()),
    projectId: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw goneProject();
    }
    const project = await projectForWrite(ctx, actorId, projectId);
    const patch: { description?: string; title?: string } = {};
    if (args.title !== undefined) {
      const title = args.title.trim();
      if (title === "") {
        throw new ConvexError("Give the project a title.");
      }
      patch.title = title;
    }
    if (args.description !== undefined) {
      if (args.description.trim() === "") {
        throw new ConvexError("Leave the description empty instead of blank.");
      }
      patch.description = args.description;
    }
    if (patch.title !== undefined || patch.description !== undefined) {
      await ctx.db.patch(project._id, patch);
    }
    return null;
  },
  returns: v.null(),
});

/**
 * Deletes the project — owner-only. The cascade is the MEMBERSHIP side:
 * every projectArtifacts row, every projectMembers row, and the fork
 * reference edges minted with dataset memberships go with the project, in
 * one transaction. Deliberately NOT the artifacts — references, not
 * containment (the removeArtifact rule, unchanged): a draft created in the
 * project survives as its creator's draft (visible in their drafts toggle,
 * publishable on its own), and published rows never even notice. The UI's
 * confirm dialog says exactly this, because it is destructive only to the
 * collaboration, never to the data.
 */
export const remove = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw goneProject();
    }
    const project = await projectForWrite(ctx, actorId, projectId, "owner");
    // Exact reads on purpose — a deletion that stops at a display cap would
    // orphan membership rows (and their edges) forever. Projects and their
    // memberships are human-scale; the unbounded walk is the honest shape
    // for a one-transaction teardown.
    const memberships = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const membership of memberships) {
      // oxlint-disable-next-line no-await-in-loop -- one membership per loop, ordered and small (the removeArtifact shape).
      const edges = await ctx.db
        .query("consumerReferences")
        .withIndex("by_consumer", (q) => q.eq("consumerId", membership._id))
        .collect();
      for (const edge of edges) {
        // oxlint-disable-next-line no-await-in-loop -- one edge per membership, ordered and small (the removeArtifact shape).
        await ctx.db.delete(edge._id);
      }
      // oxlint-disable-next-line no-await-in-loop -- one membership per loop, ordered and small (the removeArtifact shape).
      await ctx.db.delete(membership._id);
    }
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const member of members) {
      // oxlint-disable-next-line no-await-in-loop -- one member per loop, ordered and small.
      await ctx.db.delete(member._id);
    }
    await ctx.db.delete(project._id);
    return null;
  },
  returns: v.null(),
});

/**
 * The members dialog's read: the project's membership rows joined with the
 * users mirror (name/image; the email only when the viewer IS that user —
 * the same PII line users.ts draws, ADR 0009 addendum). Answers to any
 * member — a viewer sees who they share the project with — and to nobody
 * else (a non-member's read answers empty: the same read-null-vs-write-throw
 * split, list-shaped). Members added through a host flow with no mirror row
 * (a deleted account) render with their id and no profile fields.
 */
export const members = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx);
    const projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null || (await projectRoleFor(ctx, projectId, viewer)) === null) {
      return [];
    }
    const rows = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(MAX_ARTIFACTS);
    return Promise.all(
      rows.map(async (row) => {
        const user = await ctx.db
          .query("users")
          .withIndex("by_authId", (q) => q.eq("authId", row.userId))
          .first();
        return {
          _creationTime: row._creationTime,
          email: user !== null && user.authId === viewer ? user.email : undefined,
          image: user === null ? undefined : user.image,
          name: user === null ? undefined : user.name,
          role: row.role,
          userId: row.userId,
        };
      }),
    );
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      email: v.optional(v.string()),
      image: v.optional(v.string()),
      name: v.optional(v.string()),
      role: projectRoleValidator,
      userId: v.string(),
    }),
  ),
});

/**
 * Adds one member — owner-only (ADR 0011's member-management line). `user`
 * names an account by Better Auth user id OR by email (resolved through
 * users.ts's mirror-row lookup — the invite dialog accepts either). Role is
 * explicit (the dialog carries a picker); duplicates land once via the
 * in-transaction re-check. Inviting the creator re-answers "already a
 * member" — their owner row predates every invite.
 */
export const addMember = mutation({
  args: { projectId: v.string(), role: projectRoleValidator, user: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw goneProject();
    }
    await projectForWrite(ctx, actorId, projectId, "owner");
    const authId = await authIdForUser(ctx, args.user);
    if (authId === null) {
      throw new ConvexError("No account was found for that user id or email.");
    }
    if ((await memberRowFor(ctx, projectId, authId)) !== null) {
      throw new ConvexError("That person is already a member of this project.");
    }
    return ctx.db.insert("projectMembers", { projectId, role: args.role, userId: authId });
  },
  returns: v.id("projectMembers"),
});

/**
 * Changes one member's role — owner-only. The creator's row is refused for
 * EVERY change (even owner→owner): it is the invariant that keeps "a
 * project always has an owner" true with no election logic, so it doesn't
 * participate in role changes at all.
 */
export const setRole = mutation({
  args: { projectId: v.string(), role: projectRoleValidator, userId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw goneProject();
    }
    const project = await projectForWrite(ctx, actorId, projectId, "owner");
    const row = await memberRowFor(ctx, projectId, args.userId);
    if (row === null) {
      throw new ConvexError("That person isn't a member of this project.");
    }
    if (args.userId === project.createdBy) {
      throw new ConvexError("The project's creator always stays the owner.");
    }
    await ctx.db.patch(row._id, { role: args.role });
    return null;
  },
  returns: v.null(),
});

/**
 * Removes one member — owner-only, same creator carve-out as `setRole`
 * (the creator can leave by deleting the project, not by demoting
 * themself). Nothing else is touched: a removed member's drafts stay their
 * own; the project simply stops being visible to them (the membership row
 * was the whole grant).
 */
export const removeMember = mutation({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const projectId = projectIdArg(ctx, args.projectId);
    if (projectId === null) {
      throw goneProject();
    }
    const project = await projectForWrite(ctx, actorId, projectId, "owner");
    const row = await memberRowFor(ctx, projectId, args.userId);
    if (row === null) {
      throw new ConvexError("That person isn't a member of this project.");
    }
    if (args.userId === project.createdBy) {
      throw new ConvexError("The project's creator can't be removed.");
    }
    await ctx.db.delete(row._id);
    return null;
  },
  returns: v.null(),
});
