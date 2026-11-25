import { Badge } from "@caden/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Map as MapIcon } from "lucide-react";
import { useState } from "react";

import {
  ExplorerEmpty,
  ExplorerList,
  ExplorerPage,
  ExplorerRow,
  matchesSearch,
  ProjectChip,
  updatedOn,
} from "#/components/explorer";
import { VisibilityBadge } from "#/components/visibility-badge";
import { ProjectTargetSheet } from "#/features/publishing";
import * as appsStore from "#/lib/store/apps";
import * as mapsStore from "#/lib/store/maps";

export const Route = createFileRoute("/maps/")({
  component: MapsPage,
});

type AppRef = { id: string; title: string };

/** mapId → the visible apps whose widgets show it (one pass over the apps). */
function appsByMapOf(apps: readonly appsStore.AppRow[] | undefined): Map<string, AppRef[]> {
  const byMap = new globalThis.Map<string, AppRef[]>();
  for (const app of apps ?? []) {
    for (const mapId of appsStore.appMapIds(app)) {
      byMap.set(mapId, [...(byMap.get(mapId) ?? []), { id: app.id, title: app.title }]);
    }
  }
  return byMap;
}

function UsedInChips({ apps }: { apps: readonly AppRef[] }) {
  return apps.map((app) => (
    <Badge
      className="relative z-10"
      key={app.id}
      title={`Shown in the app “${app.title}”`}
      variant="outline"
    >
      <LayoutDashboard data-icon="inline-start" />
      <Link className="hover:underline" params={{ appId: app.id }} to="/apps/$appId">
        {app.title}
      </Link>
    </Badge>
  ));
}

/**
 * The maps EXPLORER (issue #257; D2 — creation lives in projects, the
 * explorer browses). Every map the viewer can see, newest first, on the
 * shared explorer row: who can open it, its project, and the apps that show
 * it. "New map" asks which project, then opens that project's Maps page.
 */
function MapsPage() {
  const maps = useQuery(mapsStore.listQueryOptions()),
    apps = useQuery(appsStore.listVisibleQueryOptions()),
    navigate = useNavigate(),
    [targeting, setTargeting] = useState(false),
    [search, setSearch] = useState(""),
    rows = maps.data,
    create = () => {
      setTargeting(true);
    };
  if (maps.isPending || rows === undefined) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  const appsByMap = appsByMapOf(apps.data),
    shown = rows.filter((map) =>
      matchesSearch(search, [
        map.name,
        map.description,
        map.project === null ? null : map.project.title,
      ]),
    );
  return (
    <ExplorerPage
      createLabel="New map"
      search={search}
      searchLabel="Search maps"
      to="/maps"
      onCreate={create}
      onSearch={setSearch}
    >
      {rows.length === 0 ? (
        <ExplorerEmpty
          createLabel="New map"
          description="A map lives in a project. Pick or name the project, then add the map on its Maps page."
          icon={MapIcon}
          title="No maps yet"
          onCreate={create}
        />
      ) : (
        <ExplorerList empty={`No maps match “${search}”.`}>
          {shown.map((map) => (
            <ExplorerRow
              chips={
                <>
                  <VisibilityBadge visibility={map.visibility} />
                  {map.project !== null && <ProjectChip project={map.project} />}
                  <UsedInChips apps={appsByMap.get(map.id) ?? []} />
                </>
              }
              description={map.description}
              icon={MapIcon}
              key={map.id}
              meta={updatedOn(map.updatedAt)}
              title={
                <Link
                  className="after:absolute after:inset-0 hover:underline"
                  params={{ mapId: map.id, projectId: map.projectId }}
                  to="/projects/$projectId/maps/$mapId"
                >
                  {map.name}
                </Link>
              }
            />
          ))}
        </ExplorerList>
      )}
      <ProjectTargetSheet
        description="Maps live in projects. Pick one, or name a new one, and add the map on its Maps page."
        onOpenChange={setTargeting}
        onTarget={async (projectId) => {
          await navigate({ params: { projectId }, to: "/projects/$projectId/maps" });
        }}
        open={targeting}
        title="Which project is the map for?"
      />
    </ExplorerPage>
  );
}
