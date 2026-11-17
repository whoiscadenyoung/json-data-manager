import { Button } from "@caden/ui/components/button";
import { Database, Maximize2, PanelTop, Plus } from "lucide-react";

import { datasetTitle, useAppDatasets } from "../data";
import { APP_LIMITS, type AppContent, type AppPage, type Widget } from "../lib/content";
import { canAddPage } from "../lib/pages";
import { widgetKindInfo } from "../widgets/registry";
import type { BuilderSelection } from "./builder-settings";

/**
 * The builder's outline, left of the canvas: the app's pages in order with
 * each page's widgets under it, then the datasets the app reads. Clicking a
 * row shows that page and opens its settings on the right.
 */

const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted/60 data-[selected=true]:bg-primary/10";

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-1.5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

/** A widget's name in the outline: its title, else its kind. */
export function widgetName(widget: Widget): string {
  const title = widget.title === undefined ? "" : widget.title.trim();
  return title === "" ? widgetKindInfo(widget.kind).label : title;
}

function pageName(page: AppPage): string {
  return page.title.trim() === "" ? "Untitled page" : page.title;
}

function WidgetRows({
  page,
  selectedWidgetId,
  onSelectWidget,
}: {
  page: AppPage;
  selectedWidgetId: string | undefined;
  onSelectWidget: (pageId: string, widgetId: string) => void;
}) {
  if (page.widgets.length === 0) {
    return null;
  }
  return (
    <ul className="ml-3 flex flex-col border-l pl-1.5">
      {page.widgets.map((widget) => {
        const Icon = widgetKindInfo(widget.kind).icon,
          name = widgetName(widget);
        return (
          <li key={widget.id}>
            <button
              type="button"
              className={ROW_CLASS}
              data-selected={widget.id === selectedWidgetId}
              title={name}
              onClick={() => {
                onSelectWidget(page.id, widget.id);
              }}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function DataRows({
  datasetIds,
  onSelect,
}: {
  datasetIds: readonly string[];
  onSelect: () => void;
}) {
  const states = useAppDatasets();
  if (datasetIds.length === 0) {
    return <p className="px-1.5 py-1 text-xs text-muted-foreground">No datasets yet.</p>;
  }
  return (
    <ul className="flex flex-col">
      {datasetIds.map((datasetId) => {
        const title = datasetTitle(states.get(datasetId) ?? { status: "loading" });
        return (
          <li key={datasetId}>
            <button type="button" className={ROW_CLASS} title={title} onClick={onSelect}>
              <Database className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function BuilderOutline({
  content,
  pageId,
  selection,
  onAddPage,
  onSelectData,
  onSelectPage,
  onSelectWidget,
}: {
  content: AppContent;
  /** The page the canvas is showing. */
  pageId: string;
  selection: BuilderSelection | undefined;
  onAddPage: () => void;
  onSelectData: () => void;
  onSelectPage: (pageId: string) => void;
  onSelectWidget: (pageId: string, widgetId: string) => void;
}) {
  const selectedWidgetId =
      selection !== undefined && selection.kind === "widget" ? selection.widgetId : undefined,
    pageSelected = selection !== undefined && selection.kind === "page",
    addable = canAddPage(content.pages);
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Pages" className="flex flex-col gap-1">
        <SectionTitle>{`Pages (${content.pages.length})`}</SectionTitle>
        <ul className="flex flex-col">
          {content.pages.map((page) => {
            const Icon = page.layout === "fullscreen" ? Maximize2 : PanelTop,
              name = pageName(page);
            return (
              <li key={page.id}>
                <button
                  type="button"
                  className={`${ROW_CLASS} ${page.id === pageId ? "font-medium" : ""}`}
                  aria-current={page.id === pageId ? "page" : undefined}
                  aria-label={page.layout === "fullscreen" ? `${name} (full screen)` : undefined}
                  data-selected={pageSelected && page.id === pageId}
                  title={name}
                  onClick={() => {
                    onSelectPage(page.id);
                  }}
                >
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{name}</span>
                </button>
                <WidgetRows
                  page={page}
                  selectedWidgetId={selectedWidgetId}
                  onSelectWidget={onSelectWidget}
                />
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          disabled={!addable}
          title={addable ? undefined : `An app holds up to ${APP_LIMITS.pages} pages`}
          onClick={onAddPage}
        >
          <Plus data-icon="inline-start" />
          Add page
        </Button>
      </section>
      <section aria-label="Data" className="flex flex-col gap-1">
        <SectionTitle>{`Data (${content.datasetIds.length})`}</SectionTitle>
        <DataRows datasetIds={content.datasetIds} onSelect={onSelectData} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          data-selected={selection !== undefined && selection.kind === "data"}
          onClick={onSelectData}
        >
          <Database data-icon="inline-start" />
          Manage datasets
        </Button>
      </section>
    </div>
  );
}
