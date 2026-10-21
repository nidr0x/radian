import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CloudOff, Search, Settings2, UserRound } from 'lucide-react';
import { currentWeekday, scheduledWorkoutDays } from './lib/date';
import { loadData, migrateData, persistData } from './lib/storage';
import { dataVersion as buildDataVersion, dataRevisionFromVersion, readCheckpoint } from './lib/syncRecovery';
import { updateActionCopy } from './lib/uiCopy';
import { applyAppUpdate } from './lib/pwa';
import { requestScreenWakeLock, type ScreenWakeLock } from './lib/wakeLock';
import { useDataSync } from './components/useDataSync';
import { BottomNav } from './components/BottomNav';
import { navItems } from './components/navigation';
import { ConfirmDialog, RestEndedOverlay, SessionExitDialog } from './components/Dialogs';
import { RestFloating } from './components/RestFloating';
import { ResumeSessionBanner } from './components/ResumeSessionBanner';
import { DataStatusPanel } from './components/DataStatusPanel';
import { UpdateBanner } from './components/UpdateBanner';
import { AccountPanel } from './components/AccountPanel';
import { SyncConflictCard } from './components/SyncConflictCard';
import { useRoutineActions } from './views/useRoutineActions';
import { useSessionActions } from './views/useSessionActions';
import { useRestTimer } from './views/useRestTimer';
import { TodayView } from './views/TodayView';
import { RoutineView } from './views/RoutineView';
import { ProgressView } from './views/ProgressView';
import { ProfileView } from './views/ProfileView';
import { OnboardingDialog } from './views/OnboardingDialog';
import type { AppData, Theme, View } from './types';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function App() {
  const [data, setDataState] = useState<AppData>(() => loadData());
  const [initialSyncCheckpoint] = useState(() => {
    const checkpoint = readCheckpoint();
    const matches = checkpoint?.snapshot === JSON.stringify(data);
    return { checkpoint, matches, revision: matches ? dataRevisionFromVersion(checkpoint?.localVersion) : 0 };
  });
  const dataRevisionRef = useRef(initialSyncCheckpoint.revision);
  const setData = (next: AppData | ((current: AppData) => AppData)): void => {
    dataRevisionRef.current += 1;
    setDataState(next);
  };
  const updateData = (updater: (current: AppData) => AppData): void => setData((current) => updater(current));
  const dataVersion = buildDataVersion(data, dataRevisionRef.current);
  const [view, setView] = useState<View>('today');
  const [topbarSearch, setTopbarSearch] = useState('');
  const [exerciseSearchRequest, setExerciseSearchRequest] = useState<{ query: string }>();
  const clearExerciseSearchRequest = useCallback(() => setExerciseSearchRequest(undefined), []);
  const [activeDayId, setActiveDayId] = useState<string>(() => data.plan.days.find((day) => day.weekday === currentWeekday())?.id ?? data.plan.days[0].id);
  const [toast, setToast] = useState<string>();
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel: string; danger: boolean; onConfirm: () => void; onCancel: () => void } | null>(null);
  const rest = useRestTimer(setToast);
  const showConfirm = (opts: { title: string; message: string; confirmLabel: string; danger: boolean }): Promise<boolean> => new Promise((resolve) => setConfirmDialog({
    ...opts,
    onConfirm: () => { resolve(true); setConfirmDialog(null); },
    onCancel: () => { resolve(false); setConfirmDialog(null); },
  }));
  const dataRef = useRef(data);
  dataRef.current = data;
  const sync = useDataSync(data, dataRef, setData, dataRevisionRef, dataVersion, showConfirm, setToast);
  const [theme, setTheme] = useState<Theme>(data.profile.theme);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [screenWakeLockActive, setScreenWakeLockActive] = useState(false);
  const screenWakeLockRef = useRef<ScreenWakeLock | undefined>(undefined);
  const session = useSessionActions(data, updateData, setToast, setView, rest.startRest);
  const routine = useRoutineActions(data, updateData, setToast);

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
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(undefined), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);
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

  const leaveSession = (): void => setExitDialogOpen(true);
  const confirmLeaveSession = (): void => {
    setExitDialogOpen(false);
    rest.stopRest();
    setView('routine');
    setToast('Sesión guardada para retomarla cuando quieras');
  };
  const changeTheme = (nextTheme: Theme): void => {
    setTheme(nextTheme);
    updateData((current) => ({ ...current, profile: { ...current.profile, theme: nextTheme } }));
  };
  const installApp = async (): Promise<void> => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };
  const repeatOnboarding = (): void => {
    setView('today');
    updateData((current) => ({ ...current, onboardingComplete: false }));
  };
  const handleApplyUpdate = (): void => {
    if (persistData(dataRef.current)) applyAppUpdate();
    else sync.setStorageWarning('No se pudo guardar antes de actualizar.');
  };
  const pendingChanges = dataVersion !== sync.acknowledged;
  const updateCopy = updateActionCopy(Boolean(activeSession));
  const connectionLabel = !sync.online ? 'sin conexión'
    : sync.cloudConflict ? 'conflicto'
      : sync.authStatus === 'syncing' ? 'sincronizando'
        : sync.accountUploadPending ? 'copia local pendiente de subir'
          : sync.authUser ? pendingChanges ? 'cambios pendientes' : 'sincronizado'
            : 'guardado local';

  return (
    <div className={activeSession && view === 'today' ? 'app-shell session-active-app' : 'app-shell'}>
      <a className="skip-link" href="#main-content">Ir al contenido</a>
      <aside className="desktop-sidebar" aria-label="Navegación principal">
        <div className="brand-lockup"><span className="brand-mark">R</span><span>radian</span></div>
        <nav className="desktop-nav" aria-label="Secciones">
          <p className="eyebrow">Entrena</p>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={view === id ? 'desktop-nav-item is-active' : 'desktop-nav-item'}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => setView(id)}
            >
              <Icon size={19} /><span>{id === 'today' ? 'Inicio' : id === 'routine' ? 'Rutinas' : label}</span>
            </button>
          ))}
        </nav>
        <div className="desktop-sidebar-footer">
          <div className="sidebar-sync-state" role="status"><span className="status-dot" /><span>{connectionLabel}</span></div>
          <button type="button" className="sidebar-settings" onClick={() => setView('profile')}><Settings2 size={18} /><span>Ajustes</span></button>
        </div>
      </aside>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">R</span><span>radian</span></div>
        <form
          className="topbar-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setExerciseSearchRequest({ query: topbarSearch.trim() });
            setView('routine');
          }}
        >
          <Search size={18} aria-hidden="true" />
          <input aria-label="Buscar ejercicios" placeholder="Buscar ejercicios…" value={topbarSearch} onChange={(event) => setTopbarSearch(event.target.value)} />
        </form>
        <div className="topbar-actions">
          <div className="connection-state" role="status"><span className="status-dot" /> <span>{connectionLabel}</span></div>
          <button className="icon-button topbar-settings" type="button" aria-label="Abrir perfil y ajustes" onClick={() => setView('profile')}><UserRound size={19} /></button>
        </div>
      </header>
      <main className="app-main" id="main-content">
        {!sync.online && <section className="profile-section" role="status">Sin conexión. Puedes seguir registrando el entrenamiento; los cambios quedan en este dispositivo.</section>}
        {sync.updateAvailable && (
          <UpdateBanner
            updateCopy={updateCopy}
            hasActiveSession={hasActiveSession}
            storageWarning={Boolean(sync.storageWarning)}
            syncing={sync.authStatus === 'syncing'}
            onApply={handleApplyUpdate}
          />
        )}
        {view === 'profile' && (
          <DataStatusPanel
            accountUploadPending={sync.accountUploadPending}
            pendingChanges={pendingChanges}
            authenticated={Boolean(sync.authUser)}
            busy={sync.authStatus === 'syncing'}
            hasCloudConflict={Boolean(sync.cloudConflict)}
            codeConnected={Boolean(sync.syncState.key)}
            online={sync.online}
            cloudUpdatedAt={sync.cloudUpdatedAt}
            recovery={sync.recovery}
            onRefresh={() => void sync.refreshCloud()}
            onRestore={sync.restoreLocalRecovery}
          />
        )}
        {view === 'profile' && (
          <AccountPanel
            user={sync.authUser}
            passkeys={sync.passkeys}
            status={sync.authStatus}
            error={sync.authError}
            cloudUpdatedAt={sync.cloudUpdatedAt}
            uploadPending={sync.accountUploadPending}
            uploadDisabled={!sync.online}
            onUploadLocal={() => void sync.uploadLocalToAccount()}
            onRegister={sync.handleRegisterPasskey}
            onLogin={sync.handleLoginPasskey}
            onAddPasskey={sync.handleAddPasskey}
            onRenamePasskey={sync.handleRenamePasskey}
            onRevokePasskey={sync.handleRevokePasskey}
            onLogout={sync.handleLogout}
            onLogoutEverywhere={sync.handleLogoutEverywhere}
          />
        )}
        {sync.cloudConflict?.data && <SyncConflictCard local={data} remote={sync.cloudConflict} remoteLabel="Copia de la nube" intro="La nube cambió desde la última sincronización. Elige qué copia conservar." onKeepLocal={() => void sync.resolveCloudConflict('local')} onUseRemote={() => void sync.resolveCloudConflict('remote')} />}
        {activeSession && view !== 'today' && <ResumeSessionBanner session={activeSession} onResume={() => setView('today')} />}
        {view === 'today' && (
          <TodayView
            data={data}
            todayDay={todayDay}
            activeSession={activeSession}
            onSelectExercise={session.selectSessionExercise}
            onDeferExercise={session.deferSessionExercise}
            restRemaining={rest.restRemaining}
            restUntil={rest.restUntil}
            restExerciseName={rest.restContext?.exerciseName}
            onRestartRest={rest.restartRest}
            screenWakeLockActive={screenWakeLockActive}
            onStart={session.startSession}
            onDismissRestEnded={rest.dismissRestEnded}
            onComplete={session.completeExercise}
            onDraft={session.updateExerciseDraft}
            onSwapExercise={session.swapSessionExercise}
            onQueueRecovery={session.queueSkippedExercises}
            onRemoveRecoveryExercise={session.removeQueuedRecoveryExercise}
            onRest={() => {
              const exercise = activeSession?.plannedExercises[activeSession.activeExerciseIndex];
              rest.startRest(exercise?.restSeconds ?? 90, exercise?.name ?? 'Ejercicio');
            }}
            onNavigate={setView}
            onUndo={session.undoLastSessionChange}
            canUndo={Boolean(session.lastSessionChange)}
            onExit={leaveSession}
            onHelp={() => setToast('Marca las series y cómo te ha ido; el resto queda guardado automáticamente.')}
          />
        )}
        {view === 'routine' && (
          <RoutineView
            data={data}
            days={scheduledDays}
            activeDay={activeDay}
            onDayChange={setActiveDayId}
            onUpdateDay={routine.updateRoutineDay}
            onAddExercise={routine.addRoutineExercise}
            onRemoveExercise={routine.removeRoutineExercise}
            onStart={session.startSession}
            searchRequest={exerciseSearchRequest}
            onSearchRequestHandled={clearExerciseSearchRequest}
          />
        )}
        {view === 'progress' && (
          <ProgressView data={data} onAddProgress={routine.addProgress} onAddCheckin={routine.addCheckin} onInfo={() => setToast('Las métricas se calculan solo con sesiones y medidas guardadas en Radian.')} onToast={setToast} />
        )}
        {view === 'profile' && (
          <ProfileView
            data={data}
            authUser={sync.authUser}
            theme={theme}
            onThemeChange={changeTheme}
            onUpdateProfile={routine.updateProfile}
            onRepeatOnboarding={repeatOnboarding}
            onImport={(next) => { setData(next); setToast('Copia restaurada'); }}
            onConfirmImport={() => showConfirm({ title: '¿Importar esta copia?', message: 'Esto sustituirá los datos locales actuales.', confirmLabel: 'Importar', danger: false })}
            onConfirmEquipment={(message) => showConfirm({ title: '¿Adaptar la rutina?', message, confirmLabel: 'Adaptar ejercicios', danger: false })}
            syncState={sync.syncState}
            syncStatus={sync.syncStatus}
            syncError={sync.syncError}
            syncConflict={sync.syncConflict}
            onKeepLocalSync={sync.keepLocalSync}
            onUseRemoteSync={sync.useRemoteSync}
            onConnectSync={sync.connectSync}
            onUploadSync={sync.uploadSync}
            onDownloadSync={sync.downloadSync}
            onDisconnectSync={sync.disconnectSync}
            onRevokeSync={sync.revokeSync}
            onInstall={installPrompt ? installApp : undefined}
            isInstalled={isInstalled}
          />
        )}
      </main>
      <BottomNav view={view} onChange={setView} />
      {exitDialogOpen && <SessionExitDialog onCancel={() => setExitDialogOpen(false)} onConfirm={confirmLeaveSession} />}
      {confirmDialog && <ConfirmDialog {...confirmDialog} />}
      {rest.restEnded && <RestEndedOverlay nextExerciseName={activeSession?.plannedExercises[activeSession.activeExerciseIndex]?.name} onDismiss={rest.dismissRestEnded} />}
      {(rest.restRemaining > 0 || toast || sync.storageWarning) && (
        <div className="floating-feedback" aria-live="polite">
          {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
          {sync.storageWarning && <div className="storage-warning" role="alert"><CloudOff size={16} />{sync.storageWarning}</div>}
          <RestFloating
            restUntil={rest.restUntil}
            restRemaining={rest.restRemaining}
            exerciseName={rest.restContext?.exerciseName}
            paused={rest.restPaused}
            onAdjust={rest.adjustRest}
            onPause={rest.pauseRest}
            onResume={rest.resumeRest}
            onClose={rest.resetRest}
          />
        </div>
      )}
      {!data.onboardingComplete && <OnboardingDialog profile={data.profile} onComplete={routine.completeOnboarding} />}
    </div>
  );
}

export { App };
export default App;
