import type { GeometryType } from "@caden/json-cms/react";
import { SchemaEditor } from "@caden/json-cms/react/ui";
import type {
  DatasetImportOptions,
  DatasetImportProgress,
  DatasetImportRow,
} from "@caden/json-cms/react/ui";
import { DatasetImporter } from "@caden/json-cms/react/ui";
import { Card, CardDescription, CardHeader, CardTitle } from "@caden/ui/components/card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FilePlus2, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import * as entriesStore from "@/lib/store/entries";

import { runPgImport } from "../lib/pg-import-pipeline";

/**
 * The create/import flow's Postgres edition (design §10 + the §14.1
 * transitional rule: from stage 1, new datasets are Postgres-native). Same
 * two entry points as the Convex flow — start from schema, or import a file
 * (`DatasetImporter`'s client-side `@caden/importers` parse is unchanged) —
 * but every write rides the `#/lib/store/*` modules: the datasets row is a
 * Postgres insert, the rows stream through `import_entries` in ~1.5 MB
 * chunks with an `imports` history row per attempt, and the original file is
 * retained in the `source-files` bucket.
 *
 * Deliberately absent here: the in-project variant (projects don't exist on
 * Postgres until stage 4 — the Convex route serves it) and the tile-archive
 * scheduling (stage 2 owns the map path).
 */

type Mode = "choose" | "schema" | "import";

/** The create args both paths send — the store's `create` arg set. The import path passes `lifecycle: "draft"` (issue #129): the dataset is born invisible to everyone but its creator and flips to published only when `markImportComplete` runs. */
function createArgs(
  datasetKind: "standard" | "geospatial",
  geometryType: GeometryType | undefined,
  schema: object,
  simplifyGeometry: boolean | undefined,
  lifecycle?: "draft",
): datasetsStore.CreateDatasetArgs {
  return {
    geometryType: datasetKind === "geospatial" ? geometryType : undefined,
    kind: datasetKind === "geospatial" ? "geospatial" : undefined,
    lifecycle,
    schema,
    simplifyGeometry: datasetKind === "geospatial" ? simplifyGeometry : undefined,
  };
}

/**
 * The datasets the schema editor's reference-field picker lists: the
 * Postgres catalog's full rows (the `pg:datasets` list projection, which
 * carries each dataset's `jsonSchema`). The picker's original Convex
 * catalog read — the stage-1 transitional split that predated the PG
 * browser — is archived with the stage-7 disconnect (issue #206); a fresh
 * dataset's reference fields target Postgres datasets.
 */
function useAvailableDatasets(): Array<{ id: string; schema: unknown; title: string }> {
  const datasets = useQuery(datasetsStore.listQueryOptions()).data;
  return (datasets ?? []).map((row) => ({ id: row.id, schema: row.jsonSchema, title: row.title }));
}

export function PostgresCreateDatasetPage() {
  const [mode, setMode] = useState<Mode>("choose");

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        {mode === "choose" ? (
          <RouterButton variant="ghost" to="/datasets" className="mb-4 -ml-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Datasets
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
            ? "Import a JSON, CSV, or Excel file to auto-generate a schema and pre-populate the dataset."
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
              Upload a JSON, CSV, or Excel file. We read every row to infer a matching schema and
              pre-populate the dataset.
            </CardDescription>
          </CardHeader>
        </Card>
      </button>
    </div>
  );
}

function SchemaFirst() {
  const navigate = useNavigate(),
    queryClient = useQueryClient(),
    availableDatasets = useAvailableDatasets(),
    [datasetKind, setDatasetKind] = useState<"standard" | "geospatial">("standard"),
    [geometryType, setGeometryType] = useState<GeometryType | undefined>(undefined);

  return (
    <SchemaEditor
      availableDatasets={availableDatasets}
      datasetKind={datasetKind}
      onDatasetKindChange={setDatasetKind}
      geometryType={geometryType}
      onGeometryTypeChange={setGeometryType}
      onSave={async (_json, parsed, _uiSchemaJson, _uiSchemaParsed) => {
        try {
          const datasetId = await datasetsStore.create(
            createArgs(datasetKind, geometryType, parsed, undefined),
          );
          void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
          toast.success("Dataset created!");
          await navigate({ params: { schemaId: datasetId }, to: "/datasets/$schemaId" });
        } catch (error) {
          toast.error(errorMessage(error, "Failed to create schema."));
          throw error;
        }
      }}
      saveLabel="Create schema"
    />
  );
}

function ImportFirst() {
  const navigate = useNavigate(),
    queryClient = useQueryClient(),
    [datasetId, setDatasetId] = useState<string | undefined>(),
    // The attempt's live progress — advanced locally per chunk (the
    // importer's chips), while the `imports` row carries the same state
    // durably server-side (`import_entries` bumps `processed` per chunk).
    // The completed state only arrives after the LAST chunk landed AND the
    // row closed — never on a query's `isLoading`.
    [progress, setProgress] = useState<DatasetImportProgress | null>(null);

  // The full pipeline for one attempt against an already-created dataset —
  // shared by the first import and a failed-import Retry (issue #129 parity).
  // Throws on failure; `runPgImport` closes its `imports` row as `failed`
  // with the error before propagating.
  async function runImport(
    targetDatasetId: string,
    rows: DatasetImportRow[],
    options: DatasetImportOptions,
  ) {
    const result = await runPgImport({
      datasetId: targetDatasetId,
      onProgress: setProgress,
      options,
      rows,
    });
    void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
    void queryClient.invalidateQueries({ queryKey: ["pg:entries"] });
    setProgress({
      processed: result.inserted,
      skipped: 0,
      status: "completed",
      total: rows.length,
    });
  }

  async function navigateToDataset(targetDatasetId: string) {
    toast.success("Dataset imported!");
    await navigate({ params: { schemaId: targetDatasetId }, to: "/datasets/$schemaId" });
  }

  return (
    <DatasetImporter
      progress={progress}
      recovery={{
        // Re-import into the SAME dataset: whatever partial rows the failed
        // attempt committed are cleared first, then the full file runs again
        // (issue #129). The dataset keeps its schema and kind — no duplicate
        // catalog entries. A fresh `imports` row opens per attempt.
        onRetry: async (rows, options) => {
          if (datasetId === undefined) {
            throw new Error("This dataset is gone — start a new import instead.");
          }
          await entriesStore.clearDatasetRows({ datasetId });
          setProgress(null);
          await runImport(datasetId, rows, options);
          // The first attempt failed before `markImportComplete`, so the draft
          // is still draft — the successful retry is the import completing
          // (issue #129): publish it, or it stays invisible to its creator.
          await datasetsStore.markImportComplete({ datasetId });
          await navigateToDataset(datasetId);
        },
        // Delete the dataset the failed import created — nothing left behind
        // (the cascade removes its entries, geometries, and import rows).
        onDiscard: async () => {
          if (datasetId !== undefined) {
            await datasetsStore.remove({ datasetId });
            void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
          }
          toast.success("Draft dataset discarded.");
          await navigate({ to: "/datasets" });
          setDatasetId(undefined);
          setProgress(null);
        },
        // Keep the (draft) dataset and leave the flow.
        onBack: () => {
          void navigate({ to: "/datasets" });
        },
      }}
      onImport={async (
        _json,
        parsedSchema,
        _uiJson,
        _parsedUiSchema,
        rows,
        kind,
        geometryType,
        options,
      ) => {
        // The dataset is created as a lifecycle DRAFT and flips to published
        // only when the import completes (issue #129) — a failed or in-flight
        // import leaves an invisible draft for Retry/Discard instead of an
        // empty, published dataset in the catalog.
        setProgress(null);
        const newDatasetId = await datasetsStore.create(
          createArgs(
            kind,
            geometryType,
            parsedSchema,
            kind === "geospatial" ? options.simplifyGeometry : undefined,
            "draft",
          ),
        );
        setDatasetId(newDatasetId);
        try {
          // The retained original file (§10 step 4) — uploaded before the
          // chunks so a failed retention aborts before any row lands.
          if (options.sourceFile !== null) {
            await datasetsStore.uploadSourceFile({
              datasetId: newDatasetId,
              file: options.sourceFile,
            });
          }
          await runImport(newDatasetId, rows, options);
          // The standalone draft becomes catalog-visible only now that its
          // import completed (issue #129).
          await datasetsStore.markImportComplete({ datasetId: newDatasetId });
          void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
          await navigateToDataset(newDatasetId);
        } catch (error) {
          // `runPgImport` already closed its `imports` row as failed with the
          // error text; this catch is the UI half — the progress card shows
          // the failure with the Retry/Discard/Back actions.
          const message = errorMessage(error, "The import failed.");
          setProgress((prev) => ({
            error: message,
            processed: prev === null ? 0 : prev.processed,
            skipped: 0,
            status: "failed",
            total: rows.length,
          }));
        }
      }}
    />
  );
}
