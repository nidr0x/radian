import { describe, expect, it } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { adaptPlanToEquipment, allExerciseEquipment, compatibleAlternatives, exerciseMatches, planEquipmentGaps, unresolvedPlanEquipmentGaps } from '../src/lib/exercises';
import { detectTrainingSignals, progressionAction, progressionCue, recommendationFor } from '../src/lib/recommendations';
import { isWorkSet, nextPrescription } from '../src/lib/progression';
import { bestRecordForExercise, detectPersonalRecord } from '../src/lib/records';
import { summarizeSession } from '../src/lib/sessionSummary';
import { createSession, createSetLogs, migrateData, parseBackup, serializeBackup, snapshotMatchesPlan } from '../src/lib/storage';
import { exerciseTrend } from '../src/lib/exerciseHistory';
import { buildWeeklySummary, weeklySummaryText } from '../src/lib/weeklySummary';
import { compareSyncCopies, syncCopySummary } from '../src/lib/sync';
import { syncDecision } from '../src/lib/syncRecovery';
import { sessionAdaptation } from '../src/lib/sessionAdaptation';
import { scheduledWorkoutDays } from '../src/lib/date';
import type { WorkoutSession } from '../src/types';

describe('motor de recomendaciones', () => {
  it('recomienda progresar después de dos sesiones fáciles', () => {
    const sessions = [
      completedSession('a', '2026-08-10', 'easy'),
      completedSession('b', '2026-08-17', 'easy'),
    ];
    expect(recommendationFor('incline-press', sessions)?.label).toBe('Progresar');
  });

  it('calcula una indicación de carga usando la última sesión', () => {
    const sessions = [
      completedSession('a', '2026-08-10', 'easy'),
      completedSession('b', '2026-08-17', 'easy'),
    ];
    sessions.forEach((session) => {
      session.plannedExercises[0].actualWeightKg = 40;
      session.plannedExercises[0].setLogs[0].weightKg = 40;
      session.plannedExercises[0].setLogs[0].completed = true;
    });
    expect(progressionCue('incline-press', sessions)).toContain('40 kg');
  });

  it('propone una acción concreta para la próxima sesión', () => {
    const sessions = [
      completedSession('a', '2026-08-10', 'easy'),
      completedSession('b', '2026-08-17', 'easy'),
    ];
    sessions.forEach((session) => {
      session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 12, weightKg: 40, completed: true }));
    });

    expect(progressionAction('incline-press', sessions)).toMatchObject({
      tone: 'positive',
      title: 'Próxima vez: prueba 42,5 kg',
    });
  });

  it('sube de repeticiones antes de subir la carga', () => {
    const session = completedSession('a', '2026-08-17', 'good');
    session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 9, weightKg: 40, completed: true }));
    const plan = nextPrescription(session.plannedExercises[0], [session]);
    expect(plan).toMatchObject({ status: 'rep', targetReps: 10, nextWeightKg: 40 });
  });

  it('descarga tras tres sesiones atascadas consecutivas', () => {
    const sessions = [
      completedSession('a', '2026-08-01', 'hard'),
      completedSession('b', '2026-08-08', 'incomplete'),
      completedSession('c', '2026-08-15', 'hard'),
    ];
    sessions.forEach((session) => session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 6, weightKg: 50, completed: true })));
    expect(nextPrescription(sessions[0].plannedExercises[0], sessions)).toMatchObject({ status: 'deload', nextWeightKg: 45 });
  });

  it('no sube una progresión lineal si no alcanza el mínimo de repeticiones', () => {
    const session = completedSession('a', '2026-08-17', 'good');
    session.plannedExercises[0].progressionPolicy = 'linear';
    session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 6, weightKg: 40, completed: true }));
    expect(nextPrescription(session.plannedExercises[0], [session])).toMatchObject({ status: 'hold', nextWeightKg: 40 });
  });

  it('bloquea la progresión cuando hay molestias', () => {
    const session = completedSession('a', '2026-08-17', 'easy');
    session.plannedExercises[0].discomfort = true;
    expect(recommendationFor('incline-press', [session])?.label).toBe('Revisar');
  });

  it('propone ajustar tras varios ejercicios no completados', () => {
    const sessions = [
      completedSession('a', '2026-08-01', 'incomplete'),
      completedSession('b', '2026-08-08', 'incomplete'),
      completedSession('c', '2026-08-15', 'good'),
    ];
    expect(recommendationFor('incline-press', sessions)?.label).toBe('Ajustar');
  });

  it('detecta un estancamiento solo tras tres exposiciones estables', () => {
    const data = defaultData();
    const sessions = [
      completedSession('a', '2026-08-01', 'good'),
      completedSession('b', '2026-08-08', 'good'),
      completedSession('c', '2026-08-15', 'good'),
    ];
    sessions.forEach((session) => session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 10, weightKg: 40, completed: true })));
    data.sessions = sessions;

    expect(detectTrainingSignals(data)).toContainEqual(expect.objectContaining({
      kind: 'plateau',
      exerciseId: 'incline-press',
      evidence: expect.objectContaining({ sessionCount: 3, latestDate: '2026-08-15' }),
    }));
  });

  it('distingue fatiga reciente del estancamiento', () => {
    const data = defaultData();
    const sessions = [
      completedSession('a', '2026-08-01', 'hard'),
      completedSession('b', '2026-08-08', 'incomplete'),
      completedSession('c', '2026-08-15', 'hard'),
    ];
    sessions.forEach((session) => {
      session.plannedExercises[0].discomfort = session.id !== 'a';
      session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 7, weightKg: 40, completed: true }));
    });
    data.sessions = sessions;

    expect(detectTrainingSignals(data)[0]).toMatchObject({ kind: 'fatigue', exerciseId: 'incline-press' });
  });

  it('resume recomendaciones semanales concretas a partir del historial', () => {
    const data = defaultData();
    const sessions = [
      completedSession('a', '2026-08-10', 'easy'),
      completedSession('b', '2026-08-17', 'easy'),
    ];
    sessions.forEach((session) => session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 12, weightKg: 40, completed: true })));
    data.sessions = sessions;

    const summary = buildWeeklySummary(data, new Date('2026-08-20T12:00:00'));
    const recommendation = summary.recommendations.find((item) => item.exerciseId === 'incline-press');

    expect(recommendation).toMatchObject({ tone: 'positive', title: 'Próxima vez: prueba 42,5 kg' });
    expect(weeklySummaryText(data, new Date('2026-08-20T12:00:00'))).toContain('RECOMENDACIONES PARA LA PRÓXIMA SEMANA');
  });

  it('compara las cuatro semanas y la fuerza con una referencia equivalente', () => {
    const data = defaultData();
    const previous = completedSession('previous', '2026-08-10', 'good');
    const current = completedSession('current', '2026-08-17', 'good');
    previous.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 10, weightKg: 40, completed: true }));
    current.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 10, weightKg: 42.5, completed: true }));
    data.sessions = [previous, current];
    const summary = buildWeeklySummary(data, new Date('2026-08-20T12:00:00'));
    expect(summary.trends).toHaveLength(4);
    expect(summary.trends.at(-1)).toMatchObject({ sessions: 1, volumeKg: 1275 });
    expect(summary.strengthChanges).toContainEqual(expect.objectContaining({ name: current.plannedExercises[0].name, previousKg: 40, currentKg: 42.5, changePercent: 6 }));
  });
});

describe('decisiones de sincronización', () => {
  it('distingue descarga, subida y conflicto usando el último checkpoint', () => {
    const base = defaultData();
    const local = structuredClone(base);
    const remote = structuredClone(base);
    const checkpoint = { userId: 'user-1', version: 'v1', snapshot: JSON.stringify(base), syncedAt: '2026-09-01T10:00:00.000Z' };
    local.profile.gym = 'Local';
    remote.profile.gym = 'Remoto';
    expect(syncDecision(base, remote, 'v2', checkpoint, 'user-1')).toBe('download');
    remote.profile.gym = base.profile.gym;
    expect(syncDecision(local, remote, 'v1', checkpoint, 'user-1')).toBe('upload');
    remote.profile.gym = 'Remoto';
    expect(syncDecision(local, remote, 'v2', checkpoint, 'user-1')).toBe('conflict');
  });

  it('resume las dos copias para decidir un conflicto sin exponer sus datos', () => {
    const local = defaultData();
    const remote = structuredClone(local);
    local.sessions = [completedSession('local', '2026-09-08', 'good')];
    local.progress = [{ id: 'local-progress', date: '2026-09-08', weightKg: 80 }];
    remote.sessions = [completedSession('remote-1', '2026-09-06', 'good'), completedSession('remote-2', '2026-09-07', 'easy')];
    remote.progress = [{ id: 'remote-progress', date: '2026-09-07', waistCm: 90 }];

    expect(syncCopySummary(local)).toEqual({ sessionCount: 1, progressCount: 1, checkinCount: 0, latestSessionDate: '2026-09-08', latestProgressDate: '2026-09-08' });
    expect(syncCopySummary(remote)).toEqual({ sessionCount: 2, progressCount: 1, checkinCount: 0, latestSessionDate: '2026-09-07', latestProgressDate: '2026-09-07' });
  });

  it('identifica las áreas realmente distintas entre dos copias', () => {
    const local = defaultData();
    const remote = structuredClone(local);
    remote.profile.gym = 'Remoto';
    remote.plan.days[0].name = 'Rutina remota';
    remote.sessions = [completedSession('remote', '2026-09-07', 'good')];
    remote.checkins = [{ id: 'remote-checkin', weekKey: '2026-W36', energy: 'normal', feeling: 'bien', completedWorkouts: 1, note: '', createdAt: '2026-09-07T10:00:00.000Z' }];

    expect(compareSyncCopies(local, remote)).toMatchObject({
      changed: { profile: true, routine: true, sessions: true, progress: false, checkins: true },
      local: { sessionCount: 0 },
      remote: { sessionCount: 1, checkinCount: 1 },
    });
  });
});

describe('persistencia y backups', () => {
  it('aplica los días elegidos a las plantillas sin cambiar sus identificadores', () => {
    const data = defaultData();
    const scheduled = scheduledWorkoutDays(data.plan.days, [2, 4]);
    expect(scheduled.map((day) => day.weekday)).toEqual([2, 4]);
    expect(scheduled.map((day) => day.id)).toEqual([data.plan.days[0].id, data.plan.days[1].id]);
    expect(scheduledWorkoutDays(data.plan.days, [7])[0]?.weekday).toBe(0);
  });

  it('empieza con un perfil neutro y medidas opcionales', () => {
    const data = defaultData();
    expect(data.profile.heightCm).toBeUndefined();
    expect(data.profile.currentWeightKg).toBeUndefined();
    expect(data.profile.goal).toBe('');
    expect(data.profile.gym).toBe('');
    expect(data.profile.nutritionContext).toBe('');
    expect(data.profile.availableEquipment).toEqual(allExerciseEquipment);
  });

  it('adapta una sesión nueva sin mutar la rutina base', () => {
    const data = defaultData();
    const baseExercise = data.plan.days[0].exercises[0];
    const session = createSession(data.plan.days[0], '2026-08-19', new Date('2026-08-19T10:00:00Z'), [], { energy: 'low', soreness: 'high' });

    expect(sessionAdaptation(session.readiness)).toMatchObject({ mode: 'recovery' });
    expect(session.plannedExercises[0]).toMatchObject({ sets: 2, repMin: 8, repMax: 8, restSeconds: 180, progressionStatus: 'hold' });
    expect(session.plannedExercises[0].progressionReason).toContain('recuperación');
    expect(data.plan.days[0].exercises[0]).toMatchObject({ sets: baseExercise.sets, repMax: baseExercise.repMax, restSeconds: baseExercise.restSeconds });
  });

  it('migra el equipamiento disponible y conserva todos los materiales en perfiles antiguos', () => {
    const data = defaultData();
    expect(migrateData({ ...data, profile: { ...data.profile, availableEquipment: ['machine', 'cable', 'unknown'] } }).profile.availableEquipment).toEqual(['machine', 'cable']);
    expect(migrateData({ ...data, profile: { ...data.profile, availableEquipment: undefined } }).profile.availableEquipment).toEqual(allExerciseEquipment);
  });

  it('conserva las medidas de un perfil antiguo al migrarlo', () => {
    const data = defaultData();
    const restored = migrateData({
      ...data,
      profile: { ...data.profile, heightCm: 180, currentWeightKg: 82, goal: 'Fuerza' },
    });
    expect(restored.profile).toMatchObject({ heightCm: 180, currentWeightKg: 82, goal: 'Fuerza' });
  });

  it('conserva una instantánea de la rutina al crear una sesión', () => {
    const data = defaultData();
    const day = data.plan.days[0];
    const session = createSession(day, '2026-08-19', new Date('2026-08-19T10:00:00Z'));
    const changed = { ...day.exercises[0], sets: 5 };
    expect(snapshotMatchesPlan(session, day.exercises[0])).toBe(true);
    expect(snapshotMatchesPlan(session, changed)).toBe(false);
    expect(session.plannedExercises[0].sets).toBe(3);
  });

  it('guarda el check-in de recuperación sin romper el esquema actual', () => {
    const data = defaultData();
    const session = createSession(data.plan.days[0], '2026-08-19', new Date('2026-08-19T10:00:00Z'), [], {
      energy: 'low',
      soreness: 'some',
    });

    expect(session.readiness).toEqual({ energy: 'low', soreness: 'some' });
    expect(migrateData({ ...data, sessions: [session] }).sessions[0].readiness).toEqual(session.readiness);
    expect(migrateData({ ...data, sessions: [{ ...session, readiness: undefined }] }).sessions[0].readiness).toBeUndefined();
  });

  it('construye una tendencia por ejercicio con carga máxima, repeticiones y volumen', () => {
    const first = completedSession('first', '2026-08-10', 'good');
    const second = completedSession('second', '2026-08-17', 'easy');
    [first, second].forEach((session, index) => {
      session.plannedExercises[0].difficulty = index === 0 ? 'good' : 'easy';
      session.plannedExercises[0].discomfort = index === 1;
      session.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, {
        actualReps: index === 0 ? 8 : 10,
        weightKg: index === 0 ? 35 : 40,
        completed: true,
      }));
    });

    expect(exerciseTrend('incline-press', [second, first])).toEqual([
      { date: '2026-08-10', maxWeightKg: 35, maxReps: 8, volumeKg: 840, difficulty: 'good', discomfort: false },
      { date: '2026-08-17', maxWeightKg: 40, maxReps: 10, volumeKg: 1200, difficulty: 'easy', discomfort: true },
    ]);
  });

  it('redondea un export y lo puede importar con su esquema', () => {
    const data = defaultData();
    const restored = parseBackup(serializeBackup(data));
    expect(restored.schemaVersion).toBe(7);
    expect(restored.plan.days).toHaveLength(4);
  });

  it('reanuda una sesión en curso después de migrar', () => {
    const data = defaultData();
    const session = createSession(data.plan.days[0], '2026-08-19');
    const restored = migrateData({ ...data, sessions: [session] });
    expect(restored.sessions[0].status).toBe('in_progress');
    expect(restored.sessions[0].activeExerciseIndex).toBe(0);
  });

  it('completa las imágenes al migrar datos creados antes de la función visual', () => {
    const legacy = JSON.parse(JSON.stringify(defaultData())) as ReturnType<typeof defaultData>;
    legacy.schemaVersion = 1;
    legacy.exercises = legacy.exercises.map(({ imageUrl: _imageUrl, ...exercise }) => exercise);
    legacy.plan.days = legacy.plan.days.map((day) => ({
      ...day,
      exercises: day.exercises.map(({ imageUrl: _imageUrl, ...exercise }) => exercise),
    }));

    const migrated = migrateData(legacy);
    expect(migrated.schemaVersion).toBe(7);
    expect(migrated.exercises.find((exercise) => exercise.id === 'incline-press')?.imageUrl).toBe('/exercises/individual/incline-press.webp');
    expect(migrated.exercises.find((exercise) => exercise.id === 'incline-press')?.imagePosition).toBe('');
    expect(migrated.exercises.find((exercise) => exercise.id === 'incline-press')?.equipment).toBe('machine');
    expect(migrated.plan.days[0].exercises[0].imageUrl).toBe('/exercises/individual/incline-press.webp');
    expect(migrated.plan.days[0].exercises[0].imagePosition).toBe('');
  });

  it('crea una fila por serie al preparar una sesión', () => {
    const data = defaultData();
    const session = createSession(data.plan.days[0], '2026-08-19');
    expect(session.plannedExercises[0].setLogs).toHaveLength(4);
    expect(session.plannedExercises[0].setLogs[0]).toMatchObject({ setNumber: 1, phase: 'warmup', targetReps: 8, completed: false });
    expect(session.plannedExercises[0].setLogs.filter(isWorkSet)).toHaveLength(3);
  });

  it('carga las últimas repeticiones al preparar la siguiente sesión', () => {
    const data = defaultData();
    const previous = createSession(data.plan.days[0], '2026-08-17');
    previous.status = 'completed';
    previous.completedAt = '2026-08-17T11:00:00.000Z';
    previous.plannedExercises[0].completed = true;
    previous.plannedExercises[0].difficulty = 'good';
    previous.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 10, weightKg: 40, completed: true }));

    const next = createSession(data.plan.days[0], '2026-08-24', new Date('2026-08-24T10:00:00.000Z'), [previous]);
    expect(next.plannedExercises[0].setLogs.filter(isWorkSet)[0]).toMatchObject({ actualReps: 10, weightKg: 40, completed: false });
  });

  it('autorrellena una sesión nueva sin marcar sus series como completadas', () => {
    const previous = createSession(defaultData().plan.days[0], '2026-08-17');
    previous.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 10, weightKg: 40, completed: true }));
    const copied = createSetLogs(3, 8, previous.plannedExercises[0].setLogs, previous.plannedExercises[0], { copyCompleted: false });
    expect(copied.filter(isWorkSet)[0]).toMatchObject({ actualReps: 10, weightKg: 40, completed: false });
  });

  it('migra cargas antiguas a todas las filas de serie', () => {
    const data = defaultData();
    const session = createSession(data.plan.days[0], '2026-08-19');
    const legacyExercise = { ...session.plannedExercises[0], setLogs: undefined, actualWeightKg: 42.5, actualReps: 10, completed: true };
    const migrated = migrateData({ ...data, sessions: [{ ...session, plannedExercises: [legacyExercise, ...session.plannedExercises.slice(1)] }] });
    expect(migrated.sessions[0].plannedExercises[0].setLogs).toHaveLength(4);
    expect(migrated.sessions[0].plannedExercises[0].setLogs[0]).toMatchObject({ weightKg: 42.5, actualReps: 10, completed: true });
  });
});

describe('biblioteca y récords', () => {
  it('filtra por texto, músculo y material y prioriza alternativas compatibles', () => {
    const data = defaultData();
    expect(exerciseMatches(data.exercises.find((exercise) => exercise.id === 'cable-fly')!, 'crossover', 'Pecho', 'cable')).toBe(true);
    expect(exerciseMatches(data.exercises.find((exercise) => exercise.id === 'cable-fly')!, 'crossover', 'Pecho', 'machine')).toBe(false);
    expect(compatibleAlternatives(data.exercises, 'incline-press')[0].id).toBe('chest-press');
    expect(compatibleAlternatives(data.exercises, 'incline-press', ['cable']).map((exercise) => exercise.id)).toEqual(['cable-fly']);
    expect(compatibleAlternatives(data.exercises, 'incline-press', ['machine']).map((exercise) => exercise.id)).toEqual(['chest-press']);
  });

  it('adapta los bloques iniciales al material disponible', () => {
    const data = defaultData();
    const adapted = adaptPlanToEquipment(data.plan, data.exercises, ['machine']);
    const cableFly = adapted.days[0].exercises.find((exercise) => exercise.id === 'mon-3');
    const replacement = data.exercises.find((exercise) => exercise.id === cableFly?.exerciseId);
    expect(cableFly?.exerciseId).toBe('cable-fly');
    expect(replacement?.equipment).toBe('cable');
  });

  it('explica qué ejercicios de la rutina ya no encajan antes de adaptar el plan', () => {
    const data = defaultData();
    const gaps = planEquipmentGaps(data.plan, data.exercises, ['machine']);

    expect(gaps.find((gap) => gap.exerciseId === 'cable-fly')).toMatchObject({
      dayName: 'Pecho, hombros, tríceps',
      exerciseName: 'Aperturas en polea',
      replacement: undefined,
    });
    expect(gaps.find((gap) => gap.exerciseId === 'triceps-pushdown')).toMatchObject({
      dayName: 'Pecho, hombros, tríceps',
      exerciseName: 'Extensión de tríceps en polea',
      replacement: undefined,
    });
  });

  it('evita duplicar ejercicios al adaptar una rutina al material disponible', () => {
    const data = defaultData();
    const adapted = adaptPlanToEquipment(data.plan, data.exercises, ['machine']);
    const monday = adapted.days.find((day) => day.id === 'monday');
    const activeIds = monday?.exercises.filter((exercise) => exercise.active).map((exercise) => exercise.exerciseId) ?? [];

    expect(new Set(activeIds).size).toBe(activeIds.length);
    expect(monday?.exercises.find((exercise) => exercise.id === 'mon-3')).toMatchObject({ exerciseId: 'cable-fly', name: 'Aperturas en polea' });
  });

  it('devuelve sólo los ejercicios que requieren revisión manual', () => {
    const data = defaultData();

    expect(unresolvedPlanEquipmentGaps(data.plan, data.exercises, ['machine']).filter((gap) => gap.dayId === 'monday').map((gap) => gap.exerciseId)).toEqual(['cable-fly', 'triceps-pushdown', 'overhead-triceps']);
  });

  it('detecta una nueva mejor carga respecto al histórico', () => {
    const data = defaultData();
    const previous = completedSession('previous', '2026-08-17', 'good');
    previous.plannedExercises[0].setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 10, weightKg: 40, completed: true }));
    const current = createSession(data.plan.days[0], '2026-08-24').plannedExercises[0];
    current.completed = true;
    current.setLogs.filter(isWorkSet).forEach((set) => Object.assign(set, { actualReps: 8, weightKg: 42.5, completed: true }));
    expect(bestRecordForExercise([previous], current.exerciseId)).toMatchObject({ maxWeightKg: 40 });
    expect(detectPersonalRecord(current, [previous])).toMatchObject({ kind: 'weight', weightKg: 42.5 });
  });
});

describe('resumen semanal', () => {
  it('solo incluye la semana actual y reúne señales para revisarla', () => {
    const data = defaultData();
    const current = createSession(data.plan.days[0], '2026-08-18', new Date('2026-08-18T10:00:00Z'));
    current.status = 'completed';
    current.completedAt = '2026-08-18T11:00:00.000Z';
    current.plannedExercises[0].completed = true;
    current.plannedExercises[0].difficulty = 'easy';
    const currentWorkSet = current.plannedExercises[0].setLogs.find(isWorkSet);
    if (!currentWorkSet) throw new Error('Expected a work set');
    Object.assign(currentWorkSet, { actualReps: 10, weightKg: 40, completed: true });
    const older = createSession(data.plan.days[0], '2026-08-10', new Date('2026-08-10T10:00:00Z'));
    older.status = 'completed';
    older.completedAt = '2026-08-10T11:00:00.000Z';
    older.plannedExercises[0].difficulty = 'hard';
    data.sessions = [older, current];
    data.progress = [{ id: 'progress-current', date: '2026-08-18', weightKg: 70, waistCm: 90 }];
    data.checkins = [{ id: 'checkin-current', weekKey: '2026-08-17', createdAt: '2026-08-20T12:00:00.000Z', feeling: 'Mejor de lo esperado', energy: 'high', completedWorkouts: 1 }];

    const summary = buildWeeklySummary(data, new Date('2026-08-20T12:00:00'));

    expect(summary.completedSessions).toBe(1);
    expect(summary.completedExercises).toBe(1);
    expect(summary.volumeKg).toBe(400);
    expect(summary.difficultyCounts.easy).toBe(1);
    expect(summary.difficultyCounts.hard).toBe(0);
    expect(summary.energy).toBe('high');
    expect(weeklySummaryText(data, new Date('2026-08-20T12:00:00'))).toContain('1/4 sesiones completadas');
  });

  it('incluye contexto del gimnasio y detalle por ejercicio en el resumen semanal', () => {
    const data = defaultData();
    data.profile.gym = 'Evanfit Picanya';
    const session = createSession(data.plan.days[0], '2026-08-18', new Date('2026-08-18T10:00:00Z'));
    session.status = 'completed';
    session.completedAt = '2026-08-18T11:00:00.000Z';
    session.plannedExercises[0].completed = true;
    session.plannedExercises[0].difficulty = 'good';
    const workSet = session.plannedExercises[0].setLogs.find(isWorkSet);
    if (!workSet) throw new Error('Expected a work set');
    Object.assign(workSet, { actualReps: 10, weightKg: 40, completed: true });
    data.sessions = [session];

    const text = weeklySummaryText(data, new Date('2026-08-20T12:00:00'));

    expect(text).toContain('Gimnasio: Evanfit Picanya');
    expect(text).toContain('DETALLE DE EJERCICIOS');
    expect(text).toContain('Press inclinado en máquina');
    expect(text).toContain('40 kg × 10 reps');
  });

  it('ordena las medidas por fecha aunque el almacenamiento llegue desordenado', () => {
    const data = defaultData();
    data.progress = [
      { id: 'newer', date: '2026-08-20', weightKg: 79 },
      { id: 'older', date: '2026-08-18', weightKg: 80 },
    ];
    const summary = buildWeeklySummary(data, new Date('2026-08-20T12:00:00'));
    expect(summary.weightStart).toBe(80);
    expect(summary.weightEnd).toBe(79);
    expect(weeklySummaryText(data, new Date('2026-08-20T12:00:00'))).toContain('Peso actual: 79 kg');
  });
});

describe('resumen de sesión', () => {
  it('calcula duración, volumen y récords frente al historial', () => {
    const previous = completedSession('previous', '2026-08-10', 'good');
    const previousSet = previous.plannedExercises[0].setLogs.find(isWorkSet);
    if (!previousSet) throw new Error('Expected a previous work set');
    Object.assign(previousSet, { actualReps: 10, weightKg: 35, completed: true });

    const current = completedSession('current', '2026-08-18', 'good');
    current.startedAt = '2026-08-18T10:00:00.000Z';
    current.completedAt = '2026-08-18T11:05:00.000Z';
    const currentSet = current.plannedExercises[0].setLogs.find(isWorkSet);
    if (!currentSet) throw new Error('Expected a current work set');
    Object.assign(currentSet, { actualReps: 8, weightKg: 40, completed: true });

    const summary = summarizeSession(current, [previous, current]);

    expect(summary).toMatchObject({ completedExercises: 1, totalExercises: current.plannedExercises.length, completedWorkSets: 1, volumeKg: 320, durationSeconds: 3900 });
    expect(summary.records[0]?.event.kind).toBe('weight');
  });
});

function completedSession(id: string, date: string, difficulty: 'easy' | 'good' | 'hard' | 'incomplete'): WorkoutSession {
  const data = defaultData();
  const session = createSession(data.plan.days[0], date, new Date(`${date}T10:00:00Z`));
  session.id = id;
  session.status = 'completed';
  session.completedAt = `${date}T11:00:00.000Z`;
  session.plannedExercises[0].completed = difficulty !== 'incomplete';
  session.plannedExercises[0].difficulty = difficulty;
  session.plannedExercises[0].completedAt = session.completedAt;
  return session;
}
