import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { AppDetailsDialog } from "#/features/app-builder";
import { PgProjectWorkspace } from "#/features/publishing";
import { isPostgresDatasetId } from "#/lib/dataset-source";

/**
 * The project workspace (roadmap 7a, #102; lifecycle doc §3; the project
 * catalog of issue #256). Stage 4 (#203) split the route on where the
 * project was created; the stage-7 disconnect (issue #206) collapsed it:
 * Postgres uuid ids mount the store-backed PG workspace, and every
 * pre-migration Convex project renders the shared ARCHIVED state (whose
 * `convex/react` hooks would throw against the unmounted provider). The
 * Convex workspace was removed from the shell; it lives on in the untouched
 * `app/convex/` + `packages/json-cms/` reference trees. The Convex-archive
 * gate itself lives in the LAYOUT (`route.tsx`); this index mounts the
 * workspace under it.
 */
export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectIndexPage,
});

/** The workspace's create-app dialog (the app-builder module is route-wired — ADR 0011/0014): the slot pins the dialog to THIS project. */
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

function ProjectIndexPage() {
  const { projectId } = Route.useParams();
  if (isPostgresDatasetId(projectId)) {
    return <PgProjectWorkspace createAppDialog={CreateAppDialogSlot} projectId={projectId} />;
  }
  return (
    <ArchivedConvexSurface
      description="This workspace served projects created before the Postgres migration. Pre-migration projects were retired with the old backend — Postgres projects are unaffected."
      homeTo="/projects"
      title="Convex projects are archived in this build"
    />
  );
}
