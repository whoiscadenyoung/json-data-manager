import { Navigate, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useSession } from "#/integrations/supabase/provider";

/**
 * The app-wide sign-in gate (issue #135, defect 1): every route renders
 * through here, so a signed-out visitor never reaches a page whose queries
 * would run unauthenticated — the endless skeletons, TanStack error
 * screens, and false "Dataset Not Found" screens the review documented.
 *
 * The stage-7 disconnect (issue #206, design doc §9) collapsed stage 0's
 * two-session world into a single Supabase session: sign-in writes only the
 * GoTrue session, the Better Auth bridge is retired, and the gate opens on
 * the Supabase session alone — `useConvexAuth` is gone along with the
 * provider it answered for. The shape is exactly the pre-disconnect one:
 * while the session is resolving (and during SSR, which knows nothing of
 * it) the gate holds the same centered spinner the route pages render — no
 * child mounts, so no child query fires anonymously. `/signin` passes
 * through untouched.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { session, isLoading } = useSession(),
    location = useLocation(),
    pathname = location.pathname;

  if (pathname === "/signin") {
    return <>{children}</>;
  }
  if (isLoading) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (session === null) {
    // Remember where the visitor was headed (a shared app link, a dataset
    // URL) so signing in lands them there instead of on the home page.
    return (
      <Navigate to="/signin" search={pathname === "/" ? {} : { redirect: location.href }} replace />
    );
  }
  return <>{children}</>;
}

/**
 * Renders its children only once the Supabase session resolves as signed in
 * — nothing while resolving, nothing signed out, no redirect. The stage-7
 * disconnect made this Supabase-only (it gated on `useConvexAuth` while the
 * Convex provider was mounted): this wraps the root-level tile-archive
 * watchers outside the routed tree (#135 follow-up), and their queries must
 * never fire anonymously for a signed-out visitor.
 */
export function SignedInOnly({ children }: { children: ReactNode }) {
  const { session, isLoading } = useSession();
  if (isLoading || session === null) {
    return null;
  }
  return <>{children}</>;
}
