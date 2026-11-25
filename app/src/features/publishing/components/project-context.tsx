import { createContext, useContext } from "react";

import type { ProjectRole } from "@/lib/store/project-members";
import type { CatalogRow, ProjectRow } from "@/lib/store/projects";

/** What the project shell shares with its section pages (issue #271): the project, the caller's seat, the catalog, and the shell-owned dialogs the sections open. */
export interface ProjectShellValue {
  canEdit: boolean;
  catalog: CatalogRow[];
  invalidateAll: () => void;
  myRole: ProjectRole;
  openAdd: () => void;
  openNewApp: () => void;
  openNewMap: () => void;
  openPress: () => void;
  pressing: boolean;
  project: ProjectRow;
  projectId: string;
}

export const ProjectShellContext = createContext<ProjectShellValue | null>(null);

/** The shell's shared state; section pages only render inside the shell. */
export function useProjectShell(): ProjectShellValue {
  const value = useContext(ProjectShellContext);
  if (value === null) {
    throw new Error("useProjectShell must be used inside the project shell.");
  }
  return value;
}
