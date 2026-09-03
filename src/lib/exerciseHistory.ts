import { isWorkSet } from './progression';
import type { Difficulty, ExerciseSession, WorkoutSession } from '../types';

export interface ExerciseTrendPoint {
  date: string;
  maxWeightKg?: number;
  maxReps?: number;
  volumeKg: number;
  difficulty?: Difficulty;
  discomfort: boolean;
}

const finiteNumbers = (values: Array<number | undefined>): number[] => values.filter((value): value is number => value !== undefined && Number.isFinite(value));

const trendPoint = (session: WorkoutSession, exercise: ExerciseSession): ExerciseTrendPoint => {
  const completedSets = (exercise.setLogs ?? []).filter((set) => isWorkSet(set) && set.completed);
  const weights = finiteNumbers(completedSets.map((set) => set.weightKg));
  const reps = finiteNumbers(completedSets.map((set) => set.actualReps));
  const volumeKg = completedSets.reduce((total, set) => total + ((set.weightKg ?? 0) * (set.actualReps ?? 0)), 0);

  return {
    date: session.dateKey,
    ...(weights.length > 0 ? { maxWeightKg: Math.max(...weights) } : {}),
    ...(reps.length > 0 ? { maxReps: Math.max(...reps) } : {}),
    volumeKg,
    ...(exercise.difficulty ? { difficulty: exercise.difficulty } : {}),
    discomfort: exercise.discomfort,
  };
};

export const exerciseTrend = (exerciseId: string, sessions: WorkoutSession[], limit = 12): ExerciseTrendPoint[] => {
  const safeLimit = Math.max(1, Math.floor(limit));
  return sessions
    .filter((session) => session.status === 'completed')
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || (a.completedAt ?? a.startedAt).localeCompare(b.completedAt ?? b.startedAt))
    .flatMap((session) => session.plannedExercises
      .filter((exercise) => exercise.exerciseId === exerciseId)
      .map((exercise) => trendPoint(session, exercise)))
    .slice(-safeLimit);
};
