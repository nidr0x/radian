import { useState } from 'react';
import { Fingerprint, LockKeyhole, LogIn, LogOut, Pencil, Save, Trash2, UserPlus } from 'lucide-react';
import type { AuthPasskey, AuthUser } from '../lib/auth';
import { AuthStatus } from '../lib/appStatus';

export function AccountPanel({ user, passkeys, status, error, cloudUpdatedAt, uploadPending, uploadDisabled, onUploadLocal, onRegister, onLogin, onAddPasskey, onRenamePasskey, onRevokePasskey, onLogout, onLogoutEverywhere }: { user?: AuthUser; passkeys: AuthPasskey[]; status: AuthStatus; error?: string; cloudUpdatedAt?: string; uploadPending: boolean; uploadDisabled: boolean; onUploadLocal: () => void; onRegister: (displayName: string, passkeyLabel: string) => void; onLogin: () => void; onAddPasskey: (passkeyLabel: string) => void; onRenamePasskey: (credentialId: string, label: string) => void; onRevokePasskey: (credentialId: string) => void; onLogout: () => void; onLogoutEverywhere: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [passkeyLabel, setPasskeyLabel] = useState('Passkey principal');
  const [editingId, setEditingId] = useState<string>();
  const [editingLabel, setEditingLabel] = useState('');
  const busy = status === 'checking' || status === 'registering' || status === 'signing_in' || status === 'syncing';
  const statusCopy = status === 'checking' ? 'Comprobando tu cuenta…' : status === 'registering' ? 'Preparando tu passkey…' : status === 'signing_in' ? 'Esperando la confirmación…' : status === 'syncing' ? 'Sincronizando con D1…' : user ? cloudUpdatedAt ? `Sincronizado ${new Date(cloudUpdatedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}` : 'Cuenta conectada' : 'Sin cuenta en la nube';
  const beginEdit = (passkey: AuthPasskey): void => { setEditingId(passkey.credentialId); setEditingLabel(passkey.label); };
  const saveEdit = (): void => { if (editingId && editingLabel.trim()) onRenamePasskey(editingId, editingLabel.trim()); setEditingId(undefined); };
  return <section className="profile-section account-section">
<div className="section-heading compact">
  <div>
    <p className="eyebrow">cuenta · opcional</p>
      <h2>{user ? 'Tu cuenta Radian' : 'Sincroniza con passkey'}</h2>
      </div>
      <Fingerprint size={21} />
    </div>{user ? <>
    <div className="account-identity">
      <span className="account-avatar">
        <Fingerprint size={19} />
      </span>
      <div>
        <strong>{user.displayName}</strong>
          <span>{statusCopy}</span>
          </div>
        </div>
        <p className="section-description">La copia de tu cuenta incluye el perfil completo, rutinas, sesiones y métricas, y se almacena en D1 sin cifrado de extremo a extremo. En este dispositivo, Radian sigue disponible sin conexión.</p>{uploadPending && <div className="account-upload-pending" role="status">
          <p>Tu copia local sigue solo en este dispositivo. Sube los datos cuando quieras activar la copia de la cuenta.</p>
            <button className="primary-button small" type="button" onClick={onUploadLocal} disabled={busy || uploadDisabled}>Subir copia local a la cuenta</button>
            </div>}<label className="account-name-field">Nombre de la nueva passkey<input value={passkeyLabel} onChange={(event) => setPasskeyLabel(event.target.value)} placeholder="Ej. iPhone" />
          </label>
          <div className="account-actions">
            <button className="primary-button small" type="button" onClick={() => onAddPasskey(passkeyLabel.trim() || 'Passkey')} disabled={busy}>
              <Fingerprint size={15} /> Añadir passkey</button>
                <button className="secondary-button small" type="button" onClick={onLogout}>
                  <LogOut size={15} /> Cerrar sesión</button>
                    <button className="text-button danger-text" type="button" onClick={onLogoutEverywhere}>Cerrar en todos</button>
                    </div>
                    <div className="passkey-list">
                      <div className="passkey-list-heading">
                        <strong>Tus dispositivos</strong>
                          <span>{passkeys.length} passkey{passkeys.length === 1 ? '' : 's'}</span>
                          </div>{passkeys.map((passkey) => <div className="passkey-row" key={passkey.credentialId}>{editingId === passkey.credentialId ? <input value={editingLabel} onChange={(event) => setEditingLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveEdit(); if (event.key === 'Escape') setEditingId(undefined); }} autoFocus /> : <div>
                          <strong>{passkey.label}</strong>
                            <span>{passkey.lastUsedAt ? `Usada ${new Date(passkey.lastUsedAt).toLocaleDateString('es-ES')}` : `Añadida ${new Date(passkey.createdAt).toLocaleDateString('es-ES')}`}</span>
                            </div>}<div className="passkey-row-actions">{editingId === passkey.credentialId ? <button type="button" aria-label="Guardar nombre" onClick={saveEdit}>
                            <Save size={15} />
                          </button> : <button type="button" aria-label={`Renombrar ${passkey.label}`} onClick={() => beginEdit(passkey)}>
                          <Pencil size={15} />
                        </button>}<button type="button" aria-label={`Revocar ${passkey.label}`} onClick={() => onRevokePasskey(passkey.credentialId)} disabled={passkeys.length <= 1}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>)}</div>
                </> : <>
                <p className="section-description">Usa la huella, Face ID, PIN o el gestor de contraseñas del dispositivo. No necesitas crear ni recordar una contraseña.</p>
                  <label className="account-name-field">Nombre para tu perfil<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Ej. Carlos" autoComplete="name" />
                </label>
                <label className="account-name-field">Nombre de la passkey<input value={passkeyLabel} onChange={(event) => setPasskeyLabel(event.target.value)} placeholder="Ej. iPhone" />
              </label>
              <div className="account-actions">
                <button className="primary-button small" type="button" onClick={() => onRegister(displayName.trim(), passkeyLabel.trim() || 'Passkey principal')} disabled={busy || !displayName.trim()}>
                  <UserPlus size={15} /> Crear con passkey</button>
                    <button className="secondary-button small" type="button" onClick={onLogin} disabled={busy}>
                      <LogIn size={15} /> Entrar</button>
                      </div>
                      <p className="account-status" role="status">{statusCopy}</p>
                      </>}{error && <p className="error-message" role="alert">{error}</p>}<p className="sync-security">
                      <LockKeyhole size={13} /> La passkey nunca sale del dispositivo. Radian guarda la clave pública necesaria para verificarla.</p>
                      </section>;
}
