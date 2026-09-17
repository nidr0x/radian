import type { PlannedExercise, ProgressionPolicy } from '../types';

export interface RoutineEditDraft {
  exerciseId: string;
  name: string;
  sets: number;
  repMin: number;
  repMax: number;
  restSeconds: number;
  warmupSets: number;
  progressionPolicy: ProgressionPolicy;
  progressionIncrementKg: number;
  imageUrl?: string;
  imagePosition?: string;
}

export const routineEditDraftFrom = (exercise: PlannedExercise): RoutineEditDraft => ({
  exerciseId: exercise.exerciseId,
  name: exercise.name,
  sets: exercise.sets,
  repMin: exercise.repMin,
  repMax: exercise.repMax,
  restSeconds: exercise.restSeconds,
  warmupSets: exercise.warmupSets ?? 0,
  progressionPolicy: exercise.progressionPolicy ?? 'double',
  progressionIncrementKg: exercise.progressionIncrementKg ?? 2.5,
  imageUrl: exercise.imageUrl,
  imagePosition: exercise.imagePosition,
});

export const routineEditPatch = (draft: RoutineEditDraft): Partial<PlannedExercise> => ({ ...draft });
