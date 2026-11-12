import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Textarea } from "@caden/ui/components/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import * as projectsStore from "@/lib/store/projects";

import { VIEWER_REASON } from "../lib/pg-viewer-posture";
import { useProjectShell } from "./pg-project-context";
import { PgBundleStatusLine } from "./pg-project-workspace";

/** The Project → Settings section (issue #271): rename + description for editors, delete for owners (memberships cascade; the datasets themselves stay), and — demoted from the toolbar — the publish-bundle press (#271 follow-up). */
export function PgProjectSettings() {
  const { canEdit, catalog, invalidateAll, myRole, openPress, pressing, project, projectId } =
      useProjectShell(),
    queryClient = useQueryClient(),
    navigate = useNavigate(),
    [title, setTitle] = useState(project.title),
    [description, setDescription] = useState(project.description ?? ""),
    [saving, setSaving] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    dirty = title !== project.title || description !== (project.description ?? ""),
    save = async (): Promise<void> => {
      if (title.trim() === "") {
        toast.error("A project needs a name.");
        return;
      }
      setSaving(true);
      try {
        const affected = await projectsStore.update({
          description,
          projectId,
          title: title.trim(),
        });
        if (affected === 0) {
          toast.error("Nothing saved — you may not edit this project.");
          return;
        }
        toast.success("Project settings saved.");
        invalidateAll();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to save the project."));
      } finally {
        setSaving(false);
      }
    },
    remove = async (): Promise<void> => {
      try {
        const affected = await projectsStore.remove({ projectId });
        if (affected === 0) {
          toast.error("The project didn't delete — only owners can delete it.");
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
        toast.success("Project deleted.");
        await navigate({ to: "/projects" });
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete the project."));
      }
    };
  return (
    <main className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="mb-1 text-2xl font-bold text-primary">Settings</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Name and describe the project. Visibility:{" "}
        <Badge variant="outline">{project.visibility}</Badge>
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-settings-title">
            Name <span className="text-destructive">*</span>
          </Label>
          <Input
            disabled={!canEdit}
            id="project-settings-title"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            value={title}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-settings-description">Description</Label>
          <Textarea
            disabled={!canEdit}
            id="project-settings-description"
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            value={description}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            disabled={!canEdit || !dirty || saving}
            title={canEdit ? undefined : VIEWER_REASON}
            type="submit"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
          {canEdit ? null : <span className="text-xs text-muted-foreground">{VIEWER_REASON}</span>}
        </div>
      </form>
      <Card className="mt-8 gap-2 border-destructive/40 px-5 py-4">
        <h2 className="text-sm font-semibold text-destructive">Delete project</h2>
        <p className="text-sm text-muted-foreground">
          Removes the project and its memberships. Datasets, maps and published bundles are not
          deleted.
        </p>
        <div>
          <Button
            disabled={myRole !== "owner"}
            onClick={() => {
              setConfirmDelete(true);
            }}
            title={myRole === "owner" ? undefined : "Only project owners can delete it."}
            variant="destructive"
          >
            Delete project
          </Button>
        </div>
      </Card>
      <div className="mt-8 flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Publishing</h2>
        <p className="text-sm text-muted-foreground">
          Publishing materialises this project's datasets into the global catalog as one bundle
          collection.
        </p>
        <PgBundleStatusLine projectId={projectId} />
        <div>
          <Button
            disabled={pressing || catalog.length === 0 || !canEdit}
            onClick={openPress}
            title={
              !canEdit
                ? VIEWER_REASON
                : catalog.length === 0
                  ? "Nothing to publish yet — add a dataset first."
                  : undefined
            }
            type="button"
          >
            <Rocket className="mr-2 h-4 w-4" />
            {pressing ? "Publishing…" : "Publish bundle"}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        confirmLabel="Delete"
        description="The project and its memberships are deleted. This cannot be undone."
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        title={`Delete "${project.title}"?`}
      />
    </main>
  );
}
