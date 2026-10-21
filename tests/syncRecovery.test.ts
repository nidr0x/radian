import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { dataRevisionFromVersion, dataVersion, preserveRecovery, readCheckpoint, readRecovery, saveCheckpoint, syncDecision } from '../src/lib/syncRecovery';
import { clearStorageFailure, createSession, getStorageFailure, parseBackup, serializeBackup } from '../src/lib/storage';
import type { AppData } from '../src/types';

describe('versión local de sincronización', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mantiene el snapshot real y distingue cambios con los mismos contadores', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const defaults = defaultData();
    const base = { ...defaults, sessions: [createSession(defaults.plan.days[0], '2026-10-09')] };
    const checkpointVersion = dataVersion(base, 4);

    saveCheckpoint('user-1', 'remote-v2', base, checkpointVersion);

    const checkpoint = readCheckpoint();
    const changed = structuredClone(base);
    changed.sessions[0].plannedExercises[0].setLogs[0].weightKg = 22.5;
    expect(checkpoint).toMatchObject({ version: 'remote-v2', localVersion: checkpointVersion, snapshot: JSON.stringify(base) });
    expect(dataVersion(changed, 5)).not.toBe(checkpointVersion);
    expect(dataRevisionFromVersion(checkpointVersion)).toBe(4);
    expect(syncDecision(changed, base, 'remote-v2', checkpoint, 'user-1')).toBe('upload');
  });
});

describe('copia de recuperación', () => {
  const stubStorage = () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    return values;
  };

  const sampleData = (): AppData => ({ ...defaultData(), sessions: [createSession(defaultData().plan.days[0], '2026-10-09', new Date('2026-10-09T09:00:00.000Z'))] });

  afterEach(() => {
    clearStorageFailure();
    vi.unstubAllGlobals();
  });

  it('grava la copia sin la codificación intermedia de texto y la recupera', () => {
    const values = stubStorage();
    const data = sampleData();
    const copy = preserveRecovery(data);
    const [, raw] = [...values.entries()][0];
    const stored = JSON.parse(raw);
    expect(stored.backup).toEqual({ app: 'radian', exportedAt: expect.any(String), data });
    expect(typeof copy?.backup).toBe('string');
    expect(parseBackup(copy?.backup ?? '').sessions).toEqual(data.sessions);

    const recovered = readRecovery();
    expect(recovered?.savedAt).toBe(copy?.savedAt);
    expect(parseBackup(recovered?.backup ?? '').sessions).toEqual(data.sessions);
  });

  it('sigue leyendo las copias antiguas con el backup codificado como texto', () => {
    const values = stubStorage();
    preserveRecovery(sampleData());
    const recoveryKey = [...values.keys()][0];
    const data = sampleData();
    const legacy = { savedAt: '2026-10-01T00:00:00.000Z', backup: serializeBackup(data) };
    values.set(recoveryKey, JSON.stringify(legacy));

    const recovered = readRecovery();
    expect(recovered?.savedAt).toBe(legacy.savedAt);
    expect(recovered?.backup).toBe(legacy.backup);
    expect(parseBackup(recovered?.backup ?? '').sessions).toEqual(data.sessions);
  });

  it('no lanza cuando la escritura de la copia de recuperación falla', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError: almacenamiento lleno'); },
    });
    expect(preserveRecovery(sampleData())).toBeUndefined();
    expect(getStorageFailure()).toMatchObject({ message: 'QuotaExceededError: almacenamiento lleno' });
  });

  it('saveCheckpoint también es best-effort', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('boom'); },
    });
    expect(() => saveCheckpoint('user-1', 'v1', sampleData(), '0')).not.toThrow();
    expect(getStorageFailure()).toMatchObject({ message: 'boom' });
  });
});
