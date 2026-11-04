import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { supabase } from "#/integrations/supabase/client";
import { useSession } from "#/integrations/supabase/provider";
import { authClient } from "#/lib/auth-client";

/**
 * Where to go after signing in: an in-app path only (a leading single "/"),
 * so the parameter can never bounce a user to another origin.
 */
function safeRedirect(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : undefined;
}

export const Route = createFileRoute("/signin")({
  component: SignInPage,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirect(search.redirect);
    return redirect === undefined ? {} : { redirect };
  },
});

/**
 * Supabase email + password sign-in (design doc §9, the stage-0 auth swap),
 * with the stage-0 session bridge: the still-mounted Convex half is fed
 * solely by its Better Auth session (integrations/convex/provider.tsx) and
 * app/convex/auth.ts rejects unauthenticated callers on every exposed read
 * AND write — a Supabase session alone would open the gate over a fully
 * unauthenticated Convex backend, the endless-skeleton failure mode #135
 * built the gate to prevent. So the same credentials sign in to BOTH
 * stores: the GoTrue session via `@supabase/ssr` cookies, and the Better
 * Auth session via `authClient` (the Convex provider picks that up
 * reactively — navigating home is enough). Accounts must exist in both
 * stores with the same credentials; the §9 recipe mints the pair. If the
 * bridge half fails, the Supabase half is rolled back so neither session
 * is left live — the gate opens only when both exist.
 *
 * There is deliberately no sign-up path, exactly as before: the public auth
 * surface has new-user signups disabled on both halves (the ADR 0009
 * addendum carries over — the trusted-collaborator model), so accounts are
 * minted by the operator; see the design doc's signup-gating note.
 */
function SignInPage() {
  const navigate = useNavigate(),
    { redirect } = Route.useSearch(),
    { session } = useSession(),
    { isAuthenticated } = useConvexAuth();

  // Already signed in — or the sessions went live just after a sign-in whose
  // navigation raced it (the gate bounced the visitor back here): go on to
  // where they were headed. Both halves must be up — the gate opens only on
  // both — so watching either alone would bounce a half-signed-in visitor
  // into a /signin ⇄ home redirect loop.
  useEffect(() => {
    if (session !== null && isAuthenticated) {
      void navigate({ href: redirect ?? "/", replace: true });
    }
  }, [session, isAuthenticated, navigate, redirect]);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: field("email"),
        password: field("password"),
      });
      if (error !== null) {
        toast.error(error.message ?? "That didn't work — try again.");
        return;
      }
      // The stage-0 bridge: the same credentials into the Better Auth store
      // the Convex half rides. A failure here must not leave a half-open
      // sign-in (the gate opens only when both sessions exist), so the
      // Supabase half is rolled back and the reason surfaced — the usual
      // cause is an account minted on only one side.
      const bridge = await authClient.signIn.email({
        email: field("email"),
        password: field("password"),
      });
      if (bridge.error !== null) {
        await supabase.auth.signOut();
        toast.error(
          (bridge.error.message ?? "That didn't work — try again.") +
            " The app signs in to both auth stores — ask the maintainer to mint the account in both.",
        );
        return;
      }
      await (redirect === undefined ? navigate({ to: "/" }) : navigate({ href: redirect }));
    } finally {
      // A thrown call (offline, server down) must not leave the button stuck
      // in its busy state (issue #135, defect 5).
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col justify-center px-6 py-24">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Use your email and password to sign in. Accounts are created by the maintainer — ask for
            one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input autoComplete="email" id="email" name="email" required type="email" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                autoComplete="current-password"
                id="password"
                minLength={8}
                name="password"
                required
                type="password"
              />
            </div>
            <Button disabled={busy} type="submit">
              {busy ? "Working…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
