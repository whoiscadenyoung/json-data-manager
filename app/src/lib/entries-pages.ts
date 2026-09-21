/**
 * Server-side paginated entries for the dataset page (issue #54).
 *
 * The table used to read `api.entries.list` — one unbounded `.collect()` of
 * every entry — which hits Convex's ~16 MiB per-execution read cap somewhere
 * around a 20k-row import and fails the page outright. `entries.listPage`
 * paginates server-side instead; this module bridges it to the TanStack cache
 * as one cursor-chained page per query.
 *
 * Pages deliberately go through the `convexQuery` bridge (not convex/react's
 * `usePaginatedQuery`, which bypasses the TanStack cache) so every page stays
 * a light-namespaced cache entry — persisted by the part-5 store and rendered
 * from it on a cold start. That makes `ENTRIES_PAGE_SIZE` part of the
 * persisted query hash: keep it a stable constant, never a prop.
 */
import { convexQuery } from "@convex-dev/react-query";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useMemo, useState } from "react";

import { env } from "#/env";
import { api } from "#convex/_generated/api";

export type EntryDoc = FunctionReturnType<typeof api.entries.listPage>["page"][number];
type EntriesPage = FunctionReturnType<typeof api.entries.listPage>;
type EntriesPageResult = UseQueryResult<EntriesPage>;

/** Rows per page. In the persisted query hash — never change it per call site. */
export const ENTRIES_PAGE_SIZE = 200;

function pageQuery(schemaId: string, cursor: string | null) {
  return convexQuery(api.entries.listPage, {
    paginationOpts: { cursor, numItems: ENTRIES_PAGE_SIZE },
    schemaId,
  });
}

/** The cursors to subscribe for `schemaId` — a fresh chain when the dataset
 * changed under a still-mounted hook (same route component, new param). */
function activeCursors(
  chain: { cursors: Array<string | null>; schemaId: string },
  schemaId: string,
): Array<string | null> {
  return chain.schemaId === schemaId ? chain.cursors : [null];
}

/** Appends the next cursor once the last page has resolved; idempotent under
 * repeated calls (double clicks, scroll bursts) before React re-renders. */
function appendCursor(
  prev: { cursors: Array<string | null>; schemaId: string },
  schemaId: string,
  prevChainLength: number,
  continueCursor: string,
): { cursors: Array<string | null>; schemaId: string } {
  const active = activeCursors(prev, schemaId);
  if (active.length !== prevChainLength || active[active.length - 1] === continueCursor) {
    return prev;
  }
  return { cursors: [...active, continueCursor], schemaId };
}

/** One query slot's page data, or undefined while pending/unmounted. */
function pageData(result: EntriesPageResult | undefined): EntriesPage | undefined {
  return result === undefined ? undefined : result.data;
}

/** One query slot's rows, or none while pending. */
function pageRows(result: EntriesPageResult): EntryDoc[] {
  const data = pageData(result);
  return data === undefined ? [] : data.page;
}

/** Page gate: true only while the FIRST page is pending — later pages stream
 * in below the fold and must never blank the page. */
function isLoadingFirstPage(results: Array<EntriesPageResult>): boolean {
  const first = results[0];
  return first === undefined ? true : first.isLoading;
}

/** True while a load-more page beyond the first is in flight. */
function isLoadingMorePages(results: Array<EntriesPageResult>, chainLength: number): boolean {
  const last = results[chainLength - 1];
  return chainLength > 1 && last !== undefined && last.isLoading;
}

/**
 * The dataset's entries as a growing set of cursor-chained pages. `loadMore`
 * (wired to the table's scroll-near-end and its Load-more button) appends the
 * next cursor once the last page has resolved; repeated calls before that are
 * no-ops, so bursty scroll events can't duplicate a page.
 */
export function useEntriesPages(schemaId: string) {
  // Keyed on schemaId so navigating between datasets restarts the chain
  // instead of replaying the old dataset's cursors against the new one.
  const [chain, setChain] = useState<{ cursors: Array<string | null>; schemaId: string }>({
    cursors: [null],
    schemaId,
  });
  const cursors = activeCursors(chain, schemaId);

  const results = useQueries({
    queries: useMemo(
      () => cursors.map((cursor) => pageQuery(schemaId, cursor)),
      [cursors, schemaId],
    ),
  });

  const lastPage = pageData(results[cursors.length - 1]);

  const loadMore = useCallback(() => {
    if (lastPage === undefined || lastPage.isDone) {
      return;
    }
    setChain((prev) => appendCursor(prev, schemaId, cursors.length, lastPage.continueCursor));
  }, [cursors.length, lastPage, schemaId]);

  const entries = useMemo(() => results.flatMap(pageRows), [results]);

  return {
    entries,
    isLoading: isLoadingFirstPage(results),
    isLoadingMore: isLoadingMorePages(results, cursors.length),
    isComplete: lastPage !== undefined && lastPage.isDone,
    canLoadMore: lastPage !== undefined && !lastPage.isDone,
    loadMore,
  };
}

// Mirrors `geometry-rows.ts`: exports materialize rarely, and `ConvexClient`
// shares the worker's proven pattern for imperative one-shot calls.
let client: ConvexClient | undefined;

function sharedClient(): ConvexClient {
  client ??= new ConvexClient(env.VITE_CONVEX_URL);
  return client;
}

/**
 * Pages `api.entries.listPage` to exhaustion — the imperative all-rows read
 * the export dialog needs (it writes one file containing the whole dataset),
 * on demand only when an export is actually confirmed. Not a hook: a large
 * dataset's full row set should never become a standing subscription.
 */
export async function fetchAllEntryRows(schemaId: string): Promise<EntryDoc[]> {
  const convex = sharedClient(),
    rows: EntryDoc[] = [];
  let cursor: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor; inherently sequential.
    const page: EntriesPage = await convex.query(api.entries.listPage, {
      paginationOpts: { cursor, numItems: 500 },
      schemaId,
    });
    rows.push(...page.page);
    if (page.isDone) {
      return rows;
    }
    cursor = page.continueCursor;
  }
}
