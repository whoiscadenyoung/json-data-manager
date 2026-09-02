import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import type { FunctionReturnType } from "convex/server";
import { Copy, Eye, MoreHorizontal } from "lucide-react";
import { useMemo } from "react";
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

function RowActions({ schemaId, entry }: { schemaId: string; entry: Entry }) {
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={copyAsJson}>
          <Copy className="h-3.5 w-3.5" />
          Copy as JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function buildColumns(schemaId: string, properties: string[]): ColumnDef<Entry>[] {
  const propertyColumns: ColumnDef<Entry>[] = properties.map((name) => ({
    accessorFn: (entry) => entry.data[name],
    cell: (info) => <ValueCell value={info.getValue()} />,
    header: name,
    id: name,
  }));

  return [
    ...propertyColumns,
    {
      cell: (info) => new Date(info.row.original._creationTime).toLocaleString(),
      header: "Created",
      id: "_creationTime",
    },
    {
      cell: (info) => <RowActions schemaId={schemaId} entry={info.row.original} />,
      header: "",
      id: "actions",
    },
  ];
}

/** A TanStack Table view of a dataset's entries: one column per schema property. */
export function EntriesTable({
  schemaId,
  properties,
  entries,
}: {
  schemaId: string;
  properties: string[];
  entries: Entry[];
}) {
  const columns = useMemo(() => buildColumns(schemaId, properties), [schemaId, properties]),
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
                className={header.column.id === "actions" ? "w-10" : "font-mono"}
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
