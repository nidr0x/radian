import { useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowDown, ArrowUp, BarChart3, CalendarDays, Check, ChevronRight, CircleHelp, Clipboard, CloudOff,
  Dumbbell, Download, FileJson, Fingerprint, Gauge, History, Info, KeyRound, Layers3, LockKeyhole, LogIn, LogOut, Minus, Moon, MoreHorizontal, Pause, Pencil, Play,
  Plus, RotateCcw, Save, Search, Settings2, ShieldCheck, SkipForward, Sparkles, Sun, Timer, Trash2, Trophy, Upload, UserPlus, UserRound, X,
  Maximize2, Minimize2,
} from 'lucide-react';
import { currentWeekday, dateKey, dayNames, formatDate, formatDuration, normalizeTrainingDays, scheduledWorkoutDays, shortDayNames, weekKey } from './lib/date';
import { exerciseGuidance } from './data/initialPlan';
import { adaptPlanToEquipment, allExerciseEquipment, compatibleAlternatives, equipmentLabel, exerciseMatches, planEquipmentGaps, unresolvedPlanEquipmentGaps, type PlanEquipmentGap } from './lib/exercises';
import { progressionAction, progressionCue, recommendationFor } from './lib/recommendations';
import { isWorkSet } from './lib/progression';
import { bestRecordForExercise, detectPersonalRecord, type ExerciseRecord } from './lib/records';
import { createSession, createSetLogs, loadData, migrateData, parseBackup, persistData, serializeBackup } from './lib/storage';
import { exerciseTrend } from './lib/exerciseHistory';
import { compareSyncCopies, deleteSyncData, generateSyncKey, loadSyncState, normalizeSyncKey, persistSyncState, pullSyncData, pushSyncData, SyncApiError, type RemoteSyncData, type SyncState } from './lib/sync';
import { buildWeeklySummary } from './lib/weeklySummary';
import { applyAppUpdate, hasAppUpdate } from './lib/pwa';
import { readCheckpoint, saveCheckpoint, syncDecision, readRecovery, preserveRecovery } from './lib/syncRecovery';
import { requestScreenWakeLock, type ScreenWakeLock } from './lib/wakeLock';
import { summarizeSession, type SessionSummary } from './lib/sessionSummary';
import { sessionAdaptation } from './lib/sessionAdaptation';
import { completionActionHint, dataStateCopy, todayPrimaryAction, updateActionCopy } from './lib/uiCopy';
import { textSizeToggleLabel, themeOptionLabel } from './lib/accessibility';
import { routineEditDraftFrom, routineEditPatch, type RoutineEditDraft } from './lib/routineEditor';
import { addPasskey, AuthApiError, currentUser, listPasskeys, loginWithPasskey, logout, logoutEverywhere, pullCloudData, pushCloudData, registerPasskey, renamePasskey, revokePasskey, type AuthPasskey, type AuthUser, type CloudData } from './lib/auth';
import type {
  AppData, Difficulty, Energy, ExperienceLevel, ExerciseDefinition, ExerciseEquipment, ExerciseGuidance, ExerciseSession, PlannedExercise, ProgressEntry, SessionReadiness, SetLog, Soreness, Theme, UserProfile, View, WeeklyCheckin, WorkoutDay, WorkoutSession,
} from './types';

const navItems: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: 'today', label: 'Hoy', icon: Activity }, { id: 'routine', label: 'Rutina', icon: Dumbbell },
  { id: 'progress', label: 'Progreso', icon: BarChart3 }, { id: 'profile', label: 'Perfil', icon: UserRound },
];

const difficultyOptions: Array<{ value: Difficulty; label: string; hint: string }> = [
  { value: 'easy', label: 'Fácil', hint: 'Había margen' }, { value: 'good', label: 'Bien', hint: 'En su punto' },
  { value: 'hard', label: 'Difícil', hint: 'Costó bastante' }, { value: 'incomplete', label: 'No pude', hint: 'No completado' },
];

const formatWeight = (value?: number): string => value === undefined ? 'Sin registro' : `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} kg`;
const formatSessionDuration = (seconds: number): string => {
  if (seconds < 60) return '<1 min';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
type SyncStatus = 'idle' | 'checking' | 'syncing' | 'ready' | 'remote' | 'synced' | 'conflict' | 'unavailable' | 'error';
type AuthStatus = 'checking' | 'signed_out' | 'registering' | 'signing_in' | 'syncing' | 'signed_in' | 'error';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function App() {
  const [data, setData] = useState<AppData>(() => loadData());
  const [view, setView] = useState<View>('today');
  const [activeDayId, setActiveDayId] = useState<string>(() => data.plan.days.find((day) => day.weekday === currentWeekday())?.id ?? data.plan.days[0].id);
  const [toast, setToast] = useState<string>();
  const [storageWarning, setStorageWarning] = useState<string>();
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [restRemaining, setRestRemaining] = useState(0);
  const [restUntil, setRestUntil] = useState<number | null>(null);
  const [restPaused, setRestPaused] = useState(false);
  const [theme, setTheme] = useState<Theme>(data.profile.theme);
  const [syncState, setSyncState] = useState<SyncState>(() => loadSyncState());
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncError, setSyncError] = useState<string>();
  const [syncConflict, setSyncConflict] = useState<RemoteSyncData>();
  const [syncReady, setSyncReady] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser>();
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  const [authError, setAuthError] = useState<string>();
  const [passkeys, setPasskeys] = useState<AuthPasskey[]>([]);
  const [cloudUpdatedAt, setCloudUpdatedAt] = useState<string>();
  const [cloudConflict, setCloudConflict] = useState<CloudData>();
  const [online, setOnline] = useState(navigator.onLine);
  const [updateAvailable, setUpdateAvailable] = useState(hasAppUpdate);
  const [recovery, setRecovery] = useState(readRecovery);
  const [acknowledged, setAcknowledged] = useState(() => readCheckpoint()?.snapshot);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const cloudBusyRef = useRef(false);
  const acknowledge = (snapshot: AppData, updatedAt?: string): void => {
    if (!updatedAt || !authUserRef.current) return;
    saveCheckpoint(authUserRef.current.id, updatedAt, snapshot);
    setAcknowledged(JSON.stringify(snapshot));
    cloudUpdatedAtRef.current = updatedAt;
    setCloudUpdatedAt(updatedAt);
  };
  useEffect(() => {
    const connected = () => setOnline(navigator.onLine);
    const updated = () => setUpdateAvailable(true);
    window.addEventListener('online', connected);
    window.addEventListener('offline', connected);
    window.addEventListener('radian-update', updated);
    return () => {
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', connected);
      window.removeEventListener('radian-update', updated);
    };
  }, []);
  const [lastSessionChange, setLastSessionChange] = useState<{ sessionId: string; snapshot: WorkoutSession }>();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [screenWakeLockActive, setScreenWakeLockActive] = useState(false);
  const screenWakeLockRef = useRef<ScreenWakeLock | undefined>(undefined);
  const syncStateRef = useRef(syncState);
  const authUserRef = useRef<AuthUser | undefined>(undefined);
  const cloudUpdatedAtRef = useRef<string | undefined>(undefined);
  const cloudSyncReadyRef = useRef(false);
  const cloudRefreshRef = useRef(0);

  const reportAuthError = (error: unknown, fallback: string): void => {
    const value = error instanceof AuthApiError ? error : new AuthApiError(fallback, 0);
    if (value.status === 409 && value.remote?.data) {
      cloudSyncReadyRef.current = false;
      setCloudConflict(value.remote);
      setAuthError('Hay una versión más reciente en la nube. Elige qué copia conservar.');
    } else {
      setAuthError(value.message);
    }
  };

  useEffect(() => {
    syncStateRef.current = syncState;
    const persisted = persistSyncState(syncState);
    setStorageWarning((current) => persisted ? current === 'No se pudo guardar el progreso en este dispositivo.' ? undefined : current : 'No se pudo guardar la configuración local. Comprueba el espacio disponible.');
  }, [syncState]);
  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);
  useEffect(() => {
    const persisted = persistData(data);
    setStorageWarning((current) => persisted ? current === 'No se pudo guardar la configuración local. Comprueba el espacio disponible.' ? undefined : current : 'No se pudo guardar el progreso en este dispositivo.');
    if (!online || !syncReady || !syncState.key) return undefined;
    const timer = window.setTimeout(() => {
      const currentState = syncStateRef.current;
      setSyncStatus('syncing');
      pushSyncData(data, currentState).then(({ updatedAt }) => {
        setSyncState((current) => ({ ...current, remoteUpdatedAt: updatedAt }));
        setSyncConflict(undefined);
        setSyncStatus('synced');
        setSyncError(undefined);
      }).catch((error: unknown) => {
        const syncErrorValue = error instanceof SyncApiError ? error : new SyncApiError('No se pudo sincronizar ahora.', 0);
        if (syncErrorValue.status === 409 && syncErrorValue.remote?.data) setSyncConflict(syncErrorValue.remote);
        if (syncErrorValue.status === 409) setSyncReady(false);
        setSyncStatus(syncErrorValue.status === 409 ? 'conflict' : syncErrorValue.status === 503 ? 'unavailable' : 'error');
        setSyncError(syncErrorValue.message);
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [data, syncReady, syncState.key, online]);
  useEffect(() => {
    if (!online || !authUser || !cloudSyncReadyRef.current || cloudBusyRef.current || JSON.stringify(data) === acknowledged) return undefined;
    const timer = window.setTimeout(() => {
      setAuthStatus('syncing');
      cloudBusyRef.current = true;
      pushCloudData(data, cloudUpdatedAtRef.current).then(({ updatedAt }) => {
        acknowledge(data, updatedAt);
        setAuthStatus('signed_in');
        setAuthError(undefined);
      }).catch((error: unknown) => {
        const value = error instanceof AuthApiError ? error : new AuthApiError('No se pudo sincronizar con D1.', 0);
        if (value.status === 401) {
          cloudSyncReadyRef.current = false;
          setAuthUser(undefined);
          setAuthStatus('signed_out');
        } else if (value.status === 409 && value.remote?.data) {
          cloudSyncReadyRef.current = false;
          setCloudConflict(value.remote);
          setAuthStatus('error');
        } else {
          setAuthStatus('error');
        }
        reportAuthError(value, 'No se pudo sincronizar con D1.');
      }).finally(() => {
        cloudBusyRef.current = false;
        if (dataRef.current !== data) setSyncAttempt((value) => value + 1);
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [authUser, data, online, syncAttempt, acknowledged]);
  useEffect(() => {
    let cancelled = false;
    currentUser().then(async (user) => {
      if (cancelled) return;
      if (!user) {
        setAuthStatus('signed_out');
        return;
      }
      try {
        await hydrateAccount(user, dataRef.current);
      } catch (error: unknown) {
        if (cancelled) return;
        cloudSyncReadyRef.current = false;
        setAuthStatus('error');
        reportAuthError(error, 'No se pudo cargar la cuenta en la nube.');
      }
    }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof AuthApiError && error.status === 503) {
        setAuthStatus('error');
        setAuthError(error.message);
      } else {
        setAuthStatus('signed_out');
      }
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.textSize = data.profile.largeText ? 'large' : 'normal';
    document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
  }, [data.profile.largeText, theme]);
  useEffect(() => {
    const handleInstallPrompt = (event: Event): void => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = (): void => { setInstallPrompt(null); setIsInstalled(true); };
    const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setIsInstalled(standalone);
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', handleInstallPrompt); window.removeEventListener('appinstalled', handleInstalled); };
  }, []);
  useEffect(() => {
    if (restUntil === null) return undefined;
    const updateRest = (): void => {
      const remaining = Math.max(0, Math.ceil((restUntil - Date.now()) / 1000));
      setRestRemaining(remaining);
      if (remaining === 0) {
        setRestUntil(null);
        setRestPaused(false);
        if ('vibrate' in navigator) navigator.vibrate?.(90);
        setToast('Descanso terminado');
      }
    };
    updateRest();
    const timer = window.setInterval(updateRest, 250);
    return () => window.clearInterval(timer);
  }, [restUntil]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(undefined), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const updateData = (updater: (current: AppData) => AppData): void => setData((current) => updater(current));
  const startRest = (seconds: number): void => {
    setRestUntil(Date.now() + seconds * 1000);
    setRestRemaining(seconds);
    setRestPaused(false);
  };
  const pauseRest = (): void => {
    if (restRemaining <= 0) return;
    setRestUntil(null);
    setRestPaused(true);
  };
  const resumeRest = (): void => {
    if (restRemaining <= 0) return;
    setRestUntil(Date.now() + restRemaining * 1000);
    setRestPaused(false);
  };
  const adjustRest = (seconds: number): void => {
    const next = Math.max(1, restRemaining + seconds);
    setRestRemaining(next);
    setRestUntil(restPaused ? null : Date.now() + next * 1000);
  };
  useEffect(() => setData((current) => migrateData(current)), []);
  const scheduledDays = scheduledWorkoutDays(data.plan.days, data.profile.trainingDays);
  const todayDay = scheduledDays.find((day) => day.weekday === currentWeekday());
  const activeDay = scheduledDays.find((day) => day.id === activeDayId) ?? scheduledDays[0];
  const activeSession = data.sessions.find((session) => session.status === 'in_progress');
  const hasActiveSession = Boolean(activeSession);

  useEffect(() => {
    let cancelled = false;
    const release = (): void => {
      const lock = screenWakeLockRef.current;
      screenWakeLockRef.current = undefined;
      setScreenWakeLockActive(false);
      if (lock && !lock.released) void lock.release();
    };
    const acquire = async (): Promise<void> => {
      if (!hasActiveSession || document.visibilityState !== 'visible') return;
      const lock = await requestScreenWakeLock();
      if (cancelled) {
        if (lock && !lock.released) void lock.release();
        return;
      }
      screenWakeLockRef.current = lock;
      setScreenWakeLockActive(Boolean(lock));
      lock?.addEventListener('release', () => {
        if (!cancelled) setScreenWakeLockActive(false);
      });
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && hasActiveSession && !screenWakeLockRef.current) void acquire();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!hasActiveSession) release(); else void acquire();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      release();
    };
  }, [hasActiveSession]);

  const startSession = (day: WorkoutDay, readiness?: SessionReadiness): void => {
    const existing = data.sessions.find((session) => session.status === 'in_progress');
    if (existing) { setView('today'); setToast('Tienes una sesión pendiente'); return; }
    const session = createSession(day, dateKey(), new Date(), data.sessions, readiness);
    updateData((current) => ({ ...current, sessions: [...current.sessions, session] }));
    setView('today');
    setToast('Sesión preparada');
  };

  const updateSession = (sessionId: string, updater: (session: WorkoutSession) => WorkoutSession): void => {
    updateData((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === sessionId ? updater(session) : session) }));
  };

  const updateExerciseDraft = (sessionId: string, plannedExerciseId: string, patch: Partial<ExerciseSession>): void => {
    updateSession(sessionId, (current) => ({
      ...current,
      plannedExercises: current.plannedExercises.map((exercise) => exercise.plannedExerciseId === plannedExerciseId ? { ...exercise, ...patch } : exercise),
    }));
  };

  const swapSessionExercise = (sessionId: string, plannedExerciseId: string, replacement: ExerciseDefinition): void => {
    const session = data.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setLastSessionChange({ sessionId, snapshot: session });
    updateSession(sessionId, (current) => ({
      ...current,
      plannedExercises: current.plannedExercises.map((item) => item.plannedExerciseId === plannedExerciseId ? {
        ...item,
        exerciseId: replacement.id,
        name: replacement.name,
        imageUrl: replacement.imageUrl,
        imagePosition: replacement.imagePosition,
        completed: false,
        difficulty: undefined,
        completedAt: undefined,
        discomfort: false,
        discomfortNote: item.discomfortNote ? `Sustituido desde ${item.name}: ${item.discomfortNote}` : `Sustituido desde ${item.name} por una molestia`,
        setLogs: createSetLogs(item.sets, item.repMin, undefined, undefined, { warmupSets: item.warmupSets }),
      } : item),
    }));
    setToast(`Cambio guardado: ${replacement.name}`);
  };

  const completeExercise = (session: WorkoutSession, exercise: ExerciseSession, patch: Partial<ExerciseSession>, shouldStartRest: boolean): void => {
    const updated = { ...exercise, ...patch, completedAt: new Date().toISOString() };
    const personalRecord = detectPersonalRecord(updated, data.sessions);
    const nextIndex = Math.min(session.activeExerciseIndex + 1, session.plannedExercises.length - 1);
    const isLast = session.activeExerciseIndex === session.plannedExercises.length - 1;
    setLastSessionChange({ sessionId: session.id, snapshot: session });
    updateSession(session.id, (current) => ({
      ...current,
      activeExerciseIndex: nextIndex,
      status: isLast ? 'completed' : 'in_progress',
      completedAt: isLast ? new Date().toISOString() : undefined,
      plannedExercises: current.plannedExercises.map((item, index) => index === current.activeExerciseIndex ? updated : item),
    }));
    if (shouldStartRest && !isLast) startRest(exercise.restSeconds);
    setToast(personalRecord ? personalRecord.kind === 'first' ? `Primera marca: ${formatWeight(personalRecord.weightKg)}` : personalRecord.kind === 'weight' ? `Nuevo récord: ${formatWeight(personalRecord.weightKg)}` : `Nuevo récord de volumen: ${formatWeight(personalRecord.weightKg)}` : isLast ? 'Sesión completada' : patch.difficulty === 'incomplete' ? 'Ejercicio saltado' : 'Guardado automáticamente');
  };

  const undoLastSessionChange = (): void => {
    if (!lastSessionChange) return;
    updateData((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === lastSessionChange.sessionId ? lastSessionChange.snapshot : session) }));
    setLastSessionChange(undefined);
    setToast('Último ejercicio restaurado');
  };

  const leaveSession = (): void => setExitDialogOpen(true);
  const confirmLeaveSession = (): void => {
    setExitDialogOpen(false);
    setRestUntil(null);
    setRestRemaining(0);
    setRestPaused(false);
    setView('routine');
    setToast('Sesión guardada para retomarla cuando quieras');
  };

  const updateRoutineDay = (dayId: string, updater: (day: WorkoutDay) => WorkoutDay): void => {
    updateData((current) => ({ ...current, plan: { ...current.plan, version: current.plan.version + 1, days: current.plan.days.map((day) => day.id === dayId ? updater(day) : day) } }));
  };

  const addRoutineExercise = (dayId: string, definition: ExerciseDefinition): void => {
    updateRoutineDay(dayId, (day) => ({
      ...day,
      exercises: [...day.exercises, {
        id: `${dayId}-${definition.id}-${Date.now()}`,
        exerciseId: definition.id,
        name: definition.name,
        sets: 3,
        repMin: 8,
        repMax: 12,
        restSeconds: 90,
        active: true,
        warmupSets: 0,
        progressionPolicy: 'double',
        progressionIncrementKg: 2.5,
        imageUrl: definition.imageUrl,
        imagePosition: definition.imagePosition,
      }],
    }));
    setToast(`${definition.name} añadido a la rutina`);
  };

  const removeRoutineExercise = (dayId: string, exerciseId: string): void => {
    const day = data.plan.days.find((item) => item.id === dayId);
    const exercise = day?.exercises.find((item) => item.id === exerciseId);
    if (!day || !exercise || !window.confirm(`¿Quitar ${exercise.name} de esta rutina?`)) return;
    updateRoutineDay(dayId, (current) => ({ ...current, exercises: current.exercises.filter((item) => item.id !== exerciseId) }));
    setToast('Ejercicio quitado de la rutina');
  };

  const addProgress = (entry: Omit<ProgressEntry, 'id' | 'date'>): void => {
    updateData((current) => {
      const nextEntry = { ...entry, id: `progress-${Date.now()}`, date: dateKey() };
      return { ...current, progress: [...current.progress, nextEntry], profile: entry.weightKg === undefined ? current.profile : { ...current.profile, currentWeightKg: entry.weightKg } };
    });
    setToast('Medida guardada');
  };

  const addCheckin = (checkin: Omit<WeeklyCheckin, 'id' | 'createdAt' | 'weekKey'>): void => {
    updateData((current) => ({ ...current, checkins: [...current.checkins.filter((item) => item.weekKey !== weekKey()), { ...checkin, id: `checkin-${Date.now()}`, createdAt: new Date().toISOString(), weekKey: weekKey() }] }));
    setToast('Check-in guardado');
  };

  const changeTheme = (nextTheme: Theme): void => {
    setTheme(nextTheme);
    updateData((current) => ({ ...current, profile: { ...current.profile, theme: nextTheme } }));
  };

  const saveSyncState = (next: SyncState): void => {
    syncStateRef.current = next;
    setSyncState(next);
  };
  const reportSyncError = (error: unknown, fallback: string): void => {
    const syncErrorValue = error instanceof SyncApiError ? error : new SyncApiError(fallback, 0);
    if (syncErrorValue.status === 409 && syncErrorValue.remote?.data) setSyncConflict(syncErrorValue.remote);
    if (syncErrorValue.status === 409 && syncErrorValue.remote?.updatedAt) saveSyncState({ ...syncStateRef.current, remoteUpdatedAt: syncErrorValue.remote.updatedAt });
    setSyncStatus(syncErrorValue.status === 409 ? 'conflict' : syncErrorValue.status === 503 ? 'unavailable' : 'error');
    setSyncError(syncErrorValue.message);
  };
  const connectSync = async (input: string): Promise<void> => {
    const key = normalizeSyncKey(input);
    if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/.test(key)) {
      setSyncStatus('error');
      setSyncError('El código debe tener este formato: XXXX-XXXX-XXXX.');
      return;
    }
    setSyncStatus('checking');
    setSyncError(undefined);
    try {
      const remote = await pullSyncData(key);
      const nextState = { key, remoteUpdatedAt: remote.updatedAt };
      saveSyncState(nextState);
      if (remote.data) {
        setSyncConflict(remote);
        setSyncReady(false);
        setSyncStatus('remote');
        setToast('Hay una copia remota disponible');
        return;
      }
      setSyncConflict(undefined);
      setSyncStatus('syncing');
      const result = await pushSyncData(data, nextState);
      saveSyncState({ ...nextState, remoteUpdatedAt: result.updatedAt });
      setSyncReady(true);
      setSyncStatus('synced');
      setToast('Copia remota creada');
    } catch (error: unknown) {
      reportSyncError(error, 'No se pudo conectar con la sincronización.');
    }
  };
  const uploadSync = async (): Promise<void> => {
    if (!syncStateRef.current.key) return;
    setSyncStatus('syncing');
    setSyncError(undefined);
    try {
      const result = await pushSyncData(data, syncStateRef.current);
      saveSyncState({ ...syncStateRef.current, remoteUpdatedAt: result.updatedAt });
      setSyncConflict(undefined);
      setSyncReady(true);
      setSyncStatus('synced');
      setToast('Copia subida');
    } catch (error: unknown) {
      reportSyncError(error, 'No se pudo subir la copia.');
    }
  };
  const downloadSync = async (): Promise<void> => {
    if (!syncStateRef.current.key) return;
    setSyncStatus('syncing');
    setSyncError(undefined);
    try {
      const remote = await pullSyncData(syncStateRef.current.key);
      if (!remote.data) throw new SyncApiError('No hay una copia remota con este código.', 404);
      applyRemoteSync(remote, 'Copia descargada');
    } catch (error: unknown) {
      reportSyncError(error, 'No se pudo descargar la copia.');
    }
  };
  const applyRemoteSync = (remote: RemoteSyncData, message: string): boolean => {
    if (!remote.data) return false;
    try {
      setRecovery(preserveRecovery(dataRef.current));
    } catch {
      setSyncStatus('conflict');
      setSyncError('No hay espacio para guardar la copia local recuperable. Exporta tus datos antes de sustituirlos.');
      return false;
    }
    setData(migrateData(remote.data));
    saveSyncState({ ...syncStateRef.current, remoteUpdatedAt: remote.updatedAt });
    setSyncConflict(undefined);
    setSyncReady(true);
    setSyncStatus('synced');
    setSyncError(undefined);
    setToast(message);
    return true;
  };
  const useRemoteSync = (): void => {
    const remote = syncConflict;
    if (!remote?.data) return;
    applyRemoteSync(remote, 'Copia remota conservada');
  };
  const keepLocalSync = async (): Promise<void> => {
    if (!syncConflict?.data || !syncConflict.updatedAt) return;
    try {
      setRecovery(preserveRecovery(syncConflict.data));
    } catch {
      setSyncStatus('conflict');
      setSyncError('No hay espacio para guardar la copia remota recuperable. Exporta tus datos antes de conservar el dispositivo.');
      return;
    }
    saveSyncState({ ...syncStateRef.current, remoteUpdatedAt: syncConflict.updatedAt });
    await uploadSync();
  };
  const disconnectSync = (): void => {
    saveSyncState({});
    setSyncConflict(undefined);
    setSyncReady(false);
    setSyncStatus('idle');
    setSyncError(undefined);
    setToast('Sincronización desconectada');
  };

  const revokeSync = async (): Promise<void> => {
    if (!syncStateRef.current.key || !window.confirm('Se borrará la copia remota y este código dejará de funcionar. ¿Continuar?')) return;
    try {
      await deleteSyncData(syncStateRef.current.key);
      disconnectSync();
      setToast('Copia remota revocada');
    } catch (error: unknown) {
      reportSyncError(error, 'No se pudo revocar la copia remota.');
    }
  };

  const installApp = async (): Promise<void> => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const completeOnboarding = (profile: Partial<UserProfile>): void => {
    updateData((current) => {
      const nextProfile = { ...current.profile, ...profile, trainingDays: normalizeTrainingDays(profile.trainingDays ?? current.profile.trainingDays).slice(0, current.plan.days.length) };
      return {
        ...current,
        onboardingComplete: true,
        profile: nextProfile,
        plan: current.sessions.length === 0 ? adaptPlanToEquipment(current.plan, current.exercises, nextProfile.availableEquipment) : current.plan,
      };
    });
    setToast('Perfil inicial guardado');
  };

  const repeatOnboarding = (): void => {
    setView('today');
    updateData((current) => ({ ...current, onboardingComplete: false }));
  };

  const updateProfile = (profile: Partial<UserProfile>, adaptEquipmentPlan = false): void => {
    updateData((current) => ({
      ...current,
      profile: { ...current.profile, ...profile },
      plan: adaptEquipmentPlan
        ? adaptPlanToEquipment(current.plan, current.exercises, profile.availableEquipment ?? current.profile.availableEquipment)
        : current.plan,
    }));
  };

  const hydrateAccount = async (user: AuthUser, localSnapshot: AppData): Promise<void> => {
    if (cloudBusyRef.current) return;
    cloudBusyRef.current = true;
    try {
    authUserRef.current = user;
    setAuthUser(user);
    setAuthStatus('syncing');
    setAuthError(undefined);
    cloudSyncReadyRef.current = false;
    const remote = await pullCloudData();
    localSnapshot = dataRef.current;
    if (remote.data) {
      const normalized = migrateData(remote.data);
      const decision = syncDecision(localSnapshot, normalized, remote.updatedAt, readCheckpoint(), user.id);
      if (decision === 'conflict') {
        setCloudConflict(remote);
        setAuthStatus('error');
        setAuthError('Hay cambios en ambas copias. Revisa cuál conservar.');
        return;
      }
      if (decision === 'upload') {
        const saved = await pushCloudData(localSnapshot, remote.updatedAt);
        acknowledge(localSnapshot, saved.updatedAt);
      } else {
        if (decision === 'download') {
          setRecovery(preserveRecovery(localSnapshot));
          setData(normalized);
        }
        acknowledge(normalized, remote.updatedAt);
      }
    } else {
      if (readCheckpoint()?.userId === user.id) {
        setAuthStatus('error');
        setAuthError('La copia remota se ha borrado. Tus datos locales siguen guardados; revisa las revisiones del MCP antes de volver a subirlos.');
        return;
      }
      const saved = await pushCloudData(localSnapshot);
      acknowledge(localSnapshot, saved.updatedAt);
    }
    cloudSyncReadyRef.current = true;
    setAuthStatus('signed_in');
    listPasskeys().then(setPasskeys).catch(() => undefined);
    setToast(`Cuenta conectada como ${user.displayName}`);
    } finally {
      cloudBusyRef.current = false;
      setSyncAttempt((value) => value + 1);
    }
  };

  const resolveCloudConflict = async (choice: 'local' | 'remote'): Promise<void> => {
    const conflict = cloudConflict;
    if (!conflict?.data || !authUserRef.current) return;
    try {
      setRecovery(preserveRecovery(choice === 'remote' ? data : migrateData(conflict.data)));
    } catch {
      setAuthError('No hay espacio para guardar la copia recuperable. Exporta tus datos antes de resolver el conflicto.');
      return;
    }
    if (choice === 'remote') {
      const next = migrateData(conflict.data);
      setData(next);
      acknowledge(next, conflict.updatedAt);
      setCloudConflict(undefined);
      setAuthError(undefined);
      cloudSyncReadyRef.current = true;
      setAuthStatus('signed_in');
      setToast('Copia de la nube restaurada');
      return;
    }
    setAuthStatus('syncing');
    try {
      const saved = await pushCloudData(data, conflict.updatedAt);
      acknowledge(data, saved.updatedAt);
      setCloudConflict(undefined);
      setAuthError(undefined);
      cloudSyncReadyRef.current = true;
      setAuthStatus('signed_in');
      setToast('Copia local subida a la nube');
    } catch (error: unknown) {
      setAuthStatus('error');
      reportAuthError(error, 'No se pudo resolver el conflicto de nube.');
    }
  };

  const handleRegisterPasskey = async (displayName: string, passkeyLabel: string): Promise<void> => {
    setAuthStatus('registering');
    setAuthError(undefined);
    try {
      const user = await registerPasskey(displayName, passkeyLabel);
      await hydrateAccount(user, data);
    } catch (error: unknown) {
      cloudSyncReadyRef.current = false;
      const value = error instanceof AuthApiError ? error : new AuthApiError('No se pudo crear la cuenta con passkey.', 0);
      setAuthStatus(value.status === 409 && value.remote?.data ? 'error' : 'signed_out');
      reportAuthError(value, 'No se pudo crear la cuenta con passkey.');
    }
  };

  const clearAuthenticatedState = (): void => {
    cloudSyncReadyRef.current = false;
    authUserRef.current = undefined;
    setAuthUser(undefined);
    setPasskeys([]);
    setCloudUpdatedAt(undefined);
    setCloudConflict(undefined);
    setAuthStatus('signed_out');
  };

  const handleLoginPasskey = async (): Promise<void> => {
    setAuthStatus('signing_in');
    setAuthError(undefined);
    try {
      const user = await loginWithPasskey();
      await hydrateAccount(user, data);
    } catch (error: unknown) {
      cloudSyncReadyRef.current = false;
      const value = error instanceof AuthApiError ? error : new AuthApiError('No se pudo iniciar sesión con passkey.', 0);
      setAuthStatus(value.status === 409 && value.remote?.data ? 'error' : 'signed_out');
      reportAuthError(value, 'No se pudo iniciar sesión con passkey.');
    }
  };

  const handleAddPasskey = async (passkeyLabel: string): Promise<void> => {
    setAuthStatus('registering');
    setAuthError(undefined);
    try {
      await addPasskey(passkeyLabel);
      listPasskeys().then(setPasskeys).catch(() => undefined);
      setAuthStatus('signed_in');
      setToast('Nueva passkey añadida');
    } catch (error: unknown) {
      if (error instanceof AuthApiError && error.status === 401) clearAuthenticatedState();
      else setAuthStatus(authUserRef.current ? 'signed_in' : 'signed_out');
      setAuthError(error instanceof AuthApiError ? error.message : 'No se pudo añadir la passkey.');
    }
  };

  const handleRenamePasskey = async (credentialId: string, label: string): Promise<void> => {
    try {
      await renamePasskey(credentialId, label);
      setPasskeys(await listPasskeys());
      setToast('Nombre de passkey actualizado');
    } catch (error: unknown) {
      if (error instanceof AuthApiError && error.status === 401) clearAuthenticatedState();
      setAuthError(error instanceof AuthApiError ? error.message : 'No se pudo renombrar la passkey.');
    }
  };

  const handleRevokePasskey = async (credentialId: string): Promise<void> => {
    if (!window.confirm('¿Revocar esta passkey? Tendrás que usar otra para volver a entrar.')) return;
    try {
      await revokePasskey(credentialId);
      setPasskeys(await listPasskeys());
      setToast('Passkey revocada');
    } catch (error: unknown) {
      if (error instanceof AuthApiError && error.status === 401) clearAuthenticatedState();
      setAuthError(error instanceof AuthApiError ? error.message : 'No se pudo revocar la passkey.');
    }
  };

  const handleLogout = async (): Promise<void> => {
    let remoteLogoutConfirmed = false;
    try { remoteLogoutConfirmed = await logout(); } catch { /* The local session can still be closed if the network fails. */ }
    clearAuthenticatedState();
    setAuthError(undefined);
    setToast(remoteLogoutConfirmed ? 'Sesión cerrada; tus datos siguen en este dispositivo' : 'Sesión local cerrada; no se pudo confirmar el cierre remoto');
  };

  const handleLogoutEverywhere = async (): Promise<void> => {
    if (!window.confirm('¿Cerrar la sesión en todos tus dispositivos?')) return;
    try {
      await logoutEverywhere();
      clearAuthenticatedState();
      setToast('Sesión cerrada en todos los dispositivos');
    } catch (error: unknown) {
      setAuthError(error instanceof AuthApiError ? error.message : 'No se pudo cerrar la sesión en todos los dispositivos.');
    }
  };

  const refreshCloud = async (): Promise<void> => {
    try {
      const user = authUserRef.current ?? await currentUser();
      if (user) await hydrateAccount(user, dataRef.current);
      else setAuthStatus('signed_out');
    } catch (error) {
      setAuthStatus('error');
      reportAuthError(error, 'No se pudo sincronizar. Los cambios siguen en este dispositivo.');
    }
  };

  useEffect(() => {
    const refreshOnReturn = (): void => {
      if (document.visibilityState !== 'visible' || !online || !authUserRef.current || cloudBusyRef.current || cloudConflict) return;
      const now = Date.now();
      if (now - cloudRefreshRef.current < 5000) return;
      cloudRefreshRef.current = now;
      void refreshCloud();
    };
    document.addEventListener('visibilitychange', refreshOnReturn);
    window.addEventListener('focus', refreshOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', refreshOnReturn);
      window.removeEventListener('focus', refreshOnReturn);
    };
  }, [online, cloudConflict]);

  const restoreLocalRecovery = (): void => {
    if (!recovery || !window.confirm('¿Restaurar esta copia? Se guardará la versión actual para poder volver atrás.')) return;
    try {
      const next = parseBackup(recovery.backup);
      setRecovery(preserveRecovery(data));
      setData(next);
      setToast('Copia recuperada en este dispositivo');
    } catch { setAuthError('No se pudo restaurar la copia. Comprueba el espacio disponible.'); }
  };
  const pendingChanges = JSON.stringify(data) !== acknowledged;
  const updateCopy = updateActionCopy(Boolean(activeSession));

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Ir al contenido</a>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">R</span><span>radian</span></div>
        <div className="connection-state" role="status"><span className="status-dot" /> {!online ? 'sin conexión' : cloudConflict ? 'conflicto' : authStatus === 'syncing' ? 'sincronizando' : authUser ? pendingChanges ? 'cambios pendientes' : 'sincronizado' : 'guardado local'}</div>
      </header>
      <main className="app-main" id="main-content">
        {!online && <section className="profile-section" role="status">Sin conexión. Puedes seguir registrando el entrenamiento; los cambios quedan en este dispositivo.</section>}
        {updateAvailable && <section className="profile-section" role="status"><strong>Hay una actualización disponible</strong><p>{activeSession ? 'Puedes actualizar al terminar el entrenamiento.' : 'Tus datos guardados se conservarán al actualizar.'}</p>{updateCopy.available ? <button className="secondary-button small" disabled={Boolean(storageWarning) || authStatus === 'syncing'} onClick={() => { if (persistData(dataRef.current)) applyAppUpdate(); else setStorageWarning('No se pudo guardar antes de actualizar.'); }}>{updateCopy.label}</button> : <span className="update-locked"><Timer size={15} aria-hidden="true" />{updateCopy.label}</span>}</section>}
        {view === 'profile' && <section className="profile-section data-status-section"><div className="section-heading compact"><div><p className="eyebrow">datos</p><h2>Estado de tus datos</h2></div><span className="data-state-pill">{dataStateCopy({ authenticated: Boolean(authUser), pendingChanges, cloudConflict: Boolean(cloudConflict), codeConnected: Boolean(syncState.key) })}</span></div><p>{authUser ? pendingChanges ? 'Hay cambios locales pendientes de sincronizar.' : 'Tu copia local coincide con la última sincronización.' : 'Los datos están guardados en este dispositivo.'}</p><p>{cloudUpdatedAt ? `Última versión sincronizada: ${new Date(cloudUpdatedAt).toLocaleString('es-ES')}` : 'Todavía no se ha confirmado una sincronización en esta sesión.'}</p><button className="secondary-button small" disabled={!online || authStatus === 'syncing'} onClick={() => void refreshCloud()}>Comprobar sincronización</button>{recovery && <div><p>Copia anterior conservada: {new Date(recovery.savedAt).toLocaleString('es-ES')}</p><button className="secondary-button small" disabled={authStatus === 'syncing'} onClick={restoreLocalRecovery}>Restaurar copia anterior</button><button className="text-button" onClick={() => downloadFile('radian-recovery.json', recovery.backup, 'application/json')}>Exportar copia anterior</button></div>}</section>}
        {view === 'profile' && <AccountPanel user={authUser} passkeys={passkeys} status={authStatus} error={authError} cloudUpdatedAt={cloudUpdatedAt} onRegister={handleRegisterPasskey} onLogin={handleLoginPasskey} onAddPasskey={handleAddPasskey} onRenamePasskey={handleRenamePasskey} onRevokePasskey={handleRevokePasskey} onLogout={handleLogout} onLogoutEverywhere={handleLogoutEverywhere} />}
        {cloudConflict?.data && <SyncConflictCard local={data} remote={cloudConflict} remoteLabel="Copia de la nube" intro="La nube cambió desde la última sincronización. Elige qué copia conservar." onKeepLocal={() => void resolveCloudConflict('local')} onUseRemote={() => void resolveCloudConflict('remote')} />}
        {activeSession && view !== 'today' && <ResumeSessionBanner session={activeSession} onResume={() => setView('today')} />}
        {view === 'today' && <TodayView data={data} todayDay={todayDay} activeSession={activeSession} restRemaining={restRemaining} screenWakeLockActive={screenWakeLockActive} onStart={startSession} onComplete={completeExercise} onDraft={updateExerciseDraft} onSwapExercise={swapSessionExercise} onRest={() => startRest(activeSession?.plannedExercises[activeSession.activeExerciseIndex]?.restSeconds ?? 90)} onNavigate={setView} onUndo={undoLastSessionChange} canUndo={Boolean(lastSessionChange)} onExit={leaveSession} onHelp={() => setToast('Marca las series y cómo te ha ido; el resto queda guardado automáticamente.')} />}
        {view === 'routine' && <RoutineView data={data} days={scheduledDays} activeDay={activeDay} onDayChange={setActiveDayId} onUpdateDay={updateRoutineDay} onAddExercise={addRoutineExercise} onRemoveExercise={removeRoutineExercise} />}
        {view === 'progress' && <ProgressView data={data} onAddProgress={addProgress} onAddCheckin={addCheckin} onInfo={() => setToast('Las métricas se calculan solo con sesiones y medidas guardadas en Radian.')} />}
        {view === 'profile' && <ProfileView data={data} theme={theme} onThemeChange={changeTheme} onUpdateProfile={updateProfile} onRepeatOnboarding={repeatOnboarding} onImport={(next) => { setData(next); setToast('Copia restaurada'); }} syncState={syncState} syncStatus={syncStatus} syncError={syncError} syncConflict={syncConflict} onKeepLocalSync={keepLocalSync} onUseRemoteSync={useRemoteSync} onConnectSync={connectSync} onUploadSync={uploadSync} onDownloadSync={downloadSync} onDisconnectSync={disconnectSync} onRevokeSync={revokeSync} onInstall={installPrompt ? installApp : undefined} isInstalled={isInstalled} />}
      </main>
      <BottomNav view={view} onChange={setView} />
      {exitDialogOpen && <SessionExitDialog onCancel={() => setExitDialogOpen(false)} onConfirm={confirmLeaveSession} />}
      {(restRemaining > 0 || toast || storageWarning) && <div className="floating-feedback" aria-live="polite">
        {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
        {storageWarning && <div className="storage-warning" role="alert"><CloudOff size={16} />{storageWarning}</div>}
        {restRemaining > 0 && <div className="rest-float"><Timer size={17} /><div><strong>{formatDuration(restRemaining)}</strong><span>{restPaused ? 'descanso pausado' : 'descanso en curso'}</span></div><div className="rest-controls"><button type="button" aria-label="Restar 15 segundos" onClick={() => adjustRest(-15)}><Minus size={14} /></button><button type="button" aria-label={restPaused ? 'Reanudar descanso' : 'Pausar descanso'} onClick={restPaused ? resumeRest : pauseRest}>{restPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} />}</button><button type="button" aria-label="Añadir 30 segundos" onClick={() => adjustRest(30)}><Plus size={14} /></button><button type="button" aria-label="Cerrar temporizador" onClick={() => { setRestUntil(null); setRestRemaining(0); setRestPaused(false); }}><X size={17} /></button></div></div>}
      </div>}
      {!data.onboardingComplete && <OnboardingDialog profile={data.profile} onComplete={completeOnboarding} />}
    </div>
  );
}

function BottomNav({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return <nav className="bottom-nav" aria-label="Navegación principal">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'nav-item is-active' : 'nav-item'} aria-current={view === id ? 'page' : undefined} onClick={() => onChange(id)}><Icon size={20} strokeWidth={view === id ? 2.6 : 1.8} /><span>{label}</span></button>)}</nav>;
}

function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <div className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{action}</div>;
}

function ResumeSessionBanner({ session, onResume }: { session: WorkoutSession; onResume: () => void }) {
  const exercise = session.plannedExercises[session.activeExerciseIndex];
  const completed = session.plannedExercises.filter((item) => item.completed).length;
  return <section className="resume-banner" aria-label="Sesión pendiente"><div><p className="eyebrow">sesión pendiente</p><strong>Continúa {exercise?.name ?? 'tu sesión'}</strong><span>{completed} de {session.plannedExercises.length} ejercicios · guardado en este dispositivo</span></div><button className="primary-button small" type="button" onClick={onResume}><Play size={15} fill="currentColor" /> Continuar</button></section>;
}

function SessionExitDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onCancel(); };
    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.session-exit-dialog');
      const focusable = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute('disabled')) : [];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('keydown', trapFocus);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.session-exit-dialog button')?.focus(), 0);
    return () => { document.removeEventListener('keydown', closeOnEscape); document.removeEventListener('keydown', trapFocus); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onCancel]);
  return <div className="session-exit-backdrop" role="presentation" onMouseDown={onCancel}><section className="session-exit-dialog" role="dialog" aria-modal="true" aria-labelledby="session-exit-title" onMouseDown={(event) => event.stopPropagation()}><div className="session-exit-heading"><p className="eyebrow">salir de la sesión</p><button className="icon-button subtle" type="button" aria-label="Cerrar aviso" onClick={onCancel}><X size={18} /></button></div><h2 id="session-exit-title">¿Pausar aquí?</h2><p>Tu progreso se ha guardado en este dispositivo. Podrás continuar desde Hoy cuando quieras.</p><div className="session-exit-actions"><button className="secondary-button" type="button" onClick={onCancel}>Seguir entrenando</button><button className="danger-button" type="button" onClick={onConfirm}>Salir de la sesión</button></div></section></div>;
}

function TodayView({ data, todayDay, activeSession, restRemaining, screenWakeLockActive, onStart, onComplete, onDraft, onSwapExercise, onRest, onNavigate, onUndo, canUndo, onExit, onHelp }: { data: AppData; todayDay?: WorkoutDay; activeSession?: WorkoutSession; restRemaining: number; screenWakeLockActive: boolean; onStart: (day: WorkoutDay, readiness?: SessionReadiness) => void; onComplete: (session: WorkoutSession, exercise: ExerciseSession, patch: Partial<ExerciseSession>, startRest: boolean) => void; onDraft: (sessionId: string, plannedExerciseId: string, patch: Partial<ExerciseSession>) => void; onSwapExercise: (sessionId: string, plannedExerciseId: string, replacement: ExerciseDefinition) => void; onRest: () => void; onNavigate: (view: View) => void; onUndo: () => void; canUndo: boolean; onExit: () => void; onHelp: () => void }) {
  const [detailExercise, setDetailExercise] = useState<PlannedExercise>();
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [readiness, setReadiness] = useState<SessionReadiness>({ energy: 'normal', soreness: 'none' });
  const day = activeSession ? data.plan.days.find((item) => item.id === activeSession.workoutDayId) : todayDay;
  const completedCount = activeSession?.plannedExercises.filter((item) => item.completed).length ?? 0;
  const scheduledDays = scheduledWorkoutDays(data.plan.days, data.profile.trainingDays);
  const workoutDay = day ?? scheduledDays.find((item) => item.weekday > currentWeekday()) ?? scheduledDays[0];
  const doneToday = data.sessions.some((session) => session.dateKey === dateKey() && session.status === 'completed');
  const latestCompletedToday = data.sessions.filter((session) => session.dateKey === dateKey() && session.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
  const completedSummary = latestCompletedToday ? summarizeSession(latestCompletedToday, data.sessions) : undefined;
  const primaryAction = todayPrimaryAction(doneToday);

  const previousExercise = activeSession ? latestExercise(data.sessions, activeSession.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId) : undefined;
  const currentRecommendation = activeSession ? recommendationFor(activeSession.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId ?? '', data.sessions) : undefined;
  const currentExercise = activeSession?.plannedExercises[activeSession.activeExerciseIndex];
  const currentProgressionCue = activeSession && currentExercise ? progressionCue(currentExercise.exerciseId, data.sessions, currentExercise) : undefined;
  const currentProgressionAction = activeSession && currentExercise ? progressionAction(currentExercise.exerciseId, data.sessions, currentExercise) : undefined;
  const currentAlternatives = activeSession ? alternativeExercises(data, activeSession.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId ?? '') : [];

  return <><section className={activeSession ? 'view-section today-view session-active-view' : 'view-section today-view'}>
    <PageHeader eyebrow={formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })} title={activeSession ? 'Sigue a tu ritmo.' : 'Lo que toca hoy.'} action={<button className="icon-button subtle" type="button" aria-label="Ayuda" onClick={onHelp}><CircleHelp size={19} /></button>} />
    <section className={activeSession ? 'today-hero session-active-hero' : 'today-hero'}>
      <div className="hero-orbit"><span>{data.profile.gym || 'TU GIMNASIO'}</span><Dumbbell size={29} /></div>
      <div className="hero-copy"><p className="eyebrow light">{activeSession ? 'sesión en curso' : doneToday ? 'hecho por hoy' : workoutDay.weekday === currentWeekday() ? 'entrenamiento de hoy' : 'siguiente sesión'}</p><h2>{displayWorkoutName(workoutDay.name)}</h2><p>{workoutDay.focus} · {workoutDay.exercises.filter((exercise) => exercise.active).length} ejercicios / ~{data.profile.sessionMinutes} min</p></div>
      <div className="hero-progress"><strong>{activeSession ? `${completedCount}/${activeSession.plannedExercises.length}` : doneToday ? '✓' : String(workoutDay.exercises.filter((exercise) => exercise.active).length)}</strong><span>{activeSession ? 'ejercicios' : doneToday ? 'sesión guardada' : 'bloques'}</span></div>
    </section>
    {activeSession ? <><SessionAdaptationNotice readiness={activeSession.readiness} /><ActiveSession session={activeSession} restRemaining={restRemaining} screenWakeLockActive={screenWakeLockActive} previousExercise={previousExercise} bestRecord={bestRecordForExercise(data.sessions, activeSession.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId ?? '')} recommendation={currentRecommendation} progression={currentProgressionCue} progressionAction={currentProgressionAction} alternatives={currentAlternatives} onComplete={onComplete} onDraft={onDraft} onSwap={(replacement) => onSwapExercise(activeSession.id, activeSession.plannedExercises[activeSession.activeExerciseIndex].plannedExerciseId, replacement)} onRest={onRest} onUndo={onUndo} canUndo={canUndo} onExit={onExit} /> </> : <>
      {completedSummary && <CompletedSessionSummary summary={completedSummary} onViewProgress={() => onNavigate('progress')} />}
      <div className="section-heading"><div><p className="eyebrow">el plan</p><h2>{workoutDay.weekday === currentWeekday() ? 'Tu sesión' : 'Próximo entrenamiento'}</h2></div><button className="text-button" onClick={() => onNavigate('routine')}>Editar rutina <ChevronRight size={16} /></button></div>
      <div className="today-start-block"><button className="primary-button start-button" type="button" onClick={() => setReadinessOpen(true)}><Play size={18} fill="currentColor" /> {primaryAction.label}</button><p>{primaryAction.hint}</p></div>
      {readinessOpen && <ReadinessPrompt value={readiness} onChange={setReadiness} onSkip={() => { setReadinessOpen(false); onStart(workoutDay); }} onStart={() => { setReadinessOpen(false); onStart(workoutDay, readiness); }} />}
      <div className="exercise-list">{workoutDay.exercises.filter((exercise) => exercise.active).map((exercise, index) => <ExercisePreview key={exercise.id} exercise={exercise} index={index} muscleGroup={data.exercises.find((item) => item.id === exercise.exerciseId)?.muscleGroup} progressionAction={progressionAction(exercise.exerciseId, data.sessions, exercise)} lastSession={latestExercise(data.sessions, exercise.exerciseId)} onOpenDetails={() => setDetailExercise(exercise)} />)}</div>
    </>}
  </section>{detailExercise && <ExerciseDetailSheet exercise={detailExercise} muscleGroup={data.exercises.find((item) => item.id === detailExercise.exerciseId)?.muscleGroup} guidance={exerciseGuidance[detailExercise.exerciseId]} recommendation={recommendationFor(detailExercise.exerciseId, data.sessions)} progressionAction={progressionAction(detailExercise.exerciseId, data.sessions, detailExercise)} lastSession={latestExercise(data.sessions, detailExercise.exerciseId)} onClose={() => setDetailExercise(undefined)} />}</>;
}

function ReadinessPrompt({ value, onChange, onSkip, onStart }: { value: SessionReadiness; onChange: (value: SessionReadiness) => void; onSkip: () => void; onStart: () => void }) {
  const energyOptions: Array<{ value: Energy; label: string }> = [
    { value: 'low', label: 'Baja' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'Alta' },
  ];
  const sorenessOptions: Array<{ value: Soreness; label: string }> = [
    { value: 'none', label: 'Ninguna' }, { value: 'some', label: 'Algo' }, { value: 'high', label: 'Mucha' },
  ];
  const choices = (options: Array<{ value: Energy | Soreness; label: string }>, selected: Energy | Soreness, update: (value: Energy | Soreness) => void) => options.map((option) => <button key={option.value} className={selected === option.value ? 'readiness-choice selected' : 'readiness-choice'} type="button" aria-pressed={selected === option.value} onClick={() => update(option.value)}>{option.label}</button>);
  return <section className="readiness-panel" aria-labelledby="readiness-title"><div><p className="eyebrow">check-in rápido · opcional</p><h3 id="readiness-title">¿Cómo llegas hoy?</h3><p>Radian usará estas sensaciones para ajustar el volumen y el descanso de esta sesión.</p></div><div className="readiness-group"><span>Energía</span><div className="readiness-choices">{choices(energyOptions, value.energy, (next) => onChange({ ...value, energy: next as Energy }))}</div></div><div className="readiness-group"><span>Molestias musculares</span><div className="readiness-choices">{choices(sorenessOptions, value.soreness, (next) => onChange({ ...value, soreness: next as Soreness }))}</div></div><div className="readiness-actions"><button className="secondary-button small" type="button" onClick={onSkip}>Empezar sin responder</button><button className="primary-button small" type="button" onClick={onStart}>Guardar y empezar</button></div></section>;
}

function SessionAdaptationNotice({ readiness }: { readiness?: SessionReadiness }) {
  const adaptation = sessionAdaptation(readiness);
  if (adaptation.mode === 'normal') return null;
  return <section className={`session-adaptation-notice ${adaptation.mode}`} role="status"><Gauge size={17} /><div><strong>{adaptation.label}</strong><span>{adaptation.detail}</span></div></section>;
}

export function ExercisePreview({ exercise, index, muscleGroup, progressionAction: action, lastSession, onOpenDetails }: { exercise: PlannedExercise; index: number; muscleGroup?: string; progressionAction?: ReturnType<typeof progressionAction>; lastSession?: ExerciseSession; onOpenDetails: () => void }) {
  return <article className="exercise-card preview-card">
    <div className="exercise-index">{String(index + 1).padStart(2, '0')}</div>
    <button className="exercise-image-button" type="button" onClick={onOpenDetails} aria-label={`Ver cómo usar ${exercise.name}`}><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} /></button>
    <div className="exercise-main">
      <div className="exercise-preview-heading">
        <button className="exercise-name-button" type="button" onClick={onOpenDetails}><h3>{exercise.name}</h3></button>
        {lastSession && <div className="last-feedback"><span>última vez</span><strong>{formatExerciseSummary(lastSession)}</strong></div>}
      </div>
      <div className="exercise-meta" aria-label="Detalles del ejercicio"><span>{muscleGroup ?? 'Ejercicio'}</span><span>{exercise.sets} series</span><span>{exercise.repMin}-{exercise.repMax} reps</span><span><Timer size={14} aria-hidden="true" /> {formatDuration(exercise.restSeconds)}</span></div>
      {action && <div className={`next-action ${action.tone}`}><Gauge size={16} aria-hidden="true" /><div><span className="next-action-label">Siguiente paso</span><strong>{action.title}</strong><span>{action.detail}</span></div></div>}
    </div>
  </article>;
}

function CompletedSessionSummary({ summary, onViewProgress }: { summary: SessionSummary; onViewProgress: () => void }) {
  const allExercisesCompleted = summary.completedExercises === summary.totalExercises;
  return <section className="completed-summary" aria-labelledby="completed-summary-title"><div className="completed-summary-heading"><div><p className="eyebrow">sesión guardada</p><h2 id="completed-summary-title">Buen trabajo.</h2></div><span className="completed-summary-mark"><Check size={18} /></span></div><div className="session-summary-grid"><div><Timer size={16} /><strong>{formatSessionDuration(summary.durationSeconds)}</strong><span>duración</span></div><div><Dumbbell size={16} /><strong>{summary.completedExercises}/{summary.totalExercises}</strong><span>ejercicios</span></div><div><Check size={16} /><strong>{summary.completedWorkSets}</strong><span>series de trabajo</span></div><div><Layers3 size={16} /><strong>{summary.volumeKg > 0 ? formatVolume(summary.volumeKg) : 'Sin carga'}</strong><span>volumen estimado</span></div></div>{summary.records.length > 0 && <div className="summary-records"><p className="eyebrow">marcas de hoy</p>{summary.records.map((record) => <div className="summary-record" key={record.exerciseId}><Trophy size={15} /><span><strong>{record.name}</strong>{record.event.kind === 'first' ? `Primera marca · ${formatWeight(record.event.weightKg)}` : record.event.kind === 'weight' ? `Nuevo peso · ${formatWeight(record.event.weightKg)}` : `Nuevo volumen · ${formatWeight(record.event.weightKg)}`}</span></div>)}</div>}<div className="completed-summary-footer"><span>{allExercisesCompleted ? 'Sesión completa. Ya tienes una referencia para la próxima.' : `Sesión cerrada con ${summary.totalExercises - summary.completedExercises} ejercicio${summary.totalExercises - summary.completedExercises === 1 ? '' : 's'} pendiente${summary.totalExercises - summary.completedExercises === 1 ? '' : 's'}.`}</span><button className="text-button" type="button" onClick={onViewProgress}>Ver progreso <ChevronRight size={15} /></button></div></section>;
}

function ActiveSession({ session, restRemaining, screenWakeLockActive, previousExercise, bestRecord, recommendation, progression, progressionAction: action, alternatives, onComplete, onDraft, onSwap, onRest, onUndo, canUndo, onExit }: { session: WorkoutSession; restRemaining: number; screenWakeLockActive: boolean; previousExercise?: ExerciseSession; bestRecord?: ExerciseRecord; recommendation?: ReturnType<typeof recommendationFor>; progression?: string; progressionAction?: ReturnType<typeof progressionAction>; alternatives: ExerciseDefinition[]; onComplete: (session: WorkoutSession, exercise: ExerciseSession, patch: Partial<ExerciseSession>, startRest: boolean) => void; onDraft: (sessionId: string, plannedExerciseId: string, patch: Partial<ExerciseSession>) => void; onSwap: (replacement: ExerciseDefinition) => void; onRest: () => void; onUndo: () => void; canUndo: boolean; onExit: () => void }) {
  const exercise = session.plannedExercises[session.activeExerciseIndex];
  const [setLogs, setSetLogs] = useState<SetLog[]>([]);
  const [discomfort, setDiscomfort] = useState(false);
  const [note, setNote] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingDifficulty, setPendingDifficulty] = useState<Difficulty>();
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);

  useEffect(() => {
    if (!exercise) return;
    const hasRecordedInputs = exercise.setLogs.some((set) => set.completed || set.weightKg !== undefined || set.actualReps !== undefined);
    const source = hasRecordedInputs ? exercise.setLogs : previousExercise?.setLogs;
    const legacy = hasRecordedInputs ? exercise : previousExercise;
    setSetLogs(createSetLogs(exercise.sets, exercise.repMin, source, legacy, { warmupSets: exercise.warmupSets, defaultActualReps: previousExercise?.setLogs.map((set) => set.actualReps), copyCompleted: !previousExercise || hasRecordedInputs }));
    setDiscomfort(exercise?.discomfort ?? false);
    setNote(exercise?.discomfortNote ?? '');
    setPendingDifficulty(exercise?.difficulty);
    setDetailsOpen(Boolean(exercise?.discomfort || exercise?.discomfortNote));
  }, [exercise?.plannedExerciseId, exercise?.exerciseId, exercise?.sets, exercise?.repMin, previousExercise?.plannedExerciseId]);

  if (!exercise) return null;
  const completed = session.plannedExercises.filter((item) => item.completed).length;
  const progress = Math.round((completed / session.plannedExercises.length) * 100);
  const updateSet = (setNumber: number, patch: Partial<SetLog>): void => {
    const nextLogs = setLogs.map((set) => set.setNumber === setNumber ? { ...set, ...patch } : set);
    setSetLogs(nextLogs);
    onDraft(session.id, exercise.plannedExerciseId, { setLogs: nextLogs });
    if (patch.completed === true) onRest();
  };
  const copyPrevious = (): void => {
    if (!previousExercise) return;
    const nextLogs = createSetLogs(exercise.sets, exercise.repMin, previousExercise.setLogs, previousExercise, { warmupSets: exercise.warmupSets, copyCompleted: false });
    setSetLogs(nextLogs);
    onDraft(session.id, exercise.plannedExerciseId, { setLogs: nextLogs });
  };
  const saveExercise = (difficulty: Difficulty): void => {
    setPendingDifficulty(difficulty);
    const completedSets = setLogs.filter((set) => isWorkSet(set) && set.completed);
    const lastSet = completedSets[completedSets.length - 1];
    onComplete(session, exercise, {
      completed: difficulty !== 'incomplete',
      difficulty,
      setLogs,
      actualWeightKg: lastSet?.weightKg,
      actualReps: lastSet?.actualReps,
      discomfort,
      discomfortNote: note || undefined,
    }, true);
  };
  const skipExercise = (): void => onComplete(session, exercise, { completed: false, difficulty: 'incomplete', setLogs, discomfort, discomfortNote: note || undefined }, false);

  return <div className="session-wrap"><div className="session-topline"><div><p className="eyebrow">sesión en curso</p><strong>{completed} de {session.plannedExercises.length} ejercicios</strong></div><div className="session-progress"><span style={{ width: `${progress}%` }} /></div><div className="session-menu-wrap"><button className="icon-button subtle" aria-label="Opciones de la sesión" aria-expanded={sessionMenuOpen} onClick={() => setSessionMenuOpen((value) => !value)}><MoreHorizontal size={19} /></button>{sessionMenuOpen && <div className="session-menu"><button type="button" onClick={() => { onUndo(); setSessionMenuOpen(false); }} disabled={!canUndo}><RotateCcw size={15} /> Deshacer último</button><button type="button" onClick={() => { skipExercise(); setSessionMenuOpen(false); }}><SkipForward size={15} /> Saltar ejercicio</button><button type="button" className="danger-action" onClick={() => { setSessionMenuOpen(false); onExit(); }}><X size={15} /> Salir de la sesión</button></div>}</div></div>
    {restRemaining > 0 && <div className="rest-inline"><Timer size={16} /><span>Descansa {formatDuration(restRemaining)} antes del siguiente ejercicio.</span><button onClick={onRest}>Reiniciar</button></div>}
    <article className="active-exercise-card"><div className="active-card-header"><span className="exercise-kicker">ejercicio {session.activeExerciseIndex + 1} / {session.plannedExercises.length}</span><span className="active-status"><span className="status-dot" /> {screenWakeLockActive ? 'pantalla activa' : 'guardado en este dispositivo'}</span></div><div className="active-exercise-overview"><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} large /><div className="active-exercise-summary"><h2>{exercise.name}</h2><div className="target-row"><div><strong>{exercise.sets}</strong><span>series de trabajo</span></div>{exercise.warmupSets > 0 && <div><strong>{exercise.warmupSets}</strong><span>calentamiento</span></div>}<div><strong>{exercise.repMin}-{exercise.repMax}</strong><span>repeticiones</span></div><div><strong>{formatDuration(exercise.restSeconds)}</strong><span>descanso</span></div></div></div></div><details className="active-insights"><summary><Gauge size={15} /> Ver consejo, historial y marcas</summary><div className="active-insights-body">{previousExercise && <p className="last-session-summary"><History size={14} /> Última vez: {previousExercise.sets} series · {formatExerciseSummary(previousExercise)}</p>}{bestRecord && <p className="personal-record-note"><Trophy size={14} /> Mejor marca: {formatWeight(bestRecord.maxWeightKg)}{bestRecord.maxWeightReps ? ` · ${bestRecord.maxWeightReps} reps` : ''}</p>}{action && <div className={`progression-note ${action.tone}`}><Gauge size={16} /><div><strong>{action.title}</strong><span>{action.detail}</span></div></div>}{progression && !action && <div className={`progression-note ${recommendation?.tone ?? 'neutral'}`}><Gauge size={16} /><span>{progression}</span></div>}</div></details><SetLogEditor logs={setLogs} repMin={exercise.repMin} repMax={exercise.repMax} hasPrevious={Boolean(previousExercise)} prefilled={Boolean(previousExercise && setLogs.some((set) => set.actualReps !== undefined || set.weightKg !== undefined))} onChange={updateSet} onCopy={copyPrevious} /><div className="difficulty-prompt"><p>¿Cómo ha ido?<span>{completionActionHint}</span></p><div className="difficulty-grid">{difficultyOptions.map((option) => <button type="button" key={option.value} aria-label={`${option.label}: ${completionActionHint.toLowerCase()}`} className={pendingDifficulty === option.value ? `difficulty-button ${option.value} selected` : `difficulty-button ${option.value}`} onClick={() => saveExercise(option.value)}><span>{option.label}</span><small>{option.hint}</small></button>)}</div></div><button type="button" className="details-toggle" onClick={() => setDetailsOpen((value) => !value)}><Plus size={17} /> {detailsOpen ? 'Ocultar molestias y nota' : 'Añadir molestias o nota'}</button>{detailsOpen && <div className="optional-fields"><label className="toggle-field"><span>¿Alguna molestia?</span><button type="button" className={discomfort ? 'toggle on' : 'toggle'} aria-pressed={discomfort} onClick={() => setDiscomfort((value) => !value)}><span /></button></label><label className="full-field">Nota breve <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="¿Qué has notado?" rows={2} /></label>{discomfort && <div className="discomfort-panel"><strong>Prueba otra variante</strong><span>La rutina original no cambia. Elige una opción del mismo grupo para continuar con menos dudas.</span>{alternatives.length > 0 ? <div className="alternative-actions">{alternatives.map((replacement) => <button type="button" className="secondary-button small" key={replacement.id} onClick={() => onSwap(replacement)}>{replacement.name}</button>)}</div> : <p>No hay otra variante guardada para este grupo. Puedes bajar la carga o parar y anotar lo ocurrido.</p>}</div>}</div>}</article><div className="session-next"><span>Después</span><strong>{session.plannedExercises[session.activeExerciseIndex + 1]?.name ?? 'Fin de la sesión'}</strong><ArrowDown size={17} /></div><p className="session-note"><Info size={14} /> Solo necesitas marcar cómo ha ido. El registro por series es opcional.</p></div>;
}

function SetLogEditor({ logs, repMin, repMax, hasPrevious, prefilled, onChange, onCopy }: { logs: SetLog[]; repMin: number; repMax: number; hasPrevious: boolean; prefilled: boolean; onChange: (setNumber: number, patch: Partial<SetLog>) => void; onCopy: () => void }) {
  const nextSet = logs.find((set) => !set.completed);
  const completeNext = (): void => {
    if (!nextSet) return;
    onChange(nextSet.setNumber, { completed: true, actualReps: nextSet.actualReps ?? (nextSet.phase === 'warmup' ? repMin : repMax) });
  };
  return <section className="set-log-card"><div className="set-log-heading"><div><p className="eyebrow">registro de hoy</p><strong>Calentamiento y series de trabajo</strong>{prefilled && <span className="prefill-note"><History size={13} /> Último registro cargado</span>}</div><div className="set-log-heading-actions">{nextSet && <button className="set-quick-action" type="button" onClick={completeNext}><Check size={14} /> Completar siguiente</button>}{hasPrevious && <button className="text-button" type="button" onClick={onCopy}>Repetir último</button>}</div></div><div className="set-log-list">{logs.map((set) => { const warmup = set.phase === 'warmup'; return <div className={`${set.completed ? 'set-log-row is-complete' : 'set-log-row'}${warmup ? ' is-warmup' : ''}`} key={set.setNumber}><span className="set-log-number">{String(set.setNumber).padStart(2, '0')}</span><span className="set-log-target">{warmup ? 'Calentamiento' : 'Objetivo'}<strong>{warmup ? `${repMin} reps` : `${repMin}-${repMax}`}</strong></span><label>Peso<input inputMode="decimal" value={set.weightKg ?? ''} onChange={(event) => onChange(set.setNumber, { weightKg: numberOrUndefined(event.target.value) })} placeholder="kg" /></label><label>Reps<input inputMode="numeric" value={set.actualReps ?? ''} onChange={(event) => onChange(set.setNumber, { actualReps: numberOrUndefined(event.target.value) })} placeholder="reps" /></label><button type="button" className={set.completed ? 'set-complete selected' : 'set-complete'} aria-label={set.completed ? `Desmarcar serie ${set.setNumber}` : `Marcar serie ${set.setNumber}`} aria-pressed={set.completed} onClick={() => onChange(set.setNumber, { completed: !set.completed })}><Check size={16} /></button></div>; })}</div></section>;
}

function ExerciseDetailSheet({ exercise, muscleGroup, guidance, recommendation, progressionAction: action, lastSession, onClose }: { exercise: PlannedExercise; muscleGroup?: string; guidance?: ExerciseGuidance; recommendation?: ReturnType<typeof recommendationFor>; progressionAction?: ReturnType<typeof progressionAction>; lastSession?: ExerciseSession; onClose: () => void }) {
  const detail = guidance ?? { setup: 'Ajusta el asiento y la carga para que puedas moverte con control.', cues: ['Mantén una postura estable.', 'Mueve la carga sin impulso.', 'Detén el recorrido si pierdes el control.'], commonMistake: 'Usar más carga de la que permite una ejecución limpia.' };
  const alternatives = detail.alternatives ?? ['Reduce la carga y acorta el recorrido.', 'Prueba una variante que no provoque molestias.', 'Si persiste, anótalo para revisarlo con tu entrenador.'];
  const discomfortAdvice = detail.discomfortAdvice ?? 'Una molestia articular no es una señal para forzar. Para, registra lo que has notado y revisa el ajuste.';
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.exercise-detail-sheet');
      const focusable = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute('disabled')) : [];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('keydown', trapFocus);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.exercise-detail-sheet button[aria-label="Cerrar ficha"]')?.focus(), 0);
    return () => { document.removeEventListener('keydown', closeOnEscape); document.removeEventListener('keydown', trapFocus); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onClose]);
  return <div className="exercise-detail-backdrop" role="presentation" onMouseDown={onClose}><section className="exercise-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="exercise-detail-title" onMouseDown={(event) => event.stopPropagation()}><div className="detail-sheet-topline"><p className="eyebrow">referencia de máquina</p><button className="icon-button subtle" type="button" aria-label="Cerrar ficha" onClick={onClose}><X size={19} /></button></div><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} large /><h2 id="exercise-detail-title">{exercise.name}</h2><div className="detail-facts"><span>{muscleGroup ?? 'Ejercicio'}</span><span>{exercise.sets} series</span><span>{exercise.repMin}-{exercise.repMax} reps</span></div><div className="detail-section"><p className="eyebrow">ajuste inicial</p><p>{detail.setup}</p></div><div className="detail-section"><p className="eyebrow">claves de ejecución</p><ol className="detail-steps">{detail.cues.map((cue) => <li key={cue}>{cue}</li>)}</ol></div><div className="detail-warning"><strong>Error habitual</strong><span>{detail.commonMistake}</span></div><div className="detail-section"><p className="eyebrow">si hay molestias</p><p>{discomfortAdvice}</p><ul className="detail-alternatives">{alternatives.map((alternative) => <li key={alternative}>{alternative}</li>)}</ul></div>{lastSession && <p className="detail-history">Último registro: {formatExerciseSummary(lastSession)}</p>}{action && <div className={`detail-action ${action.tone}`}><strong>{action.title}</strong><span>{action.detail}</span></div>}{recommendation && <p className={`detail-recommendation ${recommendation.tone}`}><Gauge size={15} /> {recommendation.label}: {recommendation.message}</p>}</section></div>;
}

function latestExercise(sessions: WorkoutSession[], exerciseId: string): ExerciseSession | undefined {
  return sessions.filter((session) => session.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).flatMap((session) => session.plannedExercises.filter((item) => item.exerciseId === exerciseId && item.difficulty))[0];
}

function alternativeExercises(data: AppData, exerciseId: string): ExerciseDefinition[] { return compatibleAlternatives(data.exercises, exerciseId, data.profile.availableEquipment).slice(0, 3); }

function ExerciseThumb({ src, position, alt, large = false }: { src?: string; position?: string; alt: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const usesAtlas = Boolean(src?.includes('/atlas-') && position);
  const atlasStyle = usesAtlas ? { backgroundImage: `url(${src})`, backgroundPosition: position } : undefined;
  return <div className={large ? 'exercise-thumb large' : 'exercise-thumb'}>{src && !failed ? usesAtlas ? <div className="exercise-thumb-image" style={atlasStyle} role="img" aria-label={alt} /> : <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <div className="exercise-thumb-fallback" aria-label={alt}><Dumbbell size={large ? 30 : 20} /></div>}</div>;
}

function RoutineView({ data, days, activeDay, onDayChange, onUpdateDay, onAddExercise, onRemoveExercise }: { data: AppData; days: WorkoutDay[]; activeDay: WorkoutDay; onDayChange: (id: string) => void; onUpdateDay: (dayId: string, updater: (day: WorkoutDay) => WorkoutDay) => void; onAddExercise: (dayId: string, exercise: ExerciseDefinition) => void; onRemoveExercise: (dayId: string, exerciseId: string) => void }) {
  const [editingName, setEditingName] = useState(false);
  const [expandedExerciseId, setExpandedExerciseId] = useState<string | undefined>(() => activeDay.exercises.find((exercise) => exercise.active)?.id);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTargetId, setLibraryTargetId] = useState<string>();
  useEffect(() => {
    setExpandedExerciseId(activeDay.exercises.find((exercise) => exercise.active)?.id);
  }, [activeDay.id]);
  const openLibrary = (targetId = activeDay.exercises.find((exercise) => exercise.active)?.id): void => {
    setLibraryTargetId(targetId);
    setLibraryOpen(true);
  };
  const replaceFromLibrary = (targetId: string, replacement: ExerciseDefinition): void => {
    onUpdateDay(activeDay.id, (day) => ({ ...day, exercises: day.exercises.map((item) => item.id === targetId ? { ...item, exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition } : item) }));
    setLibraryOpen(false);
  };
  const manualGaps = unresolvedPlanEquipmentGaps(data.plan, data.exercises, data.profile.availableEquipment).filter((gap) => gap.dayId === activeDay.id);
  return <section className="view-section"><PageHeader eyebrow="programación" title="Tu rutina" action={<button className="icon-button subtle" aria-label="Abrir biblioteca de ejercicios" onClick={() => openLibrary()}><Search size={19} /></button>} /><div className="day-tabs" role="tablist" aria-label="Días programados">{days.map((day) => <button key={day.id} id={`routine-tab-${day.id}`} role="tab" aria-selected={activeDay.id === day.id} aria-controls="routine-panel" tabIndex={activeDay.id === day.id ? 0 : -1} className={activeDay.id === day.id ? 'day-tab selected' : 'day-tab'} onClick={() => { onDayChange(day.id); setEditingName(false); }} onKeyDown={(event) => { const index = days.findIndex((item) => item.id === day.id); const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? days.length - 1 - index : 0; if (!delta) return; event.preventDefault(); const next = days[(index + delta + days.length) % days.length]; onDayChange(next.id); window.requestAnimationFrame(() => document.getElementById(`routine-tab-${next.id}`)?.focus()); }}><span>{day.shortLabel}</span><small>{displayWorkoutName(day.name).split(',')[0]}</small></button>)}</div><section className="routine-intro" id="routine-panel" role="tabpanel" aria-labelledby={`routine-tab-${activeDay.id}`}><div>{editingName ? <input className="title-input" value={activeDay.name} onChange={(event) => onUpdateDay(activeDay.id, (day) => ({ ...day, name: event.target.value }))} onBlur={() => setEditingName(false)} autoFocus /> : <h2>{displayWorkoutName(activeDay.name)}</h2>}<p>{activeDay.focus} · ~{data.profile.sessionMinutes} min</p></div><button className="icon-button subtle" aria-label="Editar nombre del entrenamiento" onClick={() => setEditingName(true)}><MoreHorizontal size={19} /></button></section>{manualGaps.length > 0 && <EquipmentReviewCard gaps={manualGaps} onReview={(gap) => { const planned = activeDay.exercises.find((exercise) => exercise.exerciseId === gap.exerciseId); if (planned) openLibrary(planned.id); }} />}{libraryOpen && <ExerciseLibrary exercises={data.exercises} availableEquipment={data.profile.availableEquipment} plannedExercises={activeDay.exercises} targetId={libraryTargetId} onTargetChange={setLibraryTargetId} onSelect={replaceFromLibrary} onAdd={(exercise) => { onAddExercise(activeDay.id, exercise); setLibraryOpen(false); }} onClose={() => setLibraryOpen(false)} />}<div className="routine-list">{activeDay.exercises.map((exercise, index) => <RoutineExercise key={exercise.id} exercise={exercise} index={index} exerciseOptions={data.exercises} alternatives={compatibleAlternatives(data.exercises, exercise.exerciseId, data.profile.availableEquipment)} guidance={exerciseGuidance[exercise.exerciseId]} lastSession={latestExercise(data.sessions, exercise.exerciseId)} progressionAction={progressionAction(exercise.exerciseId, data.sessions, exercise)} expanded={expandedExerciseId === exercise.id} onOpenLibrary={() => openLibrary(exercise.id)} onToggle={() => setExpandedExerciseId((current) => current === exercise.id ? undefined : exercise.id)} onChange={(patch) => onUpdateDay(activeDay.id, (day) => ({ ...day, exercises: day.exercises.map((item) => item.id === exercise.id ? { ...item, ...patch } : item) }))} onMove={(direction) => onUpdateDay(activeDay.id, (day) => ({ ...day, exercises: moveExercise(day.exercises, index, direction) }))} onRemove={() => onRemoveExercise(activeDay.id, exercise.id)} />)}</div><button type="button" className="secondary-button routine-add-button" onClick={() => openLibrary()}><Plus size={16} /> Añadir ejercicio</button><p className="history-note"><History size={15} /> Las sesiones guardadas conservan la rutina que tenían al empezar.</p></section>;
}

function EquipmentReviewCard({ gaps, onReview }: { gaps: PlanEquipmentGap[]; onReview: (gap: PlanEquipmentGap) => void }) {
  return <aside className="routine-equipment-review" aria-labelledby="routine-equipment-review-title"><div className="routine-equipment-review-heading"><div><p className="eyebrow">revisión pendiente</p><h3 id="routine-equipment-review-title">Hay ejercicios por ajustar</h3></div><span>{gaps.length}</span></div><p>Estos ejercicios necesitan material que ya no figura como disponible. Elige una variante para dejar la sesión lista.</p><ul>{gaps.map((gap) => <li key={`${gap.dayId}-${gap.exerciseId}`}><div><strong>{gap.exerciseName}</strong><span>Necesita {equipmentLabel(gap.equipment)}</span></div><button type="button" className="secondary-button small" aria-label={`Elegir sustitución para ${gap.exerciseName}`} onClick={() => onReview(gap)}><Search size={14} /> Elegir sustitución</button></li>)}</ul></aside>;
}

function ExerciseLibrary({ exercises, availableEquipment, plannedExercises, targetId, onTargetChange, onSelect, onAdd, onClose }: { exercises: ExerciseDefinition[]; availableEquipment: ExerciseEquipment[]; plannedExercises: PlannedExercise[]; targetId?: string; onTargetChange: (id: string) => void; onSelect: (targetId: string, replacement: ExerciseDefinition) => void; onAdd: (exercise: ExerciseDefinition) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [muscleGroup, setMuscleGroup] = useState('');
  const [equipment, setEquipment] = useState('');
  const target = targetId ?? plannedExercises[0]?.id;
  const muscles = Array.from(new Set(exercises.map((exercise) => exercise.muscleGroup))).sort((a, b) => a.localeCompare(b, 'es'));
  const equipmentOptions = Array.from(new Set(exercises.map((exercise) => exercise.equipment))).sort();
  const results = exercises.filter((exercise) => availableEquipment.includes(exercise.equipment) && exerciseMatches(exercise, query, muscleGroup, equipment)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return <section className="exercise-library" aria-label="Biblioteca de ejercicios"><div className="exercise-library-header"><div><p className="eyebrow">biblioteca personal</p><h2>Encuentra una variante</h2><p>Filtra por zona o material. Puedes sustituir un bloque o añadir uno nuevo.</p></div><button className="icon-button subtle" type="button" aria-label="Cerrar biblioteca" onClick={onClose}><X size={19} /></button></div>{plannedExercises.length > 0 && <label className="library-target">Cambiar ejercicio de<select value={target ?? ''} onChange={(event) => onTargetChange(event.target.value)}>{plannedExercises.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select></label>}<div className="library-filters"><label className="library-search"><Search size={16} /><span className="sr-only">Buscar ejercicio</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar press, polea, dorsal…" /></label><label><span className="sr-only">Filtrar por músculo</span><select value={muscleGroup} onChange={(event) => setMuscleGroup(event.target.value)}><option value="">Todos los músculos</option>{muscles.map((muscle) => <option key={muscle} value={muscle}>{muscle}</option>)}</select></label><label><span className="sr-only">Filtrar por material</span><select value={equipment} onChange={(event) => setEquipment(event.target.value)}><option value="">Todo el material</option>{equipmentOptions.map((item) => <option key={item} value={item}>{equipmentLabel(item as ExerciseDefinition['equipment'])}</option>)}</select></label></div><p className="library-results-count">{results.length} ejercicios disponibles</p><div className="library-results">{results.map((exercise) => <div className="library-result-row" key={exercise.id}><button type="button" className="library-result" disabled={!target} onClick={() => target && onSelect(target, exercise)}><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} /><span><strong>{exercise.name}</strong><small>{equipmentLabel(exercise.equipment)} · {target ? 'sustituir' : 'seleccionar'}</small></span></button><button type="button" className="library-add-button" onClick={() => onAdd(exercise)}><Plus size={14} /> Añadir</button></div>)}</div>{results.length === 0 && <p className="library-empty">No hay ejercicios con estos filtros.</p>}</section>;
}

function RoutineExercise({ exercise, index, exerciseOptions, alternatives, guidance, lastSession, progressionAction: action, expanded, onOpenLibrary, onToggle, onChange, onMove, onRemove }: { exercise: PlannedExercise; index: number; exerciseOptions: ExerciseDefinition[]; alternatives: ExerciseDefinition[]; guidance?: ExerciseGuidance; lastSession?: ExerciseSession; progressionAction?: ReturnType<typeof progressionAction>; expanded: boolean; onOpenLibrary: () => void; onToggle: () => void; onChange: (patch: Partial<PlannedExercise>) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void }) {
  const detail = guidance ?? { cues: ['Mantén una postura estable.', 'Mueve la carga sin impulso.', 'Controla el regreso.'] };
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<RoutineEditDraft>(() => routineEditDraftFrom(exercise));

  const updateDraft = (patch: Partial<RoutineEditDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const cancelEdit = (): void => {
    setDraft(routineEditDraftFrom(exercise));
    setEditOpen(false);
  };
  const saveEdit = (): void => {
    onChange(routineEditPatch(draft));
    setEditOpen(false);
  };

  return <article className={exercise.active ? 'routine-exercise' : 'routine-exercise is-off'}>
    <div className="routine-number">{String(index + 1).padStart(2, '0')}</div>
    <button type="button" className="routine-thumb-button" onClick={onToggle} aria-label={`${expanded ? 'Ocultar' : 'Ver'} imagen grande de ${exercise.name}`} aria-expanded={expanded}><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} /></button>
    <div className="routine-exercise-content">
      <div className="routine-exercise-title">
        <div className="routine-exercise-name">
          <select className="exercise-select" value={exercise.exerciseId} aria-label={`Cambiar ${exercise.name}`} onChange={(event) => { const replacement = exerciseOptions.find((item) => item.id === event.target.value); if (replacement) onChange({ exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition }); }}>
            <option value={exercise.exerciseId}>{exercise.name}</option>
            {exerciseOptions.filter((item) => item.id !== exercise.exerciseId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <p>{exercise.active ? 'Activo en la sesión' : 'Pausado'}</p>
          <button type="button" className="routine-library-button" onClick={onOpenLibrary}><Search size={13} /> Buscar en biblioteca</button>
        </div>
        <div className="routine-title-actions">
          <button type="button" className="routine-image-trigger" onClick={onToggle} aria-expanded={expanded}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}<span>{expanded ? 'Ocultar imagen' : 'Ver imagen'}</span></button>
          <button type="button" className={exercise.active ? 'toggle on' : 'toggle'} aria-label={exercise.active ? `Desactivar ${exercise.name}` : `Activar ${exercise.name}`} aria-pressed={exercise.active} onClick={() => onChange({ active: !exercise.active })}><span /></button>
        </div>
      </div>
      {expanded && <div className="routine-visual-guide"><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Imagen ampliada de ${exercise.name}`} large /><div className="routine-cues"><p className="eyebrow">cómo hacerlo</p><ol>{detail.cues.map((cue, cueIndex) => <li key={cue}><span>{cueIndex + 1}</span>{cue}</li>)}</ol></div></div>}
      <details className="routine-edit-details" open={editOpen} onToggle={(event) => { const nextOpen = event.currentTarget.open; setEditOpen(nextOpen); if (nextOpen) setDraft(routineEditDraftFrom(exercise)); }}>
        <summary>Editar parámetros del ejercicio</summary>
        <p className="routine-edit-note"><Check size={13} /> Edita sin tocar la rutina hasta guardar los cambios.</p>
        <div className="routine-fields">
          <label>Series<input inputMode="numeric" value={draft.sets} onChange={(event) => updateDraft({ sets: clampNumber(event.target.value, 1, 8) })} /></label>
          <label>Reps<input inputMode="numeric" value={`${draft.repMin}-${draft.repMax}`} onChange={(event) => { const [min, max] = event.target.value.split(/[–-]/).map(Number); if (Number.isFinite(min) && Number.isFinite(max)) updateDraft({ repMin: min, repMax: max }); }} /></label>
          <label>Descanso<input inputMode="numeric" value={draft.restSeconds / 60} onChange={(event) => updateDraft({ restSeconds: clampNumber(event.target.value, 0.5, 4) * 60 })} /></label>
        </div>
        <div className="routine-progression-fields">
          <label>Calentamiento<select value={draft.warmupSets} onChange={(event) => updateDraft({ warmupSets: clampNumber(event.target.value, 0, 3) })}><option value="0">Ninguno</option><option value="1">1 serie</option><option value="2">2 series</option><option value="3">3 series</option></select></label>
          <label>Regla de progresión<select value={draft.progressionPolicy} onChange={(event) => updateDraft({ progressionPolicy: event.target.value as RoutineEditDraft['progressionPolicy'] })}><option value="double">Doble progresión</option><option value="linear">Lineal</option><option value="off">Manual</option></select></label>
          <label>Salto de carga<input inputMode="decimal" value={draft.progressionIncrementKg} onChange={(event) => updateDraft({ progressionIncrementKg: clampNumber(event.target.value, 0.5, 10) })} /></label>
        </div>
        {alternatives.length > 0 && <div className="routine-alternatives"><span>Alternativas compatibles</span><div>{alternatives.slice(0, 3).map((replacement) => <button type="button" key={replacement.id} onClick={() => updateDraft({ exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition })}>{replacement.name}</button>)}</div></div>}
        {lastSession && <p className="routine-history"><History size={14} /> Última vez: {formatExerciseSummary(lastSession)}</p>}
        {action && <div className={`routine-next-action ${action.tone}`}><Gauge size={14} /><div><strong>{action.title}</strong><span>{action.detail}</span></div></div>}
        <div className="move-actions"><button type="button" onClick={() => { saveEdit(); onMove(-1); }} disabled={index === 0}><ArrowUp size={14} /> Subir</button><button type="button" onClick={() => { saveEdit(); onMove(1); }}><ArrowDown size={14} /> Bajar</button><button type="button" className="routine-remove-button" onClick={onRemove}><Trash2 size={14} /> Quitar</button></div>
        <div className="routine-edit-actions"><button type="button" className="secondary-button small" onClick={cancelEdit}>Cancelar</button><button type="button" className="primary-button small" onClick={saveEdit}><Save size={15} /> Guardar cambios</button></div>
      </details>
    </div>
  </article>;
}
function ProgressView({ data, onAddProgress, onAddCheckin, onInfo }: { data: AppData; onAddProgress: (entry: Omit<ProgressEntry, 'id' | 'date'>) => void; onAddCheckin: (checkin: Omit<WeeklyCheckin, 'id' | 'createdAt' | 'weekKey'>) => void; onInfo: () => void }) {
  const [measureOpen, setMeasureOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [form, setForm] = useState({ weightKg: '', waistCm: '', chestCm: '', armCm: '', hipCm: '' });
  const currentCheckin = data.checkins.find((item) => item.weekKey === weekKey());
  const weeklySummary = buildWeeklySummary(data);
  const scheduledTrainingDays = normalizeTrainingDays(data.profile.trainingDays).slice(0, data.plan.days.length);
  const weekDays = buildWeekDays(scheduledTrainingDays, data.sessions);
  const completedThisWeek = weekDays.filter((day) => day.completed).length;
  const weeklyTarget = Math.max(scheduledTrainingDays.length, 1);
  const performance = performanceRows(data.sessions);
  const progress = [...data.progress].sort((a, b) => a.date.localeCompare(b.date));
  const weightEntries = progress.filter((entry) => entry.weightKg !== undefined);
  const waistEntries = progress.filter((entry) => entry.waistCm !== undefined);
  const lastWeight = weightEntries.at(-1);
  const previousWeight = weightEntries.at(-2);
  const lastWaist = waistEntries.at(-1);
  const previousWaist = waistEntries.at(-2);
  const saveMeasure = (event: React.FormEvent): void => { event.preventDefault(); onAddProgress(Object.fromEntries(Object.entries(form).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)])) as Omit<ProgressEntry, 'id' | 'date'>); setForm({ weightKg: '', waistCm: '', chestCm: '', armCm: '', hipCm: '' }); setMeasureOpen(false); };
  return <section className="view-section"><PageHeader eyebrow="señales, no ruido" title="Tu progreso" action={<button className="icon-button subtle" type="button" aria-label="Información sobre las métricas" onClick={onInfo}><Info size={19} /></button>} /><div className="metric-grid"><MetricCard label="Peso actual" value={lastWeight?.weightKg !== undefined ? formatWeight(lastWeight.weightKg) : formatWeight(data.profile.currentWeightKg)} change={changeLabel(lastWeight?.weightKg, previousWeight?.weightKg)} icon={<Activity size={17} />} /><MetricCard label="Cintura" value={lastWaist?.waistCm !== undefined ? `${lastWaist.waistCm.toLocaleString('es-ES', { maximumFractionDigits: 1 })} cm` : 'Sin registro'} change={changeLabel(lastWaist?.waistCm, previousWaist?.waistCm, ' cm')} icon={<Gauge size={17} />} /><MetricCard label="Adherencia" value={`${Math.min(completedThisWeek, weeklyTarget)}/${weeklyTarget}`} change="esta semana" icon={<Check size={17} />} /></div><section className="progress-card weekly-adherence-card"><div className="section-heading compact"><div><p className="eyebrow">esta semana</p><h2>Tu constancia</h2></div><strong className="weekly-score">{completedThisWeek}/{weeklyTarget}</strong></div><div className="week-strip" aria-label="Entrenamientos de la semana">{weekDays.map((day) => <div className={day.completed ? 'week-day completed' : day.planned ? 'week-day planned' : 'week-day'} key={day.key}><span>{day.label}</span><i aria-hidden="true">{day.completed ? '✓' : day.planned ? '·' : ''}</i></div>)}</div><p className="history-caption">{completedThisWeek === 0 ? 'Todavía no hay entrenamientos guardados esta semana.' : `${completedThisWeek} de ${weeklyTarget} sesiones previstas ya están guardadas.`}</p></section><section className="progress-card"><div className="section-heading compact"><div><p className="eyebrow">evolución corporal</p><h2>Medidas en el tiempo</h2></div><button className="text-button" onClick={() => setMeasureOpen((value) => !value)}><Plus size={16} /> Añadir</button></div>{measureOpen && <form className="measurement-form" onSubmit={saveMeasure}><NumberField label="Peso" unit="kg" value={form.weightKg} onChange={(value) => setForm((current) => ({ ...current, weightKg: value }))} /><NumberField label="Cintura" unit="cm" value={form.waistCm} onChange={(value) => setForm((current) => ({ ...current, waistCm: value }))} /><NumberField label="Pecho" unit="cm" value={form.chestCm} onChange={(value) => setForm((current) => ({ ...current, chestCm: value }))} /><NumberField label="Brazo" unit="cm" value={form.armCm} onChange={(value) => setForm((current) => ({ ...current, armCm: value }))} /><NumberField label="Cadera" unit="cm · opcional" value={form.hipCm} onChange={(value) => setForm((current) => ({ ...current, hipCm: value }))} /><button className="primary-button small" type="submit">Guardar medidas</button></form>}<WeightChart entries={progress} /><div className="trend-list"><TrendRow label="Cintura" values={progress.map((item) => item.waistCm)} unit="cm" /></div>{data.progress.length === 0 && <div className="empty-state"><span className="empty-icon"><Activity size={19} /></span><strong>Aún no hay medidas</strong><p>Registra solo lo que te apetezca comparar. No hace falta hacerlo cada día.</p></div>}</section>{performance.length > 0 && <section className="progress-card performance-card"><div className="section-heading compact"><div><p className="eyebrow">señal de entrenamiento</p><h2>Rendimiento reciente</h2></div><Gauge size={19} /></div><div className="performance-list">{performance.map((item) => <div className="performance-row" key={item.exerciseId}><div><strong>{item.name}</strong><span>{item.load !== undefined ? `${formatWeight(item.load)} · ${item.reps ?? '-'} reps` : 'Sin carga registrada'}</span></div><b>{formatVolume(item.volume)}</b></div>)}</div></section>}<section className="checkin-card"><div className="checkin-mark"><Sun size={21} /></div><div className="checkin-copy"><p className="eyebrow">cierre semanal</p><h2>{currentCheckin ? 'Check-in guardado' : '¿Cómo ha ido la semana?'}</h2><p>{currentCheckin ? 'Puedes editarlo cuando quieras.' : 'Dos minutos para poner contexto a tus datos.'}</p></div><button className="text-button" onClick={() => setCheckinOpen((value) => !value)}>{currentCheckin ? 'Editar' : 'Hacer check-in'} <ChevronRight size={16} /></button></section>{checkinOpen && <CheckinForm existing={currentCheckin} onSave={(value) => { onAddCheckin(value); setCheckinOpen(false); }} />}
    <details className="progress-details"><summary>Ver histórico detallado</summary><div className="progress-details-body"><ExerciseTrendCard data={data} /><HistoryPanel data={data} /><WeeklyTrends summary={weeklySummary} /><TrainingSignalsCard signals={weeklySummary.signals} /></div></details><WeeklyReviewCard summary={weeklySummary} /></section>;
}

interface ExerciseTrendOption { id: string; name: string }

function exerciseTrendOptions(data: AppData): ExerciseTrendOption[] {
  const options = new Map<string, ExerciseTrendOption>();
  data.sessions.filter((session) => session.status === 'completed').forEach((session) => session.plannedExercises.forEach((exercise) => {
    if (!options.has(exercise.exerciseId)) options.set(exercise.exerciseId, { id: exercise.exerciseId, name: exercise.name });
  }));
  return Array.from(options.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function ExerciseTrendCard({ data }: { data: AppData }) {
  const [selectedExerciseId, setSelectedExerciseId] = useState('');
  const options = exerciseTrendOptions(data);
  const selected = options.find((option) => option.id === selectedExerciseId) ?? options[0];
  if (!selected) return null;
  const trend = exerciseTrend(selected.id, data.sessions);
  const weighted = trend.some((point) => point.maxWeightKg !== undefined);
  const chartPoints = trend.filter((point) => weighted ? point.maxWeightKg !== undefined : true);
  if (chartPoints.length === 0) return null;
  const latest = chartPoints.at(-1)!;
  const values = chartPoints.map((point) => weighted ? point.maxWeightKg! : point.volumeKg);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, 1);
  const width = 320;
  const plotTop = 14;
  const plotBottom = 122;
  const points = chartPoints.map((point, index) => ({
    x: chartPoints.length === 1 ? width / 2 : 12 + (index / (chartPoints.length - 1)) * (width - 24),
    y: plotBottom - ((values[index] - minimum) / range) * (plotBottom - plotTop),
    date: point.date,
  }));
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${points.at(-1)!.x.toFixed(2)} ${plotBottom} L ${points[0].x.toFixed(2)} ${plotBottom} Z`;
  const scaleValues = [maximum, minimum + range / 2, minimum];
  const numberFormat = { maximumFractionDigits: 1 } as const;
  const displayValue = (value: number): string => weighted ? `${value.toLocaleString('es-ES', numberFormat)} kg` : formatVolume(value);
  const metricLabel = weighted ? 'carga máxima' : 'volumen';
  return <section className="progress-card exercise-trend-card" aria-labelledby="exercise-trend-heading"><div className="section-heading compact"><div><p className="eyebrow">histórico por ejercicio</p><h2 id="exercise-trend-heading">Tu evolución</h2></div><History size={19} /></div><label className="exercise-trend-select" htmlFor="exercise-trend-picker"><span>Ejercicio</span><select id="exercise-trend-picker" value={selected.id} onChange={(event) => setSelectedExerciseId(event.target.value)}>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><div className="weight-chart-reading exercise-trend-reading"><strong>{displayValue(weighted ? latest.maxWeightKg! : latest.volumeKg)}</strong><span>{metricLabel} · {formatDate(latest.date, { day: 'numeric', month: 'short' })}</span></div><div className="weight-chart-body"><div className="weight-chart-scale" aria-hidden="true">{scaleValues.map((value, index) => <span key={`${value}-${index}`}>{weighted ? `${value.toLocaleString('es-ES', numberFormat)} kg` : formatVolume(value)}</span>)}</div><svg className="weight-chart-svg" viewBox="0 0 320 140" role="img" aria-labelledby="exercise-trend-title exercise-trend-description" preserveAspectRatio="none"><title id="exercise-trend-title">Evolución de {selected.name}</title><desc id="exercise-trend-description">{`${metricLabel} registrado entre ${formatDate(chartPoints[0].date, { day: 'numeric', month: 'long', year: 'numeric' })} y ${formatDate(latest.date, { day: 'numeric', month: 'long', year: 'numeric' })}.`}</desc><defs><linearGradient id="exercise-trend-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".32" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>{[plotTop, (plotTop + plotBottom) / 2, plotBottom].map((y) => <line className="weight-chart-gridline" key={y} x1="0" x2={width} y1={y} y2={y} />)}{chartPoints.length > 1 && <path className="weight-chart-area exercise-trend-area" d={areaPath} />}<path className="weight-chart-line" d={linePath} />{points.map((point, index) => <circle className={index === points.length - 1 ? 'weight-chart-point is-latest' : 'weight-chart-point'} key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r={index === points.length - 1 ? 4.5 : 3} />)}</svg></div><div className="weight-chart-footer"><span>{formatDate(chartPoints[0].date, { month: 'short', year: 'numeric' })}</span><span>{chartPoints.length} {chartPoints.length === 1 ? 'registro' : 'registros'}</span><span>{formatDate(latest.date, { month: 'short', year: 'numeric' })}</span></div>{chartPoints.length === 1 ? <p className="weight-chart-note">Añade otra sesión con este ejercicio para ver la tendencia.</p> : latest.discomfort ? <p className="weight-chart-note exercise-trend-warning">El último registro incluye molestias; prioriza control y comodidad antes de progresar.</p> : <p className="weight-chart-note">La línea muestra {weighted ? 'la carga máxima registrada en una serie' : 'el volumen de trabajo registrado'}.</p>}</section>;
}

function WeeklyTrends({ summary }: { summary: ReturnType<typeof buildWeeklySummary> }) {
  return <section className="progress-card"><h2>Últimas cuatro semanas</h2><p>La semana actual está en curso. La adherencia usa el objetivo de tu rutina actual.</p><div className="weekly-trends-table"><table><thead><tr><th>Desde</th><th>Sesiones</th><th>Adherencia</th><th>Volumen</th></tr></thead><tbody>{summary.trends.map((week) => <tr key={week.week}><td>{formatDate(week.week, { day: 'numeric', month: 'short' })}</td><td>{week.sessions}</td><td>{week.adherencePercent}%</td><td>{formatVolume(week.volumeKg)}</td></tr>)}</tbody></table></div><h3>Fuerza respecto a la semana anterior</h3><p>Carga comparada en el mismo ejercicio y con las mismas repeticiones.</p>{summary.strengthChanges.length ? <ul>{summary.strengthChanges.map((entry) => <li key={entry.exerciseId}>{entry.name}: {entry.previousKg} → {entry.currentKg} kg ({entry.changePercent > 0 ? '+' : ''}{entry.changePercent}%)</li>)}</ul> : <p>Aún no hay series comparables entre ambas semanas.</p>}</section>;
}

function WeeklyReviewCard({ summary }: { summary: ReturnType<typeof buildWeeklySummary> }) {
  const focusLabel = summary.focusTone === 'positive' ? 'Hay margen' : summary.focusTone === 'caution' ? 'Punto a revisar' : 'Siguiente paso';
  return <section className="coach-card weekly-review-card"><div className="weekly-review-topline"><div><p className="eyebrow light">para revisar juntos</p><h2>Tu semana, en claro</h2></div><span className="weekly-review-period">{summary.periodLabel}</span></div><p className="weekly-review-feedback">{summary.feedback}</p><div className="weekly-review-facts" aria-label="Resumen de la semana"><div><strong>{summary.completedSessions}/{summary.targetSessions}</strong><span>sesiones</span></div><div><strong>{summary.completedExercises}</strong><span>ejercicios</span></div><div><strong>{formatVolume(summary.volumeKg)}</strong><span>volumen</span></div></div><div className={`weekly-review-focus ${summary.focusTone}`}><Gauge size={17} /><div><strong>{focusLabel}</strong><p>{summary.focus}</p></div></div>{summary.recommendations.length > 0 && <div className="weekly-review-recommendations" aria-label="Recomendaciones para la próxima semana"><p className="eyebrow light">recomendación por ejercicio</p><ul>{summary.recommendations.slice(0, 3).map((recommendation) => <li key={recommendation.exerciseId}><strong>{recommendation.name}</strong><span>{recommendation.title}. {recommendation.detail}</span></li>)}</ul></div>}{summary.energy && <p className="weekly-review-checkin"><Sun size={15} /> Energía {summary.energy === 'high' ? 'alta' : summary.energy === 'low' ? 'baja' : 'normal'}{summary.feeling ? ` · ${summary.feeling}` : ''}</p>}</section>;
}

function TrainingSignalsCard({ signals }: { signals: ReturnType<typeof buildWeeklySummary>['signals'] }) {
  if (signals.length === 0) return null;
  return <section className="progress-card signal-card" aria-labelledby="training-signals-title"><div className="section-heading compact"><div><p className="eyebrow">detección temprana</p><h2 id="training-signals-title">Señales a revisar</h2></div><Gauge size={19} /></div><p className="section-description">No son diagnósticos: son patrones del historial para decidir el siguiente ajuste con calma.</p><div className="signal-list">{signals.slice(0, 4).map((signal) => <article className="signal-row" key={`${signal.kind}-${signal.exerciseId}`}><div><strong>{signal.name}</strong><span>{signal.title}</span></div><p>{signal.detail}</p><small>{signal.evidence.sessionCount} sesiones · {signal.evidence.latestDate}</small></article>)}</div></section>;
}

interface WeekDaySummary { key: string; label: string; planned: boolean; completed: boolean }
interface PerformanceSummary { exerciseId: string; name: string; load?: number; reps?: number; volume: number }
interface RecordSummary { exerciseId: string; name: string; load: number; reps?: number }
interface MuscleVolumeSummary { muscleGroup: string; volume: number }
interface HistorySummary { sessions30: number; currentMonth: number; previousMonth: number; volume30: number }

function buildWeekDays(trainingDays: number[], sessions: WorkoutSession[]): WeekDaySummary[] {
  const monday = new Date();
  const weekday = monday.getDay() || 7;
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - weekday + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(monday);
    current.setDate(monday.getDate() + index);
    const key = dateKey(current);
    const day = current.getDay();
    return {
      key,
      label: shortDayNames[day],
      planned: trainingDays.includes(day),
      completed: sessions.some((session) => session.status === 'completed' && session.dateKey === key),
    };
  });
}

function performanceRows(sessions: WorkoutSession[]): PerformanceSummary[] {
  const recentSessions = sessions.filter((session) => session.status === 'completed').sort((a, b) => a.dateKey.localeCompare(b.dateKey) || (a.completedAt ?? a.startedAt).localeCompare(b.completedAt ?? b.startedAt)).slice(-6);
  const rows = new Map<string, PerformanceSummary>();
  recentSessions.forEach((session) => session.plannedExercises.forEach((exercise) => {
    const recordedSets = exercise.setLogs.filter((set) => isWorkSet(set) && set.completed && set.weightKg !== undefined && set.actualReps !== undefined);
    if (recordedSets.length === 0) return;
    const best = recordedSets.reduce((current, set) => (set.weightKg ?? 0) > (current.weightKg ?? 0) ? set : current, recordedSets[0]);
    const volume = recordedSets.reduce((total, set) => total + (set.weightKg ?? 0) * (set.actualReps ?? 0), 0);
    const previous = rows.get(exercise.exerciseId);
    rows.set(exercise.exerciseId, {
      exerciseId: exercise.exerciseId,
      name: exercise.name,
      load: Math.max(previous?.load ?? 0, best.weightKg ?? 0) || undefined,
      reps: best.actualReps ?? previous?.reps,
      volume: (previous?.volume ?? 0) + volume,
    });
  }));
  return Array.from(rows.values()).sort((a, b) => b.volume - a.volume).slice(0, 3);
}

function formatVolume(value: number): string {
  if (value >= 1000) return `${(value / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}k kg`;
  return `${Math.round(value).toLocaleString('es-ES')} kg`;
}

function HistoryPanel({ data }: { data: AppData }) {
  const records = personalRecords(data.sessions).slice(0, 3);
  const muscleVolumes = muscleGroupVolumes(data).slice(0, 3);
  const summary = historySummary(data.sessions);
  return <section className="progress-card history-card"><div className="section-heading compact"><div><p className="eyebrow">historial avanzado</p><h2>Lo que está cambiando</h2></div><Trophy size={19} /></div><div className="history-stats"><div><CalendarDays size={16} /><strong>{summary.sessions30}</strong><span>sesiones · 30 días</span></div><div><Layers3 size={16} /><strong>{formatVolume(summary.volume30)}</strong><span>volumen · 30 días</span></div><div><Sparkles size={16} /><strong>{records.length}</strong><span>récords visibles</span></div></div><div className="history-columns"><div><p className="eyebrow">mejores cargas</p>{records.length ? <div className="history-list">{records.map((record) => <div className="history-list-row" key={record.exerciseId}><span>{record.name}</span><strong>{formatWeight(record.load)}{record.reps ? ` · ${record.reps} reps` : ''}</strong></div>)}</div> : <p className="history-empty">Registra peso y repeticiones para ver tus marcas.</p>}</div><div><p className="eyebrow">volumen por grupo</p>{muscleVolumes.length ? <div className="history-list">{muscleVolumes.map((item) => <div className="history-list-row" key={item.muscleGroup}><span>{item.muscleGroup}</span><strong>{formatVolume(item.volume)}</strong></div>)}</div> : <p className="history-empty">Aún no hay volumen calculable.</p>}</div></div><p className="history-caption">Este mes: {summary.currentMonth} sesiones · mes anterior: {summary.previousMonth}.</p></section>;
}

function personalRecords(sessions: WorkoutSession[]): RecordSummary[] {
  const records = new Map<string, RecordSummary>();
  sessions.filter((session) => session.status === 'completed').forEach((session) => session.plannedExercises.forEach((exercise) => {
    exercise.setLogs.filter((set) => isWorkSet(set) && set.completed && set.weightKg !== undefined).forEach((set) => {
      const previous = records.get(exercise.exerciseId);
      if (!previous || (set.weightKg ?? 0) > previous.load || ((set.weightKg ?? 0) === previous.load && (set.actualReps ?? 0) > (previous.reps ?? 0))) {
        records.set(exercise.exerciseId, { exerciseId: exercise.exerciseId, name: exercise.name, load: set.weightKg ?? 0, reps: set.actualReps });
      }
    });
  }));
  return Array.from(records.values()).sort((a, b) => b.load - a.load);
}

function muscleGroupVolumes(data: AppData): MuscleVolumeSummary[] {
  const names = new Map(data.exercises.map((exercise) => [exercise.id, exercise.muscleGroup]));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const totals = new Map<string, number>();
  data.sessions.filter((session) => session.status === 'completed' && new Date(`${session.dateKey}T12:00:00`) >= cutoff).forEach((session) => session.plannedExercises.forEach((exercise) => {
    const group = names.get(exercise.exerciseId) ?? 'Otros';
    const volume = exercise.setLogs.reduce((total, set) => total + (isWorkSet(set) && set.completed ? (set.weightKg ?? 0) * (set.actualReps ?? 0) : 0), 0);
    if (volume > 0) totals.set(group, (totals.get(group) ?? 0) + volume);
  }));
  return Array.from(totals, ([muscleGroup, volume]) => ({ muscleGroup, volume })).sort((a, b) => b.volume - a.volume);
}

function historySummary(sessions: WorkoutSession[]): HistorySummary {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const previousMonthDate = new Date(currentYear, currentMonth - 1, 1);
  const completed = sessions.filter((session) => session.status === 'completed');
  const recent = completed.filter((session) => new Date(`${session.dateKey}T12:00:00`) >= cutoff);
  const volume30 = recent.reduce((total, session) => total + session.plannedExercises.reduce((exerciseTotal, exercise) => exerciseTotal + exercise.setLogs.reduce((setTotal, set) => setTotal + (isWorkSet(set) && set.completed ? (set.weightKg ?? 0) * (set.actualReps ?? 0) : 0), 0), 0), 0);
  return {
    sessions30: recent.length,
    currentMonth: completed.filter((session) => { const date = new Date(`${session.dateKey}T12:00:00`); return date.getMonth() === currentMonth && date.getFullYear() === currentYear; }).length,
    previousMonth: completed.filter((session) => { const date = new Date(`${session.dateKey}T12:00:00`); return date.getMonth() === previousMonthDate.getMonth() && date.getFullYear() === previousMonthDate.getFullYear(); }).length,
    volume30,
  };
}

function MetricCard({ label, value, change, icon }: { label: string; value: string; change: string; icon: React.ReactNode }) { return <article className="metric-card"><div className="metric-label">{icon}<span>{label}</span></div><strong>{value}</strong><small>{change}</small></article>; }

function WeightChart({ entries }: { entries: ProgressEntry[] }) {
  const weightEntries = entries.filter((entry) => entry.weightKg !== undefined).sort((a, b) => a.date.localeCompare(b.date)).slice(-12);
  const latest = weightEntries.at(-1);
  if (!latest) return null;
  const previous = weightEntries.at(-2)?.weightKg;
  const delta = previous === undefined ? undefined : latest.weightKg! - previous;
  const values = weightEntries.map((entry) => entry.weightKg!);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, 1);
  const width = 320;
  const plotTop = 14;
  const plotBottom = 122;
  const points = weightEntries.map((entry, index) => ({
    x: weightEntries.length === 1 ? width / 2 : 12 + (index / (weightEntries.length - 1)) * (width - 24),
    y: plotBottom - ((entry.weightKg! - minimum) / range) * (plotBottom - plotTop),
  }));
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${points.at(-1)!.x.toFixed(2)} ${plotBottom} L ${points[0].x.toFixed(2)} ${plotBottom} Z`;
  const scaleValues = [maximum, minimum + range / 2, minimum];
  const numberFormat = { maximumFractionDigits: 1 } as const;
  return <section className="weight-chart" aria-labelledby="weight-chart-title">
    <div className="weight-chart-heading">
      <div>
        <p className="eyebrow">peso corporal</p>
        <div className="weight-chart-reading"><strong>{latest.weightKg!.toLocaleString('es-ES', numberFormat)}<small> kg</small></strong>{delta !== undefined && <span className={delta <= 0 ? 'is-positive' : 'is-caution'}>{delta > 0 ? '+' : ''}{delta.toLocaleString('es-ES', numberFormat)} kg</span>}</div>
      </div>
      <time dateTime={latest.date}>{formatDate(latest.date, { day: 'numeric', month: 'short' })}</time>
    </div>
    <div className="weight-chart-body">
      <div className="weight-chart-scale" aria-hidden="true">{scaleValues.map((value, index) => <span key={`${value}-${index}`}>{value.toLocaleString('es-ES', numberFormat)}</span>)}</div>
      <svg className="weight-chart-svg" viewBox="0 0 320 140" role="img" aria-labelledby="weight-chart-title weight-chart-description" preserveAspectRatio="none">
        <title id="weight-chart-title">Evolución del peso</title>
        <desc id="weight-chart-description">{`Peso registrado entre ${formatDate(weightEntries[0].date, { day: 'numeric', month: 'long', year: 'numeric' })} y ${formatDate(latest.date, { day: 'numeric', month: 'long', year: 'numeric' })}.`}</desc>
        <defs><linearGradient id="weight-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".32" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {[plotTop, (plotTop + plotBottom) / 2, plotBottom].map((y) => <line className="weight-chart-gridline" key={y} x1="0" x2={width} y1={y} y2={y} />)}
        {weightEntries.length > 1 && <path className="weight-chart-area" d={areaPath} />}
        <path className="weight-chart-line" d={linePath} />
        {points.map((point, index) => <circle className={index === points.length - 1 ? 'weight-chart-point is-latest' : 'weight-chart-point'} key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r={index === points.length - 1 ? 4.5 : 3} />)}
      </svg>
    </div>
    <div className="weight-chart-footer"><span>{formatDate(weightEntries[0].date, { month: 'short', year: 'numeric' })}</span><span>{weightEntries.length} {weightEntries.length === 1 ? 'registro' : 'registros'}</span><span>{formatDate(latest.date, { month: 'short', year: 'numeric' })}</span></div>
    {weightEntries.length === 1 && <p className="weight-chart-note">Añade otra medición para ver la tendencia.</p>}
  </section>;
}

function TrendRow({ label, values, unit }: { label: string; values: Array<number | undefined>; unit: string }) { const defined = values.filter((value): value is number => value !== undefined); const max = Math.max(...defined, 1); const min = Math.min(...defined, 0); return <div className="trend-row"><div><strong>{label}</strong><span>{defined.length ? `${defined[defined.length - 1].toLocaleString('es-ES')} ${unit}` : 'Sin datos'}</span></div><div className="trend-bars" aria-label={`Tendencia de ${label}`}>{defined.slice(-8).map((value, index) => { const height = defined.length > 1 ? Math.max(14, ((value - min) / Math.max(max - min, 1)) * 58 + 12) : 24; return <span key={`${value}-${index}`} style={{ height: `${height}px` }} />; })}</div></div>; }

function CheckinForm({ existing, onSave }: { existing?: WeeklyCheckin; onSave: (checkin: Omit<WeeklyCheckin, 'id' | 'createdAt' | 'weekKey'>) => void }) { const [form, setForm] = useState({ weightKg: existing?.weightKg?.toString() ?? '', waistCm: existing?.waistCm?.toString() ?? '', feeling: existing?.feeling ?? '', energy: existing?.energy ?? 'normal' as Energy, completedWorkouts: existing?.completedWorkouts?.toString() ?? '4', note: existing?.note ?? '' }); return <form className="checkin-form" onSubmit={(event) => { event.preventDefault(); onSave({ weightKg: form.weightKg ? Number(form.weightKg) : undefined, waistCm: form.waistCm ? Number(form.waistCm) : undefined, feeling: form.feeling, energy: form.energy, completedWorkouts: Number(form.completedWorkouts), note: form.note || undefined }); }}><div className="form-grid"><NumberField label="Peso" unit="kg · opcional" value={form.weightKg} onChange={(value) => setForm((current) => ({ ...current, weightKg: value }))} /><NumberField label="Cintura" unit="cm · opcional" value={form.waistCm} onChange={(value) => setForm((current) => ({ ...current, waistCm: value }))} /><label>Entrenamientos completados<select value={form.completedWorkouts} onChange={(event) => setForm((current) => ({ ...current, completedWorkouts: event.target.value }))}>{[0, 1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label><label>Energía<select value={form.energy} onChange={(event) => setForm((current) => ({ ...current, energy: event.target.value as Energy }))}><option value="low">Baja</option><option value="normal">Normal</option><option value="high">Alta</option></select></label></div><label>¿Cómo te has sentido?<textarea value={form.feeling} onChange={(event) => setForm((current) => ({ ...current, feeling: event.target.value }))} placeholder="Unas palabras sobre la semana" rows={2} /></label><label>Comentario opcional<textarea value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} rows={2} /></label><button className="primary-button small" type="submit"><Save size={16} /> Guardar check-in</button></form>; }

const experienceOptions: Array<{ value: ExperienceLevel; label: string; description: string }> = [
  { value: 'beginner', label: 'Estoy empezando', description: 'Quiero instrucciones sencillas y margen.' },
  { value: 'intermediate', label: 'Ya tengo base', description: 'Conozco las máquinas y registro cargas.' },
  { value: 'advanced', label: 'Tengo experiencia', description: 'Quiero centrarme en progresar.' },
];

function DayPicker({ selected, onChange }: { selected: number[]; onChange: (days: number[]) => void }) {
  const normalizedSelection = normalizeTrainingDays(selected).slice(0, 4);
  return <div className="day-picker" aria-label="Días de entrenamiento">{[1, 2, 3, 4, 5, 6, 0].map((day) => { const label = shortDayNames[day]; const dayName = dayNames[day]; const isSelected = normalizedSelection.includes(day); const selectionLimitReached = normalizedSelection.length >= 4 && !isSelected; return <button type="button" key={day} className={isSelected ? 'day-picker-button selected' : 'day-picker-button'} aria-label={dayName} aria-pressed={isSelected} disabled={selectionLimitReached} onClick={() => onChange(isSelected ? normalizedSelection.filter((item) => item !== day) : [...normalizedSelection, day].sort((a, b) => a - b))}>{label}</button>; })}</div>;
}

function EquipmentPicker({ selected, onChange }: { selected: ExerciseEquipment[]; onChange: (equipment: ExerciseEquipment[]) => void }) {
  const toggle = (equipment: ExerciseEquipment): void => {
    const next = selected.includes(equipment) ? selected.filter((item) => item !== equipment) : [...selected, equipment];
    if (next.length > 0) onChange(next);
  };
  return <div className="equipment-picker" role="group" aria-label="Equipamiento disponible">{allExerciseEquipment.map((equipment) => <label key={equipment} className={selected.includes(equipment) ? 'equipment-option selected' : 'equipment-option'}><input type="checkbox" checked={selected.includes(equipment)} onChange={() => toggle(equipment)} /><span>{equipmentLabel(equipment)}</span></label>)}</div>;
}

function OnboardingDialog({ profile, onComplete }: { profile: UserProfile; onComplete: (profile: Partial<UserProfile>) => void }) {
  const [form, setForm] = useState({
    gym: profile.gym,
    goal: profile.goal,
    heightCm: profile.heightCm?.toString() ?? '',
    currentWeightKg: profile.currentWeightKg?.toString() ?? '',
    sessionMinutes: String(profile.sessionMinutes),
    experienceLevel: profile.experienceLevel,
    trainingDays: profile.trainingDays,
    availableEquipment: profile.availableEquipment,
  });
  const save = (): void => onComplete({
    gym: form.gym.trim(),
    goal: form.goal.trim(),
    heightCm: numberOrUndefined(form.heightCm),
    currentWeightKg: numberOrUndefined(form.currentWeightKg),
    sessionMinutes: clampNumber(form.sessionMinutes, 20, 180),
    experienceLevel: form.experienceLevel,
    trainingDays: form.trainingDays.length ? form.trainingDays : profile.trainingDays,
    availableEquipment: form.availableEquipment.length ? form.availableEquipment : profile.availableEquipment,
  });
  return <div className="onboarding-backdrop"><section className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><div className="onboarding-kicker"><Sparkles size={16} /> primera configuración</div><h2 id="onboarding-title">Vamos a dejarlo a tu medida.</h2><p className="onboarding-lead">Unos datos básicos para que la rutina de Hoy encaje contigo desde el primer entrenamiento.</p><form onSubmit={(event) => { event.preventDefault(); save(); }}><label className="onboarding-field">¿Dónde entrenas?<input value={form.gym} onChange={(event) => setForm((current) => ({ ...current, gym: event.target.value }))} placeholder="Ej. Evanfit Picanya" /></label><label className="onboarding-field">¿Qué quieres conseguir?<input value={form.goal} onChange={(event) => setForm((current) => ({ ...current, goal: event.target.value }))} placeholder="Ej. ganar fuerza" /></label><div className="onboarding-grid"><label className="onboarding-field">Duración habitual<span>minutos</span><input inputMode="numeric" value={form.sessionMinutes} onChange={(event) => setForm((current) => ({ ...current, sessionMinutes: event.target.value }))} /></label><div className="onboarding-field"><span>¿Qué días entrenas?</span><span>elige los tuyos</span><DayPicker selected={form.trainingDays} onChange={(trainingDays) => setForm((current) => ({ ...current, trainingDays }))} /></div></div><div className="onboarding-field equipment-field"><span>¿Qué material tienes disponible?</span><span>Las sustituciones y la biblioteca se adaptarán a esto</span><EquipmentPicker selected={form.availableEquipment} onChange={(availableEquipment) => setForm((current) => ({ ...current, availableEquipment }))} /></div><fieldset className="experience-options"><legend>Tu punto de partida</legend>{experienceOptions.map((option) => <label key={option.value} className={form.experienceLevel === option.value ? 'experience-option selected' : 'experience-option'}><input type="radio" name="experience" value={option.value} checked={form.experienceLevel === option.value} onChange={() => setForm((current) => ({ ...current, experienceLevel: option.value }))} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</fieldset><div className="onboarding-section"><div className="onboarding-section-heading"><span>Datos opcionales</span><small>No hacen falta para empezar</small></div><div className="onboarding-grid"><label className="onboarding-field">Altura<span>cm · opcional</span><input inputMode="decimal" value={form.heightCm} onChange={(event) => setForm((current) => ({ ...current, heightCm: event.target.value }))} placeholder="-" /></label><label className="onboarding-field">Peso actual<span>kg · opcional</span><input inputMode="decimal" value={form.currentWeightKg} onChange={(event) => setForm((current) => ({ ...current, currentWeightKg: event.target.value }))} placeholder="-" /></label></div><p className="onboarding-privacy"><CloudOff size={15} /> Se guarda todo en este dispositivo. Puedes dejar estos datos vacíos y completarlos más adelante.</p></div><div className="onboarding-actions"><button className="primary-button" type="submit">Guardar y empezar <ChevronRight size={17} /></button><button className="secondary-button" type="button" onClick={() => onComplete({})}>Empezar sin completar</button></div></form></section></div>;
}

function AccountPanel({ user, passkeys, status, error, cloudUpdatedAt, onRegister, onLogin, onAddPasskey, onRenamePasskey, onRevokePasskey, onLogout, onLogoutEverywhere }: { user?: AuthUser; passkeys: AuthPasskey[]; status: AuthStatus; error?: string; cloudUpdatedAt?: string; onRegister: (displayName: string, passkeyLabel: string) => void; onLogin: () => void; onAddPasskey: (passkeyLabel: string) => void; onRenamePasskey: (credentialId: string, label: string) => void; onRevokePasskey: (credentialId: string) => void; onLogout: () => void; onLogoutEverywhere: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [passkeyLabel, setPasskeyLabel] = useState('Passkey principal');
  const [editingId, setEditingId] = useState<string>();
  const [editingLabel, setEditingLabel] = useState('');
  const busy = status === 'checking' || status === 'registering' || status === 'signing_in' || status === 'syncing';
  const statusCopy = status === 'checking' ? 'Comprobando tu cuenta…' : status === 'registering' ? 'Preparando tu passkey…' : status === 'signing_in' ? 'Esperando la confirmación…' : status === 'syncing' ? 'Sincronizando con D1…' : user ? cloudUpdatedAt ? `Sincronizado ${new Date(cloudUpdatedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}` : 'Cuenta conectada' : 'Sin cuenta en la nube';
  const beginEdit = (passkey: AuthPasskey): void => { setEditingId(passkey.credentialId); setEditingLabel(passkey.label); };
  const saveEdit = (): void => { if (editingId && editingLabel.trim()) onRenamePasskey(editingId, editingLabel.trim()); setEditingId(undefined); };
  return <section className="profile-section account-section"><div className="section-heading compact"><div><p className="eyebrow">cuenta · opcional</p><h2>{user ? 'Tu cuenta Radian' : 'Sincroniza con passkey'}</h2></div><Fingerprint size={21} /></div>{user ? <><div className="account-identity"><span className="account-avatar"><Fingerprint size={19} /></span><div><strong>{user.displayName}</strong><span>{statusCopy}</span></div></div><p className="section-description">Tus rutinas y sesiones se guardan en D1 y siguen disponibles en este dispositivo aunque estés sin conexión.</p><label className="account-name-field">Nombre de la nueva passkey<input value={passkeyLabel} onChange={(event) => setPasskeyLabel(event.target.value)} placeholder="Ej. iPhone" /></label><div className="account-actions"><button className="primary-button small" type="button" onClick={() => onAddPasskey(passkeyLabel.trim() || 'Passkey')} disabled={busy}><Fingerprint size={15} /> Añadir passkey</button><button className="secondary-button small" type="button" onClick={onLogout}><LogOut size={15} /> Cerrar sesión</button><button className="text-button danger-text" type="button" onClick={onLogoutEverywhere}>Cerrar en todos</button></div><div className="passkey-list"><div className="passkey-list-heading"><strong>Tus dispositivos</strong><span>{passkeys.length} passkey{passkeys.length === 1 ? '' : 's'}</span></div>{passkeys.map((passkey) => <div className="passkey-row" key={passkey.credentialId}>{editingId === passkey.credentialId ? <input value={editingLabel} onChange={(event) => setEditingLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveEdit(); if (event.key === 'Escape') setEditingId(undefined); }} autoFocus /> : <div><strong>{passkey.label}</strong><span>{passkey.lastUsedAt ? `Usada ${new Date(passkey.lastUsedAt).toLocaleDateString('es-ES')}` : `Añadida ${new Date(passkey.createdAt).toLocaleDateString('es-ES')}`}</span></div>}<div className="passkey-row-actions">{editingId === passkey.credentialId ? <button type="button" aria-label="Guardar nombre" onClick={saveEdit}><Save size={15} /></button> : <button type="button" aria-label={`Renombrar ${passkey.label}`} onClick={() => beginEdit(passkey)}><Pencil size={15} /></button>}<button type="button" aria-label={`Revocar ${passkey.label}`} onClick={() => onRevokePasskey(passkey.credentialId)} disabled={passkeys.length <= 1}><Trash2 size={15} /></button></div></div>)}</div></> : <><p className="section-description">Usa la huella, Face ID, PIN o el gestor de contraseñas del dispositivo. No necesitas crear ni recordar una contraseña.</p><label className="account-name-field">Nombre para tu perfil<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Ej. Carlos" autoComplete="name" /></label><label className="account-name-field">Nombre de la passkey<input value={passkeyLabel} onChange={(event) => setPasskeyLabel(event.target.value)} placeholder="Ej. iPhone" /></label><div className="account-actions"><button className="primary-button small" type="button" onClick={() => onRegister(displayName.trim(), passkeyLabel.trim() || 'Passkey principal')} disabled={busy || !displayName.trim()}><UserPlus size={15} /> Crear con passkey</button><button className="secondary-button small" type="button" onClick={onLogin} disabled={busy}><LogIn size={15} /> Entrar</button></div><p className="account-status" role="status">{statusCopy}</p></>}{error && <p className="error-message" role="alert">{error}</p>}<p className="sync-security"><LockKeyhole size={13} /> La passkey nunca sale del dispositivo. Radian guarda la clave pública necesaria para verificarla.</p></section>;
}

function ProfileView({ data, theme, onThemeChange, onUpdateProfile, onRepeatOnboarding, onImport, syncState, syncStatus, syncError, syncConflict, onKeepLocalSync, onUseRemoteSync, onConnectSync, onUploadSync, onDownloadSync, onDisconnectSync, onRevokeSync, onInstall, isInstalled }: { data: AppData; theme: Theme; onThemeChange: (theme: Theme) => void; onUpdateProfile: (profile: Partial<AppData['profile']>, adaptEquipmentPlan?: boolean) => void; onRepeatOnboarding: () => void; onImport: (data: AppData) => void; syncState: SyncState; syncStatus: SyncStatus; syncError?: string; syncConflict?: RemoteSyncData; onKeepLocalSync: () => void; onUseRemoteSync: () => void; onConnectSync: (key: string) => void; onUploadSync: () => void; onDownloadSync: () => void; onDisconnectSync: () => void; onRevokeSync: () => void; onInstall?: () => void; isInstalled: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [importError, setImportError] = useState<string>();
  const [profile, setProfile] = useState(data.profile);
  const save = (): void => {
    const equipmentChanged = profile.availableEquipment.join('|') !== data.profile.availableEquipment.join('|');
    const gaps = equipmentChanged ? planEquipmentGaps(data.plan, data.exercises, profile.availableEquipment) : [];
    if (gaps.length > 0) {
      const replaceable = gaps.filter((gap) => gap.replacement).length;
      const withoutReplacement = gaps.length - replaceable;
      const detail = `${replaceable} ${replaceable === 1 ? 'puede sustituirse' : 'pueden sustituirse'} automáticamente${withoutReplacement > 0 ? `; ${withoutReplacement} ${withoutReplacement === 1 ? 'queda' : 'quedan'} para revisar a mano` : ''}`;
      const adapt = window.confirm(`Tu material ha cambiado y ${gaps.length} ${gaps.length === 1 ? 'ejercicio ya no encaja' : 'ejercicios ya no encajan'}. ${detail}. ¿Quieres adaptar las sustituciones disponibles para las próximas sesiones?`);
      onUpdateProfile(profile, adapt);
    } else {
      onUpdateProfile(profile);
    }
    setEditing(false);
  };
  const exportData = (): void => downloadFile('radian-backup.json', serializeBackup(data), 'application/json');
  const importData = (event: React.ChangeEvent<HTMLInputElement>): void => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const next = parseBackup(String(reader.result)); setImportError(undefined); if (window.confirm('Esto sustituirá los datos locales actuales. ¿Quieres continuar?')) onImport(next); } catch (error) { setImportError(error instanceof Error ? error.message : 'No se pudo leer la copia.'); } }; reader.readAsText(file); event.target.value = ''; };
  return <section className="view-section"><PageHeader eyebrow="tu contexto" title="Perfil" action={<button className="icon-button subtle" aria-label="Editar perfil" onClick={() => setEditing(true)}><Settings2 size={19} /></button>} /><section className="profile-hero"><div className="profile-avatar">C</div><div><p className="eyebrow light">perfil local</p><h2>Tu punto de partida</h2><p>Solo tú tienes acceso a estos datos.</p></div></section><section className="profile-section"><div className="section-heading compact"><div><p className="eyebrow">base</p><h2>Datos personales</h2></div><button className="text-button" onClick={() => editing ? save() : setEditing(true)}>{editing ? 'Guardar' : 'Editar'}</button></div>{editing ? <div className="profile-form"><NumberField label="Altura" unit="cm · opcional" value={profile.heightCm?.toString() ?? ''} onChange={(value) => setProfile((current) => ({ ...current, heightCm: numberOrUndefined(value) }))} /><NumberField label="Peso actual" unit="kg · opcional" value={profile.currentWeightKg?.toString() ?? ''} onChange={(value) => setProfile((current) => ({ ...current, currentWeightKg: numberOrUndefined(value) }))} /><label>Gimnasio<input value={profile.gym} onChange={(event) => setProfile((current) => ({ ...current, gym: event.target.value }))} placeholder="Ej. Evanfit Picanya" /></label><label>Objetivo<input value={profile.goal} onChange={(event) => setProfile((current) => ({ ...current, goal: event.target.value }))} /></label><div className="days-field"><span>Días de entrenamiento</span><span>selecciona los tuyos</span><DayPicker selected={profile.trainingDays} onChange={(trainingDays) => setProfile((current) => ({ ...current, trainingDays }))} /></div><div className="profile-equipment-field"><span>Equipamiento disponible</span><span>Se usa para filtrar la biblioteca y las sustituciones</span><EquipmentPicker selected={profile.availableEquipment} onChange={(availableEquipment) => setProfile((current) => ({ ...current, availableEquipment }))} /></div><label>Duración por sesión<input inputMode="numeric" value={profile.sessionMinutes} onChange={(event) => setProfile((current) => ({ ...current, sessionMinutes: Number(event.target.value) }))} /></label><label>Nivel<select value={profile.experienceLevel} onChange={(event) => setProfile((current) => ({ ...current, experienceLevel: event.target.value as ExperienceLevel }))}><option value="beginner">Estoy empezando</option><option value="intermediate">Ya tengo base</option><option value="advanced">Tengo experiencia</option></select></label></div> : <div className="profile-facts"><Fact label="Altura" value={profile.heightCm !== undefined ? `${profile.heightCm} cm` : 'Sin registrar'} /><Fact label="Peso actual" value={profile.currentWeightKg !== undefined ? `${profile.currentWeightKg} kg` : 'Sin registrar'} /><Fact label="Objetivo" value={profile.goal || 'Sin definir'} /><Fact label="Gimnasio" value={profile.gym || 'Sin definir'} /><Fact label="Material" value={profile.availableEquipment.map((equipment) => equipmentLabel(equipment)).join(' · ')} /><Fact label="Sesiones" value={`${profile.trainingDays.length} días · ${profile.sessionMinutes} min`} /><Fact label="Nivel" value={experienceOptions.find((option) => option.value === profile.experienceLevel)?.label ?? 'Sin definir'} /></div>}</section><section className="profile-section"><div className="section-heading compact"><div><p className="eyebrow">preferencias</p><h2>Cómo usar Radian</h2></div></div><div className="setting-row"><div><strong>Apariencia</strong><span>Se adapta a tu preferencia</span></div><div className="theme-switcher" role="group" aria-label="Apariencia"><button type="button" key="system" className={theme === 'system' ? 'selected' : ''} aria-label={themeOptionLabel('system')} aria-pressed={theme === 'system'} onClick={() => onThemeChange('system')}>Auto</button><button type="button" key="light" className={theme === 'light' ? 'selected' : ''} aria-label={themeOptionLabel('light')} aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}><Sun size={16} aria-hidden="true" /></button><button type="button" key="dark" className={theme === 'dark' ? 'selected' : ''} aria-label={themeOptionLabel('dark')} aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}><Moon size={16} aria-hidden="true" /></button></div></div><div className="setting-row"><div><strong>Texto grande</strong><span>Mejor lectura en pantalla pequeña</span></div><button type="button" className={data.profile.largeText ? 'toggle on' : 'toggle'} aria-label={textSizeToggleLabel(data.profile.largeText)} aria-pressed={data.profile.largeText} onClick={() => onUpdateProfile({ largeText: !data.profile.largeText })}><span /></button></div><div className="setting-row"><div><strong>Datos en este dispositivo</strong><span>Sin analítica ni servicios de terceros</span></div><CloudOff size={19} /></div><div className="setting-row"><div><strong>Configuración inicial</strong><span>Puedes cambiar tus datos cuando quieras.</span></div><button type="button" className="secondary-button small" onClick={onRepeatOnboarding}><Sparkles size={15} /> Repetir</button></div>{(onInstall || isInstalled) && <div className="setting-row"><div><strong>{isInstalled ? 'Radian está instalada' : 'Instalar Radian'}</strong><span>{isInstalled ? 'Acceso rápido desde tu pantalla de inicio' : 'En iPhone: compartir → Añadir a pantalla de inicio'}</span></div>{isInstalled ? <ShieldCheck size={19} /> : <button type="button" className="secondary-button small" onClick={onInstall}>Instalar</button>}</div>}</section><SyncConflictCard local={data} remote={syncConflict} onKeepLocal={onKeepLocalSync} onUseRemote={onUseRemoteSync} /><SyncPanel syncState={syncState} syncStatus={syncStatus} syncError={syncError} onConnect={onConnectSync} onUpload={onUploadSync} onDownload={onDownloadSync} onDisconnect={onDisconnectSync} onRevoke={onRevokeSync} /><section className="profile-section"><div className="section-heading compact"><div><p className="eyebrow">copia de seguridad</p><h2>Tus datos</h2></div><FileJson size={20} /></div><p className="section-description">Exporta o restaura todo el contenido de Radian como un archivo JSON. Haz una copia de vez en cuando.</p><div className="backup-actions"><button className="secondary-button" onClick={exportData}><Download size={16} /> Exportar datos</button><button className="secondary-button" onClick={() => fileRef.current?.click()}><Upload size={16} /> Importar datos</button><input ref={fileRef} type="file" accept="application/json,.json" onChange={importData} hidden /></div>{importError && <p className="error-message" role="alert">{importError}</p>}</section><section className="profile-section nutrition-section"><div className="section-heading compact"><div><p className="eyebrow">contexto nutricional</p><h2>Sin contar calorías</h2></div><Info size={19} /></div><p className="section-description">Este contexto queda guardado para futuras revisiones, pero Radian no te pide registrar comidas.</p>{editing ? <textarea value={profile.nutritionContext} onChange={(event) => setProfile((current) => ({ ...current, nutritionContext: event.target.value }))} rows={5} /> : <p className="nutrition-copy">{profile.nutritionContext || 'Sin contexto guardado.'}</p>}</section></section>;
}

function SyncConflictCard({ local, remote, remoteLabel = 'Copia remota', intro = 'No se ha sobrescrito nada. Compara el resumen y toma una decisión explícita.', onKeepLocal, onUseRemote }: { local: AppData; remote?: RemoteSyncData; remoteLabel?: string; intro?: string; onKeepLocal: () => void; onUseRemote: () => void }) {
  if (!remote?.data) return null;
  const comparison = compareSyncCopies(local, remote.data);
  const formatCopyDate = (value?: string): string => value ? new Date(`${value}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : 'sin registro';
  const copySummary = (summary: ReturnType<typeof compareSyncCopies>['local']): string => `${summary.sessionCount} sesiones · ${summary.progressCount} medidas · ${summary.checkinCount} check-ins`;
  const changedAreas = [comparison.changed.profile && 'perfil', comparison.changed.routine && 'rutina', comparison.changed.sessions && 'sesiones', comparison.changed.progress && 'medidas', comparison.changed.checkins && 'check-ins'].filter((value): value is string => Boolean(value));
  return <section className="sync-conflict" role="alert" aria-label="Conflicto de sincronización"><strong>Elige qué copia conservar</strong><span>{intro}</span><div className="sync-copy-comparison"><div><small>Este dispositivo</small><strong>{copySummary(comparison.local)}</strong><span>Última sesión: {formatCopyDate(comparison.local.latestSessionDate)}</span></div><div><small>{remoteLabel}</small><strong>{copySummary(comparison.remote)}</strong><span>Última sesión: {formatCopyDate(comparison.remote.latestSessionDate)}</span></div></div>{changedAreas.length > 0 && <p className="sync-conflict-differences">Diferencias detectadas: {changedAreas.join(', ')}.</p>}<div className="sync-conflict-actions"><button className="secondary-button small" type="button" onClick={onUseRemote}>Usar {remoteLabel.toLowerCase()}</button><button className="primary-button small" type="button" onClick={onKeepLocal}>Conservar este dispositivo</button></div></section>;
}

function SyncPanel({ syncState, syncStatus, syncError, onConnect, onUpload, onDownload, onDisconnect, onRevoke }: { syncState: SyncState; syncStatus: SyncStatus; syncError?: string; onConnect: (key: string) => void; onUpload: () => void; onDownload: () => void; onDisconnect: () => void; onRevoke: () => void }) {
  const [key, setKey] = useState(syncState.key ?? '');
  useEffect(() => setKey(syncState.key ?? ''), [syncState.key]);
  const busy = syncStatus === 'checking' || syncStatus === 'syncing';
  const status = syncStatus === 'remote' ? 'Hay una copia remota pendiente de elegir.' : syncStatus === 'synced' ? 'Sincronizado ahora.' : syncStatus === 'unavailable' ? 'Cloudflare aún no está conectado.' : syncStatus === 'conflict' ? 'Hay cambios distintos en los dos dispositivos.' : syncStatus === 'checking' ? 'Comprobando el código…' : syncStatus === 'syncing' ? 'Sincronizando…' : syncState.key ? 'Código preparado.' : 'Aún no hay ningún dispositivo conectado.';
  const generate = (): void => setKey(generateSyncKey());
  const copy = (): void => { if (key) navigator.clipboard.writeText(key).catch(() => undefined); };
  return <section className="profile-section sync-section"><div className="section-heading compact"><div><p className="eyebrow">opcional · cloudflare</p><h2>Sincronizar dispositivos</h2></div><LockKeyhole size={20} /></div><p className="section-description">Empareja el móvil y el ordenador con un código. El modo local sigue funcionando si no configuras la nube.</p><div className="sync-code-field"><label>Código de sincronización<input value={key} onChange={(event) => setKey(normalizeSyncKey(event.target.value))} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" spellCheck={false} /></label>{key && <button className="icon-button" type="button" onClick={copy} aria-label="Copiar código"><Clipboard size={16} /></button>}</div><div className="backup-actions"><button className="secondary-button" type="button" onClick={generate}><KeyRound size={15} /> Generar código</button><button className="primary-button small" type="button" onClick={() => onConnect(key)} disabled={busy || !key}>Conectar</button></div>{syncState.key && <div className="sync-actions"><button className="secondary-button small" type="button" onClick={onDownload} disabled={busy}>Descargar nube</button><button className="secondary-button small" type="button" onClick={onUpload} disabled={busy}>Subir local</button><button className="text-button" type="button" onClick={onDisconnect}>Desconectar</button><button className="text-button danger-text" type="button" onClick={onRevoke}>Revocar código</button></div>}<p className="sync-status" role="status">{status}</p>{syncState.remoteUpdatedAt && <p className="sync-last-updated">Última versión confirmada: {new Date(syncState.remoteUpdatedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</p>}{syncError && <p className="error-message" role="alert">{syncError}</p>}<p className="sync-security"><LockKeyhole size={13} /> La copia se cifra en el dispositivo antes de subirla. Revoca el código si cambias de móvil.</p></section>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="fact"><span>{label}</span><strong>{value}</strong></div>; }
function displayWorkoutName(name: string): string { return name.replace(/\s*[·•]\s*/g, ', '); }
function numberOrUndefined(value: string): number | undefined { if (!value.trim()) return undefined; const number = Number(value); return Number.isFinite(number) ? number : undefined; }
function formatExerciseSummary(session: ExerciseSession): string { const completedSets = session.setLogs?.filter((set) => isWorkSet(set) && set.completed) ?? []; const lastSet = completedSets[completedSets.length - 1]; if (lastSet?.weightKg !== undefined && lastSet.actualReps !== undefined) return `${lastSet.weightKg.toLocaleString('es-ES', { maximumFractionDigits: 1 })} kg · ${lastSet.actualReps} reps`; if (session.actualWeightKg !== undefined && session.actualReps !== undefined) return `${session.actualWeightKg.toLocaleString('es-ES', { maximumFractionDigits: 1 })} kg · ${session.actualReps} reps`; return difficultyLabel(session.difficulty ?? 'good'); }
function NumberField({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange: (value: string) => void }) { return <label>{label}<span>{unit}</span><input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="-" /></label>; }
function clampNumber(value: string, min: number, max: number): number { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min; }
function moveExercise(exercises: PlannedExercise[], index: number, direction: -1 | 1): PlannedExercise[] { const nextIndex = index + direction; if (nextIndex < 0 || nextIndex >= exercises.length) return exercises; const copy = [...exercises]; [copy[index], copy[nextIndex]] = [copy[nextIndex], copy[index]]; return copy; }
function changeLabel(current?: number, previous?: number, suffix = ' kg'): string { if (current === undefined || previous === undefined) return 'sin comparación'; const difference = current - previous; if (difference === 0) return 'estable'; return `${difference > 0 ? '+' : ''}${difference.toLocaleString('es-ES', { maximumFractionDigits: 1 })}${suffix}`; }
function difficultyLabel(value: Difficulty): string { return difficultyOptions.find((option) => option.value === value)?.label ?? value; }
function downloadFile(filename: string, contents: string, type: string): void { const blob = new Blob([contents], { type }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }

export { App };
export default App;
