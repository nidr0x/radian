import type { ExerciseSession, WorkoutSession } from '../types';

export const hasSessionExerciseResult = (exercise: ExerciseSession): boolean => exercise.completed || Boolean(exercise.completedAt);
export const isSessionExerciseDeferred = (exercise: ExerciseSession): boolean => Boolean(exercise.deferredAt) && !hasSessionExerciseResult(exercise);

export const findNextSessionExerciseIndex = (exercises: ExerciseSession[], activeIndex: number): number | undefined => {
  if (exercises.length < 2) return undefined;
  const startIndex = ((activeIndex % exercises.length) + exercises.length) % exercises.length;
  const find = (includeDeferred: boolean): number | undefined => {
    for (let offset = 1; offset < exercises.length; offset += 1) {
      const index = (startIndex + offset) % exercises.length;
      const exercise = exercises[index];
      if (!hasSessionExerciseResult(exercise) && (includeDeferred || !isSessionExerciseDeferred(exercise))) return index;
    }
    return undefined;
  };
  return find(false) ?? find(true);
};

export const getNextSessionExerciseIndex = (session: WorkoutSession): number | undefined => findNextSessionExerciseIndex(session.plannedExercises, session.activeExerciseIndex);

export const getNextSessionProgress = (session: WorkoutSession, updatedExercise: ExerciseSession): Pick<WorkoutSession, 'activeExerciseIndex' | 'status' | 'completedAt'> => {
  const exercises = session.plannedExercises.map((exercise, index) => index === session.activeExerciseIndex ? updatedExercise : exercise);
  if (exercises.every(hasSessionExerciseResult)) return { activeExerciseIndex: session.activeExerciseIndex, status: 'completed', completedAt: updatedExercise.completedAt };
  const nextIndex = findNextSessionExerciseIndex(exercises, session.activeExerciseIndex);
  return { activeExerciseIndex: nextIndex ?? session.activeExerciseIndex, status: 'in_progress', completedAt: undefined };
};
