import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PersistQueryClientProvider,
  persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import { createStore, del, get, set } from "idb-keyval";
import type { UseStore } from "idb-keyval";
import { useMemo, type ReactNode } from "react";

import { isPersistableQueryHash } from "#/integrations/tanstack-query/light-namespaces";

/**
 * Persisted light state (issue #58 part 5; design doc §8.2): schema rows, entries pages and meta/counts
 * survive reloads through an IndexedDB-backed TanStack Query persister, so
 * tables open instantly on a cold start and revalidate on the next mount.
 * Geometry payloads are excluded by construction — the tile path never
 * enters the query cache, and the namespace filter below keeps the heavy
 * geometry-page queries out even when a dataset renders from rows.
 *
 * The light queries are the store modules' `pg:*` keys (each carries its
 * own `queryFn` in its `queryOptions`, so the QueryClient needs no default
 * queryFn). The store keys revalidate on mount, so the buster is a plain
 * constant — a bump of `PERSIST_BUSTER` (or `PERSIST_KEY`) is the way to
 * force a clean discard of persisted state.
 */

/** Persisted entries older than this are discarded on restore. */
const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Must be ≥ maxAge (the docs' gotcha: a smaller gcTime silently discards
 * restored cache entries). */
const PERSIST_GC_TIME_MS = PERSIST_MAX_AGE_MS + 24 * 60 * 60 * 1000;
/** Whole-cache rewrites are throttled to this; a buster bump that isn't
 * followed by a save simply re-fetches once on the next boot (safe, just not
 * instant). */
const PERSIST_THROTTLE_MS = 5_000;
// Bumped when the persisted namespaces change shape (§8.2), so a cache
// persisted under the old names is never restored.
const PERSIST_KEY = "light-query-cache-v3";
/** See the doc comment: the cache-generation marker `persistQueryClient`
 * stores alongside the payload. */
const PERSIST_BUSTER = "pg-v1";
const IDB_DB_NAME = "json-cms";
const IDB_STORE_NAME = "tanstack-query";

/**
 * The docs' IndexedDB persister recipe (`idb-keyval` for the string payload).
 * The store is created lazily — `createStore` touches `indexedDB`, which
 * doesn't exist during SSR.
 */
function createLightStatePersister() {
  let idbStore: UseStore | undefined;
  const store = () => {
    idbStore ??= createStore(IDB_DB_NAME, IDB_STORE_NAME);
    return idbStore;
  };
  return createAsyncStoragePersister({
    key: PERSIST_KEY,
    storage: {
      getItem: async (key) => await get(key, store()),
      removeItem: async (key) => {
        await del(key, store());
      },
      // The v5 AsyncStorage contract passes (key, value) — binding a single
      // parameter here silently stores the KEY as the payload.
      setItem: async (key, value) => {
        await set(key, value, store());
      },
    },
    throttleTime: PERSIST_THROTTLE_MS,
  });
}

let context:
  | {
      queryClient: QueryClient;
    }
  | undefined;

export function getContext() {
  if (context) {
    return context;
  }

  // Every live query carries its own `queryFn` (the store modules'
  // `queryOptions`). `gcTime` keeps covering the persistence window.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: PERSIST_GC_TIME_MS,
      },
    },
  });

  context = {
    queryClient,
  };

  return context;
}

export function TanStackQueryProvider({ children }: { children: ReactNode }) {
  const { queryClient } = getContext();
  const persister = useMemo(
    () => (typeof document === "undefined" ? undefined : createLightStatePersister()),
    [],
  );
  if (persister === undefined) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return (
    <PersistQueryClientProvider
      client={queryClient}
      onSuccess={() => {
        // The subscription only saves on cache CHANGES, which a quiet page
        // never produces after boot — persist whatever is cached right away
        // so the very first session already warms the store.
        void persistQueryClientSave({
          buster: PERSIST_BUSTER,
          dehydrateOptions: {
            shouldDehydrateQuery: (query) =>
              query.state.status === "success" && isPersistableQueryHash(query.queryHash),
          },
          persister,
          queryClient,
        }).catch((error: unknown) => {
          console.warn("[light-state] initial save failed", error);
        });
      }}
      persistOptions={{
        buster: PERSIST_BUSTER,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) =>
            query.state.status === "success" && isPersistableQueryHash(query.queryHash),
        },
        maxAge: PERSIST_MAX_AGE_MS,
        persister,
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
