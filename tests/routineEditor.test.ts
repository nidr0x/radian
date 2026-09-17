import { describe, expect, it } from 'vitest';
import { routineEditDraftFrom, routineEditPatch } from '../src/lib/routineEditor';

describe('borrador de edición de rutina', () => {
  it('normaliza los valores opcionales de una rutina antigua al abrir el editor', () => {
    expect(routineEditDraftFrom({
      id: 'planned-1',
      exerciseId: 'press',
      name: 'Press',
      sets: 3,
      repMin: 8,
      repMax: 10,
      restSeconds: 90,
      active: true,
    })).toEqual({
      exerciseId: 'press',
      name: 'Press',
      sets: 3,
      repMin: 8,
      repMax: 10,
      restSeconds: 90,
      warmupSets: 0,
      progressionPolicy: 'double',
      progressionIncrementKg: 2.5,
      imageUrl: undefined,
      imagePosition: undefined,
    });
  });

  it('convierte un borrador guardado en un cambio completo de rutina', () => {
    expect(routineEditPatch({
      exerciseId: 'row',
      name: 'Remo sentado',
      sets: 4,
      repMin: 6,
      repMax: 8,
      restSeconds: 120,
      warmupSets: 1,
      progressionPolicy: 'linear',
      progressionIncrementKg: 5,
      imageUrl: '/row.webp',
      imagePosition: 'center',
    })).toEqual({
      exerciseId: 'row',
      name: 'Remo sentado',
      sets: 4,
      repMin: 6,
      repMax: 8,
      restSeconds: 120,
      warmupSets: 1,
      progressionPolicy: 'linear',
      progressionIncrementKg: 5,
      imageUrl: '/row.webp',
      imagePosition: 'center',
    });
  });
});
