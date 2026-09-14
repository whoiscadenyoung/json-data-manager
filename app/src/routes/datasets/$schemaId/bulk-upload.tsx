import {
  chunkRowsForImport,
  enabledAcceptString,
  enabledExtensionsHint,
  findImportParser,
  isGeometryCompatibleWithDatasetType,
  looksLikeGeoJson,
  parseDataRows,
  parseGeoJsonFeatures,
} from "@caden/json-cms/react";
import type {
  Geometry,
  GeometryType,
  GeoJsonRow,
  ImportParseResult,
  ParsedSheet,
} from "@caden/json-cms/react";
import { SheetPicker } from "@caden/json-cms/react/ui";
import validator from "@rjsf/validator-ajv8";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, ArrowLeft, CheckCircle, FileJson, Upload, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JsonEditor } from "@/components/ui/json-editor";
import { Label } from "@/components/ui/label";

import { api } from "../../../../convex/_generated/api";

export const Route = createFileRoute("/datasets/$schemaId/bulk-upload")({
  component: BulkUploadPage,
});

interface ValidationResult {
  index: number;
  data: unknown;
  geometry?: unknown;
  valid: boolean;
  errors: string[];
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

/** AJV property-validation errors for one row's data against the dataset's JSON Schema. */
function ajvErrorsFor(data: unknown, jsonSchema: object): string[] {
  const { errors } = validator.validateFormData(data, jsonSchema);
  return errors.map((e) => e.stack ?? e.message ?? JSON.stringify(e));
}

/**
 * Geometry-compatibility error for one row's geometry against the dataset's
 * already-locked geometry type, or none. A row with no geometry is always
 * fine — entries without geometry are allowed.
 */
function geometryErrorsFor(
  geometry: Geometry | undefined,
  datasetGeometryType: string | undefined,
): string[] {
  if (geometry === undefined || datasetGeometryType === undefined) {
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `SchemaDoc.geometryType` is widened to `string`, but a geospatial schema's value is always a real `GeometryType` (enforced by the component's validator at write time).
  const lockedType = datasetGeometryType as GeometryType;
  return isGeometryCompatibleWithDatasetType(geometry.type, lockedType)
    ? []
    : [
        `Geometry type "${geometry.type}" is not compatible with this dataset's "${lockedType}" geometry type.`,
      ];
}

/** Validates a batch of GeoJSON-derived rows: AJV on `data` plus geometry-compatibility on `geometry`. */
function validateGeoJsonRows(
  rows: GeoJsonRow[],
  jsonSchema: object,
  datasetGeometryType: string | undefined,
): ValidationResult[] {
  return rows.map((item, index) => {
    const errors = [
      ...ajvErrorsFor(item.data, jsonSchema),
      ...geometryErrorsFor(item.geometry, datasetGeometryType),
    ];
    return { data: item.data, errors, geometry: item.geometry, index, valid: errors.length === 0 };
  });
}

/** Whole-text JSON.parse + GeoJSON shape check, collapsed to one call. `undefined` when either fails. */
function tryParseGeoJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return looksLikeGeoJson(parsed) ? parsed : undefined;
}

interface GeoJsonValidationOutcome {
  /** Set when the text was GeoJSON-shaped, whether or not it fully validated — the caller should stop and use this outcome instead of falling through to the plain row parser. */
  handled: boolean;
  parseError?: string;
  warning?: string;
  results?: ValidationResult[];
}

/**
 * Attempts to validate `text` as GeoJSON for a geospatial-kind schema.
 * Returns `{ handled: false }` when the text isn't GeoJSON-shaped (or fails to
 * parse at all) so the caller falls through to the standard row parser.
 */
function tryValidateGeoJson(
  text: string,
  jsonSchema: object,
  geometryType: string | undefined,
): GeoJsonValidationOutcome {
  const geoJsonCandidate = tryParseGeoJson(text);
  if (geoJsonCandidate === undefined) {
    return { handled: false };
  }

  const result = parseGeoJsonFeatures(geoJsonCandidate);
  if (result.rows.length === 0) {
    const parseError =
      result.errors.length > 0
        ? "Could not parse any features — check your GeoJSON input."
        : "No features found — provide a FeatureCollection or Feature array.";
    return { handled: true, parseError };
  }

  const warning =
    result.errors.length > 0 ? `Skipped ${result.errors.length} malformed feature(s).` : undefined;
  return {
    handled: true,
    results: validateGeoJsonRows(result.rows, jsonSchema, geometryType),
    warning,
  };
}

interface RowValidationOutcome {
  parseError?: string;
  warning?: string;
  results?: ValidationResult[];
}

/** Validates plain JSON/JSONL row text (the standard, non-GeoJSON path) against the dataset's schema. */
function validateStandardRows(text: string, jsonSchema: object): RowValidationOutcome {
  const { rows, errors: parseErrors } = parseDataRows(text);

  if (rows.length === 0) {
    const parseError =
      parseErrors.length > 0
        ? "Could not parse any rows — check your JSON/JSONL input."
        : "No rows found — provide a JSON array or JSONL file.";
    return { parseError };
  }

  const warning =
      parseErrors.length > 0 ? `Skipped ${parseErrors.length} malformed line(s).` : undefined,
    results: ValidationResult[] = rows.map((item, index) => {
      const errors = ajvErrorsFor(item, jsonSchema);
      return { data: item, errors, index, valid: errors.length === 0 };
    });

  return { results, warning };
}

/** Extracted so this ternary doesn't add to `BulkUploadPage`'s own cyclomatic complexity. */
function isGeospatialSchema(schema: { kind?: string } | null | undefined): boolean {
  return schema ? schema.kind === "geospatial" : false;
}

type LoadFileOutcome =
  | { kind: "text"; text: string }
  | { kind: "parsed"; result: ImportParseResult }
  | { kind: "error"; message: string };

/**
 * Reads and parses one uploaded file, without touching any component state —
 * extracted (like the validators above) to keep `BulkUploadPage`'s own
 * complexity down. A JSON/JSONL/GeoJSON-shaped file is handled by the
 * existing text-based GeoJSON-sniffing + AJV pipeline (`kind: "text"`);
 * everything else goes through the pluggable parser registry (CSV, Excel).
 */
/**
 * What to do with a registry parser's result: zero sheets is an error, one
 * sheet applies directly, and more than one goes to the sheet picker.
 * Extracted (like `loadImportedFile`) to keep `BulkUploadPage`'s own
 * complexity down — the component just dispatches on `kind`.
 */
type ParsedResultOutcome =
  | { kind: "error"; message: string }
  | { kind: "single"; sheet: ParsedSheet }
  | { kind: "multiple"; sheets: ParsedSheet[] };

function resolveParsedResult(result: ImportParseResult, sourceName: string): ParsedResultOutcome {
  if (result.sheets.length === 0) {
    return {
      kind: "error",
      message:
        result.errors.length > 0
          ? `Could not parse ${sourceName} (${result.errors.length} error(s)).`
          : `${sourceName} has no data rows.`,
    };
  }
  if (result.sheets.length > 1) {
    return { kind: "multiple", sheets: result.sheets };
  }
  return { kind: "single", sheet: result.sheets[0] };
}

async function loadImportedFile(file: File, isGeospatial: boolean): Promise<LoadFileOutcome> {
  const jsonLikePattern = isGeospatial
    ? /\.(json|jsonl|ndjson|geojson)$/i
    : /\.(json|jsonl|ndjson)$/i;
  if (jsonLikePattern.test(file.name) || file.type === "application/json") {
    try {
      return { kind: "text", text: await readFileAsText(file) };
    } catch {
      return { kind: "error", message: "Could not read that file." };
    }
  }

  const parser = findImportParser(file);
  if (!parser) {
    return {
      kind: "error",
      message: `Please upload a supported file (${enabledExtensionsHint()}).`,
    };
  }
  try {
    return { kind: "parsed", result: await parser.parse(file) };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not read that file.",
    };
  }
}

function countResults(results: ValidationResult[] | null): {
  validCount: number;
  invalidCount: number;
} {
  if (!results) {
    return { invalidCount: 0, validCount: 0 };
  }
  let validCount = 0;
  for (const r of results) {
    if (r.valid) {
      validCount += 1;
    }
  }
  return { invalidCount: results.length - validCount, validCount };
}

interface UploadCardProps {
  schemaTitle: string;
  jsonText: string;
  onJsonText: (value: string) => void;
  fileName: string | null;
  isDragging: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onClear: () => void;
  onValidate: () => void;
  arrayJsonSchema: object | undefined;
}

interface SheetPickerHandoff {
  fileName: string;
  sheets: ParsedSheet[];
  onSelect: (sheetName: string) => void;
  onCancel: () => void;
}

/** `null` when there's no pending multi-sheet workbook to pick from — extracted so this ternary lives outside `BulkUploadPage`'s own body. */
function buildSheetPickerHandoff(
  sheets: ParsedSheet[] | null,
  fileName: string,
  onSelect: (sheetName: string) => void,
  onCancel: () => void,
): SheetPickerHandoff | null {
  return sheets ? { fileName, onCancel, onSelect, sheets } : null;
}

/**
 * Either the sheet picker (a just-uploaded workbook has more than one sheet
 * and none is chosen yet) or the normal upload card. Extracted as its own
 * component — rather than an inline ternary in `BulkUploadPage`'s JSX — so
 * the branch doesn't add to that component's own cyclomatic complexity.
 */
function ImportSourcePanel({
  sheetPicker,
  uploadCard,
}: {
  sheetPicker: SheetPickerHandoff | null;
  uploadCard: UploadCardProps;
}) {
  if (sheetPicker) {
    return (
      <SheetPicker
        fileName={sheetPicker.fileName}
        sheets={sheetPicker.sheets.map((sheet) => ({
          name: sheet.name,
          rowCount: sheet.rows.length,
        }))}
        onSelect={sheetPicker.onSelect}
        onCancel={sheetPicker.onCancel}
      />
    );
  }
  return <UploadCard {...uploadCard} />;
}

function UploadCard({
  schemaTitle,
  jsonText,
  onJsonText,
  fileName,
  isDragging,
  fileInputRef,
  onFileChange,
  onDragOver,
  onDragLeave,
  onDrop,
  onClear,
  onValidate,
  arrayJsonSchema,
}: UploadCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data Input</CardTitle>
        <CardDescription>
          Upload a JSON, CSV, or Excel file, or paste a JSON array below. Each object will be
          validated against the <strong>{schemaTitle}</strong> schema.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Upload Data File</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept={enabledAcceptString()}
            className="hidden"
            onChange={onFileChange}
          />
          <div
            // Interactive drag-and-drop zone that also hosts a nested remove button.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="button"
            tabIndex={0}
            aria-label="Drop zone: drag a data file here or click to browse"
            className={[
              "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-6 text-center transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isDragging
                ? "border-primary bg-primary/5 text-primary"
                : "border-border text-muted-foreground hover:border-primary/50 hover:bg-muted/50",
            ].join(" ")}
            onClick={() => {
              if (fileInputRef.current) {
                fileInputRef.current.click();
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && fileInputRef.current) {
                fileInputRef.current.click();
              }
            }}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <FileJson
              className={`h-7 w-7 ${isDragging ? "text-primary" : "text-muted-foreground"}`}
            />
            {fileName ? (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{fileName}</span>
                <button
                  type="button"
                  aria-label="Remove file"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear();
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <p className="text-sm font-medium">
                  {isDragging
                    ? "Drop your file here"
                    : "Drag & drop a data file, or click to browse"}
                </p>
                <p className="text-xs">{enabledExtensionsHint()}</p>
              </>
            )}
          </div>
        </div>

        <div className="relative flex items-center gap-3">
          <div className="flex-1 border-t border-border" />
          <span className="text-xs text-muted-foreground uppercase tracking-wide">or</span>
          <div className="flex-1 border-t border-border" />
        </div>

        <div className="space-y-2">
          <Label id="json-paste-label">Paste JSON Array</Label>
          <JsonEditor
            value={jsonText}
            onChange={onJsonText}
            placeholder={'[\n  { "field": "value" },\n  { "field": "value" }\n]'}
            aria-labelledby="json-paste-label"
            disableSchemaLinting
            jsonSchema={arrayJsonSchema}
          />
        </div>

        <Button type="button" variant="outline" onClick={onValidate} disabled={!jsonText.trim()}>
          Validate Entries
        </Button>
      </CardContent>
    </Card>
  );
}

interface ValidationResultsProps {
  results: ValidationResult[];
  validCount: number;
  invalidCount: number;
  isSubmitting: boolean;
  importStatus: { processed: number; total: number } | null | undefined;
  onSubmit: () => void;
}

function ResultsBanner({ validCount, invalidCount }: { validCount: number; invalidCount: number }) {
  if (invalidCount === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950 px-4 py-3 text-sm text-green-800 dark:text-green-200">
        <CheckCircle className="h-4 w-4 shrink-0" />
        All {validCount} entries are valid and ready to upload.
      </div>
    );
  }
  if (validCount > 0) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        {invalidCount} {invalidCount === 1 ? "entry has" : "entries have"} validation errors. Only
        the {validCount} valid {validCount === 1 ? "entry" : "entries"} will be uploaded.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <XCircle className="h-4 w-4 shrink-0" />
      All entries have validation errors. Please fix them before uploading.
    </div>
  );
}

function submitLabel(
  isSubmitting: boolean,
  importStatus: { processed: number; total: number } | null | undefined,
  validCount: number,
): string {
  if (!isSubmitting) {
    return `Upload ${validCount} Valid ${validCount === 1 ? "Entry" : "Entries"}`;
  }
  return importStatus ? `Importing… ${importStatus.processed}/${importStatus.total}` : "Uploading…";
}

function ValidationResults({
  results,
  validCount,
  invalidCount,
  isSubmitting,
  importStatus,
  onSubmit,
}: ValidationResultsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Validation Results</CardTitle>
        <CardDescription>
          {validCount} valid, {invalidCount} invalid out of {results.length} entries
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ResultsBanner validCount={validCount} invalidCount={invalidCount} />

        {invalidCount > 0 && (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {results
              .filter((r) => !r.valid)
              .map((r) => (
                <div
                  key={r.index}
                  className="rounded-md border border-destructive/20 bg-muted/50 p-3 text-sm"
                >
                  <p className="font-medium text-foreground mb-1">Entry {r.index + 1}</p>
                  <ul className="space-y-0.5 text-destructive">
                    {r.errors.map((e) => (
                      <li key={`${r.index}-${e}`} className="text-xs">
                        {e}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}

        <Button onClick={onSubmit} disabled={isSubmitting || validCount === 0}>
          <Upload className="h-4 w-4 mr-2" />
          {submitLabel(isSubmitting, importStatus, validCount)}
        </Button>
      </CardContent>
    </Card>
  );
}

function BulkUploadPage() {
  const { schemaId } = Route.useParams(),
    navigate = useNavigate(),
    schema = useQuery(api.schemas.get, { schemaId }),
    generateUploadUrl = useMutation(api.imports.generateUploadUrl),
    startImport = useMutation(api.imports.startImport),
    [jsonText, setJsonText] = useState(""),
    [fileName, setFileName] = useState<string | null>(null),
    [isDragging, setIsDragging] = useState(false),
    [parseError, setParseError] = useState<string | null>(null),
    [validationResults, setValidationResults] = useState<ValidationResult[] | null>(null),
    [isSubmitting, setIsSubmitting] = useState(false),
    [importId, setImportId] = useState<string | undefined>(),
    // Set only while a just-uploaded workbook has more than one sheet and the
    // user hasn't picked one yet.
    [workbookSheets, setWorkbookSheets] = useState<ParsedSheet[] | null>(null),
    [workbookFileName, setWorkbookFileName] = useState(""),
    fileInputRef = useRef<HTMLInputElement>(null),
    importStatus = useQuery(api.imports.getImportStatus, importId ? { importId } : "skip"),
    importStatusValue = importStatus ? importStatus.status : undefined,
    importTotal = importStatus ? importStatus.total : 0,
    importErrorMsg = importStatus && importStatus.error ? importStatus.error : "Import failed.";

  // Navigate back to the dataset once the batched import finishes.
  useEffect(() => {
    if (importStatusValue === "completed") {
      toast.success(`${importTotal} ${importTotal === 1 ? "entry" : "entries"} imported!`);
      void navigate({ params: { schemaId }, to: "/datasets/$schemaId" });
    } else if (importStatusValue === "failed") {
      toast.error(importErrorMsg);
      // Reset local UI state in response to the external import subscription.
      // oxlint-disable-next-line react/set-state-in-effect
      setIsSubmitting(false);
      setImportId(undefined);
    }
  }, [importStatusValue, importTotal, importErrorMsg, navigate, schemaId]);

  // Wrap item schema in array schema for inline CodeMirror linting
  const arrayJsonSchema = useMemo(
      () => (schema ? { items: schema.schema, type: "array" } : undefined),
      [schema],
    ),
    validateJson = (text: string) => {
      if (!schema) {
        return;
      }
      setParseError(null);
      setValidationResults(null);

      if (!text.trim()) {
        setParseError("Please provide JSON input.");
        return;
      }

      const geoOutcome =
        schema.kind === "geospatial"
          ? tryValidateGeoJson(text, schema.schema, schema.geometryType)
          : { handled: false as const };
      // Not GeoJSON-shaped (or the whole-text parse failed, or the dataset isn't
      // geospatial) falls through to the standard row parser; rows just won't
      // carry geometry.
      const outcome = geoOutcome.handled ? geoOutcome : validateStandardRows(text, schema.schema);

      if (outcome.parseError !== undefined) {
        setParseError(outcome.parseError);
        return;
      }
      if (outcome.warning !== undefined) {
        toast.warning(outcome.warning);
      }
      setValidationResults(outcome.results ?? []);
    },
    isGeospatial = isGeospatialSchema(schema),
    // Convert one already-parsed sheet of plain rows (from a CSV or Excel
    // parser) into JSON text and feed it through the exact same
    // validate/upload pipeline a pasted or uploaded JSON array already uses.
    applySheetText = (sheet: ParsedSheet, name: string) => {
      setFileName(name);
      const text = JSON.stringify(sheet.rows, null, 2);
      setJsonText(text);
      setWorkbookSheets(null);
      validateJson(text);
    },
    loadFile = async (file: File) => {
      const outcome = await loadImportedFile(file, isGeospatial);
      if (outcome.kind === "error") {
        toast.error(outcome.message);
        return;
      }
      if (outcome.kind === "text") {
        setFileName(file.name);
        setJsonText(outcome.text);
        validateJson(outcome.text);
        return;
      }
      if (outcome.result.errors.length > 0) {
        toast.warning(
          `Skipped ${outcome.result.errors.length} row(s) with errors while parsing ${file.name}.`,
        );
      }
      const resolved = resolveParsedResult(outcome.result, file.name);
      if (resolved.kind === "error") {
        toast.error(resolved.message);
      } else if (resolved.kind === "multiple") {
        setWorkbookSheets(resolved.sheets);
        setWorkbookFileName(file.name);
      } else {
        applySheetText(resolved.sheet, file.name);
      }
    },
    handleSheetSelect = (sheetName: string) => {
      if (!workbookSheets) {
        return;
      }
      const sheet = workbookSheets.find((s) => s.name === sheetName);
      if (!sheet) {
        return;
      }
      applySheetText(sheet, workbookFileName);
    },
    handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = firstFile(e.target.files);
      if (file) {
        void loadFile(file);
      }
      e.target.value = "";
    },
    handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    },
    handleDragLeave = (e: React.DragEvent) => {
      const related = e.relatedTarget;
      if (!(related instanceof Node) || !e.currentTarget.contains(related)) {
        setIsDragging(false);
      }
    },
    handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        void loadFile(file);
      }
    },
    clearInput = () => {
      setJsonText("");
      setFileName(null);
      setParseError(null);
      setValidationResults(null);
      setWorkbookSheets(null);
    },
    handleSubmit = async () => {
      if (!validationResults) {
        return;
      }
      const validEntries = validationResults
        .filter((r) => r.valid)
        .map((r) => ({ data: r.data, geometry: r.geometry }));
      if (validEntries.length === 0) {
        toast.error("No valid entries to upload.");
        return;
      }

      setIsSubmitting(true);
      try {
        // Split client-side (we already have every row parsed here) and
        // upload each chunk to its own blob, then run the batched,
        // monitored import. Never one giant upload — see
        // `chunkRowsForImport`'s doc comment for why: Convex components
        // can't use the Node runtime, so no server-side step could safely
        // parse one large upload in a single pass.
        const chunks = chunkRowsForImport(validEntries),
          storageIds: string[] = [];
        for (const chunk of chunks) {
          // oxlint-disable-next-line no-await-in-loop
          const uploadUrl = await generateUploadUrl({}),
            // oxlint-disable-next-line no-await-in-loop
            res = await fetch(uploadUrl, {
              body: JSON.stringify(chunk),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            });
          if (!res.ok) {
            throw new Error("Failed to upload entries.");
          }
          // oxlint-disable-next-line no-await-in-loop
          const body: unknown = await res.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("storageId" in body) ||
            typeof body.storageId !== "string"
          ) {
            throw new Error("Upload did not return a storageId.");
          }
          storageIds.push(body.storageId);
        }
        const newImportId = await startImport({
          schemaId,
          storageIds,
          total: validEntries.length,
        });
        setImportId(newImportId);
        // Navigation happens in the effect watching importStatus.
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to upload entries.");
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
          <p className="text-muted-foreground mb-4">Dataset not found.</p>
          <RouterButton to="/datasets">Back to Datasets</RouterButton>
        </CardContent>
      </Card>
    );
  }

  const { validCount, invalidCount } = countResults(validationResults);

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 sm:px-0">
      <div className="mb-6">
        <Breadcrumb className="mb-4">
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
              <BreadcrumbPage>Bulk Upload</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4">
          <RouterButton
            variant="ghost"
            size="sm"
            to="/datasets/$schemaId"
            params={{ schemaId }}
            className="-ml-2"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </RouterButton>
          <div>
            <h1 className="text-3xl font-bold text-primary">Bulk Upload</h1>
            <p className="text-muted-foreground mt-1">
              Upload a JSON, CSV, or Excel file to create multiple entries at once.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <ImportSourcePanel
          sheetPicker={buildSheetPickerHandoff(
            workbookSheets,
            workbookFileName,
            handleSheetSelect,
            () => {
              setWorkbookSheets(null);
            },
          )}
          uploadCard={{
            arrayJsonSchema,
            fileInputRef,
            fileName,
            isDragging,
            jsonText,
            onClear: clearInput,
            onDragLeave: handleDragLeave,
            onDragOver: handleDragOver,
            onDrop: handleDrop,
            onFileChange: handleFileChange,
            onJsonText: (value) => {
              setJsonText(value);
              if (fileName) {
                setFileName(null);
              }
              setParseError(null);
              setValidationResults(null);
            },
            onValidate: () => {
              validateJson(jsonText);
            },
            schemaTitle: schema.title,
          }}
        />

        {/* Parse error */}
        {parseError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
            {parseError}
          </div>
        )}

        {validationResults && (
          <ValidationResults
            results={validationResults}
            validCount={validCount}
            invalidCount={invalidCount}
            isSubmitting={isSubmitting}
            importStatus={importStatus}
            onSubmit={() => {
              void handleSubmit();
            }}
          />
        )}
      </div>
    </div>
  );
}
