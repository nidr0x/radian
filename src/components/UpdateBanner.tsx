import { ChevronRight, RotateCcw, Timer } from 'lucide-react';
import type { UpdateActionCopy } from '../lib/uiCopy';

interface UpdateBannerProps {
  updateCopy: UpdateActionCopy;
  hasActiveSession: boolean;
  storageWarning: boolean;
  syncing: boolean;
  onApply: () => void;
}

/** Update banner from the App shell, extracted verbatim from App.tsx. */
export function UpdateBanner({ updateCopy, hasActiveSession, storageWarning, syncing, onApply }: UpdateBannerProps) {
  return (
    <section className="update-banner" role="status">
      <div className="update-mark"><RotateCcw size={22} aria-hidden="true" /></div>
      <div className="update-copy">
        <strong>Hay una actualización disponible</strong>
        <p>{hasActiveSession ? 'Puedes actualizar al terminar el entrenamiento.' : 'Tus datos guardados se conservarán al actualizar.'}</p>
      </div>
      {updateCopy.available ? (
        <button className="primary-button update-button" disabled={storageWarning || syncing} onClick={onApply}>
          {updateCopy.label}
          <ChevronRight size={19} />
        </button>
      ) : (
        <span className="update-locked"><Timer size={15} aria-hidden="true" />{updateCopy.label}</span>
      )}
    </section>
  );
}
