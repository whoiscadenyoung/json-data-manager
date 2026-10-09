import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Folder,
  Link2,
  MapPin,
  Palette,
  TriangleAlert,
  X,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import type { GroupChild, LayerDetail, MapPlacement } from "#/lib/projects/map-layers";
import { orderedChildrenOf, styleOrDefault } from "#/lib/projects/map-layers";

/**
 * The map editor's layer panel (phase 4): one row per PLACEMENT in draw
 * order. An owned placement carries the live layer's stored style dot and
 * selects into the style panel; a linked one badges its pinned version and
 * reads read-only; a missing one keeps its row with the removal path (the
 * defensive-answer convention). A placed group expands to its resolved
 * children (owned and linked alike), each with its own style dot and eye.
 */

const PLACEMENT_ICONS = {
  linked: Link2,
  missing: TriangleAlert,
  owned: MapPin,
} as const;

/** The icon for one placement row: groups show the folder, everything else its kind's mark. */
function PlacementIcon({ placement }: { placement: MapPlacement }) {
  if (placement.kind === "owned" && placement.layer.kind === "group") {
    return <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  const Icon = PLACEMENT_ICONS[placement.kind];
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

/** The style dot — the layer's stored stroke/point color (the map draws it in this). */
function StyleDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-background/60"
      style={{ backgroundColor: color }}
    />
  );
}

function PlacementEyeButton({
  label,
  visible,
  disabled,
  disabledReason,
  onToggle,
}: {
  label: string;
  visible: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={visible ? `Hide ${label}` : `Show ${label}`}
      title={disabled ? disabledReason : undefined}
      disabled={disabled}
      onClick={onToggle}
    >
      {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
    </Button>
  );
}

function MoveButtons({
  index,
  totalCount,
  label,
  disabled,
  disabledReason,
  onMoveUp,
  onMoveDown,
}: {
  index: number;
  totalCount: number;
  label: string;
  disabled: boolean;
  disabledReason?: string;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={`Move ${label} up`}
        title={disabled ? disabledReason : undefined}
        disabled={disabled || index === 0}
        onClick={onMoveUp}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={`Move ${label} down`}
        title={disabled ? disabledReason : undefined}
        disabled={disabled || index === totalCount - 1}
        onClick={onMoveDown}
      >
        <ChevronDown className="size-3.5" />
      </Button>
    </>
  );
}

/** One group child's subtitle: the linked version label or the owned kind/lifecycle line. */
function childMetaLine(child: GroupChild): string {
  if (child.childKind === "linked") {
    return `Linked · ${child.versionLabel}`;
  }
  if (child.kind === "group") {
    return "Group layer";
  }
  return child.lifecycle === "draft" ? "Draft layer" : "Data layer";
}

/** One group child row (inside an expanded owned group placement). */
function GroupChildRow({
  child,
  canWrite,
  disabled,
  disabledReason,
  onToggleChild,
}: {
  child: GroupChild;
  canWrite: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggleChild: (child: GroupChild, currentlyVisible: boolean) => void;
}) {
  const style = styleOrDefault(child.style),
    // A linked child rides the group's eye — it has no local toggle (the pin
    // is read-only; phase 5's layer-sync moves it).
    toggleable = child.childKind === "owned",
    visible = child.childKind === "owned" ? child.visible : true;
  return (
    <li
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${visible ? "" : "opacity-55"}`}
    >
      <StyleDot color={style.color} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{child.name}</p>
        <p className="truncate text-[10px] text-muted-foreground">{childMetaLine(child)}</p>
      </div>
      {child.childKind === "owned" && child.needsAttention !== undefined && (
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
      )}
      <PlacementEyeButton
        label={`"${child.name}"`}
        visible={visible}
        disabled={!toggleable || !canWrite || disabled}
        disabledReason={
          !toggleable
            ? "Linked children render read-only — the group's eye controls them."
            : disabledReason
        }
        onToggle={() => {
          onToggleChild(child, visible);
        }}
      />
    </li>
  );
}

/** The placement's name, per kind (a missing placement lost its layer row). */
function placementName(placement: MapPlacement): string {
  return placement.kind === "missing" ? "Deleted layer" : placement.layer.name;
}

/** The badge row: draft, linked-pin, and drift states. */
function PlacementBadges({ placement }: { placement: MapPlacement }) {
  if (placement.kind === "missing") {
    return null;
  }
  if (placement.kind === "linked") {
    return (
      <Badge variant="secondary" title={`Pinned at ${placement.layer.versionLabel}.`}>
        <Link2 className="h-3 w-3" />
        Linked
      </Badge>
    );
  }
  return (
    <>
      {placement.layer.lifecycle === "draft" && <Badge variant="outline">Draft</Badge>}
      {placement.layer.needsAttention !== undefined && (
        <TriangleAlert
          className="size-3.5 shrink-0 text-destructive"
          aria-label="Needs attention"
        />
      )}
    </>
  );
}

/** The meta line under the name: what this placement draws. */
function PlacementMeta({
  placement,
  childrenCount,
}: {
  placement: MapPlacement;
  childrenCount: number | undefined;
}) {
  if (placement.kind === "missing") {
    return <>remove it to clean up</>;
  }
  if (placement.kind === "linked") {
    return <>pinned {placement.layer.versionLabel}</>;
  }
  if (placement.layer.kind === "group") {
    return <>{childrenCount === undefined ? "…" : childrenCount} {childrenCount === 1 ? "child" : "children"}</>;
  }
  return (
    <>
      <StyleDot color={styleOrDefault(placement.layer.style).color} />
      styled dataset layer
    </>
  );
}

/** The row's controls: reorder, the map-local eye, style selection, removal. */
function PlacementControls({
  canWrite,
  name,
  visible,
  index,
  totalCount,
  selectable,
  viewerHint,
  onSelect,
  onToggleVisibility,
  onMove,
  onRemove,
}: {
  canWrite: boolean;
  name: string;
  visible: boolean;
  index: number;
  totalCount: number;
  selectable: boolean;
  viewerHint: string;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <MoveButtons
        index={index}
        totalCount={totalCount}
        label={name}
        disabled={!canWrite}
        disabledReason={viewerHint}
        onMoveUp={() => {
          onMove("up");
        }}
        onMoveDown={() => {
          onMove("down");
        }}
      />
      <PlacementEyeButton
        label={`"${name}"`}
        visible={visible}
        disabled={!canWrite}
        disabledReason={viewerHint}
        onToggle={onToggleVisibility}
      />
      {selectable && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Style ${name}`}
          title={canWrite ? "Style this layer — the stored style is what the map draws" : viewerHint}
          disabled={!canWrite}
          onClick={onSelect}
        >
          <Palette className="size-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label={`Remove ${name} from this map`}
        title={canWrite ? undefined : viewerHint}
        disabled={!canWrite}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/** The placement row's header: expand/collapse, icon, selectable name + badges + meta, and the controls. */
function PlacementHeader({
  placement,
  expandable,
  collapsed,
  childrenCount,
  canWrite,
  viewerHint,
  index,
  totalCount,
  onToggleCollapsed,
  onSelect,
  onToggleVisibility,
  onMove,
  onRemove,
}: {
  placement: MapPlacement;
  expandable: boolean;
  collapsed: boolean;
  childrenCount: number | undefined;
  canWrite: boolean;
  viewerHint: string;
  index: number;
  totalCount: number;
  onToggleCollapsed: (key: string) => void;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}) {
  const name = placementName(placement),
    selectable = placement.kind === "owned";
  return (
    <div className="flex items-center gap-2">
      {expandable ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
          onClick={() => {
            onToggleCollapsed(placement._id);
          }}
        >
          {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </Button>
      ) : (
        <span className="inline-block size-6 shrink-0" />
      )}
      <PlacementIcon placement={placement} />
      <button
        type="button"
        className={`flex min-w-0 flex-1 flex-col items-start text-left ${selectable ? "cursor-pointer" : "cursor-default"}`}
        title={
          placement.kind === "owned"
            ? "Select to restyle this layer"
            : placement.kind === "linked"
              ? "A linked layer is read-only — its pinned version renders as published"
              : undefined
        }
        onClick={() => {
          if (selectable) {
            onSelect();
          }
        }}
      >
        <span className="flex w-full items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          <PlacementBadges placement={placement} />
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <PlacementMeta placement={placement} childrenCount={childrenCount} />
        </span>
      </button>
      <PlacementControls
        canWrite={canWrite}
        name={name}
        visible={placement.visible}
        index={index}
        totalCount={totalCount}
        selectable={selectable}
        viewerHint={viewerHint}
        onSelect={onSelect}
        onToggleVisibility={onToggleVisibility}
        onMove={onMove}
        onRemove={onRemove}
      />
    </div>
  );
}

/** The group children list under an expanded owned group placement. */
function PlacementChildren({
  childItems,
  groupDetail,
  canWrite,
  viewerHint,
  onToggleChild,
}: {
  childItems: GroupChild[];
  groupDetail: LayerDetail | undefined;
  canWrite: boolean;
  viewerHint: string;
  onToggleChild: (child: GroupChild, currentlyVisible: boolean) => void;
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1 border-l pl-3">
      {childItems.length === 0 ? (
        <li className="px-2.5 py-1 text-xs text-muted-foreground">
          {groupDetail === undefined ? "Loading children…" : "No children — the group is empty."}
        </li>
      ) : (
        childItems.map((child) => (
          <GroupChildRow
            key={child.childLayerId}
            child={child}
            canWrite={canWrite}
            disabled={!canWrite}
            disabledReason={viewerHint}
            onToggleChild={onToggleChild}
          />
        ))
      )}
    </ul>
  );
}

/**
 * One placement row: header (expand, name, badges, controls) plus, for a
 * placed group, its resolved child tree.
 */
function PlacementRow({
  placement,
  index,
  totalCount,
  groupDetail,
  canWrite,
  selected,
  viewerHint,
  collapsedKeys,
  onToggleCollapsed,
  onSelect,
  onToggleVisibility,
  onMove,
  onRemove,
  onToggleChild,
}: {
  placement: MapPlacement;
  index: number;
  totalCount: number;
  groupDetail: LayerDetail | undefined;
  canWrite: boolean;
  selected: boolean;
  viewerHint: string;
  collapsedKeys: Set<string>;
  onToggleCollapsed: (key: string) => void;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  onToggleChild: (child: GroupChild, currentlyVisible: boolean) => void;
}) {
  // Expansion is inverted ("collapsed" set) so groups added later default
  // to expanded — the map shows everything until hidden.
  const expandable = placement.kind === "owned" && placement.layer.kind === "group",
    collapsed = collapsedKeys.has(placement._id),
    children = expandable && groupDetail !== undefined ? orderedChildrenOf(groupDetail) : [];
  return (
    <li
      className={`rounded-md border px-2.5 py-2 transition-opacity ${
        placement.visible ? "" : "opacity-55"
      } ${selected ? "border-primary" : ""}`}
    >
      <PlacementHeader
        placement={placement}
        expandable={expandable}
        collapsed={collapsed}
        childrenCount={expandable ? children.length : undefined}
        canWrite={canWrite}
        viewerHint={viewerHint}
        index={index}
        totalCount={totalCount}
        onToggleCollapsed={onToggleCollapsed}
        onSelect={onSelect}
        onToggleVisibility={onToggleVisibility}
        onMove={onMove}
        onRemove={onRemove}
      />
      {expandable && !collapsed && (
        <PlacementChildren
          childItems={children}
          groupDetail={groupDetail}
          canWrite={canWrite}
          viewerHint={viewerHint}
          onToggleChild={onToggleChild}
        />
      )}
    </li>
  );
}

/**
 * The workspace's layer panel: the map's placements in draw order, each with
 * its map-local eye (this canvas only — the layer's own default is separate),
 * reorder, removal, and selection into the style panel. Placed groups expand
 * to their resolved children.
 */
export function MapLayerPanel({
  groupDetailById,
  canWrite,
  placements,
  selectedPlacementId,
  viewerHint,
  onSelect,
  onToggleVisibility,
  onMove,
  onRemove,
  onToggleChild,
}: {
  groupDetailById: ReadonlyMap<string, LayerDetail>;
  canWrite: boolean;
  placements: MapPlacement[];
  selectedPlacementId: string | undefined;
  viewerHint: string;
  onSelect: (placement: MapPlacement) => void;
  onToggleVisibility: (placement: MapPlacement) => void;
  onMove: (placement: MapPlacement, direction: "up" | "down") => void;
  onRemove: (placement: MapPlacement) => void;
  onToggleChild: (child: GroupChild, currentlyVisible: boolean) => void;
}) {
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set()),
    toggleCollapsed = (key: string) => {
      setCollapsedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    };
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Layers ({placements.length})</CardTitle>
        <CardDescription>
          Draw order, top layer first — select a layer to restyle it, expand a group to see inside
        </CardDescription>
      </CardHeader>
      <CardContent>
        {placements.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No layers on this map yet — add one from the project or import a dataset.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {placements.map((placement, index) => (
              <PlacementRow
                key={placement._id}
                placement={placement}
                index={index}
                totalCount={placements.length}
                groupDetail={
                  placement.kind === "owned" && placement.layer.kind === "group"
                    ? groupDetailById.get(placement.layer.layerId)
                    : undefined
                }
                canWrite={canWrite}
                selected={placement._id === selectedPlacementId}
                viewerHint={viewerHint}
                collapsedKeys={collapsedKeys}
                onToggleCollapsed={toggleCollapsed}
                onSelect={() => {
                  onSelect(placement);
                }}
                onToggleVisibility={() => {
                  onToggleVisibility(placement);
                }}
                onMove={(direction) => {
                  onMove(placement, direction);
                }}
                onRemove={() => {
                  onRemove(placement);
                }}
                onToggleChild={onToggleChild}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
