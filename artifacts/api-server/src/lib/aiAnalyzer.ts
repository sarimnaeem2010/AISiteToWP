import OpenAI from "openai";
import { logger } from "./logger";

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
}

const SYSTEM_PROMPT = `You are an expert web-page structural analyzer. You convert raw HTML into a normalized JSON schema describing pages, sections, design system, and reusable content types for a WordPress importer.

Always:
- Pick the most accurate semanticType from the allowed list.
- Extract all visible text into fields. Never invent content.
- For repeating content (e.g. each testimonial, each pricing plan, each service, each team member), put each entry as one object inside repeatItems.
- For a single hero/cta/about/contact section, leave repeatItems empty and put the data in fields.
- Use snake_case keys in fields and inside repeatItems entries (headline, subheadline, cta_text, cta_url, image_url, name, role, quote, plan_name, plan_price, plan_features, etc).
- Suggest a Custom Post Type for any section that contains 3+ similar repeatItems (testimonials, services, team, projects, plans, faq).
- Output only valid JSON matching the schema. No prose.`;

const REFINEMENT_SYSTEM_PROMPT = `You are a UI structure refinement post-processor. You take a draft JSON page structure produced by a first-pass analyzer and clean it up.

Rules:
1. Merge duplicate or overlapping sections that describe the same logical block.
2. Remove noise sections (empty fields, decorative spacers, sections with no real content).
3. Ensure logical top-to-bottom flow (e.g. header/navbar first, hero next, footer last).
4. Normalize content: trim excessive whitespace, drop placeholder text like "Lorem ipsum" if obvious filler, but never invent content.
5. Ensure each section is self-contained: every section must have either non-empty fields or non-empty repeatItems.
6. Keep semanticType values from the allowed list. If unsure, use "custom".
7. Preserve the designSystem and suggestedCpts; only adjust suggestedCpts.itemCount if you removed/merged repeatItems.
8. Output only the improved JSON, matching the SAME schema as the input. No prose.`;

const SCHEMA_HINT = {
  pages: [
    {
      name: "Home",
      slug: "home",
      sections: [
        {
          semanticType: "hero",
          confidence: 0.95,
          fields: {
            headline: "string",
            subheadline: "string",
            cta_text: "string",
            cta_url: "string",
            image_url: "string",
          },
          repeatItems: [],
        },
      ],
    },
  ],
  designSystem: {
    font: "Inter, sans-serif",
    fontHeading: "Inter, sans-serif",
    colors: ["#111827", "#6366F1", "#FFFFFF"],
    primaryColor: "#6366F1",
    buttonStyle: "rounded",
    headingStyle: "bold",
  },
  suggestedCpts: [
    {
      slug: "testimonial",
      label: "Testimonial",
      pluralLabel: "Testimonials",
      sourceSemanticType: "testimonials",
      fields: ["quote", "author_name", "author_role"],
      itemCount: 3,
    },
  ],
};

function trimHtmlForLLM(html: string, maxChars = 60_000): string {
  // Strip script/style noise to give the model more room for content.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
  if (cleaned.length <= maxChars) return cleaned;
  // Keep head + first portion of body + tail.
  return cleaned.slice(0, maxChars - 2000) + "\n<!-- TRUNCATED -->\n" + cleaned.slice(-2000);
}

function isAiAvailable(): boolean {
  return Boolean(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
}

export async function analyzeWithAi(html: string): Promise<AiAnalysis | null> {
  if (!isAiAvailable()) {
    logger.warn("OpenAI integration env vars not set, skipping AI analysis");
    return null;
  }

  const client = new OpenAI({
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  });

  const trimmed = trimHtmlForLLM(html);

  try {
    const response = await client.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Analyze this HTML and return JSON matching this exact schema (allowed semanticType values: ${SEMANTIC_TYPES.join(", ")}):\n\nSCHEMA:\n${JSON.stringify(SCHEMA_HINT, null, 2)}\n\nHTML:\n${trimmed}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      logger.warn("AI returned empty response");
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<AiAnalysis>;
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      logger.warn({ raw: raw.slice(0, 200) }, "AI response missing pages");
      return null;
    }

    // Normalize and defensive-default
    const pages: AiPage[] = parsed.pages.map((p, i) => ({
      name: p.name || `Page ${i + 1}`,
      slug: p.slug || (i === 0 ? "home" : `page-${i + 1}`),
      sections: (p.sections ?? []).map((s) => ({
        semanticType: SEMANTIC_TYPES.includes(s.semanticType as SemanticType)
          ? (s.semanticType as SemanticType)
          : "custom",
        confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
        fields: s.fields ?? {},
        repeatItems: Array.isArray(s.repeatItems) ? s.repeatItems : [],
      })),
    }));

    const designSystem: AiDesignSystem = {
      font: parsed.designSystem?.font || "Inter, sans-serif",
      fontHeading: parsed.designSystem?.fontHeading,
      colors: Array.isArray(parsed.designSystem?.colors) ? parsed.designSystem!.colors : [],
      primaryColor: parsed.designSystem?.primaryColor,
      buttonStyle: parsed.designSystem?.buttonStyle || "rounded",
      headingStyle: parsed.designSystem?.headingStyle || "bold",
    };

    const suggestedCpts: SuggestedCpt[] = (parsed.suggestedCpts ?? [])
      .filter((c) => c && typeof c.slug === "string" && c.slug.length > 0)
      .map((c) => ({
        slug: c.slug.replace(/[^a-z0-9_]/g, "_").slice(0, 20),
        label: c.label || c.slug,
        pluralLabel: c.pluralLabel || `${c.label || c.slug}s`,
        sourceSemanticType: SEMANTIC_TYPES.includes(c.sourceSemanticType as SemanticType)
          ? (c.sourceSemanticType as SemanticType)
          : "custom",
        fields: Array.isArray(c.fields) ? c.fields : [],
        itemCount: typeof c.itemCount === "number" ? c.itemCount : 0,
      }));

    const draft: AiAnalysis = { pages, designSystem, suggestedCpts, source: "ai" };

    // Second pass: refinement / cleaning of the draft structure.
    const refined = await refineWithAi(client, draft);
    return refined ?? draft;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "AI analysis failed");
    return null;
  }
}

async function refineWithAi(client: OpenAI, draft: AiAnalysis): Promise<AiAnalysis | null> {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: REFINEMENT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Refine this draft structure (allowed semanticType values: ${SEMANTIC_TYPES.join(", ")}). Return JSON in the same shape.\n\nDRAFT:\n${JSON.stringify(draft, null, 2)}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      logger.warn("AI refinement returned empty response, keeping draft");
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<AiAnalysis>;
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      logger.warn("AI refinement missing pages, keeping draft");
      return null;
    }

    const pages: AiPage[] = parsed.pages.map((p, i) => ({
      name: p.name || draft.pages[i]?.name || `Page ${i + 1}`,
      slug: p.slug || draft.pages[i]?.slug || (i === 0 ? "home" : `page-${i + 1}`),
      sections: (p.sections ?? [])
        .map((s) => ({
          semanticType: SEMANTIC_TYPES.includes(s.semanticType as SemanticType)
            ? (s.semanticType as SemanticType)
            : "custom",
          confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
          fields: s.fields ?? {},
          repeatItems: Array.isArray(s.repeatItems) ? s.repeatItems : [],
        }))
        // Drop sections with no real content after refinement.
        .filter((s) => Object.keys(s.fields).length > 0 || (s.repeatItems?.length ?? 0) > 0),
    }));

    const designSystem: AiDesignSystem = {
      font: parsed.designSystem?.font || draft.designSystem.font,
      fontHeading: parsed.designSystem?.fontHeading ?? draft.designSystem.fontHeading,
      colors: Array.isArray(parsed.designSystem?.colors) ? parsed.designSystem!.colors : draft.designSystem.colors,
      primaryColor: parsed.designSystem?.primaryColor ?? draft.designSystem.primaryColor,
      buttonStyle: parsed.designSystem?.buttonStyle || draft.designSystem.buttonStyle,
      headingStyle: parsed.designSystem?.headingStyle || draft.designSystem.headingStyle,
    };

    const suggestedCpts: SuggestedCpt[] = Array.isArray(parsed.suggestedCpts)
      ? parsed.suggestedCpts
          .filter((c) => c && typeof c.slug === "string" && c.slug.length > 0)
          .map((c) => ({
            slug: c.slug.replace(/[^a-z0-9_]/g, "_").slice(0, 20),
            label: c.label || c.slug,
            pluralLabel: c.pluralLabel || `${c.label || c.slug}s`,
            sourceSemanticType: SEMANTIC_TYPES.includes(c.sourceSemanticType as SemanticType)
              ? (c.sourceSemanticType as SemanticType)
              : "custom",
            fields: Array.isArray(c.fields) ? c.fields : [],
            itemCount: typeof c.itemCount === "number" ? c.itemCount : 0,
          }))
      : draft.suggestedCpts;

    logger.info(
      {
        draftSections: draft.pages.reduce((n, p) => n + p.sections.length, 0),
        refinedSections: pages.reduce((n, p) => n + p.sections.length, 0),
      },
      "AI refinement pass complete"
    );

    return { pages, designSystem, suggestedCpts, source: "ai" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "AI refinement failed, keeping draft");
    return null;
  }
}
