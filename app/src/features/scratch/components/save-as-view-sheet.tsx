import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  createProjectView,
  definitionFromScratch,
  referencedScratchTables,
  type ScratchTableInfo,
} from "#/features/views";
import { errorMessage } from "@/lib/errors";
import { runView } from "@/lib/store/views";

/**
 * "Save as view": a title and the base table (picked from the tables the
 * query reads). The view gets one `sql` step holding the query unchanged;
 * it is created, run once, and its page opens.
 */
export function SaveAsViewSheet({
  onOpenChange,
  open,
  projectId,
  sql,
  tables,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  sql: string;
  tables: ScratchTableInfo[];
}) {
  const referenced = referencedScratchTables(sql, tables),
    [title, setTitle] = useState(""),
    [chosen, setChosen] = useState(""),
    [busy, setBusy] = useState(false),
    navigate = useNavigate(),
    queryClient = useQueryClient(),
    first = referenced[0],
    baseAlias = referenced.some((table) => table.alias === chosen)
      ? chosen
      : first === undefined
        ? ""
        : first.alias,
    missing = title.trim() === "" ? "Give the view a title." : undefined;
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const viewId = await createProjectView({
        definition: definitionFromScratch(sql, tables, baseAlias),
        projectId,
        title: title.trim(),
      });
      for (const key of ["pg:views", "pg:datasets", "pg:projects"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      await runOnce(viewId);
      onOpenChange(false);
      setTitle("");
      await navigate({ params: { projectId, viewId }, to: "/projects/$projectId/views/$viewId" });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't save the view."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Save as view</SheetTitle>
          <SheetDescription>
            The view keeps this query as its one SQL step, unchanged, and runs it once.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scratch-view-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="scratch-view-title"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              placeholder="e.g. Deployments per state"
              value={title}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scratch-view-base">Base table</Label>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              id="scratch-view-base"
              onChange={(event) => {
                setChosen(event.target.value);
              }}
              value={baseAlias}
            >
              {referenced.map((table) => (
                <option key={table.alias} value={table.alias}>
                  {table.title} ({table.name})
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              The view keeps this table&apos;s geometry and row identity.
            </p>
          </div>
          {missing !== undefined && <p className="text-xs text-muted-foreground">{missing}</p>}
          <Button
            disabled={missing !== undefined || busy || baseAlias === ""}
            onClick={() => void save()}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Saving…" : "Save view"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The one run after creating; a failure is a toast, the page still opens with the error in its run history. */
async function runOnce(viewId: string): Promise<void> {
  try {
    const outcome = await runView(viewId);
    if (outcome.status === "ok") {
      toast.success(`View saved and run: ${outcome.rowCount.toLocaleString()} rows.`);
    } else {
      toast.error(`View saved, but its first run failed: ${outcome.error}`);
    }
  } catch (error) {
    toast.error(errorMessage(error, "View saved, but it could not be run."));
  }
}
