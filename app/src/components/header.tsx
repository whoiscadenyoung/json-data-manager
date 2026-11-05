import { Button } from "@caden/ui/components/button";
import type { Session } from "@supabase/supabase-js";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatches } from "@tanstack/react-router";

import { UserAvatar } from "#/components/user-avatar";
import { supabase } from "#/integrations/supabase/client";
import { useSession } from "#/integrations/supabase/provider";
import * as profilesStore from "#/lib/store/profiles";

import { ThemeToggle } from "./theme-toggle";

/**
 * Reload after sign-out so every cached/authenticated corner of the app
 * re-reads the world as signed-out (the auth docs' recommended path). The
 * stage-7 disconnect (issue #206) made this Supabase-only: the Better Auth
 * half the Convex provider rode is retired with the provider, so there is
 * exactly one session to end.
 */
const onSignOut = async () => {
  await supabase.auth.signOut();
  window.location.reload();
};

/** The shared sign-out control (every chip variant ends with it). */
function SignOutButton() {
  return (
    <Button onClick={onSignOut} size="sm" type="button" variant="outline">
      Sign out
    </Button>
  );
}

/** One chip's visuals: avatar + truncated label, optionally the /users/$userId link. */
function UserChip(props: {
  image: string | undefined;
  label: string;
  linked: boolean;
  name: string | undefined;
  userId?: string;
}) {
  const visuals = (
    <>
      <UserAvatar className="h-6 w-6 text-[10px]" image={props.image} name={props.name} />
      <span className="max-w-48 truncate">{props.label}</span>
    </>
  );
  if (!props.linked) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          {visuals}
        </span>
        <SignOutButton />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <Link
        params={{ userId: props.userId ?? "" }}
        className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        title="View your profile"
        to="/users/$userId"
      >
        {visuals}
      </Link>
      <SignOutButton />
    </div>
  );
}

/** The signed-in user's name off the session metadata (the stage-0 projection source). */
function sessionNameOf(session: Session): string | undefined {
  const meta = session.user.user_metadata;
  return typeof meta.name === "string" ? meta.name : undefined;
}

/** The signed-in user's avatar off the session metadata. */
function sessionImageOf(session: Session): string | undefined {
  const meta = session.user.user_metadata;
  return typeof meta.avatar_url === "string" ? meta.avatar_url : undefined;
}

/** The un-linked chip while the profile row is still loading (the stage-0 shape). */
function SessionUserChip(props: { session: Session }) {
  return (
    <UserChip
      image={sessionImageOf(props.session)}
      label={sessionNameOf(props.session) ?? props.session.user.email ?? "Signed in"}
      linked={false}
      name={sessionNameOf(props.session)}
    />
  );
}

/** The linked chip from a resolved profile row — the restored pre-migration "your profile" button. */
function LinkedUserChip(props: { session: Session; profile: profilesStore.ProfileRow }) {
  return (
    <UserChip
      image={props.profile.image ?? sessionImageOf(props.session)}
      label={props.profile.name ?? props.session.user.email ?? "Signed in"}
      linked={true}
      name={props.profile.name ?? sessionNameOf(props.session)}
      userId={props.profile.id}
    />
  );
}

/**
 * The signed-in user's chip — the pre-migration "your profile" button
 * restored: avatar + name from the profiles store (the public projection —
 * the profiles table's email column is not granted to clients, 0002, so the
 * email fallback comes off the session), linking to /users/$userId. The
 * profile id IS the auth uid, which is the route param the profile page keys
 * on. The session-metadata projection holds the render while the profiles
 * read is in flight (no flash), and a missing profile row (session live, row
 * gone) degrades to plain "Signed in", exactly like the pre-migration chip.
 */
function UserMenu() {
  const { session, isLoading } = useSession();
  const profile = useQuery({
    ...profilesStore.getQueryOptions({ profileId: session === null ? "" : session.user.id }),
    // No session, no profile read (the id is the auth uid; "" is a placeholder key).
    enabled: session !== null,
  });

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
  const profileRow = profile.data;
  // The chip is LINKED only on a resolved profile row (the restored
  // pre-migration behavior); an in-flight row degrades to the session
  // projection, and a MISSING row (session live, profile trigger never ran)
  // renders bare "Signed in" — the pre-migration chip's edge shape.
  if (profileRow === undefined) {
    return <SessionUserChip session={session} />;
  }
  if (profileRow === null) {
    return <UserChip image={undefined} label="Signed in" linked={false} name={undefined} />;
  }
  return <LinkedUserChip profile={profileRow} session={session} />;
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
