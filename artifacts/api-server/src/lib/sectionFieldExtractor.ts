import { JSDOM } from "jsdom";
import crypto from "node:crypto";

export type FieldType = "text" | "url" | "attr";

export interface ExtractedField {
  key: string;
  type: FieldType;
  default: string;
  label: string;
}

export interface ExtractedSection {
  id: string;
  blockName: string;
  label: string;
  category: string;
  template: string;
  fields: ExtractedField[];
}

export interface ExtractedPage {
  slug: string;
  title: string;
  sections: ExtractedSection[];
}

const TEXT_PARENTS = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6",
  "P", "A", "BUTTON", "LI", "SPAN", "STRONG", "EM",
  "LABEL", "FIGCAPTION", "BLOCKQUOTE", "CITE", "SUMMARY",
  "DT", "DD", "TD", "TH", "SMALL", "B", "I",
]);

const SECTION_TAGS = new Set(["SECTION", "HEADER", "FOOTER", "NAV", "ASIDE", "MAIN", "ARTICLE"]);

function inferLabel(el: Element): string {
  const id = el.getAttribute("id");
  if (id) return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const cls = el.className?.toString().split(/\s+/).filter(Boolean) ?? [];
  for (const c of cls) {
    if (/^(hero|features?|pricing|testimonials?|faq|cta|footer|navbar|header|gallery|stats|team|contact|about|services?|blog|newsletter)/i.test(c)) {
      return c.replace(/[-_]+/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
    }
  }
  return el.tagName.toLowerCase();
}

function inferCategory(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "nav" || tag === "header") return "navigation";
  if (tag === "footer") return "footer";
  const cls = (el.className?.toString() ?? "").toLowerCase();
  const id = (el.getAttribute("id") ?? "").toLowerCase();
  const haystack = `${cls} ${id}`;
  if (/hero|banner|jumbotron/.test(haystack)) return "hero";
  if (/feature|service/.test(haystack)) return "features";
  if (/pric/.test(haystack)) return "pricing";
  if (/testimoni|review/.test(haystack)) return "testimonials";
  if (/faq|question/.test(haystack)) return "faq";
  if (/team|member|staff/.test(haystack)) return "team";
  if (/contact/.test(haystack)) return "contact";
  if (/cta|callout/.test(haystack)) return "cta";
  if (/stat|metric/.test(haystack)) return "stats";
  if (/gallery|portfolio/.test(haystack)) return "gallery";
  return "section";
}

function shortHash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
}

/**
 * Returns true if the URL is relative to the original site root and would
 * therefore resolve incorrectly when the section HTML is rendered inside a
 * WordPress page. Absolute http(s)://, protocol-relative //, anchors,
 * mailto:, tel:, javascript: and data: URIs are all left alone.
 */
function isRelativeAssetUrl(u: string): boolean {
  const trimmed = u.trim();
  if (!trimmed) return false;
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:|javascript:|data:)/i.test(trimmed)) return false;
  return true;
}

/**
 * Rewrite every relative asset URL in the section HTML to a {{THEME_URI}}/...
 * placeholder. The render template engine substitutes {{THEME_URI}} with the
 * generated child theme's stylesheet directory URI at request time, so images
 * referenced by section markup load from the theme's bundled assets folder
 * regardless of which WP page the block is rendered on.
 */
function rebaseAssetUrls(root: Element): void {
  const attrTargets: Array<[string, string[]]> = [
    ["img", ["src", "data-src", "data-lazy-src", "srcset"]],
    ["source", ["src", "srcset"]],
    ["video", ["src", "poster"]],
    ["audio", ["src"]],
    ["iframe", ["src"]],
    ["embed", ["src"]],
    ["object", ["data"]],
    ["link", ["href"]],
    ["script", ["src"]],
    ["use", ["href", "xlink:href"]],
    ["a", ["href"]],
  ];
  // Include the root element itself when searching for style attrs, since
  // querySelectorAll only walks descendants.
  const allWithBg: Element[] = [
    ...(root.hasAttribute("style") ? [root] : []),
    ...Array.from(root.querySelectorAll("[style]")),
  ];
  for (const [selector, attrs] of attrTargets) {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      for (const attr of attrs) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        // For anchor href, only rewrite if it looks like a file (has extension)
        if (selector === "a" && !/\.[a-z0-9]{1,5}(\?|#|$)/i.test(v)) continue;
        if (attr === "srcset") {
          const rewritten = v.split(",").map((part) => {
            const segs = part.trim().split(/\s+/);
            if (segs[0] && isRelativeAssetUrl(segs[0])) {
              segs[0] = `{{THEME_URI}}/assets/${segs[0].replace(/^\.?\/+/, "")}`;
            }
            return segs.join(" ");
          }).join(", ");
          el.setAttribute(attr, rewritten);
        } else if (isRelativeAssetUrl(v)) {
          el.setAttribute(attr, `{{THEME_URI}}/assets/${v.replace(/^\.?\/+/, "")}`);
        }
      }
    }
  }
  // Inline style background images
  for (const el of Array.from(allWithBg)) {
    const style = el.getAttribute("style");
    if (!style) continue;
    const rewritten = style.replace(/url\((['"]?)([^'")]+)\1\)/gi, (_m, q, url) => {
      if (!isRelativeAssetUrl(url)) return `url(${q}${url}${q})`;
      return `url(${q}{{THEME_URI}}/assets/${url.replace(/^\.?\/+/, "")}${q})`;
    });
    if (rewritten !== style) el.setAttribute("style", rewritten);
  }
}

function isMeaningfulText(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 1) return false;
  // Skip if only punctuation/icons
  if (/^[\s\-•·–—|/\\©®™]+$/.test(trimmed)) return false;
  return true;
}

/**
 * Walk the element subtree and replace every meaningful piece of editable
 * content (text-node content, anchor href, image src/alt) with a typed
 * placeholder. Returns the rewritten outerHTML and the list of fields.
 */
function buildSectionTemplate(
  section: Element,
  doc: Document,
): { template: string; fields: ExtractedField[] } {
  // Rebase any relative asset URLs first so the resulting fields' default
  // values are also theme-relative — that way image fields persist as
  // {{THEME_URI}}/... and survive when the user edits and re-saves.
  rebaseAssetUrls(section);

  const fields: ExtractedField[] = [];
  let counter = 0;
  const used = new Set<string>();

  const mkKey = (hint: string): string => {
    const base = hint.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "f";
    let key = `${base}_${counter++}`;
    while (used.has(key)) key = `${base}_${counter++}`;
    used.add(key);
    return key;
  };

  const labelFor = (el: Element, kind: string): string => {
    const tag = el.tagName.toLowerCase();
    return `${tag} ${kind}`;
  };

  // Walk text-bearing leaf elements first
  const allElements = section.querySelectorAll("*");
  const targets: Element[] = Array.from(allElements);
  targets.unshift(section);

  for (const el of targets) {
    if (!TEXT_PARENTS.has(el.tagName)) continue;
    // Only process direct text children (not nested element text)
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 3 /* TEXT_NODE */) continue;
      const raw = child.textContent ?? "";
      if (!isMeaningfulText(raw)) continue;
      const key = mkKey(`txt_${el.tagName.toLowerCase()}`);
      fields.push({ key, type: "text", default: raw.trim(), label: labelFor(el, "text") });
      child.textContent = raw.replace(raw.trim(), `{{TEXT:${key}}}`);
    }
  }

  // Anchor hrefs
  for (const a of Array.from(section.querySelectorAll("a"))) {
    const href = a.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      const key = mkKey("href");
      fields.push({ key, type: "url", default: href, label: "link URL" });
      a.setAttribute("href", `{{URL:${key}}}`);
    }
  }

  // Images
  for (const img of Array.from(section.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src) {
      const key = mkKey("img");
      fields.push({ key, type: "url", default: src, label: "image URL" });
      img.setAttribute("src", `{{URL:${key}}}`);
    }
    const alt = img.getAttribute("alt");
    if (alt && isMeaningfulText(alt)) {
      const key = mkKey("alt");
      fields.push({ key, type: "attr", default: alt, label: "image alt" });
      img.setAttribute("alt", `{{ATTR:${key}}}`);
    }
  }

  return { template: section.outerHTML, fields };
}

/**
 * Scan a single HTML page document and return one ExtractedSection per
 * top-level semantic block found inside <body>. The block name is unique
 * per project (caller scopes the namespace) and the template + fields can
 * be turned into a Gutenberg block, an Elementor widget, or both.
 */
export function extractSectionsFromPage(
  html: string,
  pageSlug: string,
  projectSlug: string,
): ExtractedSection[] {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const body = doc.body;
  if (!body) return [];

  // Collect top-level semantic blocks. If no <section>/<nav>/etc. exists,
  // fall back to direct children of body.
  let candidates: Element[] = Array.from(body.children).filter((c) => SECTION_TAGS.has(c.tagName));
  if (candidates.length === 0) {
    candidates = Array.from(body.children).filter((c) => c.tagName !== "SCRIPT" && c.tagName !== "STYLE");
  }

  const sections: ExtractedSection[] = [];
  let idx = 0;
  for (const el of candidates) {
    idx++;
    const label = inferLabel(el);
    const category = inferCategory(el);
    // Stable id: tag+index+hash of original outerHTML so repeat parses produce same name
    const hash = shortHash(el.outerHTML);
    const id = `${pageSlug}-${idx}-${category}-${hash}`;
    // WP block name must be lowercase ascii [a-z][a-z0-9-]*
    const blockName = `wpb-${projectSlug}/sec-${idx}-${category}-${hash}`
      .toLowerCase()
      .replace(/[^a-z0-9/-]/g, "-");
    const { template, fields } = buildSectionTemplate(el, doc);
    sections.push({ id, blockName, label: `${label} (${category})`, category, template, fields });
  }
  return sections;
}
