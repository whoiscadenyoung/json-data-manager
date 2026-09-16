import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  FolderOpen,
  Layers as LayersIcon,
  MapPin,
  X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  datasetChildKey,
  isChildEffectivelyVisible,
  isDatasetChildVisible,
  type LayerChild,
  type MapLayerDoc,
  type MapLayerOverrideMap,
} from "#/lib/map-layers";

const LAYER_ICONS = {
  collection: LayersIcon,
  group: FolderOpen,
  dataset: MapPin,
} as const;

const LAYER_KINDS = {
  collection: "Collection",
  group: "Group",
  dataset: "Dataset",
} as const;

/** Up to eight per-dataset color swatches (+N overflow) under a layer row — the same colors the map draws them in. */
function LayerDatasetDots({ colors }: { colors: string[] }) {
  if (colors.length === 0) {
    return null;
  }
  const shown = colors.slice(0, 8),
    overflow = colors.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((color) => (
        <span
          key={color}
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
        />
      ))}
      {overflow > 0 && <span className="text-xs text-muted-foreground">+{overflow}</span>}
    </span>
  );
}

type ToggleChild = (layerId: string, childKey: string, currentlyVisible: boolean) => void;

function ChildEyeButton({
  label,
  visible,
  disabled,
  onToggle,
}: {
  label: string;
  visible: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={visible ? `Hide ${label}` : `Show ${label}`}
      disabled={disabled}
      onClick={onToggle}
    >
      {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
    </Button>
  );
}

function ExpandButton({
  label,
  collapsed,
  disabled,
  onToggle,
}: {
  label: string;
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  if (disabled) {
    // Keep the layout aligned for rows without children.
    return <span className="inline-block size-6 shrink-0" />;
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      onClick={onToggle}
    >
      {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
    </Button>
  );
}

/** One dataset child row — directly under a layer, or nested under a group child. */
function DatasetChildRow({
  layerId,
  childKey,
  title,
  color,
  visible,
  disabled,
  onToggleChild,
}: {
  layerId: string;
  childKey: string;
  title: string;
  color?: string;
  visible: boolean;
  disabled: boolean;
  onToggleChild: ToggleChild;
}) {
  return (
    <li
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
        visible ? "" : "opacity-55"
      }`}
    >
      {color === undefined ? (
        <span className="inline-block h-2 w-2 shrink-0 rounded-full border border-muted-foreground/40" />
      ) : (
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      <p className="min-w-0 flex-1 truncate text-xs font-medium">{title}</p>
      <ChildEyeButton
        label={`"${title}"`}
        visible={visible}
        disabled={disabled}
        onToggle={() => {
          onToggleChild(layerId, childKey, visible);
        }}
      />
    </li>
  );
}

/** One group child of a collection layer: toggles as a unit, expands to its member datasets. */
function GroupChildRow({
  layer,
  child,
  overridesByLayer,
  collapsedKeys,
  onToggleCollapsed,
  onToggleChild,
}: {
  layer: MapLayerDoc;
  child: Extract<LayerChild, { kind: "group" }>;
  overridesByLayer: MapLayerOverrideMap;
  collapsedKeys: Set<string>;
  onToggleCollapsed: (key: string) => void;
  onToggleChild: ToggleChild;
}) {
  const layerVisible = layer.visible,
    visible = isChildEffectivelyVisible(layer, child, overridesByLayer),
    expandKey = `${layer._id}:${child.childKey}`,
    collapsed = collapsedKeys.has(expandKey);
  return (
    <li className={visible ? "" : "opacity-55"}>
      <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
        <ExpandButton
          label={`"${child.group.name}"`}
          collapsed={collapsed}
          disabled={child.datasets.length === 0}
          onToggle={() => {
            onToggleCollapsed(expandKey);
          }}
        />
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{child.group.name}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {child.datasets.length === 0
              ? "Empty group"
              : `${child.datasets.length} ${child.datasets.length === 1 ? "dataset" : "datasets"}`}
          </p>
        </div>
        <ChildEyeButton
          label={`"${child.group.name}"`}
          visible={visible}
          disabled={!layerVisible}
          onToggle={() => {
            onToggleChild(layer._id, child.childKey, visible);
          }}
        />
      </div>
      {!collapsed && child.datasets.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1 pl-4">
          {child.datasets.map((entry) => (
            <DatasetChildRow
              key={entry.dataset._id}
              layerId={layer._id}
              childKey={datasetChildKey(entry.dataset._id)}
              title={entry.dataset.title}
              color={entry.color}
              visible={isDatasetChildVisible(layer, entry.dataset, overridesByLayer)}
              disabled={!visible || !layerVisible}
              onToggleChild={onToggleChild}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One top-level layer row: header (with its own eye) plus, when expandable and expanded, its child tree. */
function LayerRow({
  layer,
  index,
  totalCount,
  name,
  childItems,
  overridesByLayer,
  datasetColors,
  collapsedKeys,
  onToggleCollapsed,
  onMoveUp,
  onMoveDown,
  onToggleVisibility,
  onRemove,
  onToggleChild,
}: {
  layer: MapLayerDoc;
  index: number;
  totalCount: number;
  name: string;
  childItems: LayerChild[];
  overridesByLayer: MapLayerOverrideMap;
  datasetColors: string[];
  collapsedKeys: Set<string>;
  onToggleCollapsed: (key: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleVisibility: () => void;
  onRemove: () => void;
  onToggleChild: ToggleChild;
}) {
  const Icon = LAYER_ICONS[layer.targetType],
    expandable = childItems.length > 0,
    expanded = !collapsedKeys.has(layer._id);
  return (
    <li
      className={`rounded-md border px-2.5 py-2 transition-opacity ${
        layer.visible ? "" : "opacity-55"
      }`}
    >
      <div className="flex items-center gap-2">
        <ExpandButton
          label={`"${name}"`}
          collapsed={!expanded}
          disabled={!expandable}
          onToggle={() => {
            onToggleCollapsed(layer._id);
          }}
        />
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs text-muted-foreground">
              {LAYER_KINDS[layer.targetType]} ·{" "}
              {datasetColors.length === 0
                ? "no geospatial datasets"
                : `${datasetColors.length} ${datasetColors.length === 1 ? "dataset" : "datasets"}`}
            </p>
            <LayerDatasetDots colors={datasetColors} />
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Move "${name}" up`}
            disabled={index === 0}
            onClick={onMoveUp}
          >
            <ChevronUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Move "${name}" down`}
            disabled={index === totalCount - 1}
            onClick={onMoveDown}
          >
            <ChevronDown className="size-3.5" />
          </Button>
          <ChildEyeButton
            label={`"${name}"`}
            visible={layer.visible}
            disabled={false}
            onToggle={onToggleVisibility}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label={`Remove "${name}" from this map`}
            onClick={onRemove}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      {expandable && expanded && (
        <ul className="mt-2 flex flex-col gap-1 border-l pl-3">
          {childItems.map((child) =>
            child.kind === "group" ? (
              <GroupChildRow
                key={child.childKey}
                layer={layer}
                child={child}
                overridesByLayer={overridesByLayer}
                collapsedKeys={collapsedKeys}
                onToggleCollapsed={onToggleCollapsed}
                onToggleChild={onToggleChild}
              />
            ) : (
              <DatasetChildRow
                key={child.childKey}
                layerId={layer._id}
                childKey={child.childKey}
                title={child.dataset.title}
                color={child.color}
                visible={isDatasetChildVisible(layer, child.dataset, overridesByLayer)}
                disabled={!layer.visible}
                onToggleChild={onToggleChild}
              />
            ),
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * The workspace's layer panel: one row per layer in draw order, each
 * expandable into its child tree — a collection layer expands to its groups
 * and directly-joined datasets (each group further expanding to its member
 * datasets), a group layer to its datasets. Every level carries its own
 * eye toggle backed by a per-child override, and hiding a group hides its
 * datasets with it.
 */
export function MapLayerPanel({
  layers,
  childrenByLayer,
  overridesByLayer,
  datasetColorsByLayer,
  nameForLayer,
  onMove,
  onToggleVisibility,
  onRemove,
  onToggleChild,
}: {
  layers: MapLayerDoc[];
  childrenByLayer: globalThis.Map<string, LayerChild[]>;
  overridesByLayer: MapLayerOverrideMap;
  datasetColorsByLayer: (layer: MapLayerDoc) => string[];
  nameForLayer: (layer: MapLayerDoc) => string;
  onMove: (layer: MapLayerDoc, direction: "up" | "down") => void;
  onToggleVisibility: (layer: MapLayerDoc) => void;
  onRemove: (layer: MapLayerDoc) => void;
  onToggleChild: ToggleChild;
}) {
  // Expansion is inverted ("collapsed" set) so layers and children added
  // later default to expanded — matching how the map itself shows
  // everything until hidden.
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
        <CardTitle>Layers ({layers.length})</CardTitle>
        <CardDescription>
          Draw order, top layer first — expand a layer to toggle its groups and datasets
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {layers.map((layer, index) => (
            <LayerRow
              key={layer._id}
              layer={layer}
              index={index}
              totalCount={layers.length}
              name={nameForLayer(layer)}
              childItems={childrenByLayer.get(layer._id) ?? []}
              overridesByLayer={overridesByLayer}
              datasetColors={datasetColorsByLayer(layer)}
              collapsedKeys={collapsedKeys}
              onToggleCollapsed={toggleCollapsed}
              onMoveUp={() => {
                onMove(layer, "up");
              }}
              onMoveDown={() => {
                onMove(layer, "down");
              }}
              onToggleVisibility={() => {
                onToggleVisibility(layer);
              }}
              onRemove={() => {
                onRemove(layer);
              }}
              onToggleChild={onToggleChild}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
