import { readGymState, writeGymState, MAX_DOCUMENT_BYTES } from '../db/radian/state';
import { authenticateMcpRequest, hasMcpScope, MCP_WRITE_SCOPE, mcpJson, mcpOptions, rateLimitMcp } from '../mcpAuth';
import { requestFingerprint } from '../mcpReceipts';
import { readSmallText } from './request';
import type { McpAuthenticatedRequest } from '../mcpAuth';
import type { SyncContext } from '../../types';
import * as syncMerge from '../../../frontend/src/lib/sync-merge.js';
// @ts-expect-error The shared JavaScript unit converter is bundled through sync-merge but has no Functions declaration.
import * as units from '../../../frontend/src/lib/units.js';

const PROTOCOLS = ['2025-06-18', '2026-07-28'];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const error = (id: unknown, code: number, message: string, data?: Record<string, unknown>) => mcpJson({
  jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) },
}, 200);
const result = (id: unknown, value: unknown, protocol?: string) => mcpJson({ jsonrpc: '2.0', id, result: value }, 200,
  protocol ? { 'MCP-Protocol-Version': protocol } : {});
const toolResult = (id: unknown, value: unknown) => result(id, {
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  isError: false,
});
const toolError = (id: unknown, message: string, detail: Record<string, unknown>) => result(id, {
  content: [{ type: 'text', text: message }], structuredContent: detail, isError: true,
});

const tools = [
  { name: 'get_profile', title: 'Leer perfil de Radian', description: 'Lee los ajustes de entrenamiento de la cuenta autorizada.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_routines', title: 'Listar rutinas', description: 'Devuelve las rutinas y sus prescripciones guardadas.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_workouts', title: 'Listar sesiones', description: 'Devuelve sesiones completadas recientes.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: 'exercise_history', title: 'Consultar historial de ejercicio', description: 'Busca series registradas por nombre o ID de ejercicio.', inputSchema: { type: 'object', properties: { exercise: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['exercise'], additionalProperties: false } },
  { name: 'get_bodyweight', title: 'Consultar peso y medidas', description: 'Lee las mediciones corporales de la cuenta autorizada.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_change_history', title: 'Consultar cambios del MCP', description: 'Lista las últimas operaciones MCP aplicadas sin devolver datos de entrenamiento.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_revisions', title: 'Listar revisiones recuperables', description: 'Lista las revisiones normalizadas de la cuenta disponibles durante 30 días.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'restore_revision', title: 'Restaurar revisión', description: 'Restaura una revisión recuperable si la cuenta no ha cambiado desde la revisión base indicada.', inputSchema: { type: 'object', properties: { baseRev: { type: 'integer', minimum: 0 }, baseWid: { type: ['string', 'null'] }, revisionId: { type: 'string', minLength: 1, maxLength: 128 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 94, pattern: '^[A-Za-z0-9_-]+$' } }, required: ['baseRev', 'baseWid', 'revisionId'], additionalProperties: false } },
  { name: 'update_profile', title: 'Actualizar ajustes del perfil', description: 'Actualiza campos explícitos del perfil con revisión base obligatoria.', inputSchema: { type: 'object', properties: { baseRev: { type: 'integer', minimum: 0 }, baseWid: { type: ['string', 'null'] }, idempotencyKey: { type: 'string', minLength: 1 }, profile: { type: 'object' } }, required: ['baseRev', 'baseWid', 'idempotencyKey', 'profile'], additionalProperties: false } },
  { name: 'record_workout', title: 'Registrar sesión', description: 'Añade una sesión completada y validada a la cuenta autorizada.', inputSchema: { type: 'object', properties: { baseRev: { type: 'integer', minimum: 0 }, baseWid: { type: ['string', 'null'] }, idempotencyKey: { type: 'string', minLength: 1 }, workout: { type: 'object' } }, required: ['baseRev', 'baseWid', 'idempotencyKey', 'workout'], additionalProperties: false } },
  { name: 'add_measurement', title: 'Añadir medición', description: 'Añade una medición corporal con revisión base obligatoria.', inputSchema: { type: 'object', properties: { baseRev: { type: 'integer', minimum: 0 }, baseWid: { type: ['string', 'null'] }, idempotencyKey: { type: 'string', minLength: 1 }, entry: { type: 'object' } }, required: ['baseRev', 'baseWid', 'idempotencyKey', 'entry'], additionalProperties: false } },
  { name: 'preview_replace_training_plan', title: 'Previsualizar sustitución de rutinas', description: 'Previsualiza la sustitución completa; no cambia datos hasta confirmar la propuesta.', inputSchema: { type: 'object', properties: { baseRev: { type: 'integer', minimum: 0 }, baseWid: { type: ['string', 'null'] }, idempotencyKey: { type: 'string', minLength: 1 }, routines: { type: 'array' } }, required: ['baseRev', 'baseWid', 'idempotencyKey', 'routines'], additionalProperties: false } },
  { name: 'preview_delete_workout', title: 'Previsualizar borrado de sesión', description: 'Muestra el efecto y crea una propuesta temporal; no cambia los datos.', inputSchema: { type: 'object', properties: { baseRev: { type: 'integer', minimum: 0 }, baseWid: { type: ['string', 'null'] }, idempotencyKey: { type: 'string', minLength: 1 }, workoutId: { type: 'string', minLength: 1 } }, required: ['baseRev', 'baseWid', 'idempotencyKey', 'workoutId'], additionalProperties: false } },
  { name: 'preview_delete_measurement', title: 'Previsualizar borrado de medición', description: 'Muestra el efecto y crea una propuesta temporal; no cambia los datos.', inputSchema: { type: 'object', properties: { baseRev: { type: 'integer', minimum: 0 }, baseWid: { type: ['string', 'null'] }, idempotencyKey: { type: 'string', minLength: 1 }, measurementId: { type: 'string', minLength: 1 } }, required: ['baseRev', 'baseWid', 'idempotencyKey', 'measurementId'], additionalProperties: false } },
  { name: 'apply_change', title: 'Confirmar cambio MCP', description: 'Aplica una propuesta explícitamente confirmada si sigue vigente y no ha cambiado la revisión base.', inputSchema: { type: 'object', properties: { changeId: { type: 'string', minLength: 1 }, confirm: { type: 'boolean' } }, required: ['changeId', 'confirm'], additionalProperties: false } },
] as const;
const readNames = new Set(['get_profile', 'list_routines', 'list_workouts', 'exercise_history', 'get_bodyweight', 'get_change_history', 'list_revisions']);
const writeNames = new Set(['update_profile', 'record_workout', 'add_measurement', 'preview_replace_training_plan', 'preview_delete_workout', 'preview_delete_measurement', 'apply_change', 'restore_revision']);
const ownKeys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const shortText = (value: unknown, max = 100) => typeof value === 'string' && value.length > 0 && value.length <= max;
const day = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00`));
const base = (args: Record<string, unknown>) => Number.isSafeInteger(args.baseRev) && (args.baseRev as number) >= 0
  && Object.hasOwn(args, 'baseWid') && (args.baseWid === null || shortText(args.baseWid, 128));
const stateObject = (snapshot: Awaited<ReturnType<typeof readGymState>>) => snapshot.state ?? {};
const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.filter(isObject) : [];
const stateCollections = ['workouts', 'routines', 'customEx', 'bodyweight', 'measurements', 'equipProfiles', 'gymCards', 'favEx'] as const;
const stateStamp = (state: Record<string, unknown>): number => {
  let latest = 0;
  const see = (value: unknown) => { latest = Math.max(latest, Math.abs(Number(value) || 0)); };
  see(state._ts);
  if (isObject(state.unitSet)) see(state.unitSet.at);
  see(state.resetAt);
  if (isObject(state.edited)) Object.values(state.edited).forEach(see);
  if (isObject(state.deleted)) for (const value of Object.values(state.deleted)) {
    if (isObject(value)) Object.values(value).forEach(see);
  }
  for (const field of ['workouts', 'routines', 'customEx', 'equipProfiles', 'gymCards']) {
    for (const entry of rows(state[field])) {
      see(entry._ts);
      if (isObject(entry._f)) Object.values(entry._f).forEach(see);
    }
  }
  for (const field of ['bodyweight', 'measurements']) for (const entry of rows(state[field])) see(entry.t);
  for (const field of ['balanceOverrides', 'loadKind', 'plates', 'dbLoad', 'dumbbells', 'dayNotes', 'dayPhotos']) {
    if (isObject(state[field])) for (const value of Object.values(state[field])) if (isObject(value)) see(value._ts);
  }
  return latest;
};
const entityKey = (field: string, entry: Record<string, unknown> | unknown): string | null => {
  if (field === 'favEx') return entry == null ? null : String(entry);
  if (!isObject(entry)) return null;
  if (field === 'bodyweight' || field === 'measurements') {
    const dayKey = entry.d ?? entry.date;
    return dayKey == null ? null : String(dayKey);
  }
  if (field === 'workouts' && entry.id == null) return `${String(entry.d ?? entry.date ?? '')}|${String(entry.start ?? '')}`;
  return entry.id == null ? null : String(entry.id);
};
const entryTime = (field: string, entry: Record<string, unknown>): number => field === 'workouts'
  ? Number(entry._ts) || Number(entry.end) || Number(entry.start) || 0
  : Number(entry._ts) || (field === 'bodyweight' || field === 'measurements' ? Number(entry.t) || 0 : 0);
const entryBody = (entry: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
  Object.entries(entry).filter(([key]) => !['_ts', '_f', '_u'].includes(key)),
);
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const restoreMerge = syncMerge as unknown as {
  keepReset: (previous: Record<string, unknown>, next: Record<string, unknown>) => unknown;
  stampRestore: (next: Record<string, unknown>, others: Record<string, unknown>[], now: number) => unknown;
  stampReplace: (next: Record<string, unknown>, others: Record<string, unknown>[], now: number) => unknown;
};
const convertStateUnit = (units as unknown as {
  convertStateUnit: (state: Record<string, unknown>, to: 'kg' | 'lb') => Record<string, unknown>;
}).convertStateUnit;

// Match the local sync merge contract: every MCP mutation carries causal edit stamps and
// tombstones, so an older offline outbox cannot reintroduce a removed entity on its next merge.
const stampMcpChange = (previous: Record<string, unknown>, next: Record<string, unknown>): number => {
  const now = Math.max(Date.now(), stateStamp(previous) + 1, stateStamp(next) + 1);
  const indexed = (state: Record<string, unknown>, field: string): Map<string, Record<string, unknown>> => new Map(
    rows(state[field]).map(entry => [entityKey(field, entry), entry] as const).filter((item): item is readonly [string, Record<string, unknown>] => item[0] !== null),
  );

  for (const field of ['workouts', 'routines', 'customEx', 'equipProfiles', 'gymCards']) {
    const before = indexed(previous, field);
    for (const entry of rows(next[field])) {
      const key = entityKey(field, entry);
      if (key === null) continue;
      const old = before.get(key);
      if (!old || !sameJson(entryBody(old), entryBody(entry))) {
        entry._ts = now;
        if (old) {
          const fields = isObject(old._f) ? { ...old._f } : {};
          for (const name of new Set([...Object.keys(entryBody(old)), ...Object.keys(entryBody(entry))])) {
            const oldBody = entryBody(old), newBody = entryBody(entry);
            if ((name in oldBody) !== (name in newBody) || !sameJson(oldBody[name], newBody[name])) fields[name] = now;
          }
          if (Object.keys(fields).length) entry._f = fields;
          else delete entry._f;
        }
      }
    }
  }
  for (const field of ['bodyweight', 'measurements']) {
    const before = indexed(previous, field);
    for (const entry of rows(next[field])) {
      const key = entityKey(field, entry);
      const old = key === null ? undefined : before.get(key);
      if (!old || !sameJson(entryBody(old), entryBody(entry))) entry.t = now;
    }
  }
  for (const field of ['balanceOverrides', 'loadKind', 'plates', 'dbLoad', 'dumbbells', 'dayNotes', 'dayPhotos']) {
    const before = isObject(previous[field]) ? previous[field] : {};
    const after = isObject(next[field]) ? next[field] : {};
    for (const [key, value] of Object.entries(after)) {
      if (!isObject(value) || value._ts === undefined) continue;
      const old = isObject(before[key]) ? before[key] : {};
      if (Number(old._ts) !== Number(value._ts) || !sameJson(entryBody(old), entryBody(value))) value._ts = now;
    }
  }

  const previousDeleted = isObject(previous.deleted) ? previous.deleted : {};
  const nextDeleted = isObject(next.deleted) ? next.deleted : {};
  const deleted: Record<string, unknown> = { ...previousDeleted, ...nextDeleted };
  for (const field of stateCollections) {
    const oldRows = field === 'favEx' ? (Array.isArray(previous[field]) ? previous[field] as unknown[] : []) : rows(previous[field]);
    const newRows = field === 'favEx' ? (Array.isArray(next[field]) ? next[field] as unknown[] : []) : rows(next[field]);
    const oldKeys = new Set(oldRows.map(entry => entityKey(field, entry)).filter((key): key is string => key !== null));
    const newKeys = new Set(newRows.map(entry => entityKey(field, entry)).filter((key): key is string => key !== null));
    const priorMap = isObject(previousDeleted[field]) ? previousDeleted[field] : {};
    const nextMap = isObject(nextDeleted[field]) ? nextDeleted[field] : {};
    const map: Record<string, unknown> = { ...priorMap };
    for (const [key, value] of Object.entries(nextMap)) {
      const current = Number(map[key]) || 0, candidate = Number(value) || 0;
      if (Math.abs(candidate) > Math.abs(current) || (Math.abs(candidate) === Math.abs(current) && candidate < current)) map[key] = value;
    }
    for (const entry of oldRows) {
      const key = entityKey(field, entry);
      if (key === null || newKeys.has(key)) continue;
      map[key] = Math.max(now, field === 'favEx' || !isObject(entry) ? 0 : entryTime(field, entry) + 1);
    }
    for (const entry of newRows) {
      const key = entityKey(field, entry);
      if (key === null || oldKeys.has(key)) continue;
      if ((Number(map[key]) || 0) > 0 || field === 'favEx') map[key] = -now;
    }
    if (Object.keys(map).length) deleted[field] = map;
  }
  if (Object.keys(deleted).length) next.deleted = deleted;

  const previousUnit = previous.unit === 'lb' ? 'lb' : 'kg';
  const nextUnit = next.unit === 'lb' ? 'lb' : 'kg';
  if (previousUnit !== nextUnit) next.unitSet = { at: now, convert: true };
  next._ts = now;

  const ownFields = new Set([
    '_ts', '_rev', '_wid', '_wids', 'active', 'unit', 'unitSet', 'resetAt', 'resetIds', 'deleted', 'edited', 'undone',
    'routineOrder', ...stateCollections, 'exWeights', 'balanceOverrides', 'loadKind', 'plates', 'dbLoad', 'dumbbells', 'dayNotes', 'dayPhotos',
  ]);
  const perKeyFields = new Set(['week', 'dayPlan', 'exNotes', 'barWeights']);
  const edited = isObject(next.edited) ? { ...next.edited } : {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (ownFields.has(key)) continue;
    const oldValue = previous[key], newValue = next[key];
    if (perKeyFields.has(key)) {
      const oldMap = isObject(oldValue) ? oldValue : {}, newMap = isObject(newValue) ? newValue : {};
      for (const item of new Set([...Object.keys(oldMap), ...Object.keys(newMap)])) {
        if ((item in oldMap) !== (item in newMap) || !sameJson(oldMap[item], newMap[item])) edited[`${key}.${item}`] = now;
      }
    } else if (!sameJson(oldValue, newValue)) edited[key] = now;
  }
  const order = (value: unknown) => rows(value).map(entry => entry.id).filter(id => id != null);
  const oldOrder = order(previous.routines), newOrder = order(next.routines);
  if (!sameJson(oldOrder, newOrder)) edited.routineOrder = now;
  if (Object.keys(edited).length) next.edited = edited;
  return now;
};

// A revision restore is an explicit replacement intent, even when a field happens to equal the
// current value. Renew all merge stamps so a device's older outbox cannot undo that intent.
const stampMcpRestore = (previous: Record<string, unknown>, next: Record<string, unknown>): void => {
  const now = stampMcpChange(previous, next);
  restoreMerge.stampRestore(next, [previous], now);
  restoreMerge.stampReplace(next, [previous], now);
  restoreMerge.keepReset(previous, next);

  const ownFields = new Set([
    '_ts', '_rev', '_wid', '_wids', '_unstamped', '_prior', 'active', 'unit', 'unitSet', 'resetAt', 'resetIds',
    'deleted', 'edited', 'undone', 'routineOrder', ...stateCollections, 'exWeights',
    'balanceOverrides', 'loadKind', 'plates', 'dbLoad', 'dumbbells', 'dayNotes', 'dayPhotos',
  ]);
  const perKeyFields = new Set(['week', 'dayPlan', 'exNotes', 'barWeights']);
  const edited = isObject(next.edited) ? { ...next.edited } : {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (ownFields.has(key)) continue;
    if (perKeyFields.has(key)) {
      const oldMap = isObject(previous[key]) ? previous[key] : {};
      const newMap = isObject(next[key]) ? next[key] : {};
      for (const item of new Set([...Object.keys(oldMap), ...Object.keys(newMap)])) edited[`${key}.${item}`] = now;
    } else {
      edited[key] = now;
    }
  }
  edited.routineOrder = now;
  next.edited = edited;

  for (const field of ['workouts', 'routines', 'customEx', 'equipProfiles', 'gymCards']) {
    const before = new Map(rows(previous[field]).map(entry => [entityKey(field, entry), entry] as const)
      .filter((item): item is readonly [string, Record<string, unknown>] => item[0] !== null));
    for (const entry of rows(next[field])) {
      const key = entityKey(field, entry);
      if (key === null) continue;
      const old = before.get(key);
      const names = new Set([
        ...Object.keys(old ?? {}), ...Object.keys(entry),
        ...(isObject(old?._f) ? Object.keys(old._f) : []), ...(isObject(entry._f) ? Object.keys(entry._f) : []),
      ].filter(name => !['_ts', '_f', '_u', 'id'].includes(name)));
      if (names.size) entry._f = Object.fromEntries([...names].map(name => [name, now]));
      else delete entry._f;
      entry._ts = now;
      delete entry._u;
    }
  }
  for (const field of ['bodyweight', 'measurements']) {
    for (const entry of rows(next[field])) entry.t = now;
  }

  for (const field of ['balanceOverrides', 'loadKind', 'plates', 'dbLoad', 'dumbbells', 'dayNotes', 'dayPhotos']) {
    const before = isObject(previous[field]) ? previous[field] : {};
    const hadTargetMap = isObject(next[field]);
    const after = hadTargetMap ? { ...(next[field] as Record<string, unknown>) } : {};
    for (const key of Object.keys(before)) if (!(key in after)) after[key] = { _ts: now };
    for (const [key, value] of Object.entries(after)) {
      if (isObject(value)) value._ts = now;
      else after[key] = { _ts: now };
    }
    if (hadTargetMap || Object.keys(after).length) next[field] = after;
  }

  if ('unit' in previous || 'unit' in next || 'unitSet' in previous || 'unitSet' in next) {
    next.unitSet = { ...(isObject(next.unitSet) ? next.unitSet : {}), at: now, convert: true };
  }
  next._ts = now;
};

const readTool = async (auth: McpAuthenticatedRequest, name: string, args: Record<string, unknown>) => {
  const snapshot = await readGymState(auth.database, auth.userId);
  const state = stateObject(snapshot);
  if (name === 'get_profile') {
    const profile = Object.fromEntries(['unit', 'lang', 'theme', 'body', 'targetW', 'langAuto', 'experience'].filter(key => key in state).map(key => [key, state[key]]));
    return { profile, rev: snapshot.rev, wid: snapshot.wid };
  }
  if (name === 'list_routines') return { rev: snapshot.rev, wid: snapshot.wid, routines: Array.isArray(state.routines) ? state.routines : [] };
  if (name === 'list_workouts') {
    const limit = args.limit === undefined ? 20 : args.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('limit debe ser un entero entre 1 y 50.');
    const workouts = Array.isArray(state.workouts) ? state.workouts : [];
    return { rev: snapshot.rev, wid: snapshot.wid, workouts: workouts.slice(-Number(limit)).reverse() };
  }
  if (name === 'exercise_history') {
    if (!shortText(args.exercise, 120)) throw new Error('exercise es obligatorio.');
    const limit = args.limit === undefined ? 50 : args.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('limit no es válido.');
    const query = String(args.exercise).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const matches = rows(state.workouts).flatMap(workout => rows(workout.entries)
      .filter(entry => `${entry.id || ''} ${entry.name || ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(query))
      .map(entry => ({ d: workout.d ?? workout.date ?? null, workoutId: workout.id ?? null, exercise: entry })))
      .slice(-Number(limit)).reverse();
    return { rev: snapshot.rev, wid: snapshot.wid, exercise: args.exercise, matches };
  }
  if (name === 'get_bodyweight') return { rev: snapshot.rev, wid: snapshot.wid, bodyweight: state.bodyweight ?? [], measurements: state.measurements ?? [] };
  if (name === 'list_revisions') {
    const now = new Date().toISOString();
    const revisions = await auth.database.prepare(`SELECT revision_id AS id, source, created_at AS createdAt,
        expires_at AS expiresAt, restored_at AS restoredAt
      FROM gym_mcp_revisions
      WHERE account_id = ? AND revision < ? AND expires_at > ?
      ORDER BY revision DESC`)
      .bind(auth.userId, snapshot.rev, now)
      .all<{ id: string; source: 'pwa' | 'mcp'; createdAt: string; expiresAt: string; restoredAt: string | null }>();
    return { revisions: revisions.results };
  }
  const auditRows = await auth.database.prepare(
    'SELECT tool_name AS tool, action, outcome, summary_json AS summary, created_at AS createdAt FROM gym_mcp_audit WHERE account_id = ? ORDER BY created_at DESC LIMIT 100',
  ).bind(auth.userId).all<{ tool: string; action: string; outcome: string; summary: string; createdAt: string }>();
  return { entries: auditRows.results.map(row => ({ ...row, summary: JSON.parse(row.summary) })), limit: 100 };
};

const previewChange = async (auth: McpAuthenticatedRequest, name: string, args: Record<string, unknown>) => {
  if (!hasMcpScope(auth.scope, MCP_WRITE_SCOPE)) return { error: 'insufficient_scope', requiredScope: MCP_WRITE_SCOPE, tool: name };
  if (!base(args)) throw new Error('baseRev y baseWid no son válidos.');
  if (!shortText(args.idempotencyKey, 100) || !/^[A-Za-z0-9_-]+$/.test(String(args.idempotencyKey))) throw new Error('idempotencyKey es obligatorio y debe ser válido.');
  const operationId = `preview-${args.idempotencyKey}`;
  const operationArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'idempotencyKey'));
  const fingerprint = await requestFingerprint({ name, args: operationArgs });
  const readOperation = () => auth.database.prepare(
    'SELECT fingerprint, result_json AS resultJson FROM gym_mcp_operations WHERE account_id = ? AND client_id = ? AND operation_id = ?',
  ).bind(auth.userId, auth.clientId, operationId).first<{ fingerprint: string; resultJson: string }>();
  const prior = await readOperation();
  if (prior) {
    if (prior.fingerprint !== fingerprint) return { error: 'idempotency_key_reused' };
    return { ...(JSON.parse(prior.resultJson) as Record<string, unknown>), replayed: true };
  }
  const snapshot = await readGymState(auth.database, auth.userId);
  if (snapshot.rev !== args.baseRev || snapshot.wid !== args.baseWid) return { error: 'conflict', rev: snapshot.rev, wid: snapshot.wid };
  const state = stateObject(snapshot);
  let kind: string;
  let payload: Record<string, unknown>;
  let preview: Record<string, unknown>;
  if (name === 'preview_replace_training_plan') {
    if (!Array.isArray(args.routines) || args.routines.length > 200 || new TextEncoder().encode(JSON.stringify(args.routines)).byteLength > 850_000) throw new Error('routines no es válido.');
    kind = 'replace_training_plan';
    payload = { kind, routines: args.routines };
    preview = { kind, currentRoutineCount: Array.isArray(state.routines) ? state.routines.length : 0, nextRoutineCount: args.routines.length };
  } else {
    const idKey = name === 'preview_delete_workout' ? 'workoutId' : 'measurementId';
    if (!shortText(args[idKey], 128)) throw new Error(`${idKey} no es válido.`);
    const collection = name === 'preview_delete_workout' ? 'workouts' : 'measurements';
    const rows = Array.isArray(state[collection]) ? state[collection] as Array<Record<string, unknown>> : [];
    const target = rows.find(row => row?.id === args[idKey]);
    if (!target) return { error: 'change_unavailable' };
    kind = name === 'preview_delete_workout' ? 'delete_workout' : 'delete_measurement';
    payload = { kind, [idKey]: args[idKey] };
    preview = { kind, id: args[idKey], date: target.d ?? null };
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const changeId = crypto.randomUUID();
  preview = { ...preview, baseRev: snapshot.rev, baseWid: snapshot.wid };
  const proposalResult = { changeId, expiresAt, preview, requiresConfirmation: true };
  try {
    await auth.database.batch([
      auth.database.prepare(`INSERT INTO gym_mcp_pending_changes
      (account_id, client_id, change_id, kind, payload_json, preview_json, base_revision, base_write_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(auth.userId, auth.clientId, changeId, kind, JSON.stringify(payload), JSON.stringify(preview), snapshot.rev, snapshot.wid, now.toISOString(), expiresAt),
      auth.database.prepare(`INSERT INTO gym_mcp_operations
        (account_id, operation_id, client_id, fingerprint, revision, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(auth.userId, operationId, auth.clientId, fingerprint, snapshot.rev, JSON.stringify(proposalResult), now.toISOString()),
      auth.database.prepare(`INSERT INTO gym_mcp_audit
      (event_id, account_id, client_id, tool_name, action, outcome, summary_json, created_at)
      VALUES (?, ?, ?, ?, 'preview', 'created', ?, ?)`)
        .bind(crypto.randomUUID(), auth.userId, auth.clientId, name, JSON.stringify({ kind, preview, changeId }), now.toISOString()),
    ]);
    return proposalResult;
  } catch (caught) {
    const raced = await readOperation();
    if (raced?.fingerprint === fingerprint) return { ...(JSON.parse(raced.resultJson) as Record<string, unknown>), replayed: true };
    throw caught;
  }
};

const applyPreview = async (auth: McpAuthenticatedRequest, args: Record<string, unknown>) => {
  if (!hasMcpScope(auth.scope, MCP_WRITE_SCOPE)) return { error: 'insufficient_scope', requiredScope: MCP_WRITE_SCOPE, tool: 'apply_change' };
  if (!shortText(args.changeId, 100) || typeof args.confirm !== 'boolean') throw new Error('changeId y confirm no son válidos.');
  if (!args.confirm) return { error: 'confirmation_required' };
  const operationId = `apply-${args.changeId}`;
  const fingerprint = await requestFingerprint({ name: 'apply_change', changeId: args.changeId, confirm: true });
  const readOperation = () => auth.database.prepare(
    'SELECT fingerprint, result_json AS resultJson FROM gym_mcp_operations WHERE account_id = ? AND client_id = ? AND operation_id = ?',
  ).bind(auth.userId, auth.clientId, operationId).first<{ fingerprint: string; resultJson: string }>();
  const prior = await readOperation();
  if (prior) {
    if (prior.fingerprint !== fingerprint) return { error: 'idempotency_key_reused' };
    return { ...(JSON.parse(prior.resultJson) as Record<string, unknown>), replayed: true };
  }
  const change = await auth.database.prepare(`SELECT kind, payload_json AS payloadJson, base_revision AS baseRev,
    base_write_id AS baseWid, expires_at AS expiresAt, used_at AS usedAt FROM gym_mcp_pending_changes
    WHERE account_id = ? AND client_id = ? AND change_id = ?`)
    .bind(auth.userId, auth.clientId, args.changeId).first<{ kind: string; payloadJson: string; baseRev: number; baseWid: string | null; expiresAt: string; usedAt: string | null }>();
  if (!change || change.usedAt || change.expiresAt <= new Date().toISOString()) return { error: 'change_unavailable' };
  const snapshot = await readGymState(auth.database, auth.userId);
  if (snapshot.rev !== change.baseRev || snapshot.wid !== change.baseWid) return { error: 'conflict', rev: snapshot.rev, wid: snapshot.wid };
  const payload = JSON.parse(change.payloadJson) as Record<string, unknown>;
  const state = { ...stateObject(snapshot) };
  if (change.kind === 'delete_workout') {
    state.workouts = (Array.isArray(state.workouts) ? state.workouts : []).filter(row => !isObject(row) || row.id !== payload.workoutId);
  } else if (change.kind === 'delete_measurement') {
    state.measurements = (Array.isArray(state.measurements) ? state.measurements : []).filter(row => !isObject(row) || row.id !== payload.measurementId);
  } else if (change.kind === 'replace_training_plan' && Array.isArray(payload.routines)) {
    state.routines = payload.routines;
  } else return { error: 'change_unavailable' };
  stampMcpChange(stateObject(snapshot), state);
  const summary = { kind: change.kind, changeId: args.changeId };
  const written = await writeGymState(auth.database, auth.userId, {
    state, baseRev: snapshot.rev, baseWid: snapshot.wid,
    mcp: { operationId, clientId: auth.clientId, tokenHash: auth.tokenHash, fingerprint, toolName: 'apply_change',
      result: { rev: snapshot.rev + 1, wid: 'pending', summary }, summary, eventId: crypto.randomUUID(), pendingChangeId: String(args.changeId) },
  });
  if (written.ok === false && 'conflict' in written) {
    const raced = await readOperation();
    if (raced?.fingerprint === fingerprint) return { ...(JSON.parse(raced.resultJson) as Record<string, unknown>), replayed: true };
    return { error: 'conflict', rev: written.conflict.rev, wid: written.conflict.wid };
  }
  if (!written.ok) return { error: written.error };
  const saved = await readOperation();
  return saved ? { ...(JSON.parse(saved.resultJson) as Record<string, unknown>), replayed: written.replayed }
    : { rev: written.rev, wid: written.wid, summary, replayed: written.replayed };
};

const writeTool = async (auth: McpAuthenticatedRequest, name: string, args: Record<string, unknown>) => {
  if (!hasMcpScope(auth.scope, MCP_WRITE_SCOPE)) return { error: 'insufficient_scope', requiredScope: MCP_WRITE_SCOPE, tool: name };
  if (!base(args)) throw new Error('baseRev y baseWid no son válidos.');
  const operationId = `write-${args.idempotencyKey as string}`;
  if (!shortText(operationId, 100) || !/^[A-Za-z0-9_-]+$/.test(operationId)) throw new Error('idempotencyKey es obligatorio y debe ser válido.');
  const operationArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'idempotencyKey'));
  const fingerprint = await requestFingerprint({ name, args: operationArgs });
  const replay = async () => auth.database.prepare(
    'SELECT fingerprint, result_json AS resultJson FROM gym_mcp_operations WHERE account_id = ? AND client_id = ? AND operation_id = ?',
  ).bind(auth.userId, auth.clientId, operationId).first<{ fingerprint: string; resultJson: string }>();
  const prior = await replay();
  if (prior) {
    if (prior.fingerprint !== fingerprint) return { error: 'idempotency_key_reused' };
    return { ...(JSON.parse(prior.resultJson) as Record<string, unknown>), replayed: true };
  }

  const snapshot = await readGymState(auth.database, auth.userId);
  if (snapshot.rev !== args.baseRev || (args.baseWid !== undefined && (snapshot.wid ?? null) !== (args.baseWid ?? null))) {
    return { error: 'conflict', rev: snapshot.rev, wid: snapshot.wid };
  }
  const previousState = stateObject(snapshot);
  let state = { ...previousState };
  let stampBaseline = previousState;
  let unitChanged = false;
  const summary: Record<string, unknown> = { kind: name };
  if (name === 'update_profile') {
    const profile = args.profile;
    if (!isObject(profile) || !ownKeys(profile, ['unit', 'lang', 'theme', 'body', 'targetW']) || !Object.keys(profile).length) throw new Error('profile no es válido.');
    if ('unit' in profile && profile.unit !== 'kg' && profile.unit !== 'lb') throw new Error('unit no es válido.');
    for (const key of ['lang', 'theme', 'body']) if (key in profile && !shortText(profile[key], 40)) throw new Error(`${key} no es válido.`);
    if ('targetW' in profile && profile.targetW !== null && (typeof profile.targetW !== 'number' || !Number.isFinite(profile.targetW) || profile.targetW < 0 || profile.targetW > 1000)) throw new Error('targetW no es válido.');
    const currentUnit = state.unit === 'lb' ? 'lb' : 'kg';
    const nextUnit = profile.unit === 'lb' || profile.unit === 'kg' ? profile.unit : currentUnit;
    unitChanged = nextUnit !== currentUnit;
    if (unitChanged) {
      stampBaseline = convertStateUnit(previousState, nextUnit);
      state = convertStateUnit(state, nextUnit);
    }
    Object.assign(state, profile);
    summary.fields = Object.keys(profile);
  } else if (name === 'record_workout') {
    if (!isObject(args.workout) || !day(args.workout.d ?? args.workout.date) || !Array.isArray(args.workout.entries) || args.workout.entries.length > 200) throw new Error('workout no es válido.');
    const id = `mcp-${operationId}`;
    state.workouts = [...(Array.isArray(state.workouts) ? state.workouts : []), { ...args.workout, d: args.workout.d ?? args.workout.date, id }];
    summary.workoutId = id;
  } else {
    if (!isObject(args.entry) || !day(args.entry.d ?? args.entry.date)) throw new Error('entry no es válido.');
    const id = `mcp-${operationId}`;
    state.measurements = [...(Array.isArray(state.measurements) ? state.measurements : []), { ...args.entry, d: args.entry.d ?? args.entry.date, id }];
    summary.measurementId = id;
  }
  const stamp = stampMcpChange(stampBaseline, state);
  if (unitChanged) state.unitSet = { at: stamp, convert: true };
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_DOCUMENT_BYTES) throw new Error('El documento supera el tamaño permitido.');
  const nextRev = snapshot.rev + 1;
  const resultValue = { rev: nextRev, wid: 'pending', summary };
  const written = await writeGymState(auth.database, auth.userId, {
    state,
    baseRev: snapshot.rev,
    baseWid: snapshot.wid,
    mcp: { operationId, clientId: auth.clientId, tokenHash: auth.tokenHash, fingerprint, toolName: name, result: resultValue, summary,
      eventId: crypto.randomUUID() },
  });
  if (written.ok === false && 'conflict' in written) {
    const raced = await replay();
    if (raced?.fingerprint === fingerprint) return { ...(JSON.parse(raced.resultJson) as Record<string, unknown>), replayed: true };
    return { error: 'conflict', rev: written.conflict.rev, wid: written.conflict.wid };
  }
  if (!written.ok) return { error: written.error };
  const saved = await replay();
  if (saved) return { ...(JSON.parse(saved.resultJson) as Record<string, unknown>), replayed: written.replayed };
  return { rev: written.rev, wid: written.wid, summary, replayed: written.replayed };
};

const restoreRevision = async (auth: McpAuthenticatedRequest, args: Record<string, unknown>) => {
  if (!hasMcpScope(auth.scope, MCP_WRITE_SCOPE)) return { error: 'insufficient_scope', requiredScope: MCP_WRITE_SCOPE, tool: 'restore_revision' };
  if (!base(args)) throw new Error('baseRev y baseWid no son válidos.');
  if (!shortText(args.revisionId, 128)) throw new Error('revisionId no es válido.');
  if (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== 'string' || !shortText(args.idempotencyKey, 94)
    || !/^[A-Za-z0-9_-]+$/.test(args.idempotencyKey))) throw new Error('idempotencyKey no es válido.');

  const operationArgs = { baseRev: args.baseRev, baseWid: args.baseWid, revisionId: args.revisionId };
  const fingerprint = await requestFingerprint({ name: 'restore_revision', args: operationArgs });
  const operationId = typeof args.idempotencyKey === 'string' ? `write-${args.idempotencyKey}` : `restore-${fingerprint}`;
  const readOperation = () => auth.database.prepare(
    'SELECT fingerprint, result_json AS resultJson FROM gym_mcp_operations WHERE account_id = ? AND client_id = ? AND operation_id = ?',
  ).bind(auth.userId, auth.clientId, operationId).first<{ fingerprint: string; resultJson: string }>();
  const prior = await readOperation();
  if (prior) {
    if (prior.fingerprint !== fingerprint) return { error: 'idempotency_key_reused' };
    return { ...(JSON.parse(prior.resultJson) as Record<string, unknown>), replayed: true };
  }

  const current = await readGymState(auth.database, auth.userId);
  if (current.rev !== args.baseRev || current.wid !== args.baseWid) return { error: 'conflict', rev: current.rev, wid: current.wid };
  const now = new Date().toISOString();
  const stored = await auth.database.prepare(`SELECT state_json AS stateJson FROM gym_mcp_revisions
    WHERE account_id = ? AND revision_id = ? AND revision < ? AND expires_at > ?`)
    .bind(auth.userId, args.revisionId, current.rev, now).first<{ stateJson: string }>();
  if (!stored) return { error: 'revision_unavailable' };
  let restoredState: unknown;
  try { restoredState = JSON.parse(stored.stateJson); }
  catch { return { error: 'revision_unavailable' }; }
  if (!isObject(restoredState)) return { error: 'revision_unavailable' };
  stampMcpRestore(stateObject(current), restoredState);

  const summary = { kind: 'restore_revision', restoredFromRevisionId: args.revisionId };
  const written = await writeGymState(auth.database, auth.userId, {
    state: restoredState,
    replaceDocument: true,
    baseRev: current.rev,
    baseWid: current.wid,
    mcp: {
      operationId,
      clientId: auth.clientId,
      tokenHash: auth.tokenHash,
      fingerprint,
      toolName: 'restore_revision',
      result: { rev: current.rev + 1, wid: 'pending', updatedAt: now, revisionId: 'pending', summary },
      summary,
      eventId: crypto.randomUUID(),
      restoreRevisionId: args.revisionId as string,
    },
  });
  if (written.ok === false && 'conflict' in written) {
    const raced = await readOperation();
    if (raced?.fingerprint === fingerprint) return { ...(JSON.parse(raced.resultJson) as Record<string, unknown>), replayed: true };
    return { error: 'conflict', rev: written.conflict.rev, wid: written.conflict.wid };
  }
  if (!written.ok) return { error: written.error };
  const saved = await readOperation();
  return saved ? { ...(JSON.parse(saved.resultJson) as Record<string, unknown>), replayed: written.replayed }
    : { rev: written.rev, wid: written.wid, updatedAt: now, revisionId: written.wid, summary, replayed: written.replayed };
};

const readBody = async (request: Request) => {
  const text = await readSmallText(request, MAX_DOCUMENT_BYTES);
  if (!text.ok) throw new Error(text.reason === 'too-large' ? 'too_large' : 'invalid_json');
  return JSON.parse(text.value);
};

const validateArguments = (name: string, args: Record<string, unknown>) => {
  const definition = tools.find(tool => tool.name === name);
  if (!definition) throw new Error('La herramienta solicitada no está disponible.');
  const schema = definition.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const allowed = Object.keys(schema.properties ?? {});
  if (!ownKeys(args, allowed) || (schema.required ?? []).some(key => !(key in args))) throw new Error('Los argumentos de la herramienta no son válidos.');
};

export const onRadianMcpPost = async (context: SyncContext): Promise<Response> => {
  const limited = await rateLimitMcp(context, 'radian');
  if (limited) return limited;
  let body: unknown;
  try { body = await readBody(context.request); }
  catch (caught) { return error(null, caught instanceof Error && caught.message === 'too_large' ? -32600 : -32700, 'La solicitud MCP no es válida.', { status: caught instanceof Error && caught.message === 'too_large' ? 413 : 400 }); }
  if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return error(null, -32600, 'La solicitud MCP no es válida.');
  if (!Object.hasOwn(body, 'id') && body.method.startsWith('notifications/')) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (!Object.hasOwn(body, 'id')) return error(null, -32600, 'La solicitud MCP no es válida.');
  const id = body.id;
  const params = isObject(body.params) ? body.params : {};
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  const auth = await authenticateMcpRequest(context);
  if (auth instanceof Response) return auth;
  if (body.method === 'initialize') {
    const requested = isObject(params) && typeof params.protocolVersion === 'string' && PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
    return result(id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: 'radian-training', version: '1.0.0' }, instructions: 'Servidor MCP Radian. Las herramientas solo acceden a la cuenta autenticada y respetan los scopes OAuth.' }, requested);
  }
  if (body.method === 'ping') return result(id, {});
  if (body.method !== 'tools/list' && body.method !== 'tools/call') return error(id, -32601, 'Método MCP no disponible.');
  if (body.method === 'tools/list') return result(id, { tools: hasMcpScope(auth.scope, MCP_WRITE_SCOPE) ? tools : tools.filter(tool => !writeNames.has(tool.name)) });
  if (typeof params.name !== 'string' || (params.arguments !== undefined && !isObject(params.arguments))) return error(id, -32602, 'La herramienta solicitada no está disponible.');
  const name = params.name;
  const args = isObject(params.arguments) ? params.arguments : {};
  try { validateArguments(name, args); }
  catch (caught) { return error(id, -32602, caught instanceof Error ? caught.message : 'Los argumentos no son válidos.'); }
  if (readNames.has(name)) {
    try { return toolResult(id, await readTool(auth, name, args)); }
    catch { return error(id, -32000, 'No se pudo completar la consulta.'); }
  }
  if (writeNames.has(name)) {
    try {
      const value = name === 'apply_change' ? await applyPreview(auth, args)
      : name.startsWith('preview_') ? await previewChange(auth, name, args)
          : name === 'restore_revision' ? await restoreRevision(auth, args)
          : await writeTool(auth, name, args);
      if (isObject(value) && 'error' in value && typeof value.error === 'string') return toolError(id, value.error, value);
      return toolResult(id, value);
    } catch (caught) { return error(id, -32602, caught instanceof Error ? caught.message : 'La mutación no es válida.'); }
  }
  return error(id, -32602, 'La herramienta solicitada no está disponible.');
};

export const onRadianMcpGet = async (context: SyncContext): Promise<Response> => {
  const limited = await rateLimitMcp(context, 'radian-get');
  if (limited) return limited;
  const auth = await authenticateMcpRequest(context);
  if (auth instanceof Response) return auth;
  return mcpJson({ error: 'method_not_allowed', message: 'Usa POST para enviar mensajes MCP.' }, 405, { Allow: 'POST, OPTIONS' });
};

export const onRadianMcpOptions = (): Response => mcpOptions();
