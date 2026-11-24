import { Outlet, createFileRoute } from "@tanstack/react-router";

import { AppDetailsDialog } from "#/features/app-builder";
import { PgProjectShell } from "#/features/publishing";

/**
 * The /projects/$projectId LAYOUT = the project workspace SHELL (issue #271):
 * a persistent toolbar + left sidebar around every project route. Sections are child routes (index =
 * Overview, catalog, create = Import, maps/$mapId, publish, members) that
 * render in the shell's content area. (History: issue #258 — the old
 * `$projectId.tsx` had no <Outlet/> and masked its children.)
 */
export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

/** The shell's create-app dialog (the app-builder module is route-wired — ADR 0011/0014): the slot pins the dialog to THIS project. */
function CreateAppDialogSlot({
  onSaved,
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (appId: string) => void | Promise<void>;
  projectId: string;
}) {
  return (
    <AppDetailsDialog
      onSaved={onSaved}
      open={open}
      onOpenChange={onOpenChange}
      projectId={projectId}
    />
  );
}

function ProjectLayout() {
  const { projectId } = Route.useParams();
  return (
    <PgProjectShell createAppDialog={CreateAppDialogSlot} projectId={projectId}>
      <Outlet />
    </PgProjectShell>
  );
}
