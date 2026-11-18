/**
 * The design §5 worked example ("States enriched") as a pure fixture, shared
 * by the golden tests and the PGlite run. Not part of the public entry.
 */
import { DEPLOYMENTS_ID, LINKS_ID, STATES_ID, noNormalization } from "./test-fixtures.js";
import type { CompileInputMeta, ViewDefinition } from "./types.js";

export const AGENCIES_ID = "44444444-4444-4444-8444-444444444444";

export const workedMetas: CompileInputMeta[] = [
  {
    node: "states",
    datasetId: STATES_ID,
    title: "States",
    fields: [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
    ],
  },
  {
    node: "deployments",
    datasetId: DEPLOYMENTS_ID,
    title: "Deployments",
    fields: [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
      { name: "stateId", type: "string" },
    ],
  },
  {
    node: "deployment_agencies",
    datasetId: AGENCIES_ID,
    title: "Deployment agencies",
    fields: [
      { name: "deploymentId", type: "string" },
      { name: "agencyId", type: "string" },
    ],
  },
  {
    node: "links",
    datasetId: LINKS_ID,
    title: "Links",
    fields: [
      { name: "stateName", type: "string" },
      { name: "type", type: "string" },
      { name: "url", type: "string" },
    ],
  },
];

/**
 * States + deployments (a node counts agencies per deployment; the outer
 * summarize counts deployments and takes the name of the one with the most
 * agencies) + links spread by type.
 */
export const workedExample: ViewDefinition = {
  nodes: {
    states: { kind: "source", ref: { kind: "dataset", id: STATES_ID } },
    deployments: { kind: "source", ref: { kind: "dataset", id: DEPLOYMENTS_ID } },
    deployment_agencies: { kind: "source", ref: { kind: "dataset", id: AGENCIES_ID } },
    links: { kind: "source", ref: { kind: "dataset", id: LINKS_ID } },
    agency_counts: {
      kind: "join",
      left: "deployments",
      right: "deployment_agencies",
      on: [{ left: "id", right: "deploymentId" }],
      matching: noNormalization,
      type: "left",
      multiMatch: { mode: "summarize", measures: [{ as: "agencyCount", fn: "count" }] },
    },
    with_deployments: {
      kind: "join",
      left: "states",
      right: "agency_counts",
      on: [{ left: "id", right: "stateId" }],
      matching: noNormalization,
      type: "left",
      multiMatch: {
        mode: "summarize",
        measures: [
          { as: "deployments", fn: "count", emptyValue: 0 },
          {
            as: "mostCollaboration",
            fn: "topBy",
            field: "name",
            by: "agencyCount",
            direction: "max",
          },
        ],
      },
    },
    enriched: {
      kind: "join",
      left: "with_deployments",
      right: "links",
      on: [{ left: "name", right: "stateName" }],
      matching: { ...noNormalization, trim: true, caseFold: true },
      type: "left",
      multiMatch: {
        mode: "spread",
        by: "type",
        value: "url",
        columns: [
          { category: "docs", as: "docsLink" },
          { category: "benefits", as: "benefitsLink" },
        ],
      },
    },
  },
  result: {
    node: "enriched",
    output: {
      fields: [
        { key: "name" },
        { key: "deployments", label: "Deployments" },
        { key: "mostCollaboration", label: "Most collaboration" },
        { key: "docsLink" },
        { key: "benefitsLink" },
      ],
      emptyFields: "omit",
    },
  },
};
