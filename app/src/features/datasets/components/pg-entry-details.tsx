import type { ReferenceField } from "@caden/json-cms/react";
import { getReferenceFields } from "@caden/json-cms/react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@caden/ui/components/breadcrumb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Calendar, FileJson } from "lucide-react";

import { resolveGeometryRows } from "@/lib/dataset-rows-pg";
import { formatBytes, formatPropertyValue } from "@/lib/format";
import * as datasetsStore from "@/lib/store/datasets";
import * as entriesStore from "@/lib/store/entries";
import * as geometriesStore from "@/lib/store/geometries";
import * as referencesStore from "@/lib/store/references";

import { useSplitReferenceLabels } from "../lib/pg-reference-labels";
import { isRecord, referencedEntryIds } from "../lib/reference-labels";
import { GeometryCard } from "./geometry-card";

/**
 * The Postgres edition of the entry-details page (design §14: surfaces split
 * on where the dataset was created). Reads ride the `#/lib/store/*` modules —
 * the entry row, its geometry, the reference labels (batched `listForIds`),
 * and the trigger-maintained `entry_references` reverse lookup. Same layout
 * as the archived Convex page: properties, links, referenced-by, geometry
 * rail.
 */

/** The same card a null read gets — the denial fallback too (RLS: an invisible row reads as missing). */
function PgEntryNotFoundCard() {
  return (
    <Card className="text-center py-12">
      <CardContent className="pt-6">
        <CardTitle className="mb-2">Entry Not Found</CardTitle>
        <CardDescription className="mb-4">
          The entry you're looking for doesn't exist or has been deleted.
        </CardDescription>
        <Link to="/datasets" className="text-primary hover:underline">
          Back to Datasets
        </Link>
      </CardContent>
    </Card>
  );
}

/** The entry's properties as a key-value table — the same face the Convex page renders. */
function PropertiesTable({ data }: { data: unknown }) {
  if (!isRecord(data)) {
    return (
      <div className="bg-muted rounded-lg p-4 overflow-x-auto">
        <pre className="text-sm">{JSON.stringify(data, null, 2)}</pre>
      </div>
    );
  }
  const rows = Object.entries(data);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">This entry has no properties.</p>;
  }
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key} className="border-b last:border-b-0">
            <th
              scope="row"
              className="w-1/3 py-2 pr-4 text-left align-top font-mono text-xs font-medium break-words text-muted-foreground"
            >
              {key}
            </th>
            <td className="py-2 break-words">{formatPropertyValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Forward references: which other-dataset entries this entry's own reference fields point to. */
function ReferenceLinksCard({
  referenceFields,
  data,
  labelsByField,
}: {
  referenceFields: ReferenceField[];
  data: unknown;
  labelsByField: Map<string, Map<string, string>>;
}) {
  if (referenceFields.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Links</CardTitle>
        <CardDescription>Other datasets this entry points to</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {referenceFields.map((field) => {
          const labels = labelsByField.get(field.name) ?? new globalThis.Map<string, string>();
          return (
            <div key={field.name} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-mono text-muted-foreground">{field.name}:</span>
              <PgReferenceLinks
                field={field}
                targetIds={referencedEntryIds(isRecord(data) ? data[field.name] : undefined)}
                labels={labels}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** One reference field's resolved target link(s) — a dash when the field is empty. */
function PgReferenceLinks({
  field,
  targetIds,
  labels,
}: {
  field: ReferenceField;
  targetIds: string[];
  labels: Map<string, string>;
}) {
  if (targetIds.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <>
      {targetIds.map((targetId) => (
        <Link
          key={targetId}
          to="/datasets/$schemaId/$entryId"
          params={{ entryId: targetId, schemaId: field.meta.datasetId }}
          className="text-primary hover:underline"
        >
          {labels.get(targetId) ?? targetId}
        </Link>
      ))}
    </>
  );
}

/** Reverse lookup: other-dataset entries that reference this one (the trigger-maintained rows). */
function ReferencedByCard({
  referencing,
  titlesByDatasetId,
}: {
  referencing: referencesStore.ReferencingEntryRow[] | undefined;
  titlesByDatasetId: Map<string, string>;
}) {
  if (referencing === undefined || referencing.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Referenced by</CardTitle>
        <CardDescription>Entries in other datasets that link to this one</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {referencing.map((ref) => {
          const datasetTitle = titlesByDatasetId.get(ref.sourceDatasetId);
          return (
            <div
              key={`${ref.sourceEntryId}-${ref.fieldName}`}
              className="flex flex-wrap items-baseline gap-x-2 text-sm"
            >
              <Link
                to="/datasets/$schemaId/$entryId"
                params={{ entryId: ref.sourceEntryId, schemaId: ref.sourceDatasetId }}
                className="text-primary hover:underline"
              >
                {datasetTitle === undefined ? "Entry" : datasetTitle} · {ref.sourceEntryId}
              </Link>
              <span className="text-xs text-muted-foreground">via {ref.fieldName}</span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * The reference labels for the entry's fields — the shared hook
 * (`useSplitReferenceLabels`) over the store's batched lookup; Convex
 * targets are archived with the stage-7 disconnect and render raw ids.
 */
// oxlint-disable-next-line eslint/complexity -- the page's loading/not-found/geometry-rail render paths are its real shape; the decomposition is the deferred #82 phase-2 cleanup.
export function PostgresEntryDetailsPage({
  entryId,
  schemaId,
}: {
  entryId: string;
  schemaId: string;
}) {
  const entryQuery = useQuery(entriesStore.getQueryOptions({ entryId })),
    geometryQuery = useQuery(geometriesStore.getByEntryQueryOptions({ entryId })),
    datasetQuery = useQuery(datasetsStore.getQueryOptions({ datasetId: schemaId })),
    dataset = datasetQuery.data,
    entry = entryQuery.data,
    geometryRow = geometryQuery.data,
    // The row's geometry resolved through the seam — inline rows resolve
    // synchronously from the verbatim jsonb, storage-backed ones via a
    // signed URL (the §5.2 storage-path parity).
    resolvedQuery = useQuery({
      enabled: geometryRow !== undefined && geometryRow !== null,
      queryFn: async () =>
        await resolveGeometryRows(
          geometryRow === undefined || geometryRow === null ? [] : [geometryRow],
        ),
      queryKey: [
        "pg:geometry-resolve",
        entryId,
        geometryRow === null
          ? "none"
          : geometryRow === undefined
            ? "loading"
            : (geometryRow.sourcePath ?? "inline"),
      ],
    }),
    geometry =
      geometryRow === undefined || geometryRow === null || resolvedQuery.data === undefined
        ? undefined
        : resolvedQuery.data.get(entryId),
    referenceFields =
      dataset === undefined || dataset === null ? [] : getReferenceFields(dataset.jsonSchema),
    labelsByField = useSplitReferenceLabels(
      referenceFields,
      entry === undefined || entry === null ? [] : [entry],
    ),
    referencingQuery = useQuery(referencesStore.listReferencingEntriesQueryOptions({ entryId })),
    pgTitlesQuery = useQuery(datasetsStore.listSummariesQueryOptions()),
    // The Convex-half titles of the old split-brain merge are archived with
    // the stage-7 disconnect (issue #206): a reverse reference from a
    // pre-migration Convex dataset renders "Entry" + its raw id, never a
    // live Convex read.
    titlesByDatasetId = new globalThis.Map<string, string>(
      (pgTitlesQuery.data ?? []).map((row) => [row.id, row.title] as const),
    );

  if (entryQuery.isPending || datasetQuery.isPending || geometryQuery.isPending) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (entry === null || entry === undefined || dataset === null || dataset === undefined) {
    return <PgEntryNotFoundCard />;
  }

  // The full stored size of this entry as one GeoJSON-shaped object — the
  // quick "is this feature unusually large?" check. Grows to include the
  // geometry once it resolves.
  const entrySize = formatBytes(
    new Blob([JSON.stringify({ properties: entry.data, geometry: geometry ?? null })]).size,
  );

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 sm:px-0">
      <div className="mb-8">
        <Breadcrumb className="mb-2">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/datasets" />}>Datasets</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/datasets/$schemaId" params={{ schemaId }} />}>
                {dataset.title}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Entry Details</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4 mb-4">
          <Link
            to="/datasets/$schemaId"
            params={{ schemaId }}
            className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dataset
          </Link>
          <div>
            <h1 className="text-3xl font-bold text-primary">Entry Details</h1>
            <div className="flex flex-wrap items-center text-muted-foreground mt-2 gap-x-4">
              <span className="flex items-center">
                <Calendar className="h-4 w-4 mr-2" />
                Created {new Date(entry.createdAt).toLocaleString()}
              </span>
              <span
                className="flex items-center"
                title="Full size of this entry's GeoJSON object (properties + geometry)"
              >
                <FileJson className="h-4 w-4 mr-2" />
                {entrySize}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Properties</CardTitle>
              <CardDescription>The data stored for this entry</CardDescription>
            </CardHeader>
            <CardContent>
              <PropertiesTable data={entry.data} />
            </CardContent>
          </Card>

          <ReferenceLinksCard
            referenceFields={referenceFields}
            data={entry.data}
            labelsByField={labelsByField}
          />

          <ReferencedByCard
            referencing={referencingQuery.data}
            titlesByDatasetId={titlesByDatasetId}
          />
        </div>

        {geometryRow !== undefined && geometryRow !== null && (
          <GeometryCard row={{ entryId, type: geometryRow.type }} geometry={geometry} />
        )}
      </div>
    </div>
  );
}
