import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

import { AuthGate, SignedInOnly } from "#/components/auth-gate";
import { Header } from "#/components/header";
import { Toaster } from "#/components/ui/sonner";
import { AppConvexProvider } from "#/integrations/convex/provider";
import { tanStackQueryDevtools } from "#/integrations/tanstack-query/devtools";
import { TanStackQueryProvider } from "#/integrations/tanstack-query/root-provider";
import { TileArchiveManager } from "#/lib/tile-archive";
import { TileArchiveCacheManager } from "#/lib/tile-archive-cache";

import appCss from "#/styles.css?url";

interface MyRouterContext {
  queryClient: QueryClient;
}

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    links: [
      {
        href: appCss,
        rel: "stylesheet",
      },
    ],
    meta: [
      {
        charSet: "utf8",
      },
      {
        content: "width=device-width, initial-scale=1",
        name: "viewport",
      },
      {
        title: "JSON Data Manager",
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased wrap-anywhere selection:bg-[rgba(79,184,178,0.24)]">
        <AppConvexProvider>
          <TanStackQueryProvider>
            {/* The catalog watchers query the moment they mount — they ride
                SignedInOnly so a signed-out visitor's gate redirect can't be
                replaced by their "You're signed out" failures (#135). */}
            <SignedInOnly>
              <TileArchiveManager />
              <TileArchiveCacheManager />
            </SignedInOnly>
            <Header />
            {/* The app-wide sign-in gate (issue #135): nothing routed renders
                — or queries — until the session resolves as signed in. */}
            <AuthGate>{children}</AuthGate>
            <Toaster />
            {/* Devtools stay a dev-only render — they shipped into production
                builds until #135's review caught it. */}
            {import.meta.env.PROD ? null : (
              <TanStackDevtools
                config={{
                  position: "bottom-right",
                }}
                plugins={[
                  {
                    name: "Tanstack Router",
                    render: <TanStackRouterDevtoolsPanel />,
                  },
                  tanStackQueryDevtools,
                ]}
              />
            )}
          </TanStackQueryProvider>
        </AppConvexProvider>
        <Scripts />
      </body>
    </html>
  );
}
