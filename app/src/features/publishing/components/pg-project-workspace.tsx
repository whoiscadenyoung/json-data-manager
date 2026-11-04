import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Database,
  ListPlus,
  Loader2,
  Map as MapIcon,
  Rocket,
  Search,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PgDatasetTagsWithCount } from "#/features/catalog";
import { RouterButton } from "@/components/router-button";
import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import * as mapsStore from "@/lib/store/maps";
import * as projectsStore from "@/lib/store/projects";
import { latestBundleQueryOptions, listMembersQueryOptions } from "@/lib/store/publishing";

import { pgPublishProjectBundle } from "../lib/pg-bundle-publish";

/**
 * The Postgres project workspace (stage 4, #203; lifecycle doc §3) — the
 * working layer's container for PG-created projects: everything in the
 * project listed by kind, the add-reference action ("fork = add-to-project":
 * a reference, never a copy), and the one-press BUNDLE PUBLISH (collection
 * + maps + every referenced dataset through `publish_version`).
 *
 * Projects are per-creator PRIVATE (the shared-artifact exception): another
 * user's project reads exactly as a missing one, and this page renders the
 * same not-found card for both. Derived artifacts (the third kind the table
 * allows) have no PG publishing until stage 5 — the section renders with
 * that note when one is referenced, never silently skipped.
 */

/** The stale-press window (the syncRuns/publishAttempts value): a press whose checkpoint hasn't moved this long was abandoned by its browser, and pressing again RESUMES it (joining the running bundle). */
const STALE_PRESS_MS = 2 * 60 * 1000;

/** The not-found card — a foreign project (creator-only RLS) reads exactly as a missing one. */
function PgProjectNotFound() {
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

/** The signed-out gate (projects are per-creator private — the auth-gated stage). */
function PgProjectSignInPrompt() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Database />
          </EmptyMedia>
          <EmptyTitle>Sign in to continue</EmptyTitle>
          <EmptyDescription>Projects are per-creator — sign in to see yours.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/signin">Sign in</RouterButton>
        </EmptyContent>
      </Empty>
    </main>
  );
}

/** One project artifact row: link + remove; the label resolves from the loaded catalog lists, falling back to the honest "no longer exists" line. */
function PgArtifactRow({
  artifact,
  datasetsById,
  mapsById,
  onRemoved,
  projectId,
}: {
  artifact: { artifactId: string; artifactKind: "dataset" | "derived" | "map" };
  datasetsById: globalThis.Map<string, { lifecycle: string; title: string }>;
  mapsById: globalThis.Map<string, { name: string }>;
  onRemoved: () => void;
  projectId: string;
}) {
  const [removing, setRemoving] = useState(false),
    remove = async (): Promise<void> => {
      setRemoving(true);
      try {
        const outcome = await projectsStore.removeArtifact({
          artifactId: artifact.artifactId,
          projectId,
        });
        if (outcome.affected === 0) {
          toast.error("The reference didn't remove — you may not have access.");
          return;
        }
        toast.success("Removed from project.");
        onRemoved();
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setRemoving(false);
      }
    };
  const dataset =
      artifact.artifactKind === "dataset" ? datasetsById.get(artifact.artifactId) : undefined,
    map = artifact.artifactKind === "map" ? mapsById.get(artifact.artifactId) : undefined,
    exists = artifact.artifactKind === "derived" || dataset !== undefined || map !== undefined,
    label =
      artifact.artifactKind === "derived"
        ? "Derived dataset (stage 5 surface)"
        : dataset !== undefined
          ? dataset.title
          : map !== undefined
            ? map.name
            : "Deleted artifact";
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      {artifact.artifactKind === "dataset" && dataset !== undefined ? (
        <Link
          className="flex min-w-0 flex-1 flex-col gap-1 py-0"
          params={{ schemaId: artifact.artifactId }}
          to="/datasets/$schemaId"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              <Database className="h-3 w-3" />
              Dataset
            </Badge>
            {dataset.lifecycle === "draft" && (
              <Badge
                title="A draft — hidden from the catalog until it publishes."
                variant="secondary"
              >
                Draft
              </Badge>
            )}
          </div>
          <p className="truncate text-sm font-medium">{label}</p>
        </Link>
      ) : artifact.artifactKind === "map" && map !== undefined ? (
        <Link
          className="flex min-w-0 flex-1 flex-col gap-1 py-0"
          params={{ mapId: artifact.artifactId }}
          to="/maps/$mapId"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default">
              <MapIcon className="h-3 w-3" />
              Map
            </Badge>
          </div>
          <p className="truncate text-sm font-medium">{label}</p>
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-1 py-0">
          <p className={`truncate text-sm font-medium ${exists ? "" : "text-muted-foreground"}`}>
            {label}
          </p>
          {!exists && (
            <p className="text-xs text-muted-foreground">
              The referenced artifact no longer exists — remove the reference to clean up.
            </p>
          )}
        </div>
      )}
      <Button
        aria-label="Remove from project"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        disabled={removing}
        onClick={() => {
          void remove();
        }}
        size="icon"
        title="Remove from project (the artifact itself is not deleted)"
        variant="ghost"
      >
        {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </Button>
    </Card>
  );
}

/** One searchable candidate row (dataset or map) in the add sheet. */
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

/** The add-existing sheet: PG datasets and PG maps, already-added ids excluded — a reference, never a copy. */
function PgAddReferenceSheet({
  addedDatasetIds,
  addedMapIds,
  onAdded,
  onOpenChange,
  open,
  projectId,
}: {
  addedDatasetIds: Set<string>;
  addedMapIds: Set<string>;
  onAdded: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  const [search, setSearch] = useState(""),
    [pendingId, setPendingId] = useState<string>(),
    datasetsQuery = useQuery({ ...datasetsStore.listSummariesQueryOptions(), enabled: open }),
    mapsQuery = useQuery({ ...mapsStore.listQueryOptions(), enabled: open }),
    normalized = search.trim().toLowerCase(),
    datasetCandidates = (datasetsQuery.data ?? [])
      .filter((dataset) => !addedDatasetIds.has(dataset.id))
      .filter((dataset) =>
        normalized === "" ? true : dataset.title.toLowerCase().includes(normalized),
      ),
    mapCandidates = (mapsQuery.data ?? [])
      .filter((map) => !addedMapIds.has(map.id))
      .filter((map) => (normalized === "" ? true : map.name.toLowerCase().includes(normalized))),
    add = async (artifactId: string, artifactKind: "dataset" | "map"): Promise<void> => {
      setPendingId(artifactId);
      try {
        const outcome = await projectsStore.addArtifact({ artifactId, artifactKind, projectId });
        if (outcome.artifact === null) {
          toast.error("The reference didn't land — you may not have access.");
          return;
        }
        toast.success(
          artifactKind === "dataset"
            ? "Added to project — it now floats on this dataset's chain head (pin it from the dataset page)."
            : "Added to project.",
        );
        onAdded();
        onOpenChange(false);
      } catch (error) {
        // A duplicate (project, kind, artifact) rides the 23505 constraint's
        // message — shown verbatim.
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
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder="Search datasets and maps…"
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
                      void add(dataset.id, "dataset");
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
          <section className="flex flex-col gap-1">
            <p className="text-sm font-semibold">Maps</p>
            {mapCandidates.length === 0 ? (
              <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
                {mapsQuery.isPending ? "Loading maps…" : "No maps left to add."}
              </p>
            ) : (
              mapCandidates.map((map) => (
                <PgAddCandidateRow
                  disabled={pendingId !== undefined}
                  hint={map.description}
                  key={map.id}
                  onPick={() => {
                    void add(map.id, "map");
                  }}
                  title={map.name}
                />
              ))
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The workspace's bundle status line (the Convex page's shape): the live press, an interrupted one, the named failures, or the promoted collection link. Staleness reads the mount-time clock (react/purity) — the page remounts on return, which is exactly when an abandoned press should announce itself. */
function PgBundleStatusLine({ projectId }: { projectId: string }) {
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

/** The workspace body: the project's facts, the artifact sections, add/press actions. */
function PgProjectWorkspaceBody({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient(),
    projectQuery = useQuery(projectsStore.getQueryOptions({ projectId })),
    artifactsQuery = useQuery(projectsStore.listArtifactsQueryOptions({ projectId })),
    datasetsQuery = useQuery(datasetsStore.listSummariesQueryOptions()),
    mapsQuery = useQuery(mapsStore.listQueryOptions()),
    [addOpen, setAddOpen] = useState(false),
    [pressing, setPressing] = useState(false),
    invalidateAll = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:publishing"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:versions"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
    },
    press = async (): Promise<void> => {
      setPressing(true);
      try {
        const outcome = await pgPublishProjectBundle({ projectId });
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
        invalidateAll();
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setPressing(false);
      }
    };

  if (projectQuery.isPending) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (projectQuery.data === null || projectQuery.data === undefined) {
    return <PgProjectNotFound />;
  }
  const project = projectQuery.data,
    artifacts = artifactsQuery.data ?? [],
    datasetsById = new globalThis.Map(
      (datasetsQuery.data ?? []).map((dataset) => [
        dataset.id,
        { lifecycle: dataset.lifecycle, title: dataset.title },
      ]),
    ),
    mapsById = new globalThis.Map(
      (mapsQuery.data ?? []).map((map) => [map.id, { name: map.name }]),
    ),
    addedDatasetIds = new Set(
      artifacts
        .filter((artifact) => artifact.artifactKind === "dataset")
        .map((artifact) => artifact.artifactId),
    ),
    addedMapIds = new Set(
      artifacts
        .filter((artifact) => artifact.artifactKind === "map")
        .map((artifact) => artifact.artifactId),
    ),
    datasetSection = artifacts.filter((artifact) => artifact.artifactKind === "dataset"),
    derivedSection = artifacts.filter((artifact) => artifact.artifactKind === "derived"),
    mapSection = artifacts.filter((artifact) => artifact.artifactKind === "map");
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <RouterButton className="-ml-2 mb-4" to="/projects" variant="ghost">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Projects
        </RouterButton>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="mb-1 text-3xl font-bold text-primary">{project.title}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>
                {artifacts.length} {artifacts.length === 1 ? "artifact" : "artifacts"}
              </span>
            </div>
            {project.description !== null && (
              <p className="mt-1 text-muted-foreground">{project.description}</p>
            )}
            <PgBundleStatusLine projectId={projectId} />
          </div>
          <div className="flex gap-2">
            <Button
              disabled={pressing || artifacts.length === 0}
              onClick={() => {
                void press();
              }}
              title={
                artifacts.length === 0
                  ? "Nothing to publish yet — add a dataset or a map with layers first."
                  : undefined
              }
              type="button"
            >
              <Rocket className="mr-2 h-4 w-4" />
              {pressing ? "Publishing…" : "Publish bundle"}
            </Button>
            <Button
              onClick={() => {
                setAddOpen(true);
              }}
              type="button"
              variant="outline"
            >
              <ListPlus className="mr-2 h-4 w-4" />
              Add existing
            </Button>
          </div>
        </div>
      </div>

      {artifacts.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Database />
            </EmptyMedia>
            <EmptyTitle>This project is empty</EmptyTitle>
            <EmptyDescription>
              Add an existing dataset or map by reference — nothing is copied.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => {
                setAddOpen(true);
              }}
              type="button"
            >
              <ListPlus className="mr-2 h-4 w-4" />
              Add existing
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {datasetSection.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                Datasets{" "}
                <span className="font-normal">
                  ({datasetSection.length} {datasetSection.length === 1 ? "artifact" : "artifacts"})
                </span>
              </h2>
              <div className="flex flex-col gap-3">
                {datasetSection.map((artifact) => (
                  <PgArtifactRow
                    artifact={artifact}
                    datasetsById={datasetsById}
                    key={artifact.id}
                    mapsById={mapsById}
                    onRemoved={invalidateAll}
                    projectId={projectId}
                  />
                ))}
              </div>
            </section>
          )}
          {derivedSection.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                Derived{" "}
                <span className="font-normal">
                  ({derivedSection.length} {derivedSection.length === 1 ? "artifact" : "artifacts"})
                </span>
              </h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Derived dataset publishing arrives in stage 5.
              </p>
              <div className="flex flex-col gap-3">
                {derivedSection.map((artifact) => (
                  <PgArtifactRow
                    artifact={artifact}
                    datasetsById={datasetsById}
                    key={artifact.id}
                    mapsById={mapsById}
                    onRemoved={invalidateAll}
                    projectId={projectId}
                  />
                ))}
              </div>
            </section>
          )}
          {mapSection.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                Maps{" "}
                <span className="font-normal">
                  ({mapSection.length} {mapSection.length === 1 ? "artifact" : "artifacts"})
                </span>
              </h2>
              <div className="flex flex-col gap-3">
                {mapSection.map((artifact) => (
                  <PgArtifactRow
                    artifact={artifact}
                    datasetsById={datasetsById}
                    key={artifact.id}
                    mapsById={mapsById}
                    onRemoved={invalidateAll}
                    projectId={projectId}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <PgAddReferenceSheet
        addedDatasetIds={addedDatasetIds}
        addedMapIds={addedMapIds}
        onAdded={invalidateAll}
        onOpenChange={setAddOpen}
        open={addOpen}
        projectId={projectId}
      />
    </main>
  );
}

/** The Postgres edition of `/projects/$projectId` — mounted by the route when the id was minted by the PG backend. */
export function PgProjectWorkspace({ projectId }: { projectId: string }) {
  const { isLoading, session } = useSession();
  if (isLoading) {
    return (
      <div className="flex min-h-100 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (session === null) {
    return <PgProjectSignInPrompt />;
  }
  return <PgProjectWorkspaceBody projectId={projectId} />;
}
