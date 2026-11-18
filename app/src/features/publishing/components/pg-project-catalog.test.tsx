// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canEdit: true,
  createFolder: vi.fn<(args: unknown) => Promise<unknown>>(),
  folder: undefined as string | undefined,
  moveArtifacts: vi.fn<(args: unknown) => Promise<number>>(),
  moveFolder: vi.fn<(args: unknown) => Promise<number>>(),
  navigate: vi.fn<(args: unknown) => Promise<void>>(),
}));

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// Links render as plain anchors; the open folder comes from the mocked search.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode; className?: string; to?: string }) =>
      createElement("a", { className: props.className, "data-to": props.to }, props.children),
    useNavigate: () => mocks.navigate,
    useSearch: () => ({ folder: mocks.folder }),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

// The surrounding features are not the subject: stub what the browser embeds.
vi.mock("#/features/views", () => ({
  DuplicateViewDialog: () => null,
  relativeTime: () => "just now",
}));
vi.mock("./pg-project-workspace", () => ({
  PgLinkedVersionActions: () => null,
  PgProvenanceChips: () => null,
}));

function membership(id: string, artifactId: string, folderId: string | null) {
  return {
    artifact: {
      addedBy: "u1",
      artifactId,
      artifactKind: "dataset",
      folderId,
      id,
      projectId: "p1",
      role: "owned",
      syncMode: "manual",
    },
    edge: null,
    head: null,
    updateAvailable: false,
  };
}

const CATALOG = [
  membership("m-states", "d-states", null),
  membership("m-awards", "d-awards", "f-fy24"),
  membership("m-summary", "v-summary", "f-fy24"),
];

vi.mock("./pg-project-context", () => ({
  useProjectShell: () => ({
    canEdit: mocks.canEdit,
    catalog: CATALOG,
    invalidateAll: () => {},
    openAdd: () => {},
    projectId: "p1",
  }),
}));

function dataset(id: string, title: string, kind: "source" | "view") {
  return {
    entryCount: 12,
    id,
    isGeospatial: false,
    kind,
    lifecycle: "draft",
    title,
    updatedAt: "2026-11-16T00:00:00Z",
  };
}

vi.mock("@/lib/store/datasets", () => ({
  listQueryOptions: () => ({
    queryFn: () => [
      dataset("d-states", "States", "source"),
      dataset("d-awards", "Awards", "source"),
      dataset("v-summary", "Award summary", "view"),
    ],
    queryKey: ["datasets"],
  }),
}));

vi.mock("@/lib/store/project-folders", () => ({
  createFolder: mocks.createFolder,
  listFoldersQueryOptions: () => ({
    queryFn: () => [
      { id: "f-grants", name: "Grants", parentId: null, updatedAt: "2026-11-16T00:00:00Z" },
      { id: "f-fy24", name: "FY24", parentId: "f-grants", updatedAt: "2026-11-16T00:00:00Z" },
    ],
    queryKey: ["folders"],
  }),
  moveArtifacts: mocks.moveArtifacts,
  moveFolder: mocks.moveFolder,
  removeFolder: vi.fn<() => Promise<number>>(),
  renameFolder: vi.fn<() => Promise<number>>(),
}));

vi.mock("@/lib/store/projects", () => ({
  removeArtifact: vi.fn<() => Promise<{ affected: number }>>(),
}));
vi.mock("@/lib/store/relations", () => ({
  listForDatasetsQueryOptions: () => ({ queryFn: () => [], queryKey: ["relations"] }),
}));
vi.mock("@/lib/store/view-reads", () => ({
  latestRunsQueryOptions: () => ({ queryFn: () => new Map(), queryKey: ["runs"] }),
  listViewSummariesQueryOptions: () => ({
    queryFn: () => [{ id: "v-summary", inputs: [], refreshMode: "manual", stale: true }],
    queryKey: ["views"],
  }),
}));

import { PgProjectCatalog } from "./pg-project-catalog";

function renderCatalog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(PgProjectCatalog)));
}

beforeEach(() => {
  mocks.canEdit = true;
  mocks.folder = undefined;
  mocks.createFolder.mockReset().mockResolvedValue({ id: "f-new" });
  mocks.moveArtifacts.mockReset().mockResolvedValue(1);
  mocks.moveFolder.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  cleanup();
});

describe("PgProjectCatalog (file browser)", () => {
  it("lists the root: folders with their item counts, then the root's own items", async () => {
    renderCatalog();
    expect(await screen.findByText("Grants")).toBeTruthy();
    expect(screen.getByText("2 items")).toBeTruthy();
    expect(screen.getByText("States")).toBeTruthy();
    // Items inside folders stay out of the root listing.
    expect(screen.queryByText("Awards")).toBeNull();
  });

  it("opens a folder from the URL: breadcrumbs, datasets and views together", async () => {
    mocks.folder = "f-fy24";
    renderCatalog();
    expect(await screen.findByText("Awards")).toBeTruthy();
    expect(screen.getByText("Award summary")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    const crumbs = within(screen.getByRole("navigation", { name: "Folder path" }));
    expect(crumbs.getByText("Catalog")).toBeTruthy();
    expect(crumbs.getByText("Grants")).toBeTruthy();
    expect(crumbs.getByText("FY24")).toBeTruthy();
    expect(screen.queryByText("States")).toBeNull();
  });

  it("searches every folder and says where each match lives", async () => {
    renderCatalog();
    await screen.findByText("Grants");
    fireEvent.change(screen.getByLabelText("Search the catalog"), { target: { value: "award" } });
    expect(screen.getByText("Awards")).toBeTruthy();
    expect(screen.getAllByText("in Catalog / Grants / FY24").length).toBe(2);
  });

  it("creates a folder inside the open folder", async () => {
    mocks.folder = "f-grants";
    renderCatalog();
    await screen.findByText("FY24");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "FY25" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => {
      expect(mocks.createFolder).toHaveBeenCalledWith({
        name: "FY25",
        parentId: "f-grants",
        projectId: "p1",
      });
    });
  });

  it("moves the selected item into the folder picked in Move to", async () => {
    renderCatalog();
    await screen.findByText("States");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select States" }));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
    const destinations = within(screen.getByRole("group", { name: "Destination" }));
    fireEvent.click(destinations.getByText("FY24"));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await waitFor(() => {
      expect(mocks.moveArtifacts).toHaveBeenCalledWith({
        folderId: "f-fy24",
        membershipIds: ["m-states"],
      });
    });
    expect(mocks.moveFolder).not.toHaveBeenCalled();
  });

  it("gives a viewer a read-only browser", async () => {
    mocks.canEdit = false;
    renderCatalog();
    await screen.findByText("Grants");
    expect(screen.getByRole("button", { name: "New folder" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });
});
