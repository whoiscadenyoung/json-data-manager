// Integration tests — the maps + layers domain (issue #257, migration 0020,
// ADR 0019) against the local Supabase Postgres.
//
// Same wire-client pattern as the stage-1 pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), everything rolled back at the end.
// Works against CI's service container (SUPABASE_DB_URL) and the local stack
// unchanged. Skips with a one-line message when the stack is unreachable.
//
// Fixtures are created INSIDE the test transaction: the attribution columns
// are stamped from auth.uid() (NOT NULL), so they cannot be created by the
// admin connection the way dataset fixtures are.
//
// The matrix (ADR 0019; owner > editor > viewer, the 0018 helpers):
//   * maps/layers/layer_children/layer_versions — reads member-wide,
//     content writes editor+; a non-member reads zero rows (the
//     no-existence-leak posture) and anon is denied everywhere.
//   * placements CASCADE with their layer MEMBERSHIP; a dataset membership's
//     removal cascades its layers (and their children).
//   * layer_versions rows are append-only — no UPDATE/DELETE policies at
//     all (the dataset_versions posture).
//   * the realtime publication carries layers + layer_children + map_layers;
//     layer_styles left it (the table died with 0020).

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  BOB,
  CAROL,
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

/** One project with the fixture members: ALICE owner (the birth trigger), BOB editor, CAROL viewer — plus a second ALICE-only project for the outsider lens. */
async function seedProject(): Promise<{ projectA: string; projectB: string }> {
  const projectA = crypto.randomUUID();
  const projectB = crypto.randomUUID();
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectA)}, 'maps A', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectB)}, 'maps B', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectA)}, ${sqlLit(BOB)}, 'editor')`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectA)}, ${sqlLit(CAROL)}, 'viewer')`,
  );
  return { projectA, projectB };
}

async function createMap(projectId: string, name = "pg-int map"): Promise<string> {
  const id = crypto.randomUUID();
  await s().expectOk(
    `insert into public.maps (id, name, project_id) values (${sqlLit(id)}, ${sqlLit(name)}, ${sqlLit(projectId)})`,
  );
  return id;
}

/** One dataset membership + the owned data layer styling it + the layer's kind-'layer' membership — the create flow's row set. */
async function seedDataLayer(
  projectId: string,
  datasetId: string,
): Promise<{ layerId: string; layerMembershipId: string }> {
  const memberRows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset', 'linked', 'manual') returning id::text as id`,
  );
  const memberRow = memberRows[0];
  if (memberRow === undefined || memberRow.id === null) throw new Error("no membership");
  const datasetMemberId: string = memberRow.id;
  const layerId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.layers (id, project_id, kind, name, dataset_member_id)
     values (${sqlLit(layerId)}, ${sqlLit(projectId)}, 'data', 'Parks', ${sqlLit(datasetMemberId)})`,
  );
  const lmRows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(layerId)}, 'layer', 'owned', 'manual') returning id::text as id`,
  );
  const lmRow = lmRows[0];
  if (lmRow === undefined || lmRow.id === null) throw new Error("no layer membership");
  return { layerId, layerMembershipId: lmRow.id };
}

async function place(mapId: string, layerMembershipId: string, order = 0): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.map_layers (map_id, "order", layer_member_id, visible)
     values (${sqlLit(mapId)}, ${order}, ${sqlLit(layerMembershipId)}, true) returning id::text as id`,
  );
  const row = rows[0];
  if (row === undefined || row.id === null) throw new Error("no placement");
  return row.id;
}

describe.skipIf(!dbUp())("maps + layers domain (0020, ADR 0019)", () => {
  test("role matrix: members read the workspace, editors write it, viewers can't, outsiders stay blind; anon denied everywhere", async () => {
    await asAlice();
    const seed = await seedProject();
    const mapId = await createMap(seed.projectA);
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    const { layerMembershipId } = await seedDataLayer(seed.projectA, datasetId);

    // EDITOR (BOB): reads the map + places layers.
    await s().asUser(BOB);
    expect(
      await s().count(`select count(*) as n from public.maps where id = ${sqlLit(mapId)}`),
    ).toBe(1);
    const placementId = await place(mapId, layerMembershipId, 0);
    await s().expectOk(
      `update public.map_layers set visible = false where id = ${sqlLit(placementId)}`,
    );
    // The editor restyles the layer (style lives on the layer row now).
    await s().expectOk(
      `update public.layers set style = '{"layers":[]}'::jsonb where project_id = ${sqlLit(seed.projectA)}`,
    );

    // VIEWER (CAROL): reads everything; every write answers the denial
    // shapes — INSERTs raise, UPDATE/DELETE filter to 0 rows.
    await s().asUser(CAROL);
    expect(
      await s().count(`select count(*) as n from public.maps where id = ${sqlLit(mapId)}`),
    ).toBe(1);
    expect(
      await s().count(
        `select count(*) as n from public.layers where project_id = ${sqlLit(seed.projectA)}`,
      ),
    ).toBe(1);
    await expect(
      s().denied(
        `insert into public.maps (id, name, project_id) values ('${crypto.randomUUID()}', 'carol', ${sqlLit(seed.projectA)})`,
      ),
    ).resolves.toMatch(/row-level security/i);
    await expect(
      s().denied(
        `update public.layers set name = 'carol was here' where project_id = ${sqlLit(seed.projectA)}`,
      ),
    ).resolves.toMatch(/0 rows/);
    await expect(
      s().denied(`update public.map_layers set visible = false where id = ${sqlLit(placementId)}`),
    ).resolves.toMatch(/0 rows/);

    // OUTSIDER (BOB against project B's map): blind. (Back to ALICE first —
    // the datasets INSERT lesson applies to maps too: the fixture creator
    // must hold the seat.)
    await s().asUser(ALICE);
    const foreignMap = await createMap(seed.projectB, "private map");
    await s().asUser(BOB);
    expect(
      await s().count(`select count(*) as n from public.maps where id = ${sqlLit(foreignMap)}`),
    ).toBe(0);

    // ANON: denied everywhere (the §4 matrix rule).
    await s().asAnon();
    expect(await s().count("select count(*) as n from public.maps")).toBe(0);
    expect(await s().count("select count(*) as n from public.layers")).toBe(0);
    expect(await s().count("select count(*) as n from public.layer_children")).toBe(0);
    expect(await s().count("select count(*) as n from public.layer_versions")).toBe(0);
    expect(await s().count("select count(*) as n from public.map_layers")).toBe(0);
    expect(await s().count("select count(*) as n from public.marker_sprites")).toBe(0);
    await expect(
      s().denied(
        `insert into public.maps (id, name, project_id) values ('${crypto.randomUUID()}', 'anon', ${sqlLit(seed.projectA)})`,
      ),
    ).resolves.toMatch(/row-level security/i);
    await s().rollback();
    await dropDatasets(s(), [datasetId]);
  });

  test("created_by is stamped to the invoker, never claimed (maps + layers)", async () => {
    await asAlice();
    const seed = await seedProject();
    const mapId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.maps (id, name, project_id, created_by) values (${sqlLit(mapId)}, 'spoofed', ${sqlLit(seed.projectA)}, ${sqlLit(BOB)})`,
    );
    const rows = await s().expectOk(
      `select created_by::text as by from public.maps where id = ${sqlLit(mapId)}`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("no map row");
    // ALICE is the invoker; BOB was claimed in the payload and dropped.
    expect(row.by).toBe(ALICE);

    const layerId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.layers (id, project_id, kind, name, created_by)
       values (${sqlLit(layerId)}, ${sqlLit(seed.projectA)}, 'group', 'spoofed layer', ${sqlLit(BOB)})`,
    );
    const layerRows = await s().expectOk(
      `select created_by::text as by from public.layers where id = ${sqlLit(layerId)}`,
    );
    const layerRow = layerRows[0];
    if (layerRow === undefined) throw new Error("no layer row");
    expect(layerRow.by).toBe(ALICE);
    await s().rollback();
  });

  test("the membership cascades: removing the layer membership removes its placements; removing the dataset membership removes its layers", async () => {
    await asAlice();
    const seed = await seedProject();
    const mapId = await createMap(seed.projectA);
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    const { layerId, layerMembershipId } = await seedDataLayer(seed.projectA, datasetId);
    const placementId = await place(mapId, layerMembershipId, 0);

    // Removing the layer's kind-'layer' membership removes its placement
    // through the FK cascade, but NOT the layer row.
    await s().expectOk(
      `delete from public.project_artifacts where id = ${sqlLit(layerMembershipId)}`,
    );
    expect(
      await s().count(
        `select count(*) as n from public.map_layers where id = ${sqlLit(placementId)}`,
      ),
    ).toBe(0);
    expect(
      await s().count(`select count(*) as n from public.layers where id = ${sqlLit(layerId)}`),
    ).toBe(1);

    // Removing the dataset membership cascades the layers styling it
    // (layers.dataset_member_id ON DELETE CASCADE).
    const memberRows = await s().expectOk(
      `select id::text as id from public.project_artifacts
       where artifact_id = ${sqlLit(datasetId)} and artifact_kind = 'dataset'`,
    );
    const memberRow = memberRows[0];
    if (memberRow === undefined || memberRow.id === null) throw new Error("no dataset membership");
    await s().expectOk(`delete from public.project_artifacts where id = ${sqlLit(memberRow.id)}`);
    expect(
      await s().count(`select count(*) as n from public.layers where id = ${sqlLit(layerId)}`),
    ).toBe(0);
    await s().rollback();
    await dropDatasets(s(), [datasetId]);
  });

  test("structure: placement draw order + layer kind/child constraints + version append-only", async () => {
    await asAlice();
    const seed = await seedProject();
    const mapId = await createMap(seed.projectA);
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    const { layerId, layerMembershipId } = await seedDataLayer(seed.projectA, datasetId);
    const p1 = await place(mapId, layerMembershipId, 0);
    // Gaps allowed; only relative order renders; ids tie-break.
    const p2Rows = await s().expectOk(
      `insert into public.map_layers (map_id, "order", layer_member_id, visible)
       values (${sqlLit(mapId)}, 7, ${sqlLit(layerMembershipId)}, false) returning id::text as id`,
    );
    const p2 = p2Rows[0];
    if (p2 === undefined || p2.id === null) throw new Error("no placement");
    const ordered = await s().expectOk(
      `select id::text as id from public.map_layers where map_id = ${sqlLit(mapId)} order by "order"`,
    );
    expect(ordered.map((r) => r.id)).toEqual([p1, p2.id]);

    // The layer kind domain (data | group).
    await expect(
      s().denied(
        `insert into public.layers (project_id, kind, name) values (${sqlLit(seed.projectA)}, 'schema', 'x')`,
      ),
    ).resolves.toMatch(/check/i);

    // A group's children: rows, not arrays; one child placement per (group, kind, child).
    const childId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.layers (id, project_id, kind, name) values (${sqlLit(childId)}, ${sqlLit(seed.projectA)}, 'data', 'Child')`,
    );
    await s().expectOk(
      `insert into public.layer_children (group_id, child_kind, child_layer_id, "order")
       values (${sqlLit(layerId)}, 'owned', ${sqlLit(childId)}, 0)`,
    );
    await expect(
      s().denied(
        `insert into public.layer_children (group_id, child_kind, child_layer_id, "order")
         values (${sqlLit(layerId)}, 'owned', ${sqlLit(childId)}, 1)`,
      ),
    ).resolves.toMatch(/duplicate key|unique/i);

    // layer_versions are append-only: INSERT lands; UPDATE and DELETE
    // answer 0 rows (no policies at all — the dataset_versions posture).
    const versionRows = await s().expectOk(
      `insert into public.layer_versions (layer_id, version_label, definition)
       values (${sqlLit(layerId)}, 'v1', '{"name":"Parks"}'::jsonb) returning id::text as id`,
    );
    const versionRow = versionRows[0];
    if (versionRow === undefined || versionRow.id === null) throw new Error("no version");
    const versionId: string = versionRow.id;
    await expect(
      s().denied(
        `update public.layer_versions set version_label = 'v9' where id = ${sqlLit(versionId)}`,
      ),
    ).resolves.toMatch(/0 rows/);
    await expect(
      s().denied(`delete from public.layer_versions where id = ${sqlLit(versionId)}`),
    ).resolves.toMatch(/0 rows/);
    await s().rollback();
    await dropDatasets(s(), [datasetId]);
  });

  test("the realtime publication carries layers, layer_children, map_layers — and layer_styles is gone", async () => {
    await s().asAdmin();
    for (const table of ["layers", "layer_children", "map_layers"]) {
      // oxlint-disable-next-line no-await-in-loop -- one wire session; statements must settle in order (the desync lesson).
      const rows = await s().expectOk(
        `select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = ${sqlLit(table)}`,
      );
      expect(rows.length, `${table} must join supabase_realtime`).toBe(1);
    }
    expect(
      await s().count(
        `select count(*) as n from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'layer_styles'`,
      ),
    ).toBe(0);
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
