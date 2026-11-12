// @vitest-environment jsdom
import type { JoinStep, Measure, Step } from "@caden/data-core/views";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// CodeMirror is client-only and does not run in jsdom: the editor is a textarea that
// exposes the props the forms hand it (diagnostics and completion labels).
vi.mock("@caden/ui/components/code-editor", () => ({
  CodeEditor: (props: {
    ariaLabel: string;
    completions?: { label: string; apply?: string }[];
    diagnostics?: { from: number; to: number; message: string }[];
    onChange: (value: string) => void;
    value: string;
  }) =>
    createElement("textarea", {
      "aria-label": props.ariaLabel,
      "data-completions": JSON.stringify(props.completions ?? []),
      "data-diagnostics": JSON.stringify(props.diagnostics ?? []),
      onChange: (event: { target: { value: string } }) => {
        props.onChange(event.target.value);
      },
      value: props.value,
    }),
}));

const mocks = vi.hoisted(() => ({
  distinct: vi.fn<(datasetId: string, field: string) => Promise<string[]>>(),
}));

vi.mock("@/lib/store/view-reads", () => ({
  distinctFieldValuesQueryOptions: (datasetId: string, field: string) => ({
    enabled: datasetId !== "" && field !== "",
    queryFn: async () => await mocks.distinct(datasetId, field),
    queryKey: ["test:distinct", datasetId, field],
  }),
}));

import { newJoinStep, type InputInfo } from "../lib/view-model";
import { CalculateForm } from "./calculate-form";
import { MeasuresEditor } from "./measures-editor";
import { SqlForm } from "./sql-form";
import { JoinForm } from "./step-forms";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const infos: InputInfo[] = [
  { alias: "states", datasetId: "d-states", title: "States", fields: ["id", "name"] },
  {
    alias: "links",
    datasetId: "d-links",
    title: "Links",
    fields: ["stateName", "type", "url"],
  },
];

function lastCall<T>(spy: { mock: { calls: T[][] } }): T {
  const call = spy.mock.calls[spy.mock.calls.length - 1];
  if (call === undefined || call[0] === undefined) {
    throw new Error("not called");
  }
  return call[0];
}

function withClient(child: React.ReactElement) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    child,
  );
}

describe("spread (join form)", () => {
  const spreadStep: JoinStep = {
    ...newJoinStep({ left: "name", right: "stateName", rightAlias: "links", rightTitle: "Links" }),
    multiMatch: {
      mode: "spread",
      by: "type",
      value: "url",
      columns: [{ category: "docs", as: "docsLink" }],
    },
  };

  function form(onChange: (s: JoinStep) => void, undeclared: string[] = []) {
    return withClient(
      createElement(JoinForm, {
        datasets: [{ id: "d-links", title: "Links" }],
        infos,
        leftFields: ["id", "name"],
        onChange,
        onPickRight: vi.fn<(id: string) => void>(),
        step: spreadStep,
        undeclaredCategories: undeclared,
      }),
    );
  }

  it("proposes the not-yet-declared values found in the data, with editable names", async () => {
    mocks.distinct.mockResolvedValue(["benefits", "docs", "Press Kit"]);
    const onChange = vi.fn<(s: JoinStep) => void>();
    render(form(onChange));
    // docs is declared already, so two columns are proposed.
    const add = await screen.findByRole("button", { name: /Add proposed columns \(2\)/ });
    expect(screen.getByText(/benefits → benefits, Press Kit → PressKit/)).toBeTruthy();
    fireEvent.click(add);
    const next = lastCall(onChange);
    expect(next.multiMatch).toEqual({
      mode: "spread",
      by: "type",
      value: "url",
      columns: [
        { category: "docs", as: "docsLink" },
        { category: "benefits", as: "benefits" },
        { category: "Press Kit", as: "PressKit" },
      ],
    });
    // The declared name is an editable text field.
    fireEvent.change(screen.getByLabelText("Spread column 1 name"), {
      target: { value: "documentation" },
    });
    expect(lastCall(onChange).multiMatch).toMatchObject({
      columns: [{ category: "docs", as: "documentation" }],
    });
    expect(mocks.distinct).toHaveBeenCalledWith("d-links", "type");
  });

  it("warns about categories the diagnostics found with no column, and offers to add them", async () => {
    mocks.distinct.mockResolvedValue([]);
    const onChange = vi.fn<(s: JoinStep) => void>();
    render(form(onChange, ["benefits", "faq"]));
    expect(await screen.findByText(/2 categories have no column/)).toBeTruthy();
    expect(screen.getByText("benefits, faq")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add columns for them" }));
    expect(lastCall(onChange).multiMatch).toMatchObject({
      columns: [
        { category: "docs", as: "docsLink" },
        { category: "benefits", as: "benefits" },
        { category: "faq", as: "faq" },
      ],
    });
  });

  it("offers the text, list and error modes with their settings", () => {
    const textStep: JoinStep = {
      ...spreadStep,
      multiMatch: { mode: "text", field: "url", separator: "; " },
    };
    const onChange = vi.fn<(s: JoinStep) => void>();
    const { rerender } = render(
      withClient(
        createElement(JoinForm, {
          datasets: [],
          infos,
          leftFields: ["name"],
          onChange,
          onPickRight: vi.fn<(id: string) => void>(),
          step: textStep,
        }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Separator"), { target: { value: " | " } });
    expect(lastCall(onChange).multiMatch).toEqual({ mode: "text", field: "url", separator: " | " });
    rerender(
      withClient(
        createElement(JoinForm, {
          datasets: [],
          infos,
          leftFields: ["name"],
          onChange,
          onPickRight: vi.fn<(id: string) => void>(),
          step: { ...spreadStep, multiMatch: { mode: "list" } },
        }),
      ),
    );
    expect(screen.getByText(/Arrays do not flatten into a GIS table/)).toBeTruthy();
  });
});

describe("measures: topBy and text", () => {
  it("shows the ranking field, direction and the empty value of a topBy measure", () => {
    const onChange = vi.fn<(m: Measure[]) => void>();
    const measures: Measure[] = [
      { as: "mostCollaboration", fn: "topBy", field: "name", by: "agencyCount", direction: "max" },
    ];
    render(
      createElement(MeasuresEditor, {
        fields: ["name", "agencyCount"],
        measures,
        onChange,
      }),
    );
    expect(screen.getByText("Value from the top row")).toBeTruthy();
    expect(screen.getByText("highest")).toBeTruthy();
    expect(screen.getByLabelText("Measure 1 ranked by")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Measure 1 value when nothing matched"), {
      target: { value: "none" },
    });
    expect(lastCall(onChange)[0]).toEqual({ ...measures[0], emptyValue: "none" });
  });

  it("asks for a separator on a text measure", () => {
    const onChange = vi.fn<(m: Measure[]) => void>();
    render(
      createElement(MeasuresEditor, {
        fields: ["name"],
        measures: [{ as: "names", fn: "text", field: "name", separator: ", " }],
        onChange,
      }),
    );
    fireEvent.change(screen.getByLabelText("Measure 1 separator"), { target: { value: "; " } });
    expect(lastCall(onChange)[0]).toMatchObject({ fn: "text", separator: "; " });
  });
});

describe("CalculateForm", () => {
  const base: Extract<Step, { kind: "calculate" }> = {
    kind: "calculate",
    field: "double",
    expr: "",
  };
  const fields = ["cost", "state name", "sites"];

  function renderWith(
    expr: string,
    onChange = vi.fn<(s: Step) => void>(),
    fieldTypes?: Map<string, "number" | "string">,
  ) {
    render(createElement(CalculateForm, { fieldTypes, fields, onChange, step: { ...base, expr } }));
    return onChange;
  }

  it("shows a positioned parse error and no result type", () => {
    renderWith("cost *");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toBe("");
    const diagnostics: { from: number; to: number; message: string }[] = JSON.parse(
      screen.getByLabelText("Expression").getAttribute("data-diagnostics") ?? "[]",
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    // The error is at the end of the text, where "cost *" is missing its right side.
    expect(diagnostics).toMatchObject([{ from: 6 }]);
    expect(screen.queryByText(/Result type/)).toBeNull();
  });

  it("names the result type for a declared field instead of 'depends on the data' (#335)", () => {
    const types = new Map<string, "number" | "string">([["cost", "number"]]);
    const first = render(
      createElement(CalculateForm, {
        fieldTypes: types,
        fields,
        onChange: vi.fn<(s: Step) => void>(),
        step: { ...base, expr: "cost" },
      }),
    );
    expect(first.getByText(/Result type/).textContent).toContain("number");
    first.unmount();
    // An undeclared field still reads as unknown.
    const second = render(
      createElement(CalculateForm, {
        fieldTypes: types,
        fields,
        onChange: vi.fn<(s: Step) => void>(),
        step: { ...base, expr: "sites" },
      }),
    );
    expect(second.getByText(/Result type/).textContent).toContain("depends on the data");
  });

  it("reports a field that does not exist, at its position", () => {
    renderWith("cost + nope");
    expect(screen.getByRole("alert").textContent).toMatch(/nope/);
    const diagnostics: { from: number; to: number }[] = JSON.parse(
      screen.getByLabelText("Expression").getAttribute("data-diagnostics") ?? "[]",
    );
    expect(diagnostics[0]).toMatchObject({ from: 7, to: 11 });
  });

  it("shows the result type of a valid expression", () => {
    renderWith("round(cost / sites, 2)");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("number")).toBeTruthy();
  });

  it("offers the row's fields (quoted when needed) and the allowed functions to autocomplete", () => {
    renderWith("");
    const completions: { label: string; apply?: string }[] = JSON.parse(
      screen.getByLabelText("Expression").getAttribute("data-completions") ?? "[]",
    );
    expect(completions).toContainEqual(expect.objectContaining({ label: "cost", apply: "cost" }));
    expect(completions).toContainEqual(
      expect.objectContaining({ label: "state name", apply: '"state name"' }),
    );
    expect(completions).toContainEqual(
      expect.objectContaining({ label: "round", apply: "round(" }),
    );
  });

  it("stores the typed text and the field name in the step", () => {
    const onChange = renderWith("");
    fireEvent.change(screen.getByLabelText("Expression"), { target: { value: "cost * 2" } });
    expect(lastCall(onChange)).toEqual({ kind: "calculate", field: "double", expr: "cost * 2" });
    fireEvent.change(screen.getByLabelText("New field name"), { target: { value: "twice" } });
    expect(lastCall(onChange)).toMatchObject({ field: "twice" });
  });
});

describe("SqlForm", () => {
  it("explains the available names and the output rule", () => {
    render(
      createElement(SqlForm, {
        aliases: ["states", "links"],
        onChange: vi.fn<(s: Step) => void>(),
        step: { kind: "sql", query: "select * from prev" },
      }),
    );
    expect(screen.getByText("in_links")).toBeTruthy();
    expect(screen.getByText("in_states")).toBeTruthy();
    expect(screen.getByText(/Output rule/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows positioned errors for a syntax error and an unknown table", () => {
    const { rerender } = render(
      createElement(SqlForm, {
        aliases: ["states"],
        onChange: vi.fn<(s: Step) => void>(),
        step: { kind: "sql", query: "select from from" },
      }),
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(
      createElement(SqlForm, {
        aliases: ["states"],
        onChange: vi.fn<(s: Step) => void>(),
        step: { kind: "sql", query: "select * from secrets" },
      }),
    );
    const diagnostics: { from: number; to: number; message: string }[] = JSON.parse(
      screen.getByLabelText("SQL query").getAttribute("data-diagnostics") ?? "[]",
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toMatch(/secrets/);
    expect(diagnostics.map((d) => d.from)).toContain("select * from ".length);
  });

  it("lists the output columns of a valid query", () => {
    render(
      createElement(SqlForm, {
        aliases: ["states"],
        onChange: vi.fn<(s: Step) => void>(),
        step: { kind: "sql", query: "select d, 1 as one from prev" },
      }),
    );
    expect(screen.getByText("d, one")).toBeTruthy();
  });
});
