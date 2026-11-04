import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRows, type StoreOptions } from "@/lib/store/client";
import { VERSION_DIFF_LIMIT } from "@/lib/store/versions";
import { versionRowOf, type VersionRow } from "@/lib/version-rows";

/**
 * The PG version UI's glue over the versions/tags stores (stage 4, #203).
 *
 * The store modules (`#/lib/store/versions`, `#/lib/store/tags`) own every
 * table read/write, the delta computation, and the retention pass. This
 * module keeps ONLY what those stores deliberately don't carry:
 *
 * - the compare overlay's POSITION read: the shared VersionCompare renders
 *   add/remove/modify dots from one array per side, so a bounded single-shot
 *   read (VERSION_DIFF_LIMIT+1, the #126 exactness rule) serves the UI
 *   instead of the store's ordinal-paged read (which exists for the frozen
 *   popups' small pages). The ops themselves come from the store's
 *   `versionDeltaQueryOptions` — one delta definition, the store's.
 * - the pure selection helpers the consumer rows need (head, prior-version
 *   revert target, the suggested next label).
 */

/**
 * One version's materialized rows as light diff rows for the overlay,
 * bounded WITH the truncation answer: one row past the budget is read so
 * `truncated` is exact (a version with exactly VERSION_DIFF_LIMIT rows is
 * not truncated — the #126 rule). Success IS complete for this single-shot
 * read; `truncated` says when the result is a bound (never an isLoading
 * gate). Rows whose provenance was severed (`entry_id` set null by a later
 * origin delete) sit outside the join key and take no part in the overlay —
 * honestly "not comparable", not a fake add/remove pair.
 */
export function overlayRowsQueryOptions(args: { versionId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:version-overlay-rows", "bounded", args],
    queryFn: async () => {
      const entries = await queryRows<{ data: unknown; entryId: string | null }>(
        clientOf(options)
          .from("version_entries")
          .select("data,entryId:entry_id")
          .eq("version_id", args.versionId)
          .order("ordinal", { ascending: true })
          .limit(VERSION_DIFF_LIMIT + 1),
      );
      const rows: VersionRow[] = [];
      for (const entry of entries.slice(0, VERSION_DIFF_LIMIT)) {
        // Provenance-severed rows (entry_id nulled by a later origin delete)
        // sit outside the join key — excluded from the overlay entirely, not
        // keyed on a fallback that could collide or fake a diff pair.
        if (entry.entryId === null) {
          continue;
        }
        const mapped = versionRowOf(entry.entryId, entry.data);
        if (mapped !== undefined) {
          rows.push(mapped);
        }
      }
      return { rows, truncated: entries.length > VERSION_DIFF_LIMIT };
    },
  });
}

/**
 * The revert target (lifecycle §7): the version one step OLDER than the
 * pinned one in the newest-first chain — the append-only chain keeps both,
 * only the reference moves back. `undefined` at the first version (nothing
 * older to revert to); the UI explains that honestly instead of a silent
 * no-op.
 */
export function priorVersionOf(
  versionsNewestFirst: Array<{ id: string; ref: string; versionLabel: string }>,
  pinnedVersionId: string,
): { id: string; ref: string; versionLabel: string } | undefined {
  const index = versionsNewestFirst.findIndex((version) => version.id === pinnedVersionId);
  if (index === -1) {
    return undefined;
  }
  return versionsNewestFirst[index + 1];
}

/** The head (newest) version of a chain, or undefined before the first publish. */
export function headVersionOf<T>(versionsNewestFirst: ReadonlyArray<T>): T | undefined {
  return versionsNewestFirst[0];
}

/** The suggested next version label ("v3" after v2) — a display default, never a constraint. */
export function nextVersionLabelOf(
  versionsNewestFirst: ReadonlyArray<{ versionLabel: string }>,
): string {
  const head = headVersionOf(versionsNewestFirst);
  const match = head === undefined ? undefined : /^v(\d+)$/.exec(head.versionLabel);
  return match === null || match === undefined ? "v1" : `v${Number(match[1]) + 1}`;
}
