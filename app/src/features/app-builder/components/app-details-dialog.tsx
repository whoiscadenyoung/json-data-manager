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
import { Spinner } from "@caden/ui/components/spinner";
import { Textarea } from "@caden/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useSession } from "#/integrations/supabase/provider";
import { errorMessage } from "#/lib/errors";
import * as appsStore from "#/lib/store/apps";
import { listMineQueryOptions, resolveMyRole } from "#/lib/store/project-members";
import * as projectsStore from "#/lib/store/projects";

import { APP_LIMITS } from "../lib/content";

/** The required title — invalid (and saying so) while empty. */
function TitleField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const missing = value.trim() === "";
  return (
    <Field data-invalid={missing ? true : undefined}>
      <FieldLabel htmlFor="app-title">
        Title <span className="text-destructive">*</span>
      </FieldLabel>
      <Input
        id="app-title"
        value={value}
        maxLength={APP_LIMITS.title}
        placeholder="Safe Streets awards explorer"
        aria-invalid={missing ? true : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {missing && <FieldDescription>A title is required.</FieldDescription>}
    </Field>
  );
}

/**
 * Title + description, for both create and edit. Apps are PROJECT-OWNED
 * (issue #259), so create needs a target: a fixed `projectId` (the project
 * workspace's flow) or — when absent — the picker below (the /apps
 * explorer's "start from here": choose an editable project, or name a new
 * one). Edit patches the existing app in place; a project can't move.
 */
// The dialog is one ladder (project picker × create/edit × the fields), each
// branch rendered once — the section ladder the workspace bodies carry.
// oxlint-disable-next-line eslint/complexity -- the ladder is the contract.
export function AppDetailsDialog({
  appId,
  projectId,
  initial,
  open,
  onOpenChange,
  onSaved,
}: {
  appId?: string;
  /** The fixed create target (the project workspace's Apps section). */
  projectId?: string;
  initial?: { title: string; description?: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (appId: string) => void | Promise<void>;
}) {
  const queryClient = useQueryClient(),
    { session } = useSession(),
    userId = session === null ? "" : session.user.id,
    projectsQuery = useQuery({
      ...projectsStore.listQueryOptions(),
      enabled: open && appId === undefined && projectId === undefined,
    }),
    membershipsQuery = useQuery({
      ...listMineQueryOptions({ userId }),
      enabled: open && appId === undefined && projectId === undefined,
    }),
    [targetProjectId, setTargetProjectId] = useState(""),
    [newProjectTitle, setNewProjectTitle] = useState(""),
    create = useMutation({
      mutationFn: async (args: { description: string; projectId: string; title: string }) =>
        await appsStore.create(args),
    }),
    updateDetails = useMutation({
      mutationFn: async (args: { appId: string; description: string; title: string }) =>
        await appsStore.updateDetails(args),
    }),
    [title, setTitle] = useState(initial === undefined ? "" : initial.title),
    [description, setDescription] = useState(
      initial === undefined ? "" : (initial.description ?? ""),
    ),
    [submitting, setSubmitting] = useState(false),
    titleMissing = title.trim() === "",
    pickingProject = appId === undefined && projectId === undefined,
    editableProjects = (projectsQuery.data ?? []).filter(
      (project) =>
        resolveMyRole(membershipsQuery.data, project.id, project.createdBy, userId) !== "viewer",
    ),
    projectMissing = pickingProject && targetProjectId === "" && newProjectTitle.trim() === "";

  const submit = async () => {
    if (titleMissing || projectMissing) {
      return;
    }
    setSubmitting(true);
    try {
      let savedId = appId;
      if (savedId === undefined) {
        let target = projectId;
        if (target === undefined) {
          target = targetProjectId;
          if (target === "") {
            target = await projectsStore.create({
              title: newProjectTitle.trim() === "" ? "My project" : newProjectTitle.trim(),
            });
            void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
          }
        }
        // `create` answers the full new row (the insert's RETURNING) and
        // mints the app's project membership (the catalog's record).
        savedId = (await create.mutateAsync({ description, projectId: target, title })).id;
      } else {
        const affected = await updateDetails.mutateAsync({ appId: savedId, description, title });
        if (affected === 0) {
          // RLS answered with 0 rows — this viewer cannot edit the app.
          toast.error("Couldn't save — editors of the app's project can change it.");
          return;
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
      onOpenChange(false);
      if (onSaved !== undefined) {
        await onSaved(savedId);
      }
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't save the app."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{appId === undefined ? "New app" : "App details"}</DialogTitle>
          <DialogDescription>
            An app is a page of maps, charts, tables and notes built from your datasets — laid out
            your way and shareable by link.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            {pickingProject && (
              <FieldSet>
                <FieldLegend variant="label">In project</FieldLegend>
                {projectsQuery.isPending ? (
                  <FieldDescription>Loading your projects…</FieldDescription>
                ) : editableProjects.length === 0 ? (
                  <FieldDescription>
                    You have no editable projects yet — name one below.
                  </FieldDescription>
                ) : (
                  <RadioGroup
                    value={targetProjectId}
                    onValueChange={(value) => {
                      setTargetProjectId(value);
                    }}
                  >
                    {editableProjects.map((project) => (
                      <Field orientation="horizontal" key={project.id}>
                        <RadioGroupItem id={`app-project-${project.id}`} value={project.id} />
                        <FieldLabel
                          htmlFor={`app-project-${project.id}`}
                          className="min-w-0 flex-1 truncate font-normal"
                        >
                          {project.title}
                        </FieldLabel>
                      </Field>
                    ))}
                  </RadioGroup>
                )}
                <Field>
                  <FieldLabel htmlFor="app-new-project">Or a new project</FieldLabel>
                  <Input
                    id="app-new-project"
                    placeholder="New project name"
                    value={newProjectTitle}
                    onChange={(event) => {
                      setNewProjectTitle(event.target.value);
                      if (event.target.value !== "") {
                        setTargetProjectId("");
                      }
                    }}
                  />
                </Field>
              </FieldSet>
            )}
            <TitleField value={title} onChange={setTitle} />
            <Field>
              <FieldLabel htmlFor="app-description">Description</FieldLabel>
              <Textarea
                id="app-description"
                value={description}
                maxLength={APP_LIMITS.description}
                rows={3}
                placeholder="Optional — shown under the title for viewers"
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || titleMissing || projectMissing}>
                {submitting && <Spinner data-icon="inline-start" />}
                {appId === undefined ? "Create app" : "Save"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
