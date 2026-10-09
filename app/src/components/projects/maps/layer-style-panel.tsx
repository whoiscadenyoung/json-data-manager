import { Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import type { LayerStyle, MapPlacement } from "#/lib/projects/map-layers";
import { DEFAULT_LAYER_STYLE, LAYER_PALETTE, styleOrDefault } from "#/lib/projects/map-layers";

/**
 * The layer style panel (phase 4): edits one OWNED layer's STORED style —
 * the `layers.style` row the map draws, replacing the standalone maps'
 * client-only `assignDatasetColors`. Saving goes through `layers.update`,
 * which also clears the layer's `needsAttention` drift flag (whoever edited
 * the definition just looked at it). A linked placement renders read-only:
 * its style is frozen in the pinned version — clone the layer (phase 5's
 * reuse flow) to customize a copy.
 *
 * The editor remounts per layer (`key` at the call site), so the draft state
 * seeds from props exactly once — no state-sync effects.
 */

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          // Clamp into the field's range — a typed -3 stores as 0, never a
          // negative opacity into the paint.
          if (Number.isFinite(parsed)) {
            onChange(Math.min(max, Math.max(min, parsed)));
          }
        }}
      />
      {hint !== undefined && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The palette swatches plus a free-form color input, one row. */
function ColorField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex flex-wrap items-center gap-1">
        {LAYER_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Use ${color}`}
            aria-pressed={value.toLowerCase() === color}
            disabled={disabled}
            className={`size-6 rounded-full border transition-transform ${
              value.toLowerCase() === color ? "scale-110 border-foreground" : "border-border"
            }`}
            style={{ backgroundColor: color }}
            onClick={() => {
              onChange(color);
            }}
          />
        ))}
        <input
          type="color"
          aria-label={`${label} custom color`}
          value={value}
          disabled={disabled}
          className="size-6 cursor-pointer rounded-full border border-border bg-transparent"
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      </div>
    </div>
  );
}

/** The read-only view for a linked placement's frozen style. */
function LinkedStyleCard({ placement }: { placement: Extract<MapPlacement, { kind: "linked" }> }) {
  const style = styleOrDefault(placement.layer.style);
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {placement.layer.name}
          <Badge variant="secondary">pinned {placement.layer.versionLabel}</Badge>
        </CardTitle>
        <CardDescription>
          A linked layer renders its pinned version read-only — the frozen style below is what the
          map draws. Clone the layer to customize a copy.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-4 w-4 rounded-full border border-border"
            style={{ backgroundColor: style.color }}
          />
          Stroke / points {style.color}
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-4 w-4 rounded border border-border"
            style={{ backgroundColor: style.fillColor }}
          />
          Fill {style.fillColor} at {Math.round(style.fillOpacity * 100)}%
        </div>
        <p className="text-xs text-muted-foreground">
          Stroke width {style.weight} · point radius {style.radius}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The editable style form for one owned placement. `name` is the only
 * required field — the Save button stays live and the friendly refusal is
 * the server's, surfaced in the toast (the UI rule: never a silently
 * disabled Save).
 */
// oxlint-disable-next-line eslint/complexity -- the form's branches ARE its render states (saving spinner, dirty hints, reset gating); splitting them into named components scatters one form across the file.
function OwnedStyleForm({
  canWrite,
  placement,
  viewerHint,
  onSave,
  saving,
}: {
  canWrite: boolean;
  placement: Extract<MapPlacement, { kind: "owned" }>;
  viewerHint: string;
  onSave: (draft: { name: string; style: LayerStyle }) => void | Promise<void>;
  saving: boolean;
}) {
  const layer = placement.layer,
    stored = styleOrDefault(layer.style),
    [name, setName] = useState(layer.name),
    [style, setStyle] = useState<LayerStyle>(stored),
    locked = !canWrite || saving,
    dirty =
      name !== layer.name ||
      style.color !== stored.color ||
      style.fillColor !== stored.fillColor ||
      style.fillOpacity !== stored.fillOpacity ||
      style.opacity !== stored.opacity ||
      style.radius !== stored.radius ||
      style.weight !== stored.weight;
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Layer style
          {layer.needsAttention !== undefined && (
            <Badge variant="destructive" title={layer.needsAttention}>
              <TriangleAlert className="h-3 w-3" />
              Needs attention
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          The stored style is what the map draws — every placement of this layer renders it.
          {layer.needsAttention !== undefined &&
            " Saving also clears the drift flag: you've now looked at the layer."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="layer-style-name" className="text-xs">
            Name
          </Label>
          <Input
            id="layer-style-name"
            value={name}
            disabled={locked}
            title={canWrite ? undefined : viewerHint}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <ColorField
          id="layer-style-color"
          label="Stroke / points"
          value={style.color}
          disabled={locked}
          onChange={(color) => {
            setStyle((prev) => ({ ...prev, color }));
          }}
        />
        <ColorField
          id="layer-style-fill"
          label="Fill"
          value={style.fillColor}
          disabled={locked}
          onChange={(fillColor) => {
            setStyle((prev) => ({ ...prev, fillColor }));
          }}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="layer-style-fill-opacity"
            label="Fill opacity"
            hint="0–1"
            value={style.fillOpacity}
            min={0}
            max={1}
            step={0.05}
            disabled={locked}
            onChange={(fillOpacity) => {
              setStyle((prev) => ({ ...prev, fillOpacity }));
            }}
          />
          <NumberField
            id="layer-style-weight"
            label="Stroke width"
            hint="pixels"
            value={style.weight}
            min={0.5}
            max={10}
            step={0.5}
            disabled={locked}
            onChange={(weight) => {
              setStyle((prev) => ({ ...prev, weight }));
            }}
          />
          <NumberField
            id="layer-style-radius"
            label="Point radius"
            hint="pixels"
            value={style.radius}
            min={2}
            max={20}
            step={1}
            disabled={locked}
            onChange={(radius) => {
              setStyle((prev) => ({ ...prev, radius }));
            }}
          />
          <NumberField
            id="layer-style-opacity"
            label="Stroke opacity"
            hint="0–1"
            value={style.opacity}
            min={0}
            max={1}
            step={0.05}
            disabled={locked}
            onChange={(opacity) => {
              setStyle((prev) => ({ ...prev, opacity }));
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            disabled={locked || !dirty}
            title={!canWrite ? viewerHint : !dirty ? "No changes to save yet" : undefined}
            onClick={() => {
              void onSave({ name, style });
            }}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save style"
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked || !dirty}
            title={canWrite ? undefined : viewerHint}
            onClick={() => {
              setName(layer.name);
              setStyle(stored);
            }}
          >
            Reset
          </Button>
        </div>
        {dirty && (
          <p className="text-xs text-muted-foreground">
            Unsaved changes — the map draws the saved style until you save.
          </p>
        )}
        <p className="text-[10px] text-muted-foreground" title={viewerHint}>
          Defaults: {DEFAULT_LAYER_STYLE.color} stroke,{" "}
          {Math.round(DEFAULT_LAYER_STYLE.fillOpacity * 100)}% fill — what an auto-created layer
          carries before anyone styles it.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The editable form for one owned GROUP placement — name + the group
 * transparency slider, the one style a group owns (the canvas scales every
 * child's fill/stroke opacities by it). A group's stored STYLE is rendered
 * by nothing (groups draw only through their children), so offering the
 * stroke/fill form here would save a silent no-op.
 */
// oxlint-disable-next-line eslint/complexity -- the form's branches ARE its render states (saving spinner, dirty hints, reset gating), same as OwnedStyleForm.
function GroupStyleForm({
  canWrite,
  placement,
  viewerHint,
  onSave,
  saving,
}: {
  canWrite: boolean;
  placement: Extract<MapPlacement, { kind: "owned" }>;
  viewerHint: string;
  onSave: (draft: { name: string; opacity: number }) => Promise<void>;
  saving: boolean;
}) {
  const layer = placement.layer,
    [name, setName] = useState(layer.name),
    [opacity, setOpacity] = useState(layer.opacity ?? 1),
    locked = !canWrite || saving,
    dirty = name !== layer.name || opacity !== (layer.opacity ?? 1);
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-base">Group</CardTitle>
        <CardDescription>
          A group draws only through its children — name it and set how transparent the whole
          subtree draws. Restyle each child by selecting it in the tree.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="group-style-name" className="text-xs">
            Name
          </Label>
          <Input
            id="group-style-name"
            value={name}
            disabled={locked}
            title={canWrite ? undefined : viewerHint}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <NumberField
          id="group-style-opacity"
          label="Group transparency"
          hint="0–1 — scales every child's fill and stroke opacity"
          value={opacity}
          min={0}
          max={1}
          step={0.05}
          disabled={locked}
          onChange={(value) => {
            setOpacity(value);
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            disabled={locked || !dirty}
            title={!canWrite ? viewerHint : !dirty ? "No changes to save yet" : undefined}
            onClick={() => {
              void onSave({ name, opacity });
            }}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save group"
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked || !dirty}
            title={canWrite ? undefined : viewerHint}
            onClick={() => {
              setName(layer.name);
              setOpacity(layer.opacity ?? 1);
            }}
          >
            Reset
          </Button>
        </div>
        {dirty && (
          <p className="text-xs text-muted-foreground">
            Unsaved changes — children draw at the saved transparency until you save.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The style panel for the selected placement: the owned data form (the
 * remount `key` re-seeds the draft per layer), the owned GROUP form (name +
 * transparency — a group's stored style is rendered by nothing), the linked
 * read-only card, or nothing for a missing placement.
 */
export function LayerStylePanel({
  canWrite,
  placement,
  viewerHint,
  saving,
  onSave,
  onSaveGroup,
}: {
  canWrite: boolean;
  placement: MapPlacement | undefined;
  viewerHint: string;
  saving: boolean;
  onSave: (draft: { name: string; style: LayerStyle }) => void | Promise<void>;
  onSaveGroup: (draft: { name: string; opacity: number }) => Promise<void>;
}) {
  if (placement === undefined) {
    return null;
  }
  if (placement.kind === "linked") {
    return <LinkedStyleCard placement={placement} />;
  }
  if (placement.kind === "missing") {
    return null;
  }
  if (placement.layer.kind === "group") {
    return (
      <GroupStyleForm
        key={placement.layer.layerId}
        canWrite={canWrite}
        placement={placement}
        viewerHint={viewerHint}
        saving={saving}
        onSave={onSaveGroup}
      />
    );
  }
  return (
    <OwnedStyleForm
      key={placement.layer.layerId}
      canWrite={canWrite}
      placement={placement}
      viewerHint={viewerHint}
      saving={saving}
      onSave={onSave}
    />
  );
}
