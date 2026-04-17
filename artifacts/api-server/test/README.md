# API server tests

Run the full suite from the package root:

```sh
pnpm --filter @workspace/api-server test
```

## PHP syntax check

The theme generator emits PHP files (`functions.php`, `render.php`,
`widget-*.php`, `_base-widget.php`, etc.) into the uploadable theme ZIP. A
syntax error in any of those templates would silently pass a structural
check but break a user's WordPress site at activation time.

`themePipeline.test.ts` therefore runs every emitted PHP file through
`src/lib/phpSyntaxCheck.ts` — a string-, comment-, and HTML-mode-aware
tokenizer that catches:

- missing/short PHP open tags
- unterminated strings, block comments, and heredocs
- unbalanced or mismatched `{}`, `()`, `[]`

To run only the PHP-related tests:

```sh
pnpm --filter @workspace/api-server exec tsx --test \
  --test-name-pattern 'PHP|theme zip|checkPhpSyntax' test/themePipeline.test.ts
```

If PHP is installed on your machine you can additionally run the
authoritative linter against an extracted theme ZIP:

```sh
unzip -o /tmp/theme.zip -d /tmp/theme && \
  find /tmp/theme -name '*.php' -print0 | xargs -0 -n1 php -l
```

The JS tokenizer exists so CI can catch these regressions even when PHP
isn't available in the sandbox.
