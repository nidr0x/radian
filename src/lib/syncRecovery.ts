import type { AppData } from '../types';
import { parseBackup, serializeBackup } from './storage';

const CHECKPOINT_KEY = 'radian-account-checkpoint-v1';
const RECOVERY_KEY = 'radian-sync-recovery-v1';
export interface Checkpoint { userId: string; version: string; snapshot: string; syncedAt: string; localVersion?: string }
export interface RecoveryCopy { savedAt: string; backup: string }
export const dataVersion = (data: AppData, revision: number): string => `${data.sessions.length}:${data.progress.length}:${data.checkins.length}:${data.plan.version}:${revision}`;
export const dataRevisionFromVersion = (version?: string): number => {
  const parts = version?.split(':');
  const revision = Number(parts?.at(-1));
  return parts?.length === 5 && Number.isInteger(revision) && revision >= 0 ? revision : 0;
};
export const readCheckpoint = (): Checkpoint | undefined => {
  try {
    const value = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? 'null');
    return value && ['userId', 'version', 'snapshot', 'syncedAt'].every((key) => typeof value[key] === 'string') && (value.localVersion === undefined || typeof value.localVersion === 'string') ? value : undefined;
  } catch { return undefined; }
};
export const saveCheckpoint = (userId: string, version: string, data: AppData, localVersion: string): void => {
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ userId, version, snapshot: JSON.stringify(data), syncedAt: new Date().toISOString(), localVersion }));
};
export const syncDecision = (local: AppData, remote: AppData, version: string | undefined, checkpoint: Checkpoint | undefined, userId: string): 'same' | 'upload' | 'download' | 'conflict' => {
  if (JSON.stringify(local) === JSON.stringify(remote)) return 'same';
  if (!checkpoint || checkpoint.userId !== userId) {
    return local.onboardingComplete || local.sessions.length || local.progress.length || local.checkins.length ? 'conflict' : 'download';
  }
  const localChanged = JSON.stringify(local) !== checkpoint.snapshot;
  const remoteChanged = version !== checkpoint.version;
  return localChanged ? remoteChanged ? 'conflict' : 'upload' : 'download';
};
export const readRecovery = (): RecoveryCopy | undefined => {
  try {
    const value = JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? 'null');
    if (!value || typeof value.savedAt !== 'string' || typeof value.backup !== 'string') return undefined;
    parseBackup(value.backup);
    return value;
  } catch { return undefined; }
};
export const preserveRecovery = (data: AppData): RecoveryCopy => {
  const copy = { savedAt: new Date().toISOString(), backup: serializeBackup(data) };
  // Refuse to overwrite either side when the recovery copy cannot be persisted.
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(copy));
  return copy;
};
