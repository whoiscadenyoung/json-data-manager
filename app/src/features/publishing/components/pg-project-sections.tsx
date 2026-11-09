import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Textarea } from "@caden/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import * as derivedStore from "@/lib/store/derived";
import * as projectsStore from "@/lib/store/projects";

import { VIEWER_REASON } from "../lib/pg-viewer-posture";
import { useProjectShell } from "./pg-project-context";

/** The Project → Settings section (issue #271): rename + description for editors, delete for owners (memberships cascade; the datasets themselves stay). */
export function PgProjectSettings() {
  const { canEdit, invalidateAll, myRole, project, projectId } = useProjectShell(),
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

/** The Data → Analysis section (issue #271): the project's datasets with one-click entry to each dataset's Transform / Analyze tabs, and its derived datasets (outputs also appear in the catalog as Derived). */
export function PgProjectAnalysis() {
  const { catalog, projectId } = useProjectShell(),
    datasetsQuery = useQuery(datasetsStore.listQueryOptions()),
    derivedQuery = useQuery(derivedStore.summariesQueryOptions()),
    titleOf = (id: string, kind: "dataset" | "derived"): string => {
      const source = kind === "dataset" ? datasetsQuery.data : derivedQuery.data,
        match = (source ?? []).find((item) => item.id === id);
      return match === undefined ? "Not visible to you" : match.title;
    },
    datasets = catalog.filter((row) => row.artifact.artifactKind === "dataset"),
    derived = catalog.filter((row) => row.artifact.artifactKind === "derived");
  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      <h1 className="mb-1 text-2xl font-bold text-primary">Analysis</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Run SQL or build a transform over a project dataset. Outputs land in the catalog as Derived
        datasets.
      </p>
      <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
        Datasets ({datasets.length})
      </h2>
      {datasets.length === 0 ? (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          Add a dataset to the catalog first — analysis runs over catalog datasets.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {datasets.map((row) => (
            <Card className="flex-row items-center gap-3 px-4 py-3" key={row.artifact.id}>
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                {titleOf(row.artifact.artifactId, "dataset")}
              </p>
              <Link
                className="rounded-md border px-3 py-1 text-sm hover:bg-muted"
                params={{ projectId, schemaId: row.artifact.artifactId }}
                search={{ view: "analyze" }}
                to="/projects/$projectId/datasets/$schemaId"
              >
                Analyze
              </Link>
              <Link
                className="rounded-md border px-3 py-1 text-sm hover:bg-muted"
                params={{ projectId, schemaId: row.artifact.artifactId }}
                search={{ view: "transform" }}
                to="/projects/$projectId/datasets/$schemaId"
              >
                Transform
              </Link>
            </Card>
          ))}
        </div>
      )}
      {derived.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold text-muted-foreground">
            Derived ({derived.length})
          </h2>
          <div className="flex flex-col gap-2">
            {derived.map((row) => (
              <Card className="flex-row items-center gap-3 px-4 py-3" key={row.artifact.id}>
                <Badge variant="outline">Derived</Badge>
                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                  {titleOf(row.artifact.artifactId, "derived")}
                </p>
              </Card>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
