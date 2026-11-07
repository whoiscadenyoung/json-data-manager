import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
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

import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import { listMineQueryOptions } from "@/lib/store/project-members";
import * as projectsStore from "@/lib/store/projects";

/**
 * The "start from here" target sheet (issue #262; §4.3): the explorers'
 * creation affordances never create outside projects — this sheet picks the
 * project the creation lands in (an editable seat's project, or a freshly
 * named one) and hands the id to the caller, which navigates into that
 * project's flow. Mirrors the add-to-project sheet's posture: viewership
 * alone never offers the target, the new-project row creates then continues,
 * and the sheet closes only after the caller's handoff resolves.
 */
export function PgProjectTargetSheet({
  title,
  description,
  open,
  onOpenChange,
  onTarget,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTarget: (projectId: string) => Promise<void> | void;
}) {
  const queryClient = useQueryClient(),
    { session } = useSession(),
    userId = session === null ? "" : session.user.id,
    membershipsQuery = useQuery({ ...listMineQueryOptions({ userId }), enabled: open }),
    writable = (membershipsQuery.data ?? []).filter((membership) => membership.role !== "viewer"),
    [name, setName] = useState(""),
    [pendingId, setPendingId] = useState<string>(),
    run = async (projectId: string, write?: () => Promise<string>): Promise<void> => {
      setPendingId(projectId);
      try {
        if (write !== undefined) {
          await write();
        }
        await onTarget(projectId);
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setPendingId(undefined);
      }
    },
    createProject = async (): Promise<void> => {
      const trimmed = name.trim();
      if (trimmed === "") {
        toast.error("Name the new project first.");
        return;
      }
      await run("new", async () => {
        const projectId = await projectsStore.create({ title: trimmed });
        void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
        void queryClient.invalidateQueries({ queryKey: ["pg:project-members"] });
        return projectId;
      });
    },
    pick = async (projectId: string): Promise<void> => {
      await run(projectId);
    };
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName("");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-6">
          <div className="flex items-center gap-2">
            <Input
              aria-label="New project name"
              maxLength={120}
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pendingId === undefined) {
                  void createProject();
                }
              }}
              placeholder="New project — name it…"
              value={name}
            />
            <Button
              disabled={pendingId !== undefined}
              onClick={() => {
                void createProject();
              }}
              size="sm"
            >
              {pendingId === "new" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create
            </Button>
          </div>
          <p className="mt-2 text-xs font-medium text-muted-foreground">
            …or continue in an existing project:
          </p>
          {membershipsQuery.isPending ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              Loading projects…
            </p>
          ) : writable.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              <FolderKanban className="mr-1.5 inline h-3.5 w-3.5" />
              No editable projects yet — name one above.
            </p>
          ) : (
            writable.map((membership) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={membership.projectId}
                onClick={() => {
                  void pick(membership.projectId);
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
