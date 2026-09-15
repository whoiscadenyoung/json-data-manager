import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { api } from "#convex/_generated/api";

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Progress line shown once simplification has started — mirrors the conversion panel's progress bar. */
function SimplifyProgress({
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
        {error ?? "Something went wrong simplifying this dataset."}
      </p>
    );
  }
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {status === "completed"
          ? `Simplified ${processed} of ${total} geometries.`
          : `Simplifying… ${processed} of ${total} geometries.`}
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

/** Shown once simplification has started: progress bar plus a close/hide button. */
function SimplifyRunningView({
  status,
  onClose,
}: {
  status: ImportStatusDoc;
  onClose: () => void;
}) {
  const settled = status.status === "completed" || status.status === "failed";
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <SimplifyProgress
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

/**
 * Side panel that rounds every stored geometry payload of this dataset to 6
 * decimal places (~11 cm) via a durable Convex workflow. Covers datasets
 * created before (or without) the importer's "Simplify geometry" option;
 * running it also flips the dataset's simplify flag so future edits match.
 */
export function SimplifyGeometryPanel({
  schemaId,
  schemaTitle,
  featureCount,
  alreadySimplified,
  open,
  onOpenChange,
  onSimplifyComplete,
}: {
  schemaId: string;
  schemaTitle: string;
  featureCount: number;
  /** True when the dataset already simplifies on write (`simplifyGeometry`). */
  alreadySimplified: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSimplifyComplete?: (result: { processed: number; total: number }) => void;
}) {
  const [importId, setImportId] = useState<string | undefined>(undefined),
    [isSubmitting, setIsSubmitting] = useState(false),
    startSimplification = useMutation(api.imports.startSimplification),
    status = useQuery(api.imports.getImportStatus, importId ? { importId } : "skip"),
    // One completion notification per run started by this panel.
    notifiedCompleteRef = useRef(false),
    handleSubmit = async () => {
      setIsSubmitting(true);
      try {
        const newImportId = await startSimplification({
          schemaId,
          total: featureCount,
        });
        setImportId(newImportId);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to start the simplification."));
      } finally {
        setIsSubmitting(false);
      }
    };

  // Settled runs shouldn't leave the user staring at a finished progress bar:
  // announce success (a failed run keeps the sheet open with its inline error
  // instead) and close the sheet. Fires once per run, and also covers the
  // "Hide"-then-later-completes case — the toast still lands even though
  // there's no sheet left to close.
  useEffect(() => {
    if (!status || status.status !== "completed" || notifiedCompleteRef.current) {
      return;
    }
    notifiedCompleteRef.current = true;
    toast.success(
      `Simplification complete — ${status.processed} of ${status.total} geometries rounded to 6 decimal places.`,
    );
    if (onSimplifyComplete) {
      onSimplifyComplete({ processed: status.processed, total: status.total });
    }
    onOpenChange(false);
  }, [status, onSimplifyComplete, onOpenChange]);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setImportId(undefined);
          notifiedCompleteRef.current = false;
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Simplify geometry</SheetTitle>
          <SheetDescription>
            Round every coordinate in &quot;{schemaTitle}&quot; to 6 decimal places — about 11 cm of
            precision, far finer than the source data needs, so nothing visibly changes on the map
            while storage shrinks and loads get faster.
          </SheetDescription>
        </SheetHeader>
        {status ? (
          <SimplifyRunningView
            status={status}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">{featureCount}</span>{" "}
                  {featureCount === 1 ? "geometry" : "geometries"} will be rewritten in place.
                </li>
                <li>
                  Coordinates are rounded to{" "}
                  <span className="font-medium text-foreground">6 decimal places</span> (~11 cm) —
                  the geometry&apos;s shape is unaffected.
                </li>
                <li>
                  The dataset will also simplify future edits and imports automatically.
                  {alreadySimplified ? " (It already does.)" : ""}
                </li>
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              This can&apos;t be undone for stored geometries. If this dataset was imported with a
              retained original file, that file keeps the untouched coordinates and can still be
              re-downloaded.
            </p>
            <SheetFooter className="mt-2 flex-row justify-end p-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="button" disabled={isSubmitting} onClick={() => void handleSubmit()}>
                {isSubmitting ? "Starting…" : `Simplify ${featureCount} geometries`}
              </Button>
            </SheetFooter>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
