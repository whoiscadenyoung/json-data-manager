import type { RowData } from "@tanstack/react-table";
import React from "react";

import { cn } from "#/lib/utils.ts";

import { useDerivedColumnTitle } from "../hooks/use-derived-column-title";
import type { DataTableColumn } from "../types";
/**
 * Renders the column title.
 */
export function TableColumnTitle<TData extends RowData, TValue>({
  column,
  title,
  className,
  children,
}: {
  column: DataTableColumn<TData, TValue>;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const derivedTitle = useDerivedColumnTitle(column, column.id, title);

  return (
    <div
      data-slot="column-title"
      className={cn(
        // `min-w-0` so `truncate` can shrink this flex item below its text
        // width (a nowrap flex child otherwise keeps full content width and
        // spills into the neighbouring header cell on narrow columns).
        "min-w-0 truncate py-0.5 text-sm font-semibold transition-colors",
        className,
      )}
    >
      {children ?? derivedTitle}
    </div>
  );
}

TableColumnTitle.displayName = "TableColumnTitle";
