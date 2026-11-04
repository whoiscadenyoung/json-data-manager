import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PgProfilePage, isPostgresCatalogId } from "#/features/catalog";

export const Route = createFileRoute("/users/$userId")({
  component: UserProfilePage,
});

/**
 * The profile page's origin branch (design doc §14), collapsed by the
 * stage-7 disconnect (issue #206): a Postgres profile id (a uuid — the auth
 * uid, which PG datasets stamp as `created_by`) mounts the store-backed
 * profile page; a pre-migration Convex Better Auth id (dash-free) renders
 * the shared ARCHIVED state instead of the old Convex profile read — its
 * `convex/react` hooks would throw against the unmounted provider, and the
 * accounts they read retired with the backend. The two id spaces are
 * disjoint, so the id IS the creation record. The Convex page was removed
 * from the shell; it lives on in the untouched `app/convex/` +
 * `packages/json-cms/` reference trees.
 */
function UserProfilePage() {
  const { userId } = Route.useParams();
  if (isPostgresCatalogId(userId)) {
    return <PgProfilePage profileId={userId} />;
  }
  return (
    <ArchivedConvexSurface
      description="This page served profiles from the pre-migration Convex auth store. Those accounts retired with the old backend — Postgres profiles are unaffected."
      homeTo="/datasets"
      title="Convex profiles are archived in this build"
    />
  );
}
