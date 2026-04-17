/**
 * CSS-to-Elementor controls translator: parses the original site CSS,
 * computes cascaded styles for any DOM element, and exposes helpers
 * that map those styles into Elementor widget settings (typography,
 * color, spacing, border) so the sidebar shows real values instead of
 * Elementor defaults.
 *
 * Design choices:
 * - We use `css-tree` for tolerant parsing; malformed rules are
 *   silently skipped so a single bad rule doesn't break a whole site.
 * - Specificity follows the standard W3C calc (id=100, class/attr/
 *   pseudo-class=10, element/pseudo-element=1). `!important` adds a
 *   large bonus so important declarations win.
 * - Inline `style` attributes are merged in last with the highest
 *   specificity, mirroring browser behavior.
 * - We deliberately ignore @media / @supports for MVP — those rules
 *   need responsive handling that Elementor exposes via separate
 *   tablet/mobile keys; covered later.
 */
import * as csstree from "css-tree";

export interface CssRule {
  selector: string;
  declarations: Record<string, { value: string; important: boolean }>;
  specificity: number; // pre-computed for the worst-case selector in the list
}

export interface ParsedSheet {
  rules: CssRule[];
}

const EMPTY_SHEET: ParsedSheet = { rules: [] };

/**
 * Parse a raw CSS string into a flat rule list. Never throws.
 * Uses css-tree's `onParseError` callback so that one malformed rule
 * doesn't discard the rest of the sheet — recoverable errors are
 * silently swallowed and parsing continues.
 */
export function parseStylesheet(css: string | undefined | null): ParsedSheet {
  if (!css || css.trim().length === 0) return EMPTY_SHEET;
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(css, {
      parseAtrulePrelude: false,
      parseValue: false,
      onParseError: () => {
        /* swallow recoverable parse errors so valid neighbouring rules survive */
      },
    });
  } catch {
    return EMPTY_SHEET;
  }
  const rules: CssRule[] = [];
  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      // Skip rules nested inside @media / @supports / @keyframes for MVP.
      // (csstree.walk visits @-rule contents too; we filter via parent.)
      const inAtRule = (this as { atrule?: csstree.CssNode | null }).atrule;
      if (inAtRule) return;
      const r = node as csstree.Rule;
      const selectorListNode = r.prelude;
      if (selectorListNode.type !== "SelectorList") return;
      const declarations = extractDeclarations(r.block);
      if (Object.keys(declarations).length === 0) return;
      const selectors = (selectorListNode as csstree.SelectorList).children
        .toArray()
        .map((s) => csstree.generate(s));
      for (const selector of selectors) {
        rules.push({
          selector,
          declarations,
          specificity: computeSpecificity(selector),
        });
      }
    },
  });
  return { rules };
}

function extractDeclarations(block: csstree.Block): CssRule["declarations"] {
  const out: CssRule["declarations"] = {};
  block.children.forEach((node) => {
    if (node.type !== "Declaration") return;
    const decl = node as csstree.Declaration;
    const value = csstree.generate(decl.value).trim();
    if (!value) return;
    out[decl.property.toLowerCase()] = {
      value,
      important: decl.important === true,
    };
  });
  return out;
}

/**
 * Approximate W3C specificity calculator. Returns a single integer
 * weight (id*10000 + class*100 + element*1) that's good enough to rank
 * rules. Pseudo-elements count as elements, pseudo-classes as classes.
 */
export function computeSpecificity(selector: string): number {
  // Strip pseudo-element bodies like ::before(...) and bracket contents.
  const s = selector.replace(/\s+/g, " ").trim();
  const ids = (s.match(/#[A-Za-z_][\w-]*/g) ?? []).length;
  // class, attribute, pseudo-class
  const classLike =
    (s.match(/\.[A-Za-z_][\w-]*/g) ?? []).length +
    (s.match(/\[[^\]]+\]/g) ?? []).length +
    (s.match(/(?<!:):[A-Za-z][\w-]*(?:\([^)]*\))?/g) ?? []).length;
  // element / pseudo-element  (split on combinators, count word starts)
  const stripped = s
    .replace(/#[A-Za-z_][\w-]*/g, "")
    .replace(/\.[A-Za-z_][\w-]*/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/::?[A-Za-z][\w-]*(\([^)]*\))?/g, " ");
  const elements = (stripped.match(/\b[a-z][a-z0-9-]*/gi) ?? []).length;
  return ids * 10000 + classLike * 100 + elements;
}

/**
 * CSS properties that inherit from their parent when no value is set
 * on the element itself. Limited to the typography/colour subset that
 * Elementor exposes — we don't need full CSS inheritance coverage.
 */
const INHERITED_PROPERTIES = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-indent",
  "word-spacing",
  "visibility",
  "direction",
]);

// Weight tiers — higher beats lower. Picked far apart so specificity
// (max ~10^6 for sane selectors) cannot leak across a tier boundary.
const TIER_NORMAL_AUTHOR = 0;
const TIER_NORMAL_INLINE = 10_000_000; // inline acts like a (1,0,0,0) selector
const TIER_IMPORTANT_AUTHOR = 100_000_000; // !important author beats inline normal
const TIER_IMPORTANT_INLINE = 1_000_000_000; // !important inline wins overall

/**
 * Returns the cascaded declarations that apply to `el`. Cascade order
 * (low → high): normal author < normal inline < !important author <
 * !important inline. Inheritable properties unset on the element are
 * looked up on ancestors. Property names are lowercase.
 */
export function computeStyles(
  el: Element,
  sheet: ParsedSheet,
): Record<string, string> {
  const own = computeOwnStyles(el, sheet);
  // Walk ancestors and fill in inheritable properties that the element
  // itself didn't set.
  let parent: Element | null = el.parentElement;
  while (parent) {
    const parentStyles = computeOwnStyles(parent, sheet);
    for (const prop of INHERITED_PROPERTIES) {
      if (own[prop] === undefined && parentStyles[prop] !== undefined) {
        own[prop] = parentStyles[prop];
      }
    }
    parent = parent.parentElement;
  }
  return own;
}

/** Cascade declarations declared *on* the element only — no inheritance walk. */
function computeOwnStyles(el: Element, sheet: ParsedSheet): Record<string, string> {
  type Pick = { value: string; weight: number; order: number };
  const winners = new Map<string, Pick>();
  let order = 0;
  for (const rule of sheet.rules) {
    let matched = false;
    try {
      matched = (el as Element & { matches: (s: string) => boolean }).matches(rule.selector);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    for (const [prop, decl] of Object.entries(rule.declarations)) {
      const weight = (decl.important ? TIER_IMPORTANT_AUTHOR : TIER_NORMAL_AUTHOR) + rule.specificity;
      const cur = winners.get(prop);
      if (!cur || weight > cur.weight || (weight === cur.weight && order >= cur.order)) {
        winners.set(prop, { value: decl.value, weight, order });
      }
    }
    order++;
  }
  const inline = el.getAttribute("style");
  if (inline) {
    for (const [prop, decl] of Object.entries(parseInlineStyle(inline))) {
      const weight = decl.important ? TIER_IMPORTANT_INLINE : TIER_NORMAL_INLINE;
      const cur = winners.get(prop);
      // Inline normal must not displace stylesheet !important (lower
      // tier), but inline !important wins outright. Strict `>` because
      // inline appears "after" all stylesheet rules in source order.
      if (!cur || weight > cur.weight) {
        winners.set(prop, { value: decl.value, weight, order: ++order });
      }
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of winners) out[k] = v.value;
  return out;
}

/**
 * Parse an inline `style` attribute, preserving per-declaration
 * `!important` flags so the cascade can rank them correctly.
 */
function parseInlineStyle(style: string): Record<string, { value: string; important: boolean }> {
  const out: Record<string, { value: string; important: boolean }> = {};
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    let v = part.slice(i + 1).trim();
    if (!k || !v) continue;
    let important = false;
    const impMatch = v.match(/!\s*important\s*$/i);
    if (impMatch) {
      important = true;
      v = v.slice(0, impMatch.index).trim();
    }
    if (v) out[k] = { value: v, important };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Elementor control shape helpers                                    */
/* ------------------------------------------------------------------ */

const LEN_RE = /^(-?\d*\.?\d+)\s*(px|em|rem|%|vh|vw|pt)?$/i;

export function parseLength(v: string | undefined): { size: number; unit: string } | null {
  if (!v) return null;
  const m = v.trim().match(LEN_RE);
  if (!m) return null;
  return { size: parseFloat(m[1]), unit: (m[2] ?? "px").toLowerCase() };
}

/** Elementor's typography group expects `_typography: "custom"` to unlock per-widget overrides. */
export interface ElementorTypography {
  typography_typography?: "custom";
  typography_font_family?: string;
  typography_font_size?: { unit: string; size: number; sizes: [] };
  typography_font_weight?: string;
  typography_font_style?: string;
  typography_text_transform?: string;
  typography_line_height?: { unit: string; size: number; sizes: [] };
  typography_letter_spacing?: { unit: string; size: number; sizes: [] };
}

export function buildTypography(styles: Record<string, string>, prefix = "typography"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let custom = false;
  const ff = styles["font-family"];
  if (ff) {
    out[`${prefix}_font_family`] = ff.replace(/['"]/g, "").split(",")[0].trim();
    custom = true;
  }
  const fs = parseLength(styles["font-size"]);
  if (fs) {
    out[`${prefix}_font_size`] = { unit: fs.unit, size: fs.size, sizes: [] };
    custom = true;
  }
  const fw = styles["font-weight"];
  if (fw) {
    out[`${prefix}_font_weight`] = fw.trim();
    custom = true;
  }
  const fst = styles["font-style"];
  if (fst) {
    out[`${prefix}_font_style`] = fst.trim();
    custom = true;
  }
  const tt = styles["text-transform"];
  if (tt) {
    out[`${prefix}_text_transform`] = tt.trim();
    custom = true;
  }
  // Line-height is special: a bare number like `1.2` is a multiplier
  // (em-equivalent), not pixels. parseLength would otherwise default
  // unitless values to "px"; we check for the unitless case first.
  const lhRaw = styles["line-height"]?.trim();
  if (lhRaw && /^-?\d*\.?\d+$/.test(lhRaw)) {
    out[`${prefix}_line_height`] = { unit: "em", size: parseFloat(lhRaw), sizes: [] };
    custom = true;
  } else {
    const lh = parseLength(lhRaw);
    if (lh) {
      out[`${prefix}_line_height`] = { unit: lh.unit, size: lh.size, sizes: [] };
      custom = true;
    }
  }
  const ls = parseLength(styles["letter-spacing"]);
  if (ls) {
    out[`${prefix}_letter_spacing`] = { unit: ls.unit, size: ls.size, sizes: [] };
    custom = true;
  }
  if (custom) out[`${prefix}_typography`] = "custom";
  return out;
}

/**
 * Parse a CSS shorthand like "10px 20px" or "10px 20px 30px 40px" into
 * the Elementor dimension shape `{unit, top, right, bottom, left, isLinked}`.
 * Returns null if no usable values were found.
 */
export function parseDimensions(value: string | undefined):
  | { unit: string; top: string; right: string; bottom: string; left: string; isLinked: boolean }
  | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4) return null;
  const lens = parts.map(parseLength);
  if (lens.some((l) => !l)) return null;
  const unit = lens[0]!.unit;
  // CSS shorthand expansion
  let top: number, right: number, bottom: number, left: number;
  const sizes = lens.map((l) => l!.size);
  if (sizes.length === 1) {
    top = right = bottom = left = sizes[0];
  } else if (sizes.length === 2) {
    top = bottom = sizes[0];
    right = left = sizes[1];
  } else if (sizes.length === 3) {
    top = sizes[0];
    right = left = sizes[1];
    bottom = sizes[2];
  } else {
    [top, right, bottom, left] = sizes;
  }
  return {
    unit,
    top: String(top),
    right: String(right),
    bottom: String(bottom),
    left: String(left),
    isLinked: top === right && right === bottom && bottom === left,
  };
}

export function buildSpacing(styles: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Prefer longhand if present, otherwise shorthand.
  const pad = parseDimensions(styles["padding"]) ?? assembleLonghand(styles, "padding");
  if (pad) out._padding = pad;
  const mar = parseDimensions(styles["margin"]) ?? assembleLonghand(styles, "margin");
  if (mar) out._margin = mar;
  return out;
}

function assembleLonghand(
  styles: Record<string, string>,
  prop: "padding" | "margin",
): ReturnType<typeof parseDimensions> | null {
  const sides = ["top", "right", "bottom", "left"] as const;
  const lens = sides.map((s) => parseLength(styles[`${prop}-${s}`]));
  if (lens.every((l) => !l)) return null;
  const unit = lens.find((l) => l)?.unit ?? "px";
  const t = lens[0]?.size ?? 0;
  const r = lens[1]?.size ?? 0;
  const b = lens[2]?.size ?? 0;
  const l = lens[3]?.size ?? 0;
  return {
    unit,
    top: String(t),
    right: String(r),
    bottom: String(b),
    left: String(l),
    isLinked: t === r && r === b && b === l,
  };
}

export function buildBorder(styles: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bw = parseDimensions(styles["border-width"]);
  if (bw) {
    out._border_width = bw;
    out._border_border = styles["border-style"] ?? "solid";
  }
  if (styles["border-color"]) out._border_color = styles["border-color"].trim();
  const br = parseDimensions(styles["border-radius"]);
  if (br) out._border_radius = br;
  return out;
}

/* ------------------------------------------------------------------ */
/*  Per-widget translators                                             */
/* ------------------------------------------------------------------ */

export function applyHeadingStyles(settings: Record<string, unknown>, styles: Record<string, string>): void {
  if (styles["color"]) settings.title_color = styles["color"].trim();
  if (styles["text-align"]) settings.align = styles["text-align"].trim();
  Object.assign(settings, buildTypography(styles, "typography"));
  Object.assign(settings, buildSpacing(styles));
}

export function applyTextEditorStyles(settings: Record<string, unknown>, styles: Record<string, string>): void {
  if (styles["color"]) settings.text_color = styles["color"].trim();
  if (styles["text-align"]) settings.align = styles["text-align"].trim();
  Object.assign(settings, buildTypography(styles, "typography"));
  Object.assign(settings, buildSpacing(styles));
}

export function applyButtonStyles(settings: Record<string, unknown>, styles: Record<string, string>): void {
  if (styles["color"]) settings.button_text_color = styles["color"].trim();
  if (styles["background-color"]) {
    settings.background_color = styles["background-color"].trim();
  }
  Object.assign(settings, buildTypography(styles, "typography"));
  Object.assign(settings, buildSpacing(styles));
  Object.assign(settings, buildBorder(styles));
}

export function applyImageStyles(settings: Record<string, unknown>, styles: Record<string, string>): void {
  Object.assign(settings, buildSpacing(styles));
  Object.assign(settings, buildBorder(styles));
}

export function applyContainerStyles(settings: Record<string, unknown>, styles: Record<string, string>): void {
  if (styles["background-color"]) settings.background_color = styles["background-color"].trim();
  Object.assign(settings, buildSpacing(styles));
  Object.assign(settings, buildBorder(styles));
}
