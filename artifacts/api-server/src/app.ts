import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Credentialed CORS must use an explicit allowlist — never reflect arbitrary
// origins, since the API carries httpOnly admin session cookies. The list
// is built from REPLIT_DEV_DOMAIN, REPLIT_DOMAINS (comma-separated, set in
// Replit deployments), and an operator-controlled CORS_ALLOWED_ORIGINS env.
// Same-origin requests (no Origin header) are always allowed.
const corsAllowlist = new Set<string>(
  [
    process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null,
    process.env.REPLIT_DOMAINS,
    process.env.CORS_ALLOWED_ORIGINS,
  ]
    .filter(Boolean)
    .flatMap((s) => (s as string).split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("http://") || s.startsWith("https://") ? s : `https://${s}`)),
);
if (corsAllowlist.size === 0) {
  logger.warn(
    "CORS allowlist is empty. Set CORS_ALLOWED_ORIGINS (comma-separated origins) for browser access from non-same-origin frontends.",
  );
}
app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (!origin) return cb(null, true);
      if (corsAllowlist.has(origin)) return cb(null, true);
      return cb(null, false);
    },
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production, serve the built React frontend as static files.
// The frontend is built to artifacts/wp-bridge-ai/dist/public relative to the monorepo root.
if (process.env.NODE_ENV === "production") {
  const staticDir = path.resolve(__dirname, "../../../artifacts/wp-bridge-ai/dist/public");
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
    logger.info({ staticDir }, "Serving frontend static files");
  } else {
    logger.warn({ staticDir }, "Frontend static dir not found — skipping static serving");
  }
}

export default app;
