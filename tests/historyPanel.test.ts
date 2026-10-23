import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HistoryPanel } from '../src/views/ProgressView';
import { defaultData } from '../src/data/initialPlan';
import { createSession } from '../src/lib/storage';

describe('panel de historial y mejores cargas', () => {
  it('muestra mejores cargas, volume por grupo y sesiones del mes fuera del bloque plegado', () => {
    const data = defaultData();
    const session = createSession(data.plan.days[0], '2026-10-05', new Date('2026-10-05T10:00:00.000Z'));
    session.status = 'completed';
    session.completedAt = '2026-10-05T11:00:00.000Z';
    session.plannedExercises[0].difficulty = 'good';
    session.plannedExercises[0].setLogs.filter((set) => set.phase !== 'warmup').forEach((set) => { set.weightKg = 60; set.actualReps = 8; set.completed = true; });
    data.sessions = [session];

    const html = renderToStaticMarkup(React.createElement(HistoryPanel, { data }));

    expect(html).toContain('Lo que está cambiando');
    expect(html).toContain('mejores cargas');
    expect(html).toContain('Press inclinado en máquina');
    expect(html).toContain('volumen por grupo');
    expect(html).toContain('mes anterior');
  });

  it('mantiene los estados vacíos orientados a registrar datos', () => {
    const html = renderToStaticMarkup(React.createElement(HistoryPanel, { data: defaultData() }));

    expect(html).toContain('Registra peso y repeticiones para ver tus marcas.');
    expect(html).toContain('Aún no hay volumen calculable.');
  });
});
