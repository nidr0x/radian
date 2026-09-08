import { defaultData } from '../data/initialPlan';
import { allExerciseEquipment } from './exercises';
import { nextPrescription } from './progression';
import { adaptPlannedExercise, sessionAdaptation } from './sessionAdaptation';
import type { AppData, BackupPayload, Energy, ExerciseSession, PlannedExercise, ProgressionPolicy, SessionReadiness, SetLog, Soreness, WorkoutDay, WorkoutSession } from '../types';

export const STORAGE_KEY = 'radian-data-v1';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isLegacyImage = (imageUrl?: string): boolean => !imageUrl || imageUrl.startsWith('https://wger.de/') || (imageUrl.startsWith('/exercises/atlas-') && (imageUrl.endsWith('.png') || imageUrl.endsWith('.webp')));
const clampWarmupSets = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(3, Math.max(0, Math.round(value))) : 0;
const optionalNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const validIncrement = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 2.5;
const validPolicy = (value: unknown): ProgressionPolicy => value === 'off' || value === 'linear' || value === 'double' ? value : 'double';
const validEnergy = (value: unknown): Energy | undefined => value === 'low' || value === 'normal' || value === 'high' ? value : undefined;
const validSoreness = (value: unknown): Soreness | undefined => value === 'none' || value === 'some' || value === 'high' ? value : undefined;
const normalizeReadiness = (value: unknown): SessionReadiness | undefined => {
  if (!isRecord(value)) return undefined;
  const energy = validEnergy(value.energy);
  const soreness = validSoreness(value.soreness);
  return energy && soreness ? { energy, soreness } : undefined;
};

interface SetLogOptions {
  warmupSets?: number;
  targetReps?: number;
  defaultWeightKg?: number;
  defaultActualReps?: Array<number | undefined>;
  copyCompleted?: boolean;
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
    completed: options.copyCompleted === false ? false : previous?.completed ?? Boolean(legacy?.completed),
  };
});

const normalizeSetLogs = (exercise: ExerciseSession): SetLog[] => createSetLogs(exercise.sets, exercise.repMin, exercise.setLogs, exercise, {
  warmupSets: clampWarmupSets(exercise.warmupSets),
});

const latestCompletedExercise = (exerciseId: string, sessions: WorkoutSession[]): ExerciseSession | undefined => sessions
  .filter((session) => session.status === 'completed')
  .sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt))
  .flatMap((session) => session.plannedExercises.filter((exercise) => exercise.exerciseId === exerciseId))[0];

export const createSession = (day: WorkoutDay, date: string, now = new Date(), history: WorkoutSession[] = [], readiness?: SessionReadiness): WorkoutSession => {
  const adaptation = sessionAdaptation(readiness);
  return {
    id: `session-${date}`,
    workoutDayId: day.id,
    dateKey: date,
    startedAt: now.toISOString(),
    status: 'in_progress',
    activeExerciseIndex: 0,
    ...(readiness ? { readiness } : {}),
    plannedExercises: day.exercises.filter((exercise) => exercise.active).map((exercise): ExerciseSession => {
      const plan = nextPrescription(exercise, history);
      const adapted = adaptPlannedExercise(exercise, adaptation);
      const warmupSets = clampWarmupSets(adapted.warmupSets);
      const previous = latestCompletedExercise(exercise.exerciseId, history);
      return {
        plannedExerciseId: exercise.id,
        exerciseId: exercise.exerciseId,
        name: exercise.name,
        sets: adapted.sets,
        repMin: adapted.repMin,
        repMax: adapted.repMax,
        restSeconds: adapted.restSeconds,
        imageUrl: exercise.imageUrl,
        imagePosition: exercise.imagePosition,
        completed: false,
        discomfort: false,
        warmupSets,
        progressionPolicy: validPolicy(adapted.progressionPolicy),
        progressionIncrementKg: validIncrement(adapted.progressionIncrementKg),
        progressionStatus: adaptation.mode === 'normal' ? plan.status : 'hold',
        progressionReason: adaptation.mode === 'normal' ? plan.reason : `${adaptation.detail} ${plan.reason}`,
        setLogs: createSetLogs(adapted.sets, adapted.repMin, undefined, undefined, {
          warmupSets,
          targetReps: adaptation.useLowerRepTarget ? adapted.repMin : plan.targetReps,
          defaultWeightKg: plan.nextWeightKg,
          defaultActualReps: previous?.setLogs.map((set) => set.actualReps),
        }),
      };
    }),
  };
};

export const migrateData = (value: unknown): AppData => {
  const fallback = defaultData();
  if (!isRecord(value)) return fallback;
  const candidate = value as Partial<AppData>;
  if (!candidate.profile || !candidate.plan || !Array.isArray(candidate.plan.days)) return fallback;
  const profile = {
    ...fallback.profile,
    ...candidate.profile,
    heightCm: optionalNumber(candidate.profile.heightCm),
    currentWeightKg: optionalNumber(candidate.profile.currentWeightKg),
    goal: typeof candidate.profile.goal === 'string' ? candidate.profile.goal : fallback.profile.goal,
    gym: typeof candidate.profile.gym === 'string' ? candidate.profile.gym : fallback.profile.gym,
    nutritionContext: typeof candidate.profile.nutritionContext === 'string' ? candidate.profile.nutritionContext : fallback.profile.nutritionContext,
    trainingDays: Array.isArray(candidate.profile.trainingDays) ? candidate.profile.trainingDays : fallback.profile.trainingDays,
    experienceLevel: candidate.profile.experienceLevel ?? fallback.profile.experienceLevel,
    availableEquipment: (() => {
      const equipment = Array.isArray(candidate.profile.availableEquipment)
        ? candidate.profile.availableEquipment.filter((item): item is typeof allExerciseEquipment[number] => allExerciseEquipment.includes(item as typeof allExerciseEquipment[number]))
        : [];
      return equipment.length ? equipment : fallback.profile.availableEquipment;
    })(),
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
    ...(normalizeReadiness(session.readiness) ? { readiness: normalizeReadiness(session.readiness) } : {}),
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

export const persistData = (data: AppData): boolean => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
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
