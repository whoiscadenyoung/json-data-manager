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

import { errorMessage } from "@/lib/errors";

import { createProjectView } from "../lib/create-view";
import { blankDefinition, inputPickerOptions, type PickerDataset } from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";

/**
 * "New view": a title and a base dataset (picked by TITLE). Both are
 * required and the sheet says so; Create explains what is missing instead of
 * sitting silently disabled.
 */
export function CreateViewSheet({
  datasets,
  onOpenChange,
  open,
  projectId,
}: {
  /** The datasets (and views) of the project, by title. */
  datasets: PickerDataset[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  const [title, setTitle] = useState(""),
    [baseId, setBaseId] = useState(""),
    [busy, setBusy] = useState(false),
    navigate = useNavigate(),
    queryClient = useQueryClient(),
    missing =
      title.trim() === ""
        ? "Give the view a title."
        : baseId === ""
          ? "Pick the dataset the view starts from."
          : undefined;
  const create = async (): Promise<void> => {
    const base = datasets.find((dataset) => dataset.id === baseId);
    if (base === undefined) {
      return;
    }
    setBusy(true);
    try {
      const viewId = await createProjectView({
        definition: blankDefinition({ datasetId: base.id, title: base.title }),
        projectId,
        title: title.trim(),
      });
      void queryClient.invalidateQueries({ queryKey: ["pg:views"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
      onOpenChange(false);
      setTitle("");
      setBaseId("");
      await navigate({ params: { projectId, viewId }, to: "/projects/$projectId/views/$viewId" });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't create the view."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>New view</SheetTitle>
          <SheetDescription>
            A view is a dataset built from steps (join, filter, group). Pick where it starts; add
            the steps in the editor.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-view-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-view-title"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              placeholder="e.g. Deployments per state"
              value={title}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>
              Starts from <span className="text-destructive">*</span>
            </Label>
            <LabeledSelect
              ariaLabel="Base dataset"
              onChange={setBaseId}
              options={inputPickerOptions(datasets)}
              placeholder="Pick a dataset"
              value={baseId}
            />
            {datasets.length === 0 && (
              <p className="text-xs text-muted-foreground">
                This project has no datasets yet. Create or import one first.
              </p>
            )}
          </div>
          {missing !== undefined && <p className="text-xs text-muted-foreground">{missing}</p>}
          <Button
            disabled={missing !== undefined || busy}
            onClick={() => {
              void create();
            }}
            type="button"
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create view
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
