import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PersistQueryClientProvider,
  persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import { useQuery } from "convex/react";
import { createStore, del, get, set } from "idb-keyval";
import type { UseStore } from "idb-keyval";
import { useMemo, type ReactNode } from "react";

import { convexQueryClient } from "#/integrations/convex/provider";
import { isPersistableQueryHash } from "#/integrations/tanstack-query/light-namespaces";
import { api } from "#convex/_generated/api";

/**
 * Persisted light state (issue #58 part 5): schema rows, entries pages and
 * meta/counts survive reloads through an IndexedDB-backed TanStack Query
 * persister, so tables open instantly on a cold start and revalidate over the
 * live WebSocket connection. Geometry payloads are excluded by construction —
 * the tile path never enters the query cache, and the namespace filter below
 * keeps the heavy geometry-page queries out even when a dataset renders from
 * rows.
 *
 * Convex query keys are JSON-safe by design (`convexQuery` stores the function
 * NAME, not the opaque reference — see "Make query key serializable" in the
 * react-query integration package), so a persisted `["convexQuery",
 * "schemas:list", …]` key re-subscribes cleanly on restore: `hydrate` rebuilds
 * the entry with the persisted hash, the integration's cache listener starts a
 * fresh WebSocket watch for it, and pushes land via `setQueryData`.
 *
 * The buster is `api.schemas.maxTileCacheVersion` (part 2's version counters):
 * any geometry write bumps some dataset's version, so the next boot discards
 * persisted state exactly when data changed. The provider stays unmounted (no
 * persistence at all) until the first buster value arrives — restoring against
 * `undefined` would silently discard the store on every cold start.
 */

/** Persisted entries older than this are discarded on restore. */
const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Must be ≥ maxAge (the docs' gotcha: a smaller gcTime silently discards
 * restored cache entries). For Convex queries gcTime is also how long a
 * subscription lingers after its last observer unmounts — acceptable for the
 * light namespaces only. */
const PERSIST_GC_TIME_MS = PERSIST_MAX_AGE_MS + 24 * 60 * 60 * 1000;
/** Whole-cache rewrites are throttled to this; a buster bump that isn't
 * followed by a save simply re-fetches once on the next boot (safe, just not
 * instant). */
const PERSIST_THROTTLE_MS = 5_000;
const PERSIST_KEY = "light-query-cache";
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

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Convex pushes updates into the cache (never stale), so gcTime is
        // free to cover the persistence window. Non-Convex queries, if any
        // appear, override queryFn per query.
        gcTime: PERSIST_GC_TIME_MS,
        queryFn: convexQueryClient.queryFn(),
        queryKeyHashFn: convexQueryClient.hashFn(),
      },
    },
  });
  // Idempotent connect: after an HMR re-evaluation of this module the bridge
  // singleton is still subscribed to the previous QueryClient — connect()
  // throws then, and letting it propagate 500s every SSR request (the
  // `context` memo below would never be reached). A same-client connection
  // is detected via the integration's getter and skipped quietly.
  let alreadyConnected = false;
  try {
    alreadyConnected = convexQueryClient.queryClient === queryClient;
  } catch {
    alreadyConnected = false; // getter throws while unconnected
  }
  if (!alreadyConnected) {
    try {
      convexQueryClient.connect(queryClient);
    } catch (error) {
      console.warn("[tanstack-query] ConvexQueryClient reconnect skipped", error);
    }
  }

  context = {
    queryClient,
  };

  return context;
}

export function TanStackQueryProvider({ children }: { children: ReactNode }) {
  const { queryClient } = getContext();
  const maxTileCacheVersion = useQuery(api.schemas.maxTileCacheVersion);
  const persister = useMemo(
    () => (typeof document === "undefined" ? undefined : createLightStatePersister()),
    [],
  );
  if (maxTileCacheVersion === undefined || persister === undefined) {
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
          buster: String(maxTileCacheVersion),
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
        buster: String(maxTileCacheVersion),
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
