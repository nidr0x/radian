import { Minus, Pause, Play, Plus, Timer, X } from 'lucide-react';
import { formatDuration } from '../lib/date';
import { useRestCountdown } from './useRestCountdown';

export function RestFloating({ restUntil, restRemaining, exerciseName, paused, onAdjust, onPause, onResume, onClose }: { restUntil: number | null; restRemaining: number; exerciseName?: string; paused: boolean; onAdjust: (seconds: number) => void; onPause: () => void; onResume: () => void; onClose: () => void }) {
  const remaining = useRestCountdown(restUntil, restRemaining);
  if (remaining <= 0) return null;
  return <div className="rest-float">
<Timer size={17} />
<div>
  <strong>{formatDuration(remaining)}</strong>
    <span>{exerciseName ? `Tras ${exerciseName} · ${paused ? 'pausado' : 'en curso'}` : paused ? 'descanso pausado' : 'descanso en curso'}</span>
    </div>
    <div className="rest-controls">
      <button type="button" aria-label="Restar 15 segundos" onClick={() => onAdjust(-15)}>
        <Minus size={14} />
      </button>
      <button type="button" aria-label={paused ? 'Reanudar descanso' : 'Pausar descanso'} onClick={paused ? onResume : onPause}>{paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} />}</button>
        <button type="button" aria-label="Añadir 30 segundos" onClick={() => onAdjust(30)}>
          <Plus size={14} />
        </button>
        <button type="button" aria-label="Cerrar temporizador" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
    </div>;
}
