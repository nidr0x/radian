import { detectPersonalRecord, type PersonalRecordEvent } from './records';
import { isWorkSet } from './progression';
import type { WorkoutSession } from '../types';

export interface SessionSummaryRecord {
  exerciseId: string;
  name: string;
  event: PersonalRecordEvent;
}

export interface SessionSummary {
  completedExercises: number;
  totalExercises: number;
  completedWorkSets: number;
  volumeKg: number;
  durationSeconds: number;
  records: SessionSummaryRecord[];
}

const elapsedSeconds = (session: WorkoutSession): number => {
  if (!session.completedAt) return 0;
  const started = Date.parse(session.startedAt);
  const completed = Date.parse(session.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return 0;
  return Math.max(0, Math.round((completed - started) / 1000));
};

export const summarizeSession = (session: WorkoutSession, history: WorkoutSession[] = []): SessionSummary => {
  const completedExercises = session.plannedExercises.filter((exercise) => exercise.completed);
  const completedWorkSets = session.plannedExercises.flatMap((exercise) => exercise.setLogs.filter((set) => isWorkSet(set) && set.completed));
  const volumeKg = completedWorkSets.reduce((total, set) => total + (set.weightKg ?? 0) * (set.actualReps ?? 0), 0);
  const previousSessions = history.filter((item) => item.id !== session.id);
  const records = completedExercises.map((exercise) => {
    const event = detectPersonalRecord(exercise, previousSessions);
    return event ? { exerciseId: exercise.exerciseId, name: exercise.name, event } : undefined;
  }).filter((record): record is SessionSummaryRecord => Boolean(record));

  return {
    completedExercises: completedExercises.length,
    totalExercises: session.plannedExercises.length,
    completedWorkSets: completedWorkSets.length,
    volumeKg: Math.round(volumeKg * 10) / 10,
    durationSeconds: elapsedSeconds(session),
    records,
  };
};
