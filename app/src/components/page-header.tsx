import type { ReactNode } from "react";

import { navLinkFor, type NavTo } from "#/components/nav-links";

/**
 * The header shared by the main routes (projects, datasets, collections,
 * apps, maps): a muted icon tile, the title, a user-facing description, and
 * the page's primary action on the right. Icon, title and description come
 * from the nav config so the tab and its page always agree.
 */
export function PageHeader({ action, to }: { action?: ReactNode; to: NavTo }) {
  const link = navLinkFor(to),
    Icon = link.icon;
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-6" />
        </div>
        <div>
          <h1 className="mb-1 text-3xl font-bold text-primary">{link.label}</h1>
          <p className="text-muted-foreground">{link.description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}
