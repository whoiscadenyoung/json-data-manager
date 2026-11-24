import { Badge } from "@caden/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@caden/ui/components/breadcrumb";
import { Button } from "@caden/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { Separator } from "@caden/ui/components/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@caden/ui/components/sidebar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState, type LinkProps } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Database,
  FlaskConical,
  FolderKanban,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  Map as MapIcon,
  Network,
  Plus,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";

import type { VisibilityLevel } from "#/lib/store/visibility";
import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import * as appsStore from "@/lib/store/apps";
import * as datasetsStore from "@/lib/store/datasets";
import * as mapsStore from "@/lib/store/maps";
import {
  listMineQueryOptions,
  resolveMyRole,
  ROLE_LABELS,
  type ProjectRole,
} from "@/lib/store/project-members";
import * as projectsStore from "@/lib/store/projects";

import { pgPublishProjectBundle } from "../lib/pg-bundle-publish";
import { VIEWER_REASON } from "../lib/pg-viewer-posture";
import { NewMapDialog } from "./new-map-dialog";
import { ProjectShellContext } from "./pg-project-context";
import {
  PgAddReferenceSheet,
  PgProjectNotFound,
  PgProjectSignInPrompt,
  type CreateAppSlot,
} from "./pg-project-workspace";
import { PgPublishBundleDialog } from "./pg-publish-bundle-dialog";

/**
 * The project workspace SHELL (issue #271, restyled 2026-11-24 after the shadcn
 * sidebar block): a full-height collapsible sidebar around every
 * `/projects/$projectId/*` route. The sidebar header is the project SWITCHER
 * (jump between projects from anywhere in one), and the toolbar — breadcrumb
 * trail + sidebar toggle + quick-create — moved into the content area so the
 * sidebar gets the full vertical space. The shell owns the project's reads
 * (project, role, catalog, maps, apps — one realtime-fed set of queries for
 * the sidebar's counts and lists), the dialogs the quick-create buttons open
 * (new map, new app, add-existing, publish bundle) and hands sections the
 * shared state through context. Sections render in the content area.
 */

const RAIL_EVENT = "jdm:project-sidebar";

/** Full-bleed editors (map editor, view editor) default the sidebar to the icon rail. */
function isEditorPath(pathname: string): boolean {
  return pathname.includes("/maps/") || pathname.includes("/apps/") || pathname.includes("/views/");
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

/** The persisted rail preference (per user, one value for editors and one for pages) drives the sidebar's controlled open state. */
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

/** Every project route a switcher jump can land on: the section roots (detail paths collapse to their section). */
const PROJECT_SECTIONS = [
  { key: "", to: "/projects/$projectId" },
  { key: "apps", to: "/projects/$projectId/apps" },
  { key: "catalog", to: "/projects/$projectId/catalog" },
  { key: "create", to: "/projects/$projectId/create" },
  { key: "lineage", to: "/projects/$projectId/lineage" },
  { key: "maps", to: "/projects/$projectId/maps" },
  { key: "members", to: "/projects/$projectId/members" },
  { key: "publish", to: "/projects/$projectId/publish" },
  { key: "scratch", to: "/projects/$projectId/scratch" },
  { key: "settings", to: "/projects/$projectId/settings" },
] as const;

type ProjectSection = (typeof PROJECT_SECTIONS)[number]["key"];
type ProjectSectionTo = (typeof PROJECT_SECTIONS)[number]["to"];

/** The route literal for one section key. */
function sectionTo(section: ProjectSection): ProjectSectionTo {
  const match = PROJECT_SECTIONS.find((row) => row.key === section);
  return match === undefined ? PROJECT_SECTIONS[0].to : match.to;
}

/** The section another project should open on when jumped to from the current path: detail paths collapse to their section root (a dataset/view under Catalog, a map under Maps, an app under Apps). */
function switcherSectionOf(rest: string): ProjectSection {
  if (rest.startsWith("/datasets/") || rest.startsWith("/views/")) {
    return "catalog";
  }
  if (rest.startsWith("/maps/")) {
    return "maps";
  }
  if (rest.startsWith("/apps/")) {
    return "apps";
  }
  const match = PROJECT_SECTIONS.find((row) => row.key !== "" && `/${row.key}` === rest);
  return match === undefined ? "" : match.key;
}

/** The list a page belongs to (the crumb before its own name): a dataset or view sits under Catalog, a map under Maps, an app under Apps. */
function parentCrumb(rest: string):
  | {
      label: string;
      to:
        | "/projects/$projectId/catalog"
        | "/projects/$projectId/maps"
        | "/projects/$projectId/apps";
    }
  | undefined {
  if (rest.startsWith("/datasets/") || rest.startsWith("/views/")) {
    return { label: "Catalog", to: "/projects/$projectId/catalog" };
  }
  if (rest.startsWith("/maps/")) {
    return { label: "Maps", to: "/projects/$projectId/maps" };
  }
  if (rest.startsWith("/apps/")) {
    return { label: "Apps", to: "/projects/$projectId/apps" };
  }
  return undefined;
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
    "/scratch": "Scratch query",
    "/apps": "Apps",
    "/catalog": "Catalog",
    "/create": "Add dataset",
    "/lineage": "Lineage",
    "/maps": "Maps",
    "/members": "Members",
    "/publish": "Publish",
    "/settings": "Settings",
  };
  return labels[rest] ?? "Overview";
}

/**
 * The project SWITCHER (the sidebar block's version-switcher pattern): the
 * current project's title + access level on a large menu button, opening into
 * "All projects" plus every project — the current one checked — jumping each
 * to the same section of the chosen project. Renders inside SidebarHeader.
 */
function ProjectSwitcher({
  accessLabel,
  memberships,
  projectId,
  project,
  rest,
  userId,
}: {
  accessLabel: string;
  memberships: ReadonlyArray<{ projectId: string; role: ProjectRole }> | undefined;
  projectId: string;
  project: projectsStore.ProjectRow;
  rest: string;
  userId: string;
}) {
  const navigate = useNavigate();
  const projectsQuery = useQuery(projectsStore.listQueryOptions());
  const projects = projectsQuery.data ?? [];
  const jump = async (targetId: string): Promise<void> => {
    await navigate({
      params: { projectId: targetId },
      to: sectionTo(switcherSectionOf(rest)),
    });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            size="lg"
            title="Switch project"
          >
            <span className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <FolderKanban className="size-4" />
            </span>
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate font-semibold">{project.title}</span>
              <span className="truncate text-xs text-muted-foreground">{accessLabel}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </SidebarMenuButton>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => {
              void navigate({ to: "/projects" });
            }}
          >
            <FolderKanban className="mr-2 size-4" />
            All projects
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {projects.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {projects.map((row) => {
                const rowRole = resolveMyRole(memberships, row.id, row.createdBy, userId);
                return (
                  <DropdownMenuItem
                    className="gap-2"
                    key={row.id}
                    onClick={() => {
                      void jump(row.id);
                    }}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border text-xs uppercase">
                      {row.title.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{row.title}</span>
                    <Badge className="shrink-0" variant="outline">
                      {ROLE_LABELS[rowRole]}
                    </Badge>
                    {row.id === projectId ? <Check className="size-4 shrink-0" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One sidebar entry: a menu button linking somewhere (tooltip in the icon rail) + its count badge. */
function ShellNavItem({
  active,
  count,
  icon: Icon,
  label,
  linkProps,
}: {
  active: boolean;
  count?: number;
  icon: ComponentType<{ className?: string }>;
  label: string;
  linkProps: LinkProps;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={<Link {...linkProps} aria-current={active ? "page" : undefined} />}
        tooltip={label}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
      {count === undefined ? null : <SidebarMenuBadge>{count}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
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
    createMap = async (values: { description: string; name: string }): Promise<void> => {
      setCreatingMap(true);
      try {
        const mapId = await mapsStore.create({
          ...(values.description === "" ? {} : { description: values.description }),
          name: values.name,
          projectId,
        });
        if (mapId === null) {
          toast.error("The map wasn't created. You may not have access.");
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ["pg:maps"] });
        setMapOpen(false);
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
    parent = parentCrumb(rest),
    section = sectionLabel(rest, currentName),
    CreateAppDialog = createAppDialog;

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
      <SidebarProvider
        className="min-h-[calc(100svh-3.5rem)]"
        onOpenChange={(next) => {
          setRail(!next);
        }}
        open={!rail}
      >
        <Sidebar collapsible="icon" data-testid="project-sidebar">
          <SidebarHeader>
            <ProjectSwitcher
              accessLabel={ROLE_LABELS[myRole]}
              memberships={myMembershipQuery.data}
              projectId={projectId}
              project={project}
              rest={rest}
              userId={userId}
            />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <ShellNavItem
                    active={false}
                    icon={FolderKanban}
                    label="Projects"
                    linkProps={{ to: "/projects" }}
                  />
                  <ShellNavItem
                    active={rest === ""}
                    icon={LayoutGrid}
                    label="Overview"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo(""),
                    }}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Data</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <ShellNavItem
                    active={rest === "/catalog" || onDataset}
                    count={catalog.length}
                    icon={Database}
                    label="Catalog"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo("catalog"),
                    }}
                  />
                  <ShellNavItem
                    active={rest === "/scratch"}
                    icon={FlaskConical}
                    label="Scratch query"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo("scratch"),
                    }}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Build</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <ShellNavItem
                    active={rest.startsWith("/maps")}
                    count={maps.length}
                    icon={MapIcon}
                    label="Maps"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo("maps"),
                    }}
                  />
                  <ShellNavItem
                    active={rest.startsWith("/apps")}
                    count={apps.length}
                    icon={LayoutDashboard}
                    label="Apps"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo("apps"),
                    }}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Project</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <ShellNavItem
                    active={rest === "/lineage"}
                    icon={Network}
                    label="Lineage"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo("lineage"),
                    }}
                  />
                  <ShellNavItem
                    active={rest === "/settings"}
                    icon={Settings}
                    label="Settings"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo("settings"),
                    }}
                  />
                  <ShellNavItem
                    active={rest === "/members"}
                    icon={Users}
                    label="Members"
                    linkProps={{
                      params: { projectId },
                      to: sectionTo("members"),
                    }}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <header
            className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4"
            data-testid="project-toolbar"
          >
            <SidebarTrigger className="-ml-1" />
            {/* data-vertical:self-center beats the kit separator's data-vertical:self-stretch (same variant specificity); a stretched fixed-height item parks at the cross-start (the top border). */}
            <Separator className="mr-1 h-4 data-vertical:self-center" orientation="vertical" />
            <div className="flex min-w-0 items-center gap-2">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link to="/projects" />}>Projects</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={<Link params={{ projectId }} to="/projects/$projectId" />}
                    >
                      <span className="max-w-48 truncate">{project.title}</span>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {parent === undefined ? null : (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbLink render={<Link params={{ projectId }} to={parent.to} />}>
                          {parent.label}
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                    </>
                  )}
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="max-w-48 truncate">{section}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
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
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      disabled={!canEdit}
                      size="sm"
                      title={
                        canEdit ? "Add a dataset, view, map, or app to this project" : VIEWER_REASON
                      }
                      type="button"
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Add new
                      <ChevronDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Data</DropdownMenuLabel>
                    <DropdownMenuItem
                      onClick={() => {
                        void navigate({ params: { projectId }, to: "/projects/$projectId/create" });
                      }}
                    >
                      <Database className="mr-2 h-4 w-4" />
                      Dataset
                      <span className="ml-auto text-xs text-muted-foreground">add or create</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canEdit}
                      onClick={() => {
                        void navigate({
                          params: { projectId },
                          to: "/projects/$projectId/views/new",
                        });
                      }}
                      title={canEdit ? undefined : VIEWER_REASON}
                    >
                      <Workflow className="mr-2 h-4 w-4" />
                      View
                      <span className="ml-auto text-xs text-muted-foreground">from steps</span>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Compose</DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={!canEdit}
                      onClick={() => {
                        setMapOpen(true);
                      }}
                      title={canEdit ? undefined : VIEWER_REASON}
                    >
                      <MapIcon className="mr-2 h-4 w-4" />
                      Map
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canEdit || CreateAppDialog === undefined}
                      onClick={() => {
                        setAppOpen(true);
                      }}
                      title={canEdit ? "New app" : VIEWER_REASON}
                    >
                      <LayoutDashboard className="mr-2 h-4 w-4" />
                      App
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <div className="min-w-0 flex-1">{children}</div>
        </SidebarInset>
      </SidebarProvider>

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
      {mapOpen ? (
        <NewMapDialog
          busy={creatingMap}
          onOpenChange={setMapOpen}
          onSubmit={(values) => {
            void createMap(values);
          }}
        />
      ) : null}
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
