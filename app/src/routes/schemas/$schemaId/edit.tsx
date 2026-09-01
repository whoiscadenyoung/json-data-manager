import { SchemaEditor } from "@caden/json-cms/react/ui";
import { useForm } from "@tanstack/react-form";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { AlertCircle, ArrowLeft, Save } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "#convex/_generated/api";
import { RouterButton } from "@/components/router-button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/schemas/$schemaId/edit")({
  component: EditSchemaPage,
});

function EditSchemaPage() {
  const { schemaId } = Route.useParams(),
    navigate = useNavigate(),
    schema = useQuery(api.schemas.get, { schemaId }),
    entries = useQuery(api.entries.list, { schemaId }),
    updateSchema = useMutation(api.schemas.update);

  if (schema === undefined || entries === undefined) {
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
          <p className="text-muted-foreground mb-4">Schema not found.</p>
          <RouterButton to="/schemas">Back to Schemas</RouterButton>
        </CardContent>
      </Card>
    );
  }

  const hasEntries = entries.length > 0;

  return (
    <div className={`mx-auto py-8 px-4 ${hasEntries ? "max-w-2xl" : "max-w-7xl"}`}>
      <div className="mb-6">
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/schemas" />}>Schemas</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/schemas/$schemaId" params={{ schemaId }} />}>
                {schema.title}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Edit</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4">
          <RouterButton
            variant="ghost"
            size="sm"
            to="/schemas/$schemaId"
            params={{ schemaId }}
            className="-ml-2"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </RouterButton>
          <h1 className="text-3xl font-bold text-primary">Edit Schema</h1>
        </div>
      </div>

      {hasEntries ? (
        <MetadataEditForm
          schemaId={schemaId}
          title={schema.title}
          description={schema.description}
          updateSchema={updateSchema}
          navigate={navigate}
        />
      ) : (
        <FullSchemaEditForm
          schemaId={schemaId}
          currentSchema={schema.schema}
          currentUiSchema={schema.uiSchema}
          updateSchema={updateSchema}
          navigate={navigate}
        />
      )}
    </div>
  );
}

function MetadataEditForm({
  schemaId,
  title,
  description,
  updateSchema,
  navigate,
}: {
  schemaId: string;
  title: string;
  description: string;
  updateSchema: ReturnType<typeof useMutation<typeof api.schemas.update>>;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const form = useForm({
    defaultValues: { description, title },
    onSubmit: async ({ value }) => {
      try {
        await updateSchema({
          description: value.description,
          schemaId,
          title: value.title,
        });
        toast.success("Schema updated!");
        void navigate({ params: { schemaId }, to: "/schemas/$schemaId" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update schema.");
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schema Info</CardTitle>
        <CardDescription>
          <span className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
            This schema has entries — only the title and description can be changed to preserve data
            integrity.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void form.handleSubmit();
          }}
          className="space-y-4"
        >
          <form.Field
            name="title"
            validators={{
              onBlur: z.string().min(1, "Title is required."),
              onChange: z.string().min(1, "Title is required."),
            }}
          >
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                  }}
                  onBlur={field.handleBlur}
                />
                {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                  <p className="text-sm text-destructive">
                    {field.state.meta.errors[0]?.message ??
                      JSON.stringify(field.state.meta.errors[0])}
                  </p>
                )}
              </div>
            )}
          </form.Field>

          <form.Field
            name="description"
            validators={{
              onBlur: z.string().min(1, "Description is required."),
              onChange: z.string().min(1, "Description is required."),
            }}
          >
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                  }}
                  onBlur={field.handleBlur}
                  rows={3}
                />
                {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                  <p className="text-sm text-destructive">
                    {field.state.meta.errors[0]?.message ??
                      JSON.stringify(field.state.meta.errors[0])}
                  </p>
                )}
              </div>
            )}
          </form.Field>

          <form.Subscribe selector={(state) => [state.isSubmitting]}>
            {([isSubmitting]) => (
              <Button type="submit" disabled={isSubmitting}>
                <Save className="h-4 w-4 mr-2" />
                {isSubmitting ? "Saving…" : "Save Changes"}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}

function FullSchemaEditForm({
  schemaId,
  currentSchema,
  currentUiSchema,
  updateSchema,
  navigate,
}: {
  schemaId: string;
  currentSchema: unknown;
  currentUiSchema?: unknown;
  updateSchema: ReturnType<typeof useMutation<typeof api.schemas.update>>;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <SchemaEditor
      initialJson={JSON.stringify(currentSchema, null, 2)}
      initialUiSchemaJson={currentUiSchema ? JSON.stringify(currentUiSchema, null, 2) : ""}
      onSave={async (_json, parsed, _uiSchemaJson, uiSchemaParsed) => {
        try {
          await updateSchema({
            schema: parsed,
            schemaId,
            uiSchema: Object.keys(uiSchemaParsed).length > 0 ? uiSchemaParsed : undefined,
          });
          toast.success("Schema updated!");
          void navigate({ params: { schemaId }, to: "/schemas/$schemaId" });
        } catch (error) {
          const message =
            typeof error === "object" &&
            error !== null &&
            "data" in error &&
            typeof error.data === "string"
              ? error.data
              : error instanceof Error
                ? error.message
                : "Failed to update schema.";
          toast.error(message);
          throw error;
        }
      }}
      saveLabel="Save Schema"
    />
  );
}
