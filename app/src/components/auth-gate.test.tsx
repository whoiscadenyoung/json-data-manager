// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The session seam: a switchable signed-out/signed-in/resolving state,
// reference-stable per render pass (the app-vitest-config rule).
const sessionState = vi.hoisted(() => ({
  isLoading: false,
  session: null as { user: { id: string } } | null,
}));
vi.mock("#/integrations/supabase/provider", () => ({
  useSession: () => ({ isLoading: sessionState.isLoading, session: sessionState.session }),
}));

// The router seam: the gate's redirect and location read, captured.
const routerState = vi.hoisted(() => ({
  navigateCalls: [] as Array<Record<string, unknown>>,
  pathname: "/",
}));
vi.mock("@tanstack/react-router", () => ({
  Navigate: (props: Record<string, unknown>) => {
    routerState.navigateCalls.push(props);
    return null;
  },
  useLocation: () => ({
    href: `http://localhost:3000${routerState.pathname}`,
    pathname: routerState.pathname,
  }),
}));

import { AuthGate, isPublicServingPathname } from "./auth-gate";

afterEach(() => {
  cleanup();
  routerState.navigateCalls.length = 0;
  routerState.pathname = "/";
});

describe("isPublicServingPathname (#261)", () => {
  it("matches exactly the published-app view, nothing deeper or wider", () => {
    expect(isPublicServingPathname("/apps/aaaaaaa1-0000-4000-8000-000000000001")).toBe(true);
    expect(isPublicServingPathname("/apps/aaaaaaa1-0000-4000-8000-000000000001/edit")).toBe(false);
    expect(isPublicServingPathname("/apps/aaaaaaa1-0000-4000-8000-000000000001/preview")).toBe(
      false,
    );
    expect(isPublicServingPathname("/apps")).toBe(false);
    expect(isPublicServingPathname("/apps/")).toBe(false);
    expect(isPublicServingPathname("/datasets/aaaaaaa1-0000-4000-8000-000000000001")).toBe(false);
    expect(isPublicServingPathname("/signin")).toBe(false);
  });
});

/** The first recorded redirect, or a loud failure (the no-optional-chaining test style). */
function firstRedirect(): Record<string, unknown> {
  const call = routerState.navigateCalls[0];
  if (call === undefined) {
    throw new Error("the gate never navigated");
  }
  return call;
}

describe("AuthGate (#261 anon serving)", () => {
  it("holds the resolving spinner before children mount (SSR and first resolve)", () => {
    sessionState.isLoading = true;
    sessionState.session = null;
    render(createElement(AuthGate, null, createElement("div", null, "served")));
    expect(screen.queryByTestId("children")).toBeNull();
    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("redirects a signed-out visitor away from a non-public route", () => {
    sessionState.isLoading = false;
    sessionState.session = null;
    routerState.pathname = "/datasets/aaaaaaa1-0000-4000-8000-000000000001";
    render(createElement(AuthGate, null, createElement("div", null, "served")));
    expect(screen.queryByTestId("children")).toBeNull();
    expect(firstRedirect().to).toBe("/signin");
  });

  it("serves the public route to a signed-out visitor — the route's anon branch owns the view", () => {
    sessionState.isLoading = false;
    sessionState.session = null;
    routerState.pathname = "/apps/aaaaaaa1-0000-4000-8000-000000000001";
    render(createElement(AuthGate, null, createElement("div", { "data-testid": "children" })));
    expect(screen.queryByTestId("children")).not.toBeNull();
    expect(routerState.navigateCalls.length).toBe(0);
  });

  it("serves signed-in visitors everywhere", () => {
    sessionState.isLoading = false;
    sessionState.session = { user: { id: "creator-1" } };
    routerState.pathname = "/datasets/aaaaaaa1-0000-4000-8000-000000000001";
    render(createElement(AuthGate, null, createElement("div", { "data-testid": "children" })));
    expect(screen.queryByTestId("children")).not.toBeNull();
    expect(routerState.navigateCalls.length).toBe(0);
  });
});
