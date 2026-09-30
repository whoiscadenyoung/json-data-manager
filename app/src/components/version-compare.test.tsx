// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The compare body mounts the overlay map, whose import chain reaches
// maplibre's vite-specific worker imports — irrelevant to this pure notice,
// so the map leg is stubbed out and never loads.
vi.mock("#/components/diff-overlay-map", () => ({ DiffOverlayMap: () => null }));

import { DeltaTruncationNotice } from "./version-compare";

afterEach(() => {
  cleanup();
});

describe("DeltaTruncationNotice (#126)", () => {
  it("says the counts cover the first 2,000 rows when a delta is truncated", () => {
    render(<DeltaTruncationNotice truncated={true} />);
    expect(screen.getByText(/2,000-row diff budget/)).toBeTruthy();
    expect(screen.getByText(/first\s+2,000 rows of each side/)).toBeTruthy();
  });

  it("renders nothing for an exact delta", () => {
    const { container } = render(<DeltaTruncationNotice truncated={false} />);
    expect(container.childElementCount).toBe(0);
  });
});
