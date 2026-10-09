import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { assertDatasetWritable, auth } from "./auth";
import { projectRoleFor, roleAtLeast } from "./projectAccess";
import { projectForRead as projectsProjectForRead, projectForWrite } from "./projects";
import { CATALOG_READ_LIMIT } from "./schemas";

/**
 * Bundle publish and fork (roadmap 7b, #103; lifecycle doc §2/§5-§6, ADR
 * 0008): one project presses once and produces exactly one bundle — the
 * collection (promoted) and the project's members frozen as versions through
 * the EXISTING 5b state machine (`api.publish.*` — deliberately never
 * forked).
 *
 * The act has three legs, in WRITE order:
 *
 * 1. **The closure walk** (the pure `bundleClosure` core below, resolved by
 *    `collectClosureInput`): every project membership — datasets and saved
 *    derived rows — deduped by id ("datasets referenced multiple times
 *    publish once"). (Phase 3 of the project-workspace design, ADR 0012,
 *    retired the map leg with the standalone maps: a map no longer drags its
 *    layer datasets into the press — datasets join a project as MEMBERS, and
 *    layers/maps join the closure in phase 5.) Derived members' own sources
 *    stay OUT of the closure (exposure decoupled, lifecycle §2): they
 *    surface only as the lineage the 5b freeze records. The collection's
 *    files are member rows of a `bundleRuns` press (schema.ts) — the
 *    bundle-level checkpoint that makes one-press resume exact.
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
 *
 * Recorded decisions (the issue's open items):
 * - **Republish: a re-press re-promotes every member** (new attempts, vN+1,
 *   append-only) — no per-dataset change signal exists to do
 *   changed-inputs-only honestly; keep-N retention bounds the chains. See
 *   the `bundleRuns` table doc.
 * - **Exposure defaults:** import sources are exposed by inclusion; derived
 *   sources stay private with lineage-only provenance. No per-artifact
 *   "expose source?" toggle ships here — adding the source to the project
 *   puts it in the next press.
 * - **Derived members publish in topological order** (by the registry rows'
 *   `dependsOn`): a fork-of-fork pair publishes its source first, so the
 *   fork's freeze records the source's FRESH head in lineage — provenance
 *   matches the rows the client actually computed over.
 *
 * Stage 8 (#104), amended by phase 1 of the project-workspace design (ADR
 * 0011): the press answers to the project's ROLE, not one creator — `start`
 * and every leg mutation (via `runningRun`) write through
 * `projects.projectForWrite`'s editor-and-up check, a viewer or outsider's
 * runId reads as "no longer exists". Reads stay member-scoped: the
 * project-scoped ones (`plan`, `run`, `latestForProject`) answer like
 * `projects.get`. (The old `layerResolutions` read — the only signed-in-
 * viewer surface — went with the map leg.)
 */

// ---------------------------------------------------------------------------
// The pure closure core — Convex-free, unit-tested with stand-ins
// (derivedSpec.ts's pattern).
// ---------------------------------------------------------------------------

/** A project membership as the closure walk sees it. */
export interface BundleMembershipLike {
  artifactId: string;
  artifactKind: "dataset" | "derived";
}

/** Everything the walk resolves, host-side from component reads. */
export interface BundleClosureInput {
  /** Dataset id → its group (both summary lists merged — drafts included). */
  groupIdByDataset: ReadonlyMap<string, string>;
  /** Dataset id → "draft" | "published" (absent = unknown/deleted → dropped). */
  lifecycleByDataset: ReadonlyMap<string, "draft" | "published">;
  /** The project's membership rows. */
  memberships: ReadonlyArray<BundleMembershipLike>;
  /** Saved registry row id → its persisted `dependsOn` edges — the derived members' topological order. */
  dependsOnByRegistry?: ReadonlyMap<string, readonly string[]>;
  /** Registry row ids whose status is "saved" (publishable; autosaves and deleted rows are out). */
  savedRegistryIds: ReadonlySet<string>;
}

/** One planned member of one press. */
export interface BundleMemberPlan {
  datasetKey: string;
  /** Dataset members: the draft's group, re-attached to the frozen row at the collection leg. */
  groupId?: string;
  kind: "dataset" | "derived";
  /** False for already-published dataset members (membership only, never a new version). */
  publish: boolean;
}

export interface BundleClosureResult {
  /** References the plan had to leave out, with why (deleted artifact, builder autosave). */
  dropped: Array<{ id: string; reason: string }>;
  /** Canonical WRITE order: datasets, then derived (topological — sources before the forks over them). */
  members: BundleMemberPlan[];
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
 * The bundle closure: the collection's datasets are the project's dataset
 * memberships, deduped by id. A draft publishes (v1, or vN+1 on a re-press)
 * when the project HOLDS it; an already-published dataset is a member only;
 * a saved transform publishes through the derived half of the 5b machine.
 * (Phase 3 of the project-workspace design, ADR 0012, retired the map walk
 * with the standalone maps — the closure is exactly the memberships, plus
 * the derived members' topological order.)
 */
export function bundleClosure(input: BundleClosureInput): BundleClosureResult {
  const datasetMembers = new Map<string, BundleMemberPlan>(),
    derivedMembers: string[] = [],
    dropped: Array<{ id: string; reason: string }> = [];

  const addDataset = (id: string): void => {
    if (datasetMembers.has(id)) {
      return;
    }
    const lifecycle = input.lifecycleByDataset.get(id);
    if (lifecycle === undefined) {
      dropped.push({ id, reason: "The dataset no longer exists." });
      return;
    }
    if (lifecycle === "draft") {
      datasetMembers.set(id, {
        datasetKey: id,
        groupId: input.groupIdByDataset.get(id),
        kind: "dataset",
        publish: true,
      });
      return;
    }
    // Already published: joins the bundle as a member only — no new version.
    datasetMembers.set(id, {
      datasetKey: id,
      kind: "dataset",
      publish: false,
    });
  };

  const addDerived = (id: string): void => {
    if (derivedMembers.includes(id)) {
      return;
    }
    if (!input.savedRegistryIds.has(id)) {
      dropped.push({
        id,
        reason: "Not a saved transform (deleted, or a builder autosave — save it first).",
      });
      return;
    }
    derivedMembers.push(id);
  };

  for (const membership of input.memberships) {
    if (membership.artifactKind === "dataset") {
      addDataset(membership.artifactId);
    } else {
      addDerived(membership.artifactId);
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
          publish: true,
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Host-side closure resolution: component reads → the pure core's input
// ---------------------------------------------------------------------------

/** Upper bound on the membership read — the walk stays bounded like every host enumeration. */
const MAX_MEMBERS = 1000;
/** Failed members reported per latestForProject read — the detail list is bounded like every read; the count stays exact. */
const MAX_REPORTED_FAILURES = 20;

/**
 * One component read that tolerates a stored id that isn't well-formed (the
 * publish.ts/projects.ts precedent — "not a collection" keeps the collection
 * leg total).
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

/**
 * Resolves everything the pure closure core reads, from the project's
 * membership rows plus light component reads: the identity-scoped summaries
 * pair `projects.get` pays (the pre-pass), plus the raw membership rows,
 * which include the drafts those consumer reads filter out, and the groups
 * list (the draft's group re-attach at the collection leg). Phase 1 of the
 * project-workspace design (ADR 0011): the identity-scoped pair can never
 * return one member another member's draft, so the pass below resolves the
 * REST of this project's dataset memberships by id through the host-flow
 * by-ids read — the closure is complete over every project-held row,
 * whatever member created it (the role guard every caller runs is what
 * authorizes the payload). `viewerId` only seeds the pre-pass, so `plan` and
 * `start` pass the same identity (the project's creator) and can never
 * disagree about what a press would do. The registry reads also capture each
 * saved row's `dependsOn` edges, so derived members can be ordered
 * sources-before-forks.
 */
async function collectClosureInput(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  viewerId: string,
): Promise<BundleClosureInput> {
  const memberships = await ctx.db
    .query("projectArtifacts")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(MAX_MEMBERS);
  const [summaries, drafts] = await Promise.all([
    ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, {
      limit: CATALOG_READ_LIMIT,
      viewerId,
    }),
    ctx.runQuery(components.jsonCms.lib.listDraftSchemaSummaries, {
      limit: CATALOG_READ_LIMIT,
      viewerId,
    }),
  ]);
  // The member-held rows the identity-scoped pair can never return: resolved
  // by id from THIS project's membership rows only. Junk ids (a membership
  // row can name any string) simply come back absent — the walk answers "no
  // longer exists", exactly as for a deleted artifact. The slice is the
  // component read's id cap (500); past it — never reached at project scale —
  // the walk drops the remainder, the same display-bound behavior the
  // workspace read documents.
  const resolvedIds = new Set([...summaries, ...drafts].map((row) => row._id));
  const unresolved = memberships
    .filter((membership) => membership.artifactKind === "dataset")
    .map((membership) => membership.artifactId)
    .filter((artifactId) => !resolvedIds.has(artifactId))
    .slice(0, 500);
  const memberDrafts =
    unresolved.length === 0
      ? []
      : await ctx.runQuery(components.jsonCms.lib.getSchemaSummaries, {
          schemaIds: unresolved,
        });

  const lifecycleByDataset = new Map<string, "draft" | "published">(),
    groupIdByDataset = new Map<string, string>();
  for (const row of [...summaries, ...drafts, ...memberDrafts]) {
    lifecycleByDataset.set(row._id, row.lifecycle === "draft" ? "draft" : "published");
    if (row.groupId !== undefined) {
      groupIdByDataset.set(row._id, row.groupId);
    }
  }

  const savedRegistryIds = new Set<string>(),
    dependsOnByRegistry = new Map<string, string[]>();
  for (const membership of memberships) {
    if (membership.artifactKind !== "derived") {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one registry read per derived membership, bounded by membership count.
    const registryId = ctx.db.normalizeId("derivedDatasets", membership.artifactId);
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const row = registryId === null ? null : await ctx.db.get(registryId);
    if (row !== null && row.status === "saved") {
      savedRegistryIds.add(membership.artifactId);
      dependsOnByRegistry.set(membership.artifactId, row.dependsOn);
    }
  }

  // Phase 2 of the project-workspace design added the "layer" kind; the
  // layers entity landed in phase 3 and its press story is phase 5, so a
  // layer membership is not a bundle member today and never enters the
  // closure input. The "map" kind is retired with the standalone maps.
  return {
    dependsOnByRegistry,
    groupIdByDataset,
    lifecycleByDataset,
    memberships: memberships
      .filter(
        (row): row is typeof row & { artifactKind: "dataset" | "derived" } =>
          row.artifactKind !== "layer",
      )
      .map((row) => ({
        artifactId: row.artifactId,
        artifactKind: row.artifactKind,
      })),
    savedRegistryIds,
  };
}

// ---------------------------------------------------------------------------
// Queries: the plan preview, the run progress, the project's published link
// ---------------------------------------------------------------------------

const memberPlanValidator = v.object({
  datasetKey: v.string(),
  groupId: v.optional(v.string()),
  kind: v.union(v.literal("dataset"), v.literal("derived")),
  publish: v.boolean(),
});

/** The project row a project-scoped read answers for, or null when it doesn't exist or the caller holds no role in it — the `projects.get` scoping (ADR 0011: any member, viewer included), since the plan names drafts. */
async function projectForRead(
  ctx: { auth: QueryCtx["auth"]; db: QueryCtx["db"] },
  projectId: string,
): Promise<Doc<"projects"> | null> {
  const viewer = await auth(ctx),
    projectId_ = ctx.db.normalizeId("projects", projectId);
  if (projectId_ === null) {
    return null;
  }
  return projectsProjectForRead(ctx, viewer, projectId_);
}

/**
 * What one press of this project WOULD do — the press's preview and the
 * tests' plan assertion. null when the project doesn't exist or the caller
 * holds no role in it (member-scoped: the plan names the project's drafts,
 * ADR 0011).
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
  v.literal("failed"),
);

const runMemberValidator = v.object({
  attemptId: v.optional(v.string()),
  datasetKey: v.string(),
  error: v.optional(v.string()),
  groupId: v.optional(v.string()),
  kind: v.union(v.literal("dataset"), v.literal("derived")),
  publishedSchemaId: v.optional(v.string()),
  publish: v.boolean(),
  status: memberStatusValidator,
});

/** One press's progress: the run row plus every member row, in press order. Member-scoped like the rest of the project surface (ADR 0011 — the run's project answers to any of its members; member rows name drafts, but a member may see the project's drafts by design). */
export const run = query({
  args: { runId: v.id("bundleRuns") },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx);
    const runRow = await ctx.db.get(args.runId);
    if (runRow === null) {
      return null;
    }
    const project = await ctx.db.get(runRow.projectId);
    if (project === null || (await projectRoleFor(ctx, project._id, viewer)) === null) {
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

// ---------------------------------------------------------------------------
// Mutations: the press's legs (the client orchestrator drives them)
// ---------------------------------------------------------------------------

/**
 * A run is only alive while its press is running — terminal runs never reopen
 * (a re-press is a NEW run). Since stage 8 (#104) this is also the press-leg
 * ownership guard: every leg mutation (recordMember/promoteCollection/
 * completeRun) funnels through here, and only the run project's editor-and-up
 * passes — a foreign or gone run reads as "no longer exists", never
 * disclosing which.
 */
async function runningRun(ctx: MutationCtx, actorId: string, runId: Id<"bundleRuns">) {
  const runRow = await ctx.db.get(runId);
  const project = runRow === null ? null : await ctx.db.get(runRow.projectId);
  if (runRow === null || project === null) {
    throw new ConvexError("This bundle run no longer exists.");
  }
  // The press writes ride the project's ROLE guard (ADR 0011): editor-and-up
  // may press and checkpoint, a viewer or outsider gets the same
  // "no longer exists" answer a missing project gives (an existence leak
  // through a write the caller could never see).
  const role = await projectRoleFor(ctx, runRow.projectId, actorId);
  if (role === null || !roleAtLeast(role, "editor")) {
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
 * re-press starts fresh (the recorded republish semantics). Role-guarded
 * since phase 1 (ADR 0011): the press writes through `projectForWrite`'s
 * editor-and-up check — any member who may write the project's content may
 * press it — and a viewer or outsider gets the same "no longer exists"
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
    // Phase 1 (ADR 0011): existence AND role in one guard — the press
    // belongs to the project's editors and owners.
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
    // The closure walks with the PROJECT CREATOR as the component pre-pass's
    // viewerId — the same identity `plan` uses, so an editor's press and the
    // preview it pressed from can never disagree. The pre-pass identity no
    // longer bounds the plan: collectClosureInput resolves every
    // project-held row by id past it (ADR 0011), whatever member created it.
    const { members } = bundleClosure(await collectClosureInput(ctx, projectId, project.createdBy));
    if (members.length === 0) {
      // The server-side gate behind the workspace's disabled control: an
      // empty press would mint an empty promoted collection and nothing else.
      throw new ConvexError(
        "Nothing to publish yet — add a dataset or a transform to this project first.",
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
 *
 * The client-supplied `publishedSchemaId` is the one place a press accepts a
 * component row id from the browser (issue #124): a LOCKED dataset answers
 * only to its creator, so recording it as this run's outcome is refused —
 * otherwise a run creator could file someone else's locked row into their
 * promoted collection at the collection leg. Ordinary (open) rows keep
 * today's accepted flow unchanged.
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
    if (args.publishedSchemaId !== undefined) {
      await assertDatasetWritable(ctx, actorId, args.publishedSchemaId);
    }
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

/** Files one member's row into the promoted collection: the frozen row it produced, or — for a referenced member — itself. A member that never froze files nothing. The edit-policy gate (issue #124) runs on the row being filed: a referenced LOCKED dataset (someone else's locked row that entered the plan as an already-published member) refuses to be filed by a foreign press, while open rows keep today's shared-catalog flow. */
async function fileMemberIntoCollection(
  ctx: MutationCtx,
  args: {
    actorId: string;
    collectionId: string;
    member: {
      datasetKey: string;
      groupId?: string;
      kind: "dataset" | "derived";
      publishedSchemaId?: string;
      status: string;
    };
  },
): Promise<void> {
  const rowId =
    args.member.publishedSchemaId ??
    (args.member.status === "referenced" ? args.member.datasetKey : undefined);
  if (rowId === undefined) {
    return;
  }
  await assertDatasetWritable(ctx, args.actorId, rowId);
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
      await fileMemberIntoCollection(ctx, { actorId, collectionId, member });
    }
    await ctx.db.patch(runRow._id, { lastProgressAt: Date.now() });
    return collectionId;
  },
  returns: v.string(),
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
