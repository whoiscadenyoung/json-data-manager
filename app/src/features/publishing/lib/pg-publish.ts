import { clientOf, queryRows, type StoreOptions } from "@/lib/store/client";
import { publishDataset } from "@/lib/store/publishing";

/**
 * The Postgres publish flow's client half (stage 4, #203; design doc
 * §5.4) — the dialog-side orchestration over the publishing store.
 *
 * The freeze itself is the store's `publishDataset` (one `publish_version`
 * call: idempotent on publish_key, set-based, single-transaction — the
 * Convex-era 5b chunk pipeline has NO Postgres counterpart). What this
 * module adds:
 *
 * - the DRAFT FLIP: an import-created draft is catalog-invisible until its
 *   lifecycle turns "published"; the publish flow flips it right after the
 *   freeze lands, and reports honestly when that flip moved zero rows
 *   (RLS-filtered — a denial the UI surfaces, never a success toast).
 * - `mintPublishKey`: the idempotency key minted when the publish dialog
 *   OPENS, so every submit inside one dialog session (and a browser retry
 *   of a hung submit) re-selects the same frozen version. The bundle press
 *   mints its own DETERMINISTIC keys (see `./pg-bundle-publish`).
 */

/** What one completed publish reports to its caller. */
export interface PgPublishOutcome {
  /** The dataset_versions id the RPC froze (or re-selected for a retried key). */
  versionId: string;
  /** Whether the draft→published lifecycle flip actually wrote (drafts only; false = denied or already published). */
  draftFlipped: boolean;
}

/**
 * Publishes one dataset version and, when the dataset is still a draft,
 * flips its lifecycle into the catalog. Two writes, ordered: the freeze
 * first (a denied freeze — a locked dataset answering only its creator,
 * RLS-before-RPC-body — throws before any lifecycle move), then the flip.
 */
export async function publishPgDatasetVersion(
  args: {
    datasetId: string;
    /** True when the dataset row's lifecycle is "draft" — the caller read the row. */
    isDraft: boolean;
    lineage?: unknown;
    /** The idempotency key minted at dialog-open (see the module comment). */
    publishKey: string;
    versionLabel: string;
  },
  options?: StoreOptions,
): Promise<PgPublishOutcome> {
  const versionId = await publishDataset(
    {
      datasetId: args.datasetId,
      lineage: args.lineage,
      publishKey: args.publishKey,
      versionLabel: args.versionLabel,
    },
    options,
  );
  if (!args.isDraft) {
    return { draftFlipped: false, versionId };
  }
  const flipped = await queryRows<{ id: string }>(
    clientOf(options)
      .from("datasets")
      .update({ lifecycle: "published" })
      .eq("id", args.datasetId)
      .select("id"),
  );
  return { draftFlipped: flipped.length > 0, versionId };
}

/** The publish idempotency key one publish attempt carries (design §5.4): a UUID minted when the dialog OPENS. */
export function mintPublishKey(): string {
  return crypto.randomUUID();
}
