import type { ViewDefinition } from "@caden/data-core/views";
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

const mocks = vi.hoisted(() => ({
  createProjectView: vi.fn<(args: unknown) => Promise<string>>(),
  navigate: vi.fn<(args: unknown) => Promise<void>>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode; className?: string; to?: string }) =>
      createElement("a", { className: props.className, "data-to": props.to }, props.children),
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

const STATES = "11111111-1111-4111-8111-111111111111";
const LINKS = "22222222-2222-4222-8222-222222222222";
const ELSEWHERE = "33333333-3333-4333-8333-333333333333";

// The canvas is React Flow (needs a measured DOM): draw the same graph as plain buttons.
vi.mock("@/features/view-graphs", async () => await import("./test-step-graph"));
vi.mock("../lib/create-view", () => ({ createProjectView: mocks.createProjectView }));
vi.mock("@/lib/store/projects", () => ({
  listCatalogQueryOptions: () => ({
    queryFn: async () => [
      { artifact: { artifactId: STATES, artifactKind: "dataset" } },
      { artifact: { artifactId: LINKS, artifactKind: "dataset" } },
      { artifact: { artifactId: "layer-1", artifactKind: "layer" } },
    ],
    queryKey: ["test:catalog"],
  }),
}));
vi.mock("@/lib/store/datasets", () => ({
  listQueryOptions: () => ({
    queryFn: async () => [
      { entryCount: 51, id: STATES, kind: "source", title: "States" },
      { entryCount: 4, id: LINKS, kind: "view", title: "Links per state" },
      { entryCount: 9, id: ELSEWHERE, kind: "source", title: "Another project's data" },
    ],
    queryKey: ["test:datasets"],
  }),
}));

import { NewViewPage } from "./new-view-page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(NewViewPage, { projectId: "p1" }),
    ),
  );
}

describe("NewViewPage (new view on the canvas)", () => {
  it("says what is missing instead of leaving Create silently disabled", async () => {
    mount();
    await screen.findByLabelText(/States/);
    expect(screen.getByRole("button", { name: "Create view" })).toHaveProperty("disabled", true);
    const reasons = screen.getByTestId("create-reasons").textContent;
    expect(reasons).toMatch(/Give the view a title/);
    expect(reasons).toMatch(/Pick at least one dataset/);
    // The canvas shows where the flow will start.
    expect(within(screen.getByTestId("step-canvas")).getByText("Pick a dataset")).toBeTruthy();
  });

  it("offers the project's datasets and views by title, and filters them by search", async () => {
    mount();
    expect(await screen.findByLabelText(/States/)).toBeTruthy();
    expect(screen.getByLabelText(/Links per state/)).toBeTruthy();
    expect(screen.getByText(/View · 4 rows/)).toBeTruthy();
    // Datasets that are not in this project are not offered as a base.
    expect(screen.queryByLabelText(/Another project's data/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Search datasets and views"), {
      target: { value: "links" },
    });
    expect(screen.queryByLabelText(/^States/)).toBeNull();
    expect(screen.getByLabelText(/Links per state/)).toBeTruthy();
  });

  it("draws the picked base on the canvas, creates the view from it and opens the editor", async () => {
    mocks.createProjectView.mockResolvedValue("v-new");
    mount();
    fireEvent.click(await screen.findByLabelText(/States/));
    expect(within(screen.getByTestId("step-canvas")).getByText("States")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "  States enriched " } });
    const create = screen.getByRole("button", { name: "Create view" });
    expect(create).toHaveProperty("disabled", false);
    expect(screen.queryByTestId("create-reasons")).toBeNull();
    fireEvent.click(create);
    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith({
        params: { projectId: "p1", viewId: "v-new" },
        to: "/projects/$projectId/views/$viewId",
      });
    });
    expect(mocks.createProjectView).toHaveBeenCalledWith({
      definition: {
        base: "states",
        inputs: [{ alias: "states", ref: { id: STATES, kind: "dataset" } }],
        output: { emptyFields: "keep", fields: [] },
        steps: [],
      },
      projectId: "p1",
      title: "States enriched",
    });
  });
});

describe("NewViewPage with several inputs", () => {
  it("creates a view that reads every picked dataset, starting from the first", async () => {
    mocks.createProjectView.mockResolvedValue("v-new");
    mount();
    fireEvent.click(await screen.findByLabelText(/States/));
    fireEvent.click(await screen.findByLabelText(/Links per state/));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Both" } });
    fireEvent.click(screen.getByRole("button", { name: "Create view" }));
    await waitFor(() => {
      expect(mocks.createProjectView).toHaveBeenCalled();
    });
    const call = mocks.createProjectView.mock.calls[0][0] as { definition: ViewDefinition };
    expect(call.definition.inputs).toHaveLength(2);
    expect(call.definition.base).toBe("states");
  });
});
