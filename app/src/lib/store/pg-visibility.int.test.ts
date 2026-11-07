// Integration tests — issue #260's visibility ladder + closure contract
// (D4; ADR 0022) against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction, every
// statement awaited, everything rolled back at the end. Skips with a
// one-line message when the stack is unreachable.
//
// The matrix:
//   * single vocabulary — `published_visibility` and `apps.sharing` are
//     GONE; every ladder table carries `visibility` with the four-rung
//     check, and an unknown rung is refused.
//   * members/signed-in gates at the policy level — `members` is the
//     project-membership gate (a `members` dataset reads for its owning
//     project's members and its creator only; a members map/layer/app
//     reads for project members), `signed-in` widens to every
//     authenticated user, and the wider arms are PUBLISHED-scoped (a draft
//     layer at `signed-in` stays project-visible; publishing opens it).
//     The project row widens its title/chips, never its artifact list
//     (project_artifacts stays member-only).
//   * min(closure) enforcement — a public app does NOT leak a
//     members-only foreign pin: the signed-in outsider reads the app row +
//     its frozen app_versions snapshot and none of the blocked dataset's
//     rows (P5: effective consumer access = min over the closure).
//   * anon frozen-row gates — anon reads NOTHING live (datasets, maps,
//     layers, apps, projects); frozen rows open only when the parent
//     artifact sits at link/public, and close again when it narrows.
//   * preflight/apply — the mixed-closure report names every promotion and
//     every blocker (a foreign locked dataset caps the share), preflight
//     moves nothing, apply widens exactly the promotions in one
//     transaction and leaves blockers untouched, both refuse a caller who
//     cannot edit the root, and a target at/below the current rung is a
//     widening-only no-op.
//   * bundle press columns — publish_bundles.visibility and the members'
//     promotion plan (visibility_from/to) exist and carry the ladder check.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  addEntry,
  ALICE,
  BOB,
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

/** Savepoint-wrapped statement expected to RAISE. Returns the message. */
async function expectRaises(text: string): Promise<string> {
  return await s().denied(text);
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
  const id = firstRow(rows).id;
  if (id === null) throw new Error("no membership id");
  return id;
}

/** One LINKED dataset membership row — the foreign pin (its home rung caps the share). */
async function linkDataset(projectId: string, datasetId: string): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset', 'linked', 'manual')
     returning id::text as id`,
  );
  const id = firstRow(rows).id;
  if (id === null) throw new Error("no membership id");
  return id;
}

/** One owned data layer styling the given dataset membership; returns the LAYER id + its membership id. */
async function seedDataLayer(
  projectId: string,
  datasetMemberId: string,
): Promise<{ layerId: string; membershipId: string }> {
  const layerId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.layers (id, project_id, kind, name, dataset_member_id)
     values (${sqlLit(layerId)}, ${sqlLit(projectId)}, 'data', 'Closure layer', ${sqlLit(datasetMemberId)})`,
  );
  const lmRows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(layerId)}, 'layer', 'owned', 'manual')
     returning id::text as id`,
  );
  const membershipId = firstRow(lmRows).id;
  if (membershipId === null) throw new Error("no layer membership id");
  return { layerId, membershipId };
}

/** One app with a map widget + one frozen app_versions row. */
async function seedApp(projectId: string, mapId: string, datasetIds: string[]): Promise<string> {
  const appId = crypto.randomUUID();
  const pages = JSON.stringify([{ widgets: [{ id: "w1", kind: "map", mapId, w: 6, h: 6 }] }]);
  const datasetList =
    datasetIds.length === 0
      ? "'{}'::uuid[]"
      : `array[${datasetIds.map((id) => sqlLit(id)).join(",")}]::uuid[]`;
  await s().expectOk(
    `insert into public.apps (id, title, project_id, pages, dataset_ids)
     values (${sqlLit(appId)}, 'Closure app', ${sqlLit(projectId)}, ${sqlLit(pages)}::jsonb, ${datasetList})`,
  );
  await s().expectOk(
    `insert into public.app_versions (app_id, version_label, definition)
     values (${sqlLit(appId)}, 'v1', '{"frozen": true}'::jsonb)`,
  );
  return appId;
}

/**
 * The closure fixture (call after `beginAs(ALICE)`): ALICE's project A
 * (BOB a viewer seat), CAROL's project C. A owns D1 (signed-in) and holds
 * CAROL's locked members-only D2 as a LINKED pin; each dataset feeds a
 * layer, both layers sit on one map, and the app embeds that map with a
 * frozen v1. Returns every id the tests need.
 */
async function seedClosure(): Promise<{
  appId: string;
  d1: string;
  d2: string;
  layerD1: string;
  layerD2: string;
  mapId: string;
  projectA: string;
}> {
  const projectA = crypto.randomUUID();
  const projectC = crypto.randomUUID();
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectA)}, 'ladder A', ${sqlLit(ALICE)})`,
  );
  // BOB holds a viewer seat on A (the member-gate lens).
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectA)}, ${sqlLit(BOB)}, 'viewer')`,
  );

  const d1 = await createDataset(s(), { createdBy: ALICE });
  const d1Membership = await ownDataset(projectA, d1);
  // CAROL's rows are HERS: the 0009 stamp overwrites created_by/added_by
  // with auth.uid(), so project C and her locked members-only dataset (the
  // canonical foreign blocker) insert WHILE SHE ACTS — her owner membership
  // mints with the project and her dataset carries her identity.
  await s().asUser(CAROL);
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectC)}, 'ladder C', ${sqlLit(CAROL)})`,
  );
  const d2 = await createDataset(s(), {
    createdBy: CAROL,
    editPolicy: "locked",
    visibility: "members",
  });
  await ownDataset(projectC, d2);
  await s().asUser(ALICE);
  const d2Membership = await linkDataset(projectA, d2);

  const layerD1Seed = await seedDataLayer(projectA, d1Membership);
  const layerD2Seed = await seedDataLayer(projectA, d2Membership);

  const mapId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.maps (id, name, project_id) values (${sqlLit(mapId)}, 'Closure map', ${sqlLit(projectA)})`,
  );
  await s().expectOk(
    `insert into public.map_layers (map_id, "order", layer_member_id, visible)
     values (${sqlLit(mapId)}, 0, ${sqlLit(layerD1Seed.membershipId)}, true)`,
  );
  await s().expectOk(
    `insert into public.map_layers (map_id, "order", layer_member_id, visible)
     values (${sqlLit(mapId)}, 1, ${sqlLit(layerD2Seed.membershipId)}, true)`,
  );

  const appId = await seedApp(projectA, mapId, [d1]);
  return {
    appId,
    d1,
    d2,
    layerD1: layerD1Seed.layerId,
    layerD2: layerD2Seed.layerId,
    mapId,
    projectA,
  };
}

/** The one column read for a ladder row's visibility, or null when the row is invisible. */
async function visibilityOf(table: string, id: string): Promise<string | null> {
  const rows = await s().expectOk(
    `select visibility from public.${table} where id = ${sqlLit(id)}`,
  );
  if (rows.length === 0) {
    return null;
  }
  return firstRow(rows).visibility;
}

describe.skipIf(!dbUp())("visibility ladder + closure (0023, ADR 0022, #260)", () => {
  test("single vocabulary: the fragments are gone and the four-rung check binds", async () => {
    await beginAs(ALICE);
    const dead = await s().expectOk(
      `select count(*) as n from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'datasets' and column_name = 'published_visibility')
           or (table_name = 'apps' and column_name = 'sharing'))`,
    );
    expect(Number(firstRow(dead).n)).toBe(0);
    const live = await s().expectOk(
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'visibility'
         and table_name in ('datasets','layers','maps','apps','projects')
       order by table_name`,
    );
    expect(live.map((row) => row.table_name)).toStrictEqual([
      "apps",
      "datasets",
      "layers",
      "maps",
      "projects",
    ]);

    // An unknown rung is refused by the check on the ladder tables.
    const projectId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.projects (id, title, created_by) values (${sqlLit(projectId)}, 'rungs', ${sqlLit(ALICE)})`,
    );
    const appMessage = await expectRaises(
      `insert into public.apps (id, title, project_id, visibility) values ('${crypto.randomUUID()}', 'x', ${sqlLit(projectId)}, 'everyone')`,
    );
    expect(appMessage).toMatch(/check/i);
    const projectMessage = await expectRaises(
      `update public.projects set visibility = 'author' where id = ${sqlLit(projectId)}`,
    );
    expect(projectMessage).toMatch(/check/i);
  });

  test("members/signed-in gates: datasets, apps, and the project row; drafts stay member-scoped", async () => {
    await beginAs(ALICE);
    const { appId, d1, layerD1, projectA } = await seedClosure();

    // The project row widens, its artifact LIST does not.
    await s().expectOk(
      `update public.projects set visibility = 'signed-in' where id = ${sqlLit(projectA)}`,
    );
    await s().asUser(CAROL);
    expect(await countWhere("projects", `id = ${sqlLit(projectA)}`)).toBe(1);
    expect(await countWhere("project_artifacts", `project_id = ${sqlLit(projectA)}`)).toBe(0);

    // A `members` dataset: the owning project's viewer reads it, the
    // signed-in outsider does not; flipping to signed-in opens it.
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.datasets set visibility = 'members' where id = ${sqlLit(d1)}`,
    );
    await s().asUser(BOB);
    expect(await countWhere("datasets", `id = ${sqlLit(d1)}`)).toBe(1);
    await s().asUser(CAROL);
    expect(await countWhere("datasets", `id = ${sqlLit(d1)}`)).toBe(0);
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.datasets set visibility = 'signed-in' where id = ${sqlLit(d1)}`,
    );
    await s().asUser(CAROL);
    expect(await countWhere("datasets", `id = ${sqlLit(d1)}`)).toBe(1);

    // The app's `members` rung keeps outsiders out; `signed-in` opens the row.
    await s().asUser(ALICE);
    await s().expectOk(`update public.apps set visibility = 'members' where id = ${sqlLit(appId)}`);
    await s().asUser(CAROL);
    expect(await countWhere("apps", `id = ${sqlLit(appId)}`)).toBe(0);
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.apps set visibility = 'signed-in' where id = ${sqlLit(appId)}`,
    );
    await s().asUser(CAROL);
    expect(await countWhere("apps", `id = ${sqlLit(appId)}`)).toBe(1);

    // A draft layer is published-scoped: `signed-in` on a DRAFT layer does
    // not open it; publishing does.
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.layers set visibility = 'signed-in' where id = ${sqlLit(layerD1)}`,
    );
    await s().asUser(CAROL);
    expect(await countWhere("layers", `id = ${sqlLit(layerD1)}`)).toBe(0);
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.layers set lifecycle = 'published' where id = ${sqlLit(layerD1)}`,
    );
    await s().asUser(CAROL);
    expect(await countWhere("layers", `id = ${sqlLit(layerD1)}`)).toBe(1);
  });

  test("min(closure): the public app never leaks its members-only foreign pin", async () => {
    await beginAs(ALICE);
    const { appId, d2, mapId } = await seedClosure();

    // The whole closure widens (the apply's behavior is the next test's
    // subject; here the widest safe lens matters, so widen directly).
    await s().expectOk(`update public.apps set visibility = 'public' where id = ${sqlLit(appId)}`);
    await s().expectOk(`update public.maps set visibility = 'public' where id = ${sqlLit(mapId)}`);
    await s().expectOk(`update public.layers set visibility = 'public', lifecycle = 'published'`);

    // BOB — signed in, a member of A but NOT of C (D2's home project), and
    // not D2's creator — reads the app row and its frozen snapshot, and
    // none of the locked foreign dataset's rows (min(closure) enforced at
    // the policy level: the public share never widens the blocked member).
    await s().asUser(BOB);
    expect(await countWhere("apps", `id = ${sqlLit(appId)}`)).toBe(1);
    expect(await countWhere("app_versions", `app_id = ${sqlLit(appId)}`)).toBe(1);
    expect(await countWhere("datasets", `id = ${sqlLit(d2)}`)).toBe(0);
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(d2)}`)).toBe(0);
  });

  test("anon: live tables stay closed; frozen rows open only at link/public", async () => {
    await beginAs(ALICE);
    const { appId, d1 } = await seedClosure();
    await addEntry(s(), d1, { name: "frozen row" });
    await s().expectOk(
      `select public.publish_version(${sqlLit(d1)}, 'v1', ${sqlLit(crypto.randomUUID())}, null)`,
    );

    // Everything below happens in THIS transaction — the fixture's world
    // must not roll back between the rungs; the ladder flips ride
    // identity switches, not new transactions.
    await s().asAnon();
    for (const table of ["datasets", "maps", "layers", "apps", "projects", "project_artifacts"]) {
      expect(await countWhere(table, "true")).toBe(0);
    }
    // members/signed-in frozen rows: closed.
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(d1)}`)).toBe(0);
    expect(await countWhere("version_entries", "true")).toBe(0);
    expect(await countWhere("app_versions", `app_id = ${sqlLit(appId)}`)).toBe(0);

    // At link: the frozen rows open; the live rows stay closed.
    await s().asUser(ALICE);
    await s().expectOk(`update public.datasets set visibility = 'link' where id = ${sqlLit(d1)}`);
    await s().expectOk(`update public.apps set visibility = 'link' where id = ${sqlLit(appId)}`);
    await s().asAnon();
    expect(await countWhere("dataset_versions", `dataset_id = ${sqlLit(d1)}`)).toBe(1);
    expect(await countWhere("version_entries", "true")).toBe(1);
    expect(await countWhere("app_versions", `app_id = ${sqlLit(appId)}`)).toBe(1);
    expect(await countWhere("datasets", `id = ${sqlLit(d1)}`)).toBe(0);
    expect(await countWhere("apps", `id = ${sqlLit(appId)}`)).toBe(0);

    // Narrowing closes the anon gate again.
    await s().asUser(ALICE);
    await s().expectOk(`update public.apps set visibility = 'members' where id = ${sqlLit(appId)}`);
    await s().asAnon();
    expect(await countWhere("app_versions", `app_id = ${sqlLit(appId)}`)).toBe(0);
  });

  test("preflight: the mixed-closure report names promotions + the foreign blocker and moves nothing", async () => {
    await beginAs(ALICE);
    const { appId, d1, d2, layerD1, layerD2, mapId } = await seedClosure();

    const raw = await s().expectOk(
      `select public.visibility_preflight('app', ${sqlLit(appId)}, 'public') as report`,
    );
    const report = JSON.parse(firstRow(raw).report ?? "{}") as {
      effective: string;
      promotions: Array<{ id: string; kind: string; to: string }>;
      blockers: Array<{ current: string; id: string; kind: string }>;
    };
    // The promotions: the app, its map, both layers, and D1.
    const promotionIds = report.promotions.map((promotion) => promotion.id);
    expect(promotionIds).toContain(appId);
    expect(promotionIds).toContain(mapId);
    expect(promotionIds).toContain(layerD1);
    expect(promotionIds).toContain(layerD2);
    expect(promotionIds).toContain(d1);
    expect(report.promotions.every((promotion) => promotion.to === "public")).toBe(true);
    // The blocker: CAROL's locked members-only pin, named and not proposed.
    expect(report.blockers).toHaveLength(1);
    const blocker = report.blockers[0];
    if (blocker === undefined) {
      throw new Error("no blocker");
    }
    expect(blocker.id).toBe(d2);
    expect(blocker.current).toBe("members");
    expect(report.effective).toBe("members");

    // The preflight moved nothing (D2's rung reads through its creator's
    // eyes — ALICE rightly cannot see CAROL's members-only dataset).
    expect(await visibilityOf("apps", appId)).toBe("members");
    expect(await visibilityOf("datasets", d1)).toBe("signed-in");
    await s().asUser(CAROL);
    expect(await visibilityOf("datasets", d2)).toBe("members");
    await s().asUser(ALICE);
  });

  test("apply: promotions widen atomically, the blocker stays, non-editors are refused", async () => {
    await beginAs(ALICE);
    const { appId, d1, d2, mapId } = await seedClosure();

    const raw = await s().expectOk(
      `select public.visibility_apply('app', ${sqlLit(appId)}, 'public') as report`,
    );
    const report = JSON.parse(firstRow(raw).report ?? "{}") as {
      applied: Array<{ from: string; id: string; to: string }>;
      blockers: Array<{ id: string }>;
      effective: string;
    };
    const appliedIds = report.applied.map((promotion) => promotion.id);
    expect(appliedIds).toContain(appId);
    expect(appliedIds).toContain(mapId);
    expect(appliedIds).toContain(d1);
    const d1Promotion = report.applied.find((promotion) => promotion.id === d1);
    if (d1Promotion === undefined) {
      throw new Error("D1 not in the applied plan");
    }
    expect(d1Promotion.from).toBe("signed-in");
    expect(report.blockers.map((blocker) => blocker.id)).toStrictEqual([d2]);
    expect(report.effective).toBe("members");

    // The rows moved exactly as reported; the blocker did not (D2's rung
    // reads through its creator's eyes).
    expect(await visibilityOf("apps", appId)).toBe("public");
    expect(await visibilityOf("maps", mapId)).toBe("public");
    expect(await visibilityOf("datasets", d1)).toBe("public");
    await s().asUser(CAROL);
    expect(await visibilityOf("datasets", d2)).toBe("members");
    await s().asUser(ALICE);

    // A viewer seat cannot widen (the root gate).
    await s().asUser(BOB);
    const refusal = await expectRaises(
      `select public.visibility_apply('app', ${sqlLit(appId)}, 'public')`,
    );
    expect(refusal).toMatch(/cannot edit/);
  });

  test("widening-only: a target at or below the current rung answers an empty plan", async () => {
    await beginAs(ALICE);
    const { appId } = await seedClosure();
    await s().expectOk(
      `update public.apps set visibility = 'signed-in' where id = ${sqlLit(appId)}`,
    );
    const raw = await s().expectOk(
      `select public.visibility_preflight('app', ${sqlLit(appId)}, 'signed-in') as report`,
    );
    const report = JSON.parse(firstRow(raw).report ?? "{}") as {
      effective: string;
      promotions: unknown[];
      blockers: unknown[];
    };
    expect(report.promotions).toStrictEqual([]);
    expect(report.blockers).toStrictEqual([]);
    expect(report.effective).toBe("signed-in");
  });

  test("the bundle press columns carry the ladder and the promotion plan", async () => {
    await beginAs(ALICE);
    const projectId = crypto.randomUUID();
    await s().expectOk(
      `insert into public.projects (id, title, created_by) values (${sqlLit(projectId)}, 'press', ${sqlLit(ALICE)})`,
    );
    const bundleRows = await s().expectOk(
      `insert into public.publish_bundles (project_id, title, visibility) values (${sqlLit(projectId)}, 'press', 'public') returning id::text as id`,
    );
    const bundleId = firstRow(bundleRows).id;
    if (bundleId === null) throw new Error("no bundle");
    await s().expectOk(
      `insert into public.publish_bundle_members (bundle_id, kind, dataset_key, publish, status, visibility_from, visibility_to)
       values (${sqlLit(bundleId)}, 'dataset', ${sqlLit(crypto.randomUUID())}, true, 'pending', 'signed-in', 'public')`,
    );
    const members = await s().expectOk(
      `select visibility_from, visibility_to from public.publish_bundle_members where bundle_id = ${sqlLit(bundleId)}`,
    );
    expect(firstRow(members).visibility_from).toBe("signed-in");
    expect(firstRow(members).visibility_to).toBe("public");

    // The ladder check binds on the bundle row too.
    const message = await expectRaises(
      `insert into public.publish_bundles (project_id, title, visibility) values (${sqlLit(projectId)}, 'bad', 'everyone')`,
    );
    expect(message).toMatch(/check/i);
  });
});
