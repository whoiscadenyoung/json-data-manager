import { Badge } from "@caden/ui/components/badge";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Copy,
  Eye,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  MoreHorizontal,
  Pencil,
  Rocket,
  Share2,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { RouterButton } from "#/components/router-button";
import { ThemeToggle } from "#/components/theme-toggle";
import { useSession } from "#/integrations/supabase/provider";
import { errorMessage } from "#/lib/errors";
import * as appVersionsStore from "#/lib/store/app-versions";
import * as appsStore from "#/lib/store/apps";
import { listMineQueryOptions, resolveMyRole } from "#/lib/store/project-members";

import { AppCanvasView } from "../components/app-canvas";
import { CopyAppDialog } from "../components/copy-app-dialog";
import { PageLoading } from "../components/page-loading";
import { PageTabs } from "../components/page-tabs";
import { copyShareUrl, ShareDialog } from "../components/share-dialog";
import { AppDatasetsProvider, AppFrozenProvider } from "../data";
import { appDocOf, type AppDoc } from "../lib/app-doc";
import { appPagesOf, type AppPage } from "../lib/content";
import { resolvePage } from "../lib/pages";

/**
 * A null row. Reads are member-wide + the example arm (0022), so a null
 * answer means the id names no app the viewer can see (a typed-wrong share
 * link, a deleted app).
 */
function AppNotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboard />
          </EmptyMedia>
          <EmptyTitle>App not found</EmptyTitle>
          <EmptyDescription>This app doesn't exist — check the link.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/apps">Browse apps</RouterButton>
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
    queryClient = useQueryClient(),
    [sharing, setSharing] = useState(false),
    [copying, setCopying] = useState(false);
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
                void copyShareUrl(app.id);
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
                    void navigate({ params: { appId: app.id }, to: "/apps/$appId/edit" });
                  }}
                >
                  <Pencil data-icon="inline-start" />
                  Edit app
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuItem
              onClick={() => {
                setCopying(true);
              }}
            >
              <Copy data-icon="inline-start" />
              Make a copy
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                void navigate({ to: "/apps" });
              }}
            >
              <LayoutGrid data-icon="inline-start" />
              Browse apps
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {app.canEdit && (
        <ShareDialog
          appId={app.id}
          sharing={app.sharing}
          open={sharing}
          onOpenChange={setSharing}
        />
      )}
      <CopyAppDialog
        app={app}
        open={copying}
        onOpenChange={setCopying}
        onCopied={async (copyId) => {
          void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
          await navigate({ params: { appId: copyId }, to: "/apps/$appId/edit" });
        }}
      />
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
          <RouterButton to="/apps/$appId/edit" params={{ appId: app.id }}>
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
function AppBar({
  app,
  tabs,
  menu,
  publishedLabel,
}: {
  app: AppDoc;
  tabs: ReactNode;
  menu: boolean;
  publishedLabel: string | null;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b border-border bg-background px-4 py-2">
      <h1 className="min-w-0 truncate text-base font-semibold" title={app.description ?? undefined}>
        {app.title}
      </h1>
      {publishedLabel !== null && (
        <Badge
          variant="secondary"
          title="The published snapshot — edits to the live app don't change this until republish."
        >
          <Rocket data-icon="inline-start" />
          {publishedLabel}
        </Badge>
      )}
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
        {app.description !== null && (
          <p className="mb-4 max-w-3xl text-muted-foreground">{app.description}</p>
        )}
        <PageCanvas app={app} page={page} />
      </main>
    </div>
  );
}

/** The frozen branch's body: pages from the snapshot, datasets from the pins, maps from the mapSnapshots. */
function FrozenAppBody({
  app,
  definition,
  publishedLabel,
  initialPageId,
  onPageChange,
  previewing,
  onExit,
}: {
  app: AppDoc;
  definition: appVersionsStore.AppVersionDefinition;
  publishedLabel: string;
  initialPageId: string | undefined;
  onPageChange: (pageId: string | undefined) => void;
  previewing: boolean;
  onExit?: () => void;
}) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the snapshot's pages jsonb is this feature's writer shape (the AppWidgetConfig boundary cast, app-doc.ts posture).
  const pages = appPagesOf(definition.pages as unknown as AppPage[]),
    page = resolvePage(pages, initialPageId),
    tabs =
      pages.length > 1 ? (
        <PageTabs
          pages={pages}
          activeId={page.id}
          onChange={(next) => {
            // The first page is the default and stays out of the URL.
            onPageChange(next === pages[0].id ? undefined : next);
          }}
        />
      ) : null,
    bars = (
      <>
        {previewing && onExit !== undefined && <PreviewBar app={app} onExit={onExit} />}
        <AppBar app={app} menu={!previewing} publishedLabel={publishedLabel} tabs={tabs} />
      </>
    );
  return (
    <AppFrozenProvider definition={definition}>
      <AppDatasetsProvider datasetIds={definition.datasetPins.map((pin) => pin.datasetId)}>
        {page.layout === "fullscreen" ? (
          <FullscreenPage app={app} page={page} bars={bars} />
        ) : (
          <ContainedPage app={app} page={page} bars={bars} />
        )}
      </AppDatasetsProvider>
    </AppFrozenProvider>
  );
}

/** The live branch's body: the app as configured right now (drafts, previews, never-published apps). */
function LiveAppBody({
  app,
  initialPageId,
  onPageChange,
  previewing,
  onExit,
}: {
  app: AppDoc;
  initialPageId: string | undefined;
  onPageChange: (pageId: string | undefined) => void;
  previewing: boolean;
  onExit?: () => void;
}) {
  const page = resolvePage(app.pages, initialPageId),
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
        {previewing && onExit !== undefined && <PreviewBar app={app} onExit={onExit} />}
        <AppBar app={app} menu={!previewing} publishedLabel={null} tabs={tabs} />
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

/**
 * A published app (/apps/$appId, what a share link opens) or the builder's
 * preview of it (/apps/$appId/preview). Both draw the app standalone — the
 * routes hide the product header — and each page in its own layout (contained
 * or full screen); `pageId` is the `?page=` param. Preview adds a toolbar with
 * an exit; it falls back to the published view for anyone who can't edit.
 *
 * Published mode renders the HEAD app_version when one exists (the frozen
 * snapshot — D7), else the live config; preview always renders live.
 */
// The page joins the app read, the role resolution, and the head-version
// gate — the branches are the view's states, each rendered once, here.
// oxlint-disable-next-line eslint/complexity -- the state ladder is the contract.
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
  const row = useQuery(appsStore.getQueryOptions({ appId })),
    { session } = useSession(),
    userId = session === null ? "" : session.user.id,
    membershipsQuery = useQuery(listMineQueryOptions({ userId })),
    headVersion = useQuery({
      ...appVersionsStore.headQueryOptions({ appId }),
      // Preview always shows the live config; only the published view freezes.
      enabled: mode === "published",
    });
  if (row.isPending) {
    return <PageLoading />;
  }
  // A read error renders as "not found" only for the denial-shaped read:
  // an RLS-hidden row IS a null row, but a network error is not a missing
  // app — it gets its own honest message.
  if (row.isError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard />
            </EmptyMedia>
            <EmptyTitle>Couldn't open the app</EmptyTitle>
            <EmptyDescription>
              {errorMessage(row.error, "Something went wrong — try again.")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }
  if (row.data === null) {
    return <AppNotFound />;
  }
  const project = row.data.project,
    app = appDocOf(
      row.data,
      resolveMyRole(
        membershipsQuery.data,
        row.data.projectId,
        project === null ? "" : project.createdBy,
        userId,
      ),
    );
  const previewing = mode === "preview" && app.canEdit && onExit !== undefined;
  if (mode === "published" && headVersion.data !== null && headVersion.data !== undefined) {
    return (
      <FrozenAppBody
        app={app}
        definition={headVersion.data.definition}
        publishedLabel={`Published ${headVersion.data.versionLabel}`}
        initialPageId={pageId}
        onPageChange={onPageChange}
        previewing={previewing}
        onExit={onExit}
      />
    );
  }
  return (
    <LiveAppBody
      app={app}
      initialPageId={pageId}
      onPageChange={onPageChange}
      previewing={previewing}
      onExit={onExit}
    />
  );
}
