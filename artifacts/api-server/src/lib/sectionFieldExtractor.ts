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
