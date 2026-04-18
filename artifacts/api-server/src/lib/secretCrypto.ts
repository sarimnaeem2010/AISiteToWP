import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

/**
 * AES-256-GCM helpers for encrypting secrets at rest in the database.
 *
 * The encryption key is sourced from `ADMIN_ENCRYPTION_KEY` (32-byte
 * hex). If the env var is missing, a random key is generated and
 * persisted once to `.local/.admin_encryption_key` (mode 0600). The
 * key is therefore NEVER stored in the same database as the
 * ciphertexts it protects, and is never logged.
 *
 * Production deployments must set `ADMIN_ENCRYPTION_KEY` and rotate
 * the key out-of-band; the file is a development convenience.
 */
import { workspaceRoot } from "./workspaceRoot";
const KEY_FILE = path.join(workspaceRoot(), ".local", ".admin_encryption_key");

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const envKey = process.env.ADMIN_ENCRYPTION_KEY?.trim();
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error("ADMIN_ENCRYPTION_KEY must be 64 hex chars (32 bytes).");
    }
    cachedKey = Buffer.from(envKey, "hex");
    return cachedKey;
  }
  // Dev fallback: generate-and-persist on first use.
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
      if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        cachedKey = Buffer.from(raw, "hex");
        return cachedKey;
      }
      logger.warn({ file: KEY_FILE }, "Encryption key file present but malformed — regenerating.");
    }
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const fresh = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, fresh.toString("hex") + "\n", { mode: 0o600 });
    logger.warn(
      { file: KEY_FILE },
      "Generated a new encryption key. For production, set ADMIN_ENCRYPTION_KEY (64 hex chars) instead of relying on the file.",
    );
    cachedKey = fresh;
    return cachedKey;
  } catch (err) {
    throw new Error(
      `Encryption key unavailable. Set ADMIN_ENCRYPTION_KEY env var (64 hex chars) or ensure ${KEY_FILE} is writable. (${String(err)})`,
    );
  }
}

/** Encrypt UTF-8 plaintext. Output: `iv.tag.ct` base64url. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

/** Decrypt the format produced by `encryptSecret`. Returns null on tamper / format errors. */
export function decryptSecret(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const [ivB, tagB, ctB] = payload.split(".");
    if (!ivB || !tagB || !ctB) return null;
    const key = loadKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB, "base64url")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch (err) {
    logger.error({ err: String(err) }, "Could not decrypt secret — tampered or wrong encryption key.");
    return null;
  }
}
