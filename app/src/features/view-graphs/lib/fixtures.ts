import type { ViewDefinition } from "@caden/data-core/views";

import type { LineageData } from "./lineage-graph";

/** Test and story fixtures: the design §5 "States enriched" view and a project around it. */

const matching = {
  caseFold: false,
  collapseSpace: false,
  stripDiacritics: false,
  trim: false,
};

export const STATES_ENRICHED: ViewDefinition = {
  nodes: {
    states: { kind: "source", ref: { id: "ds-states", kind: "dataset" } },
    deployments: { kind: "source", ref: { id: "ds-deployments", kind: "dataset" } },
    deployment_agencies: { kind: "source", ref: { id: "ds-agencies", kind: "dataset" } },
    links: { kind: "source", ref: { id: "ds-links", kind: "dataset" } },
    agency_counts: {
      kind: "join",
      label: "Agencies per deployment",
      left: "deployments",
      matching,
      multiMatch: {
        measures: [{ as: "agencyCount", fn: "count" }],
        mode: "summarize",
      },
      on: [{ left: "id", right: "deploymentId" }],
      right: "deployment_agencies",
      type: "left",
    },
    with_deployments: {
      kind: "join",
      left: "states",
      matching,
      multiMatch: {
        measures: [
          { as: "deployments", emptyValue: 0, fn: "count" },
          {
            as: "mostCollaboration",
            by: "agencyCount",
            direction: "max",
            field: "name",
            fn: "topBy",
          },
        ],
        mode: "summarize",
      },
      on: [{ left: "id", right: "stateId" }],
      right: "agency_counts",
      type: "left",
    },
    enriched: {
      kind: "join",
      left: "with_deployments",
      matching: { ...matching, caseFold: true, trim: true },
      multiMatch: {
        columns: [
          { as: "docsLink", category: "docs" },
          { as: "benefitsLink", category: "benefits" },
        ],
        by: "type",
        mode: "spread",
        value: "url",
      },
      on: [{ left: "stateName", right: "name" }],
      right: "links",
      type: "left",
    },
  },
  result: {
    node: "enriched",
    output: {
      emptyFields: "omit",
      fields: [{ key: "name" }, { key: "deployments", label: "Deployments" }],
    },
  },
};

/** A project: four source datasets, the view over them, a layer, a map, an app, and one relation. */
export const LINEAGE_FIXTURE: LineageData = {
  apps: [{ datasetIds: [], id: "app-1", mapIds: ["map-1"], title: "State explorer" }],
  datasets: [
    {
      id: "ds-states",
      kind: "source",
      lastRunStatus: null,
      refreshMode: null,
      stale: false,
      title: "States",
    },
    {
      id: "ds-deployments",
      kind: "source",
      lastRunStatus: null,
      refreshMode: null,
      stale: false,
      title: "Deployments",
    },
    {
      id: "ds-agencies",
      kind: "source",
      lastRunStatus: null,
      refreshMode: null,
      stale: false,
      title: "Deployment agencies",
    },
    {
      id: "ds-links",
      kind: "source",
      lastRunStatus: null,
      refreshMode: null,
      stale: false,
      title: "Links",
    },
    {
      id: "view-enriched",
      kind: "view",
      lastRunStatus: "ok",
      refreshMode: "manual",
      stale: true,
      title: "States enriched",
    },
    {
      id: "view-broken",
      kind: "view",
      lastRunStatus: "error",
      refreshMode: "auto",
      stale: false,
      title: "Broken view",
    },
  ],
  layers: [{ datasetMemberId: "mem-view", id: "layer-1", kind: "data", name: "States layer" }],
  maps: [{ id: "map-1", name: "Overview map" }],
  memberships: [
    { artifactId: "view-enriched", artifactKind: "dataset", id: "mem-view" },
    { artifactId: "layer-1", artifactKind: "layer", id: "mem-layer" },
  ],
  placements: [{ layerMemberId: "mem-layer", mapId: "map-1" }],
  relations: [
    { fromDataset: "ds-deployments", id: "rel-1", kind: "key", toDataset: "ds-agencies" },
  ],
  viewInputs: [
    { alias: "states", inputDatasetId: "ds-states", viewId: "view-enriched" },
    { alias: "deployments", inputDatasetId: "ds-deployments", viewId: "view-enriched" },
    { alias: "deployment_agencies", inputDatasetId: "ds-agencies", viewId: "view-enriched" },
    { alias: "links", inputDatasetId: "ds-links", viewId: "view-enriched" },
    { alias: "states", inputDatasetId: "ds-states", viewId: "view-broken" },
  ],
};
