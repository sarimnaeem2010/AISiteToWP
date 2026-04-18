import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  Sparkles,
  Shield,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  KeyRound,
  LogOut,
  ArrowLeft,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

interface AiSettings {
  enabled: boolean;
  hasKey: boolean;
  keyPreview: string | null;
  model: string;
  maxTokens: number;
  masterControllerMode: boolean;
  status: "connected" | "invalid_key" | "disabled" | "unknown";
  statusMessage: string | null;
  lastTestedAt: string | null;
  updatedAt: string;
}

const MODEL_OPTIONS = [
  { value: "gpt-4o-mini", label: "gpt-4o-mini (default — fast, cheap)" },
  { value: "gpt-4o", label: "gpt-4o (higher quality)" },
];

function StatusPill({ status }: { status: AiSettings["status"] }) {
  const config: Record<AiSettings["status"], { label: string; cls: string; Icon: React.ElementType }> = {
    connected: { label: "Connected", cls: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900", Icon: CheckCircle2 },
    invalid_key: { label: "Invalid Key", cls: "bg-destructive/10 text-destructive border-destructive/20", Icon: XCircle },
    disabled: { label: "Disabled", cls: "bg-muted text-muted-foreground border-border", Icon: AlertCircle },
    unknown: { label: "Untested", cls: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900", Icon: AlertCircle },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${c.cls}`}>
      <c.Icon className="h-3 w-3" /> {c.label}
    </span>
  );
}

export default function AdminAiSettings() {
  const apiBase = import.meta.env.BASE_URL;
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [authStatus, setAuthStatus] = useState<"loading" | "ok" | "401" | "403">("loading");
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [maxTokensDraft, setMaxTokensDraft] = useState<number>(4096);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  // Bootstrap: who am I?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}api/admin/me`, { credentials: "include" });
        if (cancelled) return;
        if (res.status === 401) { setAuthStatus("401"); return; }
        if (res.status === 403) { setAuthStatus("403"); return; }
        if (!res.ok) { setAuthStatus("401"); return; }
        const body = await res.json();
        setUser(body.user);
        setAuthStatus("ok");
      } catch {
        if (!cancelled) setAuthStatus("401");
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  // Load settings once authenticated.
  useEffect(() => {
    if (authStatus !== "ok") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}api/admin/ai-settings`, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as AiSettings;
        if (!cancelled) {
          setSettings(body);
          setMaxTokensDraft(body.maxTokens);
        }
      } catch (err) {
        if (!cancelled) toast({ title: "Could not load AI settings", description: String(err), variant: "destructive" });
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, authStatus, toast]);

  // Redirect handling for unauthenticated.
  useEffect(() => {
    if (authStatus === "401") setLocation("/admin/login");
    if (authStatus === "403") setLocation("/admin/forbidden");
  }, [authStatus, setLocation]);

  if (authStatus !== "ok" || !settings) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading admin portal…
      </div>
    );
  }

  type AiSettingsUpdate = Partial<Omit<AiSettings, "apiKeyLast4">> & { apiKey?: string | null };
  const persist = async (patch: AiSettingsUpdate) => {
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}api/admin/ai-settings`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as AiSettings;
      setSettings(body);
      setMaxTokensDraft(body.maxTokens);
      toast({ title: "Settings saved" });
    } catch (err) {
      toast({ title: "Could not save settings", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const onSaveKey = async () => {
    const trimmed = keyDraft.trim();
    if (trimmed.length === 0) { toast({ title: "Paste an API key first", variant: "destructive" }); return; }
    await persist({ apiKey: trimmed });
    setKeyDraft("");
  };

  const onClearKey = async () => {
    await persist({ apiKey: null });
    setKeyDraft("");
  };

  const onTestKey = async () => {
    setTesting(true);
    try {
      const trimmed = keyDraft.trim();
      const res = await fetch(`${apiBase}api/admin/ai-settings/test-key`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed.length > 0 ? { apiKey: trimmed } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { valid: boolean; message: string; settings: AiSettings };
      setSettings(body.settings);
      toast({
        title: body.valid ? "✅ Connection OK" : "❌ Test failed",
        description: body.message,
        variant: body.valid ? "default" : "destructive",
      });
    } catch (err) {
      toast({ title: "Test failed", description: String(err), variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const onLogout = async () => {
    await fetch(`${apiBase}api/admin/logout`, { method: "POST", credentials: "include" });
    setLocation("/admin/login");
  };

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
            <Badge variant="outline" className="font-mono text-[11px]">{user?.username}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setLocation("/")}>
              <ArrowLeft className="h-4 w-4 mr-1" /> User dashboard
            </Button>
            <Button variant="ghost" size="sm" onClick={onLogout}>
              <LogOut className="h-4 w-4 mr-1" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        <section className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" /> AI settings
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Global, system-wide controls for the AI pipeline. Changes apply to every project. The
              API key is stored securely and never returned to clients in plaintext.
            </p>
          </div>
          <StatusPill status={settings.status} />
        </section>

        {/* Enable */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>Enable AI</CardTitle>
                <CardDescription>
                  When off, every project falls back to deterministic parsing — no AI calls are
                  made.
                </CardDescription>
              </div>
              <Switch
                checked={settings.enabled}
                disabled={busy}
                onCheckedChange={(v) => persist({ enabled: v })}
              />
            </div>
          </CardHeader>
        </Card>

        {/* API key */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" /> OpenAI API key
            </CardTitle>
            <CardDescription>
              {settings.hasKey
                ? `Currently configured: ${settings.keyPreview}`
                : "No key configured. Paste a key below."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="sk-..."
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                disabled={busy || testing}
              />
              <Button onClick={onSaveKey} disabled={busy || keyDraft.trim().length === 0}>
                Save
              </Button>
              <Button
                variant="outline"
                onClick={onTestKey}
                disabled={testing || (!settings.hasKey && keyDraft.trim().length === 0)}
              >
                {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Test API key
              </Button>
              {settings.hasKey && (
                <Button variant="ghost" onClick={onClearKey} disabled={busy}>
                  Remove
                </Button>
              )}
            </div>
            {settings.statusMessage && (
              <div className="text-xs text-muted-foreground">
                Last test result: {settings.statusMessage}
                {settings.lastTestedAt && (
                  <span className="ml-1">
                    ({new Date(settings.lastTestedAt).toLocaleString()})
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Model + caps */}
        <Card>
          <CardHeader>
            <CardTitle>Model &amp; cost controls</CardTitle>
            <CardDescription>
              Choose the model and bound how many tokens each call may consume.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="model">Model</Label>
              <select
                id="model"
                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                value={settings.model}
                disabled={busy}
                onChange={(e) => persist({ model: e.target.value })}
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maxTokens">Max tokens (per call)</Label>
              <div className="flex gap-2">
                <Input
                  id="maxTokens"
                  type="number"
                  min={64}
                  max={32768}
                  value={maxTokensDraft}
                  onChange={(e) => setMaxTokensDraft(Number(e.target.value))}
                  disabled={busy}
                />
                <Button
                  variant="outline"
                  onClick={() => persist({ maxTokens: maxTokensDraft })}
                  disabled={busy || maxTokensDraft === settings.maxTokens}
                >
                  Save
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Hard cap applied by the backend on every AI call.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Master controller */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>Master Controller mode</CardTitle>
                <CardDescription>
                  Combine Semantic Analyzer, Widget Intelligence, and Design Audit into one call.
                  Cuts API usage by ~70%. Recommended on for cost.
                </CardDescription>
              </div>
              <Switch
                checked={settings.masterControllerMode}
                disabled={busy}
                onCheckedChange={(v) => persist({ masterControllerMode: v })}
              />
            </div>
          </CardHeader>
        </Card>

        <p className="text-[11px] text-muted-foreground text-center pt-4">
          Active model: <code className="font-mono">{settings.model}</code> · Updated{" "}
          {new Date(settings.updatedAt).toLocaleString()}
        </p>
      </main>
    </div>
  );
}
