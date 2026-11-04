// Shared integration-test infrastructure for the stage-1 PG tests
// (pg-rls / pg-core-schema / pg-search-entries / pg-references).
//
// This file is named *.int.test.ts because it is the only file pattern this
// stage is allowed to add under store/; it carries a single skipped
// placeholder test so vitest's collector (which matches the same glob)
// accepts it as a suite, and the other files import its exports.
//
// There is no Postgres driver in the workspace and the stage-1 builder
// cannot add one, and vitest's workers run under plain node (verified:
// `process.execPath` is node, not bun) — so this module speaks the Postgres
// wire protocol directly over node:net: SCRAM-SHA-256 authentication
// (postgres 14+ default, what both the local stack and CI's
// supabase/postgres:15.8.1.049 service container use) and the simple query
// protocol, with text-format rows. Just enough for RLS/RPC tests; not a
// general driver.

import crypto from "node:crypto";
import net from "node:net";

import { test } from "vitest";

// The placeholder must stay skipped: this module is helper code collected
// only because the stage's file pattern is *.int.test.ts.
// oxlint-disable-next-line vitest/no-disabled-tests -- intentional: placeholder suite for a helpers-only file
test.skip("shared PG integration helpers (imported by the other pg-*.int.test.ts files)", () => {});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Fixed fixture users (created idempotently by `ensureUsers`). */
export const ALICE = "a0000000-0000-4000-8000-000000000001";
export const BOB = "a0000000-0000-4000-8000-000000000002";

let probed: boolean | undefined;
/** One connectivity probe per worker; tests gate on this via skipIf. */
export function dbUp(): boolean {
  return probed ?? false;
}

export function reportUnreachable(reason?: string): void {
  // The one-line skip message the tests are required to print.
  const why = reason ? ` (${reason})` : "";
  console.log(`skipping: Supabase Postgres unreachable at ${DB_URL}${why}`);
}

// ---------------------------------------------------------------------------
// Minimal wire client
// ---------------------------------------------------------------------------

export type Row = Record<string, string | null>;
export type QueryResult = {
  rows: Row[];
  error?: string;
  code?: string;
  /** CommandComplete tag, e.g. "UPDATE 2" — used to detect 0-row writes. */
  tag?: string;
};

export class PgSession {
  private sock: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | undefined;
  private failer: ((err: Error) => void) | undefined;
  private savepointCount = 0;
  private closed = false;
  private inTransaction = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      const w = this.waiter;
      this.waiter = undefined;
      if (w) w();
    });
    sock.on("error", (err: Error) => {
      const f = this.failer;
      this.failer = undefined;
      if (f) f(err);
    });
    sock.on("close", () => {
      const f = this.failer;
      this.failer = undefined;
      if (f) f(new Error("connection closed"));
    });
  }

  /** Connect, authenticate (SCRAM-SHA-256, cleartext or md5 fallbacks). */
  static async connect(urlString: string): Promise<PgSession> {
    const url = new URL(urlString);
    const user = decodeURIComponent(url.username || "postgres");
    const password = decodeURIComponent(url.password || "postgres");
    const database = decodeURIComponent(url.pathname.replace(/^\//, "") || "postgres");

    const sock = net.connect({
      host: url.hostname,
      port: Number(url.port || 5432),
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      sock.once("error", onError);
      sock.once("connect", () => {
        sock.off("error", onError);
        resolve();
      });
    });

    const session = new PgSession(sock);
    await session.sendStartup(user, database);
    await session.authenticate(user, password);
    await session.readUntilReady();
    return session;
  }

  private async sendStartup(user: string, database: string): Promise<void> {
    const payload = Buffer.concat([
      Buffer.from(`user\0${user}\0database\0${database}\0\0`, "utf8"),
    ]);
    const head = Buffer.alloc(8);
    head.writeInt32BE(8 + payload.length, 0);
    head.writeInt32BE(196608, 4); // protocol 3.0
    this.sock.write(Buffer.concat([head, payload]));
  }

  private async readFrame(): Promise<{ type: number; payload: Buffer }> {
    for (;;) {
      if (this.buf.length >= 5) {
        const type = this.buf[0];
        const length = this.buf.readInt32BE(1);
        if (this.buf.length >= 1 + length) {
          const frame = {
            type,
            payload: this.buf.subarray(5, 1 + length),
          };
          this.buf = this.buf.subarray(1 + length);
          return frame;
        }
      }
      await new Promise<void>((resolve, reject) => {
        this.waiter = resolve;
        this.failer = reject;
      });
      if (this.closed) throw new Error("connection closed");
    }
  }

  private async authenticate(user: string, password: string): Promise<void> {
    // client-first state lives outside the union so TS7022's circular
    // inference (state referencing its own field's initializer) can't arise.
    let clientNonce = "";
    let clientFirstBare = "";
    let serverFirst = "";
    let saltedPassword: Buffer | undefined;
    let authMessage = "";

    for (;;) {
      const frame = await this.readFrame();
      if (frame.type === 0x45 /* E */) {
        throw new Error(`auth failed: ${parseErrorFields(frame.payload).M ?? "unknown"}`);
      }
      if (frame.type !== 0x52 /* R */) {
        // Not an authentication message yet (e.g. a NegotiateProtocolVersion).
        if (frame.type === 0x45) {
          throw new Error(`auth failed: ${parseErrorFields(frame.payload).M ?? "unknown"}`);
        }
        continue;
      }
      const kind = frame.payload.readInt32BE(0);
      if (kind === 0) {
        return; // AuthenticationOk
      }
      if (kind === 3) {
        // CleartextPassword
        this.sock.write(
          Buffer.concat([
            Buffer.from([0x70 /* p */]),
            int32(4 + password.length + 1),
            Buffer.from(`${password}\0`, "utf8"),
          ]),
        );
        continue;
      }
      if (kind === 5) {
        // MD5Password: md5(md5(password + user) + salt)
        const salt = frame.payload.subarray(4, 8);
        const inner = crypto.createHash("md5").update(`${password}${user}`).digest("hex");
        const response = crypto
          .createHash("md5")
          .update(inner + salt.toString("hex"))
          .digest("hex");
        this.sock.write(
          Buffer.concat([
            Buffer.from([0x70]),
            int32(4 + `md5${response}`.length + 1),
            Buffer.from(`md5${response}\0`, "utf8"),
          ]),
        );
        continue;
      }
      if (kind === 10) {
        // AuthenticationSASLContinue — server's mechanism list + first data.
        const mechanisms = frame.payload.subarray(4).toString("utf8").split("\0").filter(Boolean);
        if (!mechanisms.includes("SCRAM-SHA-256")) {
          throw new Error(`unsupported SASL mechanisms: ${mechanisms.join(", ")}`);
        }
        clientNonce = crypto.randomBytes(18).toString("base64");
        clientFirstBare = `n=${user},r=${clientNonce}`;
        const clientFirst = `n,,${clientFirstBare}`;
        const body = Buffer.concat([
          Buffer.from("SCRAM-SHA-256\0", "utf8"),
          int32(clientFirst.length),
          Buffer.from(clientFirst, "utf8"),
        ]);
        this.sock.write(Buffer.concat([Buffer.from([0x70]), int32(4 + body.length), body]));
        continue;
      }
      if (kind === 11 && clientFirstBare !== "") {
        // AuthenticationSASLContinue with the server-first-message:
        // r=...,s=...,i=...
        serverFirst = frame.payload.subarray(4).toString("utf8");
        const parts = Object.fromEntries(
          serverFirst
            .split(",")
            .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
        );
        const combinedNonce = parts.r;
        const salt = Buffer.from(parts.s, "base64");
        const iterations = Number(parts.i);
        if (!combinedNonce.startsWith(clientNonce)) {
          throw new Error("SCRAM nonce mismatch");
        }
        saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
        const clientKey = hmac(saltedPassword, "Client Key");
        const storedKey = crypto.createHash("sha256").update(clientKey).digest();
        const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`;
        authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
        const clientSignature = hmac(storedKey, authMessage);
        const clientProof = xor(clientKey, clientSignature);
        const clientFinal = `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
        const body = Buffer.from(clientFinal, "utf8");
        this.sock.write(Buffer.concat([Buffer.from([0x70]), int32(4 + body.length), body]));
        continue;
      }
      if (kind === 12 && saltedPassword !== undefined) {
        // AuthenticationSASLFinal: v=<base64 server signature>
        const serverFirstAndFinal = frame.payload.subarray(4).toString("utf8");
        const v = serverFirstAndFinal.slice("v=".length);
        const serverKey = hmac(saltedPassword, "Server Key");
        const serverSignature = hmac(serverKey, authMessage);
        if (serverSignature.toString("base64") !== v) {
          throw new Error("SCRAM server signature mismatch");
        }
        continue;
      }
      throw new Error(`unsupported auth message kind ${kind}`);
    }
  }

  private async readUntilReady(): Promise<void> {
    for (;;) {
      const frame = await this.readFrame();
      if (frame.type === 0x5a /* Z */) return;
      if (frame.type === 0x45 /* E */) {
        throw new Error(parseErrorFields(frame.payload).M ?? "startup failed");
      }
    }
  }

  /** One simple-protocol Query; ErrorResponse is returned, not thrown. */
  async query(text: string): Promise<QueryResult> {
    const body = Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
    this.sock.write(Buffer.concat([Buffer.from([0x51 /* Q */]), int32(4 + body.length), body]));

    const rows: Row[] = [];
    let columns: string[] = [];
    let error: string | undefined;
    let code: string | undefined;
    let tag: string | undefined;
    for (;;) {
      const frame = await this.readFrame();
      switch (frame.type) {
        case 0x54 /* T RowDescription */: {
          columns = [];
          const fieldCount = frame.payload.readInt16BE(0);
          let offset = 2;
          for (let i = 0; i < fieldCount; i += 1) {
            let end = frame.payload.indexOf(0, offset);
            columns.push(frame.payload.subarray(offset, end).toString("utf8"));
            offset = end + 1 + 18; // name\0 + table oid/attnum/oid/len/mod/format
          }
          break;
        }
        case 0x44 /* D DataRow */: {
          const fieldCount = frame.payload.readInt16BE(0);
          const row: Row = {};
          let offset = 2;
          for (let i = 0; i < fieldCount; i += 1) {
            const len = frame.payload.readInt32BE(offset);
            offset += 4;
            if (len === -1) {
              row[columns[i] ?? `col${i}`] = null;
            } else {
              row[columns[i] ?? `col${i}`] = frame.payload
                .subarray(offset, offset + len)
                .toString("utf8");
              offset += len;
            }
          }
          rows.push(row);
          break;
        }
        case 0x45 /* E ErrorResponse */: {
          const fields = parseErrorFields(frame.payload);
          error = fields.M ?? "unknown error";
          code = fields.C;
          break;
        }
        case 0x43 /* C CommandComplete */:
          tag = frame.payload.toString("utf8");
          break;
        case 0x5a /* Z ReadyForQuery */:
          return { rows, error, code, tag };
        default:
          break; // S ParameterStatus, K, N, I — ignored
      }
    }
  }

  /**
   * Savepoint-wrapped statement expected to be DENIED. Two denial shapes
   * exist under RLS (§4): a raised policy violation (INSERTs always; WHERE
   * -less statements) and the "reads as not found" shape — an UPDATE/DELETE
   * whose policy-filtered WHERE matches nothing, reported as 0 rows
   * affected. Returns the reason; throws if the statement had any effect.
   */
  async denied(text: string): Promise<string> {
    const sp = `sp_${this.savepointCount}`;
    this.savepointCount += 1;
    await this.query(`savepoint ${sp}`);
    const result = await this.query(text);
    await this.query(`rollback to ${sp}`);
    await this.query(`release ${sp}`);
    if (result.error !== undefined) return result.error;
    const affected = affectedCount(result.tag);
    if (affected === 0) return "0 rows affected (RLS-filtered: reads as not found)";
    throw new Error(
      `expected statement to be denied, but it affected ${affected} row(s) (tag: ${result.tag ?? "none"}): ${text}`,
    );
  }

  /** Assert the statement ran cleanly and return its rows. */
  async expectOk(text: string): Promise<Row[]> {
    const result = await this.query(text);
    if (result.error !== undefined) throw new Error(`${result.error} — in: ${text}`);
    return result.rows;
  }

  /** First cell of the first row as a number (counts). */
  async count(text: string): Promise<number> {
    const rows = await this.expectOk(text);
    const value = Object.values(rows[0] ?? {})[0];
    if (value === undefined) throw new Error(`count query returned no rows: ${text}`);
    return Number(value);
  }

  async begin(): Promise<void> {
    await this.expectOk("begin");
    this.inTransaction = true;
  }
  async commit(): Promise<void> {
    await this.expectOk("commit");
    this.inTransaction = false;
  }
  async rollback(): Promise<void> {
    await this.expectOk("rollback");
    this.inTransaction = false;
  }

  /** Roll back if a transaction is still open (cleanup after failures). */
  async rollbackIfOpen(): Promise<void> {
    if (this.inTransaction) {
      await this.rollback();
    }
  }

  /** Become an authenticated user for the current transaction.
   *
   * Sets BOTH auth.uid() GUC generations: newer supabase stacks' auth.uid()
   * parses the whole-claims JSON (`request.jwt.claims`), while the baked
   * auth schema of the bare supabase/postgres image (CI's service
   * container) reads `request.jwt.claim.sub` only (design §3.1 stage-0
   * review addendum) — setting both keeps every image family's auth.uid()
   * working. Both are cleared on every switch (asAnon/asAdmin and role
   * changes below): with claims-only the bare image's auth.uid() would
   * otherwise keep returning the PREVIOUS user after a mid-transaction
   * asUser switch, since set local role does not touch GUCs. */
  async asUser(userId: string): Promise<void> {
    await this.expectOk("set local role authenticated");
    await this.expectOk(
      `select set_config('request.jwt.claims', ${sqlLit(JSON.stringify({ sub: userId, role: "authenticated" }))}, true)`,
    );
    await this.expectOk(`select set_config('request.jwt.claim.sub', ${sqlLit(userId)}, true)`);
  }

  async asAnon(): Promise<void> {
    await this.expectOk("set local role anon");
    await this.expectOk(`select set_config('request.jwt.claims', '', true)`);
    await this.expectOk(`select set_config('request.jwt.claim.sub', '', true)`);
  }

  async asAdmin(): Promise<void> {
    await this.expectOk("reset role");
    await this.expectOk(`select set_config('request.jwt.claims', '', true)`);
    await this.expectOk(`select set_config('request.jwt.claim.sub', '', true)`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sock.write(Buffer.from([0x58 /* X Terminate */]));
    this.sock.destroy();
    this.sock.end();
  }
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

/** Affected-rows count from a CommandComplete tag ("UPDATE 2" -> 2). */
function affectedCount(tag: string | undefined): number | null {
  if (tag === undefined) return null;
  // The payload carries a trailing NUL terminator; \s does not match it.
  const parts = tag.replace(/\0/g, " ").trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const n = Number(last);
  return Number.isFinite(n) && parts.length > 1 ? n : null;
}

function hmac(key: Buffer, message: string | Buffer): Buffer {
  return crypto.createHmac("sha256", key).update(message).digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i]; // oxlint-disable-line eslint/no-bitwise -- SCRAM's client proof is XOR over GF(2); the operator is the primitive
  return out;
}

function parseErrorFields(payload: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  for (;;) {
    const code = payload[offset];
    if (code === 0) break;
    const start = offset + 1;
    const end = payload.indexOf(0, start);
    fields[String.fromCharCode(code)] = payload.subarray(start, end).toString("utf8");
    offset = end + 1;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Literal quoting (simple-protocol statements; standard_conforming_strings
// is on, so only single quotes need doubling)
// ---------------------------------------------------------------------------

export function sqlLit(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return quote(JSON.stringify(value) ?? "null");
  if (typeof value === "bigint" || typeof value === "symbol") return value.toString();
  throw new Error(`sqlLit: unsupported value type ${typeof value}`);
}

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create the fixture users (idempotent); the profiles trigger runs.
 *
 * confirmed_at, not email_confirmed_at: the baked auth schema of every
 * supabase/postgres image (CI's bare service container included) carries
 * ONLY confirmed_at — referencing email_confirmed_at fails with 42703 there
 * — while CLI 3.x stacks that run newer GoTrue migrations carry
 * email_confirmed_at as the insertable column (there confirmed_at is
 * GENERATED ALWAYS from it, so an explicit confirmed_at insert fails with
 * "cannot insert a non-DEFAULT value"). No fixed column list fits both
 * image families, so the confirmation column is probed once per worker
 * (see confirmedColumn below) and the insert is built around whichever
 * column the target stack accepts. */
export async function ensureUsers(session: PgSession): Promise<void> {
  const confirmed = confirmedColumn;
  await session.expectOk(
    `insert into auth.users (id, email, encrypted_password, aud, role${confirmed === undefined ? "" : `, ${confirmed}`}, created_at, updated_at)
     values (${sqlLit(ALICE)}, 'alice@pg-int.test', '', 'authenticated', 'authenticated'${confirmed === undefined ? "" : ", now()"}, now(), now()),
            (${sqlLit(BOB)}, 'bob@pg-int.test', '', 'authenticated', 'authenticated'${confirmed === undefined ? "" : ", now()"}, now(), now())
     on conflict (id) do nothing`,
  );
}

export async function createDataset(
  session: PgSession,
  opts: {
    createdBy: string;
    editPolicy?: "open" | "locked";
    lifecycle?: "draft" | "published";
    visibility?: "everyone" | "author";
    frozenLineage?: boolean;
    properties?: string[];
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await session.expectOk(
    `insert into public.datasets
       (id, title, properties, created_by, edit_policy, lifecycle, published_visibility, lineage)
     values (${sqlLit(id)}, 'pg-int fixture', ${sqlLit(JSON.stringify(opts.properties ?? ["name"]))}::jsonb,
             ${sqlLit(opts.createdBy)}, ${sqlLit(opts.editPolicy ?? "open")},
             ${sqlLit(opts.lifecycle ?? "published")}, ${sqlLit(opts.visibility ?? "everyone")},
             ${opts.frozenLineage ? sqlLit(JSON.stringify({ frozen: true })) : "null"}::jsonb)`,
  );
  return id;
}

export async function addEntry(
  session: PgSession,
  datasetId: string,
  data: unknown,
): Promise<string> {
  const rows = await session.expectOk(
    `insert into public.entries (dataset_id, data) values (${sqlLit(datasetId)}, ${sqlLit(JSON.stringify(data))}::jsonb) returning id::text as id`,
  );
  return rows[0].id as string;
}

export async function dropDatasets(session: PgSession, ids: string[]): Promise<void> {
  await session.rollbackIfOpen();
  await session.asAdmin();
  for (const id of ids) {
    await session.expectOk(`delete from public.datasets where id = ${sqlLit(id)}`);
  }
}

// Probe the stack once per worker so every test file can `skipIf(!dbUp())`.
// The same probe resolves the auth.users confirmation column ensureUsers may
// insert (email_confirmed_at on GoTrue-migrated CLI 3.x stacks, whose
// confirmed_at is GENERATED ALWAYS; confirmed_at on the baked-schema images
// CI's bare service container runs — see ensureUsers).
let confirmedColumn: "email_confirmed_at" | "confirmed_at" | undefined;
try {
  const probe = await PgSession.connect(DB_URL);
  const confirmed = await probe.expectOk(
    `select column_name from information_schema.columns
      where table_schema = 'auth' and table_name = 'users'
        and column_name = 'email_confirmed_at'`,
  );
  confirmedColumn = confirmed.length > 0 ? "email_confirmed_at" : "confirmed_at";
  await probe.close();
  probed = true;
} catch (error) {
  probed = false;
  reportUnreachable(error instanceof Error ? error.message : String(error));
}
