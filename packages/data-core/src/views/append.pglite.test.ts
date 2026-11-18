import { describe, expect, test } from "vitest";

import { compileDiagnostics, compileView } from "./compile.js";
import { addRows, createDb, must, runQuery } from "./test-fixtures-pglite.js";
import { definition, DEPLOYMENTS_ID, metas, STATES_ID } from "./test-fixtures.js";
import type { Step } from "./types.js";
import { validateViewDefinition } from "./validate.js";

const append: Step = {
  kind: "append",
  sources: [{ input: "deployments", tag: 2023 }],
  tagField: "fiscal_year",
  baseTag: 2022,
};

describe("append step", () => {
  test("validates and rejects bad shapes", () => {
    expect(validateViewDefinition(definition([append]), metas).ok).toBe(true);
    const noSources = validateViewDefinition(
      definition([{ kind: "append", sources: [] } as Step]),
      metas,
    );
    expect(noSources.ok).toBe(false);
    const unknown = validateViewDefinition(
      definition([{ kind: "append", sources: [{ input: "ghost" }] } as Step]),
      metas,
    );
    expect(unknown.ok).toBe(false);
    const tagWithoutField = validateViewDefinition(
      definition([{ kind: "append", sources: [{ input: "deployments", tag: 1 }] } as Step]),
      metas,
    );
    expect(tagWithoutField.ok).toBe(false);
  });

  test("stacks rows, tags them and keeps each row's geometry", async () => {
    const db = await createDb();
    const a = await addRows(db, STATES_ID, [{ name: "Kansas" }]);
    const b = await addRows(db, DEPLOYMENTS_ID, [{ name: "Main St" }, { name: "Elm St" }]);
    await db.query("insert into public.geometries (entry_id, geom) values ($1, 'A'), ($2, 'B')", [
      a[0],
      b[0],
    ]);
    const query = compileView(definition([append]), metas);
    const rows = await runQuery<{ d: Record<string, unknown>; geom: string | null }>(db, query);
    expect(rows).toHaveLength(3);
    const byName = new Map(rows.map((row) => [row.d.name, row]));
    expect(must(byName.get("Kansas")).d.fiscal_year).toBe(2022);
    expect(must(byName.get("Kansas")).geom).toBe("A");
    expect(must(byName.get("Main St")).d.fiscal_year).toBe(2023);
    expect(must(byName.get("Main St")).geom).toBe("B");
    expect(must(byName.get("Elm St")).geom).toBeNull();
  });

  test("diagnostics compile", () => {
    expect(compileDiagnostics(definition([append]), metas).sql).toContain("union all");
  });

  describe("column edits", () => {
    const edited: Step = {
      kind: "append",
      sources: [
        {
          input: "deployments",
          columns: [
            { from: "cost", as: "amount" },
            { from: "stateId", exclude: true },
          ],
        },
      ],
      baseColumns: [{ from: "stateName", as: "amount" }],
    };

    test("validates edits against known fields", () => {
      expect(validateViewDefinition(definition([edited]), metas).ok).toBe(true);
      const unknown = validateViewDefinition(
        definition([
          {
            kind: "append",
            sources: [{ input: "deployments", columns: [{ from: "nope", as: "x" }] }],
          },
        ]),
        metas,
      );
      expect(unknown.ok).toBe(false);
      const collide = validateViewDefinition(
        definition([
          {
            kind: "append",
            sources: [{ input: "deployments", columns: [{ from: "cost", as: "name" }] }],
          },
        ]),
        metas,
      );
      expect(collide.ok).toBe(false);
      const badShape = validateViewDefinition(
        definition([
          {
            kind: "append",
            sources: [
              { input: "deployments", columns: [{ from: "cost" }, { from: "cost", as: "" }] },
            ],
          } as Step,
        ]),
        metas,
      );
      expect(badShape.ok).toBe(false);
      const twice = validateViewDefinition(
        definition([
          {
            kind: "append",
            sources: [
              {
                input: "deployments",
                columns: [
                  { from: "cost", as: "x" },
                  { from: "name", as: "x" },
                ],
              },
            ],
          },
        ]),
        metas,
      );
      expect(twice.ok).toBe(false);
    });

    test("renames, excludes, merges into one column and keeps geometry", async () => {
      const db = await createDb();
      const a = await addRows(db, STATES_ID, [{ name: "Kansas", stateName: "KS", extra: 1 }]);
      const b = await addRows(db, DEPLOYMENTS_ID, [
        { name: "Main St", cost: 5, stateId: "x" },
        { name: "Elm St", stateId: "y" },
      ]);
      await db.query("insert into public.geometries (entry_id, geom) values ($1, 'A'), ($2, 'B')", [
        a[0],
        b[0],
      ]);
      const rows = await runQuery<{ d: Record<string, unknown>; geom: string | null }>(
        db,
        compileView(definition([edited]), metas),
      );
      const byName = new Map(rows.map((row) => [row.d.name, row]));
      const ks = must(byName.get("Kansas"));
      expect(ks.d.amount).toBe("KS");
      expect("stateName" in ks.d).toBe(false);
      expect(ks.d.extra).toBe(1);
      expect(ks.geom).toBe("A");
      const main = must(byName.get("Main St"));
      expect(main.d.amount).toBe(5);
      expect("cost" in main.d).toBe(false);
      expect("stateId" in main.d).toBe(false);
      expect(main.geom).toBe("B");
      // A rename of a field the row lacks creates no null key.
      expect("amount" in must(byName.get("Elm St")).d).toBe(false);
    });
  });
});
