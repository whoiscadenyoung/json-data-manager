import type { FunctionReturnType } from "convex/server";
import { Plus, Search } from "lucide-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { api } from "#convex/_generated/api";

type DatasetSummary = FunctionReturnType<typeof api.schemas.listSummaries>[number];

/** Side panel listing `candidates` (datasets not already assigned) so the user can pick one to add. */
export function DatasetPickerSheet({
  title,
  description,
  candidates,
  open,
  onOpenChange,
  onPick,
}: {
  title: string;
  description: string;
  candidates: DatasetSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (dataset: DatasetSummary) => Promise<void>;
}) {
  const [search, setSearch] = useState(""),
    [pendingId, setPendingId] = useState<string | undefined>(),
    normalizedSearch = search.trim().toLowerCase(),
    visible = normalizedSearch
      ? candidates.filter((dataset) => dataset.title.toLowerCase().includes(normalizedSearch))
      : candidates,
    handlePick = async (dataset: DatasetSummary) => {
      setPendingId(dataset._id);
      try {
        await onPick(dataset);
        onOpenChange(false);
      } finally {
        setPendingId(undefined);
      }
    };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              placeholder="Search datasets…"
              className="pl-7"
            />
          </div>

          {visible.length === 0 ? (
            <Empty className="min-h-32 border">
              <EmptyTitle>No datasets to add</EmptyTitle>
              <EmptyDescription>
                {candidates.length === 0
                  ? "Every dataset already lives here."
                  : "No datasets match your search."}
              </EmptyDescription>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {visible.map((dataset) => (
                <li
                  key={dataset._id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{dataset.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{dataset.description}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pendingId !== undefined}
                    onClick={() => {
                      void handlePick(dataset);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {pendingId === dataset._id ? "Adding…" : "Add"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
