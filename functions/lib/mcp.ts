import { dateKey, weekKey } from '../../src/lib/date';
import { progressionAction, recommendationFor } from '../../src/lib/recommendations';
import { isWorkSet } from '../../src/lib/progression';
import { buildWeeklySummary, weeklySummaryText } from '../../src/lib/weeklySummary';
import type { AppData, ExerciseSession, ProgressEntry, WorkoutSession } from '../../src/types';
import type { D1DatabaseLike } from '../types';

const PERIODS = ['this_week', 'last_week', 'last_7_days', 'this_month', 'all_time'] as const;
type Period = typeof PERIODS[number];

interface UserDataRow { payload: string; updatedAt: string }

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const loadMcpUserData = async (database: D1DatabaseLike, userId: string): Promise<AppData | null> => {
  const row = await database.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?').bind(userId).first<UserDataRow>();
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (!isRecord(parsed) || !isRecord(parsed.profile) || !isRecord(parsed.plan) || !Array.isArray(parsed.sessions)) throw new Error('invalid');
    return parsed as unknown as AppData;
  } catch {
    throw new Error('Los datos de Radian guardados en la nube no se pueden leer.');
  }
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

export const handleMcpTool = async (name: string, args: Record<string, unknown>, data: AppData | null): Promise<Record<string, unknown>> => {
  if (!data) return { message: 'Tu cuenta está conectada, pero todavía no hay una copia de Radian subida a D1.' };
  if (name === 'get_profile') return profileResult(data);
  if (name === 'get_weekly_coach') {
    const summary = buildWeeklySummary(data);
    return { ...summary, text: weeklySummaryText(data) };
  }
  if (name === 'get_recommendations') return { recommendations: recommendationsResult(data) };
  if (name === 'list_workouts') {
    const range = rangeFor(args);
    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit debe ser un entero entre 1 y 50.');
    const workouts = sortedSessions(data).filter((session) => inRange(session.dateKey, range)).slice(0, limit).map((session) => sessionResult(data, session));
    return { ...range, returned: workouts.length, workouts };
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
    return { query: args.exercise, ...range, returned: matches.length, matches };
  }
  if (name === 'get_bodyweight') {
    const range = rangeFor(args);
    const entries = [...data.progress].filter((entry) => inRange(entry.date, range)).sort((a, b) => a.date.localeCompare(b.date));
    const allEntries = [...data.progress].sort((a, b) => a.date.localeCompare(b.date));
    const latest = [...allEntries].reverse().find((entry) => entry.weightKg !== undefined);
    return { ...range, currentProfileWeightKg: data.profile.currentWeightKg, latestWeightKg: latest?.weightKg, latestDate: latest?.date, entries: entries.map((entry: ProgressEntry) => ({ id: entry.id, date: entry.date, weightKg: entry.weightKg, waistCm: entry.waistCm, chestCm: entry.chestCm, armCm: entry.armCm, hipCm: entry.hipCm })) };
  }
  throw new Error(`Herramienta no reconocida: ${name}.`);
};
