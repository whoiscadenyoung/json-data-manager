import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@caden/ui/components/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@caden/ui/components/breadcrumb";
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
import { Spinner } from "@caden/ui/components/spinner";
import { cn } from "@caden/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  Check,
  ExternalLink,
  Eye,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Plus,
  Rocket,
  Share2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { useSession } from "#/integrations/supabase/provider";
import { errorMessage } from "#/lib/errors";
import * as appsStore from "#/lib/store/apps";
import { listMineQueryOptions, resolveMyRole } from "#/lib/store/project-members";

import { AppCanvasEditor } from "../components/app-canvas";
import { AppDetailsDialog } from "../components/app-details-dialog";
import { BuilderPanel, type PanelTab } from "../components/builder-panel";
import { PageLoading } from "../components/page-loading";
import { PageTabs } from "../components/page-tabs";
import { PublishDialog } from "../components/publish-dialog";
import { ShareDialog } from "../components/share-dialog";
import { AppDatasetsProvider } from "../data";
import { appDocOf, type AppDoc } from "../lib/app-doc";
import type { Widget } from "../lib/content";
import { newWidgetId, resizeWidget } from "../lib/layout";
import { canAddPage, newPage, resolvePage, updatePage } from "../lib/pages";
import { useAppEditor, type SaveStatus } from "../use-app-editor";

function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === "error") {
    return (
      <Button type="button" variant="destructive" size="xs" onClick={onRetry}>
        <AlertCircle data-icon="inline-start" />
        Not saved — retry
      </Button>
    );
  }
  if (status === "invalid") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle className="size-3.5" />
        Not saved — give every page a title
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3.5" />
        Saved
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      <Spinner className="size-3.5" />
      Saving…
    </span>
  );
}

function EmptyCanvas({ hasData, onStart }: { hasData: boolean; onStart: (tab: PanelTab) => void }) {
  return (
    <Empty className="min-h-[420px] border-2">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayoutDashboard />
        </EmptyMedia>
        <EmptyTitle>Start building</EmptyTitle>
        <EmptyDescription>
          {hasData
            ? "Add a map, chart, table, number or text block from the panel. Drag widgets to reorder them and pull their corners to resize."
            : "Add a map from a project map, or a dataset on the Data tab for charts, tables and numbers."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          type="button"
          onClick={() => {
            onStart(hasData ? "add" : "add");
          }}
        >
          Add a widget
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function BuilderMenu({ app }: { app: AppDoc }) {
  const navigate = useNavigate(),
    queryClient = useQueryClient(),
    remove = useMutation({
      mutationFn: async (args: { appId: string }) => await appsStore.remove(args),
    }),
    [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon" aria-label="More app actions" />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setEditing(true);
              }}
            >
              <Pencil data-icon="inline-start" />
              Edit title & description
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigate({ params: { appId: app.id }, to: "/apps/$appId" });
              }}
            >
              <ExternalLink data-icon="inline-start" />
              Open published app
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                setDeleting(true);
              }}
            >
              <Trash2 data-icon="inline-start" />
              Delete app
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && (
        <AppDetailsDialog
          appId={app.id}
          initial={{ description: app.description ?? undefined, title: app.title }}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this app?</AlertDialogTitle>
            <AlertDialogDescription>
              The app and its layout are deleted for everyone with the link. Its datasets and the
              project's maps are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDeleting(false);
                void (async () => {
                  try {
                    const affected = await remove.mutateAsync({ appId: app.id });
                    if (affected === 0) {
                      // RLS answered with 0 rows — the delete never landed.
                      toast.error("Couldn't delete — editors of the app's project can delete it.");
                      return;
                    }
                    void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
                    toast.success("App deleted");
                    await navigate({ to: "/apps" });
                  } catch (error) {
                    toast.error(errorMessage(error, "Couldn't delete the app."));
                  }
                })();
              }}
            >
              Delete app
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Builder({
  app,
  embedded,
  initialPageId,
}: {
  app: AppDoc;
  embedded: boolean;
  initialPageId: string | undefined;
}) {
  const editor = useAppEditor(app),
    { content, update } = editor,
    [pageId, setPageId] = useState(() => resolvePage(app.pages, initialPageId).id),
    [selectedId, setSelectedId] = useState<string | undefined>(),
    [tab, setTab] = useState<PanelTab>("add"),
    [sharing, setSharing] = useState(false),
    [publishing, setPublishing] = useState(false),
    page = resolvePage(content.pages, pageId),
    selected = page.widgets.find((widget) => widget.id === selectedId),
    setWidgets = (change: (widgets: Widget[]) => Widget[]) => {
      update((prev) => ({
        ...prev,
        pages: updatePage(prev.pages, page.id, (current) => ({
          ...current,
          widgets: change(current.widgets),
        })),
      }));
    },
    showPage = (nextId: string) => {
      setPageId(nextId);
      setSelectedId(undefined);
    };

  return (
    <AppDatasetsProvider datasetIds={content.datasetIds}>
      <div
        className={cn(
          "flex flex-col",
          embedded ? "h-[calc(100vh-7rem)]" : "h-[calc(100vh-3.5rem)]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Breadcrumb className="min-w-0">
              <BreadcrumbList>
                {embedded ? null : (
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link to="/apps" />}>Apps</BreadcrumbLink>
                  </BreadcrumbItem>
                )}
                {!embedded && app.projectTitle !== null && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbLink
                        render={
                          <Link params={{ projectId: app.projectId }} to="/projects/$projectId" />
                        }
                      >
                        <span className="max-w-40 truncate">{app.projectTitle}</span>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                  </>
                )}
                {embedded ? null : <BreadcrumbSeparator />}
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate">
                    <h1 className="truncate font-semibold">{app.title}</h1>
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <SaveIndicator status={editor.status} onRetry={editor.retry} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RouterButton
              to="/apps/$appId/preview"
              params={{ appId: app.id }}
              search={{ page: page.id === content.pages[0].id ? undefined : page.id }}
              variant="outline"
            >
              <Eye data-icon="inline-start" />
              Preview
            </RouterButton>
            <Button
              type="button"
              onClick={() => {
                setPublishing(true);
              }}
              variant="outline"
            >
              <Rocket data-icon="inline-start" />
              Publish
            </Button>
            <Button
              type="button"
              onClick={() => {
                setSharing(true);
              }}
            >
              <Share2 data-icon="inline-start" />
              Share
            </Button>
            <BuilderMenu app={app} />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="w-[340px] shrink-0 overflow-y-auto border-r border-border bg-background p-4">
            <BuilderPanel
              tab={tab}
              onTabChange={setTab}
              content={content}
              page={page}
              selected={selected}
              projectId={app.projectId}
              onUpdate={update}
              onSelect={setSelectedId}
              onSelectPage={showPage}
            />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col bg-muted/40">
            <div className="flex shrink-0 items-center border-b border-border bg-background px-4 py-1.5">
              <PageTabs pages={content.pages} activeId={page.id} onChange={showPage}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canAddPage(content.pages)}
                  title={canAddPage(content.pages) ? undefined : "An app holds up to 12 pages"}
                  onClick={() => {
                    const added = newPage(content.pages);
                    update((prev) => ({ ...prev, pages: [...prev.pages, added] }));
                    showPage(added.id);
                    setTab("page");
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Add page
                </Button>
              </PageTabs>
            </div>
            <div
              role="presentation"
              className={cn(
                "min-h-0 flex-1 overflow-y-auto",
                page.layout === "fullscreen" ? "p-2" : "p-6",
              )}
              onClick={(event) => {
                // A click on the canvas background (not a widget) clears the selection.
                if (event.target === event.currentTarget) {
                  setSelectedId(undefined);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSelectedId(undefined);
                }
              }}
            >
              <div className={cn(page.layout === "fullscreen" ? "h-full" : "mx-auto max-w-7xl")}>
                {page.widgets.length === 0 ? (
                  <EmptyCanvas hasData={content.datasetIds.length > 0} onStart={setTab} />
                ) : (
                  <AppCanvasEditor
                    key={page.id}
                    widgets={page.widgets}
                    layout={page.layout}
                    selectedId={selectedId}
                    onSelect={(id) => {
                      setSelectedId(id);
                      setTab("widget");
                    }}
                    onReorder={(next) => {
                      setWidgets(() => next);
                    }}
                    onResize={(id, size) => {
                      setWidgets((widgets) => resizeWidget(widgets, id, size));
                    }}
                    onDuplicate={(id) => {
                      const copy = { id: newWidgetId() };
                      setWidgets((widgets) =>
                        widgets.flatMap((widget) =>
                          widget.id === id ? [widget, { ...widget, ...copy }] : [widget],
                        ),
                      );
                      setSelectedId(copy.id);
                    }}
                    onRemove={(id) => {
                      setWidgets((widgets) => widgets.filter((widget) => widget.id !== id));
                      setSelectedId(undefined);
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        <ShareDialog
          appId={app.id}
          visibility={app.visibility}
          open={sharing}
          onOpenChange={setSharing}
        />
        <PublishDialog app={app} open={publishing} onOpenChange={setPublishing} />
      </div>
    </AppDatasetsProvider>
  );
}

/** The builder (/apps/$appId/edit) — an editor of the app's project; anyone else is sent to the viewer. */
export function AppBuilderPage({
  appId,
  embedded = false,
  initialPageId,
}: {
  appId: string;
  /** Rendered inside the project shell (issue #271): sized under the shell toolbar, breadcrumb trimmed to the app title. */
  embedded?: boolean;
  initialPageId: string | undefined;
}) {
  const row = useQuery(appsStore.getQueryOptions({ appId })),
    { session } = useSession(),
    userId = session === null ? "" : session.user.id,
    membershipsQuery = useQuery(listMineQueryOptions({ userId }));
  if (row.isPending) {
    return <PageLoading />;
  }
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
  const app =
    row.data === null
      ? null
      : appDocOf(
          row.data,
          resolveMyRole(
            membershipsQuery.data,
            row.data.projectId,
            row.data.project === null ? "" : row.data.project.createdBy,
            userId,
          ),
        );
  if (app === null || !app.canEdit) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard />
            </EmptyMedia>
            <EmptyTitle>You can't edit this app</EmptyTitle>
            <EmptyDescription>
              Editors of the app's project can edit it. You can still open it, or make your own copy
              from there.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <RouterButton to="/apps/$appId" params={{ appId }}>
              Open the app
            </RouterButton>
          </EmptyContent>
        </Empty>
      </main>
    );
  }
  // Keyed by id: the editor's working copy initializes once per app.
  return <Builder key={app.id} app={app} embedded={embedded} initialPageId={initialPageId} />;
}
