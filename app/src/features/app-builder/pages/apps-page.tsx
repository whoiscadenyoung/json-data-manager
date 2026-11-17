import { Badge } from "@caden/ui/components/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Sparkles } from "lucide-react";
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
import * as appsStore from "#/lib/store/apps";

import { AppDetailsDialog } from "../components/app-details-dialog";
import { PageLoading } from "../components/page-loading";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the app holds, then when it changed (examples never change). */
export function appMeta(app: appsStore.AppSummary): string {
  const counts = [
    plural(app.pageCount, "page", "pages"),
    plural(app.widgetCount, "widget", "widgets"),
    plural(app.datasetCount, "dataset", "datasets"),
  ].join(" · ");
  return app.example ? counts : `${counts} · ${updatedOn(app.updatedAt)}`;
}

function AppRowItem({ app }: { app: appsStore.AppSummary }) {
  return (
    <ExplorerRow
      chips={
        <>
          {app.example ? (
            <Badge variant="secondary">
              <Sparkles data-icon="inline-start" />
              Example
            </Badge>
          ) : (
            <VisibilityBadge visibility={app.visibility} />
          )}
          {app.project !== null && <ProjectChip project={app.project} />}
        </>
      }
      description={app.description}
      icon={LayoutDashboard}
      meta={appMeta(app)}
      title={
        <Link
          className="after:absolute after:inset-0 hover:underline"
          params={{ appId: app.id }}
          to="/apps/$appId"
        >
          {app.title}
        </Link>
      }
    />
  );
}

const DESCRIPTION =
  "Pages of maps, charts and tables built inside projects, shared by link when their project allows it.";

/**
 * The /apps EXPLORER (issue #259; §4.3): every app the viewer can see on the
 * shared explorer row, with who can open it and its project. "New app" asks
 * which project it belongs to, then opens the builder.
 */
export function AppsPage() {
  const rows = useQuery(appsStore.listVisibleQueryOptions()),
    navigate = useNavigate(),
    [creating, setCreating] = useState(false),
    [search, setSearch] = useState(""),
    create = () => {
      setCreating(true);
    };

  if (rows.isPending) {
    return <PageLoading />;
  }
  if (rows.isError) {
    return (
      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8">
        <h1 className="text-3xl font-bold text-primary">Apps</h1>
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard />
            </EmptyMedia>
            <EmptyTitle>Couldn't load apps</EmptyTitle>
            <EmptyDescription>{rows.error.message} — try again.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }

  const apps = rows.data.map((row) => appsStore.toSummary(row)),
    shown = apps.filter((app) =>
      matchesSearch(search, [
        app.title,
        app.description,
        app.project === null ? null : app.project.title,
      ]),
    );

  return (
    <ExplorerPage
      createLabel="New app"
      description={DESCRIPTION}
      search={search}
      searchLabel="Search apps"
      title="Apps"
      onCreate={create}
      onSearch={setSearch}
    >
      {apps.length === 0 ? (
        <ExplorerEmpty
          createLabel="New app"
          description="An app lives in a project. Pick or name the project, then build the app's pages."
          icon={LayoutDashboard}
          title="No apps yet"
          onCreate={create}
        />
      ) : (
        <ExplorerList empty={`No apps match “${search}”.`}>
          {shown.map((app) => (
            <AppRowItem app={app} key={app.id} />
          ))}
        </ExplorerList>
      )}
      {creating && (
        <AppDetailsDialog
          open={creating}
          onOpenChange={setCreating}
          onSaved={async (appId) => {
            await navigate({ params: { appId }, to: "/apps/$appId/edit" });
          }}
        />
      )}
    </ExplorerPage>
  );
}
