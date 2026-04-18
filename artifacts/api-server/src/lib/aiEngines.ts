import { runEngine, hashInput, type EngineName } from "./aiClient";
import type { ParsedSite, ParsedSection } from "./parser";
import type { DesignTokens } from "./tokenExtractor";

/**
 * Per-section payload sent to the Semantic Analyzer.
 */
export interface CompressedSection {
  index: number;
  textPreview: string;
  headingPreview: string | null;
  hint: string;
}

/**
 * Flatten every section in the site into the compressed shape — no cap.
 * Callers chunk the result via {@link chunkSections} so each LLM request
 * stays at or below the per-call limit.
 */
export function compressSections(site: ParsedSite, _maxSections = 10): CompressedSection[] {
  void _maxSections;
  const flat: CompressedSection[] = [];
  let idx = 0;
  for (const page of site.pages) {
    for (const s of page.sections) {
      const heading =
        (typeof s.content.title === "string" && s.content.title) ||
        (typeof (s.content as Record<string, unknown>).headline === "string" &&
          ((s.content as Record<string, unknown>).headline as string)) ||
        null;
      const textValues: string[] = [];
      for (const v of Object.values(s.content)) {
        if (typeof v === "string") textValues.push(v);
      }
      const joined = textValues.join(" ").replace(/\s+/g, " ").trim();
      const words = joined.split(" ").slice(0, 20).join(" ");
      flat.push({
        index: idx,
        headingPreview: heading ? heading.slice(0, 120) : null,
        textPreview: words.slice(0, 240),
        hint: s.semanticType ?? s.type,
      });
      idx++;
    }
  }
  return flat;
}

/** Split sections into fixed-size chunks for the per-call ≤10 limit. */
export function chunkSections<T>(items: T[], size = 10): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const SEMANTIC_PROMPT = `You are the Semantic Analyzer engine.

Input: a JSON array of compressed page sections, each with {index, headingPreview, textPreview, hint}.
Task: classify each section's semantic role and intent.

Allowed types: hero, features, about, services, testimonials, pricing, faq, cta, gallery, stats, logos, team, contact, blog, newsletter, footer, header, custom.

Output JSON shape:
{
  "sections": [
    { "index": <int>, "type": <one of allowed>, "intent": <short string>, "confidence": <0..1> }
  ]
}`;

export interface SemanticAnalyzerOutput {
  sections: Array<{ index: number; type: string; intent: string; confidence: number }>;
}

export async function runSemanticAnalyzer(
  projectId: number,
  compressed: CompressedSection[],
): Promise<{ output: SemanticAnalyzerOutput | null; cached: boolean; tokensUsed: number }> {
  const inputHash = hashInput({ engine: "semantic", compressed });
  return runEngine<SemanticAnalyzerOutput>({
    engine: "semantic",
    projectId,
    cacheKey: { projectId, inputHash },
    systemPrompt: SEMANTIC_PROMPT,
    userPrompt: `SECTIONS:\n${JSON.stringify(compressed)}`,
  });
}

const WIDGET_PROMPT = `You are the Widget Intelligence engine.

Input: one section description {type, intent, headingPreview, textPreview, fields (object), repeatItems (array)}.
Task: pick the best matching Elementor widget for this section and propose a minimal widget structure.

Allowed widgets: heading, text-editor, button, image, image-gallery, icon-list, image-box, testimonial-carousel, price-table, accordion, tabs, contact-form, video, divider, spacer, html, posts.

Output JSON shape:
{
  "widget": <one of allowed>,
  "reason": <short string explaining the match>,
  "structure": { "settings": <object of widget settings>, "elements": <array of nested widgets, can be empty> }
}`;

export interface WidgetIntelligenceOutput {
  widget: string;
  reason: string;
  structure: { settings: Record<string, unknown>; elements: unknown[] };
}

export interface WidgetSectionInput {
  type: string;
  intent: string;
  headingPreview: string | null;
  textPreview: string;
  fields: Record<string, unknown>;
  repeatItems: unknown[];
}

export async function runWidgetIntelligence(
  projectId: number,
  section: WidgetSectionInput,
): Promise<{ output: WidgetIntelligenceOutput | null; cached: boolean; tokensUsed: number }> {
  const inputHash = hashInput({ engine: "widget", section });
  return runEngine<WidgetIntelligenceOutput>({
    engine: "widget",
    projectId,
    cacheKey: { projectId, inputHash },
    systemPrompt: WIDGET_PROMPT,
    userPrompt: `SECTION:\n${JSON.stringify(section)}`,
  });
}

const DESIGN_AUDIT_PROMPT = `You are the Design Audit engine.

Input: a token map {colors, typography, spacing} extracted from a website.
Task: identify accessibility & consistency issues (low contrast, type-scale jumps, spacing irregularities, palette redundancy) and propose targeted fixes.

Output JSON shape:
{
  "issues": [
    { "kind": <"color"|"typography"|"spacing">, "severity": <"low"|"medium"|"high">, "message": <string>, "tokenKey": <string|null> }
  ],
  "fixes": {
    "colors":     <object of {tokenKey: newHex} suggestions>,
    "typography": <object of {tokenKey: newSize} suggestions>,
    "spacing":    <object of {tokenKey: newSize} suggestions>
  }
}`;

export interface DesignAuditOutput {
  issues: Array<{
    kind: "color" | "typography" | "spacing";
    severity: "low" | "medium" | "high";
    message: string;
    tokenKey: string | null;
  }>;
  fixes: {
    colors: Record<string, string>;
    typography: Record<string, string>;
    spacing: Record<string, string>;
  };
}

export async function runDesignAudit(
  projectId: number,
  tokens: DesignTokens,
): Promise<{ output: DesignAuditOutput | null; cached: boolean; tokensUsed: number }> {
  const inputHash = hashInput({ engine: "designAudit", tokens });
  return runEngine<DesignAuditOutput>({
    engine: "designAudit",
    projectId,
    cacheKey: { projectId, inputHash },
    systemPrompt: DESIGN_AUDIT_PROMPT,
    userPrompt: `TOKENS:\n${JSON.stringify({
      colors: tokens.color,
      typography: tokens.fontSize,
      spacing: tokens.spacing,
    })}`,
  });
}

const MASTER_PROMPT = `You are the Master Controller. You combine three engines (Semantic Analyzer, Widget Intelligence, Design Audit) into a single response.

Inputs:
- "compressed": array of compressed sections (same shape as Semantic Analyzer input).
- "sections":   array of full section descriptions, one per index, in the same order.
- "tokens":     extracted design tokens.

Output JSON shape:
{
  "sections":     <Semantic Analyzer output shape>,
  "widgets":      [ { "index": <int>, "widget": <string>, "reason": <string>, "structure": <object> } ],
  "designAudit":  <Design Audit output shape>
}`;

export interface MasterControllerInput {
  compressed: CompressedSection[];
  sections: WidgetSectionInput[];
  tokens: DesignTokens;
}

export interface MasterControllerOutput {
  sections: SemanticAnalyzerOutput;
  widgets: Array<{ index: number } & WidgetIntelligenceOutput>;
  designAudit: DesignAuditOutput;
}

export async function runMasterController(
  projectId: number,
  input: MasterControllerInput,
): Promise<{ output: MasterControllerOutput | null; cached: boolean; tokensUsed: number }> {
  const inputHash = hashInput({ engine: "master", input });
  return runEngine<MasterControllerOutput>({
    engine: "master",
    projectId,
    cacheKey: { projectId, inputHash },
    systemPrompt: MASTER_PROMPT,
    userPrompt: `INPUT:\n${JSON.stringify(input)}`,
  });
}

/**
 * Build the per-section input the Widget Intelligence engine consumes.
 * Trims long text fields and caps repeatItems at 6 entries to keep
 * token usage bounded.
 */
export function toWidgetSectionInput(
  section: ParsedSection,
  semanticType: string,
  intent: string,
): WidgetSectionInput {
  const headingPreview =
    (typeof section.content.title === "string" && section.content.title.slice(0, 120)) ||
    null;
  const textValues: string[] = [];
  for (const v of Object.values(section.content)) {
    if (typeof v === "string") textValues.push(v);
  }
  const textPreview = textValues.join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
  const fields: Record<string, unknown> = { ...section.content };
  delete fields.items;
  const repeatItems = Array.isArray((section.content as Record<string, unknown>).items)
    ? ((section.content as Record<string, unknown>).items as unknown[]).slice(0, 6)
    : [];
  return { type: semanticType, intent, headingPreview, textPreview, fields, repeatItems };
}

export const ENGINE_NAMES = {
  semantic: "semantic" as EngineName,
  widget: "widget" as EngineName,
  designAudit: "designAudit" as EngineName,
  master: "master" as EngineName,
} as const;
