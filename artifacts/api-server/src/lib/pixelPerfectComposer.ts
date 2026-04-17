import crypto from "node:crypto";
import type { ExtractedPage } from "./sectionFieldExtractor";

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
 * Build the elementor_data JSON array for a page. Each section becomes one
 * Elementor section containing a single column containing our custom
 * widget. Widget settings are the field defaults.
 */
export function composeElementorData(page: ExtractedPage): unknown[] {
  return page.sections.map((s) => {
    // Native-widget path: the extractor already produced a complete
    // Elementor section tree (with real `heading` / `image` / `button` /
    // etc. widgets). Use it verbatim — no PHP widget is registered for
    // this section, the editing UX matches a normal Envato theme.
    if (s.nativeElementor) return s.nativeElementor;

    const safeId = s.blockName.split("/")[1].replace(/[^a-zA-Z0-9_]/g, "_");
    const widgetType = `wpb_${safeId}`;
    // Settings shape mirrors what the Elementor controls registered in
    // WPB_Widget_Base produce: a URL control yields {url, is_external,
    // nofollow}, a MEDIA control yields {url, id}, everything else is a
    // plain string. The widget renderer reduces these back to scalars
    // before substituting into the template, so even a fresh import
    // (settings = group defaults) round-trips byte-identically.
    const settings: Record<string, unknown> = {};
    if (s.groups && s.groups.length > 0) {
      for (const g of s.groups) {
        for (const c of g.controls) {
          if (c.type === "url") {
            settings[c.key] = { url: c.default, is_external: "", nofollow: "" };
          } else if (c.type === "media") {
            settings[c.key] = { url: c.default, id: 0 };
          } else if (c.type === "icons") {
            // ICONS control: shape mirrors what the Elementor sidebar
            // posts back. Default seeds the original icon-font class
            // tagged as a Font Awesome library entry, so an unmodified
            // import re-renders byte-identically. SVG uploads only show
            // up after the user picks one from the Elementor sidebar.
            settings[c.key] = { value: c.default, library: "fa-solid" };
          } else if (c.type === "repeater") {
            // Seed REPEATER rows from the newline-joined default. Each
            // row is a single { item: "..." } object — matches the
            // shape Elementor's REPEATER control posts back from the
            // sidebar.
            const rows = (c.default ?? "")
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
              .map((item) => ({ item }));
            settings[c.key] = rows;
          } else {
            settings[c.key] = c.default;
          }
        }
      }
    } else {
      for (const f of s.fields) settings[f.key] = f.default;
    }
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
