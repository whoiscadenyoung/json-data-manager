// Integration tests — the app builder domain (migration 0022_project_apps.sql:
// apps as PROJECT-OWNED rows, the app_versions freeze chain, the kind-'app'
// memberships, and the re-owned seeded examples) against the local Supabase
// Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), fixtures created INSIDE the test
// transaction (the created_by stamp trigger stamps auth.uid(), so admin
// connections cannot create app rows), everything rolled back at the end.
// Works against CI's service container (SUPABASE_DB_URL) and the local stack
// unchanged; skips with a one-line reason when neither is reachable.
//
// The seed tests read COMMITTED rows (the migrations'): they assert presence
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

/** The seeded identities' fixed uuids (migration 0014's constants + 0022's project/map). */
const SYSTEM_OWNER = "e0000000-0000-4000-8000-000000000000";
const PARKS = "e0000000-0000-4000-8000-000000000001";
const VISITS = "e0000000-0000-4000-8000-000000000002";
const EXPLORER = "e0000000-0000-4000-8000-000000000003";
const ATLAS = "e0000000-0000-4000-8000-000000000004";
const EXAMPLES_PROJECT = "e0000000-0000-4000-8000-000000000005";
const EXAMPLES_MAP = "e0000000-0000-4000-8000-000000000006";

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

/** Creates a project owned by ALICE (the birth trigger mints her owner membership); returns its id. */
async function createProject(title = "pg-int project"): Promise<string> {
  const id = crypto.randomUUID();
  await s().expectOk(
    `insert into public.projects (id, title) values (${sqlLit(id)}, ${sqlLit(title)})`,
  );
  return id;
}

/** Creates an app row AS THE CURRENT ROLE (stamp attribution) in a project; returns its id. */
async function createApp(projectId: string, title = "pg-int app"): Promise<string> {
  const id = crypto.randomUUID();
  const rows = await s().expectOk(
    `insert into public.apps (id, title, project_id) values (${sqlLit(id)}, ${sqlLit(title)}, ${sqlLit(projectId)}) returning id::text as id`,
  );
  return rows[0].id as string;
}

describe.skipIf(!dbUp())("seeded examples (0014/0022) — presence after reset", () => {
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
              created_by::text as by, project_id::text as proj
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
      expect(row.proj).toBe(EXAMPLES_PROJECT);
    }
    expect(Number(apps[0].pages)).toBe(1);
    expect(Number(apps[1].pages)).toBe(2);
  });

  test("the 'System examples' project owns the example chain: dataset memberships, the layer, the map, the placement, the app memberships", async () => {
    const project = await s().expectOk(
      `select title, created_by::text as by from public.projects where id = ${sqlLit(EXAMPLES_PROJECT)}`,
    );
    expect(project).toHaveLength(1);
    expect(project[0].title).toBe("System examples");
    expect(project[0].by).toBe(SYSTEM_OWNER);

    const memberships = await s().expectOk(
      `select artifact_kind, role, artifact_id from public.project_artifacts
        where project_id = ${sqlLit(EXAMPLES_PROJECT)} order by artifact_kind, artifact_id`,
    );
    const kinds = new globalThis.Map<string, string[]>();
    for (const row of memberships) {
      const list = kinds.get(row.artifact_kind as string) ?? [];
      list.push(
        (row.role as string) === "owned" ? (row.artifact_id as string) : (row.role as string),
      );
      kinds.set(row.artifact_kind as string, list);
    }
    // Two dataset memberships (owned, the sample datasets), one layer, two apps.
    expect(kinds.get("dataset")).toStrictEqual([PARKS, VISITS]);
    expect(kinds.get("app")).toStrictEqual([EXPLORER, ATLAS]);
    const layerMembership = kinds.get("layer") ?? [];
    expect(layerMembership).toHaveLength(1);
    const layerId = layerMembership[0];
    const layer = await s().expectOk(
      `select l.kind, l.name, pa.artifact_id as member from public.layers l
         join public.project_artifacts pa on pa.id = l.dataset_member_id
        where l.id = ${sqlLit(layerId)}`,
    );
    expect(layer[0].kind).toBe("data");
    expect(layer[0].name).toBe("National parks (example)");
    expect(layer[0].member).toBe(PARKS);

    const map = await s().expectOk(
      `select name, project_id::text as proj from public.maps where id = ${sqlLit(EXAMPLES_MAP)}`,
    );
    expect(map).toHaveLength(1);
    expect(map[0].proj).toBe(EXAMPLES_PROJECT);
    const placement = await s().expectOk(
      `select m."order", m.visible, pa.artifact_kind, pa.role
         from public.map_layers m join public.project_artifacts pa on pa.id = m.layer_member_id`,
    );
    expect(placement).toHaveLength(1);
    expect(placement[0].artifact_kind).toBe("layer");
    expect(placement[0].role).toBe("owned");
    expect(placement[0].visible).toBe("t");
  });

  test("the example apps' map widgets reference the stored map — the inline datasetIds mode retired", async () => {
    const widgets = await s().expectOk(
      `select jsonb_path_query_array(pages, '$.widgets[*] ? (@.kind == "map")') as maps
         from public.apps where id = ${sqlLit(EXPLORER)}`,
    );
    // The wire hands jsonb back as text (the raw wire client's posture);
    // the query JSON-parses it for the assertion.
    const maps = JSON.parse(widgets[0].maps as string) as Array<Record<string, unknown>>;
    expect(maps.length).toBeGreaterThan(0);
    for (const widget of maps) {
      expect(widget.mapId).toBe(EXAMPLES_MAP);
      expect(widget).not.toHaveProperty("datasetIds");
    }
  });

  test("the example apps ship a PUBLISHED version whose snapshot is self-contained", async () => {
    const versions = await s().expectOk(
      `select app_id::text as app, version_label as label,
              jsonb_array_length(definition->'datasetPins') as pins,
              jsonb_array_length(definition->'mapSnapshots') as maps,
              jsonb_array_length(definition->'layerVersions') as lvs,
              jsonb_array_length(definition->'pages') as pages
         from public.app_versions where app_id in (${sqlLit(EXPLORER)}, ${sqlLit(ATLAS)})
         order by app_id`,
    );
    expect(versions.map((row) => row.app)).toStrictEqual([EXPLORER, ATLAS]);
    for (const row of versions) {
      expect(row.label).toBe("v1");
      expect(Number(row.pins)).toBe(2);
      expect(Number(row.maps)).toBe(1);
      expect(Number(row.lvs)).toBe(1);
    }

    // The snapshot's dataset pins name the head versions (the publish_version
    // freezes 28 parks rows + 14 visits rows into version_entries).
    const entries = await s().expectOk(
      `select dv.dataset_id::text as ds, count(*) as n
         from public.version_entries ve join public.dataset_versions dv on dv.id = ve.version_id
        where dv.dataset_id in (${sqlLit(PARKS)}, ${sqlLit(VISITS)}) group by dv.dataset_id`,
    );
    const byDataset = new globalThis.Map(entries.map((row) => [row.ds, Number(row.n)]));
    expect(byDataset.get(PARKS)).toBe(28);
    expect(byDataset.get(VISITS)).toBe(14);

    // The map snapshot's placement points at the parks layer's published version.
    const placementVersion = await s().expectOk(
      `select lv.id::text as id, lv.version_label as label, lv.dataset->>'pinnedRef' as ref
         from public.layer_versions lv
        where lv.layer_id in (select pa.artifact_id::uuid from public.project_artifacts pa
                               where pa.project_id = ${sqlLit(EXAMPLES_PROJECT)} and pa.artifact_kind = 'layer')`,
    );
    expect(placementVersion).toHaveLength(1);
    expect(placementVersion[0].label).toBe("v1");
    expect(placementVersion[0].ref).not.toBeNull();

    // A signed-in NON-MEMBER reads the published app + its snapshot + the
    // frozen rows (the example arm + everyone-visible datasets), but NOT the
    // live project rows — the published render is snapshot-driven.
    await s().begin();
    await s().asUser(BOB);
    expect(
      await s().count(`select count(*) as n from public.apps where id = ${sqlLit(EXPLORER)}`),
    ).toBe(1);
    expect(
      await s().count(
        `select count(*) as n from public.app_versions where app_id = ${sqlLit(EXPLORER)}`,
      ),
    ).toBe(1);
    expect(
      await s().count(
        `select count(*) as n from public.version_entries ve join public.dataset_versions dv on dv.id = ve.version_id
          where dv.dataset_id = ${sqlLit(PARKS)}`,
      ),
    ).toBe(28);
    expect(
      await s().count(`select count(*) as n from public.maps where id = ${sqlLit(EXAMPLES_MAP)}`),
    ).toBe(0);
    expect(
      await s().count(
        `select count(*) as n from public.projects where id = ${sqlLit(EXAMPLES_PROJECT)}`,
      ),
    ).toBe(0);
    await s().rollback();
  });
});

describe.skipIf(!dbUp())(
  "apps RLS (0022) — project-member reads, project-editor writes, anon nothing",
  () => {
    test("anon is denied everywhere", async () => {
      await s().begin();
      await s().asAnon();
      expect(await s().count("select count(*) as n from public.apps")).toBe(0);
      await expect(
        s().denied(
          `insert into public.apps (id, title, project_id) values ('${crypto.randomUUID()}', 'anon', '${EXAMPLES_PROJECT}')`,
        ),
      ).resolves.toMatch(/row-level security/i);
      await s().rollback();
    });

    test("a non-member reads nothing; the owner reads; a viewer reads but cannot write; an editor writes", async () => {
      await asAlice();
      const projectId = await createProject();
      const appId = await createApp(projectId);

      // A signed-out-of-the-project user (BOB holds no membership yet) reads
      // nothing — the 0014 flat authenticated SELECT is gone.
      await s().asUser(BOB);
      expect(
        await s().count(`select count(*) as n from public.apps where id = ${sqlLit(appId)}`),
      ).toBe(0);

      // The owner (ALICE, via the birth-trigger membership) reads and writes.
      await s().asUser(ALICE);
      expect(
        await s().count(`select count(*) as n from public.apps where id = ${sqlLit(appId)}`),
      ).toBe(1);

      // A VIEWER seat reads the app but every write answers 0 rows.
      await s().expectOk(
        `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectId)}, ${sqlLit(BOB)}, 'viewer')`,
      );
      await s().asUser(BOB);
      expect(
        await s().count(`select count(*) as n from public.apps where id = ${sqlLit(appId)}`),
      ).toBe(1);
      expect(
        await s().denied(`update public.apps set title = 'hijacked' where id = ${sqlLit(appId)}`),
      ).toMatch(/0 rows affected/);
      expect(await s().denied(`delete from public.apps where id = ${sqlLit(appId)}`)).toMatch(
        /0 rows affected/,
      );

      // Bump BOB to editor — the same seat the maps/layers stores gate on.
      await s().asUser(ALICE);
      await s().expectOk(
        `update public.project_members set role = 'editor' where project_id = ${sqlLit(projectId)} and user_id = ${sqlLit(BOB)}`,
      );
      await s().asUser(BOB);
      await s().expectOk(
        `update public.apps set title = 'editor renamed' where id = ${sqlLit(appId)}`,
      );

      // The owner's own writes still go through (and the row cleans up).
      await s().asUser(ALICE);
      await s().expectOk(`update public.apps set title = 'renamed' where id = ${sqlLit(appId)}`);
      await s().expectOk(`delete from public.apps where id = ${sqlLit(appId)}`);
      await s().rollback();
    });

    test("created_by is stamped to the invoker, never claimed from the payload", async () => {
      await asAlice();
      const projectId = await createProject();
      const appId = crypto.randomUUID();
      await s().expectOk(
        `insert into public.apps (id, title, project_id, created_by) values (${sqlLit(appId)}, 'spoofed', ${sqlLit(projectId)}, ${sqlLit(BOB)})`,
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
      // hands back. The creator is (by the insert policy) an editor of the
      // project, so the member-wide SELECT policy admits the read-back.
      await s().begin();
      await s().asUser(ALICE);
      const projectId = await createProject();
      const result = await s().query(
        `insert into public.apps (title, project_id) values ('returning-regression', ${sqlLit(projectId)}) returning id, title;`,
      );
      expect(result.error).toBeUndefined();
      const row = result.rows.at(-1);
      expect(row !== undefined && typeof row.id === "string").toBe(true);
      await s().rollback();
    });

    test("the examples are read-only for every human editor — the explicit system guard", async () => {
      // A non-member of the examples project still READS the example apps
      // (the example arm) but every write answers 0 rows.
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

      // A session authenticated AS the system identity would pass
      // can_edit_project (it owns the examples project); the explicit
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
          `insert into public.apps (id, title, project_id) values ('${crypto.randomUUID()}', 'system', '${EXAMPLES_PROJECT}')`,
        ),
      ).resolves.toMatch(/row-level security/i);
      await s().rollback();
    });

    test("example is seed-only: a human cannot mint an example row", async () => {
      await s().begin();
      await s().asUser(ALICE);
      const projectId = await createProject();
      await expect(
        s().denied(
          `insert into public.apps (id, title, project_id, example) values ('${crypto.randomUUID()}', 'rogue example', ${sqlLit(projectId)}, true)`,
        ),
      ).resolves.toMatch(/row-level security/i);
      await s().rollback();
    });

    test("the seed's attribution rides the claims GUCs (the migration set them per statement)", async () => {
      // Structural: the apps stamp trigger exists and the seeded rows carry
      // the system attribution (0022's seed asserted the GUCs instead of
      // relying on trigger-less ordering).
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
      const projectId = await createProject();

      // sharing's literal union (validators.ts) as text + check.
      await expect(
        s().denied(
          `insert into public.apps (id, title, project_id, sharing) values ('${crypto.randomUUID()}', 'x', ${sqlLit(projectId)}, 'public')`,
        ),
      ).resolves.toMatch(/check/i);

      // saveContent's optimistic concurrency: the update lands exactly once
      // per expected revision (the store gates on eq revision). The
      // CommandComplete tag carries the affected count, so `query` (not
      // `expectOk`, which drops it) is read here.
      const appId = await createApp(projectId, "cas");
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
      // project_id is deliberately outside the UPDATE grant set — an app
      // cannot move projects.
      await expect(
        s().denied(
          `update public.apps set project_id = ${sqlLit(EXAMPLES_PROJECT)} where id = ${sqlLit(appId)}`,
        ),
      ).resolves.toMatch(/permission/i);
      // The writable set: title/description/sharing/dataset_ids/pages/revision/updated_at.
      await s().expectOk(
        `update public.apps set title = 'ok', pages = '[]'::jsonb, revision = 1, dataset_ids = '{}'::uuid[] where id = ${sqlLit(appId)}`,
      );
      await s().rollback();
    });

    test("app_versions: member-wide reads through the app's visibility, editor-only inserts, append-only", async () => {
      await asAlice();
      const projectId = await createProject();
      const appId = await createApp(projectId);

      // A viewer seat can freeze nothing.
      await s().expectOk(
        `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectId)}, ${sqlLit(BOB)}, 'viewer')`,
      );
      await s().asUser(BOB);
      await expect(
        s().denied(
          `insert into public.app_versions (app_id, version_label, definition) values (${sqlLit(appId)}, 'v1', '{}'::jsonb)`,
        ),
      ).resolves.toMatch(/row-level security/i);

      // An editor freezes a version; created_by stamps to them.
      await s().asUser(ALICE);
      await s().expectOk(
        `update public.project_members set role = 'editor' where project_id = ${sqlLit(projectId)} and user_id = ${sqlLit(BOB)}`,
      );
      await s().asUser(BOB);
      await s().expectOk(
        `insert into public.app_versions (app_id, version_label, definition) values (${sqlLit(appId)}, 'v1', '{"frozen":true}'::jsonb)`,
      );
      const stamped = await s().expectOk(
        `select created_by::text as by, definition->>'frozen' as frozen from public.app_versions where app_id = ${sqlLit(appId)}`,
      );
      expect(stamped[0].by as string).toBe(BOB);
      expect(stamped[0].frozen).toBe("true");

      // Append-only: no UPDATE/DELETE policies — even the owner cannot
      // rewrite a frozen row (the layer_versions posture: the denial reads
      // as 0 rows affected, not-found-shaped).
      await s().asUser(ALICE);
      await expect(
        s().denied(
          `update public.app_versions set definition = '{}'::jsonb where app_id = ${sqlLit(appId)}`,
        ),
      ).resolves.toMatch(/0 rows affected/);

      // Non-members cannot read the chain (the select rides the app's own RLS):
      // BOB mints a foreign project + app inside this transaction, ALICE (no
      // membership in it) reads nothing.
      await s().asUser(BOB);
      const foreign = crypto.randomUUID();
      await s().expectOk(
        `insert into public.projects (id, title) values (${sqlLit(foreign)}, 'foreign')`,
      );
      const foreignApp = await s().expectOk(
        `insert into public.apps (id, title, project_id) values ('${crypto.randomUUID()}', 'foreign app', ${sqlLit(foreign)}) returning id::text as id`,
      );
      await s().asUser(ALICE);
      expect(
        await s().count(
          `select count(*) as n from public.app_versions where app_id = ${sqlLit(foreignApp[0].id)}`,
        ),
      ).toBe(0);
      await s().rollback();
    });
  },
);
