// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The browser's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// The cards render TanStack Router Links, which need a router context this
// test doesn't build — the Link renders as a plain anchor and navigate is a
// recorded stub (the routing behavior isn't the subject here).
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode; params?: unknown; to?: string }) => {
      return createElement("a", { "data-to": props.to }, props.children);
    },
    useNavigate: () => async (args: unknown) => {
      navigateMock(args);
    },
  };
});

// The session seam: a fixed signed-in caller (tests override the state
// handle for the signed-out case). Reference-stable per render pass.
const sessionState = vi.hoisted(() => ({
  session: { user: { id: "creator-1" } } as { user: { id: string } } | null,
}));
vi.mock("@/integrations/supabase/provider", () => ({
  useSession: () => ({ isLoading: false, session: sessionState.session }),
}));

// The projects seam is the mock boundary: reads answer REFERENCE-STABLE
// fixtures behind a swappable state handle, the create write is a spy.
const state = vi.hoisted(() => ({
  createProject: vi.fn<(args: { description?: string; title: string }) => Promise<string>>(),
  navigateCalls: [] as Array<unknown>,
  projects: [] as import("#/lib/store/projects").ProjectRow[],
  projectsKey: "test:projects",
}));
const navigateMock = (args: unknown): void => {
  state.navigateCalls.push(args);
};
vi.mock("#/lib/store/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/store/projects")>();
  return {
    ...actual,
    create: state.createProject,
    listQueryOptions: () => ({
      queryFn: async () => state.projects,
      queryKey: [state.projectsKey],
    }),
  };
});

import { PgProjectsBrowser } from "./pg-projects-browser";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.projects = [];
  state.projectsKey = "test:projects";
  sessionState.session = { user: { id: "creator-1" } };
});

function renderBrowser(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(PgProjectsBrowser)));
}

describe("PgProjectsBrowser", () => {
  it("hides itself while signed out — the Convex section's gate is the page's only visible surface", async () => {
    sessionState.session = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      createElement(QueryClientProvider, { client }, createElement(PgProjectsBrowser)),
    );
    await waitFor(() => {
      expect(container.childElementCount).toBe(0);
    });
  });

  it("shows the empty state before the first Postgres project", async () => {
    renderBrowser();
    await waitFor(() => {
      expect(screen.getByText("No Postgres projects yet")).toBeTruthy();
    });
  });

  it("lists the caller's Postgres projects with the store badge and artifact count", async () => {
    state.projects = [
      {
        artifactCount: 3,
        createdAt: "2026-11-04T00:00:00+00:00",
        visibility: "members",
        createdBy: "creator-1",
        description: "One year of SMART data.",
        id: "project-1",
        title: "SMART 2024",
        updatedAt: "2026-11-04T00:00:00+00:00",
      },
    ];
    renderBrowser();
    await waitFor(() => {
      expect(screen.getByText("SMART 2024")).toBeTruthy();
    });
    expect(screen.getByText("Postgres")).toBeTruthy();
    expect(screen.getByText("3 artifacts")).toBeTruthy();
  });
});
