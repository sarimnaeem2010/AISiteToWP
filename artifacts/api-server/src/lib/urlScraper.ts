import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { logger } from "./logger";

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateIPv4(lower.slice(7));
  return false;
}

async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const host = parsed.hostname;
  const ipVersion = isIP(host);
  if (ipVersion === 4 && isPrivateIPv4(host)) throw new Error("Private/loopback addresses are not allowed");
  if (ipVersion === 6 && isPrivateIPv6(host)) throw new Error("Private/loopback addresses are not allowed");
  if (ipVersion === 0) {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) {
      if (a.family === 4 && isPrivateIPv4(a.address)) throw new Error("Host resolves to a private address");
      if (a.family === 6 && isPrivateIPv6(a.address)) throw new Error("Host resolves to a private address");
    }
  }
  return parsed;
}

export interface ScrapedHtml {
  html: string;
  finalUrl: string;
  contentType: string;
}

/**
 * Fetch a public URL and return its HTML body. Performs SSRF protection
 * (rejects loopback / private IPs), caps body size, and resolves any
 * relative URLs in <img>, <link>, <script>, <a> tags to absolute form so
 * downstream parsing/rendering keeps working.
 */
export async function scrapeUrl(rawUrl: string): Promise<ScrapedHtml> {
  const safe = await assertSafeUrl(rawUrl);

  const res = await fetch(safe.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "WP-Bridge-AI/1.0 (+https://replit.com)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`URL fetch failed: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    throw new Error(`URL did not return HTML (content-type: ${contentType || "unknown"})`);
  }

  // Re-validate after redirects: the final URL may point somewhere private.
  const finalUrl = res.url || safe.toString();
  await assertSafeUrl(finalUrl);

  // Cap body size to prevent memory exhaustion from a hostile/huge page.
  const reader = res.body?.getReader();
  if (!reader) throw new Error("URL response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`URL response too large (>${Math.round(MAX_HTML_BYTES / 1024 / 1024)}MB)`);
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const rawHtml = buf.toString("utf8");

  const html = rewriteRelativeUrls(rawHtml, finalUrl);

  logger.info({ url: finalUrl, bytes: total }, "URL scrape complete");

  return { html, finalUrl, contentType };
}

/**
 * Rewrite relative URLs in href/src/srcset/url(...) to absolute against the
 * page base. Conservative regex-based pass — keeps the original HTML mostly
 * intact and only touches URL attributes.
 */
function rewriteRelativeUrls(html: string, baseUrl: string): string {
  const base = (() => {
    try { return new URL(baseUrl); } catch { return null; }
  })();
  if (!base) return html;

  const resolve = (val: string): string => {
    const trimmed = val.trim();
    if (!trimmed) return val;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:|tel:|javascript:)/i.test(trimmed)) {
      return trimmed;
    }
    try {
      return new URL(trimmed, base).toString();
    } catch {
      return val;
    }
  };

  // href="..." | src="..." | poster="..." | action="..."
  let out = html.replace(
    /\b(href|src|poster|action)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_m, attr, _q, dq, sq) => {
      const v = dq ?? sq ?? "";
      return `${attr}="${resolve(v)}"`;
    },
  );

  // srcset="url1 1x, url2 2x"
  out = out.replace(/\bsrcset\s*=\s*"([^"]*)"/gi, (_m, list: string) => {
    const rewritten = list
      .split(",")
      .map((entry) => {
        const trimmed = entry.trim();
        const [u, ...rest] = trimmed.split(/\s+/);
        return [resolve(u ?? ""), ...rest].join(" ");
      })
      .join(", ");
    return `srcset="${rewritten}"`;
  });

  // url(...) inside inline styles
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q: string, u: string) => {
    return `url(${q}${resolve(u)}${q})`;
  });

  return out;
}
