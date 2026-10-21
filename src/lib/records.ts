import { isWorkSet } from './progression';
import type { ExerciseSession, WorkoutSession } from '../types';

export interface ExerciseRecord {
  exerciseId: string;
  maxWeightKg?: number;
  maxWeightReps?: number;
  maxVolumeKg?: number;
  maxVolumeReps?: number;
}

export interface PersonalRecordEvent {
  kind: 'first' | 'weight' | 'volume';
  weightKg: number;
  reps?: number;
  volumeKg?: number;
}

const recordFromExercise = (exercise: ExerciseSession): ExerciseRecord | undefined => {
  const sets = exercise.setLogs.filter((set) => isWorkSet(set) && set.completed && set.weightKg !== undefined);
  if (sets.length === 0) return undefined;
  const heaviest = sets.reduce((best, set) => (set.weightKg ?? 0) > (best.weightKg ?? 0) || ((set.weightKg ?? 0) === (best.weightKg ?? 0) && (set.actualReps ?? 0) > (best.actualReps ?? 0)) ? set : best, sets[0]);
  const withVolume = sets.filter((set) => set.actualReps !== undefined);
  const bestVolume = withVolume.reduce((best, set) => (set.weightKg ?? 0) * (set.actualReps ?? 0) > (best.weightKg ?? 0) * (best.actualReps ?? 0) ? set : best, withVolume[0]);
  return {
    exerciseId: exercise.exerciseId,
    maxWeightKg: heaviest.weightKg,
    maxWeightReps: heaviest.actualReps,
    maxVolumeKg: bestVolume ? (bestVolume.weightKg ?? 0) * (bestVolume.actualReps ?? 0) : undefined,
    maxVolumeReps: bestVolume?.actualReps,
  };
};

export const bestRecordForExercise = (sessions: WorkoutSession[], exerciseId: string): ExerciseRecord | undefined => {
  const records = sessions
    .filter((session) => session.status === 'completed')
    .flatMap((session) => session.plannedExercises.filter((exercise) => exercise.exerciseId === exerciseId).map(recordFromExercise).filter((record): record is ExerciseRecord => Boolean(record)));
  if (records.length === 0) return undefined;
  return records.reduce((best, current) => ({
    exerciseId,
    maxWeightKg: (current.maxWeightKg ?? 0) > (best.maxWeightKg ?? 0) ? current.maxWeightKg : best.maxWeightKg,
    maxWeightReps: (current.maxWeightKg ?? 0) > (best.maxWeightKg ?? 0) ? current.maxWeightReps : best.maxWeightReps,
    maxVolumeKg: Math.max(current.maxVolumeKg ?? 0, best.maxVolumeKg ?? 0) || undefined,
    maxVolumeReps: (current.maxVolumeKg ?? 0) > (best.maxVolumeKg ?? 0) ? current.maxVolumeReps : best.maxVolumeReps,
  }), records[0]);
};

export const detectPersonalRecord = (exercise: ExerciseSession, sessions: WorkoutSession[]): PersonalRecordEvent | undefined => {
  const current = recordFromExercise(exercise);
  if (!current?.maxWeightKg) return undefined;
  const previous = bestRecordForExercise(sessions, exercise.exerciseId);
  if (!previous) return { kind: 'first', weightKg: current.maxWeightKg, reps: current.maxWeightReps, volumeKg: current.maxVolumeKg };
  if (current.maxWeightKg > (previous.maxWeightKg ?? 0)) return { kind: 'weight', weightKg: current.maxWeightKg, reps: current.maxWeightReps, volumeKg: current.maxVolumeKg };
  if ((current.maxVolumeKg ?? 0) > (previous.maxVolumeKg ?? 0)) return { kind: 'volume', weightKg: current.maxWeightKg, reps: current.maxWeightReps, volumeKg: current.maxVolumeKg };
  return undefined;
};

/**
 * Sessions that hold their exercise's best weight (ties broken by volume), one
 * per exercise at most. Session-history pruning keeps these pinned so a record
 * can never age out of the retained history.
 */
export const recordSessionIds = (sessions: WorkoutSession[]): string[] => {
  const best = new Map<string, { sessionId: string; maxWeightKg?: number; maxVolumeKg?: number }>();
  for (const session of sessions) {
    if (session.status !== 'completed') continue;
    for (const exercise of session.plannedExercises) {
      const record = recordFromExercise(exercise);
      if (!record) continue;
      const current = best.get(record.exerciseId);
      if (!current
        || (record.maxWeightKg ?? 0) > (current.maxWeightKg ?? 0)
        || ((record.maxWeightKg ?? 0) === (current.maxWeightKg ?? 0) && (record.maxVolumeKg ?? 0) > (current.maxVolumeKg ?? 0))) {
        best.set(record.exerciseId, { sessionId: session.id, maxWeightKg: record.maxWeightKg, maxVolumeKg: record.maxVolumeKg });
      }
    }
  }
  return [...best.values()].map((entry) => entry.sessionId);
};
