import { Navigate, useLocation } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import type { ReactNode } from "react";

/**
 * The app-wide sign-in gate (issue #135, defect 1): every route renders
 * through here, so a signed-out visitor never reaches a page whose queries
 * would throw "You're signed out" — the endless skeletons, TanStack error
 * screens, and false "Dataset Not Found" screens the review documented.
 *
 * Shape: the root document renders this around its routed children (the
 * `beforeLoad`-in-the-root alternative needs auth state synchronously, which
 * no reactive session store exposes; the `_authed` pathless-layout variant
 * would move every route file for the same behavior). While the session is
 * resolving (and during SSR, which knows nothing of the session) it holds
 * the same centered spinner the route pages render — no child mounts, so no
 * child query fires anonymously. `/signin` passes through untouched.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth(),
    pathname = useLocation().pathname;

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
  if (!isAuthenticated) {
    return <Navigate to="/signin" replace />;
  }
  return <>{children}</>;
}
