import { dateKey, weekKey } from '../../src/lib/date';
import { progressionAction, recommendationFor } from '../../src/lib/recommendations';
import { isWorkSet } from '../../src/lib/progression';
import { summarizeSession } from '../../src/lib/sessionSummary';
import { buildWeeklySummary, weeklySummaryText } from '../../src/lib/weeklySummary';
import type { AppData, ExerciseSession, ProgressEntry, WorkoutSession } from '../../src/types';
import { MCP_WRITE_SCOPE } from './mcpAuth';
import { validateMcpAppData, validateMcpWriteOperation } from './mcpWrite';
import type { D1DatabaseLike, McpLoadedUserData, McpMutationResult, McpWorkoutValidationContext, McpWriteOperation } from '../types';

const PERIODS = ['this_week', 'last_week', 'last_7_days', 'this_month', 'all_time'] as const;
type Period = typeof PERIODS[number];

interface UserDataRow { payload: string; updatedAt: string }
interface McpConflictResult { error: 'conflict'; message: string; updatedAt: string | null; data: AppData | null }
interface McpNeedsVersionResult { error: 'needs_version'; message: string; updatedAt: string | null; data: AppData | null }

export type McpWriteResult = McpMutationResult | McpConflictResult | McpNeedsVersionResult;

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'get_profile',
    title: 'Leer contexto de entrenamiento',
    description: 'Lee el objetivo, gimnasio, días, duración, nivel y medidas actuales del usuario autenticado.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_weekly_coach',
    title: 'Revisar la semana',
    description: 'Resume adherencia, sensaciones, volumen, medidas y recomendaciones concretas para la próxima semana.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_workouts',
    title: 'Listar entrenamientos',
    description: 'Devuelve entrenamientos completados con fecha, sesión, ejercicios, volumen y dificultad.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'exercise_history',
    title: 'Consultar historial de ejercicio',
    description: 'Busca un ejercicio por nombre o alias y devuelve sus registros serie a serie.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', minLength: 1 },
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['exercise'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bodyweight',
    title: 'Consultar peso y medidas',
    description: 'Devuelve medidas corporales registradas y el peso actual del perfil.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_recommendations',
    title: 'Consultar próxima progresión',
    description: 'Devuelve las acciones sugeridas para los ejercicios activos según el historial del usuario.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const MCP_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'update_profile',
    title: 'Actualizar perfil',
    description: 'Actualiza solo los campos permitidos del perfil usando una versión base obligatoria.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        profile: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'profile'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_routine',
    title: 'Reemplazar rutina',
    description: 'Sustituye el plan completo y su catálogo explícito de ejercicios con control optimista de versión.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        plan: { type: 'object' },
        exercises: { type: 'array' },
      },
      required: ['baseUpdatedAt', 'plan', 'exercises'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_workout',
    title: 'Registrar entrenamiento',
    description: 'Crea una sesión completada nueva validada contra el plan y catálogo autenticados, con ID generado por el servidor.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        workout: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'workout'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_measurement',
    title: 'Añadir medición',
    description: 'Añade una entrada de progreso sin tocar el resto de la cuenta y exige versión base.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        entry: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'entry'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_checkin',
    title: 'Añadir check-in semanal',
    description: 'Hace upsert semanal por weekKey con una única escritura condicional y sin duplicados.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        checkin: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'checkin'],
      additionalProperties: false,
    },
  },
] as const;

const withVersion = (value: Record<string, unknown>, updatedAt?: string): Record<string, unknown> => updatedAt ? { ...value, updatedAt } : value;

const normalizeLoadedData = (loaded: AppData | null | McpLoadedUserData): McpLoadedUserData => {
  if (!loaded) return { data: null };
  return 'data' in loaded ? loaded : { data: loaded };
};

export const loadMcpUserData = async (database: D1DatabaseLike, userId: string): Promise<McpLoadedUserData> => {
  const row = await database.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?').bind(userId).first<UserDataRow>();
  if (!row) return { data: null };
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return { data: validateMcpAppData(parsed), updatedAt: row.updatedAt };
  } catch {
    throw new Error('Los datos de Radian guardados en la nube no se pueden leer.');
  }
};

const conflictResult = (loaded: McpLoadedUserData): McpConflictResult => ({
  error: 'conflict',
  message: loaded.data
    ? 'Hay una copia más reciente en otro dispositivo.'
    : 'La copia autenticada ya no está disponible en D1.',
  updatedAt: loaded.updatedAt ?? null,
  data: loaded.data ?? null,
});

const needsVersionResult = (loaded: McpLoadedUserData): McpNeedsVersionResult => ({
  error: 'needs_version',
  message: 'Esta mutación requiere baseUpdatedAt de la fila autenticada actual.',
  updatedAt: loaded.updatedAt ?? null,
  data: loaded.data ?? null,
});

const oauthOwnershipConflictResult = (): McpConflictResult => ({
  error: 'conflict',
  message: 'El cliente OAuth no tiene una vinculación activa de escritura para este usuario.',
  updatedAt: null,
  data: null,
});

const hasActiveWriteOwnership = async (database: D1DatabaseLike, userId: string, clientId: string): Promise<boolean> => {
  const row = await database.prepare(
    `SELECT 1 AS authorized
       FROM mcp_tokens
      WHERE user_id = ?
        AND client_id = ?
        AND token_type = 'access'
        AND expires_at > ?
        AND revoked_at IS NULL
        AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
      LIMIT 1`,
  ).bind(userId, clientId, new Date().toISOString(), MCP_WRITE_SCOPE).first<{ authorized: number }>();
  return row?.authorized === 1;
};

const workoutValidationContext = (data: AppData): McpWorkoutValidationContext => ({
  exercises: data.exercises.map((exercise) => ({ id: exercise.id })),
  plan: { days: data.plan.days.map((day) => ({ id: day.id })) },
});

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const changedProfileFields = (current: AppData, patch: Record<string, unknown>, next: AppData): string[] => Object.keys(patch).filter((key) => {
  const typedKey = key as keyof AppData['profile'];
  return !sameValue(current.profile[typedKey], next.profile[typedKey]);
});

const applyMutation = (current: AppData, operation: McpWriteOperation): { next: AppData; summary: Record<string, unknown> } => {
  if (operation.kind === 'update_profile') {
    const next = {
      ...structuredClone(current),
      profile: {
        ...structuredClone(current.profile),
        ...operation.profile,
      },
    };
    return {
      next,
      summary: {
        kind: 'update_profile',
        changedFields: changedProfileFields(current, operation.profile, next),
      },
    };
  }

  if (operation.kind === 'replace_routine') {
    const next = {
      ...structuredClone(current),
      plan: structuredClone(operation.plan),
      exercises: structuredClone(operation.exercises),
    };
    return {
      next,
      summary: {
        kind: 'replace_routine',
        planId: operation.plan.id,
        planVersion: operation.plan.version,
        dayCount: operation.plan.days.length,
        exerciseCount: operation.exercises.length,
      },
    };
  }

  if (operation.kind === 'record_workout') {
    if (operation.workout.status !== 'completed') throw new Error('record_workout solo admite sesiones completadas nuevas.');
    if (!operation.workout.completedAt) throw new Error('record_workout requiere completedAt para una sesión completada.');
    const serverWorkout = {
      ...structuredClone(operation.workout),
      id: `mcp-session-${globalThis.crypto.randomUUID()}`,
      status: 'completed' as const,
    };
    const next = {
      ...structuredClone(current),
      sessions: [...structuredClone(current.sessions), serverWorkout],
    };
    const summary = summarizeSession(serverWorkout, next.sessions);
    return {
      next,
      summary: {
        kind: 'record_workout',
        workoutId: serverWorkout.id,
        workoutDayId: serverWorkout.workoutDayId,
        dateKey: serverWorkout.dateKey,
        completedExercises: summary.completedExercises,
        totalExercises: summary.totalExercises,
        volumeKg: summary.volumeKg,
      },
    };
  }

  if (operation.kind === 'add_measurement') {
    const next = {
      ...structuredClone(current),
      progress: [...structuredClone(current.progress), structuredClone(operation.entry)],
    };
    return {
      next,
      summary: {
        kind: 'add_measurement',
        entryId: operation.entry.id,
        date: operation.entry.date,
      },
    };
  }

  if (operation.kind === 'add_checkin') {
    const matches = current.checkins.filter((entry) => entry.weekKey === operation.checkin.weekKey);
    if (matches.length > 1) throw new Error(`Ya existe más de un check-in para weekKey ${operation.checkin.weekKey}.`);
    const nextCheckins = structuredClone(current.checkins).filter((entry) => entry.weekKey !== operation.checkin.weekKey);
    nextCheckins.push(structuredClone(operation.checkin));
    const next = {
      ...structuredClone(current),
      checkins: nextCheckins,
    };
    return {
      next,
      summary: {
        kind: 'add_checkin',
        checkinId: operation.checkin.id,
        weekKey: operation.checkin.weekKey,
        replacedExisting: matches.length === 1,
      },
    };
  }

  throw new Error(`La mutación ${operation.kind} todavía no está habilitada.`);
};

export const writeMcpData = async (
  database: D1DatabaseLike,
  userId: string,
  clientId: string,
  baseUpdatedAt: string | undefined,
  operation: McpWriteOperation,
): Promise<McpWriteResult> => {
  if (!await hasActiveWriteOwnership(database, userId, clientId)) return oauthOwnershipConflictResult();
  const current = await loadMcpUserData(database, userId);
  if (!baseUpdatedAt) return needsVersionResult(current);
  if (!current.data || !current.updatedAt) return conflictResult(current);
  if (current.updatedAt !== baseUpdatedAt) return conflictResult(current);

  const validatedOperation = validateMcpWriteOperation(
    operation,
    operation.kind === 'record_workout' ? workoutValidationContext(current.data) : undefined,
  );
  const { next, summary } = applyMutation(current.data, validatedOperation);
  validateMcpAppData(next);

  const updatedAt = new Date().toISOString();
  const result = await database.prepare(
    `UPDATE user_data
     SET payload = ?, updated_at = ?
     WHERE user_id = ? AND updated_at = ?
       AND EXISTS (
         SELECT 1
           FROM mcp_tokens
          WHERE user_id = ?
            AND client_id = ?
            AND token_type = 'access'
            AND expires_at > ?
            AND revoked_at IS NULL
            AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
       )`,
  ).bind(
    JSON.stringify(next),
    updatedAt,
    userId,
    baseUpdatedAt,
    userId,
    clientId,
    updatedAt,
    MCP_WRITE_SCOPE,
  ).run();

  if ((result.meta?.changes ?? 0) !== 1) {
    return conflictResult(await loadMcpUserData(database, userId));
  }

  return { updatedAt, summary };
};

const normalizeText = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const isDateKey = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00`));
const shiftDate = (value: string, days: number): string => { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return dateKey(date); };

const rangeFor = (args: Record<string, unknown>): { from?: string; to?: string } => {
  const period = args.period === undefined ? 'all_time' : args.period;
  if (typeof period !== 'string' || !PERIODS.includes(period as Period)) throw new Error('period no es válido.');
  const today = dateKey();
  const monday = weekKey();
  const defaults: Record<Period, { from?: string; to?: string }> = {
    this_week: { from: monday, to: shiftDate(monday, 6) },
    last_week: { from: shiftDate(monday, -7), to: shiftDate(monday, -1) },
    last_7_days: { from: shiftDate(today, -6), to: today },
    this_month: { from: `${today.slice(0, 7)}-01`, to: today },
    all_time: {},
  };
  const range = { ...defaults[period as Period] };
  if (args.from !== undefined) {
    if (!isDateKey(args.from)) throw new Error('from debe tener formato YYYY-MM-DD.');
    range.from = args.from;
  }
  if (args.to !== undefined) {
    if (!isDateKey(args.to)) throw new Error('to debe tener formato YYYY-MM-DD.');
    range.to = args.to;
  }
  if (range.from && range.to && range.from > range.to) throw new Error('from no puede ser posterior a to.');
  return range;
};

const inRange = (value: string, range: { from?: string; to?: string }): boolean => (!range.from || value >= range.from) && (!range.to || value <= range.to);
const sortedSessions = (data: AppData): WorkoutSession[] => data.sessions.filter((session) => session.status === 'completed').sort((a, b) => (b.completedAt ?? b.dateKey).localeCompare(a.completedAt ?? a.dateKey));
const workSets = (exercise: ExerciseSession) => exercise.setLogs.filter(isWorkSet);
const completedWorkSets = (exercise: ExerciseSession) => workSets(exercise).filter((set) => set.completed);
const volumeForExercise = (exercise: ExerciseSession): number => completedWorkSets(exercise).reduce((total, set) => total + (set.weightKg ?? 0) * (set.actualReps ?? 0), 0);
const durationSeconds = (session: WorkoutSession): number => session.startedAt && session.completedAt ? Math.max(0, Math.round((Date.parse(session.completedAt) - Date.parse(session.startedAt)) / 1000)) : 0;
const difficultyCounts = (sessions: WorkoutSession[]): Record<string, number> => sessions.flatMap((session) => session.plannedExercises).reduce<Record<string, number>>((counts, exercise) => {
  if (exercise.difficulty) counts[exercise.difficulty] = (counts[exercise.difficulty] ?? 0) + 1;
  return counts;
}, {});

const sessionResult = (data: AppData, session: WorkoutSession) => ({
  id: session.id,
  date: session.dateKey,
  workoutName: data.plan.days.find((day) => day.id === session.workoutDayId)?.name,
  durationSeconds: durationSeconds(session),
  completedExercises: session.plannedExercises.filter((exercise) => exercise.completed).length,
  totalExercises: session.plannedExercises.length,
  volumeKg: Math.round(session.plannedExercises.reduce((total, exercise) => total + volumeForExercise(exercise), 0) * 10) / 10,
  difficultyCounts: difficultyCounts([session]),
  exercises: session.plannedExercises.map((exercise) => ({
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    completed: exercise.completed,
    difficulty: exercise.difficulty,
    discomfort: exercise.discomfort,
    setLogs: workSets(exercise).map((set) => ({ setNumber: set.setNumber, targetReps: set.targetReps, actualReps: set.actualReps, weightKg: set.weightKg, completed: set.completed })),
  })),
});

const exerciseMatches = (data: AppData, exercise: ExerciseSession, query: string): boolean => {
  const definition = data.exercises.find((candidate) => candidate.id === exercise.exerciseId);
  return [exercise.name, exercise.exerciseId, ...(definition?.aliases ?? [])].some((value) => normalizeText(value).includes(query));
};

const profileResult = (data: AppData) => ({
  goal: data.profile.goal || undefined,
  gym: data.profile.gym || undefined,
  trainingDays: data.profile.trainingDays,
  sessionMinutes: data.profile.sessionMinutes,
  experienceLevel: data.profile.experienceLevel,
  currentWeightKg: data.profile.currentWeightKg,
  heightCm: data.profile.heightCm,
  nutritionContext: data.profile.nutritionContext || undefined,
});

const recommendationsResult = (data: AppData) => {
  const seen = new Set<string>();
  return data.plan.days.flatMap((day) => day.exercises)
    .filter((exercise) => exercise.active && !seen.has(exercise.exerciseId) && seen.add(exercise.exerciseId))
    .map((exercise) => {
      const action = progressionAction(exercise.exerciseId, data.sessions, exercise);
      if (action) return { exerciseId: exercise.exerciseId, name: exercise.name, tone: action.tone, title: action.title, detail: action.detail };
      const recommendation = recommendationFor(exercise.exerciseId, data.sessions);
      return recommendation ? { exerciseId: exercise.exerciseId, name: exercise.name, tone: recommendation.tone, title: recommendation.label, detail: recommendation.message } : undefined;
    })
    .filter((recommendation): recommendation is NonNullable<typeof recommendation> => Boolean(recommendation))
    .slice(0, 12);
};

export const handleMcpTool = async (name: string, args: Record<string, unknown>, loaded: AppData | null | McpLoadedUserData): Promise<Record<string, unknown>> => {
  const { data, updatedAt } = normalizeLoadedData(loaded);
  if (!data) return { message: 'Tu cuenta está conectada, pero todavía no hay una copia de Radian subida a D1.' };
  if (name === 'get_profile') return withVersion(profileResult(data), updatedAt);
  if (name === 'get_weekly_coach') {
    const summary = buildWeeklySummary(data);
    return withVersion({ ...summary, text: weeklySummaryText(data) }, updatedAt);
  }
  if (name === 'get_recommendations') return withVersion({ recommendations: recommendationsResult(data) }, updatedAt);
  if (name === 'list_workouts') {
    const range = rangeFor(args);
    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit debe ser un entero entre 1 y 50.');
    const workouts = sortedSessions(data).filter((session) => inRange(session.dateKey, range)).slice(0, limit).map((session) => sessionResult(data, session));
    return withVersion({ ...range, returned: workouts.length, workouts }, updatedAt);
  }
  if (name === 'exercise_history') {
    const query = typeof args.exercise === 'string' ? normalizeText(args.exercise) : '';
    if (!query) throw new Error('exercise es obligatorio.');
    const range = rangeFor(args);
    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit debe ser un entero entre 1 y 50.');
    const matches = sortedSessions(data).filter((session) => inRange(session.dateKey, range)).flatMap((session) => session.plannedExercises.filter((exercise) => exerciseMatches(data, exercise, query)).map((exercise) => ({
      date: session.dateKey,
      workoutId: session.id,
      ...sessionResult(data, session).exercises.find((item) => item.exerciseId === exercise.exerciseId && item.name === exercise.name),
    }))).slice(0, limit);
    return withVersion({ query: args.exercise, ...range, returned: matches.length, matches }, updatedAt);
  }
  if (name === 'get_bodyweight') {
    const range = rangeFor(args);
    const entries = [...data.progress].filter((entry) => inRange(entry.date, range)).sort((a, b) => a.date.localeCompare(b.date));
    const allEntries = [...data.progress].sort((a, b) => a.date.localeCompare(b.date));
    const latest = [...allEntries].reverse().find((entry) => entry.weightKg !== undefined);
    return withVersion({ ...range, currentProfileWeightKg: data.profile.currentWeightKg, latestWeightKg: latest?.weightKg, latestDate: latest?.date, entries: entries.map((entry: ProgressEntry) => ({ id: entry.id, date: entry.date, weightKg: entry.weightKg, waistCm: entry.waistCm, chestCm: entry.chestCm, armCm: entry.armCm, hipCm: entry.hipCm })) }, updatedAt);
  }
  throw new Error(`Herramienta no reconocida: ${name}.`);
};
