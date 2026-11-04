import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PgGroupPage, isPostgresCatalogId } from "#/features/catalog";
import { PgGroupExport } from "#/features/datasets";

export const Route = createFileRoute("/groups/$groupId")({
  component: GroupDetailPage,
});

/**
 * The group page's origin branch (design doc §14), collapsed by the stage-7
 * disconnect (issue #206): Postgres groups (uuid ids, stage 3) mount the
 * store-backed page — composing the stage-5 export control in HERE because
 * the route layer may import any feature while the catalog feature must not
 * import `#/features/datasets` back (the cross-feature graph stays
 * acyclic). A pre-migration Convex group renders the shared ARCHIVED state
 * instead of its old Convex surface (the members/entries subscriptions, the
 * catalog mutations, the group map and its export) — those `convex/react`
 * hooks would throw against the unmounted provider. The Convex page was
 * removed from the shell; it lives on in the untouched `app/convex/` +
 * `packages/json-cms/` reference trees.
 */
function GroupDetailPage() {
  const { groupId } = Route.useParams();
  if (isPostgresCatalogId(groupId)) {
    return (
      <PgGroupPage
        groupId={groupId}
        renderExport={(group) => <PgGroupExport groupName={group.name} members={group.members} />}
      />
    );
  }
  return (
    <ArchivedConvexSurface
      description="This page served groups created before the Postgres migration. Pre-migration groups were retired with the old backend — Postgres groups are unaffected."
      homeTo="/datasets"
      title="Convex groups are archived in this build"
    />
  );
}
