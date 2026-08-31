#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_INFO = { name: 'radian-mcp', version: '0.1.0' };
const LEGACY_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const CURRENT_PROTOCOL_VERSION = '2026-07-28';
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const SHORT_DAY_NAMES = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const DIFFICULTIES = ['easy', 'good', 'hard', 'incomplete'];
const PERIODS = ['this_week', 'last_week', 'last_7_days', 'this_month', 'all_time'];

const optionalDateSchema = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'Fecha local con formato YYYY-MM-DD.',
};

export const TOOL_DEFINITIONS = [
  {
    name: 'get_profile',
    title: 'Leer contexto del perfil',
    description: 'Lee el contexto de entrenamiento del perfil local de Radian: objetivo, gimnasio, días, duración y nivel.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_routines',
    title: 'Listar rutinas',
    description: 'Lista las rutinas guardadas en Radian y cuántos ejercicios activos tiene cada día.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_routine',
    title: 'Consultar rutina',
    description: 'Devuelve la prescripción de ejercicios, series, repeticiones, descansos y progresión. Sin argumento devuelve todos los días.',
    inputSchema: {
      type: 'object',
      properties: { day: { type: 'string', description: 'ID, nombre o día de la semana que quieres consultar.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_week_plan',
    title: 'Consultar plan semanal',
    description: 'Muestra qué rutina corresponde a cada día de una semana. Usa weekOffset=-1 para la semana pasada.',
    inputSchema: {
      type: 'object',
      properties: { weekOffset: { type: 'integer', minimum: -52, maximum: 52, default: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_workouts',
    title: 'Listar entrenamientos',
    description: 'Devuelve sesiones completadas, de la más reciente a la más antigua, con ejercicios, series, volumen y dificultad.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS, description: 'Periodo cómodo para preguntas como “esta semana” o “la semana pasada”.' },
        from: optionalDateSchema,
        to: optionalDateSchema,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_workout',
    title: 'Detalle de entrenamiento',
    description: 'Devuelve el detalle serie a serie de una sesión usando su id o su fecha. Si hay dos sesiones en una fecha, devuelve sus ids para elegir.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID de la sesión.' },
        date: optionalDateSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'exercise_history',
    title: 'Historial de ejercicio',
    description: 'Busca un ejercicio por nombre, id o alias y devuelve sus registros por sesión. Ideal para “¿qué hice de press la semana pasada?”.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', minLength: 1, description: 'Nombre o parte del nombre del ejercicio.' },
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: optionalDateSchema,
        to: optionalDateSchema,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['exercise'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bodyweight',
    title: 'Consultar peso y medidas',
    description: 'Devuelve las mediciones corporales registradas, el último peso y el peso actual del perfil, sin modificar nada.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: optionalDateSchema,
        to: optionalDateSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'estimate_1rm',
    title: 'Estimar 1RM',
    description: 'Estima el 1RM con la fórmula de Epley a partir de series completadas con peso y repeticiones. Con exercise omitido devuelve una tabla.',
    inputSchema: {
      type: 'object',
      properties: { exercise: { type: 'string', description: 'Nombre, id o alias del ejercicio. Omitir para todos.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'muscle_balance',
    title: 'Consultar balance muscular',
    description: 'Resume series de trabajo y volumen por grupo muscular en el periodo solicitado.',
    inputSchema: {
      type: 'object',
      properties: { period: { type: 'string', enum: PERIODS, default: 'this_week' } },
      additionalProperties: false,
    },
  },
];

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const normalizeText = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const dateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateKey = (value, label = 'fecha') => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} debe tener formato YYYY-MM-DD.`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day, 12);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) throw new Error(`${label} no es válida.`);
  return value;
};

const weekRange = (now = new Date(), offset = 0) => {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1 + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { from: dateKey(start), to: dateKey(end) };
};

const periodRange = (period, now = new Date()) => {
  if (!period || period === 'all_time') return {};
  if (period === 'this_week') return weekRange(now);
  if (period === 'last_week') return weekRange(now, -1);
  if (period === 'last_7_days') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    from.setDate(from.getDate() - 6);
    return { from: dateKey(from), to: dateKey(now) };
  }
  if (period === 'this_month') {
    return {
      from: dateKey(new Date(now.getFullYear(), now.getMonth(), 1, 12)),
      to: dateKey(new Date(now.getFullYear(), now.getMonth() + 1, 0, 12)),
    };
  }
  throw new Error(`Periodo no reconocido: ${period}.`);
};

const resolveRange = (args = {}, defaultPeriod = 'all_time') => {
  const period = args.period ?? defaultPeriod;
  const derived = periodRange(period);
  const from = args.from === undefined ? derived.from : parseDateKey(args.from, 'from');
  const to = args.to === undefined ? derived.to : parseDateKey(args.to, 'to');
  if (from && to && from > to) throw new Error('from no puede ser posterior a to.');
  return { from, to };
};

const inRange = (value, range) => (!range.from || value >= range.from) && (!range.to || value <= range.to);

const loadData = (dataFile) => {
  let raw;
  try {
    const stat = statSync(dataFile);
    if (!stat.isFile()) throw new Error('not_a_file');
    raw = readFileSync(dataFile, 'utf8');
  } catch {
    throw new Error(`No se pudo leer el backup local de Radian: ${dataFile}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('El backup local de Radian no contiene JSON válido.');
  }
  const data = isRecord(parsed) && parsed.app === 'radian' && isRecord(parsed.data) ? parsed.data : parsed;
  if (!isRecord(data) || !isRecord(data.profile) || !isRecord(data.plan) || !Array.isArray(data.plan.days)) {
    throw new Error('El archivo no parece un backup de Radian. Exporta los datos desde Perfil.');
  }
  return {
    profile: data.profile,
    exercises: Array.isArray(data.exercises) ? data.exercises : [],
    plan: data.plan,
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    progress: Array.isArray(data.progress) ? data.progress : [],
    checkins: Array.isArray(data.checkins) ? data.checkins : [],
  };
};

const exerciseDefinition = (data, exerciseId) => data.exercises.find((item) => isRecord(item) && item.id === exerciseId);
const muscleGroupFor = (data, exercise) => exerciseDefinition(data, exercise.exerciseId)?.muscleGroup ?? 'Sin grupo';
const workSets = (exercise) => (Array.isArray(exercise?.setLogs) ? exercise.setLogs : []).filter((set) => set?.phase !== 'warmup');
const completedWorkSets = (exercise) => workSets(exercise).filter((set) => set?.completed === true);
const setVolume = (set) => {
  const weight = finiteNumber(set?.weightKg);
  const reps = finiteNumber(set?.actualReps);
  return weight !== undefined && reps !== undefined ? weight * reps : 0;
};
const exerciseVolume = (exercise) => round(completedWorkSets(exercise).reduce((total, set) => total + setVolume(set), 0));
const sessionSortKey = (session) => session.completedAt ?? session.startedAt ?? `${session.dateKey ?? ''}T00:00:00`;
const completedSessions = (data) => data.sessions.filter((session) => isRecord(session) && session.status === 'completed');
const sortedSessions = (data) => [...completedSessions(data)].sort((a, b) => sessionSortKey(b).localeCompare(sessionSortKey(a)));

const durationSeconds = (session) => {
  if (!session.startedAt || !session.completedAt) return 0;
  const started = Date.parse(session.startedAt);
  const completed = Date.parse(session.completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, Math.round((completed - started) / 1000)) : 0;
};

const difficultyCounts = (sessions) => {
  const counts = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, 0]));
  sessions.flatMap((session) => session.plannedExercises ?? []).forEach((exercise) => {
    if (DIFFICULTIES.includes(exercise.difficulty)) counts[exercise.difficulty] += 1;
  });
  return counts;
};

const sessionExerciseSummary = (data, exercise) => {
  const work = workSets(exercise);
  const completed = completedWorkSets(exercise);
  return {
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    muscleGroup: muscleGroupFor(data, exercise),
    completed: exercise.completed === true,
    difficulty: exercise.difficulty,
    setsCompleted: completed.length,
    setsPlanned: work.length || finiteNumber(exercise.sets) || 0,
    volumeKg: exerciseVolume(exercise),
    discomfort: exercise.discomfort === true,
    discomfortNote: exercise.discomfortNote,
  };
};

const sessionSummary = (data, session) => {
  const exercises = Array.isArray(session.plannedExercises) ? session.plannedExercises : [];
  const completedSets = exercises.flatMap(completedWorkSets);
  return {
    id: session.id,
    date: session.dateKey,
    workoutDayId: session.workoutDayId,
    workoutName: data.plan.days.find((day) => day.id === session.workoutDayId)?.name,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    durationSeconds: durationSeconds(session),
    completedExercises: exercises.filter((exercise) => exercise.completed === true).length,
    totalExercises: exercises.length,
    completedWorkSets: completedSets.length,
    plannedWorkSets: exercises.reduce((total, exercise) => total + (workSets(exercise).length || finiteNumber(exercise.sets) || 0), 0),
    volumeKg: round(completedSets.reduce((total, set) => total + setVolume(set), 0)),
    difficultyCounts: difficultyCounts([session]),
    exercises: exercises.map((exercise) => sessionExerciseSummary(data, exercise)),
  };
};

const scheduledDays = (data) => {
  const templates = [...data.plan.days].sort((a, b) => (a.weekday ?? 7) - (b.weekday ?? 7));
  const selected = Array.from(new Set((Array.isArray(data.profile.trainingDays) ? data.profile.trainingDays : [])
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 7)
    .map((day) => day === 7 ? 0 : day)))
    .sort((a, b) => a - b)
    .slice(0, templates.length);
  const weekdays = selected.length ? selected : templates.map((day) => day.weekday);
  return templates.slice(0, weekdays.length).map((day, index) => ({ ...day, weekday: weekdays[index], shortLabel: SHORT_DAY_NAMES[weekdays[index]] }));
};

const routineExercise = (exercise) => ({
  id: exercise.id,
  exerciseId: exercise.exerciseId,
  name: exercise.name,
  active: exercise.active !== false,
  sets: exercise.sets,
  reps: `${exercise.repMin}-${exercise.repMax}`,
  repMin: exercise.repMin,
  repMax: exercise.repMax,
  restSeconds: exercise.restSeconds,
  warmupSets: exercise.warmupSets ?? 0,
  progressionPolicy: exercise.progressionPolicy ?? 'double',
  progressionIncrementKg: exercise.progressionIncrementKg ?? 2.5,
});

const routineDay = (day) => ({
  id: day.id,
  weekday: day.weekday,
  day: DAY_NAMES[day.weekday] ?? String(day.weekday),
  shortLabel: day.shortLabel,
  name: day.name,
  focus: day.focus,
  exercises: (day.exercises ?? []).filter((exercise) => exercise.active !== false).map(routineExercise),
});

const profileResult = (data) => ({
  goal: data.profile.goal || undefined,
  gym: data.profile.gym || undefined,
  trainingDays: Array.isArray(data.profile.trainingDays) ? data.profile.trainingDays : [],
  trainingDayNames: (Array.isArray(data.profile.trainingDays) ? data.profile.trainingDays : []).map((day) => DAY_NAMES[day] ?? String(day)),
  sessionMinutes: finiteNumber(data.profile.sessionMinutes),
  experienceLevel: data.profile.experienceLevel,
  currentWeightKg: finiteNumber(data.profile.currentWeightKg),
  heightCm: finiteNumber(data.profile.heightCm),
  nutritionContext: data.profile.nutritionContext || undefined,
});

const toolResult = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const toolError = (message) => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

const findRoutineDays = (data, query) => {
  const days = scheduledDays(data);
  if (!query) return days;
  const normalized = normalizeText(query);
  return days.filter((day) => [day.id, day.name, day.focus, DAY_NAMES[day.weekday], SHORT_DAY_NAMES[day.weekday], String(day.weekday)]
    .some((value) => normalizeText(value) === normalized || normalizeText(value).includes(normalized)));
};

const handleTool = (name, args, dataFile) => {
  let data;
  try {
    data = loadData(dataFile);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : 'No se pudo leer el backup local.');
  }

  try {
    if (name === 'get_profile') return toolResult(profileResult(data));

    if (name === 'list_routines') {
      return toolResult({
        routines: [{
          id: data.plan.id,
          version: data.plan.version,
          name: 'Rutina principal',
          days: scheduledDays(data).map((day) => ({ id: day.id, weekday: day.weekday, name: day.name, focus: day.focus, exerciseCount: day.exercises.filter((exercise) => exercise.active !== false).length })),
        }],
      });
    }

    if (name === 'get_routine') {
      const days = findRoutineDays(data, args.day);
      return toolResult({ routineId: data.plan.id, version: data.plan.version, days: days.map(routineDay) });
    }

    if (name === 'get_week_plan') {
      const offset = args.weekOffset === undefined ? 0 : args.weekOffset;
      if (!Number.isInteger(offset) || offset < -52 || offset > 52) throw new Error('weekOffset debe ser un entero entre -52 y 52.');
      const range = weekRange(new Date(), offset);
      const daysByWeekday = new Map(scheduledDays(data).map((day) => [day.weekday, day]));
      const monday = parseDateKey(range.from);
      const mondayDate = new Date(`${monday}T12:00:00`);
      const days = Array.from({ length: 7 }, (_, index) => {
        const current = new Date(mondayDate);
        current.setDate(current.getDate() + index);
        const weekday = current.getDay();
        const day = daysByWeekday.get(weekday);
        return { date: dateKey(current), weekday, day: DAY_NAMES[weekday], planned: Boolean(day), workout: day ? routineDay(day) : undefined };
      });
      return toolResult({ weekOffset: offset, from: range.from, to: range.to, days });
    }

    if (name === 'list_workouts') {
      const range = resolveRange(args);
      const limit = args.limit === undefined ? 20 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit debe ser un entero entre 1 y 100.');
      const workouts = sortedSessions(data).filter((session) => inRange(session.dateKey, range)).slice(0, limit).map((session) => sessionSummary(data, session));
      return toolResult({ from: range.from, to: range.to, returned: workouts.length, workouts });
    }

    if (name === 'get_workout') {
      if (!args.id && !args.date) throw new Error('Indica id o date para localizar el entrenamiento.');
      let matches = args.id ? data.sessions.filter((session) => session.id === args.id) : data.sessions.filter((session) => session.dateKey === parseDateKey(args.date));
      if (args.id && args.date) matches = matches.filter((session) => session.dateKey === parseDateKey(args.date));
      if (matches.length === 0) return toolError('No encontré un entrenamiento con esos datos.');
      if (matches.length > 1) return toolResult({ date: args.date, multipleSessions: true, matches: matches.map((session) => sessionSummary(data, session)), hint: 'Vuelve a llamar a get_workout con uno de estos ids.' });
      const session = matches[0];
      return toolResult({
        ...sessionSummary(data, session),
        exercises: (session.plannedExercises ?? []).map((exercise) => ({
          ...sessionExerciseSummary(data, exercise),
          setLogs: workSets(exercise).map((set) => ({ setNumber: set.setNumber, targetReps: set.targetReps, actualReps: set.actualReps, weightKg: set.weightKg, completed: set.completed === true })),
        })),
      });
    }

    if (name === 'exercise_history') {
      const query = normalizeText(args.exercise);
      if (!query) throw new Error('exercise no puede estar vacío.');
      const range = resolveRange(args);
      const limit = args.limit === undefined ? 20 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit debe ser un entero entre 1 y 100.');
      const entries = [];
      sortedSessions(data).filter((session) => inRange(session.dateKey, range)).forEach((session) => (session.plannedExercises ?? []).forEach((exercise) => {
        const definition = exerciseDefinition(data, exercise.exerciseId);
        const names = [exercise.name, exercise.exerciseId, ...(definition?.aliases ?? [])];
        if (names.some((value) => normalizeText(value).includes(query))) {
          entries.push({
            date: session.dateKey,
            workoutId: session.id,
            workoutName: data.plan.days.find((day) => day.id === session.workoutDayId)?.name,
            ...sessionExerciseSummary(data, exercise),
            sets: workSets(exercise).map((set) => ({ setNumber: set.setNumber, targetReps: set.targetReps, actualReps: set.actualReps, weightKg: set.weightKg, completed: set.completed === true })),
          });
        }
      }));
      return toolResult({ query: args.exercise, from: range.from, to: range.to, returned: Math.min(entries.length, limit), matches: entries.slice(0, limit) });
    }

    if (name === 'get_bodyweight') {
      const range = resolveRange(args);
      const entries = [...data.progress].filter((entry) => inRange(entry.date, range)).sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
      const allEntries = [...data.progress].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
      const latestWithWeight = [...allEntries].reverse().find((entry) => finiteNumber(entry.weightKg) !== undefined);
      return toolResult({
        from: range.from,
        to: range.to,
        currentProfileWeightKg: finiteNumber(data.profile.currentWeightKg),
        latestWeightKg: finiteNumber(latestWithWeight?.weightKg),
        latestDate: latestWithWeight?.date,
        entries: entries.map((entry) => ({ id: entry.id, date: entry.date, weightKg: entry.weightKg, waistCm: entry.waistCm, chestCm: entry.chestCm, armCm: entry.armCm, hipCm: entry.hipCm })),
      });
    }

    if (name === 'estimate_1rm') {
      const query = args.exercise ? normalizeText(args.exercise) : undefined;
      const best = new Map();
      sortedSessions(data).forEach((session) => (session.plannedExercises ?? []).forEach((exercise) => {
        const definition = exerciseDefinition(data, exercise.exerciseId);
        const names = [exercise.name, exercise.exerciseId, ...(definition?.aliases ?? [])];
        if (query && !names.some((value) => normalizeText(value).includes(query))) return;
        completedWorkSets(exercise).forEach((set) => {
          const weight = finiteNumber(set.weightKg);
          const reps = finiteNumber(set.actualReps);
          if (weight === undefined || reps === undefined || weight <= 0 || reps <= 0) return;
          const estimated1rmKg = round(weight * (1 + reps / 30));
          const current = best.get(exercise.exerciseId);
          if (!current || estimated1rmKg > current.estimated1rmKg) best.set(exercise.exerciseId, { exerciseId: exercise.exerciseId, name: exercise.name, muscleGroup: muscleGroupFor(data, exercise), estimated1rmKg, weightKg: weight, reps, date: session.dateKey, workoutId: session.id });
        });
      }));
      const estimates = [...best.values()].sort((a, b) => b.estimated1rmKg - a.estimated1rmKg || a.name.localeCompare(b.name));
      return toolResult({ formula: 'Epley: peso × (1 + repeticiones / 30)', exercise: args.exercise, estimates });
    }

    if (name === 'muscle_balance') {
      const range = resolveRange(args, 'this_week');
      const groups = new Map();
      sortedSessions(data).filter((session) => inRange(session.dateKey, range)).forEach((session) => (session.plannedExercises ?? []).forEach((exercise) => {
        const completed = completedWorkSets(exercise);
        if (completed.length === 0) return;
        const muscleGroup = muscleGroupFor(data, exercise);
        const current = groups.get(muscleGroup) ?? { muscleGroup, sets: 0, volumeKg: 0, exercises: new Set() };
        completed.forEach((set) => { current.sets += 1; current.volumeKg += setVolume(set); });
        current.exercises.add(exercise.name);
        groups.set(muscleGroup, current);
      }));
      const muscles = [...groups.values()].map((group) => ({ ...group, volumeKg: round(group.volumeKg), exercises: [...group.exercises].sort() })).sort((a, b) => b.sets - a.sets || b.volumeKg - a.volumeKg || a.muscleGroup.localeCompare(b.muscleGroup));
      return toolResult({ from: range.from, to: range.to, muscles });
    }

    throw new Error(`Herramienta no reconocida: ${name}.`);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : 'No se pudo completar la consulta.');
  }
};

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export const resolveDataFile = (argv = [], env = process.env, cwd = process.cwd()) => {
  const explicitIndex = argv.indexOf('--data');
  const inline = argv.find((value) => value.startsWith('--data='));
  const explicit = explicitIndex >= 0 ? argv[explicitIndex + 1] : inline?.slice('--data='.length);
  if (explicitIndex >= 0 && (!explicit || explicit.startsWith('-'))) throw new Error('Indica un archivo con --data RUTA o RADIAN_DATA_FILE.');
  const value = explicit || env.RADIAN_DATA_FILE || 'radian-backup.json';
  if (!value || value.startsWith('-')) throw new Error('Indica un archivo con --data RUTA o RADIAN_DATA_FILE.');
  return resolve(cwd, value);
};

export const handleMessage = (message, dataFile) => {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || (!hasOwn(message, 'method') && !hasOwn(message, 'result'))) return rpcError(null, -32600, 'Solicitud JSON-RPC no válida.');
  if (!hasOwn(message, 'method')) return undefined;
  const id = hasOwn(message, 'id') ? message.id : undefined;
  const method = message.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'method debe ser un texto.');
  if (id === undefined && method.startsWith('notifications/')) return undefined;

  if (method === 'initialize') {
    const requested = isRecord(message.params) && typeof message.params.protocolVersion === 'string' ? message.params.protocolVersion : undefined;
    const protocolVersion = requested === CURRENT_PROTOCOL_VERSION || LEGACY_PROTOCOL_VERSIONS.has(requested) ? requested : '2025-06-18';
    return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: 'Servidor local de solo lectura. El backup se vuelve a leer en cada consulta.' } };
  }
  if (method === 'server/discover') return { jsonrpc: '2.0', id, result: { protocolVersion: CURRENT_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
  if (method === 'tools/call') {
    if (!isRecord(message.params) || typeof message.params.name !== 'string') return rpcError(id, -32602, 'tools/call necesita params.name.');
    const tool = TOOL_DEFINITIONS.find((item) => item.name === message.params.name);
    if (!tool) return rpcError(id, -32602, `Herramienta desconocida: ${message.params.name}.`);
    const args = message.params.arguments === undefined ? {} : message.params.arguments;
    if (!isRecord(args)) return rpcError(id, -32602, 'params.arguments debe ser un objeto.');
    return { jsonrpc: '2.0', id, result: handleTool(tool.name, args, dataFile) };
  }
  return rpcError(id, -32601, `Método no soportado: ${method}.`);
};

const main = () => {
  const dataFile = resolveDataFile(process.argv.slice(2));
  process.stderr.write(`Radian MCP local activo; leyendo ${dataFile}\n`);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach((line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'JSON no válido.'))}\n`);
        return;
      }
      const response = handleMessage(message, dataFile);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
