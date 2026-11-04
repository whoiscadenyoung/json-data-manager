import { PostgrestError, type SupabaseClient } from "@supabase/supabase-js";

/**
 * A supabase-js stand-in for the store/seam unit tests: a PostgREST builder
 * stub (a Promise subclass, so awaiting resolves like the real thenable
 * without adding a `then` member) that RECORDS every chained operation — so
 * tests assert the exact selects/filters/inserts the store issues — plus an
 * rpc entry point, a Storage client recording signed-URL requests, and small
 * accessors that keep the optional-chaining- and unsafe-cast-free test style
 * readable.
 */

/** One chained builder call, e.g. `{ method: "eq", args: ["dataset_id", "…"] }`. */
export interface RecordedOperation {
  method: string;
  args: unknown[];
}

/** One recorded query: a table read/write or an RPC call, with its full chain. */
export interface RecordedQuery {
  /** Table name for `from()` queries; null for `rpc()` calls. */
  table: string | null;
  /** RPC name for `rpc()` calls; null for table queries. */
  rpc: string | null;
  /** The `rpc()` argument object (empty for table queries). */
  rpcArgs: Record<string, unknown>;
  /** Every chained builder method in call order. */
  operations: RecordedOperation[];
}

/** The response a query resolves with. */
export interface ScriptedResponse {
  data?: unknown;
  error?: PostgrestError | null;
}

/** Decides a query's response from its recorded shape. */
export type QueryResponder = (query: RecordedQuery) => ScriptedResponse;

export interface RecordedSignedUrl {
  bucket: string;
  path: string;
  ttlSeconds: number;
}

/** One `storage.from(...).upload` request, with the body's size for byte-count assertions. */
export interface RecordedUpload {
  bucket: string;
  path: string;
  bodyBytes: number;
  upsert: boolean;
}

export interface StubSupabase {
  client: SupabaseClient;
  /** Every `from()`/`rpc()` query in call order. */
  queries: RecordedQuery[];
  /** Every `storage.from(...).createSignedUrl` request in call order. */
  signedUrls: RecordedSignedUrl[];
  /** Every `storage.from(...).upload` request in call order. */
  uploads: RecordedUpload[];
  /** Stack the next responder (the top of the stack answers the next query). */
  respond: (responder: QueryResponder) => void;
}

/** The awaited shape of every supabase-js response the store consumes. */
type PostgrestResult = { data: unknown; error: PostgrestError | null };

/**
 * The builder stub: awaits resolve the responder's script (eagerly read at
 * construction — the top of the responder stack answers); every chain method
 * records itself and returns the same builder, so the fluent chain survives.
 */
class StubBuilder extends Promise<PostgrestResult> {
  // `then()` must build plain Promises for its derived promise — the default
  // species (the subclass itself) would re-enter this constructor with a
  // bare executor and crash.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  private readonly query: RecordedQuery;

  constructor(query: RecordedQuery, respond: (query: RecordedQuery) => ScriptedResponse) {
    super((resolve) => {
      // The response is read in a MICROTASK, not eagerly: the chain methods
      // (`select`/`eq`/…/`limit`) all run synchronously after the builder is
      // created, and dispatchers key on the completed chain.
      queueMicrotask(() => {
        const response = respond(query);
        resolve({ data: response.data ?? null, error: response.error ?? null });
      });
    });
    this.query = query;
  }

  private record(method: string, args: unknown[]): this {
    this.query.operations.push({ args, method });
    return this;
  }

  select(...args: unknown[]): this {
    return this.record("select", args);
  }

  eq(...args: unknown[]): this {
    return this.record("eq", args);
  }

  order(...args: unknown[]): this {
    return this.record("order", args);
  }

  limit(...args: unknown[]): this {
    return this.record("limit", args);
  }

  or(filter: string): this {
    return this.record("or", [filter]);
  }

  in(...args: unknown[]): this {
    return this.record("in", args);
  }

  insert(...args: unknown[]): this {
    return this.record("insert", args);
  }

  update(...args: unknown[]): this {
    return this.record("update", args);
  }

  upsert(...args: unknown[]): this {
    return this.record("upsert", args);
  }

  delete(...args: unknown[]): this {
    return this.record("delete", args);
  }

  single(): this {
    return this.record("single", []);
  }
}

/**
 * Builds the stub client. Without a responder every query resolves
 * `{ data: null, error: null }`; pass one up front or stack more via
 * `respond` (each query is answered by the LAST stacked responder).
 */
export function stubSupabase(initial?: QueryResponder): StubSupabase {
  const queries: RecordedQuery[] = [];
  const signedUrls: RecordedSignedUrl[] = [];
  const uploads: RecordedUpload[] = [];
  const stack: QueryResponder[] = initial === undefined ? [] : [initial];
  const respond = (query: RecordedQuery): ScriptedResponse => {
    const responder = stack[stack.length - 1];
    return responder === undefined ? { data: null, error: null } : responder(query);
  };
  const client = {
    // oxlint-disable-next-line typescript/promise-function-async -- the stub must hand back the thenable synchronously, exactly as the real PostgrestQueryBuilder does; an async wrapper would break the fluent chain.
    from(table: string) {
      const query: RecordedQuery = { operations: [], rpc: null, rpcArgs: {}, table };
      queries.push(query);
      return new StubBuilder(query, respond);
    },
    // oxlint-disable-next-line typescript/promise-function-async -- same as `from`.
    rpc(rpc: string, rpcArgs: Record<string, unknown> = {}) {
      const query: RecordedQuery = { operations: [], rpc, rpcArgs, table: null };
      queries.push(query);
      return new StubBuilder(query, respond);
    },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string, ttlSeconds: number) => {
            signedUrls.push({ bucket, path, ttlSeconds });
            return { data: { signedUrl: `https://signed.test/${bucket}/${path}` }, error: null };
          },
          upload: async (path: string, body: unknown, options?: { upsert?: boolean }) => {
            const bytes =
              body instanceof Blob
                ? body.size
                : typeof body === "string"
                  ? body.length
                  : ArrayBuffer.isView(body)
                    ? body.byteLength
                    : 0;
            const upsert =
              options === undefined || options.upsert === undefined ? false : options.upsert;
            uploads.push({ bodyBytes: bytes, bucket, path, upsert });
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stand-in: the real SupabaseClient surface is far wider than anything the store touches, and the stub only implements `from`/`rpc`/`storage`.
    client: client as unknown as SupabaseClient,
    queries,
    respond: (responder: QueryResponder) => {
      stack.push(responder);
    },
    signedUrls,
    uploads,
  };
}

/** A well-formed PostgREST error for scripting failures (the real class, so `instanceof` and the typed fields hold). */
export function postgrestError(message = "permission denied", code = "42501"): PostgrestError {
  return new PostgrestError({ code, details: "", hint: "", message });
}

// ---------------------------------------------------------------------------
// Test-side accessors — indexed/optional access without the banned optional
// chaining, and with loud failures instead of silent undefineds
// ---------------------------------------------------------------------------

/** The nth recorded query, or a loud failure naming what the test expected. */
export function queryAt(queries: ReadonlyArray<RecordedQuery>, index: number): RecordedQuery {
  const query = queries[index];
  if (query === undefined) {
    throw new Error(`No recorded query at index ${index} (have ${queries.length}).`);
  }
  return query;
}

/** The first argument of the first operation with `method`, or a loud failure. */
export function firstArg(query: RecordedQuery, method: string): unknown {
  const operation = query.operations.find((candidate) => candidate.method === method);
  if (operation === undefined) {
    throw new Error(`No ${method} operation recorded (have: ${methodList(query).join(", ")}).`);
  }
  return operation.args[0];
}

/** The FULL argument list of the first operation with `method`, or a loud failure. */
export function argsOf(query: RecordedQuery, method: string): unknown[] {
  const operation = query.operations.find((candidate) => candidate.method === method);
  if (operation === undefined) {
    throw new Error(`No ${method} operation recorded (have: ${methodList(query).join(", ")}).`);
  }
  return operation.args;
}

/** Every argument list of the operations with `method`, in call order. */
export function allArgs(query: RecordedQuery, method: string): unknown[][] {
  return query.operations
    .filter((candidate) => candidate.method === method)
    .map((candidate) => candidate.args);
}

/** The chain's method names, in call order. */
export function methodList(query: RecordedQuery): string[] {
  return query.operations.map((candidate) => candidate.method);
}

/** Runs a queryOptions' queryFn with a minimal stub context (the store's queryFns close over their args and never read the context). */
export async function runQueryOptions<T>(options: {
  queryFn?: (context: never) => T | Promise<T>;
}): Promise<Awaited<T>> {
  const queryFn = options.queryFn;
  if (queryFn === undefined) {
    throw new Error("The query options carry no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context; `never` satisfies the parameter without constructing a QueryClient for nothing.
  return await queryFn({} as never);
}
