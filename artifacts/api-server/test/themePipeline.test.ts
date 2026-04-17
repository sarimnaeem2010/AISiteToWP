import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import AdmZip from "adm-zip";
import * as csstree from "css-tree";

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

  // Inject a stray closing brace before the first rule — the kind of typo
  // a future edit to the CSS pipeline could ship and that silently turns
  // the rendered site into an unstyled wall of text.
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

/**
 * Run the generated `assets/editor.js` against a strict `wp` global stub
 * and return the result. Each `wp.<namespace>` is a Proxy that throws on
 * any property access that isn't in the per-namespace allow-list, so a
 * typo in a Gutenberg API name (e.g. `useBlockProsp` instead of
 * `useBlockProps`, or `wp.blokcs` instead of `wp.blocks`) — which would
 * be valid JavaScript and pass syntax checks but blow up inside the WP
 * editor at runtime — fails fast here instead of in production. Returns
 * `{ ok: true }` if the script and the captured `wp.domReady(callback)`
 * both run without throwing, or `{ ok: false, error }` otherwise.
 */
function runEditorJsAgainstWpStub(
  src: string,
  projectSlug: string,
): { ok: boolean; error?: string } {
  // Allowed members per Gutenberg namespace, derived from the wp.* APIs
  // that EDITOR_JS in themeGenerator.ts actually touches. Keep this list
  // tight: the whole point is that adding a new wp.* reference to
  // EDITOR_JS without updating this allow-list fails the test, forcing
  // the author to verify the real Gutenberg API spelling exists.
  const stubFn = (...args: unknown[]) => ({ __stubCallArgs: args });
  const sentinel = (label: string) => ({ __stubSentinel: label });

  const namespace = (label: string, allowed: Record<string, unknown>): unknown =>
    new Proxy(allowed, {
      get(target, key) {
        // Symbol-keyed lookups (Symbol.toPrimitive, Symbol.iterator, …)
        // can be triggered by `||`, template literals, etc. — return
        // undefined rather than throwing so falsy fallbacks still work.
        if (typeof key === "symbol") return undefined;
        // Same for engine-internal accessors that vm/Node may probe.
        if (key === "then" || key === "constructor" || key === "toJSON") return undefined;
        if (!(key in target)) {
          throw new Error(
            `wp.${label}.${String(key)} is not in the stub allow-list — ` +
              `if Gutenberg actually exposes this API, add it to the test stub; ` +
              `if it doesn't, you have a typo in EDITOR_JS.`,
          );
        }
        return (target as Record<string, unknown>)[key as string];
      },
    });

  // The Edit factory inside EDITOR_JS calls `wp.blocks.registerBlockType`
  // for every block returned by `getBlockTypes()` whose name starts with
  // `wpb-${slug}/`. Pre-register one matching block so the inner loop
  // actually runs and we exercise makeEdit() + the Edit() function it
  // produces.
  const fakeBlock = {
    name: `wpb-${projectSlug}/sec-1`,
    attributes: {
      txt_0: { type: "string", default: "Short headline" },
      // Long string -> exercises the TextareaControl branch.
      txt_1: { type: "string", default: "x".repeat(120) },
      url_0: { type: "string", default: "{{THEME_URI}}/assets/img/logo.png" },
    },
  };
  const editsExercised: number[] = [];
  let domReadyCb: (() => void) | null = null;

  const wp = {
    element: namespace("element", {
      createElement: stubFn,
      Fragment: sentinel("Fragment"),
    }),
    serverSideRender: sentinel("ServerSideRender"),
    blockEditor: namespace("blockEditor", {
      InspectorControls: sentinel("InspectorControls"),
      useBlockProps: () => ({ className: "stub-block-props" }),
    }),
    components: namespace("components", {
      PanelBody: sentinel("PanelBody"),
      TextControl: sentinel("TextControl"),
      TextareaControl: sentinel("TextareaControl"),
    }),
    domReady: (fn: () => void) => {
      if (typeof fn !== "function") {
        throw new Error("wp.domReady was called with a non-function");
      }
      domReadyCb = fn;
    },
    blocks: namespace("blocks", {
      getBlockTypes: () => [fakeBlock],
      unregisterBlockType: (_n: string) => {
        /* noop — registry is fake */
      },
      registerBlockType: (_n: string, def: { edit?: (props: unknown) => unknown; save?: () => unknown }) => {
        // Actually invoke the Edit() function so any wp.* typo inside
        // makeEdit (TextControl, TextareaControl, InspectorControls,
        // PanelBody, useBlockProps, createElement, Fragment) surfaces
        // here, not just at the top of the IIFE.
        if (typeof def.edit !== "function") {
          throw new Error("registerBlockType received a non-function edit");
        }
        const setAttributes = (_u: Record<string, unknown>) => {
          /* noop */
        };
        def.edit({ attributes: { ...fakeBlock.attributes }, setAttributes });
        if (typeof def.save === "function") def.save();
        editsExercised.push(1);
      },
    }),
  } as Record<string, unknown>;

  const wpProxy = new Proxy(wp, {
    get(target, key) {
      if (typeof key === "symbol") return undefined;
      if (key === "then" || key === "constructor") return undefined;
      if (!(key in target)) {
        throw new Error(
          `wp.${String(key)} is not in the stub allow-list — typo or missing namespace.`,
        );
      }
      return target[key as string];
    },
  });

  try {
    const ctx = vm.createContext({ wp: wpProxy, console });
    vm.runInContext(src, ctx, { filename: "assets/editor.js" });
    if (!domReadyCb) {
      return { ok: false, error: "editor.js never registered a wp.domReady callback" };
    }
    (domReadyCb as () => void)();
    if (editsExercised.length === 0) {
      return { ok: false, error: "editor.js did not call wp.blocks.registerBlockType for any matching block" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

test("editor.js runs cleanly against a strict wp.* stub", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const zipBuf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(zipBuf);
  const entry = zip.getEntries().find((e) => e.entryName.endsWith("/assets/editor.js"));
  assert.ok(entry, "editor.js missing from generated theme");
  const src = entry!.getData().toString("utf8");

  const result = runEditorJsAgainstWpStub(src, PROJECT_SLUG);
  assert.ok(
    result.ok,
    `editor.js threw against the wp.* stub — every reference must use a real Gutenberg API.\n` +
      `Error: ${result.error}`,
  );
});

test("editor.js stub catches a typo in a wp.blockEditor.* API name", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const zipBuf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(zipBuf);
  const original = zip.getEntries().find((e) => e.entryName.endsWith("/assets/editor.js"))!.getData().toString("utf8");
  // Swap useBlockProps -> useBlockProsp everywhere — the kind of typo
  // that's still valid JS and would only blow up inside Gutenberg.
  const broken = original.replace(/useBlockProps/g, "useBlockProsp");
  assert.notEqual(broken, original, "test scaffolding failed to introduce typo");
  const result = runEditorJsAgainstWpStub(broken, PROJECT_SLUG);
  assert.equal(result.ok, false, "stub must reject a typo'd wp.blockEditor.* reference");
  assert.match(
    result.error ?? "",
    /useBlockProsp/,
    `expected error to mention the typo'd identifier, got: ${result.error}`,
  );
});

test("editor.js stub catches a typo in a wp.* namespace name", () => {
  const sections = extractSectionsFromPage(FIXTURE, PAGE_SLUG, PROJECT_SLUG);
  const zipBuf = generateThemeZip({
    projectName: "Fixture Site",
    projectSlug: PROJECT_SLUG,
    combinedCss: "",
    combinedJs: "",
    pages: [{ slug: PAGE_SLUG, title: "Home", sections }],
    sourceZip: null,
  });
  const zip = new AdmZip(zipBuf);
  const original = zip.getEntries().find((e) => e.entryName.endsWith("/assets/editor.js"))!.getData().toString("utf8");
  // Mistype the top-level `wp.blocks` namespace -> `wp.blokcs`.
  const broken = original.replace(/wp\.blocks\b/g, "wp.blokcs");
  assert.notEqual(broken, original, "test scaffolding failed to introduce typo");
  const result = runEditorJsAgainstWpStub(broken, PROJECT_SLUG);
  assert.equal(result.ok, false, "stub must reject a typo'd top-level wp.* namespace");
  assert.match(
    result.error ?? "",
    /blokcs/,
    `expected error to mention the typo'd namespace, got: ${result.error}`,
  );
});

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
