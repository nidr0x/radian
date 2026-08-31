import { describe, expect, it } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { compatibleAlternatives, exerciseMatches } from '../src/lib/exercises';
import { progressionAction, progressionCue, recommendationFor } from '../src/lib/recommendations';
import { isWorkSet, nextPrescription } from '../src/lib/progression';
import { bestRecordForExercise, detectPersonalRecord } from '../src/lib/records';
import { summarizeSession } from '../src/lib/sessionSummary';
import { createSession, createSetLogs, migrateData, parseBackup, serializeBackup, snapshotMatchesPlan } from '../src/lib/storage';
import { buildWeeklySummary, weeklySummaryText } from '../src/lib/weeklySummary';
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

  it('incluye contexto del gimnasio y detalle por ejercicio para revisarlo con ChatGPT', () => {
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
