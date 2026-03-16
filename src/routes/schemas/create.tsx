import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { RouterButton } from "#/components/router-button";
import { SchemaEditor } from "#/components/schema-editor/schema-editor";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/schemas/create")({
  component: CreateSchemaPage,
});

function CreateSchemaPage() {
  const navigate = useNavigate();
  const createSchema = useMutation(api.schemas.create);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        <RouterButton variant="ghost" to="/schemas" className="mb-4 -ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Schemas
        </RouterButton>
        <h1 className="text-3xl font-bold text-primary mb-1">Create Schema</h1>
        <p className="text-muted-foreground">
          Build your JSON schema visually or in code, then test it against sample data.
        </p>
      </div>

      <SchemaEditor
        onSave={async (_json, parsed, _uiSchemaJson, uiSchemaParsed) => {
          try {
            const schemaId = await createSchema({
              schema: parsed,
              uiSchema: Object.keys(uiSchemaParsed).length > 0 ? uiSchemaParsed : undefined,
            });
            toast.success("Schema created!");
            await navigate({ to: "/schemas/$schemaId", params: { schemaId } });
          } catch (err) {
            const message =
              err != null &&
              typeof err === "object" &&
              "data" in err &&
              typeof err.data === "string"
                ? err.data
                : err instanceof Error
                  ? err.message
                  : "Failed to create schema.";
            toast.error(message);
            throw err;
          }
        }}
        saveLabel="Create Schema"
      />
    </main>
  );
}
