import pg from "pg";
import crypto from "node:crypto";

const { Pool } = pg;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function bootstrapDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set.");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT false,
        display_name TEXT,
        email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_settings (
        id INTEGER PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT false,
        api_key_ciphertext TEXT,
        api_key_last4 TEXT,
        model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        master_controller_mode BOOLEAN NOT NULL DEFAULT true,
        status TEXT NOT NULL DEFAULT 'disabled',
        status_message TEXT,
        last_tested_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_cache (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL,
        engine TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        output JSONB NOT NULL,
        tokens_used INTEGER,
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_token_log (
        id SERIAL PRIMARY KEY,
        project_id INTEGER,
        engine TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        cache_hit BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        wp_url TEXT,
        wp_username TEXT,
        wp_app_password TEXT,
        wp_api_key TEXT,
        auth_mode TEXT NOT NULL DEFAULT 'basic',
        use_acf TEXT NOT NULL DEFAULT 'true',
        uploaded_files JSONB,
        parsed_site JSONB,
        design_system JSONB,
        wp_structure JSONB,
        page_count INTEGER,
        renderer TEXT NOT NULL DEFAULT 'gutenberg',
        conversion_mode TEXT NOT NULL DEFAULT 'shell',
        custom_post_types JSONB,
        design_tokens JSONB,
        ai_analysis JSONB,
        source_html TEXT,
        source_css TEXT,
        source_zip BYTEA,
        source_pages_html JSONB,
        last_pushed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS push_logs (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL,
        page_name TEXT NOT NULL,
        status TEXT NOT NULL,
        wp_id INTEGER,
        wp_url TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("[bootstrap] All tables ensured.");

    const { rows } = await client.query(
      `SELECT id FROM users WHERE is_admin = true LIMIT 1`
    );

    if (rows.length === 0) {
      const username = process.env.ADMIN_BOOTSTRAP_USERNAME?.trim() || "admin";
      const password = process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim() || "admin123";
      const passwordHash = hashPassword(password);

      const existing = await client.query(
        `SELECT id FROM users WHERE username = $1 LIMIT 1`,
        [username]
      );

      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE users SET password_hash = $1, is_admin = true WHERE id = $2`,
          [passwordHash, existing.rows[0].id]
        );
        console.log(`[bootstrap] Promoted existing user '${username}' to admin.`);
      } else {
        await client.query(
          `INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, true)`,
          [username, passwordHash]
        );
        console.log(`[bootstrap] Seeded admin user '${username}'.`);
      }
    } else {
      console.log("[bootstrap] Admin user already exists, skipping seed.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}
