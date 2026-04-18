import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  KeyRound,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AdminShell, AdminLoading, useAdminAuth } from "@/components/admin-shell";

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

interface UsageItem {
  projectId: number | null;
  projectName: string | null;
  engine: string;
  model: string;
  calls: number;
  cacheHits: number;
  tokensTotal: number;
  lastCallAt: string | null;
  estimatedCostUsd: number;
}

interface UsageResponse {
  from: string | null;
  to: string | null;
  items: UsageItem[];
  totals: { calls: number; cacheHits: number; tokensTotal: number; estimatedCostUsd: number };
  pricing: Record<string, number>;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function UsageTab({ apiBase, activeModel }: { apiBase: string; activeModel: string }) {
  const { toast } = useToast();
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      const qs = params.toString();
      const res = await fetch(
        `${apiBase}api/admin/ai-usage${qs ? `?${qs}` : ""}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as UsageResponse;
      setData(body);
    } catch (err) {
      toast({ title: "Could not load usage", description: String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [apiBase, from, to, toast]);

  useEffect(() => { void load(); }, [load]);

  const activeRate = useMemo(
    () => data?.pricing[activeModel] ?? null,
    [data, activeModel],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" /> Token usage by project
          </CardTitle>
          <CardDescription>
            Aggregated from every recorded AI call. Cost is a rough blended estimate based on the
            model used for each row.
            {activeRate !== null && (
              <span className="ml-1">
                Active model <code className="font-mono">{activeModel}</code> ≈ ${activeRate.toFixed(2)}/1M
                tokens.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="usage-from" className="text-xs">From</Label>
              <Input
                id="usage-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-44"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="usage-to" className="text-xs">To</Label>
              <Input
                id="usage-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-44"
              />
            </div>
            <Button variant="outline" onClick={load} disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
            {(from || to) && (
              <Button
                variant="ghost"
                onClick={() => { setFrom(""); setTo(""); }}
                disabled={loading}
              >
                Clear
              </Button>
            )}
          </div>

          {data && data.items.length === 0 ? (
            <div className="rounded-md border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              No AI calls recorded {from || to ? "for this date range" : "yet"}.
            </div>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Engine</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Cache hits</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Est. cost</TableHead>
                    <TableHead>Last call</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.items.map((r, i) => (
                    <TableRow key={`${r.projectId ?? "null"}-${r.engine}-${r.model}-${i}`}>
                      <TableCell className="font-medium">
                        {r.projectName ?? <span className="text-muted-foreground italic">unassigned</span>}
                        {r.projectId !== null && (
                          <span className="text-[10px] text-muted-foreground ml-1.5">#{r.projectId}</span>
                        )}
                      </TableCell>
                      <TableCell><Badge variant="outline" className="font-mono text-[10px]">{r.engine}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{r.model}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.calls)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(r.cacheHits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.tokensTotal)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatUsd(r.estimatedCostUsd)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.lastCallAt ? new Date(r.lastCallAt).toLocaleString() : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data && data.items.length > 0 && (
                    <TableRow className="bg-muted/40 font-medium">
                      <TableCell colSpan={3}>Total</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(data.totals.calls)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber(data.totals.cacheHits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(data.totals.tokensTotal)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatUsd(data.totals.estimatedCostUsd)}</TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Cost figures are approximate, blended prompt+completion estimates per model — useful for
            spotting runaway usage, not for billing reconciliation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminAiSettings() {
  const apiBase = import.meta.env.BASE_URL;
  const { toast } = useToast();
  const { user, status: authStatus } = useAdminAuth();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [maxTokensDraft, setMaxTokensDraft] = useState<number>(4096);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

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

  if (authStatus !== "ok" || !settings) {
    return <AdminLoading />;
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

  return (
    <AdminShell user={user} active="ai-settings">
      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        <section className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" /> AI control center
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Global, system-wide controls for the AI pipeline plus per-project token usage.
              The API key is stored securely and never returned to clients in plaintext.
            </p>
          </div>
          <StatusPill status={settings.status} />
        </section>

        <Tabs defaultValue="settings" className="space-y-6">
          <TabsList>
            <TabsTrigger value="settings">
              <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Settings
            </TabsTrigger>
            <TabsTrigger value="usage">
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Usage
            </TabsTrigger>
          </TabsList>

          <TabsContent value="settings" className="space-y-6">
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
          </TabsContent>

          <TabsContent value="usage" className="space-y-6">
            <UsageTab apiBase={apiBase} activeModel={settings.model} />
          </TabsContent>
        </Tabs>
      </main>
    </AdminShell>
  );
}
