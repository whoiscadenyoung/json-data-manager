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
import { Link, createFileRoute } from "@tanstack/react-router";
import { Calendar, Map as MapIcon, MapPinned } from "lucide-react";

import { RouterButton } from "#/components/router-button";
import * as mapsStore from "#/lib/store/maps";

export const Route = createFileRoute("/maps/")({
  component: MapsPage,
});

/**
 * The maps EXPLORER (issue #257; D2 — creation lives in projects, the
 * explorer browses). Every map the viewer can see (RLS: the projects they
 * belong to), newest first, each card naming its owning project — the chip
 * links there. The old standalone create/edit entry points are retired:
 * opening a map routes into its project's editor.
 */
function MapsPage() {
  const maps = useQuery(mapsStore.listQueryOptions()),
    rows = maps.data;
  if (maps.isPending || rows === undefined) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="mb-1 text-3xl font-bold text-primary">Maps</h1>
        <p className="text-muted-foreground">
          Every map in your projects — create and edit them inside a project's Maps view.
        </p>
      </div>

      {rows.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MapPinned />
            </EmptyMedia>
            <EmptyTitle>No maps yet</EmptyTitle>
            <EmptyDescription>
              Maps live in projects now — create one from a project's Maps view and it shows up
              here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <RouterButton to="/projects">
              <MapIcon className="mr-2 h-4 w-4" />
              Go to Projects
            </RouterButton>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((map) => (
            <Card
              className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md"
              key={map.id}
            >
              <Link
                className="flex min-w-0 flex-1 flex-col gap-2 py-0"
                params={{ mapId: map.id, projectId: map.projectId }}
                to="/projects/$projectId/maps/$mapId"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    title="The project that owns this map — maps are project rows."
                    variant="outline"
                  >
                    <MapIcon className="h-3 w-3" />
                    {map.project.title}
                  </Badge>
                </div>
                <div>
                  <h3 className="text-base font-semibold">{map.name}</h3>
                  {map.description !== null && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{map.description}</p>
                  )}
                </div>
                <div className="flex items-center text-xs text-muted-foreground">
                  <Calendar className="mr-1.5 h-3.5 w-3.5" />
                  Updated {new Date(map.updatedAt).toLocaleDateString()}
                </div>
              </Link>
              <RouterButton
                params={{ mapId: map.id, projectId: map.projectId }}
                to="/projects/$projectId/maps/$mapId"
                variant="outline"
              >
                Open
              </RouterButton>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
