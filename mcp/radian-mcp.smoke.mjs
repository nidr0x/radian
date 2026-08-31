import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { tmpdir } from 'node:os';
import { TOOL_DEFINITIONS, handleMessage, resolveDataFile } from './radian-mcp.mjs';

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'radian-mcp-'));
const fixturePath = join(fixtureDirectory, 'radian-backup.json');
const fixture = {
  app: 'radian',
  exportedAt: '2026-08-31T10:00:00.000Z',
  data: {
    schemaVersion: 7,
    profile: { goal: 'ganar fuerza', gym: 'Evanfit', trainingDays: [1, 3], sessionMinutes: 60, experienceLevel: 'intermediate', currentWeightKg: 80 },
    exercises: [
      { id: 'chest-press', name: 'Press de pecho', aliases: ['bench'], muscleGroup: 'Pecho' },
      { id: 'lat-pulldown', name: 'Jalón al pecho', aliases: ['jalón'], muscleGroup: 'Espalda' },
    ],
    plan: {
      id: 'main-plan',
      version: 2,
      days: [
        { id: 'monday', weekday: 1, shortLabel: 'L', name: 'Pecho', focus: 'Pecho', exercises: [{ id: 'mon-1', exerciseId: 'chest-press', name: 'Press de pecho', active: true, sets: 3, repMin: 8, repMax: 12, restSeconds: 120 }] },
        { id: 'wednesday', weekday: 3, shortLabel: 'X', name: 'Espalda', focus: 'Espalda', exercises: [{ id: 'wed-1', exerciseId: 'lat-pulldown', name: 'Jalón al pecho', active: true, sets: 3, repMin: 8, repMax: 12, restSeconds: 120 }] },
      ],
    },
    sessions: [
      {
        id: 'session-2026-08-27',
        workoutDayId: 'monday',
        dateKey: '2026-08-27',
        startedAt: '2026-08-27T17:00:00.000Z',
        completedAt: '2026-08-27T18:00:00.000Z',
        status: 'completed',
        activeExerciseIndex: 0,
        plannedExercises: [{
          plannedExerciseId: 'mon-1', exerciseId: 'chest-press', name: 'Press de pecho', sets: 3, repMin: 8, repMax: 12, completed: true, discomfort: false,
          setLogs: [
            { setNumber: 1, phase: 'warmup', targetReps: 8, actualReps: 8, weightKg: 20, completed: true },
            { setNumber: 2, phase: 'work', targetReps: 8, actualReps: 8, weightKg: 60, completed: true },
            { setNumber: 3, phase: 'work', targetReps: 8, actualReps: 9, weightKg: 60, completed: true },
            { setNumber: 4, phase: 'work', targetReps: 8, actualReps: 8, weightKg: 60, completed: true },
          ],
        }],
      },
    ],
    progress: [{ id: 'weight-1', date: '2026-08-27', weightKg: 80, waistCm: 88 }],
    checkins: [],
  },
};

writeFileSync(fixturePath, JSON.stringify(fixture));
after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

const request = (method, params = {}, id = 1) => handleMessage({ jsonrpc: '2.0', id, method, params }, fixturePath);
const toolCall = (name, arguments_ = {}) => request('tools/call', { name, arguments: arguments_ });

test('expone herramientas MCP deterministas y resuelve el archivo configurado', () => {
  assert.equal(TOOL_DEFINITIONS.length, 10);
  assert.equal(request('tools/list').result.tools[0].name, 'get_profile');
  assert.equal(resolveDataFile(['--data', './radian-backup.json'], {}, fixtureDirectory), fixturePath);
  assert.equal(resolveDataFile([], { RADIAN_DATA_FILE: './radian-backup.json' }, fixtureDirectory), fixturePath);
});

test('consulta el historial de un ejercicio por alias y periodo', () => {
  const response = toolCall('exercise_history', { exercise: 'bench', from: '2026-08-01', to: '2026-08-31' });
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.returned, 1);
  assert.equal(response.result.structuredContent.matches[0].sets[1].weightKg, 60);
  assert.equal(response.result.structuredContent.matches[0].volumeKg, 1500);
});

test('devuelve detalle serie a serie, 1RM estimado y balance muscular', () => {
  const workout = toolCall('get_workout', { id: 'session-2026-08-27' });
  assert.equal(workout.result.structuredContent.exercises[0].setLogs.length, 3);
  assert.equal(workout.result.structuredContent.completedWorkSets, 3);

  const oneRm = toolCall('estimate_1rm', { exercise: 'press de pecho' });
  assert.equal(oneRm.result.structuredContent.estimates[0].estimated1rmKg, 78);
  assert.equal(oneRm.result.structuredContent.estimates[0].reps, 9);

  const balance = toolCall('muscle_balance', { period: 'all_time' });
  assert.equal(balance.result.structuredContent.muscles[0].muscleGroup, 'Pecho');
  assert.equal(balance.result.structuredContent.muscles[0].sets, 3);
});

test('los errores de datos se entregan como resultado MCP legible', () => {
  const response = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_workouts' } }, join(fixtureDirectory, 'missing.json'));
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /backup local/);
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'not_a_tool' } }, fixturePath).error.code, -32602);
});

test('sirve initialize, tools/list y tools/call por stdio', () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'exercise_history', arguments: { exercise: 'bench', period: 'all_time' } } },
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, ['./mcp/radian-mcp.mjs', '--data', fixturePath], { cwd: process.cwd(), input: `${input}\n`, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[1].result.tools.length, 10);
  assert.equal(responses[2].result.structuredContent.matches[0].date, '2026-08-27');
});
