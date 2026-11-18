import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { cn } from "@caden/ui/lib/utils";
import {
  Calculator,
  Code,
  Funnel,
  Layers,
  ListChecks,
  Merge,
  Plus,
  Sigma,
  type LucideIcon,
} from "lucide-react";

import type { AddableKind } from "../lib/view-model";

export const ADD_ITEMS: { icon: LucideIcon; kind: AddableKind; label: string; short: string }[] = [
  { icon: Funnel, kind: "filter", label: "Filter rows", short: "Filter" },
  { icon: ListChecks, kind: "columns", label: "Rename or drop columns", short: "Columns" },
  { icon: Calculator, kind: "calculate", label: "Calculate fields", short: "Calculate" },
  { icon: Merge, kind: "join", label: "Join two nodes", short: "Join" },
  { icon: Layers, kind: "stack", label: "Stack nodes (add rows)", short: "Stack" },
  { icon: Sigma, kind: "groupBy", label: "Group and summarize", short: "Group" },
  { icon: Code, kind: "sql", label: "Custom SQL", short: "SQL" },
];

/** The canvas toolbar: one button per node kind; a click adds that node after the selected one. */
export function AddNodeToolbar({
  className,
  disabledReason,
  onAdd,
}: {
  className?: string;
  /** Why nodes can't be added yet (shown as the buttons' title). */
  disabledReason: string | undefined;
  onAdd: (kind: AddableKind) => void;
}) {
  return (
    <div
      aria-label="Add a node"
      className={cn(
        "flex flex-wrap items-center gap-0.5 rounded-lg border bg-card p-1 shadow-xs",
        className,
      )}
      role="toolbar"
    >
      <span className="px-2 text-xs font-medium text-muted-foreground">Add node</span>
      {ADD_ITEMS.map((item) => (
        <Button
          aria-label={`Add node: ${item.label}`}
          disabled={disabledReason !== undefined}
          key={item.kind}
          onClick={() => {
            onAdd(item.kind);
          }}
          size="sm"
          title={disabledReason ?? item.label}
          type="button"
          variant="ghost"
        >
          <item.icon className="h-3.5 w-3.5" />
          {item.short}
        </Button>
      ))}
    </div>
  );
}

/** The "+" on a canvas connection: picks a node kind to insert on it. */
export function InsertNodeButton({
  label,
  onAdd,
}: {
  /** What the connection joins, e.g. "d1 to join" (names the button). */
  label: string;
  onAdd: (kind: AddableKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={`Insert a node: ${label}`}
            className="flex size-5 items-center justify-center rounded-full border border-primary bg-background text-primary shadow-xs hover:bg-primary hover:text-primary-foreground"
            type="button"
          >
            <Plus className="size-3" />
          </button>
        }
      />
      <DropdownMenuContent align="center" className="w-56">
        {ADD_ITEMS.map((item) => (
          <DropdownMenuItem
            key={item.kind}
            onClick={() => {
              onAdd(item.kind);
            }}
          >
            <item.icon className="h-3.5 w-3.5" />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A dropdown that adds a node of the picked kind (the "Branch from here" menu). */
export function AddNodeMenu({
  disabled,
  label,
  onAdd,
}: {
  disabled?: boolean;
  label: string;
  onAdd: (kind: AddableKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button className="w-fit" disabled={disabled} size="sm" type="button" variant="outline">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {ADD_ITEMS.map((item) => (
          <DropdownMenuItem
            key={item.kind}
            onClick={() => {
              onAdd(item.kind);
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
