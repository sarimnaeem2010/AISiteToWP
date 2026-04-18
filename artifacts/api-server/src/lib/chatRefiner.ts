import { runEngine } from "./aiClient";
import { logger } from "./logger";
import type { ParsedSite } from "./parser";

const CHAT_SYSTEM_PROMPT = `You are an AI page-layout assistant. The user has a parsed website structure (JSON) and will give you natural-language instructions to modify it. Examples:
- "Make the header sticky"
- "Add a 3-column features section about pricing tiers"
- "Change background to dark"
- "Remove the testimonials section"
- "Reorder so the FAQ comes before the contact section"

Rules:
1. Apply ONLY the user's requested change. Do not invent unrelated changes.
2. Preserve all existing content/text unless the user explicitly asks to change it.
3. When adding new sections, infer reasonable placeholder content from context.
4. Allowed semantic types: navbar, hero, features, about, services, testimonials, pricing, gallery, faq, contact, footer, cta, blog-preview, header, stats, logos, team, blog, newsletter, custom.
5. For style changes (sticky header, dark mode, accent color, etc.), set the change on the section's "fields" object using snake_case keys like "sticky": true, "background": "dark", "primary_color": "#000".
6. Output a JSON object with TWO keys: "site" (the full updated ParsedSite, same shape as input) and "summary" (a one-sentence human description of what you changed).
7. Output JSON only. No prose outside the JSON object.`;

export interface ChatRefineResult {
  site: ParsedSite;
  summary: string;
}

/**
 * Apply a single natural-language layout instruction to a parsed site.
 * This is an explicit user action so we always run a fresh AI call —
 * no caching. Returns null when AI is disabled or the response is
 * invalid; the caller surfaces a 503 in that case.
 */
export async function applyChatRefinement(
  site: ParsedSite,
  instruction: string,
): Promise<ChatRefineResult | null> {
  const trimmedInstruction = instruction.trim().slice(0, 1000);
  if (!trimmedInstruction) return null;

  const result = await runEngine<Partial<ChatRefineResult>>({
    engine: "chatRefine",
    systemPrompt: CHAT_SYSTEM_PROMPT,
    userPrompt: `CURRENT_SITE:\n${JSON.stringify(site, null, 2)}\n\nUSER_INSTRUCTION:\n${trimmedInstruction}\n\nReturn JSON {site, summary}.`,
  });

  if (!result.output) {
    if (result.error && result.error !== "ai_disabled") {
      logger.warn({ err: result.error }, "Chat refinement failed");
    }
    return null;
  }
  const parsed = result.output;
  if (!parsed.site || !Array.isArray((parsed.site as ParsedSite).pages)) {
    logger.warn("Chat refinement response missing site.pages");
    return null;
  }
  return {
    site: parsed.site as ParsedSite,
    summary: typeof parsed.summary === "string" && parsed.summary.length > 0
      ? parsed.summary.slice(0, 280)
      : "Layout updated.",
  };
}
