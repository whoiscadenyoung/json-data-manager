import validator from "@rjsf/validator-ajv8";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  FileJson,
  Upload,
  Wand2,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { inferSchemaFromData } from "../lib/infer-schema.js";
import { JsonTree } from "./json-tree.js";
import { cn } from "./lib/utils.js";
import { Button } from "./primitives/button.js";
import { ConfirmDialog } from "./primitives/dialog.js";
import { JsonEditor } from "./primitives/json-editor.js";
import { Label } from "./primitives/label.js";

export interface ValidationResult {
  index: number;
  data: unknown;
  valid: boolean;
  failingPaths: Set<string>;
  errors: Map<string, string>;
  unknownPaths: Set<string>;
}

export interface ValidationState {
  total: number;
  failingPaths: Map<string, number>;
  /** Number of data rows with at least one validation error. */
  invalidItemCount: number;
}

interface ValidationPaneProps {
  schemaJson: string;
  /** Optional externally provided data (e.g. from a dropped data file). Wrapped in object so re-sending identical content triggers the effect. */
  externalDataText?: { text: string };
  onInferSchema: (inferredJson: string) => void;
  onStateChange: (state: ValidationState) => void;
}

function computeUnknownPaths(
  data: unknown,
  schema: Record<string, unknown>,
  pathPrefix = "",
): Set<string> {
  const unknown = new Set<string>();
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return unknown;
  }
  const schemaProps =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const key of Object.keys(data)) {
    const keyPath = `${pathPrefix}/${key}`;
    if (key in schemaProps) {
      const nestedSchema = schemaProps[key];
      if (typeof nestedSchema === "object" && nestedSchema !== null) {
        const nestedData = (data as Record<string, unknown>)[key],
          nested = computeUnknownPaths(
            nestedData,
            nestedSchema as Record<string, unknown>,
            keyPath,
          );
        for (const p of nested) {
          unknown.add(p);
        }
      }
    } else {
      unknown.add(keyPath);
    }
  }
  return unknown;
}

export function ValidationPane({
  schemaJson,
  externalDataText,
  onInferSchema,
  onStateChange,
}: ValidationPaneProps) {
  const [dataText, setDataText] = useState(""),
    [fileName, setFileName] = useState<string | null>(null),
    [isDragging, setIsDragging] = useState(false),
    [results, setResults] = useState<ValidationResult[] | null>(null),
    [parseError, setParseError] = useState<string | null>(null),
    [expandedItems, setExpandedItems] = useState<Set<number>>(new Set()),
    [isInferConfirmOpen, setIsInferConfirmOpen] = useState(false),
    fileInputRef = useRef<HTMLInputElement>(null),
    // Wrap the item schema in an array schema for CodeMirror inline linting
    arrayJsonSchema = useMemo(() => {
      try {
        const parsed = JSON.parse(schemaJson);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return { items: parsed, type: "array" };
        }
      } catch {
        // Invalid schema JSON — no inline linting
      }
      return;
    }, [schemaJson]);

  // Apply external data when provided
  useEffect(() => {
    if (externalDataText !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs internal state to an externally-provided prop (a dropped file's contents), not derivable during render.
      setDataText(externalDataText.text);
      setFileName(null);
    }
  }, [externalDataText]);

  const validate = useCallback(
    (text: string, schemaStr: string) => {
      if (!text.trim()) {
        setResults(null);
        setParseError(null);
        onStateChange({ failingPaths: new Map(), invalidItemCount: 0, total: 0 });
        return;
      }

      let parsedData: unknown;
      try {
        parsedData = JSON.parse(text);
      } catch {
        setParseError("Invalid JSON — please check your input.");
        setResults(null);
        onStateChange({ failingPaths: new Map(), invalidItemCount: 0, total: 0 });
        return;
      }

      if (!Array.isArray(parsedData)) {
        setParseError("Data must be a JSON array of objects.");
        setResults(null);
        onStateChange({ failingPaths: new Map(), invalidItemCount: 0, total: 0 });
        return;
      }

      let parsedSchema: unknown;
      try {
        parsedSchema = JSON.parse(schemaStr);
      } catch {
        // Schema is invalid — show data without validation
        setResults(
          parsedData.map((item, index) => ({
            data: item,
            errors: new Map<string, string>(),
            failingPaths: new Set<string>(),
            index,
            unknownPaths: new Set<string>(),
            valid: false,
          })),
        );
        setParseError(null);
        onStateChange({
          failingPaths: new Map(),
          invalidItemCount: parsedData.length,
          total: parsedData.length,
        });
        return;
      }

      const newResults: ValidationResult[] = parsedData.map((item, index) => {
        const { errors } = validator.validateFormData(item, parsedSchema as object),
          failingPaths = new Set<string>(),
          errorMessages = new Map<string, string>();
        for (const err of errors) {
          // RJSF property is JS accessor notation: ".email", ".address.city", "."
          // For required errors, params.missingProperty gives the key
          let path: string | null = null;

          if (err.name === "required" && err.params && typeof err.params === "object") {
            const missing = (err.params as Record<string, string>).missingProperty;
            if (missing) {
              path = `/${missing}`;
            }
          } else if (err.property && err.property !== ".") {
            // ".email" → "/email", ".address.city" → "/address/city"
            const raw = err.property.replace(/^\./, "");
            path = raw.startsWith("/") ? raw : `/${raw}`;
          }

          if (path) {
            failingPaths.add(path);
            if (!errorMessages.has(path)) {
              errorMessages.set(path, err.message ?? "Validation error");
            }
          }
        }
        const unknownPaths = computeUnknownPaths(item, parsedSchema as Record<string, unknown>);
        return {
          data: item,
          errors: errorMessages,
          failingPaths,
          index,
          unknownPaths,
          valid: errors.length === 0,
        };
      });

      setResults(newResults);
      setParseError(null);

      // Aggregate failing paths across all items
      const aggregated = new Map<string, number>();
      let invalidItemCount = 0;
      for (const r of newResults) {
        if (!r.valid) {
          invalidItemCount++;
        }
        for (const path of r.failingPaths) {
          aggregated.set(path, (aggregated.get(path) ?? 0) + 1);
        }
      }
      onStateChange({ failingPaths: aggregated, invalidItemCount, total: parsedData.length });
    },
    [onStateChange],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-validates against the schema/data pair, including an async-looking dependency (validate) that itself calls setState; not expressible as a render-time derivation.
    validate(dataText, schemaJson);
  }, [schemaJson, dataText, validate]);

  const loadFile = (file: File) => {
      if (!file.name.endsWith(".json") && file.type !== "application/json") {
        toast.error("Please upload a .json file.");
        return;
      }
      setFileName(file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = (e.target?.result as string) ?? "";
        setDataText(text);
      };
      reader.readAsText(file);
    },
    clearData = () => {
      setDataText("");
      setFileName(null);
      setResults(null);
      setParseError(null);
      setExpandedItems(new Set());
      onStateChange({ failingPaths: new Map(), invalidItemCount: 0, total: 0 });
    },
    doInfer = () => {
      try {
        const parsed = JSON.parse(dataText);
        if (!Array.isArray(parsed)) {
          toast.error("Data must be a JSON array to infer a schema.");
          return;
        }
        const inferred = inferSchemaFromData(parsed);
        onInferSchema(JSON.stringify(inferred, null, 2));
      } catch {
        toast.error("Invalid JSON — cannot infer schema.");
      }
    },
    handleInfer = () => {
      if (!dataText.trim()) {
        return;
      }
      if (schemaJson.trim()) {
        setIsInferConfirmOpen(true);
      } else {
        doInfer();
      }
    },
    toggleExpanded = (index: number) => {
      setExpandedItems((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    validCount = results?.filter((r) => r.valid).length ?? 0,
    hasData = dataText.trim().length > 0;

  return (
    <>
      <ConfirmDialog
        open={isInferConfirmOpen}
        onOpenChange={setIsInferConfirmOpen}
        title="Replace current schema?"
        description="Inferring a schema from this data will overwrite your current schema. This cannot be undone."
        confirmLabel="Replace schema"
        cancelLabel="Cancel"
        destructive
        onConfirm={doInfer}
      />
      <div className="flex flex-col h-full gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Validate with Data
          </span>
          {hasData && (
            <button
              type="button"
              onClick={clearData}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Clear data"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {hasData ? (
          /* ── Data loaded state ───────────────────────────── */
          <div className="flex flex-col gap-3 flex-1 min-h-0">
            {/* Summary + actions */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                {fileName && (
                  <span className="text-xs font-mono text-muted-foreground truncate max-w-28">
                    {fileName}
                  </span>
                )}
                {results && (
                  <span
                    className={cn(
                      "text-xs font-medium",
                      validCount < results.length
                        ? "text-destructive"
                        : "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {validCount}/{results.length} valid
                  </span>
                )}
              </div>
              <Button type="button" variant="outline" size="xs" onClick={handleInfer}>
                <Wand2 className="h-3 w-3 mr-1" />
                Infer schema
              </Button>
            </div>

            {parseError && (
              <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {parseError}
              </div>
            )}

            {/* Results list */}
            {results && results.length > 0 && (
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {results.map((r) => {
                  const isExpanded = expandedItems.has(r.index);
                  return (
                    <div
                      key={r.index}
                      className={cn(
                        "rounded-md border text-xs overflow-hidden",
                        r.valid
                          ? "border-emerald-200 dark:border-emerald-900"
                          : "border-destructive/30",
                      )}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50 transition-colors"
                        onClick={() => {
                          toggleExpanded(r.index);
                        }}
                      >
                        {r.valid ? (
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                        )}
                        <span className="font-medium flex-1">Item {r.index + 1}</span>
                        {!r.valid && (
                          <span className="text-[11px] text-destructive">
                            {r.errors.size} error{r.errors.size === 1 ? "" : "s"}
                          </span>
                        )}
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        )}
                      </button>
                      {isExpanded && (
                        <div className="border-t border-border px-2.5 py-2 overflow-x-auto bg-muted/20">
                          <JsonTree
                            data={r.data}
                            failingPaths={r.failingPaths}
                            errors={r.errors}
                            unknownPaths={r.unknownPaths}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Edit the raw data */}
            <div className="space-y-1 border-t border-border pt-3 shrink-0">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Raw data</Label>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-3 w-3" />
                  Replace
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    loadFile(file);
                  }
                  e.target.value = "";
                }}
              />
              <JsonEditor
                value={dataText}
                onChange={(v) => {
                  setDataText(v);
                }}
                height="140px"
                disableSchemaLinting
                jsonSchema={arrayJsonSchema}
              />
            </div>
          </div>
        ) : (
          /* ── Empty state ─────────────────────────────────── */
          <div className="flex flex-col gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  loadFile(file);
                }
                e.target.value = "";
              }}
            />
            <div
              role="button"
              tabIndex={0}
              aria-label="Drop a JSON file here or click to browse"
              className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isDragging
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/50 hover:bg-muted/50",
              )}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) =>
                e.key === "Enter" || e.key === " " ? fileInputRef.current?.click() : undefined
              }
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setIsDragging(false);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) {
                  loadFile(file);
                }
              }}
            >
              <FileJson
                className={cn("h-6 w-6", isDragging ? "text-primary" : "text-muted-foreground")}
              />
              <p className="text-xs font-medium">
                {isDragging
                  ? "Drop your data file here"
                  : "Upload a JSON array to test your schema"}
              </p>
              <p className="text-[11px] opacity-70">Drag & drop, or click to browse</p>
            </div>

            <div className="relative flex items-center gap-2">
              <div className="flex-1 border-t border-border" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                or paste
              </span>
              <div className="flex-1 border-t border-border" />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">JSON Array</Label>
              <JsonEditor
                value={dataText}
                onChange={(v) => {
                  setDataText(v);
                }}
                placeholder={'[\n  { "field": "value" }\n]'}
                height="160px"
                disableSchemaLinting
                jsonSchema={arrayJsonSchema}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
