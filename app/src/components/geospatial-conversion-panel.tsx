import { detectCoordinateColumns } from "@caden/json-cms/react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { api } from "#convex/_generated/api";

const NONE = "";

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Progress line shown once the conversion has started — mirrors the import progress bar's copy without pulling in its component. */
function ConversionProgress({
  processed,
  total,
  status,
  error,
}: {
  processed: number;
  total: number;
  status: "pending" | "processing" | "completed" | "failed";
  error: string | undefined;
}) {
  if (status === "failed") {
    return (
      <p className="text-sm text-destructive">
        {error ?? "Something went wrong converting this dataset."}
      </p>
    );
  }
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {status === "completed"
          ? `Converted ${processed} of ${total} rows.`
          : `Converting… ${processed} of ${total} rows.`}
      </p>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${status === "completed" ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}

type ImportStatusDoc = {
  error?: string;
  processed: number;
  status: "pending" | "processing" | "completed" | "failed";
  total: number;
};

/** Shown once the conversion has started: progress bar plus a close/hide button. */
function ConversionRunningView({
  status,
  onClose,
}: {
  status: ImportStatusDoc;
  onClose: () => void;
}) {
  const settled = status.status === "completed" || status.status === "failed";
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <ConversionProgress
        processed={status.processed}
        total={status.total}
        status={status.status}
        error={status.error}
      />
      <SheetFooter className="mt-2 flex-row justify-end p-0">
        <Button type="button" variant="outline" onClick={onClose}>
          {settled ? "Close" : "Hide"}
        </Button>
      </SheetFooter>
    </div>
  );
}

/** A single "pick a column" select, shared by the latitude/longitude fields. */
function CoordinateFieldSelect({
  id,
  label,
  columns,
  value,
  onChange,
}: {
  id: string;
  label: string;
  columns: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value === NONE ? null : value}
        onValueChange={(next) => {
          onChange(next ?? NONE);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Select a column" />
        </SelectTrigger>
        <SelectContent>
          {columns.map((column) => (
            <SelectItem key={column} value={column}>
              {column}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The column-picker form, shown before the conversion has started. */
function ConversionForm({
  columns,
  latField,
  lonField,
  onLatFieldChange,
  onLonFieldChange,
  guessed,
  entryCount,
  isSubmitting,
  onSubmit,
}: {
  columns: string[];
  latField: string;
  lonField: string;
  onLatFieldChange: (value: string) => void;
  onLonFieldChange: (value: string) => void;
  guessed: boolean;
  entryCount: number;
  isSubmitting: boolean;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      <CoordinateFieldSelect
        id="geo-lat-field"
        label="Latitude column"
        columns={columns}
        value={latField}
        onChange={onLatFieldChange}
      />
      <CoordinateFieldSelect
        id="geo-lon-field"
        label="Longitude column"
        columns={columns}
        value={lonField}
        onChange={onLonFieldChange}
      />

      {guessed && (
        <p className="text-xs text-muted-foreground">
          Detected from your data — adjust if this looks wrong.
        </p>
      )}

      <SheetFooter className="mt-2 flex-row justify-end p-0">
        <Button type="submit" disabled={isSubmitting || latField === NONE || lonField === NONE}>
          {isSubmitting ? "Starting…" : `Convert ${entryCount} rows`}
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * Side panel that converts an already-imported "standard" dataset to
 * geospatial in place: picks two of its existing columns as latitude/
 * longitude (auto-detected where possible) and backfills a Point geometry
 * for every entry from them. Unlike `DatasetImporter`, no file is uploaded —
 * the coordinates already live in the entries' own data.
 */
export function GeospatialConversionPanel({
  schemaId,
  columns,
  sampleRows,
  entryCount,
  open,
  onOpenChange,
  onConversionComplete,
}: {
  schemaId: string;
  /** Every property name on the dataset's schema — populates the two selects. */
  columns: string[];
  /** A sample of entries' `data`, used only to guess the coordinate columns. */
  sampleRows: Record<string, unknown>[];
  entryCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired once, when a conversion started by this panel finishes successfully. */
  onConversionComplete?: (result: { processed: number; total: number }) => void;
}) {
  const guess = detectCoordinateColumns(sampleRows),
    [latField, setLatField] = useState(guess === undefined ? NONE : guess.latField),
    [lonField, setLonField] = useState(guess === undefined ? NONE : guess.lonField),
    [importId, setImportId] = useState<string | undefined>(undefined),
    [isSubmitting, setIsSubmitting] = useState(false),
    startGeospatialConversion = useMutation(api.imports.startGeospatialConversion),
    status = useQuery(api.imports.getImportStatus, importId ? { importId } : "skip"),
    // One completion notification per conversion started by this panel —
    // reset when the form is reused for a new conversion.
    notifiedCompleteRef = useRef(false),
    resetFields = () => {
      setLatField(guess === undefined ? NONE : guess.latField);
      setLonField(guess === undefined ? NONE : guess.lonField);
      setImportId(undefined);
      notifiedCompleteRef.current = false;
    },
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      if (latField === NONE || lonField === NONE) {
        toast.error("Choose both a latitude and a longitude column.");
        return;
      }
      setIsSubmitting(true);
      try {
        const newImportId = await startGeospatialConversion({
          latField,
          lonField,
          schemaId,
          total: entryCount,
        });
        setImportId(newImportId);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to start the conversion."));
      } finally {
        setIsSubmitting(false);
      }
    };

  // Settled conversions shouldn't leave the user staring at a finished
  // progress bar: announce success (a failed conversion keeps the sheet open
  // with its inline error instead) and close the sheet. Fires once per
  // conversion, and also covers the "Hide"-then-later-completes case — the
  // toast still lands even though there's no sheet left to close.
  useEffect(() => {
    if (!status || status.status !== "completed" || notifiedCompleteRef.current) {
      return;
    }
    notifiedCompleteRef.current = true;
    toast.success(`Conversion complete — ${status.processed} of ${status.total} rows geocoded.`);
    if (onConversionComplete) {
      onConversionComplete({ processed: status.processed, total: status.total });
    }
    onOpenChange(false);
  }, [status, onConversionComplete, onOpenChange]);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          resetFields();
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Make geospatial</SheetTitle>
          <SheetDescription>
            Pick the columns that hold each entry&apos;s coordinates. Every entry gets a Point
            geometry built from them; rows with missing or invalid coordinates are left without one.
          </SheetDescription>
        </SheetHeader>
        {status ? (
          <ConversionRunningView
            status={status}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : (
          <ConversionForm
            columns={columns}
            latField={latField}
            lonField={lonField}
            onLatFieldChange={setLatField}
            onLonFieldChange={setLonField}
            guessed={guess !== undefined}
            entryCount={entryCount}
            isSubmitting={isSubmitting}
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
