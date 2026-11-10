import { queryOptions } from "@tanstack/react-query";

import * as appsStore from "./apps";
import { clientOf, queryRows, type StoreOptions } from "./client";
import * as layersStore from "./layers";
import * as mapsStore from "./maps";
import * as relationsStore from "./relations";

/**
 * The catalog lineage read (views initiative #304). A few RLS-scoped selects
 * through the shared client, assembled into plain rows; the graph builder
 * (`features/view-graphs`) turns them into nodes and edges. Everything is what
 * the viewer may see: an unreadable input simply becomes a placeholder node.
 */

export interface LineageDatasetRow {
  id: string;
  title: string;
  kind: "source" | "view";
  refreshMode: "manual" | "auto" | "live" | null;
  stale: boolean;
}

export interface LineageViewInputRow {
  viewId: string;
  inputDatasetId: string;
  alias: string;
}

export interface LineageMembershipRow {
  id: string;
  artifactId: string;
  artifactKind: string;
}

export interface LineagePlacementRow {
  mapId: string;
  layerMemberId: string;
}

export interface LineageRead {
  datasets: (LineageDatasetRow & { lastRunStatus: "ok" | "error" | null })[];
  viewInputs: LineageViewInputRow[];
  relations: { id: string; fromDataset: string; toDataset: string; kind: "key" | "spatial" }[];
  memberships: LineageMembershipRow[];
  layers: { id: string; name: string; kind: "data" | "group"; datasetMemberId: string | null }[];
  maps: { id: string; name: string }[];
  placements: LineagePlacementRow[];
  apps: { id: string; title: string; datasetIds: string[]; mapIds: string[] }[];
}

const DATASET_SELECT = "id,title,kind,refreshMode:refresh_mode,stale:view_stale";
/** Ids per `in (...)` filter, so the request URL stays short. */
const ID_CHUNK = 80;
/** Rounds of "fetch the inputs of the views just loaded" (chains of views). */
const MAX_INPUT_ROUNDS = 5;
const RUNS_LIMIT = 1000;

function chunked<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) {
    out.push(items.slice(i, i + ID_CHUNK));
  }
  return out;
}

async function fetchDatasets(
  ids: readonly string[],
  options?: StoreOptions,
): Promise<LineageDatasetRow[]> {
  const pages = await Promise.all(
    chunked(ids).map(
      async (chunk) =>
        await queryRows<LineageDatasetRow>(
          clientOf(options).from("datasets").select(DATASET_SELECT).in("id", chunk),
        ),
    ),
  );
  return pages.flat();
}

async function fetchViewInputs(
  viewIds: readonly string[],
  options?: StoreOptions,
): Promise<LineageViewInputRow[]> {
  const pages = await Promise.all(
    chunked(viewIds).map(
      async (chunk) =>
        await queryRows<LineageViewInputRow>(
          clientOf(options)
            .from("view_inputs")
            .select("viewId:view_id,inputDatasetId:input_dataset_id,alias")
            .in("view_id", chunk),
        ),
    ),
  );
  return pages.flat();
}

/** Loads the seed datasets and then walks view inputs until no new dataset turns up. */
async function loadDatasetClosure(seed: string[], options?: StoreOptions) {
  const datasets = new Map<string, LineageDatasetRow>();
  const viewInputs: LineageViewInputRow[] = [];
  const requested = new Set<string>();
  let pending = [...new Set(seed)];
  for (let round = 0; round < MAX_INPUT_ROUNDS && pending.length > 0; round += 1) {
    for (const id of pending) {
      requested.add(id);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- each round needs the previous round's view inputs.
    const rows = await fetchDatasets(pending, options);
    for (const row of rows) {
      datasets.set(row.id, row);
    }
    const viewIds = rows.filter((row) => row.kind === "view").map((row) => row.id);
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by construction (see above).
    const inputs = await fetchViewInputs(viewIds, options);
    viewInputs.push(...inputs);
    pending = [...new Set(inputs.map((input) => input.inputDatasetId))].filter(
      (id) => !requested.has(id),
    );
  }
  return { datasets: [...datasets.values()], viewInputs };
}

/** The newest run's status per view (rows arrive newest first). Unreadable runs read as "no run". */
async function fetchLastRunStatuses(
  viewIds: readonly string[],
  options?: StoreOptions,
): Promise<Map<string, "ok" | "error">> {
  const statuses = new Map<string, "ok" | "error">();
  if (viewIds.length === 0) {
    return statuses;
  }
  const rows = await queryRows<{ viewId: string; status: "ok" | "error" }>(
    clientOf(options)
      .from("view_runs")
      .select("viewId:view_id,status")
      .in("view_id", viewIds.slice(0, ID_CHUNK))
      .order("finished_at", { ascending: false })
      .limit(RUNS_LIMIT),
  );
  for (const row of rows) {
    if (!statuses.has(row.viewId)) {
      statuses.set(row.viewId, row.status);
    }
  }
  return statuses;
}

async function fetchPlacements(
  mapIds: readonly string[],
  options?: StoreOptions,
): Promise<LineagePlacementRow[]> {
  if (mapIds.length === 0) {
    return [];
  }
  return await queryRows<LineagePlacementRow>(
    clientOf(options)
      .from("map_layers")
      .select("mapId:map_id,layerMemberId:layer_member_id")
      .in("map_id", mapIds.slice(0, ID_CHUNK * 4)),
  );
}

/** One project's lineage inputs: its catalog, layers, maps and apps plus every view input behind them. */
export async function readLineage(
  args: { projectId: string },
  options?: StoreOptions,
): Promise<LineageRead> {
  const [memberships, layers, maps, apps] = await Promise.all([
    queryRows<LineageMembershipRow>(
      clientOf(options)
        .from("project_artifacts")
        .select("id,artifactId:artifact_id,artifactKind:artifact_kind")
        .eq("project_id", args.projectId)
        .limit(2000),
    ),
    layersStore.listForProject(args, options),
    mapsStore.listForProject(args, options),
    appsStore.listForProject(args, options),
  ]);

  const appRows = apps.map((app) => ({
    datasetIds: app.datasetIds,
    id: app.id,
    mapIds: appsStore.appMapIds(app),
    title: app.title,
  }));
  const seed = [
    ...memberships.filter((m) => m.artifactKind === "dataset").map((m) => m.artifactId),
    ...appRows.flatMap((app) => app.datasetIds),
  ];
  const closure = await loadDatasetClosure(seed, options);
  const viewIds = closure.datasets.filter((d) => d.kind === "view").map((d) => d.id);
  const [relations, runStatuses, placements] = await Promise.all([
    relationsStore.listForDatasets({ datasetIds: closure.datasets.map((d) => d.id) }, options),
    fetchLastRunStatuses(viewIds, options),
    fetchPlacements(
      maps.map((map) => map.id),
      options,
    ),
  ]);

  return {
    apps: appRows,
    datasets: closure.datasets.map((dataset) => ({
      ...dataset,
      lastRunStatus: runStatuses.get(dataset.id) ?? null,
    })),
    layers: layers.map((layer) => ({
      datasetMemberId: layer.datasetMemberId,
      id: layer.id,
      kind: layer.kind,
      name: layer.name,
    })),
    maps: maps.map((map) => ({ id: map.id, name: map.name })),
    memberships,
    placements,
    relations: relations.map((relation) => ({
      fromDataset: relation.fromDataset,
      id: relation.id,
      kind: relation.kind,
      toDataset: relation.toDataset,
    })),
    viewInputs: closure.viewInputs,
  };
}

export function lineageQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:lineage", args.projectId],
    queryFn: async () => await readLineage(args, options),
  });
}
