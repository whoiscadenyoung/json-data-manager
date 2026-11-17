// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));
// The outline only reads dataset titles; the data module's Postgres reads are not the subject.
vi.mock("../data", () => ({
  datasetTitle: (state: { title?: string }) => state.title ?? "Loading…",
  useAppDatasets: () => new Map([["d-states", { status: "ready", title: "States" }]]),
}));

import type { AppContent } from "../lib/content";
import { BuilderOutline } from "./builder-outline";
import type { BuilderSelection } from "./builder-settings";

const CONTENT: AppContent = {
  datasetIds: ["d-states"],
  pages: [
    {
      id: "p1",
      layout: "contained",
      title: "Overview",
      widgets: [
        { body: "", h: 2, id: "w-text", kind: "text", title: "Intro", w: 12 },
        { aggregate: "count", datasetId: "d-states", h: 2, id: "w-stat", kind: "stat", w: 3 },
      ],
    },
    { id: "p2", layout: "fullscreen", title: "Map", widgets: [] },
  ],
};

function renderOutline(selection?: BuilderSelection) {
  const props = {
    content: CONTENT,
    onAddPage: vi.fn<() => void>(),
    onSelectData: vi.fn<() => void>(),
    onSelectPage: vi.fn<(id: string) => void>(),
    onSelectWidget: vi.fn<(pageId: string, widgetId: string) => void>(),
    pageId: "p1",
    selection,
  };
  render(createElement(BuilderOutline, props));
  return props;
}

afterEach(() => {
  cleanup();
});

describe("BuilderOutline", () => {
  it("lists pages with their widgets, naming untitled widgets by kind", () => {
    renderOutline();
    expect(screen.getByText("Pages (2)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "Intro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Number" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Map (full screen)" })).toBeTruthy();
    expect(screen.getByText("Data (1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "States" })).toBeTruthy();
  });

  it("selects a page, a widget on its page, or the data", () => {
    const props = renderOutline();
    fireEvent.click(screen.getByRole("button", { name: "Map (full screen)" }));
    expect(props.onSelectPage).toHaveBeenCalledWith("p2");
    fireEvent.click(screen.getByRole("button", { name: "Number" }));
    expect(props.onSelectWidget).toHaveBeenCalledWith("p1", "w-stat");
    fireEvent.click(screen.getByRole("button", { name: "Manage datasets" }));
    expect(props.onSelectData).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    expect(props.onAddPage).toHaveBeenCalledTimes(1);
  });

  it("marks the selected widget", () => {
    renderOutline({ kind: "widget", widgetId: "w-text" });
    expect(screen.getByRole("button", { name: "Intro" }).getAttribute("data-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("data-selected")).toBe(
      "false",
    );
  });
});
