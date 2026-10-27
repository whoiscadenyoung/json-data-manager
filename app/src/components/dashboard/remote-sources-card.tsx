import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { RemoteSourceControls } from "#/components/remote-source-controls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { api } from "#convex/_generated/api";

/**
 * Remote bound sources (#78): layers another app serves over HTTP. Each row
 * shows the synced vs. latest revision and the Check/Sync controls; the
 * first Sync creates the dataset from the remote manifest.
 */
export function RemoteSourcesCard() {
  const sources = useQuery(api.remoteSources.list);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Remote sources</CardTitle>
        <CardDescription>
          Layers read over HTTP from other apps. The data stays in its own app — sync mirrors the
          current state here, read-only. Sources are checked every 15 minutes; syncing is manual.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {sources === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
        {sources !== undefined &&
          sources.map((source) => (
            <div key={source.source} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {source.schemaId === undefined ? (
                    source.title
                  ) : (
                    <Link
                      to="/datasets/$schemaId"
                      params={{ schemaId: source.schemaId }}
                      className="hover:underline"
                    >
                      {source.title}
                    </Link>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {source.source} · {source.syncedEntryCount ?? 0} synced features
                  {source.latest !== undefined &&
                    ` · ${source.latest.featureCount ?? "?"} at source · ${source.latest.geometryType}`}
                </p>
              </div>
              <RemoteSourceControls source={source.source} />
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
