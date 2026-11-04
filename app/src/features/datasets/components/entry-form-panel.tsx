import type { Geometry, GeometryType, ReferenceCandidate } from "@caden/json-cms/react";
import {
  assertGeometry,
  buildReferenceCandidates,
  buildReferenceUiSchema,
  getReferenceFields,
  isGeometryCompatibleWithDatasetType,
} from "@caden/json-cms/react";
import { ReferenceWidget } from "@caden/json-cms/react/ui";
import { Button } from "@caden/ui/components/button";
import { Label } from "@caden/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { Textarea } from "@caden/ui/components/textarea";
import { cn } from "@caden/ui/lib/utils";
import { Form } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { isPostgresDatasetId } from "@/lib/dataset-source";
import { searchEntriesQueryOptions } from "@/lib/store/entries";
import * as entriesStore from "@/lib/store/entries";

/**
 * The dataset doc the form reads — structural on purpose: the Convex surface
 * passes the component's `schemas.get` doc, the Postgres surface passes a
 * `#/lib/store/datasets` row adapter carrying the same fields (the PG store
 * has no `ui_schema` column yet — see the store's reconciliation note).
 */
export interface PanelSchema {
  description?: string | null;
  geometryType?: string | null;
  kind?: string | null;
  schema: object;
  uiSchema?: object | null;
}

/** The entry the form edits — `{id, data}` only; each backend's host adapts its row shape. */
export interface PanelEntry {
  data: unknown;
  id: string;
}

/**
 * Which backend owns the dataset's rows — the transitional split (design doc
 * §14), keyed on where the dataset was created by the host. `"convex"` (the
 * default) keeps the original component mutations; `"pg"` writes through the
 * `#/lib/store/*` modules.
 */
export type PanelBackend = "convex" | "pg";

interface GeometryParseResult {
  geometry?: Geometry;
  error?: string;
}

/** Parses + validates the pasted geometry textarea against the dataset's locked geometry type. */
function parseGeometryInput(text: string, schema: PanelSchema): GeometryParseResult {
  const trimmed = text.trim();
  if (schema.kind !== "geospatial" || !trimmed) {
    return {};
  }
  try {
    const parsedJson: unknown = JSON.parse(trimmed),
      geometry = assertGeometry(parsedJson);
    if (schema.geometryType === undefined || schema.geometryType === null) {
      return { geometry };
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the panel's schema is structural (geometryType widened to string), but a geospatial schema's value is always a real GeometryType (enforced by the validators at create time) — the same posture bulk-upload.tsx takes.
    const lockedType = schema.geometryType as GeometryType;
    if (!isGeometryCompatibleWithDatasetType(geometry.type, lockedType)) {
      return {
        error: `Geometry type "${geometry.type}" is not compatible with this dataset's "${schema.geometryType}" geometry type.`,
      };
    }
    return { geometry };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Invalid geometry JSON." };
  }
}

function geometryToText(geometry: Geometry | undefined): string {
  return geometry ? JSON.stringify(geometry, null, 2) : "";
}

/** One flattened candidate row, the shape `buildLabelsByField`/`buildReferenceCandidates` consume. */
interface CandidateRow {
  _id: string;
  data: unknown;
  schemaId: string;
}

/**
 * Builds the `uiSchema` fragment wiring `schema`'s reference fields (see
 * `@caden/json-cms/react`'s reference utilities) to a live candidate picker.
 *
 * Candidates come from the target dataset's store page (design §14.6: each
 * reference field names its TARGET dataset; the store's `search_entries`
 * page — newest 200 — serves it, one query per target through `useQueries`
 * — N independent queries cannot loop as hooks). The Convex-target half of
 * the old split is archived with the stage-7 disconnect (issue #206): a
 * reference field pointing at a pre-migration Convex dataset gets no
 * candidates (the widget's "No entries in the target dataset yet" state)
 * rather than a live Convex read.
 */
function useReferenceUiSchema(schema: PanelSchema): Record<string, unknown> {
  const referenceFields = getReferenceFields(schema.schema),
    targetSchemaIds = [...new Set(referenceFields.map((f) => f.meta.datasetId))],
    pgTargetIds = targetSchemaIds.filter((id) => isPostgresDatasetId(id)),
    pgCandidateQueries = useQueries({
      queries: pgTargetIds.map((targetId) => ({
        ...searchEntriesQueryOptions({ datasetId: targetId, limit: 200 }),
        enabled: pgTargetIds.length > 0,
      })),
    });

  if (referenceFields.length === 0) {
    return {};
  }
  const entriesBySchema = new Map<string, CandidateRow[]>();
  for (let index = 0; index < pgCandidateQueries.length; index += 1) {
    const queryResult = pgCandidateQueries[index],
      targetId = pgTargetIds[index];
    if (targetId === undefined || queryResult === undefined || queryResult.data === undefined) {
      continue;
    }
    for (const row of queryResult.data.rows) {
      const list = entriesBySchema.get(targetId) ?? [];
      list.push({ _id: row.id, data: row.data, schemaId: row.datasetId });
      entriesBySchema.set(targetId, list);
    }
  }

  const candidatesByField: Record<string, ReferenceCandidate[]> = {};
  for (const field of referenceFields) {
    candidatesByField[field.name] = buildReferenceCandidates(
      entriesBySchema.get(field.meta.datasetId) ?? [],
      field.meta.displayProperty,
    );
  }
  return buildReferenceUiSchema(schema.schema, candidatesByField);
}

/** The geometry textarea + RJSF form, keyed by target entry so switching entries (or a fresh create) starts clean. */
function EntryFormBody({
  schemaId,
  schema,
  entry,
  initialGeometry,
  backend,
  onSaved,
}: {
  schemaId: string;
  schema: PanelSchema;
  entry: PanelEntry | undefined;
  initialGeometry: Geometry | undefined;
  backend: PanelBackend;
  onSaved: (mode: "created" | "updated") => void;
}) {
  const isEditing = entry !== undefined,
    queryClient = useQueryClient(),
    referenceUiSchema = useReferenceUiSchema(schema),
    [formKey, setFormKey] = useState(0),
    [geometryText, setGeometryText] = useState(() => geometryToText(initialGeometry)),
    [geometryError, setGeometryError] = useState<string | null>(null),
    [isSubmitting, setIsSubmitting] = useState(false),
    // The PG writes invalidate the store's entry/dataset caches (row pages,
    // counts) the way the Convex mutations' reactivity did.
    invalidatePg = () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:entries"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:geometries"] });
    },
    submitPg = async (formData: Record<string, unknown>, geometryArg: string | undefined) => {
      if (isEditing) {
        await entriesStore.update({
          data: formData,
          datasetId: schemaId,
          entryId: entry.id,
          geometry: geometryArg === undefined ? undefined : geometryArg,
        });
      } else {
        await entriesStore.create({
          data: formData,
          datasetId: schemaId,
          geometry: geometryArg,
        });
      }
      invalidatePg();
    },
    handleSubmit = async (data: any) => {
      if (!data.formData) {
        return;
      }

      const { geometry, error: geometryParseError } = parseGeometryInput(geometryText, schema);
      if (geometryParseError !== undefined) {
        setGeometryError(geometryParseError);
        return;
      }
      setGeometryError(null);
      setIsSubmitting(true);

      // `createEntry`/`updateEntry` carry geometry as a JSON string, not the
      // nested-array `Geometry` shape directly — see `geometry_storage.ts`
      // in the component for why (Convex's 8192-elements-per-array limit,
      // which a hand-pasted ring can still exceed even for a single entry).
      // The store's `update` keeps the same JSON-text contract.
      const geometryArg = geometry === undefined ? undefined : JSON.stringify(geometry);

      try {
        if (backend === "pg") {
          await submitPg(data.formData, geometryArg);
        } else {
          // The Convex entry mutations (`api.cms.entries.create`/`update`)
          // are archived with the stage-7 disconnect (issue #206) — every
          // live caller mounts this panel with `backend: "pg"`; any other
          // value fails loudly instead of mutating a backend the shell no
          // longer wires.
          throw new Error(
            "Convex datasets are archived in this build (stage 7 disconnect): entries write through the Postgres store.",
          );
        }
        if (isEditing) {
          toast.success("Entry updated successfully!");
          onSaved("updated");
        } else {
          toast.success("Entry created successfully!");
          setGeometryText("");
          setFormKey((key) => key + 1);
          onSaved("created");
        }
      } catch (error) {
        console.error(`Error ${isEditing ? "updating" : "creating"} entry:`, error);
        toast.error(
          error instanceof Error
            ? error.message
            : `Failed to ${isEditing ? "update" : "create"} entry`,
        );
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <div className="flex flex-col gap-6">
      {schema.kind === "geospatial" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="entry-geometry">Geometry (GeoJSON, optional)</Label>
          <p className="text-xs text-muted-foreground">
            This dataset requires {schema.geometryType} geometry. Leave blank for no geometry.
          </p>
          <Textarea
            id="entry-geometry"
            value={geometryText}
            onChange={(e) => {
              setGeometryText(e.target.value);
              setGeometryError(null);
            }}
            placeholder='{"type": "Point", "coordinates": [-122.4, 37.8]}'
            rows={6}
            className="font-mono text-xs"
          />
          {geometryError && <p className="text-xs text-destructive">{geometryError}</p>}
        </div>
      )}

      <Form
        key={formKey}
        schema={schema.schema}
        formData={entry === undefined ? undefined : entry.data}
        validator={validator}
        onSubmit={(data) => {
          void handleSubmit(data);
        }}
        disabled={isSubmitting}
        widgets={{ reference: ReferenceWidget }}
        uiSchema={{
          ...referenceUiSchema,
          "ui:submitButtonOptions": {
            norender: false,
            props: {
              className:
                "w-full px-4 py-3 rounded bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors shadow-sm hover:shadow disabled:opacity-50 disabled:cursor-not-allowed",
              disabled: isSubmitting,
            },
            submitText: isSubmitting
              ? isEditing
                ? "Saving..."
                : "Creating..."
              : isEditing
                ? "Save Changes"
                : "Create Entry",
          },
        }}
      />
    </div>
  );
}

/**
 * Side panel for creating or editing a dataset entry. Defaults to a
 * right-hand panel; the header's expand button toggles it to fill the
 * viewport. Creating stays open after a successful submit (for adding
 * several entries in a row); editing closes the panel on success.
 */
export function EntryFormPanel({
  schemaId,
  schema,
  entry,
  initialGeometry,
  open,
  onOpenChange,
  backend = "convex",
}: {
  schemaId: string;
  schema: PanelSchema;
  entry?: PanelEntry;
  initialGeometry?: Geometry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which backend owns this dataset's rows — see `PanelBackend`. */
  backend?: PanelBackend;
}) {
  const isEditing = entry !== undefined,
    [fullscreen, setFullscreen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={cn(
          "flex w-full flex-col gap-0 sm:max-w-lg",
          fullscreen && "!inset-0 !h-screen !w-screen !max-w-none !border-0",
        )}
      >
        <SheetHeader className="flex-row items-start justify-between gap-2 border-b pr-14">
          <div>
            <SheetTitle>{isEditing ? "Edit Entry" : "Create Entry"}</SheetTitle>
            <SheetDescription>{schema.description}</SheetDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setFullscreen((value) => !value)}
            aria-label={fullscreen ? "Exit fullscreen" : "Expand to fullscreen"}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-6">
          <EntryFormBody
            key={entry === undefined ? "create" : entry.id}
            backend={backend}
            initialGeometry={initialGeometry}
            schema={schema}
            schemaId={schemaId}
            entry={entry}
            onSaved={(mode) => {
              if (mode === "updated") {
                onOpenChange(false);
              }
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
