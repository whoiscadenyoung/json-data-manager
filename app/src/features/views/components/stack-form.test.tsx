// @vitest-environment jsdom
import type { ViewDefinition, ViewNode } from "@caden/data-core/views";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeEditorContext } from "./node-context";
import { StackForm } from "./stack-form";

type StackNode = Extract<ViewNode, { kind: "stack" }>;

afterEach(cleanup);

const infos = [
  { alias: "fy22", datasetId: "a", title: "FY22", fields: ["name", "amount"] },
  { alias: "fy23", datasetId: "b", title: "FY23", fields: ["name", "Amount", "extra"] },
];
const definition: ViewDefinition = {
  nodes: {
    fy22: { kind: "source", ref: { kind: "dataset", id: "a" } },
    fy23: { kind: "source", ref: { kind: "dataset", id: "b" } },
    stacked: { kind: "stack", inputs: [{ node: "fy22" }, { node: "fy23" }] },
  },
  result: { node: "stacked", output: { fields: [], emptyFields: "keep" } },
};
const ctx: NodeEditorContext = {
  definition,
  diagnostics: undefined,
  errors: [],
  fields: new Map([
    ["fy22", ["name", "amount"]],
    ["fy23", ["name", "Amount", "extra"]],
  ]),
  infos,
};
const node: StackNode = { kind: "stack", inputs: [{ node: "fy22" }, { node: "fy23" }] };

function renderForm(onChange = vi.fn<(node: ViewNode) => void>()) {
  render(<StackForm ctx={ctx} id="stacked" node={node} onChange={onChange} />);
  return onChange;
}

function lastNode(onChange: ReturnType<typeof renderForm>): StackNode {
  const call = onChange.mock.calls.at(-1);
  if (call === undefined) throw new Error("onChange was not called");
  return call[0] as StackNode;
}

describe("StackForm columns", () => {
  it("shows merged and partial columns", () => {
    renderForm();
    expect(screen.getByText("Merged")).toBeTruthy();
    expect(screen.getAllByText("Only in FY23").length).toBeGreaterThan(0);
  });

  it("offers a merge chip and applies it to the input that has the other spelling", () => {
    const onChange = renderForm();
    fireEvent.click(screen.getByText(/Merge “Amount” into “amount”/));
    expect(lastNode(onChange).inputs[1].columns).toEqual([{ from: "Amount", as: "amount" }]);
  });

  it("renames a column in every input that feeds it", () => {
    const onChange = renderForm();
    const input = screen.getByLabelText("Rename column name");
    fireEvent.change(input, { target: { value: "title" } });
    fireEvent.blur(input);
    const next = lastNode(onChange);
    expect(next.inputs[0].columns).toEqual([{ from: "name", as: "title" }]);
    expect(next.inputs[1].columns).toEqual([{ from: "name", as: "title" }]);
  });

  it("excludes a field", () => {
    const onChange = renderForm();
    fireEvent.click(screen.getByLabelText("Exclude extra from FY23"));
    expect(lastNode(onChange).inputs[1].columns).toEqual([{ from: "extra", exclude: true }]);
  });

  it("tags each input and adds or removes inputs", () => {
    const onChange = renderForm();
    fireEvent.change(screen.getByLabelText("Tag for stacked node 2"), {
      target: { value: "2023" },
    });
    expect(lastNode(onChange).inputs[1].tag).toBe(2023);
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    expect(lastNode(onChange).inputs).toHaveLength(3);
    fireEvent.click(screen.getByLabelText("Remove stacked node 1"));
    expect(lastNode(onChange).inputs).toHaveLength(1);
  });
});
