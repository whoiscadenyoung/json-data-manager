import { clientOf, queryRow, queryRows, type StoreOptions } from "@/lib/store/client";
import * as collectionsStore from "@/lib/store/collections";
import * as projectsStore from "@/lib/store/projects";
import { getQueryOptions as getProjectQueryOptions } from "@/lib/store/projects";
import {
  completeBundle,
  latestBundleQueryOptions,
  linkMapLayers,
  listMembersQueryOptions,
  memberOrder,
  publishDataset,
  recordMember,
  setBundleCollection,
  startBundle,
  type BundleMemberPlan,
} from "@/lib/store/publishing";

/**
 * The bundle press — the client orchestrator of the Postgres bundle
 * (stage 4, #203; lifecycle doc §5–§6, ADR 0008), driving the publishing
 * store's press legs exactly the way `./bundle-publish.ts` drove the Convex
 * host mutations: `startBundle` (join-or-create + member plan, canonical
 * datasets → derived → maps order) → per-dataset `publishDataset` with
 * `recordMember` checkpoints → the promoted collection (create-once,
 * file-every-published-member) → `linkMapLayers` (the maps' float
 * references, reconciled to the current targets) → `completeBundle`.
 *
 * Every member's `publish_key` is DETERMINISTIC (`bundleId:memberId`) rather
 * than random: a browser killed mid-member re-presses into the same bundle
 * (start JOINS a still-running one), and publish_version's
 * ON CONFLICT (publish_key) rule turns that retry into the SAME frozen
 * version — idempotency across resumes, not just double-submits.
 *
 * Member semantics follow the publishing store's recorded shape: a dataset
 * that has never published freezes v1 in the press; an already-published
 * one joins as a "referenced" member with publish=false — the press never
 * re-freezes it (a newer version is the dataset page's publish dialog's
 * act). One member failing leaves the press partial — completed members
 * KEEP their frozen versions, the failed member's status + error name
 * exactly what to retry, and the press still closes ("failed").
 */

/** What one press ended as ("failed" = partial; completed members stand — the UI names the failed ones). */
export interface PgBundlePressOutcome {
  bundleId: string;
  collectionId: string | null;
  failedKeys: string[];
  status: "completed" | "failed";
}

/**
 * Runs one of the store modules' `queryOptions` factories imperatively (the
 * press is client code, not a React surface). The store queryFns close over
 * their args and never read TanStack's context — the same fact
 * `#/lib/store/test-support` records for the tests; the queryOptions TYPE
 * carries the fn as optional, so absence is a loud failure here.
 */
async function runStoreRead<T>(
  queryFn: ((context: never) => T | Promise<T>) | undefined,
): Promise<T> {
  if (queryFn === undefined) {
    throw new Error("The store read carries no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context; `never` satisfies the parameter without constructing a QueryClient for nothing.
  return await queryFn({} as never);
}

/** The head version row of one dataset's chain, or null before the first publish (RLS applies). */
async function headOf(
  datasetId: string,
  options?: StoreOptions,
): Promise<{
  label: string;
  versionId: string;
} | null> {
  const head = await queryRow<{ id: string; versionLabel: string }>(
    clientOf(options)
      .from("dataset_versions")
      .select("id,versionLabel:version_label")
      .eq("dataset_id", datasetId)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  if (head === null) {
    return null;
  }
  const match = /^v(\d+)$/.exec(head.versionLabel);
  return {
    label: match === null ? "v1" : `v${Number(match[1]) + 1}`,
    versionId: head.id,
  };
}

/** The map member's dataset-layer targets (the legs linkMapLayers mints references for). The maps store keeps the table; the press needs only the ids. */
async function mapLayerTargets(mapId: string, options?: StoreOptions): Promise<string[]> {
  const rows = await queryRows<{ targetId: string | null }>(
    clientOf(options)
      .from("map_layers")
      .select("targetId:target_id")
      .eq("map_id", mapId)
      .eq("target_type", "dataset")
      .limit(500),
  );
  return rows.flatMap((row) => (row.targetId === null ? [] : [row.targetId]));
}

/**
 * Publishes one project as its Postgres bundle: start (or join) the press →
 * freeze every never-published dataset member → promote the collection
 * (create-once, reused across presses) → link the maps' layer references →
 * close the run.
 */
export async function pgPublishProjectBundle(options: {
  projectId: string;
  supabase?: StoreOptions["supabase"];
}): Promise<PgBundlePressOutcome> {
  const storeOptions: StoreOptions | undefined =
      options.supabase === undefined ? undefined : { supabase: options.supabase },
    project = await runStoreRead(
      getProjectQueryOptions({ projectId: options.projectId }, storeOptions).queryFn,
    );
  if (project === null) {
    // Creator-only RLS: another user's project reads exactly as a missing one.
    throw new Error("The project to publish doesn't exist (or isn't yours).");
  }
  const artifacts = await runStoreRead(
      projectsStore.listArtifactsQueryOptions({ projectId: options.projectId }, storeOptions)
        .queryFn,
    ),
    latest = await runStoreRead(
      latestBundleQueryOptions({ projectId: options.projectId }, storeOptions).queryFn,
    );

  // The member plan: never-published datasets freeze; already-published ones
  // join referenced; maps carry their CURRENT dataset-layer targets (the
  // snapshot linkMapLayers reconciles to).
  const members: BundleMemberPlan[] = [];
  for (const artifact of artifacts) {
    if (artifact.artifactKind === "dataset") {
      // oxlint-disable-next-line no-await-in-loop -- one head read per dataset member, in artifact order.
      const head = await headOf(artifact.artifactId, storeOptions);
      members.push({
        datasetKey: artifact.artifactId,
        kind: "dataset",
        publish: head === null,
      });
    } else if (artifact.artifactKind === "map") {
      // oxlint-disable-next-line no-await-in-loop -- one targets read per map member, in artifact order.
      const targets = await mapLayerTargets(artifact.artifactId, storeOptions);
      members.push({
        datasetKey: artifact.artifactId,
        kind: "map",
        layerTargets: targets,
        publish: true,
      });
    } else {
      members.push({ datasetKey: artifact.artifactId, kind: "derived", publish: true });
    }
  }

  const started = await startBundle(
      {
        collectionId: latest === null ? undefined : (latest.collectionId ?? undefined),
        members,
        projectDescription: project.description ?? undefined,
        projectId: options.projectId,
        title: project.title,
      },
      storeOptions,
    ),
    memberRows = await runStoreRead(
      listMembersQueryOptions({ bundleId: started.bundleId }, storeOptions).queryFn,
    ),
    ordered = [...memberRows].sort((a, b) => memberOrder(a.kind) - memberOrder(b.kind)),
    failedKeys: string[] = [],
    publishedDatasetIds: string[] = [],
    mapLegs: Array<{ mapId: string; memberId: string; targets: ReadonlyArray<string> }> = [];

  for (const member of ordered) {
    if (
      !member.publish ||
      member.status === "published" ||
      member.status === "linked" ||
      member.status === "referenced"
    ) {
      continue;
    }
    if (member.kind === "map") {
      mapLegs.push({
        mapId: member.datasetKey,
        memberId: member.id,
        targets: member.layerTargets ?? [],
      });
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- members publish in press order; each checkpoint depends on the previous one landing.
      await recordMember(
        { bundleId: started.bundleId, memberId: member.id, status: "publishing" },
        storeOptions,
      );
      if (member.kind === "dataset") {
        // oxlint-disable-next-line no-await-in-loop -- see above; the freeze is inherently per-member sequential.
        const head = await headOf(member.datasetKey, storeOptions);
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const versionId = await publishDataset(
          {
            datasetId: member.datasetKey,
            publishKey: `${started.bundleId}:${member.id}`,
            versionLabel: head === null ? "v1" : head.label,
          },
          storeOptions,
        );
        // oxlint-disable-next-line no-await-in-loop -- the outcome record is the member's checkpoint; ordering keeps the run honest.
        const stamped = await recordMember(
          {
            bundleId: started.bundleId,
            memberId: member.id,
            publishedVersionId: versionId,
            status: "published",
          },
          storeOptions,
        );
        if (stamped === 0) {
          throw new Error("The member's checkpoint didn't record.");
        }
        publishedDatasetIds.push(member.datasetKey);
      } else {
        // Derived publishing lands with stage 5 — the honest refusal, not a
        // silent skip.
        throw new Error("Derived dataset publishing arrives in stage 5.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The publish failed.";
      failedKeys.push(member.datasetKey);
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await recordMember(
        { bundleId: started.bundleId, error: message, memberId: member.id, status: "failed" },
        storeOptions,
      );
    }
  }

  // The collection leg: reuse the prior press's collection, else create once
  // and record it; every PUBLISHED dataset member files into it.
  let collectionId = latest === null ? null : latest.collectionId;
  try {
    if (collectionId === null) {
      collectionId = await collectionsStore.create(
        {
          description:
            project.description === null
              ? `Published bundle of the "${project.title}" project.`
              : project.description,
          name: project.title,
        },
        storeOptions,
      );
      const claimed = await setBundleCollection(
        { bundleId: started.bundleId, collectionId },
        storeOptions,
      );
      if (claimed === 0) {
        throw new Error("The promoted collection didn't record on the bundle.");
      }
    }
    for (const datasetId of publishedDatasetIds) {
      // oxlint-disable-next-line no-await-in-loop -- one membership write per member, in press order.
      await collectionsStore.addToCollection({ collectionId, datasetId }, storeOptions);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The collection leg failed.";
    failedKeys.push("collection leg");
    await queryRows<{ id: string }>(
      clientOf(storeOptions)
        .from("publish_bundles")
        .update({ error: message, finished_at: new Date().toISOString(), status: "failed" })
        .eq("id", started.bundleId)
        .select("id"),
    );
    return { bundleId: started.bundleId, collectionId: null, failedKeys, status: "failed" };
  }

  // The map leg: one float reference per direct dataset-layer target, stale
  // edges reconciled away, each map member stamped "linked".
  await linkMapLayers({ bundleId: started.bundleId, maps: mapLegs }, storeOptions);

  const closed = await completeBundle({ bundleId: started.bundleId }, storeOptions);
  if (closed.affected === 0 || closed.bundle === null) {
    throw new Error("The bundle press couldn't close its run row.");
  }
  return {
    bundleId: started.bundleId,
    collectionId,
    failedKeys,
    status: closed.bundle.status === "failed" ? "failed" : "completed",
  };
}
