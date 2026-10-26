import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { Copy, Link2, LayoutDashboard, Pencil, Share2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import type { AppPage } from "#convex/appBuilder/validators";

import { AppCanvasView } from "../components/app-canvas";
import { PageLoading } from "../components/page-loading";
import { PageTabs } from "../components/page-tabs";
import { copyShareUrl, ShareDialog } from "../components/share-dialog";
import { AppDatasetsProvider } from "../data";
import { resolvePage } from "../lib/pages";
import type { AppDoc } from "../use-app-editor";

/** Not found and not shared read the same — an id's existence never leaks. */
function AppNotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboard />
          </EmptyMedia>
          <EmptyTitle>App not found</EmptyTitle>
          <EmptyDescription>
            This app doesn't exist, or its owner hasn't shared it with you.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/apps">Go to your apps</RouterButton>
        </EmptyContent>
      </Empty>
    </main>
  );
}

function ViewerActions({ app }: { app: AppDoc }) {
  const navigate = useNavigate(),
    duplicate = useMutation(api.appBuilder.apps.duplicate),
    [sharing, setSharing] = useState(false);
  if (app.canEdit) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSharing(true);
          }}
        >
          <Share2 data-icon="inline-start" />
          Share
        </Button>
        <RouterButton to="/apps/$appId/edit" params={{ appId: app._id }}>
          <Pencil data-icon="inline-start" />
          Edit app
        </RouterButton>
        <ShareDialog
          appId={app._id}
          sharing={app.sharing}
          open={sharing}
          onOpenChange={setSharing}
        />
      </>
    );
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void copyShareUrl(app._id);
        }}
      >
        <Link2 data-icon="inline-start" />
        Copy link
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void (async () => {
            try {
              const copyId = await duplicate({ appId: app._id });
              toast.success("Copied to your apps");
              await navigate({ params: { appId: copyId }, to: "/apps/$appId/edit" });
            } catch (error) {
              toast.error(errorMessage(error, "Couldn't copy the app."));
            }
          })();
        }}
      >
        <Copy data-icon="inline-start" />
        Make a copy
      </Button>
    </>
  );
}

/**
 * The shared app (/apps/$appId) — what a share link opens. Read-only for
 * everyone; the creator also gets Edit and Share.
 */
function EmptyPage({ app }: { app: AppDoc }) {
  return (
    <Empty className="min-h-80 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayoutDashboard />
        </EmptyMedia>
        <EmptyTitle>Nothing here yet</EmptyTitle>
        <EmptyDescription>
          {app.canEdit
            ? "Open the builder to add maps, charts and tables to this page."
            : "The owner hasn't added anything to this page yet."}
        </EmptyDescription>
      </EmptyHeader>
      {app.canEdit && (
        <EmptyContent>
          <RouterButton to="/apps/$appId/edit" params={{ appId: app._id }}>
            <Pencil data-icon="inline-start" />
            Open the builder
          </RouterButton>
        </EmptyContent>
      )}
    </Empty>
  );
}

function PageCanvas({ app, page }: { app: AppDoc; page: AppPage }) {
  return page.widgets.length === 0 ? (
    <EmptyPage app={app} />
  ) : (
    <AppCanvasView key={page.id} widgets={page.widgets} layout={page.layout} />
  );
}

function Byline({ app }: { app: AppDoc }) {
  return (
    <p className="text-xs text-muted-foreground">
      {app.example ? "Example app · " : ""}
      {app.ownerName === undefined ? "" : `By ${app.ownerName} · `}Updated{" "}
      {new Date(app.updatedAt).toLocaleDateString()}
    </p>
  );
}

/**
 * A full-screen page: one compact bar (title, tabs, actions), then the canvas
 * filling the rest of the viewport edge to edge.
 */
function FullscreenPage({ app, page, tabs }: { app: AppDoc; page: AppPage; tabs: ReactNode }) {
  return (
    <main className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-4">
          <h1 className="truncate text-sm font-semibold" title={app.description}>
            {app.title}
          </h1>
          {tabs}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ViewerActions app={app} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="md:h-full">
          <PageCanvas app={app} page={page} />
        </div>
      </div>
    </main>
  );
}

/** A contained page: the app's title block, the tabs, then a centered canvas. */
function ContainedPage({ app, page, tabs }: { app: AppDoc; page: AppPage; tabs: ReactNode }) {
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{app.title}</h1>
          {app.description !== undefined && (
            <p className="max-w-3xl text-muted-foreground">{app.description}</p>
          )}
          <Byline app={app} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ViewerActions app={app} />
        </div>
      </div>
      {tabs !== null && <div className="mb-4 border-b border-border pb-1">{tabs}</div>}
      <PageCanvas app={app} page={page} />
    </main>
  );
}

/**
 * The shared app (/apps/$appId) — what a share link opens. Read-only for
 * everyone; the creator also gets Edit and Share. Each page renders in its
 * own layout (contained or full screen); `pageId` is the `?page=` param.
 */
export function AppViewPage({
  appId,
  pageId,
  onPageChange,
}: {
  appId: string;
  pageId: string | undefined;
  onPageChange: (pageId: string | undefined) => void;
}) {
  const app = useQuery({ ...convexQuery(api.appBuilder.apps.get, { appId }) }).data;
  if (app === undefined) {
    return <PageLoading />;
  }
  if (app === null) {
    return <AppNotFound />;
  }
  const page = resolvePage(app.pages, pageId),
    tabs =
      app.pages.length > 1 ? (
        <PageTabs
          pages={app.pages}
          activeId={page.id}
          onChange={(next) => {
            // The first page is the default and stays out of the URL.
            onPageChange(next === app.pages[0].id ? undefined : next);
          }}
        />
      ) : null;
  return (
    <AppDatasetsProvider datasetIds={app.datasetIds}>
      {page.layout === "fullscreen" ? (
        <FullscreenPage app={app} page={page} tabs={tabs} />
      ) : (
        <ContainedPage app={app} page={page} tabs={tabs} />
      )}
    </AppDatasetsProvider>
  );
}
