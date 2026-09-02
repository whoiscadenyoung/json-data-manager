import { DatasetImporter, SchemaEditor } from "@caden/json-cms/react/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, FilePlus2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { Card, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";

import { api } from "../../../convex/_generated/api";

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
            onClick={() => {
              setMode("choose");
            }}
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
      <button
        type="button"
        aria-label="Start from schema"
        onClick={() => {
          onChoose("schema");
        }}
        className="text-left"
      >
        <Card className="h-full transition-shadow hover:shadow-md">
          <CardHeader>
            <FilePlus2 className="h-6 w-6 text-primary mb-2" />
            <CardTitle>Start from schema</CardTitle>
            <CardDescription>
              Define the shape of an empty dataset with the visual or code editor. Optionally upload
              a JSON Schema to start from.
            </CardDescription>
          </CardHeader>
        </Card>
      </button>
      <button
        type="button"
        aria-label="Import data"
        onClick={() => {
          onChoose("import");
        }}
        className="text-left"
      >
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
  const navigate = useNavigate(),
    createSchema = useMutation(api.schemas.create);

  return (
    <SchemaEditor
      onSave={async (_json, parsed, _uiSchemaJson, uiSchemaParsed) => {
        try {
          const schemaId = await createSchema({
            schema: parsed,
            uiSchema: Object.keys(uiSchemaParsed).length > 0 ? uiSchemaParsed : undefined,
          });
          toast.success("Schema created!");
          await navigate({ params: { schemaId }, to: "/schemas/$schemaId" });
        } catch (error) {
          const message =
            typeof error === "object" &&
            error !== null &&
            "data" in error &&
            typeof error.data === "string"
              ? error.data
              : error instanceof Error
                ? error.message
                : "Failed to create schema.";
          toast.error(message);
          throw error;
        }
      }}
      saveLabel="Create schema"
    />
  );
}

function ImportFirst() {
  const navigate = useNavigate(),
    createSchema = useMutation(api.schemas.create),
    generateUploadUrl = useMutation(api.imports.generateUploadUrl),
    startImport = useMutation(api.imports.startImport),
    [importId, setImportId] = useState<string | undefined>(),
    [schemaId, setSchemaId] = useState<string | undefined>(),
    status = useQuery(api.imports.getImportStatus, importId ? { importId } : "skip"),
    importStatus = status ? status.status : undefined;

  // Navigate to the new dataset once the import finishes.
  useEffect(() => {
    if (importStatus === "completed" && schemaId) {
      toast.success("Dataset imported!");
      void navigate({ params: { schemaId }, to: "/schemas/$schemaId" });
    }
  }, [importStatus, schemaId, navigate]);

  const progress = status
    ? {
        error: status.error,
        processed: status.processed,
        status: status.status,
        total: status.total,
      }
    : null;

  return (
    <DatasetImporter
      progress={progress}
      onImport={async (_json, parsedSchema, _uiJson, parsedUiSchema, rows) => {
        const newSchemaId = await createSchema({
            schema: parsedSchema,
            uiSchema: Object.keys(parsedUiSchema).length > 0 ? parsedUiSchema : undefined,
          }),
          uploadUrl = await generateUploadUrl({}),
          res = await fetch(uploadUrl, {
            body: JSON.stringify(rows),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
        if (!res.ok) {
          throw new Error("Failed to upload import data.");
        }
        const body: unknown = await res.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("storageId" in body) ||
          typeof body.storageId !== "string"
        ) {
          throw new Error("Import upload did not return a storageId.");
        }
        const storageId = body.storageId,
          newImportId = await startImport({
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
