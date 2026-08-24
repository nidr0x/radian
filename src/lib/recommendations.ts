import { nextPrescription, type ProgressionExercise } from './progression';
import type { ExerciseSession, Recommendation, WorkoutSession } from '../types';

export interface ProgressionAction {
  tone: Recommendation['tone'];
  title: string;
  detail: string;
}

const exerciseHistory = (exerciseId: string, sessions: WorkoutSession[]) => sessions
  .filter((session) => session.status === 'completed')
  .flatMap((session) => session.plannedExercises
    .filter((exercise) => exercise.exerciseId === exerciseId && exercise.difficulty)
    .map((exercise) => ({ ...exercise, completedAt: exercise.completedAt ?? session.completedAt ?? session.startedAt })))
  .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

const formatLoad = (value: number): string => value.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const defaultProgressionExercise = (exerciseId: string, sessions: WorkoutSession[], context?: ProgressionExercise): ProgressionExercise => {
  if (context) return context;
  const latest = sessions
    .flatMap((session) => session.plannedExercises)
    .find((exercise) => exercise.exerciseId === exerciseId);
  return latest ? {
    exerciseId: latest.exerciseId,
    sets: latest.sets,
    repMin: latest.repMin,
    repMax: latest.repMax,
    progressionPolicy: latest.progressionPolicy,
    progressionIncrementKg: latest.progressionIncrementKg,
  } : { exerciseId, sets: 3, repMin: 8, repMax: 12, progressionPolicy: 'double', progressionIncrementKg: 2.5 };
};

export const recommendationFor = (exerciseId: string, sessions: WorkoutSession[]): Recommendation | undefined => {
  const history = exerciseHistory(exerciseId, sessions);

  if (history.length === 0) return undefined;
  if (history[0].discomfort) {
    return { tone: 'caution', label: 'Revisar', message: 'Hubo molestias. Mantén el ejercicio sin progresar hasta revisarlo.' };
  }

  const recent = history.slice(0, 3);
  const easyCount = recent.filter((item) => item.difficulty === 'easy' && item.completed).length;
  const incompleteCount = recent.filter((item) => item.difficulty === 'incomplete' || !item.completed).length;

  if (easyCount >= 2 && recent.length >= 2) {
    return { tone: 'positive', label: 'Progresar', message: 'Dos sesiones fáciles seguidas. Sube ligeramente la carga o añade dificultad.' };
  }
  if (incompleteCount >= 2) {
    return { tone: 'caution', label: 'Ajustar', message: 'El ejercicio se ha quedado corto varias veces. Reduce un poco la dificultad.' };
  }
  if (history[0].difficulty === 'hard') {
    return { tone: 'neutral', label: 'Observar', message: 'Fue difícil. Mantén la programación y observa la próxima sesión.' };
  }
  if (history[0].difficulty === 'good') {
    return { tone: 'neutral', label: 'Mantener', message: 'Mantén la programación actual.' };
  }
  return { tone: 'neutral', label: 'En curso', message: 'Aún no hay suficiente señal para cambiar nada.' };
};

export const progressionAction = (exerciseId: string, sessions: WorkoutSession[], context?: ProgressionExercise | ExerciseSession): ProgressionAction | undefined => {
  const history = exerciseHistory(exerciseId, sessions);
  if (history.length === 0) return undefined;
  const plan = nextPrescription(defaultProgressionExercise(exerciseId, sessions, context), sessions);
  if (plan.status === 'start') return undefined;
  if (plan.status === 'up' && plan.nextWeightKg !== undefined) {
    return { tone: 'positive', title: `Próxima vez: prueba ${formatLoad(plan.nextWeightKg)} kg`, detail: plan.reason };
  }
  if (plan.status === 'rep') {
    return { tone: 'positive', title: `Próxima vez: busca ${plan.targetReps} repeticiones`, detail: plan.reason };
  }
  if (plan.status === 'deload' || plan.status === 'blocked') {
    return { tone: 'caution', title: plan.status === 'deload' ? 'Próxima vez: descarga' : 'Próxima vez: no progreses', detail: plan.reason };
  }
  return { tone: 'neutral', title: plan.nextWeightKg !== undefined ? `Próxima vez: mantén ${formatLoad(plan.nextWeightKg)} kg` : 'Próxima vez: mantén el rango', detail: plan.reason };
};

export const progressionCue = (exerciseId: string, sessions: WorkoutSession[], context?: ProgressionExercise | ExerciseSession): string | undefined => {
  const action = progressionAction(exerciseId, sessions, context);
  if (!action) return undefined;
  return `${action.title}. ${action.detail}`;
};

export const overallFeedback = (sessions: WorkoutSession[]): string => {
  const completed = sessions.filter((session) => session.status === 'completed');
  const results = completed.flatMap((session) => session.plannedExercises);
  const hard = results.filter((item) => item.difficulty === 'hard' || item.difficulty === 'incomplete').length;
  const easy = results.filter((item) => item.difficulty === 'easy').length;
  if (completed.length === 0) return 'Aún no hay sesiones registradas.';
  if (hard > easy && hard >= 3) return 'Varios ejercicios están costando. Conviene revisar recuperación antes de progresar.';
  if (easy >= 3) return 'Hay margen de progresión en varios ejercicios. Ve paso a paso.';
  return 'El rendimiento se mantiene estable. Continúa observando las sensaciones.';
};
