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
import { parseHtml, parseSingleHtmlPage, type ParsedPage, type ParsedSite, type DesignSystem } from "../lib/parser";
import { mapToWordPress, type CustomPostTypeDef } from "../lib/wpMapper";
import { testConnection, pushToWordPress, setAsHomepage, installTheme, activateTheme, getActiveTheme } from "../lib/wpSync";
import { extractSectionsFromPage, type ExtractedPage } from "../lib/sectionFieldExtractor";
import { generateThemeZip } from "../lib/themeGenerator";
import { composeElementorData } from "../lib/pixelPerfectComposer";
import { scrapeUrl } from "../lib/urlScraper";
import { applyChatRefinement } from "../lib/chatRefiner";
import { generateApiKey, generateWordPressPlugin } from "../lib/pluginGenerator";
import { extractZip } from "../lib/zipUpload";
import { generateAstroProject } from "../lib/astroGenerator";
import type { SuggestedCpt } from "../lib/aiAnalyzer";
import AdmZip from "adm-zip";
import { z } from "zod";
import { JSDOM } from "jsdom";


function suggestedToCpts(suggested: SuggestedCpt[] | undefined): CustomPostTypeDef[] {
  if (!Array.isArray(suggested)) return [];
  return suggested.map((s) => ({
    slug: s.slug,
    label: s.label,
    pluralLabel: s.pluralLabel,
    sourceSemanticType: s.sourceSemanticType,
    fields: s.fields,
    enabled: false,
  }));
}

// The renderer pivot is irreversible: every push goes through the generated
// child theme + Elementor widget pipeline. The endpoint stays for backwards
// compatibility with older clients that still POST a renderer value, but the
// only accepted value (and the only stored value) is "pixel_perfect".
const RendererSchema = z.object({
  renderer: z.literal("pixel_perfect"),
});

function normalizeRenderer(_v: unknown): "pixel_perfect" {
  return "pixel_perfect";
}

function projectRenderer(_stored: string | null): "pixel_perfect" {
  return "pixel_perfect";
}

/**
 * For a project that has a sourceZip and per-page HTML, run the section
 * extractor across every page and return one ExtractedPage per slug. The
 * project's slug is used as the block namespace so two projects' blocks
 * never collide on the same WP install.
 */
function buildExtractedPages(project: {
  id: number;
  name: string;
  sourcePagesHtml: unknown;
  sourceHtml: string | null;
}): { pages: ExtractedPage[]; projectSlug: string } {
  const baseSlug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "wpb-project";
  const projectSlug = `${baseSlug}-${project.id}`;
  const sourcePagesHtml = (project.sourcePagesHtml ?? null) as Record<string, { path: string; content: string }> | null;
  const pages: ExtractedPage[] = [];
  if (sourcePagesHtml && Object.keys(sourcePagesHtml).length > 0) {
    for (const [slug, src] of Object.entries(sourcePagesHtml)) {
      const sections = extractSectionsFromPage(src.content, slug, projectSlug);
      pages.push({ slug, title: slug === "home" ? "Home" : slug.replace(/-/g, " "), sections });
    }
  } else if (project.sourceHtml) {
    const sections = extractSectionsFromPage(project.sourceHtml, "home", projectSlug);
    pages.push({ slug: "home", title: "Home", sections });
  }
  return { pages, projectSlug };
}
const CustomPostTypesSchema = z.object({
  customPostTypes: z.array(
    z.object({
      slug: z.string().min(1).max(20),
      label: z.string().min(1).max(60),
      pluralLabel: z.string().min(1).max(60),
      sourceSemanticType: z.string().min(1).max(40),
      fields: z.array(z.string()),
      enabled: z.boolean(),
    }),
  ),
});

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
    aiAnalysis: project.aiAnalysis ?? null,
    customPostTypes: project.customPostTypes ?? [],
    renderer: projectRenderer(project.renderer ?? null),
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

  const { parsedSite, designSystem, aiAnalysis } = await parseHtml(body.data.htmlContent);
  const existingCpts = (project.customPostTypes as CustomPostTypeDef[] | null) ?? [];
  const suggested = suggestedToCpts(aiAnalysis?.suggestedCpts);
  // Merge: keep existing user choices, add any new suggestions not already present
  const mergedCpts: CustomPostTypeDef[] = [
    ...existingCpts,
    ...suggested.filter((s) => !existingCpts.some((e) => e.slug === s.slug)),
  ];
  const wpStructure = mapToWordPress(parsedSite, mergedCpts);

  await db
    .update(projectsTable)
    .set({
      status: "parsed",
      parsedSite: parsedSite as never,
      designSystem: designSystem as never,
      wpStructure: wpStructure as never,
      aiAnalysis: (aiAnalysis ?? null) as never,
      customPostTypes: mergedCpts as never,
      sourceHtml: body.data.htmlContent,
      pageCount: parsedSite.pages.length,
    })
    .where(eq(projectsTable.id, project.id));

  res.json({ parsedSite, designSystem, wpStructure, aiAnalysis, customPostTypes: mergedCpts });
});

// INPUT LAYER: scrape a public URL, parse it, store as the project source.
const ScrapeUrlSchema = z.object({ url: z.string().url() });
router.post("/projects/:id/scrape-url", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ScrapeUrlSchema.safeParse(req.body);
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

  let scraped;
  try {
    scraped = await scrapeUrl(body.data.url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
    return;
  }

  const { parsedSite, designSystem, aiAnalysis } = await parseHtml(scraped.html);
  const existingCpts = (project.customPostTypes as CustomPostTypeDef[] | null) ?? [];
  const suggested = suggestedToCpts(aiAnalysis?.suggestedCpts);
  const mergedCpts: CustomPostTypeDef[] = [
    ...existingCpts,
    ...suggested.filter((s) => !existingCpts.some((e) => e.slug === s.slug)),
  ];
  const wpStructure = mapToWordPress(parsedSite, mergedCpts);

  await db
    .update(projectsTable)
    .set({
      status: "parsed",
      parsedSite: parsedSite as never,
      designSystem: designSystem as never,
      wpStructure: wpStructure as never,
      aiAnalysis: (aiAnalysis ?? null) as never,
      customPostTypes: mergedCpts as never,
      sourceHtml: scraped.html,
      pageCount: parsedSite.pages.length,
    })
    .where(eq(projectsTable.id, project.id));

  res.json({
    parsedSite,
    designSystem,
    wpStructure,
    aiAnalysis,
    customPostTypes: mergedCpts,
    sourceUrl: scraped.finalUrl,
  });
});

// AI CHAT REFINEMENT: apply a natural-language layout change to the parsed site.
const ChatRefineSchema = z.object({ instruction: z.string().min(1).max(1000) });
router.post("/projects/:id/chat-refine", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ChatRefineSchema.safeParse(req.body);
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
  if (!project.parsedSite) {
    res.status(400).json({ error: "Site not parsed yet — parse a source first." });
    return;
  }

  const result = await applyChatRefinement(
    project.parsedSite as ParsedSite,
    body.data.instruction,
  );
  if (!result) {
    res.status(503).json({
      error: "Chat refinement is unavailable. Make sure the OpenAI integration is configured.",
    });
    return;
  }

  const refinedSite = result.site as Partial<ParsedSite> | null;
  if (
    !refinedSite ||
    !Array.isArray(refinedSite.pages) ||
    refinedSite.pages.length === 0 ||
    !refinedSite.pages.every(
      (p) =>
        p &&
        typeof p.name === "string" &&
        typeof p.slug === "string" &&
        Array.isArray(p.sections) &&
        p.sections.every((s) => s && typeof s.type === "string" && typeof s.content === "object"),
    )
  ) {
    res.status(422).json({
      error: "AI returned an invalid site structure. Try rephrasing your instruction.",
    });
    return;
  }
  const validatedSite: ParsedSite = { pages: refinedSite.pages as ParsedSite["pages"] };

  const cpts = (project.customPostTypes as CustomPostTypeDef[] | null) ?? [];
  const updatedStructure = mapToWordPress(validatedSite, cpts);

  await db
    .update(projectsTable)
    .set({
      parsedSite: result.site as never,
      wpStructure: updatedStructure as never,
      pageCount: result.site.pages.length,
    })
    .where(eq(projectsTable.id, project.id));

  res.json({
    summary: result.summary,
    parsedSite: result.site,
    wpStructure: updatedStructure,
  });
});

// SET AS HOMEPAGE: tell WordPress to use a pushed page as the static front page.
const SetHomepageSchema = z.object({ wpPageId: z.number().int().positive() });
router.post("/projects/:id/set-homepage", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetHomepageSchema.safeParse(req.body);
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
  if (!project.wpUrl) {
    res.status(400).json({ error: "WordPress URL not configured" });
    return;
  }
  const authMode = (project.authMode === "api_key" ? "api_key" : "basic") as "basic" | "api_key";
  if (authMode === "basic" && (!project.wpUsername || !project.wpAppPassword)) {
    res.status(400).json({ error: "WordPress credentials not configured" });
    return;
  }
  if (authMode === "api_key" && !project.wpApiKey) {
    res.status(400).json({ error: "Plugin API key not configured" });
    return;
  }

  const result = await setAsHomepage(
    {
      wpUrl: project.wpUrl,
      wpUsername: project.wpUsername,
      wpAppPassword: project.wpAppPassword,
      wpApiKey: project.wpApiKey,
      authMode,
      useAcf: project.useAcf === "true",
    },
    body.data.wpPageId,
  );
  res.json(result);
});

router.put("/projects/:id/custom-post-types", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = CustomPostTypesSchema.safeParse(req.body);
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
  // Re-map structure with new CPT selection if site is parsed
  let updatedStructure = project.wpStructure;
  if (project.parsedSite) {
    updatedStructure = mapToWordPress(
      project.parsedSite as never,
      body.data.customPostTypes,
    ) as never;
  }
  await db
    .update(projectsTable)
    .set({
      customPostTypes: body.data.customPostTypes as never,
      wpStructure: updatedStructure as never,
    })
    .where(eq(projectsTable.id, project.id));
  res.json({ customPostTypes: body.data.customPostTypes, wpStructure: updatedStructure });
});

router.put("/projects/:id/renderer", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetProjectParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = RendererSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  // Renderer choice is fixed since the Elementor-only pivot. We accept the
  // PUT for back-compat with older UIs but always store pixel_perfect.
  const [project] = await db
    .update(projectsTable)
    .set({ renderer: normalizeRenderer(body.data.renderer) })
    .where(eq(projectsTable.id, Number(params.data.id)))
    .returning();
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ renderer: project.renderer });
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

/**
 * Probe the configured WordPress instance for the currently active theme
 * and compare it to the expected per-project pixel-perfect theme slug.
 * Used by the Push button to surface a warning before the user pushes
 * pages that depend on a custom theme that hasn't been installed yet.
 * Requires api_key auth (basic auth can't reach the plugin status route).
 */
router.get("/projects/:id/active-theme", async (req, res): Promise<void> => {
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
  const { projectSlug } = buildExtractedPages(project);
  // Every project now requires the custom theme — Gutenberg/raw-HTML modes
  // were removed in the Elementor-only pivot.
  const requiresCustomTheme = true;
  if (!project.wpUrl || project.authMode !== "api_key" || !project.wpApiKey) {
    res.json({
      reachable: false,
      activeThemeSlug: null,
      activeThemeName: null,
      expectedThemeSlug: projectSlug,
      requiresCustomTheme,
      matches: false,
      reason: "Active-theme probe requires api_key auth via the companion plugin.",
    });
    return;
  }
  const probe = await getActiveTheme({
    wpUrl: project.wpUrl,
    wpUsername: project.wpUsername,
    wpAppPassword: project.wpAppPassword,
    wpApiKey: project.wpApiKey,
    authMode: "api_key",
    useAcf: project.useAcf === "true",
  });
  res.json({
    reachable: probe.reachable,
    activeThemeSlug: probe.slug,
    activeThemeName: probe.name,
    expectedThemeSlug: projectSlug,
    requiresCustomTheme,
    matches: probe.reachable && probe.slug === projectSlug,
    reason: probe.error ?? null,
  });
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

  const wpStructure = project.wpStructure as {
    pages: Array<{ title: string; slug: string; blocks: unknown[] }>;
    cptItems?: Array<{ cptSlug: string; title: string; fields: Record<string, unknown> }>;
  };
  // Renderer pivot: every push is now pixel-perfect. Legacy values stored
  // on existing projects (gutenberg / elementor / raw_html) are silently
  // upgraded — there is no UI for choosing a different renderer.
  const renderer = "pixel_perfect" as const;

  let elementorPages: Array<{ slug: string; data: unknown[] }> | undefined;
  let prebuiltBySlug: Record<string, string> | undefined;
  {
    if (!project.sourcePagesHtml && !project.sourceHtml) {
      res.status(400).json({
        error: "Pixel-perfect mode requires the original source HTML. Re-upload your ZIP.",
      });
      return;
    }
    const { pages: extPages, projectSlug: expectedThemeSlug } = buildExtractedPages(project);
    // Probe active theme on target site. If it isn't the expected
    // pixel-perfect theme, every section will render as an "unknown block"
    // placeholder — so block the push and surface a structured warning the
    // UI can act on. The user can re-submit with `force: true` to override
    // (e.g. they intentionally want to push pages before installing).
    const force = Boolean((req.body as { force?: unknown } | undefined)?.force);
    if (!force && authMode === "api_key" && project.wpApiKey) {
      const probe = await getActiveTheme({
        wpUrl: project.wpUrl,
        wpUsername: project.wpUsername,
        wpAppPassword: project.wpAppPassword,
        wpApiKey: project.wpApiKey,
        authMode: "api_key",
        useAcf: project.useAcf === "true",
      });
      if (probe.reachable && probe.slug !== expectedThemeSlug) {
        // Distinguish "old plugin doesn't report active_theme" from a real
        // mismatch. Older companion plugins (<1.5.0) returned 200 from
        // /status without the active_theme field — so we can't actually
        // tell what's installed. Send a different message in that case so
        // users know to re-download the plugin instead of chasing a theme
        // mismatch that may not exist.
        const oldPlugin = probe.slug === null;
        const message = oldPlugin
          ? `Could not verify the active WordPress theme — the installed companion plugin is older than 1.5.0 and doesn't expose this info. Re-download the plugin from the Get Plugin page (or pass force=true to push anyway).`
          : `The pixel-perfect theme "${expectedThemeSlug}" is not active on this site (active: "${probe.slug}"). Pages will render as "unknown block" placeholders. Install and activate the theme before pushing, or pass force=true to push anyway.`;
        res.status(409).json({
          warning: oldPlugin ? "plugin_outdated" : "theme_not_active",
          message,
          expectedThemeSlug,
          activeThemeSlug: probe.slug,
          activeThemeName: probe.name,
        });
        return;
      }
    }
    // The Elementor-only pivot drops Gutenberg block markup entirely:
    // the post body is intentionally empty (the WP plugin sets
    // post_content = '' for every imported page) and Elementor renders
    // the saved widgets from _elementor_data. prebuiltBySlug is kept on
    // the WpStructure for backward compatibility with the schema, but
    // is empty for every page.
    prebuiltBySlug = {};
    elementorPages = [];
    for (const ep of extPages) {
      prebuiltBySlug[ep.slug] = "";
      elementorPages.push({ slug: ep.slug, data: composeElementorData(ep) });
    }
  }

  // Raw-HTML push removed in the Elementor-only pivot. Every page is
  // pushed as Elementor data + theme widgets via the prebuiltContent path.
  const pagesPayload = wpStructure.pages;

  const result = await pushToWordPress(
    {
      wpUrl: project.wpUrl,
      wpUsername: project.wpUsername,
      wpAppPassword: project.wpAppPassword,
      wpApiKey: project.wpApiKey,
      authMode,
      useAcf: project.useAcf === "true",
    },
    {
      pages: pagesPayload as never,
      cptItems: wpStructure.cptItems ?? [],
      renderer,
      elementorPages,
      injectedCss: project.sourceCss ?? null,
      prebuiltBySlug,
    },
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
  const cpts = (project.customPostTypes as CustomPostTypeDef[] | null) ?? [];
  const { phpCode, filename } = generateWordPressPlugin(project.name, apiKey, cpts);

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
  const cpts = (project.customPostTypes as CustomPostTypeDef[] | null) ?? [];
  const { phpCode, filename } = generateWordPressPlugin(project.name, apiKey, cpts);

  // WordPress requires plugin files inside a named folder at the ZIP root
  const slug = filename.replace(/\.php$/, "");
  const readme = `=== WP Bridge AI Importer ===
Contributors: wpbridgeai
Tags: rest-api, importer, acf, elementor
Requires at least: 6.0
Tested up to: 6.5
Stable tag: 1.0.0
License: MIT

Receives structured JSON from WP Bridge AI and converts it to WordPress pages rendered by an auto-generated Elementor child theme, with ACF field support.

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

  // Parse EVERY HTML file in the ZIP into its own ParsedPage so the user
  // gets a fully editable WordPress page per source page (index.html → home,
  // templates.html → templates, about.html → about, etc.).
  const usedSlugs = new Set<string>();
  const parsedPages: ParsedPage[] = [];
  let mergedDesignSystem: DesignSystem | null = null;
  let mergedAiAnalysis: { suggestedCpts?: SuggestedCpt[] } | null = null;
  for (const htmlPage of extracted.htmlPages) {
    const baseName = htmlPage.path.split("/").pop()?.replace(/\.html?$/i, "") || "page";
    const isIndex = /^index$/i.test(baseName);
    let slug = isIndex ? "home" : baseName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) slug = "page";
    let unique = slug;
    let n = 1;
    while (usedSlugs.has(unique)) {
      unique = `${slug}-${++n}`;
    }
    usedSlugs.add(unique);
    const niceName = isIndex
      ? "Home"
      : baseName.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    try {
      const { page, designSystem, aiAnalysis } = await parseSingleHtmlPage(htmlPage.content, niceName, unique);
      parsedPages.push(page);
      if (!mergedDesignSystem) mergedDesignSystem = designSystem;
      if (aiAnalysis && !mergedAiAnalysis) {
        mergedAiAnalysis = { suggestedCpts: aiAnalysis.suggestedCpts };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Skip pages that fail to parse but keep going so the rest of the site still imports.
      // (Parse errors usually mean malformed/empty HTML.)
      console.warn(`Skipping page ${htmlPage.path}: ${msg}`);
    }
  }
  if (parsedPages.length === 0) {
    res.status(400).json({ error: "Could not parse any HTML pages from ZIP" });
    return;
  }
  const parsedSite: ParsedSite = { pages: parsedPages };

  // Build a combined stylesheet from every <style> tag in every HTML page plus
  // every .css file found in the ZIP. Injected on push so WordPress pages
  // inherit the original template's fonts, colors, backgrounds, etc.
  const inlineStyleChunks: string[] = [];
  for (const htmlPage of extracted.htmlPages) {
    try {
      const dom = new JSDOM(htmlPage.content);
      for (const el of Array.from(dom.window.document.querySelectorAll("style"))) {
        if (el.textContent) inlineStyleChunks.push(el.textContent);
      }
    } catch { /* ignore */ }
  }
  const MAX_CSS_BYTES = 1_048_576; // 1 MB cap matches plugin
  const rawCombinedCss = [
    ...extracted.cssFiles.map((f) => `/* ${f.path} */\n${f.content}`),
    ...inlineStyleChunks.map((c) => `/* inline */\n${c}`),
  ].join("\n\n");
  const combinedCss = rawCombinedCss.length > MAX_CSS_BYTES
    ? rawCombinedCss.slice(0, MAX_CSS_BYTES)
    : rawCombinedCss;
  const designSystem = mergedDesignSystem ?? { font: "system-ui", colors: [], buttonStyle: "rounded", headingStyle: "bold" };
  const aiAnalysis = mergedAiAnalysis;

  const existingCpts = (project.customPostTypes as CustomPostTypeDef[] | null) ?? [];
  const suggested = suggestedToCpts(aiAnalysis?.suggestedCpts);
  const mergedCpts: CustomPostTypeDef[] = [
    ...existingCpts,
    ...suggested.filter((s) => !existingCpts.some((e) => e.slug === s.slug)),
  ];
  const wpStructure = mapToWordPress(parsedSite, mergedCpts);

  await db
    .update(projectsTable)
    .set({
      status: "parsed",
      parsedSite: parsedSite as never,
      designSystem: designSystem as never,
      wpStructure: wpStructure as never,
      aiAnalysis: (aiAnalysis ?? null) as never,
      customPostTypes: mergedCpts as never,
      uploadedFiles: { files: extracted.files, indexPath: extracted.indexPath } as never,
      sourceHtml: extracted.indexHtml,
      sourceCss: combinedCss,
      sourceZip: req.file.buffer,
      sourcePagesHtml: Object.fromEntries(
        extracted.htmlPages.map((p) => {
          const baseName = p.path.split("/").pop()?.replace(/\.html?$/i, "") || "page";
          const isIndex = /^index$/i.test(baseName);
          const slug = isIndex ? "home" : baseName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
          return [slug || "page", { path: p.path, content: p.content }];
        }),
      ) as never,
      pageCount: parsedSite.pages.length,
    })
    .where(eq(projectsTable.id, project.id));

  res.json({
    fileCount: extracted.files.length,
    indexPath: extracted.indexPath,
    pagesParsed: parsedPages.length,
    pageSlugs: parsedPages.map((p) => p.slug),
    parsedSite,
    designSystem,
    wpStructure,
    aiAnalysis,
    customPostTypes: mergedCpts,
  });
});

// PIXEL-PERFECT: download the auto-generated child theme as a ZIP. The user
// uploads it via WP Admin → Appearance → Themes → Add New, or uses the
// /install-theme endpoint below to push it through the companion plugin.
router.get("/projects/:id/theme-zip", async (req, res): Promise<void> => {
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
  if (!project.sourcePagesHtml && !project.sourceHtml) {
    res.status(400).json({ error: "Upload a ZIP or scrape a URL first." });
    return;
  }

  const { pages, projectSlug } = buildExtractedPages(project);
  const totalSections = pages.reduce((n, p) => n + p.sections.length, 0);
  if (totalSections === 0) {
    res.status(422).json({ error: "Could not extract any sections from source HTML." });
    return;
  }
  const sourceZip = (project.sourceZip as Buffer | null) ?? null;
  // Re-collect JS from the ZIP if we have it (we never persist it separately).
  let combinedJs = "";
  if (sourceZip) {
    try {
      const AdmZip = (await import("adm-zip")).default;
      const z = new AdmZip(sourceZip);
      const jsFiles = z.getEntries().filter((e) => !e.isDirectory && /\.js$/i.test(e.entryName) && !e.entryName.startsWith("__MACOSX/"));
      combinedJs = jsFiles.map((e) => `/* ${e.entryName} */\n${e.getData().toString("utf8")}`).join("\n\n");
    } catch { /* ignore */ }
  }
  const zipBuffer = generateThemeZip({
    projectName: project.name,
    projectSlug,
    combinedCss: project.sourceCss ?? "",
    combinedJs,
    pages,
    sourceZip,
  });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${projectSlug}-theme.zip"`);
  res.send(zipBuffer);
});

// PIXEL-PERFECT: activate the previously installed theme (separate step from
// install so a failure here is reported distinctly from an install failure).
router.post("/projects/:id/activate-theme", async (req, res): Promise<void> => {
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
  if (!project.wpUrl || project.authMode !== "api_key" || !project.wpApiKey) {
    res.status(400).json({ error: "Theme activation requires API-key auth via the companion plugin." });
    return;
  }
  const { projectSlug } = buildExtractedPages(project);
  const cfg = {
    wpUrl: project.wpUrl,
    wpUsername: project.wpUsername,
    wpAppPassword: project.wpAppPassword,
    wpApiKey: project.wpApiKey,
    authMode: "api_key" as const,
    useAcf: project.useAcf === "true",
  };
  const result = await activateTheme(cfg, projectSlug);
  if (!result.success) {
    res.status(502).json({ stage: "activate", themeSlug: projectSlug, ...result });
    return;
  }
  res.json({ stage: "activate", themeSlug: projectSlug, ...result });
});

// PIXEL-PERFECT: build the theme ZIP server-side, push it to WP via the
// companion plugin's /theme-install endpoint. Activation is a separate call.
router.post("/projects/:id/install-theme", async (req, res): Promise<void> => {
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
  if (!project.wpUrl || project.authMode !== "api_key" || !project.wpApiKey) {
    res.status(400).json({ error: "Theme install requires API-key auth via the companion plugin." });
    return;
  }
  if (!project.sourcePagesHtml && !project.sourceHtml) {
    res.status(400).json({ error: "Upload a ZIP first." });
    return;
  }

  const { pages, projectSlug } = buildExtractedPages(project);
  if (pages.reduce((n, p) => n + p.sections.length, 0) === 0) {
    res.status(422).json({ error: "Could not extract any sections from source HTML." });
    return;
  }
  const sourceZip = (project.sourceZip as Buffer | null) ?? null;
  let combinedJs = "";
  if (sourceZip) {
    try {
      const z = new AdmZip(sourceZip);
      const jsFiles = z.getEntries().filter((e) => !e.isDirectory && /\.js$/i.test(e.entryName) && !e.entryName.startsWith("__MACOSX/"));
      combinedJs = jsFiles.map((e) => `/* ${e.entryName} */\n${e.getData().toString("utf8")}`).join("\n\n");
    } catch { /* ignore */ }
  }
  const zipBuffer = generateThemeZip({
    projectName: project.name,
    projectSlug,
    combinedCss: project.sourceCss ?? "",
    combinedJs,
    pages,
    sourceZip,
  });

  const cfg = {
    wpUrl: project.wpUrl,
    wpUsername: project.wpUsername,
    wpAppPassword: project.wpAppPassword,
    wpApiKey: project.wpApiKey,
    authMode: "api_key" as const,
    useAcf: project.useAcf === "true",
  };
  const installResult = await installTheme(cfg, projectSlug, zipBuffer);
  if (!installResult.success) {
    res.status(502).json({ stage: "install", themeSlug: projectSlug, ...installResult });
    return;
  }
  res.json({
    stage: "install",
    install: installResult,
    themeSlug: projectSlug,
    blocksRegistered: pages.reduce((n, p) => n + p.sections.length, 0),
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
