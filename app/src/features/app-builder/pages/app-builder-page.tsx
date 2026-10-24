import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Eye,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import type { Widget } from "#convex/appBuilder/validators";

import { AppCanvasEditor } from "../components/app-canvas";
import { AppDetailsDialog } from "../components/app-details-dialog";
import { BuilderPanel, type PanelTab } from "../components/builder-panel";
import { ShareDialog } from "../components/share-dialog";
import { AppDatasetsProvider } from "../data";
import { newWidgetId, resizeWidget } from "../lib/layout";
import { useAppEditor, type AppDoc, type SaveStatus } from "../use-app-editor";

function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
      >
        <AlertCircle className="size-3.5" />
        Not saved — retry
      </button>
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
      <Loader2 className="size-3.5 animate-spin" />
      Saving…
    </span>
  );
}

function EmptyCanvas({ hasData, onStart }: { hasData: boolean; onStart: (tab: PanelTab) => void }) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border p-10 text-center">
      <LayoutDashboard className="size-8 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Start building</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {hasData
          ? "Add a map, chart, table, number or text block from the panel. Drag widgets to reorder them and pull their corners to resize."
          : "First add a dataset — every map, chart and table in the app reads from the app's datasets."}
      </p>
      <Button
        type="button"
        onClick={() => {
          onStart(hasData ? "add" : "data");
        }}
      >
        {hasData ? "Add a widget" : "Add a dataset"}
      </Button>
    </div>
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
          <DropdownMenuItem
            onClick={() => {
              setEditing(true);
            }}
          >
            <Pencil />
            Edit title & description
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              setDeleting(true);
            }}
          >
            <Trash2 />
            Delete app
          </DropdownMenuItem>
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
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this app?"
        description="The app and its layout are deleted for everyone with the link. Its datasets are not affected."
        confirmLabel="Delete app"
        destructive
        onConfirm={() => {
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
      />
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
            <Link
              to="/apps"
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              Apps
            </Link>
            <span className="text-muted-foreground/50">/</span>
            <h1 className="truncate text-sm font-semibold">{app.title}</h1>
            <SaveIndicator status={editor.status} onRetry={editor.retry} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RouterButton to="/apps/$appId" params={{ appId: app._id }} variant="outline">
              <Eye />
              View app
            </RouterButton>
            <Button
              type="button"
              onClick={() => {
                setSharing(true);
              }}
            >
              <Share2 />
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
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (app === null || !app.canEdit) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="mb-2 text-lg font-semibold">You can't edit this app</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Only an app's creator can edit it. You can still open it, or make your own copy from
          there.
        </p>
        <RouterButton to="/apps/$appId" params={{ appId }}>
          Open the app
        </RouterButton>
      </main>
    );
  }
  // Keyed by id: the editor's working copy initializes once per app.
  return <Builder key={app._id} app={app} />;
}
