// Integration tests — rewrite_entry_field (issue #292; migration 0031).
// The set-based apply behind "Type as currency": values replace data->field,
// null removes it, RLS decides who may write, other datasets are untouched.
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

async function dataOf(entryId: string): Promise<unknown> {
  const rows = await s().expectOk(
    `select data::text as data from public.entries where id = ${sqlLit(entryId)}`,
  );
  return JSON.parse(String(rows[0].data));
}

function values(pairs: Array<[string, unknown]>): string {
  return `${sqlLit(JSON.stringify(pairs.map(([id, value]) => ({ id, value }))))}::jsonb`;
}

describe.skipIf(!dbUp())("rewrite_entry_field (#292)", () => {
  test("replaces values, removes nulls, ignores other datasets, and follows RLS", async () => {
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
      const a = await insertEntry(datasetId, { Amount: "$1,000", Name: "A" });
      const b = await insertEntry(datasetId, { Amount: " ", Name: "B" });
      const foreign = await insertEntry(otherId, { Amount: "$5" });

      const changed = await s().expectOk(
        `select public.rewrite_entry_field(${sqlLit(datasetId)}, 'Amount', ${values([
          [a, 1000],
          [b, null],
          [foreign, 5],
        ])}) as n`,
      );
      // The foreign id is dropped by the dataset predicate.
      expect(Number(changed[0].n)).toBe(2);
      expect(await dataOf(a)).toStrictEqual({ Amount: 1000, Name: "A" });
      expect(await dataOf(b)).toStrictEqual({ Name: "B" });
      expect(await dataOf(foreign)).toStrictEqual({ Amount: "$5" });

      // BOB can view the locked dataset but not edit it: RLS filters every row.
      await s().asUser(BOB);
      const denied = await s().expectOk(
        `select public.rewrite_entry_field(${sqlLit(datasetId)}, 'Amount', ${values([[a, 1]])}) as n`,
      );
      expect(Number(denied[0].n)).toBe(0);

      await s().asAnon();
      await s().denied(
        `select public.rewrite_entry_field(${sqlLit(datasetId)}, 'Amount', ${values([[a, 2]])})`,
      );

      await s().asUser(ALICE);
      expect(await dataOf(a)).toStrictEqual({ Amount: 1000, Name: "A" });
      await s().denied(`select public.rewrite_entry_field(${sqlLit(datasetId)}, ' ', '[]'::jsonb)`);
    } finally {
      await dropDatasets(s(), [datasetId, otherId]);
    }
  });
});
