// @vitest-environment jsdom
import { cleanup, fireEvent, render, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TransformEditor } from "./transform-editor";

// The autosave race (issue #135, defect 2), mocked at the module boundaries:
// convex/react's `useMutation` is the save seam, @tanstack/react-query's
// `useQuery` feeds the stored registry row (whose spec already holds one
// COMPLETE lookup step, so any non-empty title arms the autosave) and the
// catalog summaries. The TransformPreview stub keeps the test hermetic — the
// race lives in the editor's autosave effect, not the preview.
const mocks = vi.hoisted(() => ({
  useMutation: vi.fn<(reference: unknown) => unknown>(),
  // The editor's queries all ride convexQuery's `{ reference, args }` shape;
  // the stub routes by `args`.
  useQuery: vi.fn<(options: { args: unknown }) => unknown>(),
}));

vi.mock("convex/react", () => ({ useMutation: mocks.useMutation }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQuery: mocks.useQuery,
}));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (reference: unknown, args: unknown) => ({ args, reference }),
}));
vi.mock("./transform-preview", () => ({
  TransformPreview: () => <div data-testid="transform-preview-stub" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** A stored registry row whose spec's one lookup step is complete (the autosave gate's `completedCount > 0`). */
function savedDoc() {
  return {
    _creationTime: 0,
    _id: "row-1",
    dependsOn: ["schema-1", "lookup-1"],
    description: undefined,
    sourceDatasetId: "schema-1",
    spec: {
      operations: [
        {
          kind: "lookup",
          baseKey: "grantId",
          lookupDatasetId: "lookup-1",
          lookupKey: "id",
        },
      ],
      sourceDatasetId: "schema-1",
    },
    status: "saved",
    title: "Enriched sites",
  };
}

/** The summaries row the builder's candidate list resolves the picked dataset through. */
function candidate() {
  return { _creationTime: 0, _id: "lookup-1", title: "Lookups" };
}

/** Routes the editor's queries by args shape (the api proxy is a fresh object per access, so identity can't discriminate): the stored row rides `{id}`, the catalog list rides `{limit}`, and a picked dataset's point read (`{schemaId}`) gets a minimal schema doc for the column pickers. */
function stubQueries(doc: unknown) {
  mocks.useQuery.mockImplementation((options: { args: unknown }) => {
    const record =
      typeof options.args === "object" && options.args !== null
        ? (options.args as { id?: string; limit?: number; schemaId?: string })
        : undefined;
    if (record === undefined) {
      return { data: undefined };
    }
    if (record.id !== undefined) {
      return { data: doc };
    }
    if (record.schemaId !== undefined) {
      return {
        data: {
          _creationTime: 0,
          _id: record.schemaId,
          schema: { properties: {} },
          title: "Lookups",
        },
      };
    }
    return { data: [candidate()] };
  });
}

/** A save mutation whose calls settle under test control, in order. */
function controlledSave() {
  const resolvers: Array<(id: string) => void> = [],
    // Recorded call payloads (the mutation's single argument each) — kept
    // alongside the mock so assertions can index them by call order.
    calls: unknown[] = [];
  const save = vi.fn<(...args: unknown[]) => Promise<string>>(async (...args: unknown[]) => {
    calls.push(args[0]);
    return new Promise<string>((resolve) => {
      resolvers.push(resolve);
    });
  });
  return {
    calls,
    resolveNext: (id: string) => {
      const resolve = resolvers.shift();
      if (resolve === undefined) {
        throw new Error("no pending save call to resolve");
      }
      resolve(id);
    },
    save,
  };
}

/** The editor calls `useMutation` save-first on every render (then remove), so odd calls are the save — the api proxy is a fresh object per access, so the calls route by order. */
function stubMutations(save: ReturnType<typeof controlledSave>["save"]) {
  let mutationCalls = 0;
  mocks.useMutation.mockImplementation(() => {
    mutationCalls += 1;
    return mutationCalls % 2 === 1 ? save : vi.fn<() => undefined>();
  });
}

function renderEditor() {
  return render(
    <TransformEditor
      columns={["grantId"]}
      datasetTitle="Sites"
      docId="row-1"
      onClose={() => {}}
      schemaId="schema-1"
    />,
  );
}

function typeTitle(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>("#transform-title");
  if (input === null) {
    throw new Error("the transform title input is not rendered");
  }
  fireEvent.change(input, { target: { value } });
}

describe("TransformEditor autosave race (issue #135)", () => {
  it("an edit made while a save is in flight survives it: dirty stays armed, the follow-up save patches the same row with the newer content", async () => {
    vi.useFakeTimers();
    stubQueries(savedDoc());
    const { calls, save, resolveNext } = controlledSave();
    stubMutations(save);
    const { container } = renderEditor();

    // Arm the autosave: an edit on top of the stored row.
    typeTitle(container, "V1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ id: "row-1", title: "V1" });

    // Edit while the first save is still in flight.
    typeTitle(container, "V2");
    resolveNext("row-1");
    await act(async () => {
      await Promise.resolve();
    });

    // The stale save must NOT have cleared `dirty` — the edit re-arms the
    // debounce, and the follow-up save carries the newer title on the SAME
    // row id (never a duplicate draft, never a dropped edit).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1]).toMatchObject({ id: "row-1", title: "V2" });

    resolveNext("row-1");
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("closing inside the 800 ms debounce window flushes the edit instead of dropping it", async () => {
    vi.useFakeTimers();
    stubQueries(savedDoc());
    const { calls, save, resolveNext } = controlledSave();
    stubMutations(save);
    const { container, unmount } = render(
      <TransformEditor
        columns={["grantId"]}
        datasetTitle="Sites"
        docId="row-1"
        onClose={() => {}}
        schemaId="schema-1"
      />,
    );

    typeTitle(container, "Unsaved title");
    // Only part of the debounce window elapses before the editor closes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(save).not.toHaveBeenCalled();

    unmount();
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ id: "row-1", title: "Unsaved title" });
    resolveNext("row-1");
    await act(async () => {
      await Promise.resolve();
    });
  });
});
