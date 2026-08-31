# Radian

Radian is a local-first PWA for logging workouts with as little friction as possible. It is designed for use on a phone during a session: you can mark an exercise `Fácil`, `Bien`, `Difícil`, or `No pude` without entering weights or reps.

## Running the app

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm run lint:functions
npm test
npm run build
npx wrangler pages functions build functions
```

On first launch, Radian shows a short setup flow for choosing a goal, training days, session length, and experience level. Height and weight are optional, stay on the device, and can be skipped. You can repeat the setup from Profile. During a session, you can repeat the previous entry, skip an exercise, undo the last step, or leave while keeping the session in progress.

## Deploying to Cloudflare Pages

The project includes `wrangler.jsonc`, the SPA fallback, and security/cache headers in `public/`. Use these settings in Cloudflare Pages:

- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: `master`

The repository is ready for Cloudflare Pages' GitHub integration. Configure the `radian` project with:

- Repository: `nidr0x/radian`
- Production branch: `master`
- Build command: `npm ci && npm run build`
- Output directory: `dist`

Pages handles production and preview deployments. GitHub Actions still runs the TypeScript, Functions, test, and build checks, but it does not need Cloudflare credentials.

Production and preview are separate environments. Production uses the `DB` binding from `radian-prod`, its own session secret, and the origin `https://radian.nidr0x.win`. Each preview must use a separate D1 database, session secret, and WebAuthn variables derived from its hostname. Never copy production values into a preview. The `wrangler.jsonc` configuration leaves preview variables unset so the Function can validate the hostname in the URL it receives. In the Pages dashboard, configure the D1 binding and secret for each environment before testing authentication in a preview.

For a one-off deployment, you can deploy the generated directory with Wrangler:

```bash
  npm run build
  npx wrangler pages deploy dist --project-name=radian
```

The repository includes a GitHub Actions workflow. Pushes to `master` and pull requests run the checks, but the Cloudflare Pages Git integration handles publication.

The app exposes `GET /api/health` to check that the Function is running and can query D1. After a deployment, verify it with:

```bash
curl -fsS https://radian.nidr0x.win/api/health
```

## Optional device sync

The app still works without a backend. If you want to share data between a phone and a computer, the project includes the Pages Function `/api/sync` and the `migrations/0001_sync_records.sql` migration for Cloudflare D1.

1. Create a D1 database for sync if you are preparing a fork:

   ```bash
   npx wrangler d1 create radian-prod
   ```

2. In Cloudflare Pages, add a D1 binding named `DB` to production and another `DB` binding to preview, using separate databases. Radian's official deployment uses `radian-prod` in production; the preview database must be separate.
3. Apply the migration remotely:

   ```bash
   npx wrangler d1 migrations apply radian-prod --remote --env production
   ```

4. In Radian, open `Perfil → Sincronizar dispositivos`, generate a code, and connect the first device. Enter the same code on the second device, then choose whether to download the remote copy or upload its local data.

The code acts as the access key for that copy. The contents are encrypted on the device before upload. You can revoke the code to delete the remote copy and cut off access from other devices. Do not share it. If you run only `npm run dev`, the app stays in local-first mode because Vite does not serve the Pages Functions.

Local mode needs neither secrets nor a database. If you enable passkey accounts, the deployment needs the D1 database and secrets described below.

## Querying workouts with an assistant (optional MCP)

Radian includes a local, read-only MCP server for clients such as Claude Desktop, Cursor, Cline, and Continue. It lets you ask natural-language questions about your routine, sessions, exercises, bodyweight, estimated 1RM, and muscle balance.

The server runs as a `stdio` process started by the client and reads only the file you specify. It opens no ports, makes no network requests, writes no data, and is not part of the web bundle or the Cloudflare Pages build. It never needs passkeys, tokens, D1, or secrets.

### Configuration

1. In Radian, open `Perfil → Tus datos → Exportar datos` and save the file in a protected local path, such as `/Users/tu-usuario/Documentos/radian-backup.json`. If you train on multiple devices, export again after downloading the latest copy.
2. Make sure Node.js 18 or later is installed.
3. Add the server to your client's MCP configuration. In Claude Desktop, for example, edit `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "radian": {
         "command": "node",
         "args": [
           "/ruta/al/repositorio/fitness.nidr0x.win/mcp/radian-mcp.mjs"
         ],
         "env": {
           "RADIAN_DATA_FILE": "/Users/tu-usuario/Documentos/radian-backup.json"
         }
       }
     }
   }
   ```

   Cursor and other MCP clients use the same `command` + `args` + `env` combination. If the client cannot find `node`, replace `command` with the absolute path returned by `which node`.
4. Restart the client. The server reads the backup again for each query. Export it from Radian again whenever you want to update the data the assistant can query.

Examples: `what did I do for press last week?`, `what is my best estimated 1RM for leg press?`, or `which muscle groups have I trained the least this week?`. Results contain only data from the selected backup, and every tool is read-only.

Run the server smoke test with `node --test mcp/radian-mcp.smoke.mjs`.

The authentication Functions use `AUTH_RATE_LIMITER` when the environment provides it. If that binding is unavailable, they apply a per-IP, per-route limit in D1. If D1 is unavailable too, they return a controlled error instead of allowing unlimited attempts. Pages also provides Function logs and metrics in the Cloudflare dashboard.

## MVP decisions

- React + TypeScript + Vite, with an optional backend through Pages Functions and D1.
- State persisted in `localStorage` behind `src/lib/storage.ts`, with `schemaVersion` and migration functions ready to replace the adapter with IndexedDB.
- Sessions store a snapshot of the current program when they start. Editing the routine does not change historical records.
- The recommendation engine in `src/lib/recommendations.ts` is deterministic and testable without the UI.
- New sessions calculate an explainable prescription for each exercise: double progression, linear progression, maintenance, a deload after three stalled sessions, and blocked progression when discomfort is reported. The routine lets you choose the rule, load increment, and up to three warm-up sets.
- Warm-up sets are identified in the history and do not count toward progression, volume, records, or summaries. While a session is active, the PWA requests a screen lock when the browser allows it.
- `Hoy` and `Rutina` show the latest recorded signal and a concrete action for the next session. If discomfort appears, you can try variants for the same muscle group without changing the original routine.
- The backup exports the entire state as JSON. Importing requires confirmation before replacing local data.
- The service worker and manifest allow the app to be installed as a PWA and opened offline. Without D1, data stays on the device.
- Each exercise card includes its own local image, the same visual style, and numbered steps for setup, execution, and alternatives if discomfort appears. These cards work offline with the rest of the PWA shell.
- `Progreso` includes weekly adherence, recent volume, best lifts, monthly sessions, volume by muscle group, and a weekly summary you can copy to review together.
- `Perfil` includes large text, PWA installation when the browser supports it, and clear states for local mode and sync.

The first version does not count calories, log meals, or include an AI provider in the app. It keeps local mode, the encrypted pairing code, optional passkey accounts for structured sync in D1, and the optional local MCP server for read-only queries from external clients.

## Accounts, D1, and passkeys

Radian can work without an account and keep data on the device. If you want to sync across devices, the optional account uses a passkey (WebAuthn) and stores the structured copy in Cloudflare D1.

To prepare the Cloudflare environment:

1. Create a D1 database named `radian-prod` and replace the example identifier in `wrangler.jsonc` with your own. The official deployment already has this database created and configured.
2. Apply the migrations with `npx wrangler d1 migrations apply radian-prod --remote --env production` (from `0001_sync_records.sql` through `0004_auth_hardening.sql`). Repeat the process with the preview database using the preview environment.
3. Configure the `SESSION_SECRET` secret in Pages Functions and, in production, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, and `WEBAUTHN_RP_NAME`.
4. For `radian.nidr0x.win`, use `WEBAUTHN_RP_ID=radian.nidr0x.win` and `WEBAUTHN_ORIGIN=https://radian.nidr0x.win`.

`SESSION_SECRET` must be random and remain stable across deployments. Expired or consumed WebAuthn challenges, old rate limits, and expired sessions are cleaned up when new options are requested. Sessions are opaque, revocable, and tied to the user's session version. Adding, renaming, or revoking a passkey requires recent verification with another passkey. Revoking a passkey invalidates the sessions created with it. D1 provides automatic recovery through Time Travel. Review its retention in Cloudflare periodically before publishing destructive changes.

A passkey is never stored in Radian. The device keeps the private key, while D1 stores only the public key, usage counter, and label you choose. From Profile, you can add, rename, or revoke devices, but at least one active passkey must remain. Local access remains available when cloud sync is not configured.

## Mobile validation

Run these checks after publishing a version to the relevant environment, always using its HTTPS hostname:

- On iPhone with Safari: create an account with Face ID, log out, log back in, add a passkey from another device, and confirm that the new label appears in Profile.
- On Android with Chrome: repeat sign-up using a fingerprint, PIN, or password manager, log out, and validate access from the same device.
- In Profile: rename a passkey and revoke it after the additional verification. Check that a session created with the revoked passkey is no longer valid and that the last passkey cannot be deleted.
- Open the account in two browsers, use `Cerrar en todos`, and confirm that the second browser asks for authentication again.
- Pair two devices with the sync code, confirm that an incorrect code cannot read the remote contents, and make simultaneous edits to verify conflict handling.
- In a preview, confirm that the Function uses its own WebAuthn origin, D1 database, and secret, and never shows production data.
