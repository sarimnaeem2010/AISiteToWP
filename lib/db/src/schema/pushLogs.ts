import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pushLogsTable = pgTable("push_logs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  pageName: text("page_name").notNull(),
  status: text("status").notNull(),
  wpId: integer("wp_id"),
  wpUrl: text("wp_url"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPushLogSchema = createInsertSchema(pushLogsTable).omit({ id: true, createdAt: true });
export type InsertPushLog = z.infer<typeof insertPushLogSchema>;
export type PushLog = typeof pushLogsTable.$inferSelect;
