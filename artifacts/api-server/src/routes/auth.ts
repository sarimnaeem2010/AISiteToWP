import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
} from "../lib/adminAuth";
import {
  setUserSessionCookie,
  clearUserSessionCookie,
  loadUserFromUserCookie,
  USER_SESSION_COOKIE_NAME,
} from "../lib/userAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * POST /api/auth/signup
 * Body: { username, password }
 * Creates a non-admin user, opens a session, sets the user cookie.
 */
router.post("/auth/signup", async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!username || username.length < 3) {
    res.status(400).json({ error: "Username must be at least 3 characters." });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (existing) {
    res.status(409).json({ error: "That username is already taken." });
    return;
  }
  try {
    const [created] = await db
      .insert(usersTable)
      .values({ username, passwordHash: hashPassword(password), isAdmin: false })
      .returning();
    const session = await createSession(created.id);
    setUserSessionCookie(res, session.id, session.expiresAt);
    res.status(201).json({
      user: { id: created.id, username: created.username, isAdmin: created.isAdmin },
    });
  } catch (err) {
    logger.error({ err: String(err) }, "signup failed");
    res.status(500).json({ error: "Could not create account." });
  }
});

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
router.post("/auth/login", async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  const session = await createSession(user.id);
  setUserSessionCookie(res, session.id, session.expiresAt);
  res.json({
    user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
  });
});

/**
 * POST /api/auth/logout
 * Clears the user-cookie session (admin cookie is untouched).
 */
router.post("/auth/logout", async (req, res) => {
  const cookies = (req as { cookies?: Record<string, string> }).cookies ?? {};
  const sessionId = cookies[USER_SESSION_COOKIE_NAME];
  if (sessionId) {
    try {
      await deleteSession(sessionId);
    } catch (err) {
      logger.warn({ err: String(err) }, "logout: deleteSession failed");
    }
  }
  clearUserSessionCookie(res);
  res.json({ ok: true });
});

/**
 * GET /api/auth/me
 * Returns the current user, or 401 if not signed in.
 */
router.get("/auth/me", async (req, res) => {
  const user = await loadUserFromUserCookie(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    displayName: user.displayName ?? null,
    email: user.email ?? null,
  });
});

/**
 * PATCH /api/auth/me
 * Body: { displayName?, email? }
 * Updates the current user's display name and/or email.
 */
router.patch("/auth/me", async (req, res) => {
  const user = await loadUserFromUserCookie(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const body = (req.body ?? {}) as { displayName?: unknown; email?: unknown };
  const updates: { displayName?: string | null; email?: string | null } = {};
  if (body.displayName !== undefined) {
    const v = String(body.displayName ?? "").trim();
    updates.displayName = v.length === 0 ? null : v.slice(0, 80);
  }
  if (body.email !== undefined) {
    const v = String(body.email ?? "").trim();
    if (v.length === 0) {
      updates.email = null;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      res.status(400).json({ error: "Please enter a valid email address." });
      return;
    } else {
      updates.email = v.slice(0, 254);
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update." });
    return;
  }
  try {
    const [updated] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, user.id))
      .returning();
    res.json({
      id: updated.id,
      username: updated.username,
      isAdmin: updated.isAdmin,
      displayName: updated.displayName ?? null,
      email: updated.email ?? null,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "update profile failed");
    res.status(500).json({ error: "Could not update profile." });
  }
});

/**
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 * Verifies the current password before rotating the hash.
 */
router.post("/auth/change-password", async (req, res) => {
  const user = await loadUserFromUserCookie(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (!newPassword || newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters." });
    return;
  }
  const [row] = await db.select().from(usersTable).where(eq(usersTable.id, user.id));
  if (!row || !verifyPassword(currentPassword, row.passwordHash)) {
    res.status(401).json({ error: "Current password is incorrect." });
    return;
  }
  try {
    await db
      .update(usersTable)
      .set({ passwordHash: hashPassword(newPassword) })
      .where(eq(usersTable.id, user.id));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: String(err) }, "change password failed");
    res.status(500).json({ error: "Could not change password." });
  }
});

export default router;
