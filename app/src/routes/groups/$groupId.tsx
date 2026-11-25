import { createFileRoute } from "@tanstack/react-router";

import { GroupPage } from "#/features/catalog";
import { GroupExport } from "#/features/datasets";

export const Route = createFileRoute("/groups/$groupId")({
  component: GroupDetailPage,
});

/**
 * The export control composes in HERE because the route layer may import any
 * feature while the catalog feature must not import `#/features/datasets`
 * back (the cross-feature graph stays acyclic).
 */
function GroupDetailPage() {
  const { groupId } = Route.useParams();
  return (
    <GroupPage
      groupId={groupId}
      renderExport={(group) => <GroupExport groupName={group.name} members={group.members} />}
    />
  );
}
