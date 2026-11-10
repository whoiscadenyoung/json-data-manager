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
  base: "states",
  inputs: [
    { alias: "states", ref: { id: "ds-states", kind: "dataset" } },
    { alias: "deployments", ref: { id: "ds-deployments", kind: "dataset" } },
    { alias: "deploymentAgencies", ref: { id: "ds-agencies", kind: "dataset" } },
    { alias: "links", ref: { id: "ds-links", kind: "dataset" } },
  ],
  output: {
    emptyFields: "omit",
    fields: [{ key: "name" }, { key: "deployments", label: "Deployments" }],
  },
  steps: [
    {
      kind: "join",
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
      right: {
        input: "deployments",
        steps: [
          {
            kind: "join",
            matching,
            multiMatch: {
              measures: [{ as: "agencyCount", fn: "count" }],
              mode: "summarize",
            },
            on: [{ left: "id", right: "deploymentId" }],
            right: { input: "deploymentAgencies" },
            type: "left",
          },
        ],
      },
      type: "left",
    },
    {
      kind: "join",
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
      right: { input: "links" },
      type: "left",
    },
  ],
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
    { alias: "deploymentAgencies", inputDatasetId: "ds-agencies", viewId: "view-enriched" },
    { alias: "links", inputDatasetId: "ds-links", viewId: "view-enriched" },
    { alias: "states", inputDatasetId: "ds-states", viewId: "view-broken" },
  ],
};
