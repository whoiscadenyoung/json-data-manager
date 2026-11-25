import { createFileRoute } from "@tanstack/react-router";

import { CollectionPage } from "#/features/catalog";

export const Route = createFileRoute("/collections/$collectionId/")({
  component: CollectionDetailPage,
});

function CollectionDetailPage() {
  const { collectionId } = Route.useParams();
  return <CollectionPage collectionId={collectionId} />;
}
