# LaneSight

A single-page bicycle route planner demo showing route safety, bike-lane details, road hazards, and sample bike-share docks.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/lanesight/` — responsive LaneSight web app; route and dock data are local demo data.
- `artifacts/api-server/` — shared API scaffold; not required by the current LaneSight experience.
- `artifacts/mockup-sandbox/` — reusable design preview sandbox.

## Architecture decisions

- LaneSight is frontend-only for now; the first-use San Francisco route works without an account, external routing provider, or database.
- Search supports the included demo destinations only; mock navigation must remain clearly labeled as a demo.

## Product

LaneSight previews bicycle routes with safety-colored segments, tappable lane and hazard details, and mock bike-share dock counts. The Ferry Building sample route is preloaded so the app is usable on first visit.

## User preferences

- Keep the app simple and responsive on phones and laptops.
- Do not add accounts or payments for now.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
