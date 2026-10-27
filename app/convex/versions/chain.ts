/**
 * Pure chain-selection cores for versioned consumption (restructure step B3,
 * split out of `consumption.ts`): chain version/head/badge shapes, head
 * selection per chain kind, the chain-anchor rule and the drift decision.
 * No Convex context — unit-tested with plain objects in consumption.test.ts.
 */

/**
 * One version row as the chain reads see it — the versioning cores'
 * `FrozenVersion` plus the label the head/badge need (full component docs
 * carry it required; plain-object tests may omit it).
 */
export type ChainVersion = {
  _id: string;
  lineage?: { frozenAt: number; snapshotRef?: string; versionLabel?: string };
};

/** A resolved chain head — what a consumer's recorded ref compares against. */
export type ChainHead = {
  /** The chain anchor the head hangs from (`storedDelta` keys deltas on it). */
  anchorId: string;
  frozenAt: number;
  ref: string;
  schemaId: string;
  versionLabel: string;
};

/** One badge row: a consumed source, what was recorded at freeze, and the head now. */
export type SourceBadge = {
  headRef?: string;
  headSchemaId?: string;
  headVersionLabel?: string;
  recordedRef?: string;
  recordedSchemaId?: string;
  recordedVersionLabel?: string;
  sourceDatasetId: string;
  /** The source's chain anchor — the client keys `storedDelta` reads on it. */
  sourceAnchorId?: string;
  /** The consumed source's display name, resolved host-side (component or registry row — the client stays dumb). */
  sourceTitle?: string;
  state: "current" | "drift" | "live" | "missing";
};

// ---------------------------------------------------------------------------
// Pure selection cores (unit-tested in consumption.test.ts with plain
// objects, the versioning.test.ts shape): head selection per chain kind,
// the chain-anchor rule, and the drift decision.
// ---------------------------------------------------------------------------

/** A chain head as the pure cores return it — the resolver attaches `anchorId`. */
export type ChainHeadCore = Omit<ChainHead, "anchorId">;

/**
 * A component chain's head: the newest version (by freeze time) that carries
 * a snapshot ref. Versions arrive newest-creation-first; freeze time decides.
 */
export function headOfComponentChain(versions: ChainVersion[]): ChainHeadCore | undefined {
  let head: ChainHeadCore | undefined;
  for (const version of versions) {
    const lineage = version.lineage;
    if (lineage === undefined || lineage.snapshotRef === undefined) {
      continue;
    }
    if (head === undefined || lineage.frozenAt > head.frozenAt) {
      head = {
        frozenAt: lineage.frozenAt,
        ref: lineage.snapshotRef,
        schemaId: version._id,
        versionLabel: lineage.versionLabel ?? "?",
      };
    }
  }
  return head;
}

/** The structural slice of a publish attempt the attempt-chain cores read. */
export interface AttemptVersionLike {
  _creationTime: number;
  finishedAt?: number;
  publishKey: string;
  publishedSchemaId?: string;
  status: string;
  title: string;
  versionLabel: string;
}

/**
 * The NEWEST completed attempt that produced a frozen row — only completed
 * attempts count (an in-flight uploading/importing attempt is never a head,
 * the publish path's own rule); newest by finish time with creation time as
 * the tie-break (the attempts index walks ascending, so the tie-break is
 * what makes the newest attempt win). Shared with
 * `publish.sourceVersionsFor`, whose freeze-time source record must be this
 * same attempt — the head a consumer's badge compares against.
 */
export function newestCompletedAttempt<T extends AttemptVersionLike>(
  attempts: readonly T[],
): T | undefined {
  let newest: T | undefined,
    newestFrozenAt = -1,
    newestCreationTime = -1;
  for (const attempt of attempts) {
    if (attempt.status !== "completed" || attempt.publishedSchemaId === undefined) {
      continue;
    }
    const frozenAt = attempt.finishedAt ?? attempt._creationTime;
    if (
      newest === undefined ||
      frozenAt > newestFrozenAt ||
      (frozenAt === newestFrozenAt && attempt._creationTime > newestCreationTime)
    ) {
      newest = attempt;
      newestCreationTime = attempt._creationTime;
      newestFrozenAt = frozenAt;
    }
  }
  return newest;
}

/** A derived chain's head: the newest completed attempt's frozen row (see `newestCompletedAttempt`). */
export function headOfAttemptChain(
  attempts: readonly AttemptVersionLike[],
): ChainHeadCore | undefined {
  const newest = newestCompletedAttempt(attempts);
  if (newest === undefined || newest.publishedSchemaId === undefined) {
    return undefined;
  }
  return {
    frozenAt: newest.finishedAt ?? newest._creationTime,
    ref: newest.publishKey,
    schemaId: newest.publishedSchemaId,
    versionLabel: newest.versionLabel,
  };
}

/**
 * The chain anchor a dataset's versions hang from: the lineage's component
 * anchor (`sourceSchemaId`) for a draft-published row, the host registry id
 * (`sourceKey`) for a derived-published row, and the dataset itself for
 * anything that is not a frozen version (a live dataset's versions anchor on
 * it directly — the tag path's shape).
 */
export function chainAnchorOf(
  lineage: { sourceKey?: string; sourceSchemaId?: string } | undefined,
  datasetId: string,
): string {
  if (lineage === undefined) {
    return datasetId;
  }
  return lineage.sourceSchemaId ?? lineage.sourceKey ?? datasetId;
}

/**
 * The drift decision (the issue's semantics): a consumer badges when the
 * version it recorded differs from the source chain's current head. No head
 * at all means either a live source that was never published ("live" —
 * nothing to compare) or a recorded version whose chain vanished ("missing"
 * — retired or deleted; never a crash).
 *
 * A LIVE-READ source (no ref recorded — a stage-2 spec reading a dataset
 * that isn't itself a frozen version) drifts only when the head froze AFTER
 * the consumer did: a head that already existed at freeze time is already
 * reflected in the frozen rows, and nagging about it would badge forever
 * with no clearing path. Re-publishing the consumer after the source's
 * latest publish clears it — sync stays meaningful for live consumers too.
 */
export function badgeStateOf(
  recorded: { ref?: string },
  head: ChainHeadCore | undefined,
  consumerFrozenAt?: number,
): SourceBadge["state"] {
  if (head === undefined) {
    return recorded.ref === undefined ? "live" : "missing";
  }
  if (recorded.ref === undefined) {
    if (consumerFrozenAt !== undefined && head.frozenAt <= consumerFrozenAt) {
      return "current";
    }
    return "drift";
  }
  return recorded.ref === head.ref ? "current" : "drift";
}
