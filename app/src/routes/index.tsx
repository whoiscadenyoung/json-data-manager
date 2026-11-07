import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The home route lands on /projects (issue #262; §4.3): projects are the
 * primary working context — the datasets/maps/apps/collections tabs are
 * explorers over their rows, so the front door is the workspace list.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/projects" });
  },
});
