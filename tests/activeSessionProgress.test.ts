import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as AppModule from '../src/App';
import type { ExerciseSession, WorkoutSession } from '../src/types';
import { defaultData } from '../src/data/initialPlan';
import { createSession, STORAGE_KEY } from '../src/lib/storage';

const appProgress = AppModule as typeof AppModule & {
  getNextSessionProgress?: (session: WorkoutSession, updatedExercise: ExerciseSession) => Pick<WorkoutSession, 'activeExerciseIndex' | 'status' | 'completedAt'>;
};

describe('progreso visible de la sesión activa', () => {
  it('mantiene alineada la posición actual con el ejercicio mostrado aunque haya ejercicios incompletos', () => {
    const data = defaultData();
    data.onboardingComplete = true;
    const session = createSession(data.plan.days[3], '2026-09-18', new Date('2026-09-18T10:00:00.000Z'));
    session.activeExerciseIndex = 6;
    session.plannedExercises.slice(0, 4).forEach((exercise) => {
      exercise.completed = true;
      exercise.difficulty = 'good';
    });
    data.sessions = [session];

    const values = new Map<string, string>([[STORAGE_KEY, JSON.stringify(data)]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal('navigator', { onLine: true });

    const html = renderToStaticMarkup(React.createElement(AppModule.default));

    expect(html).toContain('Ejercicio 7 de 7');
    expect(html).toContain('4 completados');
    expect(html).toContain('ejercicio 7 / 7');
    expect(html).toContain('Ejercicios de la sesión');
    expect(html).not.toContain('4 de 7 ejercicios');
  });

  it('continúa en el siguiente pendiente para que se pueda volver al ejercicio aplazado', () => {
    const data = defaultData();
    const session = createSession(data.plan.days[0], '2026-09-23', new Date('2026-09-23T10:00:00.000Z'));
    session.plannedExercises = session.plannedExercises.slice(0, 4);
    session.activeExerciseIndex = 1;
    const updatedExercise = {
      ...session.plannedExercises[1],
      completed: true,
      difficulty: 'good' as const,
      completedAt: '2026-09-23T10:10:00.000Z',
    };

    expect(appProgress.getNextSessionProgress?.(session, updatedExercise)).toEqual({
      activeExerciseIndex: 2,
      status: 'in_progress',
      completedAt: undefined,
    });
  });

  it('vuelve al ejercicio pendiente al terminar los posteriores y cierra solo cuando todos tienen resultado', () => {
    const data = defaultData();
    const session = createSession(data.plan.days[0], '2026-09-23', new Date('2026-09-23T10:00:00.000Z'));
    session.plannedExercises = session.plannedExercises.slice(0, 4);
    session.activeExerciseIndex = 3;
    session.plannedExercises.slice(1, 3).forEach((exercise) => {
      exercise.completed = true;
      exercise.completedAt = '2026-09-23T10:05:00.000Z';
    });
    const updatedExercise = {
      ...session.plannedExercises[3],
      completed: true,
      difficulty: 'good' as const,
      completedAt: '2026-09-23T10:15:00.000Z',
    };

    expect(appProgress.getNextSessionProgress?.(session, updatedExercise)).toEqual({
      activeExerciseIndex: 0,
      status: 'in_progress',
      completedAt: undefined,
    });

    session.plannedExercises[3] = updatedExercise;
    session.plannedExercises[0].completed = true;
    session.plannedExercises[0].completedAt = '2026-09-23T10:20:00.000Z';
    session.activeExerciseIndex = 0;
    const finalSkippedExercise = {
      ...session.plannedExercises[0],
      completed: false,
      difficulty: 'incomplete' as const,
      completedAt: '2026-09-23T10:25:00.000Z',
    };

    expect(appProgress.getNextSessionProgress?.(session, finalSkippedExercise)).toEqual({
      activeExerciseIndex: 0,
      status: 'completed',
      completedAt: '2026-09-23T10:25:00.000Z',
    });
  });
});
