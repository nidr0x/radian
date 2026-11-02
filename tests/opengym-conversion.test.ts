import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertRadianBackup, migrateFiles } from '../scripts/migrate-radian-to-opengym.mjs';
import { defaultData } from '../src/data/initialPlan';
import { convertRadianBackupState } from '../src/lib/radian-conversion.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/opengym/radian-backup.json', import.meta.url), 'utf8'));
const currentFixture = JSON.parse(readFileSync(new URL('./fixtures/opengym/radian-backup-v7.json', import.meta.url), 'utf8'));
const legacyStateFixture = JSON.parse(readFileSync(new URL('./fixtures/opengym/radian-idb-state-v1.json', import.meta.url), 'utf8'));
const idbStateFixture = JSON.parse(readFileSync(new URL('./fixtures/opengym/radian-idb-state-v7.json', import.meta.url), 'utf8'));
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(item => canonical(item)).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'undefined';
const withTempDirectory = (callback: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'opengym-migration-'));
  try { callback(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
};

describe('conversor local Radian → openGym', () => {
  it('preserva cuenta e IDs, convierte entrenamiento y no importa energía/molestias', () => {
    const migrated = convertRadianBackup(fixture, 'account-fixture');

    expect(migrated.accountId).toBe('account-fixture');
    expect(migrated.state.routines[0]).toMatchObject({ id: 'day-fixture', ex: [{ id: 'custom-row', reps: '6-8' }] });
    expect(migrated.state.workouts[0]).toMatchObject({ id: 'session-fixture', routineId: 'day-fixture', entries: [{ id: 'custom-row', sets: [{ r: 8, w: 40, done: true, phase: 'work' }] }] });
    expect(migrated.state.bodyweight).toEqual([{ id: 'progress-fixture', d: '2020-01-01', w: 75, unit: 'kg' }]);
    expect(migrated.state.measurements).toEqual([{ id: 'progress-fixture', d: '2020-01-01', waist: 80, chest: 100, unit: 'cm' }]);
    expect(JSON.stringify(migrated.state)).not.toMatch(/readiness|soreness|discomfort|checkins|energy/i);
  });

  it('es idempotente para la misma copia y la misma cuenta', () => {
    expect(convertRadianBackup(fixture, 'account-fixture')).toEqual(convertRadianBackup(fixture, 'account-fixture'));
    expect(convertRadianBackup(fixture, 'account-fixture').migrationId).not.toBe(convertRadianBackup(fixture, 'account-other').migrationId);
  });

  it('no duplica ejercicios integrados ni transfiere campos de perfil no compatibles', () => {
    const backup = structuredClone(fixture);
    backup.data.exercises.push({ id: 'chest-press', name: 'Press de pecho', muscleGroup: 'Pecho', equipment: 'machine' });

    const { state } = convertRadianBackup(backup, 'account-fixture');
    expect(state.customEx.map(exercise => exercise.id)).toEqual(['custom-row']);
    expect(state.theme).toBe('dark');
    expect(state).not.toHaveProperty('radianProfile');
    expect(state).not.toHaveProperty('nutritionContext');
  });

  it('rechaza forma y cuenta inválidas antes de producir estado', () => {
    expect(() => convertRadianBackup({}, 'account-fixture')).toThrow('unsupported_radian_backup');
    expect(() => convertRadianBackup(fixture, 'bad')).toThrow('invalid_migration_input');
  });

  it('acepta solo backups Radian con versiones legacy 1 y actual 7 justificadas', () => {
    expect(convertRadianBackup(fixture, 'account_A').state.routines[0].id).toBe('day-fixture');
    expect(convertRadianBackup(currentFixture, 'account_A').state.routines[0].id).toBe('day-beta');
    for (const schemaVersion of [2, 6, 8, 1.5, '7']) {
      const unsupported = structuredClone(currentFixture);
      unsupported.data.schemaVersion = schemaVersion;
      expect(() => convertRadianBackup(unsupported, 'account_A')).toThrow('unsupported_radian_backup');
    }
    expect(() => convertRadianBackup({ ...currentFixture, app: 'another-app' }, 'account_A'))
      .toThrow('unsupported_radian_backup');
    expect(() => convertRadianBackup({
      ...currentFixture,
      data: { ...currentFixture.data, plan: { id: 'plan-without-days' } },
    }, 'account_A')).toThrow('unsupported_radian_backup');
  });

  it('acepta la forma cruda usada por la migración local y conserva igualdad con el backup v7', () => {
    const legacyState = convertRadianBackupState(legacyStateFixture);
    expect(legacyState).toMatchObject({
      routines: [{ id: 'guest-routine', ex: [{ id: 'guest-row' }] }],
      workouts: [{ id: 'guest-workout', routineId: 'guest-routine', entries: [{ sets: [
        { n: 1, r: 9, w: 40, done: true, phase: 'warmup' },
        { n: 2, r: 9, w: 40, done: true, phase: 'work' },
        { n: 3, r: 9, w: 40, done: true, phase: 'work' },
        { n: 4, r: 9, w: 40, done: true, phase: 'work' },
      ] }] }],
      bodyweight: [{ id: 'guest-weight', w: 75, unit: 'kg' }],
    });
    expect(convertRadianBackupState(idbStateFixture)).toEqual(convertRadianBackupState(currentFixture));
    expect(convertRadianBackupState(idbStateFixture)).not.toHaveProperty('active');
    expect(convertRadianBackupState(idbStateFixture)).not.toHaveProperty('accountId');
  });

  it('expande una entrada antigua sin setLogs con el resumen legacy y concilia las filas resultantes', () => {
    const backup = structuredClone(fixture);
    const exercise = backup.data.sessions[0].plannedExercises[0];
    delete exercise.setLogs;
    Object.assign(exercise, { sets: 3, warmupSets: 1, actualWeightKg: 40, actualReps: 10, completed: true });

    const migrated = convertRadianBackup(backup, 'account_A');
    const sets = migrated.state.workouts[0].entries[0].sets;
    expect(sets).toHaveLength(4);
    expect(sets.map(set => set.n)).toEqual([1, 2, 3, 4]);
    expect(sets[0]).toMatchObject({ r: 10, w: 40, done: true, phase: 'warmup' });
    expect(sets.slice(1).every(set => set.r === 10 && set.w === 40 && set.done && set.phase === 'work')).toBe(true);
    expect(migrated.reconciliation.sessionSets).toEqual({ source: 4, converted: 4 });
  });

  it('usa las series de la prescripción por defecto para una sesión legacy sin sets', () => {
    const fallbackPlanned = new Map(defaultData().plan.days.flatMap(day => day.exercises)
      .map(exercise => [exercise.exerciseId, exercise]));
    const backup = structuredClone(fixture);
    const exercise = backup.data.sessions[0].plannedExercises[0];
    Object.assign(exercise, { exerciseId: 'triceps-pushdown', actualWeightKg: 30, actualReps: 8, completed: true });
    delete exercise.setLogs;
    delete exercise.sets;
    delete exercise.warmupSets;
    const prescribedSets = fallbackPlanned.get('triceps-pushdown')?.sets ?? 3;

    expect(prescribedSets).toBe(2);
    const migrated = convertRadianBackup(backup, 'account_A');
    const sets = migrated.state.workouts[0].entries[0].sets;
    expect(sets).toHaveLength(prescribedSets);
    expect(sets.every(set => set.r === 8 && set.w === 30 && set.done && set.phase === 'work')).toBe(true);
    expect(migrated.reconciliation.sessionSets).toEqual({ source: prescribedSets, converted: prescribedSets });
  });

  it('concilia IDs, relaciones, orden, fechas y unidades sin inferir referencias huérfanas', () => {
    const { state } = convertRadianBackup(currentFixture, 'account_A');
    expect(state.routines.map(routine => routine.id)).toEqual(['day-beta', 'day-alpha']);
    expect(state.routines[0].ex.map(exercise => exercise.id)).toEqual(['custom-deadlift']);
    expect(state.workouts.map(workout => workout.id)).toEqual(['session-beta', 'session-orphan']);
    expect(state.workouts[0]).toMatchObject({ id: 'session-beta', d: '2020-01-01', routineId: 'day-beta', name: 'Example workout' });
    expect(state.workouts[0].entries[0]).toMatchObject({ id: 'custom-deadlift', plannedExerciseId: 'slot-beta' });
    expect(state.workouts[0].entries[0].sets.map(set => set.n)).toEqual([2, 1]);
    expect(state.workouts[0].entries[0].sets[0]).toMatchObject({ r: 5, w: 40, phase: 'work' });
    expect(state.workouts[1]).toMatchObject({ d: '2020-01-01', routineId: 'removed-day', name: 'Example workout' });
    expect(state.workouts[1].entries[0]).toMatchObject({ id: 'removed-exercise', plannedExerciseId: 'removed-slot' });
    expect(state.bodyweight).toEqual([{ id: 'progress-current', d: '2020-01-01', w: 75, unit: 'kg' }]);
    expect(state.measurements).toEqual([{ id: 'progress-current', d: '2020-01-01', waist: 80, arm: 32, unit: 'cm' }]);
  });

  it('emite el formato de workout y series que consumen los stores openGym', () => {
    const { state } = convertRadianBackup(currentFixture, 'account_A');
    const workout = state.workouts[0];
    const [workSet, warmupSet] = workout.entries[0].sets;

    expect(workout).toMatchObject({
      start: Date.parse('2020-01-01T10:00:00.000Z'),
      end: Date.parse('2020-01-01T10:30:00.000Z'),
    });
    expect(typeof workout.start).toBe('number');
    expect(typeof workout.end).toBe('number');
    expect(workout).not.toHaveProperty('t');
    expect(workSet).toMatchObject({ n: 2, r: 5, w: 40, done: true, phase: 'work' });
    expect(warmupSet).toMatchObject({ n: 1, r: 8, w: 40, done: true, phase: 'warmup' });
    expect(workSet).not.toHaveProperty('reps');
    expect(workSet).not.toHaveProperty('type');
  });

  it('mantiene determinismo por cuenta y separa el destino A del B', () => {
    const first = convertRadianBackup(currentFixture, 'account_A');
    expect(convertRadianBackup(currentFixture, 'account_A')).toEqual(first);
    const accountB = convertRadianBackup(currentFixture, 'account_B');
    expect(accountB.stateChecksum).toBe(first.stateChecksum);
    expect(accountB.migrationId).not.toBe(first.migrationId);
    expect(accountB.accountId).toBe('account_B');
  });

  it('rechaza un entrenamiento sin fecha importable antes de emitir estado o conciliación', () => {
    const invalid = structuredClone(currentFixture);
    invalid.data.sessions.push({
      id: 'session-invalid-timestamp',
      dateKey: '2026-02-30',
      startedAt: '2026-04-09T99:30:00.000Z',
      status: 'in_progress',
      plannedExercises: [],
    });
    expect(() => convertRadianBackupState(invalid)).toThrow('unimportable_radian_session');
    expect(() => convertRadianBackup(invalid, 'account_A')).toThrow('unimportable_radian_session');

    withTempDirectory(directory => {
      const inputPath = join(directory, 'invalid-session.json');
      const outputPath = join(directory, 'opengym.json');
      const rollbackPath = join(directory, 'rollback.json');
      const sourceText = JSON.stringify(invalid);
      writeFileSync(inputPath, sourceText);
      expect(() => migrateFiles({ inputPath, outputPath, rollbackPath, accountId: 'account_A' }))
        .toThrow('unimportable_radian_session');
      expect(readFileSync(inputPath, 'utf8')).toBe(sourceText);
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(rollbackPath)).toBe(false);
    });
  });

  it('migra desde archivos temporales con checksum y rollback byte por byte, sin sobreescribir', () => {
    withTempDirectory(directory => {
      const inputPath = join(directory, 'source.json');
      const outputPath = join(directory, 'opengym.json');
      const rollbackPath = join(directory, 'radian-rollback.json');
      const sourceBytes = readFileSync(new URL('./fixtures/opengym/radian-backup-v7.json', import.meta.url));
      writeFileSync(inputPath, sourceBytes);

      const result = migrateFiles({ inputPath, outputPath, rollbackPath, accountId: 'account_A' });
      const output = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(output).toMatchObject({ format: 'radian-to-opengym/v1', accountId: 'account_A' });
      expect(result.sourceChecksum).toBe(sha256(canonical(currentFixture)));
      expect(output.stateChecksum).toBe(sha256(canonical(output.state)));
      expect(result.stateChecksum).toBe(output.stateChecksum);
      expect(output.rollback.checksum).toBe(sha256(sourceBytes));
      expect(readFileSync(rollbackPath)).toEqual(sourceBytes);
      expect(readFileSync(inputPath)).toEqual(sourceBytes);

      const previousOutput = readFileSync(outputPath, 'utf8');
      expect(() => migrateFiles({ inputPath, outputPath, rollbackPath, accountId: 'account_A' }))
        .toThrow('migration_output_exists');
      expect(readFileSync(outputPath, 'utf8')).toBe(previousOutput);
      expect(readFileSync(rollbackPath)).toEqual(sourceBytes);
      expect(readFileSync(inputPath)).toEqual(sourceBytes);
    });
  });

  it('limpia rollback parcial al fallar la escritura de salida y no altera la fuente corrupta', () => {
    withTempDirectory(directory => {
      const sourceText = readFileSync(new URL('./fixtures/opengym/radian-backup-v7.json', import.meta.url), 'utf8');
      const inputPath = join(directory, 'source.json');
      const rollbackPath = join(directory, 'rollback.json');
      const outputPath = join(directory, 'missing', 'opengym.json');
      writeFileSync(inputPath, sourceText);

      expect(() => migrateFiles({ inputPath, outputPath, rollbackPath, accountId: 'account_A' })).toThrow();
      expect(existsSync(rollbackPath)).toBe(false);
      expect(existsSync(outputPath)).toBe(false);
      expect(readFileSync(inputPath, 'utf8')).toBe(sourceText);

      const corruptPath = join(directory, 'corrupt.json');
      const corruptText = '{"app":"radian","data":';
      writeFileSync(corruptPath, corruptText);
      expect(() => migrateFiles({
        inputPath: corruptPath,
        outputPath: join(directory, 'corrupt-output.json'),
        rollbackPath: join(directory, 'corrupt-rollback.json'),
        accountId: 'account_A',
      })).toThrow();
      expect(readFileSync(corruptPath, 'utf8')).toBe(corruptText);
      expect(existsSync(join(directory, 'corrupt-output.json'))).toBe(false);
      expect(existsSync(join(directory, 'corrupt-rollback.json'))).toBe(false);
    });
  });

  it('rechaza UTF-8 inválido antes de crear outputs y conserva los bytes de origen', () => {
    withTempDirectory(directory => {
      const sourceBytes = Buffer.from(readFileSync(new URL('./fixtures/opengym/radian-backup-v7.json', import.meta.url)));
      const marker = sourceBytes.indexOf(Buffer.from('Fixture Deadlift'));
      expect(marker).toBeGreaterThanOrEqual(0);
      sourceBytes[marker] = 0xff;

      const inputPath = join(directory, 'invalid-utf8.json');
      const outputPath = join(directory, 'opengym.json');
      const rollbackPath = join(directory, 'rollback.json');
      writeFileSync(inputPath, sourceBytes);
      expect(() => migrateFiles({ inputPath, outputPath, rollbackPath, accountId: 'account_A' }))
        .toThrow('invalid_radian_backup_encoding');
      expect(readFileSync(inputPath)).toEqual(sourceBytes);
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(rollbackPath)).toBe(false);
    });
  });
});
