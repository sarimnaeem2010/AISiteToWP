import crypto from "node:crypto";
import OpenAI from "openai";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  aiSettingsTable,
  aiCacheTable,
  aiTokenLogTable,
  type AiSettings,
} from "@workspace/db";
import { logger } from "./logger";
import { encryptSecret, decryptSecret } from "./secretCrypto";

const SETTINGS_ID = 1;

/** Decrypt the API key from settings, or null if not set / corrupt. */
function decryptedKey(row: AiSettings): string | null {
  return decryptSecret(row.apiKeyCiphertext);
}

export const SHARED_BASE_SYSTEM_MESSAGE = `You are an AI engine inside a WordPress site builder.
Always:
- Output strictly valid JSON matching the requested schema. No prose.
- Never invent components or widgets that were not present in the input.
- Prefer minimal nesting and Elementor-friendly structures (sections > columns > widgets).
- Do not hallucinate fields, classes, or attributes.`;

export type EngineName =
  | "semantic"
  | "widget"
  | "designAudit"
  | "master"
  | "chatRefine"
  | "legacyAnalyzer";

export interface AiSettingsPublic {
  enabled: boolean;
  hasKey: boolean;
  keyPreview: string | null;
  model: string;
  maxTokens: number;
  masterControllerMode: boolean;
  status: "connected" | "invalid_key" | "disabled" | "unknown";
  statusMessage: string | null;
  lastTestedAt: string | null;
  updatedAt: string;
}

async function loadSettingsRow(): Promise<AiSettings> {
  const [row] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.id, SETTINGS_ID));
  if (row) return row;
  const [inserted] = await db
    .insert(aiSettingsTable)
    .values({ id: SETTINGS_ID })
    .returning();
  return inserted;
}

export async function getAiSettings(): Promise<AiSettings> {
  return loadSettingsRow();
}

export function toPublicSettings(row: AiSettings): AiSettingsPublic {
  const hasKey = Boolean(row.apiKeyCiphertext);
  const keyPreview = hasKey && row.apiKeyLast4 ? `••••${row.apiKeyLast4}` : null;
  let status: AiSettingsPublic["status"];
  if (!row.enabled) status = "disabled";
  else if (!hasKey) status = "invalid_key";
  else if (row.status === "connected") status = "connected";
  else if (row.status === "invalid_key") status = "invalid_key";
  else status = "unknown";
  return {
    enabled: row.enabled,
    hasKey,
    keyPreview,
    model: row.model,
    maxTokens: row.maxTokens,
    masterControllerMode: row.masterControllerMode,
    status,
    statusMessage: row.statusMessage,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface UpdateSettingsInput {
  enabled?: boolean;
  apiKey?: string | null;
  model?: string;
  maxTokens?: number;
  masterControllerMode?: boolean;
}

export async function updateAiSettings(input: UpdateSettingsInput): Promise<AiSettings> {
  const existing = await loadSettingsRow();
  const next: Partial<AiSettings> = {};
  if (typeof input.enabled === "boolean") next.enabled = input.enabled;
  if (input.apiKey !== undefined) {
    if (input.apiKey && input.apiKey.length > 0) {
      next.apiKeyCiphertext = encryptSecret(input.apiKey);
      next.apiKeyLast4 = input.apiKey.slice(-4);
    } else {
      next.apiKeyCiphertext = null;
      next.apiKeyLast4 = null;
    }
    next.status = "unknown";
    next.statusMessage = null;
    next.lastTestedAt = null;
  }
  if (typeof input.model === "string" && input.model.length > 0) next.model = input.model;
  if (typeof input.maxTokens === "number" && input.maxTokens > 0) {
    next.maxTokens = Math.min(32768, Math.max(64, Math.floor(input.maxTokens)));
  }
  if (typeof input.masterControllerMode === "boolean") {
    next.masterControllerMode = input.masterControllerMode;
  }
  if (Object.keys(next).length === 0) return existing;
  const [updated] = await db
    .update(aiSettingsTable)
    .set(next)
    .where(eq(aiSettingsTable.id, SETTINGS_ID))
    .returning();
  return updated;
}

export async function isAiEnabled(): Promise<boolean> {
  const s = await loadSettingsRow();
  return s.enabled && Boolean(s.apiKeyCiphertext) && s.status !== "invalid_key";
}

function makeClient(apiKey: string): OpenAI {
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

export interface TestKeyResult {
  valid: boolean;
  message: string;
}

export async function testApiKey(rawKey?: string): Promise<TestKeyResult> {
  const settings = await loadSettingsRow();
  const key = rawKey ?? decryptedKey(settings) ?? "";
  if (!key) {
    await db.update(aiSettingsTable).set({
      status: "invalid_key",
      statusMessage: "No API key configured.",
      lastTestedAt: new Date(),
    }).where(eq(aiSettingsTable.id, SETTINGS_ID));
    return { valid: false, message: "No API key configured." };
  }
  const client = makeClient(key);
  try {
    const res = await client.chat.completions.create({
      model: settings.model || "gpt-4o-mini",
      max_tokens: 32,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: 'Return strictly the JSON {"status":"ok"}.' },
        { role: "user", content: "ping" },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    let parsed: { status?: string } = {};
    try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    const ok = parsed.status === "ok";
    await db.update(aiSettingsTable).set({
      status: ok ? "connected" : "unknown",
      statusMessage: ok ? "OK" : `Unexpected probe response: ${raw.slice(0, 80)}`,
      lastTestedAt: new Date(),
    }).where(eq(aiSettingsTable.id, SETTINGS_ID));
    return { valid: ok, message: ok ? "API key is valid." : "Probe call did not return ok." };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const looksInvalid = /401|403|invalid|unauthorized|api key/i.test(msg);
    await db.update(aiSettingsTable).set({
      status: looksInvalid ? "invalid_key" : "unknown",
      statusMessage: msg.slice(0, 240),
      lastTestedAt: new Date(),
    }).where(eq(aiSettingsTable.id, SETTINGS_ID));
    return { valid: false, message: msg };
  }
}

export function hashInput(input: unknown): string {
  return crypto
    .createHash("sha256")
    .update(typeof input === "string" ? input : JSON.stringify(input))
    .digest("hex");
}

export interface CacheEntry<T> {
  output: T;
  cached: boolean;
  tokensUsed: number;
  model: string | null;
  createdAt: string;
}

export async function readCache<T>(
  projectId: number,
  engine: EngineName,
  inputHash: string,
): Promise<CacheEntry<T> | null> {
  const [row] = await db
    .select()
    .from(aiCacheTable)
    .where(
      and(
        eq(aiCacheTable.projectId, projectId),
        eq(aiCacheTable.engine, engine),
        eq(aiCacheTable.inputHash, inputHash),
      ),
    )
    .orderBy(desc(aiCacheTable.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    output: row.output as T,
    cached: true,
    tokensUsed: row.tokensUsed ?? 0,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function writeCache(
  projectId: number,
  engine: EngineName,
  inputHash: string,
  output: unknown,
  tokensUsed: number,
  model: string,
): Promise<void> {
  await db.insert(aiCacheTable).values({
    projectId,
    engine,
    inputHash,
    output: output as never,
    tokensUsed,
    model,
  });
}

export async function logTokenUsage(
  projectId: number | null,
  engine: EngineName,
  model: string,
  tokens: number,
  cacheHit: boolean,
): Promise<void> {
  await db.insert(aiTokenLogTable).values({
    projectId,
    engine,
    model,
    tokensUsed: tokens,
    cacheHit,
  });
}

export interface RunOptions {
  projectId?: number | null;
  engine: EngineName;
  systemPrompt: string;
  userPrompt: string;
  /** When provided, will check & populate cache. */
  cacheKey?: { projectId: number; inputHash: string };
  /** Override model from settings. */
  modelOverride?: string;
  /** Override max tokens from settings. */
  maxTokensOverride?: number;
}

export interface RunResult<T> {
  output: T | null;
  cached: boolean;
  tokensUsed: number;
  error?: string;
}

/**
 * Core engine runner. Enforces JSON output, applies max-tokens cap,
 * checks/writes cache (when cacheKey given), records usage. Returns
 * `{output: null}` when AI is disabled / key missing — caller must
 * fall back to deterministic path.
 */
export async function runEngine<T>(opts: RunOptions): Promise<RunResult<T>> {
  const settings = await loadSettingsRow();
  const apiKey = decryptedKey(settings);
  const enabled = settings.enabled && Boolean(apiKey) && settings.status !== "invalid_key";

  if (opts.cacheKey) {
    const hit = await readCache<T>(opts.cacheKey.projectId, opts.engine, opts.cacheKey.inputHash);
    if (hit) {
      await logTokenUsage(opts.cacheKey.projectId, opts.engine, hit.model ?? settings.model, 0, true);
      return { output: hit.output, cached: true, tokensUsed: 0 };
    }
  }

  if (!enabled) {
    return { output: null, cached: false, tokensUsed: 0, error: "ai_disabled" };
  }

  const model = opts.modelOverride ?? settings.model ?? "gpt-4o-mini";
  const maxTokens = opts.maxTokensOverride ?? settings.maxTokens ?? 4096;

  const client = makeClient(apiKey!);
  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${SHARED_BASE_SYSTEM_MESSAGE}\n\n${opts.systemPrompt}` },
        { role: "user", content: opts.userPrompt },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const tokensUsed = res.usage?.total_tokens ?? 0;
    let parsed: T | null = null;
    try { parsed = JSON.parse(raw) as T; } catch (parseErr) {
      logger.warn({ engine: opts.engine, parseErr: String(parseErr) }, "AI engine returned invalid JSON");
      await logTokenUsage(opts.projectId ?? null, opts.engine, model, tokensUsed, false);
      return { output: null, cached: false, tokensUsed, error: "invalid_json" };
    }
    if (opts.cacheKey) {
      await writeCache(opts.cacheKey.projectId, opts.engine, opts.cacheKey.inputHash, parsed, tokensUsed, model);
    }
    await logTokenUsage(opts.projectId ?? null, opts.engine, model, tokensUsed, false);
    return { output: parsed, cached: false, tokensUsed };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ engine: opts.engine, err: msg }, "AI engine call failed");
    if (/401|403|invalid|unauthorized|api key/i.test(msg)) {
      await db.update(aiSettingsTable).set({
        status: "invalid_key",
        statusMessage: msg.slice(0, 240),
      }).where(eq(aiSettingsTable.id, SETTINGS_ID));
    }
    return { output: null, cached: false, tokensUsed: 0, error: msg };
  }
}

/**
 * Invalidate every cache row for a project — call when source HTML changes.
 */
export async function invalidateProjectCache(projectId: number): Promise<void> {
  await db.delete(aiCacheTable).where(eq(aiCacheTable.projectId, projectId));
}

/**
 * Most-recent AI run timestamp for a project (across any engine).
 */
export async function lastRunForProject(projectId: number): Promise<{
  lastRunAt: string | null;
  cacheEntries: number;
}> {
  const [row] = await db
    .select()
    .from(aiCacheTable)
    .where(eq(aiCacheTable.projectId, projectId))
    .orderBy(desc(aiCacheTable.createdAt))
    .limit(1);
  const all = await db
    .select({ id: aiCacheTable.id })
    .from(aiCacheTable)
    .where(eq(aiCacheTable.projectId, projectId));
  return {
    lastRunAt: row?.createdAt.toISOString() ?? null,
    cacheEntries: all.length,
  };
}
