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
import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  ChevronDown,
  Database,
  Ellipsis,
  ExternalLink,
  Eye,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
  Pencil,
  Plus,
  Rocket,
  Share2,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { useSession } from "#/integrations/supabase/provider";
import { errorMessage } from "#/lib/errors";
import * as appsStore from "#/lib/store/apps";
import { listMineQueryOptions, resolveMyRole } from "#/lib/store/project-members";

import { AppCanvasEditor } from "../components/app-canvas";
import { AppDetailsDialog } from "../components/app-details-dialog";
import { BuilderOutline } from "../components/builder-outline";
import {
  BuilderSettings,
  WidgetPalette,
  type BuilderSelection,
} from "../components/builder-settings";
import { PageLoading } from "../components/page-loading";
import { PageTabs } from "../components/page-tabs";
import { PublishDialog } from "../components/publish-dialog";
import { ShareDialog } from "../components/share-dialog";
import { AppDatasetsProvider, useAppDatasets } from "../data";
import { appDocOf, type AppDoc } from "../lib/app-doc";
import {
  APP_LIMITS,
  type AppContent,
  type AppPage,
  type Widget,
  type WidgetKind,
} from "../lib/content";
import { newWidgetId, resizeWidget } from "../lib/layout";
import { allWidgets, canAddPage, newPage, resolvePage, updatePage } from "../lib/pages";
import { useAppEditor, type SaveStatus } from "../use-app-editor";
import { createWidget, WIDGET_KINDS } from "../widgets/registry";

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

/** Whether the page (or the whole app) holds as many widgets as it can. */
function widgetsFull(content: AppContent, widgetCount: number): boolean {
  return (
    widgetCount >= APP_LIMITS.widgets || allWidgets(content.pages).length >= APP_LIMITS.totalWidgets
  );
}

function EmptyCanvas({
  full,
  hasData,
  onAdd,
}: {
  full: boolean;
  hasData: boolean;
  onAdd: (kind: WidgetKind) => void;
}) {
  return (
    <Empty className="min-h-[420px] border-2">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayoutDashboard />
        </EmptyMedia>
        <EmptyTitle>This page is empty</EmptyTitle>
        <EmptyDescription>
          Add a widget to start. Drag widgets to reorder them and pull their corners to resize.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-xl">
        <WidgetPalette full={full} hasData={hasData} onAdd={onAdd} />
      </EmptyContent>
    </Empty>
  );
}

/** "Add": a widget on this page, a new page, or a dataset for the app. */
function AddMenu({
  content,
  full,
  onAddDataset,
  onAddPage,
  onAddWidget,
}: {
  content: AppContent;
  full: boolean;
  onAddDataset: () => void;
  onAddPage: () => void;
  onAddWidget: (kind: WidgetKind) => void;
}) {
  const hasData = content.datasetIds.length > 0,
    pageAddable = canAddPage(content.pages);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" type="button" />}>
        <Plus />
        Add
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {full ? "This page holds the most widgets it can" : "Widget on this page"}
          </DropdownMenuLabel>
          {WIDGET_KINDS.map((info) => {
            const Icon = info.icon,
              needsData = info.needsData && !hasData;
            return (
              <DropdownMenuItem
                key={info.kind}
                disabled={full || needsData}
                onClick={() => {
                  onAddWidget(info.kind);
                }}
              >
                <Icon />
                <span className="flex-1">{info.label}</span>
                {needsData && (
                  <span className="text-xs text-muted-foreground">Needs a dataset</span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={!pageAddable} onClick={onAddPage}>
            <PanelTop />
            <span className="flex-1">Page</span>
            {!pageAddable && (
              <span className="text-xs text-muted-foreground">Up to {APP_LIMITS.pages}</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAddDataset}>
            <Database />
            Dataset…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BuilderMenu({ app, embedded }: { app: AppDoc; embedded: boolean }) {
  const navigate = useNavigate(),
    queryClient = useQueryClient(),
    remove = useMutation({
      mutationFn: async (args: { appId: string }) => await appsStore.remove(args),
    }),
    [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false),
    leave = async () => {
      await (embedded
        ? navigate({ params: { projectId: app.projectId }, to: "/projects/$projectId/apps" })
        : navigate({ to: "/apps" }));
    };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="ghost" size="icon-sm" aria-label="App actions" />}
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setEditing(true);
              }}
            >
              <Pencil />
              Edit title and description
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigate({ params: { appId: app.id }, to: "/apps/$appId" });
              }}
            >
              <ExternalLink />
              Open the app
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
              <Trash2 />
              Delete app…
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
                    await leave();
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

/** The title row: outline toggle, name and save state, then Add and the app's actions. */
function BuilderHeader({
  app,
  addMenu,
  embedded,
  outlineOpen,
  pageSearchId,
  status,
  onPublish,
  onRetry,
  onShare,
  onToggleOutline,
}: {
  app: AppDoc;
  addMenu: ReactNode;
  embedded: boolean;
  outlineOpen: boolean;
  /** The page the preview opens on; undefined for the first page. */
  pageSearchId: string | undefined;
  status: SaveStatus;
  onPublish: () => void;
  onRetry: () => void;
  onShare: () => void;
  onToggleOutline: () => void;
}) {
  const toggleLabel = outlineOpen ? "Hide pages and data" : "Show pages and data";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Button
        aria-expanded={outlineOpen}
        aria-label={toggleLabel}
        onClick={onToggleOutline}
        size="icon-sm"
        title={toggleLabel}
        variant="ghost"
      >
        {outlineOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0">
          {embedded ? null : (
            <Link className="text-xs text-muted-foreground hover:underline" to="/apps">
              Apps
            </Link>
          )}
          <h1 className="truncate text-base font-semibold" title={app.title}>
            {app.title}
          </h1>
        </div>
        <SaveIndicator status={status} onRetry={onRetry} />
      </div>
      {addMenu}
      <RouterButton
        to="/apps/$appId/preview"
        params={{ appId: app.id }}
        search={{ page: pageSearchId }}
        size="sm"
        variant="outline"
      >
        <Eye data-icon="inline-start" />
        Preview
      </RouterButton>
      <Button type="button" size="sm" variant="outline" onClick={onPublish}>
        <Rocket data-icon="inline-start" />
        Publish
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onShare}>
        <Share2 data-icon="inline-start" />
        Share
      </Button>
      <BuilderMenu app={app} embedded={embedded} />
    </div>
  );
}

/** The page's widgets on the canvas; a click on the background clears the selection. */
function PageCanvas({
  full,
  hasData,
  page,
  selectedWidgetId,
  onAdd,
  onSelect,
  onWidgets,
}: {
  full: boolean;
  hasData: boolean;
  page: AppPage;
  selectedWidgetId: string | undefined;
  onAdd: (kind: WidgetKind) => void;
  onSelect: (next: BuilderSelection | undefined) => void;
  onWidgets: (change: (widgets: Widget[]) => Widget[]) => void;
}) {
  return (
    <div
      role="presentation"
      className={cn("min-h-0 flex-1 overflow-y-auto", page.layout === "fullscreen" ? "p-2" : "p-6")}
      onClick={(event) => {
        // A click on the canvas background (not a widget) clears the selection.
        if (event.target === event.currentTarget) {
          onSelect(undefined);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onSelect(undefined);
        }
      }}
    >
      <div className={cn(page.layout === "fullscreen" ? "h-full" : "mx-auto max-w-7xl")}>
        {page.widgets.length === 0 ? (
          <EmptyCanvas full={full} hasData={hasData} onAdd={onAdd} />
        ) : (
          <AppCanvasEditor
            key={page.id}
            widgets={page.widgets}
            layout={page.layout}
            selectedId={selectedWidgetId}
            onSelect={(id) => {
              onSelect({ kind: "widget", widgetId: id });
            }}
            onReorder={(next) => {
              onWidgets(() => next);
            }}
            onResize={(id, size) => {
              onWidgets((widgets) => resizeWidget(widgets, id, size));
            }}
            onDuplicate={(id) => {
              const copy = { id: newWidgetId() };
              onWidgets((widgets) =>
                widgets.flatMap((widget) =>
                  widget.id === id ? [widget, { ...widget, ...copy }] : [widget],
                ),
              );
              onSelect({ kind: "widget", widgetId: copy.id });
            }}
            onRemove={(id) => {
              onWidgets((widgets) => widgets.filter((widget) => widget.id !== id));
              onSelect(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The builder as one workspace, laid out like the map editor: the outline of
 * pages, widgets and data on the left, the page's canvas in the middle, and
 * the selection's settings on the right (only while something is selected).
 */
function Workspace({
  app,
  editor,
  embedded,
  initialPageId,
}: {
  app: AppDoc;
  editor: ReturnType<typeof useAppEditor>;
  embedded: boolean;
  initialPageId: string | undefined;
}) {
  const { content, update } = editor,
    states = useAppDatasets(),
    [pageId, setPageId] = useState(() => resolvePage(app.pages, initialPageId).id),
    [selection, setSelection] = useState<BuilderSelection | undefined>(),
    [outlineOpen, setOutlineOpen] = useState(true),
    [sharing, setSharing] = useState(false),
    [publishing, setPublishing] = useState(false),
    page = resolvePage(content.pages, pageId),
    full = widgetsFull(content, page.widgets.length),
    selectedWidgetId =
      selection !== undefined && selection.kind === "widget" ? selection.widgetId : undefined,
    setWidgets = (change: (widgets: Widget[]) => Widget[]) => {
      update((prev) => ({
        ...prev,
        pages: updatePage(prev.pages, page.id, (current) => ({
          ...current,
          widgets: change(current.widgets),
        })),
      }));
    },
    showPage = (nextId: string, next: BuilderSelection | undefined) => {
      setPageId(nextId);
      setSelection(next);
    },
    addWidget = (kind: WidgetKind) => {
      const widget = createWidget(kind, content.datasetIds, states);
      setWidgets((widgets) => [...widgets, widget]);
      setSelection({ kind: "widget", widgetId: widget.id });
    },
    addPage = () => {
      const added = newPage(content.pages);
      update((prev) => ({ ...prev, pages: [...prev.pages, added] }));
      showPage(added.id, { kind: "page" });
    };

  return (
    <div
      className={cn(
        "flex min-h-[480px] flex-col",
        embedded ? "md:h-[calc(100vh-7rem)]" : "md:h-[calc(100vh-3.5rem)]",
      )}
    >
      <BuilderHeader
        app={app}
        addMenu={
          <AddMenu
            content={content}
            full={full}
            onAddDataset={() => {
              setSelection({ kind: "data" });
            }}
            onAddPage={addPage}
            onAddWidget={addWidget}
          />
        }
        embedded={embedded}
        outlineOpen={outlineOpen}
        pageSearchId={page.id === content.pages[0].id ? undefined : page.id}
        status={editor.status}
        onPublish={() => {
          setPublishing(true);
        }}
        onRetry={editor.retry}
        onShare={() => {
          setSharing(true);
        }}
        onToggleOutline={() => {
          setOutlineOpen((open) => !open);
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Pages and data"
          className={`${outlineOpen ? "flex" : "hidden"} w-full shrink-0 flex-col overflow-y-auto border-b border-border bg-background p-2 md:w-[280px] md:border-r md:border-b-0`}
        >
          <BuilderOutline
            content={content}
            pageId={page.id}
            selection={selection}
            onAddPage={addPage}
            onSelectData={() => {
              setSelection({ kind: "data" });
            }}
            onSelectPage={(id) => {
              showPage(id, { kind: "page" });
            }}
            onSelectWidget={(id, widgetId) => {
              showPage(id, { kind: "widget", widgetId });
            }}
          />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col bg-muted/40">
          {outlineOpen ? null : (
            <div className="flex shrink-0 items-center border-b border-border bg-background px-4 py-1.5">
              <PageTabs
                pages={content.pages}
                activeId={page.id}
                onChange={(id) => {
                  showPage(id, undefined);
                }}
              />
            </div>
          )}
          <PageCanvas
            full={full}
            hasData={content.datasetIds.length > 0}
            page={page}
            selectedWidgetId={selectedWidgetId}
            onAdd={addWidget}
            onSelect={setSelection}
            onWidgets={setWidgets}
          />
        </div>
        {selection !== undefined && (
          <BuilderSettings
            selection={selection}
            content={content}
            page={page}
            projectId={app.projectId}
            onClose={() => {
              setSelection(undefined);
            }}
            onUpdate={update}
            onSelectPage={(id) => {
              showPage(id, { kind: "page" });
            }}
          />
        )}
      </div>
      <ShareDialog
        appId={app.id}
        visibility={app.visibility}
        open={sharing}
        onOpenChange={setSharing}
      />
      <PublishDialog app={app} open={publishing} onOpenChange={setPublishing} />
    </div>
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
  const editor = useAppEditor(app);
  return (
    <AppDatasetsProvider datasetIds={editor.content.datasetIds}>
      <Workspace app={app} editor={editor} embedded={embedded} initialPageId={initialPageId} />
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
