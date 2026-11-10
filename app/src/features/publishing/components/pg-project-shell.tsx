import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState, type LinkProps } from "@tanstack/react-router";
import {
  Database,
  FlaskConical,
  Globe,
  Import,
  LayoutDashboard,
  LayoutGrid,
  ListPlus,
  Map as MapIcon,
  MapPlus,
  Menu,
  Network,
  PanelLeftClose,
  Plus,
  Rocket,
  Settings,
  Upload,
  Users,
} from "lucide-react";
import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";

import type { VisibilityLevel } from "#/lib/store/visibility";
import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import * as appsStore from "@/lib/store/apps";
import * as datasetsStore from "@/lib/store/datasets";
import * as mapsStore from "@/lib/store/maps";
import { listMineQueryOptions, resolveMyRole, ROLE_LABELS } from "@/lib/store/project-members";
import * as projectsStore from "@/lib/store/projects";

import { pgPublishProjectBundle } from "../lib/pg-bundle-publish";
import { VIEWER_REASON } from "../lib/pg-viewer-posture";
import { ProjectShellContext } from "./pg-project-context";
import {
  PgAddReferenceSheet,
  PgProjectNotFound,
  PgProjectSignInPrompt,
  type CreateAppSlot,
} from "./pg-project-workspace";
import { PgPublishBundleDialog } from "./pg-publish-bundle-dialog";

/**
 * The project workspace SHELL (issue #271): a persistent toolbar + left sidebar
 * around every `/projects/$projectId/*` route. The shell owns the project's
 * reads (project, role, catalog, maps, apps — one realtime-fed set of queries
 * for the sidebar's counts and lists), the dialogs the quick-create buttons
 * open (new map, new app, add-existing, publish bundle) and hands sections the
 * shared state through context. Sections render in the content area.
 */

const RAIL_EVENT = "jdm:project-sidebar";

/** Full-bleed editors (map editor) default the sidebar to the icon rail. */
function isEditorPath(pathname: string): boolean {
  return pathname.includes("/maps/") || pathname.includes("/apps/");
}

function railKey(editor: boolean): string {
  return `jdm.projectSidebar.rail.${editor ? "editor" : "page"}`;
}

function readRail(editor: boolean): boolean {
  try {
    const stored = globalThis.localStorage.getItem(railKey(editor));
    return stored === null ? editor : stored === "1";
  } catch {
    return editor;
  }
}

function subscribeRail(listener: () => void): () => void {
  globalThis.addEventListener(RAIL_EVENT, listener);
  globalThis.addEventListener("storage", listener);
  return () => {
    globalThis.removeEventListener(RAIL_EVENT, listener);
    globalThis.removeEventListener("storage", listener);
  };
}

/** The persisted rail preference: per user (localStorage), one value for editors and one for pages. */
function useRail(editor: boolean): [boolean, (next: boolean) => void] {
  const rail = useSyncExternalStore(
    subscribeRail,
    () => readRail(editor),
    () => editor,
  );
  return [
    rail,
    (next) => {
      try {
        globalThis.localStorage.setItem(railKey(editor), next ? "1" : "0");
      } catch {
        // Storage can be blocked; the toggle just doesn't persist.
      }
      globalThis.dispatchEvent(new Event(RAIL_EVENT));
    },
  ];
}

interface NavItemProps {
  count?: number;
  icon: ComponentType<{ className?: string }>;
  label: string;
  rail: boolean;
  linkProps: LinkProps;
  active: boolean;
}

/** One sidebar entry: label + count when expanded, icon-only (titled) in the rail. */
function NavItem({ active, count, icon: Icon, label, linkProps, rail }: NavItemProps) {
  return (
    <Link
      {...linkProps}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
        active ? "bg-primary/10 font-medium text-primary" : "text-foreground"
      } ${rail ? "justify-center" : ""}`}
      title={label}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {rail ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count === undefined ? null : (
            <span className="text-xs text-muted-foreground">{count}</span>
          )}
        </>
      )}
    </Link>
  );
}

function NavGroup({
  children,
  label,
  rail,
}: {
  children: ReactNode;
  label: string;
  rail: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {rail ? (
        <div className="mx-2 my-1 border-t" />
      ) : (
        <p className="px-2 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
      )}
      {children}
    </div>
  );
}

/** Section label for the breadcrumb, from the pathname below the project. */
function sectionLabel(rest: string, name: string | undefined): string {
  if (rest.startsWith("/maps/")) {
    return name ?? "Map";
  }
  if (rest.startsWith("/apps/")) {
    return name ?? "App";
  }
  if (rest.startsWith("/datasets/")) {
    return name ?? "Dataset";
  }
  if (rest.startsWith("/views/")) {
    return name ?? "View";
  }
  const labels: Record<string, string> = {
    "": "Overview",
    "/analysis": "Analysis",
    "/catalog": "Catalog",
    "/create": "Import",
    "/lineage": "Lineage",
    "/members": "Members",
    "/publish": "Publish",
    "/settings": "Settings",
  };
  return labels[rest] ?? "Overview";
}

// The shell composes the project's reads, sidebar, toolbar and shell-owned
// dialogs once for every project route; the branches are load/denied states.
// oxlint-disable-next-line eslint/complexity -- one shell composition, read top to bottom.
function PgProjectShellBody({
  children,
  createAppDialog,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
  createAppDialog?: CreateAppSlot;
}) {
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    { session } = useSession(),
    userId = session === null ? "" : session.user.id,
    pathname = useRouterState({ select: (state) => state.location.pathname }),
    base = `/projects/${projectId}`,
    rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/$/, "") : "",
    editor = isEditorPath(rest),
    [rail, setRail] = useRail(editor),
    projectQuery = useQuery(projectsStore.getQueryOptions({ projectId })),
    catalogQuery = useQuery(projectsStore.listCatalogQueryOptions({ projectId })),
    myMembershipQuery = useQuery(listMineQueryOptions({ userId })),
    mapsQuery = useQuery({ ...mapsStore.listForProjectQueryOptions({ projectId }) }),
    appsQuery = useQuery({ ...appsStore.listForProjectQueryOptions({ projectId }) }),
    datasetId =
      rest.startsWith("/datasets/") || rest.startsWith("/views/") ? (rest.split("/")[2] ?? "") : "",
    datasetQuery = useQuery({
      ...datasetsStore.getQueryOptions({ datasetId }),
      enabled: datasetId !== "",
    }),
    [addOpen, setAddOpen] = useState(false),
    [pressOpen, setPressOpen] = useState(false),
    [pressing, setPressing] = useState(false),
    [mapOpen, setMapOpen] = useState(false),
    [appOpen, setAppOpen] = useState(false),
    [mapName, setMapName] = useState(""),
    [creatingMap, setCreatingMap] = useState(false),
    invalidateAll = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:publishing"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:versions"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
    },
    press = async (visibility: VisibilityLevel): Promise<void> => {
      setPressing(true);
      try {
        const outcome = await pgPublishProjectBundle({ projectId, visibility });
        if (outcome.status === "completed" && outcome.visibilityCappedBy > 0) {
          toast.warning(
            "Project published — the collection and every referenced dataset are in the catalog, but the share is capped by artifacts you can't widen. Check the bundle's visibility.",
          );
        } else if (outcome.status === "completed") {
          toast.success(
            `Project published at “${visibility}” — the collection and every referenced dataset are in the catalog.`,
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
    },
    createMap = async (): Promise<void> => {
      setCreatingMap(true);
      try {
        const mapId = await mapsStore.create({
          name: mapName.trim() === "" ? "New map" : mapName.trim(),
          projectId,
        });
        if (mapId === null) {
          toast.error("The map didn't create — you may not have access.");
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
        setMapOpen(false);
        toast.success("Map created — opening the editor.");
        await navigate({ params: { mapId, projectId }, to: "/projects/$projectId/maps/$mapId" });
      } catch (error) {
        toast.error(errorMessage(error, "Failed to create the map."));
      } finally {
        setCreatingMap(false);
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
    myRole = resolveMyRole(myMembershipQuery.data, projectId, project.createdBy, userId),
    canEdit = myRole !== "viewer",
    catalog = catalogQuery.data ?? [],
    maps = mapsQuery.data ?? [],
    apps = appsQuery.data ?? [],
    addedDatasetIds = new Set(
      catalog
        .filter((row) => row.artifact.artifactKind === "dataset")
        .map((r) => r.artifact.artifactId),
    ),
    currentMap = maps.find((map) => rest === `/maps/${map.id}`),
    currentApp = apps.find((app) => rest.startsWith(`/apps/${app.id}`)),
    currentDataset = datasetQuery.data === null ? undefined : datasetQuery.data,
    currentName =
      currentMap === undefined
        ? currentApp === undefined
          ? currentDataset === undefined
            ? undefined
            : currentDataset.title
          : currentApp.title
        : currentMap.name,
    onDataset = datasetId !== "",
    section = sectionLabel(rest, currentName),
    onCatalog = rest === "/catalog" || rest === "/create" || rest.startsWith("/views/"),
    CreateAppDialog = createAppDialog,
    pressTitle = !canEdit
      ? VIEWER_REASON
      : catalog.length === 0
        ? "Nothing to publish yet — add a dataset first."
        : undefined;

  return (
    <ProjectShellContext.Provider
      value={{
        canEdit,
        catalog,
        invalidateAll,
        myRole,
        openAdd: () => {
          setAddOpen(true);
        },
        openNewApp: () => {
          setAppOpen(true);
        },
        openNewMap: () => {
          setMapName("");
          setMapOpen(true);
        },
        openPress: () => {
          setPressOpen(true);
        },
        pressing,
        project,
        projectId,
      }}
    >
      <div className="flex min-h-[calc(100vh-4rem)] flex-col bg-background">
        <div
          className="flex min-h-12 flex-wrap items-center gap-3 border-b px-4 py-2"
          data-testid="project-toolbar"
        >
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <Link className="text-muted-foreground hover:text-foreground" to="/projects">
              Projects
            </Link>
            <span className="text-muted-foreground">/</span>
            <Link
              className="max-w-48 truncate text-muted-foreground hover:text-foreground"
              params={{ projectId }}
              to="/projects/$projectId"
            >
              {project.title}
            </Link>
            <span className="text-muted-foreground">/</span>
            {onDataset ? (
              <>
                <Link
                  className="text-muted-foreground hover:text-foreground"
                  params={{ projectId }}
                  to="/projects/$projectId/catalog"
                >
                  Catalog
                </Link>
                <span className="text-muted-foreground">/</span>
              </>
            ) : null}
            <span className="max-w-48 truncate font-medium">{section}</span>
          </nav>
          <Badge title={`Your access to this project (${ROLE_LABELS[myRole]}).`} variant="outline">
            {ROLE_LABELS[myRole]}
          </Badge>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {onCatalog ? (
              <>
                <Button
                  disabled={!canEdit}
                  onClick={() => {
                    setAddOpen(true);
                  }}
                  size="sm"
                  title={canEdit ? undefined : VIEWER_REASON}
                  variant="outline"
                >
                  <ListPlus className="mr-1 h-3.5 w-3.5" />
                  Add existing
                </Button>
                <Link
                  className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
                  params={{ projectId }}
                  to="/projects/$projectId/create"
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Import
                </Link>
              </>
            ) : null}
            {currentDataset !== undefined && currentDataset.lifecycle === "published" ? (
              <Link
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
                params={{ schemaId: currentDataset.id }}
                title="Open the public catalog version of this dataset"
                to="/datasets/$schemaId"
              >
                <Globe className="mr-1 h-3.5 w-3.5" />
                Public version
              </Link>
            ) : null}
            <Link
              aria-label="New dataset"
              className="inline-flex h-8 items-center rounded-md border px-2 text-sm hover:bg-muted"
              params={{ projectId }}
              title="Create or import a dataset inside this project"
              to="/projects/$projectId/create"
            >
              <Database className="h-3.5 w-3.5" />
              <Plus className="h-3 w-3" />
            </Link>
            <Button
              aria-label="New map"
              disabled={!canEdit}
              onClick={() => {
                setMapName("");
                setMapOpen(true);
              }}
              size="sm"
              title={canEdit ? "New map" : VIEWER_REASON}
              variant="outline"
            >
              <MapIcon className="h-3.5 w-3.5" />
              <Plus className="h-3 w-3" />
            </Button>
            <Button
              aria-label="New app"
              disabled={!canEdit || CreateAppDialog === undefined}
              onClick={() => {
                setAppOpen(true);
              }}
              size="sm"
              title={canEdit ? "New app" : VIEWER_REASON}
              variant="outline"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              <Plus className="h-3 w-3" />
            </Button>
            <Button
              disabled={pressing || catalog.length === 0 || !canEdit}
              onClick={() => {
                setPressOpen(true);
              }}
              size="sm"
              title={pressTitle}
              type="button"
            >
              <Rocket className="mr-1 h-3.5 w-3.5" />
              {pressing ? "Publishing…" : "Publish bundle"}
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-wrap md:flex-nowrap">
          <aside
            aria-label="Project navigation"
            className={`shrink-0 border-r bg-muted/30 p-2 ${rail ? "w-full md:w-[52px]" : "w-full md:w-[248px]"}`}
            data-rail={rail ? "true" : "false"}
            data-testid="project-sidebar"
          >
            <Button
              aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
              className={rail ? "mx-auto flex" : ""}
              onClick={() => {
                setRail(!rail);
              }}
              size="icon"
              title={rail ? "Expand sidebar" : "Collapse sidebar"}
              variant="ghost"
            >
              {rail ? <Menu className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
            <nav className="flex flex-col gap-1">
              <NavItem
                active={rest === ""}
                icon={LayoutGrid}
                label="Overview"
                rail={rail}
                linkProps={{
                  activeOptions: { exact: true },
                  params: { projectId },
                  to: "/projects/$projectId",
                }}
              />
              <NavGroup label="Data" rail={rail}>
                <NavItem
                  active={rest === "/catalog" || onDataset}
                  count={catalog.length}
                  icon={Database}
                  label="Catalog"
                  rail={rail}
                  linkProps={{ params: { projectId }, to: "/projects/$projectId/catalog" }}
                />
                <NavItem
                  active={rest === "/analysis"}
                  icon={FlaskConical}
                  label="Analysis"
                  linkProps={{ params: { projectId }, to: "/projects/$projectId/analysis" }}
                  rail={rail}
                />
                <NavItem
                  active={rest === "/create"}
                  icon={Import}
                  label="Import"
                  rail={rail}
                  linkProps={{ params: { projectId }, to: "/projects/$projectId/create" }}
                />
              </NavGroup>
              <NavGroup label="Maps" rail={rail}>
                {maps.map((map) => (
                  <NavItem
                    active={rest === `/maps/${map.id}`}
                    icon={MapIcon}
                    key={map.id}
                    label={map.name}
                    rail={rail}
                    linkProps={{
                      params: { mapId: map.id, projectId },
                      to: "/projects/$projectId/maps/$mapId",
                    }}
                  />
                ))}
                {canEdit ? (
                  <button
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted ${rail ? "justify-center" : ""}`}
                    onClick={() => {
                      setMapName("");
                      setMapOpen(true);
                    }}
                    title="New map"
                    type="button"
                  >
                    <MapPlus className="h-4 w-4 shrink-0" />
                    {rail ? null : "New map"}
                  </button>
                ) : null}
              </NavGroup>
              <NavGroup label="Apps" rail={rail}>
                {apps.map((app) => (
                  <NavItem
                    active={rest.startsWith(`/apps/${app.id}`)}
                    icon={LayoutDashboard}
                    key={app.id}
                    label={app.title}
                    rail={rail}
                    linkProps={{
                      params: { appId: app.id, projectId },
                      to: "/projects/$projectId/apps/$appId/edit",
                    }}
                  />
                ))}
                {canEdit && CreateAppDialog !== undefined ? (
                  <button
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted ${rail ? "justify-center" : ""}`}
                    onClick={() => {
                      setAppOpen(true);
                    }}
                    title="New app"
                    type="button"
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    {rail ? null : "New app"}
                  </button>
                ) : null}
              </NavGroup>
              <NavGroup label="Project" rail={rail}>
                <NavItem
                  active={rest === "/lineage"}
                  icon={Network}
                  label="Lineage"
                  rail={rail}
                  linkProps={{ params: { projectId }, to: "/projects/$projectId/lineage" }}
                />
                <NavItem
                  active={rest === "/publish"}
                  icon={Rocket}
                  label="Publish"
                  rail={rail}
                  linkProps={{ params: { projectId }, to: "/projects/$projectId/publish" }}
                />
                <NavItem
                  active={rest === "/settings"}
                  icon={Settings}
                  label="Settings"
                  linkProps={{ params: { projectId }, to: "/projects/$projectId/settings" }}
                  rail={rail}
                />
                <NavItem
                  active={rest === "/members"}
                  icon={Users}
                  label="Members"
                  rail={rail}
                  linkProps={{ params: { projectId }, to: "/projects/$projectId/members" }}
                />
              </NavGroup>
            </nav>
          </aside>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </div>

      <PgPublishBundleDialog
        onConfirm={(visibility) => {
          void press(visibility);
        }}
        onOpenChange={setPressOpen}
        open={pressOpen}
        projectId={projectId}
      />
      <PgAddReferenceSheet
        addedDatasetIds={addedDatasetIds}
        onAdded={invalidateAll}
        onOpenChange={setAddOpen}
        open={addOpen}
        projectId={projectId}
      />
      <Sheet onOpenChange={setMapOpen} open={mapOpen}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>New map</SheetTitle>
            <SheetDescription>
              Name is the only required field — the editor opens right after.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-4 p-6">
            <Input
              onChange={(event) => {
                setMapName(event.target.value);
              }}
              placeholder="Parks overview"
              value={mapName}
            />
            <Button
              disabled={creatingMap}
              onClick={() => {
                void createMap();
              }}
            >
              {creatingMap ? "Creating…" : "Create and open"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      {CreateAppDialog === undefined ? null : (
        <CreateAppDialog
          onOpenChange={setAppOpen}
          onSaved={async (appId) => {
            void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
            await navigate({
              params: { appId, projectId },
              to: "/projects/$projectId/apps/$appId/edit",
            });
          }}
          open={appOpen}
          projectId={projectId}
        />
      )}
    </ProjectShellContext.Provider>
  );
}

/** The shell: session gate, then the body (project not-found renders without chrome). */
export function PgProjectShell({
  children,
  createAppDialog,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
  createAppDialog?: CreateAppSlot;
}) {
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
  return (
    <PgProjectShellBody createAppDialog={createAppDialog} projectId={projectId}>
      {children}
    </PgProjectShellBody>
  );
}
