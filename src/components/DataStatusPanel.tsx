import { dataStateCopy } from '../lib/uiCopy';
import { downloadFile } from '../lib/format';

interface DataStatusPanelProps {
  accountUploadPending: boolean;
  pendingChanges: boolean;
  authenticated: boolean;
  busy: boolean;
  hasCloudConflict: boolean;
  codeConnected: boolean;
  online: boolean;
  cloudUpdatedAt?: string;
  recovery?: { savedAt: string; backup: string };
  onRefresh: () => void;
  onRestore: () => Promise<void>;
}

/** Data status section of the profile view (rendered by the shell), extracted verbatim from App.tsx. */
export function DataStatusPanel({ accountUploadPending, pendingChanges, authenticated, busy, hasCloudConflict, codeConnected, online, cloudUpdatedAt, recovery, onRefresh, onRestore }: DataStatusPanelProps) {
  return (
    <section className="profile-section data-status-section">
      <div className="section-heading compact">
        <div><p className="eyebrow">datos</p><h2>Estado de tus datos</h2></div>
        <span className="data-state-pill">{accountUploadPending ? 'Solo este dispositivo · pendiente de subir' : dataStateCopy({ authenticated, pendingChanges, cloudConflict: hasCloudConflict, codeConnected })}</span>
      </div>
      <p>{accountUploadPending ? 'La cuenta está conectada, pero la copia local todavía no se ha enviado.' : authenticated ? pendingChanges ? 'Hay cambios locales pendientes de sincronizar.' : 'Tu copia local coincide con la última sincronización.' : 'Los datos están guardados en este dispositivo.'}</p>
      <p>{cloudUpdatedAt ? `Última versión sincronizada: ${new Date(cloudUpdatedAt).toLocaleString('es-ES')}` : 'Todavía no se ha confirmado una sincronización en esta sesión.'}</p>
      <button className="secondary-button small" disabled={!online || busy} onClick={onRefresh}>Comprobar sincronización</button>
      {recovery && (
        <div>
          <p>Copia anterior conservada: {new Date(recovery.savedAt).toLocaleString('es-ES')}</p>
          <button className="secondary-button small" disabled={busy} onClick={() => void onRestore()}>Restaurar copia anterior</button>
          <button className="text-button" onClick={() => downloadFile('radian-recovery.json', recovery.backup, 'application/json')}>Exportar copia anterior</button>
        </div>
      )}
    </section>
  );
}
