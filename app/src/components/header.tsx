import { Link } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";

import { api } from "#convex/_generated/api";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { ThemeToggle } from "./theme-toggle";

/**
 * Reload after sign-out so every cached/authenticated corner of the app
 * re-reads the world as signed-out (the auth docs' recommended path).
 */
const onSignOut = async () => {
  await authClient.signOut();
  window.location.reload();
};

/**
 * The signed-in user's name (or email, if they never set a name) — served
 * from the `users` mirror the auth component's triggers keep in sync.
 */
function UserMenu() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const me = useQuery(api.users.me);

  if (isLoading) {
    return <div className="h-6 w-28 animate-pulse rounded bg-muted" />;
  }
  if (!isAuthenticated) {
    return (
      <Link
        to="/signin"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        Sign in
      </Link>
    );
  }
  const label =
    me === undefined || me === null ? "Signed in" : (me.name ?? me.email);
  return (
    <div className="flex items-center gap-3">
      <span className="max-w-48 truncate text-sm text-muted-foreground" title={label}>
        {label}
      </span>
      <Button onClick={onSignOut} size="sm" type="button" variant="outline">
        Sign out
      </Button>
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 px-6 backdrop-blur-lg">
      <div className="flex h-14 items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-sm font-semibold">
            JSON Data Manager
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link
              to="/datasets"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Datasets
            </Link>
            <Link
              to="/collections"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Collections
            </Link>
            <Link
              to="/maps"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Maps
            </Link>
            <Link
              to="/dashboard"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Dashboard
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <UserMenu />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
