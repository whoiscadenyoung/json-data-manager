import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { cn } from "#/lib/utils";

export type ExportFormat = "geojson" | "json" | "excel";

export interface ExportFormatOption {
  value: ExportFormat;
  label: string;
  /** One-line explanation of what choosing this format produces. */
  hint: string;
}

/**
 * Export-format picker for datasets and groups. Purely presentational over
 * the export itself: `onConfirm` receives the chosen format and whether a
 * JSON-schema file should accompany the data (GeoJSON / JSON only) and
 * returns a promise the dialog awaits for its busy state.
 */
export function ExportDialog({
  open,
  onOpenChange,
  heading,
  formatOptions,
  defaultFormat,
  schemaLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What's being exported, e.g. the dataset or group title. */
  heading: string;
  /** Available formats, in display order — the first is the default. */
  formatOptions: ExportFormatOption[];
  defaultFormat: ExportFormat;
  /** Label for the include-schema checkbox target, e.g. "dataset" / "each dataset". */
  schemaLabel: string;
  onConfirm: (format: ExportFormat, includeSchema: boolean) => Promise<void>;
}) {
  // The selected format persists across re-opens on purpose (re-exporting in
  // the same format is the common case); it only resets when the dialog
  // remounts on a different page.
  const [format, setFormat] = useState(defaultFormat),
    [includeSchema, setIncludeSchema] = useState(false),
    [isExporting, setIsExporting] = useState(false);

  const supportsSchema = format === "geojson" || format === "json",
    activeOption = formatOptions.find((option) => option.value === format);

  const handleConfirm = async () => {
    setIsExporting(true);
    try {
      await onConfirm(format, includeSchema);
      onOpenChange(false);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>{heading}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            {formatOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={isExporting}
                onClick={() => {
                  setFormat(option.value);
                }}
                className={cn(
                  "rounded-md border px-3 py-2 text-left transition-colors",
                  option.value === format
                    ? "border-primary/30 bg-primary/5"
                    : "border-transparent hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "block text-sm font-medium",
                    option.value === format ? "text-primary" : "text-foreground",
                  )}
                >
                  {option.label}
                </span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </button>
            ))}
          </div>

          {supportsSchema && (
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={includeSchema}
                onCheckedChange={(checked) => {
                  // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- Radix types `checked` as boolean | "indeterminate"; the compare narrows out "indeterminate".
                  setIncludeSchema(checked === true);
                }}
              />
              <span className="text-sm">
                Also download the JSON schema file for the {schemaLabel}
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={isExporting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isExporting} onClick={() => void handleConfirm()}>
            {isExporting ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>

        {activeOption && <p className="sr-only">{activeOption.hint}</p>}
      </DialogContent>
    </Dialog>
  );
}
