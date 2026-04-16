import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("created"),
  wpUrl: text("wp_url"),
  wpUsername: text("wp_username"),
  wpAppPassword: text("wp_app_password"),
  useAcf: text("use_acf").notNull().default("true"),
  parsedSite: jsonb("parsed_site"),
  designSystem: jsonb("design_system"),
  wpStructure: jsonb("wp_structure"),
  pageCount: integer("page_count"),
  lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
