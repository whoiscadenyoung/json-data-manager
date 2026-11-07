// Integration tests — the dataset-relations domain (issue #258, migration
// 0021, ADR 0020) against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), statements expected to RAISE run
// savepoint-wrapped, everything rolled back at the end. Skips with a one-line
// message when the stack is unreachable.
//
// The matrix (ADR 0020; D3 — relations are catalog-level data truth):
//   * dataset_relations — reads gated on BOTH ends' visibility (seeing one
//     end never leaks the other), writes on BOTH ends' editability (the
//     datasets' own recorded gates are the relation's authority).
//   * dataset_relation_records — the bounded runtime query: key path
//     (live containment + the FROZEN path through a membership pin), spatial
//     path (index-backed && + exact predicate; viewport scope; the page
//     probe's has_more), pin resolution (survives member sync).
//   * structure — the unique (from, to, kind) tuple + the config shape
//     checks; created_by stamped to the invoker.
//   * the deliberate realtime absence — dataset_relations is NOT a
//     publication member (click-time reads can't go stale).

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  BOB,
  CAROL,
  addEntry,
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

/** The value, or a loud failure (the no-optional-chaining test style). */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

/** Savepoint-wrapped statement expected to RAISE; returns the error message. */
async function expectRaises(text: string): Promise<string> {
  const sp = `sp_${crypto.randomUUID().replaceAll("-", "")}`;
  await s().expectOk(`savepoint ${sp}`);
  const result = await s().query(text);
  await s().expectOk(`rollback to ${sp}`);
  await s().expectOk(`release ${sp}`);
  if (result.error !== undefined) {
    return result.error;
  }
  throw new Error(`expected the statement to raise, but it succeeded: ${text}`);
}

/** One project with the fixture members: ALICE owner, BOB editor, CAROL viewer. */
async function seedProject(): Promise<string> {
  const projectId = crypto.randomUUID();
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectId)}, 'relations A', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectId)}, ${sqlLit(BOB)}, 'editor'), (${sqlLit(projectId)}, ${sqlLit(CAROL)}, 'viewer')`,
  );
  return projectId;
}

/** One linked dataset membership (the linked-role row a pin rides). */
async function addMembership(projectId: string, datasetId: string): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
     values (${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset', 'linked', 'manual') returning id::text as id`,
  );
  return String(firstRow(rows).id);
}

/** Pins a membership at a version (the 0009 fork edge, mode pin). */
async function pinMembership(membershipId: string, versionId: string): Promise<void> {
  await s().expectOk(
    `insert into public.consumer_references (consumer_id, consumer_kind, source_dataset_id, mode, pinned_version_id)
     select id::text, 'fork', artifact_id::uuid, 'pin', ${sqlLit(versionId)}
     from public.project_artifacts where id = ${sqlLit(membershipId)}`,
  );
}

/** Declares one relation as the CURRENT user; returns the row id. */
async function declareRelation(
  fromDataset: string,
  toDataset: string,
  kind: "key" | "spatial",
  config: Record<string, unknown>,
  cardinality = "N-M",
): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.dataset_relations (from_dataset, to_dataset, kind, cardinality, config)
     values (${sqlLit(fromDataset)}, ${sqlLit(toDataset)}, ${sqlLit(kind)}, ${sqlLit(cardinality)}, ${sqlLit(JSON.stringify(config))}::jsonb)
     returning id::text as id`,
  );
  return String(firstRow(rows).id);
}

/** One inline-geometry entry (a real `geometries.source`, the geom generated). */
async function addGeometryEntry(
  datasetId: string,
  data: Record<string, unknown>,
  geometry: Record<string, unknown>,
): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.entries (dataset_id, data, geometry_type)
     values (${sqlLit(datasetId)}, ${sqlLit(JSON.stringify(data))}, ${sqlLit(String(geometry.type))})
     returning id::text as id`,
  );
  const entryId = String(firstRow(rows).id);
  await s().expectOk(
    `insert into public.geometries (dataset_id, entry_id, source, type, created_by)
     values (${sqlLit(datasetId)}, ${sqlLit(entryId)}, ${sqlLit(JSON.stringify(geometry))}, ${sqlLit(String(geometry.type))}, ${sqlLit(ALICE)})`,
  );
  return entryId;
}

/** Runs the runtime RPC as the CURRENT user; returns (entry_id, has_more) pairs. */
async function records(
  relationId: string,
  projectId: string,
  datasetId: string,
  entryId: string,
  bbox: number[] | null,
  offset = 0,
  limit = 200,
): Promise<Array<{ entry_id: string; has_more: boolean }>> {
  const run = await s().query(
    `select entry_id::text as entry_id, has_more
     from public.dataset_relation_records(
       ${sqlLit(relationId)}, ${sqlLit(projectId)}, ${sqlLit(datasetId)}, ${sqlLit(entryId)},
       ${bbox === null ? "null" : `${sqlLit(JSON.stringify(bbox))}::jsonb`},
       ${offset}, ${limit})`,
  );
  expect(run.error).toBeUndefined();
  return run.rows.map((row) => ({
    entry_id: String(row.entry_id),
    has_more: row.has_more === "t",
  }));
}

/** Publishes one version as the CURRENT user; returns the version id. */
async function publish(datasetId: string, label: string, key: string): Promise<string> {
  const run = await s().query(
    `select public.publish_version(${sqlLit(datasetId)}, ${sqlLit(label)}, ${sqlLit(key)}, null) as id`,
  );
  expect(run.error).toBeUndefined();
  return String(firstRow(run.rows).id);
}

// The parks-walkthrough fixtures: a polygon around 1e2,1e2 (11..19) and
// points inside it plus points outside.
const POLYGON = {
  coordinates: [
    [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
    ],
  ],
  type: "Polygon",
} as const;

function pointAt(lon: number, lat: number): { coordinates: [number, number]; type: "Point" } {
  return { coordinates: [lon, lat], type: "Point" };
}

describe.skipIf(!dbUp())("dataset relations (0021, ADR 0020)", () => {
  test("role matrix: both ends' gates — members read, editors declare, viewers can't, blind ends hide the row; anon denied", async () => {
    await s().begin();
    await s().asUser(ALICE);
    // parks: open (every signed-in member edits); visits: locked + published
    // (viewable by everyone, editable by ALICE alone — the write gate);
    // secret: locked + author-visibility (only ALICE sees/edits it — the
    // blind end). The datasets' own gates ARE the relation's authority:
    // project seats never widen them.
    const parks = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const visits = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });
    const secret = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "locked",
      visibility: "members",
    });
    const open2 = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });

    // ALICE (can edit both ends) declares.
    const relationId = await declareRelation(parks, visits, "spatial", {
      direction: "forward",
      predicate: "within",
    });
    const stamped = await s().expectOk(
      `select created_by::text as by from public.dataset_relations where id = ${sqlLit(relationId)}`,
    );
    expect(firstRow(stamped).by).toBe(ALICE);

    // BOB (editor of the project): reads; can declare/edit relations over
    // OPEN datasets (the open gate, not his project seat).
    await s().asUser(BOB);
    expect(
      await s().count(
        `select count(*) as n from public.dataset_relations where id = ${sqlLit(relationId)}`,
      ),
    ).toBe(1);
    const bobRelation = await declareRelation(
      parks,
      open2,
      "key",
      {
        fromKey: "park_id",
        toKey: "id",
      },
      "1-N",
    );
    await s().expectOk(
      `update public.dataset_relations set cardinality = '1-1' where id = ${sqlLit(bobRelation)}`,
    );
    await s().expectOk(`delete from public.dataset_relations where id = ${sqlLit(bobRelation)}`);

    // CAROL: reads everything visible; writes over a LOCKED end answer the
    // denial shapes — her project seat grants nothing the data forbids.
    await s().asUser(CAROL);
    expect(
      await s().count(
        `select count(*) as n from public.dataset_relations where id = ${sqlLit(relationId)}`,
      ),
    ).toBe(1);
    await expect(
      s().denied(
        `insert into public.dataset_relations (from_dataset, to_dataset, kind, config)
         values (${sqlLit(parks)}, ${sqlLit(visits)}, 'key', '{"fromKey":"a","toKey":"b"}'::jsonb)`,
      ),
    ).resolves.toMatch(/row-level security/i);
    await expect(
      s().denied(
        `update public.dataset_relations set cardinality = '1-1' where id = ${sqlLit(relationId)}`,
      ),
    ).resolves.toMatch(/0 rows/);
    await expect(
      s().denied(`delete from public.dataset_relations where id = ${sqlLit(relationId)}`),
    ).resolves.toMatch(/0 rows/);

    // The BLIND end: a relation touching `secret` is invisible to BOB
    // (one visible end never leaks the other), and its write is refused.
    await s().asUser(ALICE);
    const secretRelation = await declareRelation(parks, secret, "key", {
      fromKey: "a",
      toKey: "b",
    });
    await s().asUser(BOB);
    expect(
      await s().count(
        `select count(*) as n from public.dataset_relations where id = ${sqlLit(secretRelation)}`,
      ),
    ).toBe(0);
    await expect(
      s().denied(
        `insert into public.dataset_relations (from_dataset, to_dataset, kind, config)
         values (${sqlLit(parks)}, ${sqlLit(secret)}, 'key', '{"fromKey":"a","toKey":"b"}'::jsonb)`,
      ),
    ).resolves.toMatch(/row-level security/i);

    // ANON: denied everywhere.
    await s().asAnon();
    expect(await s().count("select count(*) as n from public.dataset_relations")).toBe(0);
    await expect(
      s().denied(
        `insert into public.dataset_relations (from_dataset, to_dataset, kind, config)
         values (${sqlLit(parks)}, ${sqlLit(visits)}, 'key', '{"fromKey":"a","toKey":"b"}'::jsonb)`,
      ),
    ).resolves.toMatch(/row-level security/i);

    await s().rollback();
    await dropDatasets(s(), [parks, visits, secret, open2]);
  });

  test("structure: unique (from, to, kind); the reverse pair is distinct; config shape checks; entry-side validation", async () => {
    await asAlice();
    const parks = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const visits = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });

    // Config shape checks FIRST (each fires before the row can collide with
    // a valid declaration below — the check constraint is evaluated at row
    // formation, the unique index at storage).
    await expect(
      expectRaises(
        `insert into public.dataset_relations (from_dataset, to_dataset, kind, cardinality, config)
       values (${sqlLit(parks)}, ${sqlLit(visits)}, 'key', 'N-M', '{"fromKey":"a"}'::jsonb)`,
      ),
    ).resolves.toMatch(/dataset_relations_key_config_check/i);
    await expect(
      expectRaises(
        `insert into public.dataset_relations (from_dataset, to_dataset, kind, cardinality, config)
       values (${sqlLit(parks)}, ${sqlLit(visits)}, 'spatial', 'N-M', '{"predicate":"nearby","direction":"forward"}'::jsonb)`,
      ),
    ).resolves.toMatch(/dataset_relations_spatial_config_check/i);
    await expect(
      expectRaises(
        `insert into public.dataset_relations (from_dataset, to_dataset, kind, cardinality, config)
       values (${sqlLit(parks)}, ${sqlLit(visits)}, 'spatial', 'N-M', '{"predicate":"within","direction":"sideways"}'::jsonb)`,
      ),
    ).resolves.toMatch(/dataset_relations_spatial_config_check/i);

    await declareRelation(parks, visits, "key", { fromKey: "a", toKey: "b" });

    // Same tuple again: the unique constraint refuses.
    await expect(
      expectRaises(
        `insert into public.dataset_relations (from_dataset, to_dataset, kind, config)
       values (${sqlLit(parks)}, ${sqlLit(visits)}, 'key', '{"fromKey":"x","toKey":"y"}'::jsonb)`,
      ),
    ).resolves.toMatch(/duplicate key value/i);
    // Same pair, other kind: distinct — allowed.
    await declareRelation(parks, visits, "spatial", { direction: "forward", predicate: "within" });
    // The reverse pair: a distinct row — allowed.
    await declareRelation(visits, parks, "key", { fromKey: "b", toKey: "a" });

    // The runtime RPC validates its arguments: a dataset that isn't an end,
    // and an entry that doesn't belong to the clicked dataset. (The key
    // relation rides the FREE reverse slot — (visits→parks) — the forward
    // one is taken by r1 above.)
    const entryId = await addEntry(s(), parks, { name: "p1" });
    const relationId = await declareRelation(visits, parks, "spatial", {
      direction: "forward",
      predicate: "intersects",
    });
    const projectId = await seedProject();
    await expect(
      expectRaises(
        `select * from public.dataset_relation_records(${sqlLit(relationId)}, ${sqlLit(projectId)}, '${crypto.randomUUID()}', ${sqlLit(entryId)}, null)`,
      ),
    ).resolves.toMatch(/not an end/i);
    await expect(
      expectRaises(
        `select * from public.dataset_relation_records(${sqlLit(relationId)}, ${sqlLit(projectId)}, ${sqlLit(parks)}, '${crypto.randomUUID()}', null)`,
      ),
    ).resolves.toMatch(/does not belong/i);
    // A relation the caller can't see reads as not-found (no leak).
    const secret = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "locked",
      visibility: "members",
    });
    const blindRelation = await declareRelation(parks, secret, "key", { fromKey: "a", toKey: "b" });
    await s().asUser(BOB);
    await expect(
      expectRaises(
        `select * from public.dataset_relation_records(${sqlLit(blindRelation)}, ${sqlLit(projectId)}, ${sqlLit(parks)}, ${sqlLit(entryId)}, null)`,
      ),
    ).resolves.toMatch(/not found or not visible/i);

    await s().rollback();
    await dropDatasets(s(), [parks, visits, secret]);
  });

  test("key path (live): containment matches, field swap by side, missing key value answers empty", async () => {
    await asAlice();
    const projectId = await seedProject();
    const parks = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "open",
      properties: ["name"],
    });
    const visits = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "open",
      properties: ["park_id", "visits"],
    });
    const p1 = await addEntry(s(), parks, { name: "park-a" });
    await addEntry(s(), parks, { name: "park-b" });
    await addEntry(s(), visits, { park_id: "park-a", visits: 10 });
    await addEntry(s(), visits, { park_id: "park-a", visits: 20 });
    await addEntry(s(), visits, { park_id: "park-b", visits: 30 });
    await addEntry(s(), visits, { visits: 40 });

    const relationId = await declareRelation(
      visits,
      parks,
      "key",
      {
        fromKey: "park_id",
        toKey: "name",
      },
      "1-N",
    );

    // Clicking a PARK (the TO side): the park's `name` matches visits' `park_id` — two records.
    const forPark = await records(relationId, projectId, parks, p1, null);
    expect(forPark.length).toBe(2);
    expect(present(forPark[0]).has_more).toBe(false);

    // Clicking a VISIT (the FROM side): the visit's `park_id` matches parks' `name` — one record.
    const visitRows = await s().expectOk(
      `select id::text as id from public.entries
       where dataset_id = ${sqlLit(visits)} and data ->> 'park_id' = 'park-a'
       order by id limit 1`,
    );
    const firstVisit = String(firstRow(visitRows).id);
    const forVisit = await records(relationId, projectId, visits, firstVisit, null);
    expect(forVisit.length).toBe(1);

    // A click whose key value is missing answers empty (never an error).
    const parkWithoutKey = await addEntry(s(), parks, {});
    const forEmpty = await records(relationId, projectId, parks, parkWithoutKey, null);
    expect(forEmpty.length).toBe(0);

    await s().rollback();
    await dropDatasets(s(), [parks, visits]);
  });

  test("key path (frozen): a pinned side answers from its frozen version — the relation survives member sync", async () => {
    await asAlice();
    const projectId = await seedProject();
    const parks = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "open",
      properties: ["name"],
    });
    const visits = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "open",
      properties: ["park_id", "visits"],
    });
    const p1 = await addEntry(s(), parks, { name: "park-a" });
    await addEntry(s(), visits, { park_id: "park-a", visits: 10 });

    // The project links parks + visits; visits is PINNED at its current head.
    await addMembership(projectId, parks);
    const visitsMembership = await addMembership(projectId, visits);
    const frozenVersion = await publish(visits, "v1", `pk-${visits}`);
    await pinMembership(visitsMembership, frozenVersion);

    const relationId = await declareRelation(
      visits,
      parks,
      "key",
      {
        fromKey: "park_id",
        toKey: "name",
      },
      "1-N",
    );

    // Before the sync: the frozen side answers from v1 (the same one row).
    expect((await records(relationId, projectId, parks, p1, null)).length).toBe(1);

    // The source adds rows (a republish past the pin) — the pinned side
    // must NOT see them: the frozen answer is the pin, not the live table.
    await addEntry(s(), visits, { park_id: "park-a", visits: 99 });
    expect((await records(relationId, projectId, parks, p1, null)).length).toBe(1);

    // Floating the membership moves the answer to the live table.
    await s().asAdmin();
    await s().expectOk(
      `update public.consumer_references set mode = 'float', pinned_version_id = null, pinned_ref = null
       where consumer_id = ${sqlLit(visitsMembership)}`,
    );
    await s().asUser(ALICE);
    expect((await records(relationId, projectId, parks, p1, null)).length).toBe(2);

    await s().rollback();
    await dropDatasets(s(), [parks, visits]);
  });

  test("spatial path (live): within/contains/intersects by direction, viewport scope, page probe", async () => {
    await asAlice();
    const projectId = await seedProject();
    const parks = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const points = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const lines = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    // Empty — its slot exists to hold one more contains quadrant.
    const trails2 = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });

    const polygonEntry = await addGeometryEntry(parks, { name: "dome" }, POLYGON);
    const inside1 = await addGeometryEntry(points, { name: "in-1" }, pointAt(12, 12));
    const inside2 = await addGeometryEntry(points, { name: "in-2" }, pointAt(15, 15));
    await addGeometryEntry(points, { name: "out" }, pointAt(30, 30));
    const crossing = await addGeometryEntry(
      lines,
      { name: "trail" },
      {
        coordinates: [
          [5, 12],
          [25, 12],
        ],
        type: "LineString",
      },
    );
    const disjoint = await addGeometryEntry(
      lines,
      { name: "far trail" },
      {
        coordinates: [
          [40, 12],
          [60, 12],
        ],
        type: "LineString",
      },
    );
    // An interior trail — fully inside the polygon (the contains-reverse
    // answer needs a contained line, not a crossing one: contains(park,
    // line) ≡ within(line, park)).
    const interior = await addGeometryEntry(
      lines,
      { name: "inner trail" },
      {
        coordinates: [
          [12, 12],
          [18, 18],
        ],
        type: "LineString",
      },
    );

    // One SPATIAL relation per ordered pair (the unique tuple): each
    // quadrant below rides its own pair.
    const within = await declareRelation(points, parks, "spatial", {
      direction: "forward",
      predicate: "within",
    });

    // Clicking the polygon: the two inside points answer; the outside one doesn't.
    const clickedPolygon = await records(
      within,
      projectId,
      parks,
      polygonEntry,
      [-180, -80, 180, 80],
    );
    expect(clickedPolygon.map((row) => row.entry_id).toSorted()).toEqual(
      [inside1, inside2].toSorted(),
    );
    expect(present(clickedPolygon[0]).has_more).toBe(false);

    // Clicking an inside point: the polygon answers (the same relation read
    // from the other side — subject order preserved).
    const clickedPoint = await records(within, projectId, points, inside1, [-180, -80, 180, 80]);
    expect(clickedPoint.map((row) => row.entry_id)).toEqual([polygonEntry]);

    // Viewport scope: a bbox excluding the polygon hides the answer even
    // though the predicate holds (the honest bounded read; the user pans).
    const outsideViewport = await records(within, projectId, points, inside1, [0, 0, 5, 5]);
    expect(outsideViewport.length).toBe(0);

    // {parks→points, contains, forward} — the SAME physical fact phrased
    // from the polygon side (subject = parks). Both click sides answer.
    const contains = await declareRelation(parks, points, "spatial", {
      direction: "forward",
      predicate: "contains",
    });
    const byContains = await records(
      contains,
      projectId,
      parks,
      polygonEntry,
      [-180, -80, 180, 80],
    );
    expect(byContains.map((row) => row.entry_id).toSorted()).toEqual([inside1, inside2].toSorted());
    const byContainsPoint = await records(
      contains,
      projectId,
      points,
      inside1,
      [-180, -80, 180, 80],
    );
    expect(byContainsPoint.map((row) => row.entry_id)).toEqual([polygonEntry]);

    // {lines→parks, contains, reverse} — subject = parks: "parks contain the
    // clicked line". The INTERIOR line's click answers the polygon; the
    // crossing one doesn't (contains ≡ within with the arguments swapped —
    // the line must lie fully inside).
    const reversed = await declareRelation(lines, parks, "spatial", {
      direction: "reverse",
      predicate: "contains",
    });
    const byReversed = await records(reversed, projectId, lines, interior, [-180, -80, 180, 80]);
    expect(byReversed.map((row) => row.entry_id)).toEqual([polygonEntry]);
    expect((await records(reversed, projectId, lines, crossing, [-180, -80, 180, 80])).length).toBe(
      0,
    );

    // {trails2→parks, contains, forward} — subject = trails2: "the clicked
    // park is contained by a trail region". A big region around the dome
    // answers (within(dome, big)); the WRONG arm (within(big, dome)) would
    // answer nothing, so this pins the reduction's fourth quadrant.
    const big = await addGeometryEntry(
      trails2,
      { name: "region" },
      {
        coordinates: [
          [
            [0, 0],
            [40, 0],
            [40, 40],
            [0, 40],
            [0, 0],
          ],
        ],
        type: "Polygon",
      },
    );
    const forwardContains = await declareRelation(trails2, parks, "spatial", {
      direction: "forward",
      predicate: "contains",
    });
    const byForwardContains = await records(
      forwardContains,
      projectId,
      parks,
      polygonEntry,
      [-180, -80, 180, 80],
    );
    expect(byForwardContains.map((row) => row.entry_id)).toEqual([big]);

    // intersects (order-free): {parks→lines, intersects, forward} — the
    // polygon's click answers the crossing trail, not the far one.
    const intersects = await declareRelation(parks, lines, "spatial", {
      direction: "forward",
      predicate: "intersects",
    });
    const byIntersects = await records(
      intersects,
      projectId,
      parks,
      polygonEntry,
      [-180, -80, 180, 80],
    );
    // The crossing AND interior trails intersect the dome; the far one doesn't.
    expect(byIntersects.map((row) => row.entry_id).toSorted()).toEqual(
      [crossing, interior].toSorted(),
    );
    void disjoint;

    // Page probe: limit 1 answers one row with has_more; the next offset
    // answers the rest without it.
    const page1 = await records(within, projectId, parks, polygonEntry, [-180, -80, 180, 80], 0, 1);
    expect(page1.length).toBe(1);
    expect(present(page1[0]).has_more).toBe(true);
    const page2 = await records(within, projectId, parks, polygonEntry, [-180, -80, 180, 80], 1, 1);
    expect(page2.length).toBe(1);
    expect(present(page2[0]).has_more).toBe(false);
    expect(present(page1[0]).entry_id).not.toBe(present(page2[0]).entry_id);

    await s().rollback();
    await dropDatasets(s(), [parks, points, lines, trails2]);
  });

  test("spatial path (frozen): the pinned side's frozen geometry answers the predicate", async () => {
    await asAlice();
    const projectId = await seedProject();
    const parks = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const points = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });

    const polygonEntry = await addGeometryEntry(parks, { name: "dome" }, POLYGON);
    await addGeometryEntry(points, { name: "in" }, pointAt(12, 12));

    const pointsMembership = await addMembership(projectId, points);
    const frozenVersion = await publish(points, "v1", `pk-${points}`);
    await pinMembership(pointsMembership, frozenVersion);

    const within = await declareRelation(points, parks, "spatial", {
      direction: "forward",
      predicate: "within",
    });
    expect(
      (await records(within, projectId, parks, polygonEntry, [-180, -80, 180, 80])).length,
    ).toBe(1);

    // The live side gains a new inside point — the PINNED answer stays frozen.
    await addGeometryEntry(points, { name: "late" }, pointAt(14, 14));
    expect(
      (await records(within, projectId, parks, polygonEntry, [-180, -80, 180, 80])).length,
    ).toBe(1);

    await s().rollback();
    await dropDatasets(s(), [parks, points]);
  });

  test("perf: the live spatial query is index-served (never a full-table spatial scan), and a 20k-point dataset answers inside the budget", async () => {
    // The 20k seed lands as COMMITTED admin rows (autocommit), then ANALYZE
    // runs on them: the perf criterion's plan evidence needs the planner to
    // see a lived-in table, and in-transaction rows are invisible to
    // ANALYZE. The user transaction below runs the RPC and rolls back; the
    // `finally` drops the fixtures and VACUUM-analyzes the emptied tables so
    // the shared sequential DB keeps true stats and no dead-tuple bloat for
    // the suites that follow.
    await s().asAdmin();
    const parks = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const points = await createDataset(s(), { createdBy: ALICE, editPolicy: "open" });
    const polygonEntry = await addGeometryEntry(parks, { name: "dome" }, POLYGON);

    // 20k points: one CTE statement (the convex-test bulk-seed posture), a
    // quarter inside the polygon, the rest far outside it.
    await s().expectOk(
      `with e as (
         insert into public.entries (dataset_id, data, geometry_type)
         select ${sqlLit(points)}, jsonb_build_object('name', 'pt-' || i, 'i', i), 'Point'
         from generate_series(1, 20000) i
         returning id, (data ->> 'i')::int as i
       )
       insert into public.geometries (dataset_id, entry_id, source, type, created_by)
       select ${sqlLit(points)}, e.id,
         jsonb_build_object('type', 'Point', 'coordinates',
           case when e.i % 4 = 0
             then jsonb_build_array(11 + (e.i % 8), 11 + (e.i % 8))
             else jsonb_build_array(40 + (e.i % 10), 40 + (e.i % 10)) end),
         'Point', ${sqlLit(ALICE)}
       from e`,
    );
    await s().expectOk("analyze public.entries");
    await s().expectOk("analyze public.geometries");

    try {
      await s().begin();
      await s().asUser(ALICE);
      const projectId = await seedProject();
      const within = await declareRelation(points, parks, "spatial", {
        direction: "forward",
        predicate: "within",
      });

      // The RPC over the 20k dataset through the REALISTIC interaction (the
      // user's viewport scoped to the polygon), responsive under the AMBIENT
      // planner (a generous wall-clock bound; CI boxes vary). The click-time
      // viewport is what keeps the candidate set selective at 20k.
      const started = Date.now();
      const rows = await s().query(
        `select count(*) as n from public.dataset_relation_records(
         ${sqlLit(within)}, ${sqlLit(projectId)}, ${sqlLit(parks)}, ${sqlLit(polygonEntry)},
         ${sqlLit(JSON.stringify([10, 10, 20, 20]))}::jsonb, 0, 500)`,
      );
      const elapsed = Date.now() - started;
      expect(rows.error).toBeUndefined();
      const count = Number(firstRow(rows.rows).n);
      expect(count).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10_000);

      // The PLAN (the perf criterion's deterministic evidence): at a selective
      // click-time viewport with the planner seeing real stats, the other
      // side's geometries are reached through an INDEX — never a bare seq
      // scan over the table (the 2026-10 map-perf lesson's full-scan
      // regression). Two index shapes are live and both bound the work: the
      // spatial-driven geometries_geom_gist hash-join shape, and the
      // entries-driven nested loop probing geometries_entry_id_key (one
      // geometry per entry). Which one wins is the planner's call under the
      // RLS-filtered estimates; neither streams unbounded rows, and the RPC's
      // cap + viewport bound the answer regardless.
      const plan = await s().query(
        `explain (costs off) select e.id
       from public.entries e
       join public.geometries g on g.entry_id = e.id
       where e.dataset_id = ${sqlLit(points)}
         and g.geom is not null
         and g.geom && st_makeenvelope(10, 10, 20, 20, 4326)
         and st_within(st_geomfromgeojson('{"type":"Polygon","coordinates":[[[10,10],[20,10],[20,20],[10,20],[10,10]]]}'), g.geom)
       order by e.id`,
      );
      expect(plan.error).toBeUndefined();
      const planText = plan.rows.map((row) => String(Object.values(row)[0])).join("\n");
      expect(planText).not.toMatch(/Seq Scan on (public\.)?geometries/);
      expect(planText).toMatch(/Index (Scan|Only Scan) using geometries_(geom_gist|entry_id_key)/);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [parks, points]);
      await s().expectOk("vacuum analyze public.entries");
      await s().expectOk("vacuum analyze public.geometries");
    }
  }, 120_000);

  test("realtime absence: dataset_relations is deliberately NOT a publication member", async () => {
    await asAlice();
    const rows = await s().expectOk(
      `select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dataset_relations'`,
    );
    expect(
      rows.length,
      "dataset_relations must stay out of supabase_realtime (0021's recorded decision)",
    ).toBe(0);
    await s().rollback();
  });
});
