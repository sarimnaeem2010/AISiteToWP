/**
 * End-to-end check that a generated theme renders correctly inside a real
 * WordPress install. Opt-in: only runs when RUN_WP_E2E=1, because it
 * downloads WordPress and boots the PHP built-in server (slow).
 *
 *   RUN_WP_E2E=1 pnpm --filter @workspace/api-server test:e2e
 *
 * The first run downloads ~30MB and installs WordPress into
 * /tmp/wpb-e2e/wp (override with WPB_E2E_DIR). Subsequent runs reuse it.
 *
 * Flow:
 *   1. setup-wp.sh   — ensures WP + SQLite drop-in + installer have run
 *   2. generate the theme zip from test/fixtures/simple-page.html
 *   3. extract the theme into wp-content/themes/<slug>/
 *   4. apply-theme.php — activates theme, creates a page from composed
 *      Gutenberg content
 *   5. boot `php -S` against the WP dir
 *   6. fetch the page HTML and assert that every section's text/url/alt
 *      field round-trips back into the rendered output
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

import { extractSectionsFromPage } from "../../src/lib/sectionFieldExtractor";
import { composeGutenbergContent } from "../../src/lib/pixelPerfectComposer";
import { generateThemeZip } from "../../src/lib/themeGenerator";

const ENABLED = process.env.RUN_WP_E2E === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WP_DIR = process.env.WPB_E2E_DIR ?? "/tmp/wpb-e2e/wp";
const FIXTURE_PATH = path.resolve(__dirname, "../fixtures/simple-page.html");
const PROJECT_SLUG = "fixture-site";
const PROJECT_NAME = "Fixture Site";
const PAGE_SLUG = "home";

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
 *     URL like `http://localhost/wp-content/themes/<slug>/assets/X`
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

  const themeAssetPrefix = new RegExp(`^https?://[^/]+/wp-content/themes/${themeSlug}/assets/`);

  const walk = (node: Element): void => {
    for (const a of Array.from(node.attributes)) {
      if (WP_INJECTED_ATTRS.has(a.name)) {
        node.removeAttribute(a.name);
        continue;
      }
      if (a.name === "src" || a.name === "href") {
        const v = a.value.replace(themeAssetPrefix, "");
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

test("uploaded theme renders end-to-end inside WordPress", { skip: !ENABLED }, async (t) => {
  // 1. Bootstrap WordPress.
  const setup = run("bash", [path.join(__dirname, "setup-wp.sh")]);
  assert.equal(setup.status, 0, `setup-wp.sh failed:\n${setup.stderr}`);

  // 2. Generate theme zip from the same fixture used by the unit tests.
  const fixture = readFileSync(FIXTURE_PATH, "utf8");
  const sections = extractSectionsFromPage(fixture, PAGE_SLUG, PROJECT_SLUG);
  assert.ok(sections.length > 0, "fixture must yield at least one section");

  const themeZip = generateThemeZip({
    projectName: PROJECT_NAME,
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });

  // 3. Wipe + extract into wp-content/themes/<slug>.
  const themesDir = path.join(WP_DIR, "wp-content/themes", PROJECT_SLUG);
  rmSync(themesDir, { recursive: true, force: true });
  mkdirSync(themesDir, { recursive: true });
  const ad = new AdmZip(themeZip);
  // Entries are namespaced by `${PROJECT_SLUG}/...`; strip that prefix when
  // extracting so files land directly under wp-content/themes/<slug>/.
  for (const e of ad.getEntries()) {
    if (e.isDirectory) continue;
    const rel = e.entryName.replace(/^[^/]+\//, "");
    const dest = path.join(themesDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, e.getData());
  }

  // 4. Compose page content + activate theme + insert page.
  const content = composeGutenbergContent({ slug: PAGE_SLUG, title: "Home", sections });
  const apply = run(
    "php",
    [path.join(__dirname, "apply-theme.php"), WP_DIR, PROJECT_SLUG, PAGE_SLUG, "Home"],
    { input: content },
  );
  assert.equal(apply.status, 0, `apply-theme.php failed:\n${apply.stderr}`);
  const pageId = parseInt(apply.stdout.trim(), 10);
  assert.ok(Number.isFinite(pageId) && pageId > 0, `unexpected page id: ${apply.stdout}`);

  // 5. Boot php -S in the background.
  const port = 18000 + Math.floor(Math.random() * 1000);
  const router = path.join(__dirname, "router.php");
  const server = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", WP_DIR, router], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (b) => { serverErr += b.toString(); });
  t.after(() => { server.kill("SIGTERM"); });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base + "/?p=" + pageId);

  // 6. Fetch the rendered page and diff field defaults against the response.
  const res = await fetch(`${base}/?page_id=${pageId}`);
  assert.equal(res.status, 200, `WP responded ${res.status}\nserver stderr:\n${serverErr}`);
  const html = await res.text();

  // Sanity: if functions.php errored, the block comment falls through to
  // the raw `<!-- wp:wpb-... -->` text. Catch that early with a clearer
  // message than the structural diff would give.
  assert.ok(
    !html.includes("<!-- wp:wpb-fixture-site/"),
    "block comments were not replaced by rendered HTML — register_block_type likely failed.\nserver stderr:\n" + serverErr + "\nFirst 800 chars:\n" + html.slice(0, 800),
  );

  // Real diff: every top-level <header>/<section>/<footer> from the
  // fixture must appear, in order, in the rendered body, and each pair's
  // normalized markup must match exactly (after stripping the well-known
  // WP mutations: injected attrs + absolute theme-URI rewrites).
  const fixtureSections = topLevelSections(fixture);
  const renderedSections = topLevelSections(html);
  assert.equal(
    renderedSections.length,
    fixtureSections.length,
    `rendered page should contain ${fixtureSections.length} top-level sections, got ${renderedSections.length}.\nrendered body sample:\n${html.slice(html.indexOf("<body"), html.indexOf("<body") + 2000)}`,
  );

  for (let i = 0; i < fixtureSections.length; i++) {
    const expected = normalize(fixtureSections[i], PROJECT_SLUG);
    const actual = normalize(renderedSections[i], PROJECT_SLUG);
    assert.equal(
      actual,
      expected,
      `section #${i + 1} (${fixtureSections[i].tagName.toLowerCase()}) does not match the fixture.\n` +
        `expected: ${expected}\n` +
        `actual:   ${actual}`,
    );
  }
});
