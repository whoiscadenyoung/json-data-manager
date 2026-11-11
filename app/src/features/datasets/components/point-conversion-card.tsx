import { detectCoordinateColumns } from "@caden/data-core/coordinate-columns";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MapPin } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { fetchDatasetEntryRows } from "#/lib/dataset-rows-pg";
import { errorMessage } from "#/lib/errors";
import * as datasetsStore from "#/lib/store/datasets";
import type { DatasetRow } from "#/lib/store/datasets";
import * as geometriesStore from "#/lib/store/geometries";

import {
  columnsOfRows,
  planPointConversion,
  skippedSummary,
  type PointPlan,
  type PointPlanRow,
} from "../lib/point-conversion";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ColumnSelect({
  id,
  label,
  value,
  columns,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  columns: readonly string[];
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm" htmlFor={id}>
      {label}
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        id={id}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        value={value}
      >
        <option value="">Pick a column</option>
        {columns.map((column) => (
          <option key={column} value={column}>
            {column}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The detected pair until the user picks their own. */
function pairOf(
  rows: readonly PointPlanRow[] | undefined,
  picked: { lat: string; lon: string } | undefined,
): { lat: string; lon: string } {
  if (picked !== undefined || rows === undefined) {
    return picked ?? { lat: "", lon: "" };
  }
  const guess = detectCoordinateColumns(rows.map((row) => (isRecord(row.data) ? row.data : {})));
  return guess === undefined ? { lat: "", lon: "" } : { lat: guess.latField, lon: guess.lonField };
}

/** The plan for the chosen pair, once the rows are loaded and two different columns are picked. */
function planFor(
  rows: readonly PointPlanRow[] | undefined,
  pair: { lat: string; lon: string },
): PointPlan | undefined {
  const ready = rows !== undefined && pair.lat !== "" && pair.lon !== "" && pair.lat !== pair.lon;
  return ready ? planPointConversion(rows, pair.lat, pair.lon) : undefined;
}

function PlanSummary({
  plan,
  total,
  progress,
  onConvert,
}: {
  plan: PointPlan;
  total: number;
  progress: string | undefined;
  onConvert: () => void;
}) {
  const skipped = skippedSummary(plan);
  return (
    <>
      <p className="text-sm">
        {plan.points.length.toLocaleString()} of {total.toLocaleString()} rows will get a point
        {skipped === "" ? "." : `; ${skipped} — those stay plain rows.`}
      </p>
      <Button
        className="self-start"
        disabled={plan.points.length === 0 || progress !== undefined}
        onClick={onConvert}
        size="sm"
      >
        {progress === undefined ? null : <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {progress ?? `Make ${plan.points.length.toLocaleString()} points`}
      </Button>
    </>
  );
}

/**
 * Spreadsheet → points (issue #293), on the Structure tab of a plain,
 * editable dataset. Reads the rows on request, previews how many get a point
 * and why the rest won't, then writes Point geometry rows in place (rows
 * without coordinates stay plain entries) and marks the dataset geospatial.
 * The geometry triggers bump the tile-cache version, so the archive
 * scheduler builds the map archive as for an import.
 */
export function PointConversionCard({ dataset }: { dataset: DatasetRow }) {
  const queryClient = useQueryClient(),
    [scanning, setScanning] = useState(false),
    rowsQuery = useQuery({
      enabled: scanning,
      queryFn: async (): Promise<PointPlanRow[]> => await fetchDatasetEntryRows(dataset.id),
      queryKey: ["pg:entries", "point-scan", dataset.id, dataset.updatedAt],
      staleTime: 60_000,
    }),
    rows = rowsQuery.data,
    [picked, setPicked] = useState<{ lat: string; lon: string } | undefined>(),
    pair = pairOf(rows, picked),
    columns = rows === undefined ? [] : columnsOfRows(rows),
    plan = planFor(rows, pair),
    [progress, setProgress] = useState<string | undefined>();

  const convert = async (): Promise<void> => {
    if (plan === undefined || plan.points.length === 0) {
      return;
    }
    try {
      const written = await geometriesStore.pointsFromCoordinates(
        { datasetId: dataset.id, points: plan.points },
        undefined,
        (done, total) => {
          setProgress(`Writing points… ${done.toLocaleString()} of ${total.toLocaleString()}`);
        },
      );
      if (written < plan.points.length) {
        throw new Error(
          `Only ${written.toLocaleString()} of ${plan.points.length.toLocaleString()} points were written — you may not have edit access.`,
        );
      }
      const flipped = await datasetsStore.setGeospatial({
        datasetId: dataset.id,
        geometryType: "Point",
      });
      if (flipped === 0) {
        throw new Error(
          "The points were written but the dataset couldn't be marked geospatial (locked).",
        );
      }
      toast.success(`${written.toLocaleString()} rows are now points on the map.`);
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:entries"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:geometries"] });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't convert the dataset."));
    } finally {
      setProgress(undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="h-5 w-5" />
          Make points from coordinates
        </CardTitle>
        <CardDescription>
          Turn latitude/longitude columns into map points (WGS84). Rows without valid coordinates
          stay in the dataset as plain rows; nothing is removed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!scanning ? (
          <Button
            className="self-start"
            onClick={() => {
              setScanning(true);
            }}
            size="sm"
            variant="outline"
          >
            Find coordinate columns
          </Button>
        ) : rows === undefined ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the rows…
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            <ColumnSelect
              columns={columns}
              id={`lat-${dataset.id}`}
              label="Latitude"
              onChange={(lat) => {
                setPicked({ lat, lon: pair.lon });
              }}
              value={pair.lat}
            />
            <ColumnSelect
              columns={columns}
              id={`lon-${dataset.id}`}
              label="Longitude"
              onChange={(lon) => {
                setPicked({ lat: pair.lat, lon });
              }}
              value={pair.lon}
            />
          </div>
        )}
        {plan === undefined ? null : (
          <PlanSummary
            onConvert={() => void convert()}
            plan={plan}
            progress={progress}
            total={rows === undefined ? 0 : rows.length}
          />
        )}
      </CardContent>
    </Card>
  );
}
