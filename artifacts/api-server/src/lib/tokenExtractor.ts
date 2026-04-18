/**
 * Project-wide design-token extractor. Walks the parsed source CSS,
 * harvests candidate spacing / font-size / color / border-radius values,
 * clusters them into representative tokens, and exposes a snap helper
 * that maps a raw value to either a `var(--wpb-…)` reference (within
 * tolerance) or the original raw value (outside tolerance).
 *
 * Design choice: we deliberately keep the token shape small and
 * opinionated (xs/sm/md/lg/xl spacing scale, h1/h2/h3/body/small type
 * scale, primary/accent/text/muted/surface/border palette,
 * sm/md/lg/full radius) so the customer-facing Design Tokens panel
 * stays scannable. Sites with more variation than this scale can hold
 * still render correctly — un-snapped values are preserved verbatim.
 */
import type { ParsedSheet } from "./cssStyleResolver";
import { parseStylesheet } from "./cssStyleResolver";

export interface DesignTokens {
  spacing: { xs: string; sm: string; md: string; lg: string; xl: string };
  fontSize: { h1: string; h2: string; h3: string; body: string; small: string };
  color: { primary: string; accent: string; text: string; muted: string; surface: string; border: string };
  radius: { sm: string; md: string; lg: string; full: string };
}

/** Default tokens used when a project has no extractable values yet. */
export const DEFAULT_TOKENS: DesignTokens = {
  spacing: { xs: "4px", sm: "8px", md: "16px", lg: "32px", xl: "64px" },
  fontSize: { h1: "48px", h2: "36px", h3: "24px", body: "16px", small: "13px" },
  color: {
    primary: "#3B82F6",
    accent: "#F59E0B",
    text: "#111827",
    muted: "#6B7280",
    surface: "#FFFFFF",
    border: "#E5E7EB",
  },
  radius: { sm: "4px", md: "8px", lg: "16px", full: "9999px" },
};

const SPACING_PROPS = new Set([
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "gap", "row-gap", "column-gap",
]);

const COLOR_PROPS = new Set([
  "color", "background-color", "background", "border-color", "fill", "stroke",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "outline-color",
]);

const RADIUS_PROPS = new Set([
  "border-radius", "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
]);

const LEN_RE = /(-?\d*\.?\d+)\s*(px|rem|em)\b/gi;
const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
const RGB_RE = /rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)/gi;
const HSL_RE = /hsla?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)%?\s*[,\s]\s*(\d+(?:\.\d+)?)%?(?:\s*[,/]\s*([\d.]+))?\s*\)/gi;

/** Convert a px/rem/em length to px (rem→16, em→16 fallback). */
function toPx(size: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case "rem": return size * 16;
    case "em":  return size * 16;
    case "px":
    default:    return size;
  }
}

interface Counter { value: string; px: number; weight: number }

/** Multi-occurrence counter: weights values by how often they appear. */
function tally(map: Map<string, Counter>, value: string, px: number, weight = 1): void {
  const key = `${px.toFixed(1)}|${value}`;
  const cur = map.get(key);
  if (cur) cur.weight += weight;
  else map.set(key, { value, px, weight });
}

function extractLengthsFromValue(raw: string): Array<{ value: string; px: number }> {
  const out: Array<{ value: string; px: number }> = [];
  for (const m of raw.matchAll(LEN_RE)) {
    const size = parseFloat(m[1]);
    const unit = m[2];
    if (!isFinite(size) || size <= 0) continue;
    out.push({ value: `${m[1]}${unit}`, px: toPx(size, unit) });
  }
  return out;
}

/** Normalize hex/rgb/hsl color into uppercase #RRGGBB hex. Returns null on failure. */
export function normalizeColor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v || v === "transparent" || v === "currentcolor" || v === "inherit" || v === "initial" || v === "unset" || v.startsWith("var(")) return null;
  // hex
  HEX_RE.lastIndex = 0;
  const hm = HEX_RE.exec(v);
  if (hm) {
    let h = hm[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 6) return `#${h.toUpperCase()}`;
    return null;
  }
  // rgb / rgba
  RGB_RE.lastIndex = 0;
  const rm = RGB_RE.exec(v);
  if (rm) {
    const r = Math.max(0, Math.min(255, parseInt(rm[1], 10)));
    const g = Math.max(0, Math.min(255, parseInt(rm[2], 10)));
    const b = Math.max(0, Math.min(255, parseInt(rm[3], 10)));
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  }
  // hsl / hsla → convert
  HSL_RE.lastIndex = 0;
  const sm = HSL_RE.exec(v);
  if (sm) {
    const h = parseFloat(sm[1]) / 360;
    const s = parseFloat(sm[2]) / 100;
    const l = parseFloat(sm[3]) / 100;
    const [r, g, b] = hslToRgb(h, s, l);
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hueToRgb(h + 1 / 3) * 255),
    Math.round(hueToRgb(h) * 255),
    Math.round(hueToRgb(h - 1 / 3) * 255),
  ];
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Sum-of-squares distance in RGB space. Cheap, good enough for grouping. */
function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return Infinity;
  return Math.sqrt(
    (ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2,
  );
}

/** Approximate luminance (0-1) of a hex color. */
function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

/** Approximate saturation (0-1) of a hex color. */
function saturation(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const max = Math.max(...rgb), min = Math.min(...rgb);
  if (max === 0) return 0;
  return (max - min) / max;
}

/**
 * Cluster numeric (px-equivalent) values into a fixed number of tiers.
 * Tiers are produced by sorting unique px values, weighting by occurrence,
 * then picking N evenly-spaced anchor values across the range.
 */
function clusterScale(
  candidates: Counter[],
  tierCount: number,
): string[] {
  if (candidates.length === 0) return [];
  // Group nearby values (within 12% of each other) into one bucket so a
  // 16/17/18 px cluster doesn't flood the scale.
  const sorted = [...candidates].sort((a, b) => a.px - b.px);
  const buckets: Counter[] = [];
  for (const c of sorted) {
    const last = buckets[buckets.length - 1];
    if (last && Math.abs(c.px - last.px) / Math.max(1, last.px) <= 0.12) {
      // Merge into last bucket — weighted average px, sum weight.
      const totalWeight = last.weight + c.weight;
      last.px = (last.px * last.weight + c.px * c.weight) / totalWeight;
      last.weight = totalWeight;
      // Prefer the value with the higher individual weight as the canonical.
      if (c.weight > last.weight / 2) last.value = c.value;
    } else {
      buckets.push({ ...c });
    }
  }
  if (buckets.length <= tierCount) {
    // Pad: re-use the largest if we don't have enough tiers.
    const out = buckets.map((b) => b.value);
    while (out.length < tierCount) out.push(out[out.length - 1] ?? "0px");
    return out;
  }
  // Pick the `tierCount` most representative buckets across the range.
  // Strategy: sort by weight descending, take top N candidates, then
  // re-sort by px ascending so the scale reads small→large.
  const top = [...buckets].sort((a, b) => b.weight - a.weight).slice(0, tierCount);
  top.sort((a, b) => a.px - b.px);
  return top.map((b) => b.value);
}

/**
 * Pick a small palette from a multiset of normalized hex colors. Returns
 * an array of representative hexes whose pairwise distance is at least
 * `minDistance` (so we don't surface near-duplicates as separate roles).
 */
function dedupePalette(counters: Counter[], minDistance: number): Counter[] {
  const sorted = [...counters].sort((a, b) => b.weight - a.weight);
  const out: Counter[] = [];
  for (const c of sorted) {
    if (out.every((o) => colorDistance(o.value, c.value) >= minDistance)) {
      out.push(c);
    }
  }
  return out;
}

/**
 * Walk the parsed stylesheet and return the project-wide token set.
 * Falls back to DEFAULT_TOKENS values for any tier that the source CSS
 * doesn't supply — this keeps the token shape stable so downstream
 * consumers (PHP enqueue, UI panel) never have to handle missing keys.
 */
export function extractDesignTokens(input: ParsedSheet | string | null | undefined): DesignTokens {
  const sheet: ParsedSheet =
    typeof input === "string" ? parseStylesheet(input) : input ?? { rules: [] };

  const spacings = new Map<string, Counter>();
  const fontSizes = new Map<string, Counter>();
  const radii = new Map<string, Counter>();
  const colors = new Map<string, Counter>();
  const bgColors = new Map<string, Counter>();
  const borderColors = new Map<string, Counter>();
  const textColors = new Map<string, Counter>();

  for (const rule of sheet.rules) {
    for (const [prop, decl] of Object.entries(rule.declarations)) {
      const v = decl.value;
      if (SPACING_PROPS.has(prop)) {
        for (const len of extractLengthsFromValue(v)) {
          if (len.px <= 0 || len.px > 256) continue; // ignore tiny/huge outliers
          tally(spacings, len.value, len.px);
        }
      } else if (prop === "font-size") {
        for (const len of extractLengthsFromValue(v)) {
          if (len.px < 8 || len.px > 144) continue;
          tally(fontSizes, len.value, len.px);
        }
      } else if (RADIUS_PROPS.has(prop)) {
        for (const len of extractLengthsFromValue(v)) {
          if (len.px < 0 || len.px > 9999) continue;
          tally(radii, len.value, len.px);
        }
      } else if (COLOR_PROPS.has(prop)) {
        const norm = normalizeColor(v);
        if (!norm) continue;
        // Skip near-black / near-white text color collection here so it
        // doesn't drown the palette; they're picked up separately below.
        tally(colors, norm, 0);
        if (prop === "color") tally(textColors, norm, 0);
        if (prop === "background-color" || prop === "background") tally(bgColors, norm, 0);
        if (prop.startsWith("border")) tally(borderColors, norm, 0);
      }
    }
  }

  // Spacing scale (5 tiers).
  const spacingTiers = clusterScale(Array.from(spacings.values()), 5);
  const spacing: DesignTokens["spacing"] = {
    xs: spacingTiers[0] ?? DEFAULT_TOKENS.spacing.xs,
    sm: spacingTiers[1] ?? DEFAULT_TOKENS.spacing.sm,
    md: spacingTiers[2] ?? DEFAULT_TOKENS.spacing.md,
    lg: spacingTiers[3] ?? DEFAULT_TOKENS.spacing.lg,
    xl: spacingTiers[4] ?? DEFAULT_TOKENS.spacing.xl,
  };

  // Font-size scale (5 tiers).
  const fontTiers = clusterScale(Array.from(fontSizes.values()), 5);
  const fontSize: DesignTokens["fontSize"] = {
    small: fontTiers[0] ?? DEFAULT_TOKENS.fontSize.small,
    body:  fontTiers[1] ?? DEFAULT_TOKENS.fontSize.body,
    h3:    fontTiers[2] ?? DEFAULT_TOKENS.fontSize.h3,
    h2:    fontTiers[3] ?? DEFAULT_TOKENS.fontSize.h2,
    h1:    fontTiers[4] ?? DEFAULT_TOKENS.fontSize.h1,
  };

  // Radius scale (4 tiers).
  const radiusTiers = clusterScale(Array.from(radii.values()), 4);
  const radius: DesignTokens["radius"] = {
    sm:   radiusTiers[0] ?? DEFAULT_TOKENS.radius.sm,
    md:   radiusTiers[1] ?? DEFAULT_TOKENS.radius.md,
    lg:   radiusTiers[2] ?? DEFAULT_TOKENS.radius.lg,
    full: radiusTiers[3] ?? DEFAULT_TOKENS.radius.full,
  };

  // Palette: pick representative hexes for each role.
  const palette = dedupePalette(Array.from(colors.values()), 24);
  // Text: prefer the darkest text-color appearance.
  const textCandidates = Array.from(textColors.values()).sort(
    (a, b) => luminance(a.value) - luminance(b.value),
  );
  const text = textCandidates[0]?.value ?? DEFAULT_TOKENS.color.text;
  // Surface: prefer the lightest background-color appearance.
  const surfaceCandidates = Array.from(bgColors.values()).sort(
    (a, b) => luminance(b.value) - luminance(a.value),
  );
  const surface = surfaceCandidates[0]?.value ?? DEFAULT_TOKENS.color.surface;
  // Border: most-used border color, falling back to a mid-luminance palette entry.
  const borderCandidates = Array.from(borderColors.values()).sort((a, b) => b.weight - a.weight);
  const border = borderCandidates[0]?.value
    ?? palette.find((p) => luminance(p.value) > 0.7 && luminance(p.value) < 0.95)?.value
    ?? DEFAULT_TOKENS.color.border;
  // Primary: most saturated palette entry that isn't text/surface/border.
  const reserved = new Set([text, surface, border]);
  const saturated = palette
    .filter((p) => !reserved.has(p.value))
    .map((p) => ({ ...p, sat: saturation(p.value) }))
    .sort((a, b) => b.sat - a.sat);
  const primary = saturated[0]?.value ?? DEFAULT_TOKENS.color.primary;
  reserved.add(primary);
  // Accent: next-most saturated entry that isn't too close to primary.
  const accent = saturated.find((p) => p.value !== primary && colorDistance(p.value, primary) > 60)?.value
    ?? saturated.find((p) => p.value !== primary)?.value
    ?? DEFAULT_TOKENS.color.accent;
  reserved.add(accent);
  // Muted: a grey-ish tone — low saturation, mid luminance, not yet used.
  const muted = palette
    .filter((p) => !reserved.has(p.value))
    .map((p) => ({ ...p, sat: saturation(p.value), lum: luminance(p.value) }))
    .filter((p) => p.sat < 0.25 && p.lum > 0.3 && p.lum < 0.8)
    .sort((a, b) => b.weight - a.weight)[0]?.value
    ?? DEFAULT_TOKENS.color.muted;

  const color: DesignTokens["color"] = { primary, accent, text, muted, surface, border };

  return { spacing, fontSize, color, radius };
}

/**
 * Snap a raw CSS value to the nearest token's CSS-custom-property
 * reference, falling back to the original value when none is within
 * tolerance. `kind` selects which token sub-scale to consider.
 *
 * - "spacing"  → spacing scale (px-equivalent comparison, 12% tolerance)
 * - "fontSize" → font-size scale (10% tolerance)
 * - "radius"   → radius scale (15% tolerance)
 * - "color"    → palette (RGB euclidean distance < 24)
 */
export type SnapKind = "spacing" | "fontSize" | "radius" | "color";

export function snapToToken(
  raw: string | undefined,
  tokens: DesignTokens | undefined,
  kind: SnapKind,
): string | undefined {
  if (raw === undefined) return raw;
  if (!tokens) return raw;
  const value = raw.trim();
  if (!value || value.startsWith("var(")) return value;

  if (kind === "color") {
    // Skip translucent colors: snapping rgba/hsla with alpha < 1 to an
    // opaque palette var would silently flatten the value and change
    // the rendered output (overlays, hover-tints, etc.). Pass through.
    if (/rgba?\s*\(/i.test(value) || /hsla?\s*\(/i.test(value)) {
      const alphaMatch = value.match(/[,/]\s*([\d.]+)\s*\)\s*$/);
      if (alphaMatch && parseFloat(alphaMatch[1]) < 1) return value;
    }
    if (/^#([0-9a-fA-F]{8})$/.test(value)) {
      // 8-digit hex carries alpha in the last 2 chars — bail out unless fully opaque (FF).
      if (!/[fF]{2}$/.test(value)) return value;
    }
    const norm = normalizeColor(value);
    if (!norm) return value;
    let bestKey: keyof DesignTokens["color"] | null = null;
    let bestDist = Infinity;
    for (const [k, hex] of Object.entries(tokens.color) as Array<[keyof DesignTokens["color"], string]>) {
      const d = colorDistance(norm, hex);
      if (d < bestDist) {
        bestDist = d;
        bestKey = k;
      }
    }
    if (bestKey && bestDist < 24) return `var(--wpb-color-${bestKey})`;
    return value;
  }

  // Numeric snap branches
  const m = value.match(/^(-?\d*\.?\d+)\s*(px|rem|em)?$/i);
  if (!m) return value;
  const size = parseFloat(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  const px = toPx(size, unit);

  let scale: Record<string, string>;
  let prefix: string;
  let tolerance: number;
  if (kind === "spacing") {
    scale = tokens.spacing as unknown as Record<string, string>;
    prefix = "wpb-space";
    tolerance = 0.12;
  } else if (kind === "fontSize") {
    scale = tokens.fontSize as unknown as Record<string, string>;
    prefix = "wpb-font";
    tolerance = 0.10;
  } else {
    scale = tokens.radius as unknown as Record<string, string>;
    prefix = "wpb-radius";
    tolerance = 0.15;
  }

  let bestKey: string | null = null;
  let bestRel = Infinity;
  for (const [k, v] of Object.entries(scale)) {
    const tm = v.match(/^(-?\d*\.?\d+)\s*(px|rem|em)?$/i);
    if (!tm) continue;
    const tokPx = toPx(parseFloat(tm[1]), (tm[2] ?? "px").toLowerCase());
    if (tokPx === 0 && px === 0) {
      bestKey = k;
      bestRel = 0;
      break;
    }
    if (tokPx === 0) continue;
    const rel = Math.abs(px - tokPx) / tokPx;
    if (rel < bestRel) {
      bestRel = rel;
      bestKey = k;
    }
  }
  if (bestKey && bestRel <= tolerance) return `var(--${prefix}-${bestKey})`;
  return value;
}

/**
 * Render the full token set as a CSS custom-property block under :root.
 * Variables follow the `--wpb-{group}-{key}` convention used by the
 * snap helper so theme overrides flow through automatically.
 */
export function renderTokensCss(tokens: DesignTokens): string {
  const lines: string[] = ["/* Auto-generated by WP Bridge AI — design tokens */", ":root {"];
  for (const [k, v] of Object.entries(tokens.spacing)) lines.push(`  --wpb-space-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.fontSize)) lines.push(`  --wpb-font-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.color)) lines.push(`  --wpb-color-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.radius)) lines.push(`  --wpb-radius-${k}: ${v};`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** Validate / coerce a token map loaded from JSON. Missing keys are filled from DEFAULT_TOKENS. */
export function coerceTokens(raw: unknown): DesignTokens {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<DesignTokens>;
  const pick = <T extends Record<string, string>>(input: unknown, defaults: T): T => {
    const out = { ...defaults };
    if (input && typeof input === "object") {
      for (const k of Object.keys(defaults) as Array<keyof T>) {
        const v = (input as Record<string, unknown>)[k as string];
        if (typeof v === "string" && v.trim().length > 0) out[k] = v.trim() as T[keyof T];
      }
    }
    return out;
  };
  return {
    spacing:  pick(o.spacing, DEFAULT_TOKENS.spacing),
    fontSize: pick(o.fontSize, DEFAULT_TOKENS.fontSize),
    color:    pick(o.color, DEFAULT_TOKENS.color),
    radius:   pick(o.radius, DEFAULT_TOKENS.radius),
  };
}
