import type { AppData, ExerciseDefinition, ExerciseSession, WorkoutSession } from '../types';
import { compatibleAlternatives } from './exercises';

export function latestExercise(sessions: WorkoutSession[], exerciseId: string): ExerciseSession | undefined {
  return sessions.filter((session) => session.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).flatMap((session) => session.plannedExercises.filter((item) => item.exerciseId === exerciseId && item.difficulty))[0];
}

export function alternativeExercises(data: AppData, exerciseId: string, differentEquipment = false): ExerciseDefinition[] {
  const current = data.exercises.find((exercise) => exercise.id === exerciseId);
  if (!current) return [];
  const availableEquipment = differentEquipment
    ? data.profile.availableEquipment.filter((equipment) => equipment !== current.equipment)
    : data.profile.availableEquipment;
  return compatibleAlternatives(data.exercises, exerciseId, availableEquipment).slice(0, 3);
}
