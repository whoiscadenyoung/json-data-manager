// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

const navigate = vi.fn<(args: unknown) => Promise<void>>();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigate };
});

// CodeMirror is client-only and not the subject: a textarea stands in.
vi.mock("@caden/ui/components/sql-editor", () => ({
  SqlEditor: (props: { ariaLabel?: string; onChange: (v: string) => void; value: string }) =>
    createElement("textarea", {
      "aria-label": props.ariaLabel,
      onChange: (event: { target: { value: string } }) => {
        props.onChange(event.target.value);
      },
      value: props.value,
    }),
}));

const scratchQuery = vi.fn<(projectId: string, sql?: string) => Promise<unknown>>();
const runView = vi.fn<(viewId: string) => Promise<unknown>>();
vi.mock("@/lib/store/views", () => ({
  scratchQuery: async (projectId: string, sql?: string) => await scratchQuery(projectId, sql),
  runView: async (viewId: string) => await runView(viewId),
}));

const createProjectView = vi.fn<(args: unknown) => Promise<string>>();
vi.mock("#/features/views", async () => {
  const actual = await vi.importActual<typeof import("../../views/lib/view-model")>(
    "../../views/lib/view-model",
  );
  return {
    definitionFromScratch: actual.definitionFromScratch,
    referencedScratchTables: actual.referencedScratchTables,
    createProjectView: async (args: unknown) => await createProjectView(args),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn<(m: string) => void>(), success: vi.fn<(m: string) => void>() },
}));

import { PgScratchPage } from "./pg-scratch-page";

const STATES = "11111111-1111-4111-8111-111111111111";
const tables = [
  {
    alias: "states",
    datasetId: STATES,
    fields: ["id", "name"],
    kind: "source",
    name: "in_states",
    title: "States",
  },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PgScratchPage, { projectId: "p1" }),
    ),
  );
}

beforeEach(() => {
  scratchQuery.mockImplementation(async (_project, sql) => {
    if (sql === undefined) return { tables };
    if (sql.includes("boom")) {
      return {
        tables,
        outcome: {
          ok: false,
          error: 'relation "boom" does not exist',
          code: "42P01",
          elapsedMs: 3,
        },
      };
    }
    return {
      tables,
      outcome: {
        ok: true,
        columns: ["name", "n"],
        rows: [{ name: "Alpha", n: 2 }],
        rowCount: 1,
        truncated: false,
        elapsedMs: 12,
      },
    };
  });
  createProjectView.mockResolvedValue("view-1");
  runView.mockResolvedValue({ status: "ok", runId: "r", rowCount: 1, diagnostics: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PgScratchPage", () => {
  it("says it is unsaved and lists the tables with their fields", async () => {
    renderPage();
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(await screen.findByText("in_states")).toBeTruthy();
    expect(screen.getByText("id, name")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /save as view/i }).disabled).toBe(
      true,
    );
  });

  it("runs the query on the server and shows rows, count and timing", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Scratch SQL"), {
      target: { value: "select 'Alpha' as name, 2 as n from in_states" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("1 row")).toBeTruthy();
    expect(screen.getByText("12 ms")).toBeTruthy();
    expect(scratchQuery).toHaveBeenLastCalledWith(
      "p1",
      "select 'Alpha' as name, 2 as n from in_states",
    );
  });

  it("shows the Postgres message when the query fails", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Scratch SQL"), {
      target: { value: "select * from boom" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      'relation "boom" does not exist',
    );
  });

  it("saves as a view: one sql step, the query unchanged, input aliased from the table name", async () => {
    renderPage();
    await screen.findByText("in_states");
    const sql = "select count(*) as n from in_states;";
    fireEvent.change(screen.getByLabelText("Scratch SQL"), { target: { value: sql } });
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: /save as view/i }));
    fireEvent.change(await screen.findByLabelText(/title/i), { target: { value: "State count" } });
    fireEvent.click(screen.getByRole("button", { name: /^save view$/i }));
    await waitFor(() => {
      expect(createProjectView).toHaveBeenCalled();
    });
    expect(createProjectView).toHaveBeenCalledWith({
      definition: {
        base: "states",
        inputs: [{ alias: "states", ref: { kind: "dataset", id: STATES } }],
        output: { fields: [], emptyFields: "keep" },
        steps: [{ kind: "sql", query: "select count(*) as n from in_states" }],
      },
      projectId: "p1",
      title: "State count",
    });
    await waitFor(() => {
      expect(runView).toHaveBeenCalledWith("view-1");
      expect(navigate).toHaveBeenCalledWith({
        params: { projectId: "p1", viewId: "view-1" },
        to: "/projects/$projectId/views/$viewId",
      });
    });
  });
});
