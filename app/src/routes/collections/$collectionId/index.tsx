import { createFileRoute } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { PgCollectionPage, isPostgresCatalogId } from "#/features/catalog";

export const Route = createFileRoute("/collections/$collectionId/")({
  component: CollectionDetailPage,
});

/**
 * The collection page's origin branch (design doc §14, the dataset page's
 * pattern), collapsed by the stage-7 disconnect (issue #206): the id says
 * where the row was created — Postgres collections (uuid ids, stage 3)
 * mount the store-backed page; a pre-migration Convex collection renders
 * the shared ARCHIVED state instead of its old Convex surface (the catalog
 * subscriptions and mutations, the group management, the ungrouped-datasets
 * card, the collection extent map) — those `convex/react` hooks would throw
 * against the unmounted provider. The Convex page was removed from the
 * shell; it lives on in the untouched `app/convex/` + `packages/json-cms/`
 * reference trees.
 */
function CollectionDetailPage() {
  const { collectionId } = Route.useParams();
  if (isPostgresCatalogId(collectionId)) {
    return <PgCollectionPage collectionId={collectionId} />;
  }
  return (
    <ArchivedConvexSurface
      description="This page served collections created before the Postgres migration. Pre-migration collections were retired with the old backend — Postgres collections are unaffected."
      homeTo="/datasets"
      title="Convex collections are archived in this build"
    />
  );
}
