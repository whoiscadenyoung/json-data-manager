import type { ReferenceField } from "@caden/json-cms/react";
import { getReferenceFields } from "@caden/json-cms/react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Copy, Eye, MoreHorizontal, Pencil } from "lucide-react";
import { toast } from "sonner";

import { DataTableClearFilter } from "#/components/niko-table/components/data-table-clear-filter";
import { DataTableColumnHeader } from "#/components/niko-table/components/data-table-column-header";
import { DataTableColumnSortMenu } from "#/components/niko-table/components/data-table-column-sort";
import { DataTableColumnTitle } from "#/components/niko-table/components/data-table-column-title";
import { DataTableFilterMenu } from "#/components/niko-table/components/data-table-filter-menu";
import { DataTableSearchFilter } from "#/components/niko-table/components/data-table-search-filter";
import { DataTableToolbarSection } from "#/components/niko-table/components/data-table-toolbar-section";
import { DataTableViewMenu } from "#/components/niko-table/components/data-table-view-menu";
import { DataTable } from "#/components/niko-table/core/data-table";
import { DataTableRoot } from "#/components/niko-table/core/data-table-root";
import {
  DataTableVirtualizedBody,
  DataTableVirtualizedEmptyBody,
  DataTableVirtualizedHeader,
} from "#/components/niko-table/core/data-table-virtualized-structure";
import type { DataTableColumnDef } from "#/components/niko-table/types";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { buildLabelsByField, referencedEntryIds } from "#/lib/reference-labels";
import { api } from "#convex/_generated/api";

type Entry = FunctionReturnType<typeof api.entries.listPage>["page"][number];

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
}: {
  schemaId: string;
  entry: Entry;
  onEdit: (entry: Entry) => void;
}) {
  const copyAsJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(entry.data, null, 2));
    toast.success("Copied entry as JSON.");
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

function buildColumns(
  schemaId: string,
  properties: string[],
  isGeospatial: boolean,
  onEdit: (entry: Entry) => void,
  referenceFieldsByName: Map<string, ReferenceField>,
  labelsByField: Map<string, Map<string, string>>,
): DataTableColumnDef<Entry>[] {
  const propertyColumns: DataTableColumnDef<Entry>[] = properties.map((name) => {
    const referenceField = referenceFieldsByName.get(name);
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
      meta: { label: name },
      size: PROPERTY_COLUMN_SIZE,
    };
  });

  const geometryColumn: DataTableColumnDef<Entry>[] = isGeospatial
    ? [
        {
          accessorFn: (entry) => entry.geometryType,
          cell: (info) => <GeometryCell geometryType={info.row.original.geometryType} />,
          enableColumnFilter: true,
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
      enableColumnFilter: true,
      header: () => <SortableHeader title="Created" />,
      id: "_creationTime",
      meta: { label: "Created" },
      size: CREATED_COLUMN_SIZE,
    },
    {
      cell: (info) => <RowActions schemaId={schemaId} entry={info.row.original} onEdit={onEdit} />,
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

/** Upper bound on ids sent to `listForIds` for label resolution (the component
 * rejects more); links beyond the cap render their raw id as today. */
const LABEL_IDS_CAP = 200;

/**
 * Collects the union of entry ids the table's loaded rows reference across
 * all reference fields — exactly the entries whose labels are worth fetching.
 * Used to be "every row of every referenced dataset" via
 * `listEntriesForSchemas`, which quietly loaded whole other datasets just to
 * label a handful of links (issue #54).
 */
function collectReferencedIds(entries: Entry[], referenceFields: ReferenceField[]): string[] {
  const ids = new Set<string>();
  if (referenceFields.length === 0) {
    return [];
  }
  for (const entry of entries) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `data` is `v.any()` in the component schema; reference values were validated at write time.
    const data = entry.data as Record<string, unknown>;
    for (const field of referenceFields) {
      for (const id of referencedEntryIds(data[field.name])) {
        ids.add(id);
      }
    }
  }
  return [...ids].slice(0, LABEL_IDS_CAP);
}

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
}) {
  const referenceFields = getReferenceFields(schema),
    referenceFieldsByName = new Map(referenceFields.map((f) => [f.name, f])),
    // Derived per render (cheap row scan); convex `useQuery` hashes the args
    // below, so an equal id list re-subscribes nothing. The list feeds the
    // label-id query — exactly the referenced entries, not whole datasets.
    referencedIds = collectReferencedIds(entries, referenceFields),
    candidateEntries = useQuery(
      api.entries.listForIds,
      referencedIds.length > 0 ? { entryIds: referencedIds } : "skip",
    ),
    labelsByField = buildLabelsByField(referenceFields, candidateEntries ?? []),
    columns = buildColumns(
      schemaId,
      properties,
      isGeospatial,
      onEdit,
      referenceFieldsByName,
      labelsByField,
    );

  return (
    <DataTableRoot
      data={entries}
      columns={columns}
      config={{ enableFilters: true, enableMultiSort: true, enableSorting: true }}
      getRowId={(entry) => entry._id}
    >
      <DataTableToolbarSection className="justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <DataTableSearchFilter placeholder="Search entries..." />
          <DataTableFilterMenu />
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
