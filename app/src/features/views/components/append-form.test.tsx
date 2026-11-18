// @vitest-environment jsdom
import type { Step } from "@caden/data-core/views";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppendForm } from "./append-form";

type AppendStep = Extract<Step, { kind: "append" }>;

afterEach(cleanup);

const infos = [
  { alias: "fy22", datasetId: "a", title: "FY22", fields: ["name", "amount"] },
  { alias: "fy23", datasetId: "b", title: "FY23", fields: ["name", "Amount", "extra"] },
];
const step: AppendStep = { kind: "append", sources: [{ input: "fy23" }] };

function renderForm(onChange = vi.fn<(step: Step) => void>()) {
  render(
    <AppendForm
      baseFields={["name", "amount"]}
      baseTitle="FY22"
      infos={infos}
      isFirstStep
      onChange={onChange}
      step={step}
    />,
  );
  return onChange;
}

describe("AppendForm columns", () => {
  it("shows merged and partial columns", () => {
    renderForm();
    expect(screen.getByText("Merged")).toBeTruthy();
    expect(screen.getAllByText("Only in FY23").length).toBeGreaterThan(0);
  });

  it("offers a merge chip and applies it", () => {
    const onChange = renderForm();
    fireEvent.click(screen.getByText(/Merge “Amount” into “amount”/));
    const next = onChange.mock.calls[0][0] as AppendStep;
    expect(next.sources[0].columns).toEqual([{ from: "Amount", as: "amount" }]);
  });

  it("excludes a field", () => {
    const onChange = renderForm();
    fireEvent.click(screen.getByLabelText("Exclude extra from FY23"));
    const next = onChange.mock.calls[0][0] as AppendStep;
    expect(next.sources[0].columns).toEqual([{ from: "extra", exclude: true }]);
  });
});
