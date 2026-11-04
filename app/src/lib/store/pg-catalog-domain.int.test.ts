// Integration tests — stage 3's catalog domain (docs/supabase-migration-design.md
// §3.4 collections/groups block + §3.2's datasets.group_id + §4 matrix rows)
// against the local Supabase Postgres, migration 0007_catalog.sql.
//
// Same wire-client pattern as the stage-1/2 pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), everything rolled back at the end.
// Works against CI's service container (SUPABASE_DB_URL) and the local stack
// unchanged. Skips with a one-line message when the stack is unreachable.
//
// Spelled-out acceptance rows (issue #202):
//   - membership ops match the component behaviors: many-to-many pairs,
//     standalone groups, the denormalized kind (stamped + rewritten);
//   - collection/group deletes cascade correctly (no orphan members);
//   - the catalog tables are authenticated read+write (shared artifacts,
//     ADR 0009) and anon gets nothing;
//   - attribution is stamped from the request, never claimed from a payload.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  BOB,
  createDataset,
  DB_URL,
  dbUp,
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

async function createCollection(name = "pg-int collection"): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.collections (name) values (${sqlLit(name)}) returning id::text as id`,
  );
  return rows[0].id as string;
}

async function createGroup(collectionId: string | null, name = "pg-int group"): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.groups (name${collectionId === null ? "" : ", collection_id"})
     values (${sqlLit(name)}${collectionId === null ? "" : `, ${sqlLit(collectionId)}`})
     returning id::text as id`,
  );
  return rows[0].id as string;
}

async function addMembership(collectionId: string, datasetId: string): Promise<void> {
  await s().expectOk(
    `insert into public.collection_datasets (collection_id, dataset_id)
     values (${sqlLit(collectionId)}, ${sqlLit(datasetId)})`,
  );
}

describe.skipIf(!dbUp())("catalog domain (0007 / §3.4 / §4)", () => {
  test("authenticated users CRUD the shared catalog across users; anon is denied everywhere", async () => {
    await asAlice();
    const collectionId = await createCollection();
    const groupId = await createGroup(collectionId);

    // BOB reads and writes ALICE's collection and group — shared catalog
    // artifacts (ADR 0009), the §4 matrix's authenticated-everything rows.
    await s().asUser(BOB);
    expect(
      await s().count(
        `select count(*) as n from public.collections where id = ${sqlLit(collectionId)}`,
      ),
    ).toBe(1);
    await s().expectOk(
      `update public.collections set name = 'renamed by bob' where id = ${sqlLit(collectionId)}`,
    );
    await s().expectOk(
      `update public.groups set description = 'bob was here' where id = ${sqlLit(groupId)}`,
    );
    const bobCollection = await createCollection("bob's collection");
    await s().expectOk(`delete from public.collections where id = ${sqlLit(bobCollection)}`);

    // anon gets nothing — no policy grants the anon role on any of the
    // three. The read denial is the empty-read shape (the count query runs,
    // zero rows pass); writes raise the policy violation.
    await s().asAnon();
    expect(await s().count(`select count(*) as n from public.collections`)).toBe(0);
    expect(await s().count(`select count(*) as n from public.groups`)).toBe(0);
    expect(await s().count(`select count(*) as n from public.collection_datasets`)).toBe(0);
    await s().denied(`insert into public.collections (name) values ('anon collection')`);
    await s().denied(`delete from public.collections where name = 'renamed by bob'`);
    await s().rollback();
  });

  test("attribution is stamped from the request; a claimed created_by is overwritten", async () => {
    await asAlice();
    const rows = await s().expectOk(
      `insert into public.collections (name, created_by) values ('claimed', ${sqlLit(BOB)})
       returning created_by::text as created_by`,
    );
    // The stamp trigger runs BEFORE the insert completes: ALICE's session id
    // wins over the payload's claim (the 0003 attribution rule).
    expect(rows[0].created_by).toBe(ALICE);
    await s().rollback();
  });

  test("membership is many-to-many with the kind denormalized at write time", async () => {
    await asAlice();
    const collectionId = await createCollection();
    const standardId = await createDataset(s(), { createdBy: ALICE });
    const geoId = await createDataset(s(), { createdBy: ALICE });
    await s().expectOk(
      `update public.datasets set is_geospatial = true where id = ${sqlLit(geoId)}`,
    );

    await addMembership(collectionId, standardId);
    await addMembership(collectionId, geoId);
    // Idempotency is the STORE's (the ignoreDuplicates upsert), not the
    // database's — a raw second insert hits the PK (asserted in the index
    // test below), so this layer only proves the pair exists once and the
    // client never sends kind: the stamp trigger read it off the rows.
    const kinds = await s().expectOk(
      `select dataset_id::text as dataset_id, kind from public.collection_datasets
       where collection_id = ${sqlLit(collectionId)}
         and dataset_id in (${sqlLit(standardId)}, ${sqlLit(geoId)})
       order by dataset_id`,
    );
    expect(kinds.length).toBe(2);
    const kindOf = new Map(kinds.map((row) => [row.dataset_id, row.kind]));
    expect(kindOf.get(standardId)).toBe("standard");
    expect(kindOf.get(geoId)).toBe("geospatial");

    // The same membership re-derived after a kind flip: rewriting the
    // dataset's kind rewrites its membership rows (the component's
    // startGeospatialConversion walk, as a trigger).
    await s().expectOk(
      `update public.datasets set is_geospatial = false where id = ${sqlLit(geoId)}`,
    );
    const flipped = await s().expectOk(
      `select kind from public.collection_datasets where dataset_id = ${sqlLit(geoId)}`,
    );
    expect(flipped[0].kind).toBe("standard");

    // A dataset in TWO collections keeps both memberships (many-to-many).
    const second = await createCollection("second collection");
    await addMembership(second, standardId);
    expect(
      await s().count(
        `select count(*) as n from public.collection_datasets where dataset_id = ${sqlLit(standardId)}`,
      ),
    ).toBe(2);
    await s().rollback();
  });

  test("deleting a collection cascades its memberships and floats its groups; deleting a group ungroups its datasets", async () => {
    await asAlice();
    const collectionId = await createCollection();
    const floatingId = await createGroup(collectionId, "will float");
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    const groupedId = await createGroup(null, "dataset's group");
    await s().expectOk(
      `update public.datasets set group_id = ${sqlLit(groupedId)} where id = ${sqlLit(datasetId)}`,
    );
    // Every statement MUST be awaited: the wire client is single-pipelined,
    // and an in-flight response interleaves with the next statement's frames
    // (the desync this file's first full run hit).
    await addMembership(collectionId, datasetId);

    // Collection delete: membership rows cascade; the nested group FLOATS
    // (ON DELETE SET NULL — the binding DDL's deviation from the component's
    // group-deleting walk).
    await s().expectOk(`delete from public.collections where id = ${sqlLit(collectionId)}`);
    expect(
      await s().count(
        `select count(*) as n from public.collection_datasets where collection_id = ${sqlLit(collectionId)}`,
      ),
    ).toBe(0);
    const floated = await s().expectOk(
      `select collection_id is null as floated from public.groups where id = ${sqlLit(floatingId)}`,
    );
    expect(floated[0].floated).toBe("t");

    // Group delete: the member dataset's group_id clears (the component's
    // deleteGroup ungroup walk), memberships untouched.
    await s().expectOk(`delete from public.groups where id = ${sqlLit(groupedId)}`);
    const ungrouped = await s().expectOk(
      `select group_id is null as ungrouped from public.datasets where id = ${sqlLit(datasetId)}`,
    );
    expect(ungrouped[0].ungrouped).toBe("t");

    // The FK-cascaded membership delete also fired the datasets trigger side:
    // the dataset row itself survived (only the link died).
    expect(
      await s().count(`select count(*) as n from public.datasets where id = ${sqlLit(datasetId)}`),
    ).toBe(1);
    await s().rollback();
  });

  test("regrouping a dataset is a datasets write — can_edit_dataset gates it (locked = creator-only)", async () => {
    await asAlice();
    const lockedId = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });
    const openId = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const groupId = await createGroup(null);

    // A non-creator collaborator cannot regroup the LOCKED dataset (the
    // datasets UPDATE policy filters to zero rows — the not-found denial
    // shape) but regroups the OPEN one.
    await s().asUser(BOB);
    await s().denied(
      `update public.datasets set group_id = ${sqlLit(groupId)} where id = ${sqlLit(lockedId)}`,
    );
    await s().expectOk(
      `update public.datasets set group_id = ${sqlLit(groupId)} where id = ${sqlLit(openId)}`,
    );
    const regrouped = await s().expectOk(
      `select group_id::text as group_id from public.datasets where id = ${sqlLit(openId)}`,
    );
    expect(regrouped[0].group_id).toBe(groupId);
    await s().rollback();
  });

  test("attribution and updated_at maintenance are wired on both catalog tables", async () => {
    await asAlice();
    const collectionId = await createCollection();
    const groupId = await createGroup(null);
    // The per-table maintenance triggers exist and the stamp rides the
    // session. (updated_at MOVEMENT can't be asserted from inside one
    // transaction — set_updated_at stamps now(), which is
    // transaction-constant — so the trigger's wiring is the assertion, the
    // function itself being stage-1-proven on datasets/entries.)
    const triggers = await s().expectOk(
      `select tgname from pg_trigger
       where tgrelid in ('public.collections'::regclass, 'public.groups'::regclass)
         and tgname in ('collections_set_updated_at', 'groups_set_updated_at',
                        'collections_stamp_created_by', 'groups_stamp_created_by')
       order by tgname`,
    );
    expect(triggers.map((row) => row.tgname)).toStrictEqual([
      "collections_set_updated_at",
      "collections_stamp_created_by",
      "groups_set_updated_at",
      "groups_stamp_created_by",
    ]);
    const stamped = await s().expectOk(
      `select created_by::text as created_by,
              c.updated_at >= c.created_at as fresh
       from public.collections c where c.id = ${sqlLit(collectionId)}`,
    );
    expect(stamped[0].created_by).toBe(ALICE);
    expect(stamped[0].fresh).toBe("t");
    const groupStamped = await s().expectOk(
      `select created_by::text as created_by, updated_at >= created_at as fresh from public.groups where id = ${sqlLit(groupId)}`,
    );
    expect(groupStamped[0].created_by).toBe(ALICE);
    expect(groupStamped[0].fresh).toBe("t");
    await s().rollback();
  });

  test("uuid ids and the by_dataset reverse index exist (the sketch's shapes)", async () => {
    await asAlice();
    // Reverse-lookup index from the sketch (§3.4 collection_datasets_by_dataset).
    const indexes = await s().expectOk(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and indexname in ('collection_datasets_by_dataset', 'groups_by_collection', 'datasets_by_group')`,
    );
    expect(indexes.length).toBe(3);
    // The join's PK is (collection_id, dataset_id) — duplicate pairs are
    // impossible even without ignoreDuplicates (a raw-SQL double insert).
    const collectionId = await createCollection();
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    await addMembership(collectionId, datasetId);
    const dup = await s().query(
      `insert into public.collection_datasets (collection_id, dataset_id)
       values (${sqlLit(collectionId)}, ${sqlLit(datasetId)})`,
    );
    expect(dup.error).toBeDefined();
    await s().rollback();
  });
});
