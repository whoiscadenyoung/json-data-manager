import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { attachDatasetRealtime } from "#/lib/store/realtime";

import { supabase } from "./client";

/**
 * The Supabase session state: the GoTrue session (null while signed out) and
 * whether the initial read has resolved. `isLoading` is the gate's "session
 * resolving" window — true during SSR too, which knows nothing of the
 * session and renders the gate's spinner, exactly as `useConvexAuth` did.
 */
interface SupabaseAuthState {
  session: Session | null;
  isLoading: boolean;
}

/**
 * The session rides a module-level external store read through
 * `useSyncExternalStore`, not component state: the store is the single
 * subscriber to `onAuthStateChange`, every consumer re-renders from the same
 * snapshot, and no consumer needs a setState-in-effect. The tracking starts
 * lazily on first subscribe (i.e. in the browser, on mount) — module import
 * stays inert on the server.
 */
const listeners = new Set<() => void>();
let currentSession: Session | null = null;
let resolved = false;
let started = false;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function applySession(next: Session | null): void {
  if (next === currentSession && resolved) {
    return;
  }
  currentSession = next;
  resolved = true;
  notify();
}

function startSessionTracking(): void {
  if (started || typeof window === "undefined") {
    return;
  }
  started = true;
  // Both of the documented session sources: the initial cookie read, and
  // every later auth event (sign-in/-out, token refresh). `applySession`
  // dedupes the double delivery of the initial session.
  supabase.auth
    .getSession()
    .then(({ data }) => applySession(data.session))
    .catch(() => applySession(null));
  supabase.auth.onAuthStateChange((_event, next) => {
    applySession(next);
  });
}

function subscribeSession(listener: () => void): () => void {
  startSessionTracking();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSessionSnapshot = (): Session | null => currentSession;
const getResolvedSnapshot = (): boolean => resolved;
// SSR/hydration snapshot: no session, still resolving — the server renders
// the gate's spinner and the client takes over from the same state.
const getServerSessionSnapshot = (): Session | null => null;
const getServerResolvedSnapshot = (): boolean => false;

const SessionContext = createContext<SupabaseAuthState>({
  session: null,
  isLoading: true,
});

/**
 * Mounted once in the root document (inside the TanStack Query provider, so
 * cache side effects can run). The Convex provider stays mounted alongside
 * it until stage 7 (design doc §9): `useConvexAuth` keeps answering for the
 * Convex surfaces while this context answers for the PG ones.
 */
export function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient(),
    session = useSyncExternalStore(subscribeSession, getSessionSnapshot, getServerSessionSnapshot),
    resolvedNow = useSyncExternalStore(
      subscribeSession,
      getResolvedSnapshot,
      getServerResolvedSnapshot,
    );

  // A sign-out must not leave any mounted surface reading a signed-in cache.
  // Nothing else invalidates here at stage 0: sign-in navigates before the
  // gate mounts children, and no Supabase data is cached yet (the store
  // modules arrive in stage 1 — design doc §8).
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        queryClient.clear();
      }
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  // Stage 6 (issue #205): the per-active-dataset realtime layer. Mounted ONCE
  // here — inside the QueryClientProvider (cache side effects), browser-only
  // (effects never run on the server) — and driven by the query cache itself:
  // a dataset channel is open exactly while a mounted surface observes that
  // dataset's queries (see lib/store/realtime.ts).
  useEffect(() => attachDatasetRealtime(queryClient, supabase), [queryClient]);

  // Memoized identity: the session changes only on auth events, so unrelated
  // re-renders must not reconstruct the context value for every consumer.
  const value = useMemo(() => ({ session, isLoading: !resolvedNow }), [session, resolvedNow]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The Supabase session state — the gate, the header chip, and PG surfaces. */
export function useSession(): SupabaseAuthState {
  return useContext(SessionContext);
}
