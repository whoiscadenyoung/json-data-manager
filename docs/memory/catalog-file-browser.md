---
name: catalog-file-browser
description: 2026-11-16 project catalog is a file browser — project_folders (0034) hold membership rows, one table for datasets + views, folder in the URL, drag/move; test and stack gotchas
metadata:
  type: project
---

2026-11-16 (branch `feat/catalog-file-browser`, stacked on
`feat/view-canvas-editor`): the project Catalog page
(`features/publishing/components/pg-project-catalog.tsx`) is a file browser.
The owner asked for datasets and views to be easy to see together and to be
grouped in folders; the separate Datasets / Views card sections are gone
(`ProjectViewsSection` and `ViewCard` were deleted).

- **Folders hold membership rows, not datasets**: `project_folders` +
  `project_artifacts.folder_id` (migration 0034). A folder only organises one
  project; nothing about visibility, publishing or lineage reads it. Members
  read the tree, editors change it. No realtime: the folder query key sits
  under `pg:projects`, so the shell's `invalidateAll` refreshes it.
- **Deleting a folder keeps its contents**: `delete_project_folder` moves the
  subfolders and memberships up one level, then deletes. It is an RPC, not a
  BEFORE DELETE trigger, because a trigger that updates sibling rows breaks a
  multi-row delete ("tuple to be deleted was already modified").
- Sibling names are unique case-insensitively, the root included (`nulls not
distinct` index); the store restates 23505 / 23514 as readable messages.
- The open folder is the route's `?folder=<id>` search value; a deleted
  folder's link falls back to the root. Search looks through the whole
  project and shows each match's path. Relations list under the root only.
- One selection drives both moves: drag rows onto a folder row or a
  breadcrumb, or select rows and "Move to". The selection actions replace the
  page actions in the same header row so the table never jumps.
- Linked datasets' sync / pin / float / revert moved into a "Version and
  sync…" dialog that reuses `PgLinkedVersionActions`.
- Pure listing logic is `features/publishing/lib/catalog-tree.ts` (unit
  tested); the page test mocks the stores, the shell context and
  `@tanstack/react-router` (`useSearch` supplies the folder).
- Not built: new datasets / views created while a folder is open still land
  at the root (`addArtifact` accepts `folderId`, the create pages don't pass
  it yet); maps and apps are not in the browser.

Gotchas:

- The compose stack's database is `app` (not `postgres`) and its
  `schema_migrations` stops at 0030: 0031-0033 were applied by hand without a
  bookkeeping row. 0034 was applied by hand too, with its row.
- Native HTML5 drag-and-drop does not fire from the browser pane's simulated
  mouse drag; dispatch `DragEvent`s (`dragstart` / `dragover` / `drop`) in the
  page to check it.
- A base-ui dialog does not focus the first input reliably without
  `initialFocus={ref}`, and `autoFocus` fails `jsx-a11y(no-autofocus)`.
- For a single int-test file without the compose password: boot the gate's
  bare `supabase/postgres` image on a spare port, apply the migrations, and
  point `SUPABASE_DB_URL` at it (`supabase_admin:postgres`).

Related: [[views-canvas-editor]], [[project-catalog-0019-lessons]],
[[int-test-db-split-ri-teardown]].
