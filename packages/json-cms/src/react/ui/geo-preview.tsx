import { computeBbox } from "@caden/data-core/geojson";
import type { BoundingBox, Geometry } from "@caden/data-core/geojson";
import { AlertTriangle, Map } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./primitives/card.js";

/**
 * The import review screen's geospatial preview: a lightweight inline-SVG
 * sketch of every parsed row's geometry plus the list of flagged rows —
 * geometry-less rows and the malformed features a GeoJSON parse skipped.
 * Deliberately not a MapLibre map: the component package stays free of map
 * dependencies (and SSR-safe), and the question an import preview answers is
 * "did my data come through looking like a map?" — an outline sketch answers
 * that at a glance. The dataset's real map lives one save away.
 */

/** Geometry-sketch cap: beyond this only a sampled subset is drawn (with a note), so a 20k-feature import can't mount thousands of SVG nodes. */
const MAX_SKETCH_SHAPES = 2000;

/** Flagged-row list cap before "+ N more". */
const MAX_FLAGGED_SHOWN = 10;

/** The viewBox the sketch draws into, CSS pixels. */
const SKETCH_WIDTH = 320,
  SKETCH_HEIGHT = 200,
  SKETCH_PAD = 14;

export interface GeoPreviewRow {
  data: unknown;
  geometry?: unknown;
}

export interface GeoPreviewProps {
  rows: ReadonlyArray<GeoPreviewRow>;
  /** Messages for features the GeoJSON parse rejected (keyed by feature index upstream). */
  invalidFeatures?: readonly string[];
}

/** One flagged list entry: the 1-based row number plus a label from its first string property. */
interface FlaggedEntry {
  label: string;
  rowNumber: number;
}

/** First string-valued property of a row — the flagged list's human label ("I 90 interchange"). */
function rowLabel(data: unknown): string {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    for (const value of Object.values(data)) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  return "";
}

/** "3 features carry geometry, 1 flagged below without one." */
function previewSummary(featureCount: number, flaggedCount: number): string {
  const geometryPart = `${featureCount.toLocaleString()} ${featureCount === 1 ? "feature carries" : "features carry"} geometry`,
    flaggedPart =
      flaggedCount > 0 ? `, ${flaggedCount.toLocaleString()} flagged below without one` : "";
  return `${geometryPart}${flaggedPart}. A rough sketch — the dataset's map renders after saving.`;
}

/** Projects the lon/lat envelope into sketch coordinates (equirectangular; a degenerate envelope centers its single point). */
function makeProjector(bbox: BoundingBox): (lon: number, lat: number) => [number, number] {
  const [minLon, minLat, maxLon, maxLat] = bbox,
    spanX = Math.max(maxLon - minLon, 1e-9),
    spanY = Math.max(maxLat - minLat, 1e-9);
  return (lon, lat) => {
    const x = SKETCH_PAD + ((lon - minLon) / spanX) * (SKETCH_WIDTH - 2 * SKETCH_PAD),
      y = SKETCH_PAD + ((maxLat - lat) / spanY) * (SKETCH_HEIGHT - 2 * SKETCH_PAD);
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  };
}

/** A position list as sketch-space points. */
function projectPositions(
  positions: ReadonlyArray<readonly number[]>,
  project: (lon: number, lat: number) => [number, number],
): Array<[number, number]> {
  return positions.map((p) => project(p[0] ?? 0, p[1] ?? 0));
}

function pointsAttribute(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

/** The projected sketch point for one position, centered when the position is unusable. */
function projectedPoint(
  coordinates: readonly number[],
  project: (lon: number, lat: number) => [number, number],
): [number, number] {
  return projectPositions([coordinates], project)[0] ?? [0, 0];
}

/** SVG path data for one ring (closed). */
function ringPath(
  ring: ReadonlyArray<readonly number[]>,
  project: (lon: number, lat: number) => [number, number],
): string {
  const points = projectPositions(ring, project);
  if (points.length === 0) {
    return "";
  }
  return `M ${pointsAttribute(points)} Z`;
}

/** N circles — the Point/MultiPoint half of the sketch. */
function PointSketch({
  points,
  project,
}: {
  points: ReadonlyArray<readonly number[]>;
  project: (lon: number, lat: number) => [number, number];
}) {
  return (
    <>
      {projectPositions(points, project).map(([x, y], i) => (
        // oxlint-disable-next-line react/no-array-index-key -- a static sketch that never reorders; its rows carry no stable ids.
        <circle className="fill-primary" cx={x} cy={y} key={i} r={3} />
      ))}
    </>
  );
}

/** N polylines — the LineString/MultiLineString half of the sketch. */
function LineSketch({
  lines,
  project,
}: {
  lines: ReadonlyArray<ReadonlyArray<readonly number[]>>;
  project: (lon: number, lat: number) => [number, number];
}) {
  return (
    <>
      {lines.map((line, i) => (
        <polyline
          className="fill-none stroke-primary"
          // oxlint-disable-next-line react/no-array-index-key -- a static sketch that never reorders; its rows carry no stable ids.
          key={i}
          points={pointsAttribute(projectPositions(line, project))}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
        />
      ))}
    </>
  );
}

/** N filled polygons (outer rings + evenodd holes) — the Polygon/MultiPolygon half of the sketch. */
function PolygonSketch({
  polygons,
  project,
}: {
  polygons: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly number[]>>>;
  project: (lon: number, lat: number) => [number, number];
}) {
  return (
    <>
      {polygons.map((polygon, i) => (
        <path
          className="fill-primary/15 stroke-primary"
          d={polygon.map((ring) => ringPath(ring, project)).join(" ")}
          fillRule="evenodd"
          // oxlint-disable-next-line react/no-array-index-key -- a static sketch that never reorders; its rows carry no stable ids.
          key={i}
          strokeLinejoin="round"
          strokeWidth={1}
        />
      ))}
    </>
  );
}

/**
 * Renders one geometry into sketch elements by dispatching to the per-family
 * sketches. Returns null for unrecognized shapes (nothing should reach this —
 * rows carry validated geometry — but a preview must never take the flow
 * down).
 */
function GeometrySketch({
  geometry,
  project,
}: {
  geometry: unknown;
  project: (lon: number, lat: number) => [number, number];
}) {
  // Rows carry geometry already validated by the import path's assertGeometry;
  // the prop stays unknown because previews also see coordinate-mapped rows.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const g = geometry as Geometry | undefined;
  if (g === undefined || g === null || typeof g !== "object") {
    return null;
  }
  if (g.type === "Point") {
    const [x, y] = projectedPoint(g.coordinates, project);
    return <circle className="fill-primary" cx={x} cy={y} r={3} />;
  }
  if (g.type === "MultiPoint") {
    return <PointSketch points={g.coordinates} project={project} />;
  }
  if (g.type === "LineString") {
    return <LineSketch lines={[g.coordinates]} project={project} />;
  }
  if (g.type === "MultiLineString") {
    return <LineSketch lines={g.coordinates} project={project} />;
  }
  if (g.type === "Polygon") {
    return <PolygonSketch polygons={[g.coordinates]} project={project} />;
  }
  if (g.type === "MultiPolygon") {
    return <PolygonSketch polygons={g.coordinates} project={project} />;
  }
  return null;
}

/** The envelope of every row's geometry, or undefined when none of them bound anything. */
function unionEnvelope(rows: ReadonlyArray<GeoPreviewRow>): BoundingBox | undefined {
  let envelope: BoundingBox | undefined;
  for (const row of rows) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see GeometrySketch.
    const rowBbox = computeBbox(row.geometry as Geometry);
    if (rowBbox === undefined) {
      continue;
    }
    envelope =
      envelope === undefined
        ? rowBbox
        : [
            Math.min(envelope[0], rowBbox[0]),
            Math.min(envelope[1], rowBbox[1]),
            Math.max(envelope[2], rowBbox[2]),
            Math.max(envelope[3], rowBbox[3]),
          ];
  }
  return envelope;
}

/** The sketch panel: every geometry-bearing row drawn into one SVG frame (capped, with an overflow note). */
function SketchSection({ rows, bbox }: { rows: ReadonlyArray<GeoPreviewRow>; bbox: BoundingBox }) {
  const sketchRows = rows.slice(0, MAX_SKETCH_SHAPES),
    hiddenSketchCount = rows.length - sketchRows.length,
    project = makeProjector(bbox);
  return (
    <CardContent className="pb-3">
      <div className="overflow-hidden rounded-md border border-border bg-muted/30">
        <svg
          aria-label="Sketch of the imported geometries"
          height={SKETCH_HEIGHT}
          viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
          width="100%"
          // An inline SVG sketch can't be an <img>; the role carries its accessible name.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="img"
        >
          {sketchRows.map((row, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- a static sketch that never reorders; its rows carry no stable ids.
            <GeometrySketch geometry={row.geometry} key={i} project={project} />
          ))}
        </svg>
      </div>
      {hiddenSketchCount > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          + {hiddenSketchCount.toLocaleString()} more{" "}
          {hiddenSketchCount === 1 ? "feature" : "features"} not sketched.
        </p>
      )}
    </CardContent>
  );
}

/** The flagged panel: rows without geometry and malformed features the parse skipped, capped with an overflow note. */
function FlaggedSection({
  flagged,
  invalid,
}: {
  flagged: FlaggedEntry[];
  invalid: readonly string[];
}) {
  const shownFlagged = flagged.slice(0, MAX_FLAGGED_SHOWN),
    shownInvalid = invalid.slice(0, MAX_FLAGGED_SHOWN),
    total = flagged.length + invalid.length,
    overflow = total - MAX_FLAGGED_SHOWN;
  return (
    <CardContent className="border-t border-border pt-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" />
        {flagged.length > 0 && (
          <span>
            {flagged.length.toLocaleString()} row{flagged.length === 1 ? "" : "s"} without geometry
          </span>
        )}
        {flagged.length > 0 && invalid.length > 0 && <span>·</span>}
        {invalid.length > 0 && (
          <span>
            {invalid.length.toLocaleString()} malformed feature
            {invalid.length === 1 ? "" : "s"} skipped
          </span>
        )}
      </p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {shownFlagged.map(({ label, rowNumber }) => (
          <li className="flex gap-1.5" key={`row-${rowNumber}`}>
            <span className="font-mono">row {rowNumber}</span>
            {label && <span className="truncate">— {label}</span>}
          </li>
        ))}
        {shownInvalid.map((message, i) => (
          // oxlint-disable-next-line react/no-array-index-key -- skipped-feature messages can repeat verbatim, so a content key could collide.
          <li className="flex gap-1.5" key={`invalid-${i}`}>
            <span className="font-mono">skipped</span>
            <span className="truncate">{message}</span>
          </li>
        ))}
        {overflow > 0 && (
          <li>
            + {overflow} more flagged {overflow === 1 ? "entry" : "entries"}.
          </li>
        )}
      </ul>
    </CardContent>
  );
}

/** The review screen's geometry sketch + flagged-rows card. Renders nothing when there's nothing to preview (no geometry, no flags). */
export function GeoPreview({ rows, invalidFeatures }: GeoPreviewProps) {
  const withGeometry = rows.filter((row) => row.geometry !== undefined && row.geometry !== null),
    geometryless = rows
      .map((row, index) => ({ index, row }))
      .filter(({ row }) => row.geometry === undefined || row.geometry === null),
    bbox = unionEnvelope(withGeometry),
    flagged = geometryless.map(({ index, row }) => ({
      label: rowLabel(row.data),
      rowNumber: index + 1,
    })),
    invalid = invalidFeatures ?? [];

  if (bbox === undefined && flagged.length === 0 && invalid.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Map className="h-4 w-4 text-muted-foreground" />
          Geometry preview
        </CardTitle>
        <CardDescription>
          {previewSummary(withGeometry.length, geometryless.length)}
        </CardDescription>
      </CardHeader>
      {bbox !== undefined && <SketchSection bbox={bbox} rows={withGeometry} />}
      {(flagged.length > 0 || invalid.length > 0) && (
        <FlaggedSection flagged={flagged} invalid={invalid} />
      )}
    </Card>
  );
}
