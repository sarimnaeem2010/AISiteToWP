import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { eq, lt } from "drizzle-orm";
import {
  db,
  usersTable,
  sessionsTable,
  type User,
} from "@workspace/db";
import { logger } from "./logger";
import { workspaceRoot } from "./workspaceRoot";

const SESSION_COOKIE = "wpb_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const INITIAL_PASSWORD_FILE = path.join(workspaceRoot(), ".local", ".admin_initial_password");

/** scrypt-based password hashing — built into Node, no extra deps. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const derived = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(derived, expected);
}

let bootstrapped = false;
let bootstrappingPromise: Promise<void> | null = null;

/**
 * Ensure at least one admin user exists. Behavior:
 *  - If `ADMIN_BOOTSTRAP_USERNAME` and `ADMIN_BOOTSTRAP_PASSWORD` are
 *    both set, seed those.
 *  - Otherwise generate a cryptographically random password, persist
 *    it once to `.local/.admin_initial_password` (mode 0600), and log
 *    a one-line pointer to that file. The password is NEVER printed
 *    to logs.
 *  - This function is idempotent and only ever fires when there are
 *    zero rows in the users table.
 */
export async function bootstrapAdmin(): Promise<void> {
  if (bootstrapped) return;
  if (bootstrappingPromise) return bootstrappingPromise;
  // If bootstrap throws (e.g. transient DB hiccup), clear the cached
  // promise so the next caller can retry. Without this reset the
  // process would be permanently locked out of admin until restart.
  bootstrappingPromise = (async () => {
    // Ensure at least one ADMIN exists — not just any user. If a non-admin
    // user happens to share the bootstrap username, we promote it; otherwise
    // we insert a fresh admin row. This prevents the system from ever
    // booting into a state with zero admin accounts.
    const existingAdmin = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.isAdmin, true))
      .limit(1);
    if (existingAdmin.length > 0) {
      bootstrapped = true;
      return;
    }
    const envUser = process.env.ADMIN_BOOTSTRAP_USERNAME?.trim();
    const envPass = process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim();
    let username: string;
    let password: string;
    if (envUser && envPass) {
      username = envUser;
      password = envPass;
      logger.info({ username }, "Seeded initial admin from ADMIN_BOOTSTRAP_USERNAME/PASSWORD env vars.");
    } else {
      username = envUser || "admin";
      // 24 random bytes -> 32 base64url chars. Strong, no shoulder-surfing risk.
      password = crypto.randomBytes(24).toString("base64url");
      try {
        fs.mkdirSync(path.dirname(INITIAL_PASSWORD_FILE), { recursive: true });
        fs.writeFileSync(
          INITIAL_PASSWORD_FILE,
          `username: ${username}\npassword: ${password}\ncreated: ${new Date().toISOString()}\n`,
          { mode: 0o600 },
        );
      } catch (err) {
        logger.error({ err: String(err) }, "Could not write initial admin password file. Set ADMIN_BOOTSTRAP_USERNAME/PASSWORD env vars instead.");
        throw err;
      }
      logger.warn(
        { username, file: INITIAL_PASSWORD_FILE },
        "Generated initial admin user. The password was written to .local/.admin_initial_password (mode 600). Read it once and rotate via the admin portal.",
      );
    }
    // If a user already exists with this username (e.g. a non-admin row),
    // promote it to admin and reset its password — never blind-insert,
    // which would crash on the unique constraint and leave the system
    // without any admin account.
    const [existingByName] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, username));
    if (existingByName) {
      await db
        .update(usersTable)
        .set({ passwordHash: hashPassword(password), isAdmin: true })
        .where(eq(usersTable.id, existingByName.id));
      logger.warn({ username }, "Promoted existing user to admin and reset its password during bootstrap.");
    } else {
      await db.insert(usersTable).values({
        username,
        passwordHash: hashPassword(password),
        isAdmin: true,
      });
    }
    bootstrapped = true;
  })();
  try {
    await bootstrappingPromise;
  } catch (err) {
    bootstrappingPromise = null;
    throw err;
  }
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  return row ?? null;
}

export async function createSession(userId: number): Promise<{ id: string; expiresAt: Date }> {
  const id = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessionsTable).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
}

export async function findSession(id: string): Promise<{ userId: number; expiresAt: Date } | null> {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id));
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await deleteSession(id);
    return null;
  }
  return { userId: row.userId, expiresAt: row.expiresAt };
}

export async function pruneSessions(): Promise<void> {
  await db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date()));
}

// Scope the admin session cookie to /api/admin so it is never sent on
// regular user-facing requests, tightening the blast radius of XSS or
// accidental cross-route leaks.
const ADMIN_COOKIE_PATH = "/api/admin";

export function setSessionCookie(res: Response, sessionId: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: ADMIN_COOKIE_PATH,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: ADMIN_COOKIE_PATH });
}

export interface AdminUserContext {
  id: number;
  username: string;
  isAdmin: boolean;
}

declare module "express" {
  interface Request {
    adminUser?: AdminUserContext;
  }
}

/**
 * Helper for inline route handlers: pulls the admin user attached by
 * `requireAdmin` middleware. Necessary because the generic Request
 * inferred by Express in inline `(req, res) => ...` handlers does not
 * pick up the `declare module "express"` augmentation above.
 */
export function getAdminUser(req: Request): AdminUserContext {
  const ctx = (req as Request & { adminUser?: AdminUserContext }).adminUser;
  if (!ctx) throw new Error("getAdminUser called without requireAdmin middleware");
  return ctx;
}

/** Resolve the signed-in user from the cookie, or null. */
export async function loadCurrentUser(req: Request): Promise<User | null> {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = await findSession(sessionId);
  if (!session) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId));
  return user ?? null;
}

/**
 * Express middleware: require an authenticated user with `isAdmin = true`.
 * 401 = no/invalid session, 403 = signed in but not admin.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await loadCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!user.isAdmin) {
    res.status(403).json({ error: "Forbidden — admin access required" });
    return;
  }
  req.adminUser = { id: user.id, username: user.username, isAdmin: user.isAdmin };
  next();
}

export const ADMIN_SESSION_COOKIE = SESSION_COOKIE;
