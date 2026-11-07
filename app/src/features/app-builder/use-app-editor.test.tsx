import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appDocOf, type AppDoc } from "./lib/app-doc";
import { firstPage } from "./lib/content";
import { useAppEditor } from "./use-app-editor";

// The save seam is mocked at the store boundary: the hook's save semantics
// (CAS advance, refusal handling, the held-back gate) are the subject here,
// not the store's Postgres calls. Mocking the store module also keeps the
// `#/env`-reaching client seam (`store/client` → `integrations/supabase`) out
// of the module graph, the stage-3 CI lesson.
const mocks = vi.hoisted(() => ({
  saveContent:
    vi.fn<
      (args: { appId: string; content: unknown; expectedRevision: number }) => Promise<number>
    >(),
}));

vi.mock("#/lib/store/apps", () => ({ saveContent: mocks.saveContent }));

/** One save call's args, or a clear failure naming the wanted call. */
function saveArgOf(callIndex: number): {
  appId: string;
  content: unknown;
  expectedRevision: number;
} {
  const call = mocks.saveContent.mock.calls[callIndex];
  if (call === undefined) {
    throw new Error(`saveContent was not called (wanted call ${callIndex})`);
  }
  const args = call[0];
  if (args === undefined) {
    throw new Error(`saveContent call ${callIndex} recorded no arguments`);
  }
  return args;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  // The store answers `expectedRevision + 1` (the CAS successor it wrote).
  mocks.saveContent.mockResolvedValue(4);
});

const CREATOR = "11111111-1111-4111-8111-111111111111",
  APP_ID = "aaaaaaa1-0000-4000-8000-000000000001";

function appOf(overrides: Partial<AppDoc> = {}): AppDoc {
  return {
    ...appDocOf(
      {
        createdAt: "2026-11-04T00:00:00.000Z",
        createdBy: CREATOR,
        datasetIds: [],
        description: null,
        example: false,
        id: APP_ID,
        pages: [],
        project: { createdBy: CREATOR, id: "p1", title: "Parks project" },
        projectId: "p1",
        revision: 3,
        visibility: "members",
        title: "Parks",
        updatedAt: "2026-11-04T01:00:00.000Z",
      },
      "owner",
    ),
    ...overrides,
  };
}

/** The hook's view, as one committed render reported it. */
type EditorView = ReturnType<typeof useAppEditor>;

function viewOf(reads: Array<EditorView>): EditorView {
  const last = reads[reads.length - 1];
  if (last === undefined) {
    throw new Error("the editor never committed a render");
  }
  return last;
}

/** Reports each committed editor view upward (the dataset-rows-react test's probe shape). */
function EditorProbe({ app, onRender }: { app: AppDoc; onRender: (view: EditorView) => void }) {
  const view = useAppEditor(app);
  useEffect(() => {
    onRender(view);
  }, [onRender, view]);
  return null;
}

/** The hook reads the query cache (save invalidations), so it renders under a provider. */
function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  );
}

function renderEditor(app: AppDoc): Array<EditorView> {
  const reads: Array<EditorView> = [];
  const onRender = (view: EditorView) => {
    reads.push(view);
  };
  render(createElement(EditorProbe, { app, onRender }), { wrapper: Wrapper });
  return reads;
}

describe("useAppEditor", () => {
  it("starts saved with the app's content as the working copy", () => {
    const reads = renderEditor(appOf());
    expect(viewOf(reads).status).toBe("saved");
    expect(viewOf(reads).content.pages).toHaveLength(1);
    expect(viewOf(reads).content.pages[0].id).toBe("page-1");
    expect(mocks.saveContent).not.toHaveBeenCalled();
  });

  it("sends the whole content with the revision it was based on, then goes back to saved", async () => {
    const reads = renderEditor(appOf({ revision: 3 })),
      editor = viewOf(reads);
    act(() => {
      editor.update((prev) => ({ ...prev, datasetIds: ["d1"] }));
    });
    expect(viewOf(reads).status).toBe("pending");
    editor.retry();
    await waitFor(() => {
      expect(mocks.saveContent).toHaveBeenCalledTimes(1);
    });
    expect(saveArgOf(0)).toStrictEqual({
      appId: APP_ID,
      content: { datasetIds: ["d1"], pages: [firstPage()] },
      expectedRevision: 3,
    });
    await waitFor(() => {
      expect(viewOf(reads).status).toBe("saved");
    });
  });

  it("advances its own CAS ref — a second save carries the successor revision", async () => {
    const reads = renderEditor(appOf({ revision: 3 })),
      editor = viewOf(reads);
    act(() => {
      editor.update((prev) => ({ ...prev, datasetIds: ["d1"] }));
    });
    editor.retry();
    await waitFor(() => {
      expect(viewOf(reads).status).toBe("saved");
    });
    act(() => {
      editor.update((prev) => ({ ...prev, datasetIds: ["d1", "d2"] }));
    });
    editor.retry();
    await waitFor(() => {
      expect(mocks.saveContent).toHaveBeenCalledTimes(2);
    });
    expect(saveArgOf(1).expectedRevision).toBe(4);
    await waitFor(() => {
      expect(viewOf(reads).status).toBe("saved");
    });
  });

  it("holds back content the user is mid-way through fixing (a blank page title) and says so", async () => {
    const reads = renderEditor(appOf()),
      editor = viewOf(reads);
    act(() => {
      editor.update((prev) => ({
        ...prev,
        pages: [{ ...prev.pages[0], title: "   " }],
      }));
    });
    // The edit registers as pending; the held-back verdict arrives when a
    // save is attempted (the debounce or an explicit retry).
    expect(viewOf(reads).status).toBe("pending");
    await act(async () => {
      editor.retry();
    });
    expect(mocks.saveContent).not.toHaveBeenCalled();
    expect(viewOf(reads).status).toBe("invalid");
  });

  it("lands in the error state on a refused save (a stale revision — another tab won) and keeps the edits", async () => {
    mocks.saveContent.mockRejectedValueOnce(
      new Error(
        "This app was changed in another tab or window — reload to get the latest version.",
      ),
    );
    const reads = renderEditor(appOf({ revision: 3 })),
      editor = viewOf(reads);
    act(() => {
      editor.update((prev) => ({ ...prev, datasetIds: ["d1"] }));
    });
    editor.retry();
    await waitFor(() => {
      expect(viewOf(reads).status).toBe("error");
    });
    // The edit survives: a retry re-sends the same content with the same
    // revision (a stale save is refused, never silently dropped).
    expect(viewOf(reads).content.datasetIds).toStrictEqual(["d1"]);
    editor.retry();
    await waitFor(() => {
      expect(mocks.saveContent).toHaveBeenCalledTimes(2);
    });
    expect(saveArgOf(1).expectedRevision).toBe(3);
  });
});
