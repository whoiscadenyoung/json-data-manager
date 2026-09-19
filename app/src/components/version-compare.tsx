import { useQuery } from "convex/react";
import { GitCompareArrows } from "lucide-react";
import { useMemo, useState } from "react";

import {
  DiffOverlayMap,
  type DiffPoint,
  type DiffPointStatus,
} from "#/components/diff-overlay-map";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { api } from "#convex/_generated/api";

type VersionOption = { label: string; schemaId: string; title: string };

/**
 * The tag-compare view (docs/bound-datasets-design.md §6, issue #77): pick
 * any two frozen versions and the delta between them renders as an
 * add/remove/modify overlay on either base. The delta computes on demand
 * (tags.getVersionDelta) into the commits' ops shape; positions come from
 * whichever version still has the feature.
 */
export function VersionCompare({ versions }: { versions: Array<VersionOption> }) {
  const newest = versions.at(0),
    oldest = versions.at(1) ?? newest,
    [aSchemaId, setASchemaId] = useState<string | undefined>(
      oldest !== undefined ? oldest.schemaId : undefined,
    ),
    [bSchemaId, setBSchemaId] = useState<string | undefined>(
      newest !== undefined ? newest.schemaId : undefined,
    ),
    [base, setBase] = useState<"a" | "b">("b"),
    options = versions.map((version) => ({
      label: `${version.title} (${version.label})`,
      value: version.schemaId,
    }));

  const delta = useQuery(
      api.tags.getVersionDelta,
      aSchemaId !== undefined && bSchemaId !== undefined && aSchemaId !== bSchemaId
        ? { aSchemaId, bSchemaId }
        : "skip",
    ),
    aEntries = useQuery(
      api.tags.versionEntries,
      aSchemaId !== undefined ? { schemaId: aSchemaId } : "skip",
    ),
    bEntries = useQuery(
      api.tags.versionEntries,
      bSchemaId !== undefined ? { schemaId: bSchemaId } : "skip",
    );

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
            setASchemaId(value ?? undefined);
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
            setBSchemaId(value ?? undefined);
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
