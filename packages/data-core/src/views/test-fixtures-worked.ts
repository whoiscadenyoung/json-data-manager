/**
 * The design §5 worked example ("States enriched") as a pure fixture, shared
 * by the golden tests and the PGlite run. Not part of the public entry.
 */
import { DEPLOYMENTS_ID, LINKS_ID, STATES_ID, noNormalization } from "./test-fixtures.js";
import type { CompileInputMeta, ViewDefinition } from "./types.js";

export const AGENCIES_ID = "44444444-4444-4444-8444-444444444444";

export const workedMetas: CompileInputMeta[] = [
  {
    alias: "states",
    datasetId: STATES_ID,
    title: "States",
    fields: [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
    ],
  },
  {
    alias: "deployments",
    datasetId: DEPLOYMENTS_ID,
    title: "Deployments",
    fields: [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
      { name: "stateId", type: "string" },
    ],
  },
  {
    alias: "deploymentAgencies",
    datasetId: AGENCIES_ID,
    title: "Deployment agencies",
    fields: [
      { name: "deploymentId", type: "string" },
      { name: "agencyId", type: "string" },
    ],
  },
  {
    alias: "links",
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
 * States + deployments (a sub-pipeline counts agencies per deployment; the
 * outer summarize counts deployments and takes the name of the one with the
 * most agencies) + links spread by type.
 */
export const workedExample: ViewDefinition = {
  inputs: [
    { alias: "states", ref: { kind: "dataset", id: STATES_ID } },
    { alias: "deployments", ref: { kind: "dataset", id: DEPLOYMENTS_ID } },
    { alias: "deploymentAgencies", ref: { kind: "dataset", id: AGENCIES_ID } },
    { alias: "links", ref: { kind: "dataset", id: LINKS_ID } },
  ],
  base: "states",
  steps: [
    {
      kind: "join",
      right: {
        input: "deployments",
        steps: [
          {
            kind: "join",
            right: { input: "deploymentAgencies" },
            on: [{ left: "id", right: "deploymentId" }],
            matching: noNormalization,
            type: "left",
            multiMatch: { mode: "summarize", measures: [{ as: "agencyCount", fn: "count" }] },
          },
        ],
      },
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
    {
      kind: "join",
      right: { input: "links" },
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
  ],
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
};
