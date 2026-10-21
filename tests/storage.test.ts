import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { recordSessionIds } from '../src/lib/records';
import {
  SESSION_HISTORY_MAX_CHARS,
  SESSION_HISTORY_MAX_SESSIONS,
  STORAGE_KEY,
  clearStorageFailure,
  createSession,
  getStorageFailure,
  loadData,
  persistData,
  pruneSessionHistory,
  subscribeStorageFailure,
  writeStoredValue,
} from '../src/lib/storage';
import type { ExerciseSession, WorkoutSession } from '../src/types';

const stubStorage = (options: { failContents?: boolean } = {}) => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.failContents) throw new Error('QuotaExceededError: almacenamiento lleno');
      values.set(key, value);
    },
  });
  return values;
};

const historySession = (id: string, pad = ''): WorkoutSession => ({ id, workoutDayId: 'day', dateKey: id, startedAt: id, status: 'completed', plannedExercises: [], activeExerciseIndex: 0, pad } as unknown as WorkoutSession);

const sessionChars = (session: WorkoutSession): number => JSON.stringify(session).length + 1;

describe('poda del historial de sesiones', () => {
  it('mantiene el array intacto cuando entra en ambos límites', () => {
    const sessions = [historySession('s1'), historySession('s2'), historySession('s3')];
    expect(pruneSessionHistory(sessions)).toBe(sessions);
  });

  it('poda las sesiones más antiguas al exceder el límite de recuento', () => {
    const sessions = [historySession('s1'), historySession('s2'), historySession('s3'), historySession('s4'), historySession('s5')];
    expect(pruneSessionHistory(sessions, 3)).toEqual([sessions[2], sessions[3], sessions[4]]);
    expect(pruneSessionHistory(sessions, SESSION_HISTORY_MAX_SESSIONS)).toBe(sessions);
  });

  it('respeta el presupuesto de caracteres y conserva solo el sufijo más reciente', () => {
    const sessions = [historySession('s1', 'uno'), historySession('s2'), historySession('s3')];
    const budget = sessionChars(sessions[2]) + sessionChars(sessions[1]);
    const kept = pruneSessionHistory(sessions, SESSION_HISTORY_MAX_SESSIONS, budget);
    expect(kept).toEqual([sessions[1], sessions[2]]);
    expect(kept.reduce((total, session) => total + sessionChars(session), 0)).toBeLessThanOrEqual(budget);
  });

  it('conserva siempre la sesión más reciente aunque exceda por sí sola el presupuesto', () => {
    const sessions = [historySession('s1'), historySession('s2')];
    expect(pruneSessionHistory(sessions, SESSION_HISTORY_MAX_SESSIONS, 0)).toEqual([sessions[1]]);
    expect(pruneSessionHistory(sessions, 0)).toEqual([sessions[1]]);
  });

  it('no devuelve un array vacío ni con límites extremos', () => {
    const sessions = [historySession('s1'), historySession('s2')];
    const kept = pruneSessionHistory(sessions, SESSION_HISTORY_MAX_SESSIONS, -5);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[kept.length - 1]).toEqual(sessions[sessions.length - 1]);
  });

  it('mantiene la sesión fijada aunque el límite de recuento la descartaría', () => {
    const sessions = [historySession('s1'), historySession('s2'), historySession('s3'), historySession('s4')];
    const kept = pruneSessionHistory(sessions, 2, SESSION_HISTORY_MAX_CHARS, ['s1']);
    expect(kept).toEqual([sessions[0], sessions[2], sessions[3]]);
  });

  it('el presupuesto de caracteres no descuenta las sesiones fijadas', () => {
    const sessions = [historySession('s1', 'uno'), historySession('s2', 'dos'), historySession('s3')];
    const budget = sessionChars(sessions[2]);
    const kept = pruneSessionHistory(sessions, SESSION_HISTORY_MAX_SESSIONS, budget, ['s1']);
    expect(kept).toEqual([sessions[0], sessions[2]]);
  });

  it('identifica la sesión con la mejor carga por ejercicio para fijarla', () => {
    const recordSession = historySession('s1');
    const recordExercise = { exerciseId: 'bench-press', setLogs: [{ setNumber: 1, phase: 'work' as const, targetReps: 8, actualReps: 5, weightKg: 95, completed: true }] } as unknown as ExerciseSession;
    (recordSession as { plannedExercises: ExerciseSession[] }).plannedExercises = [recordExercise];
    const lighter = { exerciseId: 'bench-press', setLogs: [{ setNumber: 1, phase: 'work' as const, targetReps: 8, actualReps: 5, weightKg: 80, completed: true }] } as unknown as ExerciseSession;
    const sessions = [
      recordSession,
      historySession('s2'),
      { ...historySession('s3'), plannedExercises: [lighter] } as unknown as WorkoutSession,
    ];
    expect(recordSessionIds(sessions)).toEqual(['s1']);
    expect(pruneSessionHistory(sessions, 1, SESSION_HISTORY_MAX_CHARS, recordSessionIds(sessions)).map((session) => session.id)).toEqual(['s1', 's3']);
  });
});

describe('persistencia observable', () => {
  beforeEach(() => clearStorageFailure());
  afterEach(() => vi.unstubAllGlobals());

  it('grava la copia podada sin alterar el resto de datos ni el estado en memoria', () => {
    const values = stubStorage();
    const base = defaultData();
    const baseSession = createSession(base.plan.days[0], '2026-01-01');
    const data = {
      ...base,
      progress: [{ id: 'p1', date: '2026-01-05' }],
      checkins: [{ id: 'c1', weekKey: '2026-W01', createdAt: '2026-01-05T00:00:00.000Z', feeling: 'Bien', energy: 'normal' as const, completedWorkouts: 3 }],
      sessions: Array.from({ length: 170 }, (_, index) => {
        const copy = structuredClone(baseSession);
        copy.id = `session-${String(index).padStart(4, '0')}`;
        copy.dateKey = '2026-01-01';
        return copy;
      }),
    };
    const expected = pruneSessionHistory(data.sessions);
    expect(expected.length).toBeLessThan(data.sessions.length);

    expect(persistData(data)).toBe(true);

    const stored = JSON.parse(values.get(STORAGE_KEY) ?? '{}');
    expect(stored.sessions).toEqual(expected);
    expect(data.sessions.length).toBe(170);
    expect(stored.progress).toEqual(data.progress);
    expect(stored.checkins).toEqual(data.checkins);
    expect(stored.profile).toEqual(data.profile);
    expect(stored.plan).toEqual(data.plan);
  });

  it('recarga la copia podada guardada en el dispositivo', () => {
    stubStorage();
    const base = defaultData();
    const baseSession = createSession(base.plan.days[0], '2026-01-01');
    const data = {
      ...base,
      sessions: Array.from({ length: 150 }, (_, index) => {
        const copy = structuredClone(baseSession);
        copy.id = `session-${String(index).padStart(4, '0')}`;
        return copy;
      }),
    };
    persistData(data);
    expect(loadData().sessions.length).toEqual(pruneSessionHistory(data.sessions).length);
  });

  it('registra el fallo y avisa a los suscriptores cuando la escritura falla', () => {
    stubStorage({ failContents: true });
    const failures: Array<ReturnType<typeof getStorageFailure>> = [];
    const unsubscribe = subscribeStorageFailure((failure) => failures.push(failure));
    expect(persistData(defaultData())).toBe(false);
    const failure = getStorageFailure();
    expect(failure).toMatchObject({ message: 'QuotaExceededError: almacenamiento lleno' });
    expect(Number.isFinite(Date.parse(failure?.at ?? ''))).toBe(true);
    expect(failures.at(-1)).toEqual(failure);
    unsubscribe();
  });

  it('limpia el fallo cuando la persistencia vuelve a funcionar', () => {
    stubStorage({ failContents: true });
    const failures: Array<ReturnType<typeof getStorageFailure>> = [];
    subscribeStorageFailure((failure) => failures.push(failure));
    expect(persistData(defaultData())).toBe(false);
    expect(failures.at(-1)).toMatchObject({ message: 'QuotaExceededError: almacenamiento lleno' });

    stubStorage();
    expect(persistData(defaultData())).toBe(true);
    expect(getStorageFailure()).toBeUndefined();
    expect(failures.at(-1)).toBeUndefined();
  });

  it('registra fallos ortogonales de otras claves sin impedir el resto de escrituras', () => {
    let failNext = true;
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failNext) { failNext = false; throw new Error('fallo ajeno al persist'); }
        values.set(key, value);
      },
    });
    clearStorageFailure();
    expect(writeStoredValue('otra-clave', 'x')).toBe(false);
    expect(writeStoredValue('otra-clave', 'y')).toBe(true);
    expect(getStorageFailure()).toMatchObject({ message: 'fallo ajeno al persist' });
    expect(values.get('otra-clave')).toBe('y');
  });
});
