// @vitest-environment jsdom
import type { ViewDefinition } from "@caden/data-core/views";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutputCard } from "./output-card";

afterEach(cleanup);

const FIELDS = ["name", "deployments", "docsLink"];

function definition(output: ViewDefinition["output"]): ViewDefinition {
  return {
    inputs: [{ alias: "states", ref: { kind: "dataset", id: "d1" } }],
    base: "states",
    steps: [],
    output,
  };
}

function mount(output: ViewDefinition["output"]) {
  const onChange = vi.fn<(next: ViewDefinition) => void>();
  render(
    <OutputCard
      draft={definition(output)}
      expanded
      fields={FIELDS}
      onChange={onChange}
      onSelect={() => undefined}
    />,
  );
  return onChange;
}

function lastOutput(onChange: ReturnType<typeof mount>): ViewDefinition["output"] {
  const call = onChange.mock.calls.at(-1);
  if (call === undefined) throw new Error("onChange was not called");
  return call[0].output;
}

describe("OutputCard", () => {
  it("shows the original name next to a renamed key", () => {
    mount({
      fields: [{ key: "deploys", from: "deployments", label: "Deploys" }, { key: "name" }],
      emptyFields: "keep",
    });
    expect(screen.getByText("deployments → deploys")).toBeTruthy();
  });

  it("typing a new key writes `from` so the rename is explicit", () => {
    const onChange = mount({ fields: [], emptyFields: "keep" });
    fireEvent.change(screen.getByLabelText("Key for deployments"), {
      target: { value: "deploys" },
    });
    expect(lastOutput(onChange).fields).toContainEqual({ key: "deploys", from: "deployments" });
  });

  it("warns when a key is not a valid ArcGIS field name, and for duplicates", () => {
    mount({
      fields: [
        { key: "1st", from: "name" },
        { key: "dup", from: "deployments" },
        { key: "dup", from: "docsLink" },
      ],
      emptyFields: "keep",
    });
    expect(screen.getByText(/must start with a letter/)).toBeTruthy();
    expect(screen.getAllByText(/already uses the key/).length).toBe(2);
  });

  it("does not warn for hidden fields", () => {
    mount({ fields: [{ key: "1st", from: "name", hidden: true }], emptyFields: "keep" });
    expect(screen.queryByText(/must start with a letter/)).toBeNull();
  });

  it("reorders with the arrows", () => {
    const onChange = mount({ fields: [], emptyFields: "keep" });
    fireEvent.click(screen.getByLabelText("Move name down"));
    expect(lastOutput(onChange).fields.map((f) => f.key)).toEqual([
      "deployments",
      "name",
      "docsLink",
    ]);
  });

  it("saves labels and hidden flags in the output", () => {
    const onChange = mount({ fields: [], emptyFields: "keep" });
    fireEvent.change(screen.getByLabelText("Label for deployments"), {
      target: { value: "Deployments" },
    });
    expect(lastOutput(onChange).fields).toContainEqual({
      key: "deployments",
      label: "Deployments",
    });
  });
});
