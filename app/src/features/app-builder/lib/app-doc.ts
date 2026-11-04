import type { AppRow } from "#/lib/store/apps";

import { appPagesOf, type AppPage, type Sharing } from "./content";

/**
 * The feature's app view model, built from the store's raw `AppRow`
 * (migration 0014's DDL): what the viewer, the builder, and the menus read.
 * Authorization stays client-side projection here — the DATABASE decides
 * everything (RLS: writes answer only to the creator; a non-creator write is
 * 0 rows affected); `canEdit` only decides which controls render, never
 * whether a write lands.
 *
 * The store's `ownerName` (the `get` profiles embed) is carried on the row
 * but not projected onto the doc: no surface ever read it (checked across
 * the pre-port feature tree).
 */

/** One app, as every reader of the feature gets it. */
export interface AppDoc {
  id: string;
  title: string;
  description: string | null;
  sharing: Sharing;
  /** The app's data sources (PG dataset ids), in order. */
  datasetIds: string[];
  pages: AppPage[];
  /** Seeded example: readable by everyone signed in, edited by no one. */
  example: boolean;
  revision: number;
  /** Whether the edit controls render (creator, and never a seeded example). */
  canEdit: boolean;
  updatedAt: string;
}

/**
 * The edit rule, as one predicate: only the creator, and a seeded example is
 * read-only for EVERYONE (including its seeded owner — the `system:examples`
 * behavior: read, copy, never edit; 0014's write policies enforce the same
 * server-side).
 */
export function canEditApp(
  row: { createdBy: string; example: boolean },
  authUserId: string | null | undefined,
): boolean {
  if (row.example) {
    return false;
  }
  return authUserId !== null && authUserId !== undefined && row.createdBy === authUserId;
}

/** The store row as the feature's view model (the one place the wire shapes meet). */
export function appDocOf(row: AppRow, authUserId: string | null | undefined): AppDoc {
  return {
    canEdit: canEditApp(row, authUserId),
    datasetIds: row.datasetIds,
    description: row.description,
    example: row.example,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store treats widget payloads as opaque jsonb (`AppWidgetConfig`); this feature's typed `AppPage[]` (lib/content.ts) is the only writer shape, so the boundary cast is the agreed contract.
    pages: appPagesOf(row.pages as unknown as AppPage[]),
    revision: row.revision,
    sharing: row.sharing,
    title: row.title,
    id: row.id,
    updatedAt: row.updatedAt,
  };
}
