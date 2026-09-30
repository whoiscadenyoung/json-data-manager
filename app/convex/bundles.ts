import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { auth } from "./auth";
import { resolveSourceHead } from "./consumption";
import { projectForWrite } from "./projects";

/**
 * Bundle publish and fork (roadmap 7b, #103; lifecycle doc §2/§5-§6, ADR
 * 0008): one project presses once and produces exactly one bundle — the
 * collection (promoted), each map (promoted behaviorally, its
 * mapLayers/mapLayerOverrides untouched), and the deduped referenced datasets
 * frozen as versions through the EXISTING 5b state machine
 * (`api.publish.*` — deliberately never forked).
 *
 * The act has four legs, in WRITE order:
 *
 * 1. **The closure walk** (the pure `bundleClosure` core below, resolved by
 *    `collectClosureInput`): every project membership plus every dataset each
 *    map's layers reach — collection/group layers expand LIVE exactly like
 *    the map workspace's `expandLayerDatasets`, deduped by id ("datasets
 *    referenced multiple times publish once"), cycle-safe by visited set
 *    (the findCycleToOrigin precedent — drafts cannot cycle, but the walk is
 *    total over any layer graph). Derived members' own sources stay OUT of
 *    the closure (exposure decoupled, lifecycle §2): they surface only as the
 *    lineage the 5b freeze records. The collection's files are member rows of
 *    a `bundleRuns` press (schema.ts) — the bundle-level checkpoint that
 *    makes one-press resume exact.
 * 2. **Per-member publish** — CLIENT-driven (`src/lib/bundle-publish.ts`),
 *    calling `publishDataset` per member exactly as the dataset page does;
 *    the host only checkpoints outcomes (`recordMember`). Already-published
 *    dataset members are born "referenced": no new version, they gain
 *    collection membership at leg 3.
 * 3. **The collection leg** (`promoteCollection`): create-once, reuse-after
 *    component collection named for the project, every member's frozen row
 *    (or referenced row) filed into it, and each newly frozen row attached to
 *    its draft's group — group layers would otherwise render nothing
 *    post-publish, since a frozen row is born ungrouped. Both are
 *    organization writes, which the component allows on lineage rows.
 * 4. **The map leg** (`linkMapLayers`): one float `consumerReferences` row
 *    per direct dataset layer target (consumerKind "map"). Maps are promoted
 *    by their rows persisting; this leg is only the version-reference edge —
 *    the stale-id trap's answer.
 *
 * Recorded decisions (the issue's open items):
 * - **Stale-id handling: resolution, never repointing.** A layer target id is
 *   a chain ANCHOR; reads resolve it (float → the chain's head via
 *   `consumption.resolveSourceHead`, pin → the pinned row) and render the
 *   resolved row's data under the anchor's id — layer structure, overrides,
 *   and live-layer state stay shared and untouched. Collection layers
 *   self-heal through live membership (frozen rows are filed into the
 *   collection), group layers through the group re-attach in leg 3; only
 *   direct dataset layers need the edge. A target with no chain renders
 *   itself — today's behavior, unchanged. A PIN whose pinned row was retired
 *   resolves to NOTHING, and the workspace SUPPRESSES the layer instead of
 *   letting it fall back to the anchor's live rows — rendering newer data
 *   than the pin would be the stale-id leak in the other direction; the
 *   sync/revert mutations are its repair path.
 * - **Republish: a re-press re-promotes every member** (new attempts, vN+1,
 *   append-only) — no per-dataset change signal exists to do
 *   changed-inputs-only honestly; keep-N retention bounds the chains. See
 *   the `bundleRuns` table doc.
 * - **Exposure defaults:** import sources are exposed by inclusion (they are
 *   what the maps and collection reference); derived sources stay private
 *   with lineage-only provenance. No per-artifact "expose source?" toggle
 *   ships here — adding the source to the project puts it in the next press.
 * - **Live-expansion asymmetry (recorded, not left implicit):** a
 *   collection/group layer expands LIVE at read time, so datasets added to
 *   the group later appear in the published map WITHOUT a republish — but
 *   they are not bundle members until the next press. On the CAPTURE side the
 *   bundle rule holds ("SMART 2024, not 'all SMART'"): expansion only ever
 *   captures datasets the project already holds (its memberships, its maps'
 *   direct layer targets) or datasets that are already published — a foreign
 *   draft sharing a layered collection is dropped from the plan, never
 *   silently frozen into the catalog by someone else's press.
 * - **Derived members publish in topological order** (by the registry rows'
 *   `dependsOn`): a fork-of-fork pair publishes its source first, so the
 *   fork's freeze records the source's FRESH head in lineage — provenance
 *   matches the rows the client actually computed over.
 *
 * Stage 8 (#104): the press is creator-private — `start` writes only through
 * `projects.projectForWrite`'s ownership check (any leg mutation rides the
 * same check via `runningRun`: a run's project answers to its creator, and a
 * foreign runId reads as "no longer exists"), and the closure reads take the
 * creator as the component reads' `viewerId` (the plan names drafts — a
 * foreign draft can never enter a plan). Reads stay split deliberately: the
 * project-scoped ones (`plan`, `run`, `latestForProject`) are creator-scoped
 * like `projects.get`, while `layerResolutions` still answers to any
 * signed-in MAP viewer — maps are shared catalog artifacts (the recorded D1
 * boundary: the component's maps table carries no creator stamp; adding one
 * is the recorded follow-up), and the read exposes only the anchor ids and
 * modes the map's own layer rows already show. A draft target resolves to no
 * chain either way, so it leaks nothing.
 */

// ---------------------------------------------------------------------------
// The pure closure core — Convex-free, unit-tested with stand-ins
// (derivedSpec.ts's pattern).
// ---------------------------------------------------------------------------

/** A project membership as the closure walk sees it. */
export interface BundleMembershipLike {
  artifactId: string;
  artifactKind: "dataset" | "derived" | "map";
}

/** One map's layers, as `listMapLayers` returns them (structural slice). */
export interface BundleMapLayersLike {
  layers: ReadonlyArray<{
    targetId: string;
    targetType: "collection" | "dataset" | "derived" | "group";
  }>;
  mapId: string;
}

/** Everything the walk expands through, resolved host-side from component reads. */
export interface BundleClosureInput {
  /** Component `{collection, dataset}` membership rows (ALL of them — drafts included; the consumer `listSchemasByCollection` read filters drafts, so the walk uses the raw rows). */
  collectionMembers: ReadonlyArray<{ collectionId: string; schemaId: string }>;
  /** Saved registry row id → its persisted `dependsOn` edges — the derived members' topological order. */
  dependsOnByRegistry?: ReadonlyMap<string, readonly string[]>;
  /** Dataset id → its group (both summary lists merged — drafts included). */
  groupIdByDataset: ReadonlyMap<string, string>;
  /** Dataset id → "draft" | "published" (absent = unknown/deleted → dropped). */
  lifecycleByDataset: ReadonlyMap<string, "draft" | "published">;
  /** The project's membership rows. */
  memberships: ReadonlyArray<BundleMembershipLike>;
  /** Existing maps' layers (a deleted map never enters this list). */
  layersByMap: ReadonlyArray<BundleMapLayersLike>;
  /** Component groups with a collection — the collection-layer expansion's group leg. */
  groupsByCollection: ReadonlyArray<{ collectionId: string; groupId: string }>;
  /** Registry row ids whose status is "saved" (publishable; autosaves and deleted rows are out). */
  savedRegistryIds: ReadonlySet<string>;
  /** Map memberships past the press's read bound (maps.deleteMapLayersForCollectionTree-era bound, MAX_MAPS) — reported distinctly, never as "deleted". */
  unexaminedMapIds?: ReadonlySet<string>;
}

/** One planned member of one press. */
export interface BundleMemberPlan {
  datasetKey: string;
  /** Dataset members: the draft's group, re-attached to the frozen row at the collection leg. */
  groupId?: string;
  kind: "dataset" | "derived" | "map";
  /** Map members: the direct dataset-layer targets the map leg mints references for. */
  layerTargets: string[];
  /** False for already-published dataset members (membership only, never a new version). */
  publish: boolean;
}

export interface BundleClosureResult {
  /** References the plan had to leave out, with why (deleted artifact, builder autosave, a foreign draft). */
  dropped: Array<{ id: string; reason: string }>;
  /** Canonical WRITE order: datasets, then derived (topological — sources before the forks over them), then maps. */
  members: BundleMemberPlan[];
}

/** A live-expansion target resolved to the dataset ids it currently reaches — the map workspace's `expandLayerDatasets` shape, at publish time. */
function expandLiveLayer(
  input: BundleClosureInput,
  targetId: string,
  targetType: "collection" | "group",
): string[] {
  if (targetType === "group") {
    return [...input.groupIdByDataset]
      .filter(([, groupId]) => groupId === targetId)
      .map(([datasetId]) => datasetId);
  }
  const memberIds = input.collectionMembers
      .filter((membership) => membership.collectionId === targetId)
      .map((membership) => membership.schemaId),
    groupIds = new Set(
      input.groupsByCollection
        .filter((group) => group.collectionId === targetId)
        .map((group) => group.groupId),
    );
  for (const [datasetId, groupId] of input.groupIdByDataset) {
    if (groupIds.has(groupId)) {
      memberIds.push(datasetId);
    }
  }
  return memberIds;
}

/**
 * Orders the derived members so a fork publishes after the fork it was built
 * over (dependencies first) — the freeze's `sourceVersionsFor` records the
 * source's head AT FREEZE, so source-before-fork is what keeps lineage
 * honest. Edges between MEMBERS only; the save gate rejects cycles, so a
 * defensive leftovers pass (discovery order) keeps the walk total.
 */
function topologicalDerivedOrder(
  derivedMembers: readonly string[],
  dependsOnByRegistry: ReadonlyMap<string, readonly string[]>,
): string[] {
  const memberSet = new Set(derivedMembers),
    ordered: string[] = [],
    placed = new Set<string>();
  const place = (id: string, trail: Set<string>): void => {
    if (placed.has(id)) {
      return;
    }
    if (trail.has(id)) {
      // A cycle the save gate should have rejected — keep discovery order.
      placed.add(id);
      ordered.push(id);
      return;
    }
    trail.add(id);
    for (const dependency of dependsOnByRegistry.get(id) ?? []) {
      if (memberSet.has(dependency)) {
        place(dependency, trail);
      }
    }
    trail.delete(id);
    placed.add(id);
    ordered.push(id);
  };
  for (const id of derivedMembers) {
    place(id, new Set());
  }
  return ordered;
}

/**
 * The bundle closure (issue acceptance #1): the collection's datasets are
 * every project membership plus every dataset the project's maps reach,
 * deduped by id. A draft publishes (v1, or vN+1 on a re-press) when the
 * project HOLDS it — a membership or one of its maps' direct layer targets;
 * a draft discovered only through a live collection/group expansion belongs
 * to whoever owns it and is dropped, never frozen by this press. An
 * already-published dataset is a member only; a saved transform publishes
 * through the derived half of the 5b machine; a map is promoted with its
 * dataset-layer targets recorded. The visited sets are the cycle guard — the
 * live expansion graph (collection ↔ groups ↔ datasets through many-to-many
 * memberships) is walked defensively, shared branches visited once.
 */
export function bundleClosure(input: BundleClosureInput): BundleClosureResult {
  const datasetMembers = new Map<string, BundleMemberPlan>(),
    derivedMembers: string[] = [],
    dropped: Array<{ id: string; reason: string }> = [],
    mapMembers: BundleMemberPlan[] = [],
    ownDatasetIds = new Set(
      input.memberships
        .filter((membership) => membership.artifactKind === "dataset")
        .map((membership) => membership.artifactId),
    ),
    seenDerived = new Set<string>(),
    seenMaps = new Set<string>();

  const addDataset = (id: string, via: "membership" | "layer" | "expansion"): void => {
    if (datasetMembers.has(id)) {
      return;
    }
    const lifecycle = input.lifecycleByDataset.get(id);
    if (lifecycle === undefined) {
      dropped.push({ id, reason: "The dataset no longer exists." });
      return;
    }
    if (lifecycle === "draft") {
      if (via === "expansion" && !ownDatasetIds.has(id)) {
        // Someone else's WIP sharing a layered collection — the bundle rule
        // keeps it out of this press.
        dropped.push({
          id,
          reason:
            "A draft this project doesn't hold — it stays with its own project until published.",
        });
        return;
      }
      datasetMembers.set(id, {
        datasetKey: id,
        groupId: input.groupIdByDataset.get(id),
        kind: "dataset",
        layerTargets: [],
        publish: true,
      });
      return;
    }
    // Already published: joins the bundle as a member only — no new version.
    datasetMembers.set(id, {
      datasetKey: id,
      kind: "dataset",
      layerTargets: [],
      publish: false,
    });
  };

  const addDerived = (id: string): void => {
    if (seenDerived.has(id)) {
      return;
    }
    seenDerived.add(id);
    if (!input.savedRegistryIds.has(id)) {
      dropped.push({
        id,
        reason: "Not a saved transform (deleted, or a builder autosave — save it first).",
      });
      return;
    }
    derivedMembers.push(id);
  };

  const addMap = (map: BundleMapLayersLike): void => {
    if (seenMaps.has(map.mapId)) {
      return;
    }
    seenMaps.add(map.mapId);
    const layerTargets: string[] = [];
    for (const layer of map.layers) {
      if (layer.targetType === "dataset") {
        // Recorded for the map leg even when unknown — the edge names the
        // layer's own target id, whatever it resolves to at read time.
        layerTargets.push(layer.targetId);
        addDataset(layer.targetId, "layer");
      } else if (layer.targetType === "derived") {
        // A map forces its layer datasets to publish — derived layers
        // included (their sources stay out of the closure, §2).
        addDerived(layer.targetId);
      } else {
        for (const id of expandLiveLayer(input, layer.targetId, layer.targetType)) {
          addDataset(id, "expansion");
        }
      }
    }
    mapMembers.push({
      datasetKey: map.mapId,
      kind: "map",
      layerTargets,
      publish: false,
    });
  };

  for (const membership of input.memberships) {
    if (membership.artifactKind === "dataset") {
      addDataset(membership.artifactId, "membership");
    } else if (membership.artifactKind === "derived") {
      addDerived(membership.artifactId);
    } else {
      const map = input.layersByMap.find((entry) => entry.mapId === membership.artifactId);
      if (map === undefined) {
        dropped.push({
          id: membership.artifactId,
          reason: (input.unexaminedMapIds ?? new Set()).has(membership.artifactId)
            ? "Over the press's 200-map read bound — it joins the next press."
            : "The map no longer exists.",
        });
        continue;
      }
      addMap(map);
    }
  }

  return {
    dropped,
    members: [
      ...datasetMembers.values(),
      ...topologicalDerivedOrder(derivedMembers, input.dependsOnByRegistry ?? new Map()).map(
        (id) => ({
          datasetKey: id,
          kind: "derived" as const,
          layerTargets: [],
          publish: true,
        }),
      ),
      ...mapMembers,
    ],
  };
}

// ---------------------------------------------------------------------------
// Host-side closure resolution: component reads → the pure core's input
// ---------------------------------------------------------------------------

/** Upper bounds per collection read — the walk stays bounded like every host enumeration. */
const MAX_MAPS = 200;
/** Failed members reported per latestForProject read — the detail list is bounded like every read; the count stays exact. */
const MAX_REPORTED_FAILURES = 20;

/**
 * One component read that tolerates a stored id that isn't well-formed (the
 * publish.ts/projects.ts precedent — "not a collection" keeps the legs total).
 */
async function tryGetCollection(
  ctx: { runQuery: QueryCtx["runQuery"] },
  collectionId: string,
): Promise<FunctionReturnType<typeof components.jsonCms.lib.getCollection>> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.getCollection, { collectionId });
  } catch {
    return null;
  }
}

/** The map twin (projects.ts's `tryGetMap`). */
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
 * The map memberships' layers, resolved for the closure core: one map read +
 * one layers read per map membership (bounded by MAX_MAPS), and every derived
 * layer target checked against the registry. A deleted map simply doesn't
 * enter the list — the core reports the membership as dropped.
 */
async function collectLayersByMap(
  ctx: QueryCtx,
  memberships: Array<{ artifactId: string; artifactKind: "dataset" | "derived" | "map" }>,
  checkRegistry: (id: string) => Promise<void>,
): Promise<BundleMapLayersLike[]> {
  const layersByMap: BundleMapLayersLike[] = [];
  for (const membership of memberships) {
    if (membership.artifactKind !== "map" || layersByMap.length >= MAX_MAPS) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one map read per map membership, bounded by MAX_MAPS.
    const map = await tryGetMap(ctx, membership.artifactId);
    if (map === null) {
      continue; // Deleted maps are dropped by the core, not here — it reports them.
    }
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const layers = await ctx.runQuery(components.jsonCms.lib.listMapLayers, {
      mapId: membership.artifactId,
    });
    for (const layer of layers) {
      if (layer.targetType === "derived") {
        // oxlint-disable-next-line no-await-in-loop -- one registry read per derived layer, bounded by layer count.
        await checkRegistry(layer.targetId);
      }
    }
    layersByMap.push({
      layers: layers.map((layer) => ({ targetId: layer.targetId, targetType: layer.targetType })),
      mapId: membership.artifactId,
    });
  }
  return layersByMap;
}

/**
 * Resolves everything the pure closure core reads, from the project's
 * membership rows plus four light component reads (the same summaries pair
 * `projects.get` pays — merged so drafts and published rows answer alike —
 * plus the raw membership rows, which include the drafts the consumer
 * `listSchemasByCollection` filters out, and the groups list). The
 * `viewerId` is the project's creator (every caller has already checked
 * ownership): the summaries pair is identity-scoped, so a foreign draft or
 * author-only row never enters a plan — the walk answers "no longer exists"
 * for it, the same answer the isolation rules give everywhere else. The
 * registry reads also capture each saved row's `dependsOn` edges, so derived
 * members can be ordered sources-before-forks.
 */
async function collectClosureInput(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  viewerId: string,
): Promise<BundleClosureInput> {
  const memberships = await ctx.db
    .query("projectArtifacts")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(MAX_MAPS * 5);
  const [summaries, drafts, membershipsRows, groups] = await Promise.all([
    ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, { viewerId }),
    ctx.runQuery(components.jsonCms.lib.listDraftSchemaSummaries, { viewerId }),
    ctx.runQuery(components.jsonCms.lib.listSchemaCollections, {}),
    ctx.runQuery(components.jsonCms.lib.listGroups, {}),
  ]);

  const lifecycleByDataset = new Map<string, "draft" | "published">(),
    groupIdByDataset = new Map<string, string>();
  for (const row of [...summaries, ...drafts]) {
    lifecycleByDataset.set(row._id, row.lifecycle === "draft" ? "draft" : "published");
    if (row.groupId !== undefined) {
      groupIdByDataset.set(row._id, row.groupId);
    }
  }

  const savedRegistryIds = new Set<string>(),
    dependsOnByRegistry = new Map<string, string[]>();
  const checkRegistry = async (id: string): Promise<void> => {
    const registryId = ctx.db.normalizeId("derivedDatasets", id);
    if (registryId === null) {
      return;
    }
    const row = await ctx.db.get(registryId);
    if (row !== null && row.status === "saved") {
      savedRegistryIds.add(id);
      dependsOnByRegistry.set(id, row.dependsOn);
    }
  };
  for (const membership of memberships) {
    if (membership.artifactKind === "derived") {
      // oxlint-disable-next-line no-await-in-loop -- one registry read per derived membership, bounded by membership count.
      await checkRegistry(membership.artifactId);
    }
  }

  const mapMemberships = memberships.filter((membership) => membership.artifactKind === "map");
  return {
    collectionMembers: membershipsRows.map((row) => ({
      collectionId: row.collectionId,
      schemaId: row.schemaId,
    })),
    dependsOnByRegistry,
    groupIdByDataset,
    groupsByCollection: groups
      .filter((group) => group.collectionId !== undefined)
      .map((group) => ({ collectionId: group.collectionId ?? "", groupId: group._id })),
    layersByMap: await collectLayersByMap(ctx, mapMemberships, checkRegistry),
    lifecycleByDataset,
    memberships: memberships.map((row) => ({
      artifactId: row.artifactId,
      artifactKind: row.artifactKind,
    })),
    savedRegistryIds,
    unexaminedMapIds: new Set(mapMemberships.slice(MAX_MAPS).map((row) => row.artifactId)),
  };
}

// ---------------------------------------------------------------------------
// Queries: the plan preview, the run progress, the project's published link
// ---------------------------------------------------------------------------

const memberPlanValidator = v.object({
  datasetKey: v.string(),
  groupId: v.optional(v.string()),
  kind: v.union(v.literal("dataset"), v.literal("derived"), v.literal("map")),
  layerTargets: v.array(v.string()),
  publish: v.boolean(),
});

/** The project row a project-scoped read answers for, or null when it doesn't exist or belongs to someone else — the `projects.get` scoping, since the plan names drafts (see the module doc's read-scope split). */
async function projectForRead(
  ctx: { auth: QueryCtx["auth"]; db: QueryCtx["db"] },
  projectId: string,
): Promise<Doc<"projects"> | null> {
  const viewer = await auth(ctx),
    projectId_ = ctx.db.normalizeId("projects", projectId);
  if (projectId_ === null) {
    return null;
  }
  const project = await ctx.db.get(projectId_);
  if (project === null || project.createdBy !== viewer) {
    return null;
  }
  return project;
}

/**
 * What one press of this project WOULD do — the press's preview and the
 * tests' plan assertion. null when the project doesn't exist or belongs to
 * another user (creator-scoped: the plan names drafts).
 */
export const plan = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const project = await projectForRead(ctx, args.projectId);
    if (project === null) {
      return null;
    }
    const result = bundleClosure(await collectClosureInput(ctx, project._id, project.createdBy));
    return { dropped: result.dropped, members: result.members };
  },
  returns: v.union(
    v.null(),
    v.object({
      dropped: v.array(v.object({ id: v.string(), reason: v.string() })),
      members: v.array(memberPlanValidator),
    }),
  ),
});

const memberStatusValidator = v.union(
  v.literal("pending"),
  v.literal("publishing"),
  v.literal("published"),
  v.literal("referenced"),
  v.literal("linked"),
  v.literal("failed"),
);

const runMemberValidator = v.object({
  attemptId: v.optional(v.string()),
  datasetKey: v.string(),
  error: v.optional(v.string()),
  groupId: v.optional(v.string()),
  kind: v.union(v.literal("dataset"), v.literal("derived"), v.literal("map")),
  layerTargets: v.optional(v.array(v.string())),
  publishedSchemaId: v.optional(v.string()),
  publish: v.boolean(),
  status: memberStatusValidator,
});

/** One press's progress: the run row plus every member row, in press order. Creator-scoped like the rest of the project surface (member rows name drafts). */
export const run = query({
  args: { runId: v.id("bundleRuns") },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx);
    const runRow = await ctx.db.get(args.runId);
    if (runRow === null) {
      return null;
    }
    const project = await ctx.db.get(runRow.projectId);
    if (project === null || project.createdBy !== viewer) {
      return null;
    }
    const members = await ctx.db
      .query("bundleRunMembers")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    return {
      members: members.map((member) => ({
        attemptId: member.attemptId,
        datasetKey: member.datasetKey,
        error: member.error,
        groupId: member.groupId,
        kind: member.kind,
        layerTargets: member.layerTargets,
        publishedSchemaId: member.publishedSchemaId,
        publish: member.publish,
        status: member.status,
      })),
      run: {
        _creationTime: runRow._creationTime,
        _id: runRow._id,
        collectionId: runRow.collectionId,
        error: runRow.error,
        finishedAt: runRow.finishedAt,
        projectId: runRow.projectId,
        startedAt: runRow.startedAt,
        status: runRow.status,
        title: runRow.title,
      },
    };
  },
  returns: v.union(
    v.null(),
    v.object({
      members: v.array(runMemberValidator),
      run: v.object({
        _creationTime: v.number(),
        _id: v.id("bundleRuns"),
        collectionId: v.optional(v.string()),
        error: v.optional(v.string()),
        finishedAt: v.optional(v.number()),
        projectId: v.id("projects"),
        startedAt: v.number(),
        status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
        title: v.string(),
      }),
    }),
  ),
});

/**
 * The project's bundle link for the workspace card: the newest press's
 * status and, once a press completed its collection leg, the promoted
 * collection's component id (plain string) — the project→collection link.
 * Carries `lastProgressAt` so the client can tell a LIVE press from one a
 * killed browser left behind (the syncRuns stale precedent), and the failed
 * members with their errors so the UI can say exactly what to retry.
 * Creator-scoped like `projects.get`.
 */
export const latestForProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const project = await projectForRead(ctx, args.projectId);
    if (project === null) {
      return null;
    }
    const runRow = await ctx.db
      .query("bundleRuns")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (runRow === null) {
      return null;
    }
    const members = await ctx.db
      .query("bundleRunMembers")
      .withIndex("by_run", (q) => q.eq("runId", runRow._id))
      .collect();
    const failedMembers = members
      .filter((member) => member.status === "failed")
      .map((member) => ({ datasetKey: member.datasetKey, error: member.error }));
    return {
      collectionId: runRow.collectionId,
      error: runRow.error,
      failedCount: failedMembers.length,
      failedMembers: failedMembers.slice(MAX_REPORTED_FAILURES),
      finishedAt: runRow.finishedAt,
      lastProgressAt: runRow.lastProgressAt,
      memberCount: members.length,
      publishedCount: members.filter(
        (member) => member.status === "published" || member.status === "referenced",
      ).length,
      startedAt: runRow.startedAt,
      status: runRow.status,
      title: runRow.title,
    };
  },
  returns: v.union(
    v.null(),
    v.object({
      collectionId: v.optional(v.string()),
      error: v.optional(v.string()),
      failedCount: v.number(),
      failedMembers: v.array(v.object({ datasetKey: v.string(), error: v.optional(v.string()) })),
      finishedAt: v.optional(v.number()),
      lastProgressAt: v.number(),
      memberCount: v.number(),
      publishedCount: v.number(),
      startedAt: v.number(),
      status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
      title: v.string(),
    }),
  ),
});

/**
 * The published map's layer resolutions (the stale-id leg): for every
 * consumerReferences row this map holds on a dataset, the row id its layer
 * should RENDER — the pinned row for a pin, the chain's head for a float,
 * and nothing for a target with no chain (the layer renders itself — its
 * live rows — exactly as before 7b). A PIN whose row no longer exists also
 * resolves to nothing — but that is NOT the no-chain case: the client
 * suppresses such a layer entirely rather than letting it fall back to the
 * anchor's live rows (rendering newer data than the pin would be the
 * stale-id leak in the other direction); the sync/revert mutations are its
 * repair path. The workspace substitutes render-side only; stored layer rows
 * are never rewritten.
 */
export const layerResolutions = query({
  args: { mapId: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const edges = await ctx.db
      .query("consumerReferences")
      .withIndex("by_consumer", (q) => q.eq("consumerId", args.mapId))
      .collect();
    const resolutions: Array<{
      anchorId: string;
      mode: "float" | "pin";
      resolvedSchemaId?: string;
    }> = [];
    for (const edge of edges) {
      if (edge.consumerKind !== "map") {
        continue;
      }
      let resolvedSchemaId: string | undefined;
      if (edge.mode === "pin") {
        // The pinned row, if it still exists. One edge resolution per hop,
        // each read deciding the next (the consumption.ts badge shape).
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const pinnedRow =
          edge.pinnedSchemaId === undefined
            ? null
            : await tryGetSchemaOrNull(ctx, edge.pinnedSchemaId);
        resolvedSchemaId =
          edge.pinnedSchemaId !== undefined && pinnedRow !== null ? edge.pinnedSchemaId : undefined;
      } else {
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const head = await resolveSourceHead(ctx, edge.sourceDatasetId);
        resolvedSchemaId = head === undefined ? undefined : head.schemaId;
      }
      resolutions.push({ anchorId: edge.sourceDatasetId, mode: edge.mode, resolvedSchemaId });
    }
    return resolutions;
  },
  returns: v.array(
    v.object({
      anchorId: v.string(),
      mode: v.union(v.literal("float"), v.literal("pin")),
      resolvedSchemaId: v.optional(v.string()),
    }),
  ),
});

/** The light component read `layerResolutions` needs (the consumption.ts twin). */
async function tryGetSchemaOrNull(
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
// Mutations: the press's four legs (the client orchestrator drives them)
// ---------------------------------------------------------------------------

/**
 * A run is only alive while its press is running — terminal runs never reopen
 * (a re-press is a NEW run). Since stage 8 (#104) this is also the press-leg
 * ownership guard: every leg mutation (recordMember/promoteCollection/
 * linkMapLayers/completeRun) funnels through here, and only the run
 * project's creator passes — a foreign or gone run reads as "no longer
 * exists", never disclosing which.
 */
async function runningRun(ctx: MutationCtx, actorId: string, runId: Id<"bundleRuns">) {
  const runRow = await ctx.db.get(runId);
  const project = runRow === null ? null : await ctx.db.get(runRow.projectId);
  if (runRow === null || project === null || project.createdBy !== actorId) {
    throw new ConvexError("This bundle run no longer exists.");
  }
  if (runRow.status !== "running") {
    throw new ConvexError(
      `This bundle run is ${runRow.status} — press publish again to start a new one.`,
    );
  }
  return runRow;
}

function projectIdFor(ctx: { db: MutationCtx["db"] }, projectId: string): Id<"projects"> | null {
  return ctx.db.normalizeId("projects", projectId);
}

/**
 * Starts (or joins) this project's active press: creates the run row and its
 * member rows from the closure walk, in WRITE order. A run already running is
 * JOINED (the syncRuns/publish.start pattern — the client-driven revival is
 * just the progress touch); a completed or failed run is never reopened, a
 * re-press starts fresh (the recorded republish semantics). Creator-only
 * since stage 8 (#104): the press writes through `projectForWrite`'s
 * ownership check, and a non-creator gets the same "no longer exists"
 * answer a missing project gives.
 */
export const start = mutation({
  args: { projectId: v.string() },
  // oxlint-disable-next-line eslint/complexity -- the join/revive branch, the empty refusal, and the collection carry-over are one honest sequence; splitting them would separate the guards from what they protect.
  handler: async (ctx, args) => {
    const createdBy = await auth(ctx);
    const projectId = projectIdFor(ctx, args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    // Stage 8: existence AND ownership in one guard — the press belongs to
    // the project's creator (decision D1).
    const project = await projectForWrite(ctx, createdBy, projectId);
    const latest = await ctx.db
      .query("bundleRuns")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .first();
    if (latest !== null && latest.status === "running") {
      await ctx.db.patch(latest._id, { lastProgressAt: Date.now() });
      return { joined: true, runId: latest._id };
    }
    const { members } = bundleClosure(await collectClosureInput(ctx, projectId, createdBy));
    if (members.length === 0) {
      // The server-side gate behind the workspace's disabled control: an
      // empty press would mint an empty promoted collection and nothing else.
      throw new ConvexError(
        "Nothing to publish yet — add a dataset or a map with layers to this project first.",
      );
    }
    const runId = await ctx.db.insert("bundleRuns", {
      createdBy,
      // The promoted collection is created ONCE and REUSED across presses
      // (the recorded invariant) — carry the prior press's collection so
      // promoteCollection refills it instead of minting a same-named twin.
      // promoteCollection still re-verifies existence and re-creates when it
      // was actually deleted.
      collectionId: latest === null ? undefined : latest.collectionId,
      lastProgressAt: Date.now(),
      projectDescription: project.description,
      projectId,
      startedAt: Date.now(),
      status: "running",
      title: project.title,
    });
    for (const member of members) {
      // oxlint-disable-next-line no-await-in-loop -- one member row per plan entry, in the canonical write order.
      await ctx.db.insert("bundleRunMembers", {
        datasetKey: member.datasetKey,
        groupId: member.groupId,
        kind: member.kind,
        layerTargets: member.kind === "map" ? member.layerTargets : undefined,
        publish: member.publish,
        runId,
        status: member.kind === "dataset" && !member.publish ? "referenced" : "pending",
      });
    }
    return { joined: false, runId };
  },
  returns: v.object({ joined: v.boolean(), runId: v.id("bundleRuns") }),
});

/** The member row a checkpoint names, or the friendly gone-error. */
async function memberForWrite(
  ctx: MutationCtx,
  args: { datasetKey: string; runId: Id<"bundleRuns"> },
) {
  const members = await ctx.db
    .query("bundleRunMembers")
    .withIndex("by_run", (q) => q.eq("runId", args.runId))
    .collect();
  const member = members.find((row) => row.datasetKey === args.datasetKey);
  if (member === undefined) {
    throw new ConvexError("That id is not a member of this bundle run.");
  }
  return member;
}

/**
 * Checkpoints one member's outcome (the client orchestrator's only write
 * into the run): "publishing" when its attempt starts, "published" with the
 * frozen row id once `publishDataset` returns, "failed" with the error.
 * Per-member atomicity is the attempt's; this row only records what the
 * press already knows — a killed browser resumes from exactly these rows.
 */
export const recordMember = mutation({
  args: {
    attemptId: v.optional(v.string()),
    datasetKey: v.string(),
    error: v.optional(v.string()),
    publishedSchemaId: v.optional(v.string()),
    runId: v.id("bundleRuns"),
    status: memberStatusValidator,
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    await runningRun(ctx, actorId, args.runId);
    const member = await memberForWrite(ctx, args);
    await ctx.db.patch(member._id, {
      attemptId: args.attemptId,
      error: args.error,
      publishedSchemaId: args.publishedSchemaId,
      status: args.status,
    });
    await ctx.db.patch(args.runId, { lastProgressAt: Date.now() });
    return null;
  },
  returns: v.null(),
});

/** Files one member's row into the promoted collection: the frozen row it produced, or — for a referenced member — itself. A member that never froze files nothing. */
async function fileMemberIntoCollection(
  ctx: MutationCtx,
  args: {
    collectionId: string;
    member: {
      datasetKey: string;
      groupId?: string;
      kind: "dataset" | "derived" | "map";
      publishedSchemaId?: string;
      status: string;
    };
  },
): Promise<void> {
  if (args.member.kind === "map") {
    return;
  }
  const rowId =
    args.member.publishedSchemaId ??
    (args.member.status === "referenced" ? args.member.datasetKey : undefined);
  if (rowId === undefined) {
    return;
  }
  await ctx.runMutation(components.jsonCms.lib.addSchemaToCollection, {
    collectionId: args.collectionId,
    schemaId: rowId,
  });
  if (args.member.groupId !== undefined && args.member.publishedSchemaId !== undefined) {
    // The frozen row joins its draft's group, so group layers keep rendering
    // (organization writes are allowed on lineage rows).
    await ctx.runMutation(components.jsonCms.lib.setSchemaGroup, {
      groupId: args.member.groupId,
      schemaId: rowId,
    });
  }
}

/**
 * The collection leg: create the project's promoted collection once (reuse
 * it forever after — the bundle role is behavioral, the component row gains
 * nothing), file every member's row into it (a member that published this
 * press files its frozen row; a referenced member files itself), and attach
 * each newly frozen row to its draft's group so group layers keep rendering.
 * Idempotent per (collection, dataset) pair — the component's own guard.
 */
export const promoteCollection = mutation({
  args: { runId: v.id("bundleRuns") },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const runRow = await runningRun(ctx, actorId, args.runId);
    let collectionId = runRow.collectionId;
    if (collectionId !== undefined && (await tryGetCollection(ctx, collectionId)) === null) {
      // The collection was deleted out from under the project — re-create it.
      collectionId = undefined;
    }
    if (collectionId === undefined) {
      collectionId = await ctx.runMutation(components.jsonCms.lib.createCollection, {
        description: runRow.projectDescription,
        name: runRow.title,
      });
      await ctx.db.patch(runRow._id, { collectionId });
    }
    const members = await ctx.db
      .query("bundleRunMembers")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    for (const member of members) {
      // oxlint-disable-next-line no-await-in-loop -- one membership write per member, in press order.
      await fileMemberIntoCollection(ctx, { collectionId, member });
    }
    await ctx.db.patch(runRow._id, { lastProgressAt: Date.now() });
    return collectionId;
  },
  returns: v.string(),
});

/**
 * The map leg: reconcile each member map's dataset-layer reference edges with
 * the map's CURRENT layers — one float `consumerReferences` row (consumerKind
 * "map") per direct dataset-layer target, edges for layers removed since the
 * press started (or since an earlier press) DELETED. Maps themselves are
 * already promoted: their rows and layer structure persist untouched; this
 * leg is only the version-reference edges, kept true to the live layer list
 * so the consumed-by projection and the layer resolutions never name a layer
 * the map no longer has.
 */
export const linkMapLayers = mutation({
  args: { runId: v.id("bundleRuns") },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const runRow = await runningRun(ctx, actorId, args.runId);
    const members = await ctx.db
      .query("bundleRunMembers")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    for (const member of members) {
      if (member.kind !== "map") {
        continue;
      }
      // The CURRENT layer list, not the press-time snapshot: a layer removed
      // between `start` and this leg must not gain an edge, and an edge whose
      // layer is gone must not survive the leg.
      // oxlint-disable-next-line no-await-in-loop -- one layers read + one edge scan per map member, bounded by the run's member count.
      const [layers, existing] = await Promise.all([
        ctx.runQuery(components.jsonCms.lib.listMapLayers, { mapId: member.datasetKey }),
        ctx.db
          .query("consumerReferences")
          .withIndex("by_consumer", (q) => q.eq("consumerId", member.datasetKey))
          .collect(),
      ]);
      const currentTargets = new Set(
        layers.filter((layer) => layer.targetType === "dataset").map((layer) => layer.targetId),
      );
      for (const edge of existing) {
        if (edge.consumerKind === "map" && !currentTargets.has(edge.sourceDatasetId)) {
          // oxlint-disable-next-line no-await-in-loop -- one stale-edge delete per edge, bounded.
          await ctx.db.delete(edge._id);
        }
      }
      for (const target of currentTargets) {
        if (
          existing.some((edge) => edge.consumerKind === "map" && edge.sourceDatasetId === target)
        ) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- one edge per target, in layer order.
        await ctx.db.insert("consumerReferences", {
          consumerId: member.datasetKey,
          consumerKind: "map",
          mode: "float",
          sourceDatasetId: target,
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- one status patch per map member, in press order.
      await ctx.db.patch(member._id, { status: "linked" });
    }
    await ctx.db.patch(runRow._id, { lastProgressAt: Date.now() });
    return null;
  },
  returns: v.null(),
});

/**
 * Closes the press: "completed" when every member reached a terminal state,
 * "failed" when any member failed — completed members KEEP their frozen rows
 * (append-only; per-member teardown stays publish.ts's half-built-row sweep
 * alone) and a re-press retries only what a fresh closure includes.
 */
export const completeRun = mutation({
  args: { runId: v.id("bundleRuns") },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    const runRow = await runningRun(ctx, actorId, args.runId);
    const members = await ctx.db
      .query("bundleRunMembers")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    const failed = members.filter((member) => member.status === "failed").length;
    const status = failed > 0 ? ("failed" as const) : ("completed" as const);
    await ctx.db.patch(runRow._id, {
      error:
        failed > 0
          ? `${failed} of ${members.length} members failed — completed members keep their published versions; press again to retry.`
          : undefined,
      finishedAt: Date.now(),
      lastProgressAt: Date.now(),
      status,
    });
    return { collectionId: runRow.collectionId, status };
  },
  returns: v.object({
    collectionId: v.optional(v.string()),
    status: v.union(v.literal("completed"), v.literal("failed")),
  }),
});
