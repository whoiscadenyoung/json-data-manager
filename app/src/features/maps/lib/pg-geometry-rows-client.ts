/**
 * Main-thread manager for the row-path geometry worker (`./pg-geometry-rows.worker.ts`,
 * [remedies 1] / #287) — the `tile-archive.ts` singleton-worker pattern:
 * one lazy worker, a per-dataset listener registry, and the token bridge
 * (the worker's own supabase client authenticates through here, since it
 * has no Better Auth session of its own — null when signed out, and the
 * load then fails loudly instead of silently reading zero RLS-visible rows).
 *
 * The loaders (`PgGeometriesLoader`) subscribe per dataset and receive the
 * worker's page/error events; unsubscribing cancels that dataset's run, so
 * an unmounted map stops streaming mid-pass.
 */
import type {
  PgGeometryRowsWorkerInbound,
  PgGeometryRowsWorkerOutbound,
} from "./pg-geometry-rows.worker";
// Same module graph as the loaders (main thread only): the token read is a
// tiny session getter that lives next to the tile worker's handshake.
import { fetchSupabaseAccessToken } from "./tile-archive";

type PageListener = (event: PgGeometryRowsWorkerOutbound) => void;

let rowsWorker: Worker | undefined;
const listenersByDataset = new globalThis.Map<string, Set<PageListener>>();

function workerOf(): Worker {
  if (rowsWorker === undefined) {
    const spawned = new Worker(new URL("./pg-geometry-rows.worker.ts", import.meta.url), {
      type: "module",
    });
    spawned.addEventListener("message", (event: MessageEvent<PgGeometryRowsWorkerOutbound>) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "token-request") {
        void replyToken(message.requestId);
        return;
      }
      const set = listenersByDataset.get(message.datasetId);
      if (set !== undefined) {
        for (const listener of set) {
          listener(message);
        }
      }
    });
    // A crashed worker takes its in-flight runs with it; the next subscribe
    // re-spawns and the loaders' queries re-run from scratch.
    spawned.addEventListener("error", () => {
      rowsWorker = undefined;
      listenersByDataset.clear();
    });
    rowsWorker = spawned;
  }
  return rowsWorker;
}

/**
 * Answers the worker's token requests (the tile worker's protocol, its own
 * channel): the fetcher never rejects — null when signed out — so a request
 * never hangs and the load fails with the sign-in gate's error instead.
 */
async function replyToken(requestId: number): Promise<void> {
  const token = await fetchSupabaseAccessToken();
  const worker = rowsWorker;
  if (worker === undefined) return;
  // `Worker.postMessage` takes (message, transfer) — there is no
  // `targetOrigin` parameter to pass at the worker boundary.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage({ requestId, token, type: "token" } satisfies PgGeometryRowsWorkerInbound);
}

/** Starts (or restarts) one dataset's streaming pass. A run already in flight is cancelled by the worker before the new one starts; `runId` rides every event so a superseded pass's stragglers are droppable. */
export function loadPgGeometryRows(datasetId: string, runId: number): void {
  const message = { datasetId, runId, type: "load" } satisfies PgGeometryRowsWorkerInbound;
  // `Worker.postMessage` takes (message, transfer) — there is no
  // `targetOrigin` parameter at the worker boundary (the rule's Window
  // postMessage shape does not apply).
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  workerOf().postMessage(message);
}

/** Stops one dataset's in-flight pass (between pages) — unmount's cancel. */
export function cancelPgGeometryRows(datasetId: string): void {
  if (rowsWorker !== undefined) {
    // `Worker.postMessage` takes (message, transfer) — there is no
    // `targetOrigin` parameter at the worker boundary (the rule's Window
    // postMessage shape does not apply).
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    rowsWorker.postMessage({ datasetId, type: "cancel" } satisfies PgGeometryRowsWorkerInbound);
  }
}

/**
 * Subscribes to one dataset's worker events (pages + load errors). Returns
 * the unsubscriber; the LAST unsubscribe for a dataset also cancels its
 * run — an unmounted loader must not keep the worker paging.
 */
export function subscribePgGeometryRows(datasetId: string, listener: PageListener): () => void {
  let set = listenersByDataset.get(datasetId);
  if (set === undefined) {
    set = new Set();
    listenersByDataset.set(datasetId, set);
  }
  set.add(listener);
  return () => {
    const current = listenersByDataset.get(datasetId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByDataset.delete(datasetId);
      cancelPgGeometryRows(datasetId);
    }
  };
}
