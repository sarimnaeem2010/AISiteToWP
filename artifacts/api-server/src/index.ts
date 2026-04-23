import app from "./app";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function bootstrapAdminUser() {
  const [existingAdmin] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.isAdmin, true))
    .limit(1);

  if (existingAdmin) {
    return;
  }

  const username = process.env.ADMIN_BOOTSTRAP_USERNAME?.trim() || "admin";
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim() || "admin123";
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  const passwordHash = `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;

  const [existingByName] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existingByName) {
    await db
      .update(usersTable)
      .set({ passwordHash, isAdmin: true })
      .where(eq(usersTable.id, existingByName.id));
  } else {
    await db.insert(usersTable).values({
      username,
      passwordHash,
      isAdmin: true,
    });
  }

  logger.info({ username }, "Seeded admin user on startup");
}

bootstrapAdminUser()
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
  })
  .catch((err) => {
    logger.error({ err }, "Database bootstrap failed");
    process.exit(1);
  });
