import { Button } from "@caden/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@caden/ui/components/field";
import { Input } from "@caden/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@caden/ui/components/radio-group";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, Map as MapIcon, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StoredMapCanvas } from "#/features/maps";
import { errorMessage } from "#/lib/errors";
import * as mapsStore from "#/lib/store/maps";

import { useAppFrozen } from "../data";
import { APP_LIMITS } from "../lib/content";
import { FrozenMapCanvas } from "./frozen-map-canvas";
import { WidgetMessage, type WidgetSettingsProps, type WidgetViewProps } from "./shared";

/**
 * The map widget (issue #259; D7) — one STORED project map. Live surfaces
 * (builder, preview, drafts) render the map as it is right now through
 * `StoredMapCanvas`; the published view renders the frozen snapshot through
 * `FrozenMapCanvas` — editing the live map afterwards does not move a
 * published app until republish. The inline `datasetIds` map mode retired
 * with the change: a map built anywhere in the app is a map row.
 */

export function MapWidgetView({ widget }: WidgetViewProps<"map">) {
  const frozen = useAppFrozen();
  if (widget.mapId === "") {
    return <WidgetMessage>Choose a project map for this widget.</WidgetMessage>;
  }
  if (frozen !== null) {
    const snapshot = frozen.mapSnapshots.find((candidate) => candidate.mapId === widget.mapId);
    if (snapshot === undefined) {
      return <WidgetMessage>This map isn&apos;t part of the published app.</WidgetMessage>;
    }
    return (
      <FrozenMapCanvas
        datasetPins={frozen.datasetPins}
        key={`${widget.mapId}:${snapshot.placements.map((placement) => placement.versionId).join(",")}`}
        layerVersions={frozen.layerVersions}
        snapshot={snapshot}
      />
    );
  }
  // Keyed by the map id so the builder re-fits when the widget's map changes.
  return <StoredMapCanvas key={widget.mapId} mapId={widget.mapId} />;
}

/** The map picker: the project's maps as a radio list, plus the create-from-builder flow (create → link → open the map editor). */
// The picker's ladder (loading/empty/list + the create flow) is its contract.
// oxlint-disable-next-line eslint/complexity -- the ladder is the contract.
export function MapWidgetSettings({ widget, projectId, onChange }: WidgetSettingsProps<"map">) {
  const navigate = useNavigate(),
    mapsQuery = useQuery({
      ...mapsStore.listForProjectQueryOptions({ projectId: projectId ?? "" }),
      enabled: projectId !== undefined,
    }),
    [creating, setCreating] = useState(false),
    [name, setName] = useState("");

  if (projectId === undefined) {
    return (
      <FieldDescription>
        Open the builder to choose the project map this widget shows.
      </FieldDescription>
    );
  }

  const maps = mapsQuery.data ?? [];

  const createMap = async (): Promise<void> => {
    setCreating(true);
    try {
      // The map row persists FIRST (it appears in the project's Maps view
      // immediately), the widget links it, and the builder opens the map
      // editor to compose it — the builder's autosave flushes on unmount.
      const mapId = await mapsStore.create({
        name: name.trim() === "" ? "New map" : name.trim(),
        projectId,
      });
      if (mapId === null) {
        toast.error("The map didn't create — you may not have access.");
        return;
      }
      onChange({ ...widget, mapId });
      toast.success("Map created — opening the editor.");
      await navigate({ params: { mapId, projectId }, to: "/projects/$projectId/maps/$mapId" });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to create the map."));
    } finally {
      setCreating(false);
    }
  };

  return (
    <FieldSet>
      <FieldLegend variant="label">Map</FieldLegend>
      <FieldGroup className="gap-2">
        {mapsQuery.isPending ? (
          <FieldDescription>Loading this project&apos;s maps…</FieldDescription>
        ) : maps.length === 0 ? (
          <FieldDescription>
            This project has no maps yet — create one below; it opens in the map editor and links
            here.
          </FieldDescription>
        ) : (
          <RadioGroup
            value={widget.mapId}
            onValueChange={(mapId) => {
              onChange({ ...widget, mapId });
            }}
          >
            {maps.map((map) => (
              <Field orientation="horizontal" key={map.id}>
                <RadioGroupItem id={`map-widget-${widget.id}-${map.id}`} value={map.id} />
                <FieldLabel
                  htmlFor={`map-widget-${widget.id}-${map.id}`}
                  className="min-w-0 flex-1 truncate font-normal"
                >
                  <MapIcon className="mr-1 inline h-3 w-3 shrink-0" />
                  {map.name}
                </FieldLabel>
                <a
                  aria-label={`Open ${map.name} in the map editor`}
                  className="text-muted-foreground hover:text-foreground"
                  href={`/projects/${projectId}/maps/${map.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    void navigate({
                      params: { mapId: map.id, projectId },
                      to: "/projects/$projectId/maps/$mapId",
                    });
                  }}
                  title="Open in the map editor"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Field>
            ))}
          </RadioGroup>
        )}
        {widget.mapId !== "" && maps.length > 0 && !maps.some((map) => map.id === widget.mapId) && (
          <FieldDescription>
            The linked map isn&apos;t in this list (it may live in another project) — it still
            renders.
          </FieldDescription>
        )}
        {mapsQuery.isError && (
          <FieldDescription>Couldn&apos;t load this project&apos;s maps.</FieldDescription>
        )}
        <div className="flex items-end gap-2">
          <Field className="flex-1">
            <FieldLabel htmlFor={`new-map-${widget.id}`} className="sr-only">
              New map name
            </FieldLabel>
            <Input
              id={`new-map-${widget.id}`}
              maxLength={APP_LIMITS.title}
              placeholder="New map name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={creating}
            onClick={() => {
              void createMap();
            }}
          >
            <Plus data-icon="inline-start" />
            {creating ? "Creating…" : "Create map"}
          </Button>
        </div>
        <FieldDescription>
          A map widget shows one stored project map. Style its layers in the map editor; the
          published app freezes the map as it was at publish.
        </FieldDescription>
      </FieldGroup>
    </FieldSet>
  );
}
