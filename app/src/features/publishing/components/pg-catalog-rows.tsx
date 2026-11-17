import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Checkbox } from "@caden/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { TableCell, TableHead, TableRow } from "@caden/ui/components/table";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpCircle,
  Copy,
  FileQuestion,
  Folder,
  FolderInput,
  GitBranch,
  Link2,
  MapPinned,
  MoreHorizontal,
  Pencil,
  Table2,
  Trash2,
  Workflow,
} from "lucide-react";
import type { DragEvent, ReactNode } from "react";

import { relativeTime } from "#/features/views";
import type { RelationEnd } from "@/lib/relation-phrases";
import type { CatalogRow } from "@/lib/store/projects";
import type { ViewLatestRun, ViewSummary } from "@/lib/store/view-reads";

import type { BrowserItem, TreeFolder } from "../lib/catalog-tree";
import { VIEWER_REASON } from "../lib/pg-viewer-posture";
import { RelationBadge } from "./relation-badge";

/** What a row needs to be dragged, and (for folders) dropped on. */
export interface RowDragProps {
  draggable: boolean;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent) => void;
}
export interface RowDropProps {
  "data-drop-active": boolean;
  onDragLeave: () => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

/** Everything the browser knows about one catalog item beyond its listing fields. */
export interface ItemDetail {
  draft: boolean;
  geospatial: boolean;
  lastRun: ViewLatestRun | undefined;
  relationEnds: readonly RelationEnd[];
  row: CatalogRow;
  view: ViewSummary | undefined;
}

const ROW_CLASS =
  "group data-[drop-active=true]:bg-primary/10 data-[drop-active=true]:outline data-[drop-active=true]:outline-1 data-[drop-active=true]:outline-primary";

function SelectCell({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <TableCell className="w-8 pr-0">
      <Checkbox aria-label={label} checked={checked} onCheckedChange={onToggle} />
    </TableCell>
  );
}

export function RowMenu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <TableCell className="w-10 text-right">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button aria-label={label} size="icon-sm" type="button" variant="ghost" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{children}</DropdownMenuContent>
      </DropdownMenu>
    </TableCell>
  );
}

/** A sortable column header: the catalog and the project's map and app lists share it. */
export function SortHead<Key extends string>({
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
  onSort: (key: Key) => void;
  sort: { descending: boolean; key: Key };
  sortKey: Key;
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

/** A folder row: opens on click, takes drops, and can itself be dragged into another folder. */
export function CatalogFolderRow({
  canEdit,
  drag,
  drop,
  folder,
  itemCount,
  onDelete,
  onMove,
  onRename,
  onToggle,
  projectId,
  selected,
}: {
  canEdit: boolean;
  drag: RowDragProps;
  drop: RowDropProps;
  folder: TreeFolder;
  itemCount: number;
  onDelete: () => void;
  onMove: () => void;
  onRename: () => void;
  onToggle: () => void;
  projectId: string;
  selected: boolean;
}) {
  const reason = canEdit ? undefined : VIEWER_REASON;
  return (
    <TableRow
      className={ROW_CLASS}
      data-state={selected ? "selected" : undefined}
      {...drag}
      {...drop}
    >
      <SelectCell checked={selected} label={`Select folder ${folder.name}`} onToggle={onToggle} />
      <TableCell className="max-w-0">
        <Link
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
          params={{ projectId }}
          search={{ folder: folder.id }}
          to="/projects/$projectId/catalog"
        >
          <Folder className="h-4 w-4 shrink-0 fill-primary/15 text-primary" />
          <span className="truncate">{folder.name}</span>
        </Link>
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">Folder</TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
        {itemCount} {itemCount === 1 ? "item" : "items"}
      </TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">
        {relativeTime(folder.updatedAt)}
      </TableCell>
      <RowMenu label={`Actions for folder ${folder.name}`}>
        <DropdownMenuItem disabled={!canEdit} onClick={onRename} title={reason}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canEdit} onClick={onMove} title={reason}>
          <FolderInput />
          Move to…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canEdit}
          onClick={onDelete}
          title={reason}
          variant="destructive"
        >
          <Trash2 />
          Delete folder
        </DropdownMenuItem>
      </RowMenu>
    </TableRow>
  );
}

/** How a linked reference follows its source, in a word or two. */
function linkedLabel(row: CatalogRow): string {
  if (row.edge === null) {
    return "Linked";
  }
  if (row.edge.mode !== "pin") {
    return "Linked · floating";
  }
  return row.edge.pinnedRef === null ? "Linked · pinned" : `Linked · ${row.edge.pinnedRef}`;
}

/** A view's run state: the failure wins over staleness. */
function ViewStateBadge({ detail }: { detail: ItemDetail }) {
  const { lastRun, view } = detail;
  if (view === undefined) {
    return null;
  }
  if (lastRun !== undefined && lastRun.status === "error") {
    return (
      <Badge title={lastRun.error ?? "The last run failed."} variant="destructive">
        Error
      </Badge>
    );
  }
  if (view.stale) {
    return (
      <Badge title="Inputs or steps changed since the last successful run." variant="secondary">
        Stale
      </Badge>
    );
  }
  return null;
}

/** The compact state chips after an item's name. */
function ItemBadges({ detail, onVersions }: { detail: ItemDetail; onVersions: () => void }) {
  const { draft, row, view } = detail,
    linked = row.artifact.role === "linked",
    refreshMode = view === undefined ? null : (view.refreshMode ?? null);
  return (
    <>
      {draft && (
        <Badge
          title="A draft: visible to this project's members, hidden from the global catalog until it publishes."
          variant="secondary"
        >
          Draft
        </Badge>
      )}
      {linked && (
        <Badge
          title="Added from the global catalog by reference. Nothing was copied."
          variant="outline"
        >
          <Link2 className="h-3 w-3" />
          {linkedLabel(row)}
        </Badge>
      )}
      {row.updateAvailable && (
        <button
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={onVersions}
          title="The source published a newer version. Open to sync."
          type="button"
        >
          <ArrowUpCircle className="h-3 w-3" />
          Update
        </button>
      )}
      {refreshMode !== null && refreshMode !== "manual" && (
        <Badge title="How this view's rows are refreshed." variant="outline">
          {refreshMode}
        </Badge>
      )}
      <ViewStateBadge detail={detail} />
    </>
  );
}

function typeLabel(item: BrowserItem, detail: ItemDetail): string {
  if (item.kind === "view") {
    return "View";
  }
  if (item.kind === "missing") {
    return "Missing";
  }
  return detail.geospatial ? "Spatial dataset" : "Dataset";
}

/** The item's name: a link into the dataset or view, or plain text when the dataset is gone. */
function ItemName({ item, projectId }: { item: BrowserItem; projectId: string }) {
  if (item.kind === "missing") {
    return (
      <span
        className="truncate text-muted-foreground"
        title="The referenced dataset no longer exists. Remove the reference to clean up."
      >
        {item.title}
      </span>
    );
  }
  return item.kind === "view" ? (
    <Link
      className="truncate font-medium hover:underline"
      params={{ projectId, viewId: item.datasetId }}
      to="/projects/$projectId/views/$viewId"
    >
      {item.title}
    </Link>
  ) : (
    <Link
      className="truncate font-medium hover:underline"
      params={{ projectId, schemaId: item.datasetId }}
      to="/projects/$projectId/datasets/$schemaId"
    >
      {item.title}
    </Link>
  );
}

/** The icon that tells the kinds apart at a glance. */
function ItemIcon({ geospatial, kind }: { geospatial: boolean; kind: BrowserItem["kind"] }) {
  if (kind === "view") {
    return <Workflow className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />;
  }
  if (kind === "missing") {
    return <FileQuestion className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return geospatial ? (
    <MapPinned className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
  ) : (
    <Table2 className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
  );
}

/** A dataset or view row. */
export function CatalogItemRow({
  canEdit,
  detail,
  drag,
  item,
  onDuplicate,
  onMove,
  onRemove,
  onToggle,
  onVersions,
  pathLabel,
  projectId,
  selected,
  titleOf,
}: {
  canEdit: boolean;
  detail: ItemDetail;
  drag: RowDragProps;
  item: BrowserItem;
  onDuplicate: () => void;
  onMove: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onVersions: () => void;
  /** Where the item lives, shown while searching (undefined = don't show). */
  pathLabel: string | undefined;
  projectId: string;
  selected: boolean;
  titleOf: (datasetId: string) => string;
}) {
  const reason = canEdit ? undefined : VIEWER_REASON,
    linked = detail.row.artifact.role === "linked";
  return (
    <TableRow className={ROW_CLASS} data-state={selected ? "selected" : undefined} {...drag}>
      <SelectCell checked={selected} label={`Select ${item.title}`} onToggle={onToggle} />
      <TableCell className="max-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <ItemIcon geospatial={detail.geospatial} kind={item.kind} />
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-1.5">
              <ItemName item={item} projectId={projectId} />
              <ItemBadges detail={detail} onVersions={onVersions} />
              <RelationBadge ends={detail.relationEnds} projectId={projectId} titleOf={titleOf} />
            </div>
            {pathLabel !== undefined && (
              <span className="truncate text-xs text-muted-foreground">in {pathLabel}</span>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">
        {typeLabel(item, detail)}
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
        {item.rowCount === null ? "" : `${item.rowCount.toLocaleString()} rows`}
      </TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">
        {item.modifiedAt === null ? "" : relativeTime(item.modifiedAt)}
      </TableCell>
      <RowMenu label={`Actions for ${item.title}`}>
        <DropdownMenuItem disabled={!canEdit} onClick={onMove} title={reason}>
          <FolderInput />
          Move to…
        </DropdownMenuItem>
        {item.kind === "view" && (
          <DropdownMenuItem disabled={!canEdit} onClick={onDuplicate} title={reason}>
            <Copy />
            Duplicate
          </DropdownMenuItem>
        )}
        {linked && detail.row.edge !== null && (
          <DropdownMenuItem onClick={onVersions}>
            <GitBranch />
            Version and sync…
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canEdit}
          onClick={onRemove}
          title={canEdit ? "The dataset itself is not deleted." : VIEWER_REASON}
          variant="destructive"
        >
          <Trash2 />
          Remove from project
        </DropdownMenuItem>
      </RowMenu>
    </TableRow>
  );
}
