import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { Link2, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as layersStore from "#/lib/store/layers";
import type { LayerRow } from "#/lib/store/layers";
import * as mapsStore from "#/lib/store/maps";

/** The add-child sheet for one group: owned project layers (the cycle guard refuses an ancestor at write time) + published versions to link. */
export function AddChildSheet(props: {
  groupLayerId: string;
  invalidate: () => void;
  layers: LayerRow[];
  onClose: () => void;
  open: boolean;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
  versions: layersStore.LinkableVersionRow[];
}) {
  const [pendingId, setPendingId] = useState<string>(),
    ownedCandidates = props.layers.filter((layer) => layer.id !== props.groupLayerId),
    addOwned = async (childLayerId: string): Promise<void> => {
      setPendingId(childLayerId);
      if (
        await props.run(async () => {
          const child = await layersStore.addChild({
            childKind: "owned",
            childLayerId,
            groupId: props.groupLayerId,
          });
          if (child === null) {
            throw new Error("The child was denied.");
          }
        }, "Failed to add the layer — the cycle guard may have refused it.")
      ) {
        toast.success("Added to the group.");
        props.invalidate();
        props.onClose();
      }
      setPendingId(undefined);
    },
    addLinked = async (childLayerId: string): Promise<void> => {
      setPendingId(childLayerId);
      if (
        await props.run(async () => {
          const child = await layersStore.addChild({
            childKind: "linked",
            childLayerId,
            groupId: props.groupLayerId,
          });
          if (child === null) {
            throw new Error("The child was denied.");
          }
        }, "Failed to link the layer into the group.")
      ) {
        toast.success("Linked into the group (read-only at the frozen version).");
        props.invalidate();
        props.onClose();
      }
      setPendingId(undefined);
    };
  return (
    <Sheet onOpenChange={props.onClose} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to group</SheetTitle>
          <SheetDescription>
            Owned layers nest inside the group (the guard refuses cycles); published versions link
            read-only.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-6">
          <p className="text-sm font-semibold">Project layers</p>
          {ownedCandidates.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              No other layers in the project yet.
            </p>
          ) : (
            ownedCandidates.map((layer) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={layer.id}
                onClick={() => {
                  void addOwned(layer.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{layer.name}</span>
                {pendingId === layer.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
          <p className="mt-3 text-sm font-semibold">Published versions (link)</p>
          {props.versions.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              Nothing published yet.
            </p>
          ) : (
            props.versions.map((version) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={version.id}
                onClick={() => {
                  void addLinked(version.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {version.layer.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {version.versionLabel}
                    {version.layer.project === null ? "" : ` · ${version.layer.project.title}`}
                  </span>
                </span>
                {pendingId === version.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The map form (name + description) as a sheet — the old MapFormPanel's fields, the project route's back link. */
export function MapFormDialog(props: {
  map: mapsStore.MapRow;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSubmit: (args: { description?: string; name: string }) => Promise<void>;
}) {
  const [name, setName] = useState(props.map.name),
    [description, setDescription] = useState(props.map.description ?? "");
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Edit map</SheetTitle>
          <SheetDescription>Name is the only required field.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 p-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="map-name">Name</Label>
            <Input
              id="map-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
              value={name}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="map-description">Description</Label>
            <Input
              id="map-description"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              value={description}
            />
          </div>
          <Button
            disabled={name.trim() === ""}
            onClick={() => {
              void props
                .onSubmit({
                  description: description.trim() === "" ? undefined : description,
                  name,
                })
                .then(() => {
                  props.onOpenChange(false);
                  toast.success("Map updated.");
                  return undefined;
                })
                .catch((error: unknown) => {
                  toast.error(errorMessage(error, "Failed to update the map."));
                });
            }}
          >
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The add-dataset sheet: the project's drawable memberships not yet placed — picking one mints the owned default-style layer (the auto-layer) and places it. */
export function AddDatasetSheet(props: {
  /** Geospatial dataset ids, or undefined while the summaries load (no filtering then — never flash an empty sheet). */
  geospatialDatasetIds: ReadonlySet<string> | undefined;
  invalidate: () => void;
  mapId: string;
  memberships: layersStore.DatasetMembershipRow[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  placedMembershipIds: ReadonlySet<string>;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
  titlesById: globalThis.Map<string, string>;
}) {
  const [pendingId, setPendingId] = useState<string>(),
    candidates = props.memberships.filter(
      (membership) =>
        // A plain table can never draw — offering it mints a dead layer
        // (#278).
        !props.placedMembershipIds.has(membership.id) &&
        (props.geospatialDatasetIds === undefined ||
          props.geospatialDatasetIds.has(membership.artifactId)),
    ),
    add = async (membershipId: string): Promise<void> => {
      setPendingId(membershipId);
      if (
        await props.run(async () => {
          const layerId = await layersStore.createForDataset({
            datasetMemberId: membershipId,
            projectId: props.projectId,
          });
          if (layerId === null) {
            throw new Error("The layer didn't mint — you may not have access.");
          }
          const membershipRow = await layersStore.membershipIdForLayer({ layerId });
          if (membershipRow === null) {
            throw new Error("The layer's membership didn't mint.");
          }
          const placement = await mapsStore.addPlacement({
            layerMemberId: membershipRow,
            mapId: props.mapId,
          });
          if (placement === null) {
            throw new Error("The placement was denied.");
          }
        }, "Failed to add the dataset.")
      ) {
        toast.success("Added — an owned layer was created and placed.");
        props.invalidate();
        props.onOpenChange(false);
      }
      setPendingId(undefined);
    };
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add dataset to map</SheetTitle>
          <SheetDescription>
            An owned layer with a default style is created for the dataset — restyle it from its
            row's menu.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-6">
          {candidates.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              {props.geospatialDatasetIds === undefined
                ? "Every project dataset is already placed — add more from the project's catalog."
                : "Nothing drawable to add — everything geospatial is placed, and plain tables need geometry before they can map."}
            </p>
          ) : (
            candidates.map((membership) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={membership.id}
                onClick={() => {
                  void add(membership.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {props.titlesById.get(membership.artifactId) ?? membership.artifactId}
                </span>
                {pendingId === membership.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The link-layer sheet: recent published layer versions across the viewer's visible projects; linking pins one read-only. */
export function LinkLayerSheet(props: {
  invalidate: () => void;
  linkedVersionIds: ReadonlySet<string>;
  mapId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
  versions: layersStore.LinkableVersionRow[];
}) {
  const [pendingId, setPendingId] = useState<string>(),
    candidates = props.versions.filter((version) => !props.linkedVersionIds.has(version.id)),
    link = async (versionId: string): Promise<void> => {
      setPendingId(versionId);
      if (
        await props.run(async () => {
          const membership = await layersStore.linkLayer({
            projectId: props.projectId,
            sourceVersionId: versionId,
          });
          if (membership === null) {
            throw new Error("The link was denied.");
          }
          const placement = await mapsStore.addPlacement({
            layerMemberId: membership.id,
            mapId: props.mapId,
          });
          if (placement === null) {
            throw new Error("The placement was denied.");
          }
        }, "Failed to link the layer.")
      ) {
        toast.success("Linked — a read-only pin at the published version.");
        props.invalidate();
        props.onOpenChange(false);
      }
      setPendingId(undefined);
    };
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Link a published layer</SheetTitle>
          <SheetDescription>
            A linked layer is read-only at its frozen version — clone it into an owned copy to
            restyle.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-6">
          {candidates.length === 0 ? (
            <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
              No published layers visible yet — publish one from a map first.
            </p>
          ) : (
            candidates.map((version) => (
              <button
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                disabled={pendingId !== undefined}
                key={version.id}
                onClick={() => {
                  void link(version.id);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {version.layer.name}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {version.versionLabel}
                    {version.layer.project === null ? "" : ` · ${version.layer.project.title}`}
                  </span>
                </span>
                {pendingId === version.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The new-group dialog: a name is the only required field; the group lands placed on this map. */
export function NewGroupDialog(props: {
  invalidate: () => void;
  mapId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  run: (job: () => Promise<unknown>, fallback: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(""),
    create = async (): Promise<void> => {
      if (
        await props.run(async () => {
          const layerId = await layersStore.create({
            kind: "group",
            name: name.trim() === "" ? "New group" : name.trim(),
            projectId: props.projectId,
          });
          if (layerId === null) {
            throw new Error("The group didn't mint — you may not have access.");
          }
          const membershipRow = await layersStore.membershipIdForLayer({ layerId });
          if (membershipRow === null) {
            throw new Error("The group's membership didn't mint.");
          }
          const placement = await mapsStore.addPlacement({
            layerMemberId: membershipRow,
            mapId: props.mapId,
          });
          if (placement === null) {
            throw new Error("The placement was denied.");
          }
        }, "Failed to create the group.")
      ) {
        toast.success("Group added to the map.");
        props.invalidate();
        props.onOpenChange(false);
      }
    };
  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>New group layer</SheetTitle>
          <SheetDescription>
            Groups are layers — they hold other layers and groups (cycles are refused), and they
            publish/link/clone exactly like data layers.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 p-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
              value={name}
            />
          </div>
          <Button
            onClick={() => {
              void create();
            }}
          >
            Create and place
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
