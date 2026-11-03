import { Navigate, useLocation } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import type { ReactNode } from "react";

import { useSession } from "#/integrations/supabase/provider";

/**
 * The app-wide sign-in gate (issue #135, defect 1): every route renders
 * through here, so a signed-out visitor never reaches a page whose queries
 * would throw "You're signed out" — the endless skeletons, TanStack error
 * screens, and false "Dataset Not Found" screens the review documented.
 *
 * Since the stage-0 auth swap (design doc §9) the gate reads the Supabase
 * session (`useSession`), not the Convex one: the sign-in surface writes a
 * Supabase session, so the gate has to answer from it. The shape is exactly
 * the Convex-era one: while the session is resolving (and during SSR, which
 * knows nothing of the session) it holds the same centered spinner the route
 * pages render — no child mounts, so no child query fires anonymously.
 * `/signin` passes through untouched.
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
 * Renders its children only once the CONVEX session resolves as signed in —
 * nothing while resolving, nothing signed out, no redirect. Deliberately
 * still Convex (design doc §9: `useConvexAuth` keeps answering for Convex
 * surfaces until stage 7): this wraps the root-level Convex watchers outside
 * the routed tree (#135 follow-up), and their queries must never fire
 * anonymously, nor reach the provider-level boundary whose screen would
 * replace the gate's redirect.
 */
export function SignedInOnly({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (isLoading || !isAuthenticated) {
    return null;
  }
  return <>{children}</>;
}
