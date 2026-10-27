import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import type { DatasetActionsSlot, LayersMapExtension, LayersMapLayerArgs } from "#/features/maps";
import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { useEntryRowsBySchemas } from "#/lib/dataset-rows-react";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import type { LayerStyle } from "#convex/layerStyles/validators";

import { MarkerSwatch } from "./components/marker-swatch";
import { StyleMenu } from "./components/style-menu";
import { StylePanel } from "./components/style-panel";
import { FIELD_SEPARATOR, StyledLayer } from "./components/styled-layer";
import { fieldsOfStyle, tileLayers } from "./lib/expressions";
import type { UploadedIcon } from "./lib/icon-images";
import { withIconFallback } from "./lib/icons";
import { legendClasses, singleMarkerIcon, swatchColor } from "./lib/legend";

/** How long the editor waits after the last change before saving (slider drags coalesce). */
const SAVE_DEBOUNCE_MS = 400;

const NO_ROWS: readonly DatasetEntryRow[] = [];

export interface UseLayerStylesOptions {
  mapId: string;
  /** The render ids currently on the map. */
  renderIds: readonly string[];
  /** The dataset whose entries hold a render id's field values (a derived/chain layer's source; itself otherwise). */
  entrySourceFor: (renderId: string) => string;
  /** Render ids drawing from a tile archive (labels/data filters can't render there). */
  tileRenderIds: ReadonlySet<string>;
  /** The map's assigned colors — a fresh style starts from the dataset's current color. */
  colorBySchema: ReadonlyMap<string, string>;
  /**
   * The dataset's stored geometry type (`Point`, `Polygon`, …), if known —
   * the Marker picker only shows for datasets that may have points
   * (unknown or mixed counts as "may").
   */
  geometryTypeFor?: (renderId: string) => string | undefined;
}

const NON_POINT_TYPES = new Set(["LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

export interface UseLayerStylesResult {
  /** Plug into `LayersMap`'s `extension`. */
  extension: LayersMapExtension;
  /** Plug into `MapLayerPanel`'s `datasetActions`. */
  datasetActions: DatasetActionsSlot;
  /** Assigned colors with single-symbol styles' colors applied (layer-panel dots, legend swatches). */
  colorBySchema: Map<string, string>;
  /** Render anywhere on the page: the entry-value loaders (they draw nothing). */
  loaders: ReactNode;
  /** The Style panel while a dataset is being styled, else `null` — render it in the map's sidebar. */
  panel: ReactNode;
}

/** A style's previewed (unsaved) version wins over the saved one. */
function effectiveStyles(
  saved: ReadonlyArray<{ renderId: string; style: LayerStyle }> | undefined,
  previews: ReadonlyMap<string, LayerStyle | null>,
): Map<string, LayerStyle> {
  const styles = new Map<string, LayerStyle>();
  for (const row of saved === undefined ? [] : saved) {
    styles.set(row.renderId, row.style);
  }
  for (const [renderId, preview] of previews) {
    if (preview === null) {
      styles.delete(renderId);
    } else {
      styles.set(renderId, preview);
    }
  }
  return styles;
}

/** The assigned colors with each single-symbol style's color applied. */
function withSwatchColors(
  colorBySchema: ReadonlyMap<string, string>,
  styles: ReadonlyMap<string, LayerStyle>,
): Map<string, string> {
  const colors = new Map(colorBySchema);
  for (const [renderId, style] of styles) {
    const color = swatchColor(style);
    if (color !== undefined) {
      colors.set(renderId, color);
    }
  }
  return colors;
}

/** Each source dataset's needed fields: the styles' reads, plus "everything" for the dataset being edited. */
function neededFieldsBySource(
  styles: ReadonlyMap<string, LayerStyle>,
  renderIds: readonly string[],
  entrySourceFor: (renderId: string) => string,
): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  for (const renderId of renderIds) {
    const style = styles.get(renderId),
      fields = style === undefined ? [] : fieldsOfStyle(style);
    if (fields.length > 0) {
      const source = entrySourceFor(renderId),
        existing = bySource.get(source);
      bySource.set(
        source,
        existing === undefined ? fields : [...new Set([...existing, ...fields])],
      );
    }
  }
  return bySource;
}

/**
 * The layer-styles module's single integration hook (docs/layer-styles.md):
 * the map page calls it once and plugs its results into the two core
 * extension slots. Saved styles come from `api.layerStyles.styles`; edits
 * preview instantly and save debounced; field values load only for datasets
 * whose style reads fields (or that are open in the editor).
 */
export function useLayerStyles({
  mapId,
  renderIds,
  entrySourceFor,
  tileRenderIds,
  colorBySchema,
  geometryTypeFor,
}: UseLayerStylesOptions): UseLayerStylesResult {
  const saved = useQuery(api.layerStyles.styles.listForMap, { mapId }),
    uploadList = useQuery(api.layerStyles.icons.list, {}),
    uploadsReady = uploadList !== undefined,
    uploads = new Map<string, UploadedIcon>(
      (uploadList === undefined ? [] : uploadList).map((icon) => [icon.name, icon]),
    ),
    // A `user-*` icon is drawable once the upload list confirms it exists
    // (assumed while the list loads, so nothing flickers to circles).
    isIconAvailable = (name: string) =>
      !name.startsWith("user-") || !uploadsReady || uploads.has(name),
    saveStyle = useMutation(api.layerStyles.styles.set),
    resetStyle = useMutation(api.layerStyles.styles.reset),
    [previews, setPreviews] = useState<Map<string, LayerStyle | null>>(() => new Map()),
    [editing, setEditing] = useState<{ renderId: string; title: string } | undefined>(undefined),
    [saving, setSaving] = useState(false),
    pendingRef = useRef<{ renderId: string; style: LayerStyle } | undefined>(undefined),
    timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    styles = effectiveStyles(saved, previews),
    neededBySource = neededFieldsBySource(styles, renderIds, entrySourceFor),
    editingSource = editing === undefined ? undefined : entrySourceFor(editing.renderId),
    loadSourceIds = [
      ...new Set([
        ...neededBySource.keys(),
        ...(editingSource === undefined ? [] : [editingSource]),
      ]),
    ],
    { loaders, reportsBySchema } = useEntryRowsBySchemas(loadSourceIds, true);

  const clearPreview = useCallback((renderId: string) => {
    setPreviews((prev) => {
      if (!prev.has(renderId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(renderId);
      return next;
    });
  }, []);

  const flush = useCallback(async () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    const pending = pendingRef.current;
    if (pending === undefined) {
      return;
    }
    pendingRef.current = undefined;
    setSaving(true);
    try {
      await saveStyle({ mapId, renderId: pending.renderId, style: pending.style });
      // The saved row now carries this style; drop the preview unless a newer edit queued.
      if (pendingRef.current === undefined) {
        clearPreview(pending.renderId);
      }
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't save the style."));
      clearPreview(pending.renderId);
    } finally {
      setSaving(false);
    }
  }, [clearPreview, mapId, saveStyle]);

  // Save anything queued when the page unmounts.
  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  const handleChange = (renderId: string, style: LayerStyle) => {
      setPreviews((prev) => new Map(prev).set(renderId, style));
      pendingRef.current = { renderId, style };
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    handleReset = async (renderId: string) => {
      if (pendingRef.current !== undefined && pendingRef.current.renderId === renderId) {
        pendingRef.current = undefined;
      }
      setPreviews((prev) => new Map(prev).set(renderId, null));
      try {
        await resetStyle({ mapId, renderId });
        toast.success("Style reset to the map default.");
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't reset the style."));
      } finally {
        clearPreview(renderId);
      }
    };

  const effectiveColors = withSwatchColors(colorBySchema, styles);

  const rowsFor = (renderId: string): readonly DatasetEntryRow[] => {
    const report = reportsBySchema.get(entrySourceFor(renderId));
    return report === undefined ? NO_ROWS : report.rows;
  };

  const markerFor = (icon: string | undefined, color: string) =>
    icon === undefined || !isIconAvailable(icon) ? undefined : (
      <MarkerSwatch icon={icon} color={color} uploads={uploads} size={12} />
    );

  const extension: LayersMapExtension = {
    legendFor: (renderId) => {
      const style = styles.get(renderId),
        classes = style === undefined ? undefined : legendClasses(style);
      return classes === undefined
        ? undefined
        : classes.map((item) => ({
            color: item.color,
            label: item.label,
            marker: markerFor(item.icon, item.color),
          }));
    },
    legendSwatchFor: (renderId) => {
      const style = styles.get(renderId),
        color = effectiveColors.get(renderId);
      return style === undefined || color === undefined
        ? undefined
        : markerFor(singleMarkerIcon(style), color);
    },
    renderLayer: (args: LayersMapLayerArgs) => {
      const style = styles.get(args.renderId);
      if (style === undefined) {
        return undefined;
      }
      const drawable = withIconFallback(style.layers, isIconAvailable).layers,
        layers = args.source.kind === "tiles" ? tileLayers(drawable).layers : drawable;
      if (layers.length === 0) {
        return undefined;
      }
      return (
        <StyledLayer
          renderId={args.renderId}
          layers={layers}
          source={args.source}
          entryRows={rowsFor(args.renderId)}
          fieldsKey={fieldsOfStyle(style).join(FIELD_SEPARATOR)}
          visible={args.visible}
          uploads={uploads}
          uploadsReady={uploadsReady}
          onSelect={args.onSelect}
          onTileIdle={args.onTileIdle}
        />
      );
    },
  };

  const datasetActions: DatasetActionsSlot = ({ renderId, title }) => (
    <StyleMenu
      title={title}
      styled={styles.has(renderId)}
      onEdit={() => {
        setEditing({ renderId, title });
      }}
      onReset={() => {
        void handleReset(renderId);
      }}
    />
  );

  const editingReport =
      editingSource === undefined ? undefined : reportsBySchema.get(editingSource),
    editingStyle = editing === undefined ? undefined : styles.get(editing.renderId),
    editingGeometry =
      editing === undefined || geometryTypeFor === undefined
        ? undefined
        : geometryTypeFor(editing.renderId),
    panel =
      editing === undefined ? null : (
        <StylePanel
          key={editing.renderId}
          onClose={() => {
            void flush();
            setEditing(undefined);
          }}
          title={editing.title}
          style={editingStyle}
          mayHavePoints={editingGeometry === undefined || !NON_POINT_TYPES.has(editingGeometry)}
          uploads={uploads}
          uploadList={uploadList}
          missingIcons={
            editingStyle === undefined
              ? []
              : withIconFallback(editingStyle.layers, isIconAvailable).missing
          }
          defaultColor={colorBySchema.get(editing.renderId) ?? "#3b82f6"}
          rows={editingReport === undefined ? undefined : editingReport.rows}
          rowsComplete={editingReport !== undefined && editingReport.complete}
          rendersFromTiles={tileRenderIds.has(editing.renderId)}
          saving={saving || previews.has(editing.renderId)}
          onChange={(style) => {
            handleChange(editing.renderId, style);
          }}
          onReset={() => {
            void handleReset(editing.renderId);
          }}
        />
      );

  return {
    colorBySchema: effectiveColors,
    datasetActions,
    loaders,
    panel,
    extension,
  };
}
