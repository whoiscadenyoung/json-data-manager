import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Textarea } from "@caden/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Calendar, ChevronRight, Database, FolderKanban, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import {
  listMineQueryOptions,
  resolveMyRole,
  ROLE_LABELS,
  type ProjectRole,
} from "@/lib/store/project-members";
import * as projectsStore from "@/lib/store/projects";
import type { ProjectRow } from "@/lib/store/projects";

/**
 * The Postgres projects browser section (stage 4, #203; lifecycle doc §3) —
 * the working layer's front door for PG-created projects, rendered by the
 * /projects route BESIDE the Convex page (the transitional split-brain:
 * each store lists its own projects, badges mark the origin — Convex
 * projects keep rendering exactly as they always have). Reads are
 * creator-scoped by RLS (projects are the one private artifact), so this
 * section is signed-in-only and hides itself otherwise.
 */

/** The new-project dialog for PG projects — title required (the only required field), description optional. */
function PgNewProjectDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [submitting, setSubmitting] = useState(false),
    titleEmpty = title.trim() === "",
    submit = async (): Promise<void> => {
      if (titleEmpty) {
        toast.error("Give the project a title.");
        return;
      }
      setSubmitting(true);
      try {
        const projectId = await projectsStore.create({
          description: description.trim() === "" ? undefined : description.trim(),
          title: title.trim(),
        });
        toast.success("Project created!");
        void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
        onOpenChange(false);
        await navigate({ params: { projectId }, to: "/projects/$projectId" });
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setSubmitting(false);
      }
    };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!submitting) {
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Postgres project</DialogTitle>
          <DialogDescription>
            A project is your working container — imports and drafts land in it; publishing turns
            its artifacts into catalog datasets.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pg-project-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              aria-invalid={titleEmpty}
              id="pg-project-title"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              placeholder="SMART 2024"
              value={title}
            />
            {titleEmpty && (
              <p className="text-xs font-medium text-destructive">
                A title is required before this can be created.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pg-project-description">Description</Label>
            <Textarea
              id="pg-project-description"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              placeholder="What this project is for (optional)"
              rows={3}
              value={description}
            />
          </div>
          <DialogFooter>
            <Button disabled={submitting} type="submit">
              <Plus className="mr-2 h-4 w-4" />
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One project card — the Convex browser's card shape, over the PG row. */

function PgProjectCard({ project, role }: { project: ProjectRow; role: ProjectRole }) {
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      <Link
        className="flex min-w-0 flex-1 flex-col gap-2 py-0"
        params={{ projectId: project.id }}
        to="/projects/$projectId"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge title="Created on the Postgres backend — the new native path." variant="outline">
            <Database className="h-3 w-3" />
            Postgres
          </Badge>
          <Badge title={`Your access to this project (${ROLE_LABELS[role]}).`} variant="secondary">
            {ROLE_LABELS[role]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {project.artifactCount} {project.artifactCount === 1 ? "artifact" : "artifacts"}
          </span>
        </div>
        <div>
          <h3 className="text-base font-semibold">{project.title}</h3>
          {project.description !== null && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
          )}
        </div>
        <div className="flex items-center text-xs text-muted-foreground">
          <Calendar className="mr-1.5 h-3.5 w-3.5" />
          Created {new Date(project.createdAt).toLocaleDateString()}
        </div>
      </Link>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </Card>
  );
}

/**
 * The PG section of the projects page: hidden while the session resolves or
 * signed out (Convex projects keep their own gate), otherwise the caller's
 * PG projects with a create dialog — clearly labeled as the Postgres side of
 * the split.
 */
export function PgProjectsBrowser() {
  const { isLoading, session } = useSession(),
    projectsQuery = useQuery({
      ...projectsStore.listQueryOptions(),
      enabled: !isLoading && session !== null,
    }),
    membershipsQuery = useQuery({
      ...listMineQueryOptions({ userId: session === null ? "" : session.user.id }),
      enabled: !isLoading && session !== null,
    }),
    [formOpen, setFormOpen] = useState(false);
  if (isLoading || session === null) {
    return null;
  }
  const projects = projectsQuery.data;
  return (
    <section className="mb-10 pt-8">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Database className="h-4 w-4 text-primary" />
            Postgres projects
          </h2>
          <p className="text-sm text-muted-foreground">
            Created on the Postgres backend — the new native path. Your Convex projects stay below,
            rendering as they always have.
          </p>
        </div>
        <Button
          onClick={() => {
            setFormOpen(true);
          }}
          type="button"
        >
          <Plus className="mr-2 h-4 w-4" />
          New project
        </Button>
      </div>
      {projects === undefined ? (
        <div className="flex min-h-20 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      ) : projects.length === 0 ? (
        <Empty className="min-h-40 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderKanban />
            </EmptyMedia>
            <EmptyTitle>No Postgres projects yet</EmptyTitle>
            <EmptyDescription>
              Create one to import data and draft datasets without touching the catalog.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => {
                setFormOpen(true);
              }}
              type="button"
              variant="outline"
            >
              <Plus className="mr-2 h-4 w-4" />
              Create your first Postgres project
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((project) => (
            <PgProjectCard
              key={project.id}
              project={project}
              role={resolveMyRole(
                membershipsQuery.data,
                project.id,
                project.createdBy,
                session === null ? "" : session.user.id,
              )}
            />
          ))}
        </div>
      )}
      <PgNewProjectDialog onOpenChange={setFormOpen} open={formOpen} />
    </section>
  );
}
