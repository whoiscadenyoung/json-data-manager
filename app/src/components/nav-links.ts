import {
  Database,
  FolderKanban,
  Layers,
  LayoutDashboard,
  Map,
  type LucideIcon,
} from "lucide-react";

/**
 * The five main tabs: one source for the global nav (label + icon) and for
 * each page's header (icon tile, title, description), so they never drift.
 */
export const NAV_LINKS = [
  {
    description: "Manage datasets, collections, maps and apps in one place.",
    icon: FolderKanban,
    label: "Projects",
    to: "/projects",
  },
  {
    description: "Browse datasets and groups. Grouped datasets are listed under their group.",
    icon: Database,
    label: "Datasets",
    to: "/datasets",
  },
  {
    description: "Saved groupings of datasets, created here or published from a project.",
    icon: Layers,
    label: "Collections",
    to: "/collections",
  },
  {
    description:
      "Pages of maps, charts and tables built inside projects, shared by link when their project allows it.",
    icon: LayoutDashboard,
    label: "Apps",
    to: "/apps",
  },
  {
    description: "Every map in your projects. Maps are made and edited inside a project.",
    icon: Map,
    label: "Maps",
    to: "/maps",
  },
] as const satisfies ReadonlyArray<{
  description: string;
  icon: LucideIcon;
  label: string;
  to: string;
}>;

export type NavLink = (typeof NAV_LINKS)[number];
export type NavTo = NavLink["to"];

/** The nav entry for one main tab. */
export function navLinkFor(to: NavTo): NavLink {
  return NAV_LINKS.find((link) => link.to === to) ?? NAV_LINKS[0];
}
