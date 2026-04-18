import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * The project's user table. Role-gated access to the /admin portal is
 * granted by `isAdmin = true`. There is currently no end-user-facing
 * authentication beyond the admin portal — the same table will host
 * regular users when end-user auth is added.
 */
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionsTable = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Singleton row (id=1). The OpenAI API key is stored encrypted at rest
 * — `apiKeyCiphertext` holds the AES-256-GCM ciphertext + IV + auth tag
 * encoded as `iv.tag.ct` (all base64url). The encryption key itself is
 * never stored in the DB; it lives in the ADMIN_ENCRYPTION_KEY env var
 * (or a file secret in development).
 */
export const aiSettingsTable = pgTable("ai_settings", {
  id: integer("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  apiKeyCiphertext: text("api_key_ciphertext"),
  apiKeyLast4: text("api_key_last4"),
  model: text("model").notNull().default("gpt-4o-mini"),
  maxTokens: integer("max_tokens").notNull().default(4096),
  masterControllerMode: boolean("master_controller_mode").notNull().default(true),
  status: text("status").notNull().default("disabled"),
  statusMessage: text("status_message"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const aiCacheTable = pgTable("ai_cache", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  engine: text("engine").notNull(),
  inputHash: text("input_hash").notNull(),
  output: jsonb("output").notNull(),
  tokensUsed: integer("tokens_used"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiTokenLogTable = pgTable("ai_token_log", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id"),
  engine: text("engine").notNull(),
  model: text("model").notNull(),
  tokensUsed: integer("tokens_used").notNull().default(0),
  cacheHit: boolean("cache_hit").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
export type AiSettings = typeof aiSettingsTable.$inferSelect;
export type AiCacheEntry = typeof aiCacheTable.$inferSelect;
