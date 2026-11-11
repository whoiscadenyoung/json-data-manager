import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { compileView } from "./compile.js";
import { applyExtract, planExtract } from "./reuse.js";
import type { JoinPath } from "./reuse.js";
import { addRows, createDb, must, runQuery, setGeom } from "./test-fixtures-pglite.js";
import { AGENCIES_ID, workedExample, workedMetas } from "./test-fixtures-worked.js";
import { DEPLOYMENTS_ID, LINKS_ID, STATES_ID, noNormalization } from "./test-fixtures.js";
import type { CompileInputMeta, ViewDefinition } from "./types.js";

/**
 * Extract to view (#307): the extracted definition must produce the SAME rows
 * as the inline sub-pipeline. The new view is "run" the way the server does:
 * its compiled rows are saved as entries of its own dataset, which the edited
 * definition then reads as an ordinary input.
 */

const EXTRACTED_ID = "55555555-5555-4555-8555-555555555555";

let db: PGlite;

type Row = { row_id: string; d: Record<string, unknown>; geom: string | null };

beforeAll(async () => {
  db = await createDb();
  const [kansas] = await addRows(db, STATES_ID, [
    { id: "1", name: "Kansas" },
    { id: "2", name: "Iowa" },
    { id: "3", name: "Nowhere" },
  ]);
  await setGeom(db, must(kansas), "POLYGON((0 0,1 0,1 1,0 0))");
  await addRows(db, DEPLOYMENTS_ID, [
    { id: "d1", name: "Main Street", stateId: "1" },
    { id: "d2", name: "Oak Ave", stateId: "1" },
    { id: "d3", name: "Elm", stateId: "2" },
    { id: "d4", name: "Lost", stateId: "99" },
  ]);
  await addRows(db, AGENCIES_ID, [
    { deploymentId: "d1", agencyId: "a1" },
    { deploymentId: "d1", agencyId: "a2" },
    { deploymentId: "d1", agencyId: "a3" },
    { deploymentId: "d2", agencyId: "a1" },
  ]);
  await addRows(db, LINKS_ID, [
    { stateName: " kansas ", type: "docs", url: "https://ks.example/docs" },
    { stateName: "KANSAS", type: "benefits", url: "https://ks.example/benefits" },
    { stateName: "Kansas", type: "other", url: "https://ks.example/other" },
    { stateName: "Iowa", type: "docs", url: "https://ia.example/docs" },
    { stateName: "Atlantis", type: "docs", url: "https://atlantis.example/docs" },
  ]);
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** Metas for every input of `def`: the §5 fixtures, plus the extracted view once it has been run. */
function metasOf(def: ViewDefinition, extracted?: CompileInputMeta): CompileInputMeta[] {
  const known = extracted === undefined ? workedMetas : [...workedMetas, extracted];
  return def.inputs.map((input) => {
    const meta = known.find((entry) => entry.datasetId === input.ref.id);
    return { ...must(meta), alias: input.alias };
  });
}

async function rowsOf(def: ViewDefinition, extracted?: CompileInputMeta): Promise<Row[]> {
  return await runQuery<Row>(db, compileView(def, metasOf(def, extracted)));
}

/** Runs the extracted view and saves its rows as the new dataset's entries (in the order the source rows had). */
async function saveRun(view: ViewDefinition, title: string): Promise<CompileInputMeta> {
  const rows = await rowsOf(view);
  rows.sort((a, b) => a.row_id.localeCompare(b.row_id));
  await addRows(
    db,
    EXTRACTED_ID,
    rows.map((row) => row.d),
  );
  const names = [...new Set(rows.flatMap((row) => Object.keys(row.d)))];
  return { alias: "x", datasetId: EXTRACTED_ID, title, fields: names.map((name) => ({ name })) };
}

async function clearExtracted(): Promise<void> {
  await db.query("delete from public.entries where dataset_id = $1", [EXTRACTED_ID]);
}

function byName(rows: Row[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(rows.map((row) => [String(row.d.name), row.d]));
}

async function extractAndCompare(
  def: ViewDefinition,
  path: JoinPath,
  rightTitle: string,
): Promise<{ inline: Row[]; extracted: Row[]; edited: ViewDefinition; view: ViewDefinition }> {
  const inline = await rowsOf(def);
  const planned = planExtract(def, path, rightTitle);
  if (!planned.ok) {
    throw new Error(planned.reason);
  }
  await clearExtracted();
  const title = `${rightTitle} (extracted)`;
  const meta = await saveRun(planned.plan.view, title);
  const edited = applyExtract(def, path, planned.plan, { id: EXTRACTED_ID, title });
  const extracted = await rowsOf(edited, meta);
  return { inline, extracted, edited, view: planned.plan.view };
}

describe("Extract to view on the design §5 deployments sub-pipeline", () => {
  test("identical output rows, geometry included", async () => {
    const { inline, extracted, edited, view } = await extractAndCompare(
      workedExample,
      [0],
      "Deployments",
    );
    expect(extracted).toHaveLength(3);
    expect(byName(extracted)).toEqual(byName(inline));
    const geometries = (rows: Row[]) =>
      Object.fromEntries(rows.map((row) => [String(row.d.name), row.geom]));
    expect(geometries(extracted)).toEqual(geometries(inline));
    // The new view keeps every field of the sub-pipeline's result.
    expect(view.output).toEqual({ fields: [], emptyFields: "keep" });
    expect(view.base).toBe("deployments");
    expect(view.steps).toHaveLength(1);
    // The edited join reads the new view with no steps; agencies are no longer a direct input.
    const join = must(edited.steps[0]);
    expect(join.kind === "join" && join.right.steps).toBeUndefined();
    expect(edited.inputs.map((input) => input.alias)).toEqual([
      "states",
      "links",
      "deployments_extracted",
    ]);
  });
});

describe("a join that copies fields keeps its names", () => {
  const copying: ViewDefinition = {
    inputs: [
      { alias: "states", ref: { kind: "dataset", id: STATES_ID } },
      { alias: "deployments", ref: { kind: "dataset", id: DEPLOYMENTS_ID } },
      { alias: "deploymentAgencies", ref: { kind: "dataset", id: AGENCIES_ID } },
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
        multiMatch: { mode: "first", orderBy: [{ field: "name" }] },
        fields: ["name", "agencyCount"],
      },
    ],
    output: { fields: [], emptyFields: "keep" },
  };

  test("the default prefix is written down so the new title does not rename the columns", async () => {
    const { inline, extracted, edited } = await extractAndCompare(copying, [0], "Deployments");
    const join = must(edited.steps[0]);
    expect(join.kind === "join" && join.prefix).toBe("deployments");
    expect(Object.keys(must(inline[0]).d)).toContain("deployments.agencyCount");
    expect(byName(extracted)).toEqual(byName(inline));
    expect(Object.keys(must(extracted[0]).d).toSorted()).toEqual(
      Object.keys(must(inline[0]).d).toSorted(),
    );
  });
});

describe("nested sub-pipelines: only the inner one is extracted", () => {
  const nested: ViewDefinition = {
    inputs: [
      { alias: "states", ref: { kind: "dataset", id: STATES_ID } },
      { alias: "deployments", ref: { kind: "dataset", id: DEPLOYMENTS_ID } },
      { alias: "deploymentAgencies", ref: { kind: "dataset", id: AGENCIES_ID } },
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
              right: {
                input: "deploymentAgencies",
                steps: [{ kind: "filter", where: { field: "agencyId", op: "neq", value: "a3" } }],
              },
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
          measures: [{ as: "agencies", fn: "sum", field: "agencyCount", emptyValue: 0 }],
        },
      },
    ],
    output: { fields: [], emptyFields: "keep" },
  };

  test("the inner filter becomes a view; the outer sub-pipeline stays inline", async () => {
    const { inline, extracted, edited, view } = await extractAndCompare(
      nested,
      [0, 0],
      "Deployment agencies",
    );
    expect(byName(extracted)).toEqual(byName(inline));
    expect(byName(inline)["Kansas"]).toMatchObject({ agencies: 3 });
    expect(view.base).toBe("deploymentAgencies");
    expect(view.steps.map((step) => step.kind)).toEqual(["filter"]);
    const outer = must(edited.steps[0]);
    const outerSteps = outer.kind === "join" ? must(outer.right.steps) : [];
    expect(outerSteps).toHaveLength(1);
    const inner = must(outerSteps[0]);
    expect(inner.kind === "join" && inner.right).toEqual({
      input: "deployment_agencies_extracted",
    });
  });
});
