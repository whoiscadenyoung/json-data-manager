import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import { DerivedHealthBadges } from "#/components/dataset-type-tags";
import type { DerivedDatasetSummaryRow } from "#/lib/store/derived";
import * as derivedStore from "#/lib/store/derived";
import { useSession } from "@/integrations/supabase/provider";

import { PgTransformEditor } from "./pg-transform-editor";

/**
 * The dataset page's Transform tab, Postgres edition (stage 5, #204; ADR
 * 0005 §10.2 over the store's derived module): the authoring surface for
 * lookup specs over THIS dataset as source.
 *
 * Two views, one query: the list of registry rows targeting this dataset
 * (drafts badged, health shown) and the editor (the panel-family
 * composition precedent — this stays a tab, not a route). Reloading
 * mid-edit resumes the signed-in user's newest autosaved lookup draft
 * automatically; closing the editor records the dismissed draft id in a
 * module-level set — the tab unmounts on every switch (Base UI panels), so
 * component state alone would forget the dismissal and re-open the editor
 * over the list forever.
 *
 * The kind split is the summary projection's `carriesSql` stamp (the Convex
 * rule): sql analyses are registry rows too, and they stay the Analyze
 * tab's rows — this builder cannot render a sql step, and resuming one
 * here would let Save write a spec with the sql operation dropped.
 */

/** What the user explicitly opened: an existing row, or a brand-new transform. */
type EditingTarget = { id: string } | { isNew: true };

/** Draft ids whose auto-resume the user closed, remembered across this tab's unmounts within the SPA session (the Convex builder's dismissal-set rule, scoped to the PG tab). */
const dismissedPgDraftIds = new Set<string>();

/** The signed-in user's newest LOOKUP-kind draft for this source (rows arrive newest-first), or undefined. */
function newestOwnPgDraftId(
  rows: DerivedDatasetSummaryRow[] | undefined,
  myAuthId: string | undefined,
): string | undefined {
  if (rows === undefined || myAuthId === undefined) {
    return undefined;
  }
  for (const row of rows) {
    if (row.createdBy === myAuthId && row.status === "draft" && !row.carriesSql) {
      return row.id;
    }
  }
  return undefined;
}

function PgTransformList({
  datasetTitle,
  myAuthId,
  onEdit,
  onNew,
  projectId,
  rows,
}: {
  datasetTitle: string;
  myAuthId: string | undefined;
  onEdit: (id: string) => void;
  onNew: () => void;
  projectId: string | undefined;
  rows: DerivedDatasetSummaryRow[] | undefined;
}) {
  const transformRows = rows === undefined ? undefined : rows.filter((row) => !row.carriesSql);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Derived datasets from {datasetTitle}</CardTitle>
        <CardDescription>
          A transform spec derives a virtual dataset over this one — enrich its rows with fields
          from a related dataset. This dataset&apos;s own data is never modified.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {transformRows === undefined ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : transformRows.length === 0 ? (
          <Empty className="min-h-40 border">
            <EmptyHeader>
              <EmptyTitle>No transforms yet</EmptyTitle>
              <EmptyDescription>
                Derive a view of this dataset — e.g. join a parent table&apos;s names onto its rows.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" onClick={onNew}>
                <Plus className="h-4 w-4 mr-2" />
                New transform
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {transformRows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{row.title}</p>
                    {row.status === "draft" && (
                      <Badge
                        variant="outline"
                        title={
                          row.createdBy === myAuthId
                            ? "Autosaved draft — kept in the registry, not saved as a transform yet."
                            : "Another editor's autosaved draft. Editing it continues their draft."
                        }
                      >
                        {row.createdBy === myAuthId ? "Draft" : "Draft (another editor)"}
                      </Badge>
                    )}
                    <DerivedHealthBadges health={row.health} reason={row.healthReason} />
                  </div>
                  {row.description !== null && (
                    <p className="truncate text-xs text-muted-foreground">{row.description}</p>
                  )}
                </div>
                {row.status === "saved" &&
                  projectId !== undefined && (
                    // The joined-table view ([remedies 3], #289) — the editor
                    // stays the write surface; this is the read.
                    <Link
                      className="shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                      params={{ derivedId: row.id, projectId }}
                      to="/projects/$projectId/derived/$derivedId"
                    >
                      Open
                    </Link>
                  )}
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    onEdit(row.id);
                  }}
                >
                  {row.status === "draft" && row.createdBy === myAuthId ? "Resume" : "Edit"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The Transform tab's PG builder: the list of this dataset's lookup transforms and the editor. */
export function PgTransformBuilder({
  columns,
  datasetTitle,
  schemaId,
}: {
  columns: string[];
  datasetTitle: string;
  schemaId: string;
}) {
  const { projectId } = useParams({ strict: false }),
    { session } = useSession(),
    myAuthId = session === null ? undefined : session.user.id,
    rows = useQuery(derivedStore.listBySourceQueryOptions({ sourceDatasetId: schemaId })).data,
    [editing, setEditing] = useState<EditingTarget | undefined>(undefined),
    // Auto-resume the draft until the visitor closes an editor once (then
    // the list is the home base for the rest of the visit).
    resumedDraftId = newestOwnPgDraftId(rows, myAuthId),
    autoResumeId =
      resumedDraftId !== undefined && !dismissedPgDraftIds.has(resumedDraftId)
        ? resumedDraftId
        : undefined,
    activeId = editing === undefined ? autoResumeId : "isNew" in editing ? "new" : editing.id;

  return activeId === undefined ? (
    <PgTransformList
      datasetTitle={datasetTitle}
      myAuthId={myAuthId}
      projectId={projectId}
      rows={rows}
      onEdit={(id) => {
        setEditing({ id });
      }}
      onNew={() => {
        setEditing({ isNew: true });
      }}
    />
  ) : (
    <PgTransformEditor
      columns={columns}
      datasetTitle={datasetTitle}
      docId={activeId === "new" ? undefined : activeId}
      onClose={() => {
        if (activeId !== "new") {
          dismissedPgDraftIds.add(activeId);
        }
        setEditing(undefined);
      }}
      schemaId={schemaId}
    />
  );
}
