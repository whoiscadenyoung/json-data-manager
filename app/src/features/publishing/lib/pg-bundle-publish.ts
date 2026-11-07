import { clientOf, queryRow, queryRows, type StoreOptions } from "@/lib/store/client";
import * as collectionsStore from "@/lib/store/collections";
import * as projectsStore from "@/lib/store/projects";
import { getQueryOptions as getProjectQueryOptions } from "@/lib/store/projects";
import {
  completeBundle,
  latestBundleQueryOptions,
  listMembersQueryOptions,
  memberOrder,
  publishDataset,
  recordMember,
  setBundleCollection,
  startBundle,
  type BundleMemberPlan,
} from "@/lib/store/publishing";
import { visibilityApply, visibilityPreflight, type VisibilityLevel } from "@/lib/store/visibility";

/**
 * The bundle press — the client orchestrator of the Postgres bundle
 * (stage 4, #203; lifecycle doc §5–§6, ADR 0008), driving the publishing
 * store's press legs exactly the way `./bundle-publish.ts` drove the Convex
 * host mutations: `startBundle` (join-or-create + member plan, canonical
 * datasets → derived order) → per-dataset `publishDataset` with
 * `recordMember` checkpoints → the promoted collection (create-once,
 * file-every-published-or-referenced-member) → `completeBundle`.
 *
 * The member plan IS ADR 0008's bundle rule ("one project publishes as one
 * bundle — a collection plus its datasets"): the plan is the project's
 * artifacts, deduped by id. Map members leave with #256/ADR 0018 — the
 * artifact-kind domain narrowed to dataset|derived (0019) — and return as
 * project-owned maps in [project 3], whose layer legs re-land then
 * (`linkMapLayers` stays in the publishing store, unused until that phase).
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
  /** Blockers the closure apply named — the share is capped at min(closure). */
  visibilityCappedBy: number;
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

/** The map member's dataset-layer targets removed with #256 — map memberships left the artifact domain (0019); the leg returns with [project 3]'s project-owned maps. */

/**
 * Publishes one project as its Postgres bundle: start (or join) the press →
 * freeze every never-published dataset member → promote the collection
 * (create-once, reused across presses) → close the run.
 */
// The press is one linear orchestration of the recorded legs — start,
// per-member freeze with checkpoints, collection, close — where each leg
// consumes the previous leg's rows; splitting it into helpers would thread
// that mutable run state through parameters and hide the checkpoint order
// the resume semantics depend on.
// oxlint-disable-next-line eslint/complexity -- the leg sequence IS the flat, ordered control flow the press's resume contract is stated in.
export async function pgPublishProjectBundle(options: {
  projectId: string;
  supabase?: StoreOptions["supabase"];
  /**
   * The press's target visibility rung (#260, ADR 0022) — stamped on the
   * bundle row, recorded per member from the preflight's promotion plan,
   * and applied through the closure `visibility_apply` RPC after the
   * freeze legs. Omitted = the press publishes without touching any rung.
   */
  visibility?: VisibilityLevel;
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

  // The member plan (the bundleClosure walk): never-published datasets
  // freeze; already-published ones join referenced (deduped by id).
  // Collection/group layers stay out of the plan — the recorded
  // live-expansion asymmetry (bundles.ts): they expand at read time and
  // become members only at the next press.
  const datasetPlans = new Map<string, BundleMemberPlan>(),
    derivedPlans: BundleMemberPlan[] = [];
  const planDataset = async (datasetId: string): Promise<void> => {
    if (datasetPlans.has(datasetId)) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- one head read per dataset member, in plan order.
    const head = await headOf(datasetId, storeOptions);
    datasetPlans.set(datasetId, {
      datasetKey: datasetId,
      kind: "dataset",
      publish: head === null,
    });
  };
  for (const artifact of artifacts) {
    if (artifact.artifactKind === "dataset") {
      // oxlint-disable-next-line no-await-in-loop -- one head read per dataset artifact, in artifact order.
      await planDataset(artifact.artifactId);
    } else {
      derivedPlans.push({ datasetKey: artifact.artifactId, kind: "derived", publish: true });
    }
  }
  // Already in canonical order: datasets, then derived.
  const members: BundleMemberPlan[] = [...datasetPlans.values(), ...derivedPlans];

  // The ladder leg (#260): the promotion plan comes from a SERVER-DERIVED
  // preflight (the caller's report is a preview; the stamps come from the
  // walk), recorded per member at mint, and applied after the freeze legs
  // so widened rows have frozen versions behind them. A foreign pin below
  // the target stays a blocker — the apply names it, never widens it.
  if (options.visibility !== undefined) {
    const report = await visibilityPreflight(
      { artifactId: options.projectId, kind: "project", target: options.visibility },
      storeOptions,
    );
    const datasetPromotions = new Map(
      report.promotions
        .filter((promotion) => promotion.kind === "dataset")
        .map((promotion) => [promotion.id, promotion]),
    );
    for (const member of members) {
      const promotion = datasetPromotions.get(member.datasetKey);
      if (promotion !== undefined) {
        member.visibilityFrom = promotion.from;
        member.visibilityTo = promotion.to;
      }
    }
  }

  const started = await startBundle(
      {
        collectionId: latest === null ? undefined : (latest.collectionId ?? undefined),
        members,
        projectDescription: project.description ?? undefined,
        projectId: options.projectId,
        title: project.title,
        visibility: options.visibility,
      },
      storeOptions,
    ),
    memberRows = await runStoreRead(
      listMembersQueryOptions({ bundleId: started.bundleId }, storeOptions).queryFn,
    ),
    ordered = [...memberRows].toSorted((a, b) => memberOrder(a.kind) - memberOrder(b.kind)),
    failedKeys: string[] = [],
    // The collection's files (the promoteCollection walk, bundles.ts leg 3):
    // referenced members file THEMSELVES — their frozen row already exists,
    // which is exactly how a map-layer-referenced already-published dataset
    // lands in the catalog — newly frozen members file the row the press
    // produced (pushed below), and a resumed press re-files the members an
    // earlier leg already published.
    fileIntoCollection: string[] = ordered.flatMap((member) =>
      member.kind === "dataset" && (member.status === "published" || member.status === "referenced")
        ? [member.datasetKey]
        : [],
    );

  for (const member of ordered) {
    if (
      !member.publish ||
      member.status === "published" ||
      member.status === "linked" ||
      member.status === "referenced"
    ) {
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
        fileIntoCollection.push(member.datasetKey);
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

  // Declared before the collection leg: its early return reports the
  // blocker count too (the apply leg below only ever increments it).
  let visibilityCappedBy = 0;

  // The collection leg: reuse the prior press's collection, else create once
  // and record it; every dataset member whose frozen row stands files into
  // it — the newly frozen rows AND the referenced members (the frozen row,
  // or — referenced — itself; bundles.ts leg 3). addToCollection is a no-op
  // for an existing pair (the store's ignoreDuplicates upsert), so a resumed
  // press refiling an earlier leg is safe.
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
    for (const datasetId of fileIntoCollection) {
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
    return {
      bundleId: started.bundleId,
      collectionId: null,
      failedKeys,
      status: "failed",
      visibilityCappedBy,
    };
  }

  // (The map leg left with #256 — map memberships are out of the artifact
  // domain until [project 3] re-lands it over project-owned maps.)

  // The confirmed widening, ONE transaction across the whole closure —
  // after the freeze legs so every newly-widened dataset has its frozen
  // rows behind it. Blockers ride home in the outcome (the workspace
  // surfaces them; the share is capped at min(closure), never silently).
  if (options.visibility !== undefined) {
    const applied = await visibilityApply(
      { artifactId: options.projectId, kind: "project", target: options.visibility },
      storeOptions,
    );
    visibilityCappedBy = applied.blockers.length;
  }

  const closed = await completeBundle({ bundleId: started.bundleId }, storeOptions);
  if (closed.affected === 0 || closed.bundle === null) {
    throw new Error("The bundle press couldn't close its run row.");
  }
  return {
    bundleId: started.bundleId,
    collectionId,
    failedKeys,
    status: closed.bundle.status === "failed" ? "failed" : "completed",
    visibilityCappedBy,
  };
}
