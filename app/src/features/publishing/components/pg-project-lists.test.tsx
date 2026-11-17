// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apps: [] as unknown[],
  canEdit: true,
  maps: [] as unknown[],
  openNewApp: vi.fn<() => void>(),
  openNewMap: vi.fn<() => void>(),
}));

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// Links render as plain anchors.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode; className?: string; to?: string }) =>
      createElement("a", { className: props.className, "data-to": props.to }, props.children),
    useNavigate: () => vi.fn<() => Promise<void>>(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

vi.mock("#/features/views", () => ({ relativeTime: () => "just now" }));

vi.mock("./pg-project-context", () => ({
  useProjectShell: () => ({
    canEdit: mocks.canEdit,
    openNewApp: mocks.openNewApp,
    openNewMap: mocks.openNewMap,
    projectId: "p1",
  }),
}));

vi.mock("@/lib/store/maps", () => ({
  listAllPlacementsQueryOptions: () => ({
    queryFn: () => [
      { id: "pl-1", mapId: "m-parks" },
      { id: "pl-2", mapId: "m-parks" },
      { id: "pl-3", mapId: "m-roads" },
    ],
    queryKey: ["placements"],
  }),
  listForProjectQueryOptions: () => ({ queryFn: () => mocks.maps, queryKey: ["maps"] }),
  remove: vi.fn<() => Promise<void>>(),
  update: vi.fn<() => Promise<number>>(),
}));

vi.mock("@/lib/store/apps", () => ({
  appMapIds: (app: { mapIds: string[] }) => app.mapIds,
  listForProjectQueryOptions: () => ({ queryFn: () => mocks.apps, queryKey: ["apps"] }),
  remove: vi.fn<() => Promise<number>>(),
  toSummary: (app: { pageCount: number; widgetCount: number }) => app,
  updateDetails: vi.fn<() => Promise<number>>(),
}));

vi.mock("@/lib/store/app-versions", () => ({
  headQueryOptions: ({ appId }: { appId: string }) => ({
    queryFn: () => (appId === "a-explorer" ? { versionLabel: "v3" } : null),
    queryKey: ["head", appId],
  }),
}));

import { PgProjectApps, PgProjectMaps, listRows } from "./pg-project-lists";

const MAPS = [
    {
      description: "Every park and trailhead",
      id: "m-parks",
      name: "Parks overview",
      updatedAt: "2026-11-10T00:00:00Z",
      visibility: "link",
    },
    {
      description: null,
      id: "m-roads",
      name: "Road corridors",
      updatedAt: "2026-11-16T00:00:00Z",
      visibility: "members",
    },
  ],
  APPS = [
    {
      description: null,
      id: "a-explorer",
      mapIds: ["m-parks"],
      pageCount: 2,
      title: "Parks explorer",
      updatedAt: "2026-11-12T00:00:00Z",
      visibility: "public",
      widgetCount: 5,
    },
    {
      description: null,
      id: "a-draft",
      mapIds: [],
      pageCount: 1,
      title: "Budget notes",
      updatedAt: "2026-11-15T00:00:00Z",
      visibility: "members",
      widgetCount: 1,
    },
  ];

function renderPage(page: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(page)));
}

beforeEach(() => {
  mocks.canEdit = true;
  mocks.maps = MAPS;
  mocks.apps = APPS;
  mocks.openNewMap.mockReset();
  mocks.openNewApp.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("listRows", () => {
  const rows = [
      { name: "Roads", updatedAt: "2026-11-16" },
      { name: "parks", updatedAt: "2026-11-10" },
    ],
    base = {
      modifiedOf: (row: { updatedAt: string }) => row.updatedAt,
      nameOf: (row: { name: string }) => row.name,
    };

  it("sorts by name without minding case, and by date newest first", () => {
    expect(
      listRows(rows, { ...base, search: "", sort: { descending: false, key: "name" } }).map(
        (row) => row.name,
      ),
    ).toEqual(["parks", "Roads"]);
    expect(
      listRows(rows, { ...base, search: "", sort: { descending: true, key: "modified" } }).map(
        (row) => row.name,
      ),
    ).toEqual(["Roads", "parks"]);
  });

  it("keeps only the names that contain the search", () => {
    expect(
      listRows(rows, { ...base, search: " PAR ", sort: { descending: false, key: "name" } }),
    ).toEqual([rows[1]]);
  });
});

describe("PgProjectMaps", () => {
  it("lists each map with its layers, the apps that show it and who can open it", async () => {
    renderPage(PgProjectMaps);
    expect(await screen.findByText("Parks overview")).toBeTruthy();
    expect(screen.getByText("2 maps")).toBeTruthy();
    expect(screen.getByText("Every park and trailhead")).toBeTruthy();
    expect(await screen.findByText("2 layers")).toBeTruthy();
    expect(screen.getByText("1 layer")).toBeTruthy();
    expect(await screen.findByText("1 app")).toBeTruthy();
    expect(screen.getByText("By link")).toBeTruthy();
    expect(screen.getByText("Members only")).toBeTruthy();
  });

  it("narrows the list as you search, and says when nothing matches", async () => {
    renderPage(PgProjectMaps);
    await screen.findByText("Parks overview");
    fireEvent.change(screen.getByLabelText("Search maps"), { target: { value: "road" } });
    expect(screen.queryByText("Parks overview")).toBeNull();
    expect(screen.getByText("Road corridors")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search maps"), { target: { value: "zzz" } });
    expect(screen.getByText("No maps match this search.")).toBeTruthy();
  });

  it("opens the shell's new-map form from the page button", async () => {
    renderPage(PgProjectMaps);
    await screen.findByText("Parks overview");
    fireEvent.click(screen.getByRole("button", { name: "New map" }));
    expect(mocks.openNewMap).toHaveBeenCalledTimes(1);
  });

  it("explains the empty project and tells a viewer why creating is off", async () => {
    mocks.maps = [];
    mocks.canEdit = false;
    renderPage(PgProjectMaps);
    expect(await screen.findByText("No maps yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New map" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/viewer/i)).toBeTruthy();
  });
});

describe("PgProjectApps", () => {
  it("lists each app with its contents and whether it is published", async () => {
    renderPage(PgProjectApps);
    expect(await screen.findByText("Parks explorer")).toBeTruthy();
    expect(screen.getByText("2 apps")).toBeTruthy();
    expect(screen.getByText("2 pages · 5 widgets")).toBeTruthy();
    expect(screen.getByText("1 page · 1 widget")).toBeTruthy();
    expect(await screen.findByText("v3")).toBeTruthy();
    expect(await screen.findByText("Draft")).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
  });

  it("opens the builder from the app's name", async () => {
    renderPage(PgProjectApps);
    const link = await screen.findByText("Parks explorer");
    expect(link.getAttribute("data-to")).toBe("/projects/$projectId/apps/$appId/edit");
  });
});
