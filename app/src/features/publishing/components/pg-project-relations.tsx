import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, KeyRound, Loader2, MapPinned, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import type { DatasetRow } from "@/lib/store/datasets";
import * as derivedStore from "@/lib/store/derived";
import * as layersStore from "@/lib/store/layers";
import type { DatasetMembershipRow } from "@/lib/store/layers";
import * as relationsStore from "@/lib/store/relations";
import type { DatasetRelationRow } from "@/lib/store/relations";

import { VIEWER_REASON } from "../lib/pg-viewer-posture";

/**
 * The project catalog's Relations section (issue #258 — the project-centric
 * train's phase 4; D3): the dataset↔dataset relations declared over this
 * project's dataset memberships. Relations are CATALOG-LEVEL rows — the
 * section lists every relation touching a member dataset (including ones
 * declared elsewhere), and declaring one here makes it reusable by any
 * project holding both datasets. Key relations carry the one-click
 * lookup-join offer (the transform engine's op — "relate" and "join into a
 * table" are one declaration, two consumers).
 */

type RelationKind = "key" | "spatial";
type RelationCardinality = "1-1" | "1-N" | "N-M";

/** The key-kind pickers' default (visits-per-park is the common shape). */
const DEFAULT_CARDINALITY: Record<RelationKind, RelationCardinality> = {
  key: "1-N",
  spatial: "N-M",
};

/** The relation's config summary line (key: the join fields; spatial: predicate · direction). */
function configSummary(relation: DatasetRelationRow): string {
  if (
    typeof relation.config !== "object" ||
    relation.config === null ||
    Array.isArray(relation.config)
  ) {
    return "";
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record guard above is the runtime check; the config jsonb's documented shapes are the contract.
  const config = relation.config as Record<string, unknown>;
  if (relation.kind === "key") {
    const fromKey = typeof config.fromKey === "string" ? config.fromKey : "?";
    const toKey = typeof config.toKey === "string" ? config.toKey : "?";
    return `${fromKey} → ${toKey}`;
  }
  const predicate = typeof config.predicate === "string" ? config.predicate : "?";
  const direction = typeof config.direction === "string" ? config.direction : "?";
  return `${predicate} · ${direction}`;
}

/** The dataset's title, or the fallback when the id resolves to nothing visible (no optional chaining). */
function titleOf(map: globalThis.Map<string, DatasetRow>, id: string, fallback: string): string {
  const row = map.get(id);
  return row === undefined ? fallback : row.title;
}

/** The section shell: the declared relations over the project's dataset memberships + the relate sheet. */
export function PgProjectRelationsSection({
  canEdit,
  projectId,
}: {
  canEdit: boolean;
  projectId: string;
}) {
  const queryClient = useQueryClient(),
    invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:relations"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:derived"] });
    },
    membershipsQuery = useQuery({
      ...layersStore.listDatasetMembershipsQueryOptions({ projectId }),
    }),
    datasetsQuery = useQuery(datasetsStore.listQueryOptions()),
    datasetMemberships = (membershipsQuery.data ?? []).filter(
      (membership) => membership.artifactKind === "dataset",
    ),
    datasetIds = datasetMemberships.map((membership) => membership.artifactId),
    relationsQuery = useQuery({
      ...relationsStore.listForDatasetsQueryOptions({ datasetIds }),
    }),
    relationCount = relationsQuery.data === undefined ? 0 : relationsQuery.data.length,
    datasetsById = new globalThis.Map(
      (datasetsQuery.data ?? []).map((dataset) => [dataset.id, dataset]),
    ),
    [relateOpen, setRelateOpen] = useState(false),
    // The sheet remounts on every open: a programmatic open doesn't fire the
    // sheet's onOpenChange, so the previous picks would otherwise survive
    // into the next declaration (met live — the "Declare relation" button
    // came up already enabled on the second open).
    [sheetGeneration, setSheetGeneration] = useState(0);
  return (
    <section className="mt-2">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Relations{" "}
          <span className="font-normal">
            ({relationCount} {relationCount === 1 ? "relation" : "relations"})
          </span>
        </h2>
        <Button
          disabled={!canEdit}
          onClick={() => {
            setSheetGeneration((generation) => generation + 1);
            setRelateOpen(true);
          }}
          size="sm"
          title={canEdit ? "Declare a relation between two member datasets" : VIEWER_REASON}
          variant="outline"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Relate datasets
        </Button>
      </div>
      {relationCount === 0 ? (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          No relations yet — declare how two datasets relate (a field join or a PostGIS predicate)
          and every map in every project holding them can use it.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {(relationsQuery.data === undefined ? [] : relationsQuery.data).map((relation) => (
            <PgRelationRow
              canEdit={canEdit}
              datasetsById={datasetsById}
              invalidate={invalidate}
              key={relation.id}
              relation={relation}
            />
          ))}
        </div>
      )}
      <PgRelateDatasetsSheet
        key={sheetGeneration}
        datasetMemberships={datasetMemberships}
        datasets={datasetsQuery.data ?? []}
        onOpenChange={setRelateOpen}
        open={relateOpen}
        titleById={
          new globalThis.Map(
            datasetMemberships.map((membership) => [
              membership.artifactId,
              titleOf(datasetsById, membership.artifactId, membership.artifactId),
            ]),
          )
        }
        onCreated={invalidate}
      />
    </section>
  );
}

/** One declared relation: from → to with the kind chip, cardinality, config summary, and the key-kind join offer + remove. */
function PgRelationRow({
  canEdit,
  datasetsById,
  invalidate,
  relation,
}: {
  canEdit: boolean;
  datasetsById: globalThis.Map<string, DatasetRow>;
  invalidate: () => void;
  relation: DatasetRelationRow;
}) {
  const [busy, setBusy] = useState<string>(),
    fromTitle = titleOf(datasetsById, relation.fromDataset, "Unknown dataset"),
    toTitle = titleOf(datasetsById, relation.toDataset, "Unknown dataset"),
    keyConfig =
      relation.kind === "key" &&
      typeof relation.config === "object" &&
      relation.config !== null &&
      !Array.isArray(relation.config)
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record guard above is the runtime check; the key config's documented shape is the contract.
          (relation.config as Record<string, unknown>)
        : undefined,
    join = async (): Promise<void> => {
      // The one-click lookup-join (the acceptance's "relate and join into a
      // table share the declaration"): left-join the TO side's rows onto
      // the FROM side by the relation's own key fields.
      setBusy("join");
      try {
        const fromKey = keyConfig === undefined ? undefined : keyConfig.fromKey,
          toKey = keyConfig === undefined ? undefined : keyConfig.toKey;
        if (typeof fromKey !== "string" || typeof toKey !== "string") {
          throw new Error("This relation's key fields are missing.");
        }
        await derivedStore.save({
          spec: {
            operations: [
              {
                baseKey: fromKey,
                kind: "lookup",
                lookupDatasetId: relation.toDataset,
                lookupKey: toKey,
                match: "left",
                // Namespace by TITLE, not the engine's dataset-id default —
                // UUID-prefixed output headers are unreadable (#281; the
                // transform editor's picker flow already names this way).
                namespace: toTitle,
              },
            ],
            sourceDatasetId: relation.fromDataset,
          },
          status: "saved",
          title: `${fromTitle} + ${toTitle}`,
        });
        toast.success("Derived dataset created — the join lives in the Derived section.");
        invalidate();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to create the derived dataset."));
      } finally {
        setBusy(undefined);
      }
    },
    remove = async (): Promise<void> => {
      setBusy("remove");
      try {
        await relationsStore.remove({ relationId: relation.id });
        toast.success("Relation removed.");
        invalidate();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to remove the relation."));
      } finally {
        setBusy(undefined);
      }
    };
  return (
    <Card className="flex-row items-center gap-4 px-4 py-3 transition-shadow hover:shadow-md">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0">
        <div className="flex flex-wrap items-center gap-2">
          {relation.kind === "key" ? (
            <Badge title="A field-value join between the two datasets." variant="secondary">
              <KeyRound className="h-3 w-3" />
              Key
            </Badge>
          ) : (
            <Badge
              title="A PostGIS predicate between the two datasets' geometries."
              variant="secondary"
            >
              <MapPinned className="h-3 w-3" />
              Spatial
            </Badge>
          )}
          <Badge
            title="The declared shape the map popups render by — the data decides what actually answers."
            variant="outline"
          >
            {relation.cardinality}
          </Badge>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{fromTitle}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{toTitle}</span>
        </p>
        <p className="text-xs text-muted-foreground">{configSummary(relation)}</p>
      </div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-1.5">
          {keyConfig !== undefined && (
            <Button
              disabled={busy !== undefined}
              onClick={() => {
                void join();
              }}
              size="sm"
              title="Materialize the join as a derived dataset (the transform engine's lookup op — left-joined by this relation's key fields)."
              variant="outline"
            >
              {busy === "join" ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-3.5 w-3.5" />
              )}
              Join into a table
            </Button>
          )}
          <Button
            aria-label="Remove relation"
            className="text-muted-foreground hover:text-destructive"
            disabled={busy !== undefined}
            onClick={() => {
              void remove();
            }}
            size="icon"
            title="Remove the relation (the datasets stay untouched)"
            variant="ghost"
          >
            {busy === "remove" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** The relate sheet: two distinct member datasets, the kind (key join or spatial predicate), cardinality, and the kind's config fields. */
// The kind ladder (shared from/to pickers, then key's field pickers vs
// spatial's predicate+direction) IS the sheet's whole contract, read top to
// bottom; splitting it would scatter one declaration form across components.
// oxlint-disable-next-line eslint/complexity -- the kind ladder is the form's shape, stated once.
function PgRelateDatasetsSheet({
  datasetMemberships,
  datasets,
  onCreated,
  onOpenChange,
  open,
  titleById,
}: {
  datasetMemberships: DatasetMembershipRow[];
  datasets: DatasetRow[];
  onCreated: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  titleById: globalThis.Map<string, string>;
}) {
  const [fromId, setFromId] = useState(""),
    [toId, setToId] = useState(""),
    [kind, setKind] = useState<RelationKind>("spatial"),
    [cardinality, setCardinality] = useState<RelationCardinality>(DEFAULT_CARDINALITY.spatial),
    [predicate, setPredicate] = useState("within"),
    [direction, setDirection] = useState("forward"),
    [fromKey, setFromKey] = useState(""),
    [toKey, setToKey] = useState(""),
    [pending, setPending] = useState(false),
    propertiesOf = (datasetId: string): string[] => {
      const dataset = datasets.find((candidate) => candidate.id === datasetId);
      return dataset === undefined ? [] : dataset.properties;
    },
    pickFrom = (datasetId: string): void => {
      setFromId(datasetId);
      // The key pickers' options move with their dataset — reset the stale picks.
      setFromKey("");
    },
    pickTo = (datasetId: string): void => {
      setToId(datasetId);
      setToKey("");
    },
    pickKind = (next: RelationKind): void => {
      setKind(next);
      setCardinality(DEFAULT_CARDINALITY[next]);
    },
    ready =
      fromId !== "" &&
      toId !== "" &&
      fromId !== toId &&
      (kind === "spatial" || (fromKey !== "" && toKey !== "")),
    blockedReason = ready
      ? undefined
      : fromId === "" || toId === ""
        ? "Pick the two datasets first."
        : fromId === toId
          ? "The two datasets must differ."
          : "Pick both join fields.",
    declare = async (): Promise<void> => {
      setPending(true);
      try {
        const row = await relationsStore.create({
          cardinality,
          config: kind === "key" ? { fromKey, toKey } : { direction, predicate },
          fromDataset: fromId,
          kind,
          toDataset: toId,
        });
        if (row === null) {
          toast.error("The relation didn't land — you may not be able to edit both datasets.");
          return;
        }
        toast.success(
          "Relation declared — every project holding both datasets can now relate them.",
        );
        onCreated();
        onOpenChange(false);
      } catch (error) {
        // A duplicate (from, to, kind) rides the 23505 constraint's message —
        // shown verbatim (the honest constraint).
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setPending(false);
      }
    };
  return (
    <Sheet
      onOpenChange={(next) => {
        if (next) {
          setFromId("");
          setToId("");
          setFromKey("");
          setToKey("");
          setKind("spatial");
          setCardinality(DEFAULT_CARDINALITY.spatial);
          setPredicate("within");
          setDirection("forward");
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Relate datasets</SheetTitle>
          <SheetDescription>
            A relation is declared once at the data level — every project holding both datasets
            consumes it.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold">
              From dataset <span className="text-destructive">*</span>
            </p>
            <Select
              onValueChange={(value) => {
                if (value !== null) {
                  pickFrom(value);
                }
              }}
              value={fromId}
            >
              <SelectTrigger id="relation-from">
                {/* base-ui's Select.Value renders the raw value — the label goes here explicitly. */}
                <SelectValue placeholder="Pick the first dataset">
                  {fromId === "" ? undefined : (titleById.get(fromId) ?? fromId)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {datasetMemberships.map((membership) => (
                  <SelectItem key={membership.id} value={membership.artifactId}>
                    {titleById.get(membership.artifactId) ?? membership.artifactId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold">
              To dataset <span className="text-destructive">*</span>
            </p>
            <Select
              onValueChange={(value) => {
                if (value !== null) {
                  pickTo(value);
                }
              }}
              value={toId}
            >
              <SelectTrigger id="relation-to">
                <SelectValue placeholder="Pick the second dataset">
                  {toId === "" ? undefined : (titleById.get(toId) ?? toId)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {datasetMemberships
                  .filter((membership) => membership.artifactId !== fromId)
                  .map((membership) => (
                    <SelectItem key={membership.id} value={membership.artifactId}>
                      {titleById.get(membership.artifactId) ?? membership.artifactId}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <p className="text-sm font-semibold">Kind</p>
              <Select
                onValueChange={(value) => {
                  if (value === "key" || value === "spatial") {
                    pickKind(value);
                  }
                }}
                value={kind}
              >
                <SelectTrigger id="relation-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="spatial">Spatial (PostGIS)</SelectItem>
                  <SelectItem value="key">Key (field join)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <p className="text-sm font-semibold">Cardinality</p>
              <Select
                onValueChange={(value) => {
                  if (value === "1-1" || value === "1-N" || value === "N-M") {
                    setCardinality(value);
                  }
                }}
                value={cardinality}
              >
                <SelectTrigger id="relation-cardinality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1-1">1–1</SelectItem>
                  <SelectItem value="1-N">1–N</SelectItem>
                  <SelectItem value="N-M">N–M</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {kind === "spatial" ? (
            <div className="flex items-end gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <p className="text-sm font-semibold">Predicate</p>
                <Select
                  onValueChange={(value) => {
                    if (value !== null) {
                      setPredicate(value);
                    }
                  }}
                  value={predicate}
                >
                  <SelectTrigger id="relation-predicate">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="within">within</SelectItem>
                    <SelectItem value="intersects">intersects</SelectItem>
                    <SelectItem value="contains">contains</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <p className="text-sm font-semibold">Direction</p>
                <Select
                  onValueChange={(value) => {
                    if (value !== null) {
                      setDirection(value);
                    }
                  }}
                  value={direction}
                >
                  <SelectTrigger id="relation-direction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="forward">forward — the from side is the subject</SelectItem>
                    <SelectItem value="reverse">reverse — the to side is the subject</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="flex items-end gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <p className="text-sm font-semibold">
                  From field <span className="text-destructive">*</span>
                </p>
                <Select
                  onValueChange={(value) => {
                    if (value !== null) {
                      setFromKey(value);
                    }
                  }}
                  value={fromKey}
                >
                  <SelectTrigger id="relation-from-key">
                    <SelectValue placeholder="Pick a field">
                      {fromKey === "" ? undefined : fromKey}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {propertiesOf(fromId).map((property) => (
                      <SelectItem key={property} value={property}>
                        {property}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <p className="text-sm font-semibold">
                  To field <span className="text-destructive">*</span>
                </p>
                <Select
                  onValueChange={(value) => {
                    if (value !== null) {
                      setToKey(value);
                    }
                  }}
                  value={toKey}
                >
                  <SelectTrigger id="relation-to-key">
                    <SelectValue placeholder="Pick a field">
                      {toKey === "" ? undefined : toKey}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {propertiesOf(toId).map((property) => (
                      <SelectItem key={property} value={property}>
                        {property}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <Button
            disabled={!ready || pending}
            onClick={() => {
              void declare();
            }}
            title={ready ? undefined : blockedReason}
          >
            {pending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Declare relation
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
