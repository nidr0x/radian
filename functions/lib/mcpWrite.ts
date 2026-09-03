import { migrateData } from '../../src/lib/storage';
import type {
  AppData,
  Difficulty,
  Energy,
  ExperienceLevel,
  ExerciseEquipment,
  ProgressEntry,
  ProgressionPolicy,
  SetPhase,
  Theme,
  WeeklyCheckin,
  WorkoutSession,
} from '../../src/types';
import type {
  McpPreviewableChange,
  McpProfilePatch,
  McpWorkoutValidationContext,
  McpWriteOperation,
  McpWriteRequest,
} from '../types';

const MAX_PAYLOAD_BYTES = 900_000;
const APP_DATA_KEYS = ['schemaVersion', 'onboardingComplete', 'profile', 'exercises', 'plan', 'sessions', 'progress', 'checkins'] as const;
const PROFILE_KEYS = ['goal', 'gym', 'trainingDays', 'sessionMinutes', 'experienceLevel', 'heightCm', 'currentWeightKg', 'nutritionContext', 'largeText', 'theme'] as const;
const EXERCISE_KEYS = ['id', 'name', 'muscleGroup', 'equipment', 'aliases', 'imageUrl', 'imagePosition'] as const;
const PLAN_KEYS = ['id', 'version', 'days'] as const;
const DAY_KEYS = ['id', 'weekday', 'shortLabel', 'name', 'focus', 'exercises'] as const;
const PLANNED_EXERCISE_KEYS = ['id', 'exerciseId', 'name', 'sets', 'repMin', 'repMax', 'restSeconds', 'active', 'warmupSets', 'progressionPolicy', 'progressionIncrementKg', 'imageUrl', 'imagePosition'] as const;
const SESSION_KEYS = ['id', 'workoutDayId', 'dateKey', 'startedAt', 'completedAt', 'status', 'plannedExercises', 'activeExerciseIndex', 'readiness'] as const;
const REQUIRED_SESSION_KEYS = ['id', 'workoutDayId', 'dateKey', 'startedAt', 'completedAt', 'status', 'plannedExercises', 'activeExerciseIndex'] as const;
const EXERCISE_SESSION_KEYS = ['plannedExerciseId', 'exerciseId', 'name', 'sets', 'repMin', 'repMax', 'restSeconds', 'warmupSets', 'progressionPolicy', 'progressionIncrementKg', 'progressionStatus', 'progressionReason', 'imageUrl', 'imagePosition', 'completed', 'setLogs', 'difficulty', 'actualWeightKg', 'actualReps', 'discomfort', 'discomfortNote', 'completedAt'] as const;
const SET_LOG_KEYS = ['setNumber', 'phase', 'targetReps', 'actualReps', 'weightKg', 'completed'] as const;
const PROGRESS_KEYS = ['id', 'date', 'weightKg', 'waistCm', 'chestCm', 'armCm', 'hipCm'] as const;
const CHECKIN_KEYS = ['id', 'weekKey', 'createdAt', 'weightKg', 'waistCm', 'feeling', 'energy', 'completedWorkouts', 'note'] as const;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

const DIFFICULTIES = new Set<Difficulty>(['easy', 'good', 'hard', 'incomplete']);
const ENERGIES = new Set<Energy>(['low', 'normal', 'high']);
const EXPERIENCE_LEVELS = new Set<ExperienceLevel>(['beginner', 'intermediate', 'advanced']);
const THEMES = new Set<Theme>(['system', 'light', 'dark']);
const EQUIPMENT = new Set<ExerciseEquipment>(['machine', 'cable', 'dumbbell', 'barbell', 'bodyweight']);
const PROGRESSION_POLICIES = new Set<ProgressionPolicy>(['off', 'double', 'linear']);
const SET_PHASES = new Set<SetPhase>(['warmup', 'work']);
const OPERATION_KINDS = new Set<McpWriteOperation['kind']>([
  'update_profile',
  'replace_routine',
  'record_workout',
  'add_measurement',
  'add_checkin',
  'delete_workout',
  'delete_measurement',
  'delete_checkin',
  'replace_all_data',
  'delete_all_data',
  'preview_change',
  'apply_change',
  'list_revisions',
  'restore_revision',
]);
const PREVIEWABLE_KINDS = new Set<McpPreviewableChange['kind']>([
  'delete_workout',
  'delete_measurement',
  'delete_checkin',
  'replace_all_data',
  'delete_all_data',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const assertRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} no es válido.`);
  return value;
};

const assertAllowedKeys = (record: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contiene propiedades desconocidas: ${extras.join(', ')}.`);
};

const assertRequiredKeys = (record: Record<string, unknown>, required: readonly string[], label: string): void => {
  const missing = required.filter((key) => !(key in record));
  if (missing.length > 0) throw new Error(`${label} requiere ${missing.join(', ')}.`);
};

const assertString = (value: unknown, label: string, { allowEmpty = true, maxLength = 4000 }: { allowEmpty?: boolean; maxLength?: number } = {}): string => {
  if (typeof value !== 'string') throw new Error(`${label} debe ser texto.`);
  if (!allowEmpty && value.trim().length === 0) throw new Error(`${label} no puede estar vacío.`);
  if (value.length > maxLength) throw new Error(`${label} es demasiado largo.`);
  return value;
};

const assertBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${label} debe ser booleano.`);
  return value;
};

const assertInteger = (value: unknown, label: string, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} debe ser un entero entre ${minimum} y ${maximum}.`);
  }
  return value;
};

const assertOptionalFiniteNumber = (value: unknown, label: string, minimum: number, maximum: number): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} debe estar entre ${minimum} y ${maximum}.`);
  }
  return value;
};

const assertEnum = <T extends string>(value: unknown, allowed: Set<T>, label: string): T => {
  if (typeof value !== 'string' || !allowed.has(value as T)) throw new Error(`${label} no es válido.`);
  return value as T;
};

const assertId = (value: unknown, label: string): string => {
  const id = assertString(value, label, { allowEmpty: false, maxLength: 128 });
  if (!ID_PATTERN.test(id)) throw new Error(`${label} no es válido.`);
  return id;
};

const isValidIsoTimestamp = (value: string): boolean => ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
const isValidDateKey = (value: string): boolean => DATE_KEY_PATTERN.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));

const assertIsoTimestamp = (value: unknown, label: string): string => {
  const timestamp = assertString(value, label, { allowEmpty: false, maxLength: 32 });
  if (!isValidIsoTimestamp(timestamp)) throw new Error(`${label} debe ser una fecha ISO válida.`);
  return timestamp;
};

const assertDateKey = (value: unknown, label: string): string => {
  const date = assertString(value, label, { allowEmpty: false, maxLength: 10 });
  if (!isValidDateKey(date)) throw new Error(`${label} debe tener formato YYYY-MM-DD válido.`);
  return date;
};

const assertStringArray = (value: unknown, label: string, maxItems: number): string[] => {
  if (!Array.isArray(value)) throw new Error(`${label} debe ser una lista.`);
  if (value.length > maxItems) throw new Error(`${label} supera el máximo permitido.`);
  return value.map((item, index) => assertString(item, `${label}[${index}]`, { allowEmpty: false, maxLength: 120 }));
};

const assertPayloadSize = (value: unknown): void => {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Los datos de Radian no se pueden serializar.');
  }
  if (serialized === undefined) throw new Error('Los datos de Radian no se pueden serializar.');
  if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error('Los datos de Radian son demasiado grandes para MCP (máximo 900 KB).');
  }
};

const assertRecordArray = (value: unknown, label: string): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new Error(`${label} debe ser una lista.`);
  return value.map((item, index) => assertRecord(item, `${label}[${index}]`));
};

const prevalidateAppDataShape = (value: Record<string, unknown>): void => {
  assertRecord(value.profile, 'profile');
  const exercises = assertRecordArray(value.exercises, 'exercises');
  const plan = assertRecord(value.plan, 'plan');
  const days = assertRecordArray(plan.days, 'plan.days');
  days.forEach((day, index) => {
    const dayRecord = assertRecord(day, `plan.days[${index}]`);
    assertRecordArray(dayRecord.exercises, `plan.days[${index}].exercises`);
  });
  const sessions = assertRecordArray(value.sessions, 'sessions');
  sessions.forEach((session, index) => {
    const sessionRecord = assertRecord(session, `sessions[${index}]`);
    assertRecordArray(sessionRecord.plannedExercises, `sessions[${index}].plannedExercises`);
  });
  assertRecordArray(value.progress, 'progress');
  assertRecordArray(value.checkins, 'checkins');
  exercises.forEach((exercise, index) => {
    assertRecord(exercise, `exercises[${index}]`);
  });
};

const validateProfile = (profile: Record<string, unknown>): void => {
  assertAllowedKeys(profile, PROFILE_KEYS, 'profile');
  assertRequiredKeys(profile, PROFILE_KEYS, 'profile');
  assertString(profile.goal, 'profile.goal');
  assertString(profile.gym, 'profile.gym');
  const trainingDays = profile.trainingDays;
  if (!Array.isArray(trainingDays)) throw new Error('profile.trainingDays debe ser una lista.');
  if (trainingDays.length > 7) throw new Error('profile.trainingDays no puede tener más de 7 días.');
  trainingDays.forEach((day, index) => {
    assertInteger(day, `profile.trainingDays[${index}]`, 0, 6);
  });
  assertInteger(profile.sessionMinutes, 'profile.sessionMinutes', 15, 240);
  assertEnum(profile.experienceLevel, EXPERIENCE_LEVELS, 'profile.experienceLevel');
  assertOptionalFiniteNumber(profile.heightCm, 'profile.heightCm', 80, 250);
  assertOptionalFiniteNumber(profile.currentWeightKg, 'profile.currentWeightKg', 20, 400);
  assertString(profile.nutritionContext, 'profile.nutritionContext');
  assertBoolean(profile.largeText, 'profile.largeText');
  assertEnum(profile.theme, THEMES, 'profile.theme');
};

const validateExerciseDefinition = (exercise: Record<string, unknown>, index: number, seenIds: Set<string>): void => {
  assertAllowedKeys(exercise, EXERCISE_KEYS, `exercises[${index}]`);
  assertRequiredKeys(exercise, ['id', 'name', 'muscleGroup', 'equipment'], `exercises[${index}]`);
  const id = assertId(exercise.id, `exercises[${index}].id`);
  if (seenIds.has(id)) throw new Error(`exercises[${index}].id está duplicado.`);
  seenIds.add(id);
  assertString(exercise.name, `exercises[${index}].name`, { allowEmpty: false, maxLength: 160 });
  assertString(exercise.muscleGroup, `exercises[${index}].muscleGroup`, { allowEmpty: false, maxLength: 120 });
  assertEnum(exercise.equipment, EQUIPMENT, `exercises[${index}].equipment`);
  if (exercise.aliases !== undefined) assertStringArray(exercise.aliases, `exercises[${index}].aliases`, 20);
  if (exercise.imageUrl !== undefined) assertString(exercise.imageUrl, `exercises[${index}].imageUrl`, { allowEmpty: true, maxLength: 512 });
  if (exercise.imagePosition !== undefined) assertString(exercise.imagePosition, `exercises[${index}].imagePosition`, { allowEmpty: true, maxLength: 64 });
};

const validateSetLog = (setLog: Record<string, unknown>, label: string): void => {
  assertAllowedKeys(setLog, SET_LOG_KEYS, label);
  assertRequiredKeys(setLog, ['setNumber', 'targetReps', 'completed'], label);
  assertInteger(setLog.setNumber, `${label}.setNumber`, 1, 50);
  if (setLog.phase !== undefined) assertEnum(setLog.phase, SET_PHASES, `${label}.phase`);
  assertInteger(setLog.targetReps, `${label}.targetReps`, 1, 100);
  assertOptionalFiniteNumber(setLog.actualReps, `${label}.actualReps`, 0, 100);
  assertOptionalFiniteNumber(setLog.weightKg, `${label}.weightKg`, 0, 1000);
  assertBoolean(setLog.completed, `${label}.completed`);
};

const validatePlannedExercise = (exercise: Record<string, unknown>, label: string, knownExerciseIds: Set<string>): void => {
  assertAllowedKeys(exercise, PLANNED_EXERCISE_KEYS, label);
  assertRequiredKeys(exercise, ['id', 'exerciseId', 'name', 'sets', 'repMin', 'repMax', 'restSeconds', 'active'], label);
  assertId(exercise.id, `${label}.id`);
  const exerciseId = assertId(exercise.exerciseId, `${label}.exerciseId`);
  if (!knownExerciseIds.has(exerciseId)) throw new Error(`${label}.exerciseId no existe en el catálogo.`);
  assertString(exercise.name, `${label}.name`, { allowEmpty: false, maxLength: 160 });
  assertInteger(exercise.sets, `${label}.sets`, 1, 12);
  const repMin = assertInteger(exercise.repMin, `${label}.repMin`, 1, 100);
  const repMax = assertInteger(exercise.repMax, `${label}.repMax`, 1, 100);
  if (repMin > repMax) throw new Error(`${label} tiene un rango de repeticiones inválido.`);
  assertInteger(exercise.restSeconds, `${label}.restSeconds`, 0, 900);
  assertBoolean(exercise.active, `${label}.active`);
  if (exercise.warmupSets !== undefined) assertInteger(exercise.warmupSets, `${label}.warmupSets`, 0, 3);
  if (exercise.progressionPolicy !== undefined) assertEnum(exercise.progressionPolicy, PROGRESSION_POLICIES, `${label}.progressionPolicy`);
  if (exercise.progressionIncrementKg !== undefined) assertOptionalFiniteNumber(exercise.progressionIncrementKg, `${label}.progressionIncrementKg`, 0.1, 100);
  if (exercise.imageUrl !== undefined) assertString(exercise.imageUrl, `${label}.imageUrl`, { allowEmpty: true, maxLength: 512 });
  if (exercise.imagePosition !== undefined) assertString(exercise.imagePosition, `${label}.imagePosition`, { allowEmpty: true, maxLength: 64 });
};

const validateExerciseSession = (exercise: Record<string, unknown>, label: string, knownExerciseIds?: Set<string>): void => {
  assertAllowedKeys(exercise, EXERCISE_SESSION_KEYS, label);
  assertRequiredKeys(exercise, ['plannedExerciseId', 'exerciseId', 'name', 'sets', 'repMin', 'repMax', 'restSeconds', 'warmupSets', 'progressionPolicy', 'progressionIncrementKg', 'completed', 'setLogs', 'discomfort'], label);
  assertId(exercise.plannedExerciseId, `${label}.plannedExerciseId`);
  const exerciseId = assertId(exercise.exerciseId, `${label}.exerciseId`);
  if (knownExerciseIds && !knownExerciseIds.has(exerciseId)) throw new Error(`${label}.exerciseId no existe en el catálogo.`);
  assertString(exercise.name, `${label}.name`, { allowEmpty: false, maxLength: 160 });
  assertInteger(exercise.sets, `${label}.sets`, 1, 12);
  const repMin = assertInteger(exercise.repMin, `${label}.repMin`, 1, 100);
  const repMax = assertInteger(exercise.repMax, `${label}.repMax`, 1, 100);
  if (repMin > repMax) throw new Error(`${label} tiene un rango de repeticiones inválido.`);
  assertInteger(exercise.restSeconds, `${label}.restSeconds`, 0, 900);
  const warmupSets = assertInteger(exercise.warmupSets, `${label}.warmupSets`, 0, 3);
  assertEnum(exercise.progressionPolicy, PROGRESSION_POLICIES, `${label}.progressionPolicy`);
  assertOptionalFiniteNumber(exercise.progressionIncrementKg, `${label}.progressionIncrementKg`, 0.1, 100);
  if (exercise.progressionStatus !== undefined) assertString(exercise.progressionStatus, `${label}.progressionStatus`, { allowEmpty: false, maxLength: 32 });
  if (exercise.progressionReason !== undefined) assertString(exercise.progressionReason, `${label}.progressionReason`, { allowEmpty: false, maxLength: 512 });
  if (exercise.imageUrl !== undefined) assertString(exercise.imageUrl, `${label}.imageUrl`, { allowEmpty: true, maxLength: 512 });
  if (exercise.imagePosition !== undefined) assertString(exercise.imagePosition, `${label}.imagePosition`, { allowEmpty: true, maxLength: 64 });
  assertBoolean(exercise.completed, `${label}.completed`);
  if (!Array.isArray(exercise.setLogs)) throw new Error(`${label}.setLogs debe ser una lista.`);
  if (exercise.setLogs.length !== (exercise.sets as number) + warmupSets) throw new Error(`${label}.setLogs no coincide con sets + warmupSets.`);
  exercise.setLogs.forEach((setLog, index) => validateSetLog(assertRecord(setLog, `${label}.setLogs[${index}]`), `${label}.setLogs[${index}]`));
  if (exercise.difficulty !== undefined) assertEnum(exercise.difficulty, DIFFICULTIES, `${label}.difficulty`);
  assertOptionalFiniteNumber(exercise.actualWeightKg, `${label}.actualWeightKg`, 0, 1000);
  assertOptionalFiniteNumber(exercise.actualReps, `${label}.actualReps`, 0, 100);
  assertBoolean(exercise.discomfort, `${label}.discomfort`);
  if (exercise.discomfortNote !== undefined) assertString(exercise.discomfortNote, `${label}.discomfortNote`, { allowEmpty: false, maxLength: 2000 });
  if (exercise.completedAt !== undefined) assertIsoTimestamp(exercise.completedAt, `${label}.completedAt`);
};

const validateWorkoutDay = (day: Record<string, unknown>, index: number, knownExerciseIds: Set<string>, seenIds: Set<string>): void => {
  assertAllowedKeys(day, DAY_KEYS, `plan.days[${index}]`);
  assertRequiredKeys(day, DAY_KEYS, `plan.days[${index}]`);
  const id = assertId(day.id, `plan.days[${index}].id`);
  if (seenIds.has(id)) throw new Error(`plan.days[${index}].id está duplicado.`);
  seenIds.add(id);
  assertInteger(day.weekday, `plan.days[${index}].weekday`, 0, 6);
  assertString(day.shortLabel, `plan.days[${index}].shortLabel`, { allowEmpty: false, maxLength: 8 });
  assertString(day.name, `plan.days[${index}].name`, { allowEmpty: false, maxLength: 160 });
  assertString(day.focus, `plan.days[${index}].focus`, { allowEmpty: false, maxLength: 160 });
  if (!Array.isArray(day.exercises)) throw new Error(`plan.days[${index}].exercises debe ser una lista.`);
  day.exercises.forEach((exercise, exerciseIndex) => {
    validatePlannedExercise(assertRecord(exercise, `plan.days[${index}].exercises[${exerciseIndex}]`), `plan.days[${index}].exercises[${exerciseIndex}]`, knownExerciseIds);
  });
};

const validateWorkoutPlan = (plan: Record<string, unknown>, knownExerciseIds: Set<string>): void => {
  assertAllowedKeys(plan, PLAN_KEYS, 'plan');
  assertRequiredKeys(plan, PLAN_KEYS, 'plan');
  assertId(plan.id, 'plan.id');
  assertInteger(plan.version, 'plan.version', 1, 1000000);
  if (!Array.isArray(plan.days) || plan.days.length === 0 || plan.days.length > 7) throw new Error('plan.days debe incluir entre 1 y 7 días.');
  const seenIds = new Set<string>();
  plan.days.forEach((day, index) => validateWorkoutDay(assertRecord(day, `plan.days[${index}]`), index, knownExerciseIds, seenIds));
};

const validateWorkoutSession = (session: Record<string, unknown>, index: number, knownDayIds: Set<string> | undefined, knownExerciseIds: Set<string> | undefined, seenIds: Set<string>): void => {
  assertAllowedKeys(session, SESSION_KEYS, `sessions[${index}]`);
  assertRequiredKeys(session, REQUIRED_SESSION_KEYS, `sessions[${index}]`);
  const id = assertId(session.id, `sessions[${index}].id`);
  if (seenIds.has(id)) throw new Error(`sessions[${index}].id está duplicado.`);
  seenIds.add(id);
  const workoutDayId = assertId(session.workoutDayId, `sessions[${index}].workoutDayId`);
  if (knownDayIds && !knownDayIds.has(workoutDayId)) throw new Error(`sessions[${index}].workoutDayId no existe en el plan.`);
  assertDateKey(session.dateKey, `sessions[${index}].dateKey`);
  assertIsoTimestamp(session.startedAt, `sessions[${index}].startedAt`);
  if (session.completedAt !== undefined) assertIsoTimestamp(session.completedAt, `sessions[${index}].completedAt`);
  if (session.status !== 'in_progress' && session.status !== 'completed') throw new Error(`sessions[${index}].status no es válido.`);
  if (!Array.isArray(session.plannedExercises)) throw new Error(`sessions[${index}].plannedExercises debe ser una lista.`);
  session.plannedExercises.forEach((exercise, exerciseIndex) => {
    validateExerciseSession(assertRecord(exercise, `sessions[${index}].plannedExercises[${exerciseIndex}]`), `sessions[${index}].plannedExercises[${exerciseIndex}]`, knownExerciseIds);
  });
  assertInteger(session.activeExerciseIndex, `sessions[${index}].activeExerciseIndex`, 0, Math.max(0, (session.plannedExercises as unknown[]).length));
  if (session.readiness !== undefined) {
    const readiness = assertRecord(session.readiness, `sessions[${index}].readiness`);
    assertAllowedKeys(readiness, ['energy', 'soreness'], `sessions[${index}].readiness`);
    assertRequiredKeys(readiness, ['energy', 'soreness'], `sessions[${index}].readiness`);
    assertEnum(readiness.energy, ENERGIES, `sessions[${index}].readiness.energy`);
    assertEnum(readiness.soreness, new Set(['none', 'some', 'high']), `sessions[${index}].readiness.soreness`);
  }
};

const validateHistoricalWorkoutSession = (session: Record<string, unknown>, index: number, seenIds: Set<string>): void => {
  validateWorkoutSession(session, index, undefined, undefined, seenIds);
};

const validateProgressEntry = (entry: Record<string, unknown>, index: number, seenIds: Set<string>): void => {
  assertAllowedKeys(entry, PROGRESS_KEYS, `progress[${index}]`);
  assertRequiredKeys(entry, ['id', 'date'], `progress[${index}]`);
  const id = assertId(entry.id, `progress[${index}].id`);
  if (seenIds.has(id)) throw new Error(`progress[${index}].id está duplicado.`);
  seenIds.add(id);
  assertDateKey(entry.date, `progress[${index}].date`);
  assertOptionalFiniteNumber(entry.weightKg, `progress[${index}].weightKg`, 20, 400);
  assertOptionalFiniteNumber(entry.waistCm, `progress[${index}].waistCm`, 20, 300);
  assertOptionalFiniteNumber(entry.chestCm, `progress[${index}].chestCm`, 20, 300);
  assertOptionalFiniteNumber(entry.armCm, `progress[${index}].armCm`, 10, 100);
  assertOptionalFiniteNumber(entry.hipCm, `progress[${index}].hipCm`, 20, 300);
};

const validateCheckin = (checkin: Record<string, unknown>, index: number, seenIds: Set<string>): void => {
  assertAllowedKeys(checkin, CHECKIN_KEYS, `checkins[${index}]`);
  assertRequiredKeys(checkin, ['id', 'weekKey', 'createdAt', 'feeling', 'energy', 'completedWorkouts'], `checkins[${index}]`);
  const id = assertId(checkin.id, `checkins[${index}].id`);
  if (seenIds.has(id)) throw new Error(`checkins[${index}].id está duplicado.`);
  seenIds.add(id);
  assertDateKey(checkin.weekKey, `checkins[${index}].weekKey`);
  assertIsoTimestamp(checkin.createdAt, `checkins[${index}].createdAt`);
  assertOptionalFiniteNumber(checkin.weightKg, `checkins[${index}].weightKg`, 20, 400);
  assertOptionalFiniteNumber(checkin.waistCm, `checkins[${index}].waistCm`, 20, 300);
  assertString(checkin.feeling, `checkins[${index}].feeling`, { allowEmpty: false, maxLength: 4000 });
  assertEnum(checkin.energy, ENERGIES, `checkins[${index}].energy`);
  assertInteger(checkin.completedWorkouts, `checkins[${index}].completedWorkouts`, 0, 7);
  if (checkin.note !== undefined) assertString(checkin.note, `checkins[${index}].note`, { allowEmpty: false, maxLength: 4000 });
};

const validateNormalizedAppData = (data: AppData, allowHistoricalSessions = false): AppData => {
  const record = assertRecord(data, 'Los datos de Radian');
  validateProfile(assertRecord(record.profile, 'profile'));

  if (!Array.isArray(record.exercises) || record.exercises.length === 0) throw new Error('exercises debe incluir al menos un ejercicio.');
  const exerciseIds = new Set<string>();
  record.exercises.forEach((exercise, index) => validateExerciseDefinition(assertRecord(exercise, `exercises[${index}]`), index, exerciseIds));

  validateWorkoutPlan(assertRecord(record.plan, 'plan'), exerciseIds);
  const dayIds = new Set(data.plan.days.map((day) => day.id));

  if (!Array.isArray(record.sessions)) throw new Error('sessions debe ser una lista.');
  const sessionIds = new Set<string>();
  record.sessions.forEach((session, index) => {
    const recordSession = assertRecord(session, `sessions[${index}]`);
    if (allowHistoricalSessions) {
      validateHistoricalWorkoutSession(recordSession, index, sessionIds);
      return;
    }
    validateWorkoutSession(recordSession, index, dayIds, exerciseIds, sessionIds);
  });

  if (!Array.isArray(record.progress)) throw new Error('progress debe ser una lista.');
  const progressIds = new Set<string>();
  record.progress.forEach((entry, index) => validateProgressEntry(assertRecord(entry, `progress[${index}]`), index, progressIds));

  if (!Array.isArray(record.checkins)) throw new Error('checkins debe ser una lista.');
  const checkinIds = new Set<string>();
  record.checkins.forEach((checkin, index) => validateCheckin(assertRecord(checkin, `checkins[${index}]`), index, checkinIds));

  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1 || data.schemaVersion > 7) {
    throw new Error('schemaVersion no es reconocible.');
  }
  if (data.schemaVersion !== 7) {
    throw new Error('Los datos normalizados deben quedar en schemaVersion 7.');
  }
  assertBoolean(record.onboardingComplete, 'onboardingComplete');
  assertPayloadSize(data);
  return data;
};

const validateMcpAppDataInternal = (value: unknown, allowHistoricalSessions: boolean): AppData => {
  assertPayloadSize(value);
  const record = assertRecord(value, 'Los datos de Radian');
  assertAllowedKeys(record, APP_DATA_KEYS, 'Los datos de Radian');
  assertRequiredKeys(record, APP_DATA_KEYS, 'Los datos de Radian');
  if (typeof record.schemaVersion !== 'number' || !Number.isInteger(record.schemaVersion) || record.schemaVersion < 1 || record.schemaVersion > 7) {
    throw new Error('schemaVersion no es reconocible.');
  }
  if (!isRecord(record.profile) || !isRecord(record.plan) || !Array.isArray(record.sessions) || !Array.isArray(record.exercises) || !Array.isArray(record.progress) || !Array.isArray(record.checkins)) {
    throw new Error('La estructura principal de los datos de Radian no es válida.');
  }
  if (typeof record.onboardingComplete !== 'boolean') throw new Error('onboardingComplete debe ser booleano.');
  prevalidateAppDataShape(record);
  let normalized: AppData;
  try {
    normalized = migrateData(value);
  } catch {
    throw new Error('Los datos de Radian no tienen una estructura válida.');
  }
  return validateNormalizedAppData(normalized, allowHistoricalSessions);
};

export const validateMcpAppData = (value: unknown): AppData => {
  return validateMcpAppDataInternal(value, false);
};

export const validateMcpAppDataWithHistoricalSessions = (value: unknown): AppData => {
  return validateMcpAppDataInternal(value, true);
};

const validateProfilePatch = (value: unknown): McpProfilePatch => {
  const profile = assertRecord(value, 'operation.profile');
  assertAllowedKeys(profile, PROFILE_KEYS, 'operation.profile');
  if (Object.keys(profile).length === 0) throw new Error('operation.profile requiere al menos un campo.');
  if ('goal' in profile) assertString(profile.goal, 'operation.profile.goal');
  if ('gym' in profile) assertString(profile.gym, 'operation.profile.gym');
  if ('trainingDays' in profile) {
    if (!Array.isArray(profile.trainingDays)) throw new Error('operation.profile.trainingDays debe ser una lista.');
    profile.trainingDays.forEach((day, index) => {
      assertInteger(day, `operation.profile.trainingDays[${index}]`, 0, 6);
    });
  }
  if ('sessionMinutes' in profile) assertInteger(profile.sessionMinutes, 'operation.profile.sessionMinutes', 15, 240);
  if ('experienceLevel' in profile) assertEnum(profile.experienceLevel, EXPERIENCE_LEVELS, 'operation.profile.experienceLevel');
  if ('heightCm' in profile) assertOptionalFiniteNumber(profile.heightCm, 'operation.profile.heightCm', 80, 250);
  if ('currentWeightKg' in profile) assertOptionalFiniteNumber(profile.currentWeightKg, 'operation.profile.currentWeightKg', 20, 400);
  if ('nutritionContext' in profile) assertString(profile.nutritionContext, 'operation.profile.nutritionContext');
  if ('largeText' in profile) assertBoolean(profile.largeText, 'operation.profile.largeText');
  if ('theme' in profile) assertEnum(profile.theme, THEMES, 'operation.profile.theme');
  return profile as McpProfilePatch;
};

const validatePreviewableChange = (value: unknown): McpPreviewableChange => {
  const change = assertRecord(value, 'operation.change');
  const kind = assertString(change.kind, 'operation.change.kind', { allowEmpty: false, maxLength: 40 }) as McpPreviewableChange['kind'];
  if (!PREVIEWABLE_KINDS.has(kind)) throw new Error('operation.change.kind no es válido.');
  if (kind === 'delete_workout') {
    assertAllowedKeys(change, ['kind', 'workoutId'], 'operation.change');
    assertId(change.workoutId, 'operation.change.workoutId');
    return { kind, workoutId: change.workoutId as string };
  }
  if (kind === 'delete_measurement') {
    assertAllowedKeys(change, ['kind', 'measurementId'], 'operation.change');
    assertId(change.measurementId, 'operation.change.measurementId');
    return { kind, measurementId: change.measurementId as string };
  }
  if (kind === 'delete_checkin') {
    assertAllowedKeys(change, ['kind', 'checkinId'], 'operation.change');
    assertId(change.checkinId, 'operation.change.checkinId');
    return { kind, checkinId: change.checkinId as string };
  }
  if (kind === 'replace_all_data') {
    assertAllowedKeys(change, ['kind', 'data'], 'operation.change');
    return { kind, data: validateMcpAppData(change.data) };
  }
  assertAllowedKeys(change, ['kind'], 'operation.change');
  return { kind };
};

const buildWorkoutValidationSets = (context?: McpWorkoutValidationContext): { knownDayIds?: Set<string>; knownExerciseIds?: Set<string> } => {
  if (!context) return {};
  const knownDayIds = context.plan?.days ? new Set(context.plan.days.map((day) => day.id)) : undefined;
  const knownExerciseIds = context.exercises ? new Set(context.exercises.map((exercise) => exercise.id)) : undefined;
  return { knownDayIds, knownExerciseIds };
};

export const validateMcpWriteOperation = (value: unknown, context?: McpWorkoutValidationContext): McpWriteOperation => {
  const operation = assertRecord(value, 'operation');
  const kind = assertString(operation.kind, 'operation.kind', { allowEmpty: false, maxLength: 40 }) as McpWriteOperation['kind'];
  if (!OPERATION_KINDS.has(kind)) throw new Error('operation.kind no es válido.');

  if (kind === 'update_profile') {
    assertAllowedKeys(operation, ['kind', 'profile'], 'operation');
    return { kind, profile: validateProfilePatch(operation.profile) };
  }
  if (kind === 'replace_routine') {
    assertAllowedKeys(operation, ['kind', 'plan', 'exercises'], 'operation');
    const exercises = operation.exercises;
    if (!Array.isArray(exercises) || exercises.length === 0) throw new Error('operation.exercises debe incluir el catálogo de ejercicios.');
    const blankData = migrateData({});
    const normalized = validateMcpAppData({
      ...blankData,
      schemaVersion: 7,
      onboardingComplete: false,
      profile: blankData.profile,
      exercises,
      plan: operation.plan,
      sessions: [],
      progress: [],
      checkins: [],
    });
    return { kind, plan: normalized.plan, exercises: normalized.exercises };
  }
  if (kind === 'record_workout') {
    assertAllowedKeys(operation, ['kind', 'workout'], 'operation');
    const workout = assertRecord(operation.workout, 'operation.workout');
    const { knownDayIds, knownExerciseIds } = buildWorkoutValidationSets(context);
    validateWorkoutSession(workout, 0, knownDayIds, knownExerciseIds, new Set());
    return { kind, workout: operation.workout as WorkoutSession };
  }
  if (kind === 'add_measurement') {
    assertAllowedKeys(operation, ['kind', 'entry'], 'operation');
    const entry = assertRecord(operation.entry, 'operation.entry');
    validateProgressEntry(entry, 0, new Set());
    return { kind, entry: operation.entry as ProgressEntry };
  }
  if (kind === 'add_checkin') {
    assertAllowedKeys(operation, ['kind', 'checkin'], 'operation');
    const checkin = assertRecord(operation.checkin, 'operation.checkin');
    validateCheckin(checkin, 0, new Set());
    return { kind, checkin: operation.checkin as WeeklyCheckin };
  }
  if (kind === 'delete_workout') {
    assertAllowedKeys(operation, ['kind', 'workoutId'], 'operation');
    return { kind, workoutId: assertId(operation.workoutId, 'operation.workoutId') };
  }
  if (kind === 'delete_measurement') {
    assertAllowedKeys(operation, ['kind', 'measurementId'], 'operation');
    return { kind, measurementId: assertId(operation.measurementId, 'operation.measurementId') };
  }
  if (kind === 'delete_checkin') {
    assertAllowedKeys(operation, ['kind', 'checkinId'], 'operation');
    return { kind, checkinId: assertId(operation.checkinId, 'operation.checkinId') };
  }
  if (kind === 'replace_all_data') {
    assertAllowedKeys(operation, ['kind', 'data'], 'operation');
    return { kind, data: validateMcpAppData(operation.data) };
  }
  if (kind === 'delete_all_data') {
    assertAllowedKeys(operation, ['kind'], 'operation');
    return { kind };
  }
  if (kind === 'preview_change') {
    assertAllowedKeys(operation, ['kind', 'change'], 'operation');
    return { kind, change: validatePreviewableChange(operation.change) };
  }
  if (kind === 'apply_change') {
    assertAllowedKeys(operation, ['kind', 'changeId', 'confirm'], 'operation');
    return { kind, changeId: assertId(operation.changeId, 'operation.changeId'), confirm: assertBoolean(operation.confirm, 'operation.confirm') };
  }
  if (kind === 'list_revisions') {
    assertAllowedKeys(operation, ['kind'], 'operation');
    return { kind };
  }
  assertAllowedKeys(operation, ['kind', 'revisionId'], 'operation');
  return { kind, revisionId: assertId(operation.revisionId, 'operation.revisionId') };
};

export const validateMcpWriteRequest = (value: unknown, context?: McpWorkoutValidationContext): McpWriteRequest => {
  const request = assertRecord(value, 'La solicitud MCP');
  assertAllowedKeys(request, ['userId', 'clientId', 'baseUpdatedAt', 'operation'], 'La solicitud MCP');
  assertRequiredKeys(request, ['userId', 'clientId', 'operation'], 'La solicitud MCP');
  const userId = assertId(request.userId, 'userId');
  const clientId = assertId(request.clientId, 'clientId');
  const baseUpdatedAt = request.baseUpdatedAt === undefined ? undefined : assertIsoTimestamp(request.baseUpdatedAt, 'baseUpdatedAt');
  const operationRecord = assertRecord(request.operation, 'operation');
  const operationKind = assertString(operationRecord.kind, 'operation.kind', { allowEmpty: false, maxLength: 40 }) as McpWriteOperation['kind'];
  if (operationKind === 'record_workout' && !context) {
    throw new Error('record_workout requiere contexto de validación del plan autenticado.');
  }
  if ([
    'update_profile',
    'replace_routine',
    'record_workout',
    'add_measurement',
    'add_checkin',
    'preview_change',
    'restore_revision',
  ].includes(operationKind) && !baseUpdatedAt) {
    throw new Error(`${operationKind} requiere baseUpdatedAt de la fila autenticada.`);
  }
  const operation = validateMcpWriteOperation(operationRecord, context);
  return { userId, clientId, baseUpdatedAt, operation };
};
