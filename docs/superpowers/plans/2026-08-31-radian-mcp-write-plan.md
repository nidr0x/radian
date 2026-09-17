# Writable Radian MCP Implementation Plan

> **For agentic workers:** This historical plan records the implementation task-by-task. All listed steps are complete.

**Goal:** Add safe, recoverable write access to the remote Radian MCP so Codex, Claude, and other clients can manage the authenticated D1 copy without copying prompts.

**Architecture:** Keep the existing read-only MCP tools and OAuth flow, adding a separate `radian:write` scope. Put domain mutation and validation in a new `functions/lib/mcpWrite.ts`; keep `functions/lib/mcp.ts` focused on reads and tool definitions. Use D1 conditional writes keyed by `user_data.updated_at`, a `mcp_pending_changes` table for preview/confirmation, and SQLite triggers to snapshot the old payload atomically before update or delete.

**Tech Stack:** Cloudflare Pages Functions, Cloudflare D1, TypeScript, JSON-RPC MCP over Streamable HTTP, OAuth PKCE, Vitest, Wrangler.

**Spec:** `docs/superpowers/specs/2026-08-31-radian-mcp-write-design.md`
**Estado:** Completado y publicado. Este plan se conserva como registro histórico de la implementación; sus tareas ya no representan trabajo pendiente.

## Global Constraints

- The MCP remote uses the structured `user_data` copy in D1.
- Reading keeps `radian:read`; mutations require the independent `radian:write` OAuth scope.
- Stale `baseUpdatedAt` values return `409 conflict` and never overwrite newer data.
- Destructive operations require `preview_change` followed by `apply_change`.
- Previous data is recoverable for 30 days; restoration creates a new active version.
- All mutation queries filter by the authenticated `user_id` and OAuth client.
- Maximum payload remains 900 KB, with no partial writes for invalid data.
- No passwords, passkeys, access tokens, or generated secrets enter source, tests, logs, or documentation.
- Preserve the local-first UI, its existing sync conflict flow, existing read tools, routes, and local `stdio` MCP behavior.
- Do not add a runtime dependency; use the existing D1 interfaces and domain types.

## File Map

- `migrations/0006_mcp_revisions.sql`: revisions, pending proposals, expiry indexes, and atomic `user_data` snapshot triggers.
- `functions/lib/mcpAuth.ts`: write scope, scope checks, and OAuth scope normalization.
- `functions/lib/mcp.ts`: read tools plus version-aware read responses and shared tool definitions.
- `functions/lib/mcpWrite.ts`: strict input validation, conditional mutation, previews, destructive changes, revisions, and restoration.
- `functions/api/mcp.ts`: enforce read/write scope at the MCP tool boundary and dispatch write tools.
- `functions/api/mcp/authorize.ts`: display requested read/write permissions in consent.
- `functions/.well-known/oauth-authorization-server.ts`: advertise `radian:write`.
- `functions/types.ts`: shared result and D1 row types where needed.
- `tests/mcp.test.ts`: public tool behavior, permission boundaries, mutation contracts, conflicts, previews, revisions, and restores.
- `README.md`: client setup, write permission, confirmation behavior, and recovery instructions.

### Task 1: Add the D1 revision and proposal schema

**Files:**
- Create: `migrations/0006_mcp_revisions.sql`
- Modify: `functions/types.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Produces `user_data_revisions`, `mcp_pending_changes`, and triggers that snapshot old `user_data` rows before payload changes or deletion.
- Produces row types for revision and pending-change records used by `mcpWrite.ts`.

- [x] **Step 1: Write the failing schema-contract test**

Add a focused test for the first helper seam. Assert that revision rows expose `id`, `userId`, `payload`, `source`, `createdAt`, `expiresAt`, and `restoredAt`, while pending changes expose `id`, `userId`, `clientId`, `kind`, `payload`, `baseUpdatedAt`, `summary`, `createdAt`, `expiresAt`, and `usedAt`.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL because the revision row contract and helpers do not exist.

- [x] **Step 3: Add the migration and types**

Create `user_data_revisions` and `mcp_pending_changes` with foreign keys to `users` and `mcp_clients`, indexes on `expires_at`, and these snapshot triggers:

```sql
CREATE TRIGGER IF NOT EXISTS user_data_revision_after_update
AFTER UPDATE OF payload, updated_at ON user_data
WHEN old.payload <> new.payload
BEGIN
  INSERT INTO user_data_revisions
    (id, user_id, payload, source, created_at, expires_at)
  VALUES
    (lower(hex(randomblob(16))), old.user_id, old.payload, 'automatic',
     datetime('now'), datetime('now', '+30 days'));
END;

CREATE TRIGGER IF NOT EXISTS user_data_revision_after_delete
AFTER DELETE ON user_data
BEGIN
  INSERT INTO user_data_revisions
    (id, user_id, payload, source, created_at, expires_at)
  VALUES
    (lower(hex(randomblob(16))), old.user_id, old.payload, 'automatic',
     datetime('now'), datetime('now', '+30 days'));
END;
```

Add `McpRevisionRow`, `McpPendingChangeRow`, and `McpMutationResult` to the shared type surface.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the schema seam**

```bash
git add migrations/0006_mcp_revisions.sql functions/types.ts tests/mcp.test.ts
git commit -m "feat: add recoverable MCP data revisions"
```

### Task 2: Add the independent write OAuth scope

**Files:**
- Modify: `functions/lib/mcpAuth.ts`
- Modify: `functions/api/mcp/authorize.ts`
- Modify: `functions/.well-known/oauth-authorization-server.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Produces `MCP_WRITE_SCOPE = 'radian:write'` and `hasMcpScope(scope, requiredScope): boolean`.
- `normalizeScope` accepts `radian:read`, optional `radian:write`, and optional `offline_access`; it rejects `radian:write` without `radian:read`.

- [x] **Step 1: Write failing scope tests**

```ts
it('separa lectura y escritura en OAuth', () => {
  expect(normalizeScope('radian:read')).toBe('radian:read');
  expect(normalizeScope('radian:read radian:write offline_access')).toBe('radian:read radian:write offline_access');
  expect(normalizeScope('radian:write')).toBeUndefined();
  expect(hasMcpScope('radian:read', 'radian:write')).toBe(false);
  expect(hasMcpScope('radian:read radian:write', 'radian:write')).toBe(true);
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL because write scope and scope predicate do not exist.

- [x] **Step 3: Implement scope handling and discovery**

Keep read-only clients compatible. Add the write scope to OAuth discovery, preserve it in authorization requests and token rows, and render consent with separate Spanish labels for “leer” and “modificar”. Never infer write permission from `radian:read`.

- [x] **Step 4: Run tests and verify the boundary**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: PASS, including existing read-only scope behavior.

- [x] **Step 5: Commit the OAuth scope**

```bash
git add functions/lib/mcpAuth.ts functions/api/mcp/authorize.ts functions/.well-known/oauth-authorization-server.ts tests/mcp.test.ts
git commit -m "feat: add MCP write authorization scope"
```

### Task 3: Make reads expose a safe version and add strict validation

**Files:**
- Modify: `functions/lib/mcp.ts`
- Create: `functions/lib/mcpWrite.ts`
- Modify: `functions/types.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- `loadMcpUserData(database, userId): Promise<{ data: AppData | null; updatedAt?: string }>`.
- `validateMcpAppData(value: unknown): AppData` throws a user-facing validation error and rejects invalid IDs, dates, numeric ranges, unknown top-level structures, and payloads over 900 KB.
- `McpWriteRequest` contains `userId`, `clientId`, `baseUpdatedAt`, and a validated operation payload.

- [x] **Step 1: Write failing version and validation tests**

```ts
it('devuelve updatedAt junto al resultado de lectura', async () => {
  const result = await loadMcpUserData(databaseWithUserData, 'user-1');
  expect(result.updatedAt).toBe('2026-08-31T21:00:00.000Z');
  expect(result.data?.profile).toBeDefined();
});

it('rechaza una copia completa con una rutina inválida', () => {
  expect(() => validateMcpAppData({ schemaVersion: 7, profile: {}, plan: { days: [] }, sessions: [] })).toThrow();
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL because reads return only `AppData` and strict validation is absent.

- [x] **Step 3: Implement the read record and validators**

Return `updatedAt` from every read tool result that can precede a mutation. Use `migrateData` only to normalize known legacy fields, then validate the normalized result. Use `TextEncoder` for the 900 KB limit and reject unknown properties on partial operation inputs.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the version and validation seam**

```bash
git add functions/lib/mcp.ts functions/lib/mcpWrite.ts functions/types.ts tests/mcp.test.ts
git commit -m "feat: validate MCP mutation payloads"
```

### Task 4: Implement conditional non-destructive mutations

**Files:**
- Modify: `functions/lib/mcpWrite.ts`
- Modify: `functions/lib/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- `writeMcpData(database, userId, clientId, baseUpdatedAt, operation): Promise<McpMutationResult | McpConflict>`.
- `MCP_WRITE_TOOL_DEFINITIONS` exposes `update_profile`, `replace_routine`, `record_workout`, `add_measurement`, and `add_checkin`.
- Every successful mutation returns `{ updatedAt, summary }`.

- [x] **Step 1: Write failing mutation tests**

```ts
it('actualiza solo el perfil permitido con la versión base', async () => {
  const result = await updateProfile(database, 'user-1', 'client-1', currentUpdatedAt, { gym: 'Evanfit Picanya' });
  expect(result).toMatchObject({ updatedAt: expect.any(String), summary: expect.any(Object) });
  expect(latestPayload.profile.gym).toBe('Evanfit Picanya');
});

it('rechaza una escritura sobre una versión obsoleta sin mutar datos', async () => {
  await expect(updateProfile(database, 'user-1', 'client-1', 'old-version', { gym: 'Otro' })).resolves.toMatchObject({ error: 'conflict' });
  expect(latestPayload.profile.gym).toBe('Evanfit Picanya');
});
```

Add independent tests for `record_workout`, `add_measurement`, and weekly check-in upsert, including duplicate week-key behavior.

- [x] **Step 2: Run focused tests to verify they fail**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL because mutation functions and write tool definitions do not exist.

- [x] **Step 3: Implement the conditional write primitive**

Read the current row for the authenticated user, compare `baseUpdatedAt`, validate the operation against that snapshot, and execute one conditional D1 update:

```sql
UPDATE user_data
SET payload = ?, updated_at = ?
WHERE user_id = ? AND updated_at = ?
```

Treat a change count other than one as a conflict and reread only that user’s current row. Do not apply a request without a base version; return `needs_version` with the current `updatedAt` and no write.

- [x] **Step 4: Implement the five semantic tools**

Use the existing domain types. `record_workout` creates a new completed `WorkoutSession` with a server-generated ID and validates every exercise against the account’s catalog; it never edits an existing session. `replace_routine` validates the complete `WorkoutPlan`. Profile, measurement, and check-in operations update only their declared fields.

- [x] **Step 5: Run focused tests and verify they pass**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: PASS with no writes on stale versions or invalid payloads.

- [x] **Step 6: Commit the mutation slice**

```bash
git add functions/lib/mcp.ts functions/lib/mcpWrite.ts tests/mcp.test.ts
git commit -m "feat: add conditional MCP training mutations"
```

### Task 5: Implement previews, destructive changes, revisions, and restore

**Files:**
- Modify: `functions/lib/mcpWrite.ts`
- Modify: `functions/lib/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- `previewChange(database, userId, clientId, request): Promise<{ changeId: string; expiresAt: string; summary: object }>`.
- `applyChange(database, userId, clientId, changeId, confirm: boolean): Promise<McpMutationResult | McpConflict>`.
- `listRevisions(database, userId): Promise<RevisionSummary[]>`.
- `restoreRevision(database, userId, clientId, revisionId, baseUpdatedAt): Promise<McpMutationResult | McpConflict>`.

- [x] **Step 1: Write failing recovery tests**

Test that preview does not delete, `confirm: false` does not delete, confirmation deletes exactly once, stale/foreign/expired proposals do nothing, and restore creates a new active version without changing the original revision.

```ts
it('no borra hasta aplicar una propuesta confirmada', async () => {
  const preview = await previewChange(database, 'user-1', 'client-1', { kind: 'delete_workout', workoutId, baseUpdatedAt });
  expect(await readWorkout(database, workoutId)).toBeDefined();
  await expect(applyChange(database, 'user-1', 'client-1', preview.changeId, false)).resolves.toMatchObject({ error: 'confirmation_required' });
  await expect(applyChange(database, 'user-1', 'client-1', preview.changeId, true)).resolves.toMatchObject({ revisionId: expect.any(String) });
  await expect(applyChange(database, 'user-1', 'client-1', preview.changeId, true)).resolves.toMatchObject({ error: 'change_unavailable' });
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL because pending changes, destructive dispatch, revision listing, and restore do not exist.

- [x] **Step 3: Implement proposal storage and expiry**

Persist a JSON change envelope in `mcp_pending_changes`, bound to `user_id`, `client_id`, `base_updated_at`, and a 10-minute expiration. `preview_change` only reads and inserts. `apply_change` requires `confirm === true`, validates every binding, performs the conditional mutation, and marks the proposal used after success. Replays are blocked by `used_at` and the old base version.

- [x] **Step 4: Implement destructive operations and revision recovery**

Expose named preview tools for deleting a workout, measurement, or check-in, plus full replacement and deleting the active copy. `apply_change` is the only mutation path for these kinds. Validate complete replacement payloads before writing. Use the migration’s `user_data` triggers to snapshot the old payload, delete expired revisions before listing, filter every query by `user_id`, and restore through a conditional insert/update that marks the source revision only after success.

- [x] **Step 5: Run focused tests and verify they pass**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: PASS for confirmation, conflict, ownership, expiry, one-use, backup, deletion, replacement, and restoration.

- [x] **Step 6: Commit destructive recovery**

```bash
git add functions/lib/mcp.ts functions/lib/mcpWrite.ts tests/mcp.test.ts
git commit -m "feat: add recoverable MCP destructive changes"
```

### Task 6: Wire write tools through MCP and OAuth boundaries

**Files:**
- Modify: `functions/api/mcp.ts`
- Modify: `functions/lib/mcp.ts`
- Modify: `functions/lib/mcpAuth.ts`
- Modify: `functions/api/mcp/authorize.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Read-only access continues to work with `radian:read`.
- Mutation calls return a controlled MCP error when the token lacks `radian:write`.
- Write dispatch passes only the authenticated `userId` and OAuth `clientId` to `mcpWrite.ts`.

- [x] **Step 1: Write failing dispatch tests**

Assert the catalog contains read and write tools, a read-only token is rejected for mutations, a write-scoped token dispatches correctly, and malformed arguments return `-32602` without touching D1.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run tests/mcp.test.ts`

Expected: FAIL because the router currently recognizes only read tools.

- [x] **Step 3: Add scope-aware dispatch**

Require `radian:read` for reads and `radian:write` for mutations. Keep CORS, protocol version, JSON-RPC response shape, and existing OAuth clients unchanged. Do not accept a client-supplied user ID or scope.

- [x] **Step 4: Run all local checks and commit**

Run:

```bash
npm run lint
npm run lint:functions
npm test -- --run
```

Expected: PASS with the existing 42-test baseline plus the new write tests.

```bash
git add functions/api/mcp.ts functions/lib/mcp.ts functions/lib/mcpAuth.ts functions/api/mcp/authorize.ts tests/mcp.test.ts
git commit -m "feat: expose authenticated MCP write tools"
```

### Task 7: Document client setup and recovery

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documentation explains one-time remote MCP setup, `radian:read` versus `radian:write`, the preview/confirmation flow, conflict responses, and the 30-day recovery window.

- [x] **Step 1: Add the documentation**

Explain that Codex, Claude, and other MCP clients register the endpoint once, that write scope is separately approved, and that Radian’s local copy synchronizes through the existing conflict UI. Include the exact tool names `preview_change`, `apply_change`, `list_revisions`, and `restore_revision`.

- [x] **Step 2: Verify documentation and secret hygiene**

Run:

```bash
rg -n "radian:write|preview_change|apply_change|restore_revision|30 days|api/mcp" README.md
git diff --check
```

Expected: all concepts are present; no token, password, or secret value appears.

- [x] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain writable MCP clients and recovery"
```

### Task 8: Validate, migrate, publish, and verify runtime

**Files:**
- Modify only when a verification defect requires it: files from Tasks 1–7.

**Interfaces:**
- Preview and production have migration `0006_mcp_revisions.sql` applied.
- Production advertises `radian:write`, rejects mutation calls without that scope, and keeps the existing unauthenticated `401` behavior.

- [x] **Step 1: Run complete local verification**

Run:

```bash
npm run lint
npm run lint:functions
npm test -- --run
npm run build
npx wrangler pages functions build functions --outdir /tmp/radian-pages-functions-build
git diff --check
```

Expected: all commands succeed and Pages Functions compile.

- [x] **Step 2: Apply and verify D1 migration**

Run the migration first in Preview, verify its tables and triggers with a test account, then run the same migration in production:

```bash
npx wrangler d1 migrations apply radian-preview --remote --env preview
npx wrangler d1 migrations apply radian-prod --remote --env production
```

Expected: both report `0006_mcp_revisions.sql` applied and no later migrations are pending.

- [x] **Step 3: Publish through Pages**

```bash
git push origin master
```

Expected: Cloudflare Pages creates an active deployment for the verified commit.

- [x] **Step 4: Run production smoke and write-boundary checks**

Run `npm run smoke:prod`. Verify OAuth metadata includes `radian:write`, the MCP endpoint returns `401` without a bearer token, and a read-only token cannot call a mutation. Do not create or print a real access token in logs.

- [x] **Step 5: Verify the final state**

Run `git status --short` and inspect the latest Pages deployment. Expected: clean worktree, active deployment, no unrelated files changed, and the read-only MCP behavior preserved.
