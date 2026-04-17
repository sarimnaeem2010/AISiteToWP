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
    // Each section must produce SOMETHING editable: either the legacy
    // custom-widget fields OR a native Elementor section tree.
    assert.ok(
      (s.fields && s.fields.length > 0) || s.nativeElementor,
      `${s.blockName} should expose either legacy fields or a native Elementor tree`,
    );
  }

  // Hero section: native path expresses text/url/image as widgets;
  // legacy path expresses them as fields. Verify whichever shape the
  // extractor chose carries equivalent surfaces.
  const hero = sections.find((s) => s.category === "hero")!;
  if (hero.nativeElementor) {
    const json = JSON.stringify(hero.nativeElementor);
    assert.match(json, /"widgetType":"heading"/, "hero must include a heading widget");
    assert.match(json, /"widgetType":"image"/, "hero must include an image widget");
    assert.match(json, /"alt":"/, "hero image must carry alt text");
    assert.match(json, /"url":"/, "hero must reference at least one URL");
  } else {
    const types = new Set(hero.fields.map((f) => f.type));
    assert.ok(types.has("text"), "hero should expose text fields");
    assert.ok(types.has("url"), "hero should expose url fields");
    assert.ok(types.has("attr"), "hero should expose attr fields (image alt)");
  }

  // Features section: native path expresses a `<ul>` as an icon-list
  // widget; legacy path exposes a list group repeater. Verify either.
  const features = sections.find((s) => s.category === "features")!;
  if (features.nativeElementor) {
    const json = JSON.stringify(features.nativeElementor);
    assert.match(json, /"widgetType":"icon-list"/, "features must include an icon-list widget");
    assert.match(json, /"text":"Fast"/, "features list must preserve item text");
    assert.match(json, /"text":"Reliable"/, "features list must preserve item text");
    assert.match(json, /"text":"Affordable"/, "features list must preserve item text");
  } else {
    const listGroup = features.groups.find((g) => g.kind === "list");
    assert.ok(listGroup, "features section must expose a list group");
    assert.equal(listGroup!.controls.length, 1);
    assert.equal(listGroup!.controls[0].type, "repeater");
    assert.equal(listGroup!.controls[0].default, "Fast\nReliable\nAffordable");
  }
});

test("linked images yield BOTH a link/button group and an image group", () => {
  // Common real-world pattern: a logo or hero image wrapped in a link.
  // Both surfaces must be editable in the Elementor sidebar — the link
  // exposes URL (with rel/target), the image exposes MEDIA + Alt Text.
  const html = `<!doctype html><html><body><section class="hero">
    <a href="https://example.com/landing">
      <img src="/img/logo.png" alt="Acme logo">
    </a>
  </section></body></html>`;
  const sections = extractSectionsFromPage(html, "home", "fixture-link-img");
  assert.ok(sections.length > 0, "extractor must find the hero section");
  const native = sections.find((s) => s.nativeElementor);
  if (native) {
    // Native path: a `<a><img></a>` becomes a single Image widget with
    // `link_to: custom` + the original href, and the image's src/alt
    // exposed as the `image` setting. Both surfaces remain editable
    // from Elementor's sidebar (Content → Image, Content → Link).
    const json = JSON.stringify(native.nativeElementor);
    assert.match(
      json,
      /"widgetType":"image"/,
      "linked image must produce an Elementor image widget",
    );
    assert.match(
      json,
      /"link_to":"custom"/,
      "linked image must mark the image widget as link_to=custom",
    );
    assert.match(
      json,
      /"url":"https:\/\/example\.com\/landing"/,
      "linked image must carry the original href on the image widget",
    );
    assert.match(
      json,
      /"alt":"Acme logo"/,
      "linked image must preserve the alt text on the image setting",
    );
    assert.match(
      json,
      /logo\.png/,
      "linked image must reference the original src file",
    );
    return;
  }
  const allGroups = sections.flatMap((s) => s.groups);
  const linkGroup = allGroups.find((g) => g.kind === "link" || g.kind === "button");
  const imageGroup = allGroups.find((g) => g.kind === "image");
  assert.ok(linkGroup, "linked image must produce a link/button group");
  assert.ok(imageGroup, "linked image must produce a separate image group");
  assert.ok(
    linkGroup!.controls.some((c) => c.type === "url" && c.default === "https://example.com/landing"),
    "link group must expose the URL control with the original href as its default",
  );
  assert.ok(
    imageGroup!.controls.some((c) => c.type === "media" && c.default.endsWith("logo.png")),
    "image group must expose the MEDIA control with the original src as its default",
  );
  assert.ok(
    imageGroup!.controls.some((c) => c.type === "text" && c.default === "Acme logo"),
    "image group must expose the Alt Text control with the original alt as its default",
  );
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

  // Per-section widget PHP + template.html pair is only emitted for
  // sections that fell back to the legacy custom-widget path. Sections
  // produced as native Elementor `section → column → widget` trees are
  // rendered by Elementor's built-in widgets and need no PHP class.
  for (const section of sections) {
    const dir = section.blockName.split("/")[1];
    if (section.nativeElementor) {
      assert.ok(
        !entries.includes(`${root}/widgets/widget-${dir}.php`),
        `native section ${section.blockName} should not register a PHP widget`,
      );
      assert.ok(
        !entries.includes(`${root}/widgets/templates/${dir}/template.html`),
        `native section ${section.blockName} should not ship a template file`,
      );
    } else {
      assert.ok(entries.includes(`${root}/widgets/widget-${dir}.php`), `missing widget for ${section.blockName}`);
      assert.ok(entries.includes(`${root}/widgets/templates/${dir}/template.html`), `missing template for ${section.blockName}`);
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

  const names = phpEntries.map((e) => e.entryName.replace(/\\/g, "/"));
  for (const required of ["functions.php", "index.php", "page.php", "header.php", "footer.php", "widgets/_base-widget.php"]) {
    assert.ok(
      names.some((n) => n.endsWith("/" + required)),
      `expected generated theme to include ${required}`,
    );
  }
  // Per-section widget PHP files are only emitted for sections that
  // fall back to the legacy custom-widget renderer. When EVERY section
  // is decomposed into native Elementor widgets (the modern default),
  // no `widget-*.php` file is generated, so this is informational only.
  // The base widget class file is always required, though.
  assert.ok(
    names.some((n) => n.endsWith("/widgets/_base-widget.php")),
    "theme must always ship the base widget class",
  );

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
      // Each section is rendered EITHER as a native Elementor section
      // (real heading / image / button / etc. widgets — no PHP widget
      // class needed) OR as the legacy custom widget (fields + groups
      // + template). Both shapes are valid; assert one of them holds.
      if (s.nativeElementor) {
        assert.equal(s.fields.length, 0, `${fx.file}: native section ${s.blockName} should not produce flat fields`);
        assert.equal(s.groups.length, 0, `${fx.file}: native section ${s.blockName} should not produce semantic groups`);
        assert.equal(s.template, "", `${fx.file}: native section ${s.blockName} should not produce a template string`);
      } else {
        assert.ok(s.fields.length > 0, `${fx.file}: ${s.blockName} produced zero fields`);
        const keys = s.fields.map((f) => f.key);
        assert.equal(
          new Set(keys).size,
          keys.length,
          `${fx.file}: duplicate field keys in ${s.blockName}: ${keys.join(",")}`,
        );
        assert.ok(s.groups.length > 0, `${fx.file}: ${s.blockName} produced zero groups`);
      }
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
      if (section.nativeElementor) {
        // Native sections must NOT ship a PHP widget class or template
        // file — Elementor's built-in widgets render them directly.
        assert.ok(
          !entries.includes(`${fx.projectSlug}/widgets/widget-${dir}.php`),
          `${fx.file}: native section ${section.blockName} should not register a PHP widget class`,
        );
        assert.ok(
          !entries.includes(`${fx.projectSlug}/widgets/templates/${dir}/template.html`),
          `${fx.file}: native section ${section.blockName} should not ship a template file`,
        );
        continue;
      }
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
  if (hero!.nativeElementor) {
    // Native path: the hero's inline background-image is promoted to an
    // Elementor section background setting (so it's editable from the
    // sidebar) and its URL is rebased to {{THEME_URI}}/assets/.
    const json = JSON.stringify(hero!.nativeElementor);
    assert.match(
      json,
      /\{\{THEME_URI\}\}\/assets\/images\/hero-bg\.jpg/,
      "hero background-image must be rebased and exposed in native section settings",
    );
    assert.match(json, /"background_background":"classic"/, "hero must enable the classic background");
    // Hero is expected to expose multiple link/image targets — buttons,
    // images, etc. — somewhere in its native widget tree.
    const urlMatches = json.match(/"url":"[^"]+"/g) ?? [];
    assert.ok(urlMatches.length >= 2, `hero should reference multiple URLs, got ${urlMatches.length}`);
  } else {
    assert.match(
      hero!.template,
      /background-image:url\(\{\{THEME_URI\}\}\/assets\/images\/hero-bg\.jpg\)/,
      "hero inline background-image url() must be rewritten to a {{THEME_URI}}/assets/ placeholder",
    );
    const urlFields = hero!.fields.filter((f) => f.type === "url");
    assert.ok(urlFields.length >= 2, `hero should expose multiple url fields, got ${urlFields.length}`);
  }
});

// ----------------------------------------------------------------------
// Native Elementor decomposer — Phase 1 coverage
// ----------------------------------------------------------------------

test("native decomposer turns a hero into heading + text + button + image widgets", () => {
  const html = `<!doctype html><html><body>
    <section class="hero">
      <div class="container">
        <h1>Build it fast</h1>
        <p>End-to-end automation for product teams.</p>
        <div class="cta-row">
          <a href="/signup" class="btn primary">Start free</a>
        </div>
        <img src="/img/hero.png" alt="Product screenshot">
      </div>
    </section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "hero-fixture");
  const hero = sections.find((s) => s.category === "hero");
  assert.ok(hero, "hero section must be found");
  assert.ok(hero!.nativeElementor, "hero must be decomposed natively");
  const json = JSON.stringify(hero!.nativeElementor);
  assert.match(json, /"widgetType":"heading"/, "must emit a heading widget");
  assert.match(json, /"title":"Build it fast"/);
  assert.match(json, /"widgetType":"text-editor"/, "must emit a text-editor widget for the paragraph");
  assert.match(json, /"widgetType":"button"/, "must emit a button widget for the CTA");
  assert.match(json, /"text":"Start free"/);
  assert.match(json, /"widgetType":"image"/, "must emit an image widget");
  assert.match(json, /"alt":"Product screenshot"/);
});

test("native decomposer plans 3 columns from a flex/grid 3-card row", () => {
  const html = `<!doctype html><html><body>
    <section class="features">
      <div class="grid three-col">
        <article class="card"><h3>Reliable</h3><p>99.99% uptime.</p><a href="/r" class="btn">Learn</a></article>
        <article class="card"><h3>Secure</h3><p>SOC2 audited.</p><a href="/s" class="btn">Learn</a></article>
        <article class="card"><h3>Fast</h3><p>Edge cached.</p><a href="/f" class="btn">Learn</a></article>
      </div>
    </section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "features-fixture");
  const features = sections[0];
  assert.ok(features.nativeElementor, "features must be decomposed natively");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = features.nativeElementor as any;
  assert.equal(sec.elType, "section");
  assert.equal(sec.elements.length, 3, "features row should plan 3 columns");
  for (const col of sec.elements) {
    assert.equal(col.elType, "column");
    const widgetTypes = col.elements.map((w: { widgetType: string }) => w.widgetType);
    assert.ok(widgetTypes.includes("heading"), `column missing heading: ${widgetTypes.join(",")}`);
    assert.ok(widgetTypes.includes("text-editor"), `column missing text-editor: ${widgetTypes.join(",")}`);
    assert.ok(widgetTypes.includes("button"), `column missing button: ${widgetTypes.join(",")}`);
  }
});

test("native decomposer preserves a <form> as html fallback while keeping siblings native", () => {
  const html = `<!doctype html><html><body>
    <section class="contact">
      <h2>Get in touch</h2>
      <form action="/submit" method="post">
        <label>Email <input type="email" name="email"></label>
        <button type="submit">Send</button>
      </form>
    </section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "contact-fixture");
  const contact = sections[0];
  assert.ok(contact.nativeElementor, "contact section must be decomposed natively");
  const json = JSON.stringify(contact.nativeElementor);
  assert.match(json, /"widgetType":"heading"/, "heading must be a native widget");
  assert.match(json, /"title":"Get in touch"/);
  assert.match(json, /"widgetType":"html"/, "form must be preserved via html-fallback widget");
  assert.match(json, /<form[^>]+action=/, "html fallback must contain the original <form> markup");
});

test("composer + theme generator: native page emits zero widget-*.php files", () => {
  const html = `<!doctype html><html><body>
    <section class="hero"><h1>Hello</h1><p>World</p><a href="/x" class="btn">Go</a></section>
    <section class="features"><div class="grid three-col">
      <div class="card"><h3>A</h3><p>1</p></div>
      <div class="card"><h3>B</h3><p>2</p></div>
      <div class="card"><h3>C</h3><p>3</p></div>
    </div></section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "native-only-fixture");
  assert.ok(sections.every((s) => s.nativeElementor), "every section must go native");
  const buf = generateThemeZip({
    projectName: "Native Only",
    projectSlug: "native-only-fixture",
    combinedCss: "body{margin:0}",
    combinedJs: "",
    pages: [{ slug: "home", title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(buf);
  const widgetFiles = zip
    .getEntries()
    .map((e) => e.entryName.replace(/\\/g, "/"))
    .filter((n) => /\/widgets\/widget-[^/]+\.php$/.test(n));
  assert.equal(widgetFiles.length, 0, `native-only theme must emit zero widget-*.php files, got ${widgetFiles.join(",")}`);
});

test("native decomposer propagates ancestor wrapper classes onto widget _css_classes", () => {
  // Visual-fidelity guarantee: when the decomposer descends through
  // wrapper DIVs (e.g. .container .grid .col .cta-row), the chain of
  // wrapper classes must be reattached to each emitted widget so that
  // user CSS like `.cta-row .btn { ... }` keeps matching the rendered
  // Elementor DOM. Without this propagation, sites look "messy" after
  // the Phase 1 pivot because intermediate wrappers vanish.
  const html = `<!doctype html><html><body>
    <section class="hero">
      <div class="container">
        <div class="grid two-col">
          <div class="col copy">
            <h1>Title</h1>
            <div class="cta-row">
              <a href="/x" class="btn primary">Go</a>
            </div>
          </div>
          <div class="col media"><img src="/i.png" alt="i"></div>
        </div>
      </div>
    </section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "fidelity-fixture");
  const hero = sections[0];
  assert.ok(hero.nativeElementor, "hero must be decomposed natively");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = hero.nativeElementor as any;
  assert.equal(sec.elements.length, 2, "two columns expected from .grid.two-col");

  // Column 1 (".col copy") must carry its own class so .col.copy h1 still matches.
  const col1 = sec.elements[0];
  assert.equal(col1.elType, "column");
  assert.equal(col1.settings._css_classes, "col copy");

  // The button is nested inside .cta-row inside .col copy. The dropped
  // ancestor chain (container, grid two-col, cta-row) must end up on
  // the button widget's _css_classes alongside the button's own class.
  const buttonWidget = col1.elements.find((w: { widgetType: string }) => w.widgetType === "button");
  assert.ok(buttonWidget, "button widget should exist in column 1");
  const cssClasses: string = buttonWidget.settings._css_classes;
  assert.ok(cssClasses.includes("btn primary"), `button must keep its own class, got: "${cssClasses}"`);
  assert.ok(cssClasses.includes("cta-row"), `button must inherit .cta-row wrapper class, got: "${cssClasses}"`);
  assert.ok(cssClasses.includes("container"), `button must inherit .container wrapper class, got: "${cssClasses}"`);
  assert.ok(cssClasses.includes("grid"), `button must inherit .grid wrapper class, got: "${cssClasses}"`);

  // The heading also lives under .container .grid (no .cta-row though).
  const headingWidget = col1.elements.find((w: { widgetType: string }) => w.widgetType === "heading");
  assert.ok(headingWidget, "heading widget should exist in column 1");
  const headingClasses: string = headingWidget.settings._css_classes;
  assert.ok(headingClasses.includes("container"), "heading must inherit .container ancestor class");
  assert.ok(headingClasses.includes("grid"), "heading must inherit .grid ancestor class");
  assert.ok(!headingClasses.includes("cta-row"), "heading must NOT inherit .cta-row (not an ancestor of it)");
});

test("css-to-Elementor controls translator: heading typography & color flow into widget settings", () => {
  // The decomposer should consult the original CSS, compute cascaded
  // styles per element, and write the matching values into Elementor
  // widget controls so the sidebar reflects the real visual design.
  const html = `<!doctype html><html><head><style>
    .hero h1 { color: #ff0000; font-size: 48px; font-weight: 700; line-height: 1.2; text-transform: uppercase; }
    .hero p { color: #333; font-size: 18px; }
    .hero .btn { background-color: #00ff00; color: #fff; padding: 12px 24px; border-radius: 4px; }
    .hero { padding: 80px 20px; background-color: #f5f5f5; }
  </style></head><body>
    <section class="hero">
      <h1>Title</h1>
      <p>Body</p>
      <a href="/x" class="btn">Go</a>
    </section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "css-translator-fixture");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = sections[0].nativeElementor as any;
  assert.ok(sec, "section must be decomposed natively");

  // Section background + padding picked up from CSS.
  assert.equal(sec.settings.background_color, "#f5f5f5", "section background_color from CSS");
  assert.ok(sec.settings._padding, "section padding shape present");
  assert.equal(sec.settings._padding.top, "80");
  assert.equal(sec.settings._padding.right, "20");

  const widgets = sec.elements[0].elements;
  const heading = widgets.find((w: { widgetType: string }) => w.widgetType === "heading");
  assert.equal(heading.settings.title_color, "#ff0000", "heading color");
  assert.equal(heading.settings.typography_typography, "custom", "typography unlocked");
  assert.equal(heading.settings.typography_font_size.size, 48);
  assert.equal(heading.settings.typography_font_size.unit, "px");
  assert.equal(heading.settings.typography_font_weight, "700");
  assert.equal(heading.settings.typography_text_transform, "uppercase");
  assert.equal(heading.settings.typography_line_height.size, 1.2);
  assert.equal(heading.settings.typography_line_height.unit, "em", "unitless line-height stored as em");

  const text = widgets.find((w: { widgetType: string }) => w.widgetType === "text-editor");
  assert.equal(text.settings.text_color, "#333");
  assert.equal(text.settings.typography_font_size.size, 18);

  const button = widgets.find((w: { widgetType: string }) => w.widgetType === "button");
  assert.equal(button.settings.background_color, "#00ff00", "button background from CSS");
  assert.equal(button.settings.button_text_color, "#fff", "button text color from CSS");
  assert.equal(button.settings._padding.top, "12");
  assert.equal(button.settings._padding.right, "24");
  assert.ok(button.settings._border_radius, "border-radius shape present");
  assert.equal(button.settings._border_radius.top, "4");
});

test("css translator: inline style overrides stylesheet for the same element", () => {
  const html = `<!doctype html><html><head><style>
    .hero h1 { color: #ff0000; }
  </style></head><body>
    <section class="hero">
      <h1 style="color: #0000ff">Title</h1>
    </section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "css-inline-fixture");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = sections[0].nativeElementor as any;
  const heading = sec.elements[0].elements.find((w: { widgetType: string }) => w.widgetType === "heading");
  assert.equal(heading.settings.title_color, "#0000ff", "inline style must beat the stylesheet");
});

test("css translator: malformed CSS does not crash the pipeline", () => {
  const html = `<!doctype html><html><head><style>
    this is not valid css { broken
    .hero h1 { color: red; }
  </style></head><body>
    <section class="hero"><h1>OK</h1></section>
  </body></html>`;
  // Should not throw; partial parsing recovery is acceptable.
  const sections = extractSectionsFromPage(html, "home", "css-broken-fixture");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = sections[0].nativeElementor as any;
  assert.ok(sec, "section must still decompose despite bad CSS");
});

test("css translator: tolerant parsing keeps valid rules around a broken one", () => {
  // The broken middle rule must not wipe out the trailing valid rule.
  // .broken has an invalid declaration (color value missing), but the
  // braces balance so the parser can recover and continue.
  const html = `<!doctype html><html><head><style>
    .hero h1 { color: rgb(10, 20, 30); }
    .broken { color: ; %%%%; }
    .hero p { color: rgb(40, 50, 60); }
  </style></head><body>
    <section class="hero"><h1>Title</h1><p>Body</p></section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "css-tolerant-fixture");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = sections[0].nativeElementor as any;
  const widgets = sec.elements[0].elements as Array<{ widgetType: string; settings: Record<string, unknown> }>;
  const h1 = widgets.find((w) => w.widgetType === "heading");
  const p = widgets.find((w) => w.widgetType === "text-editor");
  assert.equal(h1?.settings.title_color, "rgb(10, 20, 30)", "h1 rule must survive");
  // The text-editor color rule sits *after* the broken block; if the
  // sheet was discarded wholesale, this would be undefined.
  assert.equal(p?.settings.text_color, "rgb(40, 50, 60)", "rule after broken block must still apply");
});

test("css translator: stylesheet !important beats inline normal", () => {
  const html = `<!doctype html><html><head><style>
    .hero h1 { color: red !important; }
  </style></head><body>
    <section class="hero"><h1 style="color: blue">Hi</h1></section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "important-fixture");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = sections[0].nativeElementor as any;
  const heading = sec.elements[0].elements.find((w: { widgetType: string }) => w.widgetType === "heading");
  assert.equal(heading.settings.title_color, "red", "stylesheet !important must beat inline normal");
});

test("css translator: inline !important beats stylesheet !important", () => {
  const html = `<!doctype html><html><head><style>
    .hero h1 { color: red !important; }
  </style></head><body>
    <section class="hero"><h1 style="color: green !important">Hi</h1></section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "inline-imp-fixture");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = sections[0].nativeElementor as any;
  const heading = sec.elements[0].elements.find((w: { widgetType: string }) => w.widgetType === "heading");
  assert.equal(heading.settings.title_color, "green", "inline !important wins overall");
});

test("css translator: inheritable color/typography flow from ancestor to widget", () => {
  // `.hero` only sets color/font-size on the SECTION; the H1 inherits.
  const html = `<!doctype html><html><head><style>
    .hero { color: rgb(11, 22, 33); font-size: 40px; font-family: Inter, sans-serif; }
  </style></head><body>
    <section class="hero"><h1>Inherits</h1></section>
  </body></html>`;
  const sections = extractSectionsFromPage(html, "home", "inherit-fixture");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sec = sections[0].nativeElementor as any;
  const heading = sec.elements[0].elements.find((w: { widgetType: string }) => w.widgetType === "heading");
  assert.equal(heading.settings.title_color, "rgb(11, 22, 33)", "color must be inherited from .hero");
  assert.equal(
    (heading.settings.typography_font_size as { size: number; unit: string }).size,
    40,
    "font-size must be inherited from .hero",
  );
  assert.equal(heading.settings.typography_font_family, "Inter", "font-family must be inherited");
});
