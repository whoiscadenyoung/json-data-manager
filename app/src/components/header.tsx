import { Button } from "@caden/ui/components/button";
import { Link, useMatches } from "@tanstack/react-router";

import { UserAvatar } from "#/components/user-avatar";
import { supabase } from "#/integrations/supabase/client";
import { useSession } from "#/integrations/supabase/provider";

import { ThemeToggle } from "./theme-toggle";

/**
 * Reload after sign-out so every cached/authenticated corner of the app
 * re-reads the world as signed-out (the auth docs' recommended path).
 */
const onSignOut = async () => {
  await supabase.auth.signOut();
  window.location.reload();
};

/**
 * The signed-in user's name (or email, if they never set a name) — read
 * straight off the Supabase session's GoTrue user (design doc §9 rewires the
 * chip at stage 0; a profiles read replaces the user-metadata projection when
 * the store modules land, §3.1/§8.1).
 */
function UserMenu() {
  const { session, isLoading } = useSession();

  if (isLoading) {
    return <div className="h-6 w-28 animate-pulse rounded bg-muted" />;
  }
  if (session === null) {
    return (
      <Link to="/signin" className="text-sm text-muted-foreground hover:text-foreground">
        Sign in
      </Link>
    );
  }
  const meta = session.user.user_metadata,
    name = typeof meta.name === "string" ? meta.name : undefined,
    image = typeof meta.avatar_url === "string" ? meta.avatar_url : undefined,
    label = name ?? session.user.email ?? "Signed in";
  return (
    <div className="flex items-center gap-3">
      <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <UserAvatar className="h-6 w-6 text-[10px]" image={image} name={name} />
        <span className="max-w-48 truncate">{label}</span>
      </span>
      <Button onClick={onSignOut} size="sm" type="button" variant="outline">
        Sign out
      </Button>
    </div>
  );
}

export function Header() {
  // A route opts out with `staticData: { hideHeader: true }` (router.tsx).
  const hidden = useMatches({
    select: (matches) => matches.some((match) => match.staticData.hideHeader === true),
  });
  if (hidden) {
    return null;
  }
  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 px-6 backdrop-blur-lg">
      <div className="flex h-14 items-center justify-between">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-sm font-semibold">
            JSON Data Manager
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link
              to="/projects"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Projects
            </Link>
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
              to="/apps"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Apps
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
