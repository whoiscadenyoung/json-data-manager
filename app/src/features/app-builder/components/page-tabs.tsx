import { Tabs, TabsList, TabsTrigger } from "@caden/ui/components/tabs";
import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";

import type { AppPage } from "#convex/appBuilder/validators";

/**
 * An app's pages as tabs — the same strip in the builder and the viewer.
 * Full-screen pages carry a small icon so the layout is visible at a glance.
 * `children` render after the tabs (the builder's "Add page").
 */
export function PageTabs({
  pages,
  activeId,
  onChange,
  children,
}: {
  pages: readonly AppPage[];
  activeId: string;
  onChange: (pageId: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Tabs
        value={activeId}
        onValueChange={(value) => {
          if (typeof value === "string") {
            onChange(value);
          }
        }}
        className="min-w-0"
      >
        <TabsList variant="line" aria-label="App pages" className="max-w-full overflow-x-auto">
          {pages.map((page) => (
            <TabsTrigger key={page.id} value={page.id}>
              {page.layout === "fullscreen" && (
                <Maximize2 aria-label="Full screen" data-icon="inline-start" />
              )}
              {page.title.trim() === "" ? "Untitled page" : page.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </div>
  );
}
