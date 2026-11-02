import { currentWeekday, dateKey, scheduledWorkoutDays, weekKey } from '../../src/lib/date';
import { compatibleAlternatives, equipmentLabel } from '../../src/lib/exercises';
import { migrateData } from '../../src/lib/storage';
import { detectTrainingSignals, progressionAction, recommendationFor } from '../../src/lib/recommendations';
import { isWorkSet, nextPrescription, type ProgressionPlan } from '../../src/lib/progression';
import { summarizeSession } from '../../src/lib/sessionSummary';
import { sessionAdaptation } from '../../src/lib/sessionAdaptation';
import { buildWeeklySummary, weeklySummaryText } from '../../src/lib/weeklySummary';
import { readReceipt, receiptStatement, requestFingerprint } from './mcpReceipts';
import type { AppData, ExerciseSession, ProgressEntry, WorkoutSession } from '../../src/types';
import { hasMcpScope, MCP_WRITE_SCOPE } from './mcpAuth';
import { validateMcpAppData, validateMcpAppDataWithHistoricalSessions, validateMcpWriteOperation } from './mcpWrite';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  McpLoadedUserData,
  McpMutationResult,
  McpPendingChangeRow,
  McpPreviewableChange,
  McpRevisionRow,
  McpWorkoutValidationContext,
  McpWriteOperation,
} from '../types';

const PERIODS = ['this_week', 'last_week', 'last_7_days', 'this_month', 'all_time'] as const;
type Period = typeof PERIODS[number];
const PENDING_CHANGE_TTL_MS = 10 * 60 * 1000;

interface UserDataRow { payload: string; updatedAt: string }
interface McpConflictResult { error: 'conflict'; message: string; updatedAt: string | null; data: AppData | null }
interface McpNeedsVersionResult { error: 'needs_version'; message: string; updatedAt: string | null; data: AppData | null }
interface McpConfirmationRequiredResult { error: 'confirmation_required'; message: string }
interface McpChangeUnavailableResult { error: 'change_unavailable'; message: string }
interface McpPreviewResult { changeId: string; expiresAt: string; summary: Record<string, unknown> }
interface RevisionSummary { id: string; source: string; createdAt: string; expiresAt: string; restoredAt: string | null }
interface PreviewChangeRequest {
  baseUpdatedAt?: string;
  kind: McpPreviewableChange['kind'];
  workoutId?: string;
  measurementId?: string;
  checkinId?: string;
  data?: AppData;
}

export type McpWriteResult =
  | McpMutationResult
  | McpConflictResult
  | McpNeedsVersionResult
  | McpPreviewResult
  | McpConfirmationRequiredResult
  | McpChangeUnavailableResult
  | { revisions: RevisionSummary[] };

export const MCP_AUDIT_TOOL_DEFINITION = {
  name: 'get_change_history',
  title: 'Consultar cambios del MCP',
  description: 'Lista las últimas 100 operaciones aplicadas desde la activación de la auditoría, con fecha, cliente y revisión recuperable cuando existe. No devuelve datos de entrenamiento.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'get_profile',
    title: 'Leer contexto de entrenamiento',
    description: 'Lee el objetivo, gimnasio, días, duración, nivel y medidas actuales del usuario autenticado.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_weekly_coach',
    title: 'Revisar la semana',
    description: 'Resume adherencia, sensaciones, volumen, medidas y recomendaciones concretas para la próxima semana.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_workouts',
    title: 'Listar entrenamientos',
    description: 'Devuelve entrenamientos completados con fecha, sesión, ejercicios, volumen y dificultad.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'exercise_history',
    title: 'Consultar historial de ejercicio',
    description: 'Busca un ejercicio por nombre o alias y devuelve sus registros serie a serie.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', minLength: 1 },
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['exercise'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bodyweight',
    title: 'Consultar peso y medidas',
    description: 'Devuelve medidas corporales registradas y el peso actual del perfil.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS, default: 'all_time' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_recommendations',
    title: 'Consultar próxima progresión',
    description: 'Devuelve las acciones sugeridas para los ejercicios activos según el historial del usuario.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_next_session',
    title: 'Preparar próximo entrenamiento',
    description: 'Devuelve la sesión que toca hoy o la siguiente disponible, con la prescripción de cada ejercicio. Solo lectura.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_chat_context',
    title: 'Preparar contexto para ChatGPT',
    description: 'Devuelve en una sola lectura el perfil, la revisión semanal, el próximo entrenamiento y las recomendaciones actuales para que un asistente pueda ayudarte sin varias llamadas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_equipment_alternatives',
    title: 'Buscar alternativas por material',
    description: 'Busca sustituciones del mismo grupo muscular usando únicamente el equipamiento disponible en el perfil.',
    inputSchema: {
      type: 'object',
      properties: {
        exercise: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
      },
      required: ['exercise'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_recommendation',
    title: 'Explicar una recomendación',
    description: 'Explica la próxima acción de un ejercicio con el histórico reciente, la evidencia disponible y alternativas que sí puedes hacer.',
    inputSchema: {
      type: 'object',
      properties: { exercise: { type: 'string', minLength: 1 } },
      required: ['exercise'],
      additionalProperties: false,
    },
  },
  {
    name: 'estimate_1rm',
    title: 'Estimar 1RM',
    description: 'Estima el 1RM con la fórmula de Epley a partir de series completadas con peso y repeticiones. Con exercise omitido devuelve una tabla.',
    inputSchema: {
      type: 'object',
      properties: { exercise: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'muscle_balance',
    title: 'Consultar balance muscular',
    description: 'Resume series de trabajo y volumen por grupo muscular en el periodo solicitado.',
    inputSchema: {
      type: 'object',
      properties: { period: { type: 'string', enum: PERIODS, default: 'this_week' } },
      additionalProperties: false,
    },
  },
];

export const MCP_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'update_profile',
    title: 'Actualizar perfil',
    description: 'Actualiza solo los campos permitidos del perfil usando una versión base obligatoria.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
        profile: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'profile'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_routine',
    title: 'Reemplazar rutina',
    description: 'Sustituye el plan completo y su catálogo explícito de ejercicios con control optimista de versión.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
        plan: { type: 'object' },
        exercises: { type: 'array' },
      },
      required: ['baseUpdatedAt', 'plan', 'exercises'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_workout',
    title: 'Registrar entrenamiento',
    description: 'Crea una sesión completada nueva validada contra el plan y catálogo autenticados, con ID generado por el servidor.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
        workout: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'workout'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_measurement',
    title: 'Añadir medición',
    description: 'Añade una entrada de progreso sin tocar el resto de la cuenta y exige versión base.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
        entry: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'entry'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_checkin',
    title: 'Añadir check-in semanal',
    description: 'Hace upsert semanal por weekKey con una única escritura condicional y sin duplicados.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
        checkin: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'checkin'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_change',
    title: 'Preparar cambio destructivo',
    description: 'Previsualiza un borrado o reemplazo total, y guarda una propuesta temporal ligada al usuario, cliente y versión base.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        change: { type: 'object' },
      },
      required: ['baseUpdatedAt', 'change'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_change',
    title: 'Aplicar cambio destructivo',
    description: 'Aplica una propuesta destructiva pendiente solo cuando llega confirmada explícitamente.',
    inputSchema: {
      type: 'object',
      properties: {
        changeId: { type: 'string', minLength: 1 },
        confirm: { type: 'boolean' },
      },
      required: ['changeId', 'confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_revisions',
    title: 'Listar revisiones recuperables',
    description: 'Devuelve las revisiones activas de los últimos 30 días para la cuenta autenticada.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'restore_revision',
    title: 'Restaurar revisión',
    description: 'Restaura una revisión recuperable usando control optimista de versión y crea una nueva versión activa.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUpdatedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
        revisionId: { type: 'string', minLength: 1 },
      },
      required: ['baseUpdatedAt', 'revisionId'],
      additionalProperties: false,
    },
  },
] as const;

const MCP_READ_TOOL_NAMES = new Set<string>(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
const MCP_WRITE_TOOL_NAMES = new Set<string>(MCP_WRITE_TOOL_DEFINITIONS.map((tool) => tool.name));

export const listMcpToolsForScope = (scope: string) => hasMcpScope(scope, MCP_WRITE_SCOPE)
  ? [...MCP_TOOL_DEFINITIONS, MCP_AUDIT_TOOL_DEFINITION, ...MCP_WRITE_TOOL_DEFINITIONS]
  : [...MCP_TOOL_DEFINITIONS, MCP_AUDIT_TOOL_DEFINITION];

export const isMcpReadTool = (name: string): boolean => MCP_READ_TOOL_NAMES.has(name);
export const isMcpWriteTool = (name: string): boolean => MCP_WRITE_TOOL_NAMES.has(name);

const withVersion = (value: Record<string, unknown>, updatedAt?: string): Record<string, unknown> => updatedAt ? { ...value, updatedAt } : value;

const normalizeLoadedData = (loaded: AppData | null | McpLoadedUserData): McpLoadedUserData => {
  if (!loaded) return { data: null };
  return 'data' in loaded ? loaded : { data: loaded };
};

export const loadMcpUserData = async (database: D1DatabaseLike, userId: string): Promise<McpLoadedUserData> => {
  const row = await database.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?').bind(userId).first<UserDataRow>();
  if (!row) return { data: null };
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return { data: validateMcpAppDataWithHistoricalSessions(migrateData(parsed)), updatedAt: row.updatedAt };
  } catch {
    throw new Error('Los datos de Radian guardados en la nube no se pueden leer.');
  }
};

const conflictResult = (loaded: McpLoadedUserData): McpConflictResult => ({
  error: 'conflict',
  message: loaded.data
    ? 'Hay una copia más reciente en otro dispositivo.'
    : 'La copia autenticada ya no está disponible en D1.',
  updatedAt: loaded.updatedAt ?? null,
  data: loaded.data ?? null,
});

const needsVersionResult = (loaded: McpLoadedUserData): McpNeedsVersionResult => ({
  error: 'needs_version',
  message: 'Esta mutación requiere baseUpdatedAt de la fila autenticada actual.',
  updatedAt: loaded.updatedAt ?? null,
  data: loaded.data ?? null,
});

const oauthOwnershipConflictResult = (): McpConflictResult => ({
  error: 'conflict',
  message: 'El cliente OAuth no tiene una vinculación activa de escritura para este usuario.',
  updatedAt: null,
  data: null,
});

const hasActiveWriteOwnership = async (database: D1DatabaseLike, userId: string, clientId: string): Promise<boolean> => {
  const row = await database.prepare(
    `SELECT 1 AS authorized
       FROM mcp_tokens
      WHERE user_id = ?
        AND client_id = ?
        AND token_type = 'access'
        AND expires_at > ?
        AND revoked_at IS NULL
        AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
      LIMIT 1`,
  ).bind(userId, clientId, new Date().toISOString(), MCP_WRITE_SCOPE).first<{ authorized: number }>();
  return row?.authorized === 1;
};

const confirmationRequiredResult = (): McpConfirmationRequiredResult => ({
  error: 'confirmation_required',
  message: 'Las mutaciones destructivas solo se aplican cuando confirm=true.',
});

const changeUnavailableResult = (): McpChangeUnavailableResult => ({
  error: 'change_unavailable',
  message: 'La propuesta o revisión ya no está disponible para esta cuenta y cliente.',
});

const previewKindSet = new Set<McpPreviewableChange['kind']>([
  'delete_workout',
  'delete_measurement',
  'delete_checkin',
  'replace_all_data',
  'delete_all_data',
]);

const isPreviewableChange = (operation: McpWriteOperation): operation is McpPreviewableChange => previewKindSet.has(operation.kind as McpPreviewableChange['kind']);

const runRevisionedMutation = async (
  database: D1DatabaseLike,
  userId: string,
  revisionId: string,
  createdAt: string,
  mutation: D1PreparedStatementLike,
  receipt?: D1PreparedStatementLike,
): Promise<D1ResultLike> => {
  const results = await database.batch([
    database.prepare(
      `INSERT INTO mcp_revision_context (user_id, revision_id, created_at)
       VALUES (?, ?, ?)`,
    ).bind(userId, revisionId, createdAt),
    mutation,
    ...(receipt ? [receipt] : []),
    database.prepare(
      `DELETE FROM mcp_revision_context
        WHERE user_id = ? AND revision_id = ?`,
    ).bind(userId, revisionId),
  ]);
  return results[1];
};

const releasePendingChangeClaim = async (
  database: D1DatabaseLike,
  userId: string,
  clientId: string,
  changeId: string,
  claimId: string,
): Promise<void> => {
  await database.prepare(
    `UPDATE mcp_pending_changes
        SET claim_id = NULL, claimed_at = NULL
      WHERE id = ?
        AND user_id = ?
        AND client_id = ?
        AND claim_id = ?
        AND used_at IS NULL`,
  ).bind(changeId, userId, clientId, claimId).run();
};

const nextVersion = (baseUpdatedAt: string): string => {
  const now = Date.now();
  const base = Date.parse(baseUpdatedAt);
  return new Date(Number.isFinite(base) ? Math.max(now, base + 1) : now).toISOString();
};

const deleteExpiredUserRevisions = async (database: D1DatabaseLike, userId: string, now: string): Promise<void> => {
  await database.prepare(
    `DELETE FROM user_data_revisions
      WHERE user_id = ?
        AND datetime(expires_at) <= datetime(?)`,
  ).bind(userId, now).run();
};

const parseStoredRevision = (row: Pick<McpRevisionRow, 'payload'>): AppData => {
  try {
    return validateMcpAppDataWithHistoricalSessions(JSON.parse(row.payload));
  } catch {
    throw new Error('La revisión recuperable almacenada no es válida.');
  }
};

const buildPreviewSummary = (current: AppData, change: McpPreviewableChange): Record<string, unknown> => {
  if (change.kind === 'delete_workout') {
    const workout = current.sessions.find((session) => session.id === change.workoutId);
    if (!workout) throw new Error('El entrenamiento solicitado ya no existe en la copia autenticada.');
    return {
      kind: 'delete_workout',
      workoutId: workout.id,
      dateKey: workout.dateKey,
      workoutDayId: workout.workoutDayId,
    };
  }
  if (change.kind === 'delete_measurement') {
    const entry = current.progress.find((measurement) => measurement.id === change.measurementId);
    if (!entry) throw new Error('La medición solicitada ya no existe en la copia autenticada.');
    return {
      kind: 'delete_measurement',
      measurementId: entry.id,
      date: entry.date,
    };
  }
  if (change.kind === 'delete_checkin') {
    const entry = current.checkins.find((checkin) => checkin.id === change.checkinId);
    if (!entry) throw new Error('El check-in solicitado ya no existe en la copia autenticada.');
    return {
      kind: 'delete_checkin',
      checkinId: entry.id,
      weekKey: entry.weekKey,
    };
  }
  if (change.kind === 'replace_all_data') {
    return {
      kind: 'replace_all_data',
      sessionCount: change.data.sessions.length,
      measurementCount: change.data.progress.length,
      checkinCount: change.data.checkins.length,
    };
  }
  return {
    kind: 'delete_all_data',
    sessionCount: current.sessions.length,
    measurementCount: current.progress.length,
    checkinCount: current.checkins.length,
  };
};

const applyPreviewMutation = (current: AppData, change: McpPreviewableChange): { nextData: AppData | null; summary: Record<string, unknown> } => {
  if (change.kind === 'delete_workout') {
    const exists = current.sessions.some((session) => session.id === change.workoutId);
    if (!exists) throw new Error('El entrenamiento solicitado ya no existe en la copia autenticada.');
    return {
      nextData: {
        ...structuredClone(current),
        sessions: current.sessions.filter((session) => session.id !== change.workoutId).map((session) => structuredClone(session)),
      },
      summary: {
        kind: 'delete_workout',
        workoutId: change.workoutId,
        deleted: true,
      },
    };
  }
  if (change.kind === 'delete_measurement') {
    const exists = current.progress.some((entry) => entry.id === change.measurementId);
    if (!exists) throw new Error('La medición solicitada ya no existe en la copia autenticada.');
    return {
      nextData: {
        ...structuredClone(current),
        progress: current.progress.filter((entry) => entry.id !== change.measurementId).map((entry) => structuredClone(entry)),
      },
      summary: {
        kind: 'delete_measurement',
        measurementId: change.measurementId,
        deleted: true,
      },
    };
  }
  if (change.kind === 'delete_checkin') {
    const exists = current.checkins.some((entry) => entry.id === change.checkinId);
    if (!exists) throw new Error('El check-in solicitado ya no existe en la copia autenticada.');
    return {
      nextData: {
        ...structuredClone(current),
        checkins: current.checkins.filter((entry) => entry.id !== change.checkinId).map((entry) => structuredClone(entry)),
      },
      summary: {
        kind: 'delete_checkin',
        checkinId: change.checkinId,
        deleted: true,
      },
    };
  }
  if (change.kind === 'replace_all_data') {
    return {
      nextData: structuredClone(change.data),
      summary: {
        kind: 'replace_all_data',
        sessionCount: change.data.sessions.length,
        measurementCount: change.data.progress.length,
        checkinCount: change.data.checkins.length,
      },
    };
  }
  return {
    nextData: null,
    summary: {
      kind: 'delete_all_data',
    },
  };
};

const parsePendingChange = (row: Pick<McpPendingChangeRow, 'payload'>): McpPreviewableChange => {
  try {
    const parsed = JSON.parse(row.payload);
    const validated = validateMcpWriteOperation(parsed);
    if (!isPreviewableChange(validated)) throw new Error('La propuesta almacenada no es destructiva.');
    return validated;
  } catch {
    throw new Error('La propuesta destructiva almacenada no es válida.');
  }
};

const workoutValidationContext = (data: AppData): McpWorkoutValidationContext => ({
  exercises: data.exercises.map((exercise) => ({ id: exercise.id })),
  plan: { days: data.plan.days.map((day) => ({ id: day.id })) },
});

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const changedProfileFields = (current: AppData, patch: Record<string, unknown>, next: AppData): string[] => Object.keys(patch).filter((key) => {
  const typedKey = key as keyof AppData['profile'];
  return !sameValue(current.profile[typedKey], next.profile[typedKey]);
});

const applyMutation = (current: AppData, operation: McpWriteOperation): { next: AppData; summary: Record<string, unknown> } => {
  if (operation.kind === 'update_profile') {
    const next = {
      ...structuredClone(current),
      profile: {
        ...structuredClone(current.profile),
        ...operation.profile,
      },
    };
    return {
      next,
      summary: {
        kind: 'update_profile',
        changedFields: changedProfileFields(current, operation.profile, next),
      },
    };
  }

  if (operation.kind === 'replace_routine') {
    const next = {
      ...structuredClone(current),
      plan: structuredClone(operation.plan),
      exercises: structuredClone(operation.exercises),
    };
    return {
      next,
      summary: {
        kind: 'replace_routine',
        planId: operation.plan.id,
        planVersion: operation.plan.version,
        dayCount: operation.plan.days.length,
        exerciseCount: operation.exercises.length,
      },
    };
  }

  if (operation.kind === 'record_workout') {
    if (operation.workout.status !== 'completed') throw new Error('record_workout solo admite sesiones completadas nuevas.');
    if (!operation.workout.completedAt) throw new Error('record_workout requiere completedAt para una sesión completada.');
    const serverWorkout = {
      ...structuredClone(operation.workout),
      id: `mcp-session-${globalThis.crypto.randomUUID()}`,
      status: 'completed' as const,
    };
    const next = {
      ...structuredClone(current),
      sessions: [...structuredClone(current.sessions), serverWorkout],
    };
    const summary = summarizeSession(serverWorkout, next.sessions);
    return {
      next,
      summary: {
        kind: 'record_workout',
        workoutId: serverWorkout.id,
        workoutDayId: serverWorkout.workoutDayId,
        dateKey: serverWorkout.dateKey,
        completedExercises: summary.completedExercises,
        totalExercises: summary.totalExercises,
        volumeKg: summary.volumeKg,
      },
    };
  }

  if (operation.kind === 'add_measurement') {
    const next = {
      ...structuredClone(current),
      progress: [...structuredClone(current.progress), structuredClone(operation.entry)],
    };
    return {
      next,
      summary: {
        kind: 'add_measurement',
        entryId: operation.entry.id,
        date: operation.entry.date,
      },
    };
  }

  if (operation.kind === 'add_checkin') {
    const matches = current.checkins.filter((entry) => entry.weekKey === operation.checkin.weekKey);
    if (matches.length > 1) throw new Error(`Ya existe más de un check-in para weekKey ${operation.checkin.weekKey}.`);
    const nextCheckins = structuredClone(current.checkins).filter((entry) => entry.weekKey !== operation.checkin.weekKey);
    nextCheckins.push(structuredClone(operation.checkin));
    const next = {
      ...structuredClone(current),
      checkins: nextCheckins,
    };
    return {
      next,
      summary: {
        kind: 'add_checkin',
        checkinId: operation.checkin.id,
        weekKey: operation.checkin.weekKey,
        replacedExisting: matches.length === 1,
      },
    };
  }

  throw new Error(`La mutación ${operation.kind} todavía no está habilitada.`);
};

export const previewChange = async (
  database: D1DatabaseLike,
  userId: string,
  clientId: string,
  request: PreviewChangeRequest,
): Promise<McpPreviewResult | McpConflictResult | McpNeedsVersionResult> => {
  if (!await hasActiveWriteOwnership(database, userId, clientId)) return oauthOwnershipConflictResult();
  const current = await loadMcpUserData(database, userId);
  if (!request.baseUpdatedAt) return needsVersionResult(current);
  if (!current.data || !current.updatedAt) return conflictResult(current);
  if (current.updatedAt !== request.baseUpdatedAt) return conflictResult(current);

  const { baseUpdatedAt, ...rawChange } = request;
  const validated = validateMcpWriteOperation(rawChange);
  if (!isPreviewableChange(validated)) throw new Error('preview_change solo admite mutaciones destructivas.');

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + PENDING_CHANGE_TTL_MS).toISOString();
  const changeId = globalThis.crypto.randomUUID();
  const summary = buildPreviewSummary(current.data, validated);
  await database.prepare(
    `INSERT INTO mcp_pending_changes
      (id, user_id, client_id, kind, payload, base_updated_at, summary, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    changeId,
    userId,
    clientId,
    validated.kind,
    JSON.stringify(validated),
    baseUpdatedAt,
    JSON.stringify(summary),
    createdAt,
    expiresAt,
  ).run();
  return { changeId, expiresAt, summary };
};

export const applyChange = async (
  database: D1DatabaseLike,
  userId: string,
  clientId: string,
  changeId: string,
  confirm: boolean,
): Promise<McpMutationResult | McpConflictResult | McpChangeUnavailableResult | McpConfirmationRequiredResult> => {
  if (!confirm) return confirmationRequiredResult();
  if (!await hasActiveWriteOwnership(database, userId, clientId)) return oauthOwnershipConflictResult();

  const now = new Date().toISOString();
  const fingerprint = await requestFingerprint({ changeId, confirm });
  const replay = await readReceipt(database, userId, clientId, `apply:${changeId}`, fingerprint);
  if (replay) return replay;
  const pending = await database.prepare(
    `SELECT
        id,
        user_id AS userId,
        client_id AS clientId,
        kind,
        payload,
        base_updated_at AS baseUpdatedAt,
        summary,
        created_at AS createdAt,
        expires_at AS expiresAt,
        used_at AS usedAt
      FROM mcp_pending_changes
      WHERE id = ?
        AND user_id = ?
        AND client_id = ?
        AND claim_id IS NULL
        AND used_at IS NULL
        AND datetime(expires_at) > datetime(?)
        AND EXISTS (
          SELECT 1
            FROM mcp_tokens
           WHERE user_id = ?
             AND client_id = ?
             AND token_type = 'access'
             AND expires_at > ?
             AND revoked_at IS NULL
             AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
        )
      LIMIT 1`,
  ).bind(
    changeId,
    userId,
    clientId,
    now,
    userId,
    clientId,
    now,
    MCP_WRITE_SCOPE,
  ).first<McpPendingChangeRow>();
  if (!pending) return changeUnavailableResult();

  const current = await loadMcpUserData(database, userId);
  if (!current.data || !current.updatedAt) return conflictResult(current);
  if (current.updatedAt !== pending.baseUpdatedAt) return conflictResult(current);

  const { nextData, summary } = applyPreviewMutation(current.data, parsePendingChange(pending));
  if (nextData) validateMcpAppData(nextData);

  const updatedAt = nextVersion(pending.baseUpdatedAt);
  const claimId = globalThis.crypto.randomUUID();
  const claim = await database.prepare(
    `UPDATE mcp_pending_changes
        SET claim_id = ?, claimed_at = ?
      WHERE id = ?
        AND user_id = ?
        AND client_id = ?
        AND base_updated_at = ?
        AND claim_id IS NULL
        AND used_at IS NULL
        AND datetime(expires_at) > datetime(?)
        AND EXISTS (
          SELECT 1
            FROM mcp_tokens
           WHERE user_id = ?
             AND client_id = ?
             AND token_type = 'access'
             AND expires_at > ?
             AND revoked_at IS NULL
             AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
        )`,
  ).bind(
    claimId,
    updatedAt,
    changeId,
    userId,
    clientId,
    pending.baseUpdatedAt,
    now,
    userId,
    clientId,
    now,
    MCP_WRITE_SCOPE,
  ).run();
  if ((claim.meta?.changes ?? 0) !== 1) return changeUnavailableResult();

  const revisionId = globalThis.crypto.randomUUID();
  let mutation: D1PreparedStatementLike;
  if (nextData) {
    mutation = database.prepare(
      `UPDATE user_data
          SET payload = ?, updated_at = ?
        WHERE user_id = ? AND updated_at = ?
          AND EXISTS (
            SELECT 1
              FROM mcp_pending_changes
             WHERE id = ?
               AND user_id = ?
               AND client_id = ?
               AND claim_id = ?
               AND used_at IS NULL
          )
          AND EXISTS (
            SELECT 1
              FROM mcp_tokens
             WHERE user_id = ?
               AND client_id = ?
               AND token_type = 'access'
               AND expires_at > ?
               AND revoked_at IS NULL
               AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
          )`,
    ).bind(
      JSON.stringify(nextData),
      updatedAt,
      userId,
      pending.baseUpdatedAt,
      changeId,
      userId,
      clientId,
      claimId,
      userId,
      clientId,
      updatedAt,
      MCP_WRITE_SCOPE,
    );
  } else {
    mutation = database.prepare(
      `DELETE FROM user_data
        WHERE user_id = ? AND updated_at = ?
          AND EXISTS (
            SELECT 1
              FROM mcp_pending_changes
             WHERE id = ?
               AND user_id = ?
               AND client_id = ?
               AND claim_id = ?
               AND used_at IS NULL
          )
          AND EXISTS (
            SELECT 1
              FROM mcp_tokens
             WHERE user_id = ?
               AND client_id = ?
               AND token_type = 'access'
               AND expires_at > ?
               AND revoked_at IS NULL
               AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
          )`,
    ).bind(
      userId,
      pending.baseUpdatedAt,
      changeId,
      userId,
      clientId,
      claimId,
      userId,
      clientId,
      updatedAt,
      MCP_WRITE_SCOPE,
    );
  }

  let result: D1ResultLike;
  try {
    result = await runRevisionedMutation(database, userId, revisionId, updatedAt, mutation,
      receiptStatement(database, userId, clientId, `apply:${changeId}`, fingerprint, pending.kind, { updatedAt, summary, revisionId }));
  } catch (error) {
    await releasePendingChangeClaim(database, userId, clientId, changeId, claimId);
    throw error;
  }

  if ((result.meta?.changes ?? 0) !== 1) {
    await releasePendingChangeClaim(database, userId, clientId, changeId, claimId);
    return conflictResult(await loadMcpUserData(database, userId));
  }

  const finalized = await database.prepare(
    `UPDATE mcp_pending_changes
        SET used_at = ?, claim_id = NULL, claimed_at = NULL
      WHERE id = ?
        AND user_id = ?
        AND client_id = ?
        AND claim_id = ?
        AND used_at IS NULL`,
  ).bind(updatedAt, changeId, userId, clientId, claimId).run();
  if ((finalized.meta?.changes ?? 0) !== 1) {
    throw new Error('La propuesta se aplicó, pero no se pudo cerrar de forma segura.');
  }

  return {
    updatedAt,
    summary,
    revisionId,
  };
};

export const listRevisions = async (database: D1DatabaseLike, userId: string): Promise<RevisionSummary[]> => {
  const now = new Date().toISOString();
  await deleteExpiredUserRevisions(database, userId, now);
  const rows = await database.prepare(
    `SELECT
        id,
        user_id AS userId,
        payload,
        source,
        created_at AS createdAt,
        expires_at AS expiresAt,
        restored_at AS restoredAt
      FROM user_data_revisions
      WHERE user_id = ?
        AND datetime(expires_at) > datetime(?)
      ORDER BY created_at DESC, id DESC`,
  ).bind(userId, now).all<McpRevisionRow>();
  return rows.results.map((row) => ({
    id: row.id,
    source: row.source,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    restoredAt: row.restoredAt,
  }));
};

export const restoreRevision = async (
  database: D1DatabaseLike,
  userId: string,
  clientId: string,
  revisionId: string,
  baseUpdatedAt: string | undefined,
): Promise<McpMutationResult | McpConflictResult | McpNeedsVersionResult | McpChangeUnavailableResult> => {
  if (!await hasActiveWriteOwnership(database, userId, clientId)) return oauthOwnershipConflictResult();
  const fingerprint = await requestFingerprint({ revisionId, baseUpdatedAt });
  const requestKey = `restore:${fingerprint}`;
  const replay = await readReceipt(database, userId, clientId, requestKey, fingerprint);
  if (replay) return replay;
  const current = await loadMcpUserData(database, userId);
  if (!baseUpdatedAt) return needsVersionResult(current);

  const now = new Date().toISOString();
  const revision = await database.prepare(
    `SELECT
        id,
        user_id AS userId,
        payload,
        source,
        created_at AS createdAt,
        expires_at AS expiresAt,
        restored_at AS restoredAt
      FROM user_data_revisions
      WHERE id = ?
        AND user_id = ?
        AND datetime(expires_at) > datetime(?)
      LIMIT 1`,
  ).bind(revisionId, userId, now).first<McpRevisionRow>();
  if (!revision) return changeUnavailableResult();

  if (current.data) {
    if (!current.updatedAt || current.updatedAt !== baseUpdatedAt) return conflictResult(current);
  } else if (revision.createdAt !== baseUpdatedAt) {
    return conflictResult(current);
  }

  const restoredData = parseStoredRevision(revision);
  validateMcpAppDataWithHistoricalSessions(restoredData);

  const updatedAt = nextVersion(baseUpdatedAt);
  let result: D1ResultLike;
  let createdRevisionId: string | undefined;
  if (current.data) {
    createdRevisionId = globalThis.crypto.randomUUID();
    const mutation = database.prepare(
      `UPDATE user_data
          SET payload = ?, updated_at = ?
        WHERE user_id = ? AND updated_at = ?
          AND EXISTS (
            SELECT 1
              FROM user_data_revisions
             WHERE id = ?
               AND user_id = ?
               AND datetime(expires_at) > datetime(?)
          )
          AND EXISTS (
            SELECT 1
              FROM mcp_tokens
             WHERE user_id = ?
               AND client_id = ?
               AND token_type = 'access'
               AND expires_at > ?
               AND revoked_at IS NULL
               AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
          )`,
    ).bind(
      JSON.stringify(restoredData),
      updatedAt,
      userId,
      baseUpdatedAt,
      revisionId,
      userId,
      now,
      userId,
      clientId,
      now,
      MCP_WRITE_SCOPE,
    );
    result = await runRevisionedMutation(database, userId, createdRevisionId, updatedAt, mutation,
      receiptStatement(database, userId, clientId, requestKey, fingerprint, 'restore_revision', {
        updatedAt, summary: { kind: 'restore_revision', restoredFromRevisionId: revisionId }, revisionId: createdRevisionId,
      }));
  } else {
    const mutation = database.prepare(
      `INSERT INTO user_data (user_id, payload, updated_at)
       SELECT ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM user_data WHERE user_id = ?
        )
          AND EXISTS (
            SELECT 1
              FROM user_data_revisions
             WHERE id = ?
               AND user_id = ?
               AND created_at = ?
               AND datetime(expires_at) > datetime(?)
          )
          AND EXISTS (
            SELECT 1
              FROM mcp_tokens
             WHERE user_id = ?
               AND client_id = ?
               AND token_type = 'access'
               AND expires_at > ?
               AND revoked_at IS NULL
               AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
          )`,
    ).bind(
      userId,
      JSON.stringify(restoredData),
      updatedAt,
      userId,
      revisionId,
      userId,
      baseUpdatedAt,
      now,
      userId,
      clientId,
      now,
      MCP_WRITE_SCOPE,
    );
    [result] = await database.batch([mutation, receiptStatement(database, userId, clientId, requestKey, fingerprint, 'restore_revision', {
      updatedAt, summary: { kind: 'restore_revision', restoredFromRevisionId: revisionId },
    })]);
  }

  if ((result.meta?.changes ?? 0) !== 1) {
    return conflictResult(await loadMcpUserData(database, userId));
  }

  await database.prepare(
    `UPDATE user_data_revisions
        SET restored_at = COALESCE(restored_at, ?)
      WHERE id = ? AND user_id = ?`,
  ).bind(updatedAt, revisionId, userId).run();

  return {
    updatedAt,
    summary: {
      kind: 'restore_revision',
      restoredFromRevisionId: revisionId,
    },
    revisionId: createdRevisionId,
  };
};

export const writeMcpData = async (
  database: D1DatabaseLike,
  userId: string,
  clientId: string,
  baseUpdatedAt: string | undefined,
  operation: McpWriteOperation,
  idempotencyKey?: string,
): Promise<McpWriteResult> => {
  if (operation.kind === 'preview_change') {
    return previewChange(database, userId, clientId, {
      baseUpdatedAt,
      ...operation.change,
    });
  }
  if (operation.kind === 'apply_change') {
    return applyChange(database, userId, clientId, operation.changeId, operation.confirm);
  }
  if (operation.kind === 'list_revisions') {
    return { revisions: await listRevisions(database, userId) };
  }
  if (operation.kind === 'restore_revision') {
    return restoreRevision(database, userId, clientId, operation.revisionId, baseUpdatedAt);
  }
  if (isPreviewableChange(operation)) {
    throw new Error('Las mutaciones destructivas requieren preview_change seguido de apply_change.');
  }

  if (!await hasActiveWriteOwnership(database, userId, clientId)) return oauthOwnershipConflictResult();
  const fingerprint = await requestFingerprint({ baseUpdatedAt, operation });
  const requestKey = `write:${idempotencyKey ?? globalThis.crypto.randomUUID()}`;
  if (idempotencyKey) {
    const replay = await readReceipt(database, userId, clientId, requestKey, fingerprint);
    if (replay) return replay;
  }
  const current = await loadMcpUserData(database, userId);
  if (!baseUpdatedAt) return needsVersionResult(current);
  if (!current.data || !current.updatedAt) return conflictResult(current);
  if (current.updatedAt !== baseUpdatedAt) return conflictResult(current);

  const validatedOperation = validateMcpWriteOperation(
    operation,
    operation.kind === 'record_workout' ? workoutValidationContext(current.data) : undefined,
  );
  const { next, summary } = applyMutation(current.data, validatedOperation);
  validateMcpAppDataWithHistoricalSessions(next);

  const updatedAt = nextVersion(baseUpdatedAt);
  const mutation = database.prepare(
    `UPDATE user_data
     SET payload = ?, updated_at = ?
     WHERE user_id = ? AND updated_at = ?
       AND EXISTS (
         SELECT 1
           FROM mcp_tokens
          WHERE user_id = ?
            AND client_id = ?
            AND token_type = 'access'
            AND expires_at > ?
            AND revoked_at IS NULL
            AND instr(' ' || scope || ' ', ' ' || ? || ' ') > 0
        AND EXISTS (SELECT 1 FROM users WHERE users.id = mcp_tokens.user_id AND users.disabled = 0)
       )`,
  ).bind(
    JSON.stringify(next),
    updatedAt,
    userId,
    baseUpdatedAt,
    userId,
    clientId,
    updatedAt,
    MCP_WRITE_SCOPE,
  );

  let result: D1ResultLike;
  try {
    [result] = await database.batch([mutation, receiptStatement(database, userId, clientId, requestKey, fingerprint, operation.kind, { updatedAt, summary })]);
  } catch (error) {
    const replay = await readReceipt(database, userId, clientId, requestKey, fingerprint);
    if (replay) return replay;
    throw error;
  }

  if ((result.meta?.changes ?? 0) !== 1) {
    if (idempotencyKey) {
      const replay = await readReceipt(database, userId, clientId, requestKey, fingerprint);
      if (replay) return replay;
    }
    return conflictResult(await loadMcpUserData(database, userId));
  }

  return { updatedAt, summary };
};

const normalizeText = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const isDateKey = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00`));
const shiftDate = (value: string, days: number): string => { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return dateKey(date); };

const rangeFor = (args: Record<string, unknown>): { from?: string; to?: string } => {
  const period = args.period === undefined ? 'all_time' : args.period;
  if (typeof period !== 'string' || !PERIODS.includes(period as Period)) throw new Error('period no es válido.');
  const today = dateKey();
  const monday = weekKey();
  const defaults: Record<Period, { from?: string; to?: string }> = {
    this_week: { from: monday, to: shiftDate(monday, 6) },
    last_week: { from: shiftDate(monday, -7), to: shiftDate(monday, -1) },
    last_7_days: { from: shiftDate(today, -6), to: today },
    this_month: { from: `${today.slice(0, 7)}-01`, to: today },
    all_time: {},
  };
  const range = { ...defaults[period as Period] };
  if (args.from !== undefined) {
    if (!isDateKey(args.from)) throw new Error('from debe tener formato YYYY-MM-DD.');
    range.from = args.from;
  }
  if (args.to !== undefined) {
    if (!isDateKey(args.to)) throw new Error('to debe tener formato YYYY-MM-DD.');
    range.to = args.to;
  }
  if (range.from && range.to && range.from > range.to) throw new Error('from no puede ser posterior a to.');
  return range;
};

const inRange = (value: string, range: { from?: string; to?: string }): boolean => (!range.from || value >= range.from) && (!range.to || value <= range.to);
const sortedSessions = (data: AppData): WorkoutSession[] => data.sessions.filter((session) => session.status === 'completed').sort((a, b) => (b.completedAt ?? b.dateKey).localeCompare(a.completedAt ?? a.dateKey));
const workSets = (exercise: ExerciseSession) => exercise.setLogs.filter(isWorkSet);
const completedWorkSets = (exercise: ExerciseSession) => workSets(exercise).filter((set) => set.completed);
const volumeForExercise = (exercise: ExerciseSession): number => completedWorkSets(exercise).reduce((total, set) => total + (set.weightKg ?? 0) * (set.actualReps ?? 0), 0);
const durationSeconds = (session: WorkoutSession): number => session.startedAt && session.completedAt ? Math.max(0, Math.round((Date.parse(session.completedAt) - Date.parse(session.startedAt)) / 1000)) : 0;
const difficultyCounts = (sessions: WorkoutSession[]): Record<string, number> => sessions.flatMap((session) => session.plannedExercises).reduce<Record<string, number>>((counts, exercise) => {
  if (exercise.difficulty) counts[exercise.difficulty] = (counts[exercise.difficulty] ?? 0) + 1;
  return counts;
}, {});

const sessionResult = (data: AppData, session: WorkoutSession) => ({
  id: session.id,
  date: session.dateKey,
  workoutName: data.plan.days.find((day) => day.id === session.workoutDayId)?.name,
  durationSeconds: durationSeconds(session),
  completedExercises: session.plannedExercises.filter((exercise) => exercise.completed).length,
  totalExercises: session.plannedExercises.length,
  volumeKg: Math.round(session.plannedExercises.reduce((total, exercise) => total + volumeForExercise(exercise), 0) * 10) / 10,
  difficultyCounts: difficultyCounts([session]),
  exercises: session.plannedExercises.map((exercise) => ({
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    completed: exercise.completed,
    difficulty: exercise.difficulty,
    discomfort: exercise.discomfort,
    setLogs: workSets(exercise).map((set) => ({ setNumber: set.setNumber, targetReps: set.targetReps, actualReps: set.actualReps, weightKg: set.weightKg, completed: set.completed })),
  })),
});

const exerciseMatches = (data: AppData, exercise: ExerciseSession, query: string): boolean => {
  const definition = data.exercises.find((candidate) => candidate.id === exercise.exerciseId);
  return [exercise.name, exercise.exerciseId, ...(definition?.aliases ?? [])].some((value) => normalizeText(value).includes(query));
};

const profileResult = (data: AppData) => ({
  goal: data.profile.goal || undefined,
  gym: data.profile.gym || undefined,
  trainingDays: data.profile.trainingDays,
  sessionMinutes: data.profile.sessionMinutes,
  experienceLevel: data.profile.experienceLevel,
  currentWeightKg: data.profile.currentWeightKg,
  heightCm: data.profile.heightCm,
  nutritionContext: data.profile.nutritionContext || undefined,
  availableEquipment: data.profile.availableEquipment,
  availableEquipmentLabels: data.profile.availableEquipment.map((equipment) => equipmentLabel(equipment)),
});

const recommendationsResult = (data: AppData) => {
  const seen = new Set<string>();
  return data.plan.days.flatMap((day) => day.exercises)
    .filter((exercise) => exercise.active && !seen.has(exercise.exerciseId) && seen.add(exercise.exerciseId))
    .map((exercise) => {
      const action = progressionAction(exercise.exerciseId, data.sessions, exercise);
      if (action) return { exerciseId: exercise.exerciseId, name: exercise.name, tone: action.tone, title: action.title, detail: action.detail };
      const recommendation = recommendationFor(exercise.exerciseId, data.sessions);
      return recommendation ? { exerciseId: exercise.exerciseId, name: exercise.name, tone: recommendation.tone, title: recommendation.label, detail: recommendation.message } : undefined;
    })
    .filter((recommendation): recommendation is NonNullable<typeof recommendation> => Boolean(recommendation))
    .slice(0, 12);
};

const prescriptionResult = (plan: ProgressionPlan) => ({
  status: plan.status,
  reason: plan.reason,
  targetReps: plan.targetReps,
  nextWeightKg: plan.nextWeightKg,
});

const activePrescription = (exercise: ExerciseSession) => ({
  status: exercise.progressionStatus ?? 'start',
  reason: exercise.progressionReason ?? 'Sesión preparada en Radian.',
  targetReps: workSets(exercise)[0]?.targetReps ?? exercise.repMin,
  nextWeightKg: workSets(exercise)[0]?.weightKg ?? exercise.actualWeightKg,
});

const nextSessionResult = (data: AppData) => {
  const inProgress = data.sessions.find((session) => session.status === 'in_progress');
  if (inProgress) {
    const day = data.plan.days.find((candidate) => candidate.id === inProgress.workoutDayId);
    return {
      status: 'in_progress',
      date: inProgress.dateKey,
      workoutDayId: inProgress.workoutDayId,
      workoutName: day?.name,
      focus: day?.focus,
      weekday: day?.weekday,
      readiness: inProgress.readiness,
      adaptation: sessionAdaptation(inProgress.readiness),
      exercises: inProgress.plannedExercises.map((exercise) => ({
        exerciseId: exercise.exerciseId,
        name: exercise.name,
        sets: exercise.sets,
        repRange: { min: exercise.repMin, max: exercise.repMax },
        restSeconds: exercise.restSeconds,
        prescription: activePrescription(exercise),
      })),
    };
  }

  const today = dateKey();
  const weekday = currentWeekday();
  const days = scheduledWorkoutDays(data.plan.days, data.profile.trainingDays);
  const completedToday = data.sessions.some((session) => session.status === 'completed' && session.dateKey === today);
  const day = completedToday
    ? days.find((candidate) => candidate.weekday > weekday) ?? days[0]
    : days.find((candidate) => candidate.weekday >= weekday) ?? days[0];
  if (!day) return { status: 'no_session', date: today, exercises: [] };

  const daysAhead = completedToday
    ? (day.weekday > weekday ? day.weekday - weekday : 7 - weekday + day.weekday)
    : (day.weekday >= weekday ? day.weekday - weekday : 7 - weekday + day.weekday);
  return {
    status: 'scheduled',
    date: shiftDate(today, daysAhead),
    workoutDayId: day.id,
    workoutName: day.name,
    focus: day.focus,
    weekday: day.weekday,
    exercises: day.exercises.filter((exercise) => exercise.active).map((exercise) => ({
      exerciseId: exercise.exerciseId,
      name: exercise.name,
      sets: exercise.sets,
      repRange: { min: exercise.repMin, max: exercise.repMax },
      restSeconds: exercise.restSeconds,
      prescription: prescriptionResult(nextPrescription(exercise, data.sessions)),
    })),
  };
};

const definitionMatches = (definition: AppData['exercises'][number], query: string): boolean => [definition.id, definition.name, definition.muscleGroup, ...(definition.aliases ?? [])]
  .map(normalizeText)
  .some((value) => value === query || value.includes(query) || query.includes(value));

const definitionResult = (definition: AppData['exercises'][number]) => ({
  id: definition.id,
  name: definition.name,
  muscleGroup: definition.muscleGroup,
  equipment: definition.equipment,
  equipmentLabel: equipmentLabel(definition.equipment),
});

const matchedDefinition = (data: AppData, rawQuery: unknown): AppData['exercises'][number] | undefined => {
  const query = typeof rawQuery === 'string' ? normalizeText(rawQuery) : '';
  if (!query) throw new Error('exercise es obligatorio.');
  return data.exercises.find((definition) => definitionMatches(definition, query));
};

const alternativesResult = (data: AppData, definition: AppData['exercises'][number], limit: number) => compatibleAlternatives(data.exercises, definition.id, data.profile.availableEquipment)
  .slice(0, limit)
  .map(definitionResult);

const equipmentAlternativesLimit = (args: Record<string, unknown>): number => {
  const limit = args.limit === undefined ? 4 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('limit debe ser un entero entre 1 y 8.');
  return limit;
};

const chatContextResult = (data: AppData) => {
  const summary = buildWeeklySummary(data);
  return {
    profile: profileResult(data),
    weeklyReview: { ...summary, text: weeklySummaryText(data) },
    nextSession: nextSessionResult(data),
    recommendations: recommendationsResult(data),
    signals: detectTrainingSignals(data),
  };
};

const recommendationExplanation = (data: AppData, definition: AppData['exercises'][number]) => {
  const planned = data.plan.days.flatMap((day) => day.exercises).find((exercise) => exercise.exerciseId === definition.id);
  const action = planned ? progressionAction(definition.id, data.sessions, planned) : undefined;
  const recommendation = recommendationFor(definition.id, data.sessions);
  const evidence = sortedSessions(data).flatMap((session) => session.plannedExercises
    .filter((exercise) => exercise.exerciseId === definition.id)
    .map((exercise) => ({
      date: session.dateKey,
      workoutId: session.id,
      completed: exercise.completed,
      difficulty: exercise.difficulty,
      discomfort: exercise.discomfort,
      discomfortNote: exercise.discomfortNote,
      volumeKg: Math.round(volumeForExercise(exercise) * 10) / 10,
      setLogs: completedWorkSets(exercise).map((set) => ({ actualReps: set.actualReps, weightKg: set.weightKg })),
    })))
    .slice(0, 5);
  return {
    matchedExercise: definitionResult(definition),
    recommendation: action
      ? { tone: action.tone, title: action.title, detail: action.detail }
      : recommendation
        ? { tone: recommendation.tone, title: recommendation.label, detail: recommendation.message }
        : null,
    evidence,
    alternatives: alternativesResult(data, definition, 4),
  };
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

const muscleGroupFor = (data: AppData, exercise: ExerciseSession): string =>
  data.exercises.find((definition) => definition.id === exercise.exerciseId)?.muscleGroup ?? 'Sin grupo';

const estimate1rmResult = (data: AppData, rawQuery: unknown) => {
  const query = typeof rawQuery === 'string' ? normalizeText(rawQuery) : undefined;
  const best = new Map<string, { exerciseId: string; name: string; muscleGroup: string; estimated1rmKg: number; weightKg: number; reps: number; date: string; workoutId: string }>();
  sortedSessions(data).forEach((session) => session.plannedExercises.forEach((exercise) => {
    if (query && !exerciseMatches(data, exercise, query)) return;
    completedWorkSets(exercise).forEach((set) => {
      const weight = set.weightKg;
      const reps = set.actualReps;
      if (weight === undefined || reps === undefined || weight <= 0 || reps <= 0) return;
      const estimated1rmKg = round1(weight * (1 + reps / 30));
      const current = best.get(exercise.exerciseId);
      if (!current || estimated1rmKg > current.estimated1rmKg) {
        best.set(exercise.exerciseId, { exerciseId: exercise.exerciseId, name: exercise.name, muscleGroup: muscleGroupFor(data, exercise), estimated1rmKg, weightKg: weight, reps, date: session.dateKey, workoutId: session.id });
      }
    });
  }));
  const estimates = [...best.values()].sort((a, b) => b.estimated1rmKg - a.estimated1rmKg || a.name.localeCompare(b.name));
  return { formula: 'Epley: peso × (1 + repeticiones / 30)', exercise: rawQuery, estimates };
};

const muscleBalanceResult = (data: AppData, range: { from?: string; to?: string }) => {
  const groups = new Map<string, { muscleGroup: string; sets: number; volumeKg: number; exercises: Set<string> }>();
  sortedSessions(data).filter((session) => inRange(session.dateKey, range)).forEach((session) => session.plannedExercises.forEach((exercise) => {
    const completed = completedWorkSets(exercise);
    if (completed.length === 0) return;
    const muscleGroup = muscleGroupFor(data, exercise);
    const current = groups.get(muscleGroup) ?? { muscleGroup, sets: 0, volumeKg: 0, exercises: new Set<string>() };
    completed.forEach((set) => {
      current.sets += 1;
      current.volumeKg += (set.weightKg ?? 0) * (set.actualReps ?? 0);
    });
    current.exercises.add(exercise.name);
    groups.set(muscleGroup, current);
  }));
  const muscles = [...groups.values()].map((group) => ({ muscleGroup: group.muscleGroup, sets: group.sets, volumeKg: round1(group.volumeKg), exercises: [...group.exercises].sort() }))
    .sort((a, b) => b.sets - a.sets || b.volumeKg - a.volumeKg || a.muscleGroup.localeCompare(b.muscleGroup));
  return { from: range.from, to: range.to, muscles };
};

export const handleMcpTool = async (name: string, args: Record<string, unknown>, loaded: AppData | null | McpLoadedUserData): Promise<Record<string, unknown>> => {
  const { data, updatedAt } = normalizeLoadedData(loaded);
  if (!data) return { message: 'Tu cuenta está conectada, pero todavía no hay una copia de Radian subida a D1.' };
  if (name === 'get_profile') return withVersion(profileResult(data), updatedAt);
  if (name === 'get_weekly_coach') {
    const summary = buildWeeklySummary(data);
    return withVersion({ ...summary, text: weeklySummaryText(data) }, updatedAt);
  }
  if (name === 'get_recommendations') return withVersion({ recommendations: recommendationsResult(data), signals: detectTrainingSignals(data) }, updatedAt);
  if (name === 'get_next_session') return withVersion(nextSessionResult(data), updatedAt);
  if (name === 'get_chat_context') return withVersion(chatContextResult(data), updatedAt);
  if (name === 'get_equipment_alternatives') {
    const limit = equipmentAlternativesLimit(args);
    const definition = matchedDefinition(data, args.exercise);
    return withVersion({ query: args.exercise, matchedExercise: definition ? definitionResult(definition) : null, alternatives: definition ? alternativesResult(data, definition, limit) : [] }, updatedAt);
  }
  if (name === 'explain_recommendation') {
    const definition = matchedDefinition(data, args.exercise);
    return withVersion(definition ? recommendationExplanation(data, definition) : { matchedExercise: null, recommendation: null, evidence: [], alternatives: [] }, updatedAt);
  }
  if (name === 'estimate_1rm') return withVersion(estimate1rmResult(data, args.exercise), updatedAt);
  if (name === 'muscle_balance') {
    const range = rangeFor({ ...args, period: args.period ?? 'this_week' });
    return withVersion(muscleBalanceResult(data, range), updatedAt);
  }
  if (name === 'list_workouts') {
    const range = rangeFor(args);
    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit debe ser un entero entre 1 y 50.');
    const workouts = sortedSessions(data).filter((session) => inRange(session.dateKey, range)).slice(0, limit).map((session) => sessionResult(data, session));
    return withVersion({ ...range, returned: workouts.length, workouts }, updatedAt);
  }
  if (name === 'exercise_history') {
    const query = typeof args.exercise === 'string' ? normalizeText(args.exercise) : '';
    if (!query) throw new Error('exercise es obligatorio.');
    const range = rangeFor(args);
    const limit = args.limit === undefined ? 20 : args.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit debe ser un entero entre 1 y 50.');
    const matches = sortedSessions(data).filter((session) => inRange(session.dateKey, range)).flatMap((session) => session.plannedExercises.filter((exercise) => exerciseMatches(data, exercise, query)).map((exercise) => ({
      date: session.dateKey,
      workoutId: session.id,
      ...sessionResult(data, session).exercises.find((item) => item.exerciseId === exercise.exerciseId && item.name === exercise.name),
    }))).slice(0, limit);
    return withVersion({ query: args.exercise, ...range, returned: matches.length, matches }, updatedAt);
  }
  if (name === 'get_bodyweight') {
    const range = rangeFor(args);
    const entries = [...data.progress].filter((entry) => inRange(entry.date, range)).sort((a, b) => a.date.localeCompare(b.date));
    const allEntries = [...data.progress].sort((a, b) => a.date.localeCompare(b.date));
    const latest = [...allEntries].reverse().find((entry) => entry.weightKg !== undefined);
    return withVersion({ ...range, currentProfileWeightKg: data.profile.currentWeightKg, latestWeightKg: latest?.weightKg, latestDate: latest?.date, entries: entries.map((entry: ProgressEntry) => ({ id: entry.id, date: entry.date, weightKg: entry.weightKg, waistCm: entry.waistCm, chestCm: entry.chestCm, armCm: entry.armCm, hipCm: entry.hipCm })) }, updatedAt);
  }
  throw new Error(`Herramienta no reconocida: ${name}.`);
};
