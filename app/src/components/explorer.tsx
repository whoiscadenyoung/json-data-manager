import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import { Link } from "@tanstack/react-router";
import { FolderOpen, Plus, Search, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The global explorers (/maps, /apps): one header, one search box and one row
 * shape, so both read alike. Rows are whole-row links; chips inside a row that
 * link elsewhere sit above the stretched link.
 */

/** Whether any of the texts contains the query, ignoring case. An empty query matches all. */
export function matchesSearch(query: string, texts: ReadonlyArray<string | null>): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" || texts.some((text) => text !== null && text.toLowerCase().includes(needle))
  );
}

export function ExplorerPage({
  children,
  createLabel,
  description,
  search,
  searchLabel,
  title,
  onCreate,
  onSearch,
}: {
  children: ReactNode;
  createLabel: string;
  description: string;
  search: string;
  searchLabel: string;
  title: string;
  onCreate: () => void;
  onSearch: (value: string) => void;
}) {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mb-1 text-3xl font-bold text-primary">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <Button type="button" onClick={onCreate}>
          <Plus data-icon="inline-start" />
          {createLabel}
        </Button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={searchLabel}
          className="pl-7"
          placeholder={`${searchLabel}…`}
          value={search}
          onChange={(event) => {
            onSearch(event.target.value);
          }}
        />
      </div>
      {children}
    </main>
  );
}

/** The rows, or a line saying the search found nothing. */
export function ExplorerList({ children, empty }: { children: ReactNode[]; empty: string }) {
  if (children.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  }
  return <ul className="divide-y rounded-lg border">{children}</ul>;
}

/** The chip naming the project a map or app lives in, linking to it. */
export function ProjectChip({ project }: { project: { id: string; title: string } }) {
  return (
    <Badge className="relative z-10" title={`In the project “${project.title}”`} variant="outline">
      <FolderOpen data-icon="inline-start" />
      <Link
        className="hover:underline"
        params={{ projectId: project.id }}
        to="/projects/$projectId"
      >
        {project.title}
      </Link>
    </Badge>
  );
}

export function ExplorerRow({
  chips,
  description,
  icon: Icon,
  meta,
  title,
}: {
  /** Visibility first, then the project, then anything else. */
  chips: ReactNode;
  description: string | null;
  icon: LucideIcon;
  /** One short line: counts, when it changed. */
  meta: string;
  /** The row's link; give it `after:absolute after:inset-0` to make the row the target. */
  title: ReactNode;
}) {
  return (
    <li className="relative flex items-start gap-3 px-4 py-3 hover:bg-muted/40">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          <div className="flex flex-wrap items-center gap-1.5">{chips}</div>
        </div>
        {description !== null && description !== "" && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{description}</p>
        )}
        <p className="text-xs text-muted-foreground">{meta}</p>
      </div>
    </li>
  );
}

export function ExplorerEmpty({
  createLabel,
  description,
  icon: Icon,
  title,
  onCreate,
}: {
  createLabel: string;
  description: string;
  icon: LucideIcon;
  title: string;
  onCreate: () => void;
}) {
  return (
    <Empty className="min-h-64 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" onClick={onCreate}>
          <Plus data-icon="inline-start" />
          {createLabel}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** "Updated 3/4/2026". */
export function updatedOn(iso: string): string {
  return `Updated ${new Date(iso).toLocaleDateString()}`;
}
