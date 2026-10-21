import { useEffect, useRef, useState } from 'react';
import { Clipboard, CloudOff, Download, FileJson, Info, KeyRound, LockKeyhole, Moon, Settings2, ShieldCheck, Sparkles, Sun, UserRound, Upload } from 'lucide-react';
import { equipmentLabel, planEquipmentGaps } from '../lib/exercises';
import { serializeBackup, parseBackup } from '../lib/storage';
import { downloadFile, numberOrUndefined } from '../lib/format';
import { generateSyncKey, normalizeSyncKey } from '../lib/sync';
import { textSizeToggleLabel, themeOptionLabel } from '../lib/accessibility';
import { SyncConflictCard } from '../components/SyncConflictCard';
import { PageHeader } from '../components/PageHeader';
import { NumberField } from '../components/NumberField';
import { DayPicker, EquipmentPicker } from '../components/ProfilePickers';
import { experienceOptions } from '../lib/profileOptions';
import type { AuthUser } from '../lib/auth';
import type { RemoteSyncData, SyncState } from '../lib/sync';
import type { SyncStatus } from '../lib/appStatus';
import type { AppData, ExperienceLevel, Theme } from '../types';

export function ProfileView({ data, authUser, theme, onThemeChange, onUpdateProfile, onRepeatOnboarding, onImport, onConfirmImport, onConfirmEquipment, syncState, syncStatus, syncError, syncConflict, onKeepLocalSync, onUseRemoteSync, onConnectSync, onUploadSync, onDownloadSync, onDisconnectSync, onRevokeSync, onInstall, isInstalled }: { data: AppData; authUser?: AuthUser; theme: Theme; onThemeChange: (theme: Theme) => void; onUpdateProfile: (profile: Partial<AppData['profile']>, adaptEquipmentPlan?: boolean) => void; onRepeatOnboarding: () => void; onImport: (data: AppData) => void; onConfirmImport: () => Promise<boolean>; onConfirmEquipment: (message: string) => Promise<boolean>; syncState: SyncState; syncStatus: SyncStatus; syncError?: string; syncConflict?: RemoteSyncData; onKeepLocalSync: () => void; onUseRemoteSync: () => void; onConnectSync: (key: string) => void; onUploadSync: () => void; onDownloadSync: () => void; onDisconnectSync: () => void; onRevokeSync: () => void; onInstall?: () => void; isInstalled: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [importError, setImportError] = useState<string>();
  const [profile, setProfile] = useState(data.profile);
  const avatarInitial = (data.profile.gym.trim() || authUser?.displayName?.trim() || '').charAt(0).toLocaleUpperCase('es-ES');
  const save = async (): Promise<void> => {
    const equipmentChanged = profile.availableEquipment.join('|') !== data.profile.availableEquipment.join('|');
    const gaps = equipmentChanged ? planEquipmentGaps(data.plan, data.exercises, profile.availableEquipment) : [];
    if (gaps.length > 0) {
      const replaceable = gaps.filter((gap) => gap.replacement).length;
      const withoutReplacement = gaps.length - replaceable;
      const detail = `${replaceable} ${replaceable === 1 ? 'puede sustituirse' : 'pueden sustituirse'} automáticamente${withoutReplacement > 0 ? `; ${withoutReplacement} ${withoutReplacement === 1 ? 'queda' : 'quedan'} para revisar a mano` : ''}`;
      const adapt = await onConfirmEquipment(`Tu material ha cambiado y ${gaps.length} ${gaps.length === 1 ? 'ejercicio ya no encaja' : 'ejercicios ya no encajan'}. ${detail}. ¿Quieres adaptar las sustituciones disponibles para las próximas sesiones?`);
      onUpdateProfile(profile, adapt);
    } else {
      onUpdateProfile(profile);
    }
    setEditing(false);
  };
  const exportData = (): void => downloadFile('radian-backup.json', serializeBackup(data), 'application/json');
  const importData = (event: React.ChangeEvent<HTMLInputElement>): void => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const next = parseBackup(String(reader.result)); setImportError(undefined); void onConfirmImport().then((confirmed) => { if (confirmed) onImport(next); }); } catch (error) { setImportError(error instanceof Error ? error.message : 'No se pudo leer la copia.'); } }; reader.readAsText(file); event.target.value = ''; };
  return <section className="view-section">
<PageHeader eyebrow="tu contexto" title="Perfil" action={<button className="icon-button subtle" aria-label="Editar perfil" onClick={() => setEditing(true)}>
  <Settings2 size={19} />
</button>} />
<section className="profile-hero">
  <div className="profile-avatar">{avatarInitial || <UserRound size={22} />}</div>
    <div>
      <p className="eyebrow light">perfil local</p>
        <h2>Tu punto de partida</h2>
          <p>Solo tú tienes acceso a estos datos.</p>
          </div>
        </section>
        <section className="profile-section">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">base</p>
                <h2>Datos personales</h2>
                </div>
                <button className="text-button" onClick={() => { if (editing) void save(); else setEditing(true); }}>{editing ? 'Guardar' : 'Editar'}</button>
                </div>{editing ? <div className="profile-form">
                <NumberField label="Altura" unit="cm · opcional" value={profile.heightCm?.toString() ?? ''} onChange={(value) => setProfile((current) => ({ ...current, heightCm: numberOrUndefined(value) }))} />
                <NumberField label="Peso actual" unit="kg · opcional" value={profile.currentWeightKg?.toString() ?? ''} onChange={(value) => setProfile((current) => ({ ...current, currentWeightKg: numberOrUndefined(value) }))} />
                <label>Gimnasio<input value={profile.gym} onChange={(event) => setProfile((current) => ({ ...current, gym: event.target.value }))} placeholder="Ej. Evanfit Picanya" />
              </label>
              <label>Objetivo<input value={profile.goal} onChange={(event) => setProfile((current) => ({ ...current, goal: event.target.value }))} />
            </label>
            <div className="days-field">
              <span>Días de entrenamiento</span>
                <span>selecciona los tuyos</span>
                  <DayPicker selected={profile.trainingDays} onChange={(trainingDays) => setProfile((current) => ({ ...current, trainingDays }))} />
                </div>
                <div className="profile-equipment-field">
                  <span>Equipamiento disponible</span>
                    <span>Se usa para filtrar la biblioteca y las sustituciones</span>
                      <EquipmentPicker selected={profile.availableEquipment} onChange={(availableEquipment) => setProfile((current) => ({ ...current, availableEquipment }))} />
                    </div>
                    <label>Duración por sesión<input inputMode="numeric" value={profile.sessionMinutes} onChange={(event) => setProfile((current) => ({ ...current, sessionMinutes: Number(event.target.value) }))} />
                  </label>
                  <label>Nivel<select value={profile.experienceLevel} onChange={(event) => setProfile((current) => ({ ...current, experienceLevel: event.target.value as ExperienceLevel }))}>
                    <option value="beginner">Estoy empezando</option>
                      <option value="intermediate">Ya tengo base</option>
                        <option value="advanced">Tengo experiencia</option>
                        </select>
                      </label>
                    </div> : <div className="profile-facts">
                    <Fact label="Altura" value={profile.heightCm !== undefined ? `${profile.heightCm} cm` : 'Sin registrar'} />
                    <Fact label="Peso actual" value={profile.currentWeightKg !== undefined ? `${profile.currentWeightKg} kg` : 'Sin registrar'} />
                    <Fact label="Objetivo" value={profile.goal || 'Sin definir'} />
                    <Fact label="Gimnasio" value={profile.gym || 'Sin definir'} />
                    <Fact label="Material" value={profile.availableEquipment.map((equipment) => equipmentLabel(equipment)).join(' · ')} />
                    <Fact label="Sesiones" value={`${profile.trainingDays.length} días · ${profile.sessionMinutes} min`} />
                    <Fact label="Nivel" value={experienceOptions.find((option) => option.value === profile.experienceLevel)?.label ?? 'Sin definir'} />
                  </div>}</section>
                  <section className="profile-section">
                    <div className="section-heading compact">
                      <div>
                        <p className="eyebrow">preferencias</p>
                          <h2>Cómo usar Radian</h2>
                          </div>
                        </div>
                        <div className="setting-row">
                          <div>
                            <strong>Apariencia</strong>
                              <span>Se adapta a tu preferencia</span>
                              </div>
                              <div className="theme-switcher" role="group" aria-label="Apariencia">
                                <button type="button" key="system" className={theme === 'system' ? 'selected' : ''} aria-label={themeOptionLabel('system')} aria-pressed={theme === 'system'} onClick={() => onThemeChange('system')}>Auto</button>
                                  <button type="button" key="light" className={theme === 'light' ? 'selected' : ''} aria-label={themeOptionLabel('light')} aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}>
                                    <Sun size={16} aria-hidden="true" />
                                  </button>
                                  <button type="button" key="dark" className={theme === 'dark' ? 'selected' : ''} aria-label={themeOptionLabel('dark')} aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}>
                                    <Moon size={16} aria-hidden="true" />
                                  </button>
                                </div>
                              </div>
                              <div className="setting-row">
                                <div>
                                  <strong>Texto grande</strong>
                                    <span>Mejor lectura en pantalla pequeña</span>
                                    </div>
                                    <button type="button" className={data.profile.largeText ? 'toggle on' : 'toggle'} aria-label={textSizeToggleLabel(data.profile.largeText)} aria-pressed={data.profile.largeText} onClick={() => onUpdateProfile({ largeText: !data.profile.largeText })}>
                                      <span />
                                    </button>
                                  </div>
                                  <div className="setting-row">
                                    <div>
                                      <strong>Datos en este dispositivo</strong>
                                        <span>Sin analítica ni servicios de terceros</span>
                                        </div>
                                        <CloudOff size={19} />
                                      </div>
                                      <div className="setting-row">
                                        <div>
                                          <strong>Configuración inicial</strong>
                                            <span>Puedes cambiar tus datos cuando quieras.</span>
                                            </div>
                                            <button type="button" className="secondary-button small" onClick={onRepeatOnboarding}>
                                              <Sparkles size={15} /> Repetir</button>
                                              </div>{(onInstall || isInstalled) && <div className="setting-row">
                                              <div>
                                                <strong>{isInstalled ? 'Radian está instalada' : 'Instalar Radian'}</strong>
                                                  <span>{isInstalled ? 'Acceso rápido desde tu pantalla de inicio' : 'En iPhone: compartir → Añadir a pantalla de inicio'}</span>
                                                  </div>{isInstalled ? <ShieldCheck size={19} /> : <button type="button" className="secondary-button small" onClick={onInstall}>Instalar</button>}</div>}</section>
                                                  <SyncConflictCard local={data} remote={syncConflict} onKeepLocal={onKeepLocalSync} onUseRemote={onUseRemoteSync} />
                                                  <SyncPanel syncState={syncState} syncStatus={syncStatus} syncError={syncError} onConnect={onConnectSync} onUpload={onUploadSync} onDownload={onDownloadSync} onDisconnect={onDisconnectSync} onRevoke={onRevokeSync} />
                                                  <section className="profile-section">
                                                    <div className="section-heading compact">
                                                      <div>
                                                        <p className="eyebrow">copia de seguridad</p>
                                                          <h2>Tus datos</h2>
                                                          </div>
                                                          <FileJson size={20} />
                                                        </div>
                                                        <p className="section-description">Exporta o restaura todo el contenido de Radian como un archivo JSON. Haz una copia de vez en cuando.</p>
                                                          <div className="backup-actions">
                                                            <button className="secondary-button" onClick={exportData}>
                                                              <Download size={16} /> Exportar datos</button>
                                                                <button className="secondary-button" onClick={() => fileRef.current?.click()}>
                                                                  <Upload size={16} /> Importar datos</button>
                                                                    <input ref={fileRef} type="file" accept="application/json,.json" onChange={importData} hidden />
                                                                  </div>{importError && <p className="error-message" role="alert">{importError}</p>}</section>
                                                                  <section className="profile-section nutrition-section">
                                                                    <div className="section-heading compact">
                                                                      <div>
                                                                        <p className="eyebrow">contexto nutricional</p>
                                                                          <h2>Sin contar calorías</h2>
                                                                          </div>
                                                                          <Info size={19} />
                                                                        </div>
                                                                        <p className="section-description">Este contexto queda guardado para futuras revisiones, pero Radian no te pide registrar comidas.</p>{editing ? <textarea value={profile.nutritionContext} onChange={(event) => setProfile((current) => ({ ...current, nutritionContext: event.target.value }))} rows={5} /> : <p className="nutrition-copy">{profile.nutritionContext || 'Sin contexto guardado.'}</p>}</section>
                                                                        </section>;
}

function SyncPanel({ syncState, syncStatus, syncError, onConnect, onUpload, onDownload, onDisconnect, onRevoke }: { syncState: SyncState; syncStatus: SyncStatus; syncError?: string; onConnect: (key: string) => void; onUpload: () => void; onDownload: () => void; onDisconnect: () => void; onRevoke: () => void }) {
  const [key, setKey] = useState(syncState.key ?? '');
  useEffect(() => setKey(syncState.key ?? ''), [syncState.key]);
  const busy = syncStatus === 'checking' || syncStatus === 'syncing';
  const status = syncStatus === 'remote' ? 'Hay una copia remota pendiente de elegir.' : syncStatus === 'synced' ? 'Sincronizado ahora.' : syncStatus === 'unavailable' ? 'Cloudflare aún no está conectado.' : syncStatus === 'conflict' ? 'Hay cambios distintos en los dos dispositivos.' : syncStatus === 'checking' ? 'Comprobando el código…' : syncStatus === 'syncing' ? 'Sincronizando…' : syncState.key ? 'Código preparado.' : 'Aún no hay ningún dispositivo conectado.';
  const generate = (): void => setKey(generateSyncKey());
  const copy = (): void => { if (key) navigator.clipboard.writeText(key).catch(() => undefined); };
  return <section className="profile-section sync-section">
<div className="section-heading compact">
  <div>
    <p className="eyebrow">opcional · cloudflare</p>
      <h2>Sincronizar dispositivos</h2>
      </div>
      <LockKeyhole size={20} />
    </div>
    <p className="section-description">Empareja el móvil y el ordenador con un código. El modo local sigue funcionando si no configuras la nube.</p>
      <div className="sync-code-field">
        <label>Código de sincronización<input value={key} onChange={(event) => setKey(normalizeSyncKey(event.target.value))} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" spellCheck={false} />
      </label>{key && <button className="icon-button" type="button" onClick={copy} aria-label="Copiar código">
      <Clipboard size={16} />
    </button>}</div>
    <div className="backup-actions">
      <button className="secondary-button" type="button" onClick={generate}>
        <KeyRound size={15} /> Generar código</button>
          <button className="primary-button small" type="button" onClick={() => onConnect(key)} disabled={busy || !key}>Conectar</button>
          </div>{syncState.key && <div className="sync-actions">
          <button className="secondary-button small" type="button" onClick={onDownload} disabled={busy}>Descargar nube</button>
            <button className="secondary-button small" type="button" onClick={onUpload} disabled={busy}>Subir local</button>
              <button className="text-button" type="button" onClick={onDisconnect}>Desconectar</button>
                <button className="text-button danger-text" type="button" onClick={onRevoke}>Revocar código</button>
                </div>}<p className="sync-status" role="status">{status}</p>{syncState.remoteUpdatedAt && <p className="sync-last-updated">Última versión confirmada: {new Date(syncState.remoteUpdatedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</p>}{syncError && <p className="error-message" role="alert">{syncError}</p>}<p className="sync-security">
                <LockKeyhole size={13} /> La copia se cifra en el dispositivo antes de subirla. Revoca el código si cambias de móvil.</p>
                </section>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="fact"><span>{label}</span><strong>{value}</strong></div>; }
