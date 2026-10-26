import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { getContext } from "./integrations/tanstack-query/root-provider";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    context: getContext(),

    defaultPreload: "intent",

    defaultPreloadStaleTime: 0,

    routeTree,

    scrollRestoration: true,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
  interface StaticDataRouteOption {
    /**
     * Render the route without the global `Header`: it draws its own chrome
     * (the published app viewer and its preview, docs/app-builder.md).
     */
    hideHeader?: boolean;
  }
}
