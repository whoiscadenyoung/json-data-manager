import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import {
  Copy,
  Eye,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  MoreHorizontal,
  Pencil,
  Share2,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { ThemeToggle } from "#/components/theme-toggle";
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

/**
 * The app's own overflow menu — the only product actions on a published app,
 * so it reads as a standalone app rather than a page inside the catalog.
 */
function AppMenu({ app }: { app: AppDoc }) {
  const navigate = useNavigate(),
    duplicate = useMutation(api.appBuilder.apps.duplicate),
    [sharing, setSharing] = useState(false),
    makeCopy = async () => {
      try {
        const copyId = await duplicate({ appId: app._id });
        toast.success("Copied to your apps");
        await navigate({ params: { appId: copyId }, to: "/apps/$appId/edit" });
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't copy the app."));
      }
    };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="ghost" size="icon" aria-label="App options" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                void copyShareUrl(app._id);
              }}
            >
              <Link2 data-icon="inline-start" />
              Copy link
            </DropdownMenuItem>
            {app.canEdit ? (
              <>
                <DropdownMenuItem
                  onClick={() => {
                    setSharing(true);
                  }}
                >
                  <Share2 data-icon="inline-start" />
                  Share…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void navigate({ params: { appId: app._id }, to: "/apps/$appId/edit" });
                  }}
                >
                  <Pencil data-icon="inline-start" />
                  Edit app
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem
                onClick={() => {
                  void makeCopy();
                }}
              >
                <Copy data-icon="inline-start" />
                Make a copy
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                void navigate({ to: "/apps" });
              }}
            >
              <LayoutGrid data-icon="inline-start" />
              Go to your apps
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {app.canEdit && (
        <ShareDialog
          appId={app._id}
          sharing={app.sharing}
          open={sharing}
          onOpenChange={setSharing}
        />
      )}
    </>
  );
}

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

/**
 * Preview mode's toolbar: sits above the app, outside it, and says so. The X
 * returns to the builder.
 */
function PreviewBar({ app, onExit }: { app: AppDoc; onExit: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted px-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Eye className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">Preview</span>
        <span className="truncate text-muted-foreground">
          {app.sharing === "link"
            ? "This is what people with the link see."
            : "This is what people will see once you share it."}
        </span>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onExit} aria-label="Exit preview">
        <X data-icon="inline-start" />
        <span className="max-sm:sr-only">Exit preview</span>
      </Button>
    </div>
  );
}

/** The app's own top bar: its title, its pages, and a small menu — no product navigation. */
function AppBar({ app, tabs, menu }: { app: AppDoc; tabs: ReactNode; menu: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b border-border bg-background px-4 py-2">
      <h1 className="min-w-0 truncate text-base font-semibold" title={app.description}>
        {app.title}
      </h1>
      {tabs !== null && (
        // Phones: title and menu share the first row, the tabs take the next.
        <div className="order-last basis-full sm:order-none sm:basis-auto">{tabs}</div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ThemeToggle />
        {menu && <AppMenu app={app} />}
      </div>
    </div>
  );
}

/** A full-screen page: the bars, then the canvas filling the rest of the viewport edge to edge. */
function FullscreenPage({ app, page, bars }: { app: AppDoc; page: AppPage; bars: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      {bars}
      <main className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="md:h-full">
          <PageCanvas app={app} page={page} />
        </div>
      </main>
    </div>
  );
}

/** A contained page: sticky bars, then a centered canvas that scrolls like a document. */
function ContainedPage({ app, page, bars }: { app: AppDoc; page: AppPage; bars: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="sticky top-0 z-40">{bars}</div>
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        {app.description !== undefined && (
          <p className="mb-4 max-w-3xl text-muted-foreground">{app.description}</p>
        )}
        <PageCanvas app={app} page={page} />
      </main>
    </div>
  );
}

/**
 * A published app (/apps/$appId, what a share link opens) or the builder's
 * preview of it (/apps/$appId/preview). Both draw the app standalone — the
 * routes hide the product header — and each page in its own layout (contained
 * or full screen); `pageId` is the `?page=` param. Preview adds a toolbar with
 * an exit; it falls back to the published view for anyone who can't edit.
 */
export function AppViewPage({
  appId,
  mode,
  pageId,
  onPageChange,
  onExit,
}: {
  appId: string;
  mode: "published" | "preview";
  pageId: string | undefined;
  onPageChange: (pageId: string | undefined) => void;
  onExit?: () => void;
}) {
  const app = useQuery({ ...convexQuery(api.appBuilder.apps.get, { appId }) }).data;
  if (app === undefined) {
    return <PageLoading />;
  }
  if (app === null) {
    return <AppNotFound />;
  }
  const page = resolvePage(app.pages, pageId),
    previewing = mode === "preview" && app.canEdit && onExit !== undefined,
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
      ) : null,
    bars = (
      <>
        {previewing && <PreviewBar app={app} onExit={onExit} />}
        <AppBar app={app} tabs={tabs} menu={!previewing} />
      </>
    );
  return (
    <AppDatasetsProvider datasetIds={app.datasetIds}>
      {page.layout === "fullscreen" ? (
        <FullscreenPage app={app} page={page} bars={bars} />
      ) : (
        <ContainedPage app={app} page={page} bars={bars} />
      )}
    </AppDatasetsProvider>
  );
}
