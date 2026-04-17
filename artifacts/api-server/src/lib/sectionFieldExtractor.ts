import { JSDOM } from "jsdom";
import crypto from "node:crypto";
import { decomposeSectionToNative } from "./nativeElementorDecomposer";
import { parseStylesheet } from "./cssStyleResolver";

export type FieldType = "text" | "url" | "attr" | "tag";

export interface ExtractedField {
  key: string;
  type: FieldType;
  default: string;
  label: string;
}

/**
 * A semantic UI grouping over the flat `fields[]` list. Each group represents
 * one meaningful element from the original HTML (a button, an `<a>` link, an
 * `<img>`, a heading, a plain text node) and carries the ordered list of
 * Elementor-style controls that should be rendered together for it. The
 * widget runtime walks `groups[]` to register `start_controls_section()`
 * blocks so the Elementor sidebar feels like editing a native widget rather
 * than a flat list of strings.
 *
 * Each control's `fieldKey` references one entry in the flat `fields[]` so
 * the existing `{{TEXT:k}}` / `{{URL:k}}` / `{{ATTR:k}}` / `{{TAG:k}}`
 * placeholder substitution pipeline keeps working unchanged — groups are an
 * organizational layer on top of the flat field model, not a replacement.
 */
export type GroupKind = "button" | "link" | "image" | "heading" | "text" | "list" | "icon";

export type ControlType = "text" | "textarea" | "url" | "media" | "choose" | "repeater" | "icons";

export interface ExtractedControl {
  /** Unique key inside the widget. Used both as the Elementor control id and
   *  (intentionally identical to) the flat field key for placeholder lookup. */
  key: string;
  /** Maps to the entry in the section's flat `fields[]` array. */
  fieldKey: string;
  type: ControlType;
  label: string;
  default: string;
  /** For `type === "choose"`. Ordered list of allowed values. */
  options?: string[];
}

/**
 * Native Elementor widget that the group's sidebar UI should mirror when
 * the project is in `legacy_native` conversion mode. The PHP widget reads
 * this field to decide which native control set (Heading, Button, Image,
 * Icon List, Text Editor) to clone — including the full Style tab with
 * Group_Control_Typography, Text Color, Text Shadow, Border, etc. scoped
 * to the leaf's stable `wpb-leaf-{id}` CSS class. The render path is
 * unchanged: the original markup template is still substituted server-
 * side, so visual fidelity matches the plain `legacy` mode byte-for-byte
 * (modulo the extra leaf class).
 */
export type NativeWidgetKind =
  | "heading"
  | "button"
  | "image"
  | "icon-list"
  | "text-editor"
  | "icon";

export interface ExtractedGroup {
  id: string;
  kind: GroupKind;
  label: string;
  controls: ExtractedControl[];
  /**
   * The native Elementor widget whose control set this group should
   * clone in `legacy_native` mode. Always populated so the JSON shape is
   * stable across modes; the PHP widget only consults it when the
   * project's mode says to.
   */
  nativeWidget: NativeWidgetKind;
  /**
   * Stable CSS class added to the original leaf element in the section
   * template. Used as the `selector` suffix (e.g.
   * `{{WRAPPER}} .wpb-leaf-g0`) for native style controls in
   * `legacy_native` mode so the user's typography / color / etc. edits
   * land on the original wrapper. The class is only injected into the
   * template when the project is in `legacy_native` mode — other modes
   * leave the markup byte-identical to the source HTML.
   */
  leafClass: string;
}

export interface ExtractedSection {
  id: string;
  blockName: string;
  label: string;
  category: string;
  template: string;
  /** Flat field list derived from `groups`. Drives `{{...}}` substitution
   *  inside the template + powers the legacy block.json attribute schema.
   *  Empty for sections that emit a native Elementor tree (no PHP widget
   *  is registered for those, so there's nothing to substitute). */
  fields: ExtractedField[];
  /** Semantic groups for the Elementor sidebar UI. Empty when this section
   *  is rendered via native Elementor widgets — see `nativeElementor`. */
  groups: ExtractedGroup[];
  /**
   * When set, this section is rendered as a real Elementor
   * `Section → Column → native widget` tree (heading / image / button /
   * etc.) instead of one big custom widget. The composer returns this
   * JSON verbatim and the theme generator skips registering a PHP
   * widget class for the section. Sections that fall back to the
   * legacy custom-widget path leave this undefined.
   */
  nativeElementor?: unknown;
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

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

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

function isRelativeAssetUrl(u: string): boolean {
  const trimmed = u.trim();
  if (!trimmed) return false;
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:|javascript:|data:)/i.test(trimmed)) return false;
  return true;
}

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
  const allWithBg: Element[] = [
    ...(root.hasAttribute("style") ? [root] : []),
    ...Array.from(root.querySelectorAll("[style]")),
  ];
  for (const [selector, attrs] of attrTargets) {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      for (const attr of attrs) {
        const v = el.getAttribute(attr);
        if (!v) continue;
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
  if (/^[\s\-•·–—|/\\©®™]+$/.test(trimmed)) return false;
  return true;
}

/**
 * First piece of meaningful text inside the element subtree, used as the
 * human-friendly label suffix on group names ("Button — Start Learning").
 * Returns the empty string when no text node qualifies.
 */
function firstText(el: Element): string {
  const walker = el.ownerDocument!.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node) {
    const t = (node.textContent ?? "").trim();
    if (isMeaningfulText(t)) return t.length > 32 ? t.slice(0, 32).trimEnd() + "…" : t;
    node = walker.nextNode();
  }
  return "";
}

/**
 * True when `el` is a leaf icon-font element — `<i class="fa fa-x">` or
 * `<span class="icon-...">` with no children and no meaningful text. These
 * become the standalone `icon` group kind, edited from Elementor with the
 * native ICONS control. Detection is shared between the walker (so icons
 * inside <a>/<button> are also collected) and the per-target builder.
 */
function isIconLeaf(el: Element): boolean {
  const tag = el.tagName;
  if (tag !== "I" && tag !== "SPAN") return false;
  if (el.children.length !== 0) return false;
  if (isMeaningfulText(el.textContent ?? "")) return false;
  const cls = el.className?.toString() ?? "";
  return /\b(fa|fas|far|fab|fal|icon|bi|material-icons|ti|dashicons)[-\s]/i.test(cls);
}

function looksLikeButton(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "BUTTON") return true;
  if (tag !== "A") return false;
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  if (role === "button") return true;
  const cls = (el.className?.toString() ?? "").toLowerCase();
  return /\b(btn|button|cta|action)\b/.test(cls);
}

/**
 * Collect every <img>, <a>, <button>, heading, and free-floating text node
 * inside the section in document order. The walker stops descending into
 * elements that themselves form a group (e.g. inside an <a> we do not also
 * extract the inner <span>'s text as a separate group — it becomes the
 * link's text control). This mirrors how Elementor's native widgets are
 * scoped: one widget per logical UI element, not one per scalar.
 */
function collectGroupTargets(section: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "A") {
      out.push(el);
      // Linked-image case: <a href><img></a>. The link itself is captured
      // above (its href becomes the URL control), but the inner <img>
      // also deserves its own MEDIA + Alt Text controls — otherwise a
      // common pattern (logo / hero image wrapped in a link) would lose
      // image editing entirely. Same idea for icon-only buttons / social
      // links (`<a><i class="fab fa-twitter"></i></a>`): descend just
      // enough to surface the inner icon as its own ICONS control so
      // customers can swap glyphs on icon CTAs. We still don't descend
      // further so nested <span>s don't get double-emitted as text.
      for (const child of Array.from(el.children)) {
        if (child.tagName === "IMG" || isIconLeaf(child)) out.push(child);
      }
      return;
    }
    if (tag === "IMG") {
      out.push(el);
      return;
    }
    // Standalone icon group: a leaf <i class="fa-..."> or
    // <span class="icon-..."> that carries no text. Edited from
    // Elementor with the native ICONS control so customers can pick a
    // new glyph (or upload an SVG) from the sidebar.
    if (isIconLeaf(el)) {
      out.push(el);
      return;
    }
    if (tag === "UL" || tag === "OL") {
      // List groups expose the items as a single TEXTAREA control with one
      // line per <li>. We only treat the list as a group when its children
      // are exclusively plain-text <li>s — nested links/headings inside the
      // list still get their own widget controls via the normal walk.
      const lis = Array.from(el.children).filter((c) => c.tagName === "LI");
      const allPlain =
        lis.length > 0 &&
        lis.length === el.children.length &&
        lis.every((li) => Array.from(li.children).length === 0);
      if (allPlain) {
        out.push(el);
        return;
      }
    }
    if (HEADING_TAGS.has(tag)) {
      out.push(el);
      return;
    }
    // Plain text-bearing element with at least one direct text child.
    if (TEXT_PARENTS.has(tag)) {
      const hasOwnText = Array.from(el.childNodes).some(
        (c) => c.nodeType === 3 && isMeaningfulText(c.textContent ?? ""),
      );
      const hasInteractiveChild = Array.from(el.children).some((c) =>
        c.tagName === "A" || c.tagName === "BUTTON" || c.tagName === "IMG" || HEADING_TAGS.has(c.tagName),
      );
      if (hasOwnText && !hasInteractiveChild) {
        out.push(el);
        return;
      }
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(section);
  return out;
}

/**
 * For text-bearing leaf elements, extract every direct text-node child as
 * a single concatenated string. Returns the trimmed text and rewrites the
 * element's content to use a single `{{TEXT:key}}` placeholder per slot.
 */
function takeText(el: Element, key: string): string {
  // Walk descendant text nodes in document order, not just direct children.
  // Real-world button/link markup wraps the label in spans/icons, e.g.
  //   <a><span>Sign up</span></a>  or  <button><i class="ico"/>Buy</button>
  // Restricting to direct text-node children would silently drop the label
  // and Elementor would lose its text control for that CTA.
  const parts: string[] = [];
  const textNodes: ChildNode[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const raw = child.textContent ?? "";
        if (isMeaningfulText(raw)) {
          textNodes.push(child as ChildNode);
          parts.push(raw.trim());
        }
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(el);
  for (let i = 0; i < textNodes.length; i++) {
    const node = textNodes[i];
    const raw = node.textContent ?? "";
    if (i === 0) {
      node.textContent = raw.replace(raw.trim(), `{{TEXT:${key}}}`);
    } else {
      node.textContent = raw.replace(raw.trim(), "");
    }
  }
  return parts.join(" ").trim();
}

interface BuildResult {
  template: string;
  fields: ExtractedField[];
  groups: ExtractedGroup[];
}

function buildSectionTemplate(section: Element, opts: { injectLeafClass: boolean } = { injectLeafClass: false }): BuildResult {
  rebaseAssetUrls(section);

  const fields: ExtractedField[] = [];
  const groups: ExtractedGroup[] = [];
  const used = new Set<string>();

  let groupIdx = 0;
  const nextGroupId = (): string => {
    let id = `g${groupIdx++}`;
    while (used.has(id)) id = `g${groupIdx++}`;
    used.add(id);
    return id;
  };

  const addField = (key: string, type: FieldType, def: string, label: string): void => {
    fields.push({ key, type, default: def, label });
  };

  // Tag the original leaf element with a stable `wpb-leaf-{gid}` class
  // so native style controls in `legacy_native` mode have a CSS selector
  // hook scoped to that leaf. In other modes the template stays byte-
  // identical to the source HTML — we record `leafClass` on the group
  // for shape stability but skip the DOM mutation.
  const tagLeaf = (el: Element, gid: string): string => {
    const cls = `wpb-leaf-${gid}`;
    if (opts.injectLeafClass) {
      const existing = el.getAttribute("class") ?? "";
      const next = existing ? `${existing} ${cls}` : cls;
      el.setAttribute("class", next);
    }
    return cls;
  };

  const targets = collectGroupTargets(section);

  for (const el of targets) {
    const tag = el.tagName;

    // ---- IMAGE ----
    if (tag === "IMG") {
      const gid = nextGroupId();
      const leafClass = tagLeaf(el, gid);
      const srcKey = `${gid}_image`;
      const altKey = `${gid}_alt`;
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      addField(srcKey, "url", src, "image");
      el.setAttribute("src", `{{URL:${srcKey}}}`);
      // Mark the image so the PHP renderer can swap it for
      // wp_get_attachment_image() (which emits proper srcset/sizes)
      // whenever the saved Elementor MEDIA control carries an
      // attachment id. The marker is stripped by the same pass.
      el.setAttribute("data-wpb-media", srcKey);
      const controls: ExtractedControl[] = [
        { key: srcKey, fieldKey: srcKey, type: "media", label: "Image", default: src },
      ];
      if (isMeaningfulText(alt)) {
        addField(altKey, "attr", alt, "alt text");
        el.setAttribute("alt", `{{ATTR:${altKey}}}`);
        controls.push({ key: altKey, fieldKey: altKey, type: "text", label: "Alt Text", default: alt });
      }
      const labelText = isMeaningfulText(alt) ? alt : "Image";
      groups.push({
        id: gid,
        kind: "image",
        label: `Image — ${labelText.length > 32 ? labelText.slice(0, 32) + "…" : labelText}`,
        controls,
        nativeWidget: "image",
        leafClass,
      });
      continue;
    }

    // ---- HEADING ----
    if (HEADING_TAGS.has(tag)) {
      const gid = nextGroupId();
      const leafClass = tagLeaf(el, gid);
      const textKey = `${gid}_text`;
      const tagKey = `${gid}_tag`;
      const text = takeText(el, textKey);
      if (!text) continue;
      addField(textKey, "text", text, "heading text");
      // Tag-swap support: mark the original heading with a data attribute
      // the PHP renderer recognises and rewrites to the saved tag value.
      el.setAttribute("data-wpb-tag", tagKey);
      addField(tagKey, "tag", tag.toLowerCase(), "heading tag");
      const isLong = text.length > 80;
      groups.push({
        id: gid,
        kind: "heading",
        label: `Heading — ${text.length > 32 ? text.slice(0, 32) + "…" : text}`,
        controls: [
          { key: textKey, fieldKey: textKey, type: isLong ? "textarea" : "text", label: "Text", default: text },
          {
            key: tagKey,
            fieldKey: tagKey,
            type: "choose",
            label: "HTML Tag",
            default: tag.toLowerCase(),
            options: ["h1", "h2", "h3", "h4", "h5", "h6"],
          },
        ],
        nativeWidget: "heading",
        leafClass,
      });
      continue;
    }

    // ---- LIST ----
    if (tag === "UL" || tag === "OL") {
      const gid = nextGroupId();
      const leafClass = tagLeaf(el, gid);
      const itemsKey = `${gid}_items`;
      const items = Array.from(el.children)
        .filter((c) => c.tagName === "LI")
        .map((li) => (li.textContent ?? "").trim())
        .filter((t) => t.length > 0);
      if (items.length === 0) continue;
      const joined = items.join("\n");
      addField(itemsKey, "text", joined, "list items");
      // Replace the list's children with a single {{LIST:k}} placeholder
      // that the PHP renderer expands back to one <li> per repeater row.
      while (el.firstChild) el.removeChild(el.firstChild);
      el.textContent = `{{LIST:${itemsKey}}}`;
      groups.push({
        id: gid,
        kind: "list",
        label: `List — ${items.length} item${items.length === 1 ? "" : "s"}`,
        controls: [
          {
            key: itemsKey,
            fieldKey: itemsKey,
            // REPEATER control: each row is a single TEXT field named
            // "item". The widget runtime collapses the repeater rows
            // back into newline-joined text so the {{LIST:k}} renderer
            // can keep its existing one-line-per-<li> contract.
            type: "repeater",
            label: "Items",
            default: joined,
          },
        ],
        nativeWidget: "icon-list",
        leafClass,
      });
      continue;
    }

    // ---- ICON ----
    if (isIconLeaf(el)) {
      const gid = nextGroupId();
      const leafClass = tagLeaf(el, gid);
      const classKey = `${gid}_icon_class`;
      const altKey = `${gid}_icon_alt`;
      const linkKey = `${gid}_icon_link`;
      const cls = el.className?.toString() ?? "";
      addField(classKey, "attr", cls, "icon class");
      // Editable alt text + optional link target for the case where the
      // editor swaps the font icon for an SVG upload. Defaults are blank
      // so an unmodified import still round-trips byte-identically — the
      // swap pass falls back to the icon class string for alt and skips
      // the <a> wrap when the link is empty.
      addField(altKey, "text", "", "alt text");
      addField(linkKey, "url", "", "link URL");
      el.setAttribute("class", `{{ATTR:${classKey}}}`);
      // Marker so the PHP renderer can swap the element for an <img>
      // when the user picks an SVG via the ICONS / MEDIA control. The
      // marker is always stripped on its way out. Alt + link keys are
      // derived from this marker's value by convention (replacing the
      // _icon_class suffix with _icon_alt / _icon_link) so the swap pass
      // does not need to thread them through the marker itself.
      el.setAttribute("data-wpb-icon", classKey);
      const labelText = cls.length > 32 ? cls.slice(0, 32) + "…" : cls;
      groups.push({
        id: gid,
        kind: "icon",
        label: `Icon — ${labelText || "icon"}`,
        controls: [
          // Native Elementor ICONS control — supports both font-icon
          // libraries (Font Awesome, etc.) and SVG uploads via the
          // attached MEDIA library. The default is the original class
          // so an unmodified import round-trips byte-identically.
          { key: classKey, fieldKey: classKey, type: "icons", label: "Icon", default: cls },
          { key: altKey, fieldKey: altKey, type: "text", label: "Alt Text", default: "" },
          { key: linkKey, fieldKey: linkKey, type: "url", label: "Icon Link", default: "" },
        ],
        nativeWidget: "icon",
        leafClass,
      });
      continue;
    }

    // ---- BUTTON / LINK ----
    if (tag === "BUTTON" || tag === "A") {
      const gid = nextGroupId();
      const leafClass = tagLeaf(el, gid);
      const textKey = `${gid}_text`;
      const text = takeText(el, textKey);
      if (text) addField(textKey, "text", text, "button text");
      const controls: ExtractedControl[] = [];
      if (text) {
        const isLong = text.length > 80;
        controls.push({
          key: textKey,
          fieldKey: textKey,
          type: isLong ? "textarea" : "text",
          label: "Text",
          default: text,
        });
      }
      const rawHref = el.getAttribute("href");
      const usableHref =
        rawHref && !rawHref.startsWith("#") && !rawHref.startsWith("javascript:")
          ? rawHref
          : "";
      const isButtonEl = tag === "BUTTON" || looksLikeButton(el);
      // Buttons MUST always expose a Link control (Text + Link is the
      // semantic contract for the "button" group), even when the source
      // markup didn't carry an href. Anchors only get one when the URL
      // is real. The PHP renderer wraps button output with an <a> tag
      // when the user supplies a non-empty URL via the sidebar.
      if (usableHref || isButtonEl) {
        const linkKey = `${gid}_link`;
        addField(linkKey, "url", usableHref, "link URL");
        controls.push({ key: linkKey, fieldKey: linkKey, type: "url", label: "Link", default: usableHref });
        if (tag === "A") {
          el.setAttribute("href", `{{URL:${linkKey}}}`);
          // Mark the anchor so the PHP renderer can also inject the URL
          // control's rel / target metadata (nofollow + open-in-new-tab)
          // back onto the element when the user toggles those flags in
          // the Elementor sidebar. The marker is stripped by the same
          // pass that rewrites the attributes.
          el.setAttribute("data-wpb-link", linkKey);
        } else {
          // Native <button>: it can't carry an href itself, so mark it
          // and let the PHP renderer wrap it in an <a> when the saved
          // URL is non-empty.
          el.setAttribute("data-wpb-button-link", linkKey);
        }
      }
      if (controls.length === 0) continue;
      const labelText = text || usableHref || "Link";
      const kind: GroupKind = looksLikeButton(el) ? "button" : "link";
      const labelPrefix = kind === "button" ? "Button" : "Link";
      groups.push({
        id: gid,
        kind,
        label: `${labelPrefix} — ${labelText.length > 32 ? labelText.slice(0, 32) + "…" : labelText}`,
        controls,
        // Both buttons and plain links mirror the native Button widget's
        // sidebar (Text + Link + Style group). Native Elementor doesn't
        // ship a "link" widget — the closest match is Button.
        nativeWidget: "button",
        leafClass,
      });
      continue;
    }

    // ---- PLAIN TEXT ----
    if (TEXT_PARENTS.has(tag)) {
      const gid = nextGroupId();
      const leafClass = tagLeaf(el, gid);
      const textKey = `${gid}_text`;
      const text = takeText(el, textKey);
      if (!text) continue;
      addField(textKey, "text", text, "text");
      const isLong = text.length > 80;
      groups.push({
        id: gid,
        kind: "text",
        label: `${tag.toLowerCase()} — ${text.length > 32 ? text.slice(0, 32) + "…" : text}`,
        controls: [
          {
            key: textKey,
            fieldKey: textKey,
            type: isLong ? "textarea" : "text",
            label: "Text",
            default: text,
          },
        ],
        // Plain text leaves clone the native Text Editor widget's
        // sidebar in `legacy_native` mode. Text Editor's Style tab ships
        // Typography, Text Color, Columns — exactly the controls a
        // paragraph or label expects.
        nativeWidget: "text-editor",
        leafClass,
      });
    }
  }

  return { template: section.outerHTML, fields, groups };
}

export function extractSectionsFromPage(
  html: string,
  pageSlug: string,
  projectSlug: string,
  sourceCss?: string,
  /**
   * Override the decomposer mode for this call. When omitted, the
   * `NATIVE_ELEMENTOR_MODE` env var is consulted (defaulting to
   * `"shell"`). Tests use this to opt into per-widget translation.
   */
  decomposerModeOverride?: "shell" | "deep" | "legacy" | "legacy_native",
): ExtractedSection[] {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  if (!body) return [];

  // Parse the original site CSS once per page. The decomposer uses it
  // to compute cascaded styles per element and translate them into
  // Elementor widget settings (typography/color/spacing/border) so the
  // sidebar shows real values, not Elementor defaults. Inline <style>
  // tags from the page itself are concatenated with any external CSS
  // the caller passed in (the project's combined stylesheet).
  const inlineStyles = Array.from(dom.window.document.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  const combinedCss = `${sourceCss ?? ""}\n${inlineStyles}`;
  const sheet = parseStylesheet(combinedCss);

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
    const hash = shortHash(el.outerHTML);
    const id = `${pageSlug}-${idx}-${category}-${hash}`;
    const blockName = `wpb-${projectSlug}/sec-${idx}-${category}-${hash}`
      .toLowerCase()
      .replace(/[^a-z0-9/-]/g, "-");

    // Native-widget decomposition runs first against a CLEAN clone of
    // the section element (the legacy custom-widget pipeline mutates
    // its argument, replacing text content with `{{...}}` placeholders).
    // When decomposition succeeds we ship the native Elementor tree and
    // skip the custom widget entirely — fields/groups/template stay
    // empty and the theme generator omits the PHP widget class.
    // Native decomposition has two modes (see DecomposerMode in
    // nativeElementorDecomposer.ts):
    //   - "shell" (default): native Section + Column shells with the
    //     original markup preserved verbatim inside one html widget per
    //     column. 100% visual fidelity, sidebar-clickable structure.
    //   - "deep" (opt-in): every leaf becomes a native widget; great
    //     for clean modern pages, risky for sites with custom CSS and
    //     interactive components (canvas, forms, SVG widgets).
    // Either mode can be skipped entirely by setting
    // NATIVE_ELEMENTOR_DECOMPOSER=0 (falls back to the legacy
    // custom-widget PHP path).
    const nativeFlag = process.env.NATIVE_ELEMENTOR_DECOMPOSER ?? "1";
    const envNativeEnabled = nativeFlag !== "0" && nativeFlag !== "false";
    // The override wins over the env var: a per-project setting of
    // "legacy" disables native decomposition for that project even when
    // the env says it's enabled, and any non-"legacy" override forces
    // native decomposition on.
    // `legacy` and `legacy_native` both opt out of native decomposition
    // — they share the same render path (one custom PHP widget per
    // section that re-renders the original markup with placeholder
    // substitution). `legacy_native` only differs in how the widget's
    // sidebar UI is registered (mirrors the matching native Elementor
    // widget's controls), which is handled downstream by the theme
    // generator.
    const nativeEnabled =
      decomposerModeOverride === "legacy" || decomposerModeOverride === "legacy_native"
        ? false
        : decomposerModeOverride
          ? true
          : envNativeEnabled;
    const mode: "shell" | "deep" =
      decomposerModeOverride === "shell" || decomposerModeOverride === "deep"
        ? decomposerModeOverride
        : (process.env.NATIVE_ELEMENTOR_MODE === "deep" ? "deep" : "shell");
    const cleanClone = el.cloneNode(true) as Element;
    let nativeElementor: unknown | undefined;
    if (nativeEnabled) {
      try {
        const decomposed = decomposeSectionToNative(cleanClone, projectSlug, idx, pageSlug, sheet, mode);
        if (decomposed) nativeElementor = decomposed;
      } catch {
        // Decomposition is best-effort — never block the import.
        nativeElementor = undefined;
      }
    }

    if (nativeElementor) {
      sections.push({
        id,
        blockName,
        label: `${label} (${category})`,
        category,
        template: "",
        fields: [],
        groups: [],
        nativeElementor,
      });
    } else {
      // Only inject the `wpb-leaf-{gid}` CSS hooks into the rendered
      // template when the project is in `legacy_native` mode — those
      // classes are the selectors native style controls bind to. Other
      // legacy projects keep their templates byte-identical to the
      // original markup.
      const { template, fields, groups } = buildSectionTemplate(el, {
        injectLeafClass: decomposerModeOverride === "legacy_native",
      });
      sections.push({ id, blockName, label: `${label} (${category})`, category, template, fields, groups });
    }
  }
  return sections;
}
