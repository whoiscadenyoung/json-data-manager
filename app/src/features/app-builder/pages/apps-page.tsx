import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Globe, LayoutDashboard, Lock, Plus } from "lucide-react";
import { useState } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { api } from "#convex/_generated/api";

import { AppDetailsDialog } from "../components/app-details-dialog";
import { PageLoading } from "../components/page-loading";

/** The creator's apps (/apps). */
export function AppsPage() {
  const apps = useQuery({ ...convexQuery(api.appBuilder.apps.list, {}) }).data,
    navigate = useNavigate(),
    [creating, setCreating] = useState(false);

  if (apps === undefined) {
    return <PageLoading />;
  }

  const openNew = () => {
    setCreating(true);
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="mb-1 text-3xl font-bold text-primary">Apps</h1>
          <p className="text-muted-foreground">
            Build pages of maps, charts and tables from your datasets — and share them by link
          </p>
        </div>
        <Button type="button" onClick={openNew}>
          <Plus data-icon="inline-start" />
          New app
        </Button>
      </div>

      {apps.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard />
            </EmptyMedia>
            <EmptyTitle>No apps yet</EmptyTitle>
            <EmptyDescription>
              Pick a few datasets, drop in a map, a chart and a table, and arrange them on a grid.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={openNew}>
              <Plus data-icon="inline-start" />
              Create your first app
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <Card key={app._id} className="relative transition-shadow hover:ring-primary/40">
              <CardHeader>
                <CardTitle>
                  {/* The stretched link makes the whole card the click target. */}
                  <Link
                    to="/apps/$appId"
                    params={{ appId: app._id }}
                    className="after:absolute after:inset-0 hover:underline"
                  >
                    {app.title}
                  </Link>
                </CardTitle>
                {app.description !== undefined && (
                  <CardDescription className="line-clamp-2">{app.description}</CardDescription>
                )}
                <CardAction>
                  {app.sharing === "link" ? (
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
                </CardAction>
              </CardHeader>
              <CardFooter className="mt-auto justify-between text-muted-foreground">
                <span>
                  {app.widgetCount} {app.widgetCount === 1 ? "widget" : "widgets"} ·{" "}
                  {app.datasetCount} {app.datasetCount === 1 ? "dataset" : "datasets"}
                </span>
                <span>Updated {new Date(app.updatedAt).toLocaleDateString()}</span>
              </CardFooter>
            </Card>
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
