import { Button } from "@caden/ui/components/button";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Copy,
  Database,
  FolderOpen,
  Link2,
  List,
  MapPin,
  Palette,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import type { UseLayerStylesResult } from "#/features/layer-styles";
import type { LayerRow, LayerVersionRow } from "#/lib/store/layers";

import type { LayerSelection } from "./types";

/**
 * The settings of the layer selected in the list, docked right of the map.
 * A data layer shows its dataset, its relations and its style controls; a
 * group shows what it holds; a linked layer says why it can't be edited here.
 */

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-2 border-b px-4 py-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DataLayerSettings({
  dataset,
  layer,
  onPopupFields,
  projectId,
  relationNotes,
  styling,
}: {
  dataset: { id: string; title: string } | undefined;
  layer: LayerRow;
  onPopupFields: (layerId: string) => void;
  projectId: string;
  relationNotes: readonly string[];
  styling: UseLayerStylesResult;
}) {
  if (dataset === undefined) {
    return (
      <Section title="Dataset">
        <p className="text-sm text-muted-foreground">
          This layer's dataset is no longer in the project, so there is nothing to draw.
        </p>
      </Section>
    );
  }
  const styled = styling.isStyled(dataset.id),
    editing = styling.editingId === dataset.id;
  return (
    <>
      <Section title="Dataset">
        <Link
          className="flex items-center gap-2 text-sm font-medium hover:underline"
          params={{ projectId, schemaId: dataset.id }}
          to="/projects/$projectId/datasets/$schemaId"
        >
          <Database className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{dataset.title}</span>
        </Link>
        {relationNotes.map((note) => (
          <p className="text-xs text-muted-foreground" key={note}>
            {note}
          </p>
        ))}
        {layer.needsAttention !== null && (
          <p className="flex gap-2 text-xs text-amber-600">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {layer.needsAttention}
          </p>
        )}
      </Section>
      <Section title="Popup">
        <p className="text-xs text-muted-foreground">
          The fields shown when someone clicks a feature of this layer.
        </p>
        <Button
          className="self-start"
          onClick={() => {
            onPopupFields(layer.id);
          }}
          size="sm"
          variant="outline"
        >
          <List />
          Popup fields…
        </Button>
      </Section>
      {editing ? (
        styling.panel
      ) : (
        <Section title="Style">
          <p className="text-xs text-muted-foreground">
            {styled ? "This layer has its own style." : "This layer draws in its assigned color."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                styling.edit({ renderId: dataset.id, title: layer.name });
              }}
              size="sm"
              variant="outline"
            >
              <Palette />
              Edit style
            </Button>
            {styled && (
              <Button
                onClick={() => {
                  styling.reset(dataset.id);
                }}
                size="sm"
                variant="ghost"
              >
                <RotateCcw />
                Reset style
              </Button>
            )}
          </div>
        </Section>
      )}
    </>
  );
}

function GroupSettings({
  childCount,
  layerId,
  onAddChild,
}: {
  childCount: number;
  layerId: string;
  onAddChild: (groupLayerId: string) => void;
}) {
  return (
    <Section title="Group">
      <p className="text-sm text-muted-foreground">
        {childCount === 0
          ? "This group is empty."
          : `Holds ${childCount} ${childCount === 1 ? "layer" : "layers"}. Hiding the group hides them all.`}
      </p>
      <Button
        className="self-start"
        onClick={() => {
          onAddChild(layerId);
        }}
        size="sm"
        variant="outline"
      >
        <Plus />
        Add layer to group
      </Button>
    </Section>
  );
}

function LinkedSettings({
  onClone,
  version,
}: {
  onClone: (versionId: string) => void;
  version: LayerVersionRow | undefined;
}) {
  return (
    <Section title="Linked layer">
      <p className="text-sm text-muted-foreground">
        This layer comes from another project and stays as it was published
        {version === undefined ? "" : ` (${version.versionLabel})`}. To change its style, make an
        editable copy.
      </p>
      {version !== undefined && (
        <Button
          className="self-start"
          onClick={() => {
            onClone(version.id);
          }}
          size="sm"
          variant="outline"
        >
          <Copy />
          Make an editable copy
        </Button>
      )}
    </Section>
  );
}

const KIND_ICONS = { data: MapPin, group: FolderOpen, linked: Link2 } as const;

export function LayerSettings({
  childCount,
  dataset,
  layer,
  onAddChild,
  onClone,
  onClose,
  onPopupFields,
  projectId,
  relationNotes,
  selection,
  styling,
  version,
}: {
  /** How many layers a selected group holds. */
  childCount: number;
  /** The dataset a selected data layer draws. */
  dataset: { id: string; title: string } | undefined;
  layer: LayerRow | undefined;
  onAddChild: (groupLayerId: string) => void;
  onClone: (versionId: string) => void;
  onClose: () => void;
  onPopupFields: (layerId: string) => void;
  projectId: string;
  relationNotes: readonly string[];
  selection: LayerSelection;
  styling: UseLayerStylesResult;
  version: LayerVersionRow | undefined;
}) {
  const Icon = KIND_ICONS[selection.kind];
  return (
    <aside
      aria-label={`Settings for ${selection.name}`}
      className="flex w-full shrink-0 flex-col overflow-y-auto border-t border-border bg-background md:w-[340px] md:border-t-0 md:border-l"
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={selection.name}>
          {selection.name}
        </h2>
        <Button
          aria-label="Close layer settings"
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {selection.kind === "data" && layer !== undefined && (
        <DataLayerSettings
          dataset={dataset}
          layer={layer}
          onPopupFields={onPopupFields}
          projectId={projectId}
          relationNotes={relationNotes}
          styling={styling}
        />
      )}
      {selection.kind === "group" && layer !== undefined && (
        <GroupSettings childCount={childCount} layerId={layer.id} onAddChild={onAddChild} />
      )}
      {selection.kind === "linked" && <LinkedSettings onClone={onClone} version={version} />}
    </aside>
  );
}
