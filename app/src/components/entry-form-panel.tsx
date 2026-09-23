import type { Geometry, ReferenceCandidate } from "@caden/json-cms/react";
import {
  assertGeometry,
  buildReferenceCandidates,
  buildReferenceUiSchema,
  getReferenceFields,
  isGeometryCompatibleWithDatasetType,
} from "@caden/json-cms/react";
import { ReferenceWidget } from "@caden/json-cms/react/ui";
import { Form } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { Textarea } from "#/components/ui/textarea";
import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { cn } from "#/lib/utils";
import { api } from "#convex/_generated/api";

type Schema = NonNullable<FunctionReturnType<typeof api.schemas.get>>;
// One seam row (`entries.listPage` page item, via the row-resolution seam).
type Entry = DatasetEntryRow;

interface GeometryParseResult {
  geometry?: Geometry;
  error?: string;
}

/** Parses + validates the pasted geometry textarea against the dataset's locked geometry type. */
function parseGeometryInput(text: string, schema: Schema): GeometryParseResult {
  const trimmed = text.trim();
  if (schema.kind !== "geospatial" || !trimmed) {
    return {};
  }
  try {
    const parsedJson: unknown = JSON.parse(trimmed),
      geometry = assertGeometry(parsedJson);
    if (schema.geometryType === undefined) {
      return { geometry };
    }
    if (!isGeometryCompatibleWithDatasetType(geometry.type, schema.geometryType)) {
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

/**
 * Builds the `uiSchema` fragment wiring `schema`'s reference fields (see
 * `@caden/json-cms/react`'s reference utilities) to a live candidate picker —
 * one `listEntriesForSchemas` query covers every referenced dataset at once,
 * regardless of how many reference fields the schema has.
 */
function useReferenceUiSchema(schema: Schema): Record<string, unknown> {
  const referenceFields = getReferenceFields(schema.schema),
    targetSchemaIds = [...new Set(referenceFields.map((f) => f.meta.datasetId))],
    candidateEntries = useQuery(
      api.entries.listEntriesForSchemas,
      targetSchemaIds.length > 0 ? { schemaIds: targetSchemaIds } : "skip",
    );

  if (referenceFields.length === 0) {
    return {};
  }
  const entriesBySchema = new Map<string, Array<{ _id: string; data: unknown }>>();
  for (const candidateEntry of candidateEntries ?? []) {
    const list = entriesBySchema.get(candidateEntry.schemaId) ?? [];
    list.push(candidateEntry);
    entriesBySchema.set(candidateEntry.schemaId, list);
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
  onSaved,
}: {
  schemaId: string;
  schema: Schema;
  entry: Entry | undefined;
  initialGeometry: Geometry | undefined;
  onSaved: (mode: "created" | "updated") => void;
}) {
  const isEditing = entry !== undefined,
    createEntry = useMutation(api.entries.create),
    updateEntry = useMutation(api.entries.update),
    referenceUiSchema = useReferenceUiSchema(schema),
    [formKey, setFormKey] = useState(0),
    [geometryText, setGeometryText] = useState(() => geometryToText(initialGeometry)),
    [geometryError, setGeometryError] = useState<string | null>(null),
    [isSubmitting, setIsSubmitting] = useState(false),
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
      const geometryArg = geometry === undefined ? undefined : JSON.stringify(geometry);

      try {
        if (isEditing) {
          await updateEntry({ data: data.formData, entryId: entry._id, geometry: geometryArg });
          toast.success("Entry updated successfully!");
          onSaved("updated");
        } else {
          await createEntry({ data: data.formData, geometry: geometryArg, schemaId });
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
          ...schema.uiSchema,
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
}: {
  schemaId: string;
  schema: Schema;
  entry?: Entry;
  initialGeometry?: Geometry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
            key={entry === undefined ? "create" : entry._id}
            schemaId={schemaId}
            schema={schema}
            entry={entry}
            initialGeometry={initialGeometry}
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
