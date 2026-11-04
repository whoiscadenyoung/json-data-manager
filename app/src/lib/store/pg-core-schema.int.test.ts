// Integration tests — §3.2 schema + trigger maintenance against the local
// Supabase Postgres (docs/supabase-migration-design.md §3.2; stage-1 accept:
// import lands, summaries stay exact, search vectors build from the
// dataset's declared property keys, expand-only envelope, clear resets).

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  createDataset,
  DB_URL,
  dbUp,
  dropDatasets,
  ensureUsers,
  PgSession,
  sqlLit,
} from "./pg-int-helpers.int.test";

let session: PgSession | undefined;

/** The per-file session (connected in beforeEach when the stack is up). */
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

const POINTS = [
  {
    data: { name: "alpha", count: 1, kind: "a" },
    geometry: { type: "Point", coordinates: [1.0, 2.0] },
  },
  {
    data: { name: "beta", count: 10, kind: "b" },
    geometry: { type: "Point", coordinates: [3.0, 4.0] },
  },
  {
    data: { name: "gamma", count: 2, kind: "a" },
    geometry: { type: "Point", coordinates: [-1.0, -2.0] },
  },
];

describe.skipIf(!dbUp())("core schema (§3.2)", () => {
  test("import_entries inserts entries + geometries and maintains exact summaries", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["name", "count", "kind"],
    });
    try {
      await s().begin();
      await s().asUser(ALICE);

      const rows = await s().expectOk(
        `select * from public.import_entries('${datasetId}', ${sqlLit(POINTS)}::jsonb)`,
      );
      expect(Number(rows[0].import_entries)).toBe(3);

      const summary = (
        await s().expectOk(
          `select entry_count, feature_count, map_tile_cache_version,
                  st_astext(bbox) as envelope
           from public.datasets where id = '${datasetId}'`,
        )
      )[0];
      expect(Number(summary.entry_count)).toBe(3);
      expect(Number(summary.feature_count)).toBe(3);
      expect(Number(summary.map_tile_cache_version)).toBe(1);
      // The envelope covers [-1,-2]..[3,4].
      expect(summary.envelope).toContain("POLYGON");
      expect(summary.envelope).toContain("-1 -2");
      expect(summary.envelope).toContain("3 4");

      // Verbatim source round-trip, generated geom with SRID 4326, per-row
      // bbox trigger-filled, geometry_type denormalized, attribution stamped.
      const geom = (
        await s().expectOk(
          `select g.source, st_srid(g.geom)::int as srid, st_astext(g.geom) as wkt,
                  g.bbox, g.type, e.geometry_type, e.created_by
           from public.geometries g join public.entries e on e.id = g.entry_id
           where e.data->>'name' = 'alpha'`,
        )
      )[0];
      expect(JSON.parse(geom.source as string)).toEqual(POINTS[0].geometry);
      expect(Number(geom.srid)).toBe(4326);
      expect(geom.wkt).toBe("POINT(1 2)");
      expect(geom.bbox).toEqual("{1,2,1,2}");
      expect(geom.type).toBe("Point");
      expect(geom.geometry_type).toBe("Point");
      expect(geom.created_by).toBe(ALICE);

      // Search vector built from the dataset's DECLARED property keys.
      const hits = await s().expectOk(
        `select data->>'name' as name, (search @@ websearch_to_tsquery('simple','beta')) as beta,
                (search @@ websearch_to_tsquery('simple','nomatchxyz')) as none
         from public.entries where dataset_id = '${datasetId}' order by data->>'name'`,
      );
      const beta = hits.find((h) => h.name === "beta");
      expect(beta !== undefined && beta.beta === "t").toBe(true);
      expect(hits.every((h) => h.none === "f")).toBe(true);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("search vector rebuilds on data updates", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE, properties: ["name"] });
    try {
      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(
        `select public.import_entries('${datasetId}', ${sqlLit([{ data: { name: "first" } }])}::jsonb)`,
      );
      await s().expectOk(
        `update public.entries set data = data || '{"name":"zebra"}'::jsonb
         where dataset_id = '${datasetId}'`,
      );
      const hit = (
        await s().expectOk(
          `select (search @@ websearch_to_tsquery('simple','zebra')) as zebra,
                  (search @@ websearch_to_tsquery('simple','first')) as old
           from public.entries where dataset_id = '${datasetId}'`,
        )
      )[0];
      expect(hit.zebra).toBe("t");
      expect(hit.old).toBe("f");
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("storage-backed rows: geom null, client bbox honored, envelope not expanded, tiles include them, bbox RPC skips them", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["name"],
    });
    try {
      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(
        `select public.import_entries('${datasetId}', ${sqlLit([
          {
            data: { name: "inline" },
            geometry: { type: "Point", coordinates: [1, 2] },
            geometryType: "Point",
          },
          {
            data: { name: "big" },
            geometryType: "Point",
            geometrySourcePath: "geometries/test-payload.json",
            geometrySourceBytes: 900000,
            bbox: [10, 10, 11, 11],
          },
        ])}::jsonb)`,
      );

      const stored = (
        await s().expectOk(
          `select source, source_path, source_bytes, geom, bbox
           from public.geometries where dataset_id = '${datasetId}' and source_path is not null`,
        )
      )[0];
      expect(stored.source).toBeNull();
      expect(stored.source_path).toBe("geometries/test-payload.json");
      expect(Number(stored.source_bytes)).toBe(900000);
      expect(stored.geom).toBeNull();
      expect(stored.bbox).toEqual("{10,10,11,11}");

      // feature_count counts the storage-backed row; the envelope stays at
      // the inline point's extent (client bbox does not expand it); the tile
      // version bumped for the write.
      const summary = (
        await s().expectOk(
          `select entry_count, feature_count, max_geometry_row_bytes,
                  st_astext(bbox) as envelope
           from public.datasets where id = '${datasetId}'`,
        )
      )[0];
      expect(Number(summary.feature_count)).toBe(2);
      expect(Number(summary.max_geometry_row_bytes)).toBe(900000);
      // The envelope stays at the inline point's degenerate extent — the
      // storage-backed row's client bbox (10,10..11,11) must NOT expand it.
      expect(summary.envelope).toContain("(1 2");
      expect(summary.envelope).not.toContain("10 10");

      expect(
        await s().count(
          `select count(*) as n from public.entries_in_bbox('${datasetId}', '[0,0,5,5]')`,
        ),
      ).toBe(1);
      const tiles = await s().expectOk(
        `select geometry, geometry_source_path from public.dataset_rows_for_tiles('${datasetId}', null, 10)`,
      );
      expect(tiles).toHaveLength(2);
      expect(tiles.filter((t) => t.geometry_source_path !== null)).toHaveLength(1);
      expect(tiles.filter((t) => t.geometry !== null)).toHaveLength(1);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("envelope is expand-only on deletes; an emptying delete resets summaries and bumps the tile version", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["name"],
    });
    try {
      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(`select public.import_entries('${datasetId}', ${sqlLit(POINTS)}::jsonb)`);
      const before = Number(
        (
          await s().expectOk(
            `select map_tile_cache_version from public.datasets where id = '${datasetId}'`,
          )
        )[0].map_tile_cache_version,
      );

      // Delete one geometry: feature_count drops, the envelope never shrinks.
      await s().expectOk(
        `delete from public.geometries where dataset_id = '${datasetId}'
           and st_x(geom) = -1`,
      );
      const afterOne = (
        await s().expectOk(
          `select feature_count, st_astext(bbox) as envelope, map_tile_cache_version
           from public.datasets where id = '${datasetId}'`,
        )
      )[0];
      expect(Number(afterOne.feature_count)).toBe(2);
      expect(afterOne.envelope).toContain("-1 -2"); // still covering the deleted point
      expect(Number(afterOne.map_tile_cache_version)).toBe(before + 1);

      // Emptying delete: bbox and max row bytes reset; entry_count 0.
      await s().expectOk(`delete from public.entries where dataset_id = '${datasetId}'`);
      const empty = (
        await s().expectOk(
          `select entry_count, feature_count, bbox, max_geometry_row_bytes, map_tile_cache_version
           from public.datasets where id = '${datasetId}'`,
        )
      )[0];
      expect(Number(empty.entry_count)).toBe(0);
      expect(Number(empty.feature_count)).toBe(0);
      expect(empty.bbox).toBeNull();
      expect(empty.max_geometry_row_bytes).toBeNull();
      expect(Number(empty.map_tile_cache_version)).toBe(before + 2);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("an empty-rows import_entries call is the clear path and an import row's processed advances per chunk", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["name"],
    });
    try {
      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(
        `insert into public.imports (dataset_id, total) values ('${datasetId}', 10)`,
      );
      await s().expectOk(`select public.import_entries('${datasetId}', ${sqlLit(POINTS)}::jsonb)`);
      let imports = (
        await s().expectOk(
          `select status, total, processed from public.imports where dataset_id = '${datasetId}'`,
        )
      )[0];
      expect(imports.status).toBe("processing");
      expect(Number(imports.processed)).toBe(3);

      await s().expectOk(`select public.import_entries('${datasetId}', '[]'::jsonb)`);
      const summary = (
        await s().expectOk(
          `select entry_count, feature_count, bbox from public.datasets where id = '${datasetId}'`,
        )
      )[0];
      expect(Number(summary.entry_count)).toBe(0);
      expect(Number(summary.feature_count)).toBe(0);
      expect(summary.bbox).toBeNull();

      imports = (
        await s().expectOk(
          `select status, total, processed from public.imports where dataset_id = '${datasetId}'`,
        )
      )[0];
      expect(Number(imports.processed)).toBe(3); // the clear chunk adds none

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("malformed import payloads raise and change nothing (one statement per chunk)", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE, properties: ["name"] });
    try {
      await s().begin();
      await s().asUser(ALICE);
      expect(
        await s().denied(
          `select * from public.import_entries('${datasetId}', '[{"nope":true}]'::jsonb)`,
        ),
      ).toMatch(/data/i);
      expect(
        await s().denied(`select * from public.import_entries('${datasetId}', '{"a":1}'::jsonb)`),
      ).toMatch(/array/i);
      expect(
        await s().count(
          `select count(*) as n from public.entries where dataset_id = '${datasetId}'`,
        ),
      ).toBe(0);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("dataset_rows_for_tiles pages on next_cursor (the §5 intro blanket rule; null = exhausted)", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["name"],
    });
    try {
      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(`select public.import_entries('${datasetId}', ${sqlLit(POINTS)}::jsonb)`);

      // Walk the whole feed one row at a time: every page carries the next
      // page's continuation (the store's PagedRpcRow reads the last row's
      // next_cursor), and the final page's null is the exhaustion signal the
      // seam's completeness loop rides.
      const seen: string[] = [];
      const cursors: Array<string | null> = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await s().expectOk(
          `select entry_id::text as entry_id, data->>'name' as name, next_cursor
           from public.dataset_rows_for_tiles('${datasetId}',
             ${cursor === null ? "null" : sqlLit(cursor)}, 1)`,
        );
        expect(page).toHaveLength(1);
        const first = page[0];
        if (first === undefined) throw new Error("empty page mid-walk");
        seen.push(first.name as string);
        cursors.push(first.next_cursor === null ? null : String(first.next_cursor));
        if (first.next_cursor === null) break;
        cursor = String(first.next_cursor);
        expect(seen.length).toBeLessThanOrEqual(POINTS.length);
      }

      expect(seen).toHaveLength(POINTS.length);
      expect(new Set(seen).size).toBe(POINTS.length);
      expect(cursors[cursors.length - 1]).toBeNull();
      // Every non-final page handed back a resumable cursor.
      expect(cursors.slice(0, -1).every((c) => typeof c === "string" && c.length > 0)).toBe(true);

      // A cursor at the LAST row also exhausts (no phantom page).
      const lastId = (
        await s().expectOk(
          `select id::text as id from public.entries
           where dataset_id = '${datasetId}' order by id desc limit 1`,
        )
      )[0].id as string;
      const tail = await s().expectOk(
        `select next_cursor from public.dataset_rows_for_tiles('${datasetId}',
           encode(convert_to(jsonb_build_object('i', '${lastId}')::text, 'utf8'), 'base64'), 1)`,
      );
      expect(tail).toHaveLength(0);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});
