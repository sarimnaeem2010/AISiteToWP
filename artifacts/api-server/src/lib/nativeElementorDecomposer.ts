import crypto from "node:crypto";

/**
 * Native Elementor decomposition.
 *
 * Walks the original DOM of a parsed HTML section and emits a real
 * `Section → Column → native widget` Elementor JSON tree. Each leaf
 * (heading / paragraph / image / button / icon / list) becomes one of
 * Elementor's standard widget types (`heading`, `text-editor`, `image`,
 * `button`, `icon`, `icon-list`) so the editing experience matches a
 * theme downloaded from Envato or the WordPress directory:
 *
 *   - clicking a heading opens the Heading widget panel,
 *   - clicking a button opens the Button widget panel,
 *   - sections and columns are independently selectable.
 *
 * Anything we cannot recognize (forms, sliders, custom embeds, framework
 * widgets) is preserved as-is inside an `html` widget so layout never
 * regresses. Pages are always editable end-to-end.
 *
 * Visual fidelity comes from the generated child theme's stylesheet
 * (already shipped) plus per-widget `_element_id` / `_css_classes`
 * settings that carry the original element's id/class to Elementor's
 * wrapper. Elementor renders the widget's content inside that wrapper,
 * and the existing site CSS targets the same id/class hierarchy.
 *
 * Phase 1 deliberately keeps the implementation deterministic and rule
 * based — no headless browser, no AI classifier, no CSS-to-Elementor
 * style translation. Those are tracked as follow-ups.
 */

function elementorId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 7);
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

const FLEX_GRID_CLASS_RE =
  /\b(flex|grid|row|d-flex|d-grid|columns?|cols?|grid-cols-\d+|grid-rows-\d+|md:flex|lg:flex|sm:flex|md:grid|lg:grid|sm:grid)\b/;

const COLUMN_CHILD_CLASS_RE = /\b(col(-\w+)?|column|grid-item|flex-1|flex-item|w-\d+|md:w-\d+|lg:w-\d+)\b/;

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "META",
  "LINK",
]);

const HTML_FALLBACK_TAGS = new Set([
  "FORM",
  "TABLE",
  "VIDEO",
  "AUDIO",
  "IFRAME",
  "EMBED",
  "OBJECT",
  "CANVAS",
  "SVG",
  "MAP",
  "DETAILS",
  "DIALOG",
]);

function isMeaningfulText(s: string): boolean {
  const t = s.trim();
  if (t.length < 1) return false;
  if (/^[\s\-•·–—|/\\©®™]+$/.test(t)) return false;
  return true;
}

function isRelativeAssetUrl(u: string): boolean {
  const trimmed = u.trim();
  if (!trimmed) return false;
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:|javascript:|data:)/i.test(trimmed)) return false;
  return true;
}

function rebaseUrl(u: string): string {
  if (!isRelativeAssetUrl(u)) return u;
  return `{{THEME_URI}}/assets/${u.replace(/^\.?\/+/, "")}`;
}

function classOf(el: Element): string {
  return (el.className?.toString() ?? "").trim();
}

function idOf(el: Element): string {
  return (el.getAttribute("id") ?? "").trim();
}

function isIconLeaf(el: Element): boolean {
  const tag = el.tagName;
  if (tag !== "I" && tag !== "SPAN") return false;
  if (el.children.length !== 0) return false;
  if (isMeaningfulText(el.textContent ?? "")) return false;
  const cls = classOf(el);
  return /\b(fa|fas|far|fab|fal|icon|bi|material-icons|ti|dashicons)[-\s]/i.test(cls);
}

function looksLikeButton(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "BUTTON") return true;
  if (tag !== "A") return false;
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  if (role === "button") return true;
  const cls = classOf(el).toLowerCase();
  return /\b(btn|button|cta|action)\b/.test(cls);
}

/**
 * The classic Bootstrap / Tailwind / hand-rolled flex-row layout: a
 * container element whose direct children are visually side-by-side.
 * Used for column detection.
 */
function isLayoutContainer(el: Element): boolean {
  const cls = classOf(el);
  if (FLEX_GRID_CLASS_RE.test(cls)) return true;
  const inlineStyle = (el.getAttribute("style") ?? "").toLowerCase();
  if (/display\s*:\s*(flex|grid|inline-flex|inline-grid)/.test(inlineStyle)) return true;
  // Heuristic: a container with 2+ same-tag, similar-class children is
  // almost certainly a row of cards / columns even when the CSS class
  // names aren't explicit.
  const children = Array.from(el.children).filter((c) => !SKIP_TAGS.has(c.tagName));
  if (children.length >= 2) {
    const firstTag = children[0].tagName;
    const sameTag = children.every((c) => c.tagName === firstTag);
    if (sameTag && firstTag === "DIV") {
      const firstClass = classOf(children[0]);
      const halfMatch = children.filter((c) => classOf(c) === firstClass).length >= Math.ceil(children.length * 0.66);
      if (halfMatch) return true;
    }
  }
  return false;
}

/**
 * Walk down through useless single-child wrappers so a section like
 * `<section><div><div><div class="row">...</div></div></div></section>`
 * is recognized as a row container.
 */
function unwrapSingleChild(el: Element): Element {
  let cur = el;
  while (
    cur.children.length === 1 &&
    !Array.from(cur.childNodes).some((c) => c.nodeType === 3 && isMeaningfulText(c.textContent ?? ""))
  ) {
    const onlyChild = cur.children[0];
    if (SKIP_TAGS.has(onlyChild.tagName)) break;
    if (HTML_FALLBACK_TAGS.has(onlyChild.tagName)) break;
    cur = onlyChild;
  }
  return cur;
}

interface ElementorNode {
  id: string;
  elType: "section" | "column" | "widget";
  isInner?: boolean;
  widgetType?: string;
  settings: Record<string, unknown>;
  elements: ElementorNode[];
}

function widget(
  seed: string,
  widgetType: string,
  settings: Record<string, unknown>,
): ElementorNode {
  return {
    id: elementorId(seed),
    elType: "widget",
    widgetType,
    settings,
    elements: [],
  };
}

function applyAdvancedFromEl(settings: Record<string, unknown>, el: Element): void {
  const id = idOf(el);
  if (id) settings._element_id = id;
  const cls = classOf(el);
  if (cls) settings._css_classes = cls;
}

function linkSettingsFrom(href: string): { url: string; is_external: string; nofollow: string } {
  return { url: href, is_external: "", nofollow: "" };
}

function emitHeadingWidget(seed: string, el: Element): ElementorNode {
  const tag = el.tagName.toLowerCase();
  const settings: Record<string, unknown> = {
    title: (el.textContent ?? "").trim(),
    header_size: tag,
    align: "",
  };
  applyAdvancedFromEl(settings, el);
  return widget(seed, "heading", settings);
}

function emitTextEditorWidget(seed: string, el: Element): ElementorNode {
  // Rebase image / link URLs inside the inner HTML before we hand it to the
  // text-editor widget. Elementor's editor widget passes the value through
  // wpautop on render so plain HTML is preserved.
  const inner = el.innerHTML
    .replace(/(\s)src=(["'])([^"']+)\2/g, (_m, lead, q, u) => `${lead}src=${q}${rebaseUrl(u)}${q}`)
    .replace(/(\s)href=(["'])([^"']+)\2/g, (_m, lead, q, u) => `${lead}href=${q}${rebaseUrl(u)}${q}`);
  const settings: Record<string, unknown> = {
    editor: `<${el.tagName.toLowerCase()}>${inner}</${el.tagName.toLowerCase()}>`,
  };
  applyAdvancedFromEl(settings, el);
  return widget(seed, "text-editor", settings);
}

function emitImageWidget(seed: string, el: Element, parentLink?: Element): ElementorNode {
  const src = el.getAttribute("src") ?? "";
  const alt = el.getAttribute("alt") ?? "";
  const settings: Record<string, unknown> = {
    image: { url: rebaseUrl(src), id: 0, alt, source: "library" },
    image_size: "full",
    align: "",
  };
  if (parentLink) {
    const href = parentLink.getAttribute("href") ?? "";
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      settings.link_to = "custom";
      settings.link = linkSettingsFrom(href);
    }
  }
  applyAdvancedFromEl(settings, el);
  return widget(seed, "image", settings);
}

function emitButtonWidget(seed: string, el: Element): ElementorNode {
  const text = (el.textContent ?? "").trim();
  const href = el.getAttribute("href") ?? "";
  const usable = href && !href.startsWith("#") && !href.startsWith("javascript:") ? href : "";
  const settings: Record<string, unknown> = {
    text,
    link: linkSettingsFrom(usable),
    align: "",
  };
  applyAdvancedFromEl(settings, el);
  return widget(seed, "button", settings);
}

function emitIconWidget(seed: string, el: Element, parentLink?: Element): ElementorNode {
  const cls = classOf(el);
  const settings: Record<string, unknown> = {
    selected_icon: { value: cls, library: "fa-solid" },
    align: "center",
    primary_color: "",
  };
  if (parentLink) {
    const href = parentLink.getAttribute("href") ?? "";
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      settings.link = linkSettingsFrom(href);
    }
  }
  applyAdvancedFromEl(settings, el);
  return widget(seed, "icon", settings);
}

function emitIconListWidget(seed: string, el: Element): ElementorNode {
  const items = Array.from(el.children)
    .filter((c) => c.tagName === "LI")
    .map((li, i) => {
      const text = (li.textContent ?? "").trim();
      const link = li.querySelector("a");
      const item: Record<string, unknown> = {
        _id: elementorId(`${seed}-li-${i}`),
        text,
      };
      if (link) {
        const href = link.getAttribute("href") ?? "";
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          item.link = linkSettingsFrom(href);
        }
      }
      return item;
    })
    .filter((it) => typeof it.text === "string" && (it.text as string).length > 0);
  const settings: Record<string, unknown> = {
    icon_list: items,
    view: "traditional",
    space_between: { unit: "px", size: 10 },
  };
  applyAdvancedFromEl(settings, el);
  return widget(seed, "icon-list", settings);
}

function emitHtmlFallbackWidget(seed: string, html: string): ElementorNode {
  // Rebase asset paths inside the preserved HTML so images/fonts still resolve.
  const rebased = html
    .replace(/(\s)src=(["'])([^"']+)\2/g, (_m, lead, q, u) => `${lead}src=${q}${rebaseUrl(u)}${q}`)
    .replace(/(\s)href=(["'])([^"']+)\2/g, (_m, lead, q, u) => `${lead}href=${q}${rebaseUrl(u)}${q}`)
    .replace(/(\s)data-src=(["'])([^"']+)\2/g, (_m, lead, q, u) => `${lead}data-src=${q}${rebaseUrl(u)}${q}`)
    .replace(/url\((['"]?)([^'")]+)\1\)/gi, (_m, q, u) => `url(${q}${rebaseUrl(u)}${q})`);
  return widget(seed, "html", { html: rebased });
}

interface WalkContext {
  seedPrefix: string;
  counter: { n: number };
}

function nextSeed(ctx: WalkContext, kind: string): string {
  ctx.counter.n += 1;
  return `${ctx.seedPrefix}:${kind}:${ctx.counter.n}`;
}

/**
 * Walk a column's DOM subtree and emit native widgets in document order.
 * Anything not understood collapses into an `html` fallback widget so
 * layout/visual content is never lost.
 */
function walkColumnContents(root: Element, ctx: WalkContext): ElementorNode[] {
  const out: ElementorNode[] = [];
  // Buffer of consecutive unrecognized siblings → flushed together as one
  // html-fallback widget (keeps original wrapper markup intact).
  let htmlBuffer: string[] = [];
  const flushHtml = (): void => {
    if (htmlBuffer.length === 0) return;
    const joined = htmlBuffer.join("").trim();
    htmlBuffer = [];
    if (joined.length === 0) return;
    out.push(emitHtmlFallbackWidget(nextSeed(ctx, "html"), joined));
  };

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) {
      // raw text node at column level — wrap as text-editor paragraph
      const t = (node.textContent ?? "").trim();
      if (isMeaningfulText(t)) {
        flushHtml();
        const settings: Record<string, unknown> = { editor: `<p>${t}</p>` };
        out.push(widget(nextSeed(ctx, "text"), "text-editor", settings));
      }
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) continue;

    if (HTML_FALLBACK_TAGS.has(tag)) {
      htmlBuffer.push(el.outerHTML);
      continue;
    }

    // ICON leaf
    if (isIconLeaf(el)) {
      flushHtml();
      out.push(emitIconWidget(nextSeed(ctx, "icon"), el));
      continue;
    }

    // HEADING
    if (HEADING_TAGS.has(tag)) {
      flushHtml();
      out.push(emitHeadingWidget(nextSeed(ctx, "heading"), el));
      continue;
    }

    // IMAGE (top-level)
    if (tag === "IMG") {
      flushHtml();
      out.push(emitImageWidget(nextSeed(ctx, "image"), el));
      continue;
    }

    // BUTTON
    if (tag === "BUTTON" || (tag === "A" && looksLikeButton(el))) {
      flushHtml();
      out.push(emitButtonWidget(nextSeed(ctx, "button"), el));
      continue;
    }

    // LINKED IMAGE — `<a><img></a>` becomes an Image widget with link_to=custom.
    if (tag === "A") {
      const onlyImg =
        el.children.length === 1 &&
        el.children[0].tagName === "IMG" &&
        !isMeaningfulText(el.textContent ?? "");
      if (onlyImg) {
        flushHtml();
        out.push(emitImageWidget(nextSeed(ctx, "image"), el.children[0], el));
        continue;
      }
      const onlyIcon =
        el.children.length === 1 &&
        isIconLeaf(el.children[0]) &&
        !isMeaningfulText(el.textContent ?? "");
      if (onlyIcon) {
        flushHtml();
        out.push(emitIconWidget(nextSeed(ctx, "icon"), el.children[0], el));
        continue;
      }
      // text link — emit a button widget (Elementor has no separate "text link"
      // widget; the Button widget with style=link is the standard choice).
      const linkText = (el.textContent ?? "").trim();
      if (isMeaningfulText(linkText)) {
        flushHtml();
        out.push(emitButtonWidget(nextSeed(ctx, "button"), el));
        continue;
      }
      htmlBuffer.push(el.outerHTML);
      continue;
    }

    // PLAIN-TEXT LIST → icon-list widget
    if (tag === "UL" || tag === "OL") {
      const lis = Array.from(el.children).filter((c) => c.tagName === "LI");
      const allPlain =
        lis.length > 0 &&
        lis.length === el.children.length &&
        lis.every((li) => Array.from(li.children).every((c) => c.tagName === "A"));
      if (allPlain) {
        flushHtml();
        out.push(emitIconListWidget(nextSeed(ctx, "list"), el));
        continue;
      }
      htmlBuffer.push(el.outerHTML);
      continue;
    }

    // PARAGRAPH / inline text wrapper
    if (
      tag === "P" ||
      tag === "BLOCKQUOTE" ||
      tag === "FIGCAPTION" ||
      tag === "PRE"
    ) {
      const t = (el.textContent ?? "").trim();
      if (isMeaningfulText(t)) {
        flushHtml();
        out.push(emitTextEditorWidget(nextSeed(ctx, "text"), el));
      }
      continue;
    }

    // GENERIC CONTAINER (DIV / ARTICLE / SECTION / etc.) — recurse so
    // nested recognized leaves are still surfaced as native widgets.
    // We descend through wrappers (single-child or multi-child) as long
    // as they don't carry their own meaningful text. This means a
    // `<div class="cta-row"><a>…</a><a>…</a></div>` produces TWO real
    // Button widgets even though the wrapper class itself is dropped —
    // the ergonomic gain (each button selectable in the sidebar) wins
    // over preserving the wrapper's class hook.
    if (tag === "DIV" || tag === "ARTICLE" || tag === "SECTION" || tag === "HEADER" || tag === "FOOTER" || tag === "ASIDE" || tag === "MAIN" || tag === "PICTURE" || tag === "FIGURE") {
      const ownText = Array.from(el.childNodes).some(
        (c) => c.nodeType === 3 && isMeaningfulText(c.textContent ?? ""),
      );
      if (ownText) {
        // Has its own free-floating text → keep as a single text-editor
        // so the text isn't lost.
        flushHtml();
        out.push(emitTextEditorWidget(nextSeed(ctx, "text"), el));
        continue;
      }
      flushHtml();
      const inner = walkColumnContents(el, ctx);
      for (const w of inner) out.push(w);
      continue;
    }

    // Fallback — preserve as html
    htmlBuffer.push(el.outerHTML);
  }
  flushHtml();
  return out;
}

interface ColumnPlan {
  el: Element;
  size: number; // 1..100
}

function planColumns(root: Element): ColumnPlan[] {
  const target = unwrapSingleChild(root);
  if (target !== root && isLayoutContainer(target)) {
    const kids = Array.from(target.children).filter((c) => !SKIP_TAGS.has(c.tagName));
    if (kids.length >= 2) {
      // Try to read explicit `col-N` widths first.
      const widths = kids.map((k) => {
        const cls = classOf(k);
        const m = cls.match(/\bcol(?:-\w+)?-(\d{1,2})\b/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n >= 1 && n <= 12) return Math.round((n / 12) * 100);
        }
        const w = cls.match(/\bw-(\d{1,2})\/(\d{1,2})\b/);
        if (w) {
          const num = parseInt(w[1], 10);
          const den = parseInt(w[2], 10);
          if (den > 0) return Math.round((num / den) * 100);
        }
        return 0;
      });
      const explicit = widths.every((w) => w > 0);
      const equal = Math.round(100 / kids.length);
      return kids.map((el, i) => ({
        el,
        size: explicit ? widths[i] : equal,
      }));
    }
  }
  if (isLayoutContainer(root)) {
    const kids = Array.from(root.children).filter((c) => !SKIP_TAGS.has(c.tagName));
    if (kids.length >= 2) {
      const equal = Math.round(100 / kids.length);
      return kids.map((el) => ({ el, size: equal }));
    }
  }
  return [{ el: root, size: 100 }];
}

function buildColumn(plan: ColumnPlan, ctx: WalkContext, idx: number): ElementorNode {
  const colCtx: WalkContext = {
    seedPrefix: `${ctx.seedPrefix}:col-${idx}`,
    counter: { n: 0 },
  };
  const widgets = walkColumnContents(plan.el, colCtx);
  // If the column ended up empty (e.g. wrapper-only), preserve its raw HTML.
  if (widgets.length === 0 && plan.el.innerHTML.trim().length > 0) {
    widgets.push(emitHtmlFallbackWidget(`${colCtx.seedPrefix}:html-empty`, plan.el.innerHTML));
  }
  return {
    id: elementorId(`${colCtx.seedPrefix}:wrap`),
    elType: "column",
    isInner: false,
    settings: { _column_size: plan.size, _inline_size: null },
    elements: widgets,
  };
}

/**
 * Decompose one parsed HTML section element into a complete Elementor
 * `section → column → widget` JSON node. Returns `null` only when the
 * section is empty or all content was filtered out (caller should fall
 * back to the legacy custom-widget path).
 */
export function decomposeSectionToNative(
  rootEl: Element,
  projectSlug: string,
  sectionIndex: number,
  pageSlug = "",
): ElementorNode | null {
  // Page slug enters the seed so two pages in the same project don't
  // collide on `${projectSlug}:sec-1:section` — Elementor requires
  // every node id within a single page's `_elementor_data` to be unique
  // and IDs are derived deterministically from this seed.
  const seedPrefix = `${projectSlug}:${pageSlug}:sec-${sectionIndex}`;
  const ctx: WalkContext = { seedPrefix, counter: { n: 0 } };

  const columns = planColumns(rootEl).map((p, i) => buildColumn(p, ctx, i));
  // Filter columns whose only widget is an empty html fallback.
  const nonEmpty = columns.filter((c) => c.elements.length > 0);
  if (nonEmpty.length === 0) return null;

  const sectionSettings: Record<string, unknown> = {};
  applyAdvancedFromEl(sectionSettings, rootEl);

  // Promote inline `background-image: url(...)` on the section root to
  // an Elementor section background so the user can edit it from the
  // sidebar (Style → Background → Image) and visual fidelity survives
  // the switch from "custom widget that owns the original markup" to
  // "native widgets inside an Elementor section that doesn't carry the
  // original tag's inline style".
  const inlineStyle = rootEl.getAttribute("style") ?? "";
  const bgMatch = inlineStyle.match(/background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
  if (bgMatch) {
    sectionSettings.background_background = "classic";
    sectionSettings.background_image = { url: rebaseUrl(bgMatch[2]), id: 0, source: "library" };
    const colorMatch = inlineStyle.match(/background-color\s*:\s*([^;]+)/i);
    if (colorMatch) sectionSettings.background_color = colorMatch[1].trim();
  }

  return {
    id: elementorId(`${seedPrefix}:section`),
    elType: "section",
    isInner: false,
    settings: sectionSettings,
    elements: nonEmpty,
  };
}
