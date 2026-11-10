import { Badge } from "@caden/ui/components/badge";
import { Skeleton } from "@caden/ui/components/skeleton";
import { Spinner } from "@caden/ui/components/spinner";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { useLayerStyles } from "#/features/layer-styles";
import {
  colorForIndex,
  LayersMap,
  MAP_TILE_ARCHIVE_FORMAT,
  pgGeometryToLayerRow,
  pgSummaryToDatasetSummary,
} from "#/features/maps";
import type { DatasetGeometryRow } from "#/lib/dataset-rows";
import type {
  AppMapSnapshot,
  AppSnapshotLayerVersion,
  AppVersionDefinition,
} from "#/lib/store/app-versions";
import { sharedClient } from "#/lib/store/client";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import { createTileArchiveUrl } from "#/lib/store/geometries";
import type { GeometryRow } from "#/lib/store/geometries";
import { versionEntriesQueryOptions } from "#/lib/store/versions";

/**
 * A published app's map widget canvas (issue #259; D7) — renders the frozen
 * map snapshot, never the live map. Placements resolve through the
 * snapshot's flattened `layerVersions` list (groups recurse through their
 * frozen children). Every style comes from the frozen definition, and the
 * data comes from the pinned versions by one of two paths (#261): a dataset
 * whose pin carries a servable frozen-archive stamp draws TILES (built at
 * publish from exactly this version's rows — anon-readable under migration
 * 0024's policy; a signing failure or old-format stamp falls back to rows),
 * everything else pages the immutable `version_entries` rows. This is the
 * render half of "editing the live map afterwards does not change the
 * published app until republish".
 */

/** How deep the frozen resolver descends before stopping (the store's guard bounds real trees; this is the render-side belt). */
const RESOLVE_DEPTH_LIMIT = 16;

/** One frozen data layer to draw: its render id (the dataset), its pinned rows source, and its frozen paint. */
interface FrozenEntry {
  layerVersionId: string;
  renderId: string;
  style: unknown;
  title: string;
  /** The pinned dataset version — null means the layer's data never published (nothing draws). */
  versionId: string | null;
  visible: boolean;
}

/** The versions list as a lookup (built once per render from the snapshot array). */
function versionsByIdOf(
  layerVersions: AppSnapshotLayerVersion[],
): Map<string, AppSnapshotLayerVersion> {
  return new globalThis.Map(layerVersions.map((version) => [version.versionId, version]));
}

/** Flattens one placed layer version into its data entries (groups recurse through frozen children). */
// oxlint-disable-next-line eslint/complexity -- the frozen kind ladder (data/group, visibility chain) is the resolver's contract, stated once.
function entriesOfVersion(
  versionId: string,
  visible: boolean,
  depth: number,
  versionsById: ReadonlyMap<string, AppSnapshotLayerVersion>,
): FrozenEntry[] {
  if (depth > RESOLVE_DEPTH_LIMIT) {
    return [];
  }
  const version = versionsById.get(versionId);
  if (version === undefined) {
    return [];
  }
  if (version.kind === "data") {
    if (!visible || version.dataset === null) {
      return [];
    }
    const definitionVisible = version.definition["visible"],
      style = version.definition["style"],
      name = version.definition["name"];
    return [
      {
        layerVersionId: version.versionId,
        renderId: version.dataset.datasetId,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- style rides the definition's shapeless jsonb; the layer-styles validators own its shape.
        style,
        title: typeof name === "string" ? name : "Layer",
        versionId: version.dataset.versionId === "" ? null : version.dataset.versionId,
        visible: visible && definitionVisible !== false,
      },
    ];
  }
  return (version.frozenChildren ?? []).flatMap((child) =>
    entriesOfVersion(child.versionId, visible, depth + 1, versionsById),
  );
}

/** A version_entries row as the geometry pipeline's input row (frozen rows are inline-only — no sourcePath). */
function frozenRowOf(
  row: {
    bbox: number[] | null;
    data: unknown;
    entryId: string | null;
    geometry: unknown;
    geometryType: string | null;
  },
  datasetId: string,
): GeometryRow {
  return {
    bbox: row.bbox,
    data: row.data,
    datasetId,
    entryId: row.entryId ?? "",
    geometry: row.geometry,
    sourcePath: null,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the PG type union allows "GeometryCollection"; the app never writes one (the same narrowing posture as pgGeometryToLayerRow's).
    type: (row.geometryType ?? "Point") as GeometryRow["type"],
  };
}

/** One frozen entry's immutable rows, paged to exhaustion and reported up (the PgGeometriesLoader shape, scoped). */
function FrozenLayerRows({
  datasetId,
  onLoaded,
  versionId,
}: {
  datasetId: string;
  onLoaded: (datasetId: string, rows: DatasetGeometryRow[] | undefined) => void;
  versionId: string;
}) {
  const page = useInfiniteQuery({
    queryKey: ["pg:versions", "appFrozenRows", versionId],
    queryFn: async ({ pageParam }) => {
      const options = versionEntriesQueryOptions({ cursor: pageParam, versionId }),
        fn = options.queryFn;
      if (fn === undefined) {
        throw new Error("The version-entries read carries no queryFn.");
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context (the pg-app-publish note).
      return await fn({} as never);
    },
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  useEffect(() => {
    if (page.hasNextPage && !page.isFetchingNextPage) {
      void page.fetchNextPage();
    }
  }, [page]);
  useEffect(() => {
    if (page.data === undefined) {
      return;
    }
    const rows = page.data.pages.flatMap((one) =>
      one.rows.map((row) => pgGeometryToLayerRow(frozenRowOf(row, datasetId), row.geometry)),
    );
    onLoaded(datasetId, rows);
    return () => {
      onLoaded(datasetId, undefined);
    };
  }, [datasetId, onLoaded, page.data]);
  return null;
}

/** The pin list as the summaries LayersMap reads (titles + frozen extents for the one fit). */
function pinSummariesOf(
  datasetIds: readonly string[],
  datasetPins: AppVersionDefinition["datasetPins"],
): DatasetSummaryRow[] {
  return datasetIds.flatMap((datasetId) => {
    const pin = datasetPins.find((candidate) => candidate.datasetId === datasetId);
    if (pin === undefined) {
      return [];
    }
    return [
      {
        bbox: pin.bbox as DatasetSummaryRow["bbox"],
        createdAt: "",
        createdBy: "",
        description: null,
        editPolicy: "open",
        entryCount: 0,
        featureCount: 0,
        fieldCount: 0,
        geometryType: (pin.geometryType ?? null) as DatasetSummaryRow["geometryType"],
        groupId: null,
        id: pin.datasetId,
        isGeospatial: pin.isGeospatial,
        lifecycle: "published",
        lineage: null,
        kind: "source",
        refreshMode: null,
        stale: false,
        mapTileArchiveBuiltVersion: null,
        mapTileArchiveBytes: null,
        mapTileArchiveFormat: null,
        mapTileArchiveMaxZoom: null,
        mapTileCacheVersion: 0,
        visibility: "signed-in",
        source: null,
        title: pin.title ?? "Unavailable dataset",
      } satisfies DatasetSummaryRow,
    ];
  });
}

/** A snapshot pin's archive stamp as a servable tile pointer: present only when the stamp matches this build's layout generation (the #125 format gate — an old-format stamp reads as "no archive", rows render). */
function servableArchiveOf(
  datasetId: string,
  datasetPins: AppVersionDefinition["datasetPins"],
): { datasetId: string; path: string } | undefined {
  const pin = datasetPins.find((candidate) => candidate.datasetId === datasetId);
  if (pin === undefined || pin.archive === null || pin.archive === undefined) {
    return undefined;
  }
  if (pin.archive.format !== MAP_TILE_ARCHIVE_FORMAT) {
    return undefined;
  }
  return { datasetId, path: pin.archive.path };
}

export function FrozenMapCanvas({
  datasetPins,
  layerVersions,
  snapshot,
}: {
  datasetPins: AppVersionDefinition["datasetPins"];
  layerVersions: AppSnapshotLayerVersion[];
  snapshot: AppMapSnapshot;
}) {
  const versionsById = versionsByIdOf(layerVersions),
    // Draw order follows the placements' order (bottom to top), groups flatten.
    entries = snapshot.placements
      .toSorted((a, b) => a.order - b.order)
      .flatMap((placement) =>
        entriesOfVersion(placement.versionId, placement.visible, 0, versionsById),
      ),
    drawable = entries.filter((entry) => entry.versionId !== null && entry.visible),
    // The #261 split: a dataset whose pin carries a servable frozen archive
    // draws TILES (the publish walk built them from exactly this version's
    // rows — anon-readable under migration 0024's policy); everything else
    // pages immutable rows as before.
    tileArchives = [
      ...new globalThis.Map(
        drawable.flatMap((entry) => {
          const archive = servableArchiveOf(entry.renderId, datasetPins);
          return archive === undefined ? [] : [[archive.datasetId, archive] as const];
        }),
      ).values(),
    ],
    archiveQueries = useQueries({
      queries: tileArchives.map((archive) => ({
        // The 24 h TTL dwarfs staleTime; a re-sign on remount is one cheap
        // storage round trip.
        queryFn: async () => await createTileArchiveUrl(sharedClient(), archive.path),
        queryKey: ["pg:tile-archives", "frozen-sign", archive.datasetId, archive.path],
        retry: false,
        staleTime: 20 * 60 * 1000,
      })),
    }),
    signedUrlByDataset = new globalThis.Map(
      tileArchives.flatMap((archive, index) => {
        const query = archiveQueries[index];
        return query !== undefined && typeof query.data === "string"
          ? [[archive.datasetId, query.data] as const]
          : [];
      }),
    ),
    tileDatasetIds = new Set(tileArchives.map((archive) => archive.datasetId)),
    tileSourcesPending = tileArchives.some((archive) => !signedUrlByDataset.has(archive.datasetId)),
    rowEntries = drawable.filter((entry) => !tileDatasetIds.has(entry.renderId)),
    [rowsByDataset, setRowsByDataset] = useState<
      globalThis.Map<string, DatasetGeometryRow[] | undefined>
    >(() => new globalThis.Map()),
    // Reference-stable across renders (the useGeometriesByPgDatasets doc
    // explains why a fresh identity here would loop the loaders' effects).
    // oxlint-disable-next-line react/preserve-manual-memoization -- the stable-setter + bail-out dedupe shape verbatim (see the loader); the compiler cannot prove the stable identity across the loaders' effects.
    handleLoaded = useCallback(
      (datasetId: string, rows: DatasetGeometryRow[] | undefined) => {
        setRowsByDataset((prev) => {
          const existing = prev.get(datasetId);
          if (existing === rows) {
            return prev;
          }
          return new globalThis.Map(prev).set(datasetId, rows);
        });
      },
      // oxlint-disable-next-line react/preserve-manual-memoization -- see the comment above.
      [setRowsByDataset],
    ),
    rowDatasetIds = [...new Set(rowEntries.map((entry) => entry.renderId))],
    [arrivedTileDatasetIds, setArrivedTileDatasetIds] = useState<Set<string>>(
      () => new Set<string>(),
    ),
    rowDatasetsComplete = rowDatasetIds.every(
      (datasetId) => rowsByDataset.get(datasetId) !== undefined,
    ),
    tileDatasetsComplete = [...tileDatasetIds].every((datasetId) =>
      arrivedTileDatasetIds.has(datasetId),
    ),
    geometries = rowDatasetIds.flatMap((datasetId) => rowsByDataset.get(datasetId) ?? []),
    summaries = pinSummariesOf([...new Set(entries.map((entry) => entry.renderId))], datasetPins),
    pinTitleById = new globalThis.Map(
      datasetPins.map((pin) => [pin.datasetId, pin.title ?? "Unavailable dataset"]),
    ),
    layerStyles = useLayerStyles({
      colorBySchema: new globalThis.Map(
        drawable.map((entry, index) => [entry.renderId, colorForIndex(index)]),
      ),
      entrySourceFor: (renderId) => renderId,
      geometryTypeFor: (renderId) => {
        const pin = datasetPins.find((candidate) => candidate.datasetId === renderId);
        return pin === undefined || pin.geometryType === null ? undefined : pin.geometryType;
      },
      resetStyle: async () => {
        throw new Error("The published app shows the frozen map — republish to restyle it.");
      },
      saved: drawable.flatMap((entry) =>
        typeof entry.style === "object" &&
        entry.style !== null &&
        Object.keys(entry.style as object).length > 0
          ? [{ renderId: entry.renderId, style: entry.style }]
          : [],
      ),
      saveStyle: async () => {
        throw new Error("The published app shows the frozen map — republish to restyle it.");
      },
      renderIds: [...new Set(entries.map((entry) => entry.renderId))],
      tileRenderIds: tileDatasetIds,
    });

  if (entries.length === 0) {
    return (
      <div className="flex size-full items-center justify-center bg-muted/40 px-6 text-center text-sm text-muted-foreground">
        This map&apos;s layers aren&apos;t part of the published snapshot.
      </div>
    );
  }

  const tileSources = tileArchives.flatMap((archive) => {
      const url = signedUrlByDataset.get(archive.datasetId);
      // MapVectorTiles' PMTiles sources ride the `pmtiles://` protocol scheme
      // (the layer-source decision's shape — the bare signed URL alone is
      // not a loadable maplibre URL).
      return url === undefined ? [] : [{ schemaId: archive.datasetId, url: `pmtiles://${url}` }];
    }),
    shouldMount =
      (rowDatasetIds.length === 0 && tileSources.length === 0 && !tileSourcesPending) ||
      geometries.length > 0 ||
      tileSources.length > 0;
  return (
    <div className="relative size-full overflow-hidden">
      {rowEntries.map((entry) => (
        <FrozenLayerRows
          datasetId={entry.renderId}
          key={entry.layerVersionId}
          onLoaded={handleLoaded}
          versionId={entry.versionId ?? ""}
        />
      ))}
      {shouldMount ? (
        <LayersMap
          chainLayers={[]}
          colorBySchema={layerStyles.colorBySchema}
          datasets={summaries.map(pgSummaryToDatasetSummary)}
          derivedLayers={[]}
          extension={layerStyles.extension}
          geometries={geometries}
          onTileSourceIdle={(datasetId) => {
            setArrivedTileDatasetIds((prev) => {
              if (prev.has(datasetId)) {
                return prev;
              }
              return new globalThis.Set(prev).add(datasetId);
            });
          }}
          sourcesPending={tileSourcesPending}
          tileSources={tileSources}
          titlesById={pinTitleById}
          visibleSchemaIds={new Set(drawable.map((entry) => entry.renderId))}
        />
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
      {!(rowDatasetsComplete && tileDatasetsComplete) && (
        <Badge variant="outline" className="absolute top-3 left-3 z-10 bg-card shadow-sm">
          <Spinner data-icon="inline-start" />
          Loading features…
        </Badge>
      )}
    </div>
  );
}
