import type {
  AppData,
  ExerciseDefinition,
  ProgressEntry,
  UserProfile,
  WeeklyCheckin,
  WorkoutPlan,
  WorkoutSession,
} from '../src/types';

export interface D1ResultLike {
  success: boolean;
  meta?: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface McpRevisionRow {
  id: string;
  userId: string;
  payload: string;
  source: string;
  createdAt: string;
  expiresAt: string;
  restoredAt: string | null;
}

export interface McpPendingChangeRow {
  id: string;
  userId: string;
  clientId: string;
  kind: string;
  payload: string;
  baseUpdatedAt: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface McpMutationResult {
  updatedAt: string;
  summary: Record<string, unknown>;
  revisionId?: string;
}

export interface McpLoadedUserData {
  data: AppData | null;
  updatedAt?: string;
}

export type McpProfilePatch = Partial<Pick<
UserProfile,
'goal'
| 'gym'
| 'trainingDays'
| 'sessionMinutes'
| 'experienceLevel'
| 'availableEquipment'
| 'heightCm'
| 'currentWeightKg'
| 'nutritionContext'
| 'largeText'
| 'theme'
>>;

export interface McpUpdateProfileOperation {
  kind: 'update_profile';
  profile: McpProfilePatch;
}

export interface McpReplaceRoutineOperation {
  kind: 'replace_routine';
  plan: WorkoutPlan;
  exercises: ExerciseDefinition[];
}

export interface McpWorkoutValidationContext {
  exercises?: Array<Pick<ExerciseDefinition, 'id'>>;
  plan?: {
    days?: Array<Pick<WorkoutPlan['days'][number], 'id'>>;
  };
}

export interface McpRecordWorkoutOperation {
  kind: 'record_workout';
  workout: WorkoutSession;
}

export interface McpAddMeasurementOperation {
  kind: 'add_measurement';
  entry: ProgressEntry;
}

export interface McpAddCheckinOperation {
  kind: 'add_checkin';
  checkin: WeeklyCheckin;
}

export interface McpDeleteWorkoutOperation {
  kind: 'delete_workout';
  workoutId: string;
}

export interface McpDeleteMeasurementOperation {
  kind: 'delete_measurement';
  measurementId: string;
}

export interface McpDeleteCheckinOperation {
  kind: 'delete_checkin';
  checkinId: string;
}

export interface McpReplaceAllDataOperation {
  kind: 'replace_all_data';
  data: AppData;
}

export interface McpDeleteAllDataOperation {
  kind: 'delete_all_data';
}

export type McpPreviewableChange =
  | McpDeleteWorkoutOperation
  | McpDeleteMeasurementOperation
  | McpDeleteCheckinOperation
  | McpReplaceAllDataOperation
  | McpDeleteAllDataOperation;

export interface McpPreviewChangeOperation {
  kind: 'preview_change';
  change: McpPreviewableChange;
}

export interface McpApplyChangeOperation {
  kind: 'apply_change';
  changeId: string;
  confirm: boolean;
}

export interface McpListRevisionsOperation {
  kind: 'list_revisions';
}

export interface McpRestoreRevisionOperation {
  kind: 'restore_revision';
  revisionId: string;
}

export type McpWriteOperation =
  | McpUpdateProfileOperation
  | McpReplaceRoutineOperation
  | McpRecordWorkoutOperation
  | McpAddMeasurementOperation
  | McpAddCheckinOperation
  | McpDeleteWorkoutOperation
  | McpDeleteMeasurementOperation
  | McpDeleteCheckinOperation
  | McpReplaceAllDataOperation
  | McpDeleteAllDataOperation
  | McpPreviewChangeOperation
  | McpApplyChangeOperation
  | McpListRevisionsOperation
  | McpRestoreRevisionOperation;

export interface McpWriteRequest {
  userId: string;
  clientId: string;
  baseUpdatedAt?: string;
  operation: McpWriteOperation;
}

export interface SyncEnv {
  DB?: D1DatabaseLike;
  AUTH_RATE_LIMITER?: RateLimiterLike;
  SESSION_SECRET?: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_ORIGIN?: string;
  MCP_ORIGIN?: string;
  RADIAN_API?: string;
  OPENGYM_API?: string;
  PASSWORD_LOGIN?: string;
  INVITE_ONLY?: string;
  FIRST_USER_ADMIN?: string;
  ADMIN_UIDS?: string;
  AUDIT_LOG?: string;
  AUDIT_MAX?: string;
  AUDIT_DAYS?: string;
  AUDIT_IP?: string;
  ALLOW_GUEST?: string;
}

export interface SyncContext {
  request: Request;
  env: SyncEnv;
}
