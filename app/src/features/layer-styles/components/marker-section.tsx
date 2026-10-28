import { DEFAULT_MARKER_ICON, usesIcons } from "@caden/layer-styles/compile";
import { iconLabelFromFileName, rasterizeIcon } from "@caden/layer-styles/uploads";
import type { Marker, MarkerKind, Renderer, StyleEditor } from "@caden/layer-styles/validators";
import { Button } from "@caden/ui/components/button";
import { Checkbox } from "@caden/ui/components/checkbox";
import { Field, FieldLabel } from "@caden/ui/components/field";
import { Input } from "@caden/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@caden/ui/components/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@caden/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@caden/ui/components/toggle-group";
import { cn } from "@caden/ui/lib/utils";
import { useMutation } from "convex/react";
import { Info, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import type { Id } from "#convex/_generated/dataModel";

import { loadCatalog, type IconCatalogEntry, type UploadedIcon } from "../lib/icon-images";
import { RangeField, Section } from "./controls";
import { MarkerSwatch } from "./marker-swatch";

/** Grid cells rendered at once — a search narrows the rest. */
const MAX_GRID_ICONS = 120;

/** Uploaded icons and their list (undefined while loading), threaded to every picker. */
export interface MarkerIcons {
  uploads: ReadonlyMap<string, UploadedIcon>;
  uploadList: readonly UploadedIcon[] | undefined;
}

/** The color picker swatches preview in: the style's own (first) color. */
export function previewColor(renderer: Renderer): string {
  if (renderer.kind === "single") {
    return renderer.color;
  }
  if (renderer.kind === "categorical") {
    const first = renderer.categories.at(0);
    return first === undefined ? renderer.otherColor : first.color;
  }
  return renderer.colors.at(-1) ?? "#3b82f6";
}

function useCatalog(): IconCatalogEntry[] | undefined {
  const [catalog, setCatalog] = useState<IconCatalogEntry[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((entries) => {
        if (!cancelled) {
          setCatalog(entries);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return catalog;
}

function matches(
  entry: { name: string; label: string; keywords: readonly string[] },
  query: string,
) {
  if (query === "") {
    return true;
  }
  return (
    entry.label.toLowerCase().includes(query) ||
    entry.name.includes(query) ||
    entry.keywords.some((keyword) => keyword.includes(query))
  );
}

function IconCell({
  name,
  label,
  color,
  selected,
  icons,
  onPick,
}: {
  name: string;
  label: string;
  color: string;
  selected: boolean;
  icons: MarkerIcons;
  onPick: (name: string) => void;
}) {
  return (
    <button
      type="button"
      title={`${label} (${name})`}
      aria-label={label}
      aria-pressed={selected}
      onClick={() => {
        onPick(name);
      }}
      className={cn(
        "flex size-8 cursor-pointer items-center justify-center rounded-md border border-transparent transition-colors hover:bg-muted",
        selected && "border-primary bg-muted",
      )}
    >
      <MarkerSwatch icon={name} color={color} uploads={icons.uploads} size={22} />
    </button>
  );
}

function IconGrid({
  entries,
  value,
  color,
  icons,
  onPick,
  empty,
}: {
  entries: ReadonlyArray<{ name: string; label: string }>;
  value: string | undefined;
  color: string;
  icons: MarkerIcons;
  onPick: (name: string) => void;
  empty: string;
}) {
  if (entries.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">{empty}</p>;
  }
  const shown = entries.slice(0, MAX_GRID_ICONS);
  return (
    <>
      <div className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-0.5 overflow-y-auto">
        {shown.map((entry) => (
          <IconCell
            key={entry.name}
            name={entry.name}
            label={entry.label}
            color={color}
            selected={entry.name === value}
            icons={icons}
            onPick={onPick}
          />
        ))}
      </div>
      {entries.length > shown.length && (
        <p className="text-xs text-muted-foreground">
          Showing {shown.length} of {entries.length}. Search to narrow it down.
        </p>
      )}
    </>
  );
}

function UploadForm({ onUploaded }: { onUploaded: (name: string) => void }) {
  const generateUploadUrl = useMutation(api.layerStyles.icons.generateUploadUrl),
    createIcon = useMutation(api.layerStyles.icons.create),
    inputRef = useRef<HTMLInputElement>(null),
    [tintable, setTintable] = useState(true),
    [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const icon = await rasterizeIcon(file, tintable),
        url = await generateUploadUrl(),
        response = await fetch(url, {
          body: icon.png,
          headers: { "Content-Type": "image/png" },
          method: "POST",
        });
      if (!response.ok) {
        throw new Error("The upload failed. Try again.");
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Convex's upload endpoint answers { storageId } with the new file's id.
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      const result = await createIcon({
        height: icon.height,
        label: iconLabelFromFileName(file.name),
        pixelRatio: icon.pixelRatio,
        sdf: icon.sdf,
        storageId,
        width: icon.width,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      toast.success("Icon uploaded.");
      onUploaded(result.name);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't upload the icon."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-2">
      <input
        ref={inputRef}
        type="file"
        accept=".svg,.png,image/svg+xml,image/png"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files === null ? undefined : event.target.files[0];
          event.target.value = "";
          if (file !== undefined) {
            void upload(file);
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <Field orientation="horizontal" className="items-center gap-2">
          <Checkbox
            id="style-marker-tintable"
            checked={tintable}
            onCheckedChange={(checked) => {
              setTintable(checked);
            }}
          />
          <FieldLabel htmlFor="style-marker-tintable" className="font-normal">
            Tintable (single-color glyph)
          </FieldLabel>
        </Field>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (inputRef.current !== null) {
              inputRef.current.click();
            }
          }}
        >
          <Upload className="mr-1.5 size-3.5" />
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        SVG or PNG, 256 KB at most (PNGs up to 128 px). Tintable icons take the style's colors; turn
        it off for logos and full-color images. Uploads are shared with everyone who can edit maps.
      </p>
    </div>
  );
}

function UploadedTab({
  value,
  color,
  icons,
  query,
  onPick,
}: {
  value: string | undefined;
  color: string;
  icons: MarkerIcons;
  query: string;
  onPick: (name: string) => void;
}) {
  const removeIcon = useMutation(api.layerStyles.icons.remove),
    [confirming, setConfirming] = useState<string | undefined>(undefined),
    list = icons.uploadList,
    entries = (list === undefined ? [] : list).filter((icon) =>
      matches({ keywords: [], label: icon.label, name: icon.name }, query),
    ),
    selected = list === undefined ? undefined : list.find((icon) => icon.name === value);
  return (
    <div className="flex flex-col gap-2">
      <UploadForm onUploaded={onPick} />
      {list === undefined ? (
        <p className="text-xs text-muted-foreground">Loading uploaded icons…</p>
      ) : (
        <IconGrid
          entries={entries}
          value={value}
          color={color}
          icons={icons}
          onPick={onPick}
          empty={list.length === 0 ? "No uploaded icons yet." : "No uploaded icons match."}
        />
      )}
      {selected !== undefined && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-muted-foreground">
            {selected.label}
            {selected.sdf ? " · tintable" : " · full color"}
          </span>
          {confirming === selected.iconId ? (
            <span className="flex items-center gap-1">
              <span>Delete for every map?</span>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirming(undefined);
                  removeIcon({ iconId: selected.iconId })
                    .then(() => {
                      toast.success("Icon deleted. Styles that used it draw circles.");
                    })
                    .catch((error: unknown) => {
                      toast.error(errorMessage(error, "Couldn't delete the icon."));
                    });
                }}
              >
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirming(undefined);
                }}
              >
                Keep
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(selected.iconId);
              }}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              Delete icon
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function familyOf(name: string | undefined): "lucide" | "maki" | "uploaded" {
  if (name !== undefined && name.startsWith("maki-")) {
    return "maki";
  }
  if (name !== undefined && name.startsWith("user-")) {
    return "uploaded";
  }
  return "lucide";
}

/**
 * The icon/shape picker: the seven basic shapes for a Shape marker, or a
 * searchable grid of the curated Lucide set, Maki's map icons, and uploads
 * for an Icon marker.
 */
export function IconPicker({
  kind,
  value,
  color,
  icons,
  onPick,
}: {
  kind: Exclude<MarkerKind, "circle">;
  value: string | undefined;
  color: string;
  icons: MarkerIcons;
  onPick: (name: string) => void;
}) {
  const catalog = useCatalog(),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState<string>(() => familyOf(value)),
    needle = query.trim().toLowerCase();
  if (catalog === undefined) {
    return <p className="text-xs text-muted-foreground">Loading icons…</p>;
  }
  if (kind === "shape") {
    return (
      <IconGrid
        entries={catalog.filter((entry) => entry.family === "shape")}
        value={value}
        color={color}
        icons={icons}
        onPick={onPick}
        empty="Shapes didn't load."
      />
    );
  }
  const family = (name: "lucide" | "maki") =>
    catalog.filter((entry) => entry.family === name && matches(entry, needle));
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search icons"
          placeholder="Search icons"
          value={query}
          className="h-8 pl-7 text-xs"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      <Tabs value={tab} onValueChange={(next) => setTab(String(next))}>
        <TabsList className="w-full">
          <TabsTrigger value="lucide">Lucide</TabsTrigger>
          <TabsTrigger value="maki">Maki</TabsTrigger>
          <TabsTrigger value="uploaded">Uploaded</TabsTrigger>
        </TabsList>
        <TabsContent value="lucide" className="pt-2">
          <IconGrid
            entries={family("lucide")}
            value={value}
            color={color}
            icons={icons}
            onPick={onPick}
            empty="No Lucide icons match."
          />
        </TabsContent>
        <TabsContent value="maki" className="pt-2">
          <IconGrid
            entries={family("maki")}
            value={value}
            color={color}
            icons={icons}
            onPick={onPick}
            empty="No Maki icons match."
          />
        </TabsContent>
        <TabsContent value="uploaded" className="pt-2">
          <UploadedTab value={value} color={color} icons={icons} query={needle} onPick={onPick} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The marker a kind toggle switches to, keeping what carries over (size, rotation, class sizes). */
function markerForKind(kind: MarkerKind, current: Marker | undefined): Marker {
  const base: Marker =
    current === undefined
      ? { allowOverlap: true, icon: DEFAULT_MARKER_ICON.icon, kind, rotation: 0, size: 18 }
      : { ...current, kind };
  if (kind === "shape" && !base.icon.startsWith("shape-")) {
    return { ...base, icon: DEFAULT_MARKER_ICON.shape };
  }
  if (kind === "icon" && base.icon.startsWith("shape-")) {
    return { ...base, icon: DEFAULT_MARKER_ICON.icon };
  }
  return base;
}

/** Category icons belong to one marker kind; switching kinds starts classes on the marker's icon again. */
function withoutCategoryIcons(renderer: Renderer): Renderer {
  if (renderer.kind !== "categorical") {
    return renderer;
  }
  return {
    ...renderer,
    categories: renderer.categories.map(({ icon: _icon, ...category }) => category),
  };
}

/**
 * The Symbology section's Marker picker (datasets that may have points):
 * Circle keeps MapLibre circles; Shape and Icon draw sprite images that the
 * style's colors tint.
 */
export function MarkerControls({
  editor,
  icons,
  missingIcons,
  onChange,
}: {
  editor: StyleEditor;
  icons: MarkerIcons;
  missingIcons: readonly string[];
  onChange: (next: StyleEditor) => void;
}) {
  const { marker } = editor,
    kind: MarkerKind = marker === undefined ? "circle" : marker.kind,
    color = previewColor(editor.renderer);
  return (
    <Field>
      <FieldLabel>Marker</FieldLabel>
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        className="w-full"
        value={[kind]}
        onValueChange={(values) => {
          const next = values.at(0);
          if ((next === "circle" || next === "shape" || next === "icon") && next !== kind) {
            onChange({
              ...editor,
              marker: markerForKind(next, marker),
              renderer: withoutCategoryIcons(editor.renderer),
            });
          }
        }}
      >
        <ToggleGroupItem value="circle" className="flex-1">
          Circle
        </ToggleGroupItem>
        <ToggleGroupItem value="shape" className="flex-1">
          Shape
        </ToggleGroupItem>
        <ToggleGroupItem value="icon" className="flex-1">
          Icon
        </ToggleGroupItem>
      </ToggleGroup>
      {missingIcons.length > 0 && (
        <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {missingIcons.length === 1
            ? "An uploaded icon this style uses was"
            : "Uploaded icons this style uses were"}{" "}
          deleted, so those points draw as circles. Pick another icon.
        </p>
      )}
      {usesIcons(marker) && (
        <IconPicker
          kind={marker.kind === "shape" ? "shape" : "icon"}
          value={marker.icon}
          color={color}
          icons={icons}
          onPick={(icon) => {
            onChange({ ...editor, marker: { ...marker, icon } });
          }}
        />
      )}
    </Field>
  );
}

/** A category row's marker: a button showing the class's icon that opens the picker. */
export function CategoryIconButton({
  marker,
  icon,
  color,
  label,
  icons,
  onPick,
}: {
  marker: Marker;
  icon: string;
  color: string;
  label: string;
  icons: MarkerIcons;
  onPick: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Marker for ${label}`}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded border border-input hover:bg-muted"
          />
        }
      >
        <MarkerSwatch icon={icon} color={color} uploads={icons.uploads} size={18} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <IconPicker
          kind={marker.kind === "shape" ? "shape" : "icon"}
          value={icon}
          color={color}
          icons={icons}
          onPick={(next) => {
            onPick(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function degrees(value: number): string {
  return `${value}°`;
}

function times(value: number): string {
  return `×${value}`;
}

/** Collapsed "Marker options": icon size, rotation, overlap, and (graduated) class sizes. */
export function MarkerOptionsSection({
  editor,
  onChange,
}: {
  editor: StyleEditor;
  onChange: (next: StyleEditor) => void;
}) {
  const { marker, renderer } = editor,
    icon = usesIcons(marker) ? marker : undefined,
    graduated = renderer.kind === "graduated",
    current: Marker =
      marker === undefined
        ? {
            allowOverlap: true,
            icon: DEFAULT_MARKER_ICON.icon,
            kind: "circle",
            rotation: 0,
            size: 18,
          }
        : marker,
    setMarker = (patch: Partial<Marker>) => {
      onChange({ ...editor, marker: { ...current, ...patch } });
    };
  if (icon === undefined && !graduated) {
    return null;
  }
  return (
    <Section
      title="Marker options"
      description={icon === undefined ? "Class sizes" : "Size, rotation, overlap"}
    >
      {icon !== undefined && (
        <>
          <RangeField
            id="style-marker-size"
            label="Marker size"
            value={icon.size}
            min={8}
            max={48}
            step={1}
            format={(value) => `${value}px`}
            onChange={(size) => {
              setMarker({ size });
            }}
          />
          <RangeField
            id="style-marker-rotation"
            label="Rotation"
            value={icon.rotation}
            min={0}
            max={359}
            step={1}
            format={degrees}
            onChange={(rotation) => {
              setMarker({ rotation });
            }}
          />
          <Field orientation="horizontal" className="items-center gap-2">
            <Checkbox
              id="style-marker-overlap"
              checked={icon.allowOverlap}
              onCheckedChange={(checked) => {
                setMarker({ allowOverlap: checked });
              }}
            />
            <FieldLabel htmlFor="style-marker-overlap" className="font-normal">
              Show every marker, even where they overlap
            </FieldLabel>
          </Field>
        </>
      )}
      {graduated && (
        <>
          <Field orientation="horizontal" className="items-center gap-2">
            <Checkbox
              id="style-marker-grow"
              checked={current.sizeScale !== undefined}
              onCheckedChange={(checked) => {
                if (checked) {
                  setMarker({ sizeScale: 2 });
                } else {
                  const { sizeScale: _scale, ...rest } = current;
                  onChange({ ...editor, marker: rest });
                }
              }}
            />
            <FieldLabel htmlFor="style-marker-grow" className="font-normal">
              Grow markers by class
            </FieldLabel>
          </Field>
          {current.sizeScale !== undefined && (
            <RangeField
              id="style-marker-scale"
              label="Largest class"
              value={current.sizeScale}
              min={1.25}
              max={4}
              step={0.25}
              format={times}
              onChange={(sizeScale) => {
                setMarker({ sizeScale });
              }}
            />
          )}
        </>
      )}
    </Section>
  );
}
