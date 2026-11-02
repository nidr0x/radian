import type { ExerciseSession, ProgressionPolicy, SetLog, WorkoutSession } from '../types';

export type ProgressionStatus = 'start' | 'hold' | 'up' | 'rep' | 'deload' | 'blocked' | 'off';

export interface ProgressionExercise {
  exerciseId: string;
  sets: number;
  repMin: number;
  repMax: number;
  progressionPolicy?: ProgressionPolicy;
  progressionIncrementKg?: number;
}

export interface ProgressionPlan {
  policy: ProgressionPolicy;
  status: ProgressionStatus;
  nextWeightKg?: number;
  targetReps: number;
  reason: string;
  lastWeightKg?: number;
}

const DEFAULT_POLICY: ProgressionPolicy = 'double';
const DEFAULT_INCREMENT_KG = 2.5;

export const isWorkSet = (set: SetLog): boolean => set.phase !== 'warmup';

const formatWeight = (value: number): string => `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} kg`;
const roundWeight = (value: number): number => Math.round(value * 2) / 2;

const exerciseHistory = (exerciseId: string, sessions: WorkoutSession[]): ExerciseSession[] => sessions
  .filter((session) => session.status === 'completed')
  .sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt))
  .flatMap((session) => session.plannedExercises.filter((exercise) => exercise.exerciseId === exerciseId));

const workSets = (exercise: ExerciseSession): SetLog[] => (exercise.setLogs ?? []).filter(isWorkSet);
const completedWorkSets = (exercise: ExerciseSession): SetLog[] => workSets(exercise).filter((set) => set.completed);

const lastWeight = (exercise?: ExerciseSession): number | undefined => {
  const set = exercise ? [...completedWorkSets(exercise)].reverse().find((item) => item.weightKg !== undefined) : undefined;
  return set?.weightKg ?? exercise?.actualWeightKg;
};

const hasAllWorkSets = (exercise: ExerciseSession, plannedSets: number): boolean => {
  const sets = workSets(exercise);
  return sets.length >= plannedSets && sets.slice(0, plannedSets).every((set) => set.completed);
};

const actualReps = (exercise: ExerciseSession): number[] => completedWorkSets(exercise)
  .map((set) => set.actualReps)
  .filter((value): value is number => value !== undefined && Number.isFinite(value));

const isStall = (exercise: ExerciseSession, plannedSets: number, repMin: number): boolean => {
  const reps = actualReps(exercise);
  const complete = exercise.completed && hasAllWorkSets(exercise, plannedSets);
  return !complete || exercise.difficulty === 'hard' || exercise.difficulty === 'incomplete' || reps.length < plannedSets || reps.some((value) => value < repMin);
};

const consecutiveStalls = (history: ExerciseSession[], plannedSets: number, repMin: number): number => {
  let count = 0;
  for (const exercise of history.slice(0, 3)) {
    if (!isStall(exercise, plannedSets, repMin)) break;
    count += 1;
  }
  return count;
};

export const nextPrescription = (exercise: ProgressionExercise, sessions: WorkoutSession[]): ProgressionPlan => {
  const policy = exercise.progressionPolicy ?? DEFAULT_POLICY;
  const increment = exercise.progressionIncrementKg ?? DEFAULT_INCREMENT_KG;
  const history = exerciseHistory(exercise.exerciseId, sessions);
  const latest = history[0];
  const lastWeightKg = lastWeight(latest);

  if (!latest) {
    return { policy, status: 'start', targetReps: exercise.repMin, reason: 'Primera sesión: empieza en el rango bajo y deja margen para aprender el movimiento.' };
  }

  if (policy === 'off') {
    return { policy, status: 'off', targetReps: exercise.repMin, nextWeightKg: lastWeightKg, lastWeightKg, reason: 'Progresión manual: mantengo la última referencia y no cambio la carga automáticamente.' };
  }

  if (latest.discomfort) {
    return { policy, status: 'blocked', targetReps: exercise.repMin, nextWeightKg: lastWeightKg, lastWeightKg, reason: 'Hubo molestias: mantén la carga o cambia de variante antes de progresar.' };
  }

  if (lastWeightKg !== undefined && consecutiveStalls(history, exercise.sets, exercise.repMin) >= 3) {
    const deload = roundWeight(lastWeightKg * 0.9);
    return {
      policy,
      status: 'deload',
      targetReps: exercise.repMin,
      nextWeightKg: deload,
      lastWeightKg,
      reason: `Tres sesiones atascadas: bajo un 10 % la carga, hasta ${formatWeight(deload)}, y reconstruimos desde ahí.`,
    };
  }

  const complete = latest.completed && hasAllWorkSets(latest, exercise.sets);
  const reps = actualReps(latest);
  const reachedMin = reps.length >= exercise.sets && reps.slice(0, exercise.sets).every((value) => value >= exercise.repMin);
  if (!complete || !reachedMin) {
    return {
      policy,
      status: 'hold',
      targetReps: exercise.repMin,
      nextWeightKg: lastWeightKg,
      lastWeightKg,
      reason: lastWeightKg !== undefined ? `Repite ${formatWeight(lastWeightKg)} hasta completar todas las series con control.` : 'Repite el rango actual hasta completar todas las series con control.',
    };
  }

  if (policy === 'linear') {
    if (lastWeightKg === undefined) {
      return { policy, status: 'hold', targetReps: exercise.repMin, reason: 'No hay carga registrada: añade el peso real para poder aplicar la progresión lineal.' };
    }
    const nextWeightKg = roundWeight(lastWeightKg + increment);
    return { policy, status: 'up', targetReps: exercise.repMin, nextWeightKg, lastWeightKg, reason: `Has completado todas las series: subo ${formatWeight(lastWeightKg)} a ${formatWeight(nextWeightKg)}.` };
  }

  const reachedTop = reps.length >= exercise.sets && reps.slice(0, exercise.sets).every((value) => value >= exercise.repMax);
  if (reachedTop && lastWeightKg !== undefined) {
    const nextWeightKg = roundWeight(lastWeightKg + increment);
    return { policy, status: 'up', targetReps: exercise.repMin, nextWeightKg, lastWeightKg, reason: `Has alcanzado ${exercise.repMax} repeticiones en todas las series: subo ${formatWeight(lastWeightKg)} a ${formatWeight(nextWeightKg)} y reinicio el rango.` };
  }

  const lowestReps = Math.min(...reps.slice(0, exercise.sets));
  const targetReps = Math.min(exercise.repMax, Math.max(exercise.repMin, lowestReps + 1));
  if (targetReps > exercise.repMin) {
    return { policy, status: 'rep', targetReps, nextWeightKg: lastWeightKg, lastWeightKg, reason: `Mantén ${lastWeightKg !== undefined ? formatWeight(lastWeightKg) : 'la carga actual'} y busca ${targetReps} repeticiones en todas las series.` };
  }

  return { policy, status: 'hold', targetReps: exercise.repMin, nextWeightKg: lastWeightKg, lastWeightKg, reason: 'Consolida el rango bajo antes de intentar subir la carga.' };
};
