// Integration tests — export_profiles RLS (issue #303; migration 0030).
// Profiles follow the dataset's gates: viewers read, editors manage.
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

const SETTINGS = sqlLit(
  JSON.stringify({ format: "geojson", propertyNames: "labels", emptyFields: "omit" }),
);

describe.skipIf(!dbUp())("export_profiles RLS (#303)", () => {
  test("the creator manages profiles; a viewer reads but cannot write; anon sees nothing", async () => {
    // A locked dataset: BOB can view it (published, signed-in) but not edit it.
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "locked",
      lifecycle: "published",
      visibility: "signed-in",
    });
    try {
      await s().begin();
      await s().asUser(ALICE);
      const rows = await s().expectOk(
        `insert into public.export_profiles (dataset_id, name, settings)
         values (${sqlLit(datasetId)}, 'ArcGIS', ${SETTINGS}::jsonb) returning id::text as id, created_by::text as created_by`,
      );
      const profileId = String(rows[0].id);
      expect(rows[0].created_by).toBe(ALICE);

      // The name is unique per dataset and must not be blank.
      await s().denied(
        `insert into public.export_profiles (dataset_id, name) values (${sqlLit(datasetId)}, 'ArcGIS')`,
      );
      await s().denied(
        `insert into public.export_profiles (dataset_id, name) values (${sqlLit(datasetId)}, '  ')`,
      );
      await s().expectOk(
        `update public.export_profiles set name = 'ArcGIS v2' where id = ${sqlLit(profileId)}`,
      );

      await s().asUser(BOB);
      expect(
        await s().count(
          `select count(*) from public.export_profiles where dataset_id = ${sqlLit(datasetId)}`,
        ),
      ).toBe(1);
      await s().denied(
        `insert into public.export_profiles (dataset_id, name) values (${sqlLit(datasetId)}, 'mine')`,
      );
      await s().denied(
        `update public.export_profiles set name = 'hijacked' where id = ${sqlLit(profileId)}`,
      );
      await s().denied(`delete from public.export_profiles where id = ${sqlLit(profileId)}`);

      await s().asAnon();
      await s().denied(
        `insert into public.export_profiles (dataset_id, name) values (${sqlLit(datasetId)}, 'anon')`,
      );
      await s().denied(`select 1 from public.export_profiles`);

      await s().asUser(ALICE);
      await s().expectOk(`delete from public.export_profiles where id = ${sqlLit(profileId)}`);
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("a dataset the viewer cannot see hides its profiles", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      lifecycle: "draft",
      visibility: "members",
    });
    try {
      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(
        `insert into public.export_profiles (dataset_id, name) values (${sqlLit(datasetId)}, 'private')`,
      );
      await s().asUser(BOB);
      expect(
        await s().count(
          `select count(*) from public.export_profiles where dataset_id = ${sqlLit(datasetId)}`,
        ),
      ).toBe(0);
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});
