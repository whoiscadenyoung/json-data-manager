import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Textarea } from "@caden/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { PgDatasetPickerSheet } from "#/features/catalog";
import { errorMessage } from "#/lib/errors";
import * as datasetsStore from "#/lib/store/datasets";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import * as derivedStore from "#/lib/store/derived";

import {
  NO_COLUMN,
  PREVIEW_ROW_COUNT,
  builderOperationsFromSpec,
  draftToSpec,
  firstIncompleteReason,
  fromBuilderOperation,
  isLookupComplete,
  type BuilderOperation,
} from "../lib/transform-model";
import { PgTransformPreview } from "./pg-transform-preview";
import {
  DatasetSourceRow,
  FieldsPicker,
  KeyColumnsRow,
  PolicySelects,
  StepHeader,
  storedOperationCount,
  withSelection,
} from "./transform-editor";

/**
 * The Transform tab's editor, Postgres edition (stage 5, #204; the Convex
 * TransformEditor's counterpart over the store's derived module, design
 * §8.1): pick the related dataset (key columns auto-suggested from the
 * declared structures) → pick fields → live preview with dataset-wide match
 * stats → save.
 *
 * Durability follows the catalog lifecycle's builder rule ("autosave early
 * and often"): every edit debounce-saves a DRAFT registry row, so a reload
 * reconstructs the in-progress spec from the registry; the explicit Save
 * flips the same row to "saved". Required fields surface in the footer —
 * the Save button explains what's missing rather than sitting silently
 * disabled (the UI-polish rule). The autosave machinery keeps every rule the
 * Convex editor pinned (issue #135): saves serialize through one pending
 * promise so two debounced saves never mint duplicate rows, a save that
 * finishes mid-edit keeps `dirty` armed, and closing inside the 800 ms
 * window flushes the armed save.
 *
 * The form controls are the Convex editor's (imported — one source of truth
 * for the picker/key/fields/policy rows); the lookup step wires its own
 * store reads (the Convex step's column fetch is a component-backend
 * query). Specs write through `derivedStore.save` and the preview loads
 * rows through the PG row-resolution seam.
 */
const AUTOSAVE_DELAY_MS = 800;

/** The declared property keys of a stored JSON Schema, read structurally (the entries table's columns derivation; the store's `declaredProperties` is module-private). */
function declaredColumnsOf(jsonSchema: unknown): string[] {
  if (!isRecordShaped(jsonSchema)) {
    return [];
  }
  const properties = jsonSchema.properties;
  return isRecordShaped(properties) ? Object.keys(properties) : [];
}

function isRecordShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One registry save, then the list invalidates — the store modules' write
 * convention (writes invalidate by query key; the namespace follows the
 * `pg:` family). MODULE-level on purpose: a per-render closure in the
 * autosave effect's dependency list is an every-render identity, which the
 * hook rules reject in both directions — the editor's save calls this
 * directly, with the awaited in-flight autosave's `baseId` riding along so
 * the two racing saves of issue #135 always land on ONE row.
 */
async function saveRegistryRow(input: {
  baseId: string | undefined;
  description: string | undefined;
  queryClient: QueryClient;
  schemaId: string;
  spec: unknown;
  status: "draft" | "saved";
  title: string;
}): Promise<string> {
  const id = await derivedStore.save({
    description: input.description,
    id: input.baseId,
    spec: input.spec,
    status: input.status,
    title: input.title,
  });
  void input.queryClient.invalidateQueries({ queryKey: ["pg:derived"] });
  return id;
}

/** One lookup step's configuration, Postgres edition — the Convex `LookupStep` with the picked dataset's structure read from the datasets store. */
function PgLookupStep({
  candidates,
  columns,
  index,
  onChange,
  onRemove,
  operation,
  schemaId,
}: {
  /** Undefined while the catalog list is loading — a picked dataset's kind is then unknown. */
  candidates: DatasetSummaryRow[] | undefined;
  columns: string[];
  index: number;
  onChange: (patch: Partial<BuilderOperation>) => void;
  onRemove: () => void;
  operation: BuilderOperation;
  schemaId: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false),
    candidatesReady = candidates !== undefined,
    candidateById = new globalThis.Map((candidates ?? []).map((entry) => [entry.id, entry])),
    chosen = candidateById.get(operation.lookupDatasetId),
    // A picked dataset whose catalog entry hasn't loaded yet is of UNKNOWN
    // kind — not derived, not component — so the step shows loading state
    // instead of deciding.
    sideUnknown = !candidatesReady && operation.lookupDatasetId !== NO_COLUMN,
    // A published dataset has a declared structure to suggest from; a
    // registry id (derived-of-derived) does not — the RLS-null read then
    // keeps the free-text key column.
    pickedPublished = chosen !== undefined,
    lookupDoc = useQuery({
      ...datasetsStore.getQueryOptions({ datasetId: operation.lookupDatasetId }),
      enabled: pickedPublished,
    }).data,
    lookupColumns = withSelection(
      lookupDoc === null || lookupDoc === undefined ? [] : declaredColumnsOf(lookupDoc.jsonSchema),
      operation.lookupKey,
    ),
    pickableFields = lookupColumns.filter((column) => column !== operation.lookupKey),
    baseKeyColumns = withSelection(columns, operation.baseKey),
    lookupLoading = pickedPublished && lookupDoc === undefined;

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <StepHeader index={index} removable={true} onRemove={onRemove} />

      <DatasetSourceRow
        chosenTitle={chosen === undefined ? undefined : chosen.title}
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
        pickedComponentDataset={pickedPublished}
        sourceColumns={baseKeyColumns}
        sourceKey={operation.baseKey}
        onChange={onChange}
      />

      {pickedPublished && candidatesReady && (
        <FieldsPicker
          fields={operation.fields ?? []}
          fieldsMode={operation.fieldsMode}
          loadingColumns={lookupLoading}
          pickableFields={pickableFields}
          onModeChange={(fieldsMode) => {
            onChange(
              fieldsMode === "all"
                ? { fieldsMode }
                : { fields: operation.fields ?? [], fieldsMode },
            );
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

      <PgDatasetPickerSheet
        title="Choose the related dataset"
        description="Its rows enrich this dataset's rows on the matching key."
        candidates={(candidates ?? []).filter((entry) => entry.id !== schemaId)}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (dataset) => {
          onChange({
            fields: undefined,
            fieldsMode: "all",
            lookupDatasetId: dataset.id,
            lookupKey: NO_COLUMN,
            namespace: dataset.title,
          });
        }}
      />
    </div>
  );
}

function PgTransformEditorForm({
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
  initial: {
    description: string;
    operations: BuilderOperation[];
    title: string;
  };
  onClose: () => void;
  schemaId: string;
}) {
  const queryClient = useQueryClient(),
    // #281: project DRAFTS are valid lookup sources — the owner's unpublished
    // datasets join exactly like published ones (the preview's row reads are
    // creator-visible). Without the draft summaries a draft lookup showed the
    // "Derived source" badge, the raw UUID, and free-text-only keys.
    publishedCandidates = useQuery(datasetsStore.listSummariesQueryOptions()).data,
    draftCandidates = useQuery(datasetsStore.listDraftSummariesQueryOptions()).data,
    candidates =
      publishedCandidates === undefined || draftCandidates === undefined
        ? undefined
        : [...publishedCandidates, ...draftCandidates],
    componentIds = new globalThis.Set((candidates ?? []).map((entry) => entry.id)),
    [title, setTitle] = useState(initial.title),
    [description, setDescription] = useState(initial.description),
    [operations, setOperations] = useState(initial.operations),
    [dirty, setDirty] = useState(false),
    [autosave, setAutosave] = useState<"error" | "idle" | "saved" | "saving">("idle"),
    [savedId, setSavedId] = useState<string | undefined>(docId),
    // Issue #135, defect 7: deleting a saved transform is irreversible —
    // the destructive footer button opens this confirm instead of firing.
    [pendingDelete, setPendingDelete] = useState(false),
    // The in-flight autosave's promise, if any: explicit Save awaits it so
    // both paths share one minted id.
    pendingSaveRef = useRef<Promise<string | undefined> | null>(null),
    // Counts every edit since mount (issue #135, defect 2): an autosave that
    // finishes must clear `dirty` only when nothing was typed while it ran.
    revisionRef = useRef(0),
    // The debounce-armed save closure, armed until it fires (or the next
    // effect run replaces it). The unmount flush fires it when the editor
    // closes inside the 800 ms window.
    flushSaveRef = useRef<(() => void) | undefined>(undefined),
    markEdited = () => {
      revisionRef.current += 1;
      setDirty(true);
    },
    previewOperations = operations
      .filter(
        (operation) => isLookupComplete(operation) && componentIds.has(operation.lookupDatasetId),
      )
      .map(fromBuilderOperation),
    completedCount = operations.filter(isLookupComplete).length,
    saveReason = firstIncompleteReason(operations),
    // Autosave granularity: a non-empty title and at least one COMPLETE step
    // (the registry validates shape; half-picked steps stay local).
    canAutosave = title.trim() !== "" && completedCount > 0,
    editOperations = (next: BuilderOperation[]) => {
      setOperations(next);
      markEdited();
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
  // async callbacks only — never synchronously in the effect body. The refs
  // it reads/writes (flushSaveRef, revisionRef) are stable by design and are
  // deliberately absent from the deps list — re-arming on their mutation
  // would restart the debounce mid-typing.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  useEffect(() => {
    if (!dirty || !canAutosave) {
      flushSaveRef.current = undefined;
      return undefined;
    }
    const run = () => {
      flushSaveRef.current = undefined;
      const revisionAtSave = revisionRef.current,
        runPromise = (async () => {
          setAutosave("saving");
          try {
            // Serialize behind any in-flight save: two debounced saves racing
            // would each pass `id: undefined` while the first's minted row id
            // was still unlanded — a duplicate draft row.
            const pending = pendingSaveRef.current,
              baseId = pending === null ? savedId : ((await pending) ?? savedId),
              id = await saveRegistryRow({
                baseId,
                description: description.trim() === "" ? undefined : description.trim(),
                queryClient,
                schemaId,
                spec: draftToSpec(schemaId, operations),
                status: "draft",
                title: title.trim(),
              });
            setSavedId(id);
            if (revisionRef.current === revisionAtSave) {
              setDirty(false);
            }
            setAutosave("saved");
            return id;
          } catch {
            setAutosave("error");
            return undefined;
          }
        })();
      pendingSaveRef.current = runPromise;
    };
    const timer = setTimeout(run, AUTOSAVE_DELAY_MS);
    flushSaveRef.current = run;
    return () => {
      clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the refs this effect reads/writes (flushSaveRef, revisionRef) are stable by design; listing them would re-arm the debounce mid-typing without changing behavior. The save target is the MODULE-level saveRegistryRow (stable identity — no per-render closure in the list), and the content deps below are the freshness contract: a save captures exactly what the user sees.
  }, [
    canAutosave,
    description,
    dirty,
    operations,
    queryClient,
    savedId,
    schemaId,
    setAutosave,
    setDirty,
    setSavedId,
    title,
  ]);

  // Closing inside the debounce window must not lose the edit (issue #135,
  // defect 2): fire the armed save. A no-op once it already fired, was
  // replaced, or nothing was ever dirty.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- mount/unmount only by design; flushSaveRef is a stable ref and must not re-arm this effect.
  useEffect(() => {
    return () => {
      const flush = flushSaveRef.current;
      if (flush !== undefined) {
        flush();
      }
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- mount/unmount only by design.
  }, []);

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
      // If an autosave is in flight, its save holds (or mints) the row id —
      // await it so Save patches the same row instead of inserting a
      // duplicate. A failed autosave resolves undefined and saves nothing,
      // so falling back to the state id is safe either way.
      const revisionAtSave = revisionRef.current,
        pending = pendingSaveRef.current,
        settledId = pending === null ? savedId : ((await pending) ?? savedId),
        id = await saveRegistryRow({
          baseId: settledId,
          description: description.trim() === "" ? undefined : description.trim(),
          queryClient,
          schemaId,
          spec: draftToSpec(schemaId, operations),
          status: "saved",
          title: title.trim(),
        });
      setSavedId(id);
      // Same race as the autosave: an edit made while this explicit save ran
      // keeps `dirty` armed so it autosaves, instead of being cleared away.
      if (revisionRef.current === revisionAtSave) {
        setDirty(false);
      }
      flushSaveRef.current = undefined;
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
      // Disarm the unmount flush first: the row is about to be deleted, and
      // a debounced edit still armed must not re-insert it as a draft.
      flushSaveRef.current = undefined;
      const removed = await derivedStore.remove({ id });
      if (removed === 0) {
        // The store's silent-denial rule: 0 rows = not the creator (or
        // already gone) — surfaced, never toasted as success.
        throw new Error("That transform doesn't exist or you don't have access to it.");
      }
      void queryClient.invalidateQueries({ queryKey: ["pg:derived"] });
      toast.success("Transform deleted.");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not delete the transform."));
    }
  };

  const requirement =
    title.trim() === "" ? "Give it a title to start autosaving." : (saveReason ?? "Ready to save.");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{docId === undefined ? "New transform" : "Edit transform"}</CardTitle>
          <CardDescription>
            Enrich {datasetTitle}&apos;s rows with fields from a related dataset. Nothing here ever
            changes {datasetTitle}&apos;s own data — the result is a virtual, derived dataset.
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
                markEdited();
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
                markEdited();
              }}
            />
          </div>

          {operations.map((operation, index) => (
            <PgLookupStep
              // oxlint-disable-next-line react/no-array-index-key -- steps are positional in a small ordered list; removal remounts the tail harmlessly.
              key={index}
              candidates={candidates}
              columns={columns}
              index={index}
              operation={operation}
              schemaId={schemaId}
              onChange={(patch) => {
                patchOperation(index, patch);
              }}
              onRemove={() => {
                editOperations(operations.filter((_, operationIndex) => operationIndex !== index));
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
              Start with a lookup — enrich these rows from one related dataset.
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
          <PgTransformPreview operations={previewOperations} sourceDatasetId={schemaId} />
          {candidates !== undefined && completedCount > previewOperations.length && (
            <p className="mt-3 text-xs text-muted-foreground">
              Steps reading another derived dataset aren&apos;t previewed — pickers and preview
              cover imported datasets (published or your project drafts, #281); a derived source has
              no readable rows to preview yet.
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
          setPendingDelete(true);
        }}
        onClose={onClose}
        onSave={() => {
          void handleSave();
        }}
      />

      <ConfirmDialog
        destructive
        open={pendingDelete}
        onOpenChange={setPendingDelete}
        title={`Delete "${title.trim() || "this transform"}"?`}
        description="The saved transform and its registry row are deleted. Datasets derived from it stay, but they re-read as orphaned."
        confirmLabel="Delete"
        onConfirm={() => {
          setPendingDelete(false);
          void handleDelete();
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
  const status =
    autosave === "saving"
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

/** The Transform tab's editor, PG edition: loads the opened registry row (or starts a new one) and hosts the form — the Convex host's shape, including the sql-step guard (a spec this builder cannot fully render must never reach the form; saving it here would silently drop its sql — the row keeps its other editor, the Analyze tab). */
export function PgTransformEditor({
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
    ...derivedStore.getQueryOptions({ id: docId ?? "" }),
    enabled: docId !== undefined,
  }).data;

  if (docId !== undefined && doc === undefined) {
    return (
      <div className="flex justify-center items-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (docId !== undefined && doc === null) {
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
  const docLoaded = doc !== undefined && doc !== null,
    builderOperations = builderOperationsFromSpec(docLoaded ? doc.spec : {});
  if (docLoaded && builderOperations.length < storedOperationCount(doc.spec)) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">This transform includes a SQL step</CardTitle>
          <CardDescription className="mb-4">
            The transform builder only edits lookup steps — &ldquo;{doc.title}&rdquo; was authored
            (or extended) in the Analyze tab, and saving it here would drop its SQL. Edit it there
            instead.
          </CardDescription>
          <Button type="button" onClick={onClose}>
            Back to transforms
          </Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <PgTransformEditorForm
      columns={columns}
      datasetTitle={datasetTitle}
      docId={docId}
      initial={
        docLoaded
          ? {
              description: doc.description ?? "",
              operations: builderOperations,
              title: doc.title,
            }
          : { description: "", operations: [], title: "" }
      }
      onClose={onClose}
      schemaId={schemaId}
    />
  );
}
