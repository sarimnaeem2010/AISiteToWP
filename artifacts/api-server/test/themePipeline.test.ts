import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import AdmZip from "adm-zip";
import * as csstree from "css-tree";

import { extractSectionsFromPage } from "../src/lib/sectionFieldExtractor";
import { generateThemeZip } from "../src/lib/themeGenerator";
import { checkPhpSyntax } from "../src/lib/phpSyntaxCheck";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(__dirname, "fixtures/simple-page.html"), "utf8");

const PAGE_SLUG = "home";
const PROJECT_SLUG = "fixture-site";

/**
 * Fixtures that the parameterized "every fixture round-trips" tests at
 * the bottom of this file iterate over. Add a new entry here whenever a
 * new HTML pattern from real uploads needs the unit-level coverage too.
 */
const ALL_FIXTURES: Array<{ file: string; pageSlug: string; projectSlug: string; minSections: number }> = [
  { file: "simple-page.html", pageSlug: "home", projectSlug: "fixture-site", minSections: 4 },
  { file: "complex-page.html", pageSlug: "complex-home", projectSlug: "complex-fixture-site", minSections: 4 },
  { file: "widget-page.html", pageSlug: "widget-home", projectSlug: "widget-fixture-site", minSections: 3 },
];

test("extractSectionsFromPage finds the expected top-level sections", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  // header, hero section, features section, footer = 4 top-level semantic blocks
  assert.equal(sections.length, 4, "fixture should yield 4 top-level sections");

  const categories = sections.map((s) => s.category);
  assert.deepEqual(categories, ["navigation", "hero", "features", "footer"]);

  for (const s of sections) {
    assert.match(s.blockName, /^wpb-fixture-site\/sec-\d+-[a-z]+-[0-9a-f]{8}$/);
    assert.ok(s.fields.length > 0, `${s.blockName} should expose at least one field`);
  }

  // Hero section should contain a text field, a url field (signup link or img) and an image alt attr
  const hero = sections.find((s) => s.category === "hero")!;
  const types = new Set(hero.fields.map((f) => f.type));
  assert.ok(types.has("text"), "hero should expose text fields");
  assert.ok(types.has("url"), "hero should expose url fields");
  assert.ok(types.has("attr"), "hero should expose attr fields (image alt)");

  // Features section's <ul><li>...</li></ul> must be picked up as a
  // list group with one REPEATER control whose default value seeds the
  // repeater rows from the items joined by newlines.
  const features = sections.find((s) => s.category === "features")!;
  const listGroup = features.groups.find((g) => g.kind === "list");
  assert.ok(listGroup, "features section must expose a list group");
  assert.equal(listGroup!.controls.length, 1);
  assert.equal(listGroup!.controls[0].type, "repeater");
  assert.equal(listGroup!.controls[0].default, "Fast\nReliable\nAffordable");
});

test("section block names and ids are stable across repeated extractions", () => {
  const a = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const b = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  assert.deepEqual(
    a.map((s) => s.blockName),
    b.map((s) => s.blockName),
    "block names should be deterministic for identical input",
  );
  assert.deepEqual(
    a.map((s) => s.id),
    b.map((s) => s.id),
    "section ids should be deterministic for identical input",
  );
});

test("generateThemeZip produces a valid Elementor-only child theme bundle", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const buf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, "theme zip should be a non-empty Buffer");

  const zip = new AdmZip(buf);
  const entries = zip.getEntries().map((e) => e.entryName.replace(/\\/g, "/"));
  const root = PROJECT_SLUG;

  // Required theme files
  for (const required of [
    `${root}/style.css`,
    `${root}/functions.php`,
    `${root}/index.php`,
    `${root}/page.php`,
    `${root}/header.php`,
    `${root}/footer.php`,
    `${root}/widgets/_base-widget.php`,
  ]) {
    assert.ok(entries.includes(required), `theme zip must contain ${required}`);
  }

  // The Elementor-only pivot means the generated theme MUST NOT ship
  // any Gutenberg block infrastructure: no blocks/ directory, no
  // block.json, no editor.js. Every editable surface lives inside an
  // Elementor widget loaded from widgets/.
  for (const entry of entries) {
    assert.ok(!entry.startsWith(`${root}/blocks/`), `Gutenberg block directory leaked into theme zip: ${entry}`);
    assert.ok(!entry.endsWith("/block.json"), `Gutenberg block.json leaked into theme zip: ${entry}`);
    assert.ok(!entry.endsWith("/editor.js"), `Gutenberg editor.js leaked into theme zip: ${entry}`);
  }

  // style.css carries the WP theme header
  const styleCss = zip.getEntry(`${root}/style.css`)!.getData().toString("utf8");
  assert.match(styleCss, /Theme Name:\s*Fixture Site/);

  // One widget PHP file + one template.html per extracted section
  for (const section of sections) {
    const dir = section.blockName.split("/")[1];
    assert.ok(entries.includes(`${root}/widgets/widget-${dir}.php`), `missing widget for ${section.blockName}`);
    assert.ok(entries.includes(`${root}/widgets/templates/${dir}/template.html`), `missing template for ${section.blockName}`);
  }
});

test("every PHP file in the generated theme parses cleanly", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const buf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(buf);
  const phpEntries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.endsWith(".php"));
  assert.ok(phpEntries.length > 0, "theme must contain PHP files");

  const names = phpEntries.map((e) => e.entryName.replace(/\\/g, "/"));
  for (const required of ["functions.php", "index.php", "page.php", "header.php", "footer.php", "widgets/_base-widget.php"]) {
    assert.ok(
      names.some((n) => n.endsWith("/" + required)),
      `expected generated theme to include ${required}`,
    );
  }
  assert.ok(names.some((n) => /\/widgets\/widget-[^/]+\.php$/.test(n)), "expected at least one widget-*.php");

  for (const entry of phpEntries) {
    const src = entry.getData().toString("utf8");
    const result = checkPhpSyntax(src, entry.entryName);
    assert.ok(
      result.ok,
      `PHP syntax error in ${entry.entryName} at line ${result.line}, col ${result.column}: ${result.error}`,
    );
  }
});

test("checkPhpSyntax accepts the well-formed templates the generator emits", () => {
  const sample = `<?php
// line comment
# hash comment
/* block
   comment */
if ( ! defined( 'ABSPATH' ) ) exit;
$arr = array( 'a' => "b", 'c' => array( 1, 2, 3 ) );
$cb = function ( $x ) use ( $arr ) {
    return "value: {$x} \\\\ \\"end\\"";
};
class Foo {
    public function bar() { return '{not a real brace'; }
}
`;
  const result = checkPhpSyntax(sample, "sample.php");
  assert.ok(result.ok, `expected sample to pass: ${result.error}`);
});

test("checkPhpSyntax catches a syntax error introduced into a generated template", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const buf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(buf);
  const fnEntry = zip.getEntries().find((e) => e.entryName.endsWith("/functions.php"))!;
  const original = fnEntry.getData().toString("utf8");

  const broken = original.replace(/\}\s*\)\s*;\s*$/m, ");");
  assert.notEqual(broken, original, "test scaffolding failed to mutate functions.php");

  const result = checkPhpSyntax(broken, "functions.php");
  assert.equal(result.ok, false, "validator must flag the unbalanced brace");
});

test("checkPhpSyntax flags an unterminated string", () => {
  const broken = `<?php\n$x = 'oops;\n`;
  const result = checkPhpSyntax(broken, "broken.php");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /unterminated single-quoted string/);
});

test("checkPhpSyntax flags a mismatched bracket type", () => {
  const broken = `<?php\nfunction f( $x ] { return $x; }\n`;
  const result = checkPhpSyntax(broken, "broken.php");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /mismatched bracket|unmatched closing/);
});

function checkJsSyntax(src: string, filename: string): { ok: boolean; error?: string } {
  try {
    new vm.Script(src, { filename });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

test("every JS file in the generated theme parses cleanly", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const buf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}",
    combinedJs: "window.__wpb = { ready: true };",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(buf);
  const jsEntries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.endsWith(".js"));
  // The Elementor-only pivot ships no editor.js and no other generated
  // JS — the only possible .js file is the optional template.js that
  // bundles the source site's JS.
  const names = jsEntries.map((e) => e.entryName.replace(/\\/g, "/"));
  assert.ok(names.some((n) => n.endsWith("/assets/template.js")), "expected template.js when combinedJs provided");
  for (const entry of jsEntries) {
    const src = entry.getData().toString("utf8");
    const result = checkJsSyntax(src, entry.entryName);
    assert.ok(result.ok, `JS syntax error in ${entry.entryName}: ${result.error}`);
  }
});

test("template.js is omitted when combinedJs is empty", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const buf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(buf);
  const names = zip.getEntries().map((e) => e.entryName.replace(/\\/g, "/"));
  assert.ok(!names.some((n) => n.endsWith(".js")), "no JS files should ship when combinedJs is empty");
});

test("checkJsSyntax catches a syntax error in the bundled template.js", () => {
  const broken = `(function(){ var x = ; })();`;
  const result = checkJsSyntax(broken, "broken.js");
  assert.equal(result.ok, false);
});

test("checkJsSyntax flags an unterminated string", () => {
  const broken = `var x = 'oops;\n`;
  const result = checkJsSyntax(broken, "broken.js");
  assert.equal(result.ok, false);
});

function checkCssSyntax(src: string, filename: string): { ok: boolean; error?: string } {
  const errors: Array<{ message: string; line?: number; column?: number }> = [];
  try {
    csstree.parse(src, {
      filename,
      positions: true,
      onParseError: (err: { message: string; line?: number; column?: number }) => {
        errors.push({ message: err.message, line: err.line, column: err.column });
      },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (errors.length > 0) {
    const e = errors[0];
    return { ok: false, error: `${e.message}${e.line ? ` (line ${e.line}, col ${e.column})` : ""}` };
  }
  return { ok: true };
}

test("every CSS file in the generated theme parses cleanly", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const buf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}\n.hero{display:flex;gap:1rem}\n@media (min-width:768px){.hero{gap:2rem}}",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(buf);
  const cssEntries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.endsWith(".css"));
  assert.ok(cssEntries.length > 0, "theme must contain CSS files");

  const names = cssEntries.map((e) => e.entryName.replace(/\\/g, "/"));
  assert.ok(names.some((n) => n.endsWith("/style.css")), "expected style.css in the theme");
  assert.ok(names.some((n) => n.endsWith("/assets/template.css")), "expected assets/template.css in the theme");

  for (const entry of cssEntries) {
    const src = entry.getData().toString("utf8");
    const result = checkCssSyntax(src, entry.entryName);
    assert.ok(result.ok, `CSS syntax error in ${entry.entryName}: ${result.error}`);
  }
});

test("checkCssSyntax accepts representative stylesheet shapes the generator emits", () => {
  const sample = `/* comment */
body { margin: 0; padding: 0; }
.hero { display: flex; gap: 1rem; background-image: url('assets/images/x.jpg'); }
@media (min-width: 768px) { .hero { gap: 2rem; } }
@keyframes pulse { 0% { opacity: 0; } 100% { opacity: 1; } }
`;
  const result = checkCssSyntax(sample, "sample.css");
  assert.ok(result.ok, `expected sample to pass: ${result.error}`);
});

test("checkCssSyntax catches a syntax error introduced into a generated stylesheet", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const buf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "body{margin:0}\n.hero{display:flex}",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(buf);
  const tplCss = zip.getEntries().find((e) => e.entryName.endsWith("/assets/template.css"))!;
  const original = tplCss.getData().toString("utf8");

  const broken = "}\n" + original;
  assert.notEqual(broken, original, "test scaffolding failed to mutate template.css");

  const result = checkCssSyntax(broken, "assets/template.css");
  assert.equal(result.ok, false, "validator must flag the unbalanced rule");
});

test("checkCssSyntax flags a stray closing brace", () => {
  const broken = `body { color: red; } }\n`;
  const result = checkCssSyntax(broken, "broken.css");
  assert.equal(result.ok, false);
});


// ----------------------------------------------------------------------
// Parameterized fixture coverage
// ----------------------------------------------------------------------

for (const fx of ALL_FIXTURES) {
  test(`[${fx.file}] extract → generate produces a valid Elementor-only theme bundle`, () => {
    const html = readFileSync(path.join(__dirname, "fixtures", fx.file), "utf8");
    const sections = extractSectionsFromPage(html, fx.pageSlug, fx.projectSlug);
    assert.ok(
      sections.length >= fx.minSections,
      `${fx.file}: expected at least ${fx.minSections} sections, got ${sections.length}`,
    );

    for (const s of sections) {
      assert.ok(s.fields.length > 0, `${fx.file}: ${s.blockName} produced zero fields`);
      const keys = s.fields.map((f) => f.key);
      assert.equal(new Set(keys).size, keys.length, `${fx.file}: duplicate field keys in ${s.blockName}: ${keys.join(",")}`);
      // Every section must also expose at least one semantic group so
      // the Elementor sidebar has something to render.
      assert.ok(s.groups.length > 0, `${fx.file}: ${s.blockName} produced zero groups`);
    }

    const buf = generateThemeZip({
      projectName: fx.projectSlug,
      projectSlug: fx.projectSlug,
      combinedCss: "body{margin:0}",
      combinedJs: "",
      pages: [{ slug: fx.pageSlug, title: fx.pageSlug, sections }],
      sourceZip: null,
    });
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().map((e) => e.entryName.replace(/\\/g, "/"));
    for (const required of [
      `${fx.projectSlug}/style.css`,
      `${fx.projectSlug}/functions.php`,
      `${fx.projectSlug}/page.php`,
      `${fx.projectSlug}/widgets/_base-widget.php`,
    ]) {
      assert.ok(entries.includes(required), `${fx.file}: theme zip must contain ${required}`);
    }
    for (const section of sections) {
      const dir = section.blockName.split("/")[1];
      assert.ok(
        entries.includes(`${fx.projectSlug}/widgets/widget-${dir}.php`),
        `${fx.file}: missing widget for ${section.blockName}`,
      );
      assert.ok(
        entries.includes(`${fx.projectSlug}/widgets/templates/${dir}/template.html`),
        `${fx.file}: missing template for ${section.blockName}`,
      );
      // Widget PHP must embed both wpb_groups (semantic UI) and wpb_fields
      // (legacy flat lookup) JSON payloads — these are the contract the
      // Elementor base widget reads from at registration time.
      const widgetPhp = zip
        .getEntry(`${fx.projectSlug}/widgets/widget-${dir}.php`)!
        .getData()
        .toString("utf8");
      assert.match(widgetPhp, /wpb_groups\s*=\s*json_decode/, `${fx.file}: widget for ${section.blockName} missing wpb_groups`);
      assert.match(widgetPhp, /wpb_fields\s*=\s*json_decode/, `${fx.file}: widget for ${section.blockName} missing wpb_fields`);
    }

    const phpEntries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.endsWith(".php"));
    for (const entry of phpEntries) {
      const result = checkPhpSyntax(entry.getData().toString("utf8"), entry.entryName);
      assert.ok(result.ok, `${fx.file}: PHP syntax error in ${entry.entryName}: ${result.error}`);
    }
  });
}

test("[complex-page.html] image-heavy hero rebases inline background-image to {{THEME_URI}}", () => {
  const html = readFileSync(path.join(__dirname, "fixtures/complex-page.html"), "utf8");
  const sections = extractSectionsFromPage(html, "complex-home", "complex-fixture-site");
  const hero = sections.find((s) => s.category === "hero");
  assert.ok(hero, "complex-page.html should produce a hero section");
  assert.match(
    hero!.template,
    /background-image:url\(\{\{THEME_URI\}\}\/assets\/images\/hero-bg\.jpg\)/,
    "hero inline background-image url() must be rewritten to a {{THEME_URI}}/assets/ placeholder",
  );
  const urlFields = hero!.fields.filter((f) => f.type === "url");
  assert.ok(urlFields.length >= 2, `hero should expose multiple url fields, got ${urlFields.length}`);
});
