import { pgTable, text, serial, timestamp, integer, jsonb, customType } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() { return "bytea"; },
});
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("created"),
  wpUrl: text("wp_url"),
  wpUsername: text("wp_username"),
  wpAppPassword: text("wp_app_password"),
  wpApiKey: text("wp_api_key"),
  authMode: text("auth_mode").notNull().default("basic"),
  useAcf: text("use_acf").notNull().default("true"),
  uploadedFiles: jsonb("uploaded_files"),
  parsedSite: jsonb("parsed_site"),
  designSystem: jsonb("design_system"),
  wpStructure: jsonb("wp_structure"),
  pageCount: integer("page_count"),
  renderer: text("renderer").notNull().default("gutenberg"),
  conversionMode: text("conversion_mode").notNull().default("shell"),
  customPostTypes: jsonb("custom_post_types"),
  aiAnalysis: jsonb("ai_analysis"),
  sourceHtml: text("source_html"),
  sourceCss: text("source_css"),
  sourceZip: bytea("source_zip"),
  sourcePagesHtml: jsonb("source_pages_html"),
  lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
