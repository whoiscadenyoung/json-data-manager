/**
 * The bundle press — the client orchestrator of roadmap 7b (#103; lifecycle
 * doc §5-§6, ADR 0008). One project publishes as one bundle: the collection
 * (promoted), each map (promoted — its layer structure persists untouched),
 * and the deduped referenced datasets, each frozen through the EXISTING 5b
 * state machine via `publishDataset` — deliberately never a fork of it
 * (spec execution is client-side bulk compute, the roadmap's fixed boundary;
 * there is no server-side re-run path to reuse).
 *
 * The press is a LOOP over the host-side run's member rows
 * (`api.bundles.start` → per-member `publishDataset` → `recordMember` →
 * collection leg → map leg → `completeRun`). Every leg is idempotent and
 * every outcome is checkpointed on the run, so a killed browser re-presses
 * into the SAME run (`start` joins it) and resumes only the members that
 * never finished — per-member durability is already each publishAttempt's
 * (join-or-revive, by-ref freeze, chunk registration); the run row is what
 * makes WHICH members are done exact.
 *
 * Atomicity is per-member, by design: one member failing leaves the bundle
 * partial — completed members KEEP their frozen rows (append-only), the
 * failed member's attempt stays retryable, and the press records the failure
 * and finishes so the UI can say exactly what to retry.
 *
 * React-side consumers call `publishProjectBundle`; tests drive the host
 * mutations directly (bundles.test.ts, the publish.test.ts shape).
 */
import type { ConvexClient } from "convex/browser";

import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";

import { sharedClient } from "./dataset-rows";
import { publishDataset } from "./publish";

/** What one press ended as ("failed" = partial; completed members stand). */
export interface BundlePressOutcome {
  collectionId?: string;
  failedKeys: string[];
  runId: string;
  status: "completed" | "failed";
}

/** The member rows the orchestrator publishes, in the run's write order. */
function publishableMembers(
  members: Array<{
    datasetKey: string;
    kind: "dataset" | "derived" | "map";
    publish: boolean;
    status: string;
  }>,
): Array<{ datasetKey: string; kind: "dataset" | "derived" | "map" }> {
  return members
    .filter((member) => member.publish && member.kind !== "map" && member.status !== "published")
    .map((member) => ({ datasetKey: member.datasetKey, kind: member.kind }));
}

/**
 * Publishes one project as its bundle: start (or join) the run → publish
 * every not-yet-published dataset/derived member through `publishDataset`,
 * checkpointing each outcome → promote the collection (create-once,
 * file-every-member, group re-attach) → mint the maps' layer references →
 * close the run. Member order is the run's write order (datasets, then
 * derived), so derived lineage freezes against sources that already
 * published.
 */
export async function publishProjectBundle(options: {
  convex?: ConvexClient;
  projectId: string;
}): Promise<BundlePressOutcome> {
  const convex = options.convex === undefined ? sharedClient() : options.convex,
    started = await convex.mutation(api.bundles.start, { projectId: options.projectId }),
    run = await convex.query(api.bundles.run, { runId: started.runId });
  if (run === null) {
    throw new Error("The bundle run disappeared before the press could drive it.");
  }

  const failedKeys: string[] = [];
  for (const member of publishableMembers(run.members)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- members publish in press order; each checkpoint depends on the previous one landing.
      await convex.mutation(api.bundles.recordMember, {
        datasetKey: member.datasetKey,
        runId: started.runId,
        status: "publishing",
      });
      // oxlint-disable-next-line no-await-in-loop -- see above; the 5b machine is inherently per-member sequential.
      const outcome = await publishDataset({ convex, datasetKey: member.datasetKey });
      if (outcome.schemaId === undefined) {
        throw new Error(
          `Publishing "${member.datasetKey}" finished without a version record — start a new publish for it.`,
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- the outcome record is the member's checkpoint; ordering keeps the run honest.
      await convex.mutation(api.bundles.recordMember, {
        attemptId: outcome.attemptId,
        datasetKey: member.datasetKey,
        publishedSchemaId: outcome.schemaId,
        runId: started.runId,
        status: "published",
      });
    } catch (error) {
      const message = errorMessage(error, "The publish failed for an unknown reason.");
      failedKeys.push(member.datasetKey);
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await convex.mutation(api.bundles.recordMember, {
        datasetKey: member.datasetKey,
        error: message,
        runId: started.runId,
        status: "failed",
      });
    }
  }

  await convex.mutation(api.bundles.promoteCollection, { runId: started.runId });
  await convex.mutation(api.bundles.linkMapLayers, { runId: started.runId });
  const closed = await convex.mutation(api.bundles.completeRun, { runId: started.runId });
  return {
    collectionId: closed.collectionId,
    failedKeys,
    runId: started.runId,
    status: closed.status,
  };
}
