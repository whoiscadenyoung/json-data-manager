import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import type { FunctionReturnType } from "convex/server";
import { Plus } from "lucide-react";
import { useState } from "react";

import { DerivedHealthBadges } from "#/components/dataset-type-tags";
import { TransformEditor } from "#/components/transform-editor";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import { api } from "#convex/_generated/api";

/**
 * The dataset page's Transform tab (roadmap stage 2, #95; ADR 0005 §10.2):
 * the authoring surface for transform specs over THIS dataset as source.
 *
 * Two views, one query: the list of specs targeting this dataset (drafts
 * badged, health shown) and the editor (the panel-family composition
 * precedent — this stays a tab, not a route). Reloading mid-edit resumes
 * the signed-in user's newest autosaved draft automatically, so the
 * autosaved draft reconstructs the editing session (the lifecycle doc's
 * "autosave early and often"). Closing the editor records the dismissed
 * draft id in a module-level set — the tab unmounts on every switch (Base
 * UI panels), so component state alone would forget the dismissal and
 * re-open the editor over the list forever.
 *
 * The rows listed here come from the registry — a list projection, not row
 * pagination. Derived-row CONSUMPTION stays entirely with the
 * row-resolution seam (the preview loads through `fetchDatasetEntryRows`);
 * this surface never paginates datasets on its own.
 */

type RegistryRow = FunctionReturnType<typeof api.derivedDatasets.listBySource>[number];

/** What the user explicitly opened: an existing row, or a brand-new transform. */
type EditingTarget = { id: string } | { isNew: true };

/**
 * Draft ids whose auto-resume the user closed, remembered across this tab's
 * unmounts (and route navigations) within the SPA session — component state
 * dies with the TabsContent panel.
 */
const dismissedDraftIds = new Set<string>();

/** The signed-in user's newest draft for this source (rows arrive newest-first), or undefined. */
function newestOwnDraftId(rows: RegistryRow[] | undefined, myAuthId: string | undefined) {
  if (rows === undefined || myAuthId === undefined) {
    return undefined;
  }
  const draft = rows.find((row) => row.createdBy === myAuthId && row.status === "draft");
  return draft === undefined ? undefined : draft._id;
}

function TransformList({
  myAuthId,
  onEdit,
  onNew,
  rows,
  datasetTitle,
}: {
  datasetTitle: string;
  myAuthId: string | undefined;
  onEdit: (id: string) => void;
  onNew: () => void;
  rows: RegistryRow[] | undefined;
}) {
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
        {rows === undefined ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : rows.length === 0 ? (
          <Empty className="min-h-40 border">
            <EmptyHeader>
              <EmptyTitle>No transforms yet</EmptyTitle>
              <EmptyDescription>
                Derive a view of this dataset — e.g. join a parent table&apos;s names onto its
                rows.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                onClick={onNew}
              >
                <Plus className="h-4 w-4 mr-2" />
                New transform
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row._id}
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
                  {row.description !== undefined && (
                    <p className="truncate text-xs text-muted-foreground">{row.description}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    onEdit(row._id);
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

export function TransformBuilder({
  columns,
  datasetTitle,
  schemaId,
}: {
  columns: string[];
  datasetTitle: string;
  schemaId: string;
}) {
  const rows = useQuery({
      ...convexQuery(api.derivedDatasets.listBySource, { sourceDatasetId: schemaId }),
    }).data,
    me = useQuery({ ...convexQuery(api.users.me, {}) }).data,
    myAuthId = me === null || me === undefined ? undefined : me.authId,
    [editing, setEditing] = useState<EditingTarget | undefined>(undefined),
    // Auto-resume the draft until the visitor closes an editor once (then
    // the list is the home base for the rest of the visit).
    resumedDraftId = newestOwnDraftId(rows, myAuthId),
    autoResumeId =
      resumedDraftId !== undefined && !dismissedDraftIds.has(resumedDraftId)
        ? resumedDraftId
        : undefined,
    activeId =
      editing === undefined
        ? autoResumeId
        : "isNew" in editing
          ? "new"
          : editing.id;

  return activeId === undefined ? (
    <TransformList
      datasetTitle={datasetTitle}
      myAuthId={myAuthId}
      rows={rows}
      onEdit={(id) => {
        setEditing({ id });
      }}
      onNew={() => {
        setEditing({ isNew: true });
      }}
    />
  ) : (
    <TransformEditor
      columns={columns}
      datasetTitle={datasetTitle}
      docId={activeId === "new" ? undefined : activeId}
      onClose={() => {
        if (activeId !== "new") {
          dismissedDraftIds.add(activeId);
        }
        setEditing(undefined);
      }}
      schemaId={schemaId}
    />
  );
}
