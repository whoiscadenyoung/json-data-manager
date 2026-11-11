import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@caden/ui/components/table";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import type { JoinDiagnostics, StepDiagnostics } from "../lib/diagnostics";
import { LabeledSelect } from "./labeled-select";

export interface PreviewRow {
  row_id?: string | null;
  d: Record<string, unknown>;
  geom?: { type?: string } | null;
}

/** The columns a preview table renders: first-seen across the (at most 50) rows. */
export function previewColumns(rows: PreviewRow[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.d)) {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }
  return columns;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function ChipList({
  label,
  names,
  tone,
}: {
  label: string;
  names: string[];
  tone: "add" | "remove";
}) {
  if (names.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      {names.map((name) => (
        <Badge key={name} variant={tone === "add" ? "secondary" : "outline"}>
          {name}
        </Badge>
      ))}
    </div>
  );
}

/** Unmatched samples for one side, with "Add to key map" on the left side's samples. */
function UnmatchedSamples({
  canMap,
  mapDisabledReason,
  onAdd,
  rightSamples,
  samples,
  side,
  total,
}: {
  canMap: boolean;
  mapDisabledReason: string | undefined;
  onAdd: (from: string, to: string) => void;
  rightSamples: string[];
  samples: string[];
  side: "left" | "right";
  total: number;
}) {
  const [picking, setPicking] = useState<string | undefined>(undefined),
    [to, setTo] = useState("");
  if (total === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {side === "left" ? "Rows here with no match" : "Rows over there with no match"} ({total})
        {samples.length < total ? `, first ${samples.length} shown` : ""}
      </p>
      <ul className="flex flex-col gap-1">
        {samples.map((sample) => (
          <li className="flex flex-wrap items-center gap-2 text-sm" key={sample}>
            <code className="rounded bg-muted px-1.5 py-0.5">{sample}</code>
            {side === "left" && (
              <Button
                disabled={!canMap}
                onClick={() => {
                  setPicking(sample);
                  setTo("");
                }}
                size="xs"
                title={mapDisabledReason}
                type="button"
                variant="outline"
              >
                Add to key map
              </Button>
            )}
            {side === "left" && picking === sample && (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">matches</span>
                {rightSamples.length > 0 && (
                  <LabeledSelect
                    ariaLabel="Matches this unmatched value"
                    className="w-48"
                    onChange={setTo}
                    options={rightSamples.map((value) => ({ value, label: value }))}
                    placeholder="Pick a value"
                    value={rightSamples.includes(to) ? to : ""}
                  />
                )}
                <Input
                  aria-label="Or type the value it should match"
                  className="w-44"
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                  placeholder="or type a value"
                  value={to}
                />
                <Button
                  disabled={to.trim() === ""}
                  onClick={() => {
                    onAdd(sample, to);
                    setPicking(undefined);
                  }}
                  size="xs"
                  title={to.trim() === "" ? "Pick or type the value it should match." : undefined}
                  type="button"
                >
                  Add
                </Button>
                <Button
                  onClick={() => {
                    setPicking(undefined);
                  }}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function JoinStats({
  canMap,
  join,
  mapDisabledReason,
  onAddToKeyMap,
}: {
  canMap: boolean;
  join: JoinDiagnostics;
  mapDisabledReason: string | undefined;
  onAddToKeyMap: (from: string, to: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <p>
          <span className="font-medium">{join.leftMatched.toLocaleString()}</span> rows here
          matched, <span className="font-medium">{join.leftUnmatched.toLocaleString()}</span> did
          not
        </p>
        <p>
          <span className="font-medium">{join.rightMatched.toLocaleString()}</span> rows there
          matched, <span className="font-medium">{join.rightUnmatched.toLocaleString()}</span> did
          not
        </p>
        <p>
          <span className="font-medium">{join.multiMatchKeys.toLocaleString()}</span> keys have
          several matches
        </p>
        <p>
          Policy: <span className="font-medium">{join.policy}</span>
        </p>
      </div>
      <UnmatchedSamples
        canMap={canMap}
        mapDisabledReason={mapDisabledReason}
        onAdd={onAddToKeyMap}
        rightSamples={join.rightUnmatchedSamples}
        samples={join.leftUnmatchedSamples}
        side="left"
        total={join.leftUnmatched}
      />
      <UnmatchedSamples
        canMap={false}
        mapDisabledReason={undefined}
        onAdd={onAddToKeyMap}
        rightSamples={[]}
        samples={join.rightUnmatchedSamples}
        side="right"
        total={join.rightUnmatched}
      />
    </div>
  );
}

/** The diagnostics card of the selected step: rows in and out, fields changed, and join match statistics. */
export function DiagnosticsCard({
  canMap,
  diagnostics,
  mapDisabledReason,
  onAddToKeyMap,
}: {
  canMap: boolean;
  diagnostics: StepDiagnostics;
  mapDisabledReason: string | undefined;
  onAddToKeyMap: (from: string, to: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Diagnostics</CardTitle>
        <CardDescription>
          {diagnostics.rowsIn.toLocaleString()} rows in, {diagnostics.rowsOut.toLocaleString()} rows
          out. Computed over the full inputs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ChipList label="Fields added" names={diagnostics.fieldsAdded} tone="add" />
        <ChipList label="Fields removed" names={diagnostics.fieldsRemoved} tone="remove" />
        {diagnostics.join !== undefined && (
          <JoinStats
            canMap={canMap}
            join={diagnostics.join}
            mapDisabledReason={mapDisabledReason}
            onAddToKeyMap={onAddToKeyMap}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The preview rows (at most 50) as a table. */
export function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  const columns = previewColumns(rows);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">This step produces no rows.</p>;
  }
  return (
    <div className="max-h-96 overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {rows.some((row) => row.geom) && <TableHead className="w-20">Geometry</TableHead>}
            {columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- preview rows are positional query output.
            <TableRow key={index}>
              {rows.some((r) => r.geom) && (
                <TableCell className="text-xs text-muted-foreground">
                  {row.geom ? (row.geom.type ?? "yes") : "—"}
                </TableCell>
              )}
              {columns.map((column) => (
                <TableCell className="max-w-64 truncate font-mono text-xs" key={column}>
                  {cellText(row.d[column])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The right-hand pane: the selected step's preview rows and its diagnostics. */
export function PreviewPane({
  blockedReason,
  canMap,
  diagnostics,
  error,
  isLoading,
  mapDisabledReason,
  onAddToKeyMap,
  rows,
  title,
}: {
  /** Why no preview can run yet (validation problems), shown instead of a blank pane. */
  blockedReason: string | undefined;
  canMap: boolean;
  diagnostics: StepDiagnostics | undefined;
  error: string | undefined;
  isLoading: boolean;
  mapDisabledReason: string | undefined;
  onAddToKeyMap: (from: string, to: string) => void;
  rows: PreviewRow[] | undefined;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Badge variant="outline">First 50 rows</Badge>
      </div>
      {blockedReason !== undefined ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Preview waits on the steps above: {blockedReason}
        </p>
      ) : error !== undefined ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : rows === undefined ? (
        <p className="text-sm text-muted-foreground">Loading the preview…</p>
      ) : (
        <PreviewTable rows={rows} />
      )}
      {diagnostics !== undefined && blockedReason === undefined && (
        <DiagnosticsCard
          canMap={canMap}
          diagnostics={diagnostics}
          mapDisabledReason={mapDisabledReason}
          onAddToKeyMap={onAddToKeyMap}
        />
      )}
    </div>
  );
}
