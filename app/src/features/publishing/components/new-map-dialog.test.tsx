// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewMapDialog } from "./new-map-dialog";

afterEach(() => {
  cleanup();
});

function renderDialog() {
  const onSubmit = vi.fn<(values: { description: string; name: string }) => void>();
  render(createElement(NewMapDialog, { busy: false, onOpenChange: () => {}, onSubmit }));
  return onSubmit;
}

describe("NewMapDialog", () => {
  it("says a name is missing instead of creating an unnamed map", () => {
    const onSubmit = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create map" }));
    expect(screen.getByText("A map needs a name.")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the trimmed name and description", () => {
    const onSubmit = renderDialog();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "  Parks overview " } });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: " All parks " } });
    fireEvent.click(screen.getByRole("button", { name: "Create map" }));
    expect(onSubmit).toHaveBeenCalledWith({ description: "All parks", name: "Parks overview" });
  });
});
