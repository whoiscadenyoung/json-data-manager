"use client";

import { usePaginatedQuery } from "convex/react";
import type { PaginatedQueryArgs, PaginatedQueryReference } from "convex/react";
import { useEffect } from "react";

// Requested page size — the server (see `listGeometries`/
// `listGeometriesByCollection` in the component) clamps its own actual read
// size well under Convex's per-execution byte budget regardless of what's
// requested here, so this only affects round-trip count, never safety.
const PAGE_SIZE = 200;

/**
 * Auto-loads every page of a Convex paginated query (`listGeometries`,
 * `listGeometriesByCollection`, or any query shaped like them) instead of
 * exposing Convex's own `usePaginatedQuery`'s incremental "load more" API —
 * built for map rendering, which needs the complete result set, not a
 * growing list. Both of those queries are paginated specifically because a
 * dataset's cumulative geometry payload can exceed Convex's per-execution
 * read-byte budget even though each individual row is safely under its own
 * document-size limit (see their doc comments) — this hook is what lets a
 * consumer keep working with one flat array despite that, fetching it across
 * several small, budget-safe reads instead of one big one.
 */
export function useAllPaginated<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | "skip",
) {
  const { results, loadMore, status } = usePaginatedQuery(query, args, {
    initialNumItems: PAGE_SIZE,
  });

  useEffect(() => {
    if (status === "CanLoadMore") {
      loadMore(PAGE_SIZE);
    }
  }, [status, loadMore]);

  return {
    // Only "Exhausted" means every page has actually been fetched — treat
    // "CanLoadMore" as still-loading too, since this hook always keeps
    // going until there's nothing left, unlike Convex's own hook (which
    // treats "CanLoadMore" as a normal, load-more-on-demand resting state).
    isLoading: status !== "Exhausted",
    results,
  };
}
