import { useState, useEffect } from "react";
import { Link, useParams, useLocation } from "wouter";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Download, FileCode2, Globe, LayoutTemplate, Settings2, Trash2, Shield, UploadCloud, Eye, AlertCircle, Database, Layers, Sparkles, Palette, Ruler, Type as TypeIcon, CornerDownRight, RefreshCw, Send, Image as ImageIcon, AlignLeft, Component, HelpCircle, DollarSign, Users, Link as LinkIcon, ClipboardPaste } from "lucide-react";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";

// Map common section type strings to a representative lucide icon for the
// left-rail "Detected sections" list. Falls back to Component for unknown types.
const SECTION_ICON_MAP: Record<string, React.ElementType> = {
  hero: LayoutTemplate,
  header: AlignLeft,
  nav: AlignLeft,
  features: Sparkles,
  pricing: DollarSign,
  faq: HelpCircle,
  footer: AlignLeft,
  testimonials: Users,
  cta: Send,
  about: FileCode2,
  contact: Globe,
  gallery: ImageIcon,
};
function sectionIconFor(type: string): React.ElementType {
  const key = (type || "").toLowerCase();
  return SECTION_ICON_MAP[key] || Component;
}
function prettyType(type: string): string {
  if (!type) return "Section";
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

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
function ProjectAiStatusPill({ projectId, refreshSignal = 0 }: { projectId: string; refreshSignal?: number }) {
  const apiBase = import.meta.env.BASE_URL;
  const { toast } = useToast();
  const [status, setStatus] = useState<AiPublicStatus | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  // `nowTick` increments every 30s so the "X ago" label re-renders even
  // when the underlying `lastRunAt` value hasn't changed.
  const [, setNowTick] = useState(0);

  const loadStatus = async (signal?: { cancelled: boolean }) => {
    try {
      const res = await fetch(`${apiBase}api/projects/${projectId}/ai-status`);
      if (!res.ok) return;
      const body = (await res.json()) as AiPublicStatus;
      if (!signal?.cancelled) setStatus(body);
    } catch { /* silent — status is informational only */ }
  };

  useEffect(() => {
    const signal = { cancelled: false };
    loadStatus(signal);
    // Probe admin session silently. Non-admins (401/403) just don't see
    // the Re-analyze button — no redirect, no toast.
    (async () => {
      try {
        const res = await fetch(`${apiBase}api/admin/me`, { credentials: "include" });
        if (signal.cancelled) return;
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          if (body?.user?.isAdmin) setIsAdmin(true);
        }
      } catch { /* not signed in — fine */ }
    })();
    return () => { signal.cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, projectId]);

  // Periodically refresh status (every 30s) while the tab is visible, and
  // also tick the clock so relative timestamps stay current. Pauses when
  // the tab is hidden to avoid background polling, and re-fetches
  // immediately when the tab becomes visible again so the user sees fresh
  // data on return.
  useEffect(() => {
    const signal = { cancelled: false };
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        setNowTick((n) => n + 1);
        void loadStatus(signal);
      }, 30_000);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadStatus(signal);
        setNowTick((n) => n + 1);
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      signal.cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, projectId]);

  // External re-fetch trigger: when the parent bumps `refreshSignal` after
  // a re-import (ZIP, HTML paste, URL scrape, …) we refresh the pill
  // immediately instead of waiting for the next 30s tick. The initial
  // mount value (0) is skipped — the load-on-mount effect above already
  // covers that case.
  useEffect(() => {
    if (refreshSignal === 0) return;
    const signal = { cancelled: false };
    void loadStatus(signal);
    return () => { signal.cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const onReanalyze = async () => {
    setReanalyzing(true);
    try {
      const res = await fetch(`${apiBase}api/admin/projects/${projectId}/reanalyze`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      toast({ title: "Re-analysis complete", description: "Cache cleared and engines re-ran." });
      await loadStatus();
    } catch (err) {
      toast({
        title: "Could not re-analyze",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setReanalyzing(false);
    }
  };

  if (!status) return null;
  const label = status.aiEnabled
    ? `AI on (${status.model}) · last run ${relativeTime(status.lastRunAt)}${status.cacheEntries > 0 ? ` · ${status.cacheEntries} cached` : ""}`
    : "Deterministic parser (AI off)";
  const cls = status.aiEnabled
    ? "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900"
    : "bg-muted text-muted-foreground border-border";
  return (
    <>
      <span
        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${cls}`}
        title={status.lastRunAt ? `Last run: ${new Date(status.lastRunAt).toLocaleString()}` : "Not analyzed yet"}
      >
        {label}
      </span>
      {isAdmin && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={onReanalyze}
          disabled={reanalyzing}
          title="Clear AI cache and re-run analysis engines (admin only)"
        >
          <RefreshCw className={`h-3 w-3 ${reanalyzing ? "animate-spin" : ""}`} />
          {reanalyzing ? "Re-analyzing…" : "Re-analyze"}
        </Button>
      )}
    </>
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
  // Bumped after any action that re-runs the analyzer (re-upload ZIP,
  // re-parse HTML, scrape URL). Passed to <ProjectAiStatusPill> which
  // refetches its status immediately on change instead of waiting for
  // its 30s polling tick.
  const [aiStatusRefreshTick, setAiStatusRefreshTick] = useState(0);
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
  // Active step in the new step-flow: source / sections / mapping / design / wp / deploy.
  // Defaults to "source" but jumps to "sections" once the project has a parsed
  // structure (handled in the init effect below) so returning users land on
  // the most useful view.
  const [activeTab, setActiveTab] = useState<string>("source");
  const [tabInitialized, setTabInitialized] = useState(false);
  const [activeSection, setActiveSection] = useState<number>(0);

  // First-load initial step: if the project is already parsed, land on the
  // Sections step; otherwise stay on Source. Runs once per mount.
  useEffect(() => {
    if (!project || tabInitialized) return;
    if (project.parsedSite && project.parsedSite.pages?.length) {
      setActiveTab("sections");
    }
    setTabInitialized(true);
  }, [project, tabInitialized]);

  // Scroll-linked active section: keep the in-step section nav highlight
  // in sync with the section card the user is currently viewing inside the
  // Sections step. Re-runs whenever the section count or the active step changes.
  const sectionCount = project?.parsedSite?.pages?.[0]?.sections?.length ?? 0;
  useEffect(() => {
    if (activeTab !== "sections" || sectionCount === 0) return;
    const els: HTMLElement[] = [];
    for (let i = 0; i < sectionCount; i += 1) {
      const el = document.getElementById(`section-${i}`);
      if (el) els.push(el);
    }
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          const idx = Number(visible[0].target.id.replace("section-", ""));
          if (!Number.isNaN(idx)) setActiveSection(idx);
        }
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [activeTab, sectionCount]);

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
      setAiStatusRefreshTick((n) => n + 1);
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
      setAiStatusRefreshTick((n) => n + 1);
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
      setAiStatusRefreshTick((n) => n + 1);
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
        window.location.href = "/app";
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

  // ── Derived data for the new 2-pane layout ─────────────────────────────
  // Prefer a real source-file label when we have one (uploaded ZIP index path,
  // scraped URL filename, pasted HTML). Fall back to the project slug only
  // when no source is on file yet.
  const sourceFileName = (() => {
    const uploaded = (proj as { uploadedFiles?: { indexPath?: string; files?: Array<{ name?: string }> } }).uploadedFiles;
    if (uploaded?.indexPath) {
      const last = uploaded.indexPath.split(/[\\/]/).pop();
      if (last) return last;
    }
    const url = (proj as { sourceUrl?: string }).sourceUrl;
    if (url) {
      try {
        const u = new URL(url);
        const last = u.pathname.split("/").filter(Boolean).pop();
        if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
        return u.hostname.replace(/^www\./, "") + ".html";
      } catch { /* fall through */ }
    }
    if (proj.sourceHtml) return "pasted.html";
    const slug = (project.name || "site").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
    return `${slug}.html`;
  })();
  // Use the first parsed page's sections for the left-rail "Detected sections"
  // list — the mockup shows a single-page navigation. Sections from other
  // pages still render inside the Overview tab, just without a quick-jump entry.
  const railSections = project.parsedSite?.pages?.[0]?.sections ?? [];
  const totalSections = project.parsedSite?.pages?.reduce((acc, p) => acc + p.sections.length, 0) ?? 0;
  const widgetCount = totalSections;
  const tokenColors = (project.designSystem?.colors ?? []).slice(0, 8);
  const tokenCount = tokenColors.length;
  const isParsed = currentStep >= 2 && !!project.parsedSite;

  // Smooth-scroll to a section anchor inside the Sections step. If the user
  // clicked a section while a different step was open, switch back first.
  const jumpToSection = (idx: number) => {
    setActiveSection(idx);
    if (activeTab !== "sections") {
      setActiveTab("sections");
      // Wait a frame for the Sections step to mount before scrolling.
      requestAnimationFrame(() => {
        const el = document.getElementById(`section-${idx}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      const el = document.getElementById(`section-${idx}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const statusLabel = (project.status || "").toUpperCase();
  const isDeployable = currentStep >= 3;

  // ── Step-flow definitions ────────────────────────────────────────────
  // The 6 user-facing steps. "refine" is intentionally hidden from the bar
  // (the chat code is preserved below for future re-enablement).
  const STEPS: Array<{ key: string; label: string; icon: typeof FileCode2 }> = [
    { key: "source",   label: "Source",    icon: FileCode2 },
    { key: "sections", label: "Sections",  icon: LayoutTemplate },
    { key: "mapping",  label: "Mapping",   icon: Layers },
    { key: "design",   label: "Design",    icon: Palette },
    { key: "wp",       label: "WP Target", icon: Settings2 },
    { key: "deploy",   label: "Deploy",    icon: UploadCloud },
  ];
  const stepIndex = Math.max(0, STEPS.findIndex((s) => s.key === activeTab));
  const isStepDone = (key: string): boolean => {
    switch (key) {
      case "source":   return !!(proj.sourceHtml || proj.uploadedFiles || proj.parsedSite);
      case "sections": return !!project.parsedSite;
      case "mapping":  return !!project.parsedSite;
      case "design":   return !!project.parsedSite && (project.designSystem?.colors?.length ?? 0) > 0;
      case "wp":       return !!project.wpConfig?.wpUrl;
      case "deploy":   return project.status === "pushed";
      default:         return false;
    }
  };

  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-10 -my-8 min-h-screen bg-background animate-in fade-in duration-500">
      {/* ── Sticky top header strip ──────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="px-4 sm:px-6 lg:px-10 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/app">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 -ml-2 text-muted-foreground"
                data-testid="link-all-projects"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">All projects</span>
              </Button>
            </Link>
            <div className="hidden sm:block h-6 w-px bg-border" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h1 className="text-[15px] font-semibold truncate" title={project.name} data-testid="project-name">
                  {project.name}
                </h1>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0 ${
                    statusBadgeClass[project.status] || statusBadgeClass.created
                  }`}
                  data-testid="status-pill"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      project.status === "pushed" ? "bg-emerald-500" :
                      project.status === "configured" ? "bg-amber-500" :
                      project.status === "parsed" ? "bg-blue-500" :
                      project.status === "error" ? "bg-destructive" :
                      "bg-muted-foreground"
                    }`}
                  />
                  {prettyType(statusLabel)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5 min-w-0">
                {(proj as { sourceUrl?: string }).sourceUrl ? (
                  <>
                    <LinkIcon className="h-3 w-3 shrink-0 text-primary/70" />
                    <span className="truncate" data-testid="header-source-url" title={(proj as { sourceUrl?: string }).sourceUrl}>
                      {(proj as { sourceUrl?: string }).sourceUrl}
                    </span>
                  </>
                ) : (
                  <>
                    <FileCode2 className="h-3 w-3 shrink-0 text-primary/70" />
                    <span className="font-mono truncate" data-testid="header-source-file">{sourceFileName}</span>
                  </>
                )}
                {project.wpConfig?.wpUrl && (
                  <>
                    <span className="text-border">·</span>
                    <Globe className="h-3 w-3 shrink-0" />
                    <span className="truncate" title={`WP target: ${project.wpConfig.wpUrl}`}>
                      WP: {project.wpConfig.wpUrl.replace(/^https?:\/\//, "")}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <div className="hidden md:flex items-center gap-2 mr-1">
              <ProjectAiStatusPill projectId={id!} refreshSignal={aiStatusRefreshTick} />
            </div>
            {project.status !== "created" && (
              <Button
                variant="ghost"
                size="sm"
                className="hidden md:inline-flex h-8"
                onClick={() => {
                  const base = import.meta.env.BASE_URL;
                  window.location.href = `${base}api/projects/${id}/astro-export`;
                }}
                data-testid="header-export-astro"
              >
                <FileCode2 className="h-3.5 w-3.5" />
                Astro
              </Button>
            )}
            <Link href={`/projects/${id}/plugin`} className="hidden md:inline-block">
              <Button variant="ghost" size="sm" className="h-8">
                <Download className="h-3.5 w-3.5" />
                Plugin
              </Button>
            </Link>
            <Link href={`/projects/${id}/preview`} className="hidden sm:inline-block">
              <Button variant="outline" size="sm" className="h-8" data-testid="header-preview">
                <Eye className="h-3.5 w-3.5" />
                Preview
              </Button>
            </Link>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label="Delete project"
                >
                  <Trash2 className="h-3.5 w-3.5" />
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
                  <AlertDialogAction
                    onClick={onDelete}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              size="sm"
              className="h-8"
              onClick={onPush}
              disabled={pushing || !isDeployable}
              title={isDeployable ? "Push project to WordPress" : "Configure WordPress target first"}
              data-testid="header-push-button"
            >
              <Send className="h-3.5 w-3.5" />
              {pushing ? "Pushing…" : "Push to WordPress"}
            </Button>
          </div>
        </div>

        {/* ── Stepper bar ──────────────────────────────────────────── */}
        <div className="border-t border-border bg-muted/20">
          <div className="px-4 sm:px-6 lg:px-10 py-3">
            {/* Desktop: horizontal numbered stepper */}
            <ol className="hidden md:flex items-center gap-1" data-testid="step-bar">
              {STEPS.map((s, i) => {
                const done = isStepDone(s.key);
                const current = activeTab === s.key;
                const Icon = s.icon;
                return (
                  <li key={s.key} className="flex items-center flex-1 last:flex-none min-w-0">
                    <button
                      type="button"
                      onClick={() => setActiveTab(s.key)}
                      aria-current={current ? "step" : undefined}
                      className={`group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors min-w-0 ${
                        current
                          ? "bg-primary/10 text-foreground"
                          : "hover:bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                      data-testid={`step-${s.key}`}
                    >
                      <span
                        className={`h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${
                          done
                            ? "bg-primary text-primary-foreground"
                            : current
                              ? "bg-background border-2 border-primary text-primary"
                              : "bg-muted border border-border text-muted-foreground"
                        }`}
                      >
                        {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </span>
                      <span className={`text-[12px] font-medium truncate hidden lg:inline ${current ? "text-foreground" : ""}`}>
                        {s.label}
                      </span>
                      <Icon className="h-3.5 w-3.5 shrink-0 lg:hidden" />
                    </button>
                    {i < STEPS.length - 1 && (
                      <div
                        className={`flex-1 h-px mx-1.5 ${done ? "bg-primary/40" : "bg-border"}`}
                        aria-hidden
                      />
                    )}
                  </li>
                );
              })}
            </ol>

            {/* Mobile: dropdown + prev/next */}
            <div className="md:hidden flex items-center gap-2">
              <select
                value={activeTab}
                onChange={(e) => setActiveTab(e.target.value)}
                className="flex-1 h-9 rounded-md border border-border bg-background px-3 text-sm font-medium"
                data-testid="step-select"
              >
                {STEPS.map((s, i) => (
                  <option key={s.key} value={s.key}>
                    Step {i + 1} of {STEPS.length} — {s.label}{isStepDone(s.key) ? " ✓" : ""}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() => setActiveTab(STEPS[Math.max(0, stepIndex - 1)].key)}
                disabled={stepIndex === 0}
                aria-label="Previous step"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() => setActiveTab(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)].key)}
                disabled={stepIndex === STEPS.length - 1}
                aria-label="Next step"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* ── Step content ────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1">
        <div className="px-4 sm:px-6 lg:px-10 py-6 max-w-6xl mx-auto">
          {/* ─── Sections ──────────────────────────────────────────── */}
          <TabsContent value="sections" className="mt-0">
            {!isParsed ? (
              <Card>
                <CardHeader>
                  <CardTitle>Waiting for structure</CardTitle>
                  <CardDescription>Add a source on the previous step to continue.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={() => setActiveTab("source")} data-testid="sections-empty-go-source">
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Back to Source
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
                {/* In-step sections nav (was the page-level rail) */}
                <aside className="lg:sticky lg:top-[180px] lg:self-start lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Detected sections
                  </div>
                  {railSections.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No sections detected on the first page.</p>
                  ) : (
                    <>
                      {/* Mobile: compact dropdown */}
                      <select
                        className="lg:hidden w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                        value={activeSection ?? 0}
                        onChange={(e) => jumpToSection(Number(e.target.value))}
                        aria-label="Jump to section"
                        data-testid="section-nav-mobile"
                      >
                        {railSections.map((s, i) => (
                          <option key={i} value={i}>
                            {String(i + 1).padStart(2, "0")} · {prettyType(s.type)}
                          </option>
                        ))}
                      </select>
                      {/* Desktop: full button list */}
                      <nav className="hidden lg:block space-y-0.5" aria-label="Detected sections">
                      {railSections.map((s, i) => {
                        const Icon = sectionIconFor(s.type);
                        const active = activeSection === i;
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => jumpToSection(i)}
                            aria-current={active ? "true" : undefined}
                            className={`group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                              active
                                ? "bg-muted text-foreground font-medium"
                                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            }`}
                            data-testid={`section-nav-${i}`}
                          >
                            <Icon className={`h-4 w-4 shrink-0 ${active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`} />
                            <span className="truncate">{prettyType(s.type)}</span>
                          </button>
                        );
                      })}
                      </nav>
                    </>
                  )}
                </aside>

                {/* Section preview cards */}
                <div className="space-y-4 min-w-0">
                  {isParsed && (
                    <div className="text-xs text-muted-foreground">
                      {widgetCount} {widgetCount === 1 ? "widget" : "widgets"}
                      {tokenCount > 0 ? ` · ${tokenCount} design tokens` : ""}
                    </div>
                  )}
                  {project.parsedSite!.pages.flatMap((p) => p.sections).map((section, idx) => {
                    const isHero = idx === 0;
                    const Icon = sectionIconFor(section.type);
                    return (
                      <div
                        key={idx}
                        id={`section-${idx}`}
                        className={`rounded-xl border-2 px-5 py-5 transition-colors ${
                          isHero
                            ? "border-dashed border-primary/40 bg-primary/5"
                            : "border-border bg-card"
                        }`}
                        data-testid={`overview-section-${idx}`}
                      >
                        <div className="flex items-center justify-between gap-3 mb-4">
                          <div className="flex items-center gap-2">
                            <Icon className={`h-4 w-4 ${isHero ? "text-primary" : "text-muted-foreground"}`} />
                            <span className={`text-[11px] font-semibold uppercase tracking-wider ${isHero ? "text-primary" : "text-muted-foreground"}`}>
                              {prettyType(section.type)}
                              {isHero ? " · Elementor section" : ""}
                            </span>
                          </div>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            section-{String(idx + 1).padStart(2, "0")}
                          </span>
                        </div>
                        <div className="space-y-2.5">
                          <div className="h-3 w-full rounded bg-foreground/80" />
                          <div className="h-2 w-3/4 rounded bg-muted-foreground/40" />
                        </div>
                        {isHero && (
                          <div className="mt-4 flex items-center gap-2">
                            <div className="h-7 w-24 rounded-md bg-primary" />
                            <div className="h-7 w-20 rounded-md border border-border bg-card" />
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {tokenColors.length > 0 && (
                    <div className="rounded-xl border border-border bg-card px-5 py-3.5 flex items-center gap-3 flex-wrap">
                      <Palette className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex items-center gap-1.5">
                        {tokenColors.map((c, i) => (
                          <span
                            key={i}
                            className="h-5 w-5 rounded-full border border-border shadow-xs"
                            style={{ backgroundColor: c }}
                            title={c}
                          />
                        ))}
                      </div>
                      <span className="text-[12px] text-muted-foreground">Design tokens extracted</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 ml-auto text-xs"
                        onClick={() => setActiveTab("design")}
                      >
                        Edit tokens →
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

              {/* ─── Source ───────────────────────────────────────────── */}
              <TabsContent value="source" className="mt-0 space-y-4">
                {/* Source summary — always visible so users know what's on file */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileCode2 className="h-4 w-4 text-primary" />
                      Source on file
                    </CardTitle>
                    <CardDescription>
                      {isParsed
                        ? "Pick up where you left off, or import a fresh source below to regenerate the Elementor widgets."
                        : "Pick how you'd like to bring your site into WP Bridge — upload, paste, or scrape."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                        proj.sourceHtml || proj.uploadedFiles
                          ? "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900"
                          : "bg-muted text-muted-foreground border-border"
                      }`}>
                        <FileCode2 className="h-3 w-3" />
                        {proj.sourceHtml ? "Source HTML stored" : proj.uploadedFiles ? "ZIP files stored" : "No source on file"}
                      </span>
                      {sourceFileName && (proj.sourceHtml || proj.uploadedFiles || isParsed) && (
                        <span className="font-mono text-[12px] text-muted-foreground truncate" data-testid="source-filename">
                          {sourceFileName}
                        </span>
                      )}
                      {isParsed && (
                        <span className="text-xs text-muted-foreground ml-auto">
                          {widgetCount} {widgetCount === 1 ? "section" : "sections"} parsed
                        </span>
                      )}
                    </div>
                    {isParsed && (
                      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between flex-wrap gap-2">
                        <span className="text-xs text-muted-foreground">Ready for the next step.</span>
                        <Button size="sm" onClick={() => setActiveTab("sections")} data-testid="source-continue">
                          Continue to Sections
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                    {!isParsed && (
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-3 flex items-center gap-1.5">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        Add a source below to parse the structure and unlock the rest of the steps.
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Three import options as side-by-side picker cards */}
                <div className="grid gap-4 md:grid-cols-3">
                  {/* URL */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <LinkIcon className="h-4 w-4 text-primary" />
                        Fetch a URL
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Best for live sites. Public http(s) only.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
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
                        className="w-full"
                        onClick={() => scrapeFromUrl(scrapeUrlInput)}
                        disabled={reparsing || scrapeUrlInput.trim().length === 0}
                        data-testid="button-scrape-url"
                      >
                        <Globe className="h-3.5 w-3.5" />
                        {reparsing ? "Fetching…" : isParsed ? "Re-scrape URL" : "Scrape site"}
                      </Button>
                    </CardContent>
                  </Card>

                  {/* ZIP */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <UploadCloud className="h-4 w-4 text-primary" />
                        Upload a ZIP
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Multi-page sites with assets bundled.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <label className="block">
                        <span className="sr-only">Re-upload ZIP</span>
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
                      </label>
                      <p className="text-[11px] text-muted-foreground mt-2">
                        Drop a .zip; we'll find index.html automatically.
                      </p>
                    </CardContent>
                  </Card>

                  {/* Paste HTML */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <ClipboardPaste className="h-4 w-4 text-primary" />
                        Paste HTML
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Quick single-page experiments.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
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
                        className="w-full"
                        onClick={() => reparseHtml(pastedHtml)}
                        disabled={reparsing || pastedHtml.trim().length === 0}
                        data-testid="button-reparse-html"
                      >
                        {reparsing ? "Parsing…" : "Parse HTML"}
                      </Button>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              {/* ─── Mapping ──────────────────────────────────────────── */}
              <TabsContent value="mapping" className="mt-0 space-y-4">
                {currentStep >= 2 ? (
                  <>
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
                    {cpts.length > 0 && (
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
                  </>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      Parse a source first to configure mapping.
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* ─── Design ───────────────────────────────────────────── */}
              <TabsContent value="design" className="mt-0">
                {currentStep >= 2 ? (
                  <DesignTokensCard projectId={id!} />
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      Parse a source first to extract design tokens.
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* ─── WP Target ────────────────────────────────────────── */}
              <TabsContent value="wp" className="mt-0">
                {currentStep >= 2 ? (
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
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      Parse a source first to configure your WordPress target.
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* ─── Deploy ───────────────────────────────────────────── */}
              <TabsContent value="deploy" className="mt-0 space-y-6">
                {currentStep >= 3 ? (
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
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      Configure WordPress credentials first to enable deployment.
                    </CardContent>
                  </Card>
                )}

                {/* Deployment log */}
                <Card className="h-[420px] flex flex-col overflow-hidden p-0 gap-0">
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
              </TabsContent>

              {/* ─── Refine ───────────────────────────────────────────── */}
              <TabsContent value="refine" className="mt-0">
                {currentStep >= 2 && project.parsedSite ? (
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
                        <ScrollArea className="h-72 rounded-lg border border-border bg-muted/30 p-3">
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
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      Parse a source first to enable the refinement assistant.
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}


