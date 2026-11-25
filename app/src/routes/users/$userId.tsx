import { createFileRoute } from "@tanstack/react-router";

import { ProfilePage } from "#/features/catalog";

export const Route = createFileRoute("/users/$userId")({
  component: UserProfilePage,
});

function UserProfilePage() {
  const { userId } = Route.useParams();
  return <ProfilePage profileId={userId} />;
}
