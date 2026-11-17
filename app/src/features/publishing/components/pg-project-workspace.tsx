import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpCircle,
  ArrowUpRight,
  Database,
  FilePlus2,
  GitBranch,
  History,
  LayoutDashboard,
  Link2,
  Map as MapIcon,
  Loader2,
  Plus,
  Rocket,
  Search,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";

import { PgDatasetTagsWithCount } from "#/features/catalog";
import { RouterButton } from "@/components/router-button";
import { errorMessage } from "@/lib/errors";
import * as appsStore from "@/lib/store/apps";
import * as datasetsStore from "@/lib/store/datasets";
import * as mapsStore from "@/lib/store/maps";
import { ROLE_LABELS } from "@/lib/store/project-members";
import * as projectsStore from "@/lib/store/projects";
import type { CatalogRow } from "@/lib/store/projects";
import { latestBundleQueryOptions, listMembersQueryOptions } from "@/lib/store/publishing";
import * as versionsStore from "@/lib/store/versions";

import { VIEWER_REASON } from "../lib/pg-viewer-posture";
import { useProjectShell } from "./pg-project-context";
import { PgProjectMembersPanel } from "./pg-project-members-dialog";

/**
 * The Postgres project workspace — the project CATALOG (issue #256, the
 * project-centric train's phase 2; ADR 0018). Datasets enter the project as
 * OWNED references (created in-project — an owned draft bound to the
 * workspace) or LINKED references (added from the global catalog; a pin at
 * the chain head, never a copy), and every row renders its provenance:
 * owned / linked, and for linked rows the live pin state — pinned (with an
 * "update available" badge once the source republishes past the pin) or
 * floating — with per-member sync/revert/float actions over the existing
 * `consumer_references` machinery (0009).
 *
 * Access is the membership row (owner manages, editor works, viewer reads —
 * ADR 0017): the header badges the seat's role, the Members dialog handles
 * invites/roles/removal, and a viewer's write controls render disabled with
 * the reason. A non-member's project reads exactly as a missing one, and
 * this page renders the same not-found card for both. Map/app artifacts
 * arrive with their phases ([project 3]/[project 5]) — the catalog holds
 * datasets and views (a view is a dataset whose rows come from its steps, #301).
 */

/** The stale-press window (the syncRuns/publishAttempts value): a press whose checkpoint hasn't moved this long was abandoned by its browser, and pressing again RESUMES it (joining the running bundle). */
const STALE_PRESS_MS = 2 * 60 * 1000;

/** The not-found card — a foreign project (no membership row) reads exactly as a missing one. */
export function PgProjectNotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Database />
          </EmptyMedia>
          <EmptyTitle>Project not found</EmptyTitle>
          <EmptyDescription>
            It may have been deleted — or it belongs to another user.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/projects">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Projects
          </RouterButton>
        </EmptyContent>
      </Empty>
    </main>
  );
}

/** The signed-out gate (projects are membership-gated — the auth-gated stage). */
export function PgProjectSignInPrompt() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Database />
          </EmptyMedia>
          <EmptyTitle>Sign in to continue</EmptyTitle>
          <EmptyDescription>
            Projects are membership workspaces — sign in to see yours.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/signin">Sign in</RouterButton>
        </EmptyContent>
      </Empty>
    </main>
  );
}

/** The provenance chip row: owned/linked first, then the linked pin state, then the draft badge for owned drafts (an owned draft is project-visible, not creator-visible only — ADR 0018). */
export function PgProvenanceChips({ draft, row }: { draft: boolean; row: CatalogRow }) {
  const { artifact, edge } = row;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {artifact.role === "owned" ? (
        <Badge
          title="Created in this project — an owned reference, visible to the project's members."
          variant="secondary"
        >
          <FilePlus2 className="h-3 w-3" />
          Owned
        </Badge>
      ) : (
        <Badge title="Added from the catalog by reference — a pin at its chain head, never a copy (D1).">
          <Link2 className="h-3 w-3" />
          Linked
        </Badge>
      )}
      {edge !== null && edge.mode === "pin" ? (
        <Badge
          variant="outline"
          title={`Pinned to the frozen version ${edge.pinnedRef ?? ""} — it moves only when a member syncs.`}
        >
          <GitBranch className="h-3 w-3" />
          Pinned{edge.pinnedRef === null ? "" : ` · ${edge.pinnedRef}`}
        </Badge>
      ) : edge !== null ? (
        <Badge
          variant="outline"
          title="Floats on the source's chain head — every republish flows in automatically (sync_mode auto)."
        >
          <ArrowUpRight className="h-3 w-3" />
          Floating
        </Badge>
      ) : null}
      {draft && (
        <Badge
          title="A draft — visible to this project's members, hidden from the global catalog until it publishes (ADR 0018)."
          variant="secondary"
        >
          Draft
        </Badge>
      )}
    </div>
  );
}

/** The linked row's version actions: sync-to-head when the source moved, float/pin flips, and revert-to-an-earlier-version (versions load when the menu opens). */
// The per-state action ladder (the sync badge's branch, the pinned-branch
// actions, the float-branch action, each with its pending spinner) is the
// row's whole control set, read top to bottom; splitting it would scatter
// one control set across components with no reuse.
// oxlint-disable-next-line eslint/complexity -- the action ladder is the control set, stated once.
export function PgLinkedVersionActions({
  onDone,
  projectId,
  row,
}: {
  onDone: () => void;
  projectId: string;
  row: CatalogRow;
}) {
  const { edge } = row;
  const [pending, setPending] = useState<string>(),
    [revertOpen, setRevertOpen] = useState(false),
    versionsQuery = useQuery({
      ...versionsStore.listVersionsQueryOptions({ datasetId: row.artifact.artifactId }),
      enabled: revertOpen,
    }),
    headVersions = versionsQuery.data,
    pinnedRef = edge === null ? null : edge.pinnedRef,
    revertCandidates =
      headVersions === undefined ? [] : headVersions.filter((version) => version.ref !== pinnedRef),
    run = async (action: string, write: () => Promise<number>, success: string): Promise<void> => {
      setPending(action);
      try {
        const affected = await write();
        if (affected === 0) {
          toast.error("The reference didn't move — you may not have access.");
          return;
        }
        toast.success(success);
        onDone();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to update the reference."));
      } finally {
        setPending(undefined);
      }
    },
    sync = (): void => {
      if (edge === null) {
        return;
      }
      void run(
        "sync",
        async () => {
          const outcome = await versionsStore.syncReference({ referenceId: edge.id });
          return outcome.affected;
        },
        "Repinned to the source's current head.",
      );
    },
    float = (): void => {
      void run(
        "float",
        async () => {
          const outcome = await projectsStore.setSyncMode({
            membershipId: row.artifact.id,
            mode: "auto",
            projectId,
          });
          return outcome.affected;
        },
        "The reference now floats on the source's head.",
      );
    },
    pin = (): void => {
      void run(
        "pin",
        async () => {
          const outcome = await projectsStore.setSyncMode({
            membershipId: row.artifact.id,
            mode: "manual",
            projectId,
          });
          return outcome.pinnedRef === null ? 0 : outcome.affected;
        },
        "Pinned to the current head.",
      );
    },
    revert = (ref: string, label: string): void => {
      if (edge === null) {
        return;
      }
      void run(
        "revert",
        async () => {
          return await versionsStore.revertReference({ referenceId: edge.id, toRef: ref });
        },
        `Repinned to ${label}.`,
      );
    };
  if (edge === null) {
    return null;
  }
  const disabled = pending !== undefined;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {row.updateAvailable && (
        <Button
          disabled={disabled}
          onClick={sync}
          size="sm"
          title={`The source republished past ${pinnedRef ?? "the pin"} — advance to ${row.head === null ? "the head" : row.head.ref}.`}
          variant="default"
        >
          {pending === "sync" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUpCircle className="h-3.5 w-3.5" />
          )}
          Sync
        </Button>
      )}
      {edge.mode === "pin" ? (
        <>
          <DropdownMenu onOpenChange={setRevertOpen} open={revertOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="Revert to an earlier version"
                  disabled={disabled}
                  size="sm"
                  title="Repin to an earlier frozen version"
                  variant="outline"
                />
              }
            >
              {pending === "revert" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <History className="h-3.5 w-3.5" />
              )}
              Revert
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              <DropdownMenuLabel>Repin to</DropdownMenuLabel>
              {headVersions === undefined ? (
                <DropdownMenuItem disabled>Loading versions…</DropdownMenuItem>
              ) : revertCandidates.length === 0 ? (
                <DropdownMenuItem disabled>No other version to revert to.</DropdownMenuItem>
              ) : (
                revertCandidates.map((version) => (
                  <DropdownMenuItem
                    key={version.id}
                    onClick={() => {
                      revert(version.ref, version.versionLabel);
                    }}
                  >
                    {version.versionLabel}
                    {row.head !== null && version.ref === row.head.ref ? " (current head)" : ""}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            disabled={disabled}
            onClick={float}
            size="sm"
            title="Float on the source's head — every republish flows in automatically (sync_mode auto)."
            variant="ghost"
          >
            {pending === "float" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5" />
            )}
            Float
          </Button>
        </>
      ) : (
        <Button
          disabled={disabled}
          onClick={pin}
          size="sm"
          title="Pin at the current head — it moves only when a member syncs (sync_mode manual)."
          variant="ghost"
        >
          {pending === "pin" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitBranch className="h-3.5 w-3.5" />
          )}
          Pin
        </Button>
      )}
    </div>
  );
}

/** One searchable candidate row (dataset or derived) in the add sheet. */
function PgAddCandidateRow({
  disabled,
  hint,
  onPick,
  title,
}: {
  disabled: boolean;
  hint: string | null;
  onPick: () => void;
  title: string;
}) {
  return (
    <button
      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
      disabled={disabled}
      onClick={onPick}
      type="button"
    >
      <span className="text-sm font-medium">{title}</span>
      {hint !== null && hint !== "" && (
        <span className="line-clamp-1 text-xs text-muted-foreground">{hint}</span>
      )}
    </button>
  );
}

/** The add-existing sheet — the D1 picker over the GLOBAL catalog (every visible dataset is addable, incl. from other projects): published datasets (views included), already-added ids excluded. Each add lands as a linked reference; the sheet's sync toggle picks its follow intent (pin at head / float). */
export function PgAddReferenceSheet({
  addedDatasetIds,
  onAdded,
  onOpenChange,
  open,
  projectId,
}: {
  addedDatasetIds: Set<string>;
  onAdded: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  const [search, setSearch] = useState(""),
    [auto, setAuto] = useState(false),
    [pendingId, setPendingId] = useState<string>(),
    datasetsQuery = useQuery({ ...datasetsStore.listSummariesQueryOptions(), enabled: open }),
    normalized = search.trim().toLowerCase(),
    datasetCandidates = (datasetsQuery.data ?? [])
      .filter((dataset) => !addedDatasetIds.has(dataset.id))
      .filter((dataset) =>
        normalized === "" ? true : dataset.title.toLowerCase().includes(normalized),
      ),
    add = async (artifactId: string): Promise<void> => {
      setPendingId(artifactId);
      try {
        const outcome = await projectsStore.addArtifact({
          artifactId,
          artifactKind: "dataset",
          projectId,
          role: "linked",
          syncMode: auto ? "auto" : "manual",
        });
        if (outcome.artifact === null) {
          toast.error("The reference didn't land — you may not have access.");
          return;
        }
        toast.success(
          outcome.pinnedRef !== null
            ? `Added — pinned at ${outcome.pinnedRef}. The source republishing past it shows "update available".`
            : "Added — it floats on this dataset's chain (no frozen version to pin yet).",
        );
        onAdded();
        onOpenChange(false);
      } catch (error) {
        // A duplicate (project, kind, artifact) rides the 23505 constraint's
        // message — shown verbatim (the honest constraint).
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setPendingId(undefined);
      }
    };
  return (
    <Sheet
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to project</SheetTitle>
          <SheetDescription>
            Reference an existing artifact — nothing is copied, and the catalog stays untouched.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div className="text-sm">
              <p className="font-medium">Sync updates</p>
              <p className="text-xs text-muted-foreground">
                {auto
                  ? "References float — source republishes flow in automatically."
                  : "References pin at the current head — syncing stays explicit."}
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <input
                checked={auto}
                onChange={(event) => {
                  setAuto(event.target.checked);
                }}
                type="checkbox"
              />
              Auto
            </label>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder="Search datasets…"
              value={search}
            />
          </div>
          <section className="flex flex-col gap-1">
            <p className="text-sm font-semibold">Datasets</p>
            {datasetCandidates.length === 0 ? (
              <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
                {datasetsQuery.isPending ? "Loading datasets…" : "No datasets left to add."}
              </p>
            ) : (
              datasetCandidates.map((dataset) => (
                <div className="flex items-stretch gap-1" key={dataset.id}>
                  <PgAddCandidateRow
                    disabled={pendingId !== undefined}
                    hint={dataset.description}
                    onPick={() => {
                      void add(dataset.id);
                    }}
                    title={dataset.title}
                  />
                  <div className="flex shrink-0 flex-col justify-center">
                    <PgDatasetTagsWithCount dataset={dataset} />
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The workspace's bundle status line (the Convex page's shape): the live press, an interrupted one, the named failures, or the promoted collection link. Staleness reads the mount-time clock (react/purity) — the page remounts on return, which is exactly when an abandoned press should announce itself. */
// One status line announcing exactly one of the four press states — the
// branch per state IS the line's copy contract; extracting them would hide
// the mutually-exclusive states behind a table no other surface shares.
// oxlint-disable-next-line eslint/complexity -- the four states are the line's whole contract.
export function PgBundleStatusLine({ projectId }: { projectId: string }) {
  const latestQuery = useQuery(latestBundleQueryOptions({ projectId })),
    bundle = latestQuery.data,
    [now] = useState(() => Date.now()),
    membersQuery = useQuery({
      ...listMembersQueryOptions({
        bundleId: bundle === null || bundle === undefined ? "" : bundle.id,
      }),
      enabled: bundle !== null && bundle !== undefined && bundle.status === "failed",
    });
  if (latestQuery.isPending || bundle === null || bundle === undefined) {
    return null;
  }
  if (bundle.status === "running" && now - Date.parse(bundle.lastProgressAt) <= STALE_PRESS_MS) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Rocket className="h-3.5 w-3.5 animate-pulse text-primary" />
        Publishing bundle…
      </p>
    );
  }
  if (bundle.status === "running") {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        The last press looks interrupted — press publish to resume it where it stopped.
      </p>
    );
  }
  if (bundle.status === "failed") {
    const failed = (membersQuery.data ?? []).filter((member) => member.status === "failed");
    return (
      <div className="mt-1 flex flex-col">
        <p className="text-sm text-destructive">
          Last press failed — press publish again to retry.
        </p>
        <span className="mt-1 flex flex-col gap-0.5 text-xs text-destructive">
          {failed.map((member) => (
            <span className="truncate" key={member.id}>
              Failed: {member.datasetKey}
              {member.error === null ? "" : ` — ${member.error}`}
            </span>
          ))}
        </span>
      </div>
    );
  }
  return (
    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
      Published {new Date(bundle.finishedAt ?? bundle.startedAt).toLocaleDateString()}
      {bundle.collectionId !== null && (
        <>
          {" — "}
          <Link
            className="text-primary underline-offset-2 hover:underline"
            params={{ collectionId: bundle.collectionId }}
            to="/collections/$collectionId"
          >
            view the published collection
          </Link>
        </>
      )}
    </p>
  );
}

/** One Overview tile: what the section holds, how many, and the newest few by name. */
function OverviewTile({
  children,
  count,
  icon: Icon,
  label,
  note,
  recent,
}: {
  /** The link that opens the section. */
  children: ReactNode;
  count: number | undefined;
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** What to say when there are no recent rows to name. */
  note: string;
  recent: readonly { id: string; link: ReactNode }[];
}) {
  return (
    <Card className="gap-3 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {label}
          <span className="font-normal text-muted-foreground tabular-nums">
            {count === undefined ? "" : count.toLocaleString()}
          </span>
        </h2>
        {children}
      </div>
      {recent.length === 0 ? (
        <p className="text-sm text-muted-foreground">{count === undefined ? "Loading…" : note}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {recent.map((entry) => (
            <li className="truncate" key={entry.id}>
              {entry.link}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const TILE_LINK = "text-sm text-primary underline-offset-2 hover:underline",
  RECENT_LINK = "hover:underline",
  RECENT_COUNT = 3;

/** The newest few rows, most recently changed first. */
function newest<Row extends { updatedAt: string }>(rows: readonly Row[] | undefined): Row[] {
  return (rows ?? [])
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECENT_COUNT);
}

/** The Overview section: the project's facts, "start here" when the catalog is empty, then one tile per section. */
export function PgProjectOverview() {
  const { canEdit, catalog, myRole, project, projectId } = useProjectShell(),
    mapsQuery = useQuery(mapsStore.listForProjectQueryOptions({ projectId })),
    appsQuery = useQuery(appsStore.listForProjectQueryOptions({ projectId }));
  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      <h1 className="mb-1 text-2xl font-bold text-primary">{project.title}</h1>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <Badge title={`Your access to this project (${ROLE_LABELS[myRole]}).`} variant="outline">
          {ROLE_LABELS[myRole]}
        </Badge>
      </div>
      {project.description !== null && (
        <p className="mt-1 text-muted-foreground">{project.description}</p>
      )}
      <PgBundleStatusLine projectId={projectId} />
      {catalog.length === 0 && (
        <Card className="mt-6 gap-3 px-5 py-4">
          <h2 className="text-sm font-semibold">Start here</h2>
          <p className="text-sm text-muted-foreground">
            This project has no data yet. Create or import a dataset (it lands as an owned draft
            visible to the project), or add an existing one by reference — nothing is copied.
          </p>
          <div className="flex flex-wrap gap-2">
            <RouterButton params={{ projectId }} to="/projects/$projectId/create">
              <Plus className="mr-2 h-4 w-4" />
              Add dataset
            </RouterButton>
            <RouterButton
              params={{ projectId }}
              to="/projects/$projectId/catalog"
              variant="outline"
            >
              <Database className="mr-2 h-4 w-4" />
              Open catalog
            </RouterButton>
          </div>
          {canEdit ? null : <p className="text-xs text-muted-foreground">{VIEWER_REASON}</p>}
        </Card>
      )}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <OverviewTile
          count={catalog.length}
          icon={Database}
          label="Catalog"
          note={
            catalog.length === 0
              ? "No datasets or views yet."
              : "This project's datasets and views, in folders."
          }
          recent={[]}
        >
          <Link className={TILE_LINK} params={{ projectId }} to="/projects/$projectId/catalog">
            Open catalog
          </Link>
        </OverviewTile>
        <OverviewTile
          count={mapsQuery.data === undefined ? undefined : mapsQuery.data.length}
          icon={MapIcon}
          label="Maps"
          note="No maps yet."
          recent={newest(mapsQuery.data).map((map) => ({
            id: map.id,
            link: (
              <Link
                className={RECENT_LINK}
                params={{ mapId: map.id, projectId }}
                to="/projects/$projectId/maps/$mapId"
              >
                {map.name}
              </Link>
            ),
          }))}
        >
          <Link className={TILE_LINK} params={{ projectId }} to="/projects/$projectId/maps">
            All maps
          </Link>
        </OverviewTile>
        <OverviewTile
          count={appsQuery.data === undefined ? undefined : appsQuery.data.length}
          icon={LayoutDashboard}
          label="Apps"
          note="No apps yet."
          recent={newest(appsQuery.data).map((app) => ({
            id: app.id,
            link: (
              <Link
                className={RECENT_LINK}
                params={{ appId: app.id, projectId }}
                to="/projects/$projectId/apps/$appId/edit"
              >
                {app.title}
              </Link>
            ),
          }))}
        >
          <Link className={TILE_LINK} params={{ projectId }} to="/projects/$projectId/apps">
            All apps
          </Link>
        </OverviewTile>
      </div>
    </main>
  );
}

/** The Project → Publish section: bundle status and the press. */
export function PgProjectPublish() {
  const { canEdit, catalog, openPress, pressing, projectId } = useProjectShell();
  return (
    <main className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="mb-1 text-2xl font-bold text-primary">Publish</h1>
      <p className="text-sm text-muted-foreground">
        Publishing materialises this project's datasets into the global catalog as one bundle
        collection.
      </p>
      <PgBundleStatusLine projectId={projectId} />
      <Button
        className="mt-4"
        disabled={pressing || catalog.length === 0 || !canEdit}
        onClick={openPress}
        title={
          !canEdit
            ? VIEWER_REASON
            : catalog.length === 0
              ? "Nothing to publish yet — add a dataset first."
              : undefined
        }
        type="button"
      >
        <Rocket className="mr-2 h-4 w-4" />
        {pressing ? "Publishing…" : "Publish bundle"}
      </Button>
    </main>
  );
}

/** The Project → Members section (replaces the Members dialog launch; the dialog stays exported). */
export function PgProjectMembers() {
  const { myRole, project } = useProjectShell();
  return (
    <main className="mx-auto max-w-3xl px-6 py-6">
      <PgProjectMembersPanel isOpen myRole={myRole} project={project} />
    </main>
  );
}

/** The create-app dialog, wired by the route (the app-builder module is route-wired — ADR 0011/0014; the extension-slot pattern applied). */
export type CreateAppSlot = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (appId: string) => void | Promise<void>;
  projectId: string;
}>;
