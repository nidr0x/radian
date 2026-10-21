import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExercisePreview } from '../src/components/ExercisePreview';

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
      onOpenDetails: () => undefined,
    }));

    expect(html).toContain('exercise-preview-heading');
    expect(html).toContain('exercise-meta');
    expect(html).toContain('exercise-card-chevron');
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('tabindex="0"');
    expect(html).not.toContain('last-feedback');
    expect(html).not.toContain('next-action');
  });

  it('muestra la referencia previa y la sugerencia cuando hay datos', () => {
    const html = renderToStaticMarkup(React.createElement(ExercisePreview, {
      exercise,
      index: 0,
      muscleGroup: 'Pecho',
      cue: { last: '40 kg · 10 reps', next: 'prueba 42,5 kg', hint: 'Dos sesiones fáciles seguidas.' },
      onOpenDetails: () => undefined,
    }));

    expect(html).toContain('exercise-preview-cue');
    expect(html).toContain('Última vez · 40 kg · 10 reps');
    expect(html).toContain('prueba 42,5 kg');
    expect(html).toContain('Dos sesiones fáciles seguidas.');
  });
});
