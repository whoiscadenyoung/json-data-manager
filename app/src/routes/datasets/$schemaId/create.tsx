import type { Geometry } from "@caden/json-cms/react";
import { assertGeometry, isGeometryCompatibleWithDatasetType } from "@caden/json-cms/react";
import { Form } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";

import { api } from "../../../../convex/_generated/api";

export const Route = createFileRoute("/datasets/$schemaId/create")({
  component: CreateEntryPage,
});

type Schema = NonNullable<FunctionReturnType<typeof api.schemas.get>>;

interface GeometryParseResult {
  geometry?: Geometry;
  error?: string;
}

/** Parses + validates the pasted geometry textarea against the dataset's locked geometry type. Pulled out of `handleSubmit` to keep its own cyclomatic complexity down. */
function parseGeometryInput(text: string, schema: Schema): GeometryParseResult {
  const trimmed = text.trim();
  if (schema.kind !== "geospatial" || !trimmed) {
    return {};
  }
  try {
    const parsedJson: unknown = JSON.parse(trimmed),
      geometry = assertGeometry(parsedJson);
    if (schema.geometryType === undefined) {
      return { geometry };
    }
    if (!isGeometryCompatibleWithDatasetType(geometry.type, schema.geometryType)) {
      return {
        error: `Geometry type "${geometry.type}" is not compatible with this dataset's "${schema.geometryType}" geometry type.`,
      };
    }
    return { geometry };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Invalid geometry JSON." };
  }
}

function CreateEntryPage() {
  const { schemaId } = Route.useParams(),
    schema = useQuery(api.schemas.get, { schemaId }),
    createEntry = useMutation(api.entries.create),
    [isSubmitting, setIsSubmitting] = useState(false),
    [lastCreatedEntryId, setLastCreatedEntryId] = useState<string | null>(null),
    [geometryText, setGeometryText] = useState(""),
    [geometryError, setGeometryError] = useState<string | null>(null),
    handleSubmit = async (data: any, currentSchema: Schema) => {
      if (!schemaId || !data.formData) {
        return;
      }

      const { geometry, error: geometryParseError } = parseGeometryInput(
        geometryText,
        currentSchema,
      );
      if (geometryParseError !== undefined) {
        setGeometryError(geometryParseError);
        return;
      }
      setGeometryError(null);

      setIsSubmitting(true);

      try {
        const entryId = await createEntry({
          data: data.formData,
          geometry,
          schemaId,
        });

        setLastCreatedEntryId(entryId);
        toast.success("Entry created successfully!");

        // Reset form by forcing re-render
        window.location.reload();
      } catch (error) {
        console.error("Error creating entry:", error);
        toast.error(error instanceof Error ? error.message : "Failed to create entry");
      } finally {
        setIsSubmitting(false);
      }
    };

  if (schema === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!schema) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Dataset Not Found</CardTitle>
          <CardDescription className="mb-4">
            The schema you're looking for doesn't exist or has been deleted.
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
              <BreadcrumbPage>Create Entry</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4 mb-4">
          <RouterButton variant="outline" size="sm" to="/datasets/$schemaId" params={{ schemaId }}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </RouterButton>
          <div>
            <h1 className="text-3xl font-bold text-primary">Create New Entry</h1>
            <p className="text-lg text-muted-foreground mt-2">{schema.description}</p>
          </div>
        </div>
      </div>

      {lastCreatedEntryId && (
        <Card className="mb-6 border-green-200 bg-green-50">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-green-800">
              <Check className="h-4 w-4" />
              <span>
                Entry created successfully!{" "}
                <Link
                  to="/datasets/$schemaId/$entryId"
                  params={{ entryId: lastCreatedEntryId, schemaId }}
                  className="font-semibold underline hover:no-underline"
                >
                  View entry
                </Link>
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {schema.kind === "geospatial" && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Geometry (GeoJSON, optional)</CardTitle>
            <CardDescription>
              This dataset requires {schema.geometryType} geometry. Leave blank for no geometry.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={geometryText}
              onChange={(e) => {
                setGeometryText(e.target.value);
                setGeometryError(null);
              }}
              placeholder='{"type": "Point", "coordinates": [-122.4, 37.8]}'
              rows={6}
              className="font-mono text-sm"
            />
            {geometryError && <p className="mt-2 text-sm text-destructive">{geometryError}</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Entry Form</CardTitle>
          <CardDescription>Fill out the form below to create a new data entry</CardDescription>
        </CardHeader>
        <CardContent>
          <Form
            schema={schema.schema}
            validator={validator}
            onSubmit={(data) => {
              void handleSubmit(data, schema);
            }}
            disabled={isSubmitting}
            uiSchema={{
              ...schema.uiSchema,
              "ui:submitButtonOptions": {
                norender: false,
                props: {
                  className:
                    "w-full px-4 py-3 rounded bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors shadow-sm hover:shadow disabled:opacity-50 disabled:cursor-not-allowed",
                  disabled: isSubmitting,
                },
                submitText: isSubmitting ? "Creating..." : "Create Entry",
              },
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
