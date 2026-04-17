# Theme rendering end-to-end check

This harness uploads a generated theme into a real WordPress install and
diffs the rendered HTML against the source fixture. It catches bugs that
the in-process tests in `themePipeline.test.ts` cannot — specifically
anything that goes wrong inside WordPress itself: PHP fatals in
`functions.php`, block registration failures, broken placeholder
substitution, theme activation errors.

It is **opt-in** because it downloads ~30 MB and boots a PHP server.
`pnpm test` does not invoke it (the test calls `t.skip` unless
`RUN_WP_E2E=1`).

## Requirements

- `php` (8.1+) with the `sqlite3`, `pdo_sqlite`, `zip`, `dom`, `xml`
  extensions. Install via the package-management skill if missing:
  `installProgrammingLanguage({ language: "php-8.2" })`.
- `curl`, `tar`, `bash` (already present on the Replit image).
- Outbound HTTPS to `wordpress.org` and `github.com` (only on first run).

## How to run

```bash
pnpm --filter @workspace/api-server test:e2e
```

That sets `RUN_WP_E2E=1` and runs `test/e2e/themeRender.e2e.test.ts`.

## What it does

1. **`setup-wp.sh`** — idempotent bootstrap. Downloads WordPress + the
   `sqlite-database-integration` plugin + the Elementor plugin into
   `/tmp/wpb-e2e/wp` (override with `WPB_E2E_DIR`), wires the SQLite
   drop-in into `wp-content/db.php`, writes a minimal `wp-config.php`,
   and runs the WP installer once. Elementor is downloaded but left
   inactive — the Elementor test activates it on demand. Set
   `WPB_E2E_FRESH=1` to wipe and reinstall, or `WPB_E2E_ELEMENTOR_REF`
   to pin a specific Elementor release (e.g. `3.21.0`).
2. **`themeRender.e2e.test.ts`** — three tests, all backed by generated
   theme zips extracted into `wp-content/themes/<slug>/`. The first two
   loop over every fixture in `test/fixtures/`; the third is a focused
   bundled-asset round-trip:
   - **Gutenberg path** invokes **`apply-theme.php`**, which bootstraps
     WP, calls `switch_theme()`, and inserts a page whose `post_content`
     is the composed Gutenberg block markup (read from stdin). Sets it
     as the static front page.
   - **Elementor path** invokes **`apply-elementor.php`**, which
     activates the Elementor plugin, switches the theme, inserts an
     empty-content page, and writes the `_elementor_data` /
     `_elementor_edit_mode` / `_elementor_template_type` /
     `_elementor_version` post meta from the JSON produced by
     `composeElementorData()` (read from stdin). The frontend then has
     Elementor take over `the_content` for that page.
3. Both tests boot `php -S 127.0.0.1:<random>` against the WP dir using
   **`router.php`** (so pretty permalinks resolve), fetch
   `?page_id=<id>`, and assert:
   - the response is HTTP 200,
   - the raw `<!-- wp:wpb-... -->` block markers are gone (proving the
     blocks registered and rendered),
   - **every top-level `<header>` / `<section>` / `<footer>` from the
     source fixture matches its rendered counterpart structurally**:
     same tags, same children, same attributes, same text. For the
     Gutenberg path the rendered counterparts are the top-level
     sections of `<body>`; for the Elementor path they're the first
     element child of each `.elementor-widget-container` (Elementor
     wraps every widget in its own section/column/widget div tree).
     The normalizer strips the few mutations WordPress legitimately
     makes (`decoding`/`loading`/`fetchpriority`/`srcset`/`sizes`
     injected on `<img>`, and `{{THEME_URI}}/assets/...` rewritten to
     absolute `http://.../wp-content/themes/<slug>/assets/...`).
     Anything else — reordered elements, lost attributes, missing
     text, extra wrapper divs from a misbehaving block or widget —
     fails the diff.
   - **Bundled-asset round-trip** uses `test/fixtures/asset-page.html`
     plus an in-memory source ZIP carrying a real 1×1 PNG and a font
     placeholder. After applying the theme via `apply-theme.php`, the
     test fetches the page, collects every `<img src>` and
     `<link href>`, rewrites their host to the actual `php -S` server,
     and `HEAD`-requests each one — every URL must return 200. It also
     `HEAD`s the bundled font URL explicitly and `GET`s it to confirm
     the bytes round-trip end-to-end. Catches regressions in the
     `{{THEME_URI}}/assets/...` rewrite contract and in the
     `ASSET_EXT` copy loop in `themeGenerator.ts`.

The PHP server is killed via the test's `t.after()` hook even on failure.

## Tweaking

- **Different fixture**: change `FIXTURE_PATH` / `PROJECT_SLUG` constants
  at the top of `themeRender.e2e.test.ts`.
- **Reuse a pre-installed sandbox**: point `WPB_E2E_DIR` at it. As long
  as `wp-load.php` exists, the bootstrap skips the download step.
- **Pin a WP version**: `WPB_E2E_WP_VERSION=wordpress-6.7.1`.
