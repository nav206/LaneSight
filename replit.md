# LaneSight

A responsive, single-page San Francisco bicycle route planner using a citywide street map and live public data.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — only for workspace apps that use the database; LaneSight does not
- LaneSight requires no database connection, account, payment, or secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Shared workspace DB tooling: PostgreSQL + Drizzle ORM (not used by LaneSight)
- Validation: Zod schemas generated from OpenAPI
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/lanesight/` — responsive LaneSight web app and full-city Leaflet map.
- `artifacts/api-server/` — public-data proxy, geocoding, and route API required by LaneSight.
- `artifacts/mockup-sandbox/` — reusable design preview sandbox.

## Architecture decisions

- LaneSight uses the official SFMTA bike network as its route graph, respecting one-way direction. Class III shared-road features are displayed but not used as bike-lane route segments.
- Street connectors are separately routed over OpenStreetMap through BRouter and shown distinctly; do not present connectors as official bike lanes or silently fall back to a generic route.
- Bay Wheels counts come from the live GBFS feed. Do not use mock station counts or static route geometry.
- Street permit data is limited to permitted current/upcoming records; recent 311 reports are unverified and must never be described as confirmed hazards.
- SFMTA inventory is not a live feed. Display its source update date and keep map attribution visible.
- Public geocoding is server-side and rate-limited; if a route cannot be found on the mapped network, return a clear error instead of drawing a fallback.

## Product

LaneSight opens to a full San Francisco map and automatically requests a real Civic Center → Ferry Building route on first visit. The editable route follows directional SFMTA Class I, II, and IV facilities, with low-traffic OSM street connectors shown separately. Live Bay Wheels counts refresh periodically.

## User preferences

- Keep the app simple and responsive on phones and laptops.
- Do not add accounts or payments for now.
- The existing annotation style is approved; annotations must reflect real source data and distinguish mapped bikeways, street connectors, permits, and unverified 311 reports.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
