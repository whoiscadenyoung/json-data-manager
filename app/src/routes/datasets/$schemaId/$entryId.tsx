import type { ReferenceField } from "@caden/json-cms/react";
import { getReferenceFields } from "@caden/json-cms/react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, Calendar } from "lucide-react";

import { RouterButton } from "@/components/router-button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buildLabelsByField, isRecord, referencedEntryIds } from "@/lib/reference-labels";

import { api } from "../../../../convex/_generated/api";

export const Route = createFileRoute("/datasets/$schemaId/$entryId")({
  component: EntryDetailPage,
});

type ReferencingEntry = FunctionReturnType<typeof api.entries.listReferencingEntries>[number];

/** One reference field's resolved target link(s) — a dash when the field is empty. */
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
    <Card className="mb-6">
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
              labels={labelsByField.get(field.name) ?? new Map()}
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
    <Card className="mb-6">
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

function EntryDetailPage() {
  const { schemaId, entryId } = Route.useParams(),
    entry = useQuery(api.entries.get, { entryId }),
    schema = useQuery(api.schemas.get, { schemaId }),
    allSchemas = useQuery(api.schemas.list),
    referencingEntries = useQuery(api.entries.listReferencingEntries, { entryId }),
    referenceFields = schema ? getReferenceFields(schema.schema) : [],
    targetSchemaIds = [...new Set(referenceFields.map((f) => f.meta.datasetId))],
    referenceCandidates = useQuery(
      api.entries.listEntriesForSchemas,
      targetSchemaIds.length > 0 ? { schemaIds: targetSchemaIds } : "skip",
    ),
    labelsByField = buildLabelsByField(referenceFields, referenceCandidates ?? []),
    titleBySchemaId = new Map((allSchemas ?? []).map((s) => [s._id, s.title]));

  if (entry === undefined || schema === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!entry || !schema) {
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

  return (
    <div className="max-w-4xl mx-auto">
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
            <div className="flex items-center text-muted-foreground mt-2">
              <Calendar className="h-4 w-4 mr-2" />
              Created {new Date(entry._creationTime).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      <ReferenceLinksCard
        referenceFields={referenceFields}
        data={entry.data}
        labelsByField={labelsByField}
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Entry Data</CardTitle>
          <CardDescription>The data stored for this entry</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted rounded-lg p-4 overflow-x-auto">
            <pre className="text-sm">{JSON.stringify(entry.data, null, 2)}</pre>
          </div>
        </CardContent>
      </Card>

      <ReferencedByCard referencingEntries={referencingEntries} titleBySchemaId={titleBySchemaId} />

      <div className="flex justify-center gap-4">
        <RouterButton variant="outline" to="/datasets/$schemaId" params={{ schemaId }}>
          Back to Dataset Details
        </RouterButton>
      </div>
    </div>
  );
}
