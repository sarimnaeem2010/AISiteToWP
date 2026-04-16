import AdmZip from "adm-zip";

export interface ExtractedFile {
  path: string;
  size: number;
  type: "html" | "css" | "js" | "image" | "other";
}

export interface ExtractedProject {
  files: ExtractedFile[];
  indexHtml: string;
  indexPath: string;
  cssFiles: { path: string; content: string }[];
}

const MAX_TOTAL_SIZE = 50 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const ALLOWED_EXT = new Set([
  "html", "htm", "css", "js", "mjs", "json", "txt", "md", "svg",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf", "eot", "map",
]);

function classify(p: string): ExtractedFile["type"] {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "css") return "css";
  if (ext === "js" || ext === "mjs") return "js";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"].includes(ext)) return "image";
  return "other";
}

export function extractZip(buffer: Buffer): ExtractedProject {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  if (entries.length > MAX_FILE_COUNT) {
    throw new Error(`ZIP exceeds max file count (${MAX_FILE_COUNT})`);
  }

  const files: ExtractedFile[] = [];
  const cssFiles: { path: string; content: string }[] = [];
  const htmlCandidates: { path: string; content: string; depth: number }[] = [];
  let totalSize = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName.replace(/\\/g, "/");
    if (entryName.includes("..") || entryName.startsWith("/")) {
      throw new Error(`Unsafe path in ZIP: ${entryName}`);
    }
    if (entryName.startsWith("__MACOSX/") || entryName.includes("/.DS_Store")) continue;

    const ext = entryName.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXT.has(ext)) continue;

    const size = entry.header.size;
    totalSize += size;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error(`ZIP exceeds max total size (${MAX_TOTAL_SIZE} bytes)`);
    }

    const kind = classify(entryName);
    files.push({ path: entryName, size, type: kind });

    if (kind === "html") {
      const content = entry.getData().toString("utf8");
      const depth = entryName.split("/").length - 1;
      htmlCandidates.push({ path: entryName, content, depth });
    } else if (kind === "css") {
      cssFiles.push({ path: entryName, content: entry.getData().toString("utf8") });
    }
  }

  if (htmlCandidates.length === 0) {
    throw new Error("No HTML files found in ZIP");
  }

  htmlCandidates.sort((a, b) => {
    const aIsIndex = /(^|\/)index\.html?$/i.test(a.path) ? 0 : 1;
    const bIsIndex = /(^|\/)index\.html?$/i.test(b.path) ? 0 : 1;
    if (aIsIndex !== bIsIndex) return aIsIndex - bIsIndex;
    return a.depth - b.depth;
  });

  const pick = htmlCandidates[0];
  return {
    files,
    indexHtml: pick.content,
    indexPath: pick.path,
    cssFiles,
  };
}
