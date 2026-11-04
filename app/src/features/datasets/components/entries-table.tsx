import type { ReferenceField } from "@caden/json-cms/react";
import { getReferenceFields } from "@caden/json-cms/react";
import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { DataTableClearFilter } from "@caden/ui/niko-table/components/data-table-clear-filter";
import { DataTableColumnHeader } from "@caden/ui/niko-table/components/data-table-column-header";
import { DataTableColumnSortMenu } from "@caden/ui/niko-table/components/data-table-column-sort";
import { DataTableColumnTitle } from "@caden/ui/niko-table/components/data-table-column-title";
import { DataTableFilterMenu } from "@caden/ui/niko-table/components/data-table-filter-menu";
import { DataTableSearchFilter } from "@caden/ui/niko-table/components/data-table-search-filter";
import { DataTableToolbarSection } from "@caden/ui/niko-table/components/data-table-toolbar-section";
import { DataTableViewMenu } from "@caden/ui/niko-table/components/data-table-view-menu";
import { DataTable } from "@caden/ui/niko-table/core/data-table";
import { DataTableRoot } from "@caden/ui/niko-table/core/data-table-root";
import {
  DataTableVirtualizedBody,
  DataTableVirtualizedEmptyBody,
  DataTableVirtualizedHeader,
} from "@caden/ui/niko-table/core/data-table-virtualized-structure";
import type { DataTableColumnDef, GlobalFilter } from "@caden/ui/niko-table/types";
import { Link } from "@tanstack/react-router";
import type { ColumnFiltersState, SortingState, Updater } from "@tanstack/react-table";
import { useQuery } from "convex/react";
import { Copy, Eye, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { api } from "#convex/_generated/api";

import {
  resolveUpdater,
  SERVED_FILTER_OPERATORS,
  servedVariantOf,
  type PgColumnFilter,
  type PgPropertyType,
} from "../lib/pg-entries-table";
import {
  buildLabelsByField,
  collectReferencedIds,
  referencedEntryIds,
} from "../lib/reference-labels";

// One seam row (`entries.listPage` page item, via the row-resolution seam).
type Entry = DatasetEntryRow;

/** A JSON value formatted for a table cell: quotes stripped from strings, everything else stringified as JSON. */
function formatCellValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Render a JSON value as a table cell: dashes for missing, italic for null, mono/truncated otherwise. */
function ValueCell({ value }: { value: unknown }) {
  if (value === undefined) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  if (value === null) {
    return <span className="text-xs italic text-muted-foreground">null</span>;
  }
  const text = formatCellValue(value);
  return (
    <span className="block max-w-60 truncate font-mono text-xs" title={text}>
      {text}
    </span>
  );
}

function GeometryCell({ geometryType }: { geometryType: string | undefined }) {
  if (geometryType === undefined) {
    return <span className="text-xs italic text-muted-foreground">No geometry</span>;
  }
  return <span className="font-mono text-xs text-muted-foreground">{geometryType}</span>;
}

/** One linked target entry's resolved label, or the raw id as a fallback when it isn't (yet) resolved. */
function ReferenceLink({
  targetSchemaId,
  entryId,
  label,
}: {
  targetSchemaId: string;
  entryId: string;
  label: string | undefined;
}) {
  return (
    <Link
      to="/datasets/$schemaId/$entryId"
      params={{ entryId, schemaId: targetSchemaId }}
      className="text-primary hover:underline"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      {label ?? entryId}
    </Link>
  );
}

/** Renders a reference field's value as link(s) to the referenced entry/entries, resolved via `labelsById`. */
function ReferenceCell({
  value,
  targetSchemaId,
  labelsById,
}: {
  value: unknown;
  targetSchemaId: string;
  labelsById: Map<string, string>;
}) {
  const entryIds = referencedEntryIds(value);

  if (entryIds.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  return (
    <span className="flex flex-wrap gap-x-1.5 gap-y-0.5 text-xs">
      {entryIds.map((entryId, i) => (
        <span key={entryId}>
          <ReferenceLink
            targetSchemaId={targetSchemaId}
            entryId={entryId}
            label={labelsById.get(entryId)}
          />
          {i < entryIds.length - 1 && ","}
        </span>
      ))}
    </span>
  );
}

function RowActions({
  schemaId,
  entry,
  onEdit,
  onDelete,
}: {
  schemaId: string;
  entry: Entry;
  onEdit: (entry: Entry) => void;
  /** Present only where the backend serves a single-entry delete (the Postgres store; the Convex wrapper set never exposed one). */
  onDelete?: (entry: Entry) => void;
}) {
  const copyAsJson = () => {
    // The success toast waits for the clipboard write to actually resolve —
    // firing it first claimed success before (or while) the write could fail
    // (issue #135, defect 10).
    void (async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(entry.data, null, 2));
        toast.success("Copied entry as JSON.");
      } catch {
        toast.error("Could not copy — the browser refused the clipboard write.");
      }
    })();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Row actions" />}>
        <MoreHorizontal className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          render={
            <Link to="/datasets/$schemaId/$entryId" params={{ entryId: entry._id, schemaId }} />
          }
        >
          <Eye className="h-3.5 w-3.5" />
          View Details
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onEdit(entry)}>
          <Pencil className="h-3.5 w-3.5" />
          Edit Entry
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={copyAsJson}>
          <Copy className="h-3.5 w-3.5" />
          Copy as JSON
        </DropdownMenuItem>
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onDelete(entry)} variant="destructive">
              <Trash2 className="h-3.5 w-3.5" />
              Delete Entry
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A sortable column header: title + click-to-sort control, wired to the column via context. */
function SortableHeader({ title }: { title?: string }) {
  return (
    <DataTableColumnHeader>
      <DataTableColumnTitle title={title} />
      <DataTableColumnSortMenu />
    </DataTableColumnHeader>
  );
}

// Row virtualization (see `EntriesTable` below) lays out `<tr>`s with CSS
// grid/flex instead of the browser's table layout algorithm, which means
// column widths are no longer inferred from content — every column needs an
// explicit `size`. Kept generous enough that `ValueCell`'s own truncation
// (`max-w-60`) is usually what actually clips text, not the column itself.
const GEOMETRY_COLUMN_SIZE = 110,
  PROPERTY_COLUMN_SIZE = 220,
  CREATED_COLUMN_SIZE = 160,
  ACTIONS_COLUMN_SIZE = 40;

/**
 * How much sorting/filtering the server can serve. `"client"` (the Convex
 * path) sorts and filters every column in the browser; `"server"` (the
 * `search_entries` RPC, §5.1) sorts by a declared property key and filters
 * data keys only — the Geometry and Created columns carry no data key, so
 * they opt out of both rather than raising the RPC's `invalid key` guard.
 */
type ColumnSurfaces = "client" | "server";

function buildColumns(
  schemaId: string,
  properties: string[],
  isGeospatial: boolean,
  onEdit: (entry: Entry) => void,
  onDelete: ((entry: Entry) => void) | undefined,
  referenceFieldsByName: Map<string, ReferenceField>,
  labelsByField: Map<string, Map<string, string>>,
  surfaces: ColumnSurfaces,
  columnTypes: ReadonlyMap<string, PgPropertyType>,
): DataTableColumnDef<Entry>[] {
  const server = surfaces === "server",
    // The Postgres filter menu's field selector lists data columns only (see
    // the surfaces doc above); the Convex table keeps every column filterable.
    dataFilterable = !server;

  const propertyColumns: DataTableColumnDef<Entry>[] = properties.map((name) => {
    const referenceField = referenceFieldsByName.get(name),
      // Server mode derives the filter control from the DECLARED property
      // type: a numeric column gets the number input (so eq arrives as a
      // number and the RPC's jsonb containment matches) and only the §5.1
      // operators the RPC serves — a control the server answers wrong would
      // be a silently no-op control (the ui-polish rule). The client-side
      // Convex table keeps its original text control and full operator set.
      propertyType = server ? columnTypes.get(name) : undefined,
      variant = propertyType === undefined ? "text" : servedVariantOf(propertyType);
    return {
      accessorFn: (entry) => entry.data[name],
      cell: (info) =>
        referenceField ? (
          <ReferenceCell
            value={info.getValue()}
            targetSchemaId={referenceField.meta.datasetId}
            labelsById={labelsByField.get(name) ?? new Map()}
          />
        ) : (
          <ValueCell value={info.getValue()} />
        ),
      enableColumnFilter: true,
      header: () => <SortableHeader title={name} />,
      id: name,
      meta:
        propertyType === undefined
          ? { label: name, variant: "text" }
          : {
              filterOperators: [...(SERVED_FILTER_OPERATORS.get(variant) ?? [])],
              label: name,
              variant,
            },
      size: PROPERTY_COLUMN_SIZE,
    };
  });

  const geometryColumn: DataTableColumnDef<Entry>[] = isGeospatial
    ? [
        {
          accessorFn: (entry) => entry.geometryType,
          cell: (info) => <GeometryCell geometryType={info.row.original.geometryType} />,
          enableColumnFilter: dataFilterable,
          enableSorting: !server,
          header: () => <SortableHeader title="Geometry" />,
          id: "geometry",
          meta: { label: "Geometry" },
          size: GEOMETRY_COLUMN_SIZE,
        },
      ]
    : [];

  return [
    ...geometryColumn,
    ...propertyColumns,
    {
      accessorFn: (entry) => entry._creationTime,
      cell: (info) => new Date(info.row.original._creationTime).toLocaleString(),
      enableColumnFilter: dataFilterable,
      // The RPC's only non-key order is its `created_at desc` default — there
      // is no ascending variant to serve, so the column opts out server-side.
      enableSorting: !server,
      header: () => <SortableHeader title="Created" />,
      id: "_creationTime",
      meta: { label: "Created" },
      size: CREATED_COLUMN_SIZE,
    },
    {
      cell: (info) => (
        <RowActions
          schemaId={schemaId}
          entry={info.row.original}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      ),
      enableColumnFilter: false,
      enableHiding: false,
      enableSorting: false,
      header: "",
      id: "actions",
      size: ACTIONS_COLUMN_SIZE,
    },
  ];
}

/** Estimated row height in px, used to seed the virtualizer before rows are measured. */
const ESTIMATED_ROW_HEIGHT = 37;

/** A niko-table (TanStack Table v9) view of a dataset's entries: one column per schema property, with search/sort/filter/column-visibility. */
export function EntriesTable({
  schemaId,
  schema,
  properties,
  entries,
  entryCount,
  hasMore,
  isLoadingMore,
  onLoadMore,
  isGeospatial,
  onEdit,
  onDelete,
  labelsByField,
  server,
  columnTypes,
}: {
  schemaId: string;
  /** The dataset's JSON schema — used to detect which of `properties` are reference fields (see `@caden/json-cms/react`). */
  schema: unknown;
  properties: string[];
  entries: Entry[];
  /** The dataset's total row count (`entryCount`), for the load-more label. */
  entryCount: number | undefined;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  isGeospatial: boolean;
  onEdit: (entry: Entry) => void;
  /** Single-entry delete — wired only where the backend serves one (the Postgres store). */
  onDelete?: (entry: Entry) => void;
  /**
   * Pre-resolved reference labels, grouped by field name. When given, the
   * table skips its internal Convex label query — the Postgres host resolves
   * labels through the store's batched `listForIds` (split-brain aware:
   * referenced entries may live in either backend).
   */
  labelsByField?: Map<string, Map<string, string>>;
  /**
   * The declared property types (`declaredPropertyTypes` of the dataset's
   * schema). Server mode reads it for the per-column filter variant and the
   * served-operator restriction; the client-side Convex table ignores it.
   */
  columnTypes?: ReadonlyMap<string, PgPropertyType>;
  /**
   * Server-driven mode (design §8.4): sort/filter/search state is hoisted
   * into the caller's hands (URL search params → the `search_entries` RPC),
   * the TanStack row models run manual, and column visibility stays the only
   * client-side concern. Absent = the original client-side mode, unchanged.
   */
  server?: {
    search: string;
    onSearchChange: (value: string) => void;
    sorting: SortingState;
    onSortingChange: (updater: Updater<SortingState>) => void;
    filters: PgColumnFilter[];
    onFiltersChange: (filters: PgColumnFilter[] | null) => void;
  };
}) {
  const referenceFields = getReferenceFields(schema),
    referenceFieldsByName = new Map(referenceFields.map((f) => [f.name, f])),
    // Server mode resolves labels OUTSIDE (the caller owns the store reads —
    // see the prop doc); the Convex path keeps the internal query below.
    externalLabels = labelsByField !== undefined,
    // Derived per render (cheap row scan); convex `useQuery` hashes the args
    // below, so an equal id list re-subscribes nothing. The list feeds the
    // label-id query — exactly the referenced entries, not whole datasets.
    referencedIds = collectReferencedIds(entries, referenceFields),
    candidateEntries = useQuery(
      api.cms.entries.listForIds,
      !externalLabels && referencedIds.length > 0 ? { entryIds: referencedIds } : "skip",
    ),
    resolvedLabelsByField =
      labelsByField ?? buildLabelsByField(referenceFields, candidateEntries ?? []),
    columns = buildColumns(
      schemaId,
      properties,
      isGeospatial,
      onEdit,
      onDelete,
      referenceFieldsByName,
      resolvedLabelsByField,
      server === undefined ? "client" : "server",
      columnTypes ?? new Map(),
    ),
    // The controlled-state projection: server mode mirrors the URL-owned
    // state into the table so the toolbar's Reset button sees it (and its
    // writes route back through the handlers below); client mode passes
    // nothing and every control stays uncontrolled, exactly as before.
    rootState =
      server === undefined
        ? undefined
        : {
            // The filter mirror backs the Reset button's visibility only —
            // the menu itself is controlled separately (manualFiltering is
            // on, so no client filtering ever runs on it).
            columnFilters: server.filters.map((filter) => ({ id: filter.id, value: filter.value })),
            globalFilter: server.search,
            sorting: server.sorting,
          };

  const handleSortingChange = (updater: Updater<SortingState>) => {
    if (server === undefined) {
      return;
    }
    server.onSortingChange(resolveUpdater(updater, server.sorting));
  };

  const handleColumnFiltersChange = (updater: Updater<ColumnFiltersState>) => {
    if (server === undefined) {
      return;
    }
    const next = resolveUpdater(updater, rootState === undefined ? [] : rootState.columnFilters);
    // Only the EMPTY write is honored: it comes from the Reset button, and
    // the URL-owned filter state it must clear lives in the menu's
    // controlled rows (non-empty writes never originate here).
    if (next.length === 0) {
      server.onFiltersChange(null);
    }
  };

  const handleGlobalFilterChange = (value: GlobalFilter) => {
    if (server === undefined || typeof value !== "string") {
      return;
    }
    server.onSearchChange(value);
  };

  return (
    <DataTableRoot
      data={entries}
      columns={columns}
      config={
        server === undefined
          ? { enableFilters: true, enableMultiSort: true, enableSorting: true }
          : {
              enableFilters: true,
              enableMultiSort: false,
              enableSorting: true,
              manualFiltering: true,
              manualPagination: true,
              manualSorting: true,
            }
      }
      getRowId={(entry) => entry._id}
      onColumnFiltersChange={server === undefined ? undefined : handleColumnFiltersChange}
      onGlobalFilterChange={server === undefined ? undefined : handleGlobalFilterChange}
      onSortingChange={server === undefined ? undefined : handleSortingChange}
      state={rootState}
    >
      <DataTableToolbarSection className="justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <DataTableSearchFilter
            onChange={server === undefined ? undefined : server.onSearchChange}
            placeholder="Search entries..."
            value={server === undefined ? undefined : server.search}
          />
          {server === undefined ? (
            <DataTableFilterMenu />
          ) : (
            <DataTableFilterMenu<Record<string, unknown>>
              filters={server.filters}
              onFiltersChange={server.onFiltersChange}
            />
          )}
          <DataTableClearFilter />
        </div>
        <DataTableViewMenu />
      </DataTableToolbarSection>

      <DataTable className="max-h-[70vh]">
        <DataTableVirtualizedHeader />
        {/* Streaming load-more: scrolling within `prefetchThreshold` rows of
        the end triggers the next server page, so paging is invisible until
        the very last page boundary. */}
        <DataTableVirtualizedBody
          estimateSize={ESTIMATED_ROW_HEIGHT}
          onNearEnd={hasMore && !isLoadingMore ? onLoadMore : undefined}
          prefetchThreshold={15}
        >
          <DataTableVirtualizedEmptyBody>
            No entries match your filters.
          </DataTableVirtualizedEmptyBody>
        </DataTableVirtualizedBody>
      </DataTable>
      {hasMore && (
        <div className="flex items-center justify-center border-t pt-3">
          <Button variant="outline" size="sm" disabled={isLoadingMore} onClick={onLoadMore}>
            {isLoadingMore
              ? "Loading…"
              : `Load more (${entries.length} of ${entryCount ?? "…"} rows)`}
          </Button>
        </div>
      )}
    </DataTableRoot>
  );
}
