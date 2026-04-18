import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Shield, LogOut, ArrowLeft, Loader2, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

export type AdminAuthStatus = "loading" | "ok" | "401" | "403";

export function useAdminAuth(): { user: AdminUser | null; status: AdminAuthStatus } {
  const apiBase = import.meta.env.BASE_URL;
  const [, setLocation] = useLocation();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [status, setStatus] = useState<AdminAuthStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}api/admin/me`, { credentials: "include" });
        if (cancelled) return;
        if (res.status === 401) { setStatus("401"); return; }
        if (res.status === 403) { setStatus("403"); return; }
        if (!res.ok) { setStatus("401"); return; }
        const body = await res.json();
        setUser(body.user);
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("401");
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    if (status === "401") setLocation("/admin/login");
    if (status === "403") setLocation("/admin/forbidden");
  }, [status, setLocation]);

  return { user, status };
}

interface AdminShellProps {
  user: AdminUser | null;
  active: "ai-settings" | "users";
  children: ReactNode;
}

export function AdminShell({ user, active, children }: AdminShellProps) {
  const apiBase = import.meta.env.BASE_URL;
  const [, setLocation] = useLocation();

  const onLogout = async () => {
    await fetch(`${apiBase}api/admin/logout`, { method: "POST", credentials: "include" });
    setLocation("/admin/login");
  };

  const tabs: Array<{ id: AdminShellProps["active"]; label: string; href: string; Icon: React.ElementType }> = [
    { id: "ai-settings", label: "AI settings", href: "/admin/ai-settings", Icon: Sparkles },
    { id: "users", label: "Users", href: "/admin/users", Icon: Users },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Shield className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Admin portal</div>
              <div className="text-[10px] text-muted-foreground">WP Bridge AI</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <Badge variant="outline" className="font-mono text-[11px]" data-testid="badge-current-user">
                {user.username}
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={() => setLocation("/")}>
              <ArrowLeft className="h-4 w-4 mr-1" /> User dashboard
            </Button>
            <Button variant="ghost" size="sm" onClick={onLogout}>
              <LogOut className="h-4 w-4 mr-1" /> Sign out
            </Button>
          </div>
        </div>
        <nav className="max-w-5xl mx-auto px-6 flex items-center gap-1 -mt-px">
          {tabs.map((t) => {
            const isActive = t.id === active;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setLocation(t.href)}
                data-testid={`tab-${t.id}`}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  isActive
                    ? "border-primary text-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <t.Icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            );
          })}
        </nav>
      </header>
      {children}
    </div>
  );
}

export function AdminLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading admin portal…
    </div>
  );
}
