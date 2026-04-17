import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Address4, Address6 } from "ip-address";
import { Agent, fetch as undiciFetch } from "undici";
import { logger } from "./logger";

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

function isPrivateIPv4String(ip: string): boolean {
  let addr: Address4;
  try {
    addr = new Address4(ip);
  } catch {
    return true;
  }
  const blocks = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "255.255.255.255/32",
  ];
  return blocks.some((cidr) => {
    try {
      return addr.isInSubnet(new Address4(cidr));
    } catch {
      return false;
    }
  });
}

function isPrivateIPv6String(ip: string): boolean {
  let addr: Address6;
  try {
    addr = new Address6(ip);
  } catch {
    return true;
  }
  // IPv4-mapped/compatible — check the embedded v4 address.
  if (addr.is4()) {
    try {
      const v4 = addr.to4().address;
      if (v4 && isPrivateIPv4String(v4)) return true;
    } catch { /* not a v4-mapped form */ }
  }
  const blocks = [
    "::/128",        // unspecified
    "::1/128",       // loopback
    "::ffff:0:0/96", // IPv4-mapped (also handled above)
    "64:ff9b::/96",  // NAT64
    "100::/64",      // discard
    "2001::/23",     // IETF reserved
    "2001:db8::/32", // documentation
    "fc00::/7",      // unique-local
    "fe80::/10",     // link-local
    "ff00::/8",      // multicast
  ];
  return blocks.some((cidr) => {
    try {
      return addr.isInSubnet(new Address6(cidr));
    } catch {
      return false;
    }
  });
}

function isPrivateIp(ip: string, family: 4 | 6): boolean {
  return family === 4 ? isPrivateIPv4String(ip) : isPrivateIPv6String(ip);
}

interface ResolvedHost {
  url: URL;
  ip: string;
  family: 4 | 6;
}

async function resolveSafe(rawUrl: string): Promise<ResolvedHost> {
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
  const literal = isIP(host);
  if (literal === 4) {
    if (isPrivateIPv4String(host)) throw new Error("Private/loopback addresses are not allowed");
    return { url: parsed, ip: host, family: 4 };
  }
  if (literal === 6) {
    if (isPrivateIPv6String(host)) throw new Error("Private/loopback addresses are not allowed");
    return { url: parsed, ip: host, family: 6 };
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error("Hostname did not resolve");
  for (const a of addrs) {
    if (isPrivateIp(a.address, a.family as 4 | 6)) {
      throw new Error("Host resolves to a private address");
    }
  }
  // Pin to the first resolved address to defeat DNS rebinding.
  const first = addrs[0];
  return { url: parsed, ip: first.address, family: first.family as 4 | 6 };
}

/**
 * Build a one-shot undici Agent that pins the TCP connection to the IP
 * address we already validated, so DNS rebinding cannot redirect us at
 * connect time. We send the original Host header (in the URL) so SNI/TLS
 * still works correctly.
 */
function pinnedAgent(ip: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      lookup: (
        _host: string,
        opts: { all?: boolean } | undefined,
        cb: (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void,
      ) => {
        if (opts && opts.all) {
          cb(null, [{ address: ip, family }]);
        } else {
          cb(null, ip, family);
        }
      },
    },
  });
}

export interface ScrapedHtml {
  html: string;
  finalUrl: string;
  contentType: string;
}

/**
 * Fetch a public URL and return its HTML body. Performs SSRF protection
 * (rejects loopback / private IPs across IPv4 + IPv6, pins resolved IP to
 * defeat DNS rebinding, manually follows redirects re-validating each hop),
 * caps body size, and rewrites relative URLs in the response so downstream
 * parsing keeps working.
 */
export async function scrapeUrl(rawUrl: string): Promise<ScrapedHtml> {
  let current = rawUrl;
  let response: Awaited<ReturnType<typeof undiciFetch>> | null = null;
  let finalUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resolved = await resolveSafe(current);
    const agent = pinnedAgent(resolved.ip, resolved.family);
    const res = await undiciFetch(resolved.url.toString(), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "WP-Bridge-AI/1.0 (+https://replit.com)",
        Accept: "text/html,application/xhtml+xml",
      },
      dispatcher: agent,
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      try { res.body?.cancel(); } catch { /* ignore */ }
      try { await agent.close(); } catch { /* ignore */ }
      if (!loc) throw new Error(`Redirect ${res.status} with no Location header`);
      const next = new URL(loc, resolved.url).toString();
      if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
      current = next;
      continue;
    }

    response = res;
    finalUrl = resolved.url.toString();
    break;
  }

  if (!response) throw new Error("URL fetch produced no response");

  if (!response.ok) {
    try { response.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`URL fetch failed: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    try { response.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`URL did not return HTML (content-type: ${contentType || "unknown"})`);
  }

  // Cap body size to prevent memory exhaustion from a hostile/huge page.
  const reader = response.body?.getReader();
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
