import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteSyncData, loadSyncState, normalizeSyncKey, persistSyncState, pullSyncData, pushSyncData,
  SyncApiError, type RemoteSyncData, type SyncState,
} from '../lib/sync';
import {
  dataVersion as buildDataVersion, dataRevisionFromVersion, readCheckpoint, saveCheckpoint,
  syncDecision, readRecovery, preserveRecovery,
} from '../lib/syncRecovery';
import { migrateData, parseBackup, persistData, subscribeStorageFailure } from '../lib/storage';
import { hasAppUpdate } from '../lib/pwa';
import {
  addPasskey, AuthApiError, currentUser, listPasskeys, loginWithPasskey, logout, logoutEverywhere,
  pullCloudData, pushCloudData, registerPasskey, renamePasskey, revokePasskey,
  type AuthPasskey, type AuthUser, type CloudData,
} from '../lib/auth';
import type { AppData } from '../types';
import type { AuthStatus, SyncStatus } from '../lib/appStatus';

type SetDataSignature = (next: AppData | ((current: AppData) => AppData)) => void;
type ConfirmOptions = { title: string; message: string; confirmLabel: string; danger: boolean };

/** Device sync, cloud account and recovery state, extracted verbatim from App.tsx. */
export function useDataSync(
  data: AppData,
  dataRef: { readonly current: AppData },
  setData: SetDataSignature,
  dataRevisionRef: { current: number },
  dataVersion: string,
  showConfirm: (opts: ConfirmOptions) => Promise<boolean>,
  setToast: (toast?: string) => void,
): DataSync {
  const [storageWarning, setStorageWarning] = useState<string>();
  const [initialSyncCheckpoint] = useState(() => {
    const checkpoint = readCheckpoint();
    const matches = checkpoint?.snapshot === JSON.stringify(data);
    return { checkpoint, matches, revision: matches ? dataRevisionFromVersion(checkpoint?.localVersion) : 0 };
  });


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
  const [accountUploadPending, setAccountUploadPending] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [updateAvailable, setUpdateAvailable] = useState(hasAppUpdate);
  const [recovery, setRecovery] = useState(readRecovery);
  const [acknowledged, setAcknowledged] = useState(() => initialSyncCheckpoint.matches ? initialSyncCheckpoint.checkpoint?.localVersion ?? dataVersion : undefined);
  const [syncAttempt, setSyncAttempt] = useState(0);

  const cloudBusyRef = useRef(false);
  const acknowledge = useCallback((snapshot: AppData, updatedAt?: string, version = buildDataVersion(snapshot, dataRevisionRef.current)): void => {
    if (!updatedAt || !authUserRef.current) return;
    saveCheckpoint(authUserRef.current.id, updatedAt, snapshot, version);
    setAcknowledged(version);
    cloudUpdatedAtRef.current = updatedAt;
    setCloudUpdatedAt(updatedAt);
  }, [dataRevisionRef]);

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
  useEffect(() => subscribeStorageFailure(() => {
    setStorageWarning((current) => current === 'No se pudo guardar el progreso en este dispositivo.' ? current : 'No se pudo guardar el progreso en este dispositivo.');
  }), []);
  useEffect(() => {
    if (!online || !authUser || !cloudSyncReadyRef.current || cloudBusyRef.current || dataVersion === acknowledged) return undefined;
    const snapshotVersion = dataVersion;
    const timer = window.setTimeout(() => {
      setAuthStatus('syncing');
      cloudBusyRef.current = true;
      pushCloudData(data, cloudUpdatedAtRef.current).then(({ updatedAt }) => {
        acknowledge(data, updatedAt, snapshotVersion);
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
  }, [authUser, data, online, syncAttempt, acknowledged, dataVersion, acknowledge, dataRef]);
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
  // Runs once on mount on purpose: `hydrateAccount` and `showConfirm` are
  // per-render closures, and re-running this check on each render would refetch
  // the account and re-hydrate local data repeatedly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!syncStateRef.current.key || !await showConfirm({ title: '¿Revocar código de sincronización?', message: 'Se borrará la copia remota y este código dejará de funcionar.', confirmLabel: 'Revocar', danger: true })) return;
    try {
      await deleteSyncData(syncStateRef.current.key);
      disconnectSync();
      setToast('Copia remota revocada');
    } catch (error: unknown) {
      reportSyncError(error, 'No se pudo revocar la copia remota.');
    }
  };

  const hydrateAccount = async (user: AuthUser, localSnapshot: AppData): Promise<void> => {
    if (cloudBusyRef.current) return;
    cloudBusyRef.current = true;
    if (authUserRef.current?.id !== user.id) {
      setCloudUpdatedAt(undefined);
      setCloudConflict(undefined);
    }
    try {
    authUserRef.current = user;
    setAuthUser(user);
    setAuthStatus('syncing');
    setAuthError(undefined);
    cloudSyncReadyRef.current = false;
    const remote = await pullCloudData();
    localSnapshot = dataRef.current;
    const localVersion = buildDataVersion(localSnapshot, dataRevisionRef.current);
    if (remote.data) {
      setAccountUploadPending(false);
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
        acknowledge(localSnapshot, saved.updatedAt, localVersion);
      } else {
        if (decision === 'download') {
          setRecovery(preserveRecovery(localSnapshot));
          setData(normalized);
        }
        acknowledge(decision === 'download' ? normalized : localSnapshot, remote.updatedAt, decision === 'download' ? buildDataVersion(normalized, dataRevisionRef.current) : localVersion);
      }
    } else {
      if (readCheckpoint()?.userId === user.id) {
        setAccountUploadPending(false);
        setAuthStatus('error');
        setAuthError('La copia remota se ha borrado. Tus datos locales siguen guardados; revisa las revisiones del MCP antes de volver a subirlos.');
        return;
      }
      if (accountUploadPending) {
        setAuthStatus('signed_in');
        return;
      }
      const confirmed = await showConfirm({
        title: '¿Subir la copia local a tu cuenta?',
        message: 'Se enviará a D1 la copia completa: perfil, rutinas, sesiones, medidas y seguimiento. Esa copia no usa cifrado de extremo a extremo. Puedes cancelar y seguir usando Radian solo en este dispositivo.',
        confirmLabel: 'Subir copia',
        danger: false,
      });
      if (!confirmed) {
        setAccountUploadPending(true);
        setAuthStatus('signed_in');
        setAuthError(undefined);
        return;
      }
      const saved = await pushCloudData(localSnapshot);
      acknowledge(localSnapshot, saved.updatedAt, localVersion);
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

  const uploadLocalToAccount = async (): Promise<void> => {
    const user = authUserRef.current;
    if (!user || !online || cloudBusyRef.current) return;
    cloudBusyRef.current = true;
    setAuthStatus('syncing');
    setAuthError(undefined);
    cloudSyncReadyRef.current = false;
    try {
      const remote = await pullCloudData();
      if (remote.data) {
        setCloudConflict(remote);
        setAccountUploadPending(false);
        setAuthStatus('error');
        setAuthError('Ya hay una copia remota. Elige qué copia conservar antes de continuar.');
        return;
      }
      const localSnapshot = dataRef.current;
      const localVersion = buildDataVersion(localSnapshot, dataRevisionRef.current);
      const saved = await pushCloudData(localSnapshot);
      acknowledge(localSnapshot, saved.updatedAt, localVersion);
      cloudSyncReadyRef.current = true;
      setAccountUploadPending(false);
      setAuthStatus('signed_in');
      setToast('Copia local subida a tu cuenta');
    } catch (error: unknown) {
      const value = error instanceof AuthApiError ? error : new AuthApiError('No se pudo subir la copia a D1.', 0);
      if (value.status === 401) {
        clearAuthenticatedState();
        setAuthError(value.message);
        return;
      }
      if (value.status === 409 && value.remote?.data) {
        setCloudConflict(value.remote);
        setAccountUploadPending(false);
      }
      setAuthStatus('error');
      reportAuthError(value, 'No se pudo subir la copia a D1.');
    } finally {
      cloudBusyRef.current = false;
      setSyncAttempt((current) => current + 1);
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
      acknowledge(next, conflict.updatedAt, buildDataVersion(next, dataRevisionRef.current));
      setCloudConflict(undefined);
      setAuthError(undefined);
      cloudSyncReadyRef.current = true;
      setAuthStatus('signed_in');
      setToast('Copia de la nube restaurada');
      return;
    }
    setAuthStatus('syncing');
    try {
      const localVersion = dataVersion;
      const localSnapshot = data;
      const saved = await pushCloudData(localSnapshot, conflict.updatedAt);
      acknowledge(localSnapshot, saved.updatedAt, localVersion);
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
    setAccountUploadPending(false);
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
    if (!await showConfirm({ title: '¿Revocar esta passkey?', message: 'Tendrás que usar otra para volver a entrar.', confirmLabel: 'Revocar', danger: true })) return;
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
    if (!await showConfirm({ title: '¿Cerrar sesión en todos los dispositivos?', message: 'Se cerrará la sesión en los dispositivos conectados.', confirmLabel: 'Cerrar sesión', danger: false })) return;
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
  // Re-subscribing whenever `refreshCloud` changes identity is unnecessary: the
  // handler reads current state through refs and the throttle above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, cloudConflict]);

  const restoreLocalRecovery = async (): Promise<void> => {
    if (!recovery || !await showConfirm({ title: '¿Restaurar esta copia?', message: 'Se guardará la versión actual para poder volver atrás.', confirmLabel: 'Restaurar', danger: false })) return;
    try {
      const next = parseBackup(recovery.backup);
      setRecovery(preserveRecovery(data));
      setData(next);
      setToast('Copia recuperada en este dispositivo');
    } catch { setAuthError('No se pudo restaurar la copia. Comprueba el espacio disponible.'); }
  };

  return {
    online, updateAvailable, storageWarning, setStorageWarning,
    acknowledged, recovery, restoreLocalRecovery,
    syncState, syncStatus, syncError, syncConflict,
    authUser, authStatus, authError, passkeys, cloudUpdatedAt, cloudConflict, accountUploadPending,
    refreshCloud, uploadLocalToAccount, handleRegisterPasskey, handleLoginPasskey,
    handleAddPasskey, handleRenamePasskey, handleRevokePasskey, handleLogout, handleLogoutEverywhere,
    resolveCloudConflict, connectSync, uploadSync, downloadSync, disconnectSync, revokeSync,
    keepLocalSync, useRemoteSync,
  };
}

interface DataSync {
  online: boolean;
  updateAvailable: boolean;
  storageWarning?: string;
  setStorageWarning: (warning?: string) => void;
  acknowledged?: string;
  recovery?: { savedAt: string; backup: string };
  restoreLocalRecovery: () => Promise<void>;
  syncState: SyncState;
  syncStatus: SyncStatus;
  syncError?: string;
  syncConflict?: RemoteSyncData;
  authUser?: AuthUser;
  authStatus: AuthStatus;
  authError?: string;
  passkeys: AuthPasskey[];
  cloudUpdatedAt?: string;
  cloudConflict?: CloudData;
  accountUploadPending: boolean;
  refreshCloud: () => Promise<void>;
  uploadLocalToAccount: () => Promise<void>;
  handleRegisterPasskey: (displayName: string, passkeyLabel: string) => Promise<void>;
  handleLoginPasskey: () => Promise<void>;
  handleAddPasskey: (passkeyLabel: string) => Promise<void>;
  handleRenamePasskey: (credentialId: string, label: string) => Promise<void>;
  handleRevokePasskey: (credentialId: string) => Promise<void>;
  handleLogout: () => Promise<void>;
  handleLogoutEverywhere: () => Promise<void>;
  resolveCloudConflict: (choice: 'local' | 'remote') => Promise<void>;
  connectSync: (input: string) => Promise<void>;
  uploadSync: () => Promise<void>;
  downloadSync: () => Promise<void>;
  disconnectSync: () => void;
  revokeSync: () => Promise<void>;
  keepLocalSync: () => Promise<void>;
  useRemoteSync: () => void;
}
