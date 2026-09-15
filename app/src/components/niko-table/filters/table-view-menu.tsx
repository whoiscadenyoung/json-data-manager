import type { RowData } from "@tanstack/react-table";
import { Check, ChevronsUpDown, RotateCcw, Settings2 } from "lucide-react";
import * as React from "react";

import { Button } from "#/components/ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#/components/ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover.tsx";
import { cn } from "#/lib/utils.ts";

import { formatLabel } from "../lib/format";
import type { DataTableColumn, DataTableInstance } from "../types";
function getColumnTitle<TData extends RowData>(column: DataTableColumn<TData, unknown>): string {
  return column.columnDef.meta?.label ?? formatLabel(column.id);
}

export interface TableViewMenuProps<TData extends RowData> {
  table: DataTableInstance<TData>;
  className?: string;
  onColumnVisibilityChange?: (columnId: string, isVisible: boolean) => void;
  /**
   * Column ids that should appear in the menu but cannot be toggled off.
   * Useful for columns the table marks `enableHiding: false` but the
   * consumer still wants visible in the column list (typically with a
   * Reset to Defaults affordance below).
   */
  lockedColumnIds?: string[];
  /**
   * When provided, renders a Reset button at the bottom of the menu.
   * Useful when paired with persisted column preferences so users can
   * revert to defaults.
   */
  onReset?: () => void;
  /** Label for the reset button. Defaults to "Reset to defaults". */
  resetLabel?: string;
  /**
   * Replaces the default toolbar button.
   *
   * Same `trigger` contract the sibling filters already expose
   * (`TableColumnActions`, `TableDateFilter`, `TableFacetedFilter`), so a
   * consumer that needs a different trigger shape — a header-sized bare icon
   * beside a column title, for instance — composes one instead of waiting for
   * a boolean per shape.
   */
  trigger?: React.ReactElement;
}

interface MenuRowProps<TData extends RowData> {
  column: DataTableColumn<TData, unknown>;
  isLocked: boolean;
  isVisible: boolean;
  onToggle: (columnId: string) => void;
}

const MenuRow = React.memo(function MenuRow<TData extends RowData>({
  column,
  isLocked,
  isVisible,
  onToggle,
}: MenuRowProps<TData>) {
  return (
    <CommandItem
      data-disabled={isLocked ? "" : undefined}
      onSelect={() => {
        if (isLocked) return;
        onToggle(column.id);
      }}
    >
      <span className={cn("truncate", isLocked && "text-muted-foreground")}>
        {getColumnTitle(column)}
      </span>
      <Check
        className={cn(
          "ml-auto size-4 shrink-0",
          isLocked ? "opacity-50" : isVisible ? "opacity-100" : "opacity-0",
        )}
      />
    </CommandItem>
  );
}) as <TData extends RowData>(props: MenuRowProps<TData>) => React.ReactElement;

export function TableViewMenu<TData extends RowData>({
  table,
  onColumnVisibilityChange,
  lockedColumnIds,
  onReset,

  trigger,
  resetLabel,
}: TableViewMenuProps<TData>) {
  // Controlled search. cmdk's built-in filter hides non-matching `CommandItem`s
  // but still renders all of them — at 200+ columns that's the bottleneck.
  // Filtering at this layer means non-matching rows skip rendering entirely.
  const [search, setSearch] = React.useState("");

  // O(1) lookups instead of O(m) `.includes()` per row.
  const lockedSet = React.useMemo(() => new Set(lockedColumnIds ?? []), [lockedColumnIds]);

  const columns = React.useMemo(
    () =>
      table
        .getAllColumns()
        .filter(
          (column) =>
            typeof column.accessorFn !== "undefined" &&
            (column.getCanHide() || lockedSet.has(column.id)),
        ),
    // Depend on the column set, not just the (stable) table ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, table.options.columns, lockedSet],
  );

  const visibleColumns = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return columns;
    return columns.filter((c) => getColumnTitle(c).toLowerCase().includes(q));
  }, [columns, search]);

  // Stable callback so memoized rows skip re-render on keystrokes.
  const onToggle = React.useCallback(
    (columnId: string) => {
      const column = table.getColumn(columnId);
      if (!column) return;
      const newVisibility = !column.getIsVisible();
      column.toggleVisibility(newVisibility);
      onColumnVisibilityChange?.(columnId, newVisibility);
    },
    [table, onColumnVisibilityChange],
  );

  return (
    <Popover>
      <PopoverTrigger
        render={
          trigger ?? (
            <Button
              aria-label="Toggle columns"
              role="combobox"
              variant="outline"
              size="sm"
              className="ml-auto flex h-8"
            >
              <Settings2 />
              View
              <ChevronsUpDown className="ml-auto opacity-50" />
            </Button>
          )
        }
      />
      <PopoverContent align="end" className="w-fit p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search columns..." value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No columns found.</CommandEmpty>
            <CommandGroup>
              {visibleColumns.map((column) => (
                <MenuRow
                  key={column.id}
                  column={column}
                  isLocked={lockedSet.has(column.id)}
                  isVisible={column.getIsVisible()}
                  onToggle={onToggle}
                />
              ))}
            </CommandGroup>
          </CommandList>
          {onReset ? (
            <>
              <div className="border-t" />
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 rounded-none text-muted-foreground"
                onClick={onReset}
              >
                <RotateCcw className="size-4" />
                {resetLabel ?? "Reset to defaults"}
              </Button>
            </>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * @required displayName is required for auto feature detection
 * @see "feature-detection.ts"
 */

TableViewMenu.displayName = "TableViewMenu";
