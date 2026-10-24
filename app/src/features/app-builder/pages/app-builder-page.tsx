import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import {
  AlertCircle,
  Check,
  Eye,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import type { Widget } from "#convex/appBuilder/validators";

import { AppCanvasEditor } from "../components/app-canvas";
import { AppDetailsDialog } from "../components/app-details-dialog";
import { BuilderPanel, type PanelTab } from "../components/builder-panel";
import { PageLoading } from "../components/page-loading";
import { ShareDialog } from "../components/share-dialog";
import { AppDatasetsProvider } from "../data";
import { newWidgetId, resizeWidget } from "../lib/layout";
import { useAppEditor, type AppDoc, type SaveStatus } from "../use-app-editor";

function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === "error") {
    return (
      <Button type="button" variant="destructive" size="xs" onClick={onRetry}>
        <AlertCircle data-icon="inline-start" />
        Not saved — retry
      </Button>
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
            : "First add a dataset — every map, chart and table in the app reads from the app's datasets."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          type="button"
          onClick={() => {
            onStart(hasData ? "add" : "data");
          }}
        >
          {hasData ? "Add a widget" : "Add a dataset"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function BuilderMenu({ app }: { app: AppDoc }) {
  const navigate = useNavigate(),
    remove = useMutation(api.appBuilder.apps.remove),
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
          appId={app._id}
          initial={{ description: app.description, title: app.title }}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this app?</AlertDialogTitle>
            <AlertDialogDescription>
              The app and its layout are deleted for everyone with the link. Its datasets are not
              affected.
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
                    await remove({ appId: app._id });
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

function Builder({ app }: { app: AppDoc }) {
  const editor = useAppEditor(app),
    { content, update } = editor,
    [selectedId, setSelectedId] = useState<string | undefined>(),
    [tab, setTab] = useState<PanelTab>(app.datasetIds.length === 0 ? "data" : "add"),
    [sharing, setSharing] = useState(false),
    selected = content.widgets.find((widget) => widget.id === selectedId),
    setWidgets = (change: (widgets: Widget[]) => Widget[]) => {
      update((prev) => ({ ...prev, widgets: change(prev.widgets) }));
    };

  return (
    <AppDatasetsProvider datasetIds={content.datasetIds}>
      <div className="flex h-[calc(100vh-3.5rem)] flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Breadcrumb className="min-w-0">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link to="/apps" />}>Apps</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
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
            <RouterButton to="/apps/$appId" params={{ appId: app._id }} variant="outline">
              <Eye data-icon="inline-start" />
              View app
            </RouterButton>
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
          <div
            role="presentation"
            className="min-w-0 flex-1 overflow-y-auto bg-muted/40 p-6"
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
            {content.widgets.length === 0 ? (
              <EmptyCanvas hasData={content.datasetIds.length > 0} onStart={setTab} />
            ) : (
              <AppCanvasEditor
                widgets={content.widgets}
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
          <aside className="w-[340px] shrink-0 border-l border-border bg-background p-4">
            <BuilderPanel
              tab={tab}
              onTabChange={setTab}
              content={content}
              selected={selected}
              onUpdate={update}
              onSelect={setSelectedId}
            />
          </aside>
        </div>
        <ShareDialog
          appId={app._id}
          sharing={app.sharing}
          open={sharing}
          onOpenChange={setSharing}
        />
      </div>
    </AppDatasetsProvider>
  );
}

/** The builder (/apps/$appId/edit) — creator only; anyone else is sent to the viewer. */
export function AppBuilderPage({ appId }: { appId: string }) {
  const app = useQuery({ ...convexQuery(api.appBuilder.apps.get, { appId }) }).data;
  if (app === undefined) {
    return <PageLoading />;
  }
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
              Only an app's creator can edit it. You can still open it, or make your own copy from
              there.
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
  return <Builder key={app._id} app={app} />;
}
