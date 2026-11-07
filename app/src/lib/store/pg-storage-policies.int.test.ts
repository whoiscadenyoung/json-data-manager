// Integration tests — the §6 storage object policies (0004 + 0006's final
// shape): dataset-shaped buckets scope every object to the dataset encoded
// in the first path segment (reads can_view_dataset, writes
// can_edit_dataset + the uploader's owner stamp); marker-sprites reads are
// for every authenticated consumer while writes stay uploader-owned.
//
// Objects are inserted directly into storage.objects under the switched
// role — the same policies the storage service evaluates when PostgREST /
// signed-URL requests come through (the `authenticated` role holds the
// table privileges; RLS is the gate). Skips when the DB is unreachable,
// and skips separately (loudly) when the storage schema is absent — a bare
// postgres service without the storage-api container legitimately has no
// storage schema (both CI jobs boot one; see ci.yml).

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

// Probed at module load, like the helper's DB probe: describe.skipIf
// evaluates at registration time, before any beforeEach runs. When the DB
// itself is unreachable the helper already reported the skip line.
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

describe.skipIf(!dbUp() || !storageUp())("dataset-shaped buckets (§6)", () => {
  test("insert requires can_edit_dataset on the path's dataset AND the writer's owner stamp", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    const lockedId = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });

    await s().begin();
    await s().asUser(ALICE);
    // The creator, stamped as herself: allowed.
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('geometries', ${sqlLit(`${datasetId}/row-0.json`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );

    await s().asUser(BOB);
    // BOB may edit the open dataset, stamped as himself: allowed.
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('geometries', ${sqlLit(`${datasetId}/row-bob.json`)}, ${sqlLit(BOB)}, ${sqlLit(BOB)})`,
    );
    // BOB claiming ALICE's identity as the owner stamp: denied — the stamp
    // must be the writer's.
    await expect(
      s().denied(
        `insert into storage.objects (bucket_id, name, owner_id, owner)
         values ('geometries', ${sqlLit(`${datasetId}/row-spoofed.json`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
      ),
    ).resolves.toMatch(/row-level security/i);
    // A path naming a dataset BOB cannot edit: denied regardless of stamp.
    await expect(
      s().denied(
        `insert into storage.objects (bucket_id, name, owner_id, owner)
         values ('geometries', ${sqlLit(`${lockedId}/row-x.json`)}, ${sqlLit(BOB)}, ${sqlLit(BOB)})`,
      ),
    ).resolves.toMatch(/row-level security/i);
    // A first segment that is not a dataset id parses to null: fail closed.
    await expect(
      s().denied(
        `insert into storage.objects (bucket_id, name, owner_id, owner)
         values ('geometries', 'not-a-dataset/row.json', ${sqlLit(BOB)}, ${sqlLit(BOB)})`,
      ),
    ).resolves.toMatch(/row-level security/i);
    await s().rollback();

    await dropDatasets(s(), [datasetId, lockedId]);
  });

  test("select requires can_view_dataset on the path's dataset, not ownership", async () => {
    const openId = await createDataset(s(), { createdBy: ALICE });
    const authorOnlyId = await createDataset(s(), { createdBy: ALICE, visibility: "members" });

    await s().begin();
    await s().asUser(ALICE);
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('tile-archives', ${sqlLit(`${openId}/tiles.pmtiles`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('tile-archives', ${sqlLit(`${authorOnlyId}/tiles.pmtiles`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );

    await s().asUser(BOB);
    // Consumer reads: any viewer of the dataset signs a short-lived read —
    // ownership is irrelevant (§6 "short-lived signed reads for consumers").
    expect(
      await s().count(
        `select count(*) as n from storage.objects where bucket_id = 'tile-archives' and name = ${sqlLit(`${openId}/tiles.pmtiles`)}`,
      ),
    ).toBe(1);
    // A dataset visible to its author only hides its objects from BOB.
    expect(
      await s().count(
        `select count(*) as n from storage.objects where bucket_id = 'tile-archives' and name = ${sqlLit(`${authorOnlyId}/tiles.pmtiles`)}`,
      ),
    ).toBe(0);
    await s().rollback();

    await dropDatasets(s(), [openId, authorOnlyId]);
  });

  test("delete requires can_edit_dataset + the owner stamp", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });

    await s().begin();
    await s().asUser(ALICE);
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('source-files', ${sqlLit(`${datasetId}/import.csv`)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );

    await s().asUser(BOB);
    // A non-editor's DELETE can never succeed — the storage-api guard raises
    // on EVERY direct SQL delete (v1.88: "Direct deletion from storage
    // tables is not allowed"), so the owner-vs-non-owner difference lives in
    // the policy, verified structurally below rather than behaviorally.
    await expect(
      s().denied(
        `delete from storage.objects where bucket_id = 'source-files' and name = ${sqlLit(`${datasetId}/import.csv`)}`,
      ),
    ).resolves.toMatch(/Direct deletion|0 rows affected/i);
    await s().rollback();
    // Structural check: the delete policy gates on can_edit_dataset AND the
    // owner stamp (the policy text is stored in pg_policies).
    const pol = await s().expectOk(
      `select qual from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'migrated dataset buckets: delete requires editor + owner'`,
    );
    expect(pol[0].qual as string).toMatch(/can_edit_dataset/i);
    expect(pol[0].qual as string).toMatch(/owner/i);
    // The qual text is session-dependent: under the supabase admin
    // search_path (which includes auth, verified against the pinned CI
    // image) auth.uid() renders unqualified as `uid()` — match the call,
    // not its qualification.
    expect(pol[0].qual as string).toMatch(/uid\(\)/i);

    await dropDatasets(s(), [datasetId]);
  });
});

describe.skipIf(!dbUp() || !storageUp())("marker-sprites bucket (§6)", () => {
  test("every authenticated consumer reads; only the uploader writes", async () => {
    await s().begin();
    await s().asUser(ALICE);
    const name = `marker-sprites/${ALICE}/${crypto.randomUUID()}.png`;
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('marker-sprites', ${sqlLit(name)}, ${sqlLit(ALICE)}, ${sqlLit(ALICE)})`,
    );

    await s().asUser(BOB);
    // Shared catalog parity with the §4 marker_sprites row visibility: BOB
    // signs and renders other users' icons.
    expect(
      await s().count(
        `select count(*) as n from storage.objects where bucket_id = 'marker-sprites' and name = ${sqlLit(name)}`,
      ),
    ).toBe(1);
    // Writes stay uploader-owned: BOB can add his own sprite.
    const bobName = `marker-sprites/${BOB}/${crypto.randomUUID()}.png`;
    await s().expectOk(
      `insert into storage.objects (bucket_id, name, owner_id, owner)
       values ('marker-sprites', ${sqlLit(bobName)}, ${sqlLit(BOB)}, ${sqlLit(BOB)})`,
    );
    // But he cannot overwrite or remove ALICE's.
    await expect(
      s().denied(
        `update storage.objects set metadata = '{"m":1}'::jsonb where bucket_id = 'marker-sprites' and name = ${sqlLit(name)}`,
      ),
    ).resolves.toMatch(/0 rows affected/i);
    await expect(
      s().denied(
        `delete from storage.objects where bucket_id = 'marker-sprites' and name = ${sqlLit(name)}`,
      ),
    ).resolves.toMatch(/Direct deletion|0 rows affected/i);
    await s().rollback();
  });
});
