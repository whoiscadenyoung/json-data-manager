import { queryOptions } from "@tanstack/react-query";

import { versionRowOf, type VersionRow } from "#/lib/version-rows";

import { clientOf, queryRow, queryRows, queryScalar, type StoreOptions } from "./client";
import { CATALOG_READ_LIMIT } from "./datasets";

/**
 * The versions store (design doc §8.1 "versions.ts # datasetVersions/tags/
 * policies/consumerReferences"; stage 4, issue #203) — the PG counterpart of
 * the Convex `api.versions.*` domain over the `public.dataset_versions`,
 * `public.version_entries`, `public.consumer_references`, and
 * `public.version_policies` tables (DDL §3.5, migration 0009).
 *
 * Parity notes (each traces to `app/convex/versions/`):
 *   - A chain is one dataset's `dataset_versions` rows, newest-first; the
 *     head is the newest row (the PG form of chain.ts's head selection —
 *     publish_version stamps `ref` with the publish key, so the
 *     "attempt chain" and the version chain are ONE table here).
 *   - Retention is the database's job (`enforce_version_retention`, the
 *     keep-N pass publish_version runs in its own transaction) — this module
 *     only reads the policy row and writes keep/pins through it. Absence of
 *     a `version_policies` row reads as the defaults
 *     (DEFAULT_KEEP_VERSIONS, nothing pinned) exactly like the component
 *     store did; a foreign anchor's row is RLS-invisible, which answers the
 *     same defaults (the tags.ts:636-641 rule).
 *   - The delta is computed on demand (the `getVersionDelta` shape,
 *     tags.ts:677-709), bounded at VERSION_DIFF_LIMIT rows per side with an
 *     exact `truncated` flag (#126). The Convex tagDeltas table (stored
 *     sequential deltas) has no §3.5 counterpart and is not carried — the
 *     always-correct arbitrary-pair path is the PG read.
 *   - Pin/float consumer references carry `pinned_version_id` +
 *     `pinned_ref` when pinned, both absent on float (the DB check
 *     enforces what the Convex validators did).
 *
 * Every write helper returns the rows it affected (or the row it wrote): a
 * 0-row UPDATE reads as "not found / denied" and the UI can say so honestly
 * — RLS-filtered writes do NOT throw (the §4 denial shape), so a void
 * return would read as success to a toast.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/** One frozen version of a dataset (the `dataset_versions` row). */
export interface DatasetVersionRow {
  id: string;
  datasetId: string;
  /** The durable version identity — globally unique ("a ref never freezes twice"). */
  ref: string;
  /** The idempotency key; publish_version stamps it with the same value as `ref`. */
  publishKey: string | null;
  versionLabel: string;
  /** The lineageValidator-shape jsonb (component schema.ts:33-49), passthrough. */
  lineage: unknown;
  createdBy: string;
  createdAt: string;
}

/** One materialized row of a frozen version (the `version_entries` row). */
export interface VersionEntryRow {
  id: string;
  versionId: string;
  /** The origin entry — provenance only; `data` is the truth (§3.5). */
  entryId: string | null;
  data: unknown;
  /** Verbatim GeoJSON at freeze time; null for storage-backed oversized rows (the publish_version recorded limitation). */
  geometry: unknown;
  geometryType: string | null;
  bbox: number[] | null;
  ordinal: number;
}

/** One consumer's reference on another dataset's chain — pin or float. */
export interface ConsumerReferenceRow {
  id: string;
  /** The consuming artifact's stable id (a derived registry row, a map id, or a project_artifacts membership row — the text id space). */
  consumerId: string;
  consumerKind: "derived" | "map" | "fork";
  sourceDatasetId: string | null;
  mode: "float" | "pin";
  pinnedVersionId: string | null;
  pinnedRef: string | null;
  createdAt: string;
}

/** The per-anchor retention policy row (keep-N + pinned refs). */
export interface VersionPolicyRow {
  datasetKey: string;
  keepVersions: number | null;
  pinnedRefs: string[];
}

/** The retention resolution the UI reads: the stored policy or the defaults. */
export interface ResolvedRetentionPolicy {
  keepVersions: number;
  pinnedRefs: string[];
}

/** Unpinned versions kept per chain when no explicit keep-N is set (versioning.ts:46). */
export const DEFAULT_KEEP_VERSIONS = 10;

/**
 * The row budget one diff side reads (#126): at or above it the diff is a
 * bound, not the truth — `truncated` says so instead of silently serving a
 * bounded diff as the whole truth (versioning.ts:146).
 */
export const VERSION_DIFF_LIMIT = 2000;

const VERSION_SELECT =
  "id,datasetId:dataset_id,ref,publishKey:publish_key,versionLabel:version_label,lineage,createdBy:created_by,createdAt:created_at";
/** The consumer_references projection — shared with the projects catalog's multi-consumer read (projects.ts). */
export const REFERENCE_SELECT =
  "id,consumerId:consumer_id,consumerKind:consumer_kind,sourceDatasetId:source_dataset_id,mode,pinnedVersionId:pinned_version_id,pinnedRef:pinned_ref,createdAt:created_at";
const ENTRY_SELECT =
  "id,versionId:version_id,entryId:entry_id,data,geometry,geometryType:geometry_type,bbox,ordinal";

/** Widest one version chain read may ask for (the CATALOG_READ_LIMIT parity). */
export const VERSIONS_READ_LIMIT = CATALOG_READ_LIMIT;

// ---------------------------------------------------------------------------
// Reads (TanStack Query `queryOptions` per function, design §8.1)
// ---------------------------------------------------------------------------

/** One dataset's frozen versions, newest first — `tags.listVersions` parity. */
export function listVersionsQueryOptions(args: { datasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:versions", "list", args],
    queryFn: async () =>
      await queryRows<DatasetVersionRow>(
        clientOf(options)
          .from("dataset_versions")
          .select(VERSION_SELECT)
          .eq("dataset_id", args.datasetId)
          .order("created_at", { ascending: false })
          .limit(VERSIONS_READ_LIMIT),
      ),
  });
}

/** One version by id, or null when RLS hides it. */
export function getVersionQueryOptions(args: { versionId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:versions", "get", args],
    queryFn: async () =>
      await queryRow<DatasetVersionRow>(
        clientOf(options)
          .from("dataset_versions")
          .select(VERSION_SELECT)
          .eq("id", args.versionId)
          .limit(1),
      ),
  });
}

export interface VersionEntriesArgs {
  versionId: string;
  /** Opaque continuation from the previous page (`nextCursor`); null/absent = first page. */
  cursor?: number | null;
  limit?: number;
}

export interface VersionEntriesPage {
  rows: VersionEntryRow[];
  /** The LAST row's ordinal — pass it back as `cursor`; null = exhausted (the §5 paging rule). */
  nextCursor: number | null;
}

/** Frozen-entry page width when a caller doesn't pin one (frozen popups read rows in small pages — the on-demand #52 path). */
export const VERSION_ENTRIES_PAGE_ROWS = 200;

/**
 * Pages one version's materialized rows by `ordinal` keyset (the frozen
 * popups + compare base). Cursor-chained to exhaustion:
 * `nextCursor === null` is done (the seam's isDone rule).
 */
export function versionEntriesQueryOptions(args: VersionEntriesArgs, options?: StoreOptions) {
  const limit = args.limit ?? VERSION_ENTRIES_PAGE_ROWS;
  return queryOptions({
    queryKey: ["pg:versions", "versionEntries", args],
    queryFn: async () => {
      let query = clientOf(options)
        .from("version_entries")
        .select(ENTRY_SELECT)
        .eq("version_id", args.versionId);
      if (args.cursor !== null && args.cursor !== undefined) {
        query = query.gt("ordinal", args.cursor);
      }
      const rows = await queryRows<VersionEntryRow>(
        query.order("ordinal", { ascending: true }).limit(limit + 1),
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        nextCursor: hasMore && last !== undefined ? last.ordinal : null,
        rows: page,
      } satisfies VersionEntriesPage;
    },
  });
}

/**
 * One version's light diff rows, bounded at VERSION_DIFF_LIMIT (+ the exact
 * truncation answer) — the versionRowsBounded shape (versioning.ts:155).
 * Provenance-severed rows (`entry_id` nulled by a later origin delete) are
 * EXCLUDED here, exactly like the overlay feed (pg-versioning.ts): keyed on
 * a fallback they'd all collide on one key in `diffVersionRows`' maps and
 * fabricate add/remove pairs — outside the join key they are honestly "not
 * comparable". Truncation still counts the raw read (the bound is the
 * table's answer, not the filtered one).
 */
async function versionRowsBounded(
  versionId: string,
  options?: StoreOptions,
): Promise<{ rows: VersionRow[]; truncated: boolean }> {
  const rows = await queryRows<Pick<VersionEntryRow, "data" | "entryId">>(
    clientOf(options)
      .from("version_entries")
      .select("data,entryId:entry_id")
      .eq("version_id", versionId)
      .order("ordinal", { ascending: true })
      .limit(VERSION_DIFF_LIMIT + 1),
  );
  const truncated = rows.length > VERSION_DIFF_LIMIT;
  const light: VersionRow[] = [];
  for (const row of rows.slice(0, VERSION_DIFF_LIMIT)) {
    if (row.entryId === null) {
      continue;
    }
    const versionRow = versionRowOf(row.entryId, row.data);
    if (versionRow !== undefined) {
      light.push(versionRow);
    }
  }
  return { rows: light, truncated };
}

export interface VersionDelta {
  ops: CommitOp[];
  added: number;
  removed: number;
  updated: number;
  truncated: boolean;
}

/** The commits' ops shape — one diff entry (versioning.ts:57-64). */
export interface CommitOp {
  entryKey: string;
  fields: Array<{ after?: unknown; before?: unknown; name: string }>;
  geometryChanged: boolean;
  op: "add" | "delete" | "update";
}

/**
 * Diffs two frozen versions into the commits' ops shape — the compare
 * view's add/remove/modify overlay (the `getVersionDelta` parity;
 * versioning.ts:197-249's algorithm, re-stated here so the client computes
 * it over materialized PG rows without the Convex host). Either side at the
 * read budget answers `truncated: true` (#126).
 */
export async function getVersionDelta(
  args: { aVersionId: string; bVersionId: string },
  options?: StoreOptions,
): Promise<VersionDelta> {
  const [before, after] = [
    await versionRowsBounded(args.aVersionId, options),
    await versionRowsBounded(args.bVersionId, options),
  ];
  const ops = diffVersionRows(before.rows, after.rows);
  let added = 0,
    removed = 0,
    updated = 0;
  for (const op of ops) {
    if (op.op === "add") {
      added += 1;
    } else if (op.op === "delete") {
      removed += 1;
    } else {
      updated += 1;
    }
  }
  return { added, ops, removed, truncated: before.truncated || after.truncated, updated };
}

/** The delta between two versions as a TanStack Query (the compare view's feed). */
export function versionDeltaQueryOptions(
  args: { aVersionId: string; bVersionId: string },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:versions", "delta", args],
    queryFn: async () => await getVersionDelta(args, options),
  });
}

/** A chain head as the badge consumers compare against — the ChainHead shape (chain.ts:18-26), keyed by dataset id. */
export interface ChainHead {
  /** The chain anchor (the dataset id — the PG form of chainAnchorOf). */
  anchorId: string;
  frozenAt: number;
  ref: string;
  versionId: string;
  versionLabel: string;
}

/** The frozen-at time of one version row: the lineage stamp, falling back to the row's creation time. */
function frozenAtOf(row: DatasetVersionRow): number {
  const lineage = row.lineage;
  if (typeof lineage === "object" && lineage !== null && !Array.isArray(lineage)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record-shape guard above is the runtime check; publish_version always stamps frozenAt as a number.
    const stamp = (lineage as Record<string, unknown>).frozenAt;
    if (typeof stamp === "number") {
      return stamp;
    }
  }
  const parsed = Date.parse(row.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The newest head per dataset from one ordered read (created_at desc — the
 * versions_by_dataset index order): the first row per dataset wins. The PG
 * form of `resolveSourceHead` for PUBLISH chains — one table serves what
 * the Convex walk asked two stores.
 */
export function headsOf(rows: ReadonlyArray<DatasetVersionRow>): Map<string, ChainHead> {
  const heads = new Map<string, ChainHead>();
  for (const row of rows) {
    if (heads.has(row.datasetId)) {
      continue;
    }
    heads.set(row.datasetId, {
      anchorId: row.datasetId,
      frozenAt: frozenAtOf(row),
      ref: row.ref,
      versionId: row.id,
      versionLabel: row.versionLabel,
    });
  }
  return heads;
}

/** The chain head of one dataset (newest version), or null when the chain is empty/invisible. */
export function headOfChainQueryOptions(args: { datasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:versions", "head", args],
    queryFn: async () =>
      await queryRow<DatasetVersionRow>(
        clientOf(options)
          .from("dataset_versions")
          .select(VERSION_SELECT)
          .eq("dataset_id", args.datasetId)
          .order("created_at", { ascending: false })
          .limit(1),
      ),
  });
}

/**
 * The retention policy of one chain anchor: the stored row, or the defaults
 * when absent — including when RLS hides a foreign anchor's row, which is
 * exactly the Convex "invisible anchor answers the defaults" read
 * (tags.ts:636-641).
 */
export function retentionPolicyQueryOptions(args: { datasetKey: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:versions", "retentionPolicy", args],
    queryFn: async (): Promise<ResolvedRetentionPolicy> => {
      const row = await queryRow<VersionPolicyRow>(
        clientOf(options)
          .from("version_policies")
          .select("datasetKey:dataset_key,keepVersions:keep_versions,pinnedRefs:pinned_refs")
          .eq("dataset_key", args.datasetKey)
          .limit(1),
      );
      if (row === null) {
        return { keepVersions: DEFAULT_KEEP_VERSIONS, pinnedRefs: [] };
      }
      return {
        keepVersions: row.keepVersions ?? DEFAULT_KEEP_VERSIONS,
        pinnedRefs: row.pinnedRefs ?? [],
      };
    },
  });
}

/** One consumer's edges — `by_consumer` (the sync/revert/pin surface). */
export function listConsumerReferencesQueryOptions(
  args: { consumerId: string },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:versions", "consumerReferences", args],
    queryFn: async () =>
      await queryRows<ConsumerReferenceRow>(
        clientOf(options)
          .from("consumer_references")
          .select(REFERENCE_SELECT)
          .eq("consumer_id", args.consumerId)
          .limit(VERSIONS_READ_LIMIT),
      ),
  });
}

/** Every consumer of one source — the consumed-by list (the notify leg). */
export function consumedByQueryOptions(args: { sourceDatasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:versions", "consumedBy", args],
    queryFn: async () =>
      await queryRows<ConsumerReferenceRow>(
        clientOf(options)
          .from("consumer_references")
          .select(REFERENCE_SELECT)
          .eq("source_dataset_id", args.sourceDatasetId)
          .limit(VERSIONS_READ_LIMIT),
      ),
  });
}

// ---------------------------------------------------------------------------
// Badges — the notify-equivalent fields (chain.ts:167-182, ported verbatim)
// ---------------------------------------------------------------------------

export type BadgeState = "current" | "drift" | "live" | "missing";

/** One badge row: a consumed source, what was recorded at freeze, and the head now. */
export interface SourceBadge {
  headRef?: string;
  headVersionId?: string;
  headVersionLabel?: string;
  recordedRef?: string;
  recordedVersionId?: string;
  recordedVersionLabel?: string;
  sourceDatasetId: string;
  state: BadgeState;
}

/**
 * The drift decision (chain.ts:167-182, ported): a consumer badges when the
 * version it recorded differs from the source chain's current head. No head
 * → "live" (nothing to compare) or "missing" (the recorded chain vanished —
 * retired or deleted; never a crash). A LIVE-READ source (no ref recorded)
 * drifts only when the head froze AFTER the consumer did.
 */
export function badgeStateOf(
  recordedRef: string | undefined,
  head: ChainHead | undefined,
  consumerFrozenAt?: number,
): BadgeState {
  if (head === undefined) {
    return recordedRef === undefined ? "live" : "missing";
  }
  if (recordedRef === undefined) {
    if (consumerFrozenAt !== undefined && head.frozenAt <= consumerFrozenAt) {
      return "current";
    }
    return "drift";
  }
  return recordedRef === head.ref ? "current" : "drift";
}

/** The label lookup without optional chaining (the record itself is optional by design). */
function presentLabel(
  versionLabels: Map<string, string> | undefined,
  versionId: string,
): string | undefined {
  if (versionLabels === undefined) {
    return undefined;
  }
  return versionLabels.get(versionId);
}

/**
 * The badges for one consumer's edges against the sources' heads: `edges`
 * from `listConsumerReferencesQueryOptions`, `heads` from the heads read
 * (headsOf over the datasets' versions, newest-first). Pure — the UI joins
 * its loaded queries through this instead of one query per source.
 */
export function badgesOf(
  edges: ReadonlyArray<ConsumerReferenceRow>,
  heads: Map<string, ChainHead>,
  versionLabels?: Map<string, string>,
): SourceBadge[] {
  return edges.map((edge) => {
    const source = edge.sourceDatasetId ?? "";
    const head = heads.get(source);
    const recordedVersion =
      edge.mode === "pin" && edge.pinnedVersionId !== null
        ? {
            recordedRef: edge.pinnedRef ?? undefined,
            recordedVersionId: edge.pinnedVersionId,
            recordedVersionLabel: presentLabel(versionLabels, edge.pinnedVersionId),
          }
        : {};
    const headFields =
      head === undefined
        ? {}
        : {
            headRef: head.ref,
            headVersionId: head.versionId,
            headVersionLabel: head.versionLabel,
          };
    return {
      ...headFields,
      ...recordedVersion,
      sourceDatasetId: source,
      state: badgeStateOf(
        edge.mode === "pin" ? (edge.pinnedRef ?? undefined) : undefined,
        head,
        Date.parse(edge.createdAt) || undefined,
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Writes — every helper reports the rows it affected (the stage-4
// silent-denial rule: an RLS-filtered write reads as 0 rows, and the UI
// surfaces that instead of toasting success).
// ---------------------------------------------------------------------------

/**
 * Sets the keep-N retention count and enforces it immediately (the
 * `setKeepVersions` parity — tags.ts:598-629, minus the Convex binding
 * lookup: the PG policy row IS the store). Returns the retention pass's
 * retired count. `keep < 1` throws ("Keep at least one version").
 */
export async function setKeepVersions(
  args: { datasetKey: string; keep: number },
  options?: StoreOptions,
): Promise<number> {
  if (args.keep < 1) {
    throw new Error("Keep at least one version.");
  }
  const rows = await queryRows<{ datasetKey: string }>(
    clientOf(options)
      .from("version_policies")
      .upsert(
        { dataset_key: args.datasetKey, keep_versions: args.keep },
        { onConflict: "dataset_key" },
      )
      .select("dataset_key"),
  );
  if (rows.length === 0) {
    throw new Error("Retention policy write denied (0 rows) — not the chain owner?");
  }
  return await enforceVersionRetention(args.datasetKey, options);
}

/**
 * Pins (or unpins) one frozen version's ref into the anchor's policy store —
 * the `pinRefIntoPolicyStore` parity (consumption.ts:352-392): upsert the
 * row, add/remove the ref from `pinned_refs`. Returns the affected row
 * count (0 = denied — not the anchor's owner).
 */
export async function setVersionPinned(
  args: { datasetKey: string; ref: string; pinned: boolean },
  options?: StoreOptions,
): Promise<number> {
  const row = await queryRow<VersionPolicyRow>(
    clientOf(options)
      .from("version_policies")
      .select("datasetKey:dataset_key,keepVersions:keep_versions,pinnedRefs:pinned_refs")
      .eq("dataset_key", args.datasetKey)
      .limit(1),
  );
  const pinnedRefs = new Set(row !== null ? (row.pinnedRefs ?? []) : []);
  if (args.pinned) {
    pinnedRefs.add(args.ref);
  } else {
    pinnedRefs.delete(args.ref);
  }
  const next = [...pinnedRefs];
  const written = await queryRows<{ datasetKey: string }>(
    clientOf(options)
      .from("version_policies")
      .upsert({ dataset_key: args.datasetKey, pinned_refs: next }, { onConflict: "dataset_key" })
      .select("dataset_key"),
  );
  return written.length;
}

/** The {@link enforceVersionRetention} argument set. */
export type RetentionArgs = { datasetId: string };

/**
 * Runs the keep-N pass (`enforce_version_retention`, §6 of the migration):
 * newest `keep` unpinned versions survive; policy-pinned refs,
 * consumer-pinned rows, and live tags are exempt. Returns the retired
 * count. Throws the RPC's owner-or-editor error when neither holds.
 */
export async function enforceVersionRetention(
  args: RetentionArgs | string,
  options?: StoreOptions,
): Promise<number> {
  const datasetId = typeof args === "string" ? args : args.datasetId;
  const retired = await queryScalar<number>(
    clientOf(options).rpc("enforce_version_retention", { p_dataset: datasetId }),
  );
  if (typeof retired !== "number") {
    throw new Error("enforce_version_retention returned no count.");
  }
  return retired;
}

export interface SetReferenceModeArgs {
  referenceId: string;
  mode: "float" | "pin";
  /** Required when mode is "pin" (the DB check refuses a pinless pin). */
  pinnedVersionId?: string;
  pinnedRef?: string;
}

/**
 * Floats or pins one consumer reference (`setReferenceMode` parity,
 * consumption.ts:1289). Returns the affected row count (0 = denied — not
 * the consumer's owner, or the row is gone).
 */
export async function setReferenceMode(
  args: SetReferenceModeArgs,
  options?: StoreOptions,
): Promise<number> {
  const patch: Record<string, unknown> = { mode: args.mode };
  if (args.mode === "pin") {
    if (args.pinnedVersionId === undefined) {
      throw new Error("A pin needs its version — set pinnedVersionId first.");
    }
    patch.pinned_version_id = args.pinnedVersionId;
    patch.pinned_ref = args.pinnedRef ?? null;
  } else {
    patch.pinned_version_id = null;
    patch.pinned_ref = null;
  }
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("consumer_references")
      .update(patch)
      .eq("id", args.referenceId)
      .select("id"),
  );
  return rows.length;
}

/**
 * Advances a pinned reference to the chain's current head (`syncReference`
 * parity — sync = repin for reference consumers). Reads the edge and the
 * head first; a float edge syncs to nothing (it IS at head) and answers 0
 * changes. Returns the affected row count (0 also = denied/gone — the UI
 * reads the returned ref to distinguish).
 */
export async function syncReference(
  args: { referenceId: string },
  options?: StoreOptions,
): Promise<{ affected: number; head: ChainHead | null }> {
  const client = clientOf(options);
  const edge = await queryRow<ConsumerReferenceRow>(
    client.from("consumer_references").select(REFERENCE_SELECT).eq("id", args.referenceId).limit(1),
  );
  if (edge === null || edge.sourceDatasetId === null) {
    return { affected: 0, head: null };
  }
  const headRow = await queryRow<DatasetVersionRow>(
    client
      .from("dataset_versions")
      .select(VERSION_SELECT)
      .eq("dataset_id", edge.sourceDatasetId)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  if (headRow === null) {
    return { affected: 0, head: null };
  }
  const head: ChainHead = {
    anchorId: headRow.datasetId,
    frozenAt: frozenAtOf(headRow),
    ref: headRow.ref,
    versionId: headRow.id,
    versionLabel: headRow.versionLabel,
  };
  if (edge.mode === "float") {
    return { affected: 0, head };
  }
  if (edge.pinnedRef === head.ref) {
    return { affected: 0, head };
  }
  const rows = await queryRows<{ id: string }>(
    client
      .from("consumer_references")
      .update({ mode: "pin", pinned_ref: head.ref, pinned_version_id: head.versionId })
      .eq("id", args.referenceId)
      .select("id"),
  );
  return { affected: rows.length, head };
}

/**
 * Repins a reference to an explicit (earlier) version — the `revertReference`
 * parity (revert = repin, consumption.ts:1371). Returns the affected row
 * count (0 = denied, gone, or the named ref is no longer in the chain).
 */
export async function revertReference(
  args: { referenceId: string; toRef: string },
  options?: StoreOptions,
): Promise<number> {
  const client = clientOf(options);
  const edge = await queryRow<ConsumerReferenceRow>(
    client.from("consumer_references").select(REFERENCE_SELECT).eq("id", args.referenceId).limit(1),
  );
  if (edge === null || edge.sourceDatasetId === null) {
    return 0;
  }
  const version = await queryRow<DatasetVersionRow>(
    client
      .from("dataset_versions")
      .select(VERSION_SELECT)
      .eq("dataset_id", edge.sourceDatasetId)
      .eq("ref", args.toRef)
      .limit(1),
  );
  if (version === null) {
    return 0;
  }
  const rows = await queryRows<{ id: string }>(
    client
      .from("consumer_references")
      .update({ mode: "pin", pinned_ref: version.ref, pinned_version_id: version.id })
      .eq("id", args.referenceId)
      .select("id"),
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// The diff core — versioning.ts:197-249's `diffVersionRows`, re-stated for
// the client (the Convex host computed it server-side; the pinned semantics
// carry: deletes keep their before-state's fields, updates list only the
// changed fields, geometryChanged tracks lat/lng renames, adds carry every
// defined after-field).
// ---------------------------------------------------------------------------

/** Diffs two keyed row sets into the commits' ops shape (the versioning.ts algorithm, verbatim semantics). */
export function diffVersionRows(before: VersionRow[], after: VersionRow[]): CommitOp[] {
  const beforeByKey = new Map(before.map((row) => [row.key, row.data])),
    afterByKey = new Map(after.map((row) => [row.key, row.data])),
    ops: CommitOp[] = [];
  const names = new Set<string>();
  for (const data of beforeByKey.values()) {
    for (const name of Object.keys(data)) {
      names.add(name);
    }
  }
  for (const data of afterByKey.values()) {
    for (const name of Object.keys(data)) {
      names.add(name);
    }
  }
  for (const [key, afterData] of afterByKey) {
    const beforeData = beforeByKey.get(key);
    if (beforeData === undefined) {
      ops.push({
        entryKey: key,
        fields: [...names]
          .filter((name) => afterData[name] !== undefined)
          .map((name) => ({
            after: afterData[name],
            name,
          })),
        geometryChanged: true,
        op: "add",
      });
      continue;
    }
    const fields = [...names]
      .filter((name) => JSON.stringify(beforeData[name]) !== JSON.stringify(afterData[name]))
      .map((name) => ({ after: afterData[name], before: beforeData[name], name }));
    const geometryChanged = fields.some((field) => field.name === "lat" || field.name === "lng");
    if (fields.length > 0) {
      ops.push({ entryKey: key, fields, geometryChanged, op: "update" });
    }
  }
  for (const [key, beforeData] of beforeByKey) {
    if (!afterByKey.has(key)) {
      ops.push({
        entryKey: key,
        fields: [...names]
          .filter((name) => beforeData[name] !== undefined)
          .map((name) => ({ before: beforeData[name], name })),
        geometryChanged: false,
        op: "delete",
      });
    }
  }
  return ops;
}
