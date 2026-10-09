import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { dataRevisionFromVersion, dataVersion, readCheckpoint, saveCheckpoint, syncDecision } from '../src/lib/syncRecovery';
import { createSession } from '../src/lib/storage';

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
