import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { lookupOperationsOfSpec } from "#/lib/dataset-rows-pg";
import * as datasetsStore from "#/lib/store/datasets";
import * as derivedStore from "#/lib/store/derived";
import type { DerivedDatasetRow } from "#/lib/store/derived";

import { PgTransformPreview } from "./pg-transform-preview";

/**
 * One derived dataset's joined-table view ([remedies 3], #289) — the route
 * the catalog's Derived section opens: the registry row's spec rendered as
 * the joined table (the transform preview's dataset-wide pass) with its
 * match stats. The registry stays the engine-level store; this page is the
 * project-scoped READER — it never mutates the row (editing stays in the
 * source dataset's Transform tab).
 *
 * Scope posture: a dataset-sourced spec renders fully (the one-click join
 * mint and the editor's lookup transforms are all dataset-sourced). A
 * derived-of-derived row renders its composition chain as links — its
 * output table is the parent's rows under THIS spec's operations, which the
 * preview component (a dataset-row fetcher) cannot consume; the composed
 * view lands with the analysis layer.
 */
export function PgDerivedDatasetPage() {
  const { derivedId, projectId } = useParams({
      from: "/projects/$projectId/derived/$derivedId",
    }),
    rowQuery = useQuery(derivedStore.getQueryOptions({ id: derivedId })),
    row = rowQuery.data;

  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      {row === null || row === undefined ? (
        rowQuery.isError ? (
          <p className="text-sm text-destructive">
            This derived dataset isn&apos;t visible to you (saved transforms are project-readable;
            drafts only to their creator).
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )
      ) : (
        <PgDerivedDatasetBody projectId={projectId} row={row} />
      )}
    </main>
  );
}

function PgDerivedDatasetBody({ projectId, row }: { projectId: string; row: DerivedDatasetRow }) {
  const sourceId = row.sourceDatasetId,
    sourceQuery = useQuery({
      ...datasetsStore.getQueryOptions({ datasetId: sourceId ?? "" }),
      enabled: sourceId !== null,
    }),
    sourceTitle =
      sourceQuery.data === null || sourceQuery.data === undefined
        ? undefined
        : sourceQuery.data.title,
    // The preview's operations: the stored spec's well-formed lookup steps
    // (the seam's structural reader — sql ops contribute nothing here).
    operations = [...lookupOperationsOfSpec(row.spec)];
  return (
    <div className="flex flex-col gap-4">
      <Link
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        params={{ projectId }}
        to="/projects/$projectId/catalog"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Catalog
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-primary">{row.title}</h1>
        {row.description !== null && (
          <p className="text-sm text-muted-foreground">{row.description}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {sourceId !== null ? (
            <>
              Joined over{" "}
              <Link
                className="underline hover:text-foreground"
                params={{ projectId, schemaId: sourceId }}
                to="/projects/$projectId/datasets/$schemaId"
              >
                {sourceTitle ?? "its source dataset"}
              </Link>
            </>
          ) : (
            <>Composed over a derived dataset — its own table view lands with the analysis layer.</>
          )}
        </p>
      </div>
      {sourceId !== null && operations.length > 0 ? (
        <PgTransformPreview operations={operations} sourceDatasetId={sourceId} />
      ) : (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          {operations.length === 0
            ? "This transform has no lookup steps to render."
            : "Open its source dataset's Transform tab to edit this transform."}
        </p>
      )}
    </div>
  );
}
