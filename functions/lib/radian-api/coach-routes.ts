import { enforceAuthRateLimit, getAuthenticatedContext, isRecord, json, randomId } from '../auth';
import { readGymState } from '../db/radian/state';
import { enqueueDurableJob, type JobQueueLike } from './jobs';
import { coachRuntime, type CoachWorkerEnvironment } from './coach.js';
import { readSmallText } from './request';
import type { SyncContext, SyncEnv } from '../../types';

export type CoachApiEnvironment = SyncEnv & CoachWorkerEnvironment & { PUSH_QUEUE?: JobQueueLike };
export type CoachApiContext = SyncContext & { env: CoachApiEnvironment };

const MAX_REQUEST_BYTES = 12_000;

const readCoachBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const text = await readSmallText(request, MAX_REQUEST_BYTES);
  if (!text.ok) return null;
  try {
    const body: unknown = JSON.parse(text.value);
    return isRecord(body) ? body : null;
  } catch { return null; }
};

const activeJob = async (database: NonNullable<CoachApiEnvironment['DB']>, accountId: string) => database.prepare(
  `SELECT job_id AS jobId, payload_json AS payloadJson, created_at AS createdAt
     FROM gym_durable_jobs WHERE account_id = ? AND job_type = 'coach' AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
).bind(accountId).first<{ jobId: string; payloadJson: string; createdAt: string }>();

const hasConsent = (state: Record<string, unknown>): boolean => {
  const coach = state.coach;
  return !!coach && typeof coach === 'object' && !Array.isArray(coach)
    && !!(coach as Record<string, unknown>).consent
    && typeof (coach as Record<string, unknown>).consent === 'object'
    && !!((coach as Record<string, unknown>).consent as Record<string, unknown>).agreedAt;
};

export const startCoachJob = async (context: CoachApiContext, kind: 'create' | 'review' | 'debrief'): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, `coach-${kind}`, authenticated.user.id);
  if (limited) return limited;
  const env = context.env;
  const runtime = await coachRuntime(env);
  if (!runtime.configured || !env.PUSH_QUEUE) return json({ error: 'coach_off' }, 503);
  const body = await readCoachBody(context.request);
  if (!body) return json({ error: 'invalid_request' }, 400);
  const database = authenticated.env.DB!;
  const accountId = authenticated.user.id;
  let snapshot;
  try { snapshot = await readGymState(database, accountId); }
  catch { return json({ error: 'coach_state_unavailable' }, 503); }
  if (!snapshot.state) return json({ error: 'nostate' }, 409);
  if (!hasConsent(snapshot.state)) return json({ error: 'consent' }, 403);

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  if (await activeJob(database, accountId)) return json({ error: 'busy' }, 409);

  const options: Record<string, unknown> = {};
  if (kind === 'create') {
    if (body.intake !== undefined && body.intake !== null && !isRecord(body.intake)) return json({ error: 'invalid_intake' }, 400);
    if (body.intake) options.intake = body.intake;
    if (body.refine !== undefined) {
      if (typeof body.refine !== 'string' || body.refine.length > runtime.maxMessageLen) return json({ error: 'invalid_refine' }, 400);
      options.refine = body.refine;
      const pending = await database.prepare(
        `SELECT payload_json AS payloadJson FROM gym_coach_proposals
          WHERE account_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      ).bind(accountId).first<{ payloadJson: string }>();
      if (pending) {
        try {
          const proposal = JSON.parse(pending.payloadJson) as Record<string, unknown>;
          if (typeof proposal.expiresAt !== 'number' || proposal.expiresAt >= Date.now()) {
            if (proposal.bundle) options.previous = proposal.bundle;
            const priorIteration = Number(proposal.iteration);
            options.iteration = Number.isInteger(priorIteration) && priorIteration > 0 ? Math.min(100, priorIteration + 1) : 2;
          }
        } catch { /* malformed stored proposals are not sent back to the provider */ }
      }
    }
  } else if (kind === 'review') {
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > runtime.maxMessageLen)) return json({ error: 'invalid_note' }, 400);
    if (body.note) options.note = body.note;
  } else {
    if (body.workoutId !== undefined && body.workoutId !== null
      && (typeof body.workoutId !== 'string' || body.workoutId.length > 128)) return json({ error: 'invalid_workout' }, 400);
    if (typeof body.workoutId === 'string') options.workoutId = body.workoutId;
  }
  const lang = typeof body.lang === 'string' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body.lang) ? body.lang : undefined;
  const queued = await enqueueDurableJob(database, env.PUSH_QUEUE, {
    accountId,
    type: 'coach',
    idempotencyKey: randomId(18),
    payload: { kind, lang, options },
    coachAdmission: {
      perProfileDaily: runtime.caps.perProfileDaily,
      instanceDaily: runtime.caps.instanceDaily,
      dayStart: dayStart.toISOString(),
    },
  });
  if (!queued.ok) {
    if (await activeJob(database, accountId)) return json({ error: 'busy' }, 409);
    if (queued.error === 'coach_cap') return json({ error: 'cap' }, 429);
    return json({ error: queued.error }, 503);
  }
  return json({ job: { id: queued.jobId, kind, state: 'queued', startedAt: Date.now() } }, 202);
};

export const coachStatus = async (context: CoachApiContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'coach-status', authenticated.user.id);
  if (limited) return limited;
  const database = authenticated.env.DB!;
  const accountId = authenticated.user.id;
  const runtime = await coachRuntime(authenticated.env);
  const [active, proposal, latest, count] = await Promise.all([
    activeJob(database, accountId),
    database.prepare(`SELECT payload_json AS payloadJson FROM gym_coach_proposals
      WHERE account_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`).bind(accountId).first<{ payloadJson: string }>(),
    database.prepare(`SELECT job_id AS jobId, payload_json AS payloadJson, status, result_json AS resultJson, updated_at AS updatedAt
      FROM gym_durable_jobs WHERE account_id = ? AND job_type = 'coach'
      ORDER BY created_at DESC LIMIT 1`).bind(accountId).first<{ jobId: string; payloadJson: string; status: string; resultJson: string | null; updatedAt: string }>(),
    database.prepare(`SELECT COUNT(*) AS used FROM gym_durable_jobs WHERE account_id = ? AND job_type = 'coach' AND created_at >= ?`)
      .bind(accountId, new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString()).first<{ used: number }>(),
  ]);
  const decode = (value: string | null | undefined): Record<string, unknown> => {
    try { const parsed: unknown = value ? JSON.parse(value) : {}; return isRecord(parsed) ? parsed : {}; }
    catch { return {}; }
  };
  const activePayload = decode(active?.payloadJson);
  const latestPayload = decode(latest?.payloadJson);
  const latestResult = decode(latest?.resultJson);
  const activeKind = activePayload.kind;
  const lastKind = latestPayload.kind;
  const pending = decode(proposal?.payloadJson);
  const pendingVisible = typeof pending.expiresAt !== 'number' || pending.expiresAt >= Date.now() ? pending : null;
  let last: Record<string, unknown> | null = null;
  let lastError: Record<string, unknown> | null = null;
  if (latest && (latest.status === 'succeeded' || latest.status === 'failed')) {
    const outcome = latestResult.outcome || (latest.status === 'failed' ? 'failed' : 'ready');
    last = { id: latest.jobId, kind: lastKind, outcome, errorClass: latestResult.errorClass || null,
      at: Date.parse(latest.updatedAt), ...(typeof latestResult.reading === 'string' ? { reading: latestResult.reading } : {}) };
    if (outcome === 'failed') lastError = { errorClass: latestResult.errorClass || 'internal' };
  }
  return json({
    job: active && typeof activeKind === 'string'
      ? { id: active.jobId, kind: activeKind, state: 'running', startedAt: Date.parse(active.createdAt) } : null,
    pending: pendingVisible,
    cap: { used: count?.used ?? 0, limit: runtime.caps.perProfileDaily },
    last,
    lastError,
    maxMessageLen: runtime.maxMessageLen,
  });
};

export const resolveCoachProposal = async (context: CoachApiContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'coach-resolve', authenticated.user.id);
  if (limited) return limited;
  const body = await readCoachBody(context.request);
  if (!body) return json({ error: 'invalid_request' }, 400);
  const accepted = Array.isArray(body.accepted) ? body.accepted.filter((item): item is string => typeof item === 'string') : [];
  const rejected = Array.isArray(body.rejected) ? body.rejected.filter((item): item is string => typeof item === 'string') : [];
  if (accepted.length > 40 || rejected.length > 40 || (!body.dismissed && !accepted.length && !rejected.length)) return json({ error: 'invalid_resolution' }, 400);
  const status = body.dismissed === true ? 'dismissed' : accepted.length ? 'accepted' : 'rejected';
  const result = await authenticated.env.DB!.prepare(`UPDATE gym_coach_proposals SET status = ?, updated_at = ?
    WHERE account_id = ? AND proposal_id = (SELECT proposal_id FROM gym_coach_proposals
      WHERE account_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1) AND status = 'pending'`)
    .bind(status, new Date().toISOString(), authenticated.user.id, authenticated.user.id).run();
  return json({ ok: true, resolved: (result.meta?.changes ?? 0) === 1 });
};

export const forgetCoach = async (context: CoachApiContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'coach-forget', authenticated.user.id);
  if (limited) return limited;
  const database = authenticated.env.DB!;
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`UPDATE gym_durable_jobs SET status = 'cancelled', updated_at = ?
      WHERE account_id = ? AND job_type = 'coach' AND status IN ('queued', 'running')`).bind(now, authenticated.user.id),
    database.prepare(`UPDATE gym_coach_proposals SET status = 'dismissed', updated_at = ?
      WHERE account_id = ? AND status = 'pending'`).bind(now, authenticated.user.id),
  ]);
  return json({ ok: true });
};
