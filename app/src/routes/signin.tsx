import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";

export const Route = createFileRoute("/signin")({ component: SignInPage });

/**
 * Email + password sign-in (emailAndPassword is enabled server-side in
 * convex/auth.ts). There is deliberately no sign-up path: the public auth
 * surface has `disableSignUp` (issue #136 — the trusted-collaborator model,
 * ADR 0009), so accounts are minted by the maintainer through the internal
 * `auth.createAccount` mutation; see the ADR 0009 addendum for the recipe.
 * On success the session cookie is set and the auth provider picks the
 * session up reactively — navigating home is enough.
 */
function SignInPage() {
  const navigate = useNavigate();
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
      const result = await authClient.signIn.email({
        email: field("email"),
        password: field("password"),
      });
      if (result.error !== null) {
        toast.error(result.error.message ?? "That didn't work — try again.");
        return;
      }
      await navigate({ to: "/" });
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
