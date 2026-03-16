import { useState, useRef, useEffect, useCallback } from "react";
import { Save, Upload, FileJson, Code2, LayoutTemplate, AlertCircle } from "lucide-react";
import { Button } from "#/components/ui/button";
import { JsonEditor } from "#/components/ui/json-editor";
import { ConfirmDialog } from "#/components/ui/dialog";
import { cn } from "#/lib/utils";
import { inferSchemaFromData } from "#/lib/infer-schema";
import { toast } from "sonner";
import { VisualBuilder } from "./visual-builder";
import { ValidationPane, type ValidationState } from "./validation-pane";
import { SchemaPreview } from "./schema-preview";

const SCHEMA_SIZE_LIMIT = 102400; // 100 KB

interface SchemaEditorProps {
  initialJson?: string;
  initialUiSchemaJson?: string;
  onSave: (json: string, parsed: object, uiSchemaJson: string, uiSchemaParsed: object) => Promise<void>;
  saveLabel?: string;
}

type PendingFile = { file: File; content: string; isDataArray: boolean };

export function SchemaEditor({
  initialJson = "",
  initialUiSchemaJson = "",
  onSave,
  saveLabel = "Save",
}: SchemaEditorProps) {
  const [schemaJson, setSchemaJson] = useState(initialJson);
  const [uiSchemaJson, setUiSchemaJson] = useState(initialUiSchemaJson);
  const [activeTab, setActiveTab] = useState<"visual" | "code" | "data">("visual");
  const [isSaving, setIsSaving] = useState(false);

  // Validation pane state (lifted for visual builder badges)
  const [validationState, setValidationState] = useState<ValidationState>({
    total: 0,
    failingPaths: new Map(),
  });
  // External data to push into the validation pane. Wrapped in object so re-sending the same content still triggers the effect.
  const [externalDataText, setExternalDataText] = useState<{ text: string } | undefined>(undefined);

  // Drag & drop
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const dragLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schemaBytes = new Blob([schemaJson]).size;
  const isOverLimit = schemaBytes > SCHEMA_SIZE_LIMIT;

  const getParseError = (): string | null => {
    if (!schemaJson.trim()) return "Schema is required.";
    try {
      const p = JSON.parse(schemaJson);
      if (typeof p !== "object" || p === null || Array.isArray(p))
        return "Schema must be a JSON object.";
      const obj = p as Record<string, unknown>;
      if (!obj.title || typeof obj.title !== "string" || !obj.title.trim())
        return "Schema must have a non-empty 'title' property.";
      if (!obj.description || typeof obj.description !== "string" || !obj.description.trim())
        return "Schema must have a non-empty 'description' property.";
      return null;
    } catch {
      return "Invalid JSON — please check your input.";
    }
  };

  // Document-level drag events for the full-page overlay
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        if (dragLeaveTimer.current) clearTimeout(dragLeaveTimer.current);
        setIsDraggingFile(true);
      }
    };
    const onDragLeave = () => {
      dragLeaveTimer.current = setTimeout(() => setIsDraggingFile(false), 100);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes("Files")) {
        if (dragLeaveTimer.current) clearTimeout(dragLeaveTimer.current);
        setIsDraggingFile(true);
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDraggingFile(false);
    };
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  const readFileAsText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve((e.target?.result as string) ?? "");
      reader.onerror = reject;
      reader.readAsText(file);
    });

  const processFile = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".json") && file.type !== "application/json") {
        toast.error("Please drop a .json file.");
        return;
      }
      let content: string;
      try {
        content = await readFileAsText(file);
      } catch {
        toast.error("Could not read that file.");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        toast.error("That file does not contain valid JSON.");
        return;
      }

      const isDataArray = Array.isArray(parsed);

      if (isDataArray) {
        // Data array — offer to infer schema or load into validation pane
        if (schemaJson.trim()) {
          setPendingFile({ file, content, isDataArray: true });
          setIsConfirmDialogOpen(true);
        } else {
          // No schema yet — infer directly
          const inferred = inferSchemaFromData(parsed as unknown[]);
          setSchemaJson(JSON.stringify(inferred, null, 2));
          toast.success(`Schema inferred from ${file.name}! Fill in title and description.`);
        }
      } else {
        // It's a schema object
        if (schemaJson.trim()) {
          setPendingFile({ file, content, isDataArray: false });
          setIsConfirmDialogOpen(true);
        } else {
          setSchemaJson(content);
          toast.success(`Loaded schema from ${file.name}`);
        }
      }
    },
    [schemaJson],
  );

  const handleOverlayDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleConfirm = () => {
    if (!pendingFile) return;
    if (pendingFile.isDataArray) {
      // Load into validation pane
      setExternalDataText({ text: pendingFile.content });
      toast.success(`Loaded ${pendingFile.file.name} into the validation pane.`);
    } else {
      setSchemaJson(pendingFile.content);
      toast.success(`Replaced schema with ${pendingFile.file.name}`);
    }
    setPendingFile(null);
  };

  const handleSwitchToVisual = () => {
    if (activeTab === "code") {
      // Empty editor is fine — visual builder shows a blank canvas
      if (!schemaJson.trim()) {
        setActiveTab("visual");
        return;
      }
      try {
        JSON.parse(schemaJson);
        setActiveTab("visual");
      } catch {
        toast.error("Fix the JSON syntax error before switching to Visual mode.");
      }
    }
  };

  const getUiSchemaParseError = (): string | null => {
    if (!uiSchemaJson.trim()) return null;
    try {
      const parsed = JSON.parse(uiSchemaJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "UI Schema must be a JSON object.";
      }
      return null;
    } catch {
      return "Invalid UI Schema JSON — please check your input.";
    }
  };

  const uiSchemaBytes = new Blob([uiSchemaJson]).size;
  const isUiSchemaOverLimit = uiSchemaBytes > SCHEMA_SIZE_LIMIT;

  const handleSave = async () => {
    const err = getParseError();
    if (err) {
      toast.error(err);
      return;
    }
    if (isOverLimit) {
      toast.error(`Schema exceeds the 100 KB limit (${Math.round(schemaBytes / 1024)} KB).`);
      return;
    }
    const uiSchemaErr = getUiSchemaParseError();
    if (uiSchemaErr) {
      toast.error(uiSchemaErr);
      return;
    }
    if (isUiSchemaOverLimit) {
      toast.error(`UI Schema exceeds the 100 KB limit (${Math.round(uiSchemaBytes / 1024)} KB).`);
      return;
    }
    setIsSaving(true);
    try {
      await onSave(
        schemaJson,
        JSON.parse(schemaJson) as object,
        uiSchemaJson,
        uiSchemaJson.trim() ? (JSON.parse(uiSchemaJson) as object) : {}
      );
    } finally {
      setIsSaving(false);
    }
  };

  const canSave = !getParseError() && !isOverLimit && !getUiSchemaParseError() && !isUiSchemaOverLimit;

  return (
    <div className="relative flex flex-col gap-4">
      {/* Full-page drag overlay */}
      {isDraggingFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center pointer-events-auto"
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={handleOverlayDrop}
        >
          <div className="absolute inset-2 bg-background/90 backdrop-blur-sm border-4 border-dashed border-primary rounded-xl" />
          <div className="relative flex flex-col items-center gap-3 text-primary pointer-events-none">
            <FileJson className="h-14 w-14" />
            <p className="text-2xl font-semibold">Drop JSON file</p>
            <p className="text-sm text-muted-foreground">Schema object or data array</p>
          </div>
        </div>
      )}

      {/* Replace/load confirmation dialog */}
      <ConfirmDialog
        open={isConfirmDialogOpen}
        onOpenChange={setIsConfirmDialogOpen}
        title={
          pendingFile?.isDataArray
            ? `Load "${pendingFile.file.name}" into validation pane?`
            : `Replace schema with "${pendingFile?.file.name}"?`
        }
        description={
          pendingFile?.isDataArray
            ? "This file contains a JSON array of objects. It will be loaded into the validation pane so you can test it against your schema."
            : "This will replace your current schema content."
        }
        confirmLabel={pendingFile?.isDataArray ? "Load into data pane" : "Replace"}
        cancelLabel="Cancel"
        destructive={!pendingFile?.isDataArray}
        onConfirm={handleConfirm}
      />

      {/* Main two-panel layout */}
      <div className="flex gap-4" style={{ minHeight: "600px" }}>
        {/* Left panel: editor */}
        <div className="flex flex-col flex-1 min-w-0 rounded-lg border border-border overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 bg-muted/30 shrink-0">
            {/* Mode tabs */}
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={handleSwitchToVisual}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors",
                  activeTab === "visual"
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                <LayoutTemplate className="h-3.5 w-3.5" />
                Visual
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("code")}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors border-l border-border",
                  activeTab === "code"
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                <Code2 className="h-3.5 w-3.5" />
                Code
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("data")}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors border-l border-border",
                  activeTab === "data"
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50",
                )}
              >
                <FileJson className="h-3.5 w-3.5" />
                Data
              </button>
            </div>

            <div className="flex-1" />

            {/* Upload schema button */}
            <input
              ref={uploadInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) processFile(file);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Upload
            </Button>

            <Button type="button" size="sm" disabled={isSaving || !canSave} onClick={handleSave}>
              <Save className="h-3.5 w-3.5 mr-1.5" />
              {isSaving ? "Saving…" : saveLabel}
            </Button>
          </div>

          {/* Size warnings */}
          {(isOverLimit || isUiSchemaOverLimit) && (
            <div className="flex flex-col gap-1 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive shrink-0">
              {isOverLimit && (
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  Schema exceeds 100 KB limit ({Math.round(schemaBytes / 1024)} KB). Reduce its size
                  before saving.
                </div>
              )}
              {isUiSchemaOverLimit && (
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  UI Schema exceeds 100 KB limit ({Math.round(uiSchemaBytes / 1024)} KB). Reduce its
                  size before saving.
                </div>
              )}
            </div>
          )}

          {/* Editor content */}
          <div className="flex-1 overflow-auto p-4">
            {activeTab === "visual" && (
              <VisualBuilder
                schemaJson={schemaJson}
                onChange={setSchemaJson}
                validationFailingPaths={validationState.failingPaths}
                totalDataItems={validationState.total}
              />
            )}
            {activeTab === "code" && (
              <JsonEditor
                value={schemaJson}
                onChange={setSchemaJson}
                placeholder={
                  '{\n  "title": "My Schema",\n  "description": "...",\n  "type": "object",\n  "properties": {}\n}'
                }
                height="560px"
              />
            )}
            {activeTab === "data" && (
              <ValidationPane
                schemaJson={schemaJson}
                externalDataText={externalDataText}
                onInferSchema={(inferredJson) => {
                  setSchemaJson(inferredJson);
                  toast.success("Schema inferred! Fill in title and description to finish.");
                }}
                onStateChange={setValidationState}
              />
            )}
          </div>
        </div>

        {/* Right panel: UI Schema editor */}
        <div className="w-80 xl:w-96 shrink-0 flex flex-col rounded-lg border border-border overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 bg-muted/30 shrink-0">
            <span className="text-xs font-medium">UI Schema</span>
          </div>
          <div className="flex-1 overflow-auto">
            <JsonEditor
              value={uiSchemaJson}
              onChange={setUiSchemaJson}
              placeholder={'{\n  "ui:submitButtonOptions": {\n    "submitText": "Create Entry"\n  }\n}'}
              height="540px"
            />
          </div>
        </div>
      </div>

      {/* Preview card - spans full width below the two panels */}
      <SchemaPreview schemaJson={schemaJson} uiSchemaJson={uiSchemaJson} />
    </div>
  );
}
