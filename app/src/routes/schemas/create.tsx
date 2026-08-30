import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { SchemaId } from "@caden/json-cms";
import { SchemaEditor, DatasetImporter } from "@caden/json-cms/react/ui";
import { RouterButton } from "#/components/router-button";
import { Card, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { ArrowLeft, FilePlus2, Upload } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/schemas/create")({
  component: CreateDatasetPage,
});

type Mode = "choose" | "schema" | "import";

function CreateDatasetPage() {
  const [mode, setMode] = useState<Mode>("choose");

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        {mode === "choose" ? (
          <RouterButton variant="ghost" to="/schemas" className="mb-4 -ml-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Schemas
          </RouterButton>
        ) : (
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="mb-4 -ml-2 inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Choose a different start
          </button>
        )}
        <h1 className="text-3xl font-bold text-primary mb-1">Create dataset</h1>
        <p className="text-muted-foreground">
          {mode === "import"
            ? "Import a JSON or JSONL file to auto-generate a schema and pre-populate the dataset."
            : mode === "schema"
              ? "Build your JSON schema visually or in code, then test it against sample data."
              : "Start from an empty schema, or import data to generate one automatically."}
        </p>
      </div>

      {mode === "choose" && <PathChooser onChoose={setMode} />}
      {mode === "schema" && <SchemaFirst />}
      {mode === "import" && <ImportFirst />}
    </main>
  );
}

function PathChooser({ onChoose }: { onChoose: (mode: Mode) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 max-w-3xl">
      <button type="button" onClick={() => onChoose("schema")} className="text-left">
        <Card className="h-full transition-shadow hover:shadow-md">
          <CardHeader>
            <FilePlus2 className="h-6 w-6 text-primary mb-2" />
            <CardTitle>Start from schema</CardTitle>
            <CardDescription>
              Define the shape of an empty dataset with the visual or code editor. Optionally upload a
              JSON Schema to start from.
            </CardDescription>
          </CardHeader>
        </Card>
      </button>
      <button type="button" onClick={() => onChoose("import")} className="text-left">
        <Card className="h-full transition-shadow hover:shadow-md">
          <CardHeader>
            <Upload className="h-6 w-6 text-primary mb-2" />
            <CardTitle>Import data</CardTitle>
            <CardDescription>
              Upload a <code>.json</code> or <code>.jsonl</code> file. We read every row to infer a
              matching schema and pre-populate the dataset.
            </CardDescription>
          </CardHeader>
        </Card>
      </button>
    </div>
  );
}

function SchemaFirst() {
  const navigate = useNavigate();
  const createSchema = useMutation(api.schemas.create);

  return (
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
            err != null && typeof err === "object" && "data" in err && typeof err.data === "string"
              ? err.data
              : err instanceof Error
                ? err.message
                : "Failed to create schema.";
          toast.error(message);
          throw err;
        }
      }}
      saveLabel="Create schema"
    />
  );
}

function ImportFirst() {
  const navigate = useNavigate();
  const createSchema = useMutation(api.schemas.create);
  const generateUploadUrl = useMutation(api.imports.generateUploadUrl);
  const startImport = useMutation(api.imports.startImport);

  const [importId, setImportId] = useState<string | undefined>(undefined);
  const [schemaId, setSchemaId] = useState<SchemaId | undefined>(undefined);

  const status = useQuery(api.imports.getImportStatus, importId ? { importId } : "skip");

  // Navigate to the new dataset once the import finishes.
  useEffect(() => {
    if (status?.status === "completed" && schemaId) {
      toast.success("Dataset imported!");
      void navigate({ to: "/schemas/$schemaId", params: { schemaId } });
    }
  }, [status?.status, schemaId, navigate]);

  const progress = status
    ? {
        status: status.status,
        processed: status.processed,
        total: status.total,
        error: status.error,
      }
    : null;

  return (
    <DatasetImporter
      progress={progress}
      onImport={async (_json, parsedSchema, _uiJson, parsedUiSchema, rows) => {
        const newSchemaId = (await createSchema({
          schema: parsedSchema,
          uiSchema: Object.keys(parsedUiSchema).length > 0 ? parsedUiSchema : undefined,
        })) as SchemaId;
        const uploadUrl = await generateUploadUrl({});
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rows),
        });
        if (!res.ok) throw new Error("Failed to upload import data.");
        const { storageId } = (await res.json()) as { storageId: string };
        const newImportId = await startImport({
          schemaId: newSchemaId,
          storageId,
          total: rows.length,
        });
        setSchemaId(newSchemaId);
        setImportId(newImportId);
      }}
    />
  );
}
