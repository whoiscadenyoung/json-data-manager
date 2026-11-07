import { MAP_TILE_ARCHIVE_FORMAT } from "./pg-tile-archives";
/* oxlint-disable unicorn/require-post-message-target-origin -- every postMessage here is the worker boundary, which takes (message, transfer); there is no `targetOrigin` argument (the tile-archive.ts posture). */
import {
  fetchSupabaseAccessToken,
  type TileArchiveWorkerInbound,
  type TileArchiveWorkerOutbound,
} from "./tile-archive";

/**
 * The publish walk's frozen-archive leg (issue #261) — the main-thread half
 * of the worker's frozen-build protocol. One build = one ONE-SHOT worker
 * instance: the live scheduler (`tile-archive.ts`) never sees these
 * messages, its build states stay about the live datasets, and a publish's
 * builds cannot wedge the map editor's scheduling. The CPU-bound
 * tile math + the entry paging + the upload all run in that worker, keyed
 * off the main thread; the wrapper only answers the token handshake and
 * waits for the terminal message.
 *
 * The worker's client authenticates as the CALLING (signed-in) user, so the
 * `version_entries` read and the signed upload ride the publisher's own RLS
 * rights — the anon policy never applies on this leg.
 */

/** The pin stamp a successful build returns (`AppDatasetPin.archive`). */
export interface FrozenArchiveStamp {
  bytes: number;
  format: number;
  maxZoom: number;
  path: string;
}

/** The worker-spawn guard: tests and SSR render without workers — the publish walk then stamps null (rows path). */
function workersAvailable(): boolean {
  return typeof Worker !== "undefined";
}

const FROZEN_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** The frozen-protocol message types the one-shot wrapper settles on. */
type FrozenTerminal = Extract<
  TileArchiveWorkerOutbound,
  { type: "frozen-done" | "frozen-skipped" | "frozen-error" }
>;

function isFrozenTerminal(message: TileArchiveWorkerOutbound): message is FrozenTerminal {
  return (
    message.type === "frozen-done" ||
    message.type === "frozen-skipped" ||
    message.type === "frozen-error"
  );
}

/** Settles one terminal frozen message into the awaiting publish walk. */
function settleFrozen(
  message: FrozenTerminal,
  reject: (error: Error) => void,
  resolve: (stamp: FrozenArchiveStamp | null) => void,
): void {
  if (message.type === "frozen-done") {
    resolve({
      bytes: message.bytes,
      // The layout generation this builder produced — the read side's
      // format gate compares exactly this stamp (pg-tile-archives.ts).
      format: MAP_TILE_ARCHIVE_FORMAT,
      maxZoom: message.maxZoom,
      path: message.path,
    });
  } else if (message.type === "frozen-skipped") {
    resolve(null);
  } else {
    reject(new Error(message.message));
  }
}

/**
 * Builds one pinned version's tile archive from its own frozen rows and
 * uploads it under the frozen path convention. Resolves null when the build
 * legitimately skipped (below the 256 KB threshold — rows render it fine);
 * throws when the build failed (the caller degrades the pin to null and
 * notes it — a tile leg never fails the publish).
 */
export async function buildFrozenTileArchive(args: {
  datasetId: string;
  versionId: string;
}): Promise<FrozenArchiveStamp | null> {
  if (!workersAvailable()) {
    return null;
  }
  const worker = new Worker(new URL("./tile-archive.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise<FrozenArchiveStamp | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("The frozen tile build timed out."));
      }, FROZEN_BUILD_TIMEOUT_MS);
      worker.addEventListener("message", (event: MessageEvent<TileArchiveWorkerOutbound>) => {
        const message = event.data;
        if (message === null || message === undefined || typeof message !== "object") {
          return;
        }
        if (message.type === "token-request") {
          // The worker-handshake shape (tile-archive.ts): answer the token
          // request on the same channel, null when signed out.
          void fetchSupabaseAccessToken().then((token) => {
            worker.postMessage({
              requestId: message.requestId,
              token,
              type: "token",
            } satisfies TileArchiveWorkerInbound);
            return token;
          });
          return;
        }
        if (!isFrozenTerminal(message)) {
          // Phases are informational; a live-protocol message on a one-shot
          // instance cannot occur (the unions are disjoint) — ignore.
          return;
        }
        if (message.datasetId !== args.datasetId) {
          return;
        }
        clearTimeout(timeout);
        settleFrozen(message, reject, resolve);
      });
      worker.addEventListener("error", (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message || "The frozen tile worker crashed."));
      });
      worker.postMessage({
        datasetId: args.datasetId,
        type: "build-frozen",
        versionId: args.versionId,
      } satisfies TileArchiveWorkerInbound);
    });
  } finally {
    worker.terminate();
  }
}
