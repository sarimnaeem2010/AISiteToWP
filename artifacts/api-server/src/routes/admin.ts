import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, and, ne, asc, gte, lte, sql } from "drizzle-orm";
import { db, projectsTable, usersTable, sessionsTable, aiTokenLogTable } from "@workspace/db";
import {
  bootstrapAdmin,
  findUserByUsername,
  verifyPassword,
  hashPassword,
  createSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
  loadCurrentUser,
  getAdminUser,
} from "../lib/adminAuth";
import {
  getAiSettings,
  toPublicSettings,
  updateAiSettings,
  testApiKey,
  invalidateProjectCache,
  lastRunForProject,
} from "../lib/aiClient";
import { parseHtml } from "../lib/parser";
import { mapToWordPress, type CustomPostTypeDef } from "../lib/wpMapper";
import type { SuggestedCpt } from "../lib/aiAnalyzer";

const router: IRouter = Router();

void bootstrapAdmin().catch(() => { /* logged inside */ });

// ---- Auth ---------------------------------------------------------------
const LoginSchema = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(500),
});

router.post("/admin/login", async (req, res): Promise<void> => {
  await bootstrapAdmin();
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = await findUserByUsername(parsed.data.username);
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (!user.isAdmin) {
    res.status(403).json({ error: "Account does not have admin access" });
    return;
  }
  const session = await createSession(user.id);
  setSessionCookie(res, session.id, session.expiresAt);
  res.json({ user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
});

router.post("/admin/logout", async (req, res): Promise<void> => {
  const cookies = (req as { cookies?: Record<string, string> }).cookies ?? {};
  const sessionId = cookies["wpb_admin_session"];
  if (sessionId) {
    await deleteSession(sessionId);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/admin/me", async (req, res): Promise<void> => {
  // Soft probe — used by the frontend shell to choose between login
  // screen vs portal vs forbidden page.
  const user = await loadCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!user.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json({ user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
});

// ---- Admin user management (admin only) ---------------------------------
// All admins can manage all admin accounts. Two invariants are enforced
// server-side to prevent lockout:
//   1. The system must always retain at least one admin (no demoting the
//      last one).
//   2. An admin cannot demote themselves — a peer must do it. This avoids
//      the foot-gun where a single admin accidentally locks themselves out.

function toPublicUser(u: { id: number; username: string; isAdmin: boolean; createdAt: Date }) {
  return { id: u.id, username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt };
}

router.get("/admin/users", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      isAdmin: usersTable.isAdmin,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(asc(usersTable.id));
  res.json({ users: rows.map(toPublicUser) });
});

const CreateUserSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(500),
  isAdmin: z.boolean().optional().default(true),
});

router.post("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await findUserByUsername(parsed.data.username);
  if (existing) {
    res.status(409).json({ error: "Username already exists" });
    return;
  }
  const [row] = await db
    .insert(usersTable)
    .values({
      username: parsed.data.username,
      passwordHash: hashPassword(parsed.data.password),
      isAdmin: parsed.data.isAdmin,
    })
    .returning({
      id: usersTable.id,
      username: usersTable.username,
      isAdmin: usersTable.isAdmin,
      createdAt: usersTable.createdAt,
    });
  res.status(201).json({ user: toPublicUser(row) });
});

const ChangePasswordSchema = z.object({
  newPassword: z.string().min(8).max(500),
  // Required only when changing your own password — defense in depth so
  // a hijacked session cannot trivially rotate the cookie owner's pwd.
  currentPassword: z.string().min(1).max(500).optional(),
});

router.put("/admin/users/:id/password", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const parsed = ChangePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const isSelf = getAdminUser(req).id === id;
  if (isSelf) {
    if (!parsed.data.currentPassword) {
      res.status(400).json({ error: "currentPassword is required when changing your own password" });
      return;
    }
    if (!verifyPassword(parsed.data.currentPassword, target.passwordHash)) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
  }
  await db
    .update(usersTable)
    .set({ passwordHash: hashPassword(parsed.data.newPassword) })
    .where(eq(usersTable.id, id));
  // Invalidate every active session for the target so a rotated password
  // takes effect immediately — matches the UI copy ("they will need to
  // sign in again") and limits blast radius if the old password leaked.
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, id));
  // If the admin rotated their own password, mint a fresh session so they
  // are not bounced to the login screen on the next request.
  if (isSelf) {
    const session = await createSession(id);
    setSessionCookie(res, session.id, session.expiresAt);
  }
  res.json({ ok: true });
});

const ToggleAdminSchema = z.object({ isAdmin: z.boolean() });

router.put("/admin/users/:id/admin", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const parsed = ToggleAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  // Guard: never demote yourself.
  if (getAdminUser(req).id === id && parsed.data.isAdmin === false) {
    res.status(400).json({ error: "You cannot remove your own admin access. Ask another admin to do it." });
    return;
  }
  // Guard: never demote the last remaining admin. Counts admins OTHER than
  // the target — if zero, demoting target would leave the system locked out.
  if (target.isAdmin && parsed.data.isAdmin === false) {
    const others = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.isAdmin, true), ne(usersTable.id, id)));
    if (others.length === 0) {
      res.status(400).json({ error: "Cannot remove the last admin. Promote another user first." });
      return;
    }
  }
  await db.update(usersTable).set({ isAdmin: parsed.data.isAdmin }).where(eq(usersTable.id, id));
  const [row] = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      isAdmin: usersTable.isAdmin,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, id));
  res.json({ user: toPublicUser(row) });
});

// ---- AI Settings (admin only) -------------------------------------------
router.get("/admin/ai-settings", requireAdmin, async (_req, res): Promise<void> => {
  const row = await getAiSettings();
  res.json(toPublicSettings(row));
});

const UpdateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().max(500).nullable().optional(),
  model: z.string().min(1).max(120).optional(),
  maxTokens: z.number().int().min(64).max(32768).optional(),
  masterControllerMode: z.boolean().optional(),
});

router.put("/admin/ai-settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Treat empty string as "clear key".
  const input = { ...parsed.data };
  if (typeof input.apiKey === "string" && input.apiKey.length === 0) input.apiKey = null;
  const updated = await updateAiSettings(input);
  res.json(toPublicSettings(updated));
});

const TestKeySchema = z.object({ apiKey: z.string().max(500).optional() });

router.post("/admin/ai-settings/test-key", requireAdmin, async (req, res): Promise<void> => {
  const parsed = TestKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await testApiKey(parsed.data.apiKey);
  const row = await getAiSettings();
  res.json({ ...result, settings: toPublicSettings(row) });
});

// ---- Project AI controls -------------------------------------------------
router.get("/admin/projects/:id/ai-status", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const status = await lastRunForProject(id);
  res.json(status);
});

router.post("/admin/projects/:id/reanalyze", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!project.sourceHtml) {
    res.status(400).json({ error: "Project has no source HTML to re-analyze" });
    return;
  }
  // Invalidate cache so the analyzer runs fresh.
  await invalidateProjectCache(project.id);
  const { parsedSite, designSystem, aiAnalysis } = await parseHtml(project.sourceHtml, project.id);
  const existingCpts = (project.customPostTypes as CustomPostTypeDef[] | null) ?? [];
  const suggested: CustomPostTypeDef[] = (aiAnalysis?.suggestedCpts ?? []).map((s: SuggestedCpt) => ({
    slug: s.slug,
    label: s.label,
    pluralLabel: s.pluralLabel,
    sourceSemanticType: s.sourceSemanticType,
    fields: s.fields,
    enabled: false,
  }));
  const mergedCpts: CustomPostTypeDef[] = [
    ...existingCpts,
    ...suggested.filter((s) => !existingCpts.some((e) => e.slug === s.slug)),
  ];
  const wpStructure = mapToWordPress(parsedSite, mergedCpts);
  await db
    .update(projectsTable)
    .set({
      parsedSite: parsedSite as never,
      designSystem: designSystem as never,
      wpStructure: wpStructure as never,
      aiAnalysis: (aiAnalysis ?? null) as never,
      customPostTypes: mergedCpts as never,
      pageCount: parsedSite.pages.length,
    })
    .where(eq(projectsTable.id, project.id));

  const status = await lastRunForProject(project.id);
  res.json({
    ok: true,
    usedAi: Boolean(aiAnalysis),
    pageCount: parsedSite.pages.length,
    aiStatus: status,
  });
});

// ---- AI usage aggregation (admin only) ----------------------------------
// Rough blended $/1M-token estimates. Real OpenAI pricing splits prompt vs
// completion, but the log table only stores a single `tokensUsed` total per
// call, so we apply a conservative blended rate per model.
const MODEL_COST_PER_1M_TOKENS: Record<string, number> = {
  "gpt-4o-mini": 0.4,
  "gpt-4o": 5.0,
  "gpt-4-turbo": 10.0,
  "gpt-4": 30.0,
  "gpt-3.5-turbo": 0.75,
};
const DEFAULT_COST_PER_1M_TOKENS = 1.0;

function estimateCostUsd(model: string, tokens: number): number {
  const rate = MODEL_COST_PER_1M_TOKENS[model] ?? DEFAULT_COST_PER_1M_TOKENS;
  return (tokens / 1_000_000) * rate;
}

const AiUsageQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

router.get("/admin/ai-usage", requireAdmin, async (req, res): Promise<void> => {
  const parsed = AiUsageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const fromDate = parsed.data.from ? new Date(parsed.data.from) : null;
  const toDate = parsed.data.to ? new Date(parsed.data.to) : null;

  const filters = [
    fromDate ? gte(aiTokenLogTable.createdAt, fromDate) : undefined,
    toDate ? lte(aiTokenLogTable.createdAt, toDate) : undefined,
  ].filter((c): c is NonNullable<typeof c> => Boolean(c));
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  interface UsageRow {
    projectId: number | null;
    engine: string;
    model: string;
    calls: number;
    cacheHits: number;
    tokensTotal: number;
    lastCallAt: Date | string | null;
  }

  const baseQuery = db
    .select({
      projectId: aiTokenLogTable.projectId,
      engine: aiTokenLogTable.engine,
      model: aiTokenLogTable.model,
      calls: sql<number>`count(*)::int`,
      cacheHits: sql<number>`sum(case when ${aiTokenLogTable.cacheHit} then 1 else 0 end)::int`,
      tokensTotal: sql<number>`coalesce(sum(${aiTokenLogTable.tokensUsed}), 0)::int`,
      lastCallAt: sql<Date>`max(${aiTokenLogTable.createdAt})`,
    })
    .from(aiTokenLogTable);
  const rows = (await (whereClause ? baseQuery.where(whereClause) : baseQuery)
    .groupBy(aiTokenLogTable.projectId, aiTokenLogTable.engine, aiTokenLogTable.model)
    .orderBy(sql`max(${aiTokenLogTable.createdAt}) desc`)) as UsageRow[];

  // Resolve project names for the projectIds we have.
  const projectIds = Array.from(
    new Set(rows.map((r: UsageRow) => r.projectId).filter((id): id is number => id !== null)),
  );
  const projects = projectIds.length
    ? ((await db
        .select({ id: projectsTable.id, name: projectsTable.name })
        .from(projectsTable)
        .where(sql`${projectsTable.id} = ANY(${projectIds})`)) as { id: number; name: string }[])
    : [];
  const projectNameById = new Map(projects.map((p) => [p.id, p.name] as const));

  const items = rows.map((r: UsageRow) => ({
    projectId: r.projectId,
    projectName:
      r.projectId === null ? null : projectNameById.get(r.projectId) ?? `Project #${r.projectId}`,
    engine: r.engine,
    model: r.model,
    calls: Number(r.calls),
    cacheHits: Number(r.cacheHits),
    tokensTotal: Number(r.tokensTotal),
    lastCallAt: r.lastCallAt instanceof Date ? r.lastCallAt.toISOString() : r.lastCallAt,
    estimatedCostUsd: Number(estimateCostUsd(r.model, Number(r.tokensTotal)).toFixed(4)),
  }));

  const totals = items.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.cacheHits += r.cacheHits;
      acc.tokensTotal += r.tokensTotal;
      acc.estimatedCostUsd += r.estimatedCostUsd;
      return acc;
    },
    { calls: 0, cacheHits: 0, tokensTotal: 0, estimatedCostUsd: 0 },
  );
  totals.estimatedCostUsd = Number(totals.estimatedCostUsd.toFixed(4));

  res.json({
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    items,
    totals,
    pricing: MODEL_COST_PER_1M_TOKENS,
  });
});

// ---- Public read endpoint for the user dashboard (per-project AI status) -
// This one is intentionally NOT gated on admin: the user dashboard surfaces
// last-analysis timestamp + cache-hit indicator read-only. No settings or
// keys are revealed.
router.get("/projects/:id/ai-status", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const settings = await getAiSettings();
  const status = await lastRunForProject(id);
  const pub = toPublicSettings(settings);
  res.json({
    aiEnabled: pub.enabled && pub.hasKey && pub.status !== "invalid_key",
    aiStatus: pub.status,
    model: pub.model,
    lastRunAt: status.lastRunAt,
    cacheEntries: status.cacheEntries,
  });
});

export default router;
