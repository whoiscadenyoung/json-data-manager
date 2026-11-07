// Integration tests — issue #261's anon serving contract (ADR 0023) against
// the local Supabase Postgres: the public route's read path serves ONLY the
// frozen published rows at link/public, and the negative space stays closed.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction, every
// statement awaited, everything rolled back at the end. Skips with a
// one-line message when the stack is unreachable (and separately when the
// storage schema is absent — a bare postgres service without the
// storage-api container legitimately has no storage.objects).
//
// The matrix:
//   * the serving closure as ANON — a public app's frozen head reads, and
//     through it the whole reference closure resolves anon-side:
//     layer_versions → dataset_versions → version_entries; the live tables
//     answer zero rows to anon forever (never drafts, never live data).
//   * min(closure) at anon — a public app with a members-only member (the
//     linked foreign pin, the #260 blocker) serves the app snapshot but NOT
//     that member's frozen rows; the closure engine never widens it.
//   * the ladder is exact — `signed-in` serves nothing to anon; `link` and
//     `public` both do; narrowing closes the gates again.
//   * the storage leg (0024) — anon reads the frozen-convention archive of a
//     link/public dataset; the LIVE-convention archive of the SAME dataset
//     and the frozen archive of a members dataset stay closed (the `frozen-`
//     path marker is the leak guard).

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  addEntry,
  ALICE,
  CAROL,
  createDataset,
  DB_URL,
  dbUp,
  ensureUsers,
  PgSession,
  sqlLit,
} from "./pg-int-helpers.int.test";

/** The first element, or a loud failure (the no-optional-chaining test style). */
function firstRow(
  rows: ReadonlyArray<Record<string, string | null>>,
): Record<string, string | null> {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected at least one row (have ${rows.length}).`);
  }
  return row;
}

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

async function beginAs(userId: string): Promise<void> {
  await s().begin();
  await s().asUser(userId);
}

/** Count of one table read filtered by an id, as a number (the RLS lens). */
async function countWhere(table: string, predicate: string): Promise<number> {
  const rows = await s().query(`select 1 from public.${table} where ${predicate}`);
  return rows.rows.length;
}

/** One owned dataset membership row (the project's "owns this dataset" edge). */
async function ownDataset(projectId: string, datasetId: string): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset', 'owned', 'manual')
     returning id::text as id`,
  );
  return firstRow(rows).id as string;
}

/** One LINKED dataset membership row — the foreign pin (its home rung caps the share). */
async function linkDataset(projectId: string, datasetId: string): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset', 'linked', 'manual')
     returning id::text as id`,
  );
  return firstRow(rows).id as string;
}

/** One owned data layer styling the given dataset membership; returns the LAYER id + its membership id. */
async function seedDataLayer(
  projectId: string,
  datasetMemberId: string,
): Promise<{ layerId: string; membershipId: string }> {
  const layerId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.layers (id, project_id, kind, name, dataset_member_id)
     values (${sqlLit(layerId)}, ${sqlLit(projectId)}, 'data', 'Serving layer', ${sqlLit(datasetMemberId)})`,
  );
  const rows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(layerId)}, 'layer', 'owned', 'manual')
     returning id::text as id`,
  );
  return { layerId, membershipId: firstRow(rows).id as string };
}

/** Publishes one dataset's frozen v1 (the anon gates read these rows). */
async function publishDataset(datasetId: string): Promise<void> {
  await s().expectOk(
    `select public.publish_version(${sqlLit(datasetId)}, 'v1', ${sqlLit(crypto.randomUUID())}, null)`,
  );
}

/**
 * The serving fixture (call after `beginAs(ALICE)`): ALICE's project P with
 * her OPEN dataset D_pub (owned) and CAROL's locked members-only D_locked
 * (linked — the #260 blocker shape); one data layer on D_pub's membership
 * with a frozen version, one map placing that layer, and one app embedding
 * the map + pinning BOTH datasets with a frozen v1 whose definition carries
 * the pins/snapshot. D_locked publishes (as CAROL — locked writes are
 * creator-only) so the negative-space probe reads REAL frozen rows that the
 * anon gate must still refuse. Returns every id the tests need.
 */
async function seedServing(): Promise<{
  appId: string;
  dLocked: string;
  dLockedVersion: string;
  dPub: string;
  dPubVersion: string;
  layerId: string;
  layerVersionId: string;
  mapId: string;
}> {
  const projectId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectId)}, 'serving P', ${sqlLit(ALICE)})`,
  );

  const dPub = await createDataset(s(), { createdBy: ALICE });
  const dPubMembership = await ownDataset(projectId, dPub);
  await addEntry(s(), dPub, { name: "served row" });
  await publishDataset(dPub);
  const dPubVersion = firstRow(
    await s().expectOk(
      `select id::text as id from public.dataset_versions where dataset_id = ${sqlLit(dPub)} order by created_at desc limit 1`,
    ),
  ).id as string;

  // CAROL's rows are HERS (the 0009 stamp rewrites created_by to the acting
  // identity): project + locked dataset insert WHILE SHE ACTS, and her
  // locked dataset publishes under her hand too.
  await s().asUser(CAROL);
  const dLocked = await createDataset(s(), {
    createdBy: CAROL,
    editPolicy: "locked",
    visibility: "members",
  });
  await addEntry(s(), dLocked, { name: "blocked row" });
  await publishDataset(dLocked);
  const dLockedVersion = firstRow(
    await s().expectOk(
      `select id::text as id from public.dataset_versions where dataset_id = ${sqlLit(dLocked)} order by created_at desc limit 1`,
    ),
  ).id as string;
  await s().asUser(ALICE);
  await linkDataset(projectId, dLocked);

  const layerSeed = await seedDataLayer(projectId, dPubMembership);
  const layerVersionId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.layer_versions (id, layer_id, version_label, definition)
     values (${sqlLit(layerVersionId)}, ${sqlLit(layerSeed.layerId)}, 'v1', '{"frozen": true}'::jsonb)`,
  );
  await s().expectOk(
    `update public.layers set lifecycle = 'published' where id = ${sqlLit(layerSeed.layerId)}`,
  );

  const mapId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.maps (id, name, project_id) values (${sqlLit(mapId)}, 'Serving map', ${sqlLit(projectId)})`,
  );
  await s().expectOk(
    `insert into public.map_layers (map_id, "order", layer_member_id, visible)
     values (${sqlLit(mapId)}, 0, ${sqlLit(layerSeed.membershipId)}, true)`,
  );

  const appId = crypto.randomUUID();
  const pages = JSON.stringify([{ widgets: [{ id: "w1", kind: "map", mapId, w: 6, h: 6 }] }]);
  const datasetIds = `array[${sqlLit(dPub)}, ${sqlLit(dLocked)}]::uuid[]`;
  await s().expectOk(
    `insert into public.apps (id, title, project_id, pages, dataset_ids)
     values (${sqlLit(appId)}, 'Serving app', ${sqlLit(projectId)}, ${sqlLit(pages)}::jsonb, ${datasetIds})`,
  );
  const definition = JSON.stringify({
    datasetPins: [
      { datasetId: dPub, versionId: dPubVersion, title: "served" },
      { datasetId: dLocked, versionId: dLockedVersion, title: "blocked" },
    ],
    layerVersions: [{ versionId: layerVersionId, kind: "data" }],
    mapSnapshots: [
      {
        mapId,
        name: "Serving map",
        placements: [{ order: 0, versionId: layerVersionId, visible: true }],
      },
    ],
    pages: pages,
    title: "Serving app",
  });
  await s().expectOk(
    `insert into public.app_versions (app_id, version_label, definition)
     values (${sqlLit(appId)}, 'v1', ${sqlLit(definition)}::jsonb)`,
  );

  return {
    appId,
    dLocked,
    dLockedVersion,
    dPub,
    dPubVersion,
    layerId: layerSeed.layerId,
    layerVersionId,
    mapId,
  };
}

describe.skipIf(!dbUp())("anon serving (0024 + ADR 0023, #261)", () => {
  test("the serving closure: preflight names the blocker, apply widens the rest, anon resolves exactly the public chain", async () => {
    await beginAs(ALICE);
    const f = await seedServing();

    // The closure engine caps the share at the locked foreign pin (never
    // widened, never silent) and widens everything else to link.
    const report = firstRow(
      await s().expectOk(
        `select public.visibility_preflight('app', ${sqlLit(f.appId)}, 'link') as report`,
      ),
    ).report;
    expect(String(report)).toContain(f.dLocked);
    const outcome = firstRow(
      await s().expectOk(
        `select public.visibility_apply('app', ${sqlLit(f.appId)}, 'link') as outcome`,
      ),
    ).outcome;
    expect(String(outcome)).toContain('"link"');

    // ANON: the app's frozen head serves, and through it the whole public
    // chain resolves — layer_versions, dataset_versions, version_entries.
    // The live tables answer zero forever.
    await s().asAnon();
    // The wire client pipelines ONE statement at a time (the stage-3 lesson:
    // concurrent statements desync it) — the table probes stay sequential.
    /* oxlint-disable eslint/no-await-in-loop -- the wire client serializes statements. */
    for (const table of ["datasets", "entries", "maps", "layers", "apps", "projects"]) {
      expect(await countWhere(table, "true")).toBe(0);
    }
    /* oxlint-enable eslint/no-await-in-loop */
    expect(await countWhere("app_versions", `app_id = ${sqlLit(f.appId)}`)).toBe(1);
    expect(await countWhere("layer_versions", `id = ${sqlLit(f.layerVersionId)}`)).toBe(1);
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(f.dPub)}`)).toBe(1);
    expect(await countWhere("version_entries", `version_id = ${sqlLit(f.dPubVersion)}`)).toBe(1);

    // min(closure) at anon: the pinned members-only member's frozen rows —
    // REAL published rows, published under CAROL's hand — stay closed even
    // though the app snapshot names them.
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(f.dLocked)}`)).toBe(0);
    expect(await countWhere("version_entries", `version_id = ${sqlLit(f.dLockedVersion)}`)).toBe(0);

    // Narrowing closes the serving gate (the same URL a signed-out visitor
    // holds stops resolving).
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.apps set visibility = 'members' where id = ${sqlLit(f.appId)}`,
    );
    await s().asAnon();
    expect(await countWhere("app_versions", `app_id = ${sqlLit(f.appId)}`)).toBe(0);
  });

  test("the ladder is exact for anon: signed-in serves nothing, link and public both serve", async () => {
    await beginAs(ALICE);
    const f = await seedServing();

    // The app widens to `signed-in` WITHOUT the closure engine (a plain
    // column write): the frozen head stays anon-closed at exactly that rung.
    await s().expectOk(
      `update public.apps set visibility = 'signed-in' where id = ${sqlLit(f.appId)}`,
    );
    await s().expectOk(
      `update public.datasets set visibility = 'signed-in' where id = ${sqlLit(f.dPub)}`,
    );
    await s().asAnon();
    expect(await countWhere("app_versions", `app_id = ${sqlLit(f.appId)}`)).toBe(0);
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(f.dPub)}`)).toBe(0);

    // `link` opens the frozen rows; `public` keeps them open.
    await s().asUser(ALICE);
    await s().expectOk(`update public.apps set visibility = 'link' where id = ${sqlLit(f.appId)}`);
    await s().expectOk(
      `update public.datasets set visibility = 'link' where id = ${sqlLit(f.dPub)}`,
    );
    await s().asAnon();
    expect(await countWhere("app_versions", `app_id = ${sqlLit(f.appId)}`)).toBe(1);
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(f.dPub)}`)).toBe(1);
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.apps set visibility = 'public' where id = ${sqlLit(f.appId)}`,
    );
    await s().expectOk(
      `update public.datasets set visibility = 'public' where id = ${sqlLit(f.dPub)}`,
    );
    await s().asAnon();
    expect(await countWhere("app_versions", `app_id = ${sqlLit(f.appId)}`)).toBe(1);
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(f.dPub)}`)).toBe(1);
  });
});

// Probed at module load, like the helper's DB probe: describe.skipIf
// evaluates at registration time, before any beforeEach runs.
let storageProbed: boolean | undefined;
try {
  const probe = await PgSession.connect(DB_URL);
  storageProbed =
    (await probe.count(
      "select count(*) as n from pg_tables where schemaname = 'storage' and tablename = 'objects'",
    )) > 0;
  await probe.close();
  if (!storageProbed) {
    console.log("skipping: storage schema absent (no storage-api container against this DB)");
  }
} catch {
  storageProbed = false;
}

function storageUp(): boolean {
  return storageProbed ?? false;
}

describe.skipIf(!dbUp() || !storageUp())("anon tile storage leg (0024)", () => {
  test("anon reads frozen-convention archives of link/public datasets; live objects and members datasets stay closed", async () => {
    await beginAs(ALICE);
    const dPub = await createDataset(s(), { createdBy: ALICE });
    const dLocked = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "locked",
      visibility: "members",
    });
    // Only the PUBLIC dataset widens; the members dataset publishes (so its
    // frozen archive EXISTS and the probe would catch a leak) but stays at
    // its members rung.
    await s().expectOk(
      `update public.datasets set visibility = 'link', lifecycle = 'published' where id = ${sqlLit(dPub)}`,
    );
    await s().expectOk(
      `update public.datasets set lifecycle = 'published' where id = ${sqlLit(dLocked)}`,
    );

    // The uploader (an editor of both) stamps the objects: one frozen-
    // convention archive per dataset, plus the LIVE-convention archive of
    // the public dataset (the leak guard's control).
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('tile-archives', ${sqlLit(`${dPub}/frozen-${crypto.randomUUID()}-t.pmtiles`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('tile-archives', ${sqlLit(`${dPub}/v3-live-attempt.pmtiles`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('tile-archives', ${sqlLit(`${dLocked}/frozen-${crypto.randomUUID()}-t.pmtiles`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );

    await s().asAnon();
    // The frozen archive of a link dataset: anon-visible (the published
    // map's tile source).
    expect(
      await s().count(
        `select count(*) as n from storage.objects where bucket_id = 'tile-archives' and name like ${sqlLit(`${dPub}/frozen-%`)}`,
      ),
    ).toBe(1);
    // The same dataset's LIVE archive: closed (it can carry post-freeze
    // edits — the ladder never grants anon the live data).
    expect(
      await s().count(
        `select count(*) as n from storage.objects where bucket_id = 'tile-archives' and name like ${sqlLit(`${dPub}/v%`)}`,
      ),
    ).toBe(0);
    // The members dataset's frozen archive: closed (its dataset's rung caps
    // the object, whatever the path says).
    expect(
      await s().count(
        `select count(*) as n from storage.objects where bucket_id = 'tile-archives' and name like ${sqlLit(`${dLocked}/frozen-%`)}`,
      ),
    ).toBe(0);

    // Signed-in serving is unchanged: the 0004 policy still covers every
    // object the creator can view.
    await s().asUser(ALICE);
    expect(
      await s().count(
        `select count(*) as n from storage.objects where bucket_id = 'tile-archives' and name like ${sqlLit(`${dPub}/%`)}`,
      ),
    ).toBe(2);
  });
});
