import { fieldsOfStyle, tileLayers } from "@caden/layer-styles/expressions";
import { withIconFallback } from "@caden/layer-styles/icons";
import { legendClasses, singleMarkerIcon, swatchColor } from "@caden/layer-styles/legend";
import type { LayerStyle } from "@caden/layer-styles/validators";
import { useQuery as useStoreQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ReactElement } from "react";
import { toast } from "sonner";

import type { LayersMapExtension, LayersMapLayerArgs } from "#/features/maps";
import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { errorMessage } from "#/lib/errors";
import {
  listIconsQueryOptions,
  removeIcon as removeIconStore,
  uploadIcon as uploadIconStore,
} from "#/lib/store/layer-styles";

import type { MarkerIcons } from "./components/marker-section";
import type { MarkerIconActions, UploadIconMeta } from "./components/marker-section";
import { MarkerSwatch } from "./components/marker-swatch";
import { usePgEntryRowsBySchemas } from "./components/pg-entries-loader";
import { StyleMenu } from "./components/style-menu";
import { StylePanel } from "./components/style-panel";
import { FIELD_SEPARATOR, StyledLayer } from "./components/styled-layer";
import type { UploadedIcon } from "./lib/icon-images";

/** How long the editor waits after the last change before saving (slider drags coalesce). */
const SAVE_DEBOUNCE_MS = 400;

const NON_POINT_TYPES = new Set(["LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

const NO_ROWS: readonly DatasetEntryRow[] = [];

export interface UseLayerStylesOptions {
  /**
   * The saved layer styles, render-keyed by the caller (ADR 0019: styles
   * live ON the layer rows — renderId = the layer's dataset id, style = the
   * layer's stored fragment). The hook merges previews over them.
   */
  saved: ReadonlyArray<{ renderId: string; style: unknown }> | undefined;
  /** The debounced flush's save — the caller's layers-store update (it owns the invalidation). */
  saveStyle: (args: { renderId: string; style: LayerStyle }) => Promise<void>;
  /** Reset to the assigned-color default — the caller writes the layer's style back to `{}`. */
  resetStyle: (args: { renderId: string }) => Promise<void>;
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

/**
 * The per-render-id style trigger the map's OWN layer rows render (the
 * ⋯ menu that opens the editor) — the styling module's own contract now
 * that the placements panel lives in the route (ADR 0019).
 */
export type StyleActionsSlot = (target: { renderId: string; title: string }) => ReactElement | null;

export interface UseLayerStylesResult {
  /** Plug into `LayersMap`'s `extension`. */
  extension: LayersMapExtension;
  /** Render beside an OWNED data layer row (linked rows are read-only — the caller skips them). */
  datasetActions: StyleActionsSlot;
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

/** A saved-styles read (the caller's layer-keyed rows) narrowed to the preview merge's row shape. */
function savedRowsOf(
  saved: ReadonlyArray<{ renderId: string; style: unknown }> | undefined,
): Array<{ renderId: string; style: LayerStyle }> | undefined {
  if (saved === undefined) {
    return undefined;
  }
  const rows: Array<{ renderId: string; style: LayerStyle }> = [];
  for (const row of saved) {
    const style = row.style;
    if (typeof style === "object" && style !== null) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the style jsonb is the validators-validated document by contract (ADR 0012); the runtime object check is the read-side guard.
      rows.push({ renderId: row.renderId, style: style as LayerStyle });
    }
  }
  return rows;
}

/** An uploads read (either backend) as the picker's icon list. */
function uploadsOf(saved: ReadonlyArray<UploadedIcon> | undefined): Array<UploadedIcon> {
  return saved === undefined ? [] : [...saved];
}

/** A `user-*` icon is drawable once the upload list confirms it exists (assumed while the list loads, so nothing flickers to circles). */
function isIconAvailable(
  name: string,
  uploads: ReadonlyMap<string, UploadedIcon>,
  uploadsReady: boolean,
): boolean {
  return !name.startsWith("user-") || !uploadsReady || uploads.has(name);
}

/**
 * The layer-styles module's single integration hook (docs/layer-styles.md):
 * the map page calls it once and plugs its results into the two core
 * extension slots. Styles live ON the layer rows (ADR 0019 — the caller
 * passes the placed layers' fragments render-keyed and the save/reset
 * callbacks that write them); icons, uploads and entry reads ride the
 * store modules. The per-`(mapId, renderId)` layer_styles storage retired
 * with the table (the pre-layers approximation).
 *
 * Edits preview instantly and save debounced (400 ms); field values load
 * only for datasets whose style reads fields (or that are open in the
 * editor).
 */
// oxlint-disable-next-line eslint/complexity -- the styling wiring (extension + datasetActions + panel + loaders) is the hook's real shape; the decomposition is the deferred phase-2 cleanup, as in the route workspaces.
export function useLayerStyles({
  saved,
  saveStyle,
  resetStyle,
  renderIds,
  entrySourceFor,
  tileRenderIds,
  colorBySchema,
  geometryTypeFor,
}: UseLayerStylesOptions): UseLayerStylesResult {
  // ---- saved styles (the caller's layer-keyed rows) + uploads (the store) ----
  const pgUploadList = useStoreQuery({ ...listIconsQueryOptions() }),
    queryClient = useQueryClient(),
    actions: MarkerIconActions = {
      removeUpload: async (iconId) => {
        await removeIconStore({ iconId });
        void queryClient.invalidateQueries({ queryKey: ["pg:layer-styles"] });
      },
      uploadIcon: async (png: Blob, meta: UploadIconMeta) => {
        try {
          const result = await uploadIconStore({
            height: meta.height,
            label: meta.label,
            png,
            pixelRatio: meta.pixelRatio,
            sdf: meta.sdf,
            width: meta.width,
          });
          if (!result.ok) {
            return { error: result.error, ok: false };
          }
          void queryClient.invalidateQueries({ queryKey: ["pg:layer-styles"] });
          return { name: result.name, ok: true };
        } catch (error) {
          return { error: errorMessage(error, "Couldn't upload the icon."), ok: false };
        }
      },
    },
    // ---- the uploads list as the pickers read it ----
    uploads = new Map(uploadsOf(pgUploadList.data).map((icon) => [icon.name, icon])),
    uploadsReady = pgUploadList.isSuccess,
    // ---- editor state (before the styles derivation the loaders need) ----
    [previews, setPreviews] = useState<Map<string, LayerStyle | null>>(() => new Map()),
    [editing, setEditing] = useState<{ renderId: string; title: string } | undefined>(undefined),
    [saving, setSaving] = useState(false),
    pendingRef = useRef<{ renderId: string; style: LayerStyle } | undefined>(undefined),
    timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    // ---- styles + the entry sources whose field values they read ----
    styles = effectiveStyles(savedRowsOf(saved), previews),
    neededBySource = neededFieldsBySource(styles, renderIds, entrySourceFor),
    editingSource = editing === undefined ? undefined : entrySourceFor(editing.renderId),
    loadSourceIds = [
      ...new Set([
        ...neededBySource.keys(),
        ...(editingSource === undefined ? [] : [editingSource]),
      ]),
    ],
    // ---- field-value loaders ----
    { loaders, reportsBySchema } = usePgEntryRowsBySchemas(loadSourceIds, true);

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

  // The unmount flush requires a stable callback; the compiler cannot prove
  // the QueryClient object stable (provider-created, never mutated in
  // place). The store write MUST invalidate post-save — dropping the
  // invalidation would revert the map to the pre-save cached style once the
  // preview clears (the two suppressions below cover the callback and its
  // deps).
  // oxlint-disable-next-line react/preserve-manual-memoization
  const flush = useCallback(
    async () => {
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
        await saveStyle({ renderId: pending.renderId, style: pending.style });
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
    },
    // oxlint-disable-next-line react/preserve-manual-memoization -- see the comment above.
    [clearPreview, saveStyle],
  );

  // Save anything queued when the page unmounts.
  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  const handleReset = async (renderId: string) => {
      if (pendingRef.current !== undefined && pendingRef.current.renderId === renderId) {
        pendingRef.current = undefined;
      }
      setPreviews((prev) => new Map(prev).set(renderId, null));
      try {
        await resetStyle({ renderId });
        toast.success("Style reset to the assigned colors.");
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't reset the style."));
      } finally {
        clearPreview(renderId);
      }
    },
    handleChange = (renderId: string, style: LayerStyle) => {
      setPreviews((prev) => new Map(prev).set(renderId, style));
      pendingRef.current = { renderId, style };
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        void flush();
      }, SAVE_DEBOUNCE_MS);
    };

  const effectiveColors = withSwatchColors(colorBySchema, styles),
    rowsFor = (renderId: string): readonly DatasetEntryRow[] => {
      const report = reportsBySchema.get(entrySourceFor(renderId));
      return report === undefined ? NO_ROWS : report.rows;
    },
    markerFor = (icon: string | undefined, color: string) =>
      icon === undefined || !isIconAvailable(icon, uploads, uploadsReady) ? undefined : (
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
      const drawable = withIconFallback(style.layers, (name) =>
          isIconAvailable(name, uploads, uploadsReady),
        ).layers,
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

  const datasetActions: StyleActionsSlot = ({ renderId, title }) => (
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
    uploadList = uploadsOf(pgUploadList.data),
    icons: MarkerIcons = { actions, uploadList, uploads },
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
          uploads={icons.uploads}
          uploadList={icons.uploadList}
          actions={icons.actions}
          missingIcons={
            editingStyle === undefined
              ? []
              : withIconFallback(editingStyle.layers, (name) =>
                  isIconAvailable(name, uploads, uploadsReady),
                ).missing
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
