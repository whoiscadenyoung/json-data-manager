import type { GeometryType } from "@caden/json-cms/react";
import { SchemaEditor } from "@caden/json-cms/react/ui";
import type {
  DatasetImportOptions,
  DatasetImportProgress,
  DatasetImportRow,
} from "@caden/json-cms/react/ui";
import { DatasetImporter } from "@caden/json-cms/react/ui";
import type { DatasetImporterPhase } from "@caden/json-cms/react/ui";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@caden/ui/components/card";
import { cn } from "@caden/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle, Database, FilePlus2, ListPlus, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { useProjectShell, VIEWER_REASON } from "#/features/publishing";
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
 * The flow reads as three explicit steps — choose a method, prepare & review
 * the data, then the import itself — with the importer's phase (dropzone →
 * review → importing) driving the second/third boundary, and a dropped
 * batch keeping the flow open between files (`remainingInQueue`). Same two
 * start points as the original flow — schema first, or import a file — and
 * every write rides the `#/lib/store/*` modules: the datasets row is a
 * Postgres insert, the rows stream through `import_entries` in ~1.5 MB
 * chunks with an `imports` history row per attempt, and the original file is
 * retained in the `source-files` bucket.
 *
 * Deliberately absent here still: the tile-archive scheduling (stage 2 owns
 * the map path).
 */

type Mode = "choose" | "schema" | "import";

/** The zero-based step the stepper shows as current, derived from the mode + the importer's live phase. */
function currentStep(mode: Mode, phase: DatasetImporterPhase | undefined): 0 | 1 | 2 {
  if (mode === "choose") {
    return 0;
  }
  if (mode === "schema") {
    return 1;
  }
  return phase === "importing" ? 2 : 1;
}

/** The three-step header: Choose method → Prepare & review → Import. */
function ImportFlowSteps({ current }: { current: 0 | 1 | 2 }) {
  const steps = ["Choose method", "Prepare & review", "Import"];
  return (
    <ol aria-label="Import progress" className="mb-6 flex flex-wrap items-center gap-2">
      {steps.map((label, index) => (
        <li className="flex items-center gap-2" key={label}>
          <span
            aria-current={index === current ? "step" : undefined}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
              index === current
                ? "bg-primary text-primary-foreground"
                : index < current
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {index < current ? <CheckCircle className="h-3.5 w-3.5" /> : index + 1}
          </span>
          <span
            className={cn(
              "text-sm",
              index === current ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {index < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-8 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

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
  const [mode, setMode] = useState<Mode>("choose"),
    // The importer's live phase — the second/third step boundary rides it.
    [importerPhase, setImporterPhase] = useState<DatasetImporterPhase | undefined>(undefined);

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
            Back to add options
          </button>
        )}
        <h1 className="text-3xl font-bold text-primary mb-1">Add dataset</h1>
        <p className="text-muted-foreground">
          Add data to this project — create a new dataset (it lands as an owned draft visible to the
          project's members until it publishes) or bind an existing one by reference.
        </p>
      </div>

      <ImportFlowSteps current={currentStep(mode, importerPhase)} />
      {mode === "choose" && <AddOptions projectId={projectId} onChoose={setMode} />}
      {mode === "schema" && <SchemaFirst projectId={projectId} />}
      {mode === "import" && <ImportFirst onPhaseChange={setImporterPhase} projectId={projectId} />}
    </main>
  );
}

/** The add-dataset chooser: create new (scratch / import) or bind an existing dataset of the project. */
function AddOptions({
  onChoose,
  projectId,
}: {
  onChoose: (mode: Mode) => void;
  projectId: string;
}) {
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <section aria-label="Create new">
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Create new
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            aria-label="Start from scratch"
            onClick={() => {
              onChoose("schema");
            }}
            className="text-left"
          >
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <FilePlus2 className="h-6 w-6 text-primary mb-2" />
                <CardTitle>Start from scratch</CardTitle>
                <CardDescription>
                  Define the shape of an empty dataset with the visual or code editor. Optionally
                  upload a JSON Schema to start from.
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
                  Upload a JSON, CSV, or Excel file. Every row is read to infer a matching schema;
                  several files at once import as a batch, one review each.
                </CardDescription>
              </CardHeader>
            </Card>
          </button>
        </div>
      </section>
      <ExistingDatasetsSection projectId={projectId} />
    </div>
  );
}

/** The project's dataset memberships, with "Add existing" binding a dataset from elsewhere by reference (nothing is copied). */
function ExistingDatasetsSection({ projectId }: { projectId: string }) {
  const shell = useProjectShell(),
    datasets = useQuery(datasetsStore.listQueryOptions()).data,
    titleById = new globalThis.Map((datasets ?? []).map((dataset) => [dataset.id, dataset])),
    rows = shell.catalog
      .filter((row) => row.artifact.artifactKind === "dataset")
      .flatMap((row) => {
        const dataset = titleById.get(row.artifact.artifactId);
        return dataset === undefined ? [] : [{ dataset, view: dataset.kind === "view" }];
      }),
    datasetRows = rows.filter(({ view }) => !view);
  return (
    <section aria-label="Existing datasets">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Existing datasets{" "}
          <span className="font-normal normal-case">({datasetRows.length} in this project)</span>
        </h2>
        <Button
          disabled={!shell.canEdit}
          onClick={shell.openAdd}
          size="sm"
          title={shell.canEdit ? undefined : VIEWER_REASON}
          type="button"
          variant="outline"
        >
          <ListPlus className="mr-1 h-3.5 w-3.5" />
          Add existing
        </Button>
      </div>
      {datasetRows.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          This project has no datasets yet — create one above, or add an existing one by reference.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {datasetRows.map(({ dataset }) => (
            <Link
              className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-2.5 text-sm hover:bg-muted/50"
              key={dataset.id}
              params={{ projectId, schemaId: dataset.id }}
              to="/projects/$projectId/datasets/$schemaId"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{dataset.title}</span>
                <Badge variant="outline">{dataset.kind}</Badge>
                {dataset.lifecycle === "draft" && <Badge variant="secondary">draft</Badge>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">Open</span>
            </Link>
          ))}
        </div>
      )}
    </section>
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

/**
 * The retained original file (§10 step 4) — uploaded before the row chunks
 * so a failed retention aborts before any row lands. A retention failure
 * means NOTHING landed: the half-created empty draft is removed here (the
 * owned binding cascades with it) instead of waiting for a Discard the user
 * may never press — leaving the page used to orphan it (#274). Throws the
 * user-facing error; `onDraftGone` tells the caller the dataset id is spent.
 */
async function retainSourceFile(
  datasetId: string,
  file: File,
  onDraftGone: () => void,
): Promise<void> {
  try {
    await datasetsStore.uploadSourceFile({ datasetId, file });
  } catch (uploadError) {
    let removed = true;
    try {
      await datasetsStore.remove({ datasetId });
    } catch {
      removed = false;
    }
    onDraftGone();
    throw new Error(
      `The import failed while retaining the source file: ${errorMessage(uploadError, "the upload was refused")}. No rows were imported${removed ? " and the empty draft was removed" : " — the empty draft could not be removed automatically, discard it from the project's catalog"}. Check the file size against the storage cap and retry.`,
      { cause: uploadError },
    );
  }
}

function ImportFirst({
  onPhaseChange,
  projectId,
}: {
  /** The importer's live phase (dropzone → review → importing) — drives the page stepper. */
  onPhaseChange: (phase: DatasetImporterPhase) => void;
  projectId: string;
}) {
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

  // Leaves the flow for the project page — the single-file success path and
  // the batch card's "Back to project".
  async function leaveFlow() {
    await navigate({ params: { projectId }, to: "/projects/$projectId" });
  }

  return (
    <DatasetImporter
      progress={progress}
      onFinish={() => {
        void leaveFlow();
      }}
      onResetProgress={() => {
        setProgress(null);
      }}
      onPhaseChange={onPhaseChange}
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
          await leaveFlow();
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
          await leaveFlow();
        },
        // Keep the (draft) dataset and leave the flow.
        onBack: () => {
          void leaveFlow();
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
        context,
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
          // chunks so a failed retention aborts before any row lands.
          if (options.sourceFile !== null) {
            await retainSourceFile(newDatasetId, options.sourceFile, () => {
              setDatasetId(undefined);
            });
          }
          await runImport(newDatasetId, rows, options);
          void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
          void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
          if (context.remainingInQueue > 0) {
            // A batch keeps the flow open — the importer's completed card
            // offers the next file; navigating away here would strand it.
            toast.success(
              `Imported ${context.fileName} — ${context.remainingInQueue} file${context.remainingInQueue === 1 ? "" : "s"} still queued.`,
            );
            return;
          }
          toast.success("Dataset imported into the project as an owned draft.");
          await leaveFlow();
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
