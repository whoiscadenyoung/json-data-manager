// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// publish.ts → dataset-rows.ts → env.ts, and env.ts validates on import —
// CI has no .env.local (the stage-3 CI lesson), so the env module is mocked
// before the import graph loads.
vi.mock("#/env", () => ({ env: { VITE_CONVEX_URL: "http://127.0.0.1:3212" } }));

import { resumePlan } from "./publish";

/**
 * The orchestrator's resume decision (roadmap 5b AC 4) — the exact logic
 * review found the resume-index bug in, pinned branch by branch. The
 * orchestrator itself drives the host mutations over a live ConvexClient,
 * which the test backend cannot serve; `resumePlan` is where its resume
 * guarantee is decided, so this is where the guarantee is pinned.
 */
describe("resumePlan — the publish resume decision", () => {
  it("a fresh attempt (no plan) uploads from zero without a reset", () => {
    expect(resumePlan(undefined, 0, 4)).toStrictEqual({ from: 0, reset: false });
  });

  it("a normal resume skips exactly the registered prefix", () => {
    expect(resumePlan(5, 3, 5)).toStrictEqual({ from: 3, reset: false });
    expect(resumePlan(5, 0, 5)).toStrictEqual({ from: 0, reset: false });
    expect(resumePlan(5, 5, 5)).toStrictEqual({ from: 5, reset: false });
  });

  it("a changed chunk count resets and re-uploads from zero (the review's bug: it resumed at the stale index)", () => {
    // The traced regression: plan 5 / registered 3 / re-executed 4 must NOT
    // resume at 3 — that uploads only the new chunk 3, the freeze refuses
    // (1 ≠ 4), and the next retry re-uploads overlapping ranges into the
    // append-only list (chunk 3 twice, chunks 0-2 lost).
    expect(resumePlan(5, 3, 4)).toStrictEqual({ from: 0, reset: true });
    expect(resumePlan(4, 2, 5)).toStrictEqual({ from: 0, reset: true });
  });

  it("registrations above the plan reset too — the wedge the freeze guard otherwise refuses forever", () => {
    // A racing/replayed registration pushed the list past its plan; the plan
    // matches the re-execution, so only the registered>planned comparison
    // can see the inconsistency.
    expect(resumePlan(4, 7, 4)).toStrictEqual({ from: 0, reset: true });
  });
});
