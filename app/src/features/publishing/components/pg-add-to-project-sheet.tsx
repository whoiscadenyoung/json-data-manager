import { Button } from "@caden/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "@/components/router-button";
import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import { listMineQueryOptions } from "@/lib/store/project-members";
import * as projectsStore from "@/lib/store/projects";

/**
 * The add-to-project sheet (issue #256's "Add to project" affordances): from
 * the datasets browser or a dataset page, the signed-in user adds the
 * dataset to one of their projects as a LINKED reference — a pin at the
 * chain head, never a copy (D1; ADR 0018). The picker lists the projects
 * where the seat can write (owner|editor — the RLS insert gate; viewers'
 * projects render with the reason, and viewership alone never offers the
 * add). Duplicate adds ride the 23505 constraint verbatim.
 */
export function PgAddToProjectSheet({
  artifactId,
  onOpenChange,
  open,
}: {
  artifactId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const queryClient = useQueryClient(),
    { session } = useSession(),
    userId = session === null ? "" : session.user.id,
    membershipsQuery = useQuery({ ...listMineQueryOptions({ userId }), enabled: open }),
    writable = (membershipsQuery.data ?? []).filter((membership) => membership.role !== "viewer"),
    [pendingId, setPendingId] = useState<string>(),
    add = async (projectId: string): Promise<void> => {
      setPendingId(projectId);
      try {
        const target = writable.find((membership) => membership.projectId === projectId),
          projectTitle = target === undefined ? "the project" : target.project.title;
        const outcome = await projectsStore.addArtifact({
          artifactId,
          artifactKind: "dataset",
          projectId,
          role: "linked",
          syncMode: "manual",
        });
        if (outcome.artifact === null) {
          toast.error("The reference didn't land — you may not have access.");
          return;
        }
        toast.success(
          outcome.pinnedRef === null
            ? `Added to "${projectTitle}" — it floats on this dataset's chain (no frozen version to pin yet).`
            : `Added to "${projectTitle}" — pinned at ${outcome.pinnedRef}.`,
        );
        void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setPendingId(undefined);
      }
    };
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to project</SheetTitle>
          <SheetDescription>
            Reference this dataset from a project you can edit — nothing is copied.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-6">
          {membershipsQuery.isPending ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              Loading projects…
            </p>
          ) : writable.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderKanban />
                </EmptyMedia>
                <EmptyTitle>No editable projects</EmptyTitle>
                <EmptyDescription>
                  Create a project — or ask an owner for editor access — to reference this dataset
                  from one.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <RouterButton to="/projects">
                  <Plus className="mr-2 h-4 w-4" />
                  Go to Projects
                </RouterButton>
              </EmptyContent>
            </Empty>
          ) : (
            writable.map((membership) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={membership.projectId}
                onClick={() => {
                  void add(membership.projectId);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {membership.project.title}
                </span>
                {pendingId === membership.projectId ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The sheet-driving button for the datasets browser card — a SIBLING of the card's link (anchors can't nest; the chip rule). Hidden signed-out: projects are membership surfaces. */
export function PgDatasetCardAddToProjectButton({ datasetId }: { datasetId: string }) {
  const { session } = useSession(),
    [open, setOpen] = useState(false);
  if (session === null) {
    return null;
  }
  return (
    <>
      <Button
        aria-label="Add to project"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          setOpen(true);
        }}
        size="icon"
        title="Add this dataset to one of your projects (a linked reference — nothing is copied)"
        variant="ghost"
      >
        <FolderKanban className="h-4 w-4" />
      </Button>
      <PgAddToProjectSheet artifactId={datasetId} onOpenChange={setOpen} open={open} />
    </>
  );
}
