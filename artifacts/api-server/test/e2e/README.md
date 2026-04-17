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
   `sqlite-database-integration` plugin into `/tmp/wpb-e2e/wp` (override
   with `WPB_E2E_DIR`), wires the SQLite drop-in into `wp-content/db.php`,
   writes a minimal `wp-config.php`, and runs the WP installer once. Set
   `WPB_E2E_FRESH=1` to wipe and reinstall.
2. **`themeRender.e2e.test.ts`** — generates a theme zip from
   `test/fixtures/simple-page.html`, extracts it into
   `wp-content/themes/<slug>/`, then invokes:
3. **`apply-theme.php`** — bootstraps WP, calls `switch_theme()`, and
   inserts a page whose `post_content` is the composed Gutenberg block
   markup (read from stdin). Sets it as the static front page.
4. The test boots `php -S 127.0.0.1:<random>` against the WP dir using
   **`router.php`** (so pretty permalinks resolve), fetches
   `?page_id=<id>`, and asserts:
   - the response is HTTP 200,
   - the raw `<!-- wp:wpb-... -->` block markers are gone (proving the
     blocks registered and rendered),
   - **every top-level `<header>` / `<section>` / `<footer>` from the
     source fixture matches its rendered counterpart structurally**:
     same tags, same children, same attributes, same text. The
     normalizer strips the few mutations WordPress legitimately makes
     (`decoding`/`loading`/`fetchpriority`/`srcset`/`sizes` injected on
     `<img>`, and `{{THEME_URI}}/assets/...` rewritten to absolute
     `http://.../wp-content/themes/<slug>/assets/...`). Anything else —
     reordered elements, lost attributes, missing text, extra wrapper
     divs from a misbehaving block — fails the diff.

The PHP server is killed via the test's `t.after()` hook even on failure.

## Tweaking

- **Different fixture**: change `FIXTURE_PATH` / `PROJECT_SLUG` constants
  at the top of `themeRender.e2e.test.ts`.
- **Reuse a pre-installed sandbox**: point `WPB_E2E_DIR` at it. As long
  as `wp-load.php` exists, the bootstrap skips the download step.
- **Pin a WP version**: `WPB_E2E_WP_VERSION=wordpress-6.7.1`.
