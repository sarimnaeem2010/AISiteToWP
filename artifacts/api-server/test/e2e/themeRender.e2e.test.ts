/**
 * End-to-end check that generated themes render correctly inside a real
 * WordPress install. Opt-in: only runs when RUN_WP_E2E=1, because it
 * downloads WordPress and boots the PHP built-in server (slow).
 *
 *   RUN_WP_E2E=1 pnpm --filter @workspace/api-server test:e2e
 *
 * The first run downloads ~30MB and installs WordPress into
 * /tmp/wpb-e2e/wp (override with WPB_E2E_DIR). Subsequent runs reuse it.
 *
 * Flow (per fixture, per editor mode):
 *   1. setup-wp.sh   — ensures WP + SQLite drop-in + Elementor + installer have run
 *   2. generate the theme zip from the fixture HTML
 *   3. extract the theme into wp-content/themes/<slug>/
 *   4. apply-theme.php (Gutenberg) or apply-elementor.php (Elementor) —
 *      activates theme, creates a page from composed block / Elementor data
 *   5. boot `php -S` against the WP dir (once, reused across fixtures)
 *   6. fetch the page HTML and assert that every section's text/url/alt
 *      field round-trips back into the rendered output
 *
 * Each fixture in FIXTURES gets its own theme + page, so the loops also
 * verify that the generator can install multiple themes side-by-side
 * without colliding. The Elementor pass reuses the same generated themes
 * but exercises the Elementor widget render path instead of Gutenberg
 * blocks, catching regressions specific to the Elementor editor.
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
import {
  composeGutenbergContent,
  composeElementorData,
} from "../../src/lib/pixelPerfectComposer";
import { generateThemeZip } from "../../src/lib/themeGenerator";

const ENABLED = process.env.RUN_WP_E2E === "1";
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
 * deterministic. Shared by both the Gutenberg and Elementor passes
 * because they exercise the same generated theme — only the editor that
 * drives the page differs.
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

test("uploaded themes render end-to-end inside WordPress", { skip: !ENABLED }, async (t) => {
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

  for (const fx of FIXTURES) {
    await t.test(`${fx.file} (gutenberg)`, async () => {
      // 2. Generate theme zip from fixture.
      const fixturePath = path.join(FIXTURE_DIR, fx.file);
      const fixture = readFileSync(fixturePath, "utf8");
      const sections = extractSectionsFromPage(fixture, fx.pageSlug, fx.projectSlug);
      assert.equal(
        sections.length,
        fx.expectedSectionCount,
        `${fx.file}: expected ${fx.expectedSectionCount} extracted sections, got ${sections.length}`,
      );

      // 3. Wipe + extract into wp-content/themes/<slug>.
      buildAndExtractTheme(fx, sections);

      // 4. Compose page content + activate theme + insert page.
      const content = composeGutenbergContent({ slug: fx.pageSlug, title: fx.projectName, sections });
      const apply = run(
        "php",
        [path.join(__dirname, "apply-theme.php"), WP_DIR, fx.projectSlug, fx.pageSlug, fx.projectName],
        { input: content },
      );
      assert.equal(apply.status, 0, `${fx.file}: apply-theme.php failed:\n${apply.stderr}`);
      const pageId = parseInt(apply.stdout.trim(), 10);
      assert.ok(Number.isFinite(pageId) && pageId > 0, `${fx.file}: unexpected page id: ${apply.stdout}`);

      // 5. Fetch the rendered page and diff fields against the response.
      const res = await fetch(`${base}/?page_id=${pageId}`);
      assert.equal(res.status, 200, `${fx.file}: WP responded ${res.status}\nserver stderr:\n${serverErr}`);
      const html = await res.text();

      // Sanity: if functions.php errored, the block comment falls through
      // to the raw `<!-- wp:wpb-... -->` text. Catch that early with a
      // clearer message than the structural diff would give.
      assert.ok(
        !html.includes(`<!-- wp:wpb-${fx.projectSlug}/`),
        `${fx.file}: block comments were not replaced by rendered HTML — ` +
          `register_block_type likely failed.\nserver stderr:\n${serverErr}\n` +
          `First 800 chars:\n${html.slice(0, 800)}`,
      );

      // Real diff: every top-level <header>/<section>/<footer> from the
      // fixture must appear, in order, in the rendered body, and each
      // pair's normalized markup must match exactly (after stripping the
      // well-known WP mutations: injected attrs + absolute theme-URI
      // rewrites).
      const fixtureSections = topLevelSections(fixture);
      const renderedSections = topLevelSections(html);
      assert.equal(
        renderedSections.length,
        fixtureSections.length,
        `${fx.file}: rendered page should contain ${fixtureSections.length} ` +
          `top-level sections, got ${renderedSections.length}.\n` +
          `rendered body sample:\n${html.slice(html.indexOf("<body"), html.indexOf("<body") + 2000)}`,
      );

      for (let i = 0; i < fixtureSections.length; i++) {
        const expected = normalize(fixtureSections[i], fx.projectSlug);
        const actual = normalize(renderedSections[i], fx.projectSlug);
        assert.equal(
          actual,
          expected,
          `${fx.file}: section #${i + 1} (${fixtureSections[i].tagName.toLowerCase()}) ` +
            `does not match the fixture.\n` +
            `expected: ${expected}\n` +
            `actual:   ${actual}`,
        );
      }

      // Field round-trip check: every extracted field's default value
      // must appear somewhere in the rendered page body. The structural
      // diff above already implies this, but checking each field by name
      // gives a far clearer failure if a single attribute went missing
      // (e.g. block.json forgot to declare it, or render.php dropped the
      // placeholder).
      const bodyStart = html.indexOf("<body");
      const renderedBody = bodyStart >= 0 ? html.slice(bodyStart) : html;
      const themeUri = `/wp-content/themes/${fx.projectSlug}/assets/`;
      for (const section of sections) {
        for (const field of section.fields) {
          // For URL fields whose default is a {{THEME_URI}} placeholder
          // (relative asset paths get rebased during extraction), check
          // for the rebased asset URL the renderer actually emits.
          const expected = field.default.includes("{{THEME_URI}}/assets/")
            ? field.default.replace("{{THEME_URI}}/assets/", themeUri)
            : field.default;
          assert.ok(
            renderedBody.includes(expected),
            `${fx.file}: field "${field.key}" (${field.type}) from block ` +
              `${section.blockName} did not appear in the rendered page.\n` +
              `expected to find: ${expected}`,
          );
        }
      }
    });
  }

  // Elementor pass: same fixtures, same generated themes, but the page
  // is driven by Elementor's frontend instead of Gutenberg blocks. This
  // catches regressions in the Elementor editor path that the Gutenberg
  // pass would silently miss — typos in widget class names, broken
  // get_settings_for_display, mis-wired register hooks, etc. We use a
  // distinct page slug per fixture so the Gutenberg page above stays
  // untouched (`apply-elementor.php` is otherwise identical in shape).
  for (const fx of FIXTURES) {
    await t.test(`${fx.file} (elementor)`, async () => {
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

      const elementorPageSlug = `${fx.pageSlug}-elementor`;
      const apply = run(
        "php",
        [
          path.join(__dirname, "apply-elementor.php"),
          WP_DIR,
          fx.projectSlug,
          elementorPageSlug,
          `${fx.projectName} (Elementor)`,
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
          const expected = field.default.includes("{{THEME_URI}}/assets/")
            ? field.default.replace("{{THEME_URI}}/assets/", themeUri)
            : field.default;
          assert.ok(
            renderedBody.includes(expected),
            `${fx.file}: field "${field.key}" (${field.type}) from block ` +
              `${section.blockName} did not appear in the elementor-rendered page.\n` +
              `expected to find: ${expected}`,
          );
        }
      }
    });
  }
});
