// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Map as MapIcon } from "lucide-react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode }) => createElement("a", {}, props.children),
  };
});

import { ExplorerList, ExplorerPage, ExplorerRow, matchesSearch, ProjectChip } from "./explorer";

afterEach(() => {
  cleanup();
});

describe("matchesSearch", () => {
  it("matches any text, ignoring case and blanks", () => {
    expect(matchesSearch("", ["States"])).toBe(true);
    expect(matchesSearch("  ", [null])).toBe(true);
    expect(matchesSearch("STATE", [null, "United States"])).toBe(true);
    expect(matchesSearch("roads", ["States", null])).toBe(false);
  });
});

describe("ExplorerPage", () => {
  it("creates from the header and searches from the box", () => {
    const onCreate = vi.fn<() => void>(),
      onSearch = vi.fn<(value: string) => void>();
    render(
      <ExplorerPage
        createLabel="New map"
        search=""
        searchLabel="Search maps"
        to="/maps"
        onCreate={onCreate}
        onSearch={onSearch}
      >
        <ExplorerList empty="No maps match.">{[]}</ExplorerList>
      </ExplorerPage>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New map" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Search maps"), { target: { value: "sta" } });
    expect(onSearch).toHaveBeenCalledWith("sta");
    expect(screen.getByText("No maps match.")).toBeTruthy();
  });
});

describe("ExplorerRow", () => {
  it("shows the title, chips, description and meta line", () => {
    render(
      <ExplorerList empty="">
        {[
          <ExplorerRow
            chips={<ProjectChip project={{ id: "p1", title: "Field work" }} />}
            description="Where the teams are."
            icon={MapIcon}
            key="m1"
            meta="Updated today"
            title="Deployments"
          />,
        ]}
      </ExplorerList>,
    );
    expect(screen.getByRole("heading", { name: "Deployments" })).toBeTruthy();
    expect(screen.getByText("Field work")).toBeTruthy();
    expect(screen.getByText("Where the teams are.")).toBeTruthy();
    expect(screen.getByText("Updated today")).toBeTruthy();
  });
});
