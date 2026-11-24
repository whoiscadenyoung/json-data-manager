// @vitest-environment jsdom
import type { ViewNode } from "@caden/data-core/views";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColumnsForm } from "./columns-form";

type ColumnsNode = Extract<ViewNode, { kind: "columns" }>;

afterEach(cleanup);

function mount(node: ColumnsNode) {
  const onChange = vi.fn<(next: ViewNode) => void>();
  render(<ColumnsForm fields={["a", "b", "c"]} node={node} onChange={onChange} />);
  return onChange;
}

function last(onChange: ReturnType<typeof mount>): ColumnsNode {
  const call = onChange.mock.calls.at(-1);
  if (call === undefined) throw new Error("onChange was not called");
  return call[0] as ColumnsNode;
}

describe("ColumnsForm only list", () => {
  it("turns on with every edited column, then back off", () => {
    const base: ColumnsNode = { kind: "columns", from: "s", edits: [{ from: "b", exclude: true }] };
    const onChange = mount(base);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(last(onChange).only).toEqual(["a", "c"]);
    cleanup();
    const off = mount({ ...base, only: ["a", "c"] });
    fireEvent.click(screen.getByRole("checkbox"));
    expect("only" in last(off)).toBe(false);
  });

  it("removes and re-adds kept columns", () => {
    const base: ColumnsNode = { kind: "columns", from: "s", edits: [], only: ["a", "b"] };
    const onChange = mount(base);
    fireEvent.click(screen.getByLabelText("Stop keeping a"));
    expect(last(onChange).only).toEqual(["b"]);
    fireEvent.click(screen.getByLabelText("Keep c"));
    expect(last(onChange).only).toEqual(["a", "b", "c"]);
  });
});
