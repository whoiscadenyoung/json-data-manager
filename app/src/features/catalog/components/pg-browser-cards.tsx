import { Badge } from "@caden/ui/components/badge";
import { Card } from "@caden/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Calendar, ChevronRight, Database, FolderKanban, Layers } from "lucide-react";
import type { ReactNode } from "react";

import { UserAvatar } from "#/components/user-avatar";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import * as profilesStore from "#/lib/store/profiles";

import type { PgBrowserItem } from "../lib/pg-dataset-view";
import { PgDatasetTagsWithCount, PgDatasetTypeTags } from "./pg-dataset-tags";

/**
 * The Postgres half of the split-brain datasets browser (design §14.6: the
 * interim catalog lists BOTH stores, badged). The cards mirror the Convex
 * browser's structure exactly — tags row above the title, creator chip as a
 * SIBLING link of the card link (anchors can't nest; the chip must stay
 * clickable inside the card), group members nested beneath their group —
 * with the PG rows' trigger-maintained counts riding every list.
 */

/** Which backend a row was created on — the §14.6 source badge. */
export function SourceStoreBadge({ store }: { store: "convex" | "postgres" }) {
  return store === "postgres" ? (
    <Badge variant="outline" title="Created on the Postgres backend — the new native path.">
      <Database />
      Postgres
    </Badge>
  ) : (
    <Badge
      variant="outline"
      title="Created on the legacy Convex backend — keeps rendering as it always has."
    >
      Convex
    </Badge>
  );
}

/**
 * The creator chip: a SIBLING of the card's link (never nested inside it),
 * linking to the PG profile page. The profile read is the store's point read
 * — TanStack dedupes identical ids across cards, so a creator with many
 * datasets is one fetch, the same shape the header chip rides. Renders only
 * once the profile resolves; a missing profile row omits the chip (the
 * Convex browser's parity: chips are absent for unresolvable creators).
 */
function CreatorChip({ profileId }: { profileId: string }) {
  const query = useQuery(profilesStore.getQueryOptions({ profileId })),
    profile = query.data;
  if (profile === undefined || profile === null) {
    return null;
  }
  return (
    <Link
      to="/users/$userId"
      params={{ userId: profile.id }}
      className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title={`View ${profile.name ?? "this user"}'s profile`}
    >
      <UserAvatar
        className="h-4 w-4 text-[7px]"
        image={profile.image ?? undefined}
        name={profile.name ?? undefined}
      />
      {profile.name ?? "Unnamed"}
    </Link>
  );
}

/** The dataset's publish state (#262's explorer polish): draft until an explicit publish freezes its first version. */
function LifecycleBadge({ lifecycle }: { lifecycle: "draft" | "published" }) {
  return lifecycle === "draft" ? (
    <Badge title="A draft — visible to its project's members until published." variant="outline">
      Draft
    </Badge>
  ) : (
    <Badge
      title="Published — frozen versions live on the version chain for consumers to pin or float."
      variant="secondary"
    >
      Published
    </Badge>
  );
}

/** The "in project" chip: a SIBLING context for the card's link (no anchor nesting), naming one holding project and linking there. */
function ProjectChip({ project }: { project: { id: string; title: string } }) {
  return (
    <Badge title={`Held by the project “${project.title}”`} variant="outline">
      <FolderKanban />
      <Link
        className="hover:underline"
        params={{ projectId: project.id }}
        to="/projects/$projectId"
      >
        {project.title}
      </Link>
    </Badge>
  );
}

/**
 * One PG dataset's browser card. `trailing` renders between the creator chip
 * and the chevron — the add-to-project affordance's slot (the route owns the
 * feature dep; catalog stays feature-acyclic). `projects` names the viewer's
 * member projects holding this dataset (issue #262's provenance chips — RLS
 * scopes the read, so foreign holdings stay invisible). The badges row is a
 * SIBLING of the card's link so its project chips can be links.
 */
export function PgDatasetCard({
  dataset,
  projects,
  trailing,
}: {
  dataset: DatasetSummaryRow;
  projects?: { id: string; title: string }[];
  trailing?: ReactNode;
}) {
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      <div className="flex min-w-0 flex-1 flex-col gap-2 py-0">
        <div className="flex flex-wrap items-center gap-2">
          <SourceStoreBadge store="postgres" />
          <PgDatasetTypeTags dataset={dataset} />
          <LifecycleBadge lifecycle={dataset.lifecycle} />
          {(projects ?? []).map((project) => (
            <ProjectChip key={project.id} project={project} />
          ))}
        </div>
        <Link
          to="/datasets/$schemaId"
          params={{ schemaId: dataset.id }}
          className="flex flex-col gap-2"
        >
          <h3 className="text-base font-semibold">{dataset.title}</h3>
          <p className="line-clamp-2 text-sm text-muted-foreground">{dataset.description}</p>
          <div className="flex items-center text-xs text-muted-foreground">
            <Calendar className="mr-1.5 h-3.5 w-3.5" />
            Created {new Date(dataset.createdAt).toLocaleDateString()}
          </div>
        </Link>
      </div>
      <CreatorChip profileId={dataset.createdBy} />
      {trailing}
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </Card>
  );
}

/** A PG group item: the group's header row with its member datasets nested beneath — the hierarchical browser (groups join collections as single units; members carry the same tags + counts as standalone cards). */
export function PgGroupCard({
  item,
  collectionName,
}: {
  item: PgBrowserItem & { kind: "group" };
  /** The parent collection's display name, when the group is in one (the route resolves it from its collections read). */
  collectionName?: string;
}) {
  const group = item.group;
  return (
    <Card className="flex-col gap-0 overflow-hidden px-0 py-0">
      <Link
        to="/groups/$groupId"
        params={{ groupId: group.id }}
        className="flex flex-1 items-center gap-4 px-4 py-3 transition-shadow hover:bg-muted/40"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceStoreBadge store="postgres" />
            <Badge variant="outline">
              <Layers />
              Group
            </Badge>
            <span className="text-xs text-muted-foreground">
              {item.datasets.length === 1 ? "1 dataset" : `${item.datasets.length} datasets`}
            </span>
          </div>
          <div>
            <h3 className="text-base font-semibold">{group.name}</h3>
            <p className="line-clamp-1 text-sm text-muted-foreground">
              {group.description ??
                (group.collectionId !== null
                  ? (collectionName ?? "In a collection")
                  : "Standalone group")}
            </p>
          </div>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </Link>
      {item.datasets.length > 0 && (
        <ul className="border-t">
          {item.datasets.map((dataset) => (
            <li key={dataset.id} className="border-b last:border-b-0">
              <Link
                to="/datasets/$schemaId"
                params={{ schemaId: dataset.id }}
                className="flex flex-col gap-1 bg-muted/20 px-4 py-2 pl-8 hover:bg-muted/50"
              >
                <PgDatasetTagsWithCount dataset={dataset} />
                <p className="truncate text-sm font-medium">{dataset.title}</p>
                <p className="truncate text-xs text-muted-foreground">{dataset.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
