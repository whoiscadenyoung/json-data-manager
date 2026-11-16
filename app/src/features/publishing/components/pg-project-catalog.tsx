import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { ToggleGroup, ToggleGroupItem } from "@caden/ui/components/toggle-group";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Database,
  FolderInput,
  FolderPlus,
  Home,
  ListPlus,
  Plus,
  Search,
  Table2,
  Workflow,
  X,
} from "lucide-react";
import { Fragment, useState, type DragEvent } from "react";
import { toast } from "sonner";

import { DuplicateViewDialog } from "#/features/views";
import { RouterButton } from "@/components/router-button";
import { errorMessage } from "@/lib/errors";
import { relationEndsOf } from "@/lib/relation-phrases";
import * as datasetsStore from "@/lib/store/datasets";
import * as foldersStore from "@/lib/store/project-folders";
import * as projectsStore from "@/lib/store/projects";
import type { CatalogRow } from "@/lib/store/projects";
import * as relationsStore from "@/lib/store/relations";
import { latestRunsQueryOptions, listViewSummariesQueryOptions } from "@/lib/store/view-reads";
import type { ViewSummary } from "@/lib/store/view-reads";

import {
  canMoveFolder,
  folderPath,
  listEntries,
  resolveFolderId,
  subtreeIds,
  type BrowserItem,
  type KindFilter,
  type SortKey,
  type SortState,
  type TreeFolder,
} from "../lib/catalog-tree";
import { VIEWER_REASON } from "../lib/pg-viewer-posture";
import { DeleteFolderDialog, FolderNameDialog, MoveDialog } from "./pg-catalog-dialogs";
import {
  CatalogFolderRow,
  CatalogItemRow,
  type ItemDetail,
  type RowDropProps,
} from "./pg-catalog-rows";
import { useProjectShell } from "./pg-project-context";
import { PgProjectRelationsSection } from "./pg-project-relations";
import { PgLinkedVersionActions, PgProvenanceChips } from "./pg-project-workspace";

/**
 * The project catalog as a file browser (migration 0034). Datasets and views
 * list together in one table, organised into folders the project's editors
 * make: open a folder, drag rows onto a folder or a breadcrumb, or select
 * rows and "Move to". Folders hold membership rows, so they only organise
 * this project; nothing about the data, its visibility or its lineage reads
 * them. The open folder is the URL's `folder` search value. A search looks
 * through the whole project, whichever folder is open.
 */

/** What is being moved: folders and/or items (membership row ids). */
interface Selection {
  folderIds: string[];
  membershipIds: string[];
}

type DialogState =
  | { type: "new-folder" }
  | { type: "rename"; folder: TreeFolder }
  | { type: "delete"; folder: TreeFolder }
  | { type: "move"; selection: Selection; subject: string; from: string | null }
  | { type: "versions"; membershipId: string; title: string }
  | { type: "duplicate"; view: ViewSummary };

const FOLDER_KEY = "folder:",
  ITEM_KEY = "item:";

function selectionOf(keys: ReadonlySet<string>): Selection {
  const all = [...keys];
  return {
    folderIds: all
      .filter((key) => key.startsWith(FOLDER_KEY))
      .map((key) => key.slice(FOLDER_KEY.length)),
    membershipIds: all
      .filter((key) => key.startsWith(ITEM_KEY))
      .map((key) => key.slice(ITEM_KEY.length)),
  };
}

function countOf(selection: Selection): number {
  return selection.folderIds.length + selection.membershipIds.length;
}

/** One membership as the browser lists it; a membership whose dataset is gone lists as missing. */
function itemOf(row: CatalogRow, dataset: datasetsStore.DatasetRow | undefined): BrowserItem {
  const base = {
    datasetId: row.artifact.artifactId,
    folderId: row.artifact.folderId,
    membershipId: row.artifact.id,
  };
  if (dataset === undefined) {
    return { ...base, kind: "missing", modifiedAt: null, rowCount: null, title: "Deleted dataset" };
  }
  return {
    ...base,
    kind: dataset.kind === "view" ? "view" : "dataset",
    modifiedAt: dataset.updatedAt,
    rowCount: dataset.entryCount,
    title: dataset.title,
  };
}

/** Whether a dataset id names a source dataset (not a view, not missing). */
function isSource(datasetsById: Map<string, datasetsStore.DatasetRow>, id: string): boolean {
  const dataset = datasetsById.get(id);
  return dataset !== undefined && dataset.kind !== "view";
}

/** The project's catalog reads, shaped for the browser. */
function useCatalogData(projectId: string, catalog: CatalogRow[]) {
  const datasetsQuery = useQuery(datasetsStore.listQueryOptions()),
    foldersQuery = useQuery(foldersStore.listFoldersQueryOptions({ projectId })),
    summaries = useQuery(listViewSummariesQueryOptions()),
    datasetsById = new Map((datasetsQuery.data ?? []).map((dataset) => [dataset.id, dataset])),
    viewsById = new Map((summaries.data ?? []).map((view) => [view.id, view])),
    rows = catalog.filter((row) => row.artifact.artifactKind === "dataset"),
    artifactIds = rows.map((row) => row.artifact.artifactId),
    sourceIds = artifactIds.filter((id) => isSource(datasetsById, id)),
    viewIds = artifactIds.filter((id) => viewsById.has(id)),
    relations =
      useQuery(relationsStore.listForDatasetsQueryOptions({ datasetIds: sourceIds })).data ?? [],
    runs = useQuery(latestRunsQueryOptions(viewIds)).data,
    items: BrowserItem[] = [],
    details = new Map<string, ItemDetail>();
  for (const row of rows) {
    const { artifactId, id } = row.artifact,
      dataset = datasetsById.get(artifactId);
    items.push(itemOf(row, dataset));
    details.set(id, {
      draft: dataset !== undefined && dataset.lifecycle === "draft",
      geospatial: dataset !== undefined && dataset.isGeospatial,
      lastRun: runs === undefined ? undefined : runs.get(artifactId),
      relationEnds: relationEndsOf(relations, artifactId),
      row,
      view: viewsById.get(artifactId),
    });
  }
  return {
    details,
    folders: foldersQuery.data ?? [],
    items,
    loading: datasetsQuery.isPending || foldersQuery.isPending,
    /** The project's datasets and views, for the duplicate-view dialog's input picks. */
    pickerDatasets: rows.flatMap((row) => {
      const dataset = datasetsById.get(row.artifact.artifactId);
      return dataset === undefined
        ? []
        : [{ id: dataset.id, kind: dataset.kind, title: dataset.title }];
    }),
    titleOf: (datasetId: string): string => {
      const dataset = datasetsById.get(datasetId);
      return dataset === undefined ? "a dataset you can't see" : dataset.title;
    },
  };
}

/** Runs one catalog write: toast the outcome, refresh the reads. Returns whether it landed. */
function useCatalogWrite(invalidateAll: () => void) {
  const [busy, setBusy] = useState(false),
    write = async (
      action: () => Promise<number>,
      messages: { denied: string; done: string },
    ): Promise<boolean> => {
      setBusy(true);
      try {
        const affected = await action();
        if (affected === 0) {
          toast.error(messages.denied);
          return false;
        }
        toast.success(messages.done);
        invalidateAll();
        return true;
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
        return false;
      } finally {
        setBusy(false);
      }
    };
  return { busy, write };
}

/** A sortable column header. */
function SortHead({
  align,
  className,
  label,
  onSort,
  sort,
  sortKey,
}: {
  align?: "right";
  className?: string;
  label: string;
  onSort: (key: SortKey) => void;
  sort: SortState;
  sortKey: SortKey;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead
      aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}
      className={className}
    >
      <button
        className={`inline-flex items-center gap-1 hover:text-foreground ${align === "right" ? "w-full justify-end" : ""}`}
        onClick={() => {
          onSort(sortKey);
        }}
        type="button"
      >
        {label}
        {active ? (
          sort.descending ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

/** Catalog > Folder > Subfolder. Every crumb but the last is a link, and a drop target. */
function FolderCrumbs({
  dropOn,
  path,
  projectId,
}: {
  dropOn: (folderId: string | null) => RowDropProps;
  path: TreeFolder[];
  projectId: string;
}) {
  const crumbClass =
    "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 data-[drop-active=true]:bg-primary/10 data-[drop-active=true]:outline data-[drop-active=true]:outline-1 data-[drop-active=true]:outline-primary";
  return (
    <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
      {path.length === 0 ? (
        <span aria-current="page" className={`${crumbClass} font-semibold`}>
          <Home className="h-3.5 w-3.5" />
          Catalog
        </span>
      ) : (
        <Link
          className={`${crumbClass} text-muted-foreground hover:text-foreground`}
          params={{ projectId }}
          search={{}}
          to="/projects/$projectId/catalog"
          {...dropOn(null)}
        >
          <Home className="h-3.5 w-3.5" />
          Catalog
        </Link>
      )}
      {path.map((folder, index) => (
        <Fragment key={folder.id}>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {index === path.length - 1 ? (
            <span aria-current="page" className={`${crumbClass} truncate font-semibold`}>
              {folder.name}
            </span>
          ) : (
            <Link
              className={`${crumbClass} truncate text-muted-foreground hover:text-foreground`}
              params={{ projectId }}
              search={{ folder: folder.id }}
              to="/projects/$projectId/catalog"
              {...dropOn(folder.id)}
            >
              {folder.name}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/** The "Add" menu: everything that can enter the catalog. */
function AddMenu({
  canEdit,
  onAddExisting,
  projectId,
}: {
  canEdit: boolean;
  onAddExisting: () => void;
  projectId: string;
}) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button disabled={!canEdit} size="sm" title={canEdit ? undefined : VIEWER_REASON} />
        }
      >
        <Plus />
        Add
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            void navigate({ params: { projectId }, to: "/projects/$projectId/create" });
          }}
        >
          <Table2 />
          New dataset
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            void navigate({ params: { projectId }, to: "/projects/$projectId/views/new" });
          }}
        >
          <Workflow />
          New view
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAddExisting}>
          <ListPlus />
          Existing dataset
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The empty project: nothing in the catalog and no folders yet. */
function EmptyCatalog({
  canEdit,
  onAddExisting,
  projectId,
}: {
  canEdit: boolean;
  onAddExisting: () => void;
  projectId: string;
}) {
  return (
    <Empty className="min-h-80 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Database />
        </EmptyMedia>
        <EmptyTitle>This project's catalog is empty</EmptyTitle>
        <EmptyDescription>
          Create or import a dataset here (it lands as a draft the project's members can see), or
          add an existing one by reference. Nothing is copied.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          <RouterButton params={{ projectId }} to="/projects/$projectId/create">
            <Plus className="mr-2 h-4 w-4" />
            Add dataset
          </RouterButton>
          <Button
            disabled={!canEdit}
            onClick={onAddExisting}
            title={canEdit ? undefined : VIEWER_REASON}
            type="button"
            variant="outline"
          >
            <ListPlus className="mr-2 h-4 w-4" />
            Add existing
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}

/** The one-line message a listing with no rows shows. */
function emptyMessage(searching: boolean, kind: KindFilter, atRoot: boolean): string {
  if (searching) {
    return "Nothing in this project matches that search.";
  }
  if (kind !== "all") {
    return `No ${kind === "view" ? "views" : "datasets"} in this folder.`;
  }
  return atRoot
    ? "Nothing here yet."
    : "This folder is empty. Drag datasets and views onto it, or select them and choose Move to.";
}

/** The linked item's version dialog: its pin state and the sync / pin / float / revert actions. */
function VersionsDialog({
  onDone,
  onOpenChange,
  projectId,
  row,
  title,
}: {
  onDone: () => void;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  row: CatalogRow;
  title: string;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            This dataset is linked from the global catalog. Choose whether it stays on a fixed
            version or follows the source as it republishes.
          </DialogDescription>
        </DialogHeader>
        <PgProvenanceChips draft={false} row={row} />
        <div className="flex justify-start">
          <PgLinkedVersionActions onDone={onDone} projectId={projectId} row={row} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Data → Catalog section: the project's datasets and views as a file browser. */
// The browser's one component owns what its parts share: the open folder, the
// selection, the drag in flight and the open dialog. The branches are the
// dialogs (one per `DialogState`) and the three page states (loading, empty
// project, listing); splitting them would thread that shared state through
// props for no reuse.
// oxlint-disable-next-line eslint/complexity -- one owner for the browser's shared state; see above.
export function PgProjectCatalog() {
  const { canEdit, catalog, invalidateAll, openAdd, projectId } = useProjectShell(),
    navigate = useNavigate(),
    requested = useSearch({ from: "/projects/$projectId/catalog" }).folder,
    { details, folders, items, loading, pickerDatasets, titleOf } = useCatalogData(
      projectId,
      catalog,
    ),
    { busy, write } = useCatalogWrite(invalidateAll),
    [search, setSearch] = useState(""),
    [kind, setKind] = useState<KindFilter>("all"),
    [sort, setSort] = useState<SortState>({ descending: false, key: "name" }),
    [selected, setSelected] = useState<ReadonlySet<string>>(new Set()),
    [dragging, setDragging] = useState<Selection>(),
    [dropTarget, setDropTarget] = useState<string>(),
    [dialog, setDialog] = useState<DialogState>(),
    folderId = resolveFolderId(folders, requested),
    path = folderPath(folders, folderId),
    searching = search.trim() !== "",
    entries = listEntries({ folderId, folders, items, kind, search, sort }),
    // Only rows still listed count as selected (a move or a filter drops the rest).
    listedKeys = new Set(
      entries.map((entry) =>
        entry.type === "folder"
          ? `${FOLDER_KEY}${entry.folder.id}`
          : `${ITEM_KEY}${entry.item.membershipId}`,
      ),
    ),
    activeKeys = new Set([...selected].filter((key) => listedKeys.has(key))),
    activeSelection = selectionOf(activeKeys),
    closeDialog = (): void => {
      setDialog(undefined);
    },
    /** A dialog's write: close it once the write lands, then run `after`. */
    writeThenClose = async (
      action: () => Promise<number>,
      messages: { denied: string; done: string },
      after?: () => void,
    ): Promise<void> => {
      if (await write(action, messages)) {
        closeDialog();
        if (after !== undefined) {
          after();
        }
      }
    },
    openFolder = (id: string | null): void => {
      void navigate({
        params: { projectId },
        search: id === null ? {} : { folder: id },
        to: "/projects/$projectId/catalog",
      });
    },
    toggle = (key: string): void => {
      const next = new Set(activeKeys);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      setSelected(next);
    },
    folderName = (id: string | null): string => {
      const folder = folders.find((candidate) => candidate.id === id);
      return folder === undefined ? "Catalog" : folder.name;
    },
    /** What of a selection would actually change place by moving to `target`. */
    movable = (selection: Selection, target: string | null): Selection => ({
      folderIds: selection.folderIds.filter((id) => canMoveFolder(folders, id, target)),
      membershipIds: selection.membershipIds.filter((id) => {
        const item = items.find((candidate) => candidate.membershipId === id);
        return item !== undefined && item.folderId !== target;
      }),
    }),
    move = async (selection: Selection, target: string | null): Promise<void> => {
      const moving = movable(selection, target),
        total = countOf(moving);
      if (total === 0) {
        return;
      }
      const landed = await write(
        async () => {
          const counts = await Promise.all([
            foldersStore.moveArtifacts({ folderId: target, membershipIds: moving.membershipIds }),
            ...moving.folderIds.map(
              async (id) => await foldersStore.moveFolder({ folderId: id, parentId: target }),
            ),
          ]);
          return counts.reduce((sum, count) => sum + count, 0);
        },
        {
          denied: "Nothing moved. You may not have access.",
          done: `Moved ${total} ${total === 1 ? "item" : "items"} to ${folderName(target)}.`,
        },
      );
      if (landed) {
        setSelected(new Set());
        closeDialog();
      }
    },
    dropOn = (target: string | null): RowDropProps => {
      const accepts = dragging !== undefined && countOf(movable(dragging, target)) > 0,
        key = target ?? "root";
      return {
        "data-drop-active": accepts && dropTarget === key,
        onDragLeave: () => {
          setDropTarget((current) => (current === key ? undefined : current));
        },
        onDragOver: (event: DragEvent) => {
          if (accepts) {
            event.preventDefault();
            setDropTarget(key);
          }
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault();
          setDropTarget(undefined);
          if (dragging !== undefined) {
            void move(dragging, target);
          }
          setDragging(undefined);
        },
      };
    },
    dragOf = (key: string) => ({
      draggable: canEdit,
      onDragEnd: () => {
        setDragging(undefined);
        setDropTarget(undefined);
      },
      onDragStart: (event: DragEvent) => {
        // A selected row drags the whole selection; any other row drags alone.
        const moving = activeKeys.has(key) ? activeSelection : selectionOf(new Set([key]));
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(countOf(moving)));
        setDragging(moving);
      },
    }),
    askMove = (selection: Selection, subject: string, from: string | null): void => {
      setDialog({ from, selection, subject, type: "move" });
    },
    removeItem = (item: BrowserItem): void => {
      void write(
        async () => {
          const outcome = await projectsStore.removeArtifact({
            artifactId: item.datasetId,
            projectId,
          });
          return outcome.affected;
        },
        {
          denied: "The reference didn't remove. You may not have access.",
          done: "Removed from the project. The dataset itself is untouched.",
        },
      );
    },
    onSort = (key: SortKey): void => {
      setSort((current) => ({
        descending: current.key === key ? !current.descending : key !== "name",
        key,
      }));
    },
    reason = canEdit ? undefined : VIEWER_REASON,
    selectedCount = countOf(activeSelection),
    allSelected = entries.length > 0 && selectedCount === entries.length,
    versionsRow =
      dialog !== undefined && dialog.type === "versions"
        ? catalog.find((row) => row.artifact.id === dialog.membershipId)
        : undefined;

  if (loading) {
    return (
      <main className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }
  if (catalog.length === 0 && folders.length === 0) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-6">
        <EmptyCatalog canEdit={canEdit} onAddExisting={openAdd} projectId={projectId} />
      </main>
    );
  }
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FolderCrumbs dropOn={dropOn} path={path} projectId={projectId} />
        {/* A selection swaps the page actions for its own, in place: the table never jumps. */}
        {selectedCount > 0 ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{selectedCount} selected</span>
            <Button
              disabled={!canEdit}
              onClick={() => {
                askMove(
                  activeSelection,
                  `${selectedCount} ${selectedCount === 1 ? "item" : "items"}`,
                  searching ? null : folderId,
                );
              }}
              size="sm"
              title={reason}
              type="button"
              variant="outline"
            >
              <FolderInput />
              Move to…
            </Button>
            <Button
              aria-label="Clear selection"
              onClick={() => {
                setSelected(new Set());
              }}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              disabled={!canEdit}
              onClick={() => {
                setDialog({ type: "new-folder" });
              }}
              size="sm"
              title={reason}
              type="button"
              variant="outline"
            >
              <FolderPlus />
              New folder
            </Button>
            <AddMenu canEdit={canEdit} onAddExisting={openAdd} projectId={projectId} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search the catalog"
            className="pl-7"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Search all folders…"
            value={search}
          />
        </div>
        <ToggleGroup
          aria-label="Show"
          onValueChange={(values) => {
            const next = values[0];
            setKind(next === "dataset" || next === "view" ? next : "all");
          }}
          size="sm"
          spacing={0}
          value={[kind]}
          variant="outline"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="dataset">Datasets</ToggleGroupItem>
          <ToggleGroupItem value="view">Views</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="rounded-lg border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8 pr-0">
                <input
                  aria-label="Select all"
                  checked={allSelected}
                  className="align-middle"
                  disabled={entries.length === 0}
                  onChange={() => {
                    setSelected(allSelected ? new Set() : listedKeys);
                  }}
                  type="checkbox"
                />
              </TableHead>
              <SortHead label="Name" onSort={onSort} sort={sort} sortKey="name" />
              <TableHead className="hidden w-32 md:table-cell">Type</TableHead>
              <SortHead
                align="right"
                className="hidden w-28 sm:table-cell"
                label="Size"
                onSort={onSort}
                sort={sort}
                sortKey="rows"
              />
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
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell className="py-10 text-center text-muted-foreground" colSpan={6}>
                  {emptyMessage(searching, kind, folderId === null)}
                </TableCell>
              </TableRow>
            )}
            {entries.map((entry) => {
              if (entry.type === "folder") {
                const { folder } = entry,
                  key = `${FOLDER_KEY}${folder.id}`;
                return (
                  <CatalogFolderRow
                    canEdit={canEdit}
                    drag={dragOf(key)}
                    drop={dropOn(folder.id)}
                    folder={folder}
                    itemCount={entry.itemCount}
                    key={key}
                    onDelete={() => {
                      setDialog({ folder, type: "delete" });
                    }}
                    onMove={() => {
                      askMove(
                        { folderIds: [folder.id], membershipIds: [] },
                        `“${folder.name}”`,
                        folder.parentId,
                      );
                    }}
                    onRename={() => {
                      setDialog({ folder, type: "rename" });
                    }}
                    onToggle={() => {
                      toggle(key);
                    }}
                    projectId={projectId}
                    selected={activeKeys.has(key)}
                  />
                );
              }
              const { item } = entry,
                key = `${ITEM_KEY}${item.membershipId}`,
                detail = details.get(item.membershipId);
              if (detail === undefined) {
                return null;
              }
              return (
                <CatalogItemRow
                  canEdit={canEdit}
                  detail={detail}
                  drag={dragOf(key)}
                  item={item}
                  key={key}
                  onDuplicate={() => {
                    if (detail.view !== undefined) {
                      setDialog({ type: "duplicate", view: detail.view });
                    }
                  }}
                  onMove={() => {
                    askMove(
                      { folderIds: [], membershipIds: [item.membershipId] },
                      `“${item.title}”`,
                      item.folderId,
                    );
                  }}
                  onRemove={() => {
                    removeItem(item);
                  }}
                  onToggle={() => {
                    toggle(key);
                  }}
                  onVersions={() => {
                    setDialog({
                      membershipId: item.membershipId,
                      title: item.title,
                      type: "versions",
                    });
                  }}
                  pathLabel={
                    searching
                      ? ["Catalog", ...entry.path.map((folder) => folder.name)].join(" / ")
                      : undefined
                  }
                  projectId={projectId}
                  selected={activeKeys.has(key)}
                  titleOf={titleOf}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
      {/* Relations are project-wide, so they sit under the root listing only. */}
      {folderId === null && !searching && items.some((item) => item.kind === "dataset") && (
        <PgProjectRelationsSection canEdit={canEdit} projectId={projectId} />
      )}
      {dialog !== undefined && dialog.type === "new-folder" && (
        <FolderNameDialog
          busy={busy}
          description={`Created in ${folderName(folderId)}. Folders only organise this project.`}
          initialName=""
          onOpenChange={closeDialog}
          onSubmit={(name) => {
            void writeThenClose(
              async () => {
                const row = await foldersStore.createFolder({
                  name,
                  parentId: folderId,
                  projectId,
                });
                return row === null ? 0 : 1;
              },
              {
                denied: "The folder wasn't created. You may not have access.",
                done: `Created “${name}”.`,
              },
            );
          }}
          submitLabel="Create folder"
          title="New folder"
        />
      )}
      {dialog !== undefined && dialog.type === "rename" && (
        <FolderNameDialog
          busy={busy}
          description="Renaming a folder changes nothing about what it holds."
          initialName={dialog.folder.name}
          onOpenChange={closeDialog}
          onSubmit={(name) => {
            void writeThenClose(
              async () => await foldersStore.renameFolder({ folderId: dialog.folder.id, name }),
              {
                denied: "The folder wasn't renamed. You may not have access.",
                done: `Renamed to “${name}”.`,
              },
            );
          }}
          submitLabel="Rename"
          title="Rename folder"
        />
      )}
      {dialog !== undefined && dialog.type === "delete" && (
        <DeleteFolderDialog
          busy={busy}
          folderName={dialog.folder.name}
          onConfirm={() => {
            void writeThenClose(
              async () => await foldersStore.removeFolder({ folderId: dialog.folder.id }),
              {
                denied: "The folder wasn't deleted. You may not have access.",
                done: `Deleted “${dialog.folder.name}”. Its contents moved to ${folderName(dialog.folder.parentId)}.`,
              },
              () => {
                // Deleting the open folder leaves the URL pointing nowhere.
                if (folderId === dialog.folder.id) {
                  openFolder(dialog.folder.parentId);
                }
              },
            );
          }}
          onOpenChange={closeDialog}
          parentName={folderName(dialog.folder.parentId)}
        />
      )}
      {dialog !== undefined && dialog.type === "move" && (
        <MoveDialog
          blocked={
            new Set(dialog.selection.folderIds.flatMap((id) => [...subtreeIds(folders, id)]))
          }
          busy={busy}
          currentFolderId={dialog.from}
          folders={folders}
          onMove={(target) => {
            void move(dialog.selection, target);
          }}
          onOpenChange={closeDialog}
          subject={dialog.subject}
        />
      )}
      {dialog !== undefined && dialog.type === "versions" && versionsRow !== undefined && (
        <VersionsDialog
          onDone={() => {
            invalidateAll();
            closeDialog();
          }}
          onOpenChange={closeDialog}
          projectId={projectId}
          row={versionsRow}
          title={dialog.title}
        />
      )}
      {dialog !== undefined && dialog.type === "duplicate" && (
        <DuplicateViewDialog
          datasets={pickerDatasets}
          onOpenChange={(next) => {
            if (!next) {
              closeDialog();
            }
          }}
          open
          projectId={projectId}
          title={dialog.view.title}
          viewId={dialog.view.id}
        />
      )}
    </main>
  );
}
