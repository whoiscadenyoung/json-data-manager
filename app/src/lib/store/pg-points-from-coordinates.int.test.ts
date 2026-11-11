// Integration tests — points_from_coordinates (issue #293; migration 0032).
// Writes Point geometry rows for the entries sent, stamps entries.geometry_type,
// lets the geometry triggers maintain the summaries, and follows RLS.
// Needs a DEDICATED CI-parity db (docs/memory/int-test-db-split-ri-teardown.md).

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  BOB,
  createDataset,
  DB_URL,
  dbUp,
  dropDatasets,
  ensureUsers,
  PgSession,
  sqlLit,
} from "./pg-int-helpers.int.test";

let session: PgSession | undefined;

function s(): PgSession {
  if (session === undefined) throw new Error("integration session not connected");
  return session;
}

beforeEach(async () => {
  if (dbUp() && !session) {
    session = await PgSession.connect(DB_URL);
    await ensureUsers(session);
  }
});

afterAll(async () => {
  if (session) await session.close();
  session = undefined;
});

async function insertEntry(datasetId: string, data: object): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.entries (dataset_id, data) values (${sqlLit(datasetId)}, ${sqlLit(JSON.stringify(data))}::jsonb) returning id::text as id`,
  );
  return String(rows[0].id);
}

function points(pairs: Array<[string, [number, number]]>): string {
  return `${sqlLit(
    JSON.stringify(
      pairs.map(([id, coordinates]) => ({ geometry: { coordinates, type: "Point" }, id })),
    ),
  )}::jsonb`;
}

describe.skipIf(!dbUp())("points_from_coordinates (#293)", () => {
  test("writes points, keeps coordinate-less rows plain, ignores other datasets, follows RLS", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "locked",
      lifecycle: "published",
      visibility: "signed-in",
    });
    const otherId = await createDataset(s(), { createdBy: ALICE });
    try {
      await s().begin();
      await s().asUser(ALICE);
      const a = await insertEntry(datasetId, { lat: 39.1, lon: -94.6 });
      const b = await insertEntry(datasetId, { lat: "", lon: "" });
      const foreign = await insertEntry(otherId, { lat: 1, lon: 1 });

      const changed = await s().expectOk(
        `select public.points_from_coordinates(${sqlLit(datasetId)}, ${points([
          [a, [-94.6, 39.1]],
          [foreign, [1, 1]],
        ])}) as n`,
      );
      expect(Number(changed[0].n)).toBe(1);

      const summary = await s().expectOk(
        `select e.geometry_type, g.type, g.bbox::text as bbox,
                d.feature_count, d.map_tile_cache_version
           from public.entries e
           join public.geometries g on g.entry_id = e.id
           join public.datasets d on d.id = e.dataset_id
          where e.id = ${sqlLit(a)}`,
      );
      expect(summary[0].geometry_type).toBe("Point");
      expect(summary[0].type).toBe("Point");
      expect(String(summary[0].bbox)).toBe("{-94.6,39.1,-94.6,39.1}");
      expect(Number(summary[0].feature_count)).toBe(1);
      expect(Number(summary[0].map_tile_cache_version)).toBeGreaterThan(0);

      expect(
        await s().count(`select count(*) from public.geometries where entry_id = ${sqlLit(b)}`),
      ).toBe(0);
      expect(
        await s().count(
          `select count(*) from public.geometries where entry_id = ${sqlLit(foreign)}`,
        ),
      ).toBe(0);

      // Non-points are refused outright.
      await s().denied(
        `select public.points_from_coordinates(${sqlLit(datasetId)}, ${sqlLit(
          JSON.stringify([{ geometry: { coordinates: [[0, 0]], type: "LineString" }, id: b }]),
        )}::jsonb)`,
      );

      // BOB can view the locked dataset but not edit it.
      await s().asUser(BOB);
      await s().denied(
        `select public.points_from_coordinates(${sqlLit(datasetId)}, ${points([[b, [0, 0]]])})`,
      );

      await s().asAnon();
      await s().denied(
        `select public.points_from_coordinates(${sqlLit(datasetId)}, ${points([[b, [0, 0]]])})`,
      );
    } finally {
      await dropDatasets(s(), [datasetId, otherId]);
    }
  });
});
