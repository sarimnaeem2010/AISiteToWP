import { useState, useEffect } from "react";
import { Link, useParams, useLocation } from "wouter";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, ChevronDown, Download, FileCode2, Globe, LayoutTemplate, Settings2, Trash2, Shield, UploadCloud, Eye, AlertCircle, Database, Layers, Sparkles, Palette, Ruler, Type as TypeIcon, CornerDownRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useGetProject, useUpdateWordPressConfig, useTestWordPressConnection, useDeleteProject } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

const wpConfigSchema = z
  .object({
    wpUrl: z.string().url("Must be a valid URL"),
    authMode: z.enum(["basic", "api_key"]).default("basic"),
    wpUsername: z.string().default(""),
    wpAppPassword: z.string().default(""),
    wpApiKey: z.string().default(""),
    useAcf: z.boolean().default(true),
  })
  .refine(
    (d) => d.authMode !== "basic" || (d.wpUsername.length > 0 && d.wpAppPassword.length > 0),
    { message: "Username and app password are required for basic auth", path: ["wpAppPassword"] }
  )
  .refine(
    (d) => d.authMode !== "api_key" || d.wpApiKey.length > 0,
    { message: "API key is required", path: ["wpApiKey"] }
  );

type ConversionMode = "shell" | "deep" | "legacy" | "legacy_native";

const CONVERSION_MODE_OPTIONS: { value: ConversionMode; title: string; description: string }[] = [
  {
    value: "shell",
    title: "Shell (Recommended)",
    description: "Native Section + Column shells; original markup preserved verbatim. 100% visual fidelity, sidebar-clickable structure.",
  },
  {
    value: "deep",
    title: "Deep",
    description: "Every leaf becomes a native Elementor widget. Best for clean modern pages; risky for canvas, forms, custom SVG widgets.",
  },
  {
    value: "legacy",
    title: "Legacy",
    description: "Disable native decomposition; fall back to the custom-widget PHP path. Use only if Shell or Deep break the import.",
  },
  {
    value: "legacy_native",
    title: "Legacy + Native UI",
    description: "Same byte-identical render path as Legacy, but each leaf gets a native-Elementor-style sidebar (Typography, Color, Background, Border) scoped to its own CSS hook.",
  },
];

function isConversionMode(v: unknown): v is ConversionMode {
  return v === "shell" || v === "deep" || v === "legacy" || v === "legacy_native";
}

interface DesignTokens {
  spacing: Record<string, string>;
  fontSize: Record<string, string>;
  color: Record<string, string>;
  radius: Record<string, string>;
}

interface AiPublicStatus {
  aiEnabled: boolean;
  aiStatus: "connected" | "invalid_key" | "disabled" | "unknown";
  model: string;
  lastRunAt: string | null;
  cacheEntries: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * Read-only AI status indicator for a project. Shows whether AI is on
 * globally, when the project was last analyzed, and how much of that
 * analysis is cached. Never reveals the API key or any settings detail.
 */
function ProjectAiStatusPill({ projectId }: { projectId: string }) {
  const apiBase = import.meta.env.BASE_URL;
  const [status, setStatus] = useState<AiPublicStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}api/projects/${projectId}/ai-status`);
        if (!res.ok) return;
        const body = (await res.json()) as AiPublicStatus;
        if (!cancelled) setStatus(body);
      } catch { /* silent — status is informational only */ }
    })();
    return () => { cancelled = true; };
  }, [apiBase, projectId]);
  if (!status) return null;
  const label = status.aiEnabled
    ? `AI on (${status.model}) · last run ${relativeTime(status.lastRunAt)}${status.cacheEntries > 0 ? ` · ${status.cacheEntries} cached` : ""}`
    : "Deterministic parser (AI off)";
  const cls = status.aiEnabled
    ? "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900"
    : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${cls}`}
      title={status.lastRunAt ? `Last run: ${new Date(status.lastRunAt).toLocaleString()}` : "Not analyzed yet"}
    >
      {label}
    </span>
  );
}

function DesignTokensCard({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const apiBase = import.meta.env.BASE_URL;
  const [tokens, setTokens] = useState<DesignTokens | null>(null);
  const [source, setSource] = useState<"persisted" | "extracted" | "default">("default");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}api/projects/${projectId}/tokens`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { tokens: DesignTokens; source: typeof source };
        if (!cancelled) {
          setTokens(body.tokens);
          setSource(body.source);
        }
      } catch (err) {
        if (!cancelled) {
          toast({
            title: "Could not load design tokens",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [apiBase, projectId, toast]);

  const updateValue = (group: keyof DesignTokens, key: string, value: string) => {
    setTokens((cur) => (cur ? { ...cur, [group]: { ...cur[group], [key]: value } } : cur));
  };

  const onSave = async () => {
    if (!tokens) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}api/projects/${projectId}/tokens`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokens),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tokens: DesignTokens; source: typeof source };
      setTokens(body.tokens);
      setSource(body.source);
      toast({ title: "Design tokens saved", description: "Re-export the theme to apply them." });
    } catch (err) {
      toast({
        title: "Could not save design tokens",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const renderGroup = (
    group: keyof DesignTokens,
    label: string,
    icon: React.ElementType,
    isColor = false,
  ) => {
    if (!tokens) return null;
    const entries = Object.entries(tokens[group]);
    const Icon = icon;
    return (
      <Collapsible defaultOpen className="rounded-lg border border-border bg-muted/30">
        <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="text-sm font-semibold">{label}</span>
            <span className="text-xs text-muted-foreground">{entries.length} tokens</span>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border bg-card px-4 py-4">
          {isColor && entries.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {entries.map(([k, v]) => (
                <div key={`sw-${k}`} className="flex items-center gap-1.5 bg-muted/40 border border-border rounded-md pl-1 pr-2 py-1">
                  <span
                    className="h-5 w-5 rounded border border-border shadow-xs"
                    style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(v) ? v : "transparent" }}
                    title={v}
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">{k}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {entries.map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <label className="text-[11px] font-mono w-14 text-muted-foreground shrink-0">{k}</label>
                {isColor && (
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(v) ? v : "#000000"}
                    onChange={(e) => updateValue(group, k, e.target.value.toUpperCase())}
                    className="h-8 w-10 rounded-md border border-border bg-transparent cursor-pointer"
                    disabled={saving}
                  />
                )}
                <input
                  type="text"
                  value={v}
                  onChange={(e) => updateValue(group, k, e.target.value)}
                  className="flex-1 h-8 rounded-md border border-border bg-card px-2.5 text-xs font-mono shadow-xs focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                  disabled={saving}
                />
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const sourceLabel: Record<typeof source, string> = {
    persisted: "Saved — your edits",
    extracted: "Auto-extracted from source CSS",
    default:   "Built-in defaults",
  };

  const sourceVariant: Record<typeof source, string> = {
    persisted: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
    extracted: "bg-primary/10 text-primary border-primary/20",
    default:   "bg-muted text-muted-foreground border-border",
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary" />
              Design tokens
            </CardTitle>
            <CardDescription>
              Project-wide spacing, type scale, palette and radii. Emitted as <code className="font-mono text-[11px] bg-muted px-1 py-0.5 rounded">:root</code> CSS variables in the generated theme.
            </CardDescription>
          </div>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium shrink-0 ${sourceVariant[source]}`}>
            {sourceLabel[source]}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !tokens ? (
          <div className="text-sm text-muted-foreground">Loading tokens…</div>
        ) : (
          <div className="space-y-3">
            {renderGroup("color",    "Color",     Palette, true)}
            {renderGroup("spacing",  "Spacing",   Ruler)}
            {renderGroup("fontSize", "Font size", TypeIcon)}
            {renderGroup("radius",   "Radius",    CornerDownRight)}
            <div className="flex justify-end pt-2">
              <Button type="button" onClick={onSave} disabled={saving} size="sm">
                {saving ? "Saving…" : "Save tokens"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConversionModeCard({
  projectId,
  project,
  onSaved,
}: {
  projectId: string;
  project: { conversionMode?: ConversionMode | null };
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const apiBase = import.meta.env.BASE_URL;
  const serverMode: ConversionMode = isConversionMode(project.conversionMode)
    ? project.conversionMode
    : "shell";
  // `mode` is the optimistic display value; `lastSavedMode` always
  // reflects the most recently confirmed (200 OK) value from the
  // server, so a failed request rolls back to the correct state even
  // after several quick changes.
  const [mode, setMode] = useState<ConversionMode>(serverMode);
  const [lastSavedMode, setLastSavedMode] = useState<ConversionMode>(serverMode);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(serverMode);
    setLastSavedMode(serverMode);
  }, [serverMode]);

  const onSelect = async (next: ConversionMode) => {
    if (next === mode) return;
    const previous = lastSavedMode;
    setMode(next);
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}api/projects/${projectId}/conversion-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversionMode: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { conversionMode?: unknown };
      const confirmed: ConversionMode = isConversionMode(body.conversionMode)
        ? body.conversionMode
        : next;
      setLastSavedMode(confirmed);
      setMode(confirmed);
      toast({ title: "Conversion mode updated", description: `Re-import the source to apply "${confirmed}".` });
      onSaved();
    } catch (err) {
      setMode(previous);
      toast({
        title: "Error updating conversion mode",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          Conversion mode
        </CardTitle>
        <CardDescription>
          Controls how imported HTML is decomposed into Elementor. Changes take effect on the next re-import.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {CONVERSION_MODE_OPTIONS.map((opt) => {
            const active = mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={saving}
                onClick={() => onSelect(opt.value)}
                className={`text-left rounded-lg border p-4 transition-all relative ${
                  active
                    ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/20"
                    : "border-border bg-card hover:border-primary/40 hover:bg-muted/30"
                } ${saving ? "opacity-60 cursor-wait" : "cursor-pointer"}`}
              >
                {active && (
                  <span className="absolute top-2 right-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" />
                  </span>
                )}
                <div className="text-sm font-semibold mb-1">{opt.title}</div>
                <div className="text-xs text-muted-foreground leading-relaxed">{opt.description}</div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [, setLocation] = useLocation(); // We'll add this hook from wouter
  
  const { data: project, isLoading, refetch } = useGetProject(id || "", { query: { enabled: !!id } });
  
  const updateConfig = useUpdateWordPressConfig();
  const testConnection = useTestWordPressConnection();
  const deleteProject = useDeleteProject();

  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    pluginVersion?: string | null;
    expectedPluginVersion?: string | null;
    pluginOutdated?: boolean | null;
  } | null>(null);
  const [pastedHtml, setPastedHtml] = useState("");
  const [reparsing, setReparsing] = useState(false);
  const [scrapeUrlInput, setScrapeUrlInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLog, setChatLog] = useState<Array<{ role: "user" | "ai"; text: string }>>([]);
  const [themeStatus, setThemeStatus] = useState<{
    reachable: boolean;
    matches: boolean;
    activeThemeSlug: string | null;
    activeThemeName: string | null;
    expectedThemeSlug: string;
    requiresCustomTheme: boolean;
    reason: string | null;
  } | null>(null);
  const [pushing, setPushing] = useState(false);

  const form = useForm<z.infer<typeof wpConfigSchema>>({
    resolver: zodResolver(wpConfigSchema),
    defaultValues: {
      wpUrl: project?.wpConfig?.wpUrl || "",
      authMode: (project?.wpConfig?.authMode as "basic" | "api_key") || "basic",
      wpUsername: project?.wpConfig?.wpUsername || "",
      wpAppPassword: project?.wpConfig?.wpAppPassword || "",
      wpApiKey: project?.wpConfig?.wpApiKey || "",
      useAcf: project?.wpConfig?.useAcf ?? true,
    },
  });

  const currentAuthMode = form.watch("authMode");

  useEffect(() => {
    if (project?.wpConfig) {
      form.reset({
        wpUrl: project.wpConfig.wpUrl,
        authMode: (project.wpConfig.authMode as "basic" | "api_key") || "basic",
        wpUsername: project.wpConfig.wpUsername ?? "",
        wpAppPassword: project.wpConfig.wpAppPassword === "••••••••" ? "" : (project.wpConfig.wpAppPassword ?? ""),
        wpApiKey: project.wpConfig.wpApiKey === "••••••••" ? "" : (project.wpConfig.wpApiKey ?? ""),
        useAcf: project.wpConfig.useAcf ?? true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.wpConfig?.wpUrl, project?.wpConfig?.wpUsername, project?.wpConfig?.authMode, project?.wpConfig?.useAcf]);

  // Probe the target site for the active theme when this project is in
  // pixel-perfect mode. The push button uses this to warn the user before
  // they push pages that depend on a custom theme that's not yet active.
  const apiBaseEarly = import.meta.env.BASE_URL;
  const projAny = project as { renderer?: string; wpConfig?: { wpUrl?: string; authMode?: string } } | undefined;
  const isPixelPerfect = projAny?.renderer === "pixel_perfect";
  const isApiKeyMode = projAny?.wpConfig?.authMode === "api_key";
  useEffect(() => {
    if (!id || !isPixelPerfect || !projAny?.wpConfig?.wpUrl || !isApiKeyMode) {
      setThemeStatus(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBaseEarly}api/projects/${id}/active-theme`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setThemeStatus(data);
      } catch {
        /* fail-soft: no warning shown if probe fails */
      }
    })();
    return () => { cancelled = true; };
  }, [id, isPixelPerfect, projAny?.wpConfig?.wpUrl, isApiKeyMode, apiBaseEarly, project?.lastPushedAt]);

  if (isLoading || !project) {
    return <div className="p-8 text-center font-mono text-muted-foreground">Loading project workspace...</div>;
  }

  const currentStep = 
    project.status === "created" ? 1 : 
    project.status === "parsed" ? 2 :
    project.status === "configured" ? 3 : 4;

  const onSaveConfig = (data: z.infer<typeof wpConfigSchema>) => {
    updateConfig.mutate({ id, data }, {
      onSuccess: () => {
        toast({ title: "Configuration saved" });
        refetch();
      },
      onError: (err) => {
        toast({ title: "Error saving", description: err.message, variant: "destructive" });
      }
    });
  };

  const onTestConnection = async () => {
    setTestResult(null);
    const data = form.getValues();
    if (!data.wpUrl) {
      setTestResult({ success: false, message: "Enter a WordPress URL first." });
      return;
    }
    if (data.authMode === "api_key" && !data.wpApiKey) {
      setTestResult({ success: false, message: "Paste the Plugin API Key first (see Companion Plugin page)." });
      return;
    }
    if (data.authMode === "basic" && (!data.wpUsername || !data.wpAppPassword)) {
      setTestResult({ success: false, message: "Enter username and application password first." });
      return;
    }
    // Auto-save so Test Connection reflects what's in the form
    try {
      await updateConfig.mutateAsync({ id, data });
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    testConnection.mutate({ id }, {
      onSuccess: (res) => {
        setTestResult(res);
        if (res.success) {
          toast({ title: "Connection Successful", description: `Connected to ${res.siteTitle || "WordPress"}` });
          refetch();
        }
      },
      onError: (err) => {
        setTestResult({ success: false, message: err.message });
      }
    });
  };

  const doPush = async (force: boolean): Promise<void> => {
    setPushing(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/projects/${id}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      // Theme-not-active warning: prompt to override or cancel.
      const warning = (data as { warning?: string }).warning;
      if (res.status === 409 && (warning === "theme_not_active" || warning === "plugin_outdated")) {
        const d = data as { message?: string; expectedThemeSlug?: string; activeThemeSlug?: string };
        const proceed = window.confirm(
          `${d.message ?? "Custom theme not active on target site."}\n\n` +
            `Expected theme: ${d.expectedThemeSlug}\nActive theme:   ${d.activeThemeSlug ?? "unknown"}\n\n` +
            `Click OK to push anyway, or Cancel to install/activate the theme first.`,
        );
        if (proceed) {
          await doPush(true);
        }
        return;
      }
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      const r = data as {
        success?: boolean;
        pagesCreated?: number;
        pagesUpdated?: number;
        cptItemsCreated?: number;
        cptItemsUpdated?: number;
      };
      const created = r.pagesCreated ?? 0;
      const updated = r.pagesUpdated ?? 0;
      const cptCount = (r.cptItemsCreated ?? 0) + (r.cptItemsUpdated ?? 0);
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} created`);
      if (updated > 0) parts.push(`${updated} updated`);
      if (cptCount > 0) parts.push(`${cptCount} CPT items`);
      const desc = parts.length > 0 ? `Pages: ${parts.join(", ")}.` : "No changes were applied.";
      if (r.success) {
        toast({ title: "Push Successful", description: desc });
      } else {
        toast({ title: "Push completed with errors", description: desc, variant: "destructive" });
      }
      refetch();
    } catch (err) {
      toast({ title: "Push Failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setPushing(false);
    }
  };
  const onPush = () => { void doPush(false); };

  const apiBase = import.meta.env.BASE_URL;
  const proj = project as any;
  // Renderer is fixed since the Elementor-only pivot — every project pushes
  // through the generated child theme. We keep the variable so downstream
  // conditionals (theme-status warnings, install/activate buttons) stay
  // mounted; the legacy renderer choice UI was removed.
  const renderer = "pixel_perfect" as const;
  const cpts: Array<{ slug: string; label: string; pluralLabel: string; sourceSemanticType: string; fields: string[]; enabled: boolean }> =
    Array.isArray(proj.customPostTypes) ? proj.customPostTypes : [];

  const reuploadZip = async (file: File) => {
    setReparsing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${apiBase}api/projects/${id}/upload-zip`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      toast({ title: "Source re-uploaded", description: "Project re-parsed from ZIP. Elementor widgets regenerated." });
      refetch();
    } catch (err) {
      toast({ title: "Re-upload failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setReparsing(false);
    }
  };

  const reparseHtml = async (html: string) => {
    setReparsing(true);
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ htmlContent: html }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      toast({ title: "HTML re-parsed", description: "Elementor widgets regenerated from the new source." });
      setPastedHtml("");
      refetch();
    } catch (err) {
      toast({ title: "Re-parse failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setReparsing(false);
    }
  };

  const scrapeFromUrl = async (url: string) => {
    setReparsing(true);
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/scrape-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      toast({ title: "URL scraped & parsed", description: "Site structure extracted from the live URL." });
      setScrapeUrlInput("");
      refetch();
    } catch (err) {
      toast({ title: "URL scrape failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setReparsing(false);
    }
  };

  const sendChatMessage = async (text: string) => {
    if (!text.trim() || chatBusy) return;
    setChatBusy(true);
    setChatLog((prev) => [...prev, { role: "user", text }]);
    setChatInput("");
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/chat-refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      const summary = (data as { summary?: string }).summary || "Layout updated.";
      setChatLog((prev) => [...prev, { role: "ai", text: summary }]);
      refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setChatLog((prev) => [...prev, { role: "ai", text: `Error: ${msg}` }]);
    } finally {
      setChatBusy(false);
    }
  };

  const downloadThemeZip = async () => {
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/theme-zip`);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(proj.name ?? "site").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-theme.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Theme ZIP downloaded", description: "Upload via WordPress → Appearance → Themes → Add New → Upload Theme." });
    } catch (err) {
      toast({ title: "Theme ZIP failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const installTheme = async () => {
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/install-theme`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { message?: string; error?: string }).message || (data as { error?: string }).error || `HTTP ${res.status}`);
      toast({
        title: "Theme installed",
        description: `${(data as { blocksRegistered?: number }).blocksRegistered ?? 0} custom blocks bundled. Now click Activate to switch the site to this theme.`,
      });
    } catch (err) {
      toast({ title: "Theme install failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const activateTheme = async () => {
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/activate-theme`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { message?: string; error?: string }).message || (data as { error?: string }).error || `HTTP ${res.status}`);
      toast({
        title: "Theme activated",
        description: `${(data as { themeSlug?: string }).themeSlug ?? "Theme"} is now the active theme on your site.`,
      });
    } catch (err) {
      toast({ title: "Activation failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };


  const toggleCpt = async (slug: string, enabled: boolean) => {
    const next = cpts.map((c) => (c.slug === slug ? { ...c, enabled } : c));
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/custom-post-types`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customPostTypes: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refetch();
    } catch (err) {
      toast({ title: "Failed to update CPTs", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const onDelete = () => {
    deleteProject.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Project deleted" });
        window.location.href = "/";
      }
    });
  };

  const statusBadgeClass: Record<string, string> = {
    created:    "bg-muted text-muted-foreground border-border",
    parsed:     "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
    configured: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    pushed:     "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
    error:      "bg-destructive/10 text-destructive border-destructive/20",
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500 pb-20">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="space-y-3 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-mono text-muted-foreground">
              ID • {project.id.slice(0, 8)}
            </span>
            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider ${statusBadgeClass[project.status] || statusBadgeClass.created}`}>
              {project.status}
            </span>
            <ProjectAiStatusPill projectId={id!} />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight truncate">{project.name}</h1>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Globe className="h-4 w-4" />
            {project.wpConfig?.wpUrl || "No target URL configured"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {project.status !== "created" && (
            <Button
              variant="outline"
              onClick={() => {
                const base = import.meta.env.BASE_URL;
                window.location.href = `${base}api/projects/${id}/astro-export`;
              }}
            >
              <FileCode2 className="h-4 w-4" />
              Export Astro
            </Button>
          )}
          <Link href={`/projects/${id}/plugin`}>
            <Button variant="outline">
              <Download className="h-4 w-4" />
              Get plugin
            </Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete project</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this conversion project? This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Stepper */}
      <div className="rounded-xl border border-card-border bg-card shadow-xs p-5">
        <div className="flex items-center justify-between">
          {[
            { step: 1, label: "Source", icon: FileCode2 },
            { step: 2, label: "Parse", icon: LayoutTemplate },
            { step: 3, label: "Config", icon: Settings2 },
            { step: 4, label: "Deploy", icon: UploadCloud },
          ].map((s, i, arr) => {
            const done = currentStep > s.step;
            const active = currentStep === s.step;
            return (
              <div key={s.step} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-2 min-w-[64px]">
                  <div className={`h-10 w-10 rounded-full flex items-center justify-center transition-colors ${
                    done
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : active
                        ? "bg-primary/10 text-primary border border-primary/30"
                        : "bg-muted text-muted-foreground"
                  }`}>
                    {done ? <Check className="h-5 w-5" /> : <s.icon className="h-5 w-5" />}
                  </div>
                  <span className={`text-xs font-medium ${active || done ? "text-foreground" : "text-muted-foreground"}`}>{s.label}</span>
                </div>
                {i < arr.length - 1 && (
                  <div className={`flex-1 h-px mx-2 sm:mx-3 ${done ? "bg-primary/40" : "bg-border"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-6">
        {/* Stacked section cards */}
        <div className="space-y-6">
          {project.status === "created" && (
            <Card>
              <CardHeader>
                <CardTitle>Waiting for structure</CardTitle>
                <CardDescription>Parse a source to continue.</CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/projects/new">
                  <Button>Go to parse step</Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {currentStep >= 2 && project.parsedSite && (
            <Card className="overflow-hidden border-emerald-200/70 dark:border-emerald-900/50">
              <div className="bg-emerald-50/60 dark:bg-emerald-950/20 border-b border-emerald-100 dark:border-emerald-900/40 px-5 py-4 flex items-center justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-300">
                    <Check className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-base">Structure parsed</h3>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Found {project.parsedSite.pages.length} pages and {project.parsedSite.pages.reduce((acc, p) => acc + p.sections.length, 0)} blocks.
                    </p>
                  </div>
                </div>
                <Link href={`/projects/${id}/preview`}>
                  <Button variant="outline" size="sm">
                    <Eye className="h-4 w-4" />
                    Preview
                  </Button>
                </Link>
              </div>
            </Card>
          )}

          {currentStep >= 2 && project.parsedSite && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" />
                  Layout assistant
                </CardTitle>
                <CardDescription>
                  Refine your parsed structure in plain English. Try things like
                  <span className="italic"> "make the header sticky"</span>,
                  <span className="italic"> "add a 3-column features section about pricing"</span>, or
                  <span className="italic"> "remove the testimonials"</span>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {chatLog.length > 0 && (
                  <ScrollArea className="h-48 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="space-y-2.5">
                      {chatLog.map((m, i) => (
                        <div
                          key={i}
                          className="text-sm flex gap-2"
                          data-testid={`chat-message-${m.role}`}
                        >
                          <span className={`shrink-0 inline-flex h-5 px-1.5 items-center rounded text-[10px] font-semibold uppercase tracking-wider ${m.role === "user" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>
                            {m.role === "user" ? "you" : "ai"}
                          </span>
                          <span className="text-foreground">{m.text}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
                <div className="flex gap-2">
                  <Input
                    type="text"
                    placeholder='e.g. "Change background to dark"'
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendChatMessage(chatInput);
                      }
                    }}
                    disabled={chatBusy}
                    data-testid="input-chat-instruction"
                  />
                  <Button
                    type="button"
                    onClick={() => sendChatMessage(chatInput)}
                    disabled={chatBusy || chatInput.trim().length === 0}
                    data-testid="button-chat-send"
                  >
                    {chatBusy ? "Thinking…" : "Send"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {currentStep >= 2 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileCode2 className="h-5 w-5 text-primary" />
                  Source files
                </CardTitle>
                <CardDescription>
                  Re-upload a ZIP or paste source HTML to refresh the parsed structure and regenerate the per-section Elementor widgets.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                    proj.sourceHtml || proj.uploadedFiles
                      ? "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900"
                      : "bg-muted text-muted-foreground border-border"
                  }`}>
                    {proj.sourceHtml ? "Source HTML stored" : proj.uploadedFiles ? "ZIP files stored" : "No source on file"}
                  </span>
                  {!proj.sourceHtml && (
                    <span className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5" />
                      Re-upload required to regenerate the Elementor widgets.
                    </span>
                  )}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Re-upload ZIP</Label>
                    <Input
                      type="file"
                      accept=".zip,application/zip"
                      className="text-xs"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) reuploadZip(f);
                        e.currentTarget.value = "";
                      }}
                      disabled={reparsing}
                      data-testid="input-reupload-zip"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Or paste HTML</Label>
                    <div className="flex gap-2">
                      <Input
                        type="text"
                        placeholder="<html>…</html>"
                        className="font-mono text-xs"
                        value={pastedHtml}
                        onChange={(e) => setPastedHtml(e.target.value)}
                        disabled={reparsing}
                        data-testid="input-paste-html"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => reparseHtml(pastedHtml)}
                        disabled={reparsing || pastedHtml.trim().length === 0}
                        data-testid="button-reparse-html"
                      >
                        {reparsing ? "Parsing…" : "Re-parse"}
                      </Button>
                    </div>
                  </div>
                  <div className="md:col-span-2 space-y-1.5">
                    <Label className="text-xs">Or fetch from a live URL</Label>
                    <div className="flex gap-2">
                      <Input
                        type="url"
                        placeholder="https://example.com"
                        value={scrapeUrlInput}
                        onChange={(e) => setScrapeUrlInput(e.target.value)}
                        disabled={reparsing}
                        data-testid="input-scrape-url"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => scrapeFromUrl(scrapeUrlInput)}
                        disabled={reparsing || scrapeUrlInput.trim().length === 0}
                        data-testid="button-scrape-url"
                      >
                        <Globe className="h-3.5 w-3.5" />
                        {reparsing ? "Fetching…" : "Scrape"}
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Public http(s) URLs only. Private/loopback addresses are blocked.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {currentStep >= 2 && (
            <ConversionModeCard
              projectId={id!}
              project={{
                conversionMode: (() => {
                  const v = (project as unknown as { conversionMode?: unknown }).conversionMode;
                  return isConversionMode(v) ? v : undefined;
                })(),
              }}
              onSaved={() => refetch()}
            />
          )}

          {currentStep >= 2 && <DesignTokensCard projectId={id!} />}

          {currentStep >= 2 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings2 className="h-5 w-5 text-primary" />
                  WordPress target
                </CardTitle>
                <CardDescription>Configure credentials for the target WordPress instance.</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSaveConfig)} className="space-y-5">
                    <FormField
                      control={form.control}
                      name="wpUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>WordPress URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://my-wp-site.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="authMode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Auth mode</FormLabel>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {[
                              { v: "basic" as const,   t: "Application password", d: "Admin user + app password via WP REST" },
                              { v: "api_key" as const, t: "Plugin API key",       d: "Install bridge plugin, paste its API key" },
                            ].map(({ v, t, d }) => {
                              const active = field.value === v;
                              return (
                                <button
                                  key={v}
                                  type="button"
                                  onClick={() => field.onChange(v)}
                                  className={`text-left rounded-lg border p-3.5 transition-all relative ${
                                    active
                                      ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary/20"
                                      : "border-border bg-card hover:border-primary/40 hover:bg-muted/30"
                                  }`}
                                >
                                  {active && (
                                    <span className="absolute top-2 right-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                      <Check className="h-3 w-3" />
                                    </span>
                                  )}
                                  <div className="text-sm font-semibold mb-0.5">{t}</div>
                                  <div className="text-xs text-muted-foreground">{d}</div>
                                </button>
                              );
                            })}
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {currentAuthMode === "basic" && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name="wpUsername"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Admin username</FormLabel>
                              <FormControl>
                                <Input placeholder="admin" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="wpAppPassword"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Application password</FormLabel>
                              <FormControl>
                                <Input type="password" placeholder="xxxx xxxx xxxx xxxx" className="font-mono" {...field} />
                              </FormControl>
                              <FormDescription className="text-[11px]">Generate in WP profile settings.</FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    )}
                    {currentAuthMode === "api_key" && (
                      <FormField
                        control={form.control}
                        name="wpApiKey"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Plugin API key</FormLabel>
                            <FormControl>
                              <Input type="password" placeholder="paste key from Get Plugin screen" className="font-mono" {...field} />
                            </FormControl>
                            <FormDescription className="text-[11px]">Generated and embedded by the bridge plugin PHP file (see Get Plugin).</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <div className="space-y-2">
                      <Label>Output</Label>
                      <div
                        className="rounded-lg border border-primary/30 bg-primary/5 p-4"
                        data-testid="renderer-pixel_perfect"
                      >
                        <div className="font-semibold flex items-center gap-2 text-sm">
                          <Sparkles className="h-4 w-4 text-primary" /> Elementor + custom theme
                        </div>
                        <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                          Generates a child theme with one Elementor widget per section. Each widget exposes
                          native control groups (Button text + link, Image + alt, Heading + tag, etc.) so the
                          sidebar in Elementor feels like a stock widget. Install the theme on your WordPress
                          site first, then push your pages.
                        </div>
                      </div>
                      {renderer === "pixel_perfect" && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={downloadThemeZip}
                            data-testid="button-download-theme-zip"
                          >
                            <Download className="h-3.5 w-3.5" /> Download ZIP
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={installTheme}
                            data-testid="button-install-theme"
                          >
                            <UploadCloud className="h-3.5 w-3.5" /> Install theme
                          </Button>
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            onClick={activateTheme}
                            data-testid="button-activate-theme"
                          >
                            <Check className="h-3.5 w-3.5" /> Activate theme
                          </Button>
                        </div>
                      )}
                    </div>
                    <FormField
                      control={form.control}
                      name="useAcf"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-4 bg-card">
                          <div className="space-y-0.5">
                            <FormLabel>Advanced Custom Fields</FormLabel>
                            <FormDescription>
                              Map parsed data to ACF fields backing the Elementor widgets in the generated child theme.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <div className="flex items-center gap-3 pt-4 border-t border-border">
                      <Button type="submit" disabled={updateConfig.isPending}>
                        {updateConfig.isPending ? "Saving…" : "Save config"}
                      </Button>
                      <Button type="button" variant="outline" onClick={onTestConnection} disabled={testConnection.isPending}>
                        {testConnection.isPending ? "Testing…" : "Test connection"}
                      </Button>
                    </div>

                    {testResult && (
                      <div className="space-y-2 mt-4">
                        <div className={`p-3.5 rounded-lg text-sm flex items-start gap-2.5 border ${
                          testResult.success
                            ? "bg-emerald-50 text-emerald-800 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900"
                            : "bg-destructive/10 text-destructive border-destructive/20"
                        }`}>
                          {testResult.success ? <Check className="h-4 w-4 mt-0.5 shrink-0" /> : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                          <div>
                            <div className="font-semibold">{testResult.success ? "Connection verified" : "Connection failed"}</div>
                            <div className="opacity-90 mt-0.5">{testResult.message}</div>
                          </div>
                        </div>
                        {testResult.pluginOutdated && testResult.pluginVersion && testResult.expectedPluginVersion && (
                          <div className="p-3.5 rounded-lg text-sm flex items-start gap-2.5 bg-amber-50 text-amber-800 border border-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900">
                            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                            <div>
                              <div className="font-semibold">Companion plugin out of date</div>
                              <div className="opacity-90 mt-0.5">
                                Installed plugin is v{testResult.pluginVersion}, but this server expects v{testResult.expectedPluginVersion}.
                                Re-download from the <span className="font-semibold">Get Plugin</span> page and re-upload to your site
                                so the new pre-flight theme check is enabled.
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </form>
                </Form>
              </CardContent>
            </Card>
          )}

          {currentStep >= 2 && cpts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-primary" />
                  Custom post types
                  <span className="ml-1 inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary uppercase tracking-wider">
                    AI-detected
                  </span>
                </CardTitle>
                <CardDescription>
                  Repeated content patterns detected. Enabled types will be registered by the plugin and pushed as CPT entries instead of inline page sections.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2.5">
                  {cpts.map((cpt) => (
                    <div key={cpt.slug} className="flex items-center justify-between rounded-lg border border-border p-3.5 bg-muted/30">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold">{cpt.label}</span>
                          <span className="font-mono text-[11px] text-muted-foreground bg-muted/60 border border-border rounded px-1.5 py-0.5">{cpt.slug}</span>
                          {cpt.sourceSemanticType && (
                            <span className="text-[11px] text-muted-foreground">from {cpt.sourceSemanticType}</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {(cpt.fields?.length ?? 0)} fields · {cpt.enabled ? "will register & import" : "disabled"}
                        </p>
                      </div>
                      <Switch
                        checked={cpt.enabled !== false}
                        onCheckedChange={(checked) => toggleCpt(cpt.slug, checked)}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-4">
                  After toggling CPTs, re-download the companion plugin from the Get Plugin page so the new CPT registrations take effect on activation.
                </p>
              </CardContent>
            </Card>
          )}

          {currentStep >= 3 && (
            <Card className={project.status === "configured" ? "border-primary/40 shadow-md" : ""}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UploadCloud className="h-5 w-5 text-primary" />
                  Deploy to WordPress
                </CardTitle>
                <CardDescription>Push the generated structure and design system to your WP instance.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-lg bg-muted/30 p-4 border border-border mb-6">
                  <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Shield className="h-4 w-4 text-amber-500" />
                    Pre-flight check
                  </h4>
                  <ul className="text-sm space-y-2 text-muted-foreground">
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-500" /> Parsed structure ready</li>
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-500" /> WP REST API reachable</li>
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-emerald-500" /> Plugin companion ready</li>
                  </ul>
                </div>
                {(() => {
                  const themeMissing =
                    renderer === "pixel_perfect" &&
                    themeStatus !== null &&
                    themeStatus.requiresCustomTheme &&
                    themeStatus.reachable &&
                    !themeStatus.matches;
                  const themeUnknown =
                    renderer === "pixel_perfect" &&
                    (themeStatus === null || !themeStatus.reachable);
                  const tooltip = themeMissing
                    ? `The pixel-perfect theme "${themeStatus?.expectedThemeSlug}" is not active on the target site (active: "${themeStatus?.activeThemeSlug ?? "unknown"}"). Pages will render as "unknown block" placeholders. Install and activate the theme above first, or push anyway to override.`
                    : themeUnknown && renderer === "pixel_perfect"
                      ? "Could not verify the active theme on the target site (api-key auth required). Pixel-perfect mode needs the generated theme installed and active before pushing — install/activate it above first."
                      : "";
                  const button = (
                    <Button
                      size="lg"
                      className={`w-full text-base h-14 ${themeMissing ? "border-amber-400 bg-amber-50 hover:bg-amber-100 text-amber-800 dark:border-amber-500 dark:bg-amber-950/40 dark:hover:bg-amber-950/60 dark:text-amber-300" : ""}`}
                      variant={themeMissing ? "outline" : "default"}
                      onClick={onPush}
                      disabled={pushing}
                      data-testid="button-push-to-wordpress"
                    >
                      {pushing ? (
                        "Deploying…"
                      ) : themeMissing ? (
                        <>
                          <AlertCircle className="h-5 w-5" />
                          Push anyway — theme not active
                        </>
                      ) : (
                        <>
                          <UploadCloud className="h-5 w-5" />
                          Convert &amp; push to WordPress
                        </>
                      )}
                    </Button>
                  );
                  return tooltip ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>{button}</TooltipTrigger>
                        <TooltipContent className="max-w-sm text-xs">{tooltip}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    button
                  );
                })()}
                {renderer === "pixel_perfect" && themeStatus && themeStatus.reachable && !themeStatus.matches && (
                  <p
                    className="text-xs text-amber-700 dark:text-amber-400 mt-3 flex items-start gap-2"
                    data-testid="theme-warning"
                  >
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      The custom theme <span className="font-semibold">{themeStatus.expectedThemeSlug}</span> isn't
                      active on this site (active: <span className="font-semibold">{themeStatus.activeThemeSlug ?? "unknown"}</span>).
                      Install and activate it from the WordPress Target card above before pushing — otherwise
                      every section will render as an "unknown block" placeholder.
                    </span>
                  </p>
                )}
                {renderer === "pixel_perfect" && (themeStatus === null || !themeStatus.reachable) && (
                  <p
                    className="text-xs text-muted-foreground mt-3"
                    data-testid="theme-warning-unknown"
                  >
                    Pixel-perfect mode requires the generated theme to be installed and active on the target site.
                    Use the Install/Activate Theme buttons above before pushing.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Deployment log — stacked beneath sections */}
        <div className="space-y-6">
          <Card className="h-[480px] flex flex-col overflow-hidden p-0 gap-0">
            <CardHeader className="py-3.5 px-4 border-b border-border bg-card">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  Deployment log
                </span>
                <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Live</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden bg-[#0b0d12] text-emerald-300 font-mono text-xs">
              <ScrollArea className="h-full w-full p-4">
                {(!project.pushLog || project.pushLog.length === 0) ? (
                  <div className="text-emerald-400/40 italic">Waiting for deployment…</div>
                ) : (
                  <div className="space-y-2">
                    {project.pushLog.map((log, i) => (
                      <div key={i} className="flex gap-3">
                        <span className="text-emerald-400/40 shrink-0">[{new Date(log.createdAt).toLocaleTimeString()}]</span>
                        <span className={`shrink-0 font-semibold ${log.status === 'error' ? 'text-red-400' : log.status === 'success' ? 'text-emerald-300' : 'text-amber-300'}`}>
                          {log.status.toUpperCase()}
                        </span>
                        <span className="break-all text-emerald-100/90">{log.pageName} {log.error ? `— ${log.error}` : ''}</span>
                        {log.wpUrl && (
                          <a href={log.wpUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline shrink-0 flex items-center">
                            view <Globe className="h-3 w-3 ml-1" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

