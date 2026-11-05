// Live-stack integration proof for migration 0012_realtime_publication.sql
// and the #205 acceptance checks it unblocked — §15 step-5: "RLS-respecting
// channel receives only permitted rows".
//
// What it pins (all observed live against the local stack):
//   1. postgres_changes DELIVERS once the matrix tables join the
//      `supabase_realtime` publication (before 0012 the channels subscribed
//      and the server answered "Unable to subscribe to changes ... check
//      Realtime is enabled" — zero events, the review's merge-blocker).
//   2. RLS filters PER SUBSCRIBER: the private draft's owner receives the
//      event; a second signed-in user subscribed to the same topic/filter
//      receives nothing.
//   3. The payload mirrors the TABLE's own columns verbatim — the contract
//      realtime.test.ts's fixtures model. Verified column sets:
//        entries:    created_at, created_by, data, dataset_id,
//                    geometry_type, id, search, updated_at
//        geometries: bbox, created_at, created_by, dataset_id, entry_id,
//                    geom, id, source, source_bytes, source_path, type,
//                    updated_at
//      (notably NO `data` on geometries — that is entries.data, JOINed in by
//      the §5.5 tiles RPC only — the fact that makes the tiles feed
//      un-patchable from geometry payloads, and `geom` present as the
//      generated column's wire form.)
//
// Environment: needs the FULL local stack (Postgres + the realtime WS
// server). CI's int-test job runs a bare postgres service container with no
// realtime server, so this file skips there, like the other pg-*.int tests
// skip without a DB. Three skip reasons, each printed:
//   - Postgres unreachable (SUPABASE_DB_URL),
//   - the realtime endpoint unreachable or the worker has no WebSocket
//     global (node >= 22 does; older workers would need the `ws` package),
//   - the publication lacks the matrix (a shared local stack reset from a
//     tree predating 0012 — apply 0012 or reset from a current tree).
//
// AUTH NOTE (verified live, CLI-v3 stack): subscriber tokens are HS256 JWTs
// minted with the stack's demo JWT secret (the same secret CI's storage-api
// boot uses) — the REALTIME server verifies them against its JWKS oct key.
// PostgREST does NOT accept them (it validates the newer ES256 keys only),
// so every write here goes through the PG wire client as the acting user,
// exactly like the RLS tests do. Reads of the fixtures are wire-only too.

import crypto from "node:crypto";

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  BOB,
  createDataset,
  DB_URL,
  dbUp,
  dropDatasets,
  PgSession,
  sqlLit,
} from "./pg-int-helpers.int.test";

// ---------------------------------------------------------------------------
// Environment + reachability probes (module level, per worker — the helpers'
// pattern: boolean flags feed describe.skipIf)
// ---------------------------------------------------------------------------

const REALTIME_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
/** The CLI-v3 local stack's publishable key (kong rejects legacy JWT keys on the realtime route). */
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
/** The demo JWT secret every CLI-managed local stack signs with (see the header). */
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";

/** The eleven published tables: 0013's eight matrix tables + 0015's completion (apps, consumer_references, version_policies). */
const MATRIX_TABLES = [
  "apps",
  "collection_datasets",
  "consumer_references",
  "dataset_versions",
  "datasets",
  "entries",
  "geometries",
  "layer_styles",
  "map_layers",
  "tags",
  "version_policies",
];

let probed = false;
let probeReason = "";

try {
  const session = await PgSession.connect(DB_URL);
  const rows = await session.expectOk(
    `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`,
  );
  const published = rows.map((row) => row.tablename);
  await session.close();
  if (JSON.stringify(published) === JSON.stringify(MATRIX_TABLES)) {
    probed = true;
  } else {
    probeReason = `supabase_realtime publication has [${published.join(", ")}], expected the 0013+0015 matrix — re-apply 0013_realtime_publication.sql and 0015_realtime_matrix_completion.sql or reset from a current tree`;
    console.log(`skipping: ${probeReason}`);
  }
} catch (error) {
  probeReason = error instanceof Error ? error.message : String(error);
  console.log(`skipping: Supabase Postgres unreachable at ${DB_URL} (${probeReason})`);
}

/** base64url of a JSON value — the JWT segment encoder (no state of its own, hence module scope). */
function enc(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Mints an HS256 access token the realtime server accepts (header note). */
function mintToken(userId: string): string {
  const header = enc({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = enc({
    aud: "authenticated",
    exp: now + 3600,
    iat: now,
    role: "authenticated",
    sub: userId,
  });
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** A realtime client acting as `userId` (no session persistence — tokens are minted). */
async function subscriber(userId: string): Promise<SupabaseClient> {
  const client = createClient(REALTIME_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { params: { eventsPerSecond: 1000 } },
  });
  await client.realtime.setAuth(mintToken(userId));
  return client;
}

interface RecordedEvent {
  eventType: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
  table: string;
}

/** Subscribes one postgres_changes listener and resolves when the server's postgres subscribe completes. */
async function listen(
  client: SupabaseClient,
  topic: string,
  table: string,
  filter: string,
  events: RecordedEvent[],
): Promise<RealtimeChannel> {
  const channel = client.channel(topic);
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table, filter },
    (payload: unknown) => {
      const record = payload as Record<string, unknown>;
      events.push({
        eventType: String(record["eventType"]),
        new: (record["new"] ?? {}) as Record<string, unknown>,
        old: (record["old"] ?? {}) as Record<string, unknown>,
        table,
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("channel subscribe timed out")), 10_000);
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`channel status ${status}`));
      }
    });
  });
  // The phoenix join resolves BEFORE the server-side postgres subscribe
  // finishes (verified live: a write inside the join's shadow delivers
  // nothing — postgres_changes does not replay). Wait it out before tests
  // write.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1_500);
  });
  return channel;
}

async function closeChannels(client: SupabaseClient): Promise<void> {
  for (const channel of client.getChannels()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- teardown: the sockets close one at a time, so a wedged unsubscribe stays attributable to its channel.
    await client.removeChannel(channel);
  }
}

// Realtime WS probe: a subscription round-trip on a topic nothing publishes to.
if (probed) {
  try {
    const probeClient = await subscriber(ALICE);
    await listen(
      probeClient,
      "realtime:pg-realtime-int-probe",
      "entries",
      "dataset_id=eq.00000000-0000-4000-8000-000000000000",
      [],
    );
    await closeChannels(probeClient);
  } catch (error) {
    probed = false;
    probeReason = error instanceof Error ? error.message : String(error);
    console.log(`skipping: Supabase Realtime unreachable at ${REALTIME_URL} (${probeReason})`);
  }
}

let session: PgSession | undefined;
let datasetId: string;
let entryId: string;
const subscribedChannels: RealtimeChannel[] = [];

function s(): PgSession {
  if (session === undefined) throw new Error("integration session not connected");
  return session;
}

beforeEach(async () => {
  if (!dbUp() || !probed) return;
  session = await PgSession.connect(DB_URL);
  await session.expectOk("begin");
  // A PRIVATE DRAFT owned by ALICE: drafts are visible to the creator only
  // (the recorded RLS shape), so BOB has no SELECT row and the channel must
  // deliver him nothing.
  datasetId = await createDataset(s(), {
    createdBy: ALICE,
    lifecycle: "draft",
    visibility: "author",
  });
  await s().asAdmin();
  const rows = await s().expectOk(
    `insert into public.entries (dataset_id, data) values (${sqlLit(datasetId)}, '{"name":"before"}'::jsonb) returning id::text as id`,
  );
  const first = rows[0];
  if (first === undefined) throw new Error("entry fixture insert returned no row");
  entryId = first.id ?? "";
  await s().commit();
});

afterEach(async () => {
  if (session === undefined) return;
  for (const channel of subscribedChannels.splice(0)) {
    const client = channelToClient.get(channel);
    if (client !== undefined) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- teardown: same as closeChannels, sequential so failures stay attributable.
      await client.removeChannel(channel);
    }
  }
  await s().rollbackIfOpen();
  await dropDatasets(s(), [datasetId]);
  await s().close();
  session = undefined;
});

afterAll(async () => {
  for (const client of clients) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- teardown: close each client's sockets before the next, so one wedged socket cannot swallow the rest's errors.
    await closeChannels(client);
  }
  clients.length = 0;
});

const clients: SupabaseClient[] = [];
const channelToClient = new Map<RealtimeChannel, SupabaseClient>();

/** Subscribes and records the owning client for teardown. */
async function listenOn(
  client: SupabaseClient,
  table: string,
  filter: string,
  events: RecordedEvent[],
): Promise<RealtimeChannel> {
  if (!clients.includes(client)) clients.push(client);
  const channel = await listen(
    client,
    `dataset:${datasetId}:${table}:${clients.length}`,
    table,
    filter,
    events,
  );
  subscribedChannels.push(channel);
  channelToClient.set(channel, client);
  return channel;
}

/** Resolves with the next matching event (or fails the test's deadline).
 *
 * Matches on the CHANGED VALUE (`field` = `value`), not just the row id: a
 * subscription's first poll flushes a backlog of PRE-subscription changes
 * the replication slot still held, and the fixtures' own trigger updates
 * (an entries INSERT bumps the datasets row's counts) arrive as stale
 * UPDATE events for the very same row id — only the test's own write
 * carries the asserted value. */
async function nextEvent(
  events: RecordedEvent[],
  table: string,
  match: { eventType: "UPDATE"; field: string; id: string; value: unknown },
  // Generous: in the FULL suite the other int tests run in parallel and
  // flood the shared replication slot — delivery drains that backlog first
  // (poll_max_changes per poll). Isolated runs deliver in well under 1 s.
  timeoutMs = 15_000,
): Promise<RecordedEvent> {
  const expected = JSON.stringify(match.value);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(
        new Error(
          `no ${table} ${match.eventType} for ${match.id} with ${match.field}=${expected} within ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
    const interval = setInterval(() => {
      const event = events.find(
        (candidate) =>
          candidate.table === table &&
          candidate.eventType === match.eventType &&
          candidate.new["id"] === match.id &&
          JSON.stringify(candidate.new[match.field]) === expected,
      );
      if (event !== undefined) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(event);
      }
    }, 10);
  });
}

/** Fixed wait (the leak-check grace window after the owner's delivery). */
async function sleep(ms: number): Promise<void> {
  return await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe.skipIf(!dbUp() || !probed)(
  "pg realtime (0012): delivery, per-subscriber RLS, payload shape",
  () => {
    test("the entries UPDATE reaches the draft's owner and mirrors the table's columns verbatim", async () => {
      const events: RecordedEvent[] = [];
      await listenOn(await subscriber(ALICE), "entries", `dataset_id=eq.${datasetId}`, events);

      const startedAt = Date.now();
      await s().begin();
      await s().asUser(ALICE);
      const result = await s().query(
        `update public.entries set data = '{"name":"after"}'::jsonb where id = ${sqlLit(entryId)}`,
      );
      expect(result.error).toBeUndefined();
      await s().commit();

      const event = await nextEvent(events, "entries", {
        eventType: "UPDATE",
        field: "data",
        id: entryId,
        value: { name: "after" },
      });
      const latencyMs = Date.now() - startedAt;
      // The #205 acceptance shape (< 1 s between editors) was measured in
      // isolation (the PR records 184-688 ms across the scaling runs); the
      // gate here only bounds delivery under full-suite parallel load, where
      // the shared replication slot's backlog comes first.
      expect(latencyMs).toBeLessThan(15_000);
      // Payload = the entries table's own columns (see header), `old` = the
      // default replica identity's primary key only.
      expect(Object.keys(event.new).toSorted()).toStrictEqual([
        "created_at",
        "created_by",
        "data",
        "dataset_id",
        "geometry_type",
        "id",
        "search",
        "updated_at",
      ]);
      expect(event.new["data"]).toStrictEqual({ name: "after" });
      expect(event.new["id"]).toBe(entryId);
      expect(Object.keys(event.old)).toStrictEqual(["id"]);
      expect(event.old["id"]).toBe(entryId);
      console.log(`measured: entries UPDATE delivered in ${latencyMs} ms`);
    }, 30_000);

    test("a subscriber without read access receives nothing while the owner receives the event (§15 step-5)", async () => {
      const aliceEvents: RecordedEvent[] = [];
      const bobEvents: RecordedEvent[] = [];
      // Both subscribed BEFORE the write — a leak could not slip in after.
      await listenOn(await subscriber(ALICE), "entries", `dataset_id=eq.${datasetId}`, aliceEvents);
      await listenOn(await subscriber(BOB), "entries", `dataset_id=eq.${datasetId}`, bobEvents);

      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(
        `update public.entries set data = '{"name":"leak-check"}'::jsonb where id = ${sqlLit(entryId)}`,
      );
      await s().commit();

      const event = await nextEvent(aliceEvents, "entries", {
        eventType: "UPDATE",
        field: "data",
        id: entryId,
        value: { name: "leak-check" },
      });
      expect(event.new["data"]).toStrictEqual({ name: "leak-check" });
      // Grace window after the owner's delivery: BOB must stay silent.
      await sleep(1_500);
      expect(bobEvents.length).toBe(0);
    }, 30_000);

    test("the datasets row event reaches the owner (the tile live signal's single subscription)", async () => {
      const events: RecordedEvent[] = [];
      await listenOn(await subscriber(ALICE), "datasets", `id=eq.${datasetId}`, events);

      await s().begin();
      await s().asUser(ALICE);
      await s().expectOk(
        `update public.datasets set description = 'live-signal' where id = ${sqlLit(datasetId)}`,
      );
      await s().commit();

      const event = await nextEvent(events, "datasets", {
        eventType: "UPDATE",
        field: "description",
        id: datasetId,
        value: "live-signal",
      });
      expect(event.new["description"]).toBe("live-signal");
      // The tile signal rides the row itself (#186 remainder).
      expect(typeof event.new["map_tile_cache_version"]).toBe("number");
    }, 30_000);
  },
);
