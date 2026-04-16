import { Router, type IRouter } from "express";
import multer from "multer";
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
import { extractZip } from "../lib/zipUpload";
import { generateAstroProject } from "../lib/astroGenerator";
import AdmZip from "adm-zip";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

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
          authMode: project.authMode === "api_key" ? "api_key" : "basic",
          wpUsername: project.wpUsername ?? "",
          wpAppPassword: project.wpAppPassword ? "••••••••" : "",
          wpApiKey: project.wpApiKey ? "••••••••" : "",
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

  const authMode = (body.data as { authMode?: string }).authMode === "api_key" ? "api_key" : "basic";
  let wpApiKeyFromBody = (body.data as { wpApiKey?: string }).wpApiKey;
  // Ignore masked placeholder so we don't overwrite a valid stored key with bullets
  if (wpApiKeyFromBody && /^•+$/.test(wpApiKeyFromBody)) {
    wpApiKeyFromBody = undefined;
  }
  // Validate: must be plain ASCII token (no whitespace, no PHP paste, ≤128 chars)
  if (wpApiKeyFromBody !== undefined && wpApiKeyFromBody !== "") {
    if (wpApiKeyFromBody.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(wpApiKeyFromBody)) {
      res.status(400).json({
        error: "Invalid API key format. Paste only the hex key (the value inside the quotes of WP_BRIDGE_API_KEY), not the whole PHP file.",
      });
      return;
    }
  }

  const [project] = await db
    .update(projectsTable)
    .set({
      wpUrl: body.data.wpUrl,
      wpUsername: body.data.wpUsername ?? null,
      wpAppPassword: body.data.wpAppPassword ?? null,
      wpApiKey: wpApiKeyFromBody ?? undefined,
      authMode,
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

  if (!project.wpUrl) {
    res.json({ success: false, message: "WordPress URL not configured" });
    return;
  }
  const authMode = (project.authMode === "api_key" ? "api_key" : "basic") as "basic" | "api_key";
  if (authMode === "basic" && (!project.wpUsername || !project.wpAppPassword)) {
    res.json({ success: false, message: "WordPress username/app-password not configured" });
    return;
  }
  if (authMode === "api_key" && !project.wpApiKey) {
    res.json({ success: false, message: "Plugin API key not configured" });
    return;
  }

  const result = await testConnection({
    wpUrl: project.wpUrl,
    wpUsername: project.wpUsername,
    wpAppPassword: project.wpAppPassword,
    wpApiKey: project.wpApiKey,
    authMode,
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

  if (!project.wpUrl) {
    res.status(400).json({ error: "WordPress URL not configured" });
    return;
  }
  const authMode = (project.authMode === "api_key" ? "api_key" : "basic") as "basic" | "api_key";
  if (authMode === "basic" && (!project.wpUsername || !project.wpAppPassword)) {
    res.status(400).json({ error: "WordPress username/app-password not configured" });
    return;
  }
  if (authMode === "api_key" && !project.wpApiKey) {
    res.status(400).json({ error: "Plugin API key not configured" });
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
      wpApiKey: project.wpApiKey,
      authMode,
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

  let apiKey = project.wpApiKey;
  if (!apiKey) {
    apiKey = generateApiKey();
    await db.update(projectsTable).set({ wpApiKey: apiKey }).where(eq(projectsTable.id, project.id));
  }
  const { phpCode, filename } = generateWordPressPlugin(project.name, apiKey);

  res.json({ phpCode, filename, apiKey });
});

router.get("/projects/:id/plugin-zip", async (req, res): Promise<void> => {
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

  let apiKey = project.wpApiKey;
  if (!apiKey) {
    apiKey = generateApiKey();
    await db.update(projectsTable).set({ wpApiKey: apiKey }).where(eq(projectsTable.id, project.id));
  }
  const { phpCode, filename } = generateWordPressPlugin(project.name, apiKey);

  // WordPress requires plugin files inside a named folder at the ZIP root
  const slug = filename.replace(/\.php$/, "");
  const readme = `=== WP Bridge AI Importer ===
Contributors: wpbridgeai
Tags: rest-api, importer, acf, gutenberg
Requires at least: 6.0
Tested up to: 6.5
Stable tag: 1.0.0
License: MIT

Receives structured JSON from WP Bridge AI and converts it to WordPress pages with Gutenberg blocks and ACF fields.

== Installation ==

1. Upload the plugin zip via Plugins > Add New > Upload Plugin.
2. Activate the plugin through the Plugins menu in WordPress.
3. Copy the API key embedded in the plugin PHP file (constant WP_BRIDGE_API_KEY) into the WP Bridge AI dashboard.

== Endpoints ==

* POST /wp-json/ai-cms/v1/import — receives page payload (X-Api-Key header required)
* GET  /wp-json/ai-cms/v1/status — reports plugin status
`;

  const zip = new AdmZip();
  zip.addFile(`${slug}/${slug}.php`, Buffer.from(phpCode, "utf8"));
  zip.addFile(`${slug}/readme.txt`, Buffer.from(readme, "utf8"));

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${slug}.zip"`);
  res.send(zip.toBuffer());
});

router.post("/projects/:id/upload-zip", upload.single("file"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ParseProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded (field name: file)" });
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

  let extracted;
  try {
    extracted = extractZip(req.file.buffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: `ZIP extraction failed: ${msg}` });
    return;
  }

  const { parsedSite, designSystem } = parseHtml(extracted.indexHtml);
  const wpStructure = mapToWordPress(parsedSite);

  await db
    .update(projectsTable)
    .set({
      status: "parsed",
      parsedSite: parsedSite as never,
      designSystem: designSystem as never,
      wpStructure: wpStructure as never,
      uploadedFiles: { files: extracted.files, indexPath: extracted.indexPath } as never,
      pageCount: parsedSite.pages.length,
    })
    .where(eq(projectsTable.id, project.id));

  res.json({
    fileCount: extracted.files.length,
    indexPath: extracted.indexPath,
    parsedSite,
    designSystem,
    wpStructure,
  });
});

router.get("/projects/:id/astro-export", async (req, res): Promise<void> => {
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
  if (!project.parsedSite) {
    res.status(400).json({ error: "Project has not been parsed yet" });
    return;
  }

  const zipBuffer = generateAstroProject(
    project.name,
    project.parsedSite as never,
    (project.designSystem as never) ?? null
  );

  const safeName = project.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "astro-site";
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}-astro.zip"`);
  res.send(zipBuffer);
});

export default router;
