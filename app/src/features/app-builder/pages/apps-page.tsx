import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { Globe, LayoutDashboard, Lock, Plus, Sparkles } from "lucide-react";
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

type AppSummary = FunctionReturnType<typeof api.appBuilder.apps.list>[number];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function AccessBadge({ app }: { app: AppSummary }) {
  if (app.example) {
    return (
      <Badge variant="secondary">
        <Sparkles data-icon="inline-start" />
        Example
      </Badge>
    );
  }
  return app.sharing === "link" ? (
    <Badge variant="secondary">
      <Globe data-icon="inline-start" />
      Shared by link
    </Badge>
  ) : (
    <Badge variant="outline">
      <Lock data-icon="inline-start" />
      Private
    </Badge>
  );
}

function AppCard({ app }: { app: AppSummary }) {
  return (
    <Card className="relative transition-shadow hover:ring-primary/40">
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
          <AccessBadge app={app} />
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

function AppGrid({ apps }: { apps: readonly AppSummary[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {apps.map((app) => (
        <AppCard key={app._id} app={app} />
      ))}
    </div>
  );
}

/** The creator's apps (/apps), plus the seeded examples anyone can open and copy. */
export function AppsPage() {
  const apps = useQuery({ ...convexQuery(api.appBuilder.apps.list, {}) }).data,
    examples = useQuery({ ...convexQuery(api.appBuilder.apps.listExamples, {}) }).data,
    navigate = useNavigate(),
    [creating, setCreating] = useState(false);

  if (apps === undefined || examples === undefined) {
    return <PageLoading />;
  }

  const openNew = () => {
    setCreating(true);
  };

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8">
      <div className="flex items-center justify-between gap-4">
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

      <section aria-labelledby="your-apps" className="flex flex-col gap-4">
        <h2 id="your-apps" className="text-lg font-semibold">
          Your apps
        </h2>
        {apps.length === 0 ? (
          <Empty className="min-h-64 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayoutDashboard />
              </EmptyMedia>
              <EmptyTitle>No apps yet</EmptyTitle>
              <EmptyDescription>
                Pick a few datasets, drop in a map, a chart and a table, and arrange them on a grid
                — or open an example below and make a copy.
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
          <AppGrid apps={apps} />
        )}
      </section>

      {examples.length > 0 && (
        <section aria-labelledby="example-apps" className="flex flex-col gap-4">
          <div>
            <h2 id="example-apps" className="text-lg font-semibold">
              Examples
            </h2>
            <p className="text-sm text-muted-foreground">
              Ready-made apps on sample data. Open one to explore it, then “Make a copy” to build on
              it.
            </p>
          </div>
          <AppGrid apps={examples} />
        </section>
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
