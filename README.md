# Radian

Radian is an open-source workout planner and training log delivered as a progressive web app (PWA). The public project targets Cloudflare Pages, Pages Functions, D1, R2, and Queues. This repository does not publish native iOS or Android apps.

## Features

- Exercise library, routines, workout logging, history, and progress views.
- Offline PWA shell and local workout storage.
- Optional account sync in D1 and encrypted device pairing.
- Optional remote MCP access with explicit consent controls.
- Exercise illustrations and animations from the separately licensed Workout Guide collection; attribution and terms are in `frontend/public/exercise-media/workout-guide/`.

## Development

Install the root tooling and PWA dependencies, then build or run the frontend:

```sh
npm ci
npm ci --prefix frontend
npm run build
npm --prefix frontend run dev
```

The Vite server serves the PWA and proxies `/api` to `API_TARGET` (default `http://127.0.0.1:3000`). For the full local Pages Functions and Jobs runtime, configure local Wrangler files and use `node scripts/radian-local-runtime.mjs`; local D1/R2/Queue state is temporary and discarded when the process stops.

Focused checks:

```sh
npm test
npm --prefix frontend test
npm run lint:functions
npx wrangler pages functions build functions
```

## Cloudflare Pages

Set the Pages build command to:

```sh
npm ci && npm ci --prefix frontend && npm run build
```

Use `frontend/dist` as the build output directory. Pages discovers the Functions in `functions/`. Configure a D1 database bound as `DB` and apply the numbered migrations in `migrations/`. Add R2 and Queue bindings only for the features you enable. Configure `SESSION_SECRET`, WebAuthn origin values, and the MCP origin as environment secrets or variables in Cloudflare; never commit them.

Use separate Cloudflare projects, databases, buckets, queues, and secrets for production, previews, and personal deployments. `wrangler.jsonc` is a generic Pages configuration; account-specific files such as `wrangler.radian-new.jsonc` are local-only and ignored by Git.

## Upstream and licensing

Radian is maintained as an independent project and includes code derived from openGym. Its upstream license and third-party attributions are preserved in `LICENSE`, `frontend/UPSTREAM-NOTICE.md`, and `frontend/THIRD-PARTY-NOTICES.md`. The exercise media is governed by its own license; it is not covered by the application license.

The application is distributed under the GNU AGPL v3.0 or later. See `LICENSE` and the upstream notices before reusing or redistributing any part of the project.
