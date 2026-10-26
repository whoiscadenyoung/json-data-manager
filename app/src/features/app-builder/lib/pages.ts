import { APP_LIMITS, type AppPage, type Widget } from "#convex/appBuilder/validators";

import { moveItem, withoutDataset } from "./layout";

/**
 * Page (tab) operations for the builder — pure, React-free. An app is an
 * ordered list of pages; each page has its own layout mode and widgets, and
 * every page reads from the app's one shared list of datasets.
 */

/** A page title not yet used in the app: "Page 2", "Page 3", … */
export function nextPageTitle(pages: readonly AppPage[]): string {
  const taken = new Set(pages.map((page) => page.title));
  let n = pages.length + 1;
  while (taken.has(`Page ${n}`)) {
    n += 1;
  }
  return `Page ${n}`;
}

/** A new, empty contained page. */
export function newPage(pages: readonly AppPage[]): AppPage {
  return {
    id: `page-${crypto.randomUUID().slice(0, 8)}`,
    layout: "contained",
    title: nextPageTitle(pages),
    widgets: [],
  };
}

export function canAddPage(pages: readonly AppPage[]): boolean {
  return pages.length < APP_LIMITS.pages;
}

/** Applies `change` to one page by id, keeping every other page's reference. */
export function updatePage(
  pages: readonly AppPage[],
  pageId: string,
  change: (page: AppPage) => AppPage,
): AppPage[] {
  return pages.map((page) => (page.id === pageId ? change(page) : page));
}

/** Removes a page — never the last one (an app always has a page). */
export function removePage(pages: readonly AppPage[], pageId: string): AppPage[] {
  return pages.length <= 1 ? [...pages] : pages.filter((page) => page.id !== pageId);
}

/** Moves a page one slot left (-1) or right (+1). */
export function shiftPage(pages: readonly AppPage[], pageId: string, delta: -1 | 1): AppPage[] {
  const from = pages.findIndex((page) => page.id === pageId);
  return moveItem(pages, from, from + delta);
}

/** Every widget on every page. */
export function allWidgets(pages: readonly AppPage[]): Widget[] {
  return pages.flatMap((page) => page.widgets);
}

/** Drops a dataset from every page (what removing a data source does). */
export function pagesWithoutDataset(pages: readonly AppPage[], datasetId: string): AppPage[] {
  return pages.map((page) => ({ ...page, widgets: withoutDataset(page.widgets, datasetId) }));
}

/** The page to show for a requested id: that page when it exists, else the first. */
/** The `?page=` search param shared by the viewer, preview and builder routes. */
export function pageSearch(search: Record<string, unknown>): { page?: string } {
  return typeof search.page === "string" && search.page !== "" ? { page: search.page } : {};
}

export function resolvePage(pages: readonly AppPage[], pageId: string | undefined): AppPage {
  return pages.find((page) => page.id === pageId) ?? pages[0];
}
