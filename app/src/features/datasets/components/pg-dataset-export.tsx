import { Button } from "@caden/ui/components/button";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import type { DatasetRow } from "#/lib/store/datasets";
import { runView } from "#/lib/store/views";

import {
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "../lib/export";
import { pgExportEntries, pgExportGeometries } from "../lib/pg-export";
import { ExportDialog } from "./export-dialog";
import type { ExportFormat, ExportFormatOption } from "./export-dialog";

/**
 * The dataset page's export control, Postgres edition (stage 5, #204): the
 * button + format dialog over the PG seam. The flow is the Convex dataset
 * page's handler, re-keyed: rows and geometries materialize through
 * `pgExportEntries`/`pgExportGeometries` (whole-dataset reads — the seam
 * pages to exhaustion, and oversized geometry payloads resolve through
 * signed URLs), the schema file is the store row's `jsonSchema`.
 */
export function PgDatasetExport({ dataset }: { dataset: DatasetRow }) {
  const [open, setOpen] = useState(false),
    exportFormats: ExportFormatOption[] = dataset.isGeospatial
      ? [
          {
            value: "geojson",
            label: "GeoJSON",
            hint: "One .geojson FeatureCollection — entries without geometry get null geometry.",
          },
          { value: "json", label: "JSON", hint: "Data entries as a .json file." },
          {
            value: "excel",
            label: "Excel (.xlsx)",
            hint: "One worksheet with the entries as rows.",
          },
        ]
      : [
          { value: "json", label: "JSON", hint: "Data entries as a .json file." },
          {
            value: "excel",
            label: "Excel (.xlsx)",
            hint: "One worksheet with the entries as rows.",
          },
        ];

  const handleConfirm = async (format: ExportFormat, includeSchema: boolean) => {
    // An export always writes the WHOLE dataset — the seam materializes
    // every row on demand instead of the page holding them.
    // A live view saves no rows: an export is a snapshot, so run it once
    // (a normal saved run) and export what that run wrote.
    if (dataset.refreshMode === "live") {
      try {
        const outcome = await runView(dataset.id);
        if (outcome.status === "error") {
          toast.error(`Couldn't snapshot the live view: ${outcome.error}`);
          return;
        }
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't snapshot the live view."));
        return;
      }
    }
    let entries;
    try {
      entries = await pgExportEntries(dataset.id);
    } catch {
      toast.error("Could not load all rows for the export.");
      return;
    }
    const slug = slugify(dataset.title),
      downloadSchemaFile = () => {
        if (includeSchema) {
          downloadText(JSON.stringify(dataset.jsonSchema, null, 2), `${slug}-schema.json`);
        }
      };

    if (format === "geojson") {
      // Inline jsonb geometries resolve synchronously; the storage-backed
      // oversized payloads fetch through signed URLs — a failed row leaves
      // null geometry instead of failing the export (the seam's rule).
      const geometries = await pgExportGeometries(dataset.id);
      downloadText(
        JSON.stringify(buildGeoJsonCollection(entries, geometries, dataset.id), null, 2),
        `${slug}.geojson`,
      );
      downloadSchemaFile();
    } else if (format === "json") {
      downloadText(
        JSON.stringify(buildJsonPayload(dataset.jsonSchema, entries), null, 2),
        `${slug}.json`,
      );
      downloadSchemaFile();
    } else {
      await exportExcelWorkbook(
        [{ name: dataset.title, rows: entryRows(entries) }],
        `${slug}.xlsx`,
      );
    }
    toast.success("Export downloaded.");
  };

  return (
    <>
      <Button
        disabled={dataset.entryCount === 0 && dataset.refreshMode !== "live"}
        onClick={() => {
          setOpen(true);
        }}
        title={
          dataset.refreshMode === "live"
            ? "Runs the view once, then downloads that snapshot"
            : dataset.entryCount === 0
              ? "Nothing to export yet"
              : "Download this dataset's rows"
        }
        variant="outline"
      >
        <Download className="h-4 w-4 mr-2" />
        Export
      </Button>
      <ExportDialog
        open={open}
        onOpenChange={setOpen}
        heading={`Export "${dataset.title}"`}
        formatOptions={exportFormats}
        defaultFormat={dataset.isGeospatial ? "geojson" : "json"}
        schemaLabel="dataset"
        onConfirm={handleConfirm}
      />
    </>
  );
}
