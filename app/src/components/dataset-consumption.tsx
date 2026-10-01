import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowDownToLine,
  GitCompareArrows,
  History,
  Link2,
  Pin,
  RefreshCw,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "#/components/dashboard/confirm-delete-dialog";
import { SourceDriftBadges, type SourceBadge } from "#/components/dataset-type-tags";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { VersionCompare } from "#/components/version-compare";
import { useDatasetVersionRows } from "#/lib/dataset-rows-react";
import { errorMessage } from "#/lib/errors";
import { publishDataset } from "#/lib/publish";
import type { VersionRow } from "#/lib/version-rows";
import { api } from "#convex/_generated/api";

/**
 * Versioned consumption's consumer-facing surfaces (roadmap stage 6, #101;
 * lifecycle §7): the "source published vN" card with its per-source diff and
 * sync affordance, the consumed-by list, and the publish-chain Versions card
 * (keep-N with pinning). All reads are the consumption queries; the only
 * execution this module triggers is `publishDataset` — the 5b state machine,
 * never a re-implementation.
 */

type ChainVersionRow = FunctionReturnType<typeof api.consumption.chainVersions>[number];
type DatasetDoc = FunctionReturnType<typeof api.schemas.list>[number];

/**
 * The diff view for one drifted source: pinned (the recorded freeze) vs the
 * new head. The delta prefers the STORED sequential delta the publish
 * completion hook recorded (the issue's scale note — the pinned→head pair is
 * the common consecutive case); a pair no stored delta covers falls back to
 * the shipped on-demand `tags.getVersionDelta` inside VersionCompare.
 */
function PinnedHeadDiff(options: {
  headLabel: string;
  headRef: string;
  headSchemaId: string;
  recordedLabel: string;
  recordedRef: string;
  recordedSchemaId: string;
  sourceAnchorId: string;
  sourceTitle: string;
}) {
  const storedDelta = useQuery({
      ...convexQuery(api.consumption.storedDelta, {
        anchorId: options.sourceAnchorId,
        fromRef: options.recordedRef,
        toRef: options.headRef,
      }),
    }).data,
    headRows = useDatasetVersionRows(options.headSchemaId, true),
    pinnedRows = useDatasetVersionRows(options.recordedSchemaId, true),
    // The seam rows, keyed per version — both passes complete before the
    // overlay renders (the reports' `complete` is the full-pass signal).
    complete = headRows.isComplete && pinnedRows.isComplete,
    rowsById = new globalThis.Map<string, VersionRow[]>();
  if (complete) {
    rowsById.set(options.headSchemaId, headRows.versionRows ?? []);
    rowsById.set(options.recordedSchemaId, pinnedRows.versionRows ?? []);
  }
  return (
    <div className="mt-2">
      <VersionCompare
        delta={storedDelta === undefined ? "pending" : storedDelta}
        rows={complete ? rowsById : undefined}
        versions={[
          {
            label: options.headLabel,
            schemaId: options.headSchemaId,
            title: options.sourceTitle,
          },
          {
            label: options.recordedLabel,
            schemaId: options.recordedSchemaId,
            title: options.sourceTitle,
          },
        ]}
      />
    </div>
  );
}

/**
 * The "sources" card on a PUBLISHED row's page: what each consumed source
 * contributed at this version's freeze, whether a source chain has moved
 * since (the badge), the pinned → head diff, and — for a derived chain — the
 * sync button, which re-publishes through the 5b state machine (vN+1;
 * propagation to ITS consumers is transitive by construction).
 */
export function SourceDriftCard({ schema }: { schema: DatasetDoc }) {
  const lineage = schema.lineage;
  const badgesResult = useQuery({
    ...convexQuery(api.consumption.sourceBadges, {
      registryIds: [],
      schemaIds: [schema._id],
    }),
  }).data;
  const [diffOpenFor, setDiffOpenFor] = useState<string>(),
    [isSyncing, setIsSyncing] = useState(false),
    handleSync = async () => {
      if (lineage === undefined || lineage.sourceKey === undefined) {
        return;
      }
      setIsSyncing(true);
      try {
        await publishDataset({ datasetKey: lineage.sourceKey });
        // publishDataset's documented contract: it returns at the FREEZE
        // handoff, not at import completion — the new version (and this
        // consumers' badges) land when the durable workflow finishes.
        toast.success("Publish started — vN+1 freezes when the import lands.");
      } catch (error) {
        toast.error(errorMessage(error, "The re-publish failed."));
      } finally {
        setIsSyncing(false);
      }
    };
  if (lineage === undefined || (lineage.sourceVersions ?? []).length === 0) {
    return null;
  }
  const badges = badgesResult === undefined ? undefined : badgesResult.bySchemaId[schema._id];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" />
          Sources
        </CardTitle>
        <CardDescription>
          What each source contributed when this version froze, and whether its chain has moved
          since.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <SourceDriftBadges badges={badges} />
        {(badges ?? []).map((badge) => (
          <SourceBadgeRow
            key={badge.sourceDatasetId}
            badge={badge}
            diffOpen={diffOpenFor === badge.sourceDatasetId}
            onToggleDiff={() => {
              setDiffOpenFor(
                diffOpenFor === badge.sourceDatasetId ? undefined : badge.sourceDatasetId,
              );
            }}
          />
        ))}
        {lineage.sourceKey !== undefined && (
          <div className="mt-2 border-t pt-3">
            <Button
              disabled={isSyncing}
              size="sm"
              onClick={() => {
                void handleSync();
              }}
              variant="outline"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {isSyncing ? "Re-publishing…" : "Sync — re-run the recipe and freeze vN+1"}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Syncing re-executes the spec client-side and freezes a new version through the same
              durable publish — never a rewrite of this one (the catalog is append-only).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One consumed source's row: recorded vs head, with the diff affordance when a drift has both ends on file. */
// oxlint-disable-next-line eslint/complexity -- the per-state badges and the diff gate are flat on purpose; each state is one line of honest copy.
function SourceBadgeRow({
  badge,
  diffOpen,
  onToggleDiff,
}: {
  badge: SourceBadge;
  diffOpen: boolean;
  onToggleDiff: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{badge.sourceTitle ?? badge.sourceDatasetId}</span>
        {badge.recordedVersionLabel !== undefined ? (
          <span className="text-muted-foreground">frozen against {badge.recordedVersionLabel}</span>
        ) : (
          <span className="text-muted-foreground">read live (no frozen version)</span>
        )}
        {badge.state === "drift" && (
          <Badge variant="destructive">now at {badge.headVersionLabel ?? "a newer version"}</Badge>
        )}
        {badge.state === "missing" && <Badge variant="outline">recorded version gone</Badge>}
        {badge.state === "current" && (
          <Badge variant="secondary">
            <ArrowDownToLine className="h-3 w-3" />
            up to date
          </Badge>
        )}
        {badge.state === "drift" &&
          badge.recordedSchemaId !== undefined &&
          badge.headSchemaId !== undefined && (
            <Button onClick={onToggleDiff} size="sm" variant="outline">
              <GitCompareArrows className="h-3.5 w-3.5" />
              {diffOpen ? "Hide diff" : "Diff pinned → head"}
            </Button>
          )}
      </div>
      {diffOpen &&
        badge.state === "drift" &&
        badge.recordedSchemaId !== undefined &&
        badge.headSchemaId !== undefined &&
        badge.recordedRef !== undefined &&
        badge.headRef !== undefined &&
        badge.sourceAnchorId !== undefined && (
          <PinnedHeadDiff
            headLabel={badge.headVersionLabel ?? "head"}
            headRef={badge.headRef}
            headSchemaId={badge.headSchemaId}
            recordedLabel={badge.recordedVersionLabel ?? "pinned"}
            recordedRef={badge.recordedRef}
            recordedSchemaId={badge.recordedSchemaId}
            sourceAnchorId={badge.sourceAnchorId}
            sourceTitle={badge.sourceTitle ?? badge.sourceDatasetId}
          />
        )}
    </div>
  );
}

/**
 * The consumed-by list (lifecycle §7): every consumer holding a reference on
 * this dataset, with its pin/float state. The projection knows transform-spec
 * consumers ("derived"); maps and collections reference datasets but hold no
 * version reference — the honesty line below says so rather than implying
 * completeness.
 */
export function ConsumedByCard({ schemaId }: { schemaId: string }) {
  const consumedBy = useQuery({
    ...convexQuery(api.consumption.consumedBy, { datasetId: schemaId }),
  }).data;
  const floatToHead = useMutation(api.consumption.setReferenceMode),
    syncRef = useMutation(api.consumption.syncReference),
    revertRef = useMutation(api.consumption.revertReference),
    [pendingId, setPendingId] = useState<string>();
  const consumers = consumedBy === undefined ? [] : consumedBy.consumers;
  // One reference action at a time, tracked by the row's reference id so the
  // row's buttons show progress and can't be re-clicked mid-mutation (the
  // MembershipPicker pattern).
  const runReferenceAction = async (
    referenceId: string,
    action: "pin" | "revert" | "sync",
  ): Promise<void> => {
    setPendingId(referenceId);
    try {
      if (action === "pin") {
        await floatToHead({ mode: "pin", referenceId });
        toast.success("Pinned to the current head.");
      } else if (action === "sync") {
        await syncRef({ referenceId });
        toast.success("Repinned to the current head.");
      } else {
        await revertRef({ referenceId });
        toast.success("Repinned to the prior version.");
      }
    } catch (error) {
      toast.error(
        errorMessage(error, action === "revert" ? "Failed to revert." : "Failed to sync."),
      );
    } finally {
      setPendingId(undefined);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Consumed by ({consumedBy === undefined ? "…" : consumers.length})
        </CardTitle>
        <CardDescription>
          Datasets that reference this one, and whether each is pinned to an exact version or floats
          on the chain head.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {consumedBy === undefined ? null : consumers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing consumes this dataset yet. This list knows transform-spec consumers — maps and
            collections reference datasets but hold no version reference.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {consumers.map((consumer) => (
              <li
                key={consumer.consumerId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{consumer.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    transform spec · {consumer.mode === "pin" ? "pinned" : "floats on head"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {consumer.changed && (
                    <Badge
                      variant="destructive"
                      title="A new version of this dataset awaits this consumer."
                    >
                      changed
                    </Badge>
                  )}
                  {consumer.referenceId !== undefined && consumer.mode === "float" && (
                    <Button
                      disabled={pendingId !== undefined}
                      onClick={() => {
                        void runReferenceAction(consumer.referenceId ?? "", "pin");
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <Pin className="h-3.5 w-3.5" />
                      {pendingId === consumer.referenceId ? "Pinning…" : "Pin to head"}
                    </Button>
                  )}
                  {consumer.referenceId !== undefined && consumer.mode === "pin" && (
                    <>
                      <Button
                        disabled={pendingId !== undefined}
                        onClick={() => {
                          void runReferenceAction(consumer.referenceId ?? "", "sync");
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {pendingId === consumer.referenceId ? "Syncing…" : "Sync to head"}
                      </Button>
                      {/* Revert (lifecycle §7): repin to the PRIOR version —
                          the append-only chain keeps both; only the reference
                          moves back. Errors honestly at the first version. */}
                      <Button
                        disabled={pendingId !== undefined}
                        onClick={() => {
                          void runReferenceAction(consumer.referenceId ?? "", "revert");
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        <History className="h-3.5 w-3.5" />
                        {pendingId === consumer.referenceId ? "Reverting…" : "Revert"}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The publish-chain Versions card: the same keep-N-with-pinning + pairwise
 * compare the bound-dataset VersionsCard offers, keyed by the chain anchor
 * (a draft's component id or a derived dataset's registry id) so published
 * chains get the retention UI their completion hook enforces.
 */
// oxlint-disable-next-line eslint/complexity -- the VersionsCard sibling carries the same shape (dataset-overview.tsx); splitting the card would scatter the keep/pin/retire wiring.
export function ChainVersionsCard({ anchorId }: { anchorId: string }) {
  const versions = useQuery({ ...convexQuery(api.consumption.chainVersions, { anchorId }) }).data,
    retention = useQuery({ ...convexQuery(api.consumption.retentionPolicy, { anchorId }) }).data,
    setKeep = useMutation(api.consumption.setChainKeep),
    setPinned = useMutation(api.consumption.setChainVersionPinned),
    retire = useMutation(api.tags.retireVersion),
    [keepInput, setKeepInput] = useState<string>(),
    [compareOpen, setCompareOpen] = useState<string | undefined>(),
    [retireTarget, setRetireTarget] = useState<ChainVersionRow>(),
    [isRetiring, setIsRetiring] = useState(false),
    [pendingPinId, setPendingPinId] = useState<string>(),
    handleRetire = async () => {
      const target = retireTarget;
      if (target === undefined) {
        return;
      }
      setIsRetiring(true);
      try {
        await retire({ schemaId: target.schemaId });
        toast.success(`Retired "${target.title}".`);
        setRetireTarget(undefined);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to retire version."));
      } finally {
        setIsRetiring(false);
      }
    },
    handlePinToggle = async (schemaId: string, pinned: boolean) => {
      setPendingPinId(schemaId);
      try {
        await setPinned({ pinned, schemaId });
        toast.success(
          pinned ? "Pinned — never auto-retired." : "Unpinned — retention may retire it.",
        );
      } catch (error) {
        toast.error(errorMessage(error, "Failed to update pin."));
      } finally {
        setPendingPinId(undefined);
      }
    };
  const handleKeepSave = async () => {
    const keep = Number(keepInput);
    if (!Number.isInteger(keep) || keep < 1) {
      toast.error("Keep must be a positive whole number.");
      return;
    }
    try {
      await setKeep({ anchorId, keep });
      toast.success(`Keeping the newest ${keep} unpinned versions.`);
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Failed to set retention."));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5" />
          Versions ({versions === undefined ? "…" : versions.length})
        </CardTitle>
        <CardDescription>
          This dataset's version chain — one immutable frozen row per publish. Unpinned versions
          beyond the keep count retire automatically at the next publish; pinned ones never do.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {retention !== undefined && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Keep newest</span>
            <Input
              className="h-8 w-20"
              inputMode="numeric"
              value={keepInput ?? String(retention.keepVersions)}
              onChange={(event) => {
                setKeepInput(event.target.value);
              }}
            />
            <span className="text-muted-foreground">unpinned versions</span>
            <Button
              disabled={keepInput === undefined || keepInput === String(retention.keepVersions)}
              onClick={() => {
                void handleKeepSave();
              }}
              size="sm"
              variant="outline"
            >
              Save
            </Button>
          </div>
        )}
        {versions !== undefined && versions.length > 1 && (
          <div>
            <Button
              onClick={() => {
                setCompareOpen(compareOpen === undefined ? "compare" : undefined);
              }}
              size="sm"
              variant="outline"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              {compareOpen === undefined ? "Compare versions" : "Hide compare"}
            </Button>
            {compareOpen !== undefined && (
              <div className="mt-2">
                <VersionCompare
                  versions={versions.map((version) => ({
                    label: version.versionLabel,
                    schemaId: version.schemaId,
                    title: version.title,
                  }))}
                />
              </div>
            )}
          </div>
        )}
        {versions === undefined ? null : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions on this chain yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {versions.map((version) => {
              const isPinned =
                version.snapshotRef !== undefined &&
                retention !== undefined &&
                retention.pinnedRefs.includes(version.snapshotRef);
              return (
                <li
                  key={version.schemaId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{version.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {version.entryCount === undefined ? "" : `${version.entryCount} entries · `}
                      frozen {new Date(version.frozenAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Badge variant="outline">
                      <Tag />
                      {version.versionLabel}
                    </Badge>
                    {isPinned && (
                      <Badge variant="secondary">
                        <Pin />
                        Pinned
                      </Badge>
                    )}
                    <Button
                      aria-label={isPinned ? `Unpin ${version.title}` : `Pin ${version.title}`}
                      disabled={version.snapshotRef === undefined || pendingPinId !== undefined}
                      onClick={() => {
                        void handlePinToggle(version.schemaId, !isPinned);
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <Pin className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      aria-label={`Retire ${version.title}`}
                      onClick={() => {
                        setRetireTarget(version);
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <ConfirmDeleteDialog
          confirmLabel="Retire version"
          title={`Retire "${retireTarget === undefined ? "" : retireTarget.title}"?`}
          entityLabel="frozen version"
          description="Retiring deletes this frozen copy — its rows, geometries, and map archive. The catalog stays append-only: nothing rewrites the other versions."
          isPending={isRetiring}
          name={retireTarget === undefined ? undefined : retireTarget.title}
          onCancel={() => {
            setRetireTarget(undefined);
          }}
          onConfirm={() => {
            void handleRetire();
          }}
        />
      </CardContent>
    </Card>
  );
}
