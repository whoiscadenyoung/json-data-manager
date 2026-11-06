import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Globe, LayoutDashboard, Lock, MapPin, Plus, Sparkles } from "lucide-react";
import { useState } from "react";

import { RouterButton } from "#/components/router-button";
import * as appsStore from "#/lib/store/apps";

import { AppDetailsDialog } from "../components/app-details-dialog";
import { PageLoading } from "../components/page-loading";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The card's badge row: example first, then sharing, then the project chip (D2's explorer posture). */
function AccessBadges({ app }: { app: appsStore.AppSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {app.example ? (
        <Badge variant="secondary">
          <Sparkles data-icon="inline-start" />
          Example
        </Badge>
      ) : app.sharing === "link" ? (
        <Badge variant="secondary">
          <Globe data-icon="inline-start" />
          Shared by link
        </Badge>
      ) : (
        <Badge variant="outline">
          <Lock data-icon="inline-start" />
          Private
        </Badge>
      )}
      {app.project !== null && (
        <Badge title={`In the project “${app.project.title}”`} variant="outline">
          <MapPin data-icon="inline-start" />
          <Link
            className="hover:underline"
            params={{ projectId: app.project.id }}
            to="/projects/$projectId"
          >
            {app.project.title}
          </Link>
        </Badge>
      )}
    </div>
  );
}

function AppCard({ app }: { app: appsStore.AppSummary }) {
  return (
    <Card className="relative transition-shadow hover:ring-primary/40">
      <CardHeader>
        <CardTitle>
          {/* The stretched link makes the whole card the click target. */}
          <Link
            to="/apps/$appId"
            params={{ appId: app.id }}
            className="after:absolute after:inset-0 hover:underline"
          >
            {app.title}
          </Link>
        </CardTitle>
        {app.description !== null && (
          <CardDescription className="line-clamp-2">{app.description}</CardDescription>
        )}
        <CardAction>
          <AccessBadges app={app} />
        </CardAction>
      </CardHeader>
      <CardFooter className="mt-auto justify-between text-muted-foreground">
        <span>
          {plural(app.pageCount, "page", "pages")} · {plural(app.widgetCount, "widget", "widgets")}{" "}
          · {plural(app.datasetCount, "dataset", "datasets")}
        </span>
        {!app.example && <span>Updated {new Date(app.updatedAt).toLocaleDateString()}</span>}
      </CardFooter>
    </Card>
  );
}

/**
 * The /apps EXPLORER (issue #259; §4.3): every app the viewer can see, with
 * project chips and publish-state badges. Creation lives in project flows —
 * the explorer keeps only the lightweight "start from here" affordance,
 * which pre-creates inside a chosen (or new) project.
 */
export function AppsPage() {
  const rows = useQuery(appsStore.listVisibleQueryOptions()),
    navigate = useNavigate(),
    [creating, setCreating] = useState(false);

  if (rows.isPending) {
    return <PageLoading />;
  }
  if (rows.isError) {
    return (
      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8">
        <div>
          <h1 className="mb-1 text-3xl font-bold text-primary">Apps</h1>
          <p className="text-muted-foreground">
            Pages of maps, charts and tables built inside projects
          </p>
        </div>
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

  const apps = rows.data.map((row) => appsStore.toSummary(row));

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="mb-1 text-3xl font-bold text-primary">Apps</h1>
          <p className="text-muted-foreground">
            Pages of maps, charts and tables built inside projects — shared by link when their
            project allows it
          </p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          <Plus data-icon="inline-start" />
          Start from here
        </Button>
      </div>

      {apps.length === 0 ? (
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard />
            </EmptyMedia>
            <EmptyTitle>No apps yet</EmptyTitle>
            <EmptyDescription>
              Apps are built inside projects — open one of yours, or start here and pick (or name)
              the project it lives in.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" />
              Create your first app
            </Button>
            <RouterButton to="/projects">Go to your projects</RouterButton>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
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
    </main>
  );
}
