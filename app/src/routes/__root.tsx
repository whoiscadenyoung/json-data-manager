import { Toaster } from "@caden/ui/components/sonner";
import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

import { AuthGate, SignedInOnly } from "#/components/auth-gate";
import { Header } from "#/components/header";
import { TileArchiveCacheManager, TileArchiveManager } from "#/features/maps/tiles";
import { SupabaseAuthProvider } from "#/integrations/supabase/provider";
import { tanStackQueryDevtools } from "#/integrations/tanstack-query/devtools";
import { TanStackQueryProvider } from "#/integrations/tanstack-query/root-provider";

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
        {/* The stage-7 disconnect (issue #206): the Convex provider that
            wrapped this tree until now is unmounted — the Supabase session
            provider is the only auth context, and the shell makes zero
            Convex network calls. `SignedInOnly` gates the root watchers on
            that session. */}
        <TanStackQueryProvider>
          <SupabaseAuthProvider>
            {/* The tile-archive watchers query the moment they mount — they ride
              SignedInOnly so a signed-out visitor's gate redirect isn't raced by
              their queries (#135). */}
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
          </SupabaseAuthProvider>
        </TanStackQueryProvider>
        <Scripts />
      </body>
    </html>
  );
}
