import { getAiSettings } from "./aiClient";
import { logger } from "./logger";
import {
  compressSections,
  chunkSections,
  toWidgetSectionInput,
  runMasterController,
  runSemanticAnalyzer,
  runWidgetIntelligence,
  runDesignAudit,
  type CompressedSection,
  type WidgetSectionInput,
} from "./aiEngines";
import { extractDesignTokens, type DesignTokens } from "./tokenExtractor";
import { parseHtmlHeuristicForAi } from "./parser";

const SEMANTIC_TYPES = [
  "hero", "features", "about", "services", "testimonials", "pricing",
  "faq", "cta", "gallery", "stats", "logos", "team", "contact",
  "blog", "newsletter", "footer", "header", "custom",
] as const;

export type SemanticType = typeof SEMANTIC_TYPES[number];

export interface AiSection {
  semanticType: SemanticType;
  confidence: number;
  fields: Record<string, unknown>;
  repeatItems?: Array<Record<string, unknown>>;
  /** Set when the Widget Intelligence engine produced a widget mapping. */
  widget?: { name: string; reason: string; structure: Record<string, unknown> };
}

export interface AiPage {
  name: string;
  slug: string;
  sections: AiSection[];
}

export interface AiDesignSystem {
  font: string;
  fontHeading?: string;
  colors: string[];
  primaryColor?: string;
  buttonStyle: string;
  headingStyle: string;
}

export interface SuggestedCpt {
  slug: string;
  label: string;
  pluralLabel: string;
  sourceSemanticType: SemanticType;
  fields: string[];
  itemCount: number;
}

export interface AiAnalysis {
  pages: AiPage[];
  designSystem: AiDesignSystem;
  suggestedCpts: SuggestedCpt[];
  source: "ai" | "heuristic";
  /** Which mode was used: "master" = single combined call, "engines" = three separate calls. */
  mode: "master" | "engines";
  /** Optional design audit findings + fixes when AI ran. */
  designAudit?: unknown;
}

function inferDesignSystem(siteHtml: string): AiDesignSystem {
  const tokens = extractDesignTokens(siteHtml);
  const colors = Object.values(tokens.color).filter(Boolean) as string[];
  return {
    font: "Inter, sans-serif",
    fontHeading: undefined,
    colors,
    primaryColor: tokens.color.primary,
    buttonStyle: "rounded",
    headingStyle: "bold",
  };
}

async function buildSuggestedCpts(
  pages: AiPage[],
  projectId: number | null,
): Promise<SuggestedCpt[]> {
  const out: SuggestedCpt[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const s of page.sections) {
      if (!s.repeatItems || s.repeatItems.length < 3) continue;
      const slug = s.semanticType.replace(/[^a-z0-9_]/g, "_").slice(0, 20);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const fields = Array.from(
        new Set(s.repeatItems.flatMap((it) => Object.keys(it))),
      ).slice(0, 12);
      out.push({
        slug,
        label: s.semanticType.charAt(0).toUpperCase() + s.semanticType.slice(1),
        pluralLabel: `${s.semanticType.charAt(0).toUpperCase()}${s.semanticType.slice(1)}s`,
        sourceSemanticType: s.semanticType,
        fields,
        itemCount: s.repeatItems.length,
      });
    }
  }
  void projectId;
  return out;
}

/**
 * Convert raw HTML into the normalized analysis schema. Routing:
 *
 *  1. Always run the deterministic parser first — this gives us a
 *     trustworthy ParsedSite scaffold (no hallucinated content).
 *  2. If AI is enabled in admin settings:
 *       - masterControllerMode = true  → one Master Controller call
 *         that returns semantic + widget + designAudit at once.
 *       - masterControllerMode = false → three engine calls
 *         (Semantic, then Widget per section, then Design Audit).
 *  3. Merge engine outputs onto the parsed scaffold and return.
 *  4. On any AI failure or if AI is off, return null and let the caller
 *     fall back to the pure heuristic shape.
 */
export async function analyzeWithAi(html: string, projectId?: number): Promise<AiAnalysis | null> {
  const settings = await getAiSettings();
  const apiEnabled = settings.enabled && Boolean(settings.apiKeyCiphertext) && settings.status !== "invalid_key";
  if (!apiEnabled) {
    return null;
  }

  // Deterministic skeleton — never lies about structure.
  const skeleton = parseHtmlHeuristicForAi(html);
  if (skeleton.pages.length === 0) {
    return null;
  }

  const pid = typeof projectId === "number" ? projectId : 0;
  const compressed = compressSections(skeleton);
  const tokens = extractDesignTokens(html);
  const SECTIONS_PER_CALL = 10;

  // Flatten all sections in skeleton order so the index aligns with `compressed`.
  const flatSections = skeleton.pages.flatMap((p) => p.sections);

  if (settings.masterControllerMode) {
    const sectionInputs: WidgetSectionInput[] = flatSections.map((s) =>
      toWidgetSectionInput(s, s.semanticType ?? s.type, ""),
    );
    // Chunk by SECTIONS_PER_CALL so the Master Controller stays inside the
    // per-call section budget. Each chunk's compressed sections still carry
    // their original global `index`, so we can merge outputs directly.
    const compChunks = chunkSections(compressed, SECTIONS_PER_CALL);
    const sectChunks = chunkSections(sectionInputs, SECTIONS_PER_CALL);
    const mergedSections: Array<{ index: number; type: string; intent: string; confidence: number }> = [];
    const mergedWidgets: Array<{ index: number; widget: string; reason: string; structure: { settings: Record<string, unknown>; elements: unknown[] } }> = [];
    let designAudit: unknown = null;
    for (let c = 0; c < compChunks.length; c++) {
      const result = await runMasterController(pid, {
        compressed: compChunks[c],
        sections: sectChunks[c] ?? [],
        tokens,
      });
      if (!result.output) {
        logger.warn({ engine: "master", chunk: c }, "Master Controller returned no output; falling back");
        return null;
      }
      for (const s of result.output.sections.sections ?? []) mergedSections.push(s);
      for (const w of result.output.widgets ?? []) mergedWidgets.push(w);
      // Design audit is a function of tokens only; keep the first response.
      if (designAudit === null) designAudit = result.output.designAudit;
    }
    return projectMasterToAnalysis(
      skeleton,
      { sections: { sections: mergedSections }, widgets: mergedWidgets, designAudit },
      html,
      projectId ?? null,
    );
  }

  // Three-engine path. Chunk sections so each Semantic Analyzer call stays
  // ≤10 sections; merge results by their original `index`.
  const semanticChunks = chunkSections(compressed, SECTIONS_PER_CALL);
  const semanticAll: Array<{ index: number; type: string; intent: string; confidence: number }> = [];
  for (const chunk of semanticChunks) {
    const out = await runSemanticAnalyzer(pid, chunk);
    if (!out.output) {
      logger.warn({ engine: "semantic" }, "Semantic Analyzer failed; falling back");
      return null;
    }
    for (const s of out.output.sections) semanticAll.push(s);
  }
  const semantic = { sections: semanticAll };

  const widgetByIndex = new Map<
    number,
    { widget: string; reason: string; structure: { settings: Record<string, unknown>; elements: unknown[] } }
  >();
  for (let idx = 0; idx < flatSections.length; idx++) {
    const s = flatSections[idx];
    const sem = semanticAll.find((x) => x.index === idx);
    const wIn = toWidgetSectionInput(s, sem?.type ?? s.semanticType ?? s.type, sem?.intent ?? "");
    const w = await runWidgetIntelligence(pid, wIn);
    if (w.output) widgetByIndex.set(idx, w.output);
  }
  const designAudit = await runDesignAudit(pid, tokens);
  return projectEnginesToAnalysis(
    skeleton,
    semantic,
    widgetByIndex,
    designAudit.output,
    html,
    projectId ?? null,
  );
}

interface MasterOutput {
  sections: { sections: Array<{ index: number; type: string; intent: string; confidence: number }> };
  widgets: Array<{ index: number; widget: string; reason: string; structure: { settings: Record<string, unknown>; elements: unknown[] } }>;
  designAudit: unknown;
}

async function projectMasterToAnalysis(
  skeleton: ReturnType<typeof parseHtmlHeuristicForAi>,
  master: MasterOutput,
  html: string,
  projectId: number | null,
): Promise<AiAnalysis> {
  const widgetMap = new Map<number, MasterOutput["widgets"][number]>();
  for (const w of master.widgets ?? []) widgetMap.set(w.index, w);
  const semByIndex = new Map<number, { type: string; intent: string; confidence: number }>();
  for (const s of master.sections.sections ?? []) semByIndex.set(s.index, s);

  let i = 0;
  const pages: AiPage[] = skeleton.pages.map((p) => ({
    name: p.name,
    slug: p.slug,
    sections: p.sections.map((s): AiSection => {
      const sem = semByIndex.get(i);
      const w = widgetMap.get(i);
      const repeatItems = Array.isArray((s.content as Record<string, unknown>).items)
        ? ((s.content as Record<string, unknown>).items as Array<Record<string, unknown>>)
        : [];
      i++;
      const semanticType = (SEMANTIC_TYPES as readonly string[]).includes(sem?.type ?? "")
        ? (sem!.type as SemanticType)
        : (s.semanticType as SemanticType) ?? "custom";
      return {
        semanticType,
        confidence: sem?.confidence ?? 0.5,
        fields: { ...s.content, intent: sem?.intent },
        repeatItems,
        widget: w
          ? { name: w.widget, reason: w.reason, structure: { settings: w.structure.settings, elements: w.structure.elements } }
          : undefined,
      };
    }),
  }));

  const suggestedCpts = await buildSuggestedCpts(pages, projectId);
  return {
    pages,
    designSystem: inferDesignSystem(html),
    suggestedCpts,
    source: "ai",
    mode: "master",
    designAudit: master.designAudit,
  };
}

async function projectEnginesToAnalysis(
  skeleton: ReturnType<typeof parseHtmlHeuristicForAi>,
  semantic: { sections: Array<{ index: number; type: string; intent: string; confidence: number }> },
  widgetByIndex: Map<number, { widget: string; reason: string; structure: { settings: Record<string, unknown>; elements: unknown[] } }>,
  designAudit: unknown,
  html: string,
  projectId: number | null,
): Promise<AiAnalysis> {
  const semByIndex = new Map<number, { type: string; intent: string; confidence: number }>();
  for (const s of semantic.sections ?? []) semByIndex.set(s.index, s);
  let i = 0;
  const pages: AiPage[] = skeleton.pages.map((p) => ({
    name: p.name,
    slug: p.slug,
    sections: p.sections.map((s): AiSection => {
      const sem = semByIndex.get(i);
      const w = widgetByIndex.get(i);
      const repeatItems = Array.isArray((s.content as Record<string, unknown>).items)
        ? ((s.content as Record<string, unknown>).items as Array<Record<string, unknown>>)
        : [];
      i++;
      const semanticType = (SEMANTIC_TYPES as readonly string[]).includes(sem?.type ?? "")
        ? (sem!.type as SemanticType)
        : (s.semanticType as SemanticType) ?? "custom";
      return {
        semanticType,
        confidence: sem?.confidence ?? 0.5,
        fields: { ...s.content, intent: sem?.intent },
        repeatItems,
        widget: w ? { name: w.widget, reason: w.reason, structure: { settings: w.structure.settings, elements: w.structure.elements } } : undefined,
      };
    }),
  }));
  const suggestedCpts = await buildSuggestedCpts(pages, projectId);
  return {
    pages,
    designSystem: inferDesignSystem(html),
    suggestedCpts,
    source: "ai",
    mode: "engines",
    designAudit,
  };
}

// Re-export for legacy imports that still reference these types.
export type { CompressedSection };
