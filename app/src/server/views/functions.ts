import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * The view runner's server functions (issue #300). The browser sends a view
 * id (plus a step index, or a draft DEFINITION as JSON) and its Supabase
 * access token — never SQL, never rows. The token is verified on the server
 * (`claims.ts`); the handler bodies import the server-only wiring lazily so
 * nothing server-side reaches the client bundle.
 */

const inputRef = z.object({
  alias: z.string(),
  datasetId: z.string(),
  pinnedVersion: z.string().optional(),
});

const runInput = z.object({ accessToken: z.string().min(1), viewId: z.string().min(1) });

const previewInput = z.object({
  accessToken: z.string().min(1),
  uptoStep: z.number().int().min(0).optional(),
  viewId: z.string().min(1).optional(),
  definition: z.unknown().optional(),
  inputs: z.array(inputRef).optional(),
});

const scratchInput = z.object({
  accessToken: z.string().min(1),
  projectId: z.string().min(1),
  sql: z.string().max(100_000).optional(),
});

/** Scratch query (#306): the project's table names, plus the result when `sql` is given. Read-only as the caller. */
export const scratchQueryFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => scratchInput.parse(input))
  .handler(async ({ data }) => {
    const { scratchForToken } = await import("./entry.server");
    return await scratchForToken(data.accessToken, data.projectId, data.sql);
  });

export const runViewFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => runInput.parse(input))
  .handler(async ({ data }) => {
    const { runViewForToken } = await import("./entry.server");
    return await runViewForToken(data.accessToken, data.viewId);
  });

export const previewViewFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => previewInput.parse(input))
  .handler(async ({ data }) => {
    const { previewForToken } = await import("./entry.server");
    const step = data.uptoStep === undefined ? {} : { uptoStep: data.uptoStep };
    if (data.viewId !== undefined) {
      return await previewForToken(data.accessToken, { viewId: data.viewId, ...step });
    }
    if (data.inputs === undefined) {
      throw new Error("preview needs a viewId, or a draft definition with its inputs");
    }
    return await previewForToken(data.accessToken, {
      definition: data.definition,
      inputs: data.inputs,
      ...step,
    });
  });

const liveInput = z.object({ accessToken: z.string().min(1), viewId: z.string().min(1) });

/** A live view's rows, computed on this read (issue #305): capped, read-only, as the reader. */
export const readLiveViewFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => liveInput.parse(input))
  .handler(async ({ data }) => {
    const { readLiveForToken } = await import("./entry.server");
    return await readLiveForToken(data.accessToken, data.viewId);
  });

const modeInput = z.object({
  accessToken: z.string().min(1),
  viewId: z.string().min(1),
  mode: z.enum(["manual", "auto", "live"]),
});

export const setRefreshModeFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => modeInput.parse(input))
  .handler(async ({ data }) => {
    const { setRefreshModeForToken } = await import("./entry.server");
    await setRefreshModeForToken(data.accessToken, data.viewId, data.mode);
  });
