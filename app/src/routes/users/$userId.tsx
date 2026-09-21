import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Calendar, UserX } from "lucide-react";

import { DatasetTypeTags } from "#/components/dataset-type-tags";
import { Badge } from "#/components/ui/badge";
import { Card } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { UserAvatar } from "#/components/user-avatar";
import { api } from "#convex/_generated/api";

export const Route = createFileRoute("/users/$userId")({
  component: UserProfilePage,
});

type ProfileDataset = FunctionReturnType<typeof api.users.profile>["datasets"][number];

/**
 * One dataset the profiled user created — the browser card's shape, minus
 * the group/organization details that live on the dataset page itself.
 */
function ProfileDatasetCard({ dataset }: { dataset: ProfileDataset }) {
  return (
    <Link to="/datasets/$schemaId" params={{ schemaId: dataset._id }} className="block">
      <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-0">
          <div className="flex flex-wrap items-center gap-2">
            <DatasetTypeTags dataset={dataset} />
            <span className="text-xs text-muted-foreground">
              {dataset.fieldCount} {dataset.fieldCount === 1 ? "field" : "fields"}
            </span>
          </div>
          <div>
            <h3 className="text-base font-semibold">{dataset.title}</h3>
            <p className="line-clamp-2 text-sm text-muted-foreground">{dataset.description}</p>
          </div>
          <div className="flex items-center text-xs text-muted-foreground">
            <Calendar className="mr-1.5 h-3.5 w-3.5" />
            Created {new Date(dataset._creationTime).toLocaleDateString()}
          </div>
        </div>
      </Card>
    </Link>
  );
}

function UserProfilePage() {
  const { userId } = Route.useParams(),
    // `userId` is the Better Auth user id — the same string the component
    // stamps as `schemas.createdBy` (users.authId on the mirror row).
    profile = useQuery(api.users.profile, { authId: userId }),
    me = useQuery(api.users.me),
    isMe = me !== undefined && me !== null && me.authId === userId;

  if (profile === undefined) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (profile.user === null) {
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

  const user = profile.user,
    displayName = user.name ?? user.email;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center gap-4">
        <UserAvatar className="h-16 w-16 text-lg" image={user.image} name={user.name} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold text-primary">{displayName}</h1>
            {isMe && <Badge variant="outline">You</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {user.name !== undefined && user.name !== user.email && <span>{user.email}</span>}
            <span className="flex items-center">
              <Calendar className="mr-1.5 h-3.5 w-3.5" />
              Joined {new Date(user._creationTime).toLocaleDateString()}
            </span>
          </p>
        </div>
      </div>

      <section>
        <h2 className="mb-4 text-xl font-semibold">
          Datasets{" "}
          <span className="text-base font-normal text-muted-foreground">
            ({profile.datasets.length})
          </span>
        </h2>
        {profile.datasets.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center rounded-lg border px-4 text-center text-sm text-muted-foreground">
            No datasets yet.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {profile.datasets.map((dataset) => (
              <ProfileDatasetCard key={dataset._id} dataset={dataset} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
