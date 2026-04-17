/**
 * Lightweight PHP syntax validator used in CI to catch broken templates
 * emitted by themeGenerator.ts before they reach a user's WordPress site.
 *
 * This is NOT a full PHP parser. It is a string/comment-aware tokenizer
 * that catches the classes of mistakes that have actually broken theme
 * uploads in the past:
 *   - missing `<?php` opening tag
 *   - unterminated string / comment / heredoc
 *   - unbalanced `{ }`, `( )`, `[ ]` (the #1 cause of `php -l` failures
 *     after a hand edit to a template literal)
 *   - mismatched closing bracket type (e.g. `( ... ]`)
 *
 * PHP files may legitimately mix PHP and HTML by using `?>` to drop into
 * literal output mode and `<?php` (or `<?=`) to re-enter PHP. We track
 * that mode and only validate the PHP regions.
 *
 * If PHP is available on the host, callers can run `php -l` for a fully
 * authoritative check; this module exists for environments (CI, sandbox)
 * where PHP isn't installed.
 */
export interface PhpSyntaxResult {
  ok: boolean;
  error?: string;
  line?: number;
  column?: number;
}

const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const CLOSE_SET = new Set(["}", ")", "]"]);

export function checkPhpSyntax(source: string, filename = "<input>"): PhpSyntaxResult {
  let i = 0;
  let line = 1;
  let col = 1;
  const stack: { ch: string; line: number; col: number }[] = [];

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  // Files may start in HTML mode (e.g. header.php begins with <!doctype>)
  // or in PHP mode. Scan to the first PHP open tag; if none exists, the
  // file is pure HTML and there is no PHP to validate.
  let inPhp = false;
  while (i < source.length) {
    if (source[i] === "<" && source[i + 1] === "?") {
      if (source.startsWith("<?php", i)) {
        advance(5);
        inPhp = true;
        break;
      }
      if (source[i + 2] === "=") {
        advance(3);
        inPhp = true;
        break;
      }
    }
    advance();
  }
  if (!inPhp) {
    if (/<\?/.test(source)) {
      // Found `<?` that wasn't `<?php` or `<?=` — short open tags aren't
      // portable and almost always indicate a malformed template.
      return { ok: false, error: `${filename}: short open tag <? is not allowed; use <?php`, line: 1, column: 1 };
    }
    return { ok: true };
  }

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comments: // and #
    if ((ch === "/" && next === "/") || ch === "#") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      const startLine = line;
      const startCol = col;
      advance(2);
      let closed = false;
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        return { ok: false, error: `${filename}: unterminated /* */ block comment`, line: startLine, column: startCol };
      }
      continue;
    }

    // Single-quoted string: only \\ and \' are escapes
    if (ch === "'") {
      const startLine = line;
      const startCol = col;
      advance();
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\" && (source[i + 1] === "\\" || source[i + 1] === "'")) {
          advance(2);
          continue;
        }
        if (c === "'") {
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        return { ok: false, error: `${filename}: unterminated single-quoted string`, line: startLine, column: startCol };
      }
      continue;
    }

    // Double-quoted string: full backslash escapes
    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      advance();
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\" && i + 1 < source.length) {
          advance(2);
          continue;
        }
        if (c === '"') {
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        return { ok: false, error: `${filename}: unterminated double-quoted string`, line: startLine, column: startCol };
      }
      continue;
    }

    // Heredoc / Nowdoc: <<<LABEL ... LABEL;
    if (ch === "<" && source.startsWith("<<<", i)) {
      const startLine = line;
      const startCol = col;
      advance(3);
      // optional quotes around the label (nowdoc uses single quotes)
      let quote: '"' | "'" | "" = "";
      if (source[i] === '"' || source[i] === "'") {
        quote = source[i] as '"' | "'";
        advance();
      }
      let label = "";
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        label += source[i];
        advance();
      }
      if (quote) {
        if (source[i] !== quote) {
          return { ok: false, error: `${filename}: malformed heredoc label`, line: startLine, column: startCol };
        }
        advance();
      }
      if (label.length === 0 || source[i] !== "\n") {
        return { ok: false, error: `${filename}: malformed heredoc opener`, line: startLine, column: startCol };
      }
      advance(); // consume newline
      // Scan for the closing label at the start of a line (PHP 7.3+ allows indentation)
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\n") {
          advance();
          // peek possible indentation + label
          let j = i;
          while (j < source.length && (source[j] === " " || source[j] === "\t")) j++;
          if (source.startsWith(label, j)) {
            const after = source[j + label.length];
            if (after === undefined || after === ";" || after === "\n" || after === "," || after === ")" || after === " ") {
              // advance to end of label
              while (i < j + label.length) advance();
              closed = true;
              break;
            }
          }
        } else {
          advance();
        }
      }
      if (!closed) {
        return { ok: false, error: `${filename}: unterminated heredoc/nowdoc <<<${label}`, line: startLine, column: startCol };
      }
      continue;
    }

    // Closing PHP tag: drop into literal HTML output mode until the next
    // PHP open tag (<?php or <?=). Brackets in that HTML are not PHP code
    // and must not affect the bracket stack.
    if (ch === "?" && next === ">") {
      advance(2);
      while (i < source.length) {
        if (source[i] === "<" && source[i + 1] === "?") {
          if (source.startsWith("<?php", i)) {
            advance(5);
            break;
          }
          if (source[i + 2] === "=") {
            advance(3);
            break;
          }
          advance(2);
          break;
        }
        advance();
      }
      continue;
    }

    if (ch in OPEN_TO_CLOSE) {
      stack.push({ ch, line, col });
      advance();
      continue;
    }

    if (CLOSE_SET.has(ch)) {
      const top = stack.pop();
      if (!top) {
        return { ok: false, error: `${filename}: unmatched closing '${ch}'`, line, column: col };
      }
      const expected = OPEN_TO_CLOSE[top.ch];
      if (expected !== ch) {
        return {
          ok: false,
          error: `${filename}: mismatched bracket — expected '${expected}' to close '${top.ch}' from line ${top.line}, got '${ch}'`,
          line,
          column: col,
        };
      }
      advance();
      continue;
    }

    advance();
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return {
      ok: false,
      error: `${filename}: unbalanced — '${top.ch}' opened at line ${top.line} col ${top.col} was never closed`,
      line: top.line,
      column: top.col,
    };
  }

  return { ok: true };
}
