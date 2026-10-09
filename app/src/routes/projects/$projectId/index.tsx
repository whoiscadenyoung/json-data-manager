import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowDownToLine,
  ArrowLeft,
  Calendar,
  Database,
  FolderKanban,
  GitFork,
  History,
  Link2,
  ListPlus,
  Loader2,
  Map as MapIcon,
  MapPin,
  Plus,
  RefreshCw,
  Rocket,
  Route as RouteIcon,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { DatasetTypeTags, DerivedDatasetBadge } from "#/components/dataset-type-tags";
import { ProjectMembersDialog, ProjectRoleBadge } from "#/components/project-members-dialog";
import { RouterButton } from "#/components/router-button";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { Textarea } from "#/components/ui/textarea";
import { publishProjectBundle } from "#/lib/bundle-publish";
import { errorMessage } from "#/lib/errors";
import type { ProjectLayerRow } from "#/lib/projects/map-layers";
import { styleOrDefault } from "#/lib/projects/map-layers";

import { api } from "../../../../convex/_generated/api";

/**
 * The project workspace (roadmap 7a, #102; lifecycle doc §3): everything in
 * the project listed by kind, with the create/import entry points (which
 * land IN the project — the create page's `?projectId=` variant) and the
 * add-reference action ("fork = add-to-project": reuse adds a reference,
 * never a copy; 7b mints the fork's version-reference edge with it). Phase 2
 * gave every member row its role pair (owned/linked, the sync column); phase
 * 3 (ADR 0012) made layers members and maps project-owned rows.
 *
 * Phase 4 of the project-workspace design organizes the workspace into TABS
 * — Datasets · Layers · Maps · Analysis · Publish — behind `?view=` (the
 * datasets-page convention: the active tab survives reloads and is linkable;
 * the default tab stays out of the URL, and navigations MERGE, never
 * replace). Layers lists the project's live layer rows (stored style dot,
 * visibility, removal); Maps is the launchpad into the in-project map editor
 * at /projects/$projectId/maps/$mapId; Analysis holds the derived datasets;
 * Publish carries the bundle press.
 *
 * The read is `projects.get` — member-scoped server-side (ADR 0011); null
 * renders the not-found card, so a project that hasn't been shared with the
 * viewer (and the drafts it carries) is indistinguishable from a missing
 * one. The page badges the viewer's own role beside the title, opens the
 * members dialog from the header line, and gates every write control on the
 * seat it names — visibly disabled with the reason for viewers, never a
 * silent no-op.
 */

const projectSearchSchema = z.object({
  // Active tab ("datasets" is the default and deliberately absent from the URL).
  view: z.enum(["datasets", "layers", "maps", "analysis", "publish"]).optional(),
});

export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectWorkspacePage,
  validateSearch: projectSearchSchema,
});

type Workspace = FunctionReturnType<typeof api.projects.get>;
type WorkspaceData = NonNullable<Workspace>;
type Artifact = WorkspaceData["artifacts"][number];
type ProjectView = NonNullable<ReturnType<typeof projectSearchSchema.parse>["view"]>;

type MapSummary = FunctionReturnType<typeof api.projectMaps.list>[number];

/** The membership kinds the workspace renders sections for (phase 3 retired the map kind — a map is a projectMaps row now). */
type WorkspaceKind = "dataset" | "derived" | "layer";

/** Splits the membership rows by their declared kind — the workspace's section order. */
function groupByKind(artifacts: Artifact[]): {
  datasets: Artifact[];
  derived: Artifact[];
  layers: Artifact[];
} {
  const datasets: Artifact[] = [],
    derived: Artifact[] = [],
    layers: Artifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.artifactKind === "dataset") {
      datasets.push(artifact);
    } else if (artifact.artifactKind === "derived") {
      derived.push(artifact);
    } else {
      layers.push(artifact);
    }
  }
  return { datasets, derived, layers };
}

/** Display count for a referenced dataset: features for geospatial, entries otherwise. */
function datasetRowCount(
  summary: Extract<Artifact["state"], { kind: "dataset" }>["summary"],
): string {
  if (summary.kind === "geospatial") {
    const features = summary.featureCount;
    return features === undefined
      ? "No features yet"
      : `${features} ${features === 1 ? "feature" : "features"}`;
  }
  return `${summary.entryCount} ${summary.entryCount === 1 ? "entry" : "entries"}`;
}

/** The defensive label for an artifact deleted out from under the project. */
function missingLabel(kind: WorkspaceKind): string {
  if (kind === "dataset") {
    return "Deleted dataset";
  }
  return kind === "derived" ? "Deleted derived dataset" : "Deleted layer";
}

/**
 * The signed-out gate (roadmap 7 is the auth-gated stage): `projects.get`
 * throws for anonymous callers, which would otherwise render as an infinite
 * spinner — this card is what a signed-out visitor gets instead.
 */
function SignInPrompt({ subject }: { subject: string }) {
  return (
    <Empty className="min-h-80 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderKanban />
        </EmptyMedia>
        <EmptyTitle>Sign in to continue</EmptyTitle>
        <EmptyDescription>{subject}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <RouterButton to="/signin">Sign in</RouterButton>
      </EmptyContent>
    </Empty>
  );
}

function RemoveButton({
  canWrite,
  projectId,
  artifactId,
  artifactKind,
}: {
  canWrite: boolean;
  projectId: string;
  artifactId: string;
  artifactKind: WorkspaceKind;
}) {
  const remove = useMutation(api.projects.removeArtifact);
  // A viewer's read-only seat is surfaced on the control, never hidden:
  // the button stays visible, disabled, and says why (the UI-polish rule —
  // no silent no-ops).
  if (!canWrite) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground"
        disabled
        title="Viewers have read-only access — an editor or owner can remove artifacts."
        aria-label="Removing artifacts requires editor access"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 text-muted-foreground hover:text-destructive"
      title={removeHint(artifactKind)}
      aria-label="Remove from project"
      onClick={() => {
        const run = async () => {
          try {
            await remove({ artifactId, artifactKind, projectId });
            toast.success("Removed from project.");
          } catch (error) {
            toast.error(errorMessage(error, "Something went wrong."));
          }
        };
        void run();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

/**
 * The member-role badge (phase 2): OWNED — the workspace's own working copy,
 * member-editable (ADR 0011); LINKED — a versioned row the project
 * references, its view pinned to a version until someone Syncs.
 */
function MemberRoleBadge({ role }: { role: "owned" | "linked" }) {
  if (role === "owned") {
    return (
      <Badge
        variant="outline"
        title="Created in this project (or pulled in as a draft) — its members edit this copy directly."
      >
        Owned
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      title="A published row this project references — the project pins a version and advances it explicitly."
    >
      <Link2 className="h-3 w-3" />
      Linked
    </Badge>
  );
}

/** The viewer's seat, as one boolean plus the reason a disabled control shows. */
const VIEWER_HINT = "Viewers have read-only access — an editor or owner can change sync settings.";

/** The badge per sync state: floating (auto), pinned-and-current, or the "update available" answer. */
function SyncStateBadge({ sync }: { sync: NonNullable<Artifact["sync"]> }) {
  if (sync.mode === "float") {
    return (
      <Badge
        variant="secondary"
        title="This member floats on the source's newest published version."
      >
        <RefreshCw className="h-3 w-3" />
        Auto-syncs
      </Badge>
    );
  }
  if (sync.upToDate) {
    return (
      <Badge variant="secondary" title="The pin matches the source's newest published version.">
        <ArrowDownToLine className="h-3 w-3" />
        up to date
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      title={
        sync.headVersionLabel === undefined
          ? "The source's pinned version is no longer its head."
          : `The source is now at ${sync.headVersionLabel}.`
      }
    >
      Update available
    </Badge>
  );
}

/** Sync (only when the pin has somewhere to advance) and Revert, for a pinned member. Float members carry neither. */
function SyncActionButtons({
  canWrite,
  onRun,
  pending,
  sync,
}: {
  canWrite: boolean;
  onRun: (action: "sync" | "revert") => void;
  pending: string | undefined;
  sync: NonNullable<Artifact["sync"]>;
}) {
  if (sync.mode === "float") {
    return null;
  }
  return (
    <>
      {!sync.upToDate && canWrite && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending !== undefined}
          onClick={() => {
            onRun("sync");
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {pending === "sync" ? "Syncing…" : "Sync"}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={!canWrite || pending !== undefined}
        title={canWrite ? undefined : VIEWER_HINT}
        onClick={() => {
          onRun("revert");
        }}
      >
        <History className="h-3.5 w-3.5" />
        {pending === "revert" ? "Reverting…" : "Revert"}
      </Button>
    </>
  );
}

/**
 * One LINKED dataset member's sync column (phase 2): the "Update available"
 * badge when the source chain has moved past the pin, Sync/Revert through the
 * stage-6 reference mutations, and the per-member "Keep in sync" checkbox
 * (`projects.setMemberSync` — auto floats on the source's head, manual pins).
 * Owned members render nothing here (they are edited in place — the link-XOR-
 * modify line); viewers see the state with the controls disabled and the
 * reason on them, never silent no-ops.
 */
function MemberSyncControls({
  artifact,
  canWrite,
  projectId,
}: {
  artifact: Artifact;
  canWrite: boolean;
  projectId: string;
}) {
  const setMemberSync = useMutation(api.projects.setMemberSync),
    syncReference = useMutation(api.consumption.syncReference),
    revertReference = useMutation(api.consumption.revertReference),
    [pending, setPending] = useState<string>(),
    sync = artifact.sync;
  if (sync === undefined) {
    return null;
  }
  const run = async (action: "sync" | "revert" | "auto" | "manual"): Promise<void> => {
    setPending(action);
    try {
      if (action === "sync") {
        await syncReference({ referenceId: sync.referenceId });
        toast.success("Synced — the project's pin now sits at the source's newest version.");
      } else if (action === "revert") {
        await revertReference({ referenceId: sync.referenceId });
        toast.success("Reverted — the pin moved back one version.");
      } else {
        await setMemberSync({
          artifactId: artifact.artifactId,
          artifactKind: artifact.artifactKind,
          projectId,
          syncMode: action === "auto" ? "auto" : "manual",
        });
        toast.success(
          action === "auto"
            ? "Keeping this member in sync — it floats on the source's newest version."
            : "Sync paused — the member is pinned at the current version.",
        );
      }
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong."));
    } finally {
      setPending(undefined);
    }
  };
  const auto = sync.mode === "float";
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <SyncStateBadge sync={sync} />
        <SyncActionButtons
          canWrite={canWrite}
          onRun={(action) => {
            void run(action);
          }}
          pending={pending}
          sync={sync}
        />
      </div>
      <label
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        htmlFor={`keep-in-sync-${artifact.artifactId}`}
      >
        <Checkbox
          checked={auto}
          disabled={!canWrite || pending !== undefined}
          id={`keep-in-sync-${artifact.artifactId}`}
          onCheckedChange={(checked) => {
            void run(checked ? "auto" : "manual");
          }}
          title={canWrite ? undefined : VIEWER_HINT}
        />
        <span>Keep in sync</span>
      </label>
    </div>
  );
}

function DatasetRow({
  artifact,
  canWrite,
  projectId,
}: {
  artifact: Artifact;
  canWrite: boolean;
  projectId: string;
}) {
  if (artifact.state.kind !== "dataset") {
    return <MissingRow artifact={artifact} canWrite={canWrite} projectId={projectId} />;
  }
  const summary = artifact.state.summary;
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      {/* A project's datasets are drafts (newly created here) or references
          to published rows — the type tags render both, Draft badge included
          (the 5a rendering, reused not duplicated; the tooltip is the
          in-project copy, not the drafts-toggle one). */}
      <Link
        to="/datasets/$schemaId"
        params={{ schemaId: artifact.artifactId }}
        className="flex min-w-0 flex-1 flex-col gap-1 py-0"
      >
        <div className="flex flex-wrap items-center gap-2">
          <DatasetTypeTags
            dataset={summary}
            draftTitle="Draft — lives in this project, hidden from the catalog until it's published."
          />
          <MemberRoleBadge role={artifact.role} />
          <span className="text-xs text-muted-foreground">{datasetRowCount(summary)}</span>
        </div>
        <p className="truncate text-sm font-medium">{summary.title}</p>
        {summary.description !== undefined && (
          <p className="truncate text-xs text-muted-foreground">{summary.description}</p>
        )}
      </Link>
      <MemberSyncControls artifact={artifact} canWrite={canWrite} projectId={projectId} />
      <RemoveButton
        artifactId={artifact.artifactId}
        artifactKind={artifact.artifactKind}
        canWrite={canWrite}
        projectId={projectId}
      />
    </Card>
  );
}

function DerivedRow({
  artifact,
  canWrite,
  projectId,
}: {
  artifact: Artifact;
  canWrite: boolean;
  projectId: string;
}) {
  if (artifact.state.kind !== "derived") {
    return <MissingRow artifact={artifact} canWrite={canWrite} projectId={projectId} />;
  }
  const row = artifact.state.row;
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <DerivedDatasetBadge />
        <MemberRoleBadge role={artifact.role} />
        {row.status === "draft" && (
          <Badge
            variant="outline"
            title="A builder autosave — save the transform to surface it in the catalog."
          >
            Draft
          </Badge>
        )}
      </div>
      <p className="truncate text-sm font-medium">{row.title}</p>
      {row.description !== undefined && (
        <p className="truncate text-xs text-muted-foreground">{row.description}</p>
      )}
    </>
  );
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      {/* The spec's authoring surface, browser-parity: link only when the
          source is a COMPONENT dataset (resolved server-side) — a
          derived-of-derived has no page, exactly like the datasets browser's
          derived cards. */}
      {row.sourceDatasetId !== undefined ? (
        <Link
          to="/datasets/$schemaId"
          params={{ schemaId: row.sourceDatasetId }}
          search={{ view: "transform" }}
          className="flex min-w-0 flex-1 flex-col gap-1"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-1">{body}</div>
      )}
      <RemoveButton
        artifactId={artifact.artifactId}
        artifactKind={artifact.artifactKind}
        canWrite={canWrite}
        projectId={projectId}
      />
    </Card>
  );
}

/**
 * One layer member (phase 3, ADR 0012) rendered from its membership — the
 * kind badge (data/group), the Owned/Linked pair, and the drift or pinned-
 * version badges. The Layers TAB renders this row for linked members; owned
 * members get their live-row management row (LayerManageRow) above.
 */
function LayerRow({
  artifact,
  canWrite,
  projectId,
}: {
  artifact: Artifact;
  canWrite: boolean;
  projectId: string;
}) {
  if (artifact.state.kind !== "layer") {
    return <MissingRow artifact={artifact} canWrite={canWrite} projectId={projectId} />;
  }
  const layer = artifact.state.layer;
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="default">{layer.kind === "group" ? "Group layer" : "Layer"}</Badge>
          <MemberRoleBadge role={artifact.role} />
          {layer.source === "owned" ? (
            layer.lifecycle === "draft" ? (
              <Badge
                variant="outline"
                title="A working definition — publishing it (phase 5) freezes a version others can link or clone."
              >
                Draft
              </Badge>
            ) : null
          ) : (
            <Badge
              variant="secondary"
              title={
                layer.pinnedVersionLabel === undefined
                  ? "A published layer this project references, pinned to one frozen version."
                  : `Pinned at ${layer.pinnedVersionLabel}.`
              }
            >
              <Link2 className="h-3 w-3" />
              Pinned version
            </Badge>
          )}
          {layer.needsAttention !== undefined && (
            <Badge variant="destructive" title={layer.needsAttention}>
              Needs attention
            </Badge>
          )}
        </div>
        <p className="truncate text-sm font-medium">{layer.name}</p>
        {layer.needsAttention !== undefined && (
          <p className="truncate text-xs text-destructive">{layer.needsAttention}</p>
        )}
      </div>
      <RemoveButton
        artifactId={artifact.artifactId}
        artifactKind={artifact.artifactKind}
        canWrite={canWrite}
        projectId={projectId}
      />
    </Card>
  );
}

function MissingRow({
  artifact,
  canWrite,
  projectId,
}: {
  artifact: Artifact;
  canWrite: boolean;
  projectId: string;
}) {
  return (
    <Card className="flex-row items-center gap-4 px-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">
          {missingLabel(artifact.artifactKind)}
        </p>
        <p className="text-xs text-muted-foreground">
          The referenced artifact no longer exists — remove the reference to clean up.
        </p>
      </div>
      <RemoveButton
        artifactId={artifact.artifactId}
        artifactKind={artifact.artifactKind}
        canWrite={canWrite}
        projectId={projectId}
      />
    </Card>
  );
}

/** The owned layer row's badge line: kind, lifecycle, group membership, drift. */
function LayerBadges({ layer }: { layer: ProjectLayerRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="default">{layer.kind === "group" ? "Group layer" : "Layer"}</Badge>
      {layer.lifecycle === "draft" && (
        <Badge
          variant="outline"
          title="A working definition — publishing it (phase 5) freezes a version others can link or clone."
        >
          Draft
        </Badge>
      )}
      {layer.parentGroupId !== undefined && (
        <Badge variant="secondary" title="This layer sits inside a group layer.">
          grouped
        </Badge>
      )}
      {layer.needsAttention !== undefined && (
        <Badge variant="destructive" title={layer.needsAttention}>
          Needs attention
        </Badge>
      )}
    </div>
  );
}

/**
 * One owned layer's management row on the Layers tab (phase 4): the stored
 * style dot, kind/lifecycle/drift badges, the layer-wide eye toggle
 * (`layers.setVisible` — each map carries its own placement eye on top), and
 * removal (`layers.remove` — an owned layer's deletion takes its versions
 * and map placements with it, so it confirms first). Styling happens in the
 * map editor; the tab's note points there.
 */
function LayerManageRow({
  layer,
  canWrite,
  onRemove,
}: {
  layer: ProjectLayerRow;
  canWrite: boolean;
  onRemove: (layer: ProjectLayerRow) => void;
}) {
  const setVisible = useMutation(api.layers.setVisible),
    style = styleOrDefault(layer.style);
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      <span
        className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: style.color }}
        title={`Stored style — stroke ${style.color}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-0">
        <LayerBadges layer={layer} />
        <p className="truncate text-sm font-medium">{layer.name}</p>
        {layer.needsAttention !== undefined && (
          <p className="truncate text-xs text-destructive">{layer.needsAttention}</p>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {layer.visible ? "visible" : "hidden"}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
        title={canWrite ? "The layer-wide default — each map carries its own eye" : VIEWER_HINT}
        disabled={!canWrite}
        onClick={() => {
          const run = async () => {
            try {
              await setVisible({ layerId: layer._id, visible: !layer.visible });
            } catch (error) {
              toast.error(errorMessage(error, "Failed to toggle the layer."));
            }
          };
          void run();
        }}
      >
        {layer.visible ? <MapPin className="h-4 w-4" /> : <MapPin className="h-4 w-4 opacity-40" />}
      </Button>
      {canWrite ? (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          title="Delete this layer — its versions and map placements go with it (the datasets behind it stay)."
          aria-label={`Delete ${layer.name}`}
          onClick={() => {
            onRemove(layer);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          disabled
          title={VIEWER_HINT}
          aria-label="Deleting layers requires editor access"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </Card>
  );
}

/**
 * The add-reference candidates for one kind: published datasets plus the
 * VIEWER'S OWN drafts (the drafts read is the viewer-scoped 5a read — a
 * member's candidates are their own drafts; project-held drafts are already
 * members), or saved derived specs — already-added ids excluded. (Layers
 * join through their own create/link flows, and maps are projectMaps rows —
 * neither is a bare reference, phase 3.) Module-level so the dialog stays
 * under the complexity budget.
 */
function buildCandidates(
  kind: "dataset" | "derived",
  existingIds: Set<string>,
  lists: {
    datasets?: FunctionReturnType<typeof api.schemas.listSummaries>;
    drafts?: FunctionReturnType<typeof api.schemas.listDraftSummaries>;
    derived?: FunctionReturnType<typeof api.derivedDatasets.summaries>;
  },
): { id: string; label: string; hint?: string }[] {
  const candidates: { id: string; label: string; hint?: string }[] = [];
  if (kind === "dataset") {
    for (const row of [...(lists.datasets ?? []), ...(lists.drafts ?? [])]) {
      candidates.push({ hint: row.description, id: row._id, label: row.title });
    }
  } else {
    for (const row of lists.derived ?? []) {
      candidates.push({ hint: row.description, id: row._id, label: row.title });
    }
  }
  return candidates.filter((candidate) => !existingIds.has(candidate.id));
}

/**
 * The add-reference dialog: one candidate list per kind, opt-in subscriptions
 * (enabled only while open — the light-query convention). A click adds the
 * membership row and nothing else — no catalog row, no copy ("fork =
 * add-to-project"). Dataset candidates also offer "fork as transform" (7b):
 * a SAVED identity spec over the source, born a project member — reuse with
 * transforms, publishable day one. Phase 2 adds the keep-in-sync choice for
 * dataset adds: the default pins a linked member at the source chain's
 * current head; checked, the member floats live ("auto"). Editor-and-up
 * only: the page never mounts it for a viewer (their write buttons are
 * disabled with the reason, so the dialog never opens into a wall of server
 * denials). `initialKind` opens on the calling tab's kind (Datasets →
 * datasets, Analysis → derived).
 */
function AddReferenceDialog({
  initialKind,
  projectId,
  existingIds,
  open,
  onOpenChange,
}: {
  initialKind: "dataset" | "derived";
  projectId: string;
  existingIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useMutation(api.projects.addArtifact),
    fork = useMutation(api.projects.forkAsSpec),
    [kind, setKind] = useState<"dataset" | "derived">(initialKind),
    [pendingId, setPendingId] = useState<string | undefined>(),
    [keepInSync, setKeepInSync] = useState(false),
    datasets = useQuery({
      ...convexQuery(api.schemas.listSummaries, { limit: 1000 }),
      enabled: open,
    }).data,
    drafts = useQuery({
      ...convexQuery(api.schemas.listDraftSummaries, { limit: 1000 }),
      enabled: open,
    }).data,
    derived = useQuery({ ...convexQuery(api.derivedDatasets.summaries, {}), enabled: open }).data,
    available = buildCandidates(kind, existingIds, { datasets, drafts, derived });

  const addArtifact = async (artifactId: string, artifactKind: "dataset" | "derived") => {
    setPendingId(artifactId);
    try {
      await add({
        artifactId,
        artifactKind,
        projectId,
        // Drafts land owned regardless; linked datasets honor the choice
        // (manual pins at head, auto floats).
        syncMode: keepInSync ? "auto" : "manual",
      });
      toast.success("Added to project.");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong."));
    } finally {
      setPendingId(undefined);
    }
  };

  const forkAsTransform = async (sourceDatasetId: string, sourceTitle: string) => {
    setPendingId(sourceDatasetId);
    try {
      await fork({
        projectId,
        sourceDatasetId,
        title: `Fork of ${sourceTitle}`,
      });
      toast.success("Forked as a transform — edit its spec, publish it with the project.");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong."));
    } finally {
      setPendingId(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add to project</DialogTitle>
          <DialogDescription>
            Reference an existing artifact — nothing is copied, and the catalog stays untouched.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 py-2">
          {(
            [
              ["dataset", "Datasets"],
              ["derived", "Derived"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              variant={kind === value ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setKind(value);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        {kind === "dataset" && (
          <div className="flex flex-col gap-1 rounded-md border px-3 py-2">
            <label className="flex items-center gap-2 text-sm" htmlFor="keep-added-in-sync">
              <Checkbox
                checked={keepInSync}
                id="keep-added-in-sync"
                onCheckedChange={(checked) => {
                  setKeepInSync(checked);
                }}
              />
              <span>Keep added datasets in sync</span>
            </label>
            <p className="text-xs text-muted-foreground">
              Off (default): each added dataset is pinned at its newest published version and moves
              only when someone presses Sync. On: they float on the source's newest version
              automatically.
            </p>
          </div>
        )}
        {available.length === 0 ? (
          <p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing left to add here.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {available.map((candidate) => (
              <div key={candidate.id} className="flex items-stretch gap-1">
                <button
                  type="button"
                  disabled={pendingId !== undefined}
                  onClick={() => {
                    void addArtifact(candidate.id, kind);
                  }}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                >
                  <span className="text-sm font-medium">{candidate.label}</span>
                  {candidate.hint !== undefined && (
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {candidate.hint}
                    </span>
                  )}
                </button>
                {kind === "dataset" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 self-center"
                    disabled={pendingId !== undefined}
                    aria-label={`Fork ${candidate.label} as a transform`}
                    title="Fork as transform: a new derived spec over this dataset — a reference, never a copy"
                    onClick={() => {
                      void forkAsTransform(candidate.id, candidate.label);
                    }}
                  >
                    {pendingId === candidate.id ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Forking…
                      </>
                    ) : (
                      <>
                        <GitFork className="h-4 w-4" />
                        Fork
                      </>
                    )}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The remove control's honest copy per kind: a layer member is project-owned state — removing an OWNED layer deletes the layer, its versions, and its map placements (a linked one just unpins) — while datasets and derived specs are references that survive the removal. */
function removeHint(kind: WorkspaceKind): string {
  if (kind === "layer") {
    return "Remove from project — an owned layer is deleted with its versions and map placements; a linked layer just unpins (the source stays).";
  }
  return "Remove from project (the artifact itself is not deleted)";
}

/** The stale-run threshold, the syncRuns/publishAttempts value: a press whose checkpoint hasn't moved for this long was abandoned by its browser, and pressing again RESUMES it (start joins running runs). */
const STALE_PRESS_MS = 2 * 60 * 1000;

type LatestBundle = NonNullable<FunctionReturnType<typeof api.bundles.latestForProject>>;

/** True when the newest run says "running" but its checkpoint has been idle past the stale window — a killed browser's press, safe to re-press into (start joins it). */
function pressLooksStale(bundle: LatestBundle, now: number): boolean {
  return bundle.status === "running" && now - bundle.lastProgressAt > STALE_PRESS_MS;
}

/** The press handler: drives the client orchestrator, toasts the outcome. */
function usePressBundle(projectId: string) {
  const [pressing, setPressing] = useState(false);
  const press = async () => {
    setPressing(true);
    try {
      const outcome = await publishProjectBundle({ projectId });
      if (outcome.status === "completed") {
        toast.success(
          "Project published — the collection, its maps, and every referenced dataset are in the catalog.",
        );
      } else {
        toast.error(
          `The press finished with ${outcome.failedKeys.length} failed member${
            outcome.failedKeys.length === 1 ? "" : "s"
          }: ${outcome.failedKeys.join(", ")} — completed members keep their published versions. Press again to retry.`,
        );
      }
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong."));
    } finally {
      setPressing(false);
    }
  };
  return { press, pressing };
}

/** The failed members, named — the checkpoint design's contract ("the UI can say exactly what to retry"). */
function FailedMemberList({ bundle }: { bundle: LatestBundle }) {
  if (bundle.failedMembers.length === 0) {
    return null;
  }
  return (
    <span className="mt-1 flex flex-col gap-0.5 text-xs text-destructive">
      {bundle.failedMembers.map((member) => (
        <span key={member.datasetKey} className="truncate">
          Failed: {member.datasetKey}
          {member.error !== undefined ? ` — ${member.error}` : ""}
        </span>
      ))}
    </span>
  );
}

/** The workspace's bundle status under the Publish tab (7b): the live press (with progress), an interrupted one, the failures, or the promoted collection link. Staleness reads the mount-time clock (react/purity) — the page remounts on return, which is exactly when an abandoned press should announce itself; the press action never gates on it. */
function BundleStatusLine({ bundle }: { bundle: LatestBundle }) {
  const [now] = useState(() => Date.now()),
    stale = pressLooksStale(bundle, now);
  if (bundle.status === "running" && !stale) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Rocket className="h-3.5 w-3.5 animate-pulse text-primary" />
        Publishing bundle… {bundle.publishedCount} of {bundle.memberCount} members done
      </p>
    );
  }
  if (bundle.status === "running" && stale) {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        The last press looks interrupted — press publish to resume it where it stopped.
      </p>
    );
  }
  if (bundle.status === "failed") {
    return (
      <div className="mt-1 flex flex-col">
        <p className="text-sm text-destructive">
          Last press failed ({bundle.failedCount} of {bundle.memberCount} members) — press publish
          again to retry.
        </p>
        <FailedMemberList bundle={bundle} />
      </div>
    );
  }
  return (
    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
      Published {new Date(bundle.finishedAt ?? bundle.startedAt).toLocaleDateString()}
      {bundle.collectionId !== undefined && (
        <>
          {" — "}
          <Link
            to="/collections/$collectionId"
            params={{ collectionId: bundle.collectionId }}
            className="text-primary underline-offset-2 hover:underline"
          >
            view the published collection
          </Link>
        </>
      )}
    </p>
  );
}

/** The tab's artifact list with its empty state, shared by the Datasets and Analysis tabs. */
function ArtifactSection({
  artifacts,
  emptyDescription,
  emptyTitle,
  render,
}: {
  artifacts: Artifact[];
  emptyDescription: string;
  emptyTitle: string;
  render: (artifact: Artifact) => React.ReactNode;
}) {
  if (artifacts.length === 0) {
    return (
      <Empty className="min-h-40 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Database />
          </EmptyMedia>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {artifacts.map((artifact) => (
        <div key={artifact._id}>{render(artifact)}</div>
      ))}
    </div>
  );
}

/**
 * The Layers tab (phase 4): the project's live layer rows — stored style
 * dot, kind/lifecycle/drift badges, the layer-wide eye, removal with the
 * honest destructive copy — above the LINKED layer members (pinned units
 * from other projects, read-only). Styling happens in the map editor; the
 * tab's note points there.
 */
function LayersTab({
  canWrite,
  layerArtifacts,
  projectId,
}: {
  canWrite: boolean;
  layerArtifacts: Artifact[];
  projectId: string;
}) {
  const layers = useQuery({ ...convexQuery(api.layers.list, { projectId }) }).data,
    removeLayer = useMutation(api.layers.remove),
    [pendingRemove, setPendingRemove] = useState<ProjectLayerRow | undefined>(undefined),
    linkedArtifacts = layerArtifacts.filter(
      (artifact) => artifact.role === "linked" || artifact.state.kind === "missing",
    );
  const runRemove = async (layer: ProjectLayerRow): Promise<void> => {
    try {
      await removeLayer({ layerId: layer._id });
      toast.success(`Deleted "${layer.name}" — its map placements went with it.`);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to delete the layer."));
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          Your layers{" "}
          <span className="font-normal">
            (
            {layers === undefined
              ? "…"
              : `${layers.length} ${layers.length === 1 ? "layer" : "layers"}`}
            )
          </span>
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Styling lives on the maps — open a map and select a layer to restyle it. Publishing layers
          (freezing versions other projects can link or clone) arrives with the project bundle.
        </p>
        {layers === undefined ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
          </div>
        ) : layers.length === 0 ? (
          <Empty className="min-h-40 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RouteIcon />
              </EmptyMedia>
              <EmptyTitle>No layers yet</EmptyTitle>
              <EmptyDescription>
                Layers are born when a dataset is added to one of this project's maps — open the
                Maps tab, create a map, and add a dataset to it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {layers.map((layer) => (
              <LayerManageRow
                key={layer._id}
                layer={layer}
                canWrite={canWrite}
                onRemove={(row) => {
                  setPendingRemove(row);
                }}
              />
            ))}
          </div>
        )}
      </section>
      {linkedArtifacts.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            Linked from other projects{" "}
            <span className="font-normal">
              ({linkedArtifacts.length} {linkedArtifacts.length === 1 ? "layer" : "layers"})
            </span>
          </h2>
          <div className="flex flex-col gap-3">
            {linkedArtifacts.map((artifact) => (
              <LayerRow
                key={artifact._id}
                artifact={artifact}
                canWrite={canWrite}
                projectId={projectId}
              />
            ))}
          </div>
        </section>
      )}
      <ConfirmDialog
        open={pendingRemove !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemove(undefined);
          }
        }}
        title={`Delete "${pendingRemove === undefined ? "" : pendingRemove.name}"?`}
        description="The layer, its version chain, and every map placement go with it. The datasets behind it stay put."
        confirmLabel="Delete layer"
        destructive
        onConfirm={() => {
          if (pendingRemove !== undefined) {
            void runRemove(pendingRemove);
          }
          setPendingRemove(undefined);
        }}
      />
    </div>
  );
}

/** The new-map card (the title is the only required field — the button is live and the blank name is the server's friendly refusal, surfaced in the toast). Creating navigates straight into the editor. */
function NewMapCard({ canWrite, projectId }: { canWrite: boolean; projectId: string }) {
  const createMap = useMutation(api.projectMaps.create),
    navigate = useNavigate(),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [creating, setCreating] = useState(false);
  const handleCreate = async (): Promise<void> => {
    setCreating(true);
    try {
      const mapId = await createMap({
        description: description.trim() === "" ? undefined : description.trim(),
        name: name.trim(),
        projectId,
      });
      toast.success("Map created.");
      await navigate({
        params: { mapId, projectId },
        search: {},
        to: "/projects/$projectId/maps/$mapId",
      });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to create the map."));
    } finally {
      setCreating(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New map</CardTitle>
        <CardDescription>
          A canvas for the project's layers — name it, then place layers from the editor.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="new-map-name" className="text-xs">
            Name
          </Label>
          <Input
            id="new-map-name"
            value={name}
            disabled={creating || !canWrite}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="Corridor study"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="new-map-description" className="text-xs">
            Description (optional)
          </Label>
          <Textarea
            id="new-map-description"
            value={description}
            rows={2}
            disabled={creating || !canWrite}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            placeholder="What this map shows"
          />
        </div>
        <div>
          <Button
            type="button"
            disabled={creating || !canWrite}
            title={canWrite ? undefined : VIEWER_HINT}
            onClick={() => {
              void handleCreate();
            }}
          >
            {creating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Create map
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The Maps tab (phase 4): the project-owned maps, each launching the in-project editor, with create / reorder / delete for editors and the reasons on a viewer's disabled controls. */
function MapsTab({
  canWrite,
  maps,
  projectId,
}: {
  canWrite: boolean;
  maps: MapSummary[] | undefined;
  projectId: string;
}) {
  const moveMap = useMutation(api.projectMaps.move),
    deleteMap = useMutation(api.projectMaps.remove),
    [pendingDelete, setPendingDelete] = useState<MapSummary | undefined>(undefined);
  const runDelete = async (map: MapSummary): Promise<void> => {
    try {
      await deleteMap({ mapId: map._id });
      toast.success(`Deleted "${map.name}".`);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to delete the map."));
    }
  };
  const runMove = async (mapId: string, direction: "up" | "down"): Promise<void> => {
    try {
      await moveMap({ direction, mapId });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to move the map."));
    }
  };
  if (maps === undefined) {
    return (
      <div className="flex justify-center py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {canWrite && <NewMapCard canWrite={canWrite} projectId={projectId} />}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          This project's maps{" "}
          <span className="font-normal">
            ({maps.length} {maps.length === 1 ? "map" : "maps"})
          </span>
        </h2>
        {maps.length === 0 ? (
          <Empty className="min-h-40 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MapIcon />
              </EmptyMedia>
              <EmptyTitle>No maps yet</EmptyTitle>
              <EmptyDescription>
                {canWrite
                  ? "Create the project's first map above."
                  : "This project's editors haven't created a map yet."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {maps.map((map, index) => (
              <Card key={map._id} className="flex-row items-center gap-4 px-4">
                <MapIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Link
                  to="/projects/$projectId/maps/$mapId"
                  params={{ mapId: map._id, projectId }}
                  className="flex min-w-0 flex-1 flex-col gap-1 py-0"
                >
                  <p className="truncate text-sm font-medium">{map.name}</p>
                  {map.description !== undefined && (
                    <p className="truncate text-xs text-muted-foreground">{map.description}</p>
                  )}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {map.layerCount} {map.layerCount === 1 ? "layer" : "layers"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={`Move ${map.name} up`}
                  title={canWrite ? undefined : VIEWER_HINT}
                  disabled={!canWrite || index === 0}
                  onClick={() => {
                    void runMove(map._id, "up");
                  }}
                >
                  <ArrowLeft className="h-4 w-4 -rotate-90" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={`Move ${map.name} down`}
                  title={canWrite ? undefined : VIEWER_HINT}
                  disabled={!canWrite || index === maps.length - 1}
                  onClick={() => {
                    void runMove(map._id, "down");
                  }}
                >
                  <ArrowLeft className="h-4 w-4 rotate-90" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${map.name}`}
                  title={canWrite ? undefined : VIEWER_HINT}
                  disabled={!canWrite}
                  onClick={() => {
                    setPendingDelete(map);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>
      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        title={`Delete "${pendingDelete === undefined ? "" : pendingDelete.name}"?`}
        description="The map and its placements will be removed. The layers themselves stay in the project."
        confirmLabel="Delete map"
        destructive
        onConfirm={() => {
          if (pendingDelete !== undefined) {
            void runDelete(pendingDelete);
          }
          setPendingDelete(undefined);
        }}
      />
    </div>
  );
}

/** The Publish tab (phase 4): the one-press bundle publish with its status line and what-it-freezes copy. */
function PublishTab({
  bundle,
  canWrite,
  empty,
  projectId,
}: {
  bundle: LatestBundle | null | undefined;
  canWrite: boolean;
  empty: boolean;
  projectId: string;
}) {
  const { press, pressing } = usePressBundle(projectId);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="h-4 w-4 text-primary" />
          Publish bundle
        </CardTitle>
        <CardDescription>
          One press publishes the project: every dataset and derived spec gets a frozen version and
          the collection is promoted. Members already published keep their versions — a re-press
          republishes into NEW versions, never mutating prior ones.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <Button
            type="button"
            onClick={() => {
              void press();
            }}
            disabled={!canWrite || pressing || empty}
            title={
              !canWrite
                ? "Viewers have read-only access — an editor or owner can publish."
                : empty
                  ? "Nothing to publish yet — add a dataset or a transform first."
                  : undefined
            }
          >
            {pressing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Publishing…
              </>
            ) : (
              <>
                <Rocket className="h-4 w-4 mr-2" />
                Publish bundle
              </>
            )}
          </Button>
        </div>
        {bundle !== undefined && bundle !== null && <BundleStatusLine bundle={bundle} />}
        {bundle === null && (
          <p className="text-sm text-muted-foreground">This project has never been published.</p>
        )}
      </CardContent>
    </Card>
  );
}

// oxlint-disable-next-line eslint/complexity -- the workspace composes the header, the five tabs, and the dialogs; each tab's body is its own component.
function ProjectWorkspacePage() {
  const { projectId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate(),
    // The auth gate renders BEFORE the query state: anonymous callers' query
    // throws, and without this branch that shows as an infinite spinner.
    { isAuthenticated, isLoading: authLoading } = useConvexAuth(),
    workspace = useQuery({
      ...convexQuery(api.projects.get, { projectId }),
      enabled: !authLoading && isAuthenticated,
    }).data,
    // The project-owned maps (phase 3, ADR 0012) — the Maps tab's rows and
    // the tab bar's count. Mounted UNCONDITIONALLY beside the other hooks
    // (Rules of Hooks — an early return below would flip the hook count);
    // `enabled` keeps it idle until the auth gate, and for a project the
    // viewer can't see the read answers empty anyway.
    maps = useQuery({
      ...convexQuery(api.projectMaps.list, { projectId }),
      enabled: !authLoading && isAuthenticated,
    }).data,
    latestBundle = useQuery({
      ...convexQuery(api.bundles.latestForProject, { projectId }),
      enabled: !authLoading && isAuthenticated,
    }).data,
    [addOpen, setAddOpen] = useState(false),
    [addKind, setAddKind] = useState<"dataset" | "derived">("dataset"),
    [membersOpen, setMembersOpen] = useState(false);

  if (authLoading) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <SignInPrompt subject="Projects are shared workspaces — sign in to see yours." />
      </main>
    );
  }
  if (workspace === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (workspace === null) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderKanban />
            </EmptyMedia>
            <EmptyTitle>Project not found</EmptyTitle>
            <EmptyDescription>
              It may have been deleted — or it hasn't been shared with you.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <RouterButton to="/projects">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Projects
            </RouterButton>
          </EmptyContent>
        </Empty>
      </main>
    );
  }

  const { project, artifacts } = workspace,
    // The viewer's seat in this project (ADR 0011): owners and editors may
    // write the workspace's content; viewers read it. Every write control
    // below gates on this — visibly, with the reason on the disabled
    // control, never as a silent no-op.
    canWrite = project.role === "owner" || project.role === "editor",
    grouped = groupByKind(artifacts),
    existingIds = new Set(artifacts.map((artifact) => artifact.artifactId)),
    view = search.view ?? "datasets",
    openAddDialog = (kind: "dataset" | "derived") => {
      setAddKind(kind);
      setAddOpen(true);
    },
    // Tab switches write `?view=` so the active tab survives reloads and is
    // linkable; "datasets" is the default and stays out of the URL. The
    // merge form never drops unrelated params.
    setView = async (next: ProjectView): Promise<void> => {
      await navigate({
        search: (prev) => ({ ...prev, view: next === "datasets" ? undefined : next }),
      });
    },
    handleTabChange = (value: unknown) => {
      if (
        value === "datasets" ||
        value === "layers" ||
        value === "maps" ||
        value === "analysis" ||
        value === "publish"
      ) {
        void setView(value);
      }
    };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <RouterButton variant="ghost" to="/projects" className="mb-4 -ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Projects
        </RouterButton>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold text-primary">{project.title}</h1>
              {/* The viewer's own seat (ADR 0011's UI line): what you can do
                  here, answered on sight. */}
              <ProjectRoleBadge role={project.role} />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center">
                <Calendar className="mr-1.5 h-3.5 w-3.5" />
                Created {new Date(project._creationTime).toLocaleDateString()}
              </span>
              <span>
                {artifacts.length} {artifacts.length === 1 ? "artifact" : "artifacts"}
              </span>
              <button
                type="button"
                className="flex items-center text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  setMembersOpen(true);
                }}
              >
                <Users className="mr-1.5 h-3.5 w-3.5" />
                Members
              </button>
            </div>
            {project.description !== undefined && (
              <p className="mt-1 text-muted-foreground">{project.description}</p>
            )}
          </div>
          {canWrite && (
            <div className="flex gap-2">
              {/* The in-project create/import entry points, on the tab that
                  uses them (derived adds live on the Analysis tab). The
                  create page's `?projectId=` variant lands the draft +
                  membership atomically. */}
              <RouterButton to="/datasets/create" search={{ projectId }}>
                <Plus className="h-4 w-4 mr-2" />
                New dataset
              </RouterButton>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  openAddDialog("dataset");
                }}
              >
                <ListPlus className="h-4 w-4 mr-2" />
                Add existing
              </Button>
            </div>
          )}
        </div>
      </div>

      <Tabs value={view} onValueChange={handleTabChange}>
        <TabsList className="mb-6">
          <TabsTrigger value="datasets">Datasets ({grouped.datasets.length})</TabsTrigger>
          <TabsTrigger value="layers">Layers ({grouped.layers.length})</TabsTrigger>
          <TabsTrigger value="maps">Maps ({maps === undefined ? 0 : maps.length})</TabsTrigger>
          <TabsTrigger value="analysis">Analysis ({grouped.derived.length})</TabsTrigger>
          <TabsTrigger value="publish">Publish</TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "datasets" && (
        <ArtifactSection
          artifacts={grouped.datasets}
          emptyTitle="No datasets in this project yet"
          emptyDescription={
            canWrite
              ? "Create a dataset in the project (button above), or add an existing one by reference."
              : "Nothing has been added to this project yet — its editors and owner fill it in."
          }
          render={(artifact) => (
            <DatasetRow artifact={artifact} canWrite={canWrite} projectId={projectId} />
          )}
        />
      )}

      {view === "layers" && (
        <LayersTab canWrite={canWrite} layerArtifacts={grouped.layers} projectId={projectId} />
      )}

      {view === "maps" && <MapsTab canWrite={canWrite} maps={maps} projectId={projectId} />}

      {view === "analysis" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Derived datasets — the analysis tier. A transform reads source datasets and computes a
              new table; fork one in from the Datasets tab's add dialog ("Fork").
            </p>
            {canWrite && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  openAddDialog("derived");
                }}
              >
                <ListPlus className="h-4 w-4 mr-2" />
                Add derived
              </Button>
            )}
          </div>
          <ArtifactSection
            artifacts={grouped.derived}
            emptyTitle="No derived datasets yet"
            emptyDescription={
              canWrite
                ? "Fork a dataset as a transform from the Datasets tab's add dialog, or add a saved derived spec."
                : "This project's editors haven't derived anything yet."
            }
            render={(artifact) => (
              <DerivedRow artifact={artifact} canWrite={canWrite} projectId={projectId} />
            )}
          />
        </div>
      )}

      {view === "publish" && (
        <PublishTab
          bundle={latestBundle}
          canWrite={canWrite}
          empty={artifacts.length === 0}
          projectId={projectId}
        />
      )}

      {canWrite && (
        <AddReferenceDialog
          initialKind={addKind}
          projectId={projectId}
          existingIds={existingIds}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      )}
      <ProjectMembersDialog
        creatorId={project.createdBy}
        myRole={project.role}
        onOpenChange={setMembersOpen}
        open={membersOpen}
        projectId={projectId}
      />
    </main>
  );
}
