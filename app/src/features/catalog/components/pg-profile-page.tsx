import { Badge } from "@caden/ui/components/badge";
import { Card } from "@caden/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Calendar, UserX } from "lucide-react";

import { UserAvatar } from "#/components/user-avatar";
import { useSession } from "#/integrations/supabase/provider";
import { errorMessage } from "#/lib/errors";
import * as datasetsStore from "#/lib/store/datasets";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import * as profilesStore from "#/lib/store/profiles";

import { PgDatasetTagsWithCount } from "./pg-dataset-tags";

/**
 * The Postgres edition of `/users/$userId` (the route branches on the id's
 * origin): the profile page over the `profiles` table — the profile id IS
 * the auth uid, the same string PG datasets stamp as `created_by` — listing
 * the creator's datasets.
 *
 * The projection is the store's public one (`id`/`name`/`image`/`created_at`
 * — 0002 keeps the email column server-side), so the email subtitle renders
 * only when the viewer IS the user and comes off the auth session, exactly
 * as the header chip does. The dataset list is the store's dedicated
 * per-creator read (`datasets.listByCreator`), RLS-scoped: the creator's
 * drafts and author-only rows appear only to their creator.
 */

/** One dataset the profiled user created — the browser card's shape (tags + counts; no group details, those live on the dataset page). */
function ProfileDatasetCard({ dataset }: { dataset: DatasetSummaryRow }) {
  return (
    <Link to="/datasets/$schemaId" params={{ schemaId: dataset.id }} className="block">
      <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-0">
          <PgDatasetTagsWithCount dataset={dataset} />
          <div>
            <h3 className="text-base font-semibold">{dataset.title}</h3>
            <p className="line-clamp-2 text-sm text-muted-foreground">{dataset.description}</p>
          </div>
          <div className="flex items-center text-xs text-muted-foreground">
            <Calendar className="mr-1.5 h-3.5 w-3.5" />
            Created {new Date(dataset.createdAt).toLocaleDateString()}
          </div>
        </div>
      </Card>
    </Link>
  );
}

/** The not-found card for an id with no profile row. */
function ProfileNotFound() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserX />
          </EmptyMedia>
          <EmptyTitle>User not found</EmptyTitle>
          <EmptyDescription>
            No profile exists for this user — the account may have been deleted.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link to="/datasets" className="text-sm text-primary hover:underline">
            Back to datasets
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  );
}

// oxlint-disable-next-line eslint/complexity -- the page reads both stores' catalog rows and composes the store seams; ad hoc splitting risks these render paths (the same #82 phase-2 note the sibling Convex pages carry).
export function PgProfilePage({ profileId }: { profileId: string }) {
  const { session } = useSession(),
    // The viewer's OWN profile id is the session's user id (the profiles
    // table's primary key references auth.users). "You" badges on it.
    isMe = session !== null && session.user.id === profileId,
    sessionEmail = session === null ? undefined : session.user.email,
    profileQuery = useQuery(profilesStore.getQueryOptions({ profileId })),
    // The creator's datasets — the store's dedicated per-creator read
    // (`listByCreator`), RLS-scoped like every catalog read.
    createdQuery = useQuery(datasetsStore.listByCreatorQueryOptions({ createdBy: profileId })),
    profile = profileQuery.data,
    error = profileQuery.error;

  if (error !== null) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserX />
            </EmptyMedia>
            <EmptyTitle>Couldn't load this profile</EmptyTitle>
            <EmptyDescription>{errorMessage(error, "Please try again later.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }

  if (profile === undefined) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (profile === null) {
    return <ProfileNotFound />;
  }

  const displayName =
      profile.name ?? (isMe && sessionEmail !== undefined ? sessionEmail : profile.id),
    // The email subtitle: only ever the user themself, and only when it
    // differs from their name (the pre-migration profile page's rule).
    subtitleEmail =
      isMe && sessionEmail !== undefined && sessionEmail !== profile.name
        ? sessionEmail
        : undefined,
    created = createdQuery.data ?? [];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center gap-4">
        <UserAvatar
          className="h-16 w-16 text-lg"
          image={profile.image ?? undefined}
          name={profile.name ?? undefined}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold text-primary">{displayName}</h1>
            {isMe && <Badge variant="outline">You</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {subtitleEmail !== undefined && <span>{subtitleEmail}</span>}
            <span className="flex items-center">
              <Calendar className="mr-1.5 h-3.5 w-3.5" />
              Joined {new Date(profile.createdAt).toLocaleDateString()}
            </span>
          </p>
        </div>
      </div>

      <section>
        <h2 className="mb-4 text-xl font-semibold">
          Datasets{" "}
          <span className="text-base font-normal text-muted-foreground">({created.length})</span>
        </h2>
        {created.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center rounded-lg border px-4 text-center text-sm text-muted-foreground">
            No datasets yet.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {created.map((dataset) => (
              <ProfileDatasetCard key={dataset.id} dataset={dataset} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
