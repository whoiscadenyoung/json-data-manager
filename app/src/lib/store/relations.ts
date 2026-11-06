import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * The dataset-relations store (issue #258 — the project-centric train's
 * phase 4; ADR 0020) — declared dataset↔dataset relations over
 * `public.dataset_relations`, plus the bounded runtime query the
 * relation-aware map popup runs per feature click.
 *
 * The recorded shapes (ADR 0020):
 *   - Relations are CATALOG-LEVEL rows (D3): no project column — a relation
 *     between two global datasets exists once, and every project holding
 *     both datasets as members consumes it. RLS gates reads on BOTH ends'
 *     visibility and writes on BOTH ends' editability (the datasets' own
 *     recorded gates are the relation's authority).
 *   - kind 'key' config is `{fromKey, toKey}` (fromKey names the FROM
 *     side's field); kind 'spatial' config is `{predicate, direction}` —
 *     the predicate reads subject-against-object, forward makes the FROM
 *     side the subject (so {within, forward} ≡ {contains, reverse}).
 *   - Ends are datasets only (the FKs): derived datasets are virtual rows —
 *     their layers resolve through their SOURCE dataset in the runtime.
 *   - `relatedRecords` rides the `dataset_relation_records` RPC: bounded
 *     (server cap 500, default 200), viewport-scoped (spatial), index-backed
 *     (entries_data_gin containment / geometries_geom_gist), and the OTHER
 *     side resolves through its membership pin's frozen version when the
 *     consuming project pinned it (0009 consumer_references).
 *
 * NOTE: narrow local interfaces typed from the migration 0021 DDL/RPC, not
 * the generated `database.types.ts` (see `./client`). RPC result columns
 * keep the function's own snake_case names — PostgREST applies no select
 * aliases to RPC rows.
 */

/** One declared dataset↔dataset relation (a catalog-level row, D3). */
export interface DatasetRelationRow {
  id: string;
  fromDataset: string;
  toDataset: string;
  kind: "key" | "spatial";
  /** The declared truth the popup shapes by — the query counts what the data answers. */
  cardinality: "1-1" | "1-N" | "N-M";
  /** key: `{fromKey, toKey}`; spatial: `{predicate, direction}` (shapeless jsonb). */
  config: unknown;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One bounded related-record answer row (the RPC's own snake_case columns). */
export interface RelatedRecordRow {
  entry_id: string;
  data: Record<string, unknown>;
  /** Verbatim GeoJSON (live `geometries.source` or the frozen copy) — null for property-only rows. */
  geometry: unknown;
  geometry_type: string | null;
  has_more: boolean;
}

const RELATION_SELECT =
  "id,fromDataset:from_dataset,toDataset:to_dataset,kind,cardinality,config,createdBy:created_by,createdAt:created_at,updatedAt:updated_at";

/** The relation-list width (the catalog section's read; relations are human-scale declarations). */
export const DEFAULT_RELATIONS_LIMIT = 500;

/** The runtime query's default page (the popup's first answer). */
export const RELATED_RECORDS_LIMIT = 200;

/** The RPC's hard server cap is 500 — the store passes the caller's bound through untouched, clamped server-side. */
export const RELATED_RECORDS_MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every relation visible to the viewer touching ANY of `datasetIds`
 * (from- or to-side) — the catalog section's and the map runtime's list.
 * An empty id list short-circuits (PostgREST's `or` needs at least one
 * filter leg).
 */
export async function listForDatasets(
  args: { datasetIds: readonly string[] },
  options?: StoreOptions,
): Promise<DatasetRelationRow[]> {
  if (args.datasetIds.length === 0) {
    return [];
  }
  const idList = args.datasetIds.toSorted().join(",");
  return await queryRows<DatasetRelationRow>(
    clientOf(options)
      .from("dataset_relations")
      .select(RELATION_SELECT)
      .or(`from_dataset.in.(${idList}),to_dataset.in.(${idList})`)
      .order("id", { ascending: true })
      .limit(DEFAULT_RELATIONS_LIMIT),
  );
}

// ---------------------------------------------------------------------------
// Writes — silent-denial returns where the count matters (the store rule)
// ---------------------------------------------------------------------------

/**
 * Declares one relation. Returns the new row (null = denied — RLS refused:
 * not able to edit both ends).
 */
export async function create(
  args: {
    fromDataset: string;
    toDataset: string;
    kind: "key" | "spatial";
    cardinality: "1-1" | "1-N" | "N-M";
    config: Record<string, unknown>;
  },
  options?: StoreOptions,
): Promise<DatasetRelationRow | null> {
  return await queryRow<DatasetRelationRow>(
    clientOf(options)
      .from("dataset_relations")
      .insert({
        cardinality: args.cardinality,
        config: args.config,
        from_dataset: args.fromDataset,
        kind: args.kind,
        to_dataset: args.toDataset,
      })
      .select(RELATION_SELECT)
      .single(),
  );
}

/** Updates a relation's declared cardinality and/or config. Returns the affected count (0 = denied). */
export async function update(
  args: {
    relationId: string;
    cardinality?: "1-1" | "1-N" | "N-M";
    config?: Record<string, unknown>;
  },
  options?: StoreOptions,
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (args.cardinality !== undefined) {
    patch.cardinality = args.cardinality;
  }
  if (args.config !== undefined) {
    patch.config = args.config;
  }
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("dataset_relations")
      .update(patch)
      .eq("id", args.relationId)
      .select("id"),
  );
  return rows.length;
}

/** Deletes the relation (both ends' editors only). */
export async function remove(args: { relationId: string }, options?: StoreOptions): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("dataset_relations").delete().eq("id", args.relationId).select("id"),
  );
}

// ---------------------------------------------------------------------------
// The bounded runtime query (the relation-aware map popup's per-click read)
// ---------------------------------------------------------------------------

export interface RelatedRecordsArgs {
  relationId: string;
  /** The consuming map's project — drives the other side's pin resolution. */
  projectId: string;
  /** The clicked side (one end of the relation). */
  datasetId: string;
  /** The clicked entry (a live row). */
  entryId: string;
  /** Viewport [minLon,minLat,maxLon,maxLat] — scopes the spatial path (required by the RPC for kind spatial). */
  bbox?: [number, number, number, number];
  offset?: number;
  limit?: number;
}

/**
 * The bounded related-record answer for one feature click: per-relation,
 * index-backed, viewport-scoped (spatial), server-capped. The OTHER side
 * resolves through its membership pin's frozen version when the project
 * pinned it (the relations-survive-sync rule).
 */
export async function relatedRecords(
  args: RelatedRecordsArgs,
  options?: StoreOptions,
): Promise<RelatedRecordRow[]> {
  return await queryRows<RelatedRecordRow>(
    clientOf(options).rpc("dataset_relation_records", {
      p_bbox: args.bbox ?? null,
      p_dataset: args.datasetId,
      p_entry: args.entryId,
      p_limit: args.limit ?? RELATED_RECORDS_LIMIT,
      p_offset: args.offset ?? 0,
      p_project: args.projectId,
      p_relation: args.relationId,
    }),
  );
}

// ---------------------------------------------------------------------------
// TanStack Query options
// ---------------------------------------------------------------------------

export function listForDatasetsQueryOptions(
  args: { datasetIds: readonly string[] },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:relations", "listForDatasets", { datasetIds: args.datasetIds.toSorted() }],
    queryFn: async () => await listForDatasets(args, options),
  });
}

export function relatedRecordsQueryOptions(args: RelatedRecordsArgs, options?: StoreOptions) {
  return queryOptions({
    queryKey: [
      "pg:relations",
      "relatedRecords",
      {
        bbox: args.bbox ?? null,
        datasetId: args.datasetId,
        entryId: args.entryId,
        limit: args.limit ?? RELATED_RECORDS_LIMIT,
        offset: args.offset ?? 0,
        projectId: args.projectId,
        relationId: args.relationId,
      },
    ],
    queryFn: async () => await relatedRecords(args, options),
  });
}
