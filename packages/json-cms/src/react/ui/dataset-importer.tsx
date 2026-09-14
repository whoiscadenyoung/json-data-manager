import { AlertTriangle, CheckCircle, FileJson, Loader2, Upload, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import type { GeometryType } from "../../shared/geojson/types.js";
import { looksLikeGeoJson, parseGeoJsonFeatures } from "../lib/geojson-import.js";
import { inferSchemaFromData } from "../lib/infer-schema.js";
import { parseDataRows } from "../lib/parse-data.js";
import { cn } from "./lib/utils.js";
import { Button } from "./primitives/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./primitives/card.js";
import { SchemaEditor } from "./schema-editor.js";

/** Live import status, mirrored from the backend (see `ImportStatusDoc`). */
export interface DatasetImportProgress {
  status: "pending" | "processing" | "completed" | "failed";
  processed: number;
  total: number;
  error?: string;
}

/** One row headed for `useDatasetImport().start` — matches `StartDatasetImportArgs.rows`. */
export interface DatasetImportRow {
  data: unknown;
  geometry?: unknown;
}

export interface DatasetImporterProps {
  /**
   * Create the schema + entries from the reviewed schema and imported rows.
   * Wire this to `useDatasetImport().start` in the app.
   */
  onImport: (
    schemaJson: string,
    parsedSchema: object,
    uiSchemaJson: string,
    parsedUiSchema: object,
    rows: DatasetImportRow[],
    kind: "standard" | "geospatial",
    geometryType: GeometryType | undefined,
  ) => Promise<void>;
  /** Live progress of the running import (drives the progress bar). */
  progress?: DatasetImportProgress | null;
  saveLabel?: string;
}

const ACCEPT = ".json,.jsonl,.ndjson,application/json";

function isSupportedFile(file: File): boolean {
  return (
    /\.(json|jsonl|ndjson)$/i.test(file.name) ||
    file.type === "application/json" ||
    file.type === "application/x-ndjson"
  );
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read file"));
    });
    reader.readAsText(file);
  });
}

/** First file from an input's FileList, or undefined. */
function firstFile(list: FileList | null): File | undefined {
  return list && list.length > 0 ? list[0] : undefined;
}

/**
 * A short summary of the pre-coalesce geometry type breakdown, e.g.
 * "142 Polygon + 8 MultiPolygon → coalesced to MultiPolygon · 3 rows have no
 * geometry". Shown next to the resolved (read-only) geometry type after a
 * GeoJSON import.
 */
function summarizeGeometryTypes(
  typeCounts: Record<string, number>,
  geometryType: GeometryType | null,
  geometrylessCount: number,
): string {
  const entries =
      // oxlint-disable-next-line unicorn/no-array-sort -- `.toSorted()` needs ES2023 lib; this repo targets ES2021, and `Object.entries()` already returns a fresh array so mutating it in place is harmless.
      Object.entries(typeCounts).sort(([a], [b]) => a.localeCompare(b)),
    parts: string[] = [];
  if (entries.length > 0) {
    const countsPart = entries.map(([type, count]) => `${count} ${type}`).join(" + ");
    parts.push(
      entries.length > 1 && geometryType !== null
        ? `${countsPart} → coalesced to ${geometryType}`
        : countsPart,
    );
  }
  if (geometrylessCount > 0) {
    const verb = geometrylessCount === 1 ? "has" : "have";
    parts.push(`${geometrylessCount} row${geometrylessCount === 1 ? "" : "s"} ${verb} no geometry`);
  }
  return parts.join(" · ");
}

function statusIcon(failed: boolean, done: boolean) {
  if (failed) {
    return <XCircle className="h-5 w-5 text-destructive" />;
  }
  if (done) {
    return <CheckCircle className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />;
  }
  return <Loader2 className="h-5 w-5 animate-spin text-primary" />;
}

function statusTitle(failed: boolean, done: boolean) {
  if (failed) {
    return "Import failed";
  }
  if (done) {
    return "Import complete";
  }
  return "Importing dataset…";
}

function progressMetrics(
  progress: DatasetImportProgress | null | undefined,
  fallbackTotal: number,
) {
  const hasTotal = progress ? progress.total > 0 : false,
    processed = progress ? progress.processed : 0,
    total = hasTotal && progress ? progress.total : fallbackTotal,
    pct = hasTotal && progress ? Math.round((progress.processed / progress.total) * 100) : 0;
  return { pct, processed, total };
}

/** Progress / completion card shown while (and after) the import runs. */
function ImportProgressView({
  progress,
  fallbackTotal,
}: {
  progress: DatasetImportProgress | null | undefined;
  fallbackTotal: number;
}) {
  const status = progress ? progress.status : undefined,
    failed = status === "failed",
    done = status === "completed",
    { pct, processed, total } = progressMetrics(progress, fallbackTotal),
    errorMsg = (progress && progress.error) || "Something went wrong during the import.";
  return (
    <Card className="max-w-xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {statusIcon(failed, done)}
          {statusTitle(failed, done)}
        </CardTitle>
        <CardDescription>
          {failed ? errorMsg : `${processed} of ${total} rows imported.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              failed ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${failed ? 100 : pct}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** Empty-state dropzone for the initial data upload. */
function DatasetDropzone({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null),
    [isDragging, setIsDragging] = useState(false),
    openPicker = () => {
      if (inputRef.current) {
        inputRef.current.click();
      }
    };
  return (
    <Card className="max-w-xl mx-auto">
      <CardHeader>
        <CardTitle>Import data</CardTitle>
        <CardDescription>
          Upload a <code>.json</code> or <code>.jsonl</code> file. Every row is read to infer a
          schema that&apos;s valid against your data; you can refine it before saving.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = firstFile(e.target.files);
            if (file) {
              onFile(file);
            }
            e.target.value = "";
          }}
        />
        <div
          // Interactive drag-and-drop zone; a plain button can't host the drop affordance.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="button"
          tabIndex={0}
          aria-label="Drop a JSON or JSONL file here or click to browse"
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDragging
              ? "border-primary bg-primary/5 text-primary"
              : "border-border text-muted-foreground hover:border-primary/50 hover:bg-muted/50",
          )}
          onClick={openPicker}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              openPicker();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            const related = e.relatedTarget;
            if (!(related instanceof Node) || !e.currentTarget.contains(related)) {
              setIsDragging(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) {
              onFile(file);
            }
          }}
        >
          <FileJson
            className={cn("h-8 w-8", isDragging ? "text-primary" : "text-muted-foreground")}
          />
          <p className="text-sm font-medium">
            {isDragging ? "Drop your file here" : "Drag & drop a data file, or click to browse"}
          </p>
          <p className="text-xs">.json or .jsonl</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Review + edit the inferred schema against the imported rows. */
function DatasetReview({
  rows,
  fileName,
  inferredJson,
  dataText,
  saveLabel,
  onReupload,
  onSave,
  datasetKind,
  onDatasetKindChange,
  geometryType,
  onGeometryTypeChange,
  geometryTypeReadOnly,
  geometryTypeSummary,
}: {
  rows: DatasetImportRow[];
  fileName: string | null;
  inferredJson: string;
  dataText: string;
  saveLabel: string;
  onReupload: (file: File) => void;
  onSave: SchemaEditorSave;
  datasetKind: "standard" | "geospatial";
  onDatasetKindChange: (kind: "standard" | "geospatial") => void;
  geometryType: GeometryType | undefined;
  onGeometryTypeChange: (type: GeometryType) => void;
  geometryTypeReadOnly: boolean;
  geometryTypeSummary: string | undefined;
}) {
  const reuploadInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <FileJson className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm truncate">
            <span className="font-medium">{rows.length}</span> rows
            {fileName ? <span className="text-muted-foreground"> from {fileName}</span> : null}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            ref={reuploadInputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = firstFile(e.target.files);
              if (file) {
                onReupload(file);
              }
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (reuploadInputRef.current) {
                reuploadInputRef.current.click();
              }
            }}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Re-upload data
          </Button>
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        The schema below was inferred from your data. Refine it as needed — every imported row must
        stay valid, or re-upload data that matches. Saving creates the dataset and imports the rows.
      </div>
      <SchemaEditor
        initialJson={inferredJson}
        dataText={dataText}
        requireValidData
        saveLabel={saveLabel}
        onSave={onSave}
        datasetKind={datasetKind}
        onDatasetKindChange={onDatasetKindChange}
        geometryType={geometryType}
        onGeometryTypeChange={onGeometryTypeChange}
        geometryTypeReadOnly={geometryTypeReadOnly}
        geometryTypeSummary={geometryTypeSummary}
      />
    </div>
  );
}

type SchemaEditorSave = (
  schemaJson: string,
  parsedSchema: object,
  uiSchemaJson: string,
  parsedUiSchema: object,
) => Promise<void>;

export function DatasetImporter({
  onImport,
  progress,
  saveLabel = "Create dataset",
}: DatasetImporterProps) {
  const [rows, setRows] = useState<DatasetImportRow[] | null>(null),
    [inferredJson, setInferredJson] = useState(""),
    [dataText, setDataText] = useState(""),
    [fileName, setFileName] = useState<string | null>(null),
    [submitting, setSubmitting] = useState(false),
    // Dataset-level kind/geometry state, owned here and threaded into
    // `SchemaEditor`'s controlled "Dataset Type" section (see schema-editor.tsx).
    [datasetKind, setDatasetKind] = useState<"standard" | "geospatial">("standard"),
    [geometryType, setGeometryType] = useState<GeometryType | undefined>(undefined),
    // True only while the current geometryType was computed by coalescing an
    // actual GeoJSON import (not hand-picked via the toggle).
    [geometryTypeReadOnly, setGeometryTypeReadOnly] = useState(false),
    [geometryTypeSummary, setGeometryTypeSummary] = useState<string | undefined>(undefined),
    // A FeatureCollection / bare Feature array: geometry is split out into its
    // own rows shape and never enters the inferred JSON Schema.
    ingestGeoJson = (parsedJson: unknown, file: File, keepSchema: boolean) => {
      const result = parseGeoJsonFeatures(parsedJson);
      if (result.coalesceError !== undefined) {
        toast.error(result.coalesceError);
        return;
      }
      if (result.rows.length === 0) {
        toast.error(
          result.errors.length > 0
            ? `No valid features found (${result.errors.length} malformed feature(s)).`
            : "That file has no features.",
        );
        return;
      }
      if (result.errors.length > 0) {
        toast.warning(
          `Skipped ${result.errors.length} malformed feature(s); imported ${result.rows.length} features.`,
        );
      }
      const geometrylessCount = result.rows.filter((row) => row.geometry === undefined).length,
        properties = result.rows.map((row) => row.data);
      setRows(result.rows.map((row) => ({ data: row.data, geometry: row.geometry })));
      setFileName(file.name);
      setDataText(JSON.stringify(properties, null, 2));
      setDatasetKind("geospatial");
      setGeometryType(result.geometryType ?? undefined);
      setGeometryTypeReadOnly(true);
      setGeometryTypeSummary(
        summarizeGeometryTypes(result.typeCounts, result.geometryType, geometrylessCount),
      );
      if (keepSchema) {
        toast.success(`Reloaded ${result.rows.length} features from ${file.name}.`);
      } else {
        setInferredJson(JSON.stringify(inferSchemaFromData(properties), null, 2));
        toast.success(`Inferred a schema from ${result.rows.length} features in ${file.name}.`);
      }
    },
    // The existing plain-data flow, untouched beyond wrapping each row as `{ data }`.
    ingestStandard = (text: string, file: File, keepSchema: boolean) => {
      const { rows: parsedRows, errors } = parseDataRows(text);
      if (parsedRows.length === 0) {
        toast.error(
          errors.length > 0
            ? `No valid rows found (${errors.length} malformed line(s)).`
            : "That file has no data rows.",
        );
        return;
      }
      if (errors.length > 0) {
        toast.warning(
          `Skipped ${errors.length} malformed line(s); imported ${parsedRows.length} rows.`,
        );
      }
      setRows(parsedRows.map((data) => ({ data })));
      setFileName(file.name);
      setDataText(JSON.stringify(parsedRows, null, 2));
      setDatasetKind("standard");
      setGeometryType(undefined);
      setGeometryTypeReadOnly(false);
      setGeometryTypeSummary(undefined);
      if (keepSchema) {
        toast.success(`Reloaded ${parsedRows.length} rows from ${file.name}.`);
      } else {
        setInferredJson(JSON.stringify(inferSchemaFromData(parsedRows), null, 2));
        toast.success(`Inferred a schema from ${parsedRows.length} rows in ${file.name}.`);
      }
    },
    // Parse a file into rows. `keepSchema` is true for a re-upload (don't
    // re-infer the schema, just refresh the validation data). A whole-text
    // JSON.parse that succeeds and looks GeoJSON-shaped takes the geometry
    // path; everything else (including a failed whole-text parse, which is
    // `parseDataRows`'s own JSONL fallback territory) takes the standard path.
    ingest = async (file: File, keepSchema: boolean) => {
      if (!isSupportedFile(file)) {
        toast.error("Please upload a .json or .jsonl file.");
        return;
      }
      let text: string;
      try {
        text = await readFileAsText(file);
      } catch {
        toast.error("Could not read that file.");
        return;
      }

      let wholeTextParsed: unknown;
      try {
        wholeTextParsed = JSON.parse(text);
      } catch {
        ingestStandard(text, file, keepSchema);
        return;
      }

      if (looksLikeGeoJson(wholeTextParsed)) {
        ingestGeoJson(wholeTextParsed, file, keepSchema);
      } else {
        ingestStandard(text, file, keepSchema);
      }
    },
    handleSave: SchemaEditorSave = async (
      schemaJson,
      parsedSchema,
      uiSchemaJson,
      parsedUiSchema,
    ) => {
      if (!rows) {
        return;
      }
      setSubmitting(true);
      try {
        await onImport(
          schemaJson,
          parsedSchema,
          uiSchemaJson,
          parsedUiSchema,
          rows,
          datasetKind,
          geometryType,
        );
      } catch (error) {
        setSubmitting(false);
        toast.error(error instanceof Error ? error.message : "Failed to start import.");
        throw error;
      }
    },
    status = progress ? progress.status : undefined,
    importing = submitting || (status !== undefined && status !== "completed");

  if (importing || status === "completed") {
    return <ImportProgressView progress={progress} fallbackTotal={rows ? rows.length : 0} />;
  }

  if (rows) {
    return (
      <DatasetReview
        rows={rows}
        fileName={fileName}
        inferredJson={inferredJson}
        dataText={dataText}
        saveLabel={saveLabel}
        onReupload={(file) => void ingest(file, true)}
        onSave={handleSave}
        datasetKind={datasetKind}
        onDatasetKindChange={setDatasetKind}
        geometryType={geometryType}
        onGeometryTypeChange={setGeometryType}
        geometryTypeReadOnly={geometryTypeReadOnly}
        geometryTypeSummary={geometryTypeSummary}
      />
    );
  }

  return <DatasetDropzone onFile={(file) => void ingest(file, false)} />;
}
