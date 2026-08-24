import { defaultData } from '../data/initialPlan';
import { nextPrescription } from './progression';
import type { AppData, BackupPayload, ExerciseSession, PlannedExercise, ProgressionPolicy, SetLog, WorkoutDay, WorkoutSession } from '../types';

export const STORAGE_KEY = 'radian-data-v1';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isLegacyImage = (imageUrl?: string): boolean => !imageUrl || imageUrl.startsWith('https://wger.de/') || (imageUrl.startsWith('/exercises/atlas-') && (imageUrl.endsWith('.png') || imageUrl.endsWith('.webp')));
const clampWarmupSets = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(3, Math.max(0, Math.round(value))) : 0;
const validIncrement = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 2.5;
const validPolicy = (value: unknown): ProgressionPolicy => value === 'off' || value === 'linear' || value === 'double' ? value : 'double';

interface SetLogOptions {
  warmupSets?: number;
  targetReps?: number;
  defaultWeightKg?: number;
  defaultActualReps?: Array<number | undefined>;
}

export const createSetLogs = (sets: number, repMin: number, source?: SetLog[], legacy?: Pick<ExerciseSession, 'actualWeightKg' | 'actualReps' | 'completed'>, options: SetLogOptions = {}): SetLog[] => Array.from({ length: sets + (options.warmupSets ?? 0) }, (_, index) => {
  const previous = source?.[index];
  const phase = previous?.phase ?? (index < (options.warmupSets ?? 0) ? 'warmup' : 'work');
  return {
    setNumber: index + 1,
    phase,
    targetReps: previous?.targetReps ?? (phase === 'warmup' ? repMin : options.targetReps ?? repMin),
    actualReps: previous?.actualReps ?? options.defaultActualReps?.[index] ?? legacy?.actualReps,
    weightKg: previous?.weightKg ?? legacy?.actualWeightKg ?? options.defaultWeightKg,
    completed: previous?.completed ?? Boolean(legacy?.completed),
  };
});

const normalizeSetLogs = (exercise: ExerciseSession): SetLog[] => createSetLogs(exercise.sets, exercise.repMin, exercise.setLogs, exercise, {
  warmupSets: clampWarmupSets(exercise.warmupSets),
});

const latestCompletedExercise = (exerciseId: string, sessions: WorkoutSession[]): ExerciseSession | undefined => sessions
  .filter((session) => session.status === 'completed')
  .sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt))
  .flatMap((session) => session.plannedExercises.filter((exercise) => exercise.exerciseId === exerciseId))[0];

export const createSession = (day: WorkoutDay, date: string, now = new Date(), history: WorkoutSession[] = []): WorkoutSession => ({
  id: `session-${date}`,
  workoutDayId: day.id,
  dateKey: date,
  startedAt: now.toISOString(),
  status: 'in_progress',
  activeExerciseIndex: 0,
  plannedExercises: day.exercises.filter((exercise) => exercise.active).map((exercise): ExerciseSession => ({
    ...(() => {
      const plan = nextPrescription(exercise, history);
      const warmupSets = clampWarmupSets(exercise.warmupSets);
      const previous = latestCompletedExercise(exercise.exerciseId, history);
      return {
        warmupSets,
        progressionPolicy: validPolicy(exercise.progressionPolicy),
        progressionIncrementKg: validIncrement(exercise.progressionIncrementKg),
        progressionStatus: plan.status,
        progressionReason: plan.reason,
        setLogs: createSetLogs(exercise.sets, exercise.repMin, undefined, undefined, {
          warmupSets,
          targetReps: plan.targetReps,
          defaultWeightKg: plan.nextWeightKg,
          defaultActualReps: previous?.setLogs.map((set) => set.actualReps),
        }),
      };
    })(),
    plannedExerciseId: exercise.id,
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    sets: exercise.sets,
    repMin: exercise.repMin,
    repMax: exercise.repMax,
    restSeconds: exercise.restSeconds,
    imageUrl: exercise.imageUrl,
    imagePosition: exercise.imagePosition,
    completed: false,
    discomfort: false,
  })),
});

export const migrateData = (value: unknown): AppData => {
  const fallback = defaultData();
  if (!isRecord(value)) return fallback;
  const candidate = value as Partial<AppData>;
  if (!candidate.profile || !candidate.plan || !Array.isArray(candidate.plan.days)) return fallback;
  const profile = {
    ...fallback.profile,
    ...candidate.profile,
    trainingDays: Array.isArray(candidate.profile.trainingDays) ? candidate.profile.trainingDays : fallback.profile.trainingDays,
    experienceLevel: candidate.profile.experienceLevel ?? fallback.profile.experienceLevel,
    largeText: candidate.profile.largeText === true,
  };

  const fallbackExercises = new Map(fallback.exercises.map((exercise) => [exercise.id, exercise]));
  const fallbackPlanned = new Map(fallback.plan.days.flatMap((day) => day.exercises).map((exercise) => [exercise.exerciseId, exercise]));
  const exercises = (Array.isArray(candidate.exercises) ? candidate.exercises : fallback.exercises).map((exercise) => {
    const current = fallbackExercises.get(exercise.id);
    return {
      ...(current ?? exercise),
      ...exercise,
      imageUrl: isLegacyImage(exercise.imageUrl) ? current?.imageUrl : exercise.imageUrl,
      imagePosition: exercise.imagePosition ?? current?.imagePosition,
      equipment: exercise.equipment ?? current?.equipment ?? 'machine',
      aliases: exercise.aliases ?? current?.aliases ?? [],
    };
  });
  const exerciseVisuals = new Map(exercises.map((exercise) => [exercise.id, { imageUrl: exercise.imageUrl, imagePosition: exercise.imagePosition }]));
  const days = candidate.plan.days.map((day) => ({
    ...day,
    exercises: day.exercises.map((exercise) => {
      const current = fallbackPlanned.get(exercise.exerciseId);
      const visual = exerciseVisuals.get(exercise.exerciseId);
      return {
        ...(current ?? exercise),
        ...exercise,
        warmupSets: clampWarmupSets(exercise.warmupSets ?? current?.warmupSets),
        progressionPolicy: validPolicy(exercise.progressionPolicy ?? current?.progressionPolicy),
        progressionIncrementKg: validIncrement(exercise.progressionIncrementKg ?? current?.progressionIncrementKg),
        imageUrl: isLegacyImage(exercise.imageUrl) ? current?.imageUrl ?? visual?.imageUrl : exercise.imageUrl,
        imagePosition: exercise.imagePosition ?? current?.imagePosition ?? visual?.imagePosition,
      };
    }),
  }));
  const sessions = (Array.isArray(candidate.sessions) ? candidate.sessions : []).map((session) => ({
    ...session,
    plannedExercises: session.plannedExercises.map((exercise) => {
      const visual = exerciseVisuals.get(exercise.exerciseId);
      const planned = fallbackPlanned.get(exercise.exerciseId);
      const warmupSets = clampWarmupSets(exercise.warmupSets);
      return {
        ...exercise,
        warmupSets,
        progressionPolicy: validPolicy(exercise.progressionPolicy ?? planned?.progressionPolicy),
        progressionIncrementKg: validIncrement(exercise.progressionIncrementKg ?? planned?.progressionIncrementKg),
        imageUrl: isLegacyImage(exercise.imageUrl) ? visual?.imageUrl : exercise.imageUrl,
        imagePosition: exercise.imagePosition ?? visual?.imagePosition,
        setLogs: normalizeSetLogs({ ...exercise, warmupSets }),
      };
    }),
  }));
  return {
    ...fallback,
    ...candidate,
    schemaVersion: 7,
    onboardingComplete: typeof candidate.onboardingComplete === 'boolean'
      ? candidate.onboardingComplete
      : Boolean((Array.isArray(candidate.sessions) && candidate.sessions.length > 0) || (Array.isArray(candidate.progress) && candidate.progress.length > 0)),
    profile,
    exercises,
    plan: { ...fallback.plan, ...candidate.plan, version: candidate.plan.version ?? fallback.plan.version, days },
    sessions,
    progress: Array.isArray(candidate.progress) ? candidate.progress : [],
    checkins: Array.isArray(candidate.checkins) ? candidate.checkins : [],
  };
};

export const loadData = (): AppData => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? migrateData(JSON.parse(raw)) : defaultData();
  } catch {
    return defaultData();
  }
};

export const persistData = (data: AppData): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
};

export const serializeBackup = (data: AppData): string => JSON.stringify({ app: 'radian', exportedAt: new Date().toISOString(), data } satisfies BackupPayload, null, 2);

export const parseBackup = (raw: string): AppData => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.app !== 'radian' || !('data' in parsed)) throw new Error('Este archivo no parece una copia de Radian.');
  return migrateData(parsed.data);
};

export const snapshotMatchesPlan = (session: WorkoutSession, exercise: PlannedExercise): boolean => {
  const stored = session.plannedExercises.find((item) => item.plannedExerciseId === exercise.id);
  return stored?.sets === exercise.sets && stored.repMin === exercise.repMin && stored.repMax === exercise.repMax;
};
