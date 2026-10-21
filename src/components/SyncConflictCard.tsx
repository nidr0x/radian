import { compareSyncCopies } from '../lib/sync';
import type { AppData } from '../types';
import type { RemoteSyncData } from '../lib/sync';

export function SyncConflictCard({ local, remote, remoteLabel = 'Copia remota', intro = 'No se ha sobrescrito nada. Compara el resumen y toma una decisión explícita.', onKeepLocal, onUseRemote }: { local: AppData; remote?: RemoteSyncData; remoteLabel?: string; intro?: string; onKeepLocal: () => void; onUseRemote: () => void }) {
  if (!remote?.data) return null;
  const comparison = compareSyncCopies(local, remote.data);
  const formatCopyDate = (value?: string): string => value ? new Date(`${value}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : 'sin registro';
  const copySummary = (summary: ReturnType<typeof compareSyncCopies>['local']): string => `${summary.sessionCount} sesiones · ${summary.progressCount} medidas · ${summary.checkinCount} check-ins`;
  const changedAreas = [comparison.changed.profile && 'perfil', comparison.changed.routine && 'rutina', comparison.changed.sessions && 'sesiones', comparison.changed.progress && 'medidas', comparison.changed.checkins && 'check-ins'].filter((value): value is string => Boolean(value));
  return <section className="sync-conflict" role="alert" aria-label="Conflicto de sincronización">
<strong>Elige qué copia conservar</strong>
  <span>{intro}</span>
    <div className="sync-copy-comparison">
      <div>
        <small>Este dispositivo</small>
          <strong>{copySummary(comparison.local)}</strong>
            <span>Última sesión: {formatCopyDate(comparison.local.latestSessionDate)}</span>
            </div>
            <div>
              <small>{remoteLabel}</small>
                <strong>{copySummary(comparison.remote)}</strong>
                  <span>Última sesión: {formatCopyDate(comparison.remote.latestSessionDate)}</span>
                  </div>
                </div>{changedAreas.length > 0 && <p className="sync-conflict-differences">Diferencias detectadas: {changedAreas.join(', ')}.</p>}<div className="sync-conflict-actions">
                <button className="secondary-button small" type="button" onClick={onUseRemote}>Usar {remoteLabel.toLowerCase()}</button>
                  <button className="primary-button small" type="button" onClick={onKeepLocal}>Conservar este dispositivo</button>
                  </div>
                </section>;
}
