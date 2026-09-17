import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExercisePreview } from '../src/App';

const exercise = {
  id: 'incline-press-day-1',
  exerciseId: 'incline-press',
  name: 'Press inclinado en máquina',
  imageUrl: undefined,
  imagePosition: undefined,
  sets: 3,
  repMin: 8,
  repMax: 12,
  restSeconds: 120,
  warmupSets: 0,
  active: true,
  progressionRule: 'double_progression' as const,
  loadIncrementKg: 2.5,
};

describe('tarjeta previa de ejercicio', () => {
  it('ordena el contenido para lectura rápida en móvil', () => {
    const html = renderToStaticMarkup(React.createElement(ExercisePreview, {
      exercise,
      index: 0,
      muscleGroup: 'Pecho',
      progressionAction: {
        tone: 'positive',
        title: 'Próxima vez: prueba 42,5 kg',
        detail: 'Has alcanzado el máximo de repeticiones.',
      },
      lastSession: {
        ...exercise,
        plannedExerciseId: 'history-1',
        progressionPolicy: 'double',
        progressionIncrementKg: 2.5,
        completed: true,
        difficulty: 'good',
        actualWeightKg: 40,
        actualReps: 12,
        discomfort: false,
        setLogs: [],
      },
      onOpenDetails: () => undefined,
    }));

    expect(html).toContain('exercise-preview-heading');
    expect(html).toContain('exercise-meta');
    expect(html).toContain('next-action');
    expect(html.indexOf('exercise-preview-heading')).toBeLessThan(html.indexOf('next-action'));
  });
});
