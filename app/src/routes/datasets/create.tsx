import type { GeometryType } from "@caden/json-cms/react";
import { chunkRowsForImport } from "@caden/json-cms/react";
import { DatasetImporter, SchemaEditor } from "@caden/json-cms/react/ui";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { ArrowLeft, FilePlus2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { RouterButton } from "#/components/router-button";
import { Card, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { ensureMapTileArchive } from "#/lib/tile-archive";

import { api } from "../../../convex/_generated/api";

/**
 * `?projectId=` puts the page in the in-project variant (roadmap 7a, #102):
 * the dataset is created through `projects.createDraftDataset` — the host
 * mutation that lands the draft dataset and its project membership row in ONE
 * transaction, flagged `lifecycle: "draft"` (something the plain
 * `api.schemas.create` wrapper can never do — the wrapper deliberately omits
 * the lifecycle field). Import/create thus lands IN the project, part of the
 * flow, not a separate act (lifecycle §3). Absent, the page behaves exactly
 * as before.
 */
const createSearchSchema = z.object({
  projectId: z.string().optional(),
});

export const Route = createFileRoute("/datasets/create")({
  component: CreateDatasetPage,
  validateSearch: createSearchSchema,
});

type Mode = "choose" | "schema" | "import";

/** ConvexError / Error → user-facing message, for the failure toast. */
function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : "Failed to create schema.";
}

/**
 * The create args both paths send — the in-project variant spreads this and
 * adds `projectId`. The return annotation keeps the literal `kind` narrow (a
 * fresh object literal would otherwise widen it past the mutation's
 * validator type).
 */
function createArgs(
  datasetKind: "standard" | "geospatial",
  geometryType: GeometryType | undefined,
  schema: object,
  uiSchema: object | undefined,
  simplifyGeometry: boolean | undefined,
): {
  geometryType: GeometryType | undefined;
  kind: "geospatial" | undefined;
  schema: object;
  simplifyGeometry: boolean | undefined;
  uiSchema: object | undefined;
} {
  return {
    geometryType: datasetKind === "geospatial" ? geometryType : undefined,
    kind: datasetKind === "geospatial" ? "geospatial" : undefined,
    schema,
    simplifyGeometry,
    uiSchema,
  };
}

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function CreateDatasetPage() {
  const [mode, setMode] = useState<Mode>("choose"),
    { projectId } = Route.useSearch(),
    // The project's title, for the "creating in X" header line. The TanStack
    // bridge (not convex/react's useQuery) so a signed-out visit degrades to
    // hiding the title line + the submit toasts — the same handling the
    // projects pages use — instead of throwing to the router error boundary.
    // undefined data (query skipped) outside the in-project variant.
    projectQuery = useQuery({
      ...convexQuery(api.projects.get, projectId === undefined ? "skip" : { projectId }),
    });

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        {mode === "choose" ? (
          projectId === undefined ? (
            <RouterButton variant="ghost" to="/datasets" className="mb-4 -ml-2">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Datasets
            </RouterButton>
          ) : (
            <RouterButton
              variant="ghost"
              to="/projects/$projectId"
              params={{ projectId }}
              className="mb-4 -ml-2"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Project
            </RouterButton>
          )
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
            ? "Import a JSON, CSV, or Excel file to auto-generate a schema and pre-populate the dataset."
            : mode === "schema"
              ? "Build your JSON schema visually or in code, then test it against sample data."
              : "Start from an empty schema, or import data to generate one automatically."}
          {projectId !== undefined &&
            " Everything you create here lands in your project as a draft."}
        </p>
        {projectId !== undefined &&
          projectQuery.data !== undefined &&
          projectQuery.data !== null && (
            <p className="mt-1 text-sm text-muted-foreground">
              In project{" "}
              <span className="font-medium text-foreground">{projectQuery.data.project.title}</span>
            </p>
          )}
      </div>

      {mode === "choose" && <PathChooser onChoose={setMode} />}
      {mode === "schema" && <SchemaFirst projectId={projectId} />}
      {mode === "import" && <ImportFirst projectId={projectId} />}
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
              Upload a JSON, CSV, or Excel file. We read every row to infer a matching schema and
              pre-populate the dataset.
            </CardDescription>
          </CardHeader>
        </Card>
      </button>
    </div>
  );
}

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function SchemaFirst({ projectId }: { projectId?: string }) {
  const navigate = useNavigate(),
    createSchema = useMutation(api.schemas.create),
    createDraft = useMutation(api.projects.createDraftDataset),
    schemas = useQuery({ ...convexQuery(api.schemas.list, {}) }).data,
    availableDatasets = (schemas ?? []).map((s) => ({
      id: s._id,
      schema: s.schema,
      title: s.title,
    })),
    [datasetKind, setDatasetKind] = useState<"standard" | "geospatial">("standard"),
    [geometryType, setGeometryType] = useState<GeometryType | undefined>(undefined);

  return (
    <SchemaEditor
      availableDatasets={availableDatasets}
      datasetKind={datasetKind}
      onDatasetKindChange={setDatasetKind}
      geometryType={geometryType}
      onGeometryTypeChange={setGeometryType}
      onSave={async (_json, parsed, _uiSchemaJson, uiSchemaParsed) => {
        // The two create paths take the same shape; the in-project variant
        // adds `projectId` and lands the draft + membership atomically (see
        // the route's doc comment). The standalone path is the unchanged
        // wrapper.
        const args = createArgs(
          datasetKind,
          geometryType,
          parsed,
          Object.keys(uiSchemaParsed).length > 0 ? uiSchemaParsed : undefined,
          undefined,
        );
        try {
          const schemaId =
            projectId === undefined
              ? await createSchema(args)
              : await createDraft({ ...args, projectId });
          toast.success("Dataset created!");
          await navigate(
            projectId === undefined
              ? { params: { schemaId }, to: "/datasets/$schemaId" }
              : { params: { projectId }, to: "/projects/$projectId" },
          );
        } catch (error) {
          toast.error(errorMessage(error));
          throw error;
        }
      }}
      saveLabel="Create schema"
    />
  );
}

function ImportFirst({ projectId }: { projectId?: string }) {
  const navigate = useNavigate(),
    createSchema = useMutation(api.schemas.create),
    createDraft = useMutation(api.projects.createDraftDataset),
    generateUploadUrl = useMutation(api.imports.generateUploadUrl),
    startImport = useMutation(api.imports.startImport),
    [importId, setImportId] = useState<string | undefined>(),
    [schemaId, setSchemaId] = useState<string | undefined>(),
    status = useQuery({
      ...convexQuery(api.imports.getImportStatus, importId ? { importId } : "skip"),
    }).data,
    importStatus = status ? status.status : undefined;

  // Navigate to the new dataset (or back to the project, in the in-project
  // variant) once the import finishes. The tile archive rebuild happens
  // server-side — nothing client-side can hook the workflow — so an import
  // success just skips the manager's debounce window; the mounted manager
  // catches the version bumps either way.
  useEffect(() => {
    if (importStatus === "completed" && schemaId) {
      ensureMapTileArchive(schemaId);
      toast.success("Dataset imported!");
      void navigate(
        projectId === undefined
          ? { params: { schemaId }, to: "/datasets/$schemaId" }
          : { params: { projectId }, to: "/projects/$projectId" },
      );
    }
  }, [importStatus, schemaId, navigate, projectId]);

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
      // oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
      onImport={async (
        _json,
        parsedSchema,
        _uiJson,
        parsedUiSchema,
        rows,
        kind,
        geometryType,
        options,
      ) => {
        // The two create paths take the same shape; the in-project variant
        // adds `projectId` and lands the draft + membership atomically (see
        // the route's doc comment). The upload/startImport steps below are
        // the SAME ingest flow either way — drafts are ordinary component
        // datasets to it.
        const args = createArgs(
          kind,
          geometryType,
          parsedSchema,
          Object.keys(parsedUiSchema).length > 0 ? parsedUiSchema : undefined,
          kind === "geospatial" ? options.simplifyGeometry : undefined,
        );
        const newSchemaId =
          projectId === undefined
            ? await createSchema(args)
            : await createDraft({ ...args, projectId });

        // Split client-side (we already have every row parsed here) and
        // upload each chunk to its own blob — never one giant upload. See
        // `chunkRowsForImport`'s doc comment for why: Convex components
        // can't use the Node runtime, so no server-side step could safely
        // parse one large upload in a single pass. Each upload rides the
        // token its URL was issued under (`uploadId`) — `startImport`
        // rejects any blob without one, issued for THIS dataset (issue
        // #131).
        const chunks = chunkRowsForImport(rows),
          uploaded: Array<{ storageId: string; uploadId: string }> = [];
        for (const chunk of chunks) {
          // oxlint-disable-next-line no-await-in-loop
          const { storageUrl, uploadId } = await generateUploadUrl({ scope: newSchemaId }),
            // oxlint-disable-next-line no-await-in-loop
            res = await fetch(storageUrl, {
              body: JSON.stringify(chunk),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            });
          if (!res.ok) {
            throw new Error("Failed to upload import data.");
          }
          // oxlint-disable-next-line no-await-in-loop
          const body: unknown = await res.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("storageId" in body) ||
            typeof body.storageId !== "string"
          ) {
            throw new Error("Import upload did not return a storageId.");
          }
          uploaded.push({ storageId: body.storageId, uploadId });
        }

        // Retain the original file as its own blob so it stays
        // re-downloadable from the dataset page — deliberately NOT in
        // `uploaded` (the import workflow deletes chunk blobs as it
        // consumes them; this one must survive).
        let sourceFile:
          | { name: string; size: number; storageId: string; uploadId: string }
          | undefined;
        if (options.sourceFile) {
          const { storageUrl, uploadId } = await generateUploadUrl({ scope: newSchemaId }),
            res = await fetch(storageUrl, {
              body: options.sourceFile,
              headers: {
                "Content-Type": options.sourceFile.type || "application/octet-stream",
              },
              method: "POST",
            });
          if (!res.ok) {
            throw new Error("Failed to upload the original file.");
          }
          const body: unknown = await res.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("storageId" in body) ||
            typeof body.storageId !== "string"
          ) {
            throw new Error("Original-file upload did not return a storageId.");
          }
          sourceFile = {
            name: options.sourceFile.name,
            size: options.sourceFile.size,
            storageId: body.storageId,
            uploadId,
          };
        }

        const newImportId = await startImport({
          schemaId: newSchemaId,
          sourceFile,
          chunks: uploaded,
          total: rows.length,
        });
        setSchemaId(newSchemaId);
        setImportId(newImportId);
      }}
    />
  );
}
