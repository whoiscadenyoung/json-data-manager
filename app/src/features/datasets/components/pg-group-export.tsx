import { Button } from "@caden/ui/components/button";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import * as datasetsStore from "#/lib/store/datasets";
import type { DatasetSummaryRow } from "#/lib/store/datasets";

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
 * The group page's export control, Postgres edition (stage 5, #204): the
 * Convex group export's flow, re-keyed onto the PG seam. One whole-dataset
 * read per member (`pgExportEntries` — the seam pages to exhaustion), full
 * dataset docs read on demand for the JSON-schema payloads (summaries
 * don't carry them — the Convex page's `fetchSchemasById` rule), each
 * geospatial member's geometries resolved through the seam (signed URLs
 * for the oversized payloads), and the joined-fields toggle scoped to THIS
 * group's members — the registry reads ride one flattened query, so specs
 * over unrelated datasets never load.
 *
 * Entry ids are Postgres uuids (globally unique), so every member's
 * geometry map merges into one keyed by entry id without collision.
 */
export function PgGroupExport({
  groupName,
  members,
}: {
  groupName: string;
  members: DatasetSummaryRow[];
}) {
  const [open, setOpen] = useState(false),
    memberIds = members.map((member) => member.id),
    geospatialCount = members.filter((member) => member.isGeospatial).length,
    exportFormats: ExportFormatOption[] =
      geospatialCount > 0
        ? [
            {
              value: "geojson",
              label: "GeoJSON",
              hint: `One .geojson FeatureCollection per geospatial dataset (${geospatialCount} file(s)) — schemas stay separate.`,
            },
            {
              value: "json",
              label: "JSON",
              hint: `One .json file per dataset (${members.length} file(s)) — schemas stay separate.`,
            },
            {
              value: "excel",
              label: "Excel (.xlsx)",
              hint: `One workbook with a worksheet per dataset (${members.length} sheet(s)).`,
            },
          ]
        : [
            {
              value: "json",
              label: "JSON",
              hint: `One .json file per dataset (${members.length} file(s)) — schemas stay separate.`,
            },
            {
              value: "excel",
              label: "Excel (.xlsx)",
              hint: `One workbook with a worksheet per dataset (${members.length} sheet(s)).`,
            },
          ];

  // oxlint-disable-next-line eslint/complexity -- per-format download paths; ad hoc splitting risks these render paths (the same #82 phase-2 note the Convex group page carries).
  const handleConfirm = async (format: ExportFormat, includeSchema: boolean) => {
    // Row-streams read through the seam: each member's export rows
    // materialize per dataset through the seam's paginated reads — the
    // completeness rule (every page, cursor to exhaustion).
    let rowsByDataset: globalThis.Map<string, Awaited<ReturnType<typeof pgExportEntries>>>;
    try {
      const pairs = await Promise.all(
        members.map(async (member) => [member.id, await pgExportEntries(member.id)] as const),
      );
      rowsByDataset = new globalThis.Map(pairs);
    } catch {
      toast.error("Could not load all rows for the export.");
      return;
    }
    // Dataset rows are summaries — the JSON-schema payloads only exist on
    // the full docs, so an export that wants them reads each one here, on
    // demand, instead of the page carrying them all the time.
    const schemasById = await readSchemasById(memberIds),
      entriesOf = (dataset: DatasetSummaryRow) => rowsByDataset.get(dataset.id) ?? [],
      downloadSchemaFile = (dataset: DatasetSummaryRow) => {
        if (!includeSchema) {
          return;
        }
        const schema = schemasById.get(dataset.id);
        if (schema !== undefined) {
          downloadText(JSON.stringify(schema, null, 2), `${slugify(dataset.title)}-schema.json`);
        }
      };

    if (format === "geojson") {
      // GeoJSON is a geospatial format — regular datasets in the group have
      // no geometry to express and are skipped.
      const geospatialMembers = members.filter((member) => member.isGeospatial);
      for (const member of geospatialMembers) {
        // oxlint-disable-next-line no-await-in-loop -- one geometry resolution per geospatial member, in member order (parallel across rows within a member, per the seam).
        const geometries = await pgExportGeometries(member.id);
        downloadText(
          JSON.stringify(buildGeoJsonCollection(entriesOf(member), geometries, member.id), null, 2),
          `${slugify(member.title)}.geojson`,
        );
        downloadSchemaFile(member);
      }
      toast.success(`Exported ${geospatialCount} GeoJSON file(s).`);
      return;
    }
    if (format === "json") {
      for (const member of members) {
        downloadText(
          JSON.stringify(buildJsonPayload(schemasById.get(member.id), entriesOf(member)), null, 2),
          `${slugify(member.title)}.json`,
        );
        downloadSchemaFile(member);
      }
      toast.success(`Exported ${members.length} JSON file(s).`);
      return;
    }
    await exportExcelWorkbook(
      members.map((member) => ({ name: member.title, rows: entryRows(entriesOf(member)) })),
      `${slugify(groupName)}.xlsx`,
    );
    toast.success("Exported workbook.");
  };

  return (
    <>
      <Button
        disabled={members.length === 0}
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
      >
        <Download className="h-4 w-4 mr-2" />
        Export ({members.length})
      </Button>
      <ExportDialog
        open={open}
        onOpenChange={setOpen}
        heading={`Export "${groupName}" (${members.length} datasets)`}
        formatOptions={exportFormats}
        defaultFormat={geospatialCount > 0 ? "geojson" : "json"}
        schemaLabel="each dataset"
        onConfirm={handleConfirm}
      />
    </>
  );
}

/** One store dataset row, read imperatively — same rule, for the schema payloads. */
async function readStoreDataset(datasetId: string): Promise<unknown> {
  const queryFn = datasetsStore.getQueryOptions({ datasetId }).queryFn;
  if (queryFn === undefined) {
    throw new Error("The dataset store read carries no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context; `never` satisfies the parameter without constructing a QueryClient for nothing (pg-bundle-publish's rule).
  const row = await queryFn({} as never);
  return row === null ? null : row.jsonSchema;
}

/**
 * The full docs' SCHEMA payloads for the given members — a dataset that
 * vanished between listing and read contributes nothing (the Convex
 * loader's rule; the JSON payload then carries `$schema: undefined`, the
 * same degradation), and a read failure degrades the same way instead of
 * aborting the export.
 */
async function readSchemasById(
  datasetIds: readonly string[],
): Promise<globalThis.Map<string, unknown>> {
  const pairs = await Promise.all(
    datasetIds.map(async (id) => {
      try {
        return [id, await readStoreDataset(id)] as const;
      } catch {
        return [id, undefined] as const;
      }
    }),
  );
  const byId = new globalThis.Map<string, unknown>();
  for (const [id, schema] of pairs) {
    if (schema !== null && schema !== undefined) {
      byId.set(id, schema);
    }
  }
  return byId;
}
