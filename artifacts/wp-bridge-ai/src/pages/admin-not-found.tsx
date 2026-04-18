import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Compass, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Admin 404 boundary. Performs the same auth probe as the rest of the
 * admin portal so unauthenticated visitors are sent to the admin login
 * and signed-in non-admins land on the 403 page — never the user app.
 */
export default function AdminNotFound() {
  const apiBase = import.meta.env.BASE_URL;
  const [, setLocation] = useLocation();
  const [authStatus, setAuthStatus] = useState<"loading" | "ok" | "401" | "403">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}api/admin/me`, { credentials: "include" });
        if (cancelled) return;
        if (res.status === 401) { setAuthStatus("401"); return; }
        if (res.status === 403) { setAuthStatus("403"); return; }
        if (!res.ok) { setAuthStatus("401"); return; }
        setAuthStatus("ok");
      } catch {
        if (!cancelled) setAuthStatus("401");
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    if (authStatus === "401") setLocation("/admin/login");
    if (authStatus === "403") setLocation("/admin/forbidden");
  }, [authStatus, setLocation]);

  if (authStatus !== "ok") {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Checking admin access…
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/20 px-4 py-12">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Compass className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl">Admin page not found</CardTitle>
          <CardDescription>
            That admin route does not exist. You are still inside the admin portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center text-xs text-muted-foreground space-y-2">
          <Link href="/admin/ai-settings" className="text-primary hover:underline">
            Go to AI settings
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
