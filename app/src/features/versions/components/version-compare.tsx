import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";
import { GitCompareArrows } from "lucide-react";
import { useMemo, useState } from "react";

import type { VersionDelta } from "#/lib/store/versions";
import type { VersionRow } from "#/lib/version-rows";

import { DiffOverlayMap, type DiffPoint, type DiffPointStatus } from "./diff-overlay-map";

type VersionOption = { label: string; schemaId: string; title: string };

/**
 * The truncation notice (#126): a delta whose sides sat at the server's
 * read budget covers only the first VERSION_DIFF_LIMIT rows per version —
 * the UI says so instead of presenting the bounded counts as the whole
 * truth. Module-level so the compare body stays a flat render.
 */
export function DeltaTruncationNotice({ truncated }: { truncated: boolean }) {
  if (!truncated) {
    return null;
  }
  return (
    <p className="text-xs text-amber-600 dark:text-amber-400">
      These versions exceed the 2,000-row diff budget — the counts and overlay cover the first 2,000
      rows of each side.
    </p>
  );
}

/**
 * The selected pair. The caller owns it, since the delta is a function of
 * the pair.
 */
interface ComparePair {
  aSchemaId: string | undefined;
  bSchemaId: string | undefined;
}

/**
 * The compare body — selects, the delta counts, and the diff overlay — as a
 * PURE view: every datum arrives as a prop (a resolved delta, the
 * positioning rows keyed per version, and a controlled pair). It mounts no
 * data reads of its own.
 */
// oxlint-disable-next-line eslint/complexity -- the compare body's readiness branches ARE its contract; ad hoc splitting risks these render paths.
export function VersionCompareView({
  versions,
  rows,
  delta,
  pair,
  onPairChange,
}: {
  versions: Array<VersionOption>;
  rows: globalThis.Map<string, VersionRow[]>;
  delta: VersionDelta | undefined;
  pair: ComparePair;
  onPairChange: (pair: ComparePair) => void;
}) {
  const aSchemaId = pair.aSchemaId,
    bSchemaId = pair.bSchemaId,
    [base, setBase] = useState<"a" | "b">("b"),
    options = versions.map((version) => ({
      label: `${version.title} (${version.label})`,
      value: version.schemaId,
    })),
    aEntries = rows.get(aSchemaId ?? ""),
    bEntries = rows.get(bSchemaId ?? "");

  const points = useMemo<DiffPoint[]>(() => {
    if (delta === undefined || aEntries === undefined || bEntries === undefined) {
      return [];
    }
    const rowsByKey = new Map<string, Record<string, unknown>>();
    for (const row of base === "a" ? [...aEntries, ...bEntries] : [...bEntries, ...aEntries]) {
      rowsByKey.set(row.key, row.data);
    }
    return delta.ops.flatMap((op) => {
      const data = rowsByKey.get(op.entryKey),
        lat = data !== undefined ? data.lat : undefined,
        lng = data !== undefined ? data.lng : undefined;
      if (typeof lat !== "number" || typeof lng !== "number") {
        return [];
      }
      const status: DiffPointStatus =
        op.op === "add" ? "add" : op.op === "delete" ? "delete" : "update";
      return [{ key: op.entryKey, label: op.entryKey, lat, lng, status }];
    });
  }, [delta, aEntries, bEntries, base]);

  const titleOf = (schemaId: string | undefined) => {
    const match =
      schemaId === undefined
        ? undefined
        : versions.find((version) => version.schemaId === schemaId);
    return match !== undefined ? match.title : "?";
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <GitCompareArrows className="h-4 w-4 text-muted-foreground" />
        <Select
          items={options}
          value={aSchemaId}
          onValueChange={(value) => {
            onPairChange({ aSchemaId: value ?? undefined, bSchemaId });
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">compared to</span>
        <Select
          items={options}
          value={bSchemaId}
          onValueChange={(value) => {
            onPairChange({ aSchemaId, bSchemaId: value ?? undefined });
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {delta !== undefined && aSchemaId !== bSchemaId && (
          <div className="flex items-center gap-1.5">
            <Badge variant="default">+{delta.added}</Badge>
            <Badge variant="destructive">−{delta.removed}</Badge>
            <Badge variant="secondary">~{delta.updated}</Badge>
          </div>
        )}
      </div>
      <DeltaTruncationNotice truncated={delta !== undefined && delta.truncated} />
      {aSchemaId === bSchemaId ? (
        <p className="text-sm text-muted-foreground">Pick two different versions to compare.</p>
      ) : delta === undefined || aEntries === undefined || bEntries === undefined ? (
        <p className="text-sm text-muted-foreground">Computing delta…</p>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Overlay on base
            <Button
              size="sm"
              variant={base === "a" ? "default" : "outline"}
              onClick={() => {
                setBase("a");
              }}
            >
              {titleOf(aSchemaId)} (before)
            </Button>
            <Button
              size="sm"
              variant={base === "b" ? "default" : "outline"}
              onClick={() => {
                setBase("b");
              }}
            >
              {titleOf(bSchemaId)} (after)
            </Button>
          </div>
          <DiffOverlayMap points={points} />
        </>
      )}
    </div>
  );
}
