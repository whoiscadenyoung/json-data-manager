import { createFileRoute } from "@tanstack/react-router";

import { LinksPanel } from "#/components/dashboard/links-panel";
import { LocationsPanel } from "#/components/dashboard/locations-panel";
import { RestaurantsPanel } from "#/components/dashboard/restaurants-panel";
import { SnapshotsCard } from "#/components/dashboard/snapshots-card";
import { SyncStatusCard } from "#/components/dashboard/sync-status-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });

/**
 * CRUD surface for the foreign-domain tables (restaurants, locations,
 * restaurantLocations) — the "source of truth" side of the bound-datasets
 * PoC. Editing here never touches the projected json-cms dataset directly;
 * the sync card above the tabs shows when the projection is stale and
 * rebuilds it on demand.
 */
function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold">External data dashboard</h1>
        <p className="text-sm text-muted-foreground">
          CRUD over the app's own tables — the source of truth in the bound-datasets PoC. Edits mark
          the projection stale; sync pushes them into the json-cms dataset that the maps render.
        </p>
      </div>
      <SyncStatusCard />
      <SnapshotsCard />
      <Tabs defaultValue="restaurants">
        <TabsList>
          <TabsTrigger value="restaurants">Restaurants</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="links">Restaurant locations</TabsTrigger>
        </TabsList>
        <TabsContent value="restaurants">
          <RestaurantsPanel />
        </TabsContent>
        <TabsContent value="locations">
          <LocationsPanel />
        </TabsContent>
        <TabsContent value="links">
          <LinksPanel />
        </TabsContent>
      </Tabs>
    </main>
  );
}
