import { useState, FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { UserPlus, Loader2, Zap } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Signup() {
  const apiBase = import.meta.env.BASE_URL;
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}api/auth/signup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Sign up failed (${res.status})`);
      }
      setLocation("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/20 px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <Link href="/" className="flex items-center justify-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Zap className="h-4 w-4 fill-current" />
          </span>
          <span className="text-base font-semibold tracking-tight">WP Bridge AI</span>
        </Link>
        <Card className="shadow-lg">
          <CardHeader className="text-center space-y-3">
            <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <UserPlus className="h-6 w-6" />
            </div>
            <CardTitle className="text-2xl">Create your account</CardTitle>
            <CardDescription>Start converting HTML into editable WordPress in minutes.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-1.5">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  data-testid="input-signup-username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy}
                  required
                  minLength={3}
                />
                <p className="text-[11px] text-muted-foreground">At least 3 characters.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  data-testid="input-signup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  required
                  minLength={8}
                />
                <p className="text-[11px] text-muted-foreground">At least 8 characters.</p>
              </div>
              {error && (
                <div
                  data-testid="text-signup-error"
                  className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2"
                >
                  {error}
                </div>
              )}
              <Button
                type="submit"
                data-testid="button-signup-submit"
                className="w-full"
                disabled={busy}
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating account…
                  </>
                ) : (
                  "Create account"
                )}
              </Button>
              <p className="text-sm text-muted-foreground text-center pt-2">
                Already have an account?{" "}
                <Link href="/login" className="text-primary font-medium hover:underline">
                  Sign in
                </Link>
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
