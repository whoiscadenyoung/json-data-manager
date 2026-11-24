import { createFileRoute } from "@tanstack/react-router";

import { PgProfilePage } from "#/features/catalog";

export const Route = createFileRoute("/users/$userId")({
  component: UserProfilePage,
});

function UserProfilePage() {
  const { userId } = Route.useParams();
  return <PgProfilePage profileId={userId} />;
}
