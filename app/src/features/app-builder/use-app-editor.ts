import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import type { AppContent } from "#convex/appBuilder/validators";

export type AppDoc = NonNullable<FunctionReturnType<typeof api.appBuilder.apps.get>>;

export type SaveStatus = "saved" | "pending" | "saving" | "error";

/** Quiet period after the last edit before an autosave goes out. */
const AUTOSAVE_MS = 700;

/**
 * The builder's working copy of an app's content, autosaved. Edits apply to
 * local state immediately (the canvas never waits on the network); a
 * debounced save sends the whole content with the revision it was based on,
 * and the server refuses a save built on a stale revision (another tab).
 *
 * The debounce lives in refs driven from the edit handlers — never in an
 * effect keyed on content, whose cleanup would cancel a pending save on any
 * unrelated re-render (the transform-preview lesson, docs/memory).
 */
export function useAppEditor(app: AppDoc) {
  const saveContent = useMutation(api.appBuilder.apps.saveContent),
    [content, setContent] = useState<AppContent>(() => ({
      datasetIds: app.datasetIds,
      widgets: app.widgets,
    })),
    [status, setStatus] = useState<SaveStatus>("saved"),
    latest = useRef(content),
    revision = useRef(app.revision),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    dirty = useRef(false),
    inFlight = useRef(false);

  const flush = async (): Promise<void> => {
    if (inFlight.current || !dirty.current) {
      return;
    }
    inFlight.current = true;
    dirty.current = false;
    setStatus("saving");
    try {
      revision.current = await saveContent({
        appId: app._id,
        content: latest.current,
        expectedRevision: revision.current,
      });
      setStatus(dirty.current ? "pending" : "saved");
    } catch (error) {
      dirty.current = true;
      setStatus("error");
      toast.error(errorMessage(error, "Couldn't save the app."));
      return;
    } finally {
      inFlight.current = false;
    }
    if (dirty.current) {
      schedule();
    }
  };

  function schedule() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush();
    }, AUTOSAVE_MS);
  }

  const update = (change: (prev: AppContent) => AppContent) => {
    const next = change(latest.current);
    latest.current = next;
    setContent(next);
    dirty.current = true;
    setStatus("pending");
    schedule();
  };

  // Leaving the page: send what's pending, and warn on a hard unload.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current || inFlight.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      clearTimeout(timer.current);
      void flush();
    };
    // oxlint-disable-next-line react/exhaustive-deps -- mount/unmount only: `flush` reads refs, so the latest content always goes out.
  }, []);

  return {
    content,
    retry: () => {
      void flush();
    },
    status,
    update,
  };
}
