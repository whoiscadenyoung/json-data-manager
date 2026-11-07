import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
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
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Calendar,
  Globe,
  LayoutDashboard,
  Link2,
  Lock,
  Map as MapIcon,
  MapPinned,
  Plus,
  Users,
} from "lucide-react";
import { useState } from "react";

import { RouterButton } from "#/components/router-button";
import { PgProjectTargetSheet } from "#/features/publishing";
import * as appsStore from "#/lib/store/apps";
import * as mapsStore from "#/lib/store/maps";
import type { VisibilityLevel } from "#/lib/store/visibility";

export const Route = createFileRoute("/maps/")({
  component: MapsPage,
});

/** The rung badge — the same ladder the apps explorer shows (#262's explorer polish). */
function VisibilityBadge({ visibility }: { visibility: VisibilityLevel }) {
  return visibility === "public" ? (
    <Badge variant="secondary">
      <Globe data-icon="inline-start" />
      Public
    </Badge>
  ) : visibility === "link" ? (
    <Badge variant="secondary">
      <Link2 data-icon="inline-start" />
      By link
    </Badge>
  ) : visibility === "signed-in" ? (
    <Badge variant="secondary">
      <Users data-icon="inline-start" />
      Signed-in
    </Badge>
  ) : (
    <Badge variant="outline">
      <Lock data-icon="inline-start" />
      Members only
    </Badge>
  );
}

/**
 * The maps EXPLORER (issue #257; D2 — creation lives in projects, the
 * explorer browses). Every map the viewer can see (RLS: the projects they
 * belong to), newest first, each card naming its owning project — the chip
 * links there — plus the visibility rung and the live apps whose widgets
 * reference the map (issue #262's "used in" back-reference; the scan rides
 * the visible-apps read). The old standalone create/edit entry points are
 * retired: the header affordance targets a project (chosen or freshly named)
 * and opening a map routes into its project's editor.
 */
function MapsPage() {
  const maps = useQuery(mapsStore.listQueryOptions()),
    apps = useQuery(appsStore.listVisibleQueryOptions()),
    navigate = useNavigate(),
    [targeting, setTargeting] = useState(false),
    rows = maps.data;
  if (maps.isPending || rows === undefined) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  // One pass over the visible apps: mapId → live apps referencing it
  // (the widget payload's `mapId` key is the builder's stored-map write).
  const appsByMap = new globalThis.Map<string, { id: string; title: string }[]>();
  for (const app of apps.data ?? []) {
    for (const mapId of appsStore.appMapIds(app)) {
      const used = appsByMap.get(mapId) ?? [];
      used.push({ id: app.id, title: app.title });
      appsByMap.set(mapId, used);
    }
  }
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="mb-1 text-3xl font-bold text-primary">Maps</h1>
          <p className="text-muted-foreground">
            Every map in your projects — create and edit them inside a project's Maps view.
          </p>
        </div>
        <Button
          onClick={() => {
            setTargeting(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Start from here
        </Button>
      </div>

      {rows.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MapPinned />
            </EmptyMedia>
            <EmptyTitle>No maps yet</EmptyTitle>
            <EmptyDescription>
              Maps live in projects now — start here and pick (or name) the project, then create the
              map in its Maps view.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => {
                setTargeting(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create your first map
            </Button>
            <RouterButton to="/projects">Go to your projects</RouterButton>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((map) => {
            const usedIn = appsByMap.get(map.id) ?? [];
            return (
              <Card
                className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md"
                key={map.id}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2 py-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <VisibilityBadge visibility={map.visibility} />
                    {map.project !== null && (
                      <Badge
                        title="The project that owns this map — maps are project rows."
                        variant="outline"
                      >
                        <MapIcon className="h-3 w-3" />
                        <Link
                          className="hover:underline"
                          params={{ projectId: map.project.id }}
                          to="/projects/$projectId"
                        >
                          {map.project.title}
                        </Link>
                      </Badge>
                    )}
                    {usedIn.map((app) => (
                      <Badge
                        key={app.id}
                        title={`Live in the app “${app.title}”`}
                        variant="outline"
                      >
                        <LayoutDashboard className="h-3 w-3" />
                        <Link
                          className="hover:underline"
                          params={{ appId: app.id }}
                          to="/apps/$appId"
                        >
                          {app.title}
                        </Link>
                      </Badge>
                    ))}
                  </div>
                  <Link
                    className="flex flex-col gap-2"
                    params={{ mapId: map.id, projectId: map.projectId }}
                    to="/projects/$projectId/maps/$mapId"
                  >
                    <h3 className="text-base font-semibold">{map.name}</h3>
                    {map.description !== null && (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {map.description}
                      </p>
                    )}
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Calendar className="mr-1.5 h-3.5 w-3.5" />
                      Updated {new Date(map.updatedAt).toLocaleDateString()}
                    </div>
                  </Link>
                </div>
                <RouterButton
                  params={{ mapId: map.id, projectId: map.projectId }}
                  to="/projects/$projectId/maps/$mapId"
                  variant="outline"
                >
                  Open
                </RouterButton>
              </Card>
            );
          })}
        </div>
      )}

      <PgProjectTargetSheet
        description="Maps live in projects — pick (or name) one, then create the map in its Maps view."
        onOpenChange={setTargeting}
        onTarget={async (projectId) => {
          await navigate({ params: { projectId }, to: "/projects/$projectId" });
        }}
        open={targeting}
        title="Create a map"
      />
    </main>
  );
}
