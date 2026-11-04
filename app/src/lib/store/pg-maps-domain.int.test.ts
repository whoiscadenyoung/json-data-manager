// Integration tests — stage 2's maps domain (docs/supabase-migration-design.md
// §3.4 maps block + §4 matrix row + §5.6) against the local Supabase Postgres.
//
// Same wire-client pattern as the stage-1 pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), everything rolled back at the end.
// Works against CI's service container (SUPABASE_DB_URL) and the local stack
// unchanged. Skips with a one-line message when the stack is unreachable.
//
// Maps fixtures are created INSIDE the test transaction: their attribution
// columns are stamped from auth.uid() (NOT NULL), so they cannot be created
// by the admin connection the way dataset fixtures are.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

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

// A failed test leaves its transaction open (and aborted); roll it back so
// the next test in the file starts from a clean session.
afterEach(async () => {
  if (session) await session.rollbackIfOpen();
});

/** Open the per-test transaction as ALICE; close with s().rollback(). */
async function asAlice(): Promise<void> {
  await s().begin();
  await s().asUser(ALICE);
}

async function createMap(name = "pg-int map"): Promise<string> {
  const id = crypto.randomUUID();
  await s().expectOk(`insert into public.maps (id, name) values (${sqlLit(id)}, ${sqlLit(name)})`);
  return id;
}

async function addLayer(mapId: string, targetId: string, order = 0): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.map_layers (map_id, "order", target_type, target_id, visible)
     values (${sqlLit(mapId)}, ${order}, 'dataset', ${sqlLit(targetId)}, true) returning id::text as id`,
  );
  return rows[0].id as string;
}

describe.skipIf(!dbUp())("maps domain (§3.4/§4)", () => {
  test("authenticated users CRUD the shared catalog; anon is denied everywhere", async () => {
    await asAlice();
    const mapId = await createMap();

    // A second user (BOB) reads and writes ALICE's map — "maps stay open"
    // (§4: shared catalog artifacts, ADR 0009).
    await s().asUser(BOB);
    expect(
      await s().count(`select count(*) as n from public.maps where id = ${sqlLit(mapId)}`),
    ).toBe(1);
    const layerId = await addLayer(mapId, crypto.randomUUID());
    await s().expectOk(
      `update public.map_layers set visible = false where id = ${sqlLit(layerId)}`,
    );

    await s().asAnon();
    expect(await s().count("select count(*) as n from public.maps")).toBe(0);
    expect(await s().count("select count(*) as n from public.map_layers")).toBe(0);
    expect(await s().count("select count(*) as n from public.map_layer_overrides")).toBe(0);
    expect(await s().count("select count(*) as n from public.layer_styles")).toBe(0);
    expect(await s().count("select count(*) as n from public.marker_sprites")).toBe(0);
    await expect(
      s().denied(`insert into public.maps (id, name) values ('${crypto.randomUUID()}', 'anon')`),
    ).resolves.toMatch(/row-level security/i);
    await s().rollback();
  });

  test("created_by / updated_by / uploaded_by are stamped to the invoker, never claimed", async () => {
    await asAlice();

    const mapId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.maps (id, name, created_by) values (${sqlLit(mapId)}, 'spoofed', ${sqlLit(BOB)})`,
    );
    const rows = await s().expectOk(
      `select created_by::text as by from public.maps where id = ${sqlLit(mapId)}`,
    );
    // ALICE is the invoker; BOB was claimed in the payload and dropped.
    expect(rows[0].by as string).toBe(ALICE);

    // layer_styles.updated_by follows the LAST writer.
    const styleId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.layer_styles (id, map_id, render_id, style)
       values (${sqlLit(styleId)}, ${sqlLit(mapId)}, 'render-1', '{"layers":[]}'::jsonb)`,
    );
    await s().asUser(BOB);
    await s().expectOk(
      `update public.layer_styles set style = '{"layers":[1]}'::jsonb where id = ${sqlLit(styleId)}`,
    );
    const styleRows = await s().expectOk(
      `select updated_by::text as by from public.layer_styles where id = ${sqlLit(styleId)}`,
    );
    expect(styleRows[0].by as string).toBe(BOB);

    await s().asUser(ALICE);
    const spriteId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.marker_sprites (id, label, storage_path, width, height)
       values (${sqlLit(spriteId)}, 'pin', ${sqlLit(`marker-sprites/${ALICE}/${spriteId}.png`)}, 24, 24)`,
    );
    const spriteRows = await s().expectOk(
      `select uploaded_by::text as by from public.marker_sprites where id = ${sqlLit(spriteId)}`,
    );
    expect(spriteRows[0].by as string).toBe(ALICE);
    await s().rollback();
  });

  test("deleting a map cascades through layers, overrides and styles", async () => {
    await asAlice();
    const mapId = await createMap();
    const layerId = await addLayer(mapId, crypto.randomUUID());
    await s().expectOk(
      `insert into public.map_layer_overrides (layer_id, child_key, visible)
       values (${sqlLit(layerId)}, ${sqlLit(`dataset:${crypto.randomUUID()}`)}, false)`,
    );
    await s().expectOk(
      `insert into public.layer_styles (id, map_id, render_id, style)
       values ('${crypto.randomUUID()}', ${sqlLit(mapId)}, 'render-2', '{}'::jsonb)`,
    );

    await s().expectOk(`delete from public.maps where id = ${sqlLit(mapId)}`);
    expect(
      await s().count(
        `select count(*) as n from public.map_layers where map_id = ${sqlLit(mapId)}`,
      ),
    ).toBe(0);
    expect(
      await s().count(
        `select count(*) as n from public.layer_styles where map_id = ${sqlLit(mapId)}`,
      ),
    ).toBe(0);
    expect(
      await s().count(
        `select count(*) as n from public.map_layer_overrides where layer_id = ${sqlLit(layerId)}`,
      ),
    ).toBe(0);
    await s().rollback();
  });

  test("structure parity: layer order+target index, override uniqueness, style uniqueness", async () => {
    await asAlice();
    const mapId = await createMap();
    const target = crypto.randomUUID();
    const l1 = await addLayer(mapId, target, 0);
    const l2Rows = await s().expectOk(
      `insert into public.map_layers (map_id, "order", target_type, target_id, visible)
       values (${sqlLit(mapId)}, 7, 'dataset', ${sqlLit(target)}, false) returning id::text as id`,
    );
    const l2 = l2Rows[0].id as string;

    // by_map (map_id, "order"): an index scan yields draw order — gaps allowed.
    const ordered = await s().expectOk(
      `select id::text as id from public.map_layers where map_id = ${sqlLit(mapId)} order by "order"`,
    );
    expect(ordered.map((r) => r.id)).toEqual([l1, l2]);

    // by_target: rows findable by target alone (expansion reads).
    expect(
      await s().count(
        `select count(*) as n from public.map_layers where target_id = ${sqlLit(target)}`,
      ),
    ).toBe(2);

    // One override row per {layer_id, child_key} (unique constraint).
    const childKey = `dataset:${crypto.randomUUID()}`;
    await s().expectOk(
      `insert into public.map_layer_overrides (layer_id, child_key, visible)
       values (${sqlLit(l1)}, ${sqlLit(childKey)}, true)`,
    );
    await expect(
      s().denied(
        `insert into public.map_layer_overrides (layer_id, child_key, visible)
         values (${sqlLit(l1)}, ${sqlLit(childKey)}, false)`,
      ),
    ).resolves.toMatch(/duplicate key|unique/i);

    // One style row per {map_id, render_id} (unique constraint).
    await s().expectOk(
      `insert into public.layer_styles (id, map_id, render_id, style)
       values ('${crypto.randomUUID()}', ${sqlLit(mapId)}, 'render-3', '{}'::jsonb)`,
    );
    await expect(
      s().denied(
        `insert into public.layer_styles (id, map_id, render_id, style)
         values ('${crypto.randomUUID()}', ${sqlLit(mapId)}, 'render-3', '{}'::jsonb)`,
      ),
    ).resolves.toMatch(/duplicate key|unique/i);

    // target_type is constrained to the component's four literals.
    await expect(
      s().denied(
        `insert into public.map_layers (map_id, "order", target_type, target_id)
         values (${sqlLit(mapId)}, 0, 'schema', ${sqlLit(target)})`,
      ),
    ).resolves.toMatch(/check/i);
    await s().rollback();
  });
});

describe.skipIf(!dbUp())("install_tile_archive CAS (§5.6)", () => {
  test("claims the archive only onto the expected version; stale installs return false", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });

    await s().begin();
    await s().asUser(ALICE);
    // Current version is 0: installing onto 0 succeeds and stamps the columns.
    const okRows = await s().expectOk(
      `select public.install_tile_archive(${sqlLit(datasetId)}, 0, ${sqlLit(`tile-archives/${datasetId}/tiles.pmtiles`)}, 12345, 12, 0, 2) as ok`,
    );
    expect(okRows[0].ok as string).toBe("t");
    const stamped = await s().expectOk(
      `select map_tile_archive_path as p, map_tile_archive_bytes as b, map_tile_archive_max_zoom as z,
              map_tile_archive_built_version as v, map_tile_archive_format as f
         from public.datasets where id = ${sqlLit(datasetId)}`,
    );
    expect(stamped[0].p as string).toBe(`tile-archives/${datasetId}/tiles.pmtiles`);
    expect(stamped[0].b as string).toBe("12345");
    expect(stamped[0].z as string).toBe("12");
    expect(stamped[0].f as string).toBe("2");

    // A geometry write bumps map_tile_cache_version (the trigger path) —
    // installing onto the OLD version is now stale: false, columns untouched.
    await s().expectOk(
      `insert into public.entries (dataset_id, data) values (${sqlLit(datasetId)}, '{"name":"x"}'::jsonb)`,
    );
    await s().expectOk(
      `insert into public.geometries (dataset_id, entry_id, source, type)
       select ${sqlLit(datasetId)}, id, '{"type":"Point","coordinates":[0,0]}'::jsonb, 'Point'
         from public.entries where dataset_id = ${sqlLit(datasetId)} limit 1`,
    );
    const versionRows = await s().expectOk(
      `select map_tile_cache_version as v from public.datasets where id = ${sqlLit(datasetId)}`,
    );
    const current = Number(versionRows[0].v);
    expect(current).toBeGreaterThan(0);

    const staleRows = await s().expectOk(
      `select public.install_tile_archive(${sqlLit(datasetId)}, 0, ${sqlLit(`tile-archives/${datasetId}/stale.pmtiles`)}, 1, 12, 0, 2) as ok`,
    );
    expect(staleRows[0].ok as string).toBe("f");
    const unchanged = await s().expectOk(
      `select map_tile_archive_path as p from public.datasets where id = ${sqlLit(datasetId)}`,
    );
    expect(unchanged[0].p as string).toBe(`tile-archives/${datasetId}/tiles.pmtiles`);

    // And onto the CURRENT version → true (the worker's success path).
    const freshRows = await s().expectOk(
      `select public.install_tile_archive(${sqlLit(datasetId)}, ${current}, ${sqlLit(`tile-archives/${datasetId}/fresh.pmtiles`)}, 1, 12, ${current}, 2) as ok`,
    );
    expect(freshRows[0].ok as string).toBe("t");
    await s().rollback();
    await dropDatasets(s(), [datasetId]);
  });

  test("paths outside the caller dataset's tile-archives prefix are rejected", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    const other = crypto.randomUUID();

    await s().begin();
    await s().asUser(ALICE);
    await expect(
      s().denied(
        `select public.install_tile_archive(${sqlLit(datasetId)}, 0, ${sqlLit(`tile-archives/${other}/x.pmtiles`)}, 1, 12, 0, 2)`,
      ),
    ).resolves.toMatch(/tile-archives\/<datasetId>/i);
    await expect(
      s().denied(
        `select public.install_tile_archive(${sqlLit(datasetId)}, 0, ${sqlLit(`geometries/${datasetId}/x.json`)}, 1, 12, 0, 2)`,
      ),
    ).resolves.toMatch(/tile-archives\/<datasetId>/i);
    await s().rollback();
    await dropDatasets(s(), [datasetId]);
  });

  test("non-editors cannot install (definer RPC still answers the §4 gate)", async () => {
    const lockedId = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });
    const openId = await createDataset(s(), { createdBy: ALICE });

    // BOB on a LOCKED dataset: the definer UPDATE matches no row → false,
    // the §4 "reads as not found" shape (indistinguishable from a CAS miss
    // by design — §5.6: the caller re-reads map_tile_cache_version either
    // way).
    await s().begin();
    await s().asUser(BOB);
    const deniedRows = await s().expectOk(
      `select public.install_tile_archive(${sqlLit(lockedId)}, 0, ${sqlLit(`tile-archives/${lockedId}/x.pmtiles`)}, 1, 12, 0, 2) as ok`,
    );
    expect(deniedRows[0].ok as string).toBe("f");

    // BOB on an OPEN dataset installs fine (trusted collaborator, ADR 0010).
    const okRows = await s().expectOk(
      `select public.install_tile_archive(${sqlLit(openId)}, 0, ${sqlLit(`tile-archives/${openId}/x.pmtiles`)}, 1, 12, 0, 2) as ok`,
    );
    expect(okRows[0].ok as string).toBe("t");
    await s().rollback();
    await dropDatasets(s(), [lockedId, openId]);
  });
});
