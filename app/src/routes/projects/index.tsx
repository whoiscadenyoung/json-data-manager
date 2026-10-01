import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useConvexAuth, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Calendar, ChevronRight, FolderKanban, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { errorMessage } from "#/lib/errors";

import { api } from "../../../convex/_generated/api";

/**
 * The project browser (roadmap 7a, #102; lifecycle doc §3): the working
 * layer's front door. Projects are the draft-side containers where
 * import/create lands; the datasets browser remains the materialized
 * catalog. The read is creator-scoped server-side (`projects.list` returns
 * the signed-in caller's own projects — other users' projects never enter
 * the payload), through the same light-query bridge the other browsers use.
 */
export const Route = createFileRoute("/projects/")({
  component: ProjectsPage,
});

type ProjectSummary = FunctionReturnType<typeof api.projects.list>[number];

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useMutation(api.projects.create),
    navigate = Route.useNavigate(),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (title.trim() === "") {
      toast.error("Give the project a title.");
      return;
    }
    setSubmitting(true);
    try {
      const projectId = await create({
        description: description.trim() === "" ? undefined : description,
        title,
      });
      toast.success("Project created!");
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
      open={open}
      onOpenChange={(next) => {
        if (!submitting) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is your working container — imports and drafts land in it; publishing turns
            its artifacts into catalog datasets.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="space-y-4 py-2"
        >
          <div className="space-y-2">
            <Label htmlFor="project-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="project-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
              }}
              placeholder="SMART 2024"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="What this project is for (optional)"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              <Plus className="h-4 w-4 mr-2" />
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      <Link
        to="/projects/$projectId"
        params={{ projectId: project._id }}
        className="flex min-w-0 flex-1 flex-col gap-2 py-0"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {project.artifactCount} {project.artifactCount === 1 ? "artifact" : "artifacts"}
          </span>
        </div>
        <div>
          <h3 className="text-base font-semibold">{project.title}</h3>
          <p className="line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
        </div>
        <div className="flex items-center text-xs text-muted-foreground">
          <Calendar className="mr-1.5 h-3.5 w-3.5" />
          Created {new Date(project._creationTime).toLocaleDateString()}
        </div>
      </Link>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </Card>
  );
}

function ProjectsPage() {
  // The auth gate renders BEFORE the query state: anonymous callers' query
  // throws, and without this branch that shows as an infinite spinner.
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth(),
    projects = useQuery({ ...convexQuery(api.projects.list, {}) }).data,
    [formOpen, setFormOpen] = useState(false);

  if (authLoading) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderKanban />
            </EmptyMedia>
            <EmptyTitle>Sign in to continue</EmptyTitle>
            <EmptyDescription>Projects are per-creator — sign in to see yours.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <RouterButton to="/signin">Sign in</RouterButton>
          </EmptyContent>
        </Empty>
      </main>
    );
  }
  if (projects === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-primary mb-1">Projects</h1>
          <p className="text-muted-foreground">
            Your working containers — import and draft here, publish to the catalog when ready
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setFormOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          New project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderKanban />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Create a project to import data and draft datasets without touching the catalog.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              onClick={() => {
                setFormOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create your first project
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((project) => (
            <ProjectCard key={project._id} project={project} />
          ))}
        </div>
      )}

      <NewProjectDialog open={formOpen} onOpenChange={setFormOpen} />
    </main>
  );
}
