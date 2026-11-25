import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@caden/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import { Skeleton } from "@caden/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@caden/ui/components/table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ExternalLink,
  LayoutDashboard,
  Map as MapIcon,
  Pencil,
  Plus,
  Rocket,
  Search,
  Trash2,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";

import { VisibilityBadge } from "#/components/visibility-badge";
import { relativeTime } from "#/features/views";
import { errorMessage } from "@/lib/errors";
import * as appVersionsStore from "@/lib/store/app-versions";
import * as appsStore from "@/lib/store/apps";
import * as mapsStore from "@/lib/store/maps";

import { VIEWER_REASON } from "../lib/viewer-posture";
import { FolderNameDialog } from "./catalog-dialogs";
import { RowMenu, SortHead } from "./catalog-rows";
import { useProjectShell } from "./project-context";

/**
 * The project's Maps and Apps pages: one table each, in the catalog's style.
 * A row opens its editor; the row menu renames and deletes. Creating stays
 * with the shell's dialogs, so the toolbar's "Add new" and these pages share
 * one form each.
 */

type ListSortKey = "name" | "modified";
interface ListSort {
  descending: boolean;
  key: ListSortKey;
}

/** The row a rename or delete dialog is about. */
type RowDialog = { type: "rename" | "delete"; id: string; name: string } | undefined;

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** Rows that match the search, in the chosen order. */
export function listRows<Row>(
  rows: readonly Row[],
  options: {
    modifiedOf: (row: Row) => string;
    nameOf: (row: Row) => string;
    search: string;
    sort: ListSort;
  },
): Row[] {
  const needle = options.search.trim().toLowerCase(),
    direction = options.sort.descending ? -1 : 1;
  return rows
    .filter((row) => needle === "" || options.nameOf(row).toLowerCase().includes(needle))
    .toSorted((left, right) =>
      options.sort.key === "name"
        ? direction * options.nameOf(left).localeCompare(options.nameOf(right))
        : direction * options.modifiedOf(left).localeCompare(options.modifiedOf(right)),
    );
}

function useListSort(): [ListSort, (key: ListSortKey) => void] {
  const [sort, setSort] = useState<ListSort>({ descending: false, key: "name" });
  return [
    sort,
    (key) => {
      setSort((current) => ({
        descending: current.key === key ? !current.descending : key !== "name",
        key,
      }));
    },
  ];
}

/** One write from a row: says what happened, and reports whether it landed. */
async function writeRow(
  job: () => Promise<number>,
  messages: { denied: string; done: string; failed: string },
): Promise<boolean> {
  try {
    if ((await job()) === 0) {
      toast.error(messages.denied);
      return false;
    }
    toast.success(messages.done);
    return true;
  } catch (error) {
    toast.error(errorMessage(error, messages.failed));
    return false;
  }
}

function CreateButton({
  canEdit,
  label,
  onClick,
}: {
  canEdit: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      disabled={!canEdit}
      onClick={onClick}
      size="sm"
      title={canEdit ? undefined : VIEWER_REASON}
      type="button"
    >
      <Plus />
      {label}
    </Button>
  );
}

/** The page around a list: title and count, the create button, the search, then the table. */
function ListPage({
  action,
  children,
  count,
  onSearch,
  search,
  searchLabel,
  title,
}: {
  action: ReactNode;
  children: ReactNode;
  count: string;
  onSearch: (value: string) => void;
  search: string;
  searchLabel: string;
  title: string;
}) {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-baseline gap-2 text-lg font-semibold">
          {title}
          <span className="text-sm font-normal text-muted-foreground">{count}</span>
        </h1>
        {action}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={searchLabel}
          className="pl-7"
          onChange={(event) => {
            onSearch(event.target.value);
          }}
          placeholder={`${searchLabel}…`}
          value={search}
        />
      </div>
      <div className="rounded-lg border">{children}</div>
    </main>
  );
}

function ListSkeleton() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-6">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-64 w-full" />
    </main>
  );
}

function EmptyList({
  action,
  canEdit,
  description,
  icon: Icon,
  title,
}: {
  action: ReactNode;
  canEdit: boolean;
  description: string;
  icon: ComponentType;
  title: string;
}) {
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {action}
          {canEdit ? null : <p className="text-xs text-muted-foreground">{VIEWER_REASON}</p>}
        </EmptyContent>
      </Empty>
    </main>
  );
}

function NoMatches({ columns, noun }: { columns: number; noun: string }) {
  return (
    <TableRow>
      <TableCell className="py-10 text-center text-muted-foreground" colSpan={columns}>
        No {noun} match this search.
      </TableCell>
    </TableRow>
  );
}

/** The name cell: icon, the link into the editor, and the description under it. */
function NameCell({
  children,
  description,
  icon,
}: {
  children: ReactNode;
  description: string | null;
  icon: ReactNode;
}) {
  return (
    <TableCell className="max-w-0">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <div className="flex min-w-0 flex-col">
          {children}
          {description !== null && description !== "" && (
            <span className="truncate text-xs text-muted-foreground">{description}</span>
          )}
        </div>
      </div>
    </TableCell>
  );
}

/** Rename and delete, the two actions every row shares. */
function EditItems({
  canEdit,
  onDelete,
  onRename,
}: {
  canEdit: boolean;
  onDelete: () => void;
  onRename: () => void;
}) {
  const reason = canEdit ? undefined : VIEWER_REASON;
  return (
    <>
      <DropdownMenuItem disabled={!canEdit} onClick={onRename} title={reason}>
        <Pencil />
        Rename…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!canEdit} onClick={onDelete} title={reason} variant="destructive">
        <Trash2 />
        Delete…
      </DropdownMenuItem>
    </>
  );
}

function ListHead({
  children,
  onSort,
  sort,
}: {
  children: ReactNode;
  onSort: (key: ListSortKey) => void;
  sort: ListSort;
}) {
  return (
    <TableHeader>
      <TableRow>
        <SortHead label="Name" onSort={onSort} sort={sort} sortKey="name" />
        {children}
        <TableHead className="hidden w-36 md:table-cell">Who can open</TableHead>
        <SortHead
          className="hidden w-28 lg:table-cell"
          label="Modified"
          onSort={onSort}
          sort={sort}
          sortKey="modified"
        />
        <TableHead className="w-10" />
      </TableRow>
    </TableHeader>
  );
}

/** Layers per map and the apps that show each map, for the project's maps. */
function useMapUsage(projectId: string): {
  appTitles: Map<string, string[]>;
  layerCounts: Map<string, number>;
} {
  const placementsQuery = useQuery(mapsStore.listAllPlacementsQueryOptions()),
    appsQuery = useQuery(appsStore.listForProjectQueryOptions({ projectId })),
    layerCounts = new globalThis.Map<string, number>(),
    appTitles = new globalThis.Map<string, string[]>();
  for (const placement of placementsQuery.data ?? []) {
    layerCounts.set(placement.mapId, (layerCounts.get(placement.mapId) ?? 0) + 1);
  }
  for (const app of appsQuery.data ?? []) {
    for (const mapId of appsStore.appMapIds(app)) {
      appTitles.set(mapId, [...(appTitles.get(mapId) ?? []), app.title]);
    }
  }
  return { appTitles, layerCounts };
}

/** The rename and delete dialogs of one map row. */
function MapDialogs({
  dialog,
  map,
  onClose,
  usedBy,
}: {
  dialog: NonNullable<RowDialog>;
  map: mapsStore.MapRow | undefined;
  onClose: () => void;
  /** Titles of the apps that show this map. */
  usedBy: readonly string[];
}) {
  const queryClient = useQueryClient(),
    [busy, setBusy] = useState(false),
    finish = async (job: () => Promise<boolean>): Promise<void> => {
      setBusy(true);
      if (await job()) {
        void queryClient.invalidateQueries({ queryKey: ["maps"] });
        onClose();
      }
      setBusy(false);
    };
  if (dialog.type === "rename") {
    return (
      <FolderNameDialog
        busy={busy}
        description="The new name shows everywhere the map is used."
        fieldLabel="Map name"
        initialName={dialog.name}
        onOpenChange={onClose}
        onSubmit={(name) => {
          void finish(
            async () =>
              await writeRow(
                async () =>
                  await mapsStore.update({
                    description:
                      map === undefined || map.description === null ? undefined : map.description,
                    mapId: dialog.id,
                    name,
                  }),
                {
                  denied: "The map wasn't renamed. You may not have access.",
                  done: `Renamed to “${name}”.`,
                  failed: "Failed to rename the map.",
                },
              ),
          );
        }}
        submitLabel="Rename"
        title="Rename map"
      />
    );
  }
  return (
    <ConfirmDialog
      confirmLabel="Delete map"
      description={
        usedBy.length === 0
          ? "The map and its layer list are deleted. The project's datasets stay."
          : `The map and its layer list are deleted. The project's datasets stay. ${plural(usedBy.length, "app shows", "apps show")} this map and will lose it: ${usedBy.join(", ")}.`
      }
      destructive
      onConfirm={() => {
        void finish(
          async () =>
            await writeRow(
              async () => {
                await mapsStore.remove({ mapId: dialog.id });
                return 1;
              },
              {
                denied: "The map wasn't deleted. You may not have access.",
                done: `Deleted “${dialog.name}”.`,
                failed: "Failed to delete the map.",
              },
            ),
        );
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={`Delete “${dialog.name}”?`}
    />
  );
}

/** The project's Maps page. */
export function ProjectMaps() {
  const { canEdit, openNewMap, projectId } = useProjectShell(),
    mapsQuery = useQuery(mapsStore.listForProjectQueryOptions({ projectId })),
    [search, setSearch] = useState(""),
    [sort, onSort] = useListSort(),
    [dialog, setDialog] = useState<RowDialog>(),
    { appTitles, layerCounts } = useMapUsage(projectId),
    create = <CreateButton canEdit={canEdit} label="New map" onClick={openNewMap} />;
  if (mapsQuery.data === undefined) {
    return <ListSkeleton />;
  }
  const maps = mapsQuery.data;
  if (maps.length === 0) {
    return (
      <EmptyList
        action={create}
        canEdit={canEdit}
        description="A map shows this project's datasets as layers. Create one, then add the datasets you want on it."
        icon={MapIcon}
        title="No maps yet"
      />
    );
  }
  const rows = listRows(maps, {
    modifiedOf: (map) => map.updatedAt,
    nameOf: (map) => map.name,
    search,
    sort,
  });
  return (
    <ListPage
      action={create}
      count={plural(maps.length, "map", "maps")}
      onSearch={setSearch}
      search={search}
      searchLabel="Search maps"
      title="Maps"
    >
      <Table className="table-fixed">
        <ListHead onSort={onSort} sort={sort}>
          <TableHead className="hidden w-24 text-right sm:table-cell">Layers</TableHead>
          <TableHead className="hidden w-28 md:table-cell">Used in</TableHead>
        </ListHead>
        <TableBody>
          {rows.length === 0 && <NoMatches columns={6} noun="maps" />}
          {rows.map((map) => {
            const apps = appTitles.get(map.id) ?? [];
            return (
              <TableRow key={map.id}>
                <NameCell
                  description={map.description}
                  icon={
                    <MapIcon className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  }
                >
                  <Link
                    className="truncate font-medium hover:underline"
                    params={{ mapId: map.id, projectId }}
                    to="/projects/$projectId/maps/$mapId"
                  >
                    {map.name}
                  </Link>
                </NameCell>
                <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                  {plural(layerCounts.get(map.id) ?? 0, "layer", "layers")}
                </TableCell>
                <TableCell
                  className="hidden text-muted-foreground md:table-cell"
                  title={apps.join(", ")}
                >
                  {apps.length === 0 ? "" : plural(apps.length, "app", "apps")}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <VisibilityBadge visibility={map.visibility} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {relativeTime(map.updatedAt)}
                </TableCell>
                <RowMenu label={`Actions for ${map.name}`}>
                  <EditItems
                    canEdit={canEdit}
                    onDelete={() => {
                      setDialog({ id: map.id, name: map.name, type: "delete" });
                    }}
                    onRename={() => {
                      setDialog({ id: map.id, name: map.name, type: "rename" });
                    }}
                  />
                </RowMenu>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {dialog === undefined ? null : (
        <MapDialogs
          dialog={dialog}
          map={maps.find((row) => row.id === dialog.id)}
          onClose={() => {
            setDialog(undefined);
          }}
          usedBy={appTitles.get(dialog.id) ?? []}
        />
      )}
    </ListPage>
  );
}

/** Whether the app has a published snapshot, and which one. */
function AppStatus({ appId }: { appId: string }) {
  const head = useQuery(appVersionsStore.headQueryOptions({ appId }));
  if (head.isPending) {
    return null;
  }
  return head.data === null || head.data === undefined ? (
    <Badge title="Not published yet. Only the builder shows it." variant="outline">
      Draft
    </Badge>
  ) : (
    <Badge
      title="The published version. Edits don't change it until you publish again."
      variant="secondary"
    >
      <Rocket data-icon="inline-start" />
      {head.data.versionLabel}
    </Badge>
  );
}

/** The project's Apps page. */
export function ProjectApps() {
  const { canEdit, openNewApp, projectId } = useProjectShell(),
    queryClient = useQueryClient(),
    navigate = useNavigate(),
    appsQuery = useQuery(appsStore.listForProjectQueryOptions({ projectId })),
    [search, setSearch] = useState(""),
    [sort, onSort] = useListSort(),
    [dialog, setDialog] = useState<RowDialog>(),
    [busy, setBusy] = useState(false),
    create = <CreateButton canEdit={canEdit} label="New app" onClick={openNewApp} />;
  if (appsQuery.data === undefined) {
    return <ListSkeleton />;
  }
  const apps = appsQuery.data;
  if (apps.length === 0) {
    return (
      <EmptyList
        action={create}
        canEdit={canEdit}
        description="An app puts this project's maps, charts and tables on pages you can share. Create one to start building."
        icon={LayoutDashboard}
        title="No apps yet"
      />
    );
  }
  const rows = listRows(apps, {
      modifiedOf: (app) => app.updatedAt,
      nameOf: (app) => app.title,
      search,
      sort,
    }),
    finish = async (job: () => Promise<boolean>): Promise<void> => {
      setBusy(true);
      if (await job()) {
        void queryClient.invalidateQueries({ queryKey: ["apps"] });
        setDialog(undefined);
      }
      setBusy(false);
    };
  return (
    <ListPage
      action={create}
      count={plural(apps.length, "app", "apps")}
      onSearch={setSearch}
      search={search}
      searchLabel="Search apps"
      title="Apps"
    >
      <Table className="table-fixed">
        <ListHead onSort={onSort} sort={sort}>
          <TableHead className="hidden w-40 sm:table-cell">Contents</TableHead>
          <TableHead className="hidden w-28 md:table-cell">Status</TableHead>
        </ListHead>
        <TableBody>
          {rows.length === 0 && <NoMatches columns={6} noun="apps" />}
          {rows.map((app) => {
            const summary = appsStore.toSummary(app);
            return (
              <TableRow key={app.id}>
                <NameCell
                  description={app.description}
                  icon={
                    <LayoutDashboard className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  }
                >
                  <Link
                    className="truncate font-medium hover:underline"
                    params={{ appId: app.id, projectId }}
                    to="/projects/$projectId/apps/$appId/edit"
                  >
                    {app.title}
                  </Link>
                </NameCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {plural(summary.pageCount, "page", "pages")} ·{" "}
                  {plural(summary.widgetCount, "widget", "widgets")}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <AppStatus appId={app.id} />
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <VisibilityBadge visibility={app.visibility} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {relativeTime(app.updatedAt)}
                </TableCell>
                <RowMenu label={`Actions for ${app.title}`}>
                  <DropdownMenuItem
                    onClick={() => {
                      void navigate({ params: { appId: app.id }, to: "/apps/$appId" });
                    }}
                  >
                    <ExternalLink />
                    Open the app
                  </DropdownMenuItem>
                  <EditItems
                    canEdit={canEdit}
                    onDelete={() => {
                      setDialog({ id: app.id, name: app.title, type: "delete" });
                    }}
                    onRename={() => {
                      setDialog({ id: app.id, name: app.title, type: "rename" });
                    }}
                  />
                </RowMenu>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {dialog !== undefined && dialog.type === "rename" && (
        <FolderNameDialog
          busy={busy}
          description="The new name shows in the builder and on the shared app."
          fieldLabel="App name"
          initialName={dialog.name}
          onOpenChange={() => {
            setDialog(undefined);
          }}
          onSubmit={(title) => {
            void finish(
              async () =>
                await writeRow(
                  async () => await appsStore.updateDetails({ appId: dialog.id, title }),
                  {
                    denied: "The app wasn't renamed. You may not have access.",
                    done: `Renamed to “${title}”.`,
                    failed: "Failed to rename the app.",
                  },
                ),
            );
          }}
          submitLabel="Rename"
          title="Rename app"
        />
      )}
      <ConfirmDialog
        confirmLabel="Delete app"
        description="The app, its pages and its published versions are deleted, and its shared link stops working. The project's maps and datasets stay."
        destructive
        onConfirm={() => {
          if (dialog === undefined) {
            return;
          }
          void finish(
            async () =>
              await writeRow(async () => await appsStore.remove({ appId: dialog.id }), {
                denied: "The app wasn't deleted. You may not have access.",
                done: `Deleted “${dialog.name}”.`,
                failed: "Failed to delete the app.",
              }),
          );
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(undefined);
          }
        }}
        open={dialog !== undefined && dialog.type === "delete"}
        title={dialog === undefined ? "" : `Delete “${dialog.name}”?`}
      />
    </ListPage>
  );
}
