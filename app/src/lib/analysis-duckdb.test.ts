import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";

import {
  applyEngineLockdown,
  ENGINE_LOCKDOWN_STATEMENTS,
  normalizeArrowValue,
} from "./analysis-duckdb";
import type { LockdownConnection } from "./analysis-duckdb";

/**
 * The pure cell-normalization policy of the DuckDB engine handle (the
 * `SqlEngine` impl's query leg). The WASM engine itself can't run under
 * vitest (no worker/browser WASM in the node environment), so the
 * information_schema drop dance and memory_limit setting stay
 * build-verified only — this file pins the one piece of that module that is
 * pure policy: what an Arrow cell becomes in serializable plain data.
 */
describe("normalizeArrowValue — Arrow cells into serializable plain data", () => {
  it("narrows DuckDB's BigInt aggregates (COUNT/sum) to safe numbers", () => {
    expect(normalizeArrowValue(42n)).toBe(42);
    expect(normalizeArrowValue(0n)).toBe(0);
    expect(normalizeArrowValue(-9007199254740991n)).toBe(-9007199254740991);
  });

  it("stringifies BigInt beyond the safe range instead of silently losing precision", () => {
    expect(normalizeArrowValue(9007199254740992n)).toBe("9007199254740992");
    expect(normalizeArrowValue(-9007199254740993n)).toBe("-9007199254740993");
  });

  it("passes every non-BigInt value through untouched", () => {
    expect(normalizeArrowValue("aldine")).toBe("aldine");
    expect(normalizeArrowValue(3.14)).toBe(3.14);
    expect(normalizeArrowValue(null)).toBe(null);
    expect(normalizeArrowValue(undefined)).toBe(undefined);
    expect(normalizeArrowValue(true)).toBe(true);
  });
});

/** A connection stand-in recording what it was asked to run, refusing the statements in `failures` (an engine build without those settings). */
function recordingConnection(failures: ReadonlySet<string>): LockdownConnection & {
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (failures.has(sql)) {
        throw new Error("Cannot change configuration option");
      }
      return undefined;
    },
  };
}

describe("ENGINE_LOCKDOWN_STATEMENTS — the post-init lockdown (#132)", () => {
  it("disables external access and the extension gates, locking the configuration LAST so a query cannot undo the lockdown", () => {
    expect(ENGINE_LOCKDOWN_STATEMENTS).toStrictEqual([
      "SET enable_external_access = false",
      "SET autoinstall_known_extensions = false",
      "SET autoload_known_extensions = false",
      "SET lock_configuration = true",
    ]);
  });

  it("leaves memory_limit out — it must precede the lock, and createEngine sets it just before the applier runs", () => {
    expect(
      ENGINE_LOCKDOWN_STATEMENTS.some((statement) => statement.includes("memory_limit")),
    ).toBe(false);
  });
});

describe("applyEngineLockdown — best-effort, in order, never failing startup", () => {
  it("runs every lockdown statement in order against the connection", async () => {
    const connection = recordingConnection(new Set());
    await applyEngineLockdown(connection);
    expect(connection.queries).toStrictEqual([...ENGINE_LOCKDOWN_STATEMENTS]);
  });

  it("swallows an unsupported setting and still applies the rest of the lockdown", async () => {
    const unsupported = ENGINE_LOCKDOWN_STATEMENTS[1] ?? "";
    const connection = recordingConnection(new Set([unsupported]));
    await expect(applyEngineLockdown(connection)).resolves.toBeUndefined();
    expect(connection.queries).toStrictEqual([...ENGINE_LOCKDOWN_STATEMENTS]);
  });
});

/**
 * The lockdown against the REAL pinned engine. The browser path (blob-URL
 * worker, Vite `?url` assets) cannot run under vitest, so these drive the
 * same package's own Node target — same wasm engine, same API surface —
 * through the real `applyEngineLockdown` code path. The behaviors pinned
 * here were probe-verified on this exact pin on 2026-09-30 (engine v1.5.4
 * embedded in `@duckdb/duckdb-wasm` 1.33.1-dev57.0).
 */
const nodeRequire = createRequire(import.meta.url),
  NODE_BUNDLE_PATH = nodeRequire.resolve("@duckdb/duckdb-wasm/dist/duckdb-node.cjs"),
  DUCKDB_PKG_ROOT = path.dirname(path.dirname(NODE_BUNDLE_PATH)),
  /** The slice of the Node bundle this file drives (the CJS require comes back untyped). */
  duckdbNode = nodeRequire(NODE_BUNDLE_PATH) as {
    AsyncDuckDB: new (
      logger: unknown,
      worker: unknown,
    ) => {
      connect(): Promise<LockdownConnection>;
      instantiate(mainModule: string, pthreadWorker: string | null): Promise<null>;
    };
    ConsoleLogger: new (level: number) => unknown;
    LogLevel: { WARNING: number };
  };

/**
 * A `worker_threads` Worker running a bootstrap that wires the duckdb
 * worker's web-style `globalThis.onmessage` / `globalThis.postMessage` onto
 * `parentPort` — node wires neither on a bare worker (the script's handler
 * registration silently no-ops and the worker drains to exit 0), while the
 * browser bundle spawns its own importScripts blob for the same reason.
 * `eval: true` keeps the bootstrap a string here rather than a repo file.
 */
class NodeWorkerBridge {
  private readonly worker: Worker;

  constructor(workerScriptPath: string) {
    const bootstrap = [
      "const { parentPort } = require('node:worker_threads');",
      "globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);",
      `require(${JSON.stringify(workerScriptPath)});`,
      "parentPort.on('message', (message) => {",
      "  const handler = globalThis.onmessage;",
      "  if (typeof handler === 'function') { handler({ data: message }); }",
      "});",
    ].join("\n");
    this.worker = new Worker(bootstrap, { eval: true });
  }

  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void {
    if (type === "message") {
      this.worker.on("message", (data) => handler({ data }));
    } else if (type === "error") {
      this.worker.on("error", (error) => handler({ data: error }));
    } else if (type === "close") {
      this.worker.on("exit", () => handler({}));
    }
  }

  postMessage(message: unknown): void {
    // A worker_threads port here, not window.postMessage — the targetOrigin rule does not apply.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    this.worker.postMessage(message);
  }

  async terminate(): Promise<unknown> {
    return this.worker.terminate();
  }
}

/** The connection surface the assertions read (plain records out of the Arrow table). */
interface ProbeConnection {
  query(sql: string): Promise<{ toArray(): Array<Record<string, unknown>> }>;
}

describe("the locked-down engine (real pinned wasm, Node target)", () => {
  let bridge: NodeWorkerBridge | undefined,
    connection: ProbeConnection | undefined;

  const engine = (): ProbeConnection => {
    if (connection === undefined) {
      throw new Error("the engine was not built");
    }
    return connection;
  };

  beforeAll(async () => {
    bridge = new NodeWorkerBridge(path.join(DUCKDB_PKG_ROOT, "dist/duckdb-node-eh.worker.cjs"));
    const db = new duckdbNode.AsyncDuckDB(
      new duckdbNode.ConsoleLogger(duckdbNode.LogLevel.WARNING),
      bridge,
    );
    await db.instantiate(path.join(DUCKDB_PKG_ROOT, "dist/duckdb-eh.wasm"), null);
    const opened = await db.connect();
    await opened.query("SET memory_limit='256MB'");
    // The real code path — the same applier createEngine runs.
    await applyEngineLockdown(opened);
    connection = opened as ProbeConnection;
  }, 120_000);

  afterAll(async () => {
    if (bridge !== undefined) {
      await bridge.terminate();
    }
  });

  it("refuses a remote read_csv — a shared analysis cannot make the viewer's browser fetch (Permission Error)", async () => {
    await expect(
      engine().query("SELECT count(*) AS n FROM read_csv('https://example.invalid/data.csv')"),
    ).rejects.toThrow(/Permission Error/);
  }, 30_000);

  it("refuses read_parquet / parquet_scan — the extension is no longer autoloaded (Catalog Error)", async () => {
    await expect(
      engine().query("SELECT count(*) AS n FROM read_parquet('https://example.invalid/data.parquet')"),
    ).rejects.toThrow(/Catalog Error/);
    await expect(
      engine().query("SELECT count(*) AS n FROM parquet_scan('https://example.invalid/data.parquet')"),
    ).rejects.toThrow(/Catalog Error/);
  }, 30_000);

  it("refuses LOAD httpfs — external extensions cannot be pulled in after the lockdown", async () => {
    await expect(engine().query("LOAD httpfs")).rejects.toThrow(/Permission Error/);
  }, 30_000);

  it("refuses SET after engine init — lock_configuration froze the settings in place", async () => {
    await expect(engine().query("SET memory_limit='512MB'")).rejects.toThrow(
      /Cannot change configuration option/,
    );
    await expect(engine().query("SET enable_external_access=true")).rejects.toThrow(
      /Cannot change configuration option/,
    );
  }, 30_000);

  it("still runs a plain SELECT — the lockdown does not touch legitimate analyses", async () => {
    const result = await engine().query("SELECT 42 AS n");
    expect(result.toArray().map((row) => row.n)).toStrictEqual([42]);
  }, 30_000);
});
