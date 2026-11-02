import type { D1DatabaseLike, D1PreparedStatementLike } from '../../../types';

export const MAX_DOCUMENT_BYTES = 900_000;
export const MAX_FIELD_BYTES = 65_536;
export const MAX_COLLECTION_ROWS = 10_000;
export const MAX_ROUTINE_EXERCISES = 200;
export const MAX_SESSION_EXERCISES = 200;
export const MAX_SESSION_SETS = 500;

const ARRAY_FIELDS = ['routines', 'workouts', 'bodyweight', 'measurements', 'customEx', 'favEx', 'equipProfiles', 'gymCards'] as const;
const MAP_FIELDS = ['exNotes', 'exWeights'] as const;
const LOCAL_FIELDS = new Set(['active', '_rev', '_wid', '_wids']);
const GUARD = `EXISTS (
  SELECT 1 FROM gym_sync_state
   WHERE account_id = ? AND revision = ? AND write_id = ?
)`;
const MCP_ACCESS_TOKEN_GUARD = `EXISTS (
  SELECT 1 FROM mcp_tokens t JOIN users u ON u.id = t.user_id
   WHERE t.token_hash = ? AND t.user_id = ? AND t.client_id = ? AND t.token_type = 'access'
     AND t.revoked_at IS NULL AND t.expires_at > ? AND u.disabled = 0
)`;

type JsonObject = Record<string, unknown>;
type CollectionKey = typeof ARRAY_FIELDS[number] | typeof MAP_FIELDS[number];

interface RevisionRow { revision: number; writeId: string | null; updatedAt: string | null; source: 'pwa' | 'mcp' }
interface ReceiptRow { fingerprint: string; revision: number; writeId: string }
interface FieldRow { fieldKey: string; valueJson: string }
interface PresenceRow { collectionKey: string; present: number }
interface RoutineRow { routineId: string; position: number; detailsJson: string }
interface RoutineExerciseRow { routineId: string; position: number; prescriptionJson: string }
interface SessionRow { sessionId: string; position: number; detailsJson: string }
interface SessionExerciseRow { sessionId: string; exercisePosition: number; detailsJson: string }
interface SessionSetRow { sessionId: string; exercisePosition: number; setPosition: number; detailsJson: string }
interface JsonEntityRow { position: number; detailsJson: string }
interface BodyweightRow extends JsonEntityRow { entryId: string }
interface MeasurementRow extends JsonEntityRow { entryId: string }
interface ProfileRow { unit: string | null; language: string | null; theme: string | null }
interface Tombstone { entityType: string; entityId: string }

export interface GymStateSnapshot {
  state: JsonObject | null;
  rev: number;
  wid: string | null;
  updatedAt: string | null;
  source: 'pwa' | 'mcp';
}

export interface WriteGymStateOptions {
  state: unknown;
  baseRev?: number | null;
  baseWid?: string | null;
  replaceDocument?: boolean;
  mcp?: {
    operationId: string;
    clientId: string;
    fingerprint: string;
    toolName: string;
    result: Record<string, unknown>;
    summary: Record<string, unknown>;
    eventId: string;
    tokenHash?: string;
    pendingChangeId?: string;
    restoreRevisionId?: string;
  };
}

export type WriteGymStateResult =
  | { ok: true; rev: number; wid: string; replayed: boolean }
  | { ok: false; error: string }
  | { ok: false; conflict: GymStateSnapshot };

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const omit = (value: JsonObject, keys: string[]): JsonObject => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const bytesOf = (value: string): number => new TextEncoder().encode(value).byteLength;
const parseJson = <T>(value: string): T => {
  try { return JSON.parse(value) as T; } catch { throw new Error('invalid_stored_state'); }
};

const jsonValue = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('invalid_json_value');
  if (bytesOf(result) > MAX_FIELD_BYTES) throw new Error('field_too_large');
  return result;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

const sha256 = async (value: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (part) => part.toString(16).padStart(2, '0')).join('');
};

const asText = (value: unknown): string | null => typeof value === 'string' ? value : null;
const asNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const asId = (value: unknown, fallback: string): string => typeof value === 'string' && value.length > 0 ? value : fallback;
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value);
const isCollectionKey = (value: string): value is CollectionKey => ([...ARRAY_FIELDS, ...MAP_FIELDS] as string[]).includes(value);

const jsonArray = (value: unknown[]): string => JSON.stringify(value);

const readRevision = (database: D1DatabaseLike, accountId: string): Promise<RevisionRow | null> => database.prepare(
  'SELECT revision, write_id AS writeId, updated_at AS updatedAt, revision_source AS source FROM gym_sync_state WHERE account_id = ?',
).bind(accountId).first<RevisionRow>();

export const readGymRevision = async (database: D1DatabaseLike, accountId: string): Promise<{ rev: number; wid: string | null }> => {
  const row = await readRevision(database, accountId);
  return { rev: row?.revision ?? 0, wid: row?.writeId ?? null };
};

const readEntityState = async (database: D1DatabaseLike, accountId: string): Promise<JsonObject> => {
  const [profile, fields, settings, presence, routines, routineExercises, sessions, sessionExercises, sessionSets,
    customExercises, bodyweight, measurements, favourites, equipmentProfiles, gymCards, exerciseNotes, exerciseWeights] = await Promise.all([
    database.prepare('SELECT unit, language, theme FROM gym_profile WHERE account_id = ?').bind(accountId).first<ProfileRow>(),
    database.prepare('SELECT field_key AS fieldKey, value_json AS valueJson FROM gym_state_fields WHERE account_id = ?').bind(accountId).all<FieldRow>(),
    database.prepare('SELECT setting_key AS fieldKey, value_json AS valueJson FROM gym_settings WHERE account_id = ?').bind(accountId).all<FieldRow>(),
    database.prepare('SELECT collection_key AS collectionKey, present FROM gym_state_collection_presence WHERE account_id = ?').bind(accountId).all<PresenceRow>(),
    database.prepare('SELECT routine_id AS routineId, position, details_json AS detailsJson FROM gym_routines WHERE account_id = ? ORDER BY position, routine_id').bind(accountId).all<RoutineRow>(),
    database.prepare('SELECT routine_id AS routineId, position, prescription_json AS prescriptionJson FROM gym_routine_exercises WHERE account_id = ? ORDER BY routine_id, position').bind(accountId).all<RoutineExerciseRow>(),
    database.prepare('SELECT session_id AS sessionId, position, details_json AS detailsJson FROM gym_sessions WHERE account_id = ? ORDER BY position, session_id').bind(accountId).all<SessionRow>(),
    database.prepare('SELECT session_id AS sessionId, exercise_position AS exercisePosition, details_json AS detailsJson FROM gym_session_exercises WHERE account_id = ? ORDER BY session_id, exercise_position').bind(accountId).all<SessionExerciseRow>(),
    database.prepare('SELECT session_id AS sessionId, exercise_position AS exercisePosition, set_position AS setPosition, details_json AS detailsJson FROM gym_session_sets WHERE account_id = ? ORDER BY session_id, exercise_position, set_position').bind(accountId).all<SessionSetRow>(),
    database.prepare('SELECT position, details_json AS detailsJson FROM gym_custom_exercises WHERE account_id = ? ORDER BY position, exercise_id').bind(accountId).all<JsonEntityRow>(),
    database.prepare('SELECT entry_id AS entryId, position, details_json AS detailsJson FROM gym_bodyweight WHERE account_id = ? ORDER BY position, entry_id').bind(accountId).all<BodyweightRow>(),
    database.prepare('SELECT entry_id AS entryId, position, values_json AS detailsJson FROM gym_body_measurements WHERE account_id = ? ORDER BY position, entry_id').bind(accountId).all<MeasurementRow>(),
    database.prepare('SELECT exercise_id AS id FROM gym_favourites WHERE account_id = ? ORDER BY position, exercise_id').bind(accountId).all<{ id: string }>(),
    database.prepare('SELECT position, details_json AS detailsJson FROM gym_equipment_profiles WHERE account_id = ? ORDER BY position, profile_id').bind(accountId).all<JsonEntityRow>(),
    database.prepare('SELECT position, details_json AS detailsJson FROM gym_cards WHERE account_id = ? ORDER BY position, card_id').bind(accountId).all<JsonEntityRow>(),
    database.prepare('SELECT exercise_id AS id, note FROM gym_exercise_notes WHERE account_id = ?').bind(accountId).all<{ id: string; note: string }>(),
    database.prepare('SELECT exercise_id AS id, details_json AS detailsJson FROM gym_exercise_weights WHERE account_id = ?').bind(accountId).all<{ id: string; detailsJson: string }>(),
  ]);

  const state: JsonObject = {};
  for (const row of [...settings.results, ...fields.results]) state[row.fieldKey] = parseJson(row.valueJson);
  if (profile?.unit !== null && profile?.unit !== undefined && !own(state, 'unit')) state.unit = profile.unit;
  if (profile?.language !== null && profile?.language !== undefined && !own(state, 'lang')) state.lang = profile.language;
  if (profile?.theme !== null && profile?.theme !== undefined && !own(state, 'theme')) state.theme = profile.theme;

  const routineEx = new Map<string, unknown[]>();
  for (const row of routineExercises.results) {
    const values = routineEx.get(row.routineId) ?? [];
    values.push(parseJson(row.prescriptionJson));
    routineEx.set(row.routineId, values);
  }
  const routineRows = routines.results.map((row) => ({ ...parseJson<JsonObject>(row.detailsJson), ex: routineEx.get(row.routineId) ?? [] }));

  const setRows = new Map<string, Map<number, unknown[]>>();
  for (const row of sessionSets.results) {
    const byPosition = setRows.get(row.sessionId) ?? new Map<number, unknown[]>();
    const values = byPosition.get(row.exercisePosition) ?? [];
    values.push(parseJson(row.detailsJson));
    byPosition.set(row.exercisePosition, values);
    setRows.set(row.sessionId, byPosition);
  }
  const entries = new Map<string, unknown[]>();
  for (const row of sessionExercises.results) {
    const byPosition = setRows.get(row.sessionId);
    const value = { ...parseJson<JsonObject>(row.detailsJson), sets: byPosition?.get(row.exercisePosition) ?? [] };
    const values = entries.get(row.sessionId) ?? [];
    values.push(value);
    entries.set(row.sessionId, values);
  }
  const sessionRows = sessions.results.map((row) => ({ ...parseJson<JsonObject>(row.detailsJson), entries: entries.get(row.sessionId) ?? [] }));

  const presenceMap = new Map(presence.results.map((row) => [row.collectionKey, row.present === 1]));
  const includeCollection = (key: CollectionKey, values: unknown[]): void => {
    if (presenceMap.get(key) === true || (presenceMap.get(key) === undefined && values.length > 0)) state[key] = values;
  };
  includeCollection('routines', routineRows);
  includeCollection('workouts', sessionRows);
  includeCollection('bodyweight', bodyweight.results.map((row) => parseJson(row.detailsJson)));
  includeCollection('measurements', measurements.results.map((row) => parseJson(row.detailsJson)));
  includeCollection('customEx', customExercises.results.map((row) => parseJson(row.detailsJson)));
  includeCollection('favEx', favourites.results.map((row) => row.id));
  includeCollection('equipProfiles', equipmentProfiles.results.map((row) => parseJson(row.detailsJson)));
  includeCollection('gymCards', gymCards.results.map((row) => parseJson(row.detailsJson)));

  const notes = Object.fromEntries(exerciseNotes.results.map((row) => [row.id, row.note]));
  if (presenceMap.get('exNotes') === true || (presenceMap.get('exNotes') === undefined && exerciseNotes.results.length > 0)) state.exNotes = notes;
  const weights = Object.fromEntries(exerciseWeights.results.map((row) => [row.id, parseJson(row.detailsJson)]));
  if (presenceMap.get('exWeights') === true || (presenceMap.get('exWeights') === undefined && exerciseWeights.results.length > 0)) state.exWeights = weights;
  return state;
};

export const readGymState = async (database: D1DatabaseLike, accountId: string): Promise<GymStateSnapshot> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readRevision(database, accountId);
    const data = await readEntityState(database, accountId);
    const after = await readRevision(database, accountId);
    if (before?.revision !== after?.revision || before?.writeId !== after?.writeId || before?.source !== after?.source) continue;
    const rev = after?.revision ?? 0;
    if (rev === 0) return { state: null, rev, wid: null, updatedAt: after?.updatedAt ?? null, source: after?.source ?? 'pwa' };
    const state = { ...data, _rev: rev, ...(after?.writeId ? { _wid: after.writeId } : {}) };
    return { state, rev, wid: after?.writeId ?? null, updatedAt: after?.updatedAt ?? null, source: after?.source ?? 'pwa' };
  }
  throw new Error('snapshot_changed_during_read');
};

interface EncodedState {
  state: JsonObject;
  fields: Array<{ key: string; json: string }>;
  presence: Array<{ key: CollectionKey; present: number }>;
  routines: Array<{ id: string; position: number; name: string; dayKey: string | null; progressionJson: string | null; detailsJson: string }>;
  routineExercises: Array<{ routineId: string; exerciseId: string; position: number; prescriptionJson: string }>;
  sessions: Array<{ id: string; position: number; routineId: string | null; date: string; startedAt: number | null; completedAt: number | null; note: string | null; detailsJson: string }>;
  sessionExercises: Array<{ sessionId: string; position: number; exerciseId: string; name: string | null; note: string | null; detailsJson: string }>;
  sessionSets: Array<{ sessionId: string; exercisePosition: number; position: number; type: string | null; reps: number | null; load: number | null; duration: number | null; distance: number | null; speed: number | null; effort: number | null; rest: number | null; completed: number; detailsJson: string }>;
  bodyweight: Array<{ id: string; position: number; date: string; weight: number; unit: string | null; detailsJson: string }>;
  measurements: Array<{ id: string; position: number; date: string; detailsJson: string }>;
  customExercises: Array<{ id: string; position: number; name: string; muscle: string | null; equipment: string | null; detailsJson: string }>;
  favourites: Array<{ id: string; position: number }>;
  equipmentProfiles: Array<{ id: string; position: number; detailsJson: string }>;
  gymCards: Array<{ id: string; position: number; detailsJson: string }>;
  exerciseNotes: Array<{ id: string; note: string }>;
  exerciseWeights: Array<{ id: string; weight: number; date: string | null; detailsJson: string }>;
  fieldPaths: string[];
  activeEntities: Array<{ entityType: string; entityId: string }>;
}

const encodeState = (value: unknown): EncodedState | string => {
  if (!isObject(value)) return 'invalid_state';
  const state = omit(value, [...LOCAL_FIELDS]);
  const sourceJson = JSON.stringify(state);
  if (sourceJson === undefined || bytesOf(sourceJson) > MAX_DOCUMENT_BYTES) return 'payload_too_large';
  const fields: EncodedState['fields'] = [];
  const presence: EncodedState['presence'] = [];
  const routines: EncodedState['routines'] = [];
  const routineExercises: EncodedState['routineExercises'] = [];
  const sessions: EncodedState['sessions'] = [];
  const sessionExercises: EncodedState['sessionExercises'] = [];
  const sessionSets: EncodedState['sessionSets'] = [];
  const bodyweight: EncodedState['bodyweight'] = [];
  const measurements: EncodedState['measurements'] = [];
  const customExercises: EncodedState['customExercises'] = [];
  const favourites: EncodedState['favourites'] = [];
  const equipmentProfiles: EncodedState['equipmentProfiles'] = [];
  const gymCards: EncodedState['gymCards'] = [];
  const exerciseNotes: EncodedState['exerciseNotes'] = [];
  const exerciseWeights: EncodedState['exerciseWeights'] = [];
  const fieldPaths: string[] = [];
  const activeEntities: EncodedState['activeEntities'] = [];
  let rowCount = 0;

  for (const key of [...ARRAY_FIELDS, ...MAP_FIELDS]) {
    presence.push({ key, present: own(state, key) ? 1 : 0 });
    if (own(state, key) && (ARRAY_FIELDS.includes(key as typeof ARRAY_FIELDS[number]) ? !Array.isArray(state[key]) : !isObject(state[key]))) return 'invalid_collection';
  }

  for (const [key, item] of Object.entries(state)) {
    if (LOCAL_FIELDS.has(key) || isCollectionKey(key)) continue;
    let valueJson: string;
    try { valueJson = jsonValue(item); } catch (error) { return error instanceof Error ? error.message : 'invalid_state_field'; }
    fields.push({ key, json: valueJson });
    fieldPaths.push(`field/${key}`);
  }

  const routineList = (state.routines as unknown[] | undefined) ?? [];
  if (routineList.length > MAX_COLLECTION_ROWS) return 'too_many_routines';
  const routineIds = new Set<string>();
  for (const [position, value] of routineList.entries()) {
    if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !Array.isArray(value.ex)) return 'invalid_routine';
    if (routineIds.has(value.id)) return 'duplicate_routine_id';
    routineIds.add(value.id);
    if (value.ex.length > MAX_ROUTINE_EXERCISES) return 'too_many_routine_exercises';
    const detailsJson = jsonValue(omit(value, ['ex']));
    routines.push({ id: value.id, position, name: value.name, dayKey: asText(value.dayKey ?? value.day),
      progressionJson: value.progression === undefined ? null : jsonValue(value.progression), detailsJson });
    activeEntities.push({ entityType: 'routine', entityId: value.id });
    fieldPaths.push(`routine/${value.id}`);
    for (const [exercisePosition, exercise] of value.ex.entries()) {
      if (!isObject(exercise)) return 'invalid_routine_exercise';
      routineExercises.push({ routineId: value.id, exerciseId: asId(exercise.id, String(exercisePosition)), position: exercisePosition,
        prescriptionJson: jsonValue(exercise) });
      rowCount++;
    }
  }

  const workoutList = (state.workouts as unknown[] | undefined) ?? [];
  if (workoutList.length > MAX_COLLECTION_ROWS) return 'too_many_workouts';
  const sessionIds = new Set<string>();
  for (const [position, value] of workoutList.entries()) {
    if (!isObject(value) || !isDate(value.d) || !Array.isArray(value.entries)) return 'invalid_workout';
    if (value.entries.length > MAX_SESSION_EXERCISES) return 'too_many_session_exercises';
    const id = asId(value.id, `legacy-${position}-${value.d}-${String(value.start ?? '')}`);
    if (sessionIds.has(id)) return 'duplicate_workout_id';
    sessionIds.add(id);
    const routineId = asText(value.routineId ?? (Array.isArray(value.routineIds) ? value.routineIds[0] : null));
    sessions.push({ id, position, routineId, date: value.d.slice(0, 10), startedAt: asNumber(value.start), completedAt: asNumber(value.end),
      note: asText(value.note), detailsJson: jsonValue(omit(value, ['entries'])) });
    activeEntities.push({ entityType: 'session', entityId: id });
    fieldPaths.push(`session/${id}`);
    let setCount = 0;
    for (const [exercisePosition, entry] of value.entries.entries()) {
      if (!isObject(entry) || !Array.isArray(entry.sets)) return 'invalid_session_exercise';
      const exerciseId = asId(entry.id, String(exercisePosition));
      sessionExercises.push({ sessionId: id, position: exercisePosition, exerciseId, name: asText(entry.name), note: asText(entry.note),
        detailsJson: jsonValue(omit(entry, ['sets'])) });
      rowCount++;
      for (const [setPosition, set] of entry.sets.entries()) {
        if (!isObject(set)) return 'invalid_session_set';
        setCount++;
        sessionSets.push({ sessionId: id, exercisePosition, position: setPosition, type: asText(set.type), reps: asNumber(set.r), load: asNumber(set.w),
          duration: asNumber(set.sec), distance: asNumber(set.distance), speed: asNumber(set.speed), effort: asNumber(set.rpe ?? set.rir),
          rest: asNumber(set.rest), completed: set.done === true ? 1 : 0, detailsJson: jsonValue(set) });
      }
    }
    if (setCount > MAX_SESSION_SETS) return 'too_many_session_sets';
    rowCount += setCount;
  }

  const bodyweightList = (state.bodyweight as unknown[] | undefined) ?? [];
  if (bodyweightList.length > MAX_COLLECTION_ROWS) return 'too_many_bodyweight_entries';
  const bodyweightIds = new Set<string>();
  for (const [position, value] of bodyweightList.entries()) {
    if (!isObject(value) || !isDate(value.d) || asNumber(value.w) === null) return 'invalid_bodyweight';
    const id = `${value.d}|${String(value.t ?? '')}`;
    if (bodyweightIds.has(id)) return 'duplicate_bodyweight_entry';
    bodyweightIds.add(id);
    bodyweight.push({ id, position, date: value.d.slice(0, 10), weight: asNumber(value.w)!,
      unit: state.unit === 'kg' || state.unit === 'lb' ? state.unit : null, detailsJson: jsonValue(value) });
    activeEntities.push({ entityType: 'bodyweight', entityId: id });
    fieldPaths.push(`bodyweight/${id}`);
    rowCount++;
  }

  const measurementList = (state.measurements as unknown[] | undefined) ?? [];
  if (measurementList.length > MAX_COLLECTION_ROWS) return 'too_many_measurements';
  const measurementIds = new Set<string>();
  for (const [position, value] of measurementList.entries()) {
    if (!isObject(value) || !isDate(value.d)) return 'invalid_measurement';
    const id = asId(value.id, `${value.d}|${String(value.t ?? '')}`);
    if (measurementIds.has(id)) return 'duplicate_measurement_id';
    measurementIds.add(id);
    measurements.push({ id, position, date: value.d.slice(0, 10), detailsJson: jsonValue(value) });
    activeEntities.push({ entityType: 'measurement', entityId: id });
    fieldPaths.push(`measurement/${id}`);
    rowCount++;
  }

  const customList = (state.customEx as unknown[] | undefined) ?? [];
  if (customList.length > MAX_COLLECTION_ROWS) return 'too_many_custom_exercises';
  for (const [position, value] of customList.entries()) {
    if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string') return 'invalid_custom_exercise';
    customExercises.push({ id: value.id, position, name: value.name, muscle: asText(value.muscle ?? value.muscleGroup), equipment: asText(value.equipment), detailsJson: jsonValue(value) });
    activeEntities.push({ entityType: 'custom-exercise', entityId: value.id });
    fieldPaths.push(`custom-exercise/${value.id}`);
    rowCount++;
  }

  const favouriteList = (state.favEx as unknown[] | undefined) ?? [];
  if (favouriteList.length > MAX_COLLECTION_ROWS) return 'too_many_favourites';
  for (const [position, value] of favouriteList.entries()) {
    if (typeof value !== 'string' || !value) return 'invalid_favourite';
    favourites.push({ id: value, position });
    activeEntities.push({ entityType: 'favourite', entityId: value });
    fieldPaths.push(`favourite/${value}`);
    rowCount++;
  }

  for (const [key, target, kind] of [
    ['equipProfiles', equipmentProfiles, 'equipment-profile'],
    ['gymCards', gymCards, 'gym-card'],
  ] as const) {
    const values = (state[key] as unknown[] | undefined) ?? [];
    if (values.length > MAX_COLLECTION_ROWS) return `too_many_${key}`;
    for (const [position, value] of values.entries()) {
      if (!isObject(value) || typeof value.id !== 'string' || !value.id) return `invalid_${key}`;
      target.push({ id: value.id, position, detailsJson: jsonValue(value) });
      activeEntities.push({ entityType: kind, entityId: value.id });
      fieldPaths.push(`${kind}/${value.id}`);
      rowCount++;
    }
  }

  const noteMap = (state.exNotes as JsonObject | undefined) ?? {};
  if (Object.keys(noteMap).length > MAX_COLLECTION_ROWS) return 'too_many_exercise_notes';
  for (const [id, note] of Object.entries(noteMap)) {
    if (typeof note !== 'string') return 'invalid_exercise_note';
    exerciseNotes.push({ id, note });
    activeEntities.push({ entityType: 'exercise-note', entityId: id });
    fieldPaths.push(`exercise-note/${id}`);
    rowCount++;
  }

  const weightMap = (state.exWeights as JsonObject | undefined) ?? {};
  if (Object.keys(weightMap).length > MAX_COLLECTION_ROWS) return 'too_many_exercise_weights';
  for (const [id, weight] of Object.entries(weightMap)) {
    const value = isObject(weight) ? asNumber(weight.w) : asNumber(weight);
    if (value === null) return 'invalid_exercise_weight';
    exerciseWeights.push({ id, weight: value, date: isObject(weight) ? asText(weight.d) : null, detailsJson: jsonValue(weight) });
    activeEntities.push({ entityType: 'exercise-weight', entityId: id });
    fieldPaths.push(`exercise-weight/${id}`);
    rowCount++;
  }

  rowCount += fields.length + routines.length + sessions.length;
  if (rowCount > MAX_COLLECTION_ROWS * 2) return 'too_many_normalized_rows';
  return { state, fields, presence, routines, routineExercises, sessions, sessionExercises, sessionSets, bodyweight, measurements,
    customExercises, favourites, equipmentProfiles, gymCards, exerciseNotes, exerciseWeights, fieldPaths, activeEntities };
};

const writeStatement = (database: D1DatabaseLike, sql: string, values: unknown[], accountId: string, revision: number, writeId: string): D1PreparedStatementLike =>
  database.prepare(sql).bind(...values, accountId, revision, writeId);

const deleteRows = (database: D1DatabaseLike, table: string, accountId: string, revision: number, writeId: string): D1PreparedStatementLike =>
  writeStatement(database, `DELETE FROM ${table} WHERE account_id = ? AND ${GUARD}`, [accountId], accountId, revision, writeId);

const jsonInsert = (
  database: D1DatabaseLike,
  sql: string,
  accountId: string,
  revision: number,
  writeId: string,
  rows: unknown[],
  withRevision = true,
): D1PreparedStatementLike => writeStatement(database, sql, withRevision ? [accountId, revision, jsonArray(rows)] : [accountId, jsonArray(rows)], accountId, revision, writeId);

const entityIndex = (state: JsonObject | null, key: CollectionKey): Set<string> => {
  const values = state?.[key];
  if (!Array.isArray(values)) return new Set();
  return new Set(values.flatMap((value, index) => {
    if (key === 'favEx') return typeof value === 'string' ? [value] : [];
    if (!isObject(value)) return [];
    if (key === 'bodyweight') return [`${String(value.d ?? '')}|${String(value.t ?? '')}`];
    if (key === 'measurements') return [asId(value.id, `${String(value.d ?? '')}|${String(value.t ?? '')}`)];
    if (key === 'workouts') return [typeof value.id === 'string' ? value.id : `legacy-${index}-${String(value.d ?? '')}-${String(value.start ?? '')}`];
    return typeof value.id === 'string' ? [value.id] : [`legacy-${index}`];
  }));
};

const removedEntities = (previous: JsonObject | null, next: JsonObject): Tombstone[] => {
  const result: Tombstone[] = [];
  const mapping: Array<[CollectionKey, string]> = [
    ['routines', 'routine'], ['workouts', 'session'], ['bodyweight', 'bodyweight'], ['measurements', 'measurement'],
    ['customEx', 'custom-exercise'], ['favEx', 'favourite'], ['equipProfiles', 'equipment-profile'], ['gymCards', 'gym-card'],
  ];
  for (const [key, entityType] of mapping) {
    const oldIds = entityIndex(previous, key);
    const newIds = own(next, key) ? entityIndex(next, key) : oldIds;
    for (const id of oldIds) if (!newIds.has(id)) result.push({ entityType, entityId: id });
  }
  for (const key of ['exNotes', 'exWeights'] as const) {
    const oldMap = isObject(previous?.[key]) ? previous[key] : {};
    const newMap = isObject(next[key]) ? next[key] : own(next, key) ? {} : oldMap;
    for (const id of Object.keys(oldMap)) if (!own(newMap, id)) result.push({ entityType: key === 'exNotes' ? 'exercise-note' : 'exercise-weight', entityId: id });
  }
  return result;
};

const mergeAbsentFields = (current: JsonObject | null, incoming: JsonObject): JsonObject => {
  const next = { ...(current ?? {}), ...incoming };
  for (const key of LOCAL_FIELDS) delete next[key];
  return next;
};

export const writeGymState = async (
  database: D1DatabaseLike,
  accountId: string,
  options: WriteGymStateOptions,
): Promise<WriteGymStateResult> => {
  const incoming = encodeState(options.state);
  if (typeof incoming === 'string') return { ok: false, error: incoming };
  if (options.baseRev != null && (!Number.isSafeInteger(options.baseRev) || options.baseRev < 0)) return { ok: false, error: 'invalid_base_revision' };
  if (options.baseWid != null && (typeof options.baseWid !== 'string' || options.baseWid.length > 128)) return { ok: false, error: 'invalid_base_write_id' };
  if (options.mcp?.restoreRevisionId !== undefined
    && (typeof options.mcp.restoreRevisionId !== 'string' || !options.mcp.restoreRevisionId || options.mcp.restoreRevisionId.length > 128)) {
    return { ok: false, error: 'invalid_restore_revision' };
  }

  const requestedRev = options.baseRev ?? 0;
  const hasRequestedWid = options.baseWid !== undefined;
  const requestedWid = options.baseWid ?? null;
  const fingerprint = await sha256(stableStringify({
    baseRev: requestedRev,
    ...(hasRequestedWid ? { baseWid: requestedWid } : {}),
    state: incoming.state,
  }));
  const operationId = `doc-${fingerprint}`;
  const priorReceipt = await database.prepare(
    'SELECT fingerprint, revision, write_id AS writeId FROM gym_sync_receipts WHERE account_id = ? AND operation_id = ?',
  ).bind(accountId, operationId).first<ReceiptRow>();
  if (priorReceipt && !options.mcp) {
    if (priorReceipt.fingerprint !== fingerprint) return { ok: false, error: 'operation_id_reused' };
    return { ok: true, rev: priorReceipt.revision, wid: priorReceipt.writeId, replayed: true };
  }

  const current = await readGymState(database, accountId);
  if (current.rev !== requestedRev || (hasRequestedWid && current.wid !== requestedWid)) return { ok: false, conflict: current };
  const compareWid = hasRequestedWid ? requestedWid : current.wid;
  const encoded = options.replaceDocument ? incoming : encodeState(mergeAbsentFields(current.state, incoming.state));
  if (typeof encoded === 'string') return { ok: false, error: encoded };
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString();
  if (current.state && stableStringify(omit(current.state, [...LOCAL_FIELDS])) === stableStringify(encoded.state)) {
    if (options.mcp) {
      const tokenGuard = options.mcp.tokenHash !== undefined ? ` AND ${MCP_ACCESS_TOKEN_GUARD}` : '';
      const tokenValues = options.mcp.tokenHash !== undefined
        ? [options.mcp.tokenHash, accountId, options.mcp.clientId, now]
        : [];
      const recordGuard = `EXISTS (SELECT 1 FROM gym_sync_state WHERE account_id = ? AND revision = ? AND write_id IS ?${tokenGuard})`;
      const pendingGuard = options.mcp.pendingChangeId
        ? ` AND EXISTS (SELECT 1 FROM gym_mcp_pending_changes
           WHERE account_id = ? AND client_id = ? AND change_id = ? AND used_at IS NULL AND expires_at > ?)`
        : '';
      const pendingValues = options.mcp.pendingChangeId
        ? [accountId, options.mcp.clientId, options.mcp.pendingChangeId, now]
        : [];
      const restoreGuard = options.mcp.restoreRevisionId !== undefined
        ? ` AND EXISTS (SELECT 1 FROM gym_mcp_revisions
           WHERE account_id = ? AND revision_id = ? AND expires_at > ?)`
        : '';
      const restoreValues = options.mcp.restoreRevisionId !== undefined
        ? [accountId, options.mcp.restoreRevisionId, now]
        : [];
      const results = await database.batch([
        database.prepare(
          `INSERT OR IGNORE INTO gym_mcp_operations (account_id, operation_id, client_id, fingerprint, revision, result_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${recordGuard}${pendingGuard}${restoreGuard}`,
        ).bind(accountId, options.mcp.operationId, options.mcp.clientId, options.mcp.fingerprint, current.rev,
          JSON.stringify({ ...options.mcp.result, rev: current.rev, wid: current.wid,
            ...(options.mcp.restoreRevisionId !== undefined
              ? { ...(current.wid ? { revisionId: current.wid } : {}), updatedAt: current.updatedAt }
              : {}) }), now, accountId, current.rev, current.wid,
          ...tokenValues, ...pendingValues, ...restoreValues),
        database.prepare(
          `INSERT OR IGNORE INTO gym_mcp_audit (event_id, account_id, client_id, tool_name, action, outcome, summary_json, created_at)
           SELECT ?, ?, ?, ?, 'write', 'nochange', ?, ? WHERE ${recordGuard}${pendingGuard}${restoreGuard} AND changes() = 1`,
        ).bind(options.mcp.eventId, accountId, options.mcp.clientId, options.mcp.toolName,
          JSON.stringify(options.mcp.summary), now, accountId, current.rev, current.wid,
          ...tokenValues, ...pendingValues, ...restoreValues),
        ...(options.mcp.restoreRevisionId !== undefined ? [database.prepare(
          `UPDATE gym_mcp_revisions SET restored_at = COALESCE(restored_at, ?)
            WHERE account_id = ? AND revision_id = ? AND expires_at > ?
              AND ${recordGuard}
              AND EXISTS (SELECT 1 FROM gym_mcp_operations
                WHERE account_id = ? AND client_id = ? AND operation_id = ? AND fingerprint = ?)`
        ).bind(now, accountId, options.mcp.restoreRevisionId, now, accountId, current.rev, current.wid,
          ...tokenValues, accountId, options.mcp.clientId, options.mcp.operationId, options.mcp.fingerprint)] : []),
        ...(options.mcp.pendingChangeId ? [database.prepare(
          `UPDATE gym_mcp_pending_changes SET used_at = ?
            WHERE account_id = ? AND client_id = ? AND change_id = ? AND used_at IS NULL AND expires_at > ?
              AND ${recordGuard}${restoreGuard} AND changes() = 1`,
        ).bind(now, accountId, options.mcp.clientId, options.mcp.pendingChangeId, now,
          accountId, current.rev, current.wid, ...tokenValues, ...restoreValues)] : []),
      ]);
      const recorded = (results[0]?.meta?.changes ?? 0) === 1
        && (results[1]?.meta?.changes ?? 0) === 1
        && (!options.mcp.pendingChangeId || (results[2]?.meta?.changes ?? 0) === 1);
      if (!recorded) {
        const receipt = await database.prepare(
          'SELECT fingerprint, result_json AS resultJson FROM gym_mcp_operations WHERE account_id = ? AND client_id = ? AND operation_id = ?',
        ).bind(accountId, options.mcp.clientId, options.mcp.operationId).first<{ fingerprint: string; resultJson: string }>();
        if (receipt) {
          if (receipt.fingerprint !== options.mcp.fingerprint) return { ok: false, error: 'operation_id_reused' };
          const saved = parseJson<{ rev: number; wid: string | null }>(receipt.resultJson);
          return { ok: true, rev: saved.rev, wid: saved.wid ?? '', replayed: true };
        }
        const latest = await readGymState(database, accountId);
        if (latest.rev !== current.rev || latest.wid !== current.wid) return { ok: false, conflict: latest };
        return { ok: false, error: options.mcp.pendingChangeId ? 'change_unavailable'
          : options.mcp.restoreRevisionId !== undefined ? 'revision_unavailable' : 'write_unavailable' };
      }
    }
    return { ok: true, rev: current.rev, wid: current.wid ?? '', replayed: false };
  }

  const writeId = crypto.randomUUID();
  const revision = current.rev + 1;
  const deleted = removedEntities(current.state, encoded.state);
  const stateTimestamp = asNumber(encoded.state._ts);
  const resetAt = asNumber(encoded.state.resetAt);
  const profile = {
    unit: encoded.state.unit === undefined ? null : encoded.state.unit,
    language: encoded.state.lang === undefined ? null : encoded.state.lang,
    theme: encoded.state.theme === undefined ? null : encoded.state.theme,
  };
  if (profile.unit !== null && profile.unit !== 'kg' && profile.unit !== 'lb') return { ok: false, error: 'invalid_unit' };
  if (profile.language !== null && typeof profile.language !== 'string') return { ok: false, error: 'invalid_language' };
  if (profile.theme !== null && typeof profile.theme !== 'string') return { ok: false, error: 'invalid_theme' };

  const activeJson = jsonArray(encoded.activeEntities);
  const pendingChangeGuard = options.mcp?.pendingChangeId
    ? ` AND EXISTS (SELECT 1 FROM gym_mcp_pending_changes
       WHERE account_id = ? AND client_id = ? AND change_id = ? AND used_at IS NULL AND expires_at > ?)`
    : '';
  const restoreRevisionGuard = options.mcp?.restoreRevisionId !== undefined
    ? ` AND EXISTS (SELECT 1 FROM gym_mcp_revisions
       WHERE account_id = ? AND revision_id = ? AND expires_at > ?)`
    : '';
  const tokenGuard = options.mcp?.tokenHash !== undefined ? ` AND ${MCP_ACCESS_TOKEN_GUARD}` : '';
  const tokenValues = options.mcp?.tokenHash !== undefined
    ? [options.mcp.tokenHash, accountId, options.mcp.clientId, now]
    : [];
  const initializeState = options.mcp?.tokenHash !== undefined
    ? database.prepare(`INSERT OR IGNORE INTO gym_sync_state (account_id, revision, updated_at)
        SELECT ?, 0, ? WHERE ${MCP_ACCESS_TOKEN_GUARD}`).bind(accountId, now, ...tokenValues)
    : database.prepare('INSERT OR IGNORE INTO gym_sync_state (account_id, revision, updated_at) VALUES (?, 0, ?)').bind(accountId, now);
  const statements: D1PreparedStatementLike[] = [
    initializeState,
    database.prepare(
      `UPDATE gym_sync_state SET revision = revision + 1, write_id = ?, updated_at = ?, state_timestamp = ?, reset_at = ?, revision_source = ?
        WHERE account_id = ? AND revision = ? AND write_id IS ?${pendingChangeGuard}${restoreRevisionGuard}${tokenGuard}`,
    ).bind(writeId, now, stateTimestamp, resetAt, options.mcp ? 'mcp' : 'pwa', accountId, requestedRev, compareWid,
      ...(options.mcp?.pendingChangeId ? [accountId, options.mcp.clientId, options.mcp.pendingChangeId, now] : []),
      ...(options.mcp?.restoreRevisionId !== undefined ? [accountId, options.mcp.restoreRevisionId, now] : []),
      ...tokenValues),
  ];
  statements.push(writeStatement(database,
    `DELETE FROM gym_mcp_revisions WHERE account_id = ? AND expires_at <= ? AND revision != ? AND ${GUARD}`,
    [accountId, now, current.rev], accountId, revision, writeId));
  if (current.state) statements.push(writeStatement(database,
    `INSERT INTO gym_mcp_revisions
      (account_id, revision, revision_id, write_id, source, state_json, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${GUARD}
     ON CONFLICT(account_id, revision) DO UPDATE SET
       write_id = excluded.write_id,
       source = excluded.source,
       state_json = excluded.state_json,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    [accountId, current.rev, current.wid ?? crypto.randomUUID(), current.wid, current.source,
      JSON.stringify(omit(current.state, [...LOCAL_FIELDS])), current.updatedAt ?? now, expiresAt],
    accountId, revision, writeId));
  for (const table of [
    'gym_session_sets', 'gym_session_exercises', 'gym_routine_exercises', 'gym_custom_exercises', 'gym_sessions',
    'gym_routines', 'gym_bodyweight', 'gym_body_measurements', 'gym_favourites', 'gym_equipment_profiles', 'gym_cards',
    'gym_exercise_notes', 'gym_exercise_weights', 'gym_settings', 'gym_state_fields', 'gym_state_collection_presence', 'gym_profile',
  ]) statements.push(deleteRows(database, table, accountId, revision, writeId));

  statements.push(writeStatement(database,
    `INSERT INTO gym_profile (account_id, unit, language, theme, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE ${GUARD}`,
    [accountId, profile.unit, profile.language, profile.theme, now, now], accountId, revision, writeId));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_state_fields (account_id, field_key, value_json, updated_revision)
     SELECT ?, json_extract(item.value, '$.key'), json_extract(item.value, '$.json'), ?
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.fields));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_state_collection_presence (account_id, collection_key, present)
     SELECT ?, json_extract(item.value, '$.key'), json_extract(item.value, '$.present')
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.presence, false));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_routines (account_id, routine_id, position, name, day_key, progression_json, details_json, updated_revision)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position'), json_extract(item.value, '$.name'),
       json_extract(item.value, '$.dayKey'), json_extract(item.value, '$.progressionJson'), json_extract(item.value, '$.detailsJson'), ?
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.routines));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_routine_exercises (account_id, routine_id, exercise_id, position, prescription_json)
     SELECT ?, json_extract(item.value, '$.routineId'), json_extract(item.value, '$.exerciseId'), json_extract(item.value, '$.position'),
       json_extract(item.value, '$.prescriptionJson') FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.routineExercises, false));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_sessions (account_id, session_id, position, routine_id, session_date, started_at, completed_at, note, details_json, updated_revision)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position'), json_extract(item.value, '$.routineId'),
       json_extract(item.value, '$.date'), json_extract(item.value, '$.startedAt'), json_extract(item.value, '$.completedAt'),
       json_extract(item.value, '$.note'), json_extract(item.value, '$.detailsJson'), ?
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.sessions));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_session_exercises (account_id, session_id, exercise_position, exercise_id, name, note, details_json)
     SELECT ?, json_extract(item.value, '$.sessionId'), json_extract(item.value, '$.position'), json_extract(item.value, '$.exerciseId'),
       json_extract(item.value, '$.name'), json_extract(item.value, '$.note'), json_extract(item.value, '$.detailsJson')
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.sessionExercises, false));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_session_sets (account_id, session_id, exercise_position, set_position, set_type, reps, load, duration_seconds,
       distance, speed, effort, rest_seconds, completed, details_json)
     SELECT ?, json_extract(item.value, '$.sessionId'), json_extract(item.value, '$.exercisePosition'), json_extract(item.value, '$.position'),
       json_extract(item.value, '$.type'), json_extract(item.value, '$.reps'), json_extract(item.value, '$.load'),
       json_extract(item.value, '$.duration'), json_extract(item.value, '$.distance'), json_extract(item.value, '$.speed'),
       json_extract(item.value, '$.effort'), json_extract(item.value, '$.rest'), json_extract(item.value, '$.completed'),
       json_extract(item.value, '$.detailsJson') FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.sessionSets, false));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_bodyweight (account_id, entry_id, position, measured_on, weight, unit, details_json, updated_revision)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position'), json_extract(item.value, '$.date'),
       json_extract(item.value, '$.weight'), json_extract(item.value, '$.unit'), json_extract(item.value, '$.detailsJson'), ?
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.bodyweight));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_body_measurements (account_id, entry_id, position, measured_on, values_json, updated_revision)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position'), json_extract(item.value, '$.date'),
       json_extract(item.value, '$.detailsJson'), ? FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.measurements));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_custom_exercises (account_id, exercise_id, position, name, muscle_group, equipment, details_json, updated_revision)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position'), json_extract(item.value, '$.name'),
       json_extract(item.value, '$.muscle'), json_extract(item.value, '$.equipment'), json_extract(item.value, '$.detailsJson'), ?
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.customExercises));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_favourites (account_id, exercise_id, position)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position') FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.favourites, false));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_equipment_profiles (account_id, profile_id, position, details_json)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position'), json_extract(item.value, '$.detailsJson')
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.equipmentProfiles, false));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_cards (account_id, card_id, position, details_json)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.position'), json_extract(item.value, '$.detailsJson')
       FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.gymCards, false));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_exercise_notes (account_id, exercise_id, note, updated_revision)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.note'), ? FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.exerciseNotes));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_exercise_weights (account_id, exercise_id, weight, measured_on, details_json, updated_revision)
     SELECT ?, json_extract(item.value, '$.id'), json_extract(item.value, '$.weight'), json_extract(item.value, '$.date'),
       json_extract(item.value, '$.detailsJson'), ? FROM json_each(?) item WHERE ${GUARD}`,
    accountId, revision, writeId, encoded.exerciseWeights));
  statements.push(writeStatement(database,
    `DELETE FROM gym_sync_tombstones WHERE account_id = ? AND EXISTS (
       SELECT 1 FROM json_each(?) active
        WHERE json_extract(active.value, '$.entityType') = entity_type AND json_extract(active.value, '$.entityId') = entity_id
     ) AND ${GUARD}`,
    [accountId, activeJson], accountId, revision, writeId));
  statements.push(writeStatement(database,
    `INSERT INTO gym_sync_tombstones (account_id, entity_type, entity_id, deleted_at, delete_revision)
     SELECT ?, json_extract(item.value, '$.entityType'), json_extract(item.value, '$.entityId'), ?, ?
       FROM json_each(?) item WHERE ${GUARD}
     ON CONFLICT(account_id, entity_type, entity_id) DO UPDATE SET deleted_at = excluded.deleted_at, delete_revision = excluded.delete_revision`,
    [accountId, now, revision, jsonArray(deleted)], accountId, revision, writeId));
  statements.push(jsonInsert(database,
    `INSERT INTO gym_sync_field_revisions (account_id, field_path, revision)
     SELECT ?, item.value, ? FROM json_each(?) item WHERE ${GUARD}
     ON CONFLICT(account_id, field_path) DO UPDATE SET revision = excluded.revision`,
    accountId, revision, writeId, encoded.fieldPaths));
  statements.push(writeStatement(database,
    `INSERT INTO gym_sync_changes (account_id, revision, ordinal, operation_id, field_path, value_json, deleted, created_at)
     SELECT ?, ?, 0, ?, '$document', NULL, 0, ? WHERE ${GUARD}`,
    [accountId, revision, operationId, now], accountId, revision, writeId));
  statements.push(writeStatement(database,
    `INSERT INTO gym_sync_receipts (account_id, operation_id, fingerprint, revision, write_id, created_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE ${GUARD}`,
    [accountId, operationId, fingerprint, revision, writeId, now], accountId, revision, writeId));
  statements.push(writeStatement(database,
    `INSERT INTO gym_mcp_revisions
      (account_id, revision, revision_id, write_id, source, state_json, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}`,
    [accountId, revision, writeId, writeId, options.mcp ? 'mcp' : 'pwa', JSON.stringify(encoded.state), now, expiresAt],
    accountId, revision, writeId));
  if (options.mcp) {
    const recordGuard = 'EXISTS (SELECT 1 FROM gym_sync_state WHERE account_id = ? AND revision = ? AND write_id = ?)';
    statements.push(database.prepare(
      `INSERT INTO gym_mcp_operations (account_id, operation_id, client_id, fingerprint, revision, result_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${recordGuard}`,
    ).bind(accountId, options.mcp.operationId, options.mcp.clientId, options.mcp.fingerprint, revision,
      JSON.stringify({ ...options.mcp.result, rev: revision, wid: writeId,
        ...(options.mcp.restoreRevisionId !== undefined ? { revisionId: writeId } : {}) }), now, accountId, revision, writeId));
    statements.push(database.prepare(
      `INSERT INTO gym_mcp_audit (event_id, account_id, client_id, tool_name, action, outcome, summary_json, created_at)
       SELECT ?, ?, ?, ?, 'write', 'applied', ?, ? WHERE ${recordGuard}`,
    ).bind(options.mcp.eventId, accountId, options.mcp.clientId, options.mcp.toolName,
      JSON.stringify(options.mcp.summary), now, accountId, revision, writeId));
    if (options.mcp.restoreRevisionId !== undefined) statements.push(database.prepare(
      `UPDATE gym_mcp_revisions SET restored_at = COALESCE(restored_at, ?)
        WHERE account_id = ? AND revision_id = ? AND expires_at > ? AND ${recordGuard}
          AND EXISTS (SELECT 1 FROM gym_mcp_operations
            WHERE account_id = ? AND client_id = ? AND operation_id = ? AND fingerprint = ?)`,
    ).bind(now, accountId, options.mcp.restoreRevisionId, now, accountId, revision, writeId,
      accountId, options.mcp.clientId, options.mcp.operationId, options.mcp.fingerprint));
    if (options.mcp.pendingChangeId) statements.push(database.prepare(
      `UPDATE gym_mcp_pending_changes SET used_at = ?
        WHERE account_id = ? AND client_id = ? AND change_id = ? AND used_at IS NULL AND expires_at > ? AND ${recordGuard}`,
    ).bind(now, accountId, options.mcp.clientId, options.mcp.pendingChangeId, now, accountId, revision, writeId));
  }

  const results = await database.batch(statements);
  if ((results[1]?.meta?.changes ?? 0) === 1) return { ok: true, rev: revision, wid: writeId, replayed: false };

  const racedReceipt = await database.prepare(
    'SELECT fingerprint, revision, write_id AS writeId FROM gym_sync_receipts WHERE account_id = ? AND operation_id = ?',
  ).bind(accountId, operationId).first<ReceiptRow>();
  if (racedReceipt && !options.mcp) {
    if (racedReceipt.fingerprint !== fingerprint) return { ok: false, error: 'operation_id_reused' };
    return { ok: true, rev: racedReceipt.revision, wid: racedReceipt.writeId, replayed: true };
  }
  if (options.mcp?.restoreRevisionId !== undefined) {
    const available = await database.prepare(
      'SELECT 1 AS present FROM gym_mcp_revisions WHERE account_id = ? AND revision_id = ? AND expires_at > ?',
    ).bind(accountId, options.mcp.restoreRevisionId, now).first<{ present: number }>();
    if (!available) return { ok: false, error: 'revision_unavailable' };
  }
  return { ok: false, conflict: await readGymState(database, accountId) };
};
