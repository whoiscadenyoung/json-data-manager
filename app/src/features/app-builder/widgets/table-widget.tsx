import { DataTableColumnHeader } from "#/components/niko-table/components/data-table-column-header";
import { DataTableColumnSortMenu } from "#/components/niko-table/components/data-table-column-sort";
import { DataTableColumnTitle } from "#/components/niko-table/components/data-table-column-title";
import { DataTableSearchFilter } from "#/components/niko-table/components/data-table-search-filter";
import { DataTableToolbarSection } from "#/components/niko-table/components/data-table-toolbar-section";
import { DataTable } from "#/components/niko-table/core/data-table";
import { DataTableRoot } from "#/components/niko-table/core/data-table-root";
import {
  DataTableVirtualizedBody,
  DataTableVirtualizedEmptyBody,
  DataTableVirtualizedHeader,
} from "#/components/niko-table/core/data-table-virtualized-structure";
import type { DataTableColumnDef } from "#/components/niko-table/types";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Label } from "#/components/ui/label";
import { entryDataRecord, type DatasetEntryRow } from "#/lib/dataset-rows";
import { useDatasetEntryPages } from "#/lib/dataset-rows-react";
import { formatPropertyValue } from "#/lib/format";

import type { DatasetField } from "../lib/fields";
import {
  DatasetSelect,
  useDatasetFields,
  WidgetMessage,
  WithDataset,
  type WidgetOf,
  type WidgetSettingsProps,
  type WidgetViewProps,
} from "./shared";

/**
 * A read-only, searchable, sortable table of one dataset — the same niko-table
 * kit as the dataset page's Entries tab, without its edit actions, streaming
 * pages in as the viewer scrolls (the seam's `useDatasetEntryPages`).
 */

const COLUMN_SIZE = 180,
  ROW_HEIGHT = 37,
  /** Search toolbar + its gap, subtracted from the body height. */
  TOOLBAR_HEIGHT = 48,
  LOAD_MORE_HEIGHT = 44;

function Cell({ value }: { value: unknown }) {
  if (value === undefined || value === null) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  const text = formatPropertyValue(value);
  return (
    <span className="block truncate text-xs" title={text}>
      {text}
    </span>
  );
}

function buildColumns(columns: readonly string[]): DataTableColumnDef<DatasetEntryRow>[] {
  return columns.map((name) => ({
    accessorFn: (entry) => entryDataRecord(entry)[name],
    cell: (info) => <Cell value={info.getValue()} />,
    header: () => (
      <DataTableColumnHeader>
        <DataTableColumnTitle title={name} />
        <DataTableColumnSortMenu />
      </DataTableColumnHeader>
    ),
    id: name,
    meta: { label: name },
    size: COLUMN_SIZE,
  }));
}

/** The visible columns: the configured ones still present on the dataset, or every field. */
function visibleColumns(widget: WidgetOf<"table">, fields: readonly DatasetField[]): string[] {
  const names = fields.map((field) => field.name);
  if (widget.columns.length === 0) {
    return names;
  }
  const present = new Set(names);
  return widget.columns.filter((column) => present.has(column));
}

function TableBody({
  widget,
  fields,
  entryCount,
  height,
}: {
  widget: WidgetOf<"table">;
  fields: readonly DatasetField[];
  entryCount: number | undefined;
  height: number;
}) {
  const { entries, isLoading, isLoadingMore, canLoadMore, loadMore } = useDatasetEntryPages(
      widget.datasetId,
    ),
    columns = buildColumns(visibleColumns(widget, fields));
  if (isLoading) {
    return <WidgetMessage loading>Loading rows…</WidgetMessage>;
  }
  if (columns.length === 0) {
    return <WidgetMessage>This dataset has no fields to show.</WidgetMessage>;
  }
  const tableHeight = Math.max(120, height - TOOLBAR_HEIGHT - (canLoadMore ? LOAD_MORE_HEIGHT : 0));
  return (
    <div className="flex h-full flex-col px-3 pb-2">
      <DataTableRoot
        data={entries}
        columns={columns}
        config={{ enableFilters: true, enableSorting: true }}
        getRowId={(entry) => entry._id}
      >
        <DataTableToolbarSection className="pb-2">
          <DataTableSearchFilter placeholder="Search rows…" />
        </DataTableToolbarSection>
        <DataTable height={tableHeight}>
          <DataTableVirtualizedHeader />
          <DataTableVirtualizedBody
            estimateSize={ROW_HEIGHT}
            onNearEnd={canLoadMore && !isLoadingMore ? loadMore : undefined}
            prefetchThreshold={15}
          >
            <DataTableVirtualizedEmptyBody>No rows match.</DataTableVirtualizedEmptyBody>
          </DataTableVirtualizedBody>
        </DataTable>
        {canLoadMore && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" size="sm" disabled={isLoadingMore} onClick={loadMore}>
              {isLoadingMore ? "Loading…" : `Load more (${entries.length} of ${entryCount ?? "…"})`}
            </Button>
          </div>
        )}
      </DataTableRoot>
    </div>
  );
}

export function TableWidgetView({ widget, height }: WidgetViewProps<"table">) {
  return (
    <WithDataset datasetId={widget.datasetId}>
      {(state) => (
        <TableBody
          widget={widget}
          fields={state.fields}
          entryCount={state.doc.entryCount}
          height={height}
        />
      )}
    </WithDataset>
  );
}

export function TableWidgetSettings({
  widget,
  datasetIds,
  onChange,
}: WidgetSettingsProps<"table">) {
  const fields = useDatasetFields(widget.datasetId),
    shown = new Set(visibleColumns(widget, fields));
  const toggle = (name: string, checked: boolean) => {
    // Keep the dataset's declared order; "every field" collapses back to [].
    const next = fields
      .map((field) => field.name)
      .filter((field) => (field === name ? checked : shown.has(field)));
    onChange({ ...widget, columns: next.length === fields.length ? [] : next });
  };
  return (
    <>
      <DatasetSelect
        id={`table-dataset-${widget.id}`}
        datasetIds={datasetIds}
        value={widget.datasetId}
        onChange={(datasetId) => {
          onChange({ ...widget, columns: [], datasetId });
        }}
      />
      {fields.length > 0 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Columns</legend>
          <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-md border border-border p-2">
            {fields.map((field) => (
              <Label key={field.name} className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={shown.has(field.name)}
                  onCheckedChange={(checked) => {
                    toggle(field.name, checked);
                  }}
                />
                <span className="truncate">{field.name}</span>
              </Label>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}
