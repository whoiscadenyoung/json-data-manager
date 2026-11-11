import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { compileDiagnostics, compileView } from "./compile.js";
import { addRows, createDb, must, runQuery, setGeom } from "./test-fixtures-pglite.js";
import { AGENCIES_ID, workedExample, workedMetas } from "./test-fixtures-worked.js";
import { DEPLOYMENTS_ID, LINKS_ID, STATES_ID } from "./test-fixtures.js";
import { validateViewDefinition } from "./validate.js";

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
  const [kansas] = await addRows(db, STATES_ID, [
    { id: "1", name: "Kansas" },
    { id: "2", name: "Iowa" },
    { id: "3", name: "Nowhere" },
  ]);
  await setGeom(db, kansas, "POLYGON((0 0,1 0,1 1,0 0))");
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

describe("design §5 worked example, run on PGlite", () => {
  test("the definition validates against the input metadata", () => {
    const result = validateViewDefinition(workedExample, workedMetas);
    expect(result).toEqual({ ok: true, value: workedExample });
  });

  test("exact output rows; agencyCount never reaches the view", async () => {
    const rows = await runQuery<{ d: Record<string, unknown>; geom: string | null }>(
      db,
      compileView(workedExample, workedMetas),
    );
    const byName = new Map(rows.map((row) => [String(row.d.name), row]));
    expect(rows).toHaveLength(3);
    expect(must(byName.get("Kansas")).d).toEqual({
      name: "Kansas",
      deployments: 2,
      mostCollaboration: "Main Street",
      docsLink: "https://ks.example/docs",
      benefitsLink: "https://ks.example/benefits",
    });
    expect(must(byName.get("Iowa")).d).toEqual({
      name: "Iowa",
      deployments: 1,
      mostCollaboration: "Elm",
      docsLink: "https://ia.example/docs",
      benefitsLink: null,
    });
    expect(must(byName.get("Nowhere")).d).toEqual({
      name: "Nowhere",
      deployments: 0,
      mostCollaboration: null,
      docsLink: null,
      benefitsLink: null,
    });
    for (const row of rows) {
      expect(Object.keys(row.d)).not.toContain("agencyCount");
    }
    // The base input's geometry passes through every step unchanged.
    expect(must(byName.get("Kansas")).geom).toBe("POLYGON((0 0,1 0,1 1,0 0))");
    expect(must(byName.get("Iowa")).geom).toBeNull();
  });

  test("without the output projection the sub-pipeline field is still not copied", async () => {
    const rows = await runQuery<{ d: Record<string, unknown> }>(
      db,
      compileView({ ...workedExample, output: { fields: [], emptyFields: "keep" } }, workedMetas),
    );
    for (const row of rows) {
      expect(Object.keys(row.d)).not.toContain("agencyCount");
    }
  });

  test("diagnostics: sub-pipeline step, unmatched links, undeclared category", async () => {
    const [row] = await runQuery<{ diagnostics: { steps: Record<string, unknown>[] } }>(
      db,
      compileDiagnostics(workedExample, workedMetas),
    );
    const steps = row.diagnostics.steps;
    // Execution order: the sub-pipeline's join, then the outer joins.
    expect(steps.map((s) => [s.kind, s.path ?? null, s.index])).toEqual([
      ["join", "steps[0].right.steps[0]", 0],
      ["join", null, 0],
      ["join", null, 1],
    ]);
    expect(steps[0]).toMatchObject({ rowsIn: 4, rowsOut: 4, fieldsAdded: ["agencyCount"] });
    expect(steps[2]).toMatchObject({
      rowsIn: 3,
      rowsOut: 3,
      join: {
        leftMatched: 2,
        leftUnmatched: 1,
        leftUnmatchedSamples: ["Nowhere"],
        rightUnmatched: 1,
        rightUnmatchedSamples: ["Atlantis"],
        policy: "spread",
        spread: { undeclaredCategories: ["other"], undeclaredRows: 1 },
      },
    });
  });
});
