import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TrainingSignalsCard } from '../src/views/ProgressView';
import type { TrainingSignal } from '../src/lib/recommendations';

const signal: TrainingSignal = {
  exerciseId: 'incline-press',
  name: 'Press inclinado en máquina',
  kind: 'fatigue',
  tone: 'caution',
  title: 'Señal de fatiga',
  detail: 'Dos de las últimas tres exposiciones fueron difíciles o incompletas. Mantén o descarga antes de progresar.',
  evidence: {
    sessionCount: 3,
    latestDate: '2026-10-20',
    oldestDate: '2026-10-06',
    hardOrIncompleteCount: 2,
    discomfortCount: 0,
  },
};

describe('tarjeta de señales de entrenamiento', () => {
  it('muestra las señales con su evidencia fuera del bloque plegado', () => {
    const html = renderToStaticMarkup(React.createElement(TrainingSignalsCard, { signals: [signal] }));

    expect(html).toContain('signal-card');
    expect(html).toContain('Señales a revisar');
    expect(html).toContain('Press inclinado en máquina');
    expect(html).toContain('Dos de las últimas tres exposiciones');
    expect(html).toContain('3 sesiones · 2026-10-20');
  });

  it('no muestra tarjeta cuando no hay señales', () => {
    expect(renderToStaticMarkup(React.createElement(TrainingSignalsCard, { signals: [] }))).toBe('');
  });
});
