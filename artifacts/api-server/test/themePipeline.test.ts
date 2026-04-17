import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import AdmZip from "adm-zip";

import { extractSectionsFromPage } from "../src/lib/sectionFieldExtractor";
import { composeGutenbergContent } from "../src/lib/pixelPerfectComposer";
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

test("composeGutenbergContent emits one block comment per section with attrs", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const content = composeGutenbergContent({ slug: PAGE_SLUG, title: "Home", sections });
  const matches = content.match(/<!-- wp:wpb-fixture-site\/[^ ]+ \{[\s\S]*?\} \/-->/g) ?? [];
  assert.equal(matches.length, sections.length, "one block comment per section");
});

test("generateThemeZip produces a valid child theme bundle", () => {
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
  ]) {
    assert.ok(entries.includes(required), `theme zip must contain ${required}`);
  }

  // style.css carries the WP theme header
  const styleCss = zip.getEntry(`${root}/style.css`)!.getData().toString("utf8");
  assert.match(styleCss, /Theme Name:\s*Fixture Site/);

  // One block.json + render.php + template.html per extracted section
  const blockJsons = entries.filter((n) => n.startsWith(`${root}/blocks/`) && n.endsWith("/block.json"));
  assert.equal(blockJsons.length, sections.length, "one block.json per section");

  for (const section of sections) {
    const dir = section.blockName.split("/")[1];
    assert.ok(entries.includes(`${root}/blocks/${dir}/block.json`));
    assert.ok(entries.includes(`${root}/blocks/${dir}/render.php`));
    assert.ok(entries.includes(`${root}/blocks/${dir}/template.html`));
    assert.ok(entries.includes(`${root}/widgets/widget-${dir}.php`));

    const json = JSON.parse(zip.getEntry(`${root}/blocks/${dir}/block.json`)!.getData().toString("utf8"));
    assert.equal(json.name, section.blockName);
    assert.equal(typeof json.attributes, "object");
    for (const f of section.fields) {
      assert.ok(json.attributes[f.key], `block.json for ${section.blockName} must declare attribute ${f.key}`);
    }
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

  // Sanity: we expect at least the canonical templates the generator emits.
  const names = phpEntries.map((e) => e.entryName.replace(/\\/g, "/"));
  for (const required of ["functions.php", "index.php", "page.php", "header.php", "footer.php", "widgets/_base-widget.php"]) {
    assert.ok(
      names.some((n) => n.endsWith("/" + required)),
      `expected generated theme to include ${required}`,
    );
  }
  assert.ok(names.some((n) => /\/blocks\/[^/]+\/render\.php$/.test(n)), "expected at least one block render.php");
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
  // A minimal but representative PHP snippet covering features used by
  // the generator: comments, single + double-quoted strings with escapes,
  // nested arrays/closures, and a conditional class definition.
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

  // Drop the final closing brace — the kind of regression the previous
  // structure-only test would have happily shipped.
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
  assert.ok(jsEntries.length > 0, "theme must contain JS files");

  const names = jsEntries.map((e) => e.entryName.replace(/\\/g, "/"));
  assert.ok(names.some((n) => n.endsWith("/assets/editor.js")), "expected editor.js in the theme");
  assert.ok(names.some((n) => n.endsWith("/assets/template.js")), "expected template.js when combinedJs provided");

  for (const entry of jsEntries) {
    const src = entry.getData().toString("utf8");
    const result = checkJsSyntax(src, entry.entryName);
    assert.ok(result.ok, `JS syntax error in ${entry.entryName}: ${result.error}`);
  }
});

test("checkJsSyntax accepts the editor.js shape the generator emits", () => {
  const sample = `(function(){
    var x = { a: 1, b: [1,2,3] };
    function f(n){ return "v:" + n; }
    return f(x.a);
  })();`;
  const result = checkJsSyntax(sample, "sample.js");
  assert.ok(result.ok, `expected sample to pass: ${result.error}`);
});

test("checkJsSyntax catches a syntax error introduced into a generated JS template", () => {
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
  const editor = zip.getEntries().find((e) => e.entryName.endsWith("/assets/editor.js"))!;
  const original = editor.getData().toString("utf8");

  // Drop the trailing `})();` — the kind of typo a future edit to EDITOR_JS could ship.
  const broken = original.replace(/\}\)\(\)\s*;\s*$/m, "");
  assert.notEqual(broken, original, "test scaffolding failed to mutate editor.js");

  const result = checkJsSyntax(broken, "assets/editor.js");
  assert.equal(result.ok, false, "validator must flag the unbalanced IIFE");
});

test("checkJsSyntax flags an unterminated string", () => {
  const broken = `var x = 'oops;\n`;
  const result = checkJsSyntax(broken, "broken.js");
  assert.equal(result.ok, false);
});


// ----------------------------------------------------------------------
// Parameterized fixture coverage
//
// The simple-page.html-only assertions above lock down the happy path.
// The tests below run the full extract → compose → generate pipeline
// against every fixture in ALL_FIXTURES so richer real-world layouts
// (nested grids, image-heavy heroes with inline background-image
// styles, inline SVGs, multi-column footers) are exercised without
// having to spin up WordPress.
// ----------------------------------------------------------------------

for (const fx of ALL_FIXTURES) {
  test(`[${fx.file}] extract → compose → generate produces a valid theme bundle`, () => {
    const html = readFileSync(path.join(__dirname, "fixtures", fx.file), "utf8");
    const sections = extractSectionsFromPage(html, fx.pageSlug, fx.projectSlug);
    assert.ok(
      sections.length >= fx.minSections,
      `${fx.file}: expected at least ${fx.minSections} sections, got ${sections.length}`,
    );

    // Every section must declare at least one editable field — otherwise
    // the upstream "no missing field values" guarantee is meaningless.
    for (const s of sections) {
      assert.ok(s.fields.length > 0, `${fx.file}: ${s.blockName} produced zero fields`);
      // Field keys must be unique within a section so block.json
      // attributes don't clobber each other.
      const keys = s.fields.map((f) => f.key);
      assert.equal(new Set(keys).size, keys.length, `${fx.file}: duplicate field keys in ${s.blockName}: ${keys.join(",")}`);
    }

    // Composition must emit one self-closing block comment per section
    // and carry every field's default in the JSON attribute payload.
    const content = composeGutenbergContent({ slug: fx.pageSlug, title: fx.pageSlug, sections });
    const matches = content.match(new RegExp(`<!-- wp:wpb-${fx.projectSlug}/[^ ]+ \\{[\\s\\S]*?\\} /-->`, "g")) ?? [];
    assert.equal(matches.length, sections.length, `${fx.file}: one block comment per section`);

    // Theme zip must contain the canonical files plus per-section
    // assets, and every block.json must declare every field as an
    // attribute — this is the "no missing field values" invariant the
    // e2e check relies on.
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
    ]) {
      assert.ok(entries.includes(required), `${fx.file}: theme zip must contain ${required}`);
    }
    for (const section of sections) {
      const dir = section.blockName.split("/")[1];
      const blockJsonEntry = zip.getEntry(`${fx.projectSlug}/blocks/${dir}/block.json`);
      assert.ok(blockJsonEntry, `${fx.file}: missing block.json for ${section.blockName}`);
      const json = JSON.parse(blockJsonEntry!.getData().toString("utf8"));
      for (const f of section.fields) {
        assert.ok(
          json.attributes[f.key],
          `${fx.file}: block.json for ${section.blockName} must declare attribute ${f.key}`,
        );
        assert.equal(
          json.attributes[f.key].default,
          f.default,
          `${fx.file}: ${section.blockName} attribute ${f.key} default mismatch`,
        );
      }
    }

    // Every PHP file must parse cleanly — richer fixtures could expose
    // escaping bugs in our PHP code generator that simple-page misses.
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
  // Inline background-image url() in the hero <section> must be rebased
  // so the rendered theme can resolve it against the bundled assets/.
  assert.match(
    hero!.template,
    /background-image:url\(\{\{THEME_URI\}\}\/assets\/images\/hero-bg\.jpg\)/,
    "hero inline background-image url() must be rewritten to a {{THEME_URI}}/assets/ placeholder",
  );
  // And the hero should expose multiple image url fields (logo isn't
  // here — that's in the header — but the screenshot is).
  const urlFields = hero!.fields.filter((f) => f.type === "url");
  assert.ok(urlFields.length >= 2, `hero should expose multiple url fields, got ${urlFields.length}`);
});
