import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Database, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { DatasetPickerSheet } from "#/components/dataset-picker-sheet";
import { TransformPreview } from "#/components/transform-preview";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#convex/_generated/api";
import {
  NO_COLUMN,
  PREVIEW_ROW_COUNT,
  builderOperationsFromSpec,
  draftToSpec,
  firstIncompleteReason,
  fromBuilderOperation,
  isLookupComplete,
  type BuilderOperation,
} from "#/lib/transform-model";

/**
 * The Transform tab's editor (roadmap stage 2, #95; docs/derived-datasets-design.md
 * §8): pick the related dataset (key columns auto-suggested from the
 * declared structures) → pick fields → live preview with dataset-wide
 * match stats → save.
 *
 * Durability follows the catalog lifecycle's builder rule ("autosave early
 * and often", docs/catalog-lifecycle-design.md §6): every edit debounce-saves
 * a DRAFT registry row, so a reload reconstructs the in-progress spec from
 * the registry; the explicit Save flips the same row to "saved". Required
 * fields surface in the footer — the Save button explains what's missing
 * rather than sitting silently disabled (the UI-polish rule).
 */

const AUTOSAVE_DELAY_MS = 800;

type DatasetSummary = FunctionReturnType<typeof api.schemas.listSummaries>[number];

interface InitialDraft {
  description: string;
  operations: BuilderOperation[];
  title: string;
}

const EMPTY_DRAFT: InitialDraft = { description: "", operations: [], title: "" };

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** A "pick a column" select that keeps a stale stored value visible (marked) so health issues are re-fixable, not invisible. */
function ColumnSelect({
  columns,
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  columns: string[];
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const options =
    value === NO_COLUMN || columns.includes(value) ? columns : [value, ...columns];
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        disabled={columns.length === 0}
        value={value === NO_COLUMN ? null : value}
        onValueChange={(next) => {
          onChange(next ?? NO_COLUMN);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((column) => (
            <SelectItem key={column} value={column}>
              {column}
              {column === value && !columns.includes(column) ? " (missing now)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A select's option list: the declared columns, with a stored-but-now-missing selection kept visible so it can be re-picked. */
function withSelection(columns: string[], selected: string): string[] {
  return selected === NO_COLUMN || columns.includes(selected) ? columns : [selected, ...columns];
}

function candidateTitle(chosen: DatasetSummary | undefined): string | undefined {
  return chosen === undefined ? undefined : chosen.title;
}

/** One lookup step's configuration. */
function LookupStep({
  candidates,
  columns,
  index,
  onChange,
  onRemove,
  operation,
  removable,
  schemaId,
}: {
  /** Undefined while the catalog list is loading — a picked dataset's kind is then unknown. */
  candidates: DatasetSummary[] | undefined;
  columns: string[];
  index: number;
  onChange: (patch: Partial<BuilderOperation>) => void;
  onRemove: () => void;
  operation: BuilderOperation;
  removable: boolean;
  schemaId: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false),
    candidatesReady = candidates !== undefined,
    candidateById = new Map((candidates ?? []).map((entry) => [entry._id, entry])),
    chosen = candidateById.get(operation.lookupDatasetId),
    // A picked dataset whose catalog entry hasn't loaded yet is of UNKNOWN
    // kind — not derived, not component — so the step shows loading state
    // instead of deciding.
    sideUnknown = !candidatesReady && operation.lookupDatasetId !== NO_COLUMN,
    // A component dataset has a declared structure to suggest from; a
    // registry id (derived-of-derived, authored via the API today) does not.
    isComponentDataset = chosen !== undefined,
    lookupSchema = useQuery({
      ...convexQuery(
        api.schemas.get,
        isComponentDataset ? { schemaId: operation.lookupDatasetId } : "skip",
      ),
    }).data,
    // The declared columns of the related dataset — the same idiom the
    // Structure tab uses on the page's own schema.
    lookupProperties =
      lookupSchema === null || lookupSchema === undefined
        ? []
        : Object.keys(lookupSchema.schema.properties ?? {}),
    lookupColumns = withSelection(lookupProperties, operation.lookupKey),
    pickableFields = lookupColumns.filter((column) => column !== operation.lookupKey),
    baseKeyColumns = withSelection(columns, operation.baseKey);

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <StepHeader index={index} removable={removable} onRemove={onRemove} />

      <DatasetSourceRow
        chosenTitle={candidateTitle(chosen)}
        loading={sideUnknown}
        lookupDatasetId={operation.lookupDatasetId}
        onOpenPicker={() => {
          setPickerOpen(true);
        }}
      />

      <KeyColumnsRow
        index={index}
        lookupReady={candidatesReady}
        lookupColumns={lookupColumns}
        lookupKey={operation.lookupKey}
        pickedComponentDataset={isComponentDataset}
        sourceColumns={baseKeyColumns}
        sourceKey={operation.baseKey}
        onChange={onChange}
      />

      {isComponentDataset && candidatesReady && (
        <FieldsPicker
          fields={operation.fields ?? []}
          fieldsMode={operation.fieldsMode}
          loadingColumns={lookupSchema === undefined}
          pickableFields={pickableFields}
          onModeChange={(fieldsMode) => {
            onChange(fieldsMode === "all" ? { fieldsMode } : { fields: operation.fields ?? [], fieldsMode });
          }}
          onToggleField={(field, checked) => {
            const current = operation.fields ?? [];
            onChange({
              fields: checked ? [...current, field] : current.filter((entry) => entry !== field),
            });
          }}
        />
      )}

      <PolicySelects
        index={index}
        match={operation.match}
        onDuplicateKey={operation.onDuplicateKey}
        onChange={onChange}
      />

      <RelatedDatasetPickerSheet
        candidates={candidates}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(dataset) => {
          onChange({
            fields: undefined,
            fieldsMode: "all",
            lookupDatasetId: dataset._id,
            lookupKey: NO_COLUMN,
            namespace: dataset.title,
          });
        }}
        schemaId={schemaId}
      />
    </div>
  );
}

/**
 * The related-dataset picker over the component catalog (this dataset
 * excluded) — with the namespace rule applied: the picked dataset's title
 * becomes the enrichment namespace (the engine's opaque-id fallback never
 * fires for a picked catalog dataset).
 */
function RelatedDatasetPickerSheet({
  candidates,
  onOpenChange,
  onPick,
  open,
  schemaId,
}: {
  /** Undefined while the catalog list loads — the sheet then lists nothing yet. */
  candidates: DatasetSummary[] | undefined;
  onOpenChange: (open: boolean) => void;
  onPick: (dataset: DatasetSummary) => void;
  open: boolean;
  schemaId: string;
}) {
  return (
    <DatasetPickerSheet
      title="Choose the related dataset"
      description="Its rows enrich this dataset's rows on the matching key."
      candidates={(candidates ?? []).filter((entry) => entry._id !== schemaId)}
      open={open}
      onOpenChange={onOpenChange}
      onPick={async (dataset) => {
        onPick(dataset);
      }}
    />
  );
}

/** The step's title row with its remove button. */
function StepHeader({
  index,
  onRemove,
  removable,
}: {
  index: number;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-medium">Lookup step {index + 1}</p>
      {removable && (
        <Button
          aria-label={`Remove lookup step ${index + 1}`}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

/** The two join-key pickers: one column on this dataset, one on the related dataset (select when its structure is declared, free text when it is a derived dataset). */
function KeyColumnsRow({
  index,
  lookupColumns,
  lookupKey,
  lookupReady,
  onChange,
  pickedComponentDataset,
  sourceColumns,
  sourceKey,
}: {
  index: number;
  lookupColumns: string[];
  lookupKey: string;
  lookupReady: boolean;
  onChange: (patch: Partial<BuilderOperation>) => void;
  pickedComponentDataset: boolean;
  sourceColumns: string[];
  sourceKey: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ColumnSelect
        columns={sourceColumns}
        id={`transform-base-key-${index}`}
        label="Key column on this dataset"
        placeholder={pickedComponentDataset ? "Select a column" : "Choose the related dataset first"}
        value={sourceKey}
        onChange={(next) => {
          onChange({ baseKey: next });
        }}
      />
      {!lookupReady ? (
        <div className="flex flex-col gap-2">
          <Label>Key column on the related dataset</Label>
          <p className="text-xs text-muted-foreground">Loading the related dataset's columns…</p>
        </div>
      ) : pickedComponentDataset ? (
        <ColumnSelect
          columns={lookupColumns}
          id={`transform-lookup-key-${index}`}
          label="Key column on the related dataset"
          placeholder="Select a column"
          value={lookupKey}
          onChange={(next) => {
            onChange({ lookupKey: next });
          }}
        />
      ) : (
        <FreeTextKeyColumn
          index={index}
          value={lookupKey}
          onChange={(next) => {
            onChange({ lookupKey: next });
          }}
        />
      )}
    </div>
  );
}

/** The related-dataset row: the picker button, the derived-source marker, and the namespacing note. */
function DatasetSourceRow({
  chosenTitle,
  loading,
  lookupDatasetId,
  onOpenPicker,
}: {
  chosenTitle: string | undefined;
  loading: boolean;
  lookupDatasetId: string;
  onOpenPicker: () => void;
}) {
  const picked = lookupDatasetId !== NO_COLUMN;
  return (
    <div className="flex flex-col gap-2">
      <Label>Related dataset</Label>
      <div className="flex items-center gap-2">
        <Button size="sm" type="button" variant="outline" onClick={onOpenPicker}>
          <Database className="h-3.5 w-3.5" />
          {chosenTitle === undefined && !picked ? "Choose a dataset…" : chosenTitle ?? lookupDatasetId}
        </Button>
        {!picked || chosenTitle !== undefined || loading ? null : (
          <Badge variant="outline" title="Not an imported dataset — likely another derived dataset.">
            Derived source
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {chosenTitle === undefined
          ? !picked
            ? "Its fields arrive on this dataset's rows, namespaced (e.g. \u201cGrants.Status\u201d)."
            : loading
              ? "Loading the related dataset's info…"
              : "Reads another derived dataset — column pickers and preview for derived sources land in stage 3; type the key column for now."
          : `Brought-in fields are namespaced as \u201c${chosenTitle}.<field>\u201d so exports stay unambiguous.`}
      </p>
    </div>
  );
}

/** The free-text key column for datasets without a declared structure to suggest from. */
function FreeTextKeyColumn({
  index,
  value,
  onChange,
}: {
  index: number;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`transform-lookup-key-${index}`}>Key column on the related dataset</Label>
      <Input
        id={`transform-lookup-key-${index}`}
        value={value === NO_COLUMN ? "" : value}
        placeholder="Type the column name"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

/** Which enrichment fields arrive: every field but the join key (the engine's omit-means-all), or an explicit pick. */
function FieldsPicker({
  fields,
  fieldsMode,
  loadingColumns,
  pickableFields,
  onModeChange,
  onToggleField,
}: {
  fields: string[];
  fieldsMode: "all" | "pick";
  loadingColumns: boolean;
  pickableFields: string[];
  onModeChange: (mode: "all" | "pick") => void;
  onToggleField: (field: string, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Fields to bring in</Label>
      <div className="flex gap-2">
        <Button
          size="sm"
          type="button"
          variant={fieldsMode === "all" ? "default" : "outline"}
          onClick={() => {
            onModeChange("all");
          }}
        >
          All fields
        </Button>
        <Button
          size="sm"
          type="button"
          variant={fieldsMode === "pick" ? "default" : "outline"}
          onClick={() => {
            onModeChange("pick");
          }}
        >
          Choose fields
        </Button>
      </div>
      {fieldsMode === "all" ? (
        <p className="text-xs text-muted-foreground">
          Every field except the join key arrives, namespaced — first-seen across the data.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
          {pickableFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {loadingColumns ? "Loading columns…" : "No fields declared yet."}
            </p>
          ) : (
            pickableFields.map((field) => (
              <label key={field} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={fields.includes(field)}
                  onCheckedChange={(checked) => {
                    onToggleField(field, checked);
                  }}
                />
                {field}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** The two §6 policy selects: the match policy and the duplicate-key policy (decided, not implicit). */
function PolicySelects({
  index,
  match,
  onChange,
  onDuplicateKey,
}: {
  index: number;
  match: "inner" | "left" | undefined;
  onChange: (patch: Partial<BuilderOperation>) => void;
  onDuplicateKey: "error" | "first" | "last" | undefined;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`transform-match-${index}`}>Rows without a match</Label>
        <Select
          value={match ?? "left"}
          onValueChange={(next) => {
            onChange({ match: next === "inner" ? "inner" : undefined });
          }}
        >
          <SelectTrigger id={`transform-match-${index}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Keep them (left join)</SelectItem>
            <SelectItem value="inner">Drop them (inner join)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`transform-dupes-${index}`}>Duplicate keys in the lookup</Label>
        <Select
          value={onDuplicateKey ?? "first"}
          onValueChange={(next) => {
            onChange({ onDuplicateKey: next === "last" || next === "error" ? next : undefined });
          }}
        >
          <SelectTrigger id={`transform-dupes-${index}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="first">Keep the first match</SelectItem>
            <SelectItem value="last">Keep the last match</SelectItem>
            <SelectItem value="error">Treat as an error</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}


function TransformEditorForm({
  columns,
  datasetTitle,
  docId,
  initial,
  onClose,
  schemaId,
}: {
  columns: string[];
  datasetTitle: string;
  docId: string | undefined;
  initial: InitialDraft;
  onClose: () => void;
  schemaId: string;
}) {
  const save = useMutation(api.derivedDatasets.save),
    remove = useMutation(api.derivedDatasets.remove),
    candidates = useQuery({ ...convexQuery(api.schemas.listSummaries, {}) }).data,
    componentIds = new Set((candidates ?? []).map((entry) => entry._id)),
    [title, setTitle] = useState(initial.title),
    [description, setDescription] = useState(initial.description),
    [operations, setOperations] = useState(initial.operations),
    [dirty, setDirty] = useState(false),
    [autosave, setAutosave] = useState<"error" | "idle" | "saved" | "saving">("idle"),
    [savedId, setSavedId] = useState<string | undefined>(docId),
    // The in-flight autosave's promise, if any: explicit Save awaits it so
    // both paths share one minted id — clicking Save while the debounced
    // autosave is mid-flight would otherwise insert a second registry row
    // for the same logical transform.
    pendingSaveRef = useRef<Promise<string | undefined> | null>(null),
    previewOperations = operations
      .filter((operation) => isLookupComplete(operation) && componentIds.has(operation.lookupDatasetId))
      .map(fromBuilderOperation),
    completedCount = operations.filter(isLookupComplete).length,
    saveReason = firstIncompleteReason(operations),
    // Autosave granularity: a non-empty title and at least one COMPLETE step
    // (the registry validates shape; half-picked steps stay local).
    canAutosave = title.trim() !== "" && completedCount > 0,
    editOperations = (next: BuilderOperation[]) => {
      setOperations(next);
      setDirty(true);
    },
    patchOperation = (index: number, patch: Partial<BuilderOperation>) => {
      editOperations(
        operations.map((operation, operationIndex) =>
          operationIndex === index ? { ...operation, ...patch } : operation,
        ),
      );
    };

  // Debounced autosave (the lifecycle doc's "autosave early and often"): a
  // reload reconstructs the draft from the registry. State changes land in
  // async callbacks only — never synchronously in the effect body.
  useEffect(() => {
    if (!dirty || !canAutosave) {
      return undefined;
    }
    const timer = setTimeout(() => {
      const run = (async () => {
        setAutosave("saving");
        try {
          const id = await save({
            description: description.trim() === "" ? undefined : description.trim(),
            id: savedId,
            spec: draftToSpec(schemaId, operations),
            status: "draft",
            title: title.trim(),
          });
          setSavedId(id);
          setDirty(false);
          setAutosave("saved");
          return id;
        } catch {
          setAutosave("error");
          return undefined;
        }
      })();
      pendingSaveRef.current = run;
    }, AUTOSAVE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [
    canAutosave,
    description,
    dirty,
    operations,
    save,
    savedId,
    schemaId,
    setAutosave,
    setDirty,
    setSavedId,
    title,
  ]);

  const handleSave = async () => {
    if (title.trim() === "") {
      toast.error("Give the transform a title — it names the derived dataset.");
      return;
    }
    if (saveReason !== undefined) {
      toast.error(saveReason);
      return;
    }
    try {
      // If an autosave is in flight, its mutation mints (or holds) the row
      // id — await it so Save patches the same row instead of inserting a
      // duplicate. A failed autosave resolves undefined and saves nothing,
      // so falling back to the state id is safe either way.
      const pending = pendingSaveRef.current;
      const settledId = pending === null ? savedId : ((await pending) ?? savedId);
      await save({
        description: description.trim() === "" ? undefined : description.trim(),
        id: settledId,
        spec: draftToSpec(schemaId, operations),
        status: "saved",
        title: title.trim(),
      });
      setDirty(false);
      setAutosave("saved");
      toast.success("Transform saved.");
    } catch (error) {
      toast.error(errorMessage(error, "Could not save the transform."));
    }
  };

  const handleDelete = async () => {
    const id = savedId;
    if (id === undefined) {
      return;
    }
    try {
      await remove({ id });
      toast.success("Transform deleted.");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not delete the transform."));
    }
  };

  const requirement =
    title.trim() === ""
      ? "Give it a title to start autosaving."
      : (saveReason ?? "Ready to save.");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{docId === undefined ? "New transform" : "Edit transform"}</CardTitle>
          <CardDescription>
            Enrich {datasetTitle}&apos;s rows with fields from a related dataset. Nothing here
            ever changes {datasetTitle}&apos;s own data — the result is a virtual, derived
            dataset.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="transform-title">Title</Label>
            <Input
              id="transform-title"
              value={title}
              placeholder={`e.g. \u201c${datasetTitle} with owner names\u201d`}
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Required — the derived dataset&apos;s name in the catalog.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="transform-description">Description</Label>
            <Textarea
              id="transform-description"
              value={description}
              placeholder="Optional — what this derived view is for."
              onChange={(event) => {
                setDescription(event.target.value);
                setDirty(true);
              }}
            />
          </div>

          {operations.map((operation, index) => (
            <LookupStep
              // oxlint-disable-next-line react/no-array-index-key -- steps are positional in a small ordered list; removal remounts the tail harmlessly.
              key={index}
              candidates={candidates}
              columns={columns}
              index={index}
              operation={operation}
              removable={true}
              schemaId={schemaId}
              onChange={(patch) => {
                patchOperation(index, patch);
              }}
              onRemove={() => {
                editOperations(
                  operations.filter((_, operationIndex) => operationIndex !== index),
                );
              }}
            />
          ))}

          <Button
            className="w-fit"
            type="button"
            variant="outline"
            onClick={() => {
              editOperations([
                ...operations,
                {
                  baseKey: NO_COLUMN,
                  fieldsMode: "all",
                  kind: "lookup",
                  lookupDatasetId: NO_COLUMN,
                  lookupKey: NO_COLUMN,
                },
              ]);
            }}
          >
            <Plus className="h-4 w-4" />
            Add lookup step
          </Button>
          {operations.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Start with a lookup — enrich these rows from one related dataset (stage 4 adds
              rollups).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>
            Match stats cover every row of the dataset; the table shows the first{" "}
            {PREVIEW_ROW_COUNT}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TransformPreview operations={previewOperations} sourceDatasetId={schemaId} />
          {candidates !== undefined && completedCount > previewOperations.length && (
            <p className="mt-3 text-xs text-muted-foreground">
              Steps reading another derived dataset aren&apos;t previewed yet — that lands with
              stage 3.
            </p>
          )}
        </CardContent>
      </Card>

      <EditorFooter
        autosave={autosave}
        canAutosave={canAutosave}
        deletable={savedId !== undefined}
        dirty={dirty}
        requirement={requirement}
        onDelete={() => {
          void handleDelete();
        }}
        onClose={onClose}
        onSave={() => {
          void handleSave();
        }}
      />
    </div>
  );
}

/** The editor's footer: back, the autosave/requirement line (required fields surface here — never a silently disabled Save), delete, save. */
function EditorFooter({
  autosave,
  canAutosave,
  deletable,
  dirty,
  requirement,
  onDelete,
  onClose,
  onSave,
}: {
  autosave: "error" | "idle" | "saved" | "saving";
  canAutosave: boolean;
  deletable: boolean;
  dirty: boolean;
  requirement: string;
  onDelete: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const status = autosave === "saving"
    ? "Saving draft…"
    : autosave === "error"
      ? "The draft could not be saved — edit anything to retry."
      : autosave === "saved"
        ? "Draft saved — reload any time and resume from the transforms list."
        : dirty && !canAutosave
          ? requirement
          : "";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="ghost" onClick={onClose}>
        Back to transforms
      </Button>
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{status}</p>
      {deletable && (
        <Button type="button" variant="destructive" onClick={onDelete}>
          Delete
        </Button>
      )}
      <Button type="button" onClick={onSave}>
        Save transform
      </Button>
    </div>
  );
}

/** The Transform tab's editor: loads the opened registry row (or starts a new one) and hosts the form. */
export function TransformEditor({
  columns,
  datasetTitle,
  docId,
  onClose,
  schemaId,
}: {
  columns: string[];
  datasetTitle: string;
  docId: string | undefined;
  onClose: () => void;
  schemaId: string;
}) {
  const doc = useQuery({
    ...convexQuery(api.derivedDatasets.get, docId === undefined ? "skip" : { id: docId }),
  }).data;

  if (docId !== undefined && doc === undefined) {
    return (
      <div className="flex justify-center items-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (doc === null) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Transform not found</CardTitle>
          <CardDescription className="mb-4">
            It may have been deleted from another tab.
          </CardDescription>
          <Button type="button" onClick={onClose}>
            Back to transforms
          </Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <TransformEditorForm
      columns={columns}
      datasetTitle={datasetTitle}
      docId={docId}
      initial={
        doc === undefined
          ? EMPTY_DRAFT
          : {
              description: doc.description ?? "",
              operations: builderOperationsFromSpec(doc.spec),
              title: doc.title,
            }
      }
      onClose={onClose}
      schemaId={schemaId}
    />
  );
}
