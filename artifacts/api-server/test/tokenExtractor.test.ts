import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractDesignTokens,
  snapToToken,
  renderTokensCss,
  coerceTokens,
  normalizeColor,
  DEFAULT_TOKENS,
  type DesignTokens,
} from "../src/lib/tokenExtractor";

const SAMPLE_CSS = `
  :root { color-scheme: light; }
  body { color: #111827; background-color: #FFFFFF; font-size: 16px; }
  h1 { font-size: 48px; color: #111827; }
  h2 { font-size: 36px; color: #111827; }
  h3 { font-size: 24px; }
  small { font-size: 13px; }
  .card { padding: 16px; border-radius: 8px; border-color: #E5E7EB; background-color: #FFFFFF; }
  .card-lg { padding: 32px; border-radius: 16px; }
  .pill { padding: 8px; border-radius: 9999px; }
  .tight { padding: 4px; }
  .hero { padding: 64px; }
  .btn { background-color: #3B82F6; color: #FFFFFF; padding: 16px; border-radius: 8px; }
  .btn-accent { background-color: #F59E0B; }
  .muted { color: #6B7280; }
`;

test("normalizeColor handles hex, rgb, hsl", () => {
  assert.equal(normalizeColor("#abc"), "#AABBCC");
  assert.equal(normalizeColor("#aabbcc"), "#AABBCC");
  assert.equal(normalizeColor("rgb(255, 0, 0)"), "#FF0000");
  assert.equal(normalizeColor("rgba(0, 128, 0, 0.5)"), "#008000");
  assert.equal(normalizeColor("hsl(0, 100%, 50%)"), "#FF0000");
  assert.equal(normalizeColor("transparent"), null);
  assert.equal(normalizeColor("var(--whatever)"), null);
});

test("extractDesignTokens returns the full token shape with sensible values", () => {
  const tokens = extractDesignTokens(SAMPLE_CSS);
  // Shape contract — every group is filled.
  assert.deepEqual(Object.keys(tokens.spacing).sort(), ["lg", "md", "sm", "xl", "xs"]);
  assert.deepEqual(Object.keys(tokens.fontSize).sort(), ["body", "h1", "h2", "h3", "small"]);
  assert.deepEqual(Object.keys(tokens.color).sort(), ["accent", "border", "muted", "primary", "surface", "text"]);
  assert.deepEqual(Object.keys(tokens.radius).sort(), ["full", "lg", "md", "sm"]);
  // Surface = brightest BG color.
  assert.equal(tokens.color.surface, "#FFFFFF");
  // Text = darkest text color.
  assert.equal(tokens.color.text, "#111827");
  // Border lifted from the explicit border-color declaration.
  assert.equal(tokens.color.border, "#E5E7EB");
  // Primary should pick the most saturated palette entry.
  assert.match(tokens.color.primary, /^#[0-9A-F]{6}$/);
  // Spacing scale should include the small + large extremes we authored.
  const spacingValues = Object.values(tokens.spacing);
  assert.ok(spacingValues.includes("4px") || spacingValues.includes("8px"), "small spacing tier present");
  assert.ok(spacingValues.includes("64px") || spacingValues.includes("32px"), "large spacing tier present");
});

test("extractDesignTokens falls back to DEFAULT_TOKENS for empty CSS", () => {
  const tokens = extractDesignTokens("");
  assert.deepEqual(tokens, DEFAULT_TOKENS);
});

test("snapToToken color: returns var() within tolerance, raw otherwise", () => {
  const tokens: DesignTokens = {
    ...DEFAULT_TOKENS,
    color: { ...DEFAULT_TOKENS.color, primary: "#3B82F6" },
  };
  // Exact match
  assert.equal(snapToToken("#3B82F6", tokens, "color"), "var(--wpb-color-primary)");
  // Near match (within ~24 RGB-distance)
  assert.equal(snapToToken("#3D80F5", tokens, "color"), "var(--wpb-color-primary)");
  // Far away — passes through unchanged.
  assert.equal(snapToToken("#FF00FF", tokens, "color"), "#FF00FF");
});

test("snapToToken numeric: snaps spacing/fontSize/radius within tolerance", () => {
  const tokens: DesignTokens = {
    spacing: { xs: "4px", sm: "8px", md: "16px", lg: "32px", xl: "64px" },
    fontSize: { small: "13px", body: "16px", h3: "24px", h2: "36px", h1: "48px" },
    color: DEFAULT_TOKENS.color,
    radius: { sm: "4px", md: "8px", lg: "16px", full: "9999px" },
  };
  assert.equal(snapToToken("16px", tokens, "spacing"), "var(--wpb-space-md)");
  assert.equal(snapToToken("17px", tokens, "spacing"), "var(--wpb-space-md)");
  // 22px is too far from any spacing tier (16/32 — ~37% off both); raw.
  assert.equal(snapToToken("22px", tokens, "spacing"), "22px");
  assert.equal(snapToToken("48px", tokens, "fontSize"), "var(--wpb-font-h1)");
  assert.equal(snapToToken("9999px", tokens, "radius"), "var(--wpb-radius-full)");
});

test("snapToToken color: never snaps translucent colors to opaque tokens", () => {
  const tokens: DesignTokens = {
    ...DEFAULT_TOKENS,
    color: { ...DEFAULT_TOKENS.color, primary: "#3B82F6" },
  };
  // rgba with alpha < 1 → pass through unchanged
  assert.equal(snapToToken("rgba(59, 130, 246, 0.5)", tokens, "color"), "rgba(59, 130, 246, 0.5)");
  // hsla with alpha < 1 → pass through unchanged
  assert.equal(snapToToken("hsla(217, 91%, 60%, 0.4)", tokens, "color"), "hsla(217, 91%, 60%, 0.4)");
  // 8-digit hex with non-FF alpha → pass through
  assert.equal(snapToToken("#3B82F680", tokens, "color"), "#3B82F680");
  // rgba with alpha = 1 (fully opaque) → still snaps
  assert.equal(snapToToken("rgba(59, 130, 246, 1)", tokens, "color"), "var(--wpb-color-primary)");
  // 8-digit hex with FF alpha → still snaps
  assert.equal(snapToToken("#3B82F6FF", tokens, "color"), "var(--wpb-color-primary)");
});

test("snapToToken passes through undefined / var() / non-numeric values", () => {
  const tokens = DEFAULT_TOKENS;
  assert.equal(snapToToken(undefined, tokens, "color"), undefined);
  assert.equal(snapToToken("var(--foo)", tokens, "color"), "var(--foo)");
  assert.equal(snapToToken("auto", tokens, "spacing"), "auto");
});

test("snapToToken returns raw when tokens are missing", () => {
  assert.equal(snapToToken("#3B82F6", undefined, "color"), "#3B82F6");
  assert.equal(snapToToken("16px", undefined, "spacing"), "16px");
});

test("renderTokensCss emits the full :root variable block", () => {
  const css = renderTokensCss(DEFAULT_TOKENS);
  assert.match(css, /:root\s*\{/);
  assert.match(css, /--wpb-space-md:\s*16px/);
  assert.match(css, /--wpb-font-h1:\s*48px/);
  assert.match(css, /--wpb-color-primary:\s*#3B82F6/);
  assert.match(css, /--wpb-radius-full:\s*9999px/);
});

test("coerceTokens fills missing tiers from DEFAULT_TOKENS", () => {
  const partial = coerceTokens({ color: { primary: "#FF0000" } });
  assert.equal(partial.color.primary, "#FF0000");
  // Other tiers fall through to defaults.
  assert.equal(partial.color.text, DEFAULT_TOKENS.color.text);
  assert.equal(partial.spacing.md, DEFAULT_TOKENS.spacing.md);
});

test("coerceTokens tolerates non-object input", () => {
  assert.deepEqual(coerceTokens(null), DEFAULT_TOKENS);
  assert.deepEqual(coerceTokens("nope"), DEFAULT_TOKENS);
  assert.deepEqual(coerceTokens(42), DEFAULT_TOKENS);
});
