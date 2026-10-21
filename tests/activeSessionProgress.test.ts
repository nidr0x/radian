import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { getNextSessionProgress } from '../src/lib/sessionFlow';
import { getLatestWorkoutStreak } from '../src/lib/trainingStats';
import type { WorkoutSession } from '../src/types';
import { defaultData } from '../src/data/initialPlan';
import { createSession, STORAGE_KEY } from '../src/lib/storage';

const completedOn = (dateKey: string): WorkoutSession => ({ dateKey, status: 'completed' } as WorkoutSession);

const renderAppWithData = (data: ReturnType<typeof defaultData>): string => {
  const values = new Map<string, string>([[STORAGE_KEY, JSON.stringify(data)]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('navigator', { onLine: true });
  return renderToStaticMarkup(React.createElement(App));
};

describe('progreso visible de la sesión activa', () => {
  it('cuenta sesiones previstas y deja que termine el día programado actual', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 12));
    try {
      expect(getLatestWorkoutStreak([1, 3, 5], [completedOn('2026-10-05'), completedOn('2026-10-07')])).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reinicia la racha al faltar una sesión prevista', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 12));
    try {
      expect(getLatestWorkoutStreak([1, 3, 5], [completedOn('2026-10-05')])).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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

    const html = renderToStaticMarkup(React.createElement(App));

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

    expect(getNextSessionProgress(session, updatedExercise)).toEqual({
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

    expect(getNextSessionProgress(session, updatedExercise)).toEqual({
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

    expect(getNextSessionProgress(session, finalSkippedExercise)).toEqual({
      activeExerciseIndex: 0,
      status: 'completed',
      completedAt: '2026-09-23T10:25:00.000Z',
    });
  });

  it('compara cada ejercicio completado con su última sesión y muestra la progresión siguiente', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 12));
    try {
      const data = defaultData();
      data.onboardingComplete = true;
      const previous = createSession(data.plan.days[0], '2026-10-02', new Date('2026-10-02T10:00:00.000Z'));
      const today = createSession(data.plan.days[0], '2026-10-09', new Date('2026-10-09T10:00:00.000Z'));
      for (const [session, weight, completedAt] of [[previous, 4, '2026-10-02T10:20:00.000Z'], [today, 5, '2026-10-09T10:20:00.000Z']] as const) {
        session.status = 'completed';
        session.completedAt = completedAt;
        const exercise = session.plannedExercises.find((item) => item.exerciseId === 'incline-press')!;
        exercise.completed = true;
        exercise.difficulty = 'good';
        exercise.completedAt = completedAt;
        const workSet = exercise.setLogs.find((set) => set.phase === 'work')!;
        Object.assign(workSet, { completed: true, weightKg: weight, actualReps: 10 });
      }
      data.sessions = [previous, today];

      const html = renderAppWithData(data);

      expect(html).toContain('comparación por ejercicio');
      expect(html).toContain('Última vez · 2 oct');
      expect(html).toContain('4 kg · 10 reps');
      expect(html).toContain('5 kg · 10 reps');
      expect(html).toContain('Próxima sesión');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aclara que el peso de las mancuernas se registra por unidad', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 12));
    try {
      const data = defaultData();
      data.onboardingComplete = true;
      const session = createSession(data.plan.days[0], '2026-10-05', new Date('2026-10-05T10:00:00.000Z'));
      session.activeExerciseIndex = 3;
      data.sessions = [session];

      const html = renderAppWithData(data);

      expect(html).toContain('En mancuernas, registra el peso de una sola mancuerna.');
    } finally {
      vi.useRealTimers();
    }
  });
});
