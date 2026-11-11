/**
 * Shared fixtures for the views tests (also reused by the Postgres sanity
 * int test). Not part of the public entry.
 */
import type { CompileInputMeta, JoinStep, KeyMatching, Step, ViewDefinition } from "./types.js";

export const STATES_ID = "11111111-1111-4111-8111-111111111111";
export const DEPLOYMENTS_ID = "22222222-2222-4222-8222-222222222222";
export const LINKS_ID = "33333333-3333-4333-8333-333333333333";

export const metas: CompileInputMeta[] = [
  {
    alias: "states",
    datasetId: STATES_ID,
    title: "States",
    fields: [{ name: "id" }, { name: "name" }, { name: "stateName" }],
  },
  {
    alias: "deployments",
    datasetId: DEPLOYMENTS_ID,
    title: "Deployments 2024",
    fields: [
      { name: "id" },
      { name: "name" },
      { name: "stateId", type: "string" },
      { name: "cost", type: "number" },
    ],
  },
  {
    alias: "links",
    datasetId: LINKS_ID,
    title: "Links",
    pinnedVersion: "v-ref-1",
    fields: [{ name: "stateName" }, { name: "type" }, { name: "url" }],
  },
];

export const noNormalization: KeyMatching = {
  trim: false,
  caseFold: false,
  collapseSpace: false,
  stripDiacritics: false,
};

export const fullNormalization: KeyMatching = {
  trim: true,
  caseFold: true,
  collapseSpace: true,
  stripDiacritics: true,
};

export function definition(steps: Step[], overrides: Partial<ViewDefinition> = {}): ViewDefinition {
  return {
    inputs: [
      { alias: "states", ref: { kind: "dataset", id: STATES_ID } },
      { alias: "deployments", ref: { kind: "dataset", id: DEPLOYMENTS_ID } },
      { alias: "links", ref: { kind: "dataset", id: LINKS_ID, version: "v-ref-1" } },
    ],
    base: "states",
    steps,
    output: { fields: [], emptyFields: "keep" },
    ...overrides,
  };
}

export function join(overrides: Partial<JoinStep> = {}): JoinStep {
  return {
    kind: "join",
    right: { input: "deployments" },
    on: [{ left: "id", right: "stateId" }],
    matching: noNormalization,
    type: "left",
    multiMatch: { mode: "first" },
    ...overrides,
  };
}
