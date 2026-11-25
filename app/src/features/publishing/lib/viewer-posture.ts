/** The viewer-facing reason every disabled project write control carries (the UI-polish rule: a reason, never a silent no-op). One string, shared by the workspace and its sections — a lib module, not the workspace component, so the sections can hold it without a component-import cycle. */
export const VIEWER_REASON =
  "Viewers have read-only access to this project — ask an owner for editor access.";
