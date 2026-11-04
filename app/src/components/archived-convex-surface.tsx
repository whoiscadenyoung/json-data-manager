import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Link } from "@tanstack/react-router";
import { ArchiveX } from "lucide-react";
import type { ReactNode } from "react";

/** Where the surface's "back" link goes — the catalog section it belongs to. */
type ArchivedHome = "/datasets" | "/maps" | "/projects";

const HOME_LABELS: Record<ArchivedHome, string> = {
  "/datasets": "Back to Datasets",
  "/maps": "Back to Maps",
  "/projects": "Back to Projects",
};

/**
 * The shared "archived in this build" surface (stage 7 disconnect, issue
 * #206): every routed surface whose rows lived in the pre-migration Convex
 * catalog renders this instead of mounting a live `convex/react` hook — with
 * the Convex provider unmounted, those hooks would throw against a missing
 * client, and the backend they read is going away (data disposable, design
 * doc §14). The untouched `app/convex/` + `packages/json-cms/` trees remain
 * the revert path; nothing renders from them in this build.
 */
export function ArchivedConvexSurface({
  children,
  description = "This surface served items created before the Postgres migration. Pre-migration data was retired with the old backend — Postgres items are unaffected.",
  homeTo = "/datasets",
  title = "Convex datasets are archived in this build",
}: {
  /** An optional surface-specific line under the shared description. */
  children?: ReactNode;
  description?: string;
  homeTo?: ArchivedHome;
  title?: string;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ArchiveX />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link className="text-primary text-sm hover:underline" to={homeTo}>
            {HOME_LABELS[homeTo]}
          </Link>
        </EmptyContent>
        {children}
      </Empty>
    </main>
  );
}
