import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, FolderKanban, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ProjectRoleBadge } from "#/components/project-members-dialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";

type ProjectRow = FunctionReturnType<typeof api.projects.list>[number];

/**
 * One candidate project row: the viewer's own project, badged with their role
 * in it, with the Add action — or the Added badge when this artifact is
 * already a member (the CollectionAddSheet precedent).
 */
function ProjectCandidateRow({
  project,
  added,
  pendingId,
  onAdd,
}: {
  project: ProjectRow;
  added: boolean;
  pendingId: string | undefined;
  onAdd: (project: ProjectRow) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{project.title}</p>
          {project.description !== undefined && (
            <p className="truncate text-xs text-muted-foreground">{project.description}</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ProjectRoleBadge role={project.role} />
        {added ? (
          <Badge variant="secondary">
            <Check />
            Added
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={pendingId !== undefined}
            onClick={() => {
              onAdd(project);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {pendingId === project._id ? "Adding…" : "Add"}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * The "Add to project" picker (phase 2 of the project-workspace design): the
 * dataset surfaces' entry point — browser cards and the dataset page's
 * actions menu open this sheet, which lists every project the signed-in
 * viewer BELONGS to (the member-scoped `projects.list`, ADR 0011) and adds
 * the artifact as a reference on click. Nothing is copied: a published
 * dataset lands LINKED, pinned at its newest published version until someone
 * Syncs (the workspace's keep-in-sync checkbox flips it to float); a draft
 * lands owned, shared with that project's members (ADR 0011's adding-is-
 * sharing line). Projects already holding the artifact show Added instead of
 * a second Add — the server's duplicate rejection stays the backstop.
 * Queries subscribe only while the sheet is open (the light-query
 * convention).
 */
export function AddToProjectSheet({
  artifactId,
  artifactKind,
  artifactTitle,
  open,
  onOpenChange,
}: {
  artifactId: string;
  artifactKind: "dataset";
  artifactTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pendingId, setPendingId] = useState<string | undefined>(),
    navigate = useNavigate(),
    projects = useQuery({ ...convexQuery(api.projects.list, {}), enabled: open }).data,
    holding = useQuery({
      ...convexQuery(api.projects.holdingProjects, { artifactId, artifactKind }),
      enabled: open,
    }).data,
    add = useMutation(api.projects.addArtifact),
    addedIds = new Set(holding ?? []);

  const handleAdd = async (project: ProjectRow): Promise<void> => {
    setPendingId(project._id);
    try {
      await add({ artifactId, artifactKind, projectId: project._id, syncMode: "manual" });
      toast.success(`Added "${artifactTitle}" to "${project.title}".`);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to add to project."));
    } finally {
      setPendingId(undefined);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to project</SheetTitle>
          <SheetDescription>
            Add "{artifactTitle}" as a reference — nothing is copied. Published datasets are pinned
            at their newest version until someone syncs; drafts are shared with the project's
            members.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
          {projects === undefined ? null : projects.length === 0 ? (
            <Empty className="min-h-40 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderKanban />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Create a project first — datasets are added to projects you belong to.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    void navigate({ to: "/projects" });
                  }}
                >
                  Go to Projects
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {projects.map((project) => (
                <ProjectCandidateRow
                  key={project._id}
                  project={project}
                  added={addedIds.has(project._id)}
                  pendingId={pendingId}
                  onAdd={(target) => {
                    void handleAdd(target);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
