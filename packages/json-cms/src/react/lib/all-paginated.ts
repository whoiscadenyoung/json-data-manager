"use client";

import { usePaginatedQuery } from "convex/react";
import type { PaginatedQueryArgs, PaginatedQueryItem, PaginatedQueryReference } from "convex/react";
import { useEffect, useState } from "react";

// Requested page size — the server (see `listGeometries`/
// `listGeometriesByCollection` in the component) clamps its own actual read
// size well under Convex's per-execution byte budget regardless of what's
// requested here, so this only affects round-trip count, never safety.
const PAGE_SIZE = 200;

interface AllPaginatedState<Item> {
  argsKey: string;
  hasCompletedPass: boolean;
  results: Item[];
}

function initialState<Item>(argsKey: string): AllPaginatedState<Item> {
  return { argsKey, hasCompletedPass: false, results: [] };
}

/**
 * The state this hook should carry into the next render, given what's
 * stored now and what this render's `usePaginatedQuery` call just
 * produced. Returns `prev` itself (not merely an equal-looking object)
 * whenever nothing has actually changed — the caller relies on that
 * reference equality to skip a pointless `setState`, since constructing a
 * fresh object every render regardless of content would call `setState` on
 * every render and re-trigger itself indefinitely.
 */
function nextAllPaginatedState<Item>(
  prev: AllPaginatedState<Item>,
  argsKey: string,
  status: string,
  results: Item[],
): AllPaginatedState<Item> {
  if (prev.argsKey !== argsKey) {
    // A new query target — nothing from the previous one carries over;
    // start fresh from whatever this render's own status/results already are.
    return { argsKey, hasCompletedPass: status === "Exhausted", results };
  }
  if (status === "Exhausted") {
    // A fully completed pass is always authoritative — replace whatever
    // was there before, growing or shrinking as needed.
    return prev.results === results && prev.hasCompletedPass ? prev : { argsKey, hasCompletedPass: true, results };
  }
  if (prev.hasCompletedPass) {
    // A later pass reset mid-flight while a complete snapshot from a prior
    // pass already exists — deliberately keep serving that snapshot; only
    // a fresh completed pass (above) replaces it.
    return prev;
  }
  // Still on this query's very first pass (never yet reached "Exhausted").
  // `usePaginatedQuery` resets to a blank first page whenever Convex
  // invalidates a cursor (documented behavior) — for a dataset large
  // enough to need many pages, that reset happening before the first pass
  // ever finishes is the common case, not an edge case. So never let a
  // reset regress what's already rendered; only grow toward the eventual
  // complete pass, which is what actually corrects any real shrink (e.g.
  // rows genuinely deleted).
  return results.length > prev.results.length ? { argsKey, hasCompletedPass: false, results } : prev;
}

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
 *
 * A large dataset can need hundreds of these small reads to finish one full
 * pass. `usePaginatedQuery` resets to a blank first page whenever a cursor
 * is invalidated by concurrent writes (documented behavior — see its own
 * JSDoc), which for a dataset that size can easily happen more than once
 * before a full pass ever completes. Rather than mirroring that reset into
 * the caller (which would mean repeatedly flashing back to "nothing
 * loaded" and hiding whatever had already rendered), this hook accumulates
 * the best-known result set in state: it renders growing partial results
 * as the very first pass streams in — never letting a mid-pass reset
 * shrink what's already shown, only grow it — and once a pass has fully
 * completed, switches to always trusting the latest completed pass
 * (growing or shrinking as needed), through any later reset, until the
 * next one finishes.
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

  const argsKey = args === "skip" ? "skip" : JSON.stringify(args),
    [state, setState] = useState<AllPaginatedState<PaginatedQueryItem<Query>>>(() =>
      initialState(argsKey),
    );

  // Adjusted synchronously during render (not in an effect) whenever this
  // render's inputs call for a different snapshot than what's stored — the
  // "adjusting state when a prop changes" pattern: React re-renders
  // immediately with the new state before committing, so this never paints
  // a stale frame, and unlike doing the equivalent in an effect it doesn't
  // trigger an extra cascading render.
  const nextState = nextAllPaginatedState(state, argsKey, status, results);
  if (nextState !== state) {
    setState(nextState);
  }

  return {
    isLoading: !nextState.hasCompletedPass && nextState.results.length === 0,
    results: nextState.results,
  };
}
