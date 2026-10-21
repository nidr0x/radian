import { useState } from 'react';
import { createSession, createSetLogs } from '../lib/storage';
import { dateKey } from '../lib/date';
import { detectPersonalRecord } from '../lib/records';
import { formatWeight } from '../lib/format';
import { getNextSessionExerciseIndex, getNextSessionProgress } from '../lib/sessionFlow';
import type { ExerciseDefinition, ExerciseSession, PlannedExercise, SessionReadiness, WorkoutDay, WorkoutSession } from '../types';

type UpdateData = (updater: (current: import('../types').AppData) => import('../types').AppData) => void;
type SetToast = (toast?: string) => void;
type SetView = (view: import('../types').View) => void;

/** Session mutation handlers, extracted verbatim from App.tsx. */
export function useSessionActions(
  data: import('../types').AppData,
  updateData: UpdateData,
  setToast: SetToast,
  setView: SetView,
  startRest: (seconds: number, exerciseName: string) => void,
): SessionActions {

  const [lastSessionChange, setLastSessionChange] = useState<{ sessionId: string; snapshot: WorkoutSession }>();

  const startSession = (day: WorkoutDay, readiness?: SessionReadiness): void => {
    const existing = data.sessions.find((session) => session.status === 'in_progress');
    if (existing) { setView('today'); setToast('Tienes una sesión pendiente'); return; }
    const recoverySources = data.sessions
      .filter((session) => (session.recoveryExercises?.length ?? 0) > 0)
      .sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt));
    const routineExerciseIds = new Set(day.exercises.filter((exercise) => exercise.active).map((exercise) => exercise.exerciseId));
    const queuedByExercise = new Map<string, PlannedExercise>();
    recoverySources.forEach((source) => source.recoveryExercises?.forEach((exercise) => {
      if (!queuedByExercise.has(exercise.exerciseId)) queuedByExercise.set(exercise.exerciseId, exercise);
    }));
    const queuedRecoveryCount = queuedByExercise.size;
    const recoveryExercises = Array.from(queuedByExercise.values()).filter((exercise) => !routineExerciseIds.has(exercise.exerciseId));
    const sessionDay = recoveryExercises.length ? { ...day, exercises: [...day.exercises, ...recoveryExercises] } : day;
    const createdSession = createSession(sessionDay, dateKey(), new Date(), data.sessions, readiness);
    const session = data.sessions.some((item) => item.id === createdSession.id)
      ? { ...createdSession, id: `${createdSession.id}-${Date.now()}` }
      : createdSession;
    const recoverySourceIds = new Set(recoverySources.map((source) => source.id));
    updateData((current) => ({
      ...current,
      sessions: [
        ...current.sessions.map((item) => recoverySourceIds.has(item.id) ? { ...item, recoveryExercises: undefined } : item),
        session,
      ],
    }));
    setView('today');
    setToast(queuedRecoveryCount ? `Sesión preparada con ${queuedRecoveryCount} ejercicio${queuedRecoveryCount === 1 ? '' : 's'} pendiente${queuedRecoveryCount === 1 ? '' : 's'}` : 'Sesión preparada');
  };

  const updateSession = (sessionId: string, updater: (session: WorkoutSession) => WorkoutSession): void => {
    updateData((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === sessionId ? updater(session) : session) }));
  };

  const updateExerciseDraft = (sessionId: string, plannedExerciseId: string, patch: Partial<ExerciseSession>): void => {
    updateSession(sessionId, (current) => ({
      ...current,
      plannedExercises: current.plannedExercises.map((exercise) => exercise.plannedExerciseId === plannedExerciseId ? { ...exercise, ...patch } : exercise),
    }));
  };

  const queueSkippedExercises = (sessionId: string): void => {
    updateSession(sessionId, (current) => ({
      ...current,
      recoveryExercises: current.plannedExercises
        .filter((exercise) => !exercise.completed && Boolean(exercise.completedAt))
        .map((exercise, index) => ({
          id: `recovery-${current.dateKey}-${Date.now()}-${index}`,
          exerciseId: exercise.exerciseId,
          name: exercise.name,
          sets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          restSeconds: exercise.restSeconds,
          active: true,
          warmupSets: exercise.warmupSets,
          progressionPolicy: exercise.progressionPolicy,
          progressionIncrementKg: exercise.progressionIncrementKg,
          imageUrl: exercise.imageUrl,
          imagePosition: exercise.imagePosition,
        })),
    }));
  };

  const removeQueuedRecoveryExercise = (sessionId: string, recoveryExerciseId: string): void => {
    updateSession(sessionId, (current) => {
      const recoveryExercises = current.recoveryExercises?.filter((exercise) => exercise.id !== recoveryExerciseId);
      return { ...current, recoveryExercises: recoveryExercises?.length ? recoveryExercises : undefined };
    });
  };

  const selectSessionExercise = (sessionId: string, index: number): void => {
    updateSession(sessionId, (current) => index >= 0 && index < current.plannedExercises.length
      ? { ...current, activeExerciseIndex: index }
      : current);
  };

  const deferSessionExercise = (session: WorkoutSession): void => {
    const activeIndex = session.activeExerciseIndex;
    const exercise = session.plannedExercises[activeIndex];
    if (!exercise) return;
    const deferredExercise: ExerciseSession = {
      ...exercise,
      completed: false,
      completedAt: undefined,
      difficulty: undefined,
      deferredAt: new Date().toISOString(),
    };
    const plannedExercises = session.plannedExercises.map((item, index) => index === activeIndex ? deferredExercise : item);
    const nextIndex = getNextSessionExerciseIndex({ ...session, plannedExercises });
    if (nextIndex === undefined) {
      setToast('No hay otro ejercicio pendiente. Puedes pausar la sesión y volver más tarde.');
      return;
    }
    setLastSessionChange({ sessionId: session.id, snapshot: session });
    updateSession(session.id, (current) => ({
      ...current,
      activeExerciseIndex: nextIndex,
      status: 'in_progress',
      completedAt: undefined,
      plannedExercises: current.plannedExercises.map((item, index) => index === activeIndex ? deferredExercise : item),
    }));
    setToast(`${exercise.name} aplazado; volverás al terminar los pendientes.`);
  };

  const swapSessionExercise = (sessionId: string, plannedExerciseId: string, replacement: ExerciseDefinition, reason: 'discomfort' | 'equipment' = 'discomfort'): void => {
    const session = data.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setLastSessionChange({ sessionId, snapshot: session });
    updateSession(sessionId, (current) => ({
      ...current,
      plannedExercises: current.plannedExercises.map((item) => item.plannedExerciseId === plannedExerciseId ? {
        ...item,
        exerciseId: replacement.id,
        name: replacement.name,
        imageUrl: replacement.imageUrl,
        imagePosition: replacement.imagePosition,
        completed: false,
        difficulty: undefined,
        completedAt: undefined,
        deferredAt: undefined,
        discomfort: reason === 'discomfort' ? false : item.discomfort,
        discomfortNote: reason === 'discomfort'
          ? item.discomfortNote
            ? 'Sustituido desde ' + item.name + ': ' + item.discomfortNote
            : 'Sustituido desde ' + item.name + ' por una molestia'
          : item.discomfortNote,
        setLogs: createSetLogs(item.sets, item.repMin, undefined, undefined, { warmupSets: item.warmupSets }),
      } : item),
    }));
    setToast(reason === 'equipment' ? 'Alternativa solo para hoy: ' + replacement.name : 'Cambio guardado: ' + replacement.name);
  };

  const completeExercise = (session: WorkoutSession, exercise: ExerciseSession, patch: Partial<ExerciseSession>, shouldStartRest: boolean): void => {
    const updated = { ...exercise, ...patch, completedAt: new Date().toISOString(), deferredAt: undefined };
    const personalRecord = detectPersonalRecord(updated, data.sessions);
    const nextProgress = getNextSessionProgress(session, updated);
    setLastSessionChange({ sessionId: session.id, snapshot: session });
    updateSession(session.id, (current) => ({
      ...current,
      ...nextProgress,
      plannedExercises: current.plannedExercises.map((item, index) => index === current.activeExerciseIndex ? updated : item),
    }));
    if (shouldStartRest && nextProgress.status !== 'completed') startRest(exercise.restSeconds, exercise.name);
    setToast(personalRecord ? personalRecord.kind === 'first' ? `Primera marca: ${formatWeight(personalRecord.weightKg)}` : personalRecord.kind === 'weight' ? `Nuevo récord: ${formatWeight(personalRecord.weightKg)}` : `Nuevo récord de volumen: ${formatWeight(personalRecord.weightKg)}` : nextProgress.status === 'completed' ? 'Sesión completada' : patch.difficulty === 'incomplete' ? 'Ejercicio saltado' : 'Guardado automáticamente');
  };

  const undoLastSessionChange = (): void => {
    if (!lastSessionChange) return;
    updateData((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === lastSessionChange.sessionId ? lastSessionChange.snapshot : session) }));
    setLastSessionChange(undefined);
    setToast('Último ejercicio restaurado');
  };

  return {
    startSession, updateExerciseDraft, queueSkippedExercises, removeQueuedRecoveryExercise,
    selectSessionExercise, deferSessionExercise, swapSessionExercise, completeExercise,
    undoLastSessionChange, lastSessionChange,
  };
}

interface SessionActions {
  startSession: (day: WorkoutDay, readiness?: SessionReadiness) => void;
  updateExerciseDraft: (sessionId: string, plannedExerciseId: string, patch: Partial<ExerciseSession>) => void;
  queueSkippedExercises: (sessionId: string) => void;
  removeQueuedRecoveryExercise: (sessionId: string, recoveryExerciseId: string) => void;
  selectSessionExercise: (sessionId: string, index: number) => void;
  deferSessionExercise: (session: WorkoutSession) => void;
  swapSessionExercise: (sessionId: string, plannedExerciseId: string, replacement: ExerciseDefinition, reason?: 'discomfort' | 'equipment') => void;
  completeExercise: (session: WorkoutSession, exercise: ExerciseSession, patch: Partial<ExerciseSession>, shouldStartRest: boolean) => void;
  undoLastSessionChange: () => void;
  lastSessionChange?: { sessionId: string; snapshot: WorkoutSession };
}
