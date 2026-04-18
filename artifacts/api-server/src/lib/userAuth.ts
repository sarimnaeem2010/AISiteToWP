import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";
import { findSession } from "./adminAuth";

const USER_SESSION_COOKIE = "wpb_user_session";

/**
 * User session cookie. Unlike the admin cookie (scoped to /api/admin),
 * the user cookie is scoped to "/" so it travels on both API requests
 * (/api/auth/me, /api/projects/...) and SPA navigations. Sessions are
 * stored in the same `sessions` table as admin sessions; the cookie
 * name is what differentiates the two.
 */
export function setUserSessionCookie(res: Response, sessionId: string, expiresAt: Date): void {
  res.cookie(USER_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export function clearUserSessionCookie(res: Response): void {
  res.clearCookie(USER_SESSION_COOKIE, { path: "/" });
}

/** Resolve the user from the user cookie (NOT the admin cookie). */
export async function loadUserFromUserCookie(req: Request): Promise<User | null> {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  const sessionId = cookies[USER_SESSION_COOKIE];
  if (!sessionId) return null;
  const session = await findSession(sessionId);
  if (!session) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId));
  return user ?? null;
}

export interface UserContext {
  id: number;
  username: string;
  isAdmin: boolean;
}

declare module "express" {
  interface Request {
    currentUser?: UserContext;
  }
}

/** Express middleware: require any authenticated (non-admin OK) user. */
export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await loadUserFromUserCookie(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.currentUser = { id: user.id, username: user.username, isAdmin: user.isAdmin };
  next();
}

export const USER_SESSION_COOKIE_NAME = USER_SESSION_COOKIE;
