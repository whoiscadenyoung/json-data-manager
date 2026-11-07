// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The import chain reaches `#/env` through the integrations client (which
// validates at import time); CI has no .env.local — the stage-3 lesson.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// The session seam: the anon visitor (null session, resolved gate).
const sessionState = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
}));
vi.mock("#/integrations/supabase/provider", () => ({
  useSession: () => ({ isLoading: false, session: sessionState.session }),
}));

// The store seams: the apps row read is DISABLED for anon (the 0023 model —
// no anon policies on live tables); the head app_version read is the view's
// primary. Reference-stable states per render pass (the app-vitest-config rule).
const storeState = vi.hoisted(() => ({
  headRow: null as Record<string, unknown> | null,
}));
vi.mock("#/lib/store/app-versions", () => ({
  headQueryOptions: (args: { appId: string }) => ({
    queryFn: async () => await Promise.resolve(storeState.headRow),
    queryKey: ["pg:appVersions", "head", args],
  }),
}));
vi.mock("#/lib/store/apps", () => ({
  getQueryOptions: (args: { appId: string }) => ({
    queryFn: async () => await Promise.resolve(null),
    queryKey: ["pg:apps", "get", args],
  }),
}));
vi.mock("#/lib/store/project-members", () => ({
  listMineQueryOptions: (args: { userId: string }) => ({
    queryFn: async () => await Promise.resolve([]),
    queryKey: ["pg:project-members", "mine", args],
  }),
  resolveMyRole: () => null,
}));

// The router seam: the denial card's sign-in CTA renders as a plain button
// (no router context under jsdom).
vi.mock("#/components/router-button", () => ({
  RouterButton: (props: { children: string }) =>
    createElement("button", { type: "button" }, props.children),
}));

import { AppViewPage } from "./app-view-page";

const APP_ID = "aaaaaaa1-0000-4000-8000-000000000001";

// The published view's top bar mounts ThemeToggle, which reads the color-
// scheme query jsdom does not implement (the standard jsdom stub).
const noop = () => undefined;
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      addEventListener: noop,
      addListener: noop,
      dispatchEvent: noop,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: noop,
      removeListener: noop,
    }),
    writable: true,
  });
});

/** One frozen head row with an empty first page (no widgets — the light render). */
function headRowOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: APP_ID,
    createdAt: "2026-11-06T00:00:00.000Z",
    definition: {
      datasetPins: [],
      description: "A public tourism explorer",
      layerVersions: [],
      mapSnapshots: [],
      pages: [],
      title: "Tourism Explorer",
    },
    id: "version-1",
    versionLabel: "v1",
    ...overrides,
  };
}

function renderView(): ReactNode {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(AppViewPage, {
      appId: APP_ID,
      mode: "published",
      onPageChange: () => undefined,
      pageId: undefined,
    }),
  );
}

afterEach(() => {
  cleanup();
  storeState.headRow = null;
  sessionState.session = null;
});

describe("AppViewPage anon branch (#261)", () => {
  it("renders the denial card when the head version reads null (non-existent, members, or signed-in app — the RLS-honest denial)", async () => {
    storeState.headRow = null;
    render(renderView());
    expect(await screen.findByText("Not available while signed out")).not.toBeNull();
    expect(screen.getByText("Sign in")).not.toBeNull();
    // The live app's title never leaks through the denial.
    expect(screen.queryByText("Tourism Explorer")).toBeNull();
  });

  it("renders the frozen snapshot for a link/public app — title, published badge, no edit menu", async () => {
    storeState.headRow = headRowOf();
    render(renderView());
    expect(await screen.findByText("Tourism Explorer")).not.toBeNull();
    expect(screen.getByText("Published v1")).not.toBeNull();
    // The overflow menu needs a session (copy/copy-as/edit actions) — the
    // anon view renders none.
    expect(screen.queryByLabelText("App options")).toBeNull();
  });
});
