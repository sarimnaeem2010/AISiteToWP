import AdmZip from "adm-zip";
import path from "node:path";

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"]);
const FONT_EXT = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

interface UploadOpts {
  baseUrl: string;
  headers: Record<string, string>;
  authMode: "basic" | "api_key";
}

/**
 * Upload one binary asset to the WordPress media library and return its URL.
 * For api_key mode, uploads via plugin endpoint that bypasses kses; for basic
 * auth, uses standard wp/v2/media REST endpoint.
 */
async function uploadOne(
  filename: string,
  bytes: Buffer,
  ext: string,
  opts: UploadOpts,
): Promise<string | null> {
  const mime = MIME[ext] ?? "application/octet-stream";
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
  try {
    if (opts.authMode === "api_key") {
      const res = await fetch(`${opts.baseUrl}/wp-json/ai-cms/v1/media`, {
        method: "POST",
        headers: {
          ...opts.headers,
          "Content-Type": mime,
          "X-Filename": safeName,
        },
        body: bytes as unknown as BodyInit,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { url?: string };
      return data.url ?? null;
    }
    const res = await fetch(`${opts.baseUrl}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        ...opts.headers,
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${safeName}"`,
      },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { source_url?: string };
    return data.source_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Walk the original ZIP, upload every image + font to WordPress media, and
 * return a map from the asset's relative ZIP path → uploaded WP media URL.
 */
export async function uploadZipAssets(
  zipBytes: Buffer,
  opts: UploadOpts,
): Promise<{ urlMap: Map<string, string>; uploaded: number }> {
  const urlMap = new Map<string, string>();
  let uploaded = 0;
  const zip = new AdmZip(zipBytes);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName.replace(/\\/g, "/");
    if (entryName.startsWith("__MACOSX/") || entryName.includes("/.DS_Store")) continue;
    const ext = entryName.split(".").pop()?.toLowerCase() ?? "";
    if (!IMG_EXT.has(ext) && !FONT_EXT.has(ext)) continue;
    const url = await uploadOne(path.basename(entryName), entry.getData(), ext, opts);
    if (url) {
      urlMap.set(entryName, url);
      // Also map by basename (HTML often references just "hero.png")
      urlMap.set(path.basename(entryName), url);
      uploaded++;
    }
  }
  return { urlMap, uploaded };
}

/**
 * Strip the leading "./" or "/" from a URL and normalize "../" segments
 * to find a matching entry in our urlMap.
 */
function lookupAsset(rawRef: string, urlMap: Map<string, string>): string | null {
  if (/^(https?:|data:|mailto:|#|javascript:)/i.test(rawRef)) return null;
  // Normalize: drop ./ and leading /
  let ref = rawRef.split("?")[0].split("#")[0];
  ref = ref.replace(/^\.?\//, "");
  // Try direct match
  if (urlMap.has(ref)) return urlMap.get(ref)!;
  // Try basename
  const base = ref.split("/").pop() ?? ref;
  if (urlMap.has(base)) return urlMap.get(base)!;
  // Try suffix match (some entries may include a parent folder prefix)
  for (const [key, val] of urlMap) {
    if (key.endsWith(ref) || key.endsWith(`/${base}`)) return val;
  }
  return null;
}

/**
 * Rewrite every src/href/srcset/url(...) reference in HTML or CSS to point
 * at the uploaded WordPress media URL when we have one. Leaves untouched
 * references (like external CDN URLs or unmatched paths) intact.
 */
export function rewriteAssetUrls(input: string, urlMap: Map<string, string>): string {
  if (urlMap.size === 0) return input;
  // src="...", href="...", action="..." -- both single + double quoted
  let out = input.replace(
    /(src|href|action|data-src|data-bg|poster)\s*=\s*(["'])([^"']+)\2/gi,
    (m, attr, q, ref) => {
      const replacement = lookupAsset(ref, urlMap);
      return replacement ? `${attr}=${q}${replacement}${q}` : m;
    },
  );
  // srcset="img1.png 1x, img2.png 2x"
  out = out.replace(/(srcset)\s*=\s*(["'])([^"']+)\2/gi, (_m, attr, q, value) => {
    const rewritten = (value as string)
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const sp = trimmed.split(/\s+/);
        const url = sp[0];
        const rest = sp.slice(1).join(" ");
        const newUrl = lookupAsset(url, urlMap) ?? url;
        return rest ? `${newUrl} ${rest}` : newUrl;
      })
      .join(", ");
    return `${attr}=${q}${rewritten}${q}`;
  });
  // CSS url(...) -- handles url(x), url('x'), url("x")
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
    const replacement = lookupAsset(ref, urlMap);
    return replacement ? `url(${q}${replacement}${q})` : m;
  });
  return out;
}
