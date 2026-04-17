/**
 * End-to-end check that generated themes render correctly inside a real
 * WordPress install. Runs as part of the normal `pnpm test` pipeline so
 * regressions get caught before merge.
 *
 *   pnpm --filter @workspace/api-server test
 *
 * The first run downloads ~30MB and installs WordPress + Elementor into
 * /tmp/wpb-e2e/wp (override with WPB_E2E_DIR). Subsequent runs reuse the
 * cached install and complete in well under a minute.
 *
 * Opt out (e.g. on machines without PHP, or for quick inner-loop unit
 * test runs) with SKIP_WP_E2E=1. The test also auto-skips with a clear
 * message if `php` isn't on PATH so contributors without PHP installed
 * still get green unit tests; CI is expected to have PHP.
 *
 * Flow (per fixture):
 *   1. setup-wp.sh        — ensures WP + SQLite drop-in + Elementor + installer have run
 *   2. generate the theme zip from the fixture HTML
 *   3. extract the theme into wp-content/themes/<slug>/
 *   4. apply-elementor.php — activates theme, creates a page driven by
 *      Elementor with the composed _elementor_data
 *   5. boot `php -S` against the WP dir (once, reused across fixtures)
 *   6. fetch the page HTML and assert that every section's text/url/alt
 *      field round-trips back into the rendered output
 *
 * Each fixture in FIXTURES gets its own theme + page, so the loop also
 * verifies that the generator can install multiple themes side-by-side
 * without colliding. After the renderer pivot the only render path is
 * Elementor — the legacy Gutenberg pass has been deleted along with
 * composeGutenbergContent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import AdmZip from "adm-zip";
import { JSDOM } from "jsdom";

import {
  extractSectionsFromPage,
  type ExtractedSection,
} from "../../src/lib/sectionFieldExtractor";
import { composeElementorData } from "../../src/lib/pixelPerfectComposer";
import { generateThemeZip } from "../../src/lib/themeGenerator";

/**
 * Default-on so the WordPress render check runs on every `pnpm test`.
 * Two opt-outs:
 *   - SKIP_WP_E2E=1   explicit skip (dev wants fast unit-only loop)
 *   - php not on PATH  auto-skip with a clear reason (so contributors
 *                      without PHP installed don't see a confusing fail)
 * RUN_WP_E2E=0 is also honored for symmetry with the historical opt-in.
 */
function detectE2eEnabled(): { enabled: boolean; reason?: string } {
  if (process.env.SKIP_WP_E2E === "1") {
    return { enabled: false, reason: "SKIP_WP_E2E=1" };
  }
  if (process.env.RUN_WP_E2E === "0") {
    return { enabled: false, reason: "RUN_WP_E2E=0" };
  }
  const probe = spawnSync("php", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) {
    // In CI, refuse to silently skip the regression gate — a misconfigured
    // runner without PHP would otherwise let breakage merge. We surface
    // this by reporting enabled=true with no reason, so the test runs and
    // fails loudly the first time it tries to spawn `bash setup-wp.sh`.
    if (process.env.CI === "1" || process.env.CI === "true") {
      throw new Error(
        "WordPress render E2E requires PHP 8+ on PATH but `php` is unavailable. " +
          "Install PHP on the CI runner or set SKIP_WP_E2E=1 explicitly to acknowledge skipping the regression gate.",
      );
    }
    return {
      enabled: false,
      reason: "php not available on PATH (install PHP 8+ to enable the WP render check)",
    };
  }
  return { enabled: true };
}
const E2E = detectE2eEnabled();
const ENABLED = E2E.enabled;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WP_DIR = process.env.WPB_E2E_DIR ?? "/tmp/wpb-e2e/wp";
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");

interface FixtureCase {
  /** Fixture file under test/fixtures/ */
  file: string;
  /** Unique theme slug — also the wp-content/themes/<slug> directory. */
  projectSlug: string;
  /** Human-readable theme name. */
  projectName: string;
  /** Page slug used inside WordPress. */
  pageSlug: string;
  /** Expected number of top-level <header>/<section>/<footer>/... sections. */
  expectedSectionCount: number;
}

/**
 * The fixtures we round-trip end-to-end. simple-page covers the minimal
 * happy path; complex-page mirrors the messy uploads we see in the wild
 * (image-heavy hero with inline background-image styles, nested grid /
 * card layouts, inline SVG decorations, multi-column footer).
 */
const FIXTURES: FixtureCase[] = [
  {
    file: "simple-page.html",
    projectSlug: "fixture-site",
    projectName: "Fixture Site",
    pageSlug: "home",
    expectedSectionCount: 4,
  },
  {
    file: "complex-page.html",
    projectSlug: "complex-fixture-site",
    projectName: "Complex Fixture Site",
    pageSlug: "complex-home",
    expectedSectionCount: 4,
  },
  {
    // Dedicated fixture for the semantic-groups widget pivot. Covers
    // every supported group kind — button, link, image, heading, text —
    // so a regression in any group's settings shape (URL → {url, ...},
    // MEDIA → {url, id}, etc.) trips this fixture's elementor pass.
    file: "widget-page.html",
    projectSlug: "widget-fixture-site",
    projectName: "Widget Fixture Site",
    pageSlug: "widget-home",
    expectedSectionCount: 3,
  },
];

function run(cmd: string, args: string[], opts: { input?: string } = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(cmd, args, { input: opts.input, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

const SECTION_TAGS = new Set(["HEADER", "SECTION", "FOOTER", "NAV", "ASIDE", "MAIN", "ARTICLE"]);

/**
 * Pull the top-level semantic sections out of an HTML document in
 * document order. Mirrors the selection logic in
 * `sectionFieldExtractor.extractSectionsFromPage`: we look for tags in
 * SECTION_TAGS that are not nested inside another such tag. This lets
 * the diff line up the fixture's <header>/<section>/<footer> with the
 * blocks that WordPress rendered into the page body.
 */
function topLevelSections(html: string): Element[] {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  if (!body) return [];
  return Array.from(body.querySelectorAll(Array.from(SECTION_TAGS).join(",").toLowerCase())).filter((el) => {
    let p: Element | null = el.parentElement;
    while (p && p !== body) {
      if (SECTION_TAGS.has(p.tagName)) return false;
      p = p.parentElement;
    }
    return true;
  });
}

const WP_INJECTED_ATTRS = new Set([
  "decoding", "loading", "fetchpriority", "srcset", "sizes",
  // The semantic-groups extractor stamps `data-wpb-tag="<key>"` on every
  // heading so the PHP renderer can swap the tag from h1..h6 at render
  // time. The marker is not present in the source fixture, so strip it
  // before comparing rendered output to the fixture.
  "data-wpb-tag",
]);

/**
 * Normalize a rendered DOM subtree so it can be compared against the
 * source fixture. WordPress legitimately mutates rendered output in a
 * handful of well-known ways that we strip here:
 *   - injects `decoding`, `loading`, `fetchpriority` on <img>
 *   - rewrites our `{{THEME_URI}}/assets/X` placeholder into an absolute
 *     URL like `http://localhost/wp-content/themes/<slug>/assets/X`,
 *     both in `src`/`href` and inside inline `style="...url(...)..."`
 *   - adds extra whitespace between block-level elements
 * Anything else is treated as a real difference.
 */
function normalize(el: Element, themeSlug: string): string {
  const cloneSrc = el.cloneNode(true) as Element;
  // jsdom-cloned nodes still need an owner document for serialization;
  // attach to a fresh fragment.
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const doc = dom.window.document;
  const clone = doc.importNode(cloneSrc, true) as Element;
  doc.body.appendChild(clone);

  const themeAssetPrefixSrc = `https?://[^/]+/wp-content/themes/${themeSlug}/assets/`;
  const themeAssetPrefix = new RegExp("^" + themeAssetPrefixSrc);
  const themeAssetUrlInStyle = new RegExp(themeAssetPrefixSrc, "g");

  const walk = (node: Element): void => {
    for (const a of Array.from(node.attributes)) {
      if (WP_INJECTED_ATTRS.has(a.name)) {
        node.removeAttribute(a.name);
        continue;
      }
      if (a.name === "src" || a.name === "href") {
        const v = a.value.replace(themeAssetPrefix, "");
        node.setAttribute(a.name, v);
      } else if (a.name === "style") {
        // background:url(http://.../wp-content/themes/<slug>/assets/x.jpg)
        // → url(x.jpg) so it lines up with the source fixture's relative URL.
        const v = a.value.replace(themeAssetUrlInStyle, "");
        node.setAttribute(a.name, v);
      }
    }
    // Sort attributes so attribute ordering can't cause spurious diffs.
    const entries = Array.from(node.attributes).map((a) => [a.name, a.value] as const);
    entries.sort(([x], [y]) => x.localeCompare(y));
    for (const [name] of entries) node.removeAttribute(name);
    for (const [name, value] of entries) node.setAttribute(name, value);

    for (const child of Array.from(node.children)) walk(child);
  };
  walk(clone);

  // Collapse whitespace between elements. We keep significant whitespace
  // inside text nodes (e.g. spaces inside `<p>foo bar</p>`) but normalize
  // runs of whitespace to a single space and trim text nodes that sit
  // between elements.
  return clone.outerHTML
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw new Error(`server at ${url} never came up: ${String(lastErr)}`);
}

/**
 * Build the theme zip for a fixture and extract it into
 * wp-content/themes/<slug>/. Wipes any prior copy first so re-runs are
 * deterministic.
 */
function buildAndExtractTheme(fx: FixtureCase, sections: ExtractedSection[]): void {
  const themeZip = generateThemeZip({
    projectName: fx.projectName,
    projectSlug: fx.projectSlug,
    combinedCss: "body{margin:0}",
    combinedJs: "",
    pages: [{ slug: fx.pageSlug, title: fx.projectName, sections }],
    sourceZip: null,
  });
  const themesDir = path.join(WP_DIR, "wp-content/themes", fx.projectSlug);
  rmSync(themesDir, { recursive: true, force: true });
  mkdirSync(themesDir, { recursive: true });
  const ad = new AdmZip(themeZip);
  // Entries are namespaced by `${projectSlug}/...`; strip that prefix
  // when extracting so files land directly under wp-content/themes/<slug>/.
  for (const e of ad.getEntries()) {
    if (e.isDirectory) continue;
    const rel = e.entryName.replace(/^[^/]+\//, "");
    const dest = path.join(themesDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, e.getData());
  }
}

test("uploaded themes render end-to-end inside WordPress", { skip: ENABLED ? false : (E2E.reason ?? true) }, async (t) => {
  // 1. Bootstrap WordPress (once for the whole suite).
  const setup = run("bash", [path.join(__dirname, "setup-wp.sh")]);
  assert.equal(setup.status, 0, `setup-wp.sh failed:\n${setup.stderr}`);

  // Boot php -S in the background once; we'll switch themes per fixture.
  const port = 18000 + Math.floor(Math.random() * 1000);
  const router = path.join(__dirname, "router.php");
  const server = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", WP_DIR, router], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (b) => { serverErr += b.toString(); });
  t.after(() => { server.kill("SIGTERM"); });
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base + "/");


  // Bundled-asset round-trip: confirms that real binary files placed in
  // the user's source ZIP (image + font) actually end up at the URL the
  // generated theme links to. Catches regressions in the
  // `{{THEME_URI}}/assets/...` rewrite contract and in the ASSET_EXT
  // copy loop in `themeGenerator.ts`. See task #11.
  await t.test("bundled images and fonts load on the rendered page", async () => {
    // 1x1 transparent PNG — small, real, byte-correct.
    const PNG_1x1 = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
        "0000000d49444154789c6300010000050001000a2db4e70000000049454e44ae426082",
      "hex",
    );
    // The PHP server doesn't validate font bytes, so any non-empty buffer
    // suffices to verify the file is actually present + served. The
    // contents are signed so we can compare what comes back.
    const FONT_BYTES = Buffer.from("WPB-E2E-FONT-PLACEHOLDER\n", "utf8");

    const projectSlug = "asset-fixture-site";
    const projectName = "Asset Fixture Site";
    const pageSlug = "asset-home";
    const fixturePath = path.join(FIXTURE_DIR, "asset-page.html");
    const fixture = readFileSync(fixturePath, "utf8");
    const sections = extractSectionsFromPage(fixture, pageSlug, projectSlug);
    assert.ok(sections.length >= 2, "asset fixture should produce at least header + section");

    // Build a synthetic source ZIP carrying a real PNG and a font file.
    // themeGenerator copies anything matching ASSET_EXT into assets/
    // verbatim, preserving the relative path inside the ZIP.
    const srcZip = new AdmZip();
    srcZip.addFile("img/logo.png", PNG_1x1);
    srcZip.addFile("fonts/test.woff2", FONT_BYTES);
    const sourceZipBuf = srcZip.toBuffer();

    // Reference the bundled font from CSS so style.css/template.css ends
    // up enqueueing it, and so the test exercises the bundled-font copy
    // path even though no <link href> in the rendered HTML points at the
    // font file directly.
    const combinedCss =
      "@font-face{font-family:'WpbTest';" +
      "src:url('assets/fonts/test.woff2') format('woff2');}" +
      "body{font-family:'WpbTest',sans-serif;margin:0}";

    const themeZip = generateThemeZip({
      projectName,
      projectSlug,
      combinedCss,
      combinedJs: "",
      pages: [{ slug: pageSlug, title: projectName, sections }],
      sourceZip: sourceZipBuf,
    });

    // Sanity: the source PNG + font must have made it into the theme zip.
    const themeRead = new AdmZip(themeZip);
    const logoEntry = themeRead.getEntry(`${projectSlug}/assets/img/logo.png`);
    const fontEntry = themeRead.getEntry(`${projectSlug}/assets/fonts/test.woff2`);
    assert.ok(logoEntry, "themeGenerator must copy img/logo.png into assets/");
    assert.ok(fontEntry, "themeGenerator must copy fonts/test.woff2 into assets/");
    assert.deepEqual(logoEntry!.getData(), PNG_1x1, "PNG bytes must round-trip through the theme zip");
    assert.deepEqual(fontEntry!.getData(), FONT_BYTES, "font bytes must round-trip through the theme zip");

    // Extract into wp-content/themes/<slug>/.
    const themesDir = path.join(WP_DIR, "wp-content/themes", projectSlug);
    rmSync(themesDir, { recursive: true, force: true });
    mkdirSync(themesDir, { recursive: true });
    for (const e of themeRead.getEntries()) {
      if (e.isDirectory) continue;
      const rel = e.entryName.replace(/^[^/]+\//, "");
      const dest = path.join(themesDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, e.getData());
    }

    // Apply theme + insert page (driven by Elementor — the only render
    // path now that the Gutenberg pass has been removed).
    const elementorData = composeElementorData({ slug: pageSlug, title: projectName, sections });
    const apply = run(
      "php",
      [path.join(__dirname, "apply-elementor.php"), WP_DIR, projectSlug, pageSlug, projectName],
      { input: JSON.stringify(elementorData) },
    );
    assert.equal(apply.status, 0, `apply-elementor.php failed:\n${apply.stderr}`);
    const pageId = parseInt(apply.stdout.trim(), 10);
    assert.ok(Number.isFinite(pageId) && pageId > 0, `unexpected page id: ${apply.stdout}`);

    // Fetch and parse the rendered page.
    const res = await fetch(`${base}/?page_id=${pageId}`);
    assert.equal(res.status, 200, `WP responded ${res.status}\nserver stderr:\n${serverErr}`);
    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Collect every <img src> and <link href>, restrict to same-origin
    // (skip e.g. fonts.googleapis.com which php -S can't serve).
    const imgUrls = Array.from(doc.querySelectorAll("img[src]"))
      .map((el) => el.getAttribute("src") ?? "")
      .filter(Boolean);
    const linkUrls = Array.from(doc.querySelectorAll("link[href]"))
      .map((el) => el.getAttribute("href") ?? "")
      .filter(Boolean);

    assert.ok(imgUrls.length > 0, "rendered page must contain at least one <img src>");
    assert.ok(linkUrls.length > 0, "rendered page must contain at least one <link href>");

    // WordPress emits absolute URLs whose host is whatever HTTP_HOST was
    // when the page was rendered (apply-theme.php sets it to "localhost",
    // not "127.0.0.1:<port>"). Rewrite any same-host absolute URLs and
    // any root-relative URLs so they point at our actual php -S server.
    const rewriteToBase = (u: string): string | null => {
      if (!u) return null;
      if (u.startsWith("//")) u = "http:" + u;
      if (u.startsWith("/")) return `${base}${u}`;
      try {
        const parsed = new URL(u);
        if (parsed.host === `127.0.0.1:${port}`) return u;
        if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
          return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
        }
        return null;
      } catch {
        return null;
      }
    };

    const targets = [...imgUrls, ...linkUrls]
      .map(rewriteToBase)
      .filter((u): u is string => u !== null);
    assert.ok(
      targets.length >= 2,
      `expected at least one same-origin <img> and <link>, got ${targets.length}: ${[...imgUrls, ...linkUrls].join(", ")}`,
    );

    // HEAD every same-origin asset URL the rendered page references.
    for (const url of targets) {
      const headRes = await fetch(url, { method: "HEAD" });
      assert.equal(
        headRes.status,
        200,
        `bundled asset did not load: ${url} → HTTP ${headRes.status}\n` +
          `server stderr:\n${serverErr}`,
      );
    }

    // Explicit font check: nothing in the rendered <head> emits a <link>
    // for the @font-face URL, so HEAD it directly to confirm the font
    // bundle copy path is intact (task #11 acceptance: "ideally a font").
    const fontUrl = `${base}/wp-content/themes/${projectSlug}/assets/fonts/test.woff2`;
    const fontHead = await fetch(fontUrl, { method: "HEAD" });
    assert.equal(
      fontHead.status,
      200,
      `bundled font did not load: ${fontUrl} → HTTP ${fontHead.status}`,
    );
    // And confirm the bytes round-trip end-to-end (catches the case where
    // a 200 is returned but with empty / garbled content because of a
    // mis-set Content-Length or transfer encoding).
    const fontGet = await fetch(fontUrl);
    const fontBody = Buffer.from(await fontGet.arrayBuffer());
    assert.deepEqual(
      fontBody,
      FONT_BYTES,
      "bundled font bytes must match what was placed in the source zip",
    );

    // And confirm at least one of the same-origin <img src> URLs points
    // at our bundled image (so the test fails loud if the rebase logic
    // ever stops emitting the {{THEME_URI}}/assets/ prefix).
    const themeImgPath = `/wp-content/themes/${projectSlug}/assets/img/logo.png`;
    assert.ok(
      targets.some((u) => u.endsWith(themeImgPath)),
      `expected one of the rendered <img src> URLs to point at the bundled ` +
        `image (${themeImgPath}); got: ${targets.join(", ")}`,
    );
  });

  // Mutation round-trip: prove that editing a widget's settings in
  // Elementor really does propagate to the rendered HTML. Without this
  // check the page could be hard-coded to its defaults and every other
  // assertion above would still pass. We mutate at least one control
  // per supported group kind (heading text + tag, link URL + nofollow,
  // image src + alt, list items) and verify the mutated values appear
  // in the rendered body and the original defaults do not.
  await t.test("mutated widget settings round-trip into the rendered page", async () => {
    const projectSlug = "mutation-fixture-site";
    const projectName = "Mutation Fixture Site";
    const pageSlug = "mutation-home";
    const fixturePath = path.join(FIXTURE_DIR, "simple-page.html");
    const fixture = readFileSync(fixturePath, "utf8");
    const sections = extractSectionsFromPage(fixture, pageSlug, projectSlug);
    assert.ok(sections.length >= 4, "simple-page should produce 4 sections");

    buildAndExtractTheme(
      { file: "simple-page.html", projectSlug, projectName, pageSlug, expectedSectionCount: 4 },
      sections,
    );

    interface WidgetNode {
      widgetType: string;
      settings: Record<string, unknown>;
    }
    interface ColumnNode { elements: WidgetNode[] }
    interface SectionNode { elements: ColumnNode[] }
    const elementorData = composeElementorData({ slug: pageSlug, title: projectName, sections }) as SectionNode[];

    // Build a flat map of every group across every section so we can
    // pick the first instance of each kind to mutate. We also remember
    // the corresponding widget settings object so we can mutate in place.
    interface GroupRef {
      kind: string;
      sectionIndex: number;
      controls: { key: string; type: string; default: string }[];
      settings: Record<string, unknown>;
    }
    const allGroups: GroupRef[] = [];
    for (let si = 0; si < sections.length; si++) {
      const widget = elementorData[si].elements[0].elements[0];
      for (const g of sections[si].groups) {
        allGroups.push({ kind: g.kind, sectionIndex: si, controls: g.controls, settings: widget.settings });
      }
    }

    const headingGroup = allGroups.find((g) => g.kind === "heading");
    const linkGroup = allGroups.find((g) => g.kind === "link" || g.kind === "button");
    const imageGroup = allGroups.find((g) => g.kind === "image");
    const listGroup = allGroups.find((g) => g.kind === "list");
    assert.ok(headingGroup, "expected at least one heading group");
    assert.ok(linkGroup, "expected at least one link/button group");
    assert.ok(imageGroup, "expected at least one image group");
    assert.ok(listGroup, "expected at least one list group");

    // Mutate heading: change BOTH text and tag (h1 → h3).
    const headingTextCtl = headingGroup!.controls.find((c) => c.key.endsWith("_text"))!;
    const headingTagCtl = headingGroup!.controls.find((c) => c.key.endsWith("_tag"))!;
    const headingOriginalText = headingTextCtl.default;
    const headingOriginalTag = headingTagCtl.default;
    const headingMutatedText = "MUTATED Heading XYZ";
    const headingMutatedTag = headingOriginalTag === "h3" ? "h4" : "h3";
    headingGroup!.settings[headingTextCtl.key] = headingMutatedText;
    headingGroup!.settings[headingTagCtl.key] = headingMutatedTag;

    // Mutate link/button: change URL + nofollow flag.
    const linkUrlCtl = linkGroup!.controls.find((c) => c.type === "url")!;
    const linkOriginalUrl = linkUrlCtl.default;
    const linkMutatedUrl = "https://example.com/mutated-target";
    linkGroup!.settings[linkUrlCtl.key] = {
      url: linkMutatedUrl,
      is_external: true,
      nofollow: true,
    };

    // Mutate image: change src to an external URL + alt text.
    const imageMediaCtl = imageGroup!.controls.find((c) => c.type === "media")!;
    const imageAltCtl = imageGroup!.controls.find((c) => c.key.endsWith("_alt"));
    const imageOriginalUrl = imageMediaCtl.default;
    const imageMutatedUrl = "https://example.com/mutated-image.png";
    imageGroup!.settings[imageMediaCtl.key] = { url: imageMutatedUrl, id: 0 };
    let imageMutatedAlt: string | null = null;
    if (imageAltCtl) {
      imageMutatedAlt = "MUTATED alt text " + Math.random().toString(36).slice(2, 8);
      imageGroup!.settings[imageAltCtl.key] = imageMutatedAlt;
    }

    // Mutate list items: replace defaults with new lines.
    const listItemsCtl = listGroup!.controls[0];
    const listOriginalItems = listItemsCtl.default;
    const listMutatedItems = "Mutated-Alpha\nMutated-Beta\nMutated-Gamma";
    listGroup!.settings[listItemsCtl.key] = listMutatedItems;

    const apply = run(
      "php",
      [path.join(__dirname, "apply-elementor.php"), WP_DIR, projectSlug, pageSlug, projectName],
      { input: JSON.stringify(elementorData) },
    );
    assert.equal(apply.status, 0, `apply-elementor.php failed:\n${apply.stderr}`);
    const pageId = parseInt(apply.stdout.trim(), 10);
    assert.ok(Number.isFinite(pageId) && pageId > 0, `unexpected page id: ${apply.stdout}`);

    const res = await fetch(`${base}/?page_id=${pageId}`);
    assert.equal(res.status, 200, `WP responded ${res.status}\nserver stderr:\n${serverErr}`);
    const html = await res.text();
    const bodyStart = html.indexOf("<body");
    const renderedBody = bodyStart >= 0 ? html.slice(bodyStart) : html;

    // 1. Heading text + tag swap.
    assert.ok(
      renderedBody.includes(headingMutatedText),
      `mutated heading text "${headingMutatedText}" missing from rendered body`,
    );
    assert.ok(
      !renderedBody.includes(headingOriginalText),
      `original heading text "${headingOriginalText}" should be replaced after mutation`,
    );
    const tagPattern = new RegExp(`<${headingMutatedTag}[^>]*>[^<]*${headingMutatedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    assert.match(
      renderedBody,
      tagPattern,
      `mutated heading should render inside <${headingMutatedTag}> after tag swap`,
    );

    // 2. Link URL + nofollow.
    assert.ok(
      renderedBody.includes(linkMutatedUrl),
      `mutated link URL "${linkMutatedUrl}" missing from rendered body`,
    );
    assert.ok(
      !renderedBody.includes(`href="${linkOriginalUrl}"`),
      `original link href "${linkOriginalUrl}" should not survive mutation`,
    );
    // The nofollow / target=_blank metadata must end up on the SAME
    // anchor element whose href we mutated — not on some other random
    // <a> in the page that incidentally carries rel="nofollow".
    const mutatedDom = new JSDOM(html);
    const mutatedAnchor = Array.from(mutatedDom.window.document.querySelectorAll("a"))
      .find((a) => a.getAttribute("href") === linkMutatedUrl);
    assert.ok(
      mutatedAnchor,
      `mutated <a href="${linkMutatedUrl}"> not found in rendered DOM`,
    );
    const mutatedRel = mutatedAnchor!.getAttribute("rel") ?? "";
    assert.match(
      mutatedRel,
      /\bnofollow\b/,
      `mutated anchor rel must include "nofollow", got: rel="${mutatedRel}"`,
    );
    assert.equal(
      mutatedAnchor!.getAttribute("target"),
      "_blank",
      `mutated anchor with is_external=true must render target="_blank"`,
    );
    assert.ok(
      !mutatedAnchor!.hasAttribute("data-wpb-link"),
      "data-wpb-link marker must be stripped from rendered output",
    );

    // 3. Image src + alt.
    assert.ok(
      renderedBody.includes(imageMutatedUrl),
      `mutated image src "${imageMutatedUrl}" missing from rendered body`,
    );
    assert.ok(
      !renderedBody.includes(imageOriginalUrl),
      `original image src "${imageOriginalUrl}" should not survive mutation`,
    );
    if (imageMutatedAlt) {
      assert.ok(
        renderedBody.includes(imageMutatedAlt),
        `mutated alt text "${imageMutatedAlt}" missing from rendered body`,
      );
    }

    // 4. List items.
    for (const item of ["Mutated-Alpha", "Mutated-Beta", "Mutated-Gamma"]) {
      assert.ok(
        renderedBody.includes(item),
        `mutated list item "${item}" missing from rendered body`,
      );
    }
    for (const original of listOriginalItems.split("\n")) {
      assert.ok(
        !renderedBody.includes(`<li>${original}</li>`),
        `original list item "${original}" should not survive mutation`,
      );
    }
  });

  for (const fx of FIXTURES) {
    await t.test(`${fx.file}`, async () => {
      const fixturePath = path.join(FIXTURE_DIR, fx.file);
      const fixture = readFileSync(fixturePath, "utf8");
      const sections = extractSectionsFromPage(fixture, fx.pageSlug, fx.projectSlug);
      assert.equal(
        sections.length,
        fx.expectedSectionCount,
        `${fx.file}: expected ${fx.expectedSectionCount} extracted sections, got ${sections.length}`,
      );

      // Re-extract the theme. The gutenberg subtest above already
      // populated this dir, but re-extracting keeps each subtest
      // independently runnable (e.g. with --test-name-pattern).
      buildAndExtractTheme(fx, sections);

      const elementorData = composeElementorData({
        slug: fx.pageSlug,
        title: fx.projectName,
        sections,
      });
      assert.equal(
        elementorData.length,
        sections.length,
        `${fx.file}: composeElementorData should emit one top-level section per extracted section`,
      );

      const apply = run(
        "php",
        [
          path.join(__dirname, "apply-elementor.php"),
          WP_DIR,
          fx.projectSlug,
          fx.pageSlug,
          fx.projectName,
        ],
        { input: JSON.stringify(elementorData) },
      );
      assert.equal(apply.status, 0, `${fx.file}: apply-elementor.php failed:\n${apply.stderr}`);
      const pageId = parseInt(apply.stdout.trim(), 10);
      assert.ok(Number.isFinite(pageId) && pageId > 0, `${fx.file}: unexpected page id: ${apply.stdout}`);

      const res = await fetch(`${base}/?page_id=${pageId}`);
      assert.equal(res.status, 200, `${fx.file}: WP responded ${res.status}\nserver stderr:\n${serverErr}`);
      const html = await res.text();

      // Sanity: if Elementor failed to take over the_content, the page
      // is empty (apply-elementor.php deliberately stores no
      // post_content). The widget-container marker is the unambiguous
      // "Elementor rendered our widgets" signal.
      assert.ok(
        html.includes("elementor-widget-container"),
        `${fx.file}: no .elementor-widget-container in the response — ` +
          `Elementor likely did not render the page.\n` +
          `server stderr:\n${serverErr}\n` +
          `First 1200 chars:\n${html.slice(0, 1200)}`,
      );

      const dom = new JSDOM(html);
      const containers = Array.from(
        dom.window.document.querySelectorAll(".elementor-widget-container"),
      );
      const fixtureSections = topLevelSections(fixture);
      assert.equal(
        containers.length,
        fixtureSections.length,
        `${fx.file}: expected ${fixtureSections.length} elementor widget ` +
          `containers (one per fixture section), got ${containers.length}`,
      );

      // Each widget renders the same template that the Gutenberg block
      // renders, so the first element child of every widget container
      // must be the original <header>/<section>/<footer>, byte-identical
      // (after the same WP-injected-attr / theme-URI normalization) to
      // the fixture.
      for (let i = 0; i < fixtureSections.length; i++) {
        const child = containers[i].firstElementChild;
        assert.ok(
          child,
          `${fx.file}: elementor widget container #${i + 1} has no element ` +
            `child — render() likely produced empty output.\n` +
            `container HTML: ${containers[i].outerHTML.slice(0, 400)}`,
        );
        const expected = normalize(fixtureSections[i], fx.projectSlug);
        const actual = normalize(child!, fx.projectSlug);
        assert.equal(
          actual,
          expected,
          `${fx.file}: elementor widget #${i + 1} ` +
            `(${fixtureSections[i].tagName.toLowerCase()}) does not match the fixture.\n` +
            `expected: ${expected}\n` +
            `actual:   ${actual}`,
        );
      }

      // Field round-trip check: same as the Gutenberg pass — every
      // extracted field's default value must appear in the rendered
      // body. URL placeholders are rebased to absolute theme URLs.
      const bodyStart = html.indexOf("<body");
      const renderedBody = bodyStart >= 0 ? html.slice(bodyStart) : html;
      const themeUri = `/wp-content/themes/${fx.projectSlug}/assets/`;
      for (const section of sections) {
        for (const field of section.fields) {
          if (field.type === "tag") continue; // tag-swap field, value is just "h1".."h6"
          const rebased = field.default.includes("{{THEME_URI}}/assets/")
            ? field.default.replace("{{THEME_URI}}/assets/", themeUri)
            : field.default;
          // List/repeater fields are stored as a newline-joined scalar
          // but rendered as one <li> per row, so the joined string
          // never appears verbatim. Check each row instead.
          const expectedFragments = rebased.includes("\n")
            ? rebased.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
            : [rebased];
          for (const expected of expectedFragments) {
            assert.ok(
              renderedBody.includes(expected),
              `${fx.file}: field "${field.key}" (${field.type}) from block ` +
                `${section.blockName} did not appear in the elementor-rendered page.\n` +
                `expected to find: ${expected}`,
            );
          }
        }
      }

      // Semantic-groups assertion: every section must expose at least one
      // group, and the composed Elementor settings for each group's
      // controls must use the native control-shape Elementor expects
      // (URL → {url, is_external, nofollow}, MEDIA → {url, id}, others
      // are scalars). The widget-page.html fixture has been crafted to
      // exercise every supported group kind so this asserts an example
      // of each.
      type ElData = Array<{ elements: Array<{ elements: Array<{ widgetType: string; settings: Record<string, unknown> }> }> }>;
      const composed = elementorData as ElData;
      const seenKinds = new Set<string>();
      for (let si = 0; si < sections.length; si++) {
        const section = sections[si];
        assert.ok(
          section.groups.length > 0,
          `${fx.file}: section #${si + 1} (${section.blockName}) has no semantic groups — ` +
            `the smart Elementor controls UI requires at least one group per section.`,
        );
        const widget = composed[si].elements[0].elements[0];
        for (const g of section.groups) {
          seenKinds.add(g.kind);
          for (const c of g.controls) {
            const v = widget.settings[c.key];
            assert.ok(
              v !== undefined,
              `${fx.file}: control "${c.key}" (group ${g.id}/${g.kind}) missing from composed widget settings`,
            );
            if (c.type === "url") {
              assert.equal(typeof v, "object", `${fx.file}: URL control ${c.key} must be an object`);
              assert.equal((v as { url?: string }).url, c.default, `${fx.file}: URL control ${c.key} must carry .url = default`);
              assert.ok("is_external" in (v as object), `${fx.file}: URL control ${c.key} missing is_external`);
              assert.ok("nofollow" in (v as object), `${fx.file}: URL control ${c.key} missing nofollow`);
            } else if (c.type === "media") {
              assert.equal(typeof v, "object", `${fx.file}: MEDIA control ${c.key} must be an object`);
              assert.equal((v as { url?: string }).url, c.default, `${fx.file}: MEDIA control ${c.key} must carry .url`);
              assert.ok("id" in (v as object), `${fx.file}: MEDIA control ${c.key} missing id`);
            } else if (c.type === "choose") {
              assert.equal(v, c.default, `${fx.file}: CHOOSE control ${c.key} must default to ${c.default}`);
              assert.ok(Array.isArray(c.options) && c.options.length > 0, `${fx.file}: CHOOSE control ${c.key} must declare options`);
            } else if (c.type === "repeater") {
              assert.ok(Array.isArray(v), `${fx.file}: REPEATER control ${c.key} must seed an array of rows`);
              const rows = v as Array<{ item?: string }>;
              const expected = (c.default ?? "")
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              assert.equal(rows.length, expected.length, `${fx.file}: REPEATER control ${c.key} row count mismatch`);
              for (let i = 0; i < expected.length; i++) {
                assert.equal(rows[i]?.item, expected[i], `${fx.file}: REPEATER row ${i} item mismatch`);
              }
            } else {
              assert.equal(v, c.default, `${fx.file}: TEXT control ${c.key} must default to its scalar value`);
            }
          }
        }
      }
      // The widget-page.html fixture is the one that must exercise all
      // group kinds end-to-end. The other fixtures are noisier so we
      // only require their group settings round-trip correctly above.
      if (fx.file === "widget-page.html") {
        for (const required of ["button", "link", "image", "heading", "text"] as const) {
          assert.ok(
            seenKinds.has(required),
            `${fx.file}: expected at least one "${required}" group across all sections, ` +
              `got: [${Array.from(seenKinds).join(", ")}]`,
          );
        }
      }
    });
  }
});
