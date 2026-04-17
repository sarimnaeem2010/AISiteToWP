import crypto from "node:crypto";
import type { ExtractedPage, ExtractedSection } from "./sectionFieldExtractor";

/**
 * Generate a stable Elementor-style 7-char hex id derived from a seed.
 * Elementor expects every node (section/column/widget) to have a unique
 * 7-character id. We hash the seed so different seeds within the same
 * section never collide, and the same seed always produces the same id
 * (idempotent re-imports).
 */
function elementorId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 7);
}

/**
 * Build Gutenberg post_content for a page composed entirely of our custom
 * per-section blocks. Each block is self-closing and carries its attribute
 * values (the original text/links/images) in the comment delimiter so the
 * render.php substitutes them back into the saved template.
 */
export function composeGutenbergContent(page: ExtractedPage): string {
  const parts: string[] = [];
  for (const s of page.sections) {
    const attrs: Record<string, string> = {};
    for (const f of s.fields) attrs[f.key] = f.default;
    const json = JSON.stringify(attrs).replace(/--/g, "\\u002d\\u002d");
    parts.push(`<!-- wp:${s.blockName} ${json} /-->`);
  }
  return parts.join("\n\n");
}

/**
 * Build the elementor_data JSON array for a page. Each section becomes one
 * Elementor section containing a single column containing our custom
 * widget. Widget settings are the field defaults.
 */
export function composeElementorData(page: ExtractedPage): unknown[] {
  return page.sections.map((s) => {
    const safeId = s.blockName.split("/")[1].replace(/[^a-zA-Z0-9_]/g, "_");
    const widgetType = `wpb_${safeId}`;
    const settings: Record<string, string> = {};
    for (const f of s.fields) settings[f.key] = f.default;
    return {
      id: elementorId(`${safeId}:section`),
      elType: "section",
      settings: {},
      isInner: false,
      elements: [
        {
          id: elementorId(`${safeId}:column`),
          elType: "column",
          settings: { _column_size: 100 },
          isInner: false,
          elements: [
            {
              id: elementorId(`${safeId}:widget`),
              elType: "widget",
              widgetType,
              settings,
              elements: [],
            },
          ],
        },
      ],
    };
  });
}
