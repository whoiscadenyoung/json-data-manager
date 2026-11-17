// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppSummary } from "#/lib/store/apps";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode }) => createElement("a", {}, props.children),
    useNavigate: () => vi.fn<() => Promise<void>>(),
  };
});
// The store's rows pass straight through `toSummary`; its Postgres reads are not the subject.
vi.mock("#/lib/store/apps", () => ({
  listVisibleQueryOptions: () => ({
    queryFn: async () => [
      summary({ id: "a1", title: "Safe streets", visibility: "public" }),
      summary({ example: true, id: "a2", project: null, title: "Example explorer" }),
    ],
    queryKey: ["apps"],
  }),
  toSummary: (row: AppSummary) => row,
}));
vi.mock("../components/app-details-dialog", () => ({
  AppDetailsDialog: () => createElement("div", { role: "dialog" }, "New app dialog"),
}));

import { appMeta, AppsPage } from "./apps-page";

function summary(overrides: Partial<AppSummary>): AppSummary {
  return {
    datasetCount: 1,
    description: null,
    example: false,
    id: "a",
    pageCount: 2,
    project: { createdBy: "u1", id: "p1", title: "Field work" },
    title: "App",
    updatedAt: "2026-11-01T00:00:00.000Z",
    visibility: "members",
    widgetCount: 3,
    ...overrides,
  };
}

function renderPage() {
  render(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AppsPage)),
  );
}

afterEach(() => {
  cleanup();
});

describe("appMeta", () => {
  it("counts what the app holds and when it changed, except for examples", () => {
    expect(appMeta(summary({}))).toMatch(/^2 pages · 3 widgets · 1 dataset · Updated /);
    expect(appMeta(summary({ example: true, pageCount: 1 }))).toBe(
      "1 page · 3 widgets · 1 dataset",
    );
  });
});

describe("AppsPage", () => {
  it("lists apps with who can open them and their project, and filters by search", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Safe streets" })).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByText("Field work")).toBeTruthy();
    expect(screen.getByText("Example")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "field" } });
    expect(screen.queryByRole("heading", { name: "Example explorer" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "zzz" } });
    expect(screen.getByText("No apps match “zzz”.")).toBeTruthy();
  });

  it("opens the new-app dialog from the header", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New app" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
