import { useState } from "react";
import {
  LayoutTemplate, AlignLeft, Sparkles, DollarSign, HelpCircle,
  Send, FileCode2, Globe, ImageIcon, Component, Users,
  ChevronDown, ChevronRight, Wand2, RefreshCw, Type,
  MousePointerClick, Image as ImageIco, List, Link as LinkIco,
  Heading1, AlignLeft as TextIco, Star, BarChart2, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SidebarSection {
  type: string;
  content: Record<string, unknown>;
  rawHtml?: string;
}

interface Props {
  sections: SidebarSection[];
  selectedIndex: number;
  onSelectSection: (idx: number) => void;
  projectId: string;
  apiBase: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECTION_ICONS: Record<string, React.ElementType> = {
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
  stats: BarChart2,
  blog: FileCode2,
};

function iconFor(type: string): React.ElementType {
  return SECTION_ICONS[(type || "").toLowerCase()] || Component;
}

function pretty(s: string): string {
  if (!s) return "Section";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Confidence: how well-classified is this section type?
// hero/footer/header/nav → High; features/pricing/cta/testimonials → Medium; custom → Low
type Confidence = "high" | "medium" | "low";
function confidenceFor(type: string): Confidence {
  const t = (type || "").toLowerCase();
  if (["hero", "footer", "header", "nav"].includes(t)) return "high";
  if (["features", "pricing", "cta", "testimonials", "faq", "about", "contact", "gallery", "stats", "blog"].includes(t)) return "medium";
  return "low";
}
const CONFIDENCE_COLORS: Record<Confidence, string> = {
  high:   "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
  medium: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300",
  low:    "bg-muted text-muted-foreground border-border",
};

// Map content keys → element kind metadata
interface ElementMeta { label: string; icon: React.ElementType; hint: string }
const ELEMENT_META: Record<string, ElementMeta> = {
  title:       { label: "Heading",     icon: Heading1,          hint: "Main section heading" },
  subtitle:    { label: "Sub-heading", icon: Type,              hint: "Secondary heading or tagline" },
  description: { label: "Body text",  icon: TextIco,           hint: "Paragraph / description text" },
  cta:         { label: "Primary CTA", icon: MousePointerClick, hint: "Primary call-to-action button" },
  ctaSecondary:{ label: "Secondary CTA", icon: MousePointerClick, hint: "Secondary button" },
  images:      { label: "Images",      icon: ImageIco,          hint: "Image assets in this section" },
  items:       { label: "Repeating items", icon: List,          hint: "Card grid, feature list or FAQ items" },
  plans:       { label: "Plans",       icon: DollarSign,        hint: "Pricing plan cards" },
  badge:       { label: "Badge / label", icon: Star,            hint: "Small badge or tag element" },
  link:        { label: "Link",         icon: LinkIco,           hint: "Hyperlink" },
};

function renderValue(val: unknown): string {
  if (typeof val === "string") return val.slice(0, 80) + (val.length > 80 ? "…" : "");
  if (Array.isArray(val)) return `${val.length} item${val.length !== 1 ? "s" : ""}`;
  if (typeof val === "object" && val !== null) return JSON.stringify(val).slice(0, 60) + "…";
  return String(val ?? "");
}

// ─── Sub-views ────────────────────────────────────────────────────────────────

function StructureTab({
  sections,
  selectedIndex,
  onSelectSection,
}: {
  sections: SidebarSection[];
  selectedIndex: number;
  onSelectSection: (i: number) => void;
}) {
  return (
    <div className="py-2">
      <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Page map
      </div>
      {sections.length === 0 ? (
        <p className="px-3 text-xs text-muted-foreground">No sections detected.</p>
      ) : (
        <nav className="space-y-0.5" aria-label="Section structure">
          {sections.map((s, i) => {
            const Icon = iconFor(s.type);
            const conf = confidenceFor(s.type);
            const active = selectedIndex === i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelectSection(i)}
                className={`group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                  active
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <span
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${
                    active ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted border-border text-muted-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 truncate text-sm">{pretty(s.type)}</span>
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${CONFIDENCE_COLORS[conf]}`}
                  title={`Detection confidence: ${conf}`}
                >
                  {conf === "high" ? "H" : conf === "medium" ? "M" : "L"}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {/* Legend */}
      <div className="mx-3 mt-4 rounded-md border border-border bg-muted/30 p-2.5 space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">Confidence</div>
        {(["high", "medium", "low"] as Confidence[]).map((c) => (
          <div key={c} className="flex items-center gap-2">
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${CONFIDENCE_COLORS[c]}`}>
              {c === "high" ? "H" : c === "medium" ? "M" : "L"}
            </span>
            <span className="text-[11px] text-muted-foreground capitalize">{c}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContentTab({
  section,
  index,
}: {
  section: SidebarSection | null;
  index: number;
}) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["title", "cta", "description"]));

  if (!section) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        Select a section from Structure to inspect its elements.
      </div>
    );
  }

  const entries = Object.entries(section.content).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const knownEntries = entries.filter(([k]) => ELEMENT_META[k]);
  const unknownEntries = entries.filter(([k]) => !ELEMENT_META[k]);

  const toggle = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="py-2">
      <div className="px-3 pb-2">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {pretty(section.type)} — section {String(index + 1).padStart(2, "0")}
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="px-3 text-xs text-muted-foreground">No editable content found in this section.</p>
      ) : (
        <div className="space-y-0.5 px-1.5">
          {knownEntries.map(([key, val]) => {
            const meta = ELEMENT_META[key];
            const Icon = meta.icon;
            const open = openGroups.has(key);
            return (
              <div key={key} className="rounded-md border border-border bg-card overflow-hidden">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                  onClick={() => toggle(key)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                  <span className="flex-1 text-xs font-medium text-foreground">{meta.label}</span>
                  <span className="text-[10px] text-muted-foreground mr-1">{meta.hint}</span>
                  {open
                    ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  }
                </button>
                {open && (
                  <div className="border-t border-border bg-muted/20 px-3 py-2.5">
                    <span className="text-[11px] font-mono text-foreground/80 break-words">
                      {renderValue(val)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}

          {unknownEntries.length > 0 && (
            <div className="rounded-md border border-border bg-card overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                onClick={() => toggle("__other")}
              >
                <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-xs font-medium">Other fields</span>
                {openGroups.has("__other")
                  ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                }
              </button>
              {openGroups.has("__other") && (
                <div className="border-t border-border bg-muted/20 px-3 py-2.5 space-y-1.5">
                  {unknownEntries.map(([k, v]) => (
                    <div key={k} className="flex items-start gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground w-24 shrink-0">{k}</span>
                      <span className="text-[11px] font-mono text-foreground/80 break-words flex-1">{renderValue(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AiTab({
  sections,
  projectId,
  apiBase,
}: {
  sections: SidebarSection[];
  projectId: string;
  apiBase: string;
}) {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);

  const reanalyze = async () => {
    setRunning(true);
    try {
      const res = await fetch(`${apiBase}api/admin/projects/${projectId}/reanalyze`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      toast({ title: "AI re-analysis complete", description: "Sections re-classified by AI." });
    } catch (err) {
      toast({
        title: "Re-analysis failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  // Summarise the current confidence distribution
  const dist = { high: 0, medium: 0, low: 0 };
  for (const s of sections) {
    dist[confidenceFor(s.type)] += 1;
  }

  // Element kind summary
  const elementSummary: Record<string, number> = {};
  for (const s of sections) {
    for (const [k, v] of Object.entries(s.content)) {
      if (v !== undefined && v !== null && v !== "") {
        elementSummary[k] = (elementSummary[k] || 0) + 1;
      }
    }
  }

  return (
    <div className="py-2 space-y-4">
      {/* Main action */}
      <div className="px-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          AI detection
        </div>
        <Button
          size="sm"
          className="w-full gap-2"
          onClick={reanalyze}
          disabled={running}
        >
          {running
            ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            : <Wand2 className="h-3.5 w-3.5" />
          }
          {running ? "Analyzing…" : "Re-detect sections"}
        </Button>
        <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
          AI scans the page structure, re-classifies sections, and updates labels.
          Your manual edits are preserved.
        </p>
      </div>

      {/* Confidence summary */}
      <div className="px-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          Confidence summary
        </div>
        <div className="rounded-lg border border-border bg-muted/30 divide-y divide-border overflow-hidden">
          {(["high", "medium", "low"] as Confidence[]).map((c) => (
            <div key={c} className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${CONFIDENCE_COLORS[c]}`}>
                  {c === "high" ? "H" : c === "medium" ? "M" : "L"}
                </span>
                <span className="text-xs capitalize text-foreground">{c}</span>
              </div>
              <span className="text-xs font-mono text-muted-foreground">{dist[c]} section{dist[c] !== 1 ? "s" : ""}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Element kind summary */}
      {Object.keys(elementSummary).length > 0 && (
        <div className="px-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
            Detected elements
          </div>
          <div className="rounded-lg border border-border bg-muted/30 divide-y divide-border overflow-hidden">
            {Object.entries(elementSummary)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 8)
              .map(([kind, count]) => {
                const meta = ELEMENT_META[kind];
                const Icon = meta ? meta.icon : Layers;
                return (
                  <div key={kind} className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-primary/70" />
                      <span className="text-xs text-foreground">{meta ? meta.label : kind}</span>
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">{count}×</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* What AI can detect — info block */}
      <div className="px-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          AI detects
        </div>
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 space-y-1.5">
          {[
            "Layout blocks & section boundaries",
            "Headings, body text, CTAs",
            "Image & icon groups",
            "Navigation & footer",
            "Repeating card / grid patterns",
            "Section purpose & type label",
          ].map((item) => (
            <div key={item} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type Tab = "structure" | "content" | "ai";

export function AiSectionSidebar({ sections, selectedIndex, onSelectSection, projectId, apiBase }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("structure");
  const selectedSection = sections[selectedIndex] ?? null;

  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: "structure", label: "Structure", icon: Layers },
    { key: "content",   label: "Content",   icon: TextIco },
    { key: "ai",        label: "AI",         icon: Wand2 },
  ];

  return (
    <aside className="flex flex-col rounded-xl border border-border bg-card overflow-hidden shadow-xs">
      {/* Tab bar */}
      <div className="flex border-b border-border bg-muted/30">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors ${
                active
                  ? "border-b-2 border-primary text-foreground bg-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Scrollable body */}
      <ScrollArea className="flex-1 max-h-[calc(100vh-240px)]">
        {activeTab === "structure" && (
          <StructureTab
            sections={sections}
            selectedIndex={selectedIndex}
            onSelectSection={(i) => {
              onSelectSection(i);
              setActiveTab("content");
            }}
          />
        )}
        {activeTab === "content" && (
          <ContentTab section={selectedSection} index={selectedIndex} />
        )}
        {activeTab === "ai" && (
          <AiTab sections={sections} projectId={projectId} apiBase={apiBase} />
        )}
      </ScrollArea>
    </aside>
  );
}
