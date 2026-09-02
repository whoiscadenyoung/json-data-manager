import { parseDataRows } from "@caden/json-cms/react";
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

export const Route = createFileRoute("/schemas/$schemaId/bulk-upload")({
  component: BulkUploadPage,
});

interface ValidationResult {
  index: number;
  data: unknown;
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
        <CardTitle>JSON Input</CardTitle>
        <CardDescription>
          Upload a <code>.json</code> or <code>.jsonl</code> file or paste a JSON array below. Each
          object will be validated against the <strong>{schemaTitle}</strong> schema.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Upload JSON File</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.jsonl,.ndjson,application/json"
            className="hidden"
            onChange={onFileChange}
          />
          <div
            // Interactive drag-and-drop zone that also hosts a nested remove button.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="button"
            tabIndex={0}
            aria-label="Drop zone: drag a JSON file here or click to browse"
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
                    : "Drag & drop a JSON file, or click to browse"}
                </p>
                <p className="text-xs">.json or .jsonl files</p>
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
    fileInputRef = useRef<HTMLInputElement>(null),
    importStatus = useQuery(api.imports.getImportStatus, importId ? { importId } : "skip"),
    importStatusValue = importStatus ? importStatus.status : undefined,
    importTotal = importStatus ? importStatus.total : 0,
    importErrorMsg = importStatus && importStatus.error ? importStatus.error : "Import failed.";

  // Navigate back to the dataset once the batched import finishes.
  useEffect(() => {
    if (importStatusValue === "completed") {
      toast.success(`${importTotal} ${importTotal === 1 ? "entry" : "entries"} imported!`);
      void navigate({ params: { schemaId }, to: "/schemas/$schemaId" });
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

      const { rows, errors: parseErrors } = parseDataRows(text);

      if (rows.length === 0) {
        setParseError(
          parseErrors.length > 0
            ? "Could not parse any rows — check your JSON/JSONL input."
            : "No rows found — provide a JSON array or JSONL file.",
        );
        return;
      }
      if (parseErrors.length > 0) {
        toast.warning(`Skipped ${parseErrors.length} malformed line(s).`);
      }

      const results: ValidationResult[] = rows.map((item, index) => {
        const { errors } = validator.validateFormData(item, schema.schema);
        return {
          data: item,
          errors: errors.map((e) => e.stack ?? e.message ?? JSON.stringify(e)),
          index,
          valid: errors.length === 0,
        };
      });

      setValidationResults(results);
    },
    loadFile = async (file: File) => {
      if (!/\.(json|jsonl|ndjson)$/i.test(file.name) && file.type !== "application/json") {
        toast.error("Please upload a .json or .jsonl file.");
        return;
      }
      setFileName(file.name);
      let text: string;
      try {
        text = await readFileAsText(file);
      } catch {
        toast.error("Could not read that file.");
        return;
      }
      setJsonText(text);
      validateJson(text);
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
    },
    handleSubmit = async () => {
      if (!validationResults) {
        return;
      }
      const validEntries = validationResults.filter((r) => r.valid).map((r) => r.data);
      if (validEntries.length === 0) {
        toast.error("No valid entries to upload.");
        return;
      }

      setIsSubmitting(true);
      try {
        // Upload the valid rows to storage, then run the batched, monitored import.
        const uploadUrl = await generateUploadUrl({}),
          res = await fetch(uploadUrl, {
            body: JSON.stringify(validEntries),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
        if (!res.ok) {
          throw new Error("Failed to upload entries.");
        }
        const body: unknown = await res.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("storageId" in body) ||
          typeof body.storageId !== "string"
        ) {
          throw new Error("Upload did not return a storageId.");
        }
        const newImportId = await startImport({
          schemaId,
          storageId: body.storageId,
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
          <p className="text-muted-foreground mb-4">Schema not found.</p>
          <RouterButton to="/schemas">Back to Schemas</RouterButton>
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
              <BreadcrumbPage>Bulk Upload</BreadcrumbPage>
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
          <div>
            <h1 className="text-3xl font-bold text-primary">Bulk Upload</h1>
            <p className="text-muted-foreground mt-1">
              Upload a JSON array of objects to create multiple entries at once.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <UploadCard
          schemaTitle={schema.title}
          jsonText={jsonText}
          onJsonText={(value) => {
            setJsonText(value);
            if (fileName) {
              setFileName(null);
            }
            setParseError(null);
            setValidationResults(null);
          }}
          fileName={fileName}
          isDragging={isDragging}
          fileInputRef={fileInputRef}
          onFileChange={handleFileChange}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClear={clearInput}
          onValidate={() => {
            validateJson(jsonText);
          }}
          arrayJsonSchema={arrayJsonSchema}
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
