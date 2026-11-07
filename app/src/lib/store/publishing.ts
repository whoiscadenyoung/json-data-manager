import type { SupabaseClient } from "@supabase/supabase-js";
import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, queryScalar, type StoreOptions } from "./client";
import { VERSIONS_READ_LIMIT } from "./versions";
import type { VisibilityLevel } from "./visibility";

/**
 * The publishing store (design doc §8.1 "publishing.ts # publish_version
 * orchestration + bundles"; stage 4, issue #203) — the PG counterpart of the
 * Convex `api.publishing.*` domain: the §5.4 publish RPC and the bundle
 * press over `public.publish_bundles` + `public.publish_bundle_members`
 * (DDL §3.5, migration 0009).
 *
 * Parity notes (each traces to `app/convex/publishing/`):
 *   - `publishDataset` is one `publish_version` call: the RPC is the freeze
 *     (idempotent on publish_key; set-based materialization; retention in
 *     the same transaction). The Convex 5b chunk pipeline collapses — PG
 *     materializes from the LIVE rows (§3.5), not client-uploaded chunks,
 *     so the attempt machinery shrinks to the member rows' `attempt_id` +
 *     the RPC's atomicity (the issue's recorded collapse).
 *   - The press is CLIENT-orchestrated exactly like the Convex one
 *     (bundles.ts): `startBundle` mints the bundle + member rows in the
 *     canonical order (datasets, then derived, then maps — the order the
 *     publish legs must run in, bundles.ts:204-212); a running bundle is
 *     JOINED, never forked (start's join-or-revive); `recordMember`
 *     checkpoints each member; the promoted collection is created once and
 *     REUSED across presses; `completeRun` closes completed/failed with
 *     completed members keeping their frozen rows (append-only).
 *   - Per-member status machine: pending → publishing → published
 *     (publishable members); already-published members are born
 *     "referenced"; map members go pending → linked; failed leaves the run
 *     partial.
 *   - Attempt-chain reads filter to members whose frozen row SURVIVES —
 *     `status === "published"` AND `published_version_id` still resolves
 *     (existence, not markers — the #126 self-healing rule,
 *     retire-version-pin-refusal memory). `survivingMembers` is that
 *     filter, pure and unit-tested.
 *
 * Every write helper returns the rows it affected (the stage-4
 * silent-denial rule): RLS-filtered writes answer 0 rows instead of
 * throwing, and the UI surfaces denials honestly.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL/RPC
 * signatures, not the generated `database.types.ts` (see `./client`).
 */

/** One bundle press row (the `publish_bundles` row — component bundleRuns). */
export interface PublishBundleRow {
  id: string;
  projectId: string;
  /** The project's title at press time — the promoted collection's name. */
  title: string;
  projectDescription: string | null;
  /** The promoted collection — created once, reused across presses. */
  collectionId: string | null;
  status: "running" | "completed" | "failed";
  error: string | null;
  /** The press's target visibility rung (#260, ADR 0022). */
  visibility: VisibilityLevel;
  createdBy: string;
  startedAt: string;
  finishedAt: string | null;
  lastProgressAt: string;
}

/** One member of one press (the `publish_bundle_members` row — bundleRunMembers). */
export interface BundleMemberRow {
  id: string;
  bundleId: string;
  kind: "dataset" | "derived" | "map";
  /** The member artifact's id (a dataset, a derived registry row, or a map — the text id space). */
  datasetKey: string;
  /** The draft's group, so the frozen row joins it at the collection leg. */
  groupId: string | null;
  /** False for already-published members — they join as members only, no new version. */
  publish: boolean;
  status: BundleMemberStatus;
  publishedVersionId: string | null;
  attemptId: string | null;
  /** Map members: the DATASET-layer target ids the press mints map references for. */
  layerTargets: string[] | null;
  /** The promotion plan's from/to for this member (null = the press promoted nothing here). */
  visibilityFrom: VisibilityLevel | null;
  visibilityTo: VisibilityLevel | null;
  error: string | null;
}

export type BundleMemberStatus =
  | "pending"
  | "publishing"
  | "published"
  | "referenced"
  | "linked"
  | "failed";

/** Every member status, in machine order (the status check's literals). */
export const BUNDLE_MEMBER_STATUSES: ReadonlyArray<BundleMemberStatus> = [
  "pending",
  "publishing",
  "published",
  "referenced",
  "linked",
  "failed",
];

/** The canonical member write order of a press (bundles.ts:210-212): datasets, then derived, then maps. */
export function memberOrder(kind: "dataset" | "derived" | "map"): number {
  if (kind === "dataset") {
    return 0;
  }
  return kind === "derived" ? 1 : 2;
}

/**
 * The attempt-chain survival filter (#126, existence not markers): only
 * completed members whose frozen row still resolves count — retired or
 * retention-deleted versions orphan their members, and those read as
 * absent instead of crashing the feed (the self-healing rule).
 */
export function survivingMembers(
  members: ReadonlyArray<BundleMemberRow>,
): Array<BundleMemberRow & { status: "published" }> {
  const alive: Array<BundleMemberRow & { status: "published" }> = [];
  for (const member of members) {
    if (member.status !== "published" || member.publishedVersionId === null) {
      continue;
    }
    // The row id is a bare uuid; truthiness by null check, never by the
    // string's content — existence is the database's answer, resolved
    // through the version reads the caller joins.
    alive.push({ ...member, status: "published" });
  }
  return alive;
}

const BUNDLE_SELECT =
  "id,projectId:project_id,title,projectDescription:project_description,collectionId:collection_id,status,error,visibility,createdBy:created_by,startedAt:started_at,finishedAt:finished_at,lastProgressAt:last_progress_at";
const MEMBER_SELECT =
  "id,bundleId:bundle_id,kind,datasetKey:dataset_key,groupId:group_id,publish,status,publishedVersionId:published_version_id,attemptId:attempt_id,layerTargets:layer_targets,visibilityFrom:visibility_from,visibilityTo:visibility_to,error";

// ---------------------------------------------------------------------------
// Publish (§5.4)
// ---------------------------------------------------------------------------

/** The {@link publishDataset} argument set — the §5.4 RPC's parameters. */
export interface PublishDatasetArgs {
  datasetId: string;
  versionLabel: string;
  /** The idempotency key — a retried/killed publish cannot fork two v1s. */
  publishKey: string;
  /** lineageValidator-shape jsonb (recipe + sourceVersions); absent = the narrow draft shape the RPC stamps. */
  lineage?: unknown;
}

/**
 * Publishes one frozen version (`publish_version`, §5.4): materializes the
 * dataset's live rows into `version_entries`, returns the new version's id.
 * Idempotent on publish_key — the SAME key answers the EXISTING version
 * (the freeze short-circuit), so a double-submit converges on one v1.
 * Throws the RPC's gate error when the dataset is not writable by the
 * caller (locked = creator only, frozen = nobody).
 */
export async function publishDataset(
  args: PublishDatasetArgs,
  options?: StoreOptions,
): Promise<string> {
  const versionId = await queryScalar<string>(
    clientOf(options).rpc("publish_version", {
      p_dataset: args.datasetId,
      p_lineage: args.lineage ?? null,
      p_publish_key: args.publishKey,
      p_version_label: args.versionLabel,
    }),
  );
  if (typeof versionId !== "string") {
    throw new Error("publish_version returned no version id.");
  }
  return versionId;
}

// ---------------------------------------------------------------------------
// Reads (TanStack Query options)
// ---------------------------------------------------------------------------

/** One project's presses, newest first. */
export function listBundlesQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:publishing", "listBundles", args],
    queryFn: async () =>
      await queryRows<PublishBundleRow>(
        clientOf(options)
          .from("publish_bundles")
          .select(BUNDLE_SELECT)
          .eq("project_id", args.projectId)
          .order("started_at", { ascending: false })
          .limit(VERSIONS_READ_LIMIT),
      ),
  });
}

/** The project's LATEST press (the join-or-revive read). */
export function latestBundleQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:publishing", "latestBundle", args],
    queryFn: async () =>
      await queryRow<PublishBundleRow>(
        clientOf(options)
          .from("publish_bundles")
          .select(BUNDLE_SELECT)
          .eq("project_id", args.projectId)
          .order("started_at", { ascending: false })
          .limit(1),
      ),
  });
}

/** One press's members, in the canonical order they were minted (the by_bundle scan IS the order). */
export function listMembersQueryOptions(args: { bundleId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:publishing", "listMembers", args],
    queryFn: async () =>
      await queryRows<BundleMemberRow>(
        clientOf(options)
          .from("publish_bundle_members")
          .select(MEMBER_SELECT)
          .eq("bundle_id", args.bundleId)
          .limit(VERSIONS_READ_LIMIT),
      ),
  });
}

// ---------------------------------------------------------------------------
// Writes — the press's client-side legs, each reporting rows affected
// ---------------------------------------------------------------------------

/** One member row to mint at press start (the bundleClosure output shape). */
export interface BundleMemberPlan {
  kind: "dataset" | "derived" | "map";
  datasetKey: string;
  groupId?: string;
  /** False for already-published dataset members (referenced, no new version). */
  publish: boolean;
  /** Map members: the dataset-layer target ids (press-time snapshot). */
  layerTargets?: string[];
  /** The confirmed promotion plan's from/to for this member (the preflight's rows, stamped at mint). */
  visibilityFrom?: VisibilityLevel;
  visibilityTo?: VisibilityLevel;
}

/** The {@link startBundle} argument set. */
export interface StartBundleArgs {
  projectId: string;
  /** The project's title/description at press time (the promoted collection's). */
  title: string;
  projectDescription?: string;
  /** The press's target visibility rung (#260) — stamped on the bundle row. */
  visibility?: VisibilityLevel;
  /** The prior press's collection id — REUSED across presses (the recorded invariant); omit on the first press. */
  collectionId?: string;
  /** The closure plan, already ordered datasets → derived → maps by the caller. */
  members: BundleMemberPlan[];
}

export interface StartBundleResult {
  bundleId: string;
  /** True when the press JOINED the project's still-running bundle (start's join-or-revive). */
  joined: boolean;
}

/**
 * Starts (or joins) one bundle press — the `bundles.start` parity. A
 * still-running latest bundle is JOINED (touched, returned); otherwise the
 * bundle row and its members are minted in the canonical order, with
 * already-published dataset members born "referenced" and everything else
 * "pending". Returns an error-shaped throw when the caller passes no
 * members (the server-side gate behind the workspace's disabled control —
 * an empty press would mint an empty promoted collection).
 */
export async function startBundle(
  args: StartBundleArgs,
  options?: StoreOptions,
): Promise<StartBundleResult> {
  const client = clientOf(options);
  const latest = await queryRow<PublishBundleRow>(
    client
      .from("publish_bundles")
      .select(BUNDLE_SELECT)
      .eq("project_id", args.projectId)
      .order("started_at", { ascending: false })
      .limit(1),
  );
  if (latest !== null && latest.status === "running") {
    await queryRows<{ id: string }>(
      client
        .from("publish_bundles")
        .update({ last_progress_at: new Date().toISOString() })
        .eq("id", latest.id)
        .select("id"),
    );
    return { bundleId: latest.id, joined: true };
  }
  if (args.members.length === 0) {
    throw new Error(
      "Nothing to publish yet — add a dataset or a map with layers to this project first.",
    );
  }
  const bundle = await queryRow<{ id: string }>(
    client
      .from("publish_bundles")
      .insert({
        collection_id: args.collectionId ?? null,
        project_description: args.projectDescription ?? null,
        project_id: args.projectId,
        title: args.title,
      })
      .select("id")
      .single(),
  );
  if (bundle === null) {
    throw new Error("Bundle insert returned no row.");
  }
  await mintBundleMembers(client, bundle.id, args.members);
  return { bundleId: bundle.id, joined: false };
}

/** The member row's initial status (the press's birth rule: referenced members skip pending). */
function initialStatusOf(member: BundleMemberPlan): BundleMemberStatus {
  if (member.kind === "dataset" && !member.publish) {
    return "referenced";
  }
  return "pending";
}

/**
 * Mints the member rows in the CANONICAL write order (datasets, then
 * derived, then maps — the order the publish legs must run in,
 * bundles.ts:204-212). Sequential on purpose: the by_bundle scan IS the
 * order, so parallel inserts would lose it.
 */
async function mintBundleMembers(
  client: SupabaseClient,
  bundleId: string,
  members: ReadonlyArray<BundleMemberPlan>,
): Promise<void> {
  const ordered = members.toSorted((a, b) => memberOrder(a.kind) - memberOrder(b.kind));
  for (const member of ordered) {
    // One member row per plan entry, in the canonical write order (the
    // ordered no-await-in-loop of the Convex start).
    // oxlint-disable-next-line eslint/no-await-in-loop -- the mint order IS the semantic (see above).
    await queryRows<{ id: string }>(
      client
        .from("publish_bundle_members")
        .insert({
          bundle_id: bundleId,
          dataset_key: member.datasetKey,
          group_id: member.groupId ?? null,
          kind: member.kind,
          layer_targets: member.layerTargets ?? null,
          publish: member.publish,
          status: initialStatusOf(member),
        })
        .select("id"),
    );
  }
}

/** The {@link recordMember} argument set — the client orchestrator's checkpoint. */
export interface RecordMemberArgs {
  bundleId: string;
  memberId: string;
  status?: BundleMemberStatus;
  /** The frozen version this member produced (the accept-a-component-row-id rule rides RLS: bundles are creator-only). */
  publishedVersionId?: string;
  attemptId?: string;
  error?: string;
}

/**
 * Checkpoints one member's outcome (the `recordMember` parity — the press's
 * only write into a member row): status, frozen version, attempt, error.
 * Also touches the bundle's `last_progress_at` (the run's liveness). Returns
 * the affected member-row count (0 = denied/gone — bundles are
 * creator-only, so a foreign press reads as not-found).
 */
export async function recordMember(
  args: RecordMemberArgs,
  options?: StoreOptions,
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (args.status !== undefined) {
    patch.status = args.status;
  }
  if (args.publishedVersionId !== undefined) {
    patch.published_version_id = args.publishedVersionId;
  }
  if (args.attemptId !== undefined) {
    patch.attempt_id = args.attemptId;
  }
  if (args.error !== undefined) {
    patch.error = args.error;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("recordMember needs at least one field to checkpoint.");
  }
  const client = clientOf(options);
  const rows = await queryRows<{ id: string }>(
    client
      .from("publish_bundle_members")
      .update(patch)
      .eq("id", args.memberId)
      .eq("bundle_id", args.bundleId)
      .select("id"),
  );
  if (rows.length > 0) {
    await queryRows<{ id: string }>(
      client
        .from("publish_bundles")
        .update({ last_progress_at: new Date().toISOString() })
        .eq("id", args.bundleId)
        .select("id"),
    );
  }
  return rows.length;
}

/**
 * Records the promoted collection's id on the press (the `promoteCollection`
 * parity — created once, reused across presses). Returns the affected row
 * count (0 = denied/gone).
 */
export async function setBundleCollection(
  args: { bundleId: string; collectionId: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("publish_bundles")
      .update({ collection_id: args.collectionId })
      .eq("id", args.bundleId)
      .select("id"),
  );
  return rows.length;
}

/**
 * Marks the map legs linked: mints ONE float consumer_reference per direct
 * dataset layer target (`consumer_kind: "map"`, consumer_id = the map id —
 * the layer reads' chain-resolution leg, bundles.linkMapLayers), reconciling
 * stale edges away.
 *
 * The CURRENT layer list is RE-READ here, at leg time — never the
 * press-time snapshot the plan carried (bundles.ts:1060-1123's recorded
 * rule): a layer removed between `start` and this leg must not gain an
 * edge, and an edge whose layer is gone must not survive the leg. A linked
 * member skipped by a resumed press re-walks here and self-heals.
 * Returns the affected member-row count (the "linked" stamps).
 */
export async function linkMapLayers(
  args: {
    bundleId: string;
    /** Per map member: the map id (its member row gets the "linked" stamp). */
    maps: Array<{ mapId: string; memberId: string }>;
  },
  options?: StoreOptions,
): Promise<number> {
  const client = clientOf(options);
  let linked = 0;
  for (const map of args.maps) {
    // The leg-time layer read (bundles.ts runs maps.listMapLayers in the
    // same position) — the snapshot the plan carried is never consulted.
    // oxlint-disable-next-line eslint/no-await-in-loop -- one layers read + one edge scan per map member, bounded by the run's member count (the linkMapLayers walk).
    const layerRows = await queryRows<{ targetId: string | null }>(
      client
        .from("map_layers")
        .select("targetId:target_id")
        .eq("map_id", map.mapId)
        .eq("target_type", "dataset")
        .limit(500),
    );
    const currentTargets = new Set(
      layerRows.flatMap((row) => (row.targetId === null ? [] : [row.targetId])),
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- one layers read + one edge scan per map member, bounded by the run's member count (the linkMapLayers walk).
    const existing = await queryRows<{
      consumerId: string;
      id: string;
      sourceDatasetId: string | null;
    }>(
      client
        .from("consumer_references")
        .select("id,consumerId:consumer_id,sourceDatasetId:source_dataset_id")
        .eq("consumer_id", map.mapId)
        .eq("consumer_kind", "map"),
    );
    for (const edge of existing) {
      const source = edge.sourceDatasetId;
      if (source !== null && !currentTargets.has(source)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one stale-edge delete per edge, ordered and bounded (the Convex walk).
        await queryRows<{ id: string }>(
          client.from("consumer_references").delete().eq("id", edge.id).select("id"),
        );
      }
    }
    const knownSources = new Set(
      existing.flatMap((edge) => (edge.sourceDatasetId === null ? [] : [edge.sourceDatasetId])),
    );
    for (const target of currentTargets) {
      if (knownSources.has(target)) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- one edge per target, in layer order (the Convex walk).
      await queryRows<{ id: string }>(
        client
          .from("consumer_references")
          .insert({
            consumer_id: map.mapId,
            consumer_kind: "map",
            mode: "float",
            source_dataset_id: target,
          })
          .select("id"),
      );
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- one status patch per map member, in press order (the Convex walk).
    const stamped = await queryRows<{ id: string }>(
      client
        .from("publish_bundle_members")
        .update({ status: "linked" })
        .eq("id", map.memberId)
        .eq("bundle_id", args.bundleId)
        .select("id"),
    );
    linked += stamped.length;
  }
  return linked;
}

/** The {@link completeBundle} result — the promoted collection + the closed status. */
export interface CompleteBundleResult {
  bundle: PublishBundleRow | null;
  affected: number;
}

/**
 * Closes the press (the `completeRun` parity): "completed" when every
 * member reached a terminal state, "failed" when any member failed —
 * completed members KEEP their frozen rows (append-only). Returns the
 * closed bundle row and the affected count (0 = denied/gone).
 */
export async function completeBundle(
  args: { bundleId: string },
  options?: StoreOptions,
): Promise<CompleteBundleResult> {
  const client = clientOf(options);
  const members = await queryRows<BundleMemberRow>(
    client.from("publish_bundle_members").select(MEMBER_SELECT).eq("bundle_id", args.bundleId),
  );
  const failed = members.filter((member) => member.status === "failed").length;
  const status = failed > 0 ? "failed" : "completed";
  const rows = await queryRows<PublishBundleRow>(
    client
      .from("publish_bundles")
      .update({
        error:
          failed > 0
            ? `${failed} of ${members.length} members failed — completed members keep their published versions; press again to retry.`
            : null,
        finished_at: new Date().toISOString(),
        status,
      })
      .eq("id", args.bundleId)
      .select(BUNDLE_SELECT),
  );
  return { affected: rows.length, bundle: rows[0] ?? null };
}
