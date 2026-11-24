---
name: project-sidebar-switcher
description: 2026-11-24 projects-area shadcn sidebar rework — @caden/ui sidebar port recipe, sticky-header pin, IAB slow-first-load trap, perf-buffer-250 artifact
metadata:
  type: project
---

2026-11-24: the project workspace shell (`PgProjectShell`) was restyled after the
shadcn sidebar block — owner chose **projects-area-only** scope (global top header
stays everywhere else). Shipped in `app/src/features/publishing/components/pg-project-shell.tsx`:
a full-height `Sidebar` (collapsible="icon") whose header is a version-switcher-style
**project switcher** (jumps to the same section of another project; detail paths
collapse to their section root — datasets/views → Catalog, maps → Maps, apps → Apps),
and the old toolbar became a `SidebarInset` header: `SidebarTrigger | Separator |
Breadcrumb(Projects / project / section)` + role badge + Add new. The old
`useRail` localStorage keys (`jdm.projectSidebar.rail.page` / `.editor`) now drive
the sidebar's controlled `open` (open = !rail), so per-editor/page persistence is preserved.

**Why:** the toolbar previously spanned the full width ABOVE the sidebar, wasting
vertical space; the switcher replaces back-and-forth via /projects.

**How to apply / gotchas:**

- `shadcn add sidebar` CANNOT be used on `@caden/ui`: it overwrites 6 kit
  components and adds a bogus `cn` dep. Port instead from
  `raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/bases/base/ui/<name>.tsx`
  - `bases/base/hooks/use-mobile.ts`, rewrite imports to the package's relative
    paths, and INLINE the `cn-sidebar-*` tokens from
    `apps/v4/registry/styles/style-mira.css` (this kit predates the cn-* token
    indirection — components carry styles inline). Lint: `useIsMobile` as registry-written
    (setState in effect) is an ERROR here — rewrite with `useSyncExternalStore`.
- The vendored `sidebar.tsx` container pins at `sticky top-14 h-[calc(100svh-3.5rem)]`
  (adapted from stock `fixed inset-y-0 h-svh`) because the app's global header is
  sticky at h-14; `SidebarProvider` gets `className="min-h-[calc(100svh-3.5rem)]"`.
- base-ui switcher recipe: trigger via `DropdownMenuTrigger render={<SidebarMenuButton/>}`,
  items need the pointerdown/up/click dispatch, `DropdownMenuLabel` inside the group.
- **IAB trap:** after new module chains enter vite's graph (or a stash/pop),
  first FULL page loads can take 30 s+ before anything renders and look like a
  dead hang (spinner only, looks like `projectQuery.isPending` forever). It is a
  transform burst, not a bug — steady-state full loads settle to 1.8–3 s. Wait
  before bisecting.
- **perf.buffer artifact:** `performance.getEntriesByType("resource")` caps at 250
  entries — "zero :8000 requests" readouts on a loaded dev page are the buffer
  overflowing, not a network stall. Use a PerformanceObserver for request timelines.
- Verified in-browser: switcher jump preserves section, check on current, All
  projects crumb/button → /projects, collapse/persist per page/editor, editor
  paths default to icon rail, mobile sheet carries switcher + nav, breadcrumb
  Projects crumb → /projects. Test project created + deleted during verification.
