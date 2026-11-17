// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode }) => createElement("a", {}, props.children),
  };
});
vi.mock("#/lib/store/datasets", () => ({
  listSummariesQueryOptions: () => ({ queryFn: async () => [], queryKey: ["summaries"] }),
}));
vi.mock("../data", () => ({
  datasetTitle: () => "States",
  useAppDatasets: () => new Map(),
}));
// The kind-specific settings are each widget's own; the panel around them is the subject.
vi.mock("../widgets/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../widgets/registry")>();
  return { ...actual, WidgetSettings: () => createElement("div", {}, "Kind settings") };
});

import type { AppContent } from "../lib/content";
import { BuilderSettings, type BuilderSelection } from "./builder-settings";

const CONTENT: AppContent = {
  datasetIds: [],
  pages: [
    {
      id: "p1",
      layout: "contained",
      title: "Overview",
      widgets: [{ body: "", h: 2, id: "w-text", kind: "text", w: 12 }],
    },
  ],
};

function renderSettings(selection: BuilderSelection) {
  const props = {
    content: CONTENT,
    onClose: vi.fn<() => void>(),
    onSelectPage: vi.fn<(id: string) => void>(),
    onUpdate: vi.fn<(change: (prev: AppContent) => AppContent) => void>(),
    page: CONTENT.pages[0],
    projectId: "proj",
    selection,
  };
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(BuilderSettings, props),
    ),
  );
  return props;
}

/** Applies the last content change the panel asked for. */
function lastChange(onUpdate: ReturnType<typeof renderSettings>["onUpdate"]): AppContent {
  const call = onUpdate.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error("no update");
  }
  return call[0](CONTENT);
}

afterEach(() => {
  cleanup();
});

describe("BuilderSettings", () => {
  it("edits the selected widget's title, named by its kind until it has one", () => {
    const props = renderSettings({ kind: "widget", widgetId: "w-text" });
    expect(screen.getByRole("heading", { name: "Text" })).toBeTruthy();
    expect(screen.getByText("Kind settings")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Intro" } });
    expect(lastChange(props.onUpdate).pages[0].widgets[0].title).toBe("Intro");
  });

  it("renames the page and closes from the header", () => {
    const props = renderSettings({ kind: "page" });
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Summary" } });
    expect(lastChange(props.onUpdate).pages[0].title).toBe("Summary");
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the app's datasets", () => {
    renderSettings({ kind: "data" });
    expect(screen.getByRole("heading", { name: "Data" })).toBeTruthy();
    expect(screen.getByText("No datasets yet")).toBeTruthy();
  });

  it("shows nothing for a widget that is gone", () => {
    renderSettings({ kind: "widget", widgetId: "w-missing" });
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
