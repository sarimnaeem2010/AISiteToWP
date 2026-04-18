import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * Locate the monorepo root (the directory containing pnpm-workspace.yaml).
 * Resolution order:
 *   1. WORKSPACE_ROOT env var if set.
 *   2. Walk up from this file until a pnpm-workspace.yaml is found.
 *   3. Walk up from process.cwd() as a last resort.
 *   4. Fall back to process.cwd() itself.
 *
 * This is robust across `pnpm --filter` (cwd = artifact dir), `node dist/...`
 * (cwd = artifact dir), and direct `node` invocations from the repo root.
 */
export function workspaceRoot(): string {
  if (cached) return cached;
  if (process.env.WORKSPACE_ROOT && fs.existsSync(process.env.WORKSPACE_ROOT)) {
    cached = process.env.WORKSPACE_ROOT;
    return cached;
  }
  const candidates: string[] = [];
  try {
    candidates.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* not an ESM module — skip */
  }
  candidates.push(process.cwd());
  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
        cached = dir;
        return cached;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cached = process.cwd();
  return cached;
}
