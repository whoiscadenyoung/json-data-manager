import type { ReferenceField } from "@caden/json-cms/react";
import { getReferenceFields } from "@caden/json-cms/react";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Copy, Eye, MoreHorizontal, Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { buildLabelsByField, referencedEntryIds } from "#/lib/reference-labels";
import { api } from "#convex/_generated/api";

type Entry = FunctionReturnType<typeof api.entries.list>[number];

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

function buildColumns(
  schemaId: string,
  properties: string[],
  isGeospatial: boolean,
  onEdit: (entry: Entry) => void,
  referenceFieldsByName: Map<string, ReferenceField>,
  labelsByField: Map<string, Map<string, string>>,
): ColumnDef<Entry>[] {
  const propertyColumns: ColumnDef<Entry>[] = properties.map((name) => {
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
      header: name,
      id: name,
    };
  });

  const geometryColumn: ColumnDef<Entry>[] = isGeospatial
    ? [
        {
          cell: (info) => <GeometryCell geometryType={info.row.original.geometryType} />,
          header: "Geometry",
          id: "geometry",
        },
      ]
    : [];

  return [
    ...geometryColumn,
    ...propertyColumns,
    {
      cell: (info) => new Date(info.row.original._creationTime).toLocaleString(),
      header: "Created",
      id: "_creationTime",
    },
    {
      cell: (info) => <RowActions schemaId={schemaId} entry={info.row.original} onEdit={onEdit} />,
      header: "",
      id: "actions",
    },
  ];
}

/** A TanStack Table view of a dataset's entries: one column per schema property. */
export function EntriesTable({
  schemaId,
  schema,
  properties,
  entries,
  isGeospatial,
  onEdit,
}: {
  schemaId: string;
  /** The dataset's JSON schema — used to detect which of `properties` are reference fields (see `@caden/json-cms/react`). */
  schema: unknown;
  properties: string[];
  entries: Entry[];
  isGeospatial: boolean;
  onEdit: (entry: Entry) => void;
}) {
  const referenceFields = getReferenceFields(schema),
    referenceFieldsByName = new Map(referenceFields.map((f) => [f.name, f])),
    targetSchemaIds = [...new Set(referenceFields.map((f) => f.meta.datasetId))],
    candidateEntries = useQuery(
      api.entries.listEntriesForSchemas,
      targetSchemaIds.length > 0 ? { schemaIds: targetSchemaIds } : "skip",
    ),
    labelsByField = buildLabelsByField(referenceFields, candidateEntries ?? []),
    columns = buildColumns(
      schemaId,
      properties,
      isGeospatial,
      onEdit,
      referenceFieldsByName,
      labelsByField,
    ),
    // TanStack Table's returned instance always has fresh method references; this is inherent to the library.
    // oxlint-disable-next-line react/incompatible-library
    table = useReactTable({ columns, data: entries, getCoreRowModel: getCoreRowModel() });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                className={
                  header.column.id === "actions"
                    ? "w-10"
                    : header.column.id === "geometry"
                      ? undefined
                      : "font-mono"
                }
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
