# Radian

[![License: AGPL v3 or later](https://img.shields.io/badge/License-AGPL--3.0%2B-blue.svg)](LICENSE)

**Radian is an open-source workout planner and training log built as a progressive web app (PWA).** It is a fork of [OpenGym](https://github.com/DuarteSantos8/openGym), adapted to run on Cloudflare Workers with D1, R2, and Queues.

Radian is designed for the web and can be installed as a PWA. This repository does not include native iOS or Android apps.

## Features

- Browse exercises, build routines, log workouts, and review training history and progress.
- Use the app shell and locally stored workout data offline.
- Optionally sync account data through D1 and pair devices with encrypted sharing.
- Connect remote MCP tools with explicit authorization controls.
- Browse exercise illustrations and animations from the separately licensed Workout Guide collection. See the attribution and terms in `frontend/public/exercise-media/workout-guide/`.

## Architecture

| Layer | Cloudflare service |
| --- | --- |
| PWA and API | Pages and Pages Functions (Workers) |
| Account and workout data | D1 |
| Media and pairing objects | R2 |
| Background jobs | Queues |

The frontend is built with Vite. Pages serves the generated PWA from `frontend/dist` and runs API handlers from `functions/`.

## Run locally

Install dependencies and build the PWA:

```sh
npm ci
npm ci --prefix frontend
npm run build
```

Start the frontend development server with:

```sh
npm run dev
```

The Vite server proxies `/api` to `API_TARGET`, which defaults to `http://127.0.0.1:3000`. To run the full local Pages Functions and Jobs runtime, configure local Wrangler bindings and use `node scripts/radian-local-runtime.mjs`. Local D1, R2, and Queue state is temporary and discarded when the process stops.

## Checks

```sh
npm test
npm --prefix frontend test
npm run lint:functions
npm run build:functions
```

## Deploy to Cloudflare Pages

Create a Pages project for the repository and use:

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm ci --prefix frontend && npm run build` |
| Build output directory | `frontend/dist` |

Pages discovers the Functions in `functions/`. Bind a D1 database as `DB` and apply the SQL files in `migrations/`. Configure R2 buckets and Queues for the features you enable. For encrypted device pairing, bind `PAIR_OBJECTS` on both Pages and the Jobs Worker to the same R2 bucket; the Jobs Worker drains queued pairing-object deletions on its scheduled trigger. Set `SESSION_SECRET`, WebAuthn origins, and MCP origin in Cloudflare as secrets or variables; never commit credentials or account-specific resource IDs.

For optional Umami analytics, set `VITE_UMAMI_SRC` and `VITE_UMAMI_ID` at build time, then set the Pages runtime variable `UMAMI_ORIGIN` to the matching HTTPS origin (for example, `https://stats.example`). The origin is added only to the script and connection sources in the Content Security Policy.

## Upstream and licensing

Radian is a fork of [OpenGym](https://github.com/DuarteSantos8/openGym). Upstream attribution and third-party notices are preserved in `frontend/UPSTREAM-NOTICE.md` and `frontend/THIRD-PARTY-NOTICES.md`.

The application is distributed under the GNU Affero General Public License v3.0 or later. Exercise media has separate licensing terms and is not covered by the application license. See `LICENSE` and the notices before reusing or redistributing the project or its media.
