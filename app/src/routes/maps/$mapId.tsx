import { Card, CardContent, CardDescription, CardTitle } from "@caden/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";

import { ArchivedConvexSurface } from "#/components/archived-convex-surface";
import { isPostgresDatasetId } from "#/lib/dataset-source";
import * as mapsStore from "#/lib/store/maps";

export const Route = createFileRoute("/maps/$mapId")({
  component: MapRoutePage,
});

/**
 * The /maps/$mapId deep link (issue #257; D2): maps live in projects now,
 * so this route RESOLVES the map's project and forwards into the
 * in-project editor — which is exactly how the backfilled standalone maps
 * open (the 0020 backfill folded each creator's maps into their own
 * project). A non-member reads the not-found card (the
 * invisible-reads-as-not-found rule), and a pre-migration Convex id
 * renders the shared archived state.
 */
function MapRoutePage() {
  const { mapId } = Route.useParams();
  if (!isPostgresDatasetId(mapId)) {
    return (
      <ArchivedConvexSurface
        description="This workspace served maps created before the Postgres migration. Pre-migration maps were retired with the old backend."
        homeTo="/maps"
        title="Convex maps are archived in this build"
      />
    );
  }
  return <MapRedirect mapId={mapId} />;
}

function MapRedirect({ mapId }: { mapId: string }) {
  const query = useQuery(mapsStore.getQueryOptions({ mapId })),
    map = query.data;
  if (query.isPending) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (map === null || map === undefined) {
    return (
      <Card className="mx-auto mt-8 max-w-md py-12 text-center">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Map not found</CardTitle>
          <CardDescription className="mb-4">
            The map doesn't exist — or you're not a member of its project.
          </CardDescription>
          <Link className="text-primary underline-offset-2 hover:underline" to="/maps">
            Back to Maps
          </Link>
        </CardContent>
      </Card>
    );
  }
  throw redirect({
    params: { mapId: map.id, projectId: map.projectId },
    to: "/projects/$projectId/maps/$mapId",
  });
}
