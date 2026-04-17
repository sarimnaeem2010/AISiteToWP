import crypto from "node:crypto";
import {
  type ParsedSheet,
  computeStyles,
  applyHeadingStyles,
  applyTextEditorStyles,
  applyImageStyles,
  applyButtonStyles,
  applyContainerStyles,
} from "./cssStyleResolver";

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
 *
 * Also collects the classes of every wrapper we descended PAST so the
 * caller can reattach those classes to the next live Elementor element.
 * Without this, original CSS like `.container .grid h1 { ... }` would
 * stop matching after Phase 1 (since `.container` and `.grid` aren't in
 * the rendered DOM anymore) and the page would look visually broken.
 */
function unwrapSingleChild(el: Element): { final: Element; droppedClasses: string[] } {
  let cur = el;
  const droppedClasses: string[] = [];
  while (
    cur.children.length === 1 &&
    !Array.from(cur.childNodes).some((c) => c.nodeType === 3 && isMeaningfulText(c.textContent ?? ""))
  ) {
    const onlyChild = cur.children[0];
    if (SKIP_TAGS.has(onlyChild.tagName)) break;
    if (HTML_FALLBACK_TAGS.has(onlyChild.tagName)) break;
    // Record only INTERMEDIATE wrappers — `el` itself is the caller's
    // anchor (section root in planColumns, column root in buildColumn)
    // whose class is already applied to the corresponding Elementor
    // node by the caller. Including it here would double-apply.
    if (cur !== el) {
      const c = classOf(cur);
      if (c) droppedClasses.push(c);
    }
    cur = onlyChild;
  }
  return { final: cur, droppedClasses };
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

/**
 * Resolve cascaded CSS styles for `el` against the parsed stylesheet.
 * Returns an empty record when no sheet is in scope (Phase 1 callers
 * who didn't opt into the translator) so existing behavior is preserved.
 */
function resolveStylesFor(el: Element, ctx: WalkContext): Record<string, string> {
  if (!ctx.sheet) return {};
  return computeStyles(el, ctx.sheet);
}

function linkSettingsFrom(href: string): { url: string; is_external: string; nofollow: string } {
  return { url: href, is_external: "", nofollow: "" };
}

function emitHeadingWidget(seed: string, el: Element, ctx: WalkContext): ElementorNode {
  const tag = el.tagName.toLowerCase();
  const settings: Record<string, unknown> = {
    title: (el.textContent ?? "").trim(),
    header_size: tag,
    align: "",
  };
  applyAdvancedFromEl(settings, el);
  applyHeadingStyles(settings, resolveStylesFor(el, ctx));
  return widget(seed, "heading", settings);
}

function emitTextEditorWidget(seed: string, el: Element, ctx: WalkContext): ElementorNode {
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
  applyTextEditorStyles(settings, resolveStylesFor(el, ctx));
  return widget(seed, "text-editor", settings);
}

function emitImageWidget(seed: string, el: Element, ctx: WalkContext, parentLink?: Element): ElementorNode {
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
  applyImageStyles(settings, resolveStylesFor(el, ctx));
  return widget(seed, "image", settings);
}

function emitButtonWidget(seed: string, el: Element, ctx: WalkContext): ElementorNode {
  const text = (el.textContent ?? "").trim();
  const href = el.getAttribute("href") ?? "";
  const usable = href && !href.startsWith("#") && !href.startsWith("javascript:") ? href : "";
  const settings: Record<string, unknown> = {
    text,
    link: linkSettingsFrom(usable),
    align: "",
  };
  applyAdvancedFromEl(settings, el);
  applyButtonStyles(settings, resolveStylesFor(el, ctx));
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
  /**
   * Optional parsed stylesheet. When present, each emit* function looks
   * up the cascaded CSS for the source element and translates relevant
   * properties (typography, color, spacing, border) into Elementor
   * widget settings so the sidebar shows real values instead of
   * Elementor defaults.
   */
  sheet?: ParsedSheet;
}

function nextSeed(ctx: WalkContext, kind: string): string {
  ctx.counter.n += 1;
  return `${ctx.seedPrefix}:${kind}:${ctx.counter.n}`;
}

/**
 * Add ancestor wrapper classes to a widget's `_css_classes` setting.
 * Elementor renders this string onto the widget's outer wrapper div, so
 * descendant selectors like `.cta-row .btn` keep matching even though
 * the original `.cta-row` div was dropped during decomposition.
 *
 * Without this propagation, after Phase 1 the page would look "messy"
 * because the user's site CSS targets the original ancestor chain that
 * no longer exists in the rendered DOM.
 */
function withAncestorClasses(node: ElementorNode, ancestorClasses: string[]): ElementorNode {
  if (ancestorClasses.length === 0) return node;
  const own = (node.settings._css_classes as string | undefined) ?? "";
  const merged = [...ancestorClasses, ...(own ? [own] : [])].join(" ").trim();
  if (merged) node.settings._css_classes = merged;
  return node;
}

/**
 * Walk a column's DOM subtree and emit native widgets in document order.
 * Anything not understood collapses into an `html` fallback widget so
 * layout/visual content is never lost.
 *
 * `ancestorClasses` carries the class strings of every wrapper we
 * recursed THROUGH on the way down to this subtree. Each emitted widget
 * gets those classes prepended to its `_css_classes` so the original
 * site CSS keeps targeting the right elements after Phase 1 drops the
 * intermediate wrapper DOM nodes.
 */
function walkColumnContents(
  root: Element,
  ctx: WalkContext,
  ancestorClasses: string[] = [],
): ElementorNode[] {
  const out: ElementorNode[] = [];
  const push = (n: ElementorNode): void => {
    out.push(withAncestorClasses(n, ancestorClasses));
  };
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
      const t = (node.textContent ?? "").trim();
      if (isMeaningfulText(t)) {
        flushHtml();
        const settings: Record<string, unknown> = { editor: `<p>${t}</p>` };
        push(widget(nextSeed(ctx, "text"), "text-editor", settings));
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

    if (isIconLeaf(el)) {
      flushHtml();
      push(emitIconWidget(nextSeed(ctx, "icon"), el));
      continue;
    }

    if (HEADING_TAGS.has(tag)) {
      flushHtml();
      push(emitHeadingWidget(nextSeed(ctx, "heading"), el, ctx));
      continue;
    }

    if (tag === "IMG") {
      flushHtml();
      push(emitImageWidget(nextSeed(ctx, "image"), el, ctx));
      continue;
    }

    if (tag === "BUTTON" || (tag === "A" && looksLikeButton(el))) {
      flushHtml();
      push(emitButtonWidget(nextSeed(ctx, "button"), el, ctx));
      continue;
    }

    if (tag === "A") {
      const onlyImg =
        el.children.length === 1 &&
        el.children[0].tagName === "IMG" &&
        !isMeaningfulText(el.textContent ?? "");
      if (onlyImg) {
        flushHtml();
        push(emitImageWidget(nextSeed(ctx, "image"), el.children[0], ctx, el));
        continue;
      }
      const onlyIcon =
        el.children.length === 1 &&
        isIconLeaf(el.children[0]) &&
        !isMeaningfulText(el.textContent ?? "");
      if (onlyIcon) {
        flushHtml();
        push(emitIconWidget(nextSeed(ctx, "icon"), el.children[0], el));
        continue;
      }
      const linkText = (el.textContent ?? "").trim();
      if (isMeaningfulText(linkText)) {
        flushHtml();
        push(emitButtonWidget(nextSeed(ctx, "button"), el, ctx));
        continue;
      }
      htmlBuffer.push(el.outerHTML);
      continue;
    }

    if (tag === "UL" || tag === "OL") {
      const lis = Array.from(el.children).filter((c) => c.tagName === "LI");
      const allPlain =
        lis.length > 0 &&
        lis.length === el.children.length &&
        lis.every((li) => Array.from(li.children).every((c) => c.tagName === "A"));
      if (allPlain) {
        flushHtml();
        push(emitIconListWidget(nextSeed(ctx, "list"), el));
        continue;
      }
      htmlBuffer.push(el.outerHTML);
      continue;
    }

    if (
      tag === "P" ||
      tag === "BLOCKQUOTE" ||
      tag === "FIGCAPTION" ||
      tag === "PRE"
    ) {
      const t = (el.textContent ?? "").trim();
      if (isMeaningfulText(t)) {
        flushHtml();
        push(emitTextEditorWidget(nextSeed(ctx, "text"), el, ctx));
      }
      continue;
    }

    // GENERIC CONTAINER — recurse, propagating this wrapper's class
    // (and any ancestor classes already in scope) down to its leaves.
    if (tag === "DIV" || tag === "ARTICLE" || tag === "SECTION" || tag === "HEADER" || tag === "FOOTER" || tag === "ASIDE" || tag === "MAIN" || tag === "PICTURE" || tag === "FIGURE") {
      const ownText = Array.from(el.childNodes).some(
        (c) => c.nodeType === 3 && isMeaningfulText(c.textContent ?? ""),
      );
      if (ownText) {
        flushHtml();
        push(emitTextEditorWidget(nextSeed(ctx, "text"), el, ctx));
        continue;
      }
      flushHtml();
      const wrapperCls = classOf(el);
      const nextAncestors = wrapperCls ? [...ancestorClasses, wrapperCls] : ancestorClasses;
      const inner = walkColumnContents(el, ctx, nextAncestors);
      // `inner` widgets already had `nextAncestors` baked in by their
      // own recursive call, so push them through verbatim — don't
      // double-prepend the same chain.
      for (const w of inner) out.push(w);
      continue;
    }

    htmlBuffer.push(el.outerHTML);
  }
  flushHtml();
  return out;
}

interface ColumnPlan {
  el: Element;
  size: number; // 1..100
}

interface ColumnPlanResult {
  plans: ColumnPlan[];
  /**
   * Classes from wrapper DOM nodes that planColumns walked PAST on the
   * way from the section root to the layout container (e.g. the
   * `.container .grid` chain in `<section><div class="container"><div
   * class="grid two-col"><div class="col">…`). The caller forwards
   * these into each column's `_css_classes` so original CSS like
   * `.container .grid h1 { ... }` keeps targeting the rendered DOM.
   */
  droppedAncestorClasses: string[];
}

function planColumns(root: Element): ColumnPlanResult {
  const { final: target, droppedClasses } = unwrapSingleChild(root);
  if (target !== root && isLayoutContainer(target)) {
    const kids = Array.from(target.children).filter((c) => !SKIP_TAGS.has(c.tagName));
    if (kids.length >= 2) {
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
      // The layout container's own class is part of the chain too —
      // it sits between the section root and the columns and is
      // dropped from the rendered DOM along with the wrappers.
      const layoutCls = classOf(target);
      const chain = layoutCls ? [...droppedClasses, layoutCls] : droppedClasses;
      return {
        plans: kids.map((el, i) => ({ el, size: explicit ? widths[i] : equal })),
        droppedAncestorClasses: chain,
      };
    }
  }
  if (isLayoutContainer(root)) {
    const kids = Array.from(root.children).filter((c) => !SKIP_TAGS.has(c.tagName));
    if (kids.length >= 2) {
      const equal = Math.round(100 / kids.length);
      return {
        plans: kids.map((el) => ({ el, size: equal })),
        droppedAncestorClasses: [],
      };
    }
  }
  return {
    plans: [{ el: root, size: 100 }],
    droppedAncestorClasses: droppedClasses,
  };
}

function buildColumn(
  plan: ColumnPlan,
  ctx: WalkContext,
  idx: number,
  ancestorClasses: string[],
): ElementorNode {
  const colCtx: WalkContext = {
    seedPrefix: `${ctx.seedPrefix}:col-${idx}`,
    counter: { n: 0 },
    sheet: ctx.sheet,
  };
  // The column's own DOM wrapper class (e.g. `col copy`) lives on the
  // Elementor column's `_css_classes` setting so selectors like
  // `.col.copy h1` keep matching. The dropped wrapper chain
  // (e.g. `container grid two-col`) is forwarded into the widgets
  // inside this column instead of the column itself, since Elementor
  // renders columns inside their parent section's wrapper — the
  // wrapper-chain classes only become visible to descendant CSS when
  // they sit on each leaf's own wrapper.
  const ownCls = classOf(plan.el);
  const colClasses = ownCls ? ownCls : "";
  const widgets = walkColumnContents(plan.el, colCtx, ancestorClasses);
  if (widgets.length === 0 && plan.el.innerHTML.trim().length > 0) {
    // Same fidelity rule applies to the empty-column fallback: keep
    // the ancestor wrapper chain on the html widget so original CSS
    // selectors keep matching the preserved markup.
    widgets.push(
      withAncestorClasses(
        emitHtmlFallbackWidget(`${colCtx.seedPrefix}:html-empty`, plan.el.innerHTML),
        ancestorClasses,
      ),
    );
  }
  const settings: Record<string, unknown> = {
    _column_size: plan.size,
    _inline_size: null,
  };
  if (colClasses) settings._css_classes = colClasses;
  const ownId = idOf(plan.el);
  if (ownId) settings._element_id = ownId;
  return {
    id: elementorId(`${colCtx.seedPrefix}:wrap`),
    elType: "column",
    isInner: false,
    settings,
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
  sheet?: ParsedSheet,
): ElementorNode | null {
  // Page slug enters the seed so two pages in the same project don't
  // collide on `${projectSlug}:sec-1:section` — Elementor requires
  // every node id within a single page's `_elementor_data` to be unique
  // and IDs are derived deterministically from this seed.
  const seedPrefix = `${projectSlug}:${pageSlug}:sec-${sectionIndex}`;
  const ctx: WalkContext = { seedPrefix, counter: { n: 0 }, sheet };

  const { plans, droppedAncestorClasses } = planColumns(rootEl);
  const columns = plans.map((p, i) => buildColumn(p, ctx, i, droppedAncestorClasses));
  // Filter columns whose only widget is an empty html fallback.
  const nonEmpty = columns.filter((c) => c.elements.length > 0);
  if (nonEmpty.length === 0) return null;

  const sectionSettings: Record<string, unknown> = {};
  applyAdvancedFromEl(sectionSettings, rootEl);
  // Translate the section root's cascaded CSS (background, padding,
  // margin, border) into Elementor section settings so the sidebar's
  // Style tab reflects the original look.
  if (sheet) applyContainerStyles(sectionSettings, computeStyles(rootEl, sheet));

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
