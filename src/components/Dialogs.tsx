import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useFocusTrap } from '../lib/useFocusTrap';

export function SessionExitDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true, onCancel);
  return <div className="session-exit-backdrop" role="presentation" onMouseDown={onCancel}>
<section ref={dialogRef} className="session-exit-dialog" role="dialog" aria-modal="true" aria-labelledby="session-exit-title" onMouseDown={(event) => event.stopPropagation()}>
  <div className="session-exit-heading">
    <p className="eyebrow">salir de la sesión</p>
      <button className="icon-button subtle" type="button" aria-label="Cerrar aviso" onClick={onCancel}>
        <X size={18} />
      </button>
    </div>
    <h2 id="session-exit-title">¿Pausar aquí?</h2>
      <p>Tu progreso se ha guardado en este dispositivo. Podrás continuar desde Hoy cuando quieras.</p>
        <div className="session-exit-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>Seguir entrenando</button>
            <button className="primary-button" type="button" onClick={onConfirm}>Pausar y salir</button>
            </div>
          </section>
        </div>;
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false, onConfirm, onCancel }: { title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true, onCancel);
  const content = <div className="session-exit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
<section ref={dialogRef} className="session-exit-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" onMouseDown={(event) => event.stopPropagation()}>
  <h2 id="confirm-dialog-title">{title}</h2>
    <p id="confirm-dialog-message">{message}</p>
      <div className="session-exit-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>Cancelar</button>
          <button className={danger ? 'primary-button danger-button' : 'primary-button'} type="button" onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </section>
      </div>;
  return createPortal(content, document.body);
}

export function RestEndedOverlay({ nextExerciseName, onDismiss }: { nextExerciseName?: string; onDismiss: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true, onDismiss);
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 10_000);
    return () => { window.clearTimeout(timer); };
  }, [onDismiss]);
  const content = <div className="rest-ended-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}>
<section ref={dialogRef} className="rest-ended-dialog" role="dialog" aria-modal="true" aria-labelledby="rest-ended-title" onMouseDown={(event) => event.stopPropagation()}>
  <Check className="rest-ended-check" size={52} aria-hidden="true" />
  <p className="eyebrow">temporizador</p>
    <h2 id="rest-ended-title">¡Descanso terminado!</h2>
      <p>{nextExerciseName ? `Siguiente: ${nextExerciseName}` : 'Cuando quieras, puedes continuar.'}</p>
        <button className="primary-button" type="button" onClick={onDismiss}>Continuar</button>
        </section>
      </div>;
  return createPortal(content, document.body);
}
