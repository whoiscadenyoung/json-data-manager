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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompareArrows, History, Link2, Pin, RefreshCw, Tag, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { errorMessage } from "@/lib/errors";
import * as tagsStore from "@/lib/store/tags";
import {
  consumedByQueryOptions,
  listVersionsQueryOptions,
  retentionPolicyQueryOptions,
  revertReference,
  setKeepVersions,
  setReferenceMode,
  syncReference,
  versionDeltaQueryOptions,
  type ConsumerReferenceRow,
  type DatasetVersionRow,
  type VersionDelta,
} from "@/lib/store/versions";
import type { VersionRow } from "@/lib/version-rows";

import { headVersionOf, overlayRowsQueryOptions, priorVersionOf } from "../lib/pg-versioning";
import { VersionCompare } from "./version-compare";

/**
 * The Postgres dataset page's versioning surfaces (stage 4, #203) — the
 * Convex-era Overview cards' PG edition, over the versions/tags stores:
 *
 * - `PgVersionsCard`: the version chain (one immutable frozen row per
 *   publish), tag management (a tag names one exact version — the pin),
 *   keep-N retention (the store's set-and-enforce pass), and the pairwise
 *   compare fed by the store's delta query + the overlay's bounded position
 *   reads.
 * - `PgConsumersCard`: the consumed-by list with pin/float, sync-to-head,
 *   and revert (repin to the prior version — explained honestly at the
 *   first version instead of a silent no-op).
 *
 * Versions themselves have no client delete — frozen rows are immutable by
 * construction (no grants, ADR 0009), so the manual retire action targets
 * TAGS, and its #126 refusal (a consumer still pins the version) surfaces
 * the database's refusal message verbatim. Write denials that move zero
 * rows surface honestly (the stores' rows-affected returns), never as a
 * success toast.
 */

/** The consumer-kind labels, in plain language (the ui-polish rule). */
const CONSUMER_KIND_LABELS = {
  derived: "Transform spec",
  fork: "Fork",
  map: "Map layer",
} as const;

/** Tags grouped per version id, oldest first within a version — built mutation-free from pairs. */
function groupTagsByVersion(tags: tagsStore.TagRow[]): globalThis.Map<string, tagsStore.TagRow[]> {
  const pairs = [...tags].reverse().map((tag) => [tag.versionId, tag] as const);
  const grouped = new globalThis.Map<string, tagsStore.TagRow[]>();
  for (const [versionId, tag] of pairs) {
    const existing = grouped.get(versionId);
    grouped.set(versionId, existing === undefined ? [tag] : [...existing, tag]);
  }
  return grouped;
}

/** One version's tag chips: live tags plain, retired ones marked (honest history, no vanishing). */
function VersionTagChips({ tags }: { tags: tagsStore.TagRow[] | undefined }) {
  if (tags === undefined || tags.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) =>
        tag.retiredAt === null ? (
          <Badge key={tag.id} variant="outline">
            <Tag className="h-3 w-3" />
            {tag.name}
          </Badge>
        ) : (
          <Badge key={tag.id} title="Retired — kept in the tag history." variant="secondary">
            <Tag className="h-3 w-3" />
            {tag.name} (retired)
          </Badge>
        ),
      )}
    </div>
  );
}

/** The inline "name this version's tag" form — the required name explains itself while empty (never a silently disabled save). */
function TagCreateForm({
  onCreate,
  suggestedName,
}: {
  onCreate: (name: string) => Promise<void>;
  suggestedName: string;
}) {
  const [name, setName] = useState(""),
    [submitting, setSubmitting] = useState(false),
    nameEmpty = name.trim() === "",
    submit = async (): Promise<void> => {
      if (nameEmpty) {
        toast.error("Give the tag a name.");
        return;
      }
      setSubmitting(true);
      try {
        await onCreate(name.trim());
        setName("");
      } finally {
        setSubmitting(false);
      }
    };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        aria-invalid={nameEmpty}
        aria-label="Tag name"
        className="h-8 w-44"
        onChange={(event) => {
          setName(event.target.value);
        }}
        placeholder={suggestedName}
        value={name}
      />
      {nameEmpty && (
        <span className="text-xs font-medium text-destructive">A name is required.</span>
      )}
      <Button
        disabled={submitting}
        onClick={() => {
          void submit();
        }}
        size="sm"
        variant="outline"
      >
        <Tag className="h-3.5 w-3.5" />
        {submitting ? "Tagging…" : "Tag this version"}
      </Button>
    </div>
  );
}

/**
 * The compare's data feed (the PG "diff view inputs"): the store's delta
 * query (one delta definition — the store's, bounded with the exact
 * #126 truncation flag) plus the overlay's bounded position reads per side,
 * feeding the shared VersionCompare through its controlled-pair props.
 * Success IS complete for these single-shot reads — never an isLoading gate.
 */
function PgVersionCompareLoader({
  datasetTitle,
  versions,
}: {
  datasetTitle: string;
  versions: DatasetVersionRow[];
}) {
  const newest = versions.at(0),
    oldest = versions.at(1) ?? newest,
    [aId, setAId] = useState<string | undefined>(oldest === undefined ? undefined : oldest.id),
    [bId, setBId] = useState<string | undefined>(newest === undefined ? undefined : newest.id),
    selected = aId !== undefined && bId !== undefined,
    deltaQuery = useQuery({
      ...versionDeltaQueryOptions({
        aVersionId: aId ?? "",
        bVersionId: bId ?? "",
      }),
      enabled: selected,
    }),
    aRowsQuery = useQuery({
      ...overlayRowsQueryOptions({ versionId: aId ?? "" }),
      enabled: aId !== undefined,
    }),
    bRowsQuery = useQuery({
      ...overlayRowsQueryOptions({ versionId: bId ?? "" }),
      enabled: bId !== undefined,
    }),
    aRows = aRowsQuery.data,
    bRows = bRowsQuery.data,
    deltaData = deltaQuery.data,
    complete =
      selected &&
      deltaQuery.isSuccess &&
      aRowsQuery.isSuccess &&
      bRowsQuery.isSuccess &&
      deltaData !== undefined &&
      aRows !== undefined &&
      bRows !== undefined,
    delta: VersionDelta | undefined = complete ? deltaData : undefined,
    rowsById = new globalThis.Map<string, VersionRow[]>(
      complete && aId !== undefined && bId !== undefined
        ? [
            [aId, aRows.rows],
            [bId, bRows.rows],
          ]
        : [],
    );
  return (
    <VersionCompare
      delta={complete ? delta : "pending"}
      onPairChange={(pair) => {
        setAId(pair.aSchemaId);
        setBId(pair.bSchemaId);
      }}
      pair={{ aSchemaId: aId, bSchemaId: bId }}
      rows={rowsById}
      versions={versions.map((version) => ({
        label: version.versionLabel,
        schemaId: version.id,
        title: datasetTitle,
      }))}
    />
  );
}

/** One chain row: label, ref, frozen date, its tags, the tag-create form, and the retire confirm per live tag. */
function PgVersionRowItem({
  datasetId,
  tagList,
  version,
}: {
  datasetId: string;
  tagList: tagsStore.TagRow[] | undefined;
  version: DatasetVersionRow;
}) {
  const queryClient = useQueryClient(),
    [tagFormOpen, setTagFormOpen] = useState(false),
    [retireTarget, setRetireTarget] = useState<tagsStore.TagRow | undefined>(undefined),
    [isRetiring, setIsRetiring] = useState(false),
    invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:tags"] });
    },
    liveTags = (tagList ?? []).filter((tag) => tag.retiredAt === null),
    handleCreateTag = async (name: string): Promise<void> => {
      try {
        await tagsStore.create({ datasetId, name, versionId: version.id });
        invalidate();
        toast.success(`Tagged ${version.versionLabel} as "${name}".`);
        setTagFormOpen(false);
      } catch (error) {
        // A duplicate (dataset, name) rides the 23505 constraint's message —
        // shown verbatim.
        toast.error(errorMessage(error, "Failed to create the tag."));
      }
    },
    handleRetire = async (): Promise<void> => {
      const target = retireTarget;
      if (target === undefined) {
        return;
      }
      setIsRetiring(true);
      try {
        const retired = await tagsStore.retire({ tagId: target.id });
        if (retired === 0) {
          toast.error("The tag wasn't found — it may already be retired.");
        } else {
          toast.success(`Retired tag "${target.name}".`);
        }
        setRetireTarget(undefined);
        invalidate();
      } catch (error) {
        // The #126 refusal rides here: the guard trigger's message, shown
        // verbatim — never softened into a generic failure.
        toast.error(errorMessage(error, "Failed to retire the tag."));
      } finally {
        setIsRetiring(false);
      }
    };
  return (
    <li className="flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="outline">
            <Tag className="h-3 w-3" />
            {version.versionLabel}
          </Badge>
          <span className="truncate font-mono text-xs text-muted-foreground" title={version.ref}>
            {version.ref}
          </span>
          <span className="text-xs text-muted-foreground">
            frozen {new Date(version.createdAt).toLocaleString()}
          </span>
        </div>
        <Button
          onClick={() => {
            setTagFormOpen((open) => !open);
          }}
          size="sm"
          variant="ghost"
        >
          <Tag className="h-3.5 w-3.5" />
          Tag
        </Button>
      </div>
      <VersionTagChips tags={tagList} />
      {tagFormOpen && (
        <TagCreateForm
          suggestedName={version.versionLabel}
          onCreate={async (name) => {
            await handleCreateTag(name);
          }}
        />
      )}
      {liveTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {liveTags.map((tag) => (
            <Button
              aria-label={`Retire tag ${tag.name}`}
              key={tag.id}
              onClick={() => {
                setRetireTarget(tag);
              }}
              size="sm"
              variant="ghost"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Retire "{tag.name}"
            </Button>
          ))}
        </div>
      )}
      <ConfirmDeleteDialog
        confirmLabel="Retire tag"
        description="Retiring this named pin marks it retired in the tag history. It is refused while a consumer still pins this exact version — a consumer's explicit choice of one version is never silently moved (#126)."
        entityLabel="tag"
        isPending={isRetiring}
        name={retireTarget === undefined ? undefined : retireTarget.name}
        onCancel={() => {
          setRetireTarget(undefined);
        }}
        onConfirm={() => {
          void handleRetire();
        }}
        title={`Retire tag "${retireTarget === undefined ? "" : retireTarget.name}"?`}
      />
    </li>
  );
}

/**
 * The publish-chain Versions card for a Postgres dataset: the immutable
 * chain, tag management (create/retire with the #126 refusal surfaced
 * verbatim), keep-N retention (the store's set-and-enforce pass), and the
 * pairwise compare.
 */
export function PgVersionsCard({
  datasetId,
  datasetTitle,
}: {
  datasetId: string;
  datasetTitle: string;
}) {
  const queryClient = useQueryClient(),
    versionsQuery = useQuery(listVersionsQueryOptions({ datasetId })),
    tagsQuery = useQuery(tagsStore.listQueryOptions({ datasetId })),
    retentionQuery = useQuery(retentionPolicyQueryOptions({ datasetKey: datasetId })),
    versions = versionsQuery.data,
    tags = tagsQuery.data,
    retention = retentionQuery.data,
    tagsByVersion = groupTagsByVersion(tags ?? []),
    [keepInput, setKeepInput] = useState<string>(),
    [compareOpen, setCompareOpen] = useState(false),
    handleKeepSave = async (): Promise<void> => {
      const keep = Number(keepInput);
      if (!Number.isInteger(keep) || keep < 1) {
        toast.error("Keep must be a positive whole number.");
        return;
      }
      try {
        const retired = await setKeepVersions({ datasetKey: datasetId, keep });
        void queryClient.invalidateQueries({ queryKey: ["pg:versions"] });
        toast.success(
          retired > 0
            ? `Keeping the newest ${keep} versions — ${retired} past it retired now.`
            : `Keeping the newest ${keep} versions.`,
        );
      } catch (error) {
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
          One immutable frozen copy per publish — publishing never rewrites an earlier version. Tag
          a version to pin it by name; retiring a tag is refused while a consumer still pins that
          exact version.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {versionsQuery.isError && (
          <p className="text-sm text-destructive">
            {errorMessage(versionsQuery.error, "Couldn't load the version history.")}
          </p>
        )}
        {retention !== undefined && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Keep newest</span>
            <Input
              className="h-8 w-20"
              inputMode="numeric"
              onChange={(event) => {
                setKeepInput(event.target.value);
              }}
              value={keepInput ?? String(retention.keepVersions)}
            />
            <span className="text-muted-foreground">versions in retention</span>
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
                setCompareOpen((open) => !open);
              }}
              size="sm"
              variant="outline"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              {compareOpen ? "Hide compare" : "Compare versions"}
            </Button>
            {compareOpen && (
              <div className="mt-2">
                <PgVersionCompareLoader datasetTitle={datasetTitle} versions={versions} />
              </div>
            )}
          </div>
        )}
        {versions === undefined ? (
          <p className="text-sm text-muted-foreground">Loading versions…</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet — "Publish version" freezes the current rows as the first one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {versions.map((version) => (
              <PgVersionRowItem
                datasetId={datasetId}
                key={version.id}
                tagList={tagsByVersion.get(version.id)}
                version={version}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** One consumed-by row: who consumes, float/pin state, and the pin/sync/revert actions. */
function PgConsumerRowItem({
  consumer,
  versions,
}: {
  consumer: ConsumerReferenceRow;
  versions: DatasetVersionRow[] | undefined;
}) {
  const head = versions === undefined ? undefined : headVersionOf(versions),
    pinnedVersionId = consumer.pinnedVersionId,
    changed =
      consumer.mode === "pin" &&
      pinnedVersionId !== null &&
      head !== undefined &&
      head.id !== pinnedVersionId,
    prior =
      consumer.mode === "pin" && pinnedVersionId !== null && versions !== undefined
        ? priorVersionOf(versions, pinnedVersionId)
        : undefined,
    [pendingAction, setPendingAction] = useState<string>(),
    run = async (
      action: "pin" | "revert" | "sync",
      write: () => Promise<number>,
      success: string,
    ): Promise<void> => {
      setPendingAction(action);
      try {
        const affected = await write();
        if (affected === 0) {
          toast.error("The reference didn't move — you may not have access.");
          return;
        }
        toast.success(success);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to update the reference."));
      } finally {
        setPendingAction(undefined);
      }
    },
    pinOrSync = (action: "pin" | "sync", success: string): (() => void) | undefined => {
      if (head === undefined) {
        return undefined;
      }
      return () => {
        void run(
          action,
          async () => {
            if (action === "pin") {
              return await setReferenceMode({
                mode: "pin",
                pinnedRef: head.ref,
                pinnedVersionId: head.id,
                referenceId: consumer.id,
              });
            }
            const outcome = await syncReference({ referenceId: consumer.id });
            return outcome.affected;
          },
          success,
        );
      };
    },
    pinToHead = pinOrSync("pin", "Pinned to the current head."),
    syncToHead = pinOrSync("sync", "Repinned to the current head."),
    revert =
      prior === undefined
        ? undefined
        : (): void => {
            void run(
              "revert",
              async () => {
                return await revertReference({ referenceId: consumer.id, toRef: prior.ref });
              },
              `Repinned to ${prior.versionLabel}.`,
            );
          };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{consumer.consumerId}</p>
        <p className="truncate text-xs text-muted-foreground">
          {CONSUMER_KIND_LABELS[consumer.consumerKind]} ·{" "}
          {consumer.mode === "pin"
            ? `pinned to ${consumer.pinnedRef ?? "an exact version"}`
            : "floats on head"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {changed && (
          <Badge title="A new version of this dataset awaits this consumer." variant="destructive">
            changed
          </Badge>
        )}
        {consumer.mode === "float" &&
          (pinToHead === undefined ? (
            <span
              className="text-xs text-muted-foreground"
              title="No published version to pin to yet."
            >
              Pin to head
            </span>
          ) : (
            <Button
              disabled={pendingAction !== undefined}
              onClick={pinToHead}
              size="sm"
              variant="ghost"
            >
              <Pin className="h-3.5 w-3.5" />
              {pendingAction === "pin" ? "Pinning…" : "Pin to head"}
            </Button>
          ))}
        {consumer.mode === "pin" && (
          <>
            {syncToHead !== undefined && (
              <Button
                disabled={pendingAction !== undefined}
                onClick={syncToHead}
                size="sm"
                variant="ghost"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {pendingAction === "sync" ? "Syncing…" : "Sync to head"}
              </Button>
            )}
            {/* Revert (lifecycle §7): repin to the PRIOR version — the
                append-only chain keeps both; only the reference moves back.
                At the first version the action explains itself instead of
                sitting disabled. */}
            {revert !== undefined ? (
              <Button
                disabled={pendingAction !== undefined}
                onClick={revert}
                size="sm"
                variant="ghost"
              >
                <History className="h-3.5 w-3.5" />
                {pendingAction === "revert" ? "Reverting…" : "Revert"}
              </Button>
            ) : (
              <span
                className="text-xs text-muted-foreground"
                title="Already at the first version — nothing older to revert to."
              >
                Revert
              </span>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** The consumed-by list for a Postgres dataset (lifecycle §7): every consumer reference with its pin/float state and the sync/revert actions. */
export function PgConsumersCard({ datasetId }: { datasetId: string }) {
  const consumersQuery = useQuery(consumedByQueryOptions({ sourceDatasetId: datasetId })),
    versionsQuery = useQuery(listVersionsQueryOptions({ datasetId })),
    consumers = consumersQuery.data,
    versions = versionsQuery.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Consumed by ({consumers === undefined ? "…" : consumers.length})
        </CardTitle>
        <CardDescription>
          Consumers that reference this dataset, and whether each is pinned to an exact version or
          floats on the chain head. Adding a dataset to a project or a map's layer mints its
          reference; publishing a new version marks pinned consumers "changed" until they sync.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {consumers === undefined ? (
          <p className="text-sm text-muted-foreground">Loading consumers…</p>
        ) : consumers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Link2 className="mr-1 inline h-3.5 w-3.5" />
            Nothing consumes this dataset yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {consumers.map((consumer) => (
              <PgConsumerRowItem consumer={consumer} key={consumer.id} versions={versions} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
