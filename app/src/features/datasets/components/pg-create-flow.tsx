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
import * as projectsStore from "@/lib/store/projects";

import { runPgImport } from "../lib/pg-import-pipeline";

/**
 * The create/import flow's Postgres edition (design §10). One entry point
 * since #262 — the PROJECT-BOUND variant (ADR 0018): explorers never create
 * outside projects, so the flow always mounts with a `projectId` and the
 * dataset is born an OWNED DRAFT of that project — lifecycle stays 'draft'
 * (no markImportComplete flip: the import completing is not a publish; the
 * dataset publishes through the normal publish surfaces) and the membership
 * row binds it to the project in the same flow, so its members see it and
 * its editors work it (the ADR 0017 deferred clause, member-visible owned
 * drafts). Discarding a failed attempt removes the membership with the
 * dataset (the artifact reference is a text id; no FK would clean it up).
 *
 * Same two start points as the original flow — schema first, or import a
 * file (`DatasetImporter`'s client-side `@caden/importers` parse is
 * unchanged) — and every write rides the `#/lib/store/*` modules: the
 * datasets row is a Postgres insert, the rows stream through
 * `import_entries` in ~1.5 MB chunks with an `imports` history row per
 * attempt, and the original file is retained in the `source-files` bucket.
 *
 * Deliberately absent here still: the tile-archive scheduling (stage 2 owns
 * the map path).
 */

type Mode = "choose" | "schema" | "import";

/** The create args both paths send — the store's `create` arg set. Every dataset this flow births is a draft (the owned-draft rule; ADR 0018). */
function createArgs(
  datasetKind: "standard" | "geospatial",
  geometryType: GeometryType | undefined,
  schema: object,
  simplifyGeometry: boolean | undefined,
): datasetsStore.CreateDatasetArgs {
  return {
    geometryType: datasetKind === "geospatial" ? geometryType : undefined,
    kind: datasetKind === "geospatial" ? "geospatial" : undefined,
    lifecycle: "draft",
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

export function PostgresCreateDatasetPage({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<Mode>("choose");

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        {mode === "choose" ? (
          <RouterButton
            params={{ projectId }}
            variant="ghost"
            to="/projects/$projectId"
            className="mb-4 -ml-2"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Project
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
          The dataset lands in this project as an owned draft — visible to the project's members
          until it publishes.
        </p>
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

function SchemaFirst({ projectId }: { projectId: string }) {
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
          // The owned-draft path (ADR 0018): draft lifecycle + the
          // membership row binding it to the project.
          const datasetId = await datasetsStore.create(
            createArgs(datasetKind, geometryType, parsed, undefined),
          );
          await bindOwnedDraft(datasetId, projectId);
          void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
          void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
          toast.success("Dataset created in the project as an owned draft.");
          await navigate({ params: { projectId }, to: "/projects/$projectId" });
        } catch (error) {
          toast.error(errorMessage(error, "Failed to create schema."));
          throw error;
        }
      }}
      saveLabel="Create schema"
    />
  );
}

/** Binds a freshly-created in-project dataset as the project's OWNED artifact (ADR 0018 — the membership row IS the sharing). Throws through on failure: the draft without its binding would be an invisible orphan. */
async function bindOwnedDraft(datasetId: string, projectId: string): Promise<void> {
  const outcome = await projectsStore.addArtifact({
    artifactId: datasetId,
    artifactKind: "dataset",
    projectId,
    role: "owned",
  });
  if (outcome.artifact === null) {
    throw new Error("The project binding didn't land — you may not have access.");
  }
}

function ImportFirst({ projectId }: { projectId: string }) {
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

  async function navigateToDataset() {
    toast.success("Dataset imported into the project as an owned draft.");
    await navigate({ params: { projectId }, to: "/projects/$projectId" });
  }

  return (
    <DatasetImporter
      progress={progress}
      recovery={{
        // Re-import into the SAME dataset: whatever partial rows the failed
        // attempt committed are cleared first, then the full file runs again
        // (issue #129). The dataset keeps its schema and kind — no duplicate
        // catalog entries. A fresh `imports` row opens per attempt. The
        // draft stays a draft (the owned-draft rule; ADR 0018) — project
        // members see it through the binding, and publishing happens
        // through the publish surfaces.
        onRetry: async (rows, options) => {
          if (datasetId === undefined) {
            throw new Error("This dataset is gone — start a new import instead.");
          }
          await entriesStore.clearDatasetRows({ datasetId });
          setProgress(null);
          await runImport(datasetId, rows, options);
          await navigateToDataset();
        },
        // Delete the dataset the failed import created — nothing left behind
        // (the cascade removes its entries, geometries, and import rows).
        // The owned membership goes first: the artifact reference is a text
        // id no FK reaches, so an unremoved binding would dangle.
        onDiscard: async () => {
          if (datasetId !== undefined) {
            await projectsStore.removeArtifact({ artifactId: datasetId, projectId });
            await datasetsStore.remove({ datasetId });
            void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
            void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
          }
          toast.success("Draft dataset discarded.");
          setDatasetId(undefined);
          setProgress(null);
          await navigate({ params: { projectId }, to: "/projects/$projectId" });
        },
        // Keep the (draft) dataset and leave the flow.
        onBack: () => {
          void navigate({ params: { projectId }, to: "/projects/$projectId" });
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
        // The dataset is created as a lifecycle DRAFT and binds as the
        // project's OWNED artifact (ADR 0018) — it NEVER auto-flips: the
        // owned draft is member-visible through the binding, and publishing
        // stays an explicit act.
        setProgress(null);
        const newDatasetId = await datasetsStore.create(
          createArgs(
            kind,
            geometryType,
            parsedSchema,
            kind === "geospatial" ? options.simplifyGeometry : undefined,
          ),
        );
        setDatasetId(newDatasetId);
        try {
          // The project binding first — an owned draft is only member-
          // visible through it, and a failure here should abort before any
          // row lands (the file-retention ordering precedent).
          await bindOwnedDraft(newDatasetId, projectId);
          // The retained original file (§10 step 4) — uploaded before the
          // chunks so a failed retention aborts before any row lands. A
          // retention failure means NOTHING landed: the half-created empty
          // draft is removed here (the owned binding cascades with it)
          // instead of waiting for a Discard the user may never press —
          // leaving the page used to orphan it (#274).
          if (options.sourceFile !== null) {
            try {
              await datasetsStore.uploadSourceFile({
                datasetId: newDatasetId,
                file: options.sourceFile,
              });
            } catch (uploadError) {
              let removed = true;
              try {
                await datasetsStore.remove({ datasetId: newDatasetId });
              } catch {
                removed = false;
              }
              setDatasetId(undefined);
              throw new Error(
                `The import failed while retaining the source file: ${errorMessage(uploadError, "the upload was refused")}. No rows were imported${removed ? " and the empty draft was removed" : " — the empty draft could not be removed automatically, discard it from the project's catalog"}. Check the file size against the storage cap and retry.`,
              );
            }
          }
          await runImport(newDatasetId, rows, options);
          void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
          void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
          await navigateToDataset();
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
