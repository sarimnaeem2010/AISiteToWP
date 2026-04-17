import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

import { extractSectionsFromPage } from "../src/lib/sectionFieldExtractor";
import { composeGutenbergContent } from "../src/lib/pixelPerfectComposer";
import { generateThemeZip } from "../src/lib/themeGenerator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(__dirname, "fixtures/simple-page.html"), "utf8");

const PAGE_SLUG = "home";
const PROJECT_SLUG = "fixture-site";

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
