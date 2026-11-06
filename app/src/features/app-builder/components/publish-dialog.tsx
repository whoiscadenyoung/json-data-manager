import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as mapsStore from "#/lib/store/maps";
import { headOfChainQueryOptions } from "#/lib/store/versions";

import { datasetTitle, useAppDatasets } from "../data";
import type { AppDoc } from "../lib/app-doc";
import { publishApp } from "../lib/pg-app-publish";

/**
 * The app publish dialog (issue #259; D6/D7): freezing the app's config
 * snapshot — its pages, every referenced map (with each placement's layer
 * version at publish time), and every referenced dataset's head version
 * pin. The dialog names what will freeze and flags datasets with no
 * published version yet (their widgets will render unavailable in the
 * published app until they publish and the app republishes).
 */

/** One referenced dataset's pin status, as the dialog lists it. */
function DatasetPinRow({ datasetId }: { datasetId: string }) {
  const head = useQuery(headOfChainQueryOptions({ datasetId })),
    title = datasetTitle(useAppDatasets().get(datasetId) ?? { status: "unavailable" });
  return (
    <li className="flex items-center justify-between gap-2 py-0.5">
      <span className="truncate">{title}</span>
      {head.isPending ? (
        <Badge variant="outline">checking…</Badge>
      ) : head.data !== null && head.data !== undefined ? (
        <Badge variant="secondary" title="The app freezes this dataset's head version at publish.">
          {head.data.versionLabel}
        </Badge>
      ) : (
        <Badge
          variant="outline"
          title="No published version yet — its widgets render unavailable until the dataset publishes and the app republishes."
        >
          no version yet
        </Badge>
      )}
    </li>
  );
}

export function PublishDialog({
  app,
  open,
  onOpenChange,
  onPublished,
}: {
  app: AppDoc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPublished?: () => void | Promise<void>;
}) {
  const queryClient = useQueryClient(),
    [publishing, setPublishing] = useState(false),
    mapIds = [
      ...new Set(
        app.pages
          .flatMap((page) => page.widgets)
          .filter((widget) => widget.kind === "map")
          .map((widget) => widget.mapId)
          .filter((mapId) => mapId !== ""),
      ),
    ],
    mapsQuery = useQuery({
      ...mapsStore.listForProjectQueryOptions({ projectId: app.projectId }),
      enabled: open,
    }),
    mapNamesById = new globalThis.Map((mapsQuery.data ?? []).map((map) => [map.id, map.name]));

  const publish = async (): Promise<void> => {
    setPublishing(true);
    try {
      const result = await publishApp({ appId: app.id });
      if (result === null) {
        toast.error("The app didn't publish — it may have been deleted.");
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["pg:appVersions"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
      toast.success(
        `Published ${result.version.versionLabel}${
          result.unpinnedDatasetTitles.length === 0
            ? ""
            : ` — ${result.unpinnedDatasetTitles.length} dataset${
                result.unpinnedDatasetTitles.length === 1 ? " has" : "s have"
              } no published version yet`
        }.`,
      );
      onOpenChange(false);
      if (onPublished !== undefined) {
        await onPublished();
      }
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't publish the app."));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!publishing) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this app</DialogTitle>
          <DialogDescription>
            Publishing freezes a snapshot: the app&apos;s pages, each referenced map with its layers
            as published, and each dataset&apos;s head version. Editing the live app or its maps
            afterwards won&apos;t change the published app until you publish again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          {mapIds.length > 0 && (
            <div>
              <p className="mb-1 font-medium">Maps</p>
              <ul className="flex flex-col">
                {mapIds.map((mapId) => (
                  <li className="flex items-center justify-between gap-2 py-0.5" key={mapId}>
                    <span className="truncate">{mapNamesById.get(mapId) ?? mapId}</span>
                    <Badge variant="secondary">
                      <Rocket className="h-3 w-3" />
                      frozen at publish
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {app.datasetIds.length > 0 && (
            <div>
              <p className="mb-1 font-medium">Datasets (pinned versions)</p>
              <ul className="flex flex-col">
                {app.datasetIds.map((datasetId) => (
                  <DatasetPinRow datasetId={datasetId} key={datasetId} />
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={publishing}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="button" disabled={publishing} onClick={() => void publish()}>
            <Rocket data-icon="inline-start" />
            {publishing ? "Publishing…" : "Publish app"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
