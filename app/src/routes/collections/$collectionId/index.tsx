import { createFileRoute } from "@tanstack/react-router";

import { PgCollectionPage } from "#/features/catalog";

export const Route = createFileRoute("/collections/$collectionId/")({
  component: CollectionDetailPage,
});

function CollectionDetailPage() {
  const { collectionId } = Route.useParams();
  return <PgCollectionPage collectionId={collectionId} />;
}
