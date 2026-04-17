# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

- **wp-bridge-ai** (`artifacts/wp-bridge-ai`) — React+Vite frontend for the HTML→WordPress conversion pipeline.
- **api-server** (`artifacts/api-server`) — Express + Drizzle backend. Pipeline libs in `src/lib/`:
  - `parser.ts` — HTML → ParsedSite structure (heuristic).
  - `aiAnalyzer.ts` — Two-pass AI: draft analysis then refinement (`gpt-5.2`, JSON mode). Falls back to draft on refinement failure.
  - `urlScraper.ts` — SSRF-protected URL fetch + relative→absolute URL rewriting (5MB cap).
  - `chatRefiner.ts` — Natural-language layout edits → updated ParsedSite.
  - `wpMapper.ts` — ParsedSite → WP Gutenberg/Elementor/Raw HTML blocks.
  - `wpSync.ts` — REST API push to WordPress (pages, CPTs, set-as-homepage).
- New project routes: `POST /projects/:id/scrape-url`, `/chat-refine`, `/set-homepage`. The chat-refine route validates AI output shape before persisting (rejects with 422 on malformed structure).

## Required env vars (api-server)

- `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY` — OpenAI proxy credentials.
- `DATABASE_URL` — Postgres connection string.
