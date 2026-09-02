import { AlertCircle, Code2, FileJson, LayoutTemplate, Save, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { inferSchemaFromData } from "../lib/infer-schema.js";
import { cn } from "./lib/utils.js";
import { Button } from "./primitives/button.js";
import { ConfirmDialog } from "./primitives/dialog.js";
import { JsonEditor } from "./primitives/json-editor.js";
import { SchemaPreview } from "./schema-preview.js";
import { ValidationPane } from "./validation-pane.js";
import type { ValidationState } from "./validation-pane.js";
import { VisualBuilder } from "./visual-builder.js";

const SCHEMA_SIZE_LIMIT = 102_400; // 100 KB

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

/** Validation error for the schema JSON string, or null when it's valid. */
function schemaJsonError(schemaJson: string): string | null {
  if (!schemaJson.trim()) {
    return "Schema is required.";
  }
  try {
    const p: unknown = JSON.parse(schemaJson);
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      return "Schema must be a JSON object.";
    }
    return schemaMetaError(p);
  } catch {
    return "Invalid JSON — please check your input.";
  }
}

/** Validation error for the UI-schema JSON string, or null when it's valid/empty. */
function uiSchemaJsonError(uiSchemaJson: string): string | null {
  if (!uiSchemaJson.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(uiSchemaJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "UI Schema must be a JSON object.";
    }
    return null;
  } catch {
    return "Invalid UI Schema JSON — please check your input.";
  }
}

/** Validate the required `title` / `description` metadata on a parsed schema. */
function schemaMetaError(p: object): string | null {
  if (!("title" in p) || typeof p.title !== "string" || !p.title.trim()) {
    return "Schema must have a non-empty 'title' property.";
  }
  if (!("description" in p) || typeof p.description !== "string" || !p.description.trim()) {
    return "Schema must have a non-empty 'description' property.";
  }
  return null;
}

interface SchemaEditorProps {
  initialJson?: string;
  initialUiSchemaJson?: string;
  onSave: (
    json: string,
    parsed: object,
    uiSchemaJson: string,
    uiSchemaParsed: object,
  ) => Promise<void>;
  saveLabel?: string;
  /**
   * Data to seed the validation pane with (a JSON array string). Updating it
   * re-seeds the pane — used by the dataset importer to push imported rows in
   * and to re-push them on re-upload without touching the schema.
   */
  dataText?: string;
  /**
   * When true, saving is blocked unless the seeded data is present and every
   * row validates against the current schema. Used when the dataset is being
   * pre-populated, so an invalid schema can't be saved against real data.
   */
  requireValidData?: boolean;
}

interface PendingFile {
  file: File;
  content: string;
  isDataArray: boolean;
}

type EditorTab = "visual" | "code" | "data";

/** Import mode opens on the Data tab; otherwise the Visual builder. */
function initialTab(requireValidData: boolean): EditorTab {
  return requireValidData ? "data" : "visual";
}

/** Tracks whether a file is being dragged over the document (for the overlay). */
function useFileDragOverlay(): [boolean, (dragging: boolean) => void] {
  const [isDraggingFile, setIsDraggingFile] = useState(false),
    dragLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const clearTimer = () => {
        if (dragLeaveTimer.current) {
          clearTimeout(dragLeaveTimer.current);
        }
      },
      show = (e: DragEvent) => {
        if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
          clearTimer();
          setIsDraggingFile(true);
        }
      },
      onDragOver = (e: DragEvent) => {
        e.preventDefault();
        show(e);
      },
      onDragLeave = () => {
        dragLeaveTimer.current = setTimeout(() => {
          setIsDraggingFile(false);
        }, 100);
      },
      onDrop = (e: DragEvent) => {
        e.preventDefault();
        setIsDraggingFile(false);
      };
    document.addEventListener("dragenter", show);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", show);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
  return [isDraggingFile, setIsDraggingFile];
}

function tabClass(active: boolean): string {
  return cn(
    "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors",
    active
      ? "bg-background text-foreground"
      : "text-muted-foreground hover:text-foreground hover:bg-background/50",
  );
}

function computeCanSave(
  schemaError: string | null,
  schemaOver: boolean,
  uiError: string | null,
  uiOver: boolean,
  requireValidData: boolean,
  isDataValid: boolean,
): boolean {
  if (schemaError || schemaOver || uiError || uiOver) {
    return false;
  }
  return !requireValidData || isDataValid;
}

/** First blocking reason a save can't proceed, or null when it can. */
function preSaveError(opts: {
  schemaError: string | null;
  schemaBytes: number;
  schemaOver: boolean;
  uiError: string | null;
  uiSchemaBytes: number;
  uiOver: boolean;
  requireValidData: boolean;
  isDataValid: boolean;
  validationState: ValidationState;
}): string | null {
  if (opts.schemaError) {
    return opts.schemaError;
  }
  if (opts.schemaOver) {
    return `Schema exceeds the 100 KB limit (${Math.round(opts.schemaBytes / 1024)} KB).`;
  }
  if (opts.uiError) {
    return opts.uiError;
  }
  if (opts.uiOver) {
    return `UI Schema exceeds the 100 KB limit (${Math.round(opts.uiSchemaBytes / 1024)} KB).`;
  }
  if (opts.requireValidData && !opts.isDataValid) {
    const { invalidItemCount, total } = opts.validationState;
    return total === 0
      ? "Import some data before saving."
      : `${invalidItemCount} row${invalidItemCount === 1 ? "" : "s"} don't match the schema. Fix the schema or re-upload matching data.`;
  }
  return null;
}

function DragOverlay({
  onDrop,
  onLeave,
}: {
  onDrop: (e: React.DragEvent) => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-auto"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={onLeave}
      onDrop={onDrop}
    >
      <div className="absolute inset-2 bg-background/90 backdrop-blur-sm border-4 border-dashed border-primary rounded-xl" />
      <div className="relative flex flex-col items-center gap-3 text-primary pointer-events-none">
        <FileJson className="h-14 w-14" />
        <p className="text-2xl font-semibold">Drop JSON file</p>
        <p className="text-sm text-muted-foreground">Schema object or data array</p>
      </div>
    </div>
  );
}

function ReplaceConfirmDialog({
  open,
  onOpenChange,
  pendingFile,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingFile: PendingFile | null;
  onConfirm: () => void;
}) {
  const pendingName = pendingFile ? pendingFile.file.name : "",
    pendingIsData = pendingFile ? pendingFile.isDataArray : false;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        pendingIsData
          ? `Load "${pendingName}" into validation pane?`
          : `Replace schema with "${pendingName}"?`
      }
      description={
        pendingIsData
          ? "This file contains a JSON array of objects. It will be loaded into the validation pane so you can test it against your schema."
          : "This will replace your current schema content."
      }
      confirmLabel={pendingIsData ? "Load into data pane" : "Replace"}
      cancelLabel="Cancel"
      destructive={!pendingIsData}
      onConfirm={onConfirm}
    />
  );
}

function EditorToolbar({
  activeTab,
  onSwitchVisual,
  onSelectTab,
  onUploadFile,
  onSave,
  canSave,
  isSaving,
  saveLabel,
}: {
  activeTab: EditorTab;
  onSwitchVisual: () => void;
  onSelectTab: (tab: EditorTab) => void;
  onUploadFile: (file: File) => void;
  onSave: () => void;
  canSave: boolean;
  isSaving: boolean;
  saveLabel: string;
}) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 bg-muted/30 shrink-0">
      <div className="flex rounded-md border border-border overflow-hidden">
        <button type="button" onClick={onSwitchVisual} className={tabClass(activeTab === "visual")}>
          <LayoutTemplate className="h-3.5 w-3.5" />
          Visual
        </button>
        <button
          type="button"
          onClick={() => {
            onSelectTab("code");
          }}
          className={cn(tabClass(activeTab === "code"), "border-l border-border")}
        >
          <Code2 className="h-3.5 w-3.5" />
          Code
        </button>
        <button
          type="button"
          onClick={() => {
            onSelectTab("data");
          }}
          className={cn(tabClass(activeTab === "data"), "border-l border-border")}
        >
          <FileJson className="h-3.5 w-3.5" />
          Data
        </button>
      </div>

      <div className="flex-1" />

      <input
        ref={uploadInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = firstFile(e.target.files);
          if (file) {
            onUploadFile(file);
          }
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          if (uploadInputRef.current) {
            uploadInputRef.current.click();
          }
        }}
      >
        <Upload className="h-3.5 w-3.5 mr-1.5" />
        Upload
      </Button>

      <Button type="button" size="sm" disabled={isSaving || !canSave} onClick={onSave}>
        <Save className="h-3.5 w-3.5 mr-1.5" />
        {isSaving ? "Saving…" : saveLabel}
      </Button>
    </div>
  );
}

function SizeWarnings({
  schemaOver,
  uiOver,
  schemaBytes,
  uiSchemaBytes,
}: {
  schemaOver: boolean;
  uiOver: boolean;
  schemaBytes: number;
  uiSchemaBytes: number;
}) {
  if (!schemaOver && !uiOver) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive shrink-0">
      {schemaOver && (
        <div className="flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          Schema exceeds 100 KB limit ({Math.round(schemaBytes / 1024)} KB). Reduce its size before
          saving.
        </div>
      )}
      {uiOver && (
        <div className="flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          UI Schema exceeds 100 KB limit ({Math.round(uiSchemaBytes / 1024)} KB). Reduce its size
          before saving.
        </div>
      )}
    </div>
  );
}

function DataValidityWarning({
  total,
  invalidItemCount,
}: {
  total: number;
  invalidItemCount: number;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-amber-300/40 bg-amber-50 dark:bg-amber-950/40 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300 shrink-0">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      {total === 0
        ? "Import data to pre-populate this dataset before saving."
        : `${invalidItemCount} of ${total} imported row${total === 1 ? "" : "s"} don't match the schema. Adjust the schema or re-upload matching data — saving is blocked until every row is valid.`}
    </div>
  );
}

function EditorTabPanel({
  activeTab,
  schemaJson,
  onSchemaJson,
  validationState,
  externalDataText,
  onInferSchema,
  onStateChange,
}: {
  activeTab: EditorTab;
  schemaJson: string;
  onSchemaJson: (value: string) => void;
  validationState: ValidationState;
  externalDataText: { text: string } | undefined;
  onInferSchema: (inferredJson: string) => void;
  onStateChange: (state: ValidationState) => void;
}) {
  return (
    <div className="flex-1 overflow-auto p-4">
      {activeTab === "visual" && (
        <VisualBuilder
          schemaJson={schemaJson}
          onChange={onSchemaJson}
          validationFailingPaths={validationState.failingPaths}
          totalDataItems={validationState.total}
        />
      )}
      {activeTab === "code" && (
        <JsonEditor
          value={schemaJson}
          onChange={onSchemaJson}
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
          onInferSchema={onInferSchema}
          onStateChange={onStateChange}
        />
      )}
    </div>
  );
}

export function SchemaEditor({
  initialJson = "",
  initialUiSchemaJson = "",
  onSave,
  saveLabel = "Save",
  dataText,
  requireValidData = false,
}: SchemaEditorProps) {
  const [schemaJson, setSchemaJson] = useState(initialJson),
    [uiSchemaJson, setUiSchemaJson] = useState(initialUiSchemaJson),
    [activeTab, setActiveTab] = useState<EditorTab>(initialTab(requireValidData)),
    [isSaving, setIsSaving] = useState(false),
    // Validation pane state (lifted for visual builder badges)
    [validationState, setValidationState] = useState<ValidationState>({
      failingPaths: new Map(),
      invalidItemCount: 0,
      total: 0,
    }),
    // External data to push into the validation pane. Seeded from `dataText` by
    // the effect below (wrapped in an object so re-sending identical content
    // still triggers it).
    [externalDataText, setExternalDataText] = useState<{ text: string } | undefined>(undefined);

  // Re-seed the validation pane whenever the controlled `dataText` prop changes
  // (initial import + every re-upload).
  useEffect(() => {
    if (dataText !== undefined) {
      // Sync the controlled data prop into the validation pane on every re-upload.
      // oxlint-disable-next-line react/set-state-in-effect
      setExternalDataText({ text: dataText });
    }
  }, [dataText]);

  // Drag & drop
  const [isDraggingFile, setIsDraggingFile] = useFileDragOverlay(),
    [pendingFile, setPendingFile] = useState<PendingFile | null>(null),
    [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false),
    schemaBytes = new Blob([schemaJson]).size,
    isOverLimit = schemaBytes > SCHEMA_SIZE_LIMIT;

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

        if (Array.isArray(parsed)) {
          // Data array — offer to infer schema or load into validation pane
          if (schemaJson.trim()) {
            setPendingFile({ content, file, isDataArray: true });
            setIsConfirmDialogOpen(true);
          } else {
            // No schema yet — infer directly
            const inferred = inferSchemaFromData(parsed);
            setSchemaJson(JSON.stringify(inferred, null, 2));
            toast.success(`Schema inferred from ${file.name}! Fill in title and description.`);
          }
        } else if (schemaJson.trim()) {
          // It's a schema object
          setPendingFile({ content, file, isDataArray: false });
          setIsConfirmDialogOpen(true);
        } else {
          setSchemaJson(content);
          toast.success(`Loaded schema from ${file.name}`);
        }
      },
      [schemaJson],
    ),
    handleOverlayDrop = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingFile(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        void processFile(file);
      }
    },
    handleConfirm = () => {
      if (!pendingFile) {
        return;
      }
      if (pendingFile.isDataArray) {
        // Load into validation pane
        setExternalDataText({ text: pendingFile.content });
        toast.success(`Loaded ${pendingFile.file.name} into the validation pane.`);
      } else {
        setSchemaJson(pendingFile.content);
        toast.success(`Replaced schema with ${pendingFile.file.name}`);
      }
      setPendingFile(null);
    },
    handleSwitchToVisual = () => {
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
    },
    uiSchemaBytes = new Blob([uiSchemaJson]).size,
    isUiSchemaOverLimit = uiSchemaBytes > SCHEMA_SIZE_LIMIT,
    handleSave = async () => {
      const error = preSaveError({
        isDataValid,
        requireValidData,
        schemaBytes,
        schemaError: schemaJsonError(schemaJson),
        schemaOver: isOverLimit,
        uiError: uiSchemaJsonError(uiSchemaJson),
        uiOver: isUiSchemaOverLimit,
        uiSchemaBytes,
        validationState,
      });
      if (error) {
        toast.error(error);
        return;
      }
      const parsedSchema: object = JSON.parse(schemaJson),
        parsedUiSchema: object = uiSchemaJson.trim() ? JSON.parse(uiSchemaJson) : {};
      setIsSaving(true);
      try {
        await onSave(schemaJson, parsedSchema, uiSchemaJson, parsedUiSchema);
      } finally {
        setIsSaving(false);
      }
    },
    // When pre-populating a dataset, every imported row must validate.
    isDataValid = validationState.total > 0 && validationState.invalidItemCount === 0,
    canSave = computeCanSave(
      schemaJsonError(schemaJson),
      isOverLimit,
      uiSchemaJsonError(uiSchemaJson),
      isUiSchemaOverLimit,
      requireValidData,
      isDataValid,
    );

  const showDataWarning = requireValidData && !isDataValid && !schemaJsonError(schemaJson);

  return (
    <div className="relative flex flex-col gap-4">
      {isDraggingFile && (
        <DragOverlay
          onDrop={handleOverlayDrop}
          onLeave={() => {
            setIsDraggingFile(false);
          }}
        />
      )}

      <ReplaceConfirmDialog
        open={isConfirmDialogOpen}
        onOpenChange={setIsConfirmDialogOpen}
        pendingFile={pendingFile}
        onConfirm={handleConfirm}
      />

      {/* Main two-panel layout */}
      <div className="flex gap-4" style={{ minHeight: "600px" }}>
        {/* Left panel: editor */}
        <div className="flex flex-col flex-1 min-w-0 rounded-lg border border-border overflow-hidden">
          <EditorToolbar
            activeTab={activeTab}
            onSwitchVisual={handleSwitchToVisual}
            onSelectTab={setActiveTab}
            onUploadFile={processFile}
            onSave={handleSave}
            canSave={canSave}
            isSaving={isSaving}
            saveLabel={saveLabel}
          />

          <SizeWarnings
            schemaOver={isOverLimit}
            uiOver={isUiSchemaOverLimit}
            schemaBytes={schemaBytes}
            uiSchemaBytes={uiSchemaBytes}
          />

          {showDataWarning && (
            <DataValidityWarning
              total={validationState.total}
              invalidItemCount={validationState.invalidItemCount}
            />
          )}

          <EditorTabPanel
            activeTab={activeTab}
            schemaJson={schemaJson}
            onSchemaJson={setSchemaJson}
            validationState={validationState}
            externalDataText={externalDataText}
            onInferSchema={(inferredJson) => {
              setSchemaJson(inferredJson);
              toast.success("Schema inferred! Fill in title and description to finish.");
            }}
            onStateChange={setValidationState}
          />
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
              placeholder={
                '{\n  "ui:submitButtonOptions": {\n    "submitText": "Create Entry"\n  }\n}'
              }
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
