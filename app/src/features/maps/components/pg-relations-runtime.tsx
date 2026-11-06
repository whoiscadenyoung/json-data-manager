import { buildFeatureCollection } from "@caden/json-cms/react";
import type { Geometry } from "@caden/json-cms/react";
import { MapClusterLayer, MapGeoJSON } from "@caden/ui/components/map";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Fragment, useState } from "react";

import type { FeatureSelection } from "#/lib/dataset-rows-react";
import { formatPropertyValue } from "#/lib/format";
import * as relationsStore from "#/lib/store/relations";
import type { DatasetRelationRow } from "#/lib/store/relations";

import { buildPointFeatureCollection } from "../lib/point-geometry";

/**
 * The relation-aware map runtime (issue #258 — the project-centric train's
 * phase 4; ADR 0020). Opt-in through `LayersMap`'s `relationRuntime` prop:
 * the in-project editor mounts it; surfaces without it (and the app map
 * widget until [project 5]) pay nothing.
 *
 * Three pieces, one per concern:
 *   - `useRelationsRuntime` resolves the selection's clicked-side dataset
 *     (derived/chain layers resolve through their SOURCE dataset — relations
 *     are dataset-ended), reads the relations touching the map's datasets,
 *     and narrows to the ones touching the click. Titles for relation ends
 *     ride the caller's `titlesById` (the editor's summaries read covers
 *     every visible dataset, which is every relation end its viewer can
 *     see — the both-ends visibility rule).
 *   - `PgRelatedRecordsPanel` renders the popup's related-records section:
 *     one `PgRelatedRecordsSection` per touching relation, each owning its
 *     bounded query (`dataset_relation_records` RPC — index-backed,
 *     viewport-scoped for spatial, server-capped) and its "show more"
 *     offset. Cardinality shapes the render: 1-1 inlines the matched
 *     record's fields namespaced by the other dataset's title; 1-N and N-M
 *     list rows.
 *   - `PgRelationHighlight` draws the related set as an amber overlay (one
 *     per touching relation). It shares the section's first-page query key,
 *     so one fetch serves both; clicks on highlighted points drill in
 *     (cross-highlight, the Power BI posture).
 */

/** The highlight overlay's paint — amber, unmistakably not a dataset color. */
const HIGHLIGHT_COLOR = "#f59e0b";

/** The related-records list's per-row field cap (identity fields, not the whole row). */
const SUMMARY_FIELD_COUNT = 3;

/** The 1-1 inline's namespaced-field cap. */
const INLINE_FIELD_COUNT = 6;

/** A viewport bbox at click time — [minLon, minLat, maxLon, maxLat] (the RPC's spatial scope). */
export type ViewportBbox = [number, number, number, number];

/** What a surface passes to opt in (the in-project editor passes its project). */
export interface RelationRuntimeOptions {
  projectId: string;
}

/** One relation touching the clicked feature, with the other side resolved. */
export interface TouchingRelation {
  /** The clicked side's source dataset (what the RPC validates against). */
  clickedDatasetId: string;
  otherDatasetId: string;
  otherTitle: string;
  relation: DatasetRelationRow;
}

/** Render id → source dataset id (derived + chain re-keying; plain ids pass through). */
export function sourceDatasetOfRenderId(
  renderId: string,
  derivedLayers: ReadonlyArray<{ derivedId: string; sourceSchemaId: string }>,
  chainLayers: ReadonlyArray<{ renderId: string; sourceSchemaId: string }>,
): string {
  for (const derived of derivedLayers) {
    if (derived.derivedId === renderId) {
      return derived.sourceSchemaId;
    }
  }
  for (const chain of chainLayers) {
    if (chain.renderId === renderId) {
      return chain.sourceSchemaId;
    }
  }
  return renderId;
}

/**
 * Resolves the relations touching the current selection. `loading` covers
 * the relations-list read only (each section's own query reports its own).
 */
// The resolution walk (clicked-side source mapping, then the from/to
// narrowing with titles) is the runtime's whole contract, read top to bottom;
// splitting it would scatter one resolution across helpers with shared
// closures.
// oxlint-disable-next-line eslint/complexity -- the resolution walk is the contract, stated once.
export function useRelationsRuntime(args: {
  /** The map's source-dataset ids (render ids resolved through the re-key maps). */
  datasetIds: readonly string[];
  chainLayers: ReadonlyArray<{ renderId: string; sourceSchemaId: string }>;
  derivedLayers: ReadonlyArray<{ derivedId: string; sourceSchemaId: string }>;
  runtime: RelationRuntimeOptions | undefined;
  selected: FeatureSelection | undefined;
  titlesById: globalThis.Map<string, string>;
}): { loading: boolean; touching: TouchingRelation[] } {
  const clickedDatasetId =
      args.selected === undefined
        ? undefined
        : sourceDatasetOfRenderId(args.selected.schemaId, args.derivedLayers, args.chainLayers),
    relationsQuery = useQuery({
      ...relationsStore.listForDatasetsQueryOptions({ datasetIds: args.datasetIds }),
      enabled: args.runtime !== undefined && args.datasetIds.length > 0,
    });
  if (args.runtime === undefined || clickedDatasetId === undefined) {
    return { loading: false, touching: [] };
  }
  const relations = relationsQuery.data;
  if (relations === undefined) {
    return { loading: true, touching: [] };
  }
  const touching: TouchingRelation[] = [];
  for (const relation of relations) {
    const other =
      relation.fromDataset === clickedDatasetId
        ? relation.toDataset
        : relation.toDataset === clickedDatasetId
          ? relation.fromDataset
          : undefined;
    if (other === undefined) {
      continue;
    }
    touching.push({
      clickedDatasetId,
      otherDatasetId: other,
      otherTitle: args.titlesById.get(other) ?? "Related dataset",
      relation,
    });
  }
  return { loading: false, touching };
}

/** The bounded per-relation records query — one key shared by the section and the highlight at the same offset. */
function useRelatedRecordsQuery(args: {
  bbox: ViewportBbox | undefined;
  clickedDatasetId: string;
  item: TouchingRelation;
  limit: number;
  offset: number;
  runtime: RelationRuntimeOptions;
  selected: FeatureSelection;
}) {
  return useQuery({
    ...relationsStore.relatedRecordsQueryOptions({
      // The RPC demands a viewport bbox on the spatial path; the key path
      // needs none. A click without bounds skips the spatial query
      // (enabled below) rather than asking the server for an error.
      bbox: args.item.relation.kind === "spatial" ? args.bbox : undefined,
      datasetId: args.clickedDatasetId,
      entryId: args.selected.entryId,
      limit: args.limit,
      offset: args.offset,
      projectId: args.runtime.projectId,
      relationId: args.item.relation.id,
    }),
    enabled: args.item.relation.kind !== "spatial" || args.bbox !== undefined,
  });
}

/** The popup panel's related-records slot — the touching relations' sections, or nothing. */
export function PgRelatedRecordsPanel(props: {
  bbox: ViewportBbox | undefined;
  loading: boolean;
  runtime: RelationRuntimeOptions;
  selected: FeatureSelection;
  touching: TouchingRelation[];
}) {
  if (props.touching.length === 0) {
    if (!props.loading) {
      return null;
    }
    return (
      <div className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading related records…
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Related records
      </p>
      {props.touching.map((item) => (
        <PgRelatedRecordsSection
          bbox={props.bbox}
          item={item}
          key={item.relation.id}
          runtime={props.runtime}
          selected={props.selected}
        />
      ))}
    </div>
  );
}

/** One touching relation's section: its bounded answer, cardinality-shaped, with "show more". */
function PgRelatedRecordsSection(props: {
  bbox: ViewportBbox | undefined;
  item: TouchingRelation;
  runtime: RelationRuntimeOptions;
  selected: FeatureSelection;
}) {
  const [offset, setOffset] = useState(0),
    query = useRelatedRecordsQuery({
      bbox: props.bbox,
      clickedDatasetId: props.item.clickedDatasetId,
      item: props.item,
      limit: relationsStore.RELATED_RECORDS_LIMIT,
      offset,
      runtime: props.runtime,
      selected: props.selected,
    }),
    rows = query.data;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">{props.item.otherTitle}</span>
        <span className="text-muted-foreground">
          {props.item.relation.kind === "key" ? "key join" : "spatial"}
          {" · "}
          {props.item.relation.cardinality}
        </span>
      </p>
      {query.isError ? (
        <p className="text-xs text-destructive">Couldn't load the related records.</p>
      ) : query.isPending ? (
        query.fetchStatus === "idle" ? (
          // The spatial query is parked (no viewport bounds at click time) —
          // honest state, never a spinner that never resolves.
          <p className="text-xs text-muted-foreground">Pan the map and click again.</p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </p>
        )
      ) : rows === undefined || rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No related records.</p>
      ) : (
        <>
          {props.item.relation.cardinality === "1-1" ? (
            <PgInlineRecordFields
              fields={inlineFields(rows[0].data, props.item)}
              otherTitle={props.item.otherTitle}
            />
          ) : (
            rows.map((row) => (
              <div
                className="flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5"
                key={row.entry_id}
              >
                {summaryFields(row.data, props.item).map(([key, value]) => (
                  <div className="flex items-baseline justify-between gap-2" key={key}>
                    <span className="shrink-0 text-xs text-muted-foreground">{key}</span>
                    <span className="truncate text-xs">{formatPropertyValue(value)}</span>
                  </div>
                ))}
              </div>
            ))
          )}
          {rows[rows.length - 1].has_more && (
            <button
              className="self-start text-xs font-medium text-primary hover:underline"
              onClick={() => {
                setOffset(offset + relationsStore.RELATED_RECORDS_LIMIT);
              }}
              type="button"
            >
              Show more
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The 1-1 inline: the matched record's fields, namespaced by the other dataset's title. */
function PgInlineRecordFields(props: { fields: Array<[string, unknown]>; otherTitle: string }) {
  if (props.fields.length === 0) {
    return <p className="text-xs text-muted-foreground">No related record.</p>;
  }
  return (
    <dl className="flex flex-col gap-1 rounded-md border px-2.5 py-1.5">
      {props.fields.map(([key, value]) => (
        <div className="flex items-baseline justify-between gap-2" key={key}>
          <dt className="shrink-0 text-xs text-muted-foreground">
            {props.otherTitle}.{key}
          </dt>
          <dd className="truncate text-xs">{formatPropertyValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The relation's preferred field names for a clicked side (the key fields, side-swapped). */
function preferredKeys(item: TouchingRelation): string[] {
  if (item.relation.kind !== "key") {
    return [];
  }
  if (
    typeof item.relation.config !== "object" ||
    item.relation.config === null ||
    Array.isArray(item.relation.config)
  ) {
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record guard above is the runtime check; the key config's documented shape is the contract.
  const config = item.relation.config as Record<string, unknown>,
    fromKey = typeof config.fromKey === "string" ? config.fromKey : undefined,
    toKey = typeof config.toKey === "string" ? config.toKey : undefined;
  if (fromKey === undefined || toKey === undefined) {
    return [];
  }
  return item.relation.fromDataset === item.clickedDatasetId ? [toKey] : [fromKey];
}

/** A related row's display fields: the relation's key fields first, then the row's own order, capped. */
function summaryFields(
  data: Record<string, unknown> | undefined,
  item: TouchingRelation,
): Array<[string, unknown]> {
  if (data === undefined) {
    return [];
  }
  const out: Array<[string, unknown]> = [];
  for (const key of preferredKeys(item)) {
    const value = data[key];
    if (value !== undefined && value !== null) {
      out.push([key, value]);
    }
    if (out.length >= SUMMARY_FIELD_COUNT) {
      return out;
    }
  }
  for (const entry of Object.entries(data)) {
    if (out.length >= SUMMARY_FIELD_COUNT) {
      break;
    }
    if (!out.some(([key]) => key === entry[0])) {
      out.push(entry);
    }
  }
  return out;
}

/** The 1-1 inline's namespaced fields (the matched record's, capped). */
function inlineFields(
  data: Record<string, unknown> | undefined,
  item: TouchingRelation,
): Array<[string, unknown]> {
  if (data === undefined) {
    return [];
  }
  const preferred = preferredKeys(item),
    out: Array<[string, unknown]> = [];
  for (const entry of Object.entries(data)) {
    if (out.length >= INLINE_FIELD_COUNT) {
      break;
    }
    if (preferred.includes(entry[0])) {
      out.unshift(entry);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** The related set's amber highlight overlay (one per touching relation). Shares the section's first-page query. */
export function PgRelationHighlight(props: {
  bbox: ViewportBbox | undefined;
  item: TouchingRelation;
  onSelect: (selection: FeatureSelection) => void;
  runtime: RelationRuntimeOptions;
  selected: FeatureSelection;
}) {
  const query = useRelatedRecordsQuery({
      bbox: props.bbox,
      clickedDatasetId: props.item.clickedDatasetId,
      item: props.item,
      limit: relationsStore.RELATED_RECORDS_LIMIT,
      offset: 0,
      runtime: props.runtime,
      selected: props.selected,
    }),
    pointRows: Array<{ geometry: Geometry; id: string; properties: HighlightProps }> = [],
    otherRows: Array<{ geometry: Geometry; id: string; properties: HighlightProps }> = [];
  for (const row of query.data ?? []) {
    const geometry = asGeometry(row.geometry);
    if (geometry === undefined) {
      continue;
    }
    const feature = {
      geometry,
      id: row.entry_id,
      properties: { entryId: row.entry_id, schemaId: props.item.otherDatasetId },
    };
    (geometry.type === "Point" || geometry.type === "MultiPoint" ? pointRows : otherRows).push(
      feature,
    );
  }
  if (pointRows.length === 0 && otherRows.length === 0) {
    return null;
  }
  return (
    <Fragment>
      {otherRows.length > 0 && (
        <MapGeoJSON<HighlightProps>
          data={buildFeatureCollection<HighlightProps>(otherRows)}
          fillPaint={{ "fill-color": HIGHLIGHT_COLOR, "fill-opacity": 0.25 }}
          linePaint={{ "line-color": HIGHLIGHT_COLOR, "line-width": 3 }}
        />
      )}
      {pointRows.length > 0 && (
        <MapClusterLayer<HighlightProps>
          data={buildPointFeatureCollection<HighlightProps>(pointRows)}
          onPointClick={(feature) => {
            props.onSelect(feature.properties);
          }}
          pointColor={HIGHLIGHT_COLOR}
        />
      )}
    </Fragment>
  );
}

/** The highlight features' click payload (the selection shape). */
interface HighlightProps {
  entryId: string;
  schemaId: string;
}

/** The RPC's verbatim-GeoJSON column, guarded. */
function asGeometry(value: unknown): Geometry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the object guard above is the runtime check; the RPC's verbatim-GeoJSON column is the contract.
  return value as Geometry;
}
