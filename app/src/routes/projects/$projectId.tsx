import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useConvexAuth, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowLeft,
  Calendar,
  Database,
  FolderKanban,
  ListPlus,
  Map as MapIcon,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DatasetTypeTags, DerivedDatasetBadge } from "#/components/dataset-type-tags";
import { RouterButton } from "#/components/router-button";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
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

import { api } from "../../../convex/_generated/api";

/**
 * The project workspace (roadmap 7a, #102; lifecycle doc §3): everything in
 * the project listed by kind, with the create/import entry points (which
 * land IN the project — the create page's `?projectId=` variant) and the
 * add-reference action ("fork = add-to-project": reuse adds a reference,
 * never a copy). Per-artifact publish affordances stay on the artifact's own
 * page — the rows link there (the dataset page owns the 5b publish flow), so
 * the workspace never implies a bundle publish exists (that's 7b).
 *
 * The read is `projects.get` — creator-scoped server-side; null renders the
 * not-found card, so another user's project (and the drafts it carries) is
 * indistinguishable from a missing one.
 */
export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectWorkspacePage,
});

type Workspace = FunctionReturnType<typeof api.projects.get>;
type WorkspaceData = NonNullable<Workspace>;
type Artifact = WorkspaceData["artifacts"][number];

/** ConvexError / Error → user-facing message (the create.tsx extractor). */
function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Splits the membership rows by their declared kind — the workspace's section order. */
function groupByKind(artifacts: Artifact[]): {
  datasets: Artifact[];
  derived: Artifact[];
  maps: Artifact[];
} {
  const datasets: Artifact[] = [],
    derived: Artifact[] = [],
    maps: Artifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.artifactKind === "dataset") {
      datasets.push(artifact);
    } else if (artifact.artifactKind === "derived") {
      derived.push(artifact);
    } else {
      maps.push(artifact);
    }
  }
  return { datasets, derived, maps };
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
function missingLabel(kind: "dataset" | "derived" | "map"): string {
  if (kind === "dataset") {
    return "Deleted dataset";
  }
  return kind === "derived" ? "Deleted derived dataset" : "Deleted map";
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
  projectId,
  artifactId,
  artifactKind,
}: {
  projectId: string;
  artifactId: string;
  artifactKind: "dataset" | "derived" | "map";
}) {
  const remove = useMutation(api.projects.removeArtifact);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 text-muted-foreground hover:text-destructive"
      title="Remove from project (the artifact itself is not deleted)"
      aria-label="Remove from project"
      onClick={() => {
        const run = async () => {
          try {
            await remove({ artifactId, artifactKind, projectId });
            toast.success("Removed from project.");
          } catch (error) {
            toast.error(errorMessage(error));
          }
        };
        void run();
      }}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

function DatasetRow({ artifact, projectId }: { artifact: Artifact; projectId: string }) {
  if (artifact.state.kind !== "dataset") {
    return <MissingRow artifact={artifact} projectId={projectId} />;
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
          <span className="text-xs text-muted-foreground">{datasetRowCount(summary)}</span>
        </div>
        <p className="truncate text-sm font-medium">{summary.title}</p>
        {summary.description !== undefined && (
          <p className="truncate text-xs text-muted-foreground">{summary.description}</p>
        )}
      </Link>
      <RemoveButton
        artifactId={artifact.artifactId}
        artifactKind={artifact.artifactKind}
        projectId={projectId}
      />
    </Card>
  );
}

function DerivedRow({ artifact, projectId }: { artifact: Artifact; projectId: string }) {
  if (artifact.state.kind !== "derived") {
    return <MissingRow artifact={artifact} projectId={projectId} />;
  }
  const row = artifact.state.row;
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <DerivedDatasetBadge />
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
        projectId={projectId}
      />
    </Card>
  );
}

function MapRow({ artifact, projectId }: { artifact: Artifact; projectId: string }) {
  if (artifact.state.kind !== "map") {
    return <MissingRow artifact={artifact} projectId={projectId} />;
  }
  const map = artifact.state.map;
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      <Link
        to="/maps/$mapId"
        params={{ mapId: artifact.artifactId }}
        className="flex min-w-0 flex-1 flex-col gap-1 py-0"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="default">
            <MapIcon />
            Map
          </Badge>
        </div>
        <p className="truncate text-sm font-medium">{map.name}</p>
        {map.description !== undefined && (
          <p className="truncate text-xs text-muted-foreground">{map.description}</p>
        )}
      </Link>
      <RemoveButton
        artifactId={artifact.artifactId}
        artifactKind={artifact.artifactKind}
        projectId={projectId}
      />
    </Card>
  );
}

function MissingRow({ artifact, projectId }: { artifact: Artifact; projectId: string }) {
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
        projectId={projectId}
      />
    </Card>
  );
}

/**
 * The add-reference candidates for one kind: published datasets plus the
 * project owner's drafts (the drafts read is the all-users 5a read; the
 * workspace never widens it), saved derived specs, or maps — already-added
 * ids excluded. Module-level so the dialog stays under the complexity budget.
 */
function buildCandidates(
  kind: "dataset" | "derived" | "map",
  ownerAuthId: string,
  existingIds: Set<string>,
  lists: {
    datasets?: FunctionReturnType<typeof api.schemas.listSummaries>;
    drafts?: FunctionReturnType<typeof api.schemas.listDraftSummaries>;
    derived?: FunctionReturnType<typeof api.derivedDatasets.summaries>;
    maps?: FunctionReturnType<typeof api.maps.list>;
  },
): { id: string; label: string; hint?: string }[] {
  const candidates: { id: string; label: string; hint?: string }[] = [];
  if (kind === "dataset") {
    const ownedDrafts = (lists.drafts ?? []).filter((row) => row.createdBy === ownerAuthId);
    for (const row of [...(lists.datasets ?? []), ...ownedDrafts]) {
      candidates.push({ hint: row.description, id: row._id, label: row.title });
    }
  } else if (kind === "derived") {
    for (const row of lists.derived ?? []) {
      candidates.push({ hint: row.description, id: row._id, label: row.title });
    }
  } else {
    for (const row of lists.maps ?? []) {
      candidates.push({ hint: row.description, id: row._id, label: row.name });
    }
  }
  return candidates.filter((candidate) => !existingIds.has(candidate.id));
}

/**
 * The add-reference dialog: one candidate list per kind, opt-in subscriptions
 * (enabled only while open — the light-query convention). A click adds the
 * membership row and nothing else — no catalog row, no copy ("fork =
 * add-to-project").
 */
function AddReferenceDialog({
  projectId,
  ownerAuthId,
  existingIds,
  open,
  onOpenChange,
}: {
  projectId: string;
  ownerAuthId: string;
  existingIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useMutation(api.projects.addArtifact),
    [kind, setKind] = useState<"dataset" | "derived" | "map">("dataset"),
    [pendingId, setPendingId] = useState<string | undefined>(),
    datasets = useQuery({ ...convexQuery(api.schemas.listSummaries), enabled: open }).data,
    drafts = useQuery({ ...convexQuery(api.schemas.listDraftSummaries), enabled: open }).data,
    derived = useQuery({ ...convexQuery(api.derivedDatasets.summaries, {}), enabled: open }).data,
    maps = useQuery({ ...convexQuery(api.maps.list), enabled: open }).data,
    available = buildCandidates(kind, ownerAuthId, existingIds, {
      datasets,
      drafts,
      derived,
      maps,
    });

  const addArtifact = async (artifactId: string, artifactKind: "dataset" | "derived" | "map") => {
    setPendingId(artifactId);
    try {
      await add({ artifactId, artifactKind, projectId });
      toast.success("Added to project.");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
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
              ["map", "Maps"],
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
        {available.length === 0 ? (
          <p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing left to add here.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {available.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                disabled={pendingId !== undefined}
                onClick={() => {
                  void addArtifact(candidate.id, kind);
                }}
                className="flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
              >
                <span className="text-sm font-medium">{candidate.label}</span>
                {candidate.hint !== undefined && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {candidate.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function ProjectWorkspacePage() {
  const { projectId } = Route.useParams(),
    // The auth gate renders BEFORE the query state: anonymous callers' query
    // throws, and without this branch that shows as an infinite spinner.
    { isAuthenticated, isLoading: authLoading } = useConvexAuth(),
    workspace = useQuery({ ...convexQuery(api.projects.get, { projectId }) }).data,
    [addOpen, setAddOpen] = useState(false);

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
        <SignInPrompt subject="Projects are per-creator — sign in to see yours." />
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
              It may have been deleted — or it belongs to another user.
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
    grouped = groupByKind(artifacts),
    existingIds = new Set(artifacts.map((artifact) => artifact.artifactId)),
    empty = artifacts.length === 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <RouterButton variant="ghost" to="/projects" className="mb-4 -ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Projects
        </RouterButton>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-primary mb-1">{project.title}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center">
                <Calendar className="mr-1.5 h-3.5 w-3.5" />
                Created {new Date(project._creationTime).toLocaleDateString()}
              </span>
              <span>
                {artifacts.length} {artifacts.length === 1 ? "artifact" : "artifacts"}
              </span>
            </div>
            {project.description !== undefined && (
              <p className="mt-1 text-muted-foreground">{project.description}</p>
            )}
          </div>
          <div className="flex gap-2">
            {/* The in-project create/import entry point: the create page's
                ?projectId= variant lands the draft + membership atomically. */}
            <RouterButton to="/datasets/create" search={{ projectId }}>
              <Plus className="h-4 w-4 mr-2" />
              New dataset
            </RouterButton>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setAddOpen(true);
              }}
            >
              <ListPlus className="h-4 w-4 mr-2" />
              Add existing
            </Button>
          </div>
        </div>
      </div>

      {empty ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Database />
            </EmptyMedia>
            <EmptyTitle>This project is empty</EmptyTitle>
            <EmptyDescription>
              Create a dataset in the project, or add an existing one by reference.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <RouterButton to="/datasets/create" search={{ projectId }}>
                <Plus className="h-4 w-4 mr-2" />
                New dataset
              </RouterButton>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAddOpen(true);
                }}
              >
                <ListPlus className="h-4 w-4 mr-2" />
                Add existing
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {(
            [
              ["Datasets", grouped.datasets.length, "datasets"],
              ["Derived", grouped.derived.length, "derived"],
              ["Maps", grouped.maps.length, "maps"],
            ] as const
          ).map(([heading, count, kind]) =>
            count === 0 ? null : (
              <section key={kind}>
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                  {heading}{" "}
                  <span className="font-normal">
                    ({count} {count === 1 ? "artifact" : "artifacts"})
                  </span>
                </h2>
                <div className="flex flex-col gap-3">
                  {kind === "datasets" &&
                    grouped.datasets.map((artifact) => (
                      <DatasetRow key={artifact._id} artifact={artifact} projectId={projectId} />
                    ))}
                  {kind === "derived" &&
                    grouped.derived.map((artifact) => (
                      <DerivedRow key={artifact._id} artifact={artifact} projectId={projectId} />
                    ))}
                  {kind === "maps" &&
                    grouped.maps.map((artifact) => (
                      <MapRow key={artifact._id} artifact={artifact} projectId={projectId} />
                    ))}
                </div>
              </section>
            ),
          )}
        </div>
      )}

      <AddReferenceDialog
        projectId={projectId}
        ownerAuthId={project.createdBy}
        existingIds={existingIds}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </main>
  );
}
