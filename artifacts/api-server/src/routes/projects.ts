import { Router, type IRouter } from "express";
import { eq, desc, count, sql } from "drizzle-orm";
import { db, projectsTable, pushLogsTable } from "@workspace/db";
import {
  CreateProjectBody,
  GetProjectParams,
  DeleteProjectParams,
  ParseProjectParams,
  ParseProjectBody,
  UpdateWordPressConfigParams,
  UpdateWordPressConfigBody,
  TestWordPressConnectionParams,
  PushToWordPressParams,
  GeneratePluginParams,
} from "@workspace/api-zod";
import { parseHtml } from "../lib/parser";
import { mapToWordPress } from "../lib/wpMapper";
import { testConnection, pushToWordPress } from "../lib/wpSync";
import { generateApiKey, generateWordPressPlugin } from "../lib/pluginGenerator";

const router: IRouter = Router();

router.get("/projects/stats", async (_req, res): Promise<void> => {
  const [totalRow] = await db.select({ count: count() }).from(projectsTable);
  const [parsedRow] = await db
    .select({ count: count() })
    .from(projectsTable)
    .where(sql`${projectsTable.status} != 'created'`);
  const [pushedRow] = await db
    .select({ count: count() })
    .from(projectsTable)
    .where(eq(projectsTable.status, "pushed"));
  const [pagesRow] = await db
    .select({ total: sql<number>`coalesce(sum(${projectsTable.pageCount}), 0)` })
    .from(projectsTable);

  res.json({
    totalProjects: Number(totalRow?.count ?? 0),
    parsedProjects: Number(parsedRow?.count ?? 0),
    pushedProjects: Number(pushedRow?.count ?? 0),
    totalPagesConverted: Number(pagesRow?.total ?? 0),
  });
});

router.get("/projects", async (_req, res): Promise<void> => {
  const projects = await db
    .select()
    .from(projectsTable)
    .orderBy(desc(projectsTable.createdAt));

  res.json(
    projects.map((p) => ({
      id: String(p.id),
      name: p.name,
      status: p.status,
      wpUrl: p.wpUrl ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      pageCount: p.pageCount ?? null,
      lastPushedAt: p.lastPushedAt?.toISOString() ?? null,
    }))
  );
});

router.post("/projects", async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({ name: parsed.data.name, status: "created" })
    .returning();

  res.status(201).json({
    id: String(project.id),
    name: project.name,
    status: project.status,
    wpUrl: project.wpUrl ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    pageCount: project.pageCount ?? null,
    lastPushedAt: project.lastPushedAt?.toISOString() ?? null,
  });
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, Number(params.data.id)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const logs = await db
    .select()
    .from(pushLogsTable)
    .where(eq(pushLogsTable.projectId, project.id))
    .orderBy(desc(pushLogsTable.createdAt));

  res.json({
    id: String(project.id),
    name: project.name,
    status: project.status,
    wpUrl: project.wpUrl ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    pageCount: project.pageCount ?? null,
    lastPushedAt: project.lastPushedAt?.toISOString() ?? null,
    parsedSite: project.parsedSite ?? null,
    designSystem: project.designSystem ?? null,
    wpConfig: project.wpUrl
      ? {
          wpUrl: project.wpUrl,
          wpUsername: project.wpUsername ?? "",
          wpAppPassword: project.wpAppPassword ? "••••••••" : "",
          useAcf: project.useAcf === "true",
        }
      : null,
    pushLog: logs.map((l) => ({
      pageName: l.pageName,
      status: l.status,
      wpId: l.wpId ?? null,
      wpUrl: l.wpUrl ?? null,
      error: l.error ?? null,
      createdAt: l.createdAt.toISOString(),
    })),
  });
});

router.delete("/projects/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(pushLogsTable).where(eq(pushLogsTable.projectId, Number(params.data.id)));
  const [deleted] = await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, Number(params.data.id)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/projects/:id/parse", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ParseProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = ParseProjectBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, Number(params.data.id)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { parsedSite, designSystem } = parseHtml(body.data.htmlContent);
  const wpStructure = mapToWordPress(parsedSite);

  await db
    .update(projectsTable)
    .set({
      status: "parsed",
      parsedSite: parsedSite as never,
      designSystem: designSystem as never,
      wpStructure: wpStructure as never,
      pageCount: parsedSite.pages.length,
    })
    .where(eq(projectsTable.id, project.id));

  res.json({ parsedSite, designSystem, wpStructure });
});

router.put("/projects/:id/wordpress-config", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateWordPressConfigParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateWordPressConfigBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [project] = await db
    .update(projectsTable)
    .set({
      wpUrl: body.data.wpUrl,
      wpUsername: body.data.wpUsername,
      wpAppPassword: body.data.wpAppPassword,
      useAcf: String(body.data.useAcf ?? true),
      status: "configured",
    })
    .where(eq(projectsTable.id, Number(params.data.id)))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    id: String(project.id),
    name: project.name,
    status: project.status,
    wpUrl: project.wpUrl ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    pageCount: project.pageCount ?? null,
    lastPushedAt: project.lastPushedAt?.toISOString() ?? null,
  });
});

router.post("/projects/:id/test-connection", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = TestWordPressConnectionParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, Number(params.data.id)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!project.wpUrl || !project.wpUsername || !project.wpAppPassword) {
    res.json({ success: false, message: "WordPress credentials not configured" });
    return;
  }

  const result = await testConnection({
    wpUrl: project.wpUrl,
    wpUsername: project.wpUsername,
    wpAppPassword: project.wpAppPassword,
  });

  res.json(result);
});

router.post("/projects/:id/push", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = PushToWordPressParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, Number(params.data.id)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!project.wpUrl || !project.wpUsername || !project.wpAppPassword) {
    res.status(400).json({ error: "WordPress credentials not configured" });
    return;
  }

  if (!project.wpStructure) {
    res.status(400).json({ error: "Site not parsed yet" });
    return;
  }

  const wpStructure = project.wpStructure as { pages: Array<{ title: string; slug: string; blocks: unknown[] }> };

  const result = await pushToWordPress(
    {
      wpUrl: project.wpUrl,
      wpUsername: project.wpUsername,
      wpAppPassword: project.wpAppPassword,
      useAcf: project.useAcf === "true",
    },
    wpStructure
  );

  await db
    .update(projectsTable)
    .set({
      status: result.success ? "pushed" : "error",
      lastPushedAt: new Date(),
    })
    .where(eq(projectsTable.id, project.id));

  for (const entry of result.log) {
    await db.insert(pushLogsTable).values({
      projectId: project.id,
      pageName: entry.pageName,
      status: entry.status,
      wpId: entry.wpId ?? null,
      wpUrl: entry.wpUrl ?? null,
      error: entry.error ?? null,
    });
  }

  res.json({
    success: result.success,
    pagesCreated: result.pagesCreated,
    pagesUpdated: result.pagesUpdated,
    mediaUploaded: result.mediaUploaded,
    errors: result.errors,
    wpPageUrls: result.wpPageUrls,
  });
});

router.get("/projects/:id/plugin", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GeneratePluginParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, Number(params.data.id)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const apiKey = generateApiKey();
  const { phpCode, filename } = generateWordPressPlugin(project.name, apiKey);

  res.json({ phpCode, filename, apiKey });
});

export default router;
