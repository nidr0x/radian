import type { AppData, WorkoutSession } from '../types';
import { dateKey, shortDayNames } from './date';
import { normalizeTrainingDays } from './date';
import { isWorkSet } from './progression';

export interface WeekDaySummary { key: string; label: string; planned: boolean; completed: boolean }
export interface PerformanceSummary { exerciseId: string; name: string; load?: number; reps?: number; volume: number }
export interface RecordSummary { exerciseId: string; name: string; load: number; reps?: number }
export interface MuscleVolumeSummary { muscleGroup: string; volume: number }
export interface HistorySummary { sessions30: number; currentMonth: number; previousMonth: number; volume30: number }

export function buildWeekDays(trainingDays: number[], sessions: WorkoutSession[]): WeekDaySummary[] {
  const monday = new Date();
  const weekday = monday.getDay() || 7;
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - weekday + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(monday);
    current.setDate(monday.getDate() + index);
    const key = dateKey(current);
    const day = current.getDay();
    return {
      key,
      label: shortDayNames[day],
      planned: trainingDays.includes(day),
      completed: sessions.some((session) => session.status === 'completed' && session.dateKey === key),
    };
  });
}

export function getLatestWorkoutStreak(trainingDays: number[], sessions: WorkoutSession[]): number {
  const plannedDays = new Set(normalizeTrainingDays(trainingDays));
  const completedDays = new Set(sessions.filter((session) => session.status === 'completed').map((session) => session.dateKey));
  const earliestSession = [...completedDays].sort()[0];
  if (!plannedDays.size || !earliestSession) return 0;
  const cursor = new Date(`${dateKey()}T12:00:00`);
  if (plannedDays.has(cursor.getDay()) && !completedDays.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (dateKey(cursor) >= earliestSession) {
    if (plannedDays.has(cursor.getDay())) {
      if (!completedDays.has(dateKey(cursor))) break;
      streak += 1;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
export function performanceRows(sessions: WorkoutSession[]): PerformanceSummary[] {
  const recentSessions = sessions.filter((session) => session.status === 'completed').sort((a, b) => a.dateKey.localeCompare(b.dateKey) || (a.completedAt ?? a.startedAt).localeCompare(b.completedAt ?? b.startedAt)).slice(-6);
  const rows = new Map<string, PerformanceSummary>();
  recentSessions.forEach((session) => session.plannedExercises.forEach((exercise) => {
    const recordedSets = exercise.setLogs.filter((set) => isWorkSet(set) && set.completed && set.weightKg !== undefined && set.actualReps !== undefined);
    if (recordedSets.length === 0) return;
    const best = recordedSets.reduce((current, set) => (set.weightKg ?? 0) > (current.weightKg ?? 0) ? set : current, recordedSets[0]);
    const volume = recordedSets.reduce((total, set) => total + (set.weightKg ?? 0) * (set.actualReps ?? 0), 0);
    const previous = rows.get(exercise.exerciseId);
    rows.set(exercise.exerciseId, {
      exerciseId: exercise.exerciseId,
      name: exercise.name,
      load: Math.max(previous?.load ?? 0, best.weightKg ?? 0) || undefined,
      reps: best.actualReps ?? previous?.reps,
      volume: (previous?.volume ?? 0) + volume,
    });
  }));
  return Array.from(rows.values()).sort((a, b) => b.volume - a.volume).slice(0, 3);
}

export function personalRecords(sessions: WorkoutSession[]): RecordSummary[] {
  const records = new Map<string, RecordSummary>();
  sessions.filter((session) => session.status === 'completed').forEach((session) => session.plannedExercises.forEach((exercise) => {
    exercise.setLogs.filter((set) => isWorkSet(set) && set.completed && set.weightKg !== undefined).forEach((set) => {
      const previous = records.get(exercise.exerciseId);
      if (!previous || (set.weightKg ?? 0) > previous.load || ((set.weightKg ?? 0) === previous.load && (set.actualReps ?? 0) > (previous.reps ?? 0))) {
        records.set(exercise.exerciseId, { exerciseId: exercise.exerciseId, name: exercise.name, load: set.weightKg ?? 0, reps: set.actualReps });
      }
    });
  }));
  return Array.from(records.values()).sort((a, b) => b.load - a.load);
}

export function muscleGroupVolumes(data: AppData): MuscleVolumeSummary[] {
  const names = new Map(data.exercises.map((exercise) => [exercise.id, exercise.muscleGroup]));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const totals = new Map<string, number>();
  data.sessions.filter((session) => session.status === 'completed' && new Date(`${session.dateKey}T12:00:00`) >= cutoff).forEach((session) => session.plannedExercises.forEach((exercise) => {
    const group = names.get(exercise.exerciseId) ?? 'Otros';
    const volume = exercise.setLogs.reduce((total, set) => total + (isWorkSet(set) && set.completed ? (set.weightKg ?? 0) * (set.actualReps ?? 0) : 0), 0);
    if (volume > 0) totals.set(group, (totals.get(group) ?? 0) + volume);
  }));
  return Array.from(totals, ([muscleGroup, volume]) => ({ muscleGroup, volume })).sort((a, b) => b.volume - a.volume);
}

export function historySummary(sessions: WorkoutSession[]): HistorySummary {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const previousMonthDate = new Date(currentYear, currentMonth - 1, 1);
  const completed = sessions.filter((session) => session.status === 'completed');
  const recent = completed.filter((session) => new Date(`${session.dateKey}T12:00:00`) >= cutoff);
  const volume30 = recent.reduce((total, session) => total + session.plannedExercises.reduce((exerciseTotal, exercise) => exerciseTotal + exercise.setLogs.reduce((setTotal, set) => setTotal + (isWorkSet(set) && set.completed ? (set.weightKg ?? 0) * (set.actualReps ?? 0) : 0), 0), 0), 0);
  return {
    sessions30: recent.length,
    currentMonth: completed.filter((session) => { const date = new Date(`${session.dateKey}T12:00:00`); return date.getMonth() === currentMonth && date.getFullYear() === currentYear; }).length,
    previousMonth: completed.filter((session) => { const date = new Date(`${session.dateKey}T12:00:00`); return date.getMonth() === previousMonthDate.getMonth() && date.getFullYear() === previousMonthDate.getFullYear(); }).length,
    volume30,
  };
}
export interface ExerciseTrendOption { id: string; name: string }

export function exerciseTrendOptions(data: AppData): ExerciseTrendOption[] {
  const options = new Map<string, ExerciseTrendOption>();
  data.sessions.filter((session) => session.status === 'completed').forEach((session) => session.plannedExercises.forEach((exercise) => {
    if (!options.has(exercise.exerciseId)) options.set(exercise.exerciseId, { id: exercise.exerciseId, name: exercise.name });
  }));

  return Array.from(options.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
