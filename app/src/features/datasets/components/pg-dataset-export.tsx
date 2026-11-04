import { Button } from "@caden/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import type { DatasetRow } from "#/lib/store/datasets";
import * as derivedStore from "#/lib/store/derived";

import {
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "../lib/export";
import { pgApplyJoinedFields, pgExportEntries, pgExportGeometries } from "../lib/pg-export";
import { ExportDialog } from "./export-dialog";
import type { ExportFormat, ExportFormatOption } from "./export-dialog";

/**
 * The dataset page's export control, Postgres edition (stage 5, #204): the
 * button + format dialog over the PG seam. The flow is the Convex dataset
 * page's handler, re-keyed: rows and geometries materialize through
 * `pgExportEntries`/`pgExportGeometries` (whole-dataset reads — the seam
 * pages to exhaustion, and oversized geometry payloads resolve through
 * signed URLs), the schema file is the store row's `jsonSchema`, and the
 * joined-fields toggle counts the dataset's SAVED derived rows from the
 * store's registry (drafts never back the toggle — a hidden control must
 * never still change the output, and a toggle that could never change the
 * output must not render).
 */
export function PgDatasetExport({ dataset }: { dataset: DatasetRow }) {
  const [open, setOpen] = useState(false),
    savedRows = useQuery(
      derivedStore.listBySourceQueryOptions({ sourceDatasetId: dataset.id }),
    ).data,
    savedCount = savedRows === undefined ? undefined : pgReadyCountOf(savedRows),
    joinedFieldsHint =
      savedCount === undefined || savedCount === 0
        ? undefined
        : `Include joined fields from ${
            savedCount === 1 ? "its saved transform" : `its ${savedCount} saved transforms`
          }`,
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

  const handleConfirm = async (
    format: ExportFormat,
    includeSchema: boolean,
    includeJoinedFields: boolean,
  ) => {
    // An export always writes the WHOLE dataset — the seam materializes
    // every row on demand instead of the page holding them.
    let entries;
    try {
      entries = await pgExportEntries(dataset.id);
    } catch {
      toast.error("Could not load all rows for the export.");
      return;
    }
    // "Include joined fields": the dataset's saved transforms fold through
    // the pinned enrichment fold. Only the toggled path allocates anything —
    // an untoggled export skips enrichment entirely so it stays
    // byte-identical to today's output.
    let skippedTransforms = 0;
    if (includeJoinedFields && savedRows !== undefined) {
      try {
        const rowsBySource = new globalThis.Map<string, typeof entries>([[dataset.id, entries]]);
        skippedTransforms = await pgApplyJoinedFields({ rows: savedRows, rowsBySource });
        entries = rowsBySource.get(dataset.id) ?? entries;
      } catch (error) {
        toast.error(errorMessage(error, "Could not apply the saved transforms."));
        return;
      }
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
    toast.success("Export downloaded.", {
      description:
        skippedTransforms === 0
          ? undefined
          : `Skipped ${skippedTransforms} saved transform(s) that aren't currently ready.`,
    });
  };

  return (
    <>
      <Button
        disabled={dataset.entryCount === 0}
        onClick={() => {
          setOpen(true);
        }}
        title={dataset.entryCount === 0 ? "Nothing to export yet" : "Download this dataset's rows"}
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
        joinedFieldsHint={joinedFieldsHint}
        onConfirm={handleConfirm}
      />
    </>
  );
}

/** The dataset's READY saved registry rows (the Convex page's `readyTransforms` count: explicitly saved rows whose read-time health is "ready" — drafts and stale specs never back the export toggle). */
function pgReadyCountOf(rows: readonly { health: string; status: string }[]): number {
  let ready = 0;
  for (const row of rows) {
    if (row.status === "saved" && row.health === "ready") {
      ready += 1;
    }
  }
  return ready;
}
