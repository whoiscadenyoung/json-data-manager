import type { Graph, GraphEdge, GraphNode, GraphNodeStatus } from "./graph-types";

/** One dataset or view row, as the lineage read returns it. */
export interface LineageDataset {
  id: string;
  title: string;
  kind: "source" | "view";
  refreshMode: "manual" | "auto" | "live" | null;
  /** `view_stale`: inputs or definition changed since the last good run. */
  stale: boolean;
  /** The newest run's status; null when the view never ran or the runs aren't readable. */
  lastRunStatus: "ok" | "error" | null;
}

export interface LineageViewInput {
  viewId: string;
  inputDatasetId: string;
  alias: string;
}

export interface LineageRelation {
  id: string;
  fromDataset: string;
  toDataset: string;
  kind: "key" | "spatial";
}

/** A `project_artifacts` row: the hop from a membership id to the thing it names. */
export interface LineageMembership {
  id: string;
  artifactId: string;
  artifactKind: string;
}

export interface LineageLayer {
  id: string;
  name: string;
  kind: "data" | "group";
  datasetMemberId: string | null;
}

export interface LineageMap {
  id: string;
  name: string;
}

export interface LineagePlacement {
  mapId: string;
  layerMemberId: string;
}

export interface LineageApp {
  id: string;
  title: string;
  datasetIds: string[];
  mapIds: string[];
}

/** Everything the lineage graph is built from (the store assembles it under the viewer's RLS). */
export interface LineageData {
  datasets: LineageDataset[];
  viewInputs: LineageViewInput[];
  relations: LineageRelation[];
  memberships: LineageMembership[];
  layers: LineageLayer[];
  maps: LineageMap[];
  placements: LineagePlacement[];
  apps: LineageApp[];
}

export const UNAVAILABLE_DATASET_TITLE = "Unavailable dataset";

const REFRESH_LABEL: Record<string, string> = {
  auto: "Auto refresh",
  live: "Live",
  manual: "Manual refresh",
};

function statusOf(dataset: LineageDataset): GraphNodeStatus {
  if (dataset.lastRunStatus === "error") {
    return "error";
  }
  return dataset.stale ? "stale" : "ok";
}

function datasetNode(dataset: LineageDataset): GraphNode {
  const isView = dataset.kind === "view";
  return {
    detail: isView && dataset.refreshMode !== null ? REFRESH_LABEL[dataset.refreshMode] : undefined,
    entityId: dataset.id,
    id: `${isView ? "view" : "dataset"}:${dataset.id}`,
    kind: isView ? "view" : "dataset",
    label: dataset.title,
    status: isView ? statusOf(dataset) : undefined,
    unavailable: dataset.title === UNAVAILABLE_DATASET_TITLE ? true : undefined,
  };
}

function placeholderDataset(id: string): LineageDataset {
  return {
    id,
    kind: "source",
    lastRunStatus: null,
    refreshMode: null,
    stale: false,
    title: UNAVAILABLE_DATASET_TITLE,
  };
}

/**
 * Accumulates nodes and edges, dropping duplicate ids. Edges always point in
 * the direction the data flows (provider to consumer), so a left-to-right
 * layout reads source datasets on the left and apps on the right. A cycle in
 * the data is just another edge: the layout breaks it, nothing here recurses.
 */
class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  addNode(node: GraphNode): void {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  addEdge(edge: Omit<GraphEdge, "id">): void {
    if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) {
      return;
    }
    const id = `${edge.kind}:${edge.source}>${edge.target}`;
    if (!this.edges.has(id)) {
      this.edges.set(id, { ...edge, id });
    }
  }

  build(): Graph {
    return { edges: [...this.edges.values()], nodes: [...this.nodes.values()] };
  }
}

function datasetNodeId(builder: GraphBuilder, datasetId: string): string {
  if (builder.hasNode(`view:${datasetId}`)) {
    return `view:${datasetId}`;
  }
  return `dataset:${datasetId}`;
}

function addDatasets(builder: GraphBuilder, data: LineageData): void {
  const known = new Set(data.datasets.map((dataset) => dataset.id));
  for (const dataset of data.datasets) {
    builder.addNode(datasetNode(dataset));
  }
  // An input, relation end or app source we cannot read is still part of the picture.
  const referenced = [
    ...data.viewInputs.map((input) => input.inputDatasetId),
    ...data.relations.flatMap((relation) => [relation.fromDataset, relation.toDataset]),
    ...data.apps.flatMap((app) => app.datasetIds),
  ];
  for (const id of referenced) {
    if (!known.has(id)) {
      known.add(id);
      builder.addNode(datasetNode(placeholderDataset(id)));
    }
  }
}

function addDatasetEdges(builder: GraphBuilder, data: LineageData): void {
  for (const input of data.viewInputs) {
    builder.addEdge({
      kind: "input",
      label: input.alias,
      source: datasetNodeId(builder, input.inputDatasetId),
      target: `view:${input.viewId}`,
    });
  }
  for (const relation of data.relations) {
    builder.addEdge({
      kind: "relation",
      label: relation.kind,
      source: datasetNodeId(builder, relation.fromDataset),
      target: datasetNodeId(builder, relation.toDataset),
    });
  }
}

function addConsumerNodes(builder: GraphBuilder, data: LineageData): void {
  for (const layer of data.layers) {
    builder.addNode({
      detail: layer.kind === "group" ? "Group layer" : undefined,
      entityId: layer.id,
      id: `layer:${layer.id}`,
      kind: "layer",
      label: layer.name,
    });
  }
  for (const map of data.maps) {
    builder.addNode({ entityId: map.id, id: `map:${map.id}`, kind: "map", label: map.name });
  }
  for (const app of data.apps) {
    builder.addNode({ entityId: app.id, id: `app:${app.id}`, kind: "app", label: app.title });
  }
}

function addConsumers(builder: GraphBuilder, data: LineageData): void {
  const memberships = new Map(data.memberships.map((member) => [member.id, member]));
  addConsumerNodes(builder, data);
  for (const layer of data.layers) {
    const member =
      layer.datasetMemberId === null ? undefined : memberships.get(layer.datasetMemberId);
    if (member !== undefined) {
      builder.addEdge({
        kind: "consumer",
        source: datasetNodeId(builder, member.artifactId),
        target: `layer:${layer.id}`,
      });
    }
  }
  for (const placement of data.placements) {
    const member = memberships.get(placement.layerMemberId);
    if (member !== undefined && member.artifactKind === "layer") {
      builder.addEdge({
        kind: "consumer",
        source: `layer:${member.artifactId}`,
        target: `map:${placement.mapId}`,
      });
    }
  }
  for (const app of data.apps) {
    for (const mapId of app.mapIds) {
      builder.addEdge({ kind: "consumer", source: `map:${mapId}`, target: `app:${app.id}` });
    }
    for (const datasetId of app.datasetIds) {
      builder.addEdge({
        kind: "consumer",
        source: datasetNodeId(builder, datasetId),
        target: `app:${app.id}`,
      });
    }
  }
}

/**
 * The catalog lineage graph (design §9): datasets, views, maps, layers and
 * apps as nodes; view inputs (solid), relations (dashed) and consumers
 * (dataset to layer, layer to map, map and dataset to app) as edges. Stale
 * and failing views carry a `status`. Pure and total: missing rows become
 * "Unavailable dataset" placeholders and cycles are left to the layout.
 */
export function buildLineageGraph(data: LineageData): Graph {
  const builder = new GraphBuilder();
  addDatasets(builder, data);
  addDatasetEdges(builder, data);
  addConsumers(builder, data);
  return builder.build();
}
