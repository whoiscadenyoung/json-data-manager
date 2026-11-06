import type { AppRow } from "#/lib/store/apps";

import { appPagesOf, type AppPage, type Sharing } from "./content";

/**
 * The feature's app view model, built from the store's raw `AppRow`
 * (migration 0022's DDL — apps are project-owned): what the viewer, the
 * builder, and the menus read. Authorization stays client-side projection
 * here — the DATABASE decides everything (RLS: writes answer only to the
 * project's editors; a non-editor write is 0 rows affected); `canEdit` only
 * decides which controls render, never whether a write lands.
 *
 * The edit rule (issue #259 — "creator-gated writes, now via project roles"):
 * a seeded example is read-only for EVERYONE (including its project's
 * editors — the `system:examples` behavior: read, copy, never edit); every
 * other app is editable by its project's owner/editor seat, read-only for
 * viewers and outsiders. 0014's write policies enforce the same
 * server-side (0022).
 */

/** One app, as every reader of the feature gets it. */
export interface AppDoc {
  id: string;
  /** The owning project — null when the viewer can't read the project row (an example, for a non-member). */
  projectId: string;
  projectTitle: string | null;
  title: string;
  description: string | null;
  sharing: Sharing;
  /** The app's data sources (PG dataset ids), in order. */
  datasetIds: string[];
  pages: AppPage[];
  /** Seeded example: readable by everyone signed in, edited by no one. */
  example: boolean;
  revision: number;
  /** Whether the edit controls render (a project editor/owner seat, and never a seeded example). */
  canEdit: boolean;
  updatedAt: string;
}

/** The seat shape `resolveMyRole` answers — what the pages hand this module. */
export type AppViewerRole = "owner" | "editor" | "viewer" | null | undefined;

/**
 * The edit rule, as one predicate: a project editor/owner seat, and a seeded
 * example is read-only for EVERYONE.
 */
export function canEditApp(row: { example: boolean }, myRole: AppViewerRole): boolean {
  if (row.example) {
    return false;
  }
  return myRole === "owner" || myRole === "editor";
}

/** The store row as the feature's view model (the one place the wire shapes meet). */
export function appDocOf(row: AppRow, myRole: AppViewerRole): AppDoc {
  return {
    canEdit: canEditApp(row, myRole),
    datasetIds: row.datasetIds,
    description: row.description,
    example: row.example,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store treats widget payloads as opaque jsonb (`AppWidgetConfig`); this feature's typed `AppPage[]` (lib/content.ts) is the only writer shape, so the boundary cast is the agreed contract.
    pages: appPagesOf(row.pages as unknown as AppPage[]),
    projectId: row.projectId,
    projectTitle: row.project === null ? null : row.project.title,
    revision: row.revision,
    sharing: row.sharing,
    title: row.title,
    id: row.id,
    updatedAt: row.updatedAt,
  };
}
