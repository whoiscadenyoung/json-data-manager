import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Field, FieldLabel } from "@caden/ui/components/field";
import { ToggleGroup, ToggleGroupItem } from "@caden/ui/components/toggle-group";
import { Info, RotateCcw, X } from "lucide-react";

import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { entryDataRecord } from "#/lib/dataset-rows";
import type { LayerStyle, Renderer, StyleEditor } from "#convex/layerStyles/validators";

import { compileStyle, defaultEditor, usesIcons } from "../lib/compile";
import { hasTileLimitations } from "../lib/expressions";
import { legendClasses } from "../lib/legend";
import { isRampName, RAMP_NAMES, rampColors, type RampName } from "../lib/palettes";
import {
  bestCategoryField,
  categoricalRenderer,
  fieldNames,
  graduatedRenderer,
  numericFieldNames,
  overflowCount,
} from "../lib/renderers";
import { AdvancedSection } from "./advanced-section";
import { ColorField, RangeField, Section, SelectField, SwatchList } from "./controls";
import {
  CategoryIconButton,
  MarkerControls,
  MarkerOptionsSection,
  type MarkerIcons,
} from "./marker-section";

type Records = ReadonlyArray<Record<string, unknown>>;

const CLASS_COUNTS = [3, 4, 5, 6, 7] as const;

function valuesOf(records: Records, field: string): unknown[] {
  return records.map((record) => record[field]);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function px(value: number): string {
  return `${value}px`;
}

function rampLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).replaceAll("-", " → ");
}

/** The renderer the kind toggle switches to, generated from the loaded values. */
function rendererForKind(
  kind: Renderer["kind"],
  current: Renderer,
  records: Records,
  fields: { all: string[]; numeric: string[] },
  fallbackColor: string,
): Renderer | undefined {
  if (kind === "single") {
    return { color: current.kind === "single" ? current.color : fallbackColor, kind: "single" };
  }
  if (kind === "categorical") {
    const field = bestCategoryField(records, fields.all);
    return field === undefined ? undefined : categoricalRenderer(field, valuesOf(records, field));
  }
  const field = fields.numeric[0];
  return field === undefined
    ? undefined
    : graduatedRenderer(field, valuesOf(records, field), {
        classes: 5,
        method: "quantile",
        ramp: "blues",
      });
}

/** A category row's color, with its marker button first when points draw as shapes/icons. */
function CategoryRow({
  id,
  label,
  color,
  icon,
  marker,
  icons,
  onColor,
  onIcon,
}: {
  id: string;
  label: string;
  color: string;
  icon: string | undefined;
  marker: StyleEditor["marker"];
  icons: MarkerIcons;
  onColor: (color: string) => void;
  onIcon?: (icon: string) => void;
}) {
  if (!usesIcons(marker) || onIcon === undefined) {
    return <ColorField id={id} label={label} value={color} onChange={onColor} />;
  }
  return (
    <div className="flex items-center gap-2">
      <CategoryIconButton
        marker={marker}
        icon={icon ?? marker.icon}
        color={color}
        label={label}
        icons={icons}
        onPick={onIcon}
      />
      <div className="min-w-0 flex-1">
        <ColorField id={id} label={label} value={color} onChange={onColor} />
      </div>
    </div>
  );
}

function CategoriesEditor({
  renderer,
  marker,
  icons,
  records,
  fields,
  onChange,
}: {
  renderer: Extract<Renderer, { kind: "categorical" }>;
  marker: StyleEditor["marker"];
  icons: MarkerIcons;
  records: Records;
  fields: string[];
  onChange: (next: Renderer) => void;
}) {
  const overflow = overflowCount(valuesOf(records, renderer.field)),
    setCategory = (index: number, patch: { color?: string; icon?: string }) => {
      onChange({
        ...renderer,
        categories: renderer.categories.map((item, itemIndex) =>
          itemIndex === index ? { ...item, ...patch } : item,
        ),
      });
    };
  return (
    <>
      <SelectField
        id="style-category-field"
        label="Field"
        value={renderer.field}
        options={fields.map((field) => ({ label: field, value: field }))}
        onChange={(field) => {
          onChange(categoricalRenderer(field, valuesOf(records, field)));
        }}
      />
      <div className="flex flex-col gap-1.5">
        {renderer.categories.map((category, index) => (
          <CategoryRow
            key={String(category.value)}
            id={`style-category-${index}`}
            label={String(category.value)}
            color={category.color}
            icon={category.icon}
            marker={marker}
            icons={icons}
            onColor={(color) => {
              setCategory(index, { color });
            }}
            onIcon={(icon) => {
              setCategory(index, { icon });
            }}
          />
        ))}
        <CategoryRow
          id="style-category-other"
          label={overflow > 0 ? `Other (${overflow} more values)` : "Other"}
          color={renderer.otherColor}
          icon={undefined}
          marker={marker}
          icons={icons}
          onColor={(otherColor) => {
            onChange({ ...renderer, otherColor });
          }}
        />
      </div>
    </>
  );
}

function GraduatedEditor({
  renderer,
  records,
  fields,
  onChange,
}: {
  renderer: Extract<Renderer, { kind: "graduated" }>;
  records: Records;
  fields: string[];
  onChange: (next: Renderer) => void;
}) {
  const ramp: RampName = isRampName(renderer.ramp) ? renderer.ramp : "blues",
    regenerate = (patch: {
      field?: string;
      method?: "equal" | "quantile";
      classes?: number;
      ramp?: RampName;
    }) => {
      const field = patch.field ?? renderer.field;
      onChange(
        graduatedRenderer(field, valuesOf(records, field), {
          classes: patch.classes ?? renderer.colors.length,
          method: patch.method ?? renderer.method,
          ramp: patch.ramp ?? ramp,
        }),
      );
    },
    classes = legendClasses(compileStyle({ ...defaultEditor("#000000"), renderer }));
  return (
    <>
      <SelectField
        id="style-graduated-field"
        label="Numeric field"
        value={renderer.field}
        options={fields.map((field) => ({ label: field, value: field }))}
        onChange={(field) => {
          regenerate({ field });
        }}
      />
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          id="style-graduated-method"
          label="Method"
          value={renderer.method}
          options={[
            { label: "Quantile", value: "quantile" },
            { label: "Equal interval", value: "equal" },
          ]}
          onChange={(method) => {
            regenerate({ method: method === "equal" ? "equal" : "quantile" });
          }}
        />
        <SelectField
          id="style-graduated-classes"
          label="Classes"
          value={String(renderer.colors.length)}
          options={CLASS_COUNTS.map((count) => ({ label: String(count), value: String(count) }))}
          onChange={(count) => {
            regenerate({ classes: Number(count) });
          }}
        />
      </div>
      <SelectField
        id="style-graduated-ramp"
        label="Color ramp"
        value={ramp}
        options={RAMP_NAMES.map((name) => ({ label: rampLabel(name), value: name }))}
        onChange={(name) => {
          if (isRampName(name)) {
            onChange({
              ...renderer,
              colors: rampColors(name, renderer.colors.length),
              ramp: name,
            });
          }
        }}
      />
      {classes !== undefined && <SwatchList items={classes} />}
    </>
  );
}

function RendererEditor({
  editor,
  icons,
  records,
  fields,
  onChange,
}: {
  editor: StyleEditor;
  icons: MarkerIcons;
  records: Records;
  fields: { all: string[]; numeric: string[] };
  onChange: (next: Renderer) => void;
}) {
  const { renderer } = editor;
  if (renderer.kind === "categorical") {
    return (
      <CategoriesEditor
        renderer={renderer}
        marker={editor.marker}
        icons={icons}
        records={records}
        fields={fields.all}
        onChange={onChange}
      />
    );
  }
  if (renderer.kind === "graduated") {
    return (
      <GraduatedEditor
        renderer={renderer}
        records={records}
        fields={fields.numeric}
        onChange={onChange}
      />
    );
  }
  return (
    <ColorField
      id="style-single-color"
      label="Color"
      value={renderer.color}
      onChange={(color) => {
        onChange({ color, kind: "single" });
      }}
    />
  );
}

/** Symbology: the only section open by default — what most people come here for. */
function SymbologySection({
  editor,
  records,
  fields,
  fieldsLoading,
  fallbackColor,
  mayHavePoints,
  icons,
  missingIcons,
  onChange,
}: {
  editor: StyleEditor;
  records: Records;
  fields: { all: string[]; numeric: string[] };
  fieldsLoading: boolean;
  fallbackColor: string;
  mayHavePoints: boolean;
  icons: MarkerIcons;
  missingIcons: readonly string[];
  onChange: (next: StyleEditor) => void;
}) {
  const setRenderer = (renderer: Renderer) => {
    onChange({ ...editor, renderer });
  };
  return (
    <div className="flex flex-col gap-4 border-b px-4 py-5">
      <Field>
        <FieldLabel>Symbology</FieldLabel>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          className="w-full"
          value={[editor.renderer.kind]}
          onValueChange={(values) => {
            const kind = values.at(0);
            if (kind === "single" || kind === "categorical" || kind === "graduated") {
              const next = rendererForKind(kind, editor.renderer, records, fields, fallbackColor);
              if (next !== undefined) {
                setRenderer(next);
              }
            }
          }}
        >
          <ToggleGroupItem value="single" className="flex-1">
            Single
          </ToggleGroupItem>
          <ToggleGroupItem
            value="categorical"
            className="flex-1"
            disabled={fields.all.length === 0}
          >
            Categories
          </ToggleGroupItem>
          <ToggleGroupItem
            value="graduated"
            className="flex-1"
            disabled={fields.numeric.length === 0}
          >
            Graduated
          </ToggleGroupItem>
        </ToggleGroup>
        {fieldsLoading && (
          <p className="text-xs text-muted-foreground">Loading this dataset's fields…</p>
        )}
      </Field>
      {mayHavePoints && (
        <MarkerControls
          editor={editor}
          icons={icons}
          missingIcons={missingIcons}
          onChange={onChange}
        />
      )}
      <RendererEditor
        editor={editor}
        icons={icons}
        records={records}
        fields={fields}
        onChange={setRenderer}
      />
      <RangeField
        id="style-opacity"
        label="Fill opacity"
        value={editor.opacity}
        min={0}
        max={1}
        step={0.05}
        format={percent}
        onChange={(opacity) => {
          onChange({ ...editor, opacity });
        }}
      />
    </div>
  );
}

function OutlineSection({
  editor,
  onChange,
}: {
  editor: StyleEditor;
  onChange: (next: StyleEditor) => void;
}) {
  return (
    <Section title="Outlines & sizes" description="Polygon outlines, line width, point size">
      <ColorField
        id="style-stroke-color"
        label="Outline color"
        value={editor.strokeColor}
        onChange={(strokeColor) => {
          onChange({ ...editor, strokeColor });
        }}
      />
      <RangeField
        id="style-stroke-width"
        label="Outline width"
        value={editor.strokeWidth}
        min={0}
        max={8}
        step={0.5}
        format={px}
        onChange={(strokeWidth) => {
          onChange({ ...editor, strokeWidth });
        }}
      />
      <RangeField
        id="style-line-width"
        label="Line width"
        value={editor.lineWidth}
        min={0.5}
        max={12}
        step={0.5}
        format={px}
        onChange={(lineWidth) => {
          onChange({ ...editor, lineWidth });
        }}
      />
      {!usesIcons(editor.marker) && (
        <RangeField
          id="style-radius"
          label="Point size"
          value={editor.radius}
          min={1}
          max={20}
          step={0.5}
          format={px}
          onChange={(radius) => {
            onChange({ ...editor, radius });
          }}
        />
      )}
    </Section>
  );
}

function LabelsSection({
  editor,
  fields,
  rendersFromTiles,
  onChange,
}: {
  editor: StyleEditor;
  fields: string[];
  rendersFromTiles: boolean;
  onChange: (next: StyleEditor) => void;
}) {
  const { label } = editor,
    noneValue = "__none__";
  return (
    <Section title="Labels" description={label === undefined ? "Off" : `Showing ${label.field}`}>
      {rendersFromTiles && (
        <p className="flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          This dataset draws from map tiles, which can't show labels yet. Labels still export with
          the style.
        </p>
      )}
      <SelectField
        id="style-label-field"
        label="Label field"
        value={label === undefined ? noneValue : label.field}
        options={[
          { label: "No labels", value: noneValue },
          ...fields.map((field) => ({ label: field, value: field })),
        ]}
        onChange={(field) => {
          if (field === noneValue) {
            const { label: _removed, ...rest } = editor;
            onChange(rest);
            return;
          }
          onChange({
            ...editor,
            label: {
              color: label === undefined ? "#1f2937" : label.color,
              field,
              haloColor: label === undefined ? "#ffffff" : label.haloColor,
              size: label === undefined ? 12 : label.size,
            },
          });
        }}
      />
      {label !== undefined && (
        <>
          <RangeField
            id="style-label-size"
            label="Size"
            value={label.size}
            min={8}
            max={24}
            step={1}
            format={px}
            onChange={(size) => {
              onChange({ ...editor, label: { ...label, size } });
            }}
          />
          <ColorField
            id="style-label-color"
            label="Text color"
            value={label.color}
            onChange={(color) => {
              onChange({ ...editor, label: { ...label, color } });
            }}
          />
          <ColorField
            id="style-label-halo"
            label="Halo color"
            value={label.haloColor}
            onChange={(haloColor) => {
              onChange({ ...editor, label: { ...label, haloColor } });
            }}
          />
        </>
      )}
    </Section>
  );
}

function zoomDescription(editor: StyleEditor): string {
  if (editor.minzoom === undefined && editor.maxzoom === undefined) {
    return "All zoom levels";
  }
  return `Zoom ${editor.minzoom ?? 0}–${editor.maxzoom ?? 24}`;
}

function ZoomSection({
  editor,
  onChange,
}: {
  editor: StyleEditor;
  onChange: (next: StyleEditor) => void;
}) {
  const minzoom = editor.minzoom ?? 0,
    maxzoom = editor.maxzoom ?? 24,
    withRange = (nextMin: number, nextMax: number): StyleEditor => {
      const { minzoom: _min, maxzoom: _max, ...rest } = editor;
      return {
        ...rest,
        ...(nextMin > 0 ? { minzoom: nextMin } : {}),
        ...(nextMax < 24 ? { maxzoom: nextMax } : {}),
      };
    };
  return (
    <Section title="Zoom range" description={zoomDescription(editor)}>
      <p className="text-xs text-muted-foreground">
        Hide this dataset when zoomed out (or in) past these levels. 0 is the whole world; 20 is
        street level.
      </p>
      <RangeField
        id="style-minzoom"
        label="Show from zoom"
        value={minzoom}
        min={0}
        max={23}
        step={1}
        onChange={(value) => {
          onChange(withRange(value, Math.max(maxzoom, value + 1)));
        }}
      />
      <RangeField
        id="style-maxzoom"
        label="Hide past zoom"
        value={maxzoom}
        min={1}
        max={24}
        step={1}
        onChange={(value) => {
          onChange(withRange(Math.min(minzoom, value - 1), value));
        }}
      />
    </Section>
  );
}

/** Shown in place of the simple editor when the style was hand-written as MapLibre JSON. */
function CustomStyleNotice({ onStartOver }: { onStartOver: () => void }) {
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-5">
      <p className="text-sm">
        <span className="font-medium">Custom MapLibre style.</span>{" "}
        <span className="text-muted-foreground">
          This style was written as JSON, so the simple editor can't show it. Edit it under
          Advanced, or start over with the simple editor.
        </span>
      </p>
      <Button variant="outline" size="sm" className="self-start" onClick={onStartOver}>
        Start over with the simple editor
      </Button>
    </div>
  );
}

/**
 * The Style panel (docs/layer-styles.md): how one dataset draws on this map,
 * docked in the map's sidebar above the layer list so the map stays fully
 * visible while it previews. Symbology is open; outlines, labels, zoom range,
 * and the MapLibre JSON are collapsed sections. Every change previews on the
 * map immediately and saves on its own (debounced by the caller) — there is
 * no Save button.
 */
export function StylePanel({
  onClose,
  title,
  style,
  defaultColor,
  rows,
  rowsComplete,
  rendersFromTiles,
  saving,
  mayHavePoints,
  uploads,
  uploadList,
  missingIcons,
  onChange,
  onReset,
}: {
  onClose: () => void;
  title: string;
  /** The saved (or previewed) style; `undefined` = unstyled, the editor starts from the default look. */
  style: LayerStyle | undefined;
  defaultColor: string;
  /** The dataset's entries (for fields and class values); `undefined` until the first page arrives. */
  rows: readonly DatasetEntryRow[] | undefined;
  rowsComplete: boolean;
  rendersFromTiles: boolean;
  saving: boolean;
  /** Whether the dataset may have points (unknown or mixed counts) — the Marker picker shows only then. */
  mayHavePoints: boolean;
  /** Uploaded icons by name, and the list (undefined while loading). */
  uploads: MarkerIcons["uploads"];
  uploadList: MarkerIcons["uploadList"];
  /** Uploaded icons the style names that were deleted (those points draw circles). */
  missingIcons: readonly string[];
  onChange: (style: LayerStyle) => void;
  onReset: () => void;
}) {
  const records = rows === undefined ? [] : rows.map(entryDataRecord),
    all = fieldNames(records),
    fields = { all, numeric: numericFieldNames(records, all) },
    editor = style === undefined ? defaultEditor(defaultColor) : style.editor,
    applyEditor = (next: StyleEditor) => {
      onChange(compileStyle(next));
    },
    tileNote = style !== undefined && rendersFromTiles && hasTileLimitations(style),
    icons: MarkerIcons = { uploadList, uploads };
  return (
    <Card className="h-fit gap-0 py-0" aria-label={`Style for ${title}`}>
      <CardHeader className="border-b py-4">
        <CardTitle className="truncate">Style · {title}</CardTitle>
        <CardDescription>
          How this dataset draws on this map. Other maps and the data aren't affected.
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close style panel"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </CardAction>
      </CardHeader>
      {editor === undefined ? (
        <CustomStyleNotice
          onStartOver={() => {
            applyEditor(defaultEditor(defaultColor));
          }}
        />
      ) : (
        <>
          <SymbologySection
            editor={editor}
            records={records}
            fields={fields}
            fieldsLoading={!rowsComplete}
            fallbackColor={defaultColor}
            mayHavePoints={mayHavePoints}
            icons={icons}
            missingIcons={missingIcons}
            onChange={applyEditor}
          />
          {mayHavePoints && <MarkerOptionsSection editor={editor} onChange={applyEditor} />}
          <OutlineSection editor={editor} onChange={applyEditor} />
          <LabelsSection
            editor={editor}
            fields={fields.all}
            rendersFromTiles={rendersFromTiles}
            onChange={applyEditor}
          />
          <ZoomSection editor={editor} onChange={applyEditor} />
        </>
      )}
      <AdvancedSection
        style={style === undefined ? compileStyle(defaultEditor(defaultColor)) : style}
        title={title}
        icons={icons}
        onApply={onChange}
      />
      {tileNote && (
        <p className="flex gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Large datasets draw from map tiles: colors and sizes work, but labels, attribute filters,
          per-category icons and icon sizes by class only show once the dataset renders from rows.
        </p>
      )}
      <CardFooter className="flex-row items-center justify-between py-2">
        <span className="text-xs text-muted-foreground">
          {saving ? "Saving…" : style === undefined ? "Default style" : "Saved"}
        </span>
        <Button variant="ghost" size="sm" disabled={style === undefined} onClick={onReset}>
          <RotateCcw className="mr-1.5 size-3.5" />
          Reset to default
        </Button>
      </CardFooter>
    </Card>
  );
}
