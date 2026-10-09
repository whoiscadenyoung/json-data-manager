import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FolderKanban, MapIcon, Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";

/**
 * The project-map targets the "add to project map" sheet offers (phase 3 of
 * the project-workspace design, ADR 0012 — standalone maps are retired; a
 * map exists only inside a project). A DATASET target auto-layers itself
 * onto the chosen map (one owned data layer, default style); a
 * COLLECTION/GROUP target expands to its geospatial datasets and auto-layers
 * EACH — "add all datasets from collection" — with the skipped (no-geometry)
 * datasets reported in the toast, never silently dropped.
 */
type AddToMapTarget = {
  targetId: string;
  targetType: "collection" | "dataset" | "group";
  targetName: string;
};

type ProjectSummary = FunctionReturnType<typeof api.projects.list>[number];
type MapSummary = FunctionReturnType<typeof api.projectMaps.list>[number];

/** The toast copy for one completed add — the dataset arm and the expand arm differ. */
function addedMessage(
  target: AddToMapTarget,
  outcome: { added: number; skipped: number },
  mapName: string,
): string {
  if (target.targetType === "dataset") {
    return `Added "${target.targetName}" to map "${mapName}" as its own layer.`;
  }
  const skipped =
    outcome.skipped === 0
      ? ""
      : ` — ${outcome.skipped} dataset${outcome.skipped === 1 ? "" : "s"} skipped (no geometry)`;
  return `Added ${outcome.added} ${
    outcome.added === 1 ? "layer" : "layers"
  } from "${target.targetName}" to map "${mapName}"${skipped}.`;
}

/** The search-filtered subset of one project's maps. */
function visibleMapsOf(maps: MapSummary[] | undefined, search: string): MapSummary[] {
  if (maps === undefined) {
    return [];
  }
  const normalized = search.trim().toLowerCase();
  return normalized === ""
    ? maps
    : maps.filter((map) => map.name.toLowerCase().includes(normalized));
}

/** The project picker — every project the viewer belongs to, one click selects. */
function ProjectPicker({
  onSelect,
  projects,
  selectedId,
}: {
  onSelect: (projectId: string) => void;
  projects: ProjectSummary[];
  selectedId: string | undefined;
}) {
  if (projects.length === 0) {
    return (
      <Empty className="min-h-24 border">
        <EmptyTitle>No projects yet</EmptyTitle>
        <EmptyDescription>Create a project first — maps live inside projects.</EmptyDescription>
      </Empty>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {projects.map((project) => (
        <Button
          key={project._id}
          type="button"
          size="sm"
          variant={selectedId === project._id ? "secondary" : "ghost"}
          onClick={() => {
            onSelect(project._id);
          }}
        >
          <FolderKanban className="h-3.5 w-3.5" />
          {project.title}
        </Button>
      ))}
    </div>
  );
}

/** The new-map form (the title is the only required field — the button is live and the blank name is the server's friendly refusal, surfaced in the toast). */
function NewMapSection({
  isPending,
  newName,
  onNameChange,
  onCreate,
}: {
  isPending: boolean;
  newName: string;
  onNameChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-md border p-3" aria-label="New map">
      <Label htmlFor="add-to-map-new-name">New map</Label>
      <p className="text-xs text-muted-foreground">
        Creates a map in the selected project and layers the target onto it.
      </p>
      <div className="flex gap-2">
        <Input
          id="add-to-map-new-name"
          value={newName}
          onChange={(e) => {
            onNameChange(e.target.value);
          }}
          placeholder="Map name"
        />
        <Button variant="outline" disabled={isPending} onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          {isPending ? "Creating…" : "Create & add"}
        </Button>
      </div>
    </section>
  );
}

/** One project's existing maps, searchable, with per-map add buttons. */
function ProjectMapsSection({
  maps,
  onAdd,
  pendingKey,
  search,
  onSearchChange,
}: {
  maps: MapSummary[];
  onAdd: (map: MapSummary) => void;
  pendingKey: string | undefined;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label="Existing maps">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            onSearchChange(e.target.value);
          }}
          placeholder="Search maps…"
          className="pl-7"
        />
      </div>
      <ul className="flex flex-col gap-1">
        {maps.map((map) => (
          <li
            key={map._id}
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <MapIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{map.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {map.layerCount} {map.layerCount === 1 ? "layer" : "layers"}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={pendingKey !== undefined}
              onClick={() => {
                onAdd(map);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {pendingKey === map._id ? "Adding…" : "Add"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Side panel for adding something (a dataset, collection, or group) to a
 * PROJECT map: pick one of the project's existing maps, or type a name to
 * create a new map in that project with this target layered onto it. The
 * project is picked first (maps live inside projects now).
 */
export function AddToMapSheet({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AddToMapTarget;
}) {
  const projects = useQuery({ ...convexQuery(api.projects.list, {}), enabled: open }).data,
    [projectId, setProjectId] = useState<string>(),
    maps = useQuery({
      ...convexQuery(api.projectMaps.list, { projectId: projectId ?? "" }),
      enabled: open && projectId !== undefined,
    }).data,
    addDataset = useMutation(api.projectMaps.addDatasetToMap),
    addAll = useMutation(api.projectMaps.addAllDatasets),
    createMap = useMutation(api.projectMaps.create),
    [search, setSearch] = useState(""),
    [newName, setNewName] = useState(""),
    // Which add is in flight — a map id, or "__new__" for create-and-add.
    [pendingKey, setPendingKey] = useState<string | undefined>(),
    visible = visibleMapsOf(maps, search);

  const runAdd = async (mapId: string, mapName: string) => {
    setPendingKey(mapId);
    try {
      if (target.targetType === "dataset") {
        await addDataset({ datasetId: target.targetId, mapId });
        toast.success(addedMessage(target, { added: 1, skipped: 0 }, mapName));
      } else {
        const outcome = await addAll({
          collectionId: target.targetType === "collection" ? target.targetId : undefined,
          groupId: target.targetType === "group" ? target.targetId : undefined,
          mapId,
        });
        toast.success(addedMessage(target, outcome, mapName));
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to add to map."));
    } finally {
      setPendingKey(undefined);
    }
  };

  const handleCreateAndAdd = async () => {
    const name = newName.trim();
    if (name === "") {
      toast.error("Give the map a name.");
      return;
    }
    if (projectId === undefined) {
      toast.error("Pick the project the map belongs to.");
      return;
    }
    setPendingKey("__new__");
    try {
      const mapId = await createMap({ name, projectId });
      await runAdd(mapId, name);
      toast.success(`Created map "${name}" in the selected project.`);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to create map."));
      setPendingKey(undefined);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
          setNewName("");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add to project map</SheetTitle>
          <SheetDescription>
            {target.targetType === "dataset"
              ? `Add "${target.targetName}" to one of your project's maps as a layer.`
              : `Add every dataset from "${target.targetName}" to a project map, one layer each.`}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <section className="flex flex-col gap-2" aria-label="Project">
            <Label htmlFor="add-to-map-project">Project</Label>
            {projects === undefined ? (
              <div className="flex justify-center py-4">
                <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            ) : (
              <ProjectPicker onSelect={setProjectId} projects={projects} selectedId={projectId} />
            )}
          </section>

          {projectId !== undefined && (
            <>
              <NewMapSection
                isPending={pendingKey === "__new__"}
                newName={newName}
                onNameChange={setNewName}
                onCreate={() => {
                  void handleCreateAndAdd();
                }}
              />
              {maps === undefined ? (
                <div className="flex justify-center py-8">
                  <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
                </div>
              ) : visible.length === 0 ? (
                <Empty className="min-h-32 border">
                  <EmptyTitle>No maps yet</EmptyTitle>
                  <EmptyDescription>Name your first map above to get started.</EmptyDescription>
                </Empty>
              ) : (
                <ProjectMapsSection
                  maps={visible}
                  onAdd={(map) => {
                    void runAdd(map._id, map.name);
                  }}
                  pendingKey={pendingKey}
                  search={search}
                  onSearchChange={setSearch}
                />
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
