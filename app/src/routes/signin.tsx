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
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { supabase } from "#/integrations/supabase/client";
import { useSession } from "#/integrations/supabase/provider";

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
 * Supabase email + password sign-in (design doc §9, the stage-0 auth swap).
 * There is deliberately no sign-up path, exactly as before: the public auth
 * surface has new-user signups disabled (the ADR 0009 addendum carries over
 * — the trusted-collaborator model), so accounts are minted by the operator
 * with the service-role key or the local Studio; see the design doc's
 * signup-gating note. The session lands in cookies via `@supabase/ssr` and
 * the auth provider picks it up reactively — navigating home is enough.
 */
function SignInPage() {
  const navigate = useNavigate(),
    { redirect } = Route.useSearch(),
    { session } = useSession();

  // Already signed in — or the session went live just after a sign-in whose
  // navigation raced it (the gate bounced the visitor back here): go on to
  // where they were headed.
  useEffect(() => {
    if (session !== null) {
      void navigate({ href: redirect ?? "/", replace: true });
    }
  }, [session, navigate, redirect]);
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
