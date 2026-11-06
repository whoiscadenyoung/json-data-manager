import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@caden/ui/components/field";
import { Input } from "@caden/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@caden/ui/components/radio-group";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useSession } from "#/integrations/supabase/provider";
import { errorMessage } from "#/lib/errors";
import * as appsStore from "#/lib/store/apps";
import { listMineQueryOptions, resolveMyRole } from "#/lib/store/project-members";
import * as projectsStore from "#/lib/store/projects";

import type { AppDoc } from "../lib/app-doc";

/**
 * "Make a copy" (issue #259): apps are project-owned, so the copy needs a
 * target project — the dialog lists the caller's editable projects plus an
 * inline new-project field. Datasets the new owner can't see drop (the
 * store's duplicate rule); a map reference survives only if its map is
 * visible to them.
 */
export function CopyAppDialog({
  app,
  open,
  onOpenChange,
  onCopied,
}: {
  app: AppDoc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopied: (appId: string) => void | Promise<void>;
}) {
  const queryClient = useQueryClient(),
    { session } = useSession(),
    userId = session === null ? "" : session.user.id,
    projectsQuery = useQuery(projectsStore.listQueryOptions()),
    membershipsQuery = useQuery(listMineQueryOptions({ userId })),
    [selected, setSelected] = useState<string>(""),
    [newTitle, setNewTitle] = useState(""),
    [creating, setCreating] = useState(false),
    editableProjects = (projectsQuery.data ?? []).filter(
      (project) =>
        resolveMyRole(membershipsQuery.data, project.id, project.createdBy, userId) !== "viewer",
    );

  const runCopy = async (): Promise<void> => {
    setCreating(true);
    try {
      let projectId = selected;
      if (projectId === "") {
        projectId = await projectsStore.create({
          title: newTitle.trim() === "" ? "My project" : newTitle.trim(),
        });
        void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
      }
      const copy = await appsStore.duplicate({ appId: app.id, projectId });
      if (copy === null) {
        toast.error("Couldn't copy — this app doesn't exist.");
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
      toast.success("Copied into the project");
      onOpenChange(false);
      await onCopied(copy.id);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't copy the app."));
    } finally {
      setCreating(false);
    }
  };

  const canSubmit = creating === false && (selected !== "" || newTitle.trim() !== "");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!creating) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy “{app.title}”</DialogTitle>
          <DialogDescription>
            The copy lands in a project you can edit. Datasets it can&apos;t see drop out of the
            copy — and a map widget keeps its map only if that map is visible to you.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Into project</FieldLegend>
            {projectsQuery.isPending ? (
              <FieldDescription>Loading your projects…</FieldDescription>
            ) : editableProjects.length === 0 ? (
              <FieldDescription>
                You have no editable projects yet — name one below and the copy creates it.
              </FieldDescription>
            ) : (
              <RadioGroup
                value={selected}
                onValueChange={(value) => {
                  setSelected(value);
                }}
              >
                {editableProjects.map((project) => (
                  <Field orientation="horizontal" key={project.id}>
                    <RadioGroupItem id={`copy-project-${project.id}`} value={project.id} />
                    <FieldLabel
                      htmlFor={`copy-project-${project.id}`}
                      className="min-w-0 flex-1 truncate font-normal"
                    >
                      {project.title}
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            )}
          </FieldSet>
          <Field>
            <FieldLabel htmlFor="copy-new-project">
              <Plus className="h-3.5 w-3.5" />
              Or a new project
            </FieldLabel>
            <Input
              id="copy-new-project"
              placeholder="New project name"
              value={newTitle}
              onChange={(event) => {
                setNewTitle(event.target.value);
                if (event.target.value !== "") {
                  setSelected("");
                }
              }}
            />
            <FieldDescription>
              Creating a project puts the copy there as its owner.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={creating}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              void runCopy();
            }}
          >
            {creating ? "Copying…" : "Copy app"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
