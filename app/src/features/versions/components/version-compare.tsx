import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { GitCompareArrows } from "lucide-react";
import { useMemo, useState } from "react";

import type { VersionRow } from "#/lib/version-rows";
import { api } from "#convex/_generated/api";

import { DiffOverlayMap, type DiffPoint, type DiffPointStatus } from "./diff-overlay-map";

type VersionOption = { label: string; schemaId: string; title: string };
type VersionDelta = FunctionReturnType<typeof api.versions.tags.getVersionDelta>;

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
 * A precomputed delta: the caller hands in the stored sequential delta (or
 * "pending" while its read is in flight) so the common pinned→head pair
 * never pays the on-demand full scan; null/absent falls back to it.
 */
type PrecomputedDelta = VersionDelta | null | "pending";

/**
 * The selected pair, when the caller controls it: the Postgres edition of
 * the compare (stage 4, #203) computes its delta client-side, so IT has to
 * own which pair is selected (the delta is a function of the pair). Absent
 * `pair`, the component seeds and holds its own selection exactly as it
 * always has (the Convex path — untouched behavior).
 */
interface ComparePair {
  aSchemaId: string | undefined;
  bSchemaId: string | undefined;
}

/**
 * The tag-compare view (docs/bound-datasets-design.md §6, issue #77): pick
 * any two frozen versions and the delta between them renders as an
 * add/remove/modify overlay on either base. The delta computes on demand
 * (tags.getVersionDelta) into the commits' ops shape; positions come from
 * whichever version still has the feature.
 *
 * `rows` (stage 6, #101) hands the overlay's positioning rows in from the
 * row-resolution seam (`useDatasetVersionRows` — byte-budgeted pages through
 * the one seam) instead of the server's bounded `tags.versionEntries` read;
 * the ops themselves still come from the shipped delta path, so counts and
 * positions key identically (`version-rows.ts` is the one key rule both
 * sides share).
 *
 * `pair`/`onPairChange` (stage 4) make the selection CONTROLLED for callers
 * that derive the delta themselves (the PG edition); the fallback queries
 * stay skipped in that mode exactly as when `rows`/`delta` serve.
 */
// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
export function VersionCompare({
  versions,
  rows,
  delta: deltaProp,
  pair,
  onPairChange,
}: {
  versions: Array<VersionOption>;
  rows?: globalThis.Map<string, VersionRow[]>;
  delta?: PrecomputedDelta;
  pair?: ComparePair;
  onPairChange?: (pair: ComparePair) => void;
}) {
  const newest = versions.at(0),
    oldest = versions.at(1) ?? newest,
    [seededA, setSeededA] = useState<string | undefined>(
      oldest !== undefined ? oldest.schemaId : undefined,
    ),
    [seededB, setSeededB] = useState<string | undefined>(
      newest !== undefined ? newest.schemaId : undefined,
    ),
    // Controlled when the caller passes `pair`; the seeded states stand in
    // otherwise (their setters are only reachable through that same branch).
    aSchemaId = pair === undefined ? seededA : pair.aSchemaId,
    bSchemaId = pair === undefined ? seededB : pair.bSchemaId,
    selectPair = (patch: { aSchemaId?: string; bSchemaId?: string }): void => {
      if (pair === undefined || onPairChange === undefined) {
        if (patch.aSchemaId !== undefined) {
          setSeededA(patch.aSchemaId);
        }
        if (patch.bSchemaId !== undefined) {
          setSeededB(patch.bSchemaId);
        }
        return;
      }
      onPairChange({
        aSchemaId: patch.aSchemaId ?? pair.aSchemaId,
        bSchemaId: patch.bSchemaId ?? pair.bSchemaId,
      });
    },
    [base, setBase] = useState<"a" | "b">("b"),
    options = versions.map((version) => ({
      label: `${version.title} (${version.label})`,
      value: version.schemaId,
    }));

  // The delta: the caller's precomputed one when handed in ("pending" shows
  // the computing state without firing the fallback), else the shipped
  // on-demand read. The query stays mounted either way ("skip" keeps it
  // unsubscribed while the prop serves) — hooks can't be conditional.
  const fallbackDelta = useQuery(
      api.versions.tags.getVersionDelta,
      deltaProp === undefined || deltaProp === null
        ? aSchemaId !== undefined && bSchemaId !== undefined && aSchemaId !== bSchemaId
          ? { aSchemaId, bSchemaId }
          : "skip"
        : "skip",
    ),
    delta =
      deltaProp === "pending" || deltaProp === undefined || deltaProp === null
        ? fallbackDelta
        : deltaProp,
    // Positioning rows: the seam-provided rows when handed in, else the
    // shipped server read. The queries stay mounted either way ("skip" keeps
    // them unsubscribed while `rows` serves) — hooks can't be conditional.
    aServerEntries = useQuery(
      api.versions.tags.versionEntries,
      rows !== undefined || aSchemaId === undefined ? "skip" : { schemaId: aSchemaId },
    ),
    bServerEntries = useQuery(
      api.versions.tags.versionEntries,
      rows !== undefined || bSchemaId === undefined ? "skip" : { schemaId: bSchemaId },
    ),
    aEntries = rows === undefined ? aServerEntries : rows.get(aSchemaId ?? ""),
    bEntries = rows === undefined ? bServerEntries : rows.get(bSchemaId ?? "");

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
            selectPair({ aSchemaId: value ?? undefined });
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
            selectPair({ bSchemaId: value ?? undefined });
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
