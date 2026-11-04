// Integration tests — the app builder domain (migration 0014_app_builder.sql:
// the §3.6 apps block, its RLS row, and the seeded system:examples examples)
// against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), fixtures created INSIDE the test
// transaction (the created_by stamp trigger stamps auth.uid(), so admin
// connections cannot create app rows), everything rolled back at the end.
// Works against CI's service container (SUPABASE_DB_URL) and the local stack
// unchanged; skips with a one-line reason when neither is reachable.
//
// The seed tests read COMMITTED rows (the migration's): they assert presence
// after a `supabase db reset`, not their own fixtures.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  BOB,
  DB_URL,
  dbUp,
  ensureUsers,
  PgSession,
  sqlLit,
} from "./pg-int-helpers.int.test";

/** The seeded identities' fixed uuids (migration 0014's constants). */
const SYSTEM_OWNER = "e0000000-0000-4000-8000-000000000000";
const PARKS = "e0000000-0000-4000-8000-000000000001";
const VISITS = "e0000000-0000-4000-8000-000000000002";
const EXPLORER = "e0000000-0000-4000-8000-000000000003";
const ATLAS = "e0000000-0000-4000-8000-000000000004";

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

/** Creates an app row AS THE CURRENT ROLE (stamp attribution); returns its id. */
async function createApp(title = "pg-int app"): Promise<string> {
  const id = crypto.randomUUID();
  const rows = await s().expectOk(
    `insert into public.apps (id, title) values (${sqlLit(id)}, ${sqlLit(title)}) returning id::text as id`,
  );
  return rows[0].id as string;
}

describe.skipIf(!dbUp())("seeded examples (0014) — presence after reset", () => {
  test("the system profile, both sample datasets, and both example apps are committed", async () => {
    const profile = await s().expectOk(
      `select id::text as id, email, name from public.profiles where id = ${sqlLit(SYSTEM_OWNER)}`,
    );
    expect(profile).toHaveLength(1);
    expect(profile[0].email).toBe("system-examples@system.jdm.local");
    expect(profile[0].name).toBe("App builder examples");

    const parks = await s().expectOk(
      `select title, entry_count as entries, feature_count as features, edit_policy as policy,
              published_visibility as visibility, lifecycle, created_by::text as by
         from public.datasets where id = ${sqlLit(PARKS)}`,
    );
    expect(parks).toHaveLength(1);
    expect(parks[0].by).toBe(SYSTEM_OWNER);
    expect(Number(parks[0].entries)).toBe(28);
    expect(Number(parks[0].features)).toBe(28);
    expect(parks[0].policy).toBe("locked");
    expect(parks[0].visibility).toBe("everyone");
    expect(parks[0].lifecycle).toBe("published");

    const visits = await s().expectOk(
      `select entry_count as entries, feature_count as features, created_by::text as by
         from public.datasets where id = ${sqlLit(VISITS)}`,
    );
    expect(visits).toHaveLength(1);
    expect(Number(visits[0].entries)).toBe(14);
    expect(Number(visits[0].features)).toBe(0);

    const apps = await s().expectOk(
      `select id::text as id, title, sharing, example, revision, jsonb_array_length(pages) as pages,
              created_by::text as by
         from public.apps where example order by id`,
    );
    expect(apps.map((row) => row.id)).toStrictEqual([EXPLORER, ATLAS]);
    expect(apps.map((row) => row.title)).toStrictEqual([
      "National Parks Explorer",
      "Park Visits Atlas",
    ]);
    for (const row of apps) {
      expect(row.sharing).toBe("link");
      expect(row.example).toBe("t");
      expect(Number(row.revision)).toBe(0);
      expect(row.by).toBe(SYSTEM_OWNER);
    }
    expect(Number(apps[0].pages)).toBe(1);
    expect(Number(apps[1].pages)).toBe(2);
  });

  test("the example pages reference the seeded datasets; their rows are readable (RLS open, dataset published)", async () => {
    const refs = await s().expectOk(
      `select pages #>> '{0,widgets,5,datasetId}' as chart_ref, dataset_ids::text as ids
         from public.apps where id = ${sqlLit(EXPLORER)}`,
    );
    expect(refs[0].chart_ref).toBe(PARKS);
    expect(refs[0].ids).toContain(VISITS);

    // The read path the widgets ride: a signed-in viewer sees the sample
    // datasets (published + everyone), so the examples are live.
    await s().begin();
    await s().asUser(BOB);
    expect(
      await s().count(
        `select count(*) as n from public.entries where dataset_id in (${sqlLit(PARKS)}, ${sqlLit(VISITS)})`,
      ),
    ).toBe(42);
    await s().rollback();
  });
});

describe.skipIf(!dbUp())(
  "apps RLS (0014) — collaborator reads, creator writes, anon nothing",
  () => {
    test("anon is denied everywhere", async () => {
      await s().begin();
      await s().asAnon();
      expect(await s().count("select count(*) as n from public.apps")).toBe(0);
      await expect(
        s().denied(`insert into public.apps (id, title) values ('${crypto.randomUUID()}', 'anon')`),
      ).resolves.toMatch(/row-level security/i);
      await s().rollback();
    });

    test("the creator edits; the collaborator reads but cannot write", async () => {
      await asAlice();
      const appId = await createApp();

      // Collaborator READS the app (flat authenticated SELECT — the maps-domain
      // posture 0014 records)…
      await s().asUser(BOB);
      expect(
        await s().count(`select count(*) as n from public.apps where id = ${sqlLit(appId)}`),
      ).toBe(1);

      // …but every write answers 0 rows (the reads-as-not-found denial shape).
      expect(
        await s().denied(`update public.apps set title = 'hijacked' where id = ${sqlLit(appId)}`),
      ).toMatch(/0 rows affected/);
      expect(await s().denied(`delete from public.apps where id = ${sqlLit(appId)}`)).toMatch(
        /0 rows affected/,
      );

      // The creator's own writes go through.
      await s().asUser(ALICE);
      await s().expectOk(`update public.apps set title = 'renamed' where id = ${sqlLit(appId)}`);
      await s().expectOk(`delete from public.apps where id = ${sqlLit(appId)}`);
      await s().rollback();
    });

    test("created_by is stamped to the invoker, never claimed from the payload", async () => {
      await asAlice();
      const appId = crypto.randomUUID();
      await s().expectOk(
        `insert into public.apps (id, title, created_by) values (${sqlLit(appId)}, 'spoofed', ${sqlLit(BOB)})`,
      );
      const rows = await s().expectOk(
        `select created_by::text as by from public.apps where id = ${sqlLit(appId)}`,
      );
      expect(rows[0].by as string).toBe(ALICE);
      await s().rollback();
    });

    test("INSERT .. RETURNING passes the SELECT policy on the new row (0008)", async () => {
      // The shipped store create is `.insert(...).select(...)` — Postgres
      // evaluates the SELECT policy on the new row to decide what RETURNING
      // hands back. 0014's SELECT is flat `using (true)` (the ask's maps-domain
      // rule), so the read-back cannot fail the way the helper-gated policies
      // did pre-0008.
      await s().begin();
      await s().asUser(ALICE);
      const result = await s().query(
        `insert into public.apps (title) values ('returning-regression') returning id, title;`,
      );
      expect(result.error).toBeUndefined();
      const row = result.rows.at(-1);
      expect(row !== undefined && typeof row.id === "string").toBe(true);
      await s().rollback();
    });

    test("the examples are read-only for every human editor — the explicit system guard", async () => {
      // A non-creator.
      await s().begin();
      await s().asUser(BOB);
      expect(
        await s().count(`select count(*) as n from public.apps where id = ${sqlLit(EXPLORER)}`),
      ).toBe(1);
      expect(
        await s().denied(
          `update public.apps set title = 'vandalized' where id = ${sqlLit(EXPLORER)}`,
        ),
      ).toMatch(/0 rows affected/);
      expect(await s().denied(`delete from public.apps where id = ${sqlLit(EXPLORER)}`)).toMatch(
        /0 rows affected/,
      );
      await s().rollback();

      // A session authenticated AS the system identity would pass a bare
      // creator gate (created_by = auth.uid()); the explicit
      // `created_by <> system_examples_owner()` arm in every write policy is
      // what keeps the examples un-editable even then.
      await s().begin();
      await s().asUser(SYSTEM_OWNER);
      expect(
        await s().denied(`update public.apps set title = 'x' where id = ${sqlLit(ATLAS)}`),
      ).toMatch(/0 rows affected/);
      expect(await s().denied(`delete from public.apps where id = ${sqlLit(ATLAS)}`)).toMatch(
        /0 rows affected/,
      );
      await expect(
        s().denied(
          `insert into public.apps (id, title) values ('${crypto.randomUUID()}', 'system')`,
        ),
      ).resolves.toMatch(/row-level security/i);
      await s().rollback();
    });

    test("example is seed-only: a human cannot mint an example row", async () => {
      await s().begin();
      await s().asUser(ALICE);
      await expect(
        s().denied(
          `insert into public.apps (id, title, example) values ('${crypto.randomUUID()}', 'rogue example', true)`,
        ),
      ).resolves.toMatch(/row-level security/i);
      await s().rollback();
    });

    test("the seed's created_by stamp could not run mid-migration (the seed rows predate the trigger)", async () => {
      // Structural: the trigger exists and stamps; the seed's rows carry the
      // system attribution it would have nulled. (The migration creates the
      // stamp trigger LAST, after the seed — 0014's header note.)
      const trigger = await s().expectOk(
        `select count(*) as n from pg_trigger where tgrelid = 'public.apps'::regclass and tgname = 'apps_stamp_created_by'`,
      );
      expect(Number(trigger[0].n)).toBe(1);
      const rows = await s().expectOk(
        `select created_by::text as by from public.apps where example`,
      );
      for (const row of rows) {
        expect(row.by).toBe(SYSTEM_OWNER);
      }
    });

    test("structure parity: sharing is a two-literal check; revision is the CAS counter; column grants pin server-owned fields", async () => {
      await asAlice();

      // sharing's literal union (validators.ts) as text + check.
      await expect(
        s().denied(
          `insert into public.apps (id, title, sharing) values ('${crypto.randomUUID()}', 'x', 'public')`,
        ),
      ).resolves.toMatch(/check/i);

      // saveContent's optimistic concurrency: the update lands exactly once
      // per expected revision (the store gates on eq revision). The
      // CommandComplete tag carries the affected count, so `query` (not
      // `expectOk`, which drops it) is read here.
      const appId = await createApp("cas");
      const first = await s().query(
        `update public.apps set revision = revision + 1, dataset_ids = '{${PARKS}}'::uuid[] where id = ${sqlLit(appId)} and revision = 0`,
      );
      expect(first.error).toBeUndefined();
      // The wire tag carries a trailing NUL (the helpers' affectedCount
      // normalization); trim it for the comparison.
      expect((first.tag ?? "").replace(/\0/g, " ").trim()).toBe("UPDATE 1");
      const second = await s().query(
        `update public.apps set revision = revision + 1 where id = ${sqlLit(appId)} and revision = 0`,
      );
      expect(second.error).toBeUndefined();
      expect((second.tag ?? "").replace(/\0/g, " ").trim()).toBe("UPDATE 0");

      // The 0003 column-grant pattern: server-owned fields are unwritable by
      // the role, regardless of the policies.
      await expect(
        s().denied(`update public.apps set example = true where id = ${sqlLit(appId)}`),
      ).resolves.toMatch(/permission/i);
      await expect(
        s().denied(
          `update public.apps set created_by = ${sqlLit(BOB)} where id = ${sqlLit(appId)}`,
        ),
      ).resolves.toMatch(/permission/i);
      // The writable set: title/description/sharing/dataset_ids/pages/revision/updated_at.
      await s().expectOk(
        `update public.apps set pages = '[{"id":"p","title":"p","layout":"fullscreen","widgets":[]}]'::jsonb, updated_at = now() where id = ${sqlLit(appId)}`,
      );

      // updated_at maintenance rides the shared trigger.
      const stamps = await s().expectOk(
        `select count(*) as n from pg_trigger where tgrelid = 'public.apps'::regclass and tgname in ('apps_set_updated_at', 'apps_stamp_created_by')`,
      );
      expect(Number(stamps[0].n)).toBe(2);
      await s().rollback();
    });

    test("the sample datasets are locked behind the system creator (ADR 0010 shape)", async () => {
      await s().begin();
      await s().asUser(BOB);
      // Viewable (published + everyone) but not editable (locked + system
      // creator): can_edit_dataset answers false for every human session.
      expect(
        await s().count(`select count(*) as n from public.datasets where id = ${sqlLit(PARKS)}`),
      ).toBe(1);
      expect(
        (await s().expectOk(`select public.can_edit_dataset(${sqlLit(PARKS)}) as ok`))[0]
          .ok as string,
      ).toBe("f");
      expect(
        await s().denied(`update public.datasets set title = 'mine' where id = ${sqlLit(PARKS)}`),
      ).toMatch(/0 rows affected/);
      expect(await s().denied(`delete from public.datasets where id = ${sqlLit(PARKS)}`)).toMatch(
        /0 rows affected/,
      );
      await expect(
        s().denied(
          `insert into public.entries (dataset_id, data) values (${sqlLit(PARKS)}, '{"name":"x"}'::jsonb)`,
        ),
      ).resolves.toMatch(/row-level security/i);
      await s().rollback();
    });
  },
);
