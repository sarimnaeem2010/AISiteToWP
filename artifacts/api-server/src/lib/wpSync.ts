import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { logger } from "./logger";

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
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
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

interface WpConfig {
  wpUrl: string;
  wpUsername: string;
  wpAppPassword: string;
  useAcf?: boolean;
}

interface WpBlock {
  blockType: string;
  acfGroup?: string | null;
  fields: Record<string, unknown>;
  innerBlocks?: Record<string, unknown>[];
}

interface WpPage {
  title: string;
  slug: string;
  blocks: WpBlock[];
}

interface WpStructure {
  pages: WpPage[];
}

interface PushLogEntry {
  pageName: string;
  status: "success" | "error" | "skipped";
  wpId?: number | null;
  wpUrl?: string | null;
  error?: string | null;
  createdAt: string;
}

interface PushResult {
  success: boolean;
  pagesCreated: number;
  pagesUpdated: number;
  mediaUploaded: number;
  errors: string[];
  wpPageUrls: string[];
  log: PushLogEntry[];
}

function blocksToGutenbergContent(blocks: WpBlock[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const { blockType, fields, innerBlocks } = block;

    if (blockType === "core/html") {
      const content = typeof fields.content === "string" ? fields.content : "";
      if (content) {
        lines.push(`<!-- wp:html -->\n${content}\n<!-- /wp:html -->`);
        continue;
      }
    }

    if (blockType === "core/cover") {
      lines.push(`<!-- wp:cover {"dimRatio":50} -->`);
      lines.push(`<div class="wp-block-cover"><div class="wp-block-cover__inner-container">`);
      if (fields.headline) {
        lines.push(`<!-- wp:heading --><h2 class="wp-block-heading">${String(fields.headline)}</h2><!-- /wp:heading -->`);
      }
      if (fields.subheadline) {
        lines.push(`<!-- wp:paragraph --><p>${String(fields.subheadline)}</p><!-- /wp:paragraph -->`);
      }
      if (fields.cta_text) {
        const ctaUrl = String(fields.cta_url || "#");
        lines.push(`<!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link" href="${ctaUrl}">${String(fields.cta_text)}</a></div><!-- /wp:button --></div><!-- /wp:buttons -->`);
      }
      lines.push(`</div></div><!-- /wp:cover -->`);
      continue;
    }

    if (blockType === "core/columns" || blockType === "core/group") {
      lines.push(`<!-- wp:group {"layout":{"type":"constrained"}} -->`);
      lines.push(`<div class="wp-block-group">`);
      if (fields.section_title || fields.heading) {
        lines.push(`<!-- wp:heading --><h2 class="wp-block-heading">${String(fields.section_title || fields.heading || "")}</h2><!-- /wp:heading -->`);
      }
      if (fields.section_subtitle || fields.subheading || fields.body) {
        lines.push(`<!-- wp:paragraph --><p>${String(fields.section_subtitle || fields.subheading || fields.body || "")}</p><!-- /wp:paragraph -->`);
      }
      if (innerBlocks && innerBlocks.length > 0) {
        for (const inner of innerBlocks) {
          const innerBlock = inner as WpBlock;
          if (innerBlock.fields.title || innerBlock.fields.description || innerBlock.fields.quote) {
            lines.push(`<!-- wp:group --><div class="wp-block-group">`);
            if (innerBlock.fields.title) lines.push(`<!-- wp:heading {"level":3} --><h3 class="wp-block-heading">${String(innerBlock.fields.title)}</h3><!-- /wp:heading -->`);
            if (innerBlock.fields.description) lines.push(`<!-- wp:paragraph --><p>${String(innerBlock.fields.description)}</p><!-- /wp:paragraph -->`);
            if (innerBlock.fields.quote) lines.push(`<!-- wp:quote --><blockquote class="wp-block-quote"><p>${String(innerBlock.fields.quote)}</p><cite>${String(innerBlock.fields.author_name || "")}</cite></blockquote><!-- /wp:quote -->`);
            if (innerBlock.fields.question) {
              lines.push(`<!-- wp:details --><details class="wp-block-details"><summary>${String(innerBlock.fields.question)}</summary><div class="wp-block-details__content"><!-- wp:paragraph --><p>${String(innerBlock.fields.answer || "")}</p><!-- /wp:paragraph --></div></details><!-- /wp:details -->`);
            }
            lines.push(`</div><!-- /wp:group -->`);
          }
        }
      }
      lines.push(`</div><!-- /wp:group -->`);
      continue;
    }

    if (blockType === "core/gallery") {
      lines.push(`<!-- wp:gallery --><figure class="wp-block-gallery"></figure><!-- /wp:gallery -->`);
      continue;
    }

    if (blockType === "core/query") {
      lines.push(`<!-- wp:query {"query":{"perPage":${Number(fields.posts_per_page || 3)},"postType":"post"}} -->`);
      lines.push(`<div class="wp-block-query"><!-- wp:post-template --><!-- wp:post-title /--><!-- wp:post-excerpt /--><!-- /wp:post-template --></div><!-- /wp:query -->`);
      continue;
    }

    if (fields.section_title || fields.heading) {
      lines.push(`<!-- wp:heading --><h2 class="wp-block-heading">${String(fields.section_title || fields.heading || "")}</h2><!-- /wp:heading -->`);
    }
    if (fields.section_body || fields.description || fields.body) {
      lines.push(`<!-- wp:paragraph --><p>${String(fields.section_body || fields.description || fields.body || "")}</p><!-- /wp:paragraph -->`);
    }
  }

  return lines.join("\n");
}

export async function testConnection(config: WpConfig): Promise<{ success: boolean; message: string; wpVersion?: string; siteTitle?: string }> {
  const { wpUrl, wpUsername, wpAppPassword } = config;
  try {
    await assertSafeUrl(wpUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `URL rejected: ${msg}` };
  }
  const baseUrl = wpUrl.replace(/\/$/, "");
  const auth = Buffer.from(`${wpUsername}:${wpAppPassword}`).toString("base64");

  try {
    const response = await fetch(`${baseUrl}/wp-json/wp/v2/`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { success: false, message: `WordPress API returned ${response.status}: ${body.slice(0, 200)}` };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      message: "Connection successful",
      wpVersion: String(data.namespaces ? "REST API active" : "Connected"),
      siteTitle: String(data.name || "WordPress Site"),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Connection failed: ${msg}` };
  }
}

export async function pushToWordPress(
  config: WpConfig,
  wpStructure: WpStructure
): Promise<PushResult> {
  const { wpUrl, wpUsername, wpAppPassword } = config;
  await assertSafeUrl(wpUrl);
  const baseUrl = wpUrl.replace(/\/$/, "");
  const auth = Buffer.from(`${wpUsername}:${wpAppPassword}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };

  let pagesCreated = 0;
  let pagesUpdated = 0;
  const errors: string[] = [];
  const wpPageUrls: string[] = [];
  const log: PushLogEntry[] = [];

  for (const page of wpStructure.pages) {
    try {
      const content = blocksToGutenbergContent(page.blocks);

      const existingRes = await fetch(
        `${baseUrl}/wp-json/wp/v2/pages?slug=${encodeURIComponent(page.slug)}&status=any`,
        { headers }
      );
      const existing = (await existingRes.json()) as Array<{ id: number; link: string }>;

      let wpId: number;
      let wpLink: string;

      if (Array.isArray(existing) && existing.length > 0) {
        const updateRes = await fetch(`${baseUrl}/wp-json/wp/v2/pages/${existing[0].id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            title: page.title,
            content,
            slug: page.slug,
            status: "publish",
          }),
        });

        if (!updateRes.ok) {
          const errBody = await updateRes.text().catch(() => "");
          throw new Error(`Update failed: ${updateRes.status} ${errBody.slice(0, 200)}`);
        }

        const updated = (await updateRes.json()) as { id: number; link: string };
        wpId = updated.id;
        wpLink = updated.link;
        pagesUpdated++;
      } else {
        const createRes = await fetch(`${baseUrl}/wp-json/wp/v2/pages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: page.title,
            content,
            slug: page.slug,
            status: "publish",
          }),
        });

        if (!createRes.ok) {
          const errBody = await createRes.text().catch(() => "");
          throw new Error(`Create failed: ${createRes.status} ${errBody.slice(0, 200)}`);
        }

        const created = (await createRes.json()) as { id: number; link: string };
        wpId = created.id;
        wpLink = created.link;
        pagesCreated++;
      }

      wpPageUrls.push(wpLink);
      log.push({
        pageName: page.title,
        status: "success",
        wpId,
        wpUrl: wpLink,
        error: null,
        createdAt: new Date().toISOString(),
      });

      logger.info({ page: page.title, wpId }, "Page pushed to WordPress");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${page.title}: ${msg}`);
      log.push({
        pageName: page.title,
        status: "error",
        wpId: null,
        wpUrl: null,
        error: msg,
        createdAt: new Date().toISOString(),
      });
      logger.error({ page: page.title, err: msg }, "Failed to push page");
    }
  }

  return {
    success: errors.length === 0,
    pagesCreated,
    pagesUpdated,
    mediaUploaded: 0,
    errors,
    wpPageUrls,
    log,
  };
}
