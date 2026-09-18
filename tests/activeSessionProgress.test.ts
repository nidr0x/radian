import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { defaultData } from '../src/data/initialPlan';
import { createSession, STORAGE_KEY } from '../src/lib/storage';

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

    const html = renderToStaticMarkup(React.createElement(App));

    expect(html).toContain('Ejercicio 7 de 7');
    expect(html).toContain('4 completados');
    expect(html).toContain('ejercicio 7 / 7');
    expect(html).not.toContain('4 de 7 ejercicios');
  });
});
