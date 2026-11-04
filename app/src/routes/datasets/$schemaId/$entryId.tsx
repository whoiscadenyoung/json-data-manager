import type { ReferenceField } from "@caden/json-cms/react";
import { getReferenceFields, useResolvedGeometries } from "@caden/json-cms/react";
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
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, Calendar, FileJson } from "lucide-react";

import {
  buildLabelsByField,
  GeometryCard,
  isRecord,
  PostgresEntryDetailsPage,
  referencedEntryIds,
} from "#/features/datasets";
import { QueryErrorBoundary } from "@/components/query-error-boundary";
import { RouterButton } from "@/components/router-button";
import { useDatasetEntryGeometryRow, useDatasetEntryRow } from "@/lib/dataset-rows-react";
import { isPostgresDatasetId } from "@/lib/dataset-source";
import { formatBytes, formatPropertyValue } from "@/lib/format";

import { api } from "../../../../convex/_generated/api";

export const Route = createFileRoute("/datasets/$schemaId/$entryId")({
  component: EntryDetailPage,
});

function EntryDetailPage() {
  // Transitional split (design doc §14): uuid ids were minted by the
  // Postgres backend — their entry details read through the store modules.
  // Convex datasets keep this page's original Convex reads, unchanged.
  const { entryId, schemaId } = Route.useParams();
  if (isPostgresDatasetId(schemaId)) {
    return <PostgresEntryDetailsPage entryId={entryId} schemaId={schemaId} />;
  }
  // Stage 8 (#104): a denied by-id read (a foreign entry, a draft dataset's
  // row) THROWS from the raw subscription — the boundary renders the same
  // card a deleted entry gets, never the router's error screen. `resetKey`
  // clears it when either route param changes (issue #135, defect 6).
  return (
    <QueryErrorBoundary fallback={<EntryDetailNotFoundCard />} resetKey={`${schemaId}:${entryId}`}>
      {/* oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup. */}
      <EntryDetailBody />
    </QueryErrorBoundary>
  );
}

type ReferencingEntry = FunctionReturnType<typeof api.cms.entries.listReferencingEntries>[number];

function ReferenceFieldLinks({
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
      {targetIds.map((targetId) => {
        const label = labels.get(targetId);
        return (
          <Link
            key={targetId}
            to="/datasets/$schemaId/$entryId"
            params={{ entryId: targetId, schemaId: field.meta.datasetId }}
            className="text-primary hover:underline"
          >
            {label === undefined ? targetId : label}
          </Link>
        );
      })}
    </>
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
        {referenceFields.map((field) => (
          <div key={field.name} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-mono text-muted-foreground">{field.name}:</span>
            <ReferenceFieldLinks
              field={field}
              targetIds={referencedEntryIds(isRecord(data) ? data[field.name] : undefined)}
              labels={labelsByField.get(field.name) ?? new globalThis.Map()}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Reverse lookup: other-dataset entries that reference this one. */
function ReferencedByCard({
  referencingEntries,
  titleBySchemaId,
}: {
  referencingEntries: ReferencingEntry[] | undefined;
  titleBySchemaId: Map<string, string>;
}) {
  if (referencingEntries === undefined || referencingEntries.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Referenced by</CardTitle>
        <CardDescription>Entries in other datasets that link to this one</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {referencingEntries.map((ref) => {
          const datasetTitle = titleBySchemaId.get(ref.sourceSchemaId);
          return (
            <div
              key={`${ref.sourceEntry._id}-${ref.fieldName}`}
              className="flex flex-wrap items-baseline gap-x-2 text-sm"
            >
              <Link
                to="/datasets/$schemaId/$entryId"
                params={{ entryId: ref.sourceEntry._id, schemaId: ref.sourceSchemaId }}
                className="text-primary hover:underline"
              >
                {datasetTitle === undefined ? "Entry" : datasetTitle} · {ref.sourceEntry._id}
              </Link>
              <span className="text-xs text-muted-foreground">via {ref.fieldName}</span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** The entry's properties as a key-value table — the primary face of both tabular and GeoJSON-derived entries. */
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

/** The same card a null read gets — the denial fallback too (stage 8: a foreign draft/author-only id reads exactly as a missing one). */
function EntryDetailNotFoundCard() {
  return (
    <Card className="text-center py-12">
      <CardContent className="pt-6">
        <CardTitle className="mb-2">Entry Not Found</CardTitle>
        <CardDescription className="mb-4">
          The entry you're looking for doesn't exist or has been deleted.
        </CardDescription>
        <RouterButton to="/datasets">Back to Datasets</RouterButton>
      </CardContent>
    </Card>
  );
}

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function EntryDetailBody() {
  const { schemaId, entryId } = Route.useParams(),
    // This entry's row and geometry row resolve through the seam's on-demand
    // point reads — the same path a map popup takes (#52); the schema,
    // summaries, and reference lookups around them are label/relationship
    // reads, not row resolution.
    entry = useDatasetEntryRow(entryId),
    geometryRow = useDatasetEntryGeometryRow(entryId),
    schema = useQuery(api.cms.schemas.get, { schemaId }),
    allSchemas = useQuery(api.cms.schemas.listSummaries, { limit: 1000 }),
    referencingEntries = useQuery(api.cms.entries.listReferencingEntries, { entryId }),
    // Resolves the row's payload — inline `geometryJson` synchronously, a
    // storage-backed `geometryUrl` via fetch (see the hook's doc).
    resolvedGeometries = useResolvedGeometries(geometryRow ? [geometryRow] : []),
    geometry =
      geometryRow === undefined || geometryRow === null
        ? undefined
        : resolvedGeometries.get(geometryRow._id),
    referenceFields = schema ? getReferenceFields(schema.schema) : [],
    targetSchemaIds = [...new Set(referenceFields.map((f) => f.meta.datasetId))],
    referenceCandidates = useQuery(
      api.cms.entries.listEntriesForSchemas,
      targetSchemaIds.length > 0 ? { limit: 200, schemaIds: targetSchemaIds } : "skip",
    ),
    labelsByField = buildLabelsByField(referenceFields, referenceCandidates ?? []),
    titleBySchemaId = new globalThis.Map((allSchemas ?? []).map((s) => [s._id, s.title]));

  if (entry === undefined || schema === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!entry || !schema) {
    return <EntryDetailNotFoundCard />;
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
                {schema.title}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Entry Details</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4 mb-4">
          <RouterButton variant="outline" size="sm" to="/datasets/$schemaId" params={{ schemaId }}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dataset
          </RouterButton>
          <div>
            <h1 className="text-3xl font-bold text-primary">Entry Details</h1>
            <div className="flex flex-wrap items-center text-muted-foreground mt-2 gap-x-4">
              <span className="flex items-center">
                <Calendar className="h-4 w-4 mr-2" />
                Created {new Date(entry._creationTime).toLocaleString()}
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
            referencingEntries={referencingEntries}
            titleBySchemaId={titleBySchemaId}
          />
        </div>

        {geometryRow !== undefined && geometryRow !== null && (
          <GeometryCard row={geometryRow} geometry={geometry} />
        )}
      </div>
    </div>
  );
}
