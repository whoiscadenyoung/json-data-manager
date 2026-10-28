import type { Doc } from "../_generated/dataModel.js";

/**
 * Catalog visibility (roadmap 5a, #99; docs/catalog-lifecycle-design.md §3):
 * drafts are invisible to catalog consumers. ABSENT reads as published — the
 * polarity that keeps every pre-field row and every dataset created through
 * today's flows catalog-visible with no backfill — so the only excluded state
 * is an explicit `"draft"`. No index serves absent-OR-published (not an
 * eq-prefix), and both catalog reads are already full scans, so this
 * predicate is applied in-memory over the collected rows.
 */
function isCatalogVisible(doc: Pick<Doc<"schemas">, "lifecycle">): boolean {
  return doc.lifecycle !== "draft";
}

/**
 * Identity scoping for the catalog reads (roadmap stage 8, #104; the D1/D2
 * decisions recorded on the issue): a DRAFT is readable only by its creator,
 * and a catalog-visible row flagged `publishedVisibility: "author"` likewise
 * — every other row is readable by any signed-in viewer (the default,
 * unchanged). The viewer is the HOST's `auth` hook return value, passed as
 * the required `viewerId` argument of every catalog enumeration: the
 * component stays auth-less (it cannot see the host's sessions), and the
 * required argument is the invariant that no caller enumerates the catalog
 * without declaring who is looking — the client-facing wrappers fill it from
 * the choke point, so no client path can forget it.
 */
export function isVisibleToViewer(
  doc: Pick<Doc<"schemas">, "createdBy" | "lifecycle" | "publishedVisibility">,
  viewerId: string,
): boolean {
  if (doc.lifecycle === "draft" || doc.publishedVisibility === "author") {
    return doc.createdBy === viewerId;
  }
  return true;
}

/** Both catalog-read filters, applied together (the enumerations' shared predicate). */
export function isCatalogVisibleToViewer(
  doc: Pick<Doc<"schemas">, "createdBy" | "lifecycle" | "publishedVisibility">,
  viewerId: string,
): boolean {
  return isCatalogVisible(doc) && isVisibleToViewer(doc, viewerId);
}

// ---------------------------------------------------------------------------
// List-read bounds (issue #128)
//
// Every enumeration below takes a REQUIRED `limit` — the unbounded
// full-table `.collect()` reads are gone. Each read honors the limit up to
// `LIST_LIMIT_MAX` and bounds its scan with `.take()`, so no query execution
// can read a whole table. The visibility/lifecycle filters are applied AFTER
// the take (no index serves absent-OR-published lifecycle, and
// publishedVisibility is likewise unindexeable for the same reason): a
// catalog dominated by rows the viewer cannot see can therefore answer with
// fewer than `limit` rows — the documented cost of the bound, and the
// windowed-scan trade-off the issue records for `consumedBy`'s take(500)
// scan. Reading fewer FULL schema docs per execution is also what keeps the
// ~16 MiB per-execution read cap reachable at all (each doc can carry 200 KB
// of schema/uiSchema payload).
// ---------------------------------------------------------------------------

/** The largest `limit` any list read honors — callers may pass more, the scan never exceeds this. */
const LIST_LIMIT_MAX = 1000;

/** Normalizes a required list `limit` to the honored width (≥ 1, capped at `LIST_LIMIT_MAX`). */
export function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(limit), LIST_LIMIT_MAX));
}

/**
 * The client-facing projection of a full `schemas` doc (issue #131): the
 * stored shape with the two `_storage` pointers stripped — the storage-id
 * secrecy half of the fix. `mapTileArchiveStorageId` is internal to the
 * install/delete flows; `sourceFileStorageId` becomes `hasSourceFile`, so a
 * caller can still tell "this dataset has a retained original" without
 * learning the blob's id. Every public query that returns a schema doc maps
 * through here — host flows that need the raw pointers read the stored doc
 * component-side (`ctx.db.get`), never through a public result.
 */
export function toPublicSchemaView(doc: Doc<"schemas">) {
  const { mapTileArchiveStorageId: _archiveId, sourceFileStorageId: _sourceFileId, ...view } = doc;
  return { ...view, hasSourceFile: _sourceFileId !== undefined };
}
