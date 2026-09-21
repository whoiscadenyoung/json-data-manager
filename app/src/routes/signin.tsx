import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";

export const Route = createFileRoute("/signin")({ component: SignInPage });

/**
 * Email + password sign-in/sign-up (emailAndPassword is enabled server-side
 * in convex/auth.ts). On success the session cookie is set and the auth
 * provider picks the session up reactively — navigating home is enough.
 */
function SignInPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const email = field("email");
    const password = field("password");
    setBusy(true);
    const result =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({
            email,
            name: field("name"),
            password,
          });
    setBusy(false);
    if (result.error !== null) {
      toast.error(result.error.message ?? "That didn't work — try again.");
      return;
    }
    await navigate({ to: "/" });
  };

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col justify-center px-6 py-24">
      <Card>
        <CardHeader>
          <CardTitle>{mode === "sign-in" ? "Sign in" : "Create an account"}</CardTitle>
          <CardDescription>
            {mode === "sign-in"
              ? "Use your email and password to sign in."
              : "Pick an email and password — you'll be signed in right away."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {mode === "sign-up" ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Name</Label>
                <Input autoComplete="name" id="name" name="name" required />
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input autoComplete="email" id="email" name="email" required type="email" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                id="password"
                minLength={8}
                name="password"
                required
                type="password"
              />
            </div>
            <Button disabled={busy} type="submit">
              {busy ? "Working…" : mode === "sign-in" ? "Sign in" : "Sign up"}
            </Button>
          </form>
          <Button
            className="mt-3 w-full"
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            }}
            type="button"
            variant="ghost"
          >
            {mode === "sign-in"
              ? "Need an account? Sign up"
              : "Already have an account? Sign in"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
