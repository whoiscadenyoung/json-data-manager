import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Database,
  Ellipsis,
  Eye,
  EyeOff,
  FolderOpen,
  GitMerge,
  GripVertical,
  Link2,
  List,
  Plus,
  Rocket,
  Trash2,
  Ungroup,
  X,
} from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";

import * as layersStore from "#/lib/store/layers";
import type { LayerRow } from "#/lib/store/layers";
import * as mapsStore from "#/lib/store/maps";
import type { MapPlacementRow } from "#/lib/store/maps";

import { RELATED_SET_PREFIX, ungroupRelatedLayers } from "./layer-grouping";
import type { LayerSelection, PendingRemoval, RunWrite } from "./types";

/**
 * The map's layer list: one row per layer in draw order, top layer first.
 * Clicking a row selects it (its settings open beside the map); dragging a
 * row changes the draw order; a group opens to show the layers inside it.
 */

export interface OutlineProps {
  childrenLists: globalThis.Map<string, layersStore.LayerChildRow[]>;
  collapsedGroups: ReadonlySet<string>;
  /** The swatch color of the dataset a data layer draws. */
  colorOf: (datasetId: string) => string | undefined;
  layersById: globalThis.Map<string, LayerRow>;
  memberships: globalThis.Map<string, layersStore.ArtifactRefRow>;
  onAddChild: (groupLayerId: string) => void;
  /** Present when two or more layers on the map are related: offers to group them. */
  onGroupRelated: (() => void) | undefined;
  /** Moves a placement to another position in the draw order. */
  onMove: (placementId: string, toIndex: number) => void;
  onPopupFields: (layerId: string) => void;
  onRemove: (pending: PendingRemoval) => void;
  onSelect: (selection: LayerSelection) => void;
  placements: MapPlacementRow[];
  projectId: string;
  run: RunWrite;
  selectedRowId: string | undefined;
  toggleCollapsed: (key: string) => void;
  versionsById: globalThis.Map<string, layersStore.LayerVersionRow>;
}

const ROW_CLASS =
  "group/row flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted/60 data-[selected=true]:bg-primary/10 data-[drop=true]:shadow-[inset_0_2px_0_0_var(--color-primary)]";

/** What one placement is, resolved from its membership. */
interface PlacementFacts {
  datasetId: string | undefined;
  isGroup: boolean;
  layer: LayerRow | undefined;
  linked: boolean;
  name: string;
  version: layersStore.LayerVersionRow | undefined;
}

/** The dataset an owned data layer draws, if it is still in the project. */
function datasetIdOf(props: OutlineProps, layer: LayerRow | undefined): string | undefined {
  if (layer === undefined || layer.datasetMemberId === null) {
    return undefined;
  }
  const member = props.memberships.get(layer.datasetMemberId);
  return member !== undefined && member.artifactKind === "dataset" ? member.artifactId : undefined;
}

function nameOf(
  linked: boolean,
  layer: LayerRow | undefined,
  version: layersStore.LayerVersionRow | undefined,
): string {
  if (linked) {
    return `Linked layer${version === undefined ? "" : ` · ${version.versionLabel}`}`;
  }
  return layer === undefined ? "Layer" : layer.name;
}

function factsOf(props: OutlineProps, placement: MapPlacementRow): PlacementFacts {
  const membership = props.memberships.get(placement.layerMemberId);
  if (membership === undefined) {
    return {
      datasetId: undefined,
      isGroup: false,
      layer: undefined,
      linked: false,
      name: "Layer",
      version: undefined,
    };
  }
  const linked = membership.role === "linked",
    layer = linked ? undefined : props.layersById.get(membership.artifactId),
    version = linked ? props.versionsById.get(membership.artifactId) : undefined;
  return {
    datasetId: datasetIdOf(props, layer),
    isGroup: layer !== undefined && layer.kind === "group",
    layer,
    linked,
    name: nameOf(linked, layer, version),
    version,
  };
}

/** The mark that tells the row kinds apart: a group, a linked layer, or the color a data layer draws in. */
function KindMark({ color, facts }: { color: string | undefined; facts: PlacementFacts }) {
  if (facts.linked) {
    return <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  if (facts.isGroup) {
    return <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    <span
      aria-hidden
      className="mx-0.5 inline-block size-2.5 shrink-0 rounded-full border border-border"
      style={{ backgroundColor: color ?? "transparent" }}
    />
  );
}

function EyeButton({
  disabled,
  label,
  onToggle,
  visible,
}: {
  disabled: boolean;
  label: string;
  onToggle: () => void;
  visible: boolean;
}) {
  return (
    <Button
      aria-label={visible ? `Hide "${label}"` : `Show "${label}"`}
      className="size-6"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      size="icon"
      title={visible ? "Hide on the map" : "Show on the map"}
      variant="ghost"
    >
      {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
    </Button>
  );
}

function RowMenu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Actions for "${label}"`}
            className="size-6"
            onClick={(event) => {
              event.stopPropagation();
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <Ellipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu items about the dataset a data layer draws. */
function DatasetItems({ facts, props }: { facts: PlacementFacts; props: OutlineProps }) {
  const { datasetId, layer } = facts;
  return (
    <>
      {layer !== undefined && layer.kind === "data" && datasetId !== undefined && (
        <DropdownMenuItem
          onClick={() => {
            props.onPopupFields(layer.id);
          }}
        >
          <List />
          Popup fields…
        </DropdownMenuItem>
      )}
      {datasetId !== undefined && (
        <DropdownMenuItem
          render={
            <Link
              params={{ projectId: props.projectId, datasetId: datasetId }}
              to="/projects/$projectId/datasets/$datasetId"
            />
          }
        >
          <Database />
          Open dataset
        </DropdownMenuItem>
      )}
    </>
  );
}

/** The menu items that change what a layer is (publish, clone, popup fields, open its dataset, ungroup). */
function LayerItems({
  act,
  facts,
  placement,
  props,
}: {
  act: (job: () => Promise<unknown>, success: string) => void;
  facts: PlacementFacts;
  placement: MapPlacementRow;
  props: OutlineProps;
}) {
  const { layer, linked, version } = facts;
  return (
    <>
      {layer !== undefined && (
        <DropdownMenuItem
          onClick={() => {
            act(async () => {
              if ((await layersStore.publishLayer({ layerId: layer.id })) === null) {
                throw new Error("The layer wasn't published. You may not have access.");
              }
            }, "Layer published. Other projects can now link or copy it.");
          }}
        >
          <Rocket />
          {facts.isGroup ? "Publish group and its layers" : "Publish layer"}
        </DropdownMenuItem>
      )}
      {linked && version !== undefined && (
        <DropdownMenuItem
          onClick={() => {
            act(async () => {
              const cloned = await layersStore.cloneLayer({
                projectId: props.projectId,
                sourceVersionId: version.id,
              });
              if (cloned === null) {
                throw new Error("The copy wasn't made. You may not have access.");
              }
            }, "Copied into this project as a layer you can edit.");
          }}
        >
          <Copy />
          Make an editable copy
        </DropdownMenuItem>
      )}
      <DatasetItems facts={facts} props={props} />
      {layer !== undefined && facts.isGroup && layer.name.startsWith(RELATED_SET_PREFIX) && (
        <DropdownMenuItem
          onClick={() => {
            props.onRemove({
              confirmLabel: "Ungroup",
              description:
                "The layers inside go back on the map as separate layers, and the group is deleted.",
              run: async () => {
                await ungroupRelatedLayers({
                  groupId: layer.id,
                  mapId: placement.mapId,
                  placementId: placement.id,
                });
              },
              title: `Ungroup "${facts.name}"?`,
            });
          }}
        >
          <Ungroup />
          Ungroup
        </DropdownMenuItem>
      )}
    </>
  );
}

/** The two ways a layer leaves: off this map (it stays in the project), or deleted from the project. */
function RemoveItems({
  facts,
  placement,
  props,
}: {
  facts: PlacementFacts;
  placement: MapPlacementRow;
  props: OutlineProps;
}) {
  const { layer, linked, name } = facts;
  return (
    <>
      <DropdownMenuItem
        onClick={() => {
          props.onRemove(
            linked
              ? {
                  confirmLabel: "Unlink",
                  description:
                    "The link is removed from this project and from every map in it. The published layer itself is untouched.",
                  run: async () => {
                    await layersStore.unlinkLayer({ membershipId: placement.layerMemberId });
                  },
                  title: `Unlink "${name}"?`,
                }
              : {
                  confirmLabel: "Remove from map",
                  description:
                    "The layer leaves this map. It stays in the project, so you can add it again.",
                  run: async () => {
                    await mapsStore.removePlacement({ placementId: placement.id });
                  },
                  title: `Remove "${name}" from this map?`,
                },
          );
        }}
      >
        <X />
        {linked ? "Unlink from project" : "Remove from map"}
      </DropdownMenuItem>
      {layer !== undefined && (
        <DropdownMenuItem
          onClick={() => {
            props.onRemove({
              confirmLabel: "Delete layer",
              description: facts.isGroup
                ? "The group is deleted from the project and from every map that shows it. The layers inside it stay in the project."
                : "The layer and its style are deleted from the project and from every map that shows it. Its dataset stays.",
              run: async () => {
                await layersStore.remove({ layerId: layer.id });
              },
              title: `Delete "${name}"?`,
            });
          }}
          variant="destructive"
        >
          <Trash2 />
          Delete layer…
        </DropdownMenuItem>
      )}
    </>
  );
}

/** What one layer inside a group is, and the selection its row stands for. */
function childFactsOf(
  props: OutlineProps,
  child: layersStore.LayerChildRow,
): { childLayer: LayerRow | undefined; label: string; selection: LayerSelection } {
  const linked = child.childKind === "linked",
    childLayer = linked ? undefined : props.layersById.get(child.childLayerId),
    version = linked ? props.versionsById.get(child.childLayerId) : undefined,
    label = childLayer === undefined ? (linked ? "Linked layer" : "Layer") : childLayer.name,
    kind = childLayer === undefined ? "linked" : childLayer.kind === "group" ? "group" : "data";
  return {
    childLayer,
    label,
    selection: {
      kind,
      layerId: childLayer === undefined ? undefined : childLayer.id,
      name: label,
      rowId: child.id,
      versionId: version === undefined ? undefined : version.id,
    },
  };
}

/** The layers inside an open group. Each can be selected, hidden, moved up or taken out. */
function GroupChildren({
  act,
  busy,
  groupLayerId,
  props,
}: {
  act: (job: () => Promise<unknown>, success: string) => void;
  busy: boolean;
  groupLayerId: string;
  props: OutlineProps;
}) {
  const children = props.childrenLists.get(groupLayerId) ?? [];
  return (
    <ul className="ml-3 flex flex-col border-l pl-1.5">
      {children.map((child, index) => {
        const { childLayer, label, selection } = childFactsOf(props, child);
        return (
          <li key={child.id}>
            {/* The row is a click target for selection; its buttons carry the keyboard path. */}
            {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div
              className={`${ROW_CLASS} ${childLayer !== undefined && !childLayer.visible ? "text-muted-foreground" : ""}`}
              data-selected={props.selectedRowId === child.id}
              onClick={() => {
                props.onSelect(selection);
              }}
            >
              {child.childKind === "linked" ? (
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <span
                  aria-hidden
                  className="mx-0.5 inline-block size-2.5 shrink-0 rounded-full border border-border bg-muted"
                />
              )}
              <button className="min-w-0 flex-1 truncate text-left" title={label} type="button">
                {label}
              </button>
              {childLayer !== undefined && (
                <EyeButton
                  disabled={busy}
                  label={label}
                  onToggle={() => {
                    act(async () => {
                      await layersStore.update({
                        layerId: childLayer.id,
                        visible: !childLayer.visible,
                      });
                    }, "");
                  }}
                  visible={childLayer.visible}
                />
              )}
              <RowMenu label={label}>
                <DropdownMenuItem
                  disabled={index === 0 || busy}
                  onClick={() => {
                    act(async () => {
                      await layersStore.moveChild({ childId: child.id, direction: "up" });
                    }, "");
                  }}
                >
                  <ChevronUp />
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === children.length - 1 || busy}
                  onClick={() => {
                    act(async () => {
                      await layersStore.moveChild({ childId: child.id, direction: "down" });
                    }, "");
                  }}
                >
                  <ChevronDown />
                  Move down
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    act(async () => {
                      await layersStore.removeChild({ childId: child.id });
                    }, "Taken out of the group.");
                  }}
                >
                  <X />
                  Take out of group
                </DropdownMenuItem>
              </RowMenu>
            </div>
          </li>
        );
      })}
      {children.length === 0 && (
        <li className="px-2 py-1 text-xs text-muted-foreground">This group is empty.</li>
      )}
      <li>
        <Button
          className="h-7 justify-start px-1.5 text-xs text-muted-foreground"
          onClick={() => {
            props.onAddChild(groupLayerId);
          }}
          size="sm"
          variant="ghost"
        >
          <Plus />
          Add layer to group
        </Button>
      </li>
    </ul>
  );
}

/** What a drag is carrying, and where it is hovering. */
interface DragState {
  fromIndex: number;
  overIndex: number | undefined;
}

/** One row's writes: whether one is running, and a runner that reports the outcome. */
function useRowAct(
  run: RunWrite,
): [boolean, (job: () => Promise<unknown>, success: string) => void] {
  const [busy, setBusy] = useState(false);
  return [
    busy,
    (job, success) => {
      setBusy(true);
      void run(job, "That didn't go through. You may not have access.").then((landed) => {
        if (landed && success !== "") {
          toast.success(success);
        }
        setBusy(false);
        return undefined;
      });
    },
  ];
}

/** The selection a placement row stands for. */
function selectionOf(facts: PlacementFacts, rowId: string): LayerSelection {
  return {
    kind: facts.linked ? "linked" : facts.isGroup ? "group" : "data",
    layerId: facts.layer === undefined ? undefined : facts.layer.id,
    name: facts.name,
    rowId,
    versionId: facts.version === undefined ? undefined : facts.version.id,
  };
}

/** Dragging a row onto another moves it to that position in the draw order. */
function dragHandlers({
  drag,
  index,
  placement,
  props,
  setDrag,
}: {
  drag: DragState | undefined;
  index: number;
  placement: MapPlacementRow;
  props: OutlineProps;
  setDrag: (next: DragState | undefined) => void;
}) {
  return {
    "data-drop": drag !== undefined && drag.overIndex === index && drag.fromIndex !== index,
    onDragEnd: () => {
      setDrag(undefined);
    },
    onDragOver: (event: DragEvent) => {
      if (drag === undefined) {
        return;
      }
      event.preventDefault();
      if (drag.overIndex !== index) {
        setDrag({ fromIndex: drag.fromIndex, overIndex: index });
      }
    },
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", placement.id);
      setDrag({ fromIndex: index, overIndex: undefined });
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const moved = drag === undefined ? undefined : props.placements[drag.fromIndex];
      if (moved !== undefined && moved.id !== placement.id) {
        props.onMove(moved.id, index);
      }
      setDrag(undefined);
    },
  };
}

/** The small marks after a layer's name: it needs attention, it is published. */
function RowBadges({ layer }: { layer: LayerRow | undefined }) {
  if (layer === undefined) {
    return null;
  }
  return (
    <>
      {layer.needsAttention !== null && (
        <span title={`Needs attention: ${layer.needsAttention}`}>
          <AlertTriangle
            aria-label="Needs attention"
            className="size-3.5 shrink-0 text-amber-600"
          />
        </span>
      )}
      {layer.lifecycle === "published" && (
        <span title="Published: other projects can link or copy this layer.">
          <Rocket aria-label="Published" className="size-3 shrink-0 text-muted-foreground" />
        </span>
      )}
    </>
  );
}

function GroupToggle({
  expanded,
  name,
  onToggle,
}: {
  expanded: boolean;
  name: string;
  onToggle: () => void;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse "${name}"` : `Expand "${name}"`}
      className="flex size-4 shrink-0 items-center justify-center"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      type="button"
    >
      {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
    </button>
  );
}

/** One placement row, and its children when it is an open group. */
function PlacementRow({
  drag,
  index,
  placement,
  props,
  setDrag,
}: {
  drag: DragState | undefined;
  index: number;
  placement: MapPlacementRow;
  props: OutlineProps;
  setDrag: (next: DragState | undefined) => void;
}) {
  const facts = factsOf(props, placement),
    { layer, name } = facts,
    expanded = facts.isGroup && !props.collapsedGroups.has(placement.id),
    [busy, act] = useRowAct(props.run),
    last = props.placements.length - 1;
  return (
    <li>
      {/* The row is a click target for selection and a drag handle; its buttons carry the keyboard path. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className={`${ROW_CLASS} ${placement.visible ? "" : "text-muted-foreground"}`}
        data-selected={props.selectedRowId === placement.id}
        draggable
        onClick={() => {
          props.onSelect(selectionOf(facts, placement.id));
        }}
        {...dragHandlers({ drag, index, placement, props, setDrag })}
      >
        <GripVertical
          aria-hidden
          className="size-3 shrink-0 cursor-grab text-muted-foreground/50 opacity-0 group-hover/row:opacity-100"
        />
        {facts.isGroup ? (
          <GroupToggle
            expanded={expanded}
            name={name}
            onToggle={() => {
              props.toggleCollapsed(placement.id);
            }}
          />
        ) : null}
        <KindMark
          color={facts.datasetId === undefined ? undefined : props.colorOf(facts.datasetId)}
          facts={facts}
        />
        <button className="min-w-0 flex-1 truncate text-left" title={name} type="button">
          {name}
        </button>
        <RowBadges layer={layer} />
        <EyeButton
          disabled={busy}
          label={name}
          onToggle={() => {
            act(async () => {
              await mapsStore.setPlacementVisibility({
                placementId: placement.id,
                visible: !placement.visible,
              });
            }, "");
          }}
          visible={placement.visible}
        />
        <RowMenu label={name}>
          <DropdownMenuItem
            disabled={index === 0 || busy}
            onClick={() => {
              props.onMove(placement.id, index - 1);
            }}
          >
            <ChevronUp />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === last || busy}
            onClick={() => {
              props.onMove(placement.id, index + 1);
            }}
          >
            <ChevronDown />
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <LayerItems act={act} facts={facts} placement={placement} props={props} />
          <DropdownMenuSeparator />
          <RemoveItems facts={facts} placement={placement} props={props} />
        </RowMenu>
      </div>
      {layer !== undefined && expanded && (
        <GroupChildren act={act} busy={busy} groupLayerId={layer.id} props={props} />
      )}
    </li>
  );
}

/** The layer list. */
export function LayerOutline(props: OutlineProps) {
  const [drag, setDrag] = useState<DragState>();
  return (
    <section aria-label="Layers" className="flex flex-col gap-1">
      <h2
        className="px-1.5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        title="Draw order: the top layer draws over the ones below it. Drag a layer to reorder."
      >
        Layers ({props.placements.length})
      </h2>
      <ul className="flex flex-col">
        {props.placements.map((placement, index) => (
          <PlacementRow
            drag={drag}
            index={index}
            key={placement.id}
            placement={placement}
            props={props}
            setDrag={setDrag}
          />
        ))}
      </ul>
      {props.onGroupRelated !== undefined && (
        <Button
          className="mt-1 justify-start"
          onClick={props.onGroupRelated}
          size="sm"
          title="Puts the layers whose datasets are related into one group."
          variant="outline"
        >
          <GitMerge />
          Group related layers
        </Button>
      )}
    </section>
  );
}
