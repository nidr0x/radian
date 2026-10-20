import { useRef } from 'react';
import { Gauge, X } from 'lucide-react';
import { useFocusTrap } from '../lib/useFocusTrap';
import { formatExerciseSummary } from '../lib/format';
import { ExerciseThumb } from './ExerciseThumb';
import { recommendationFor, progressionAction } from '../lib/recommendations';
import type { ExerciseGuidance, PlannedExercise, ExerciseSession } from '../types';

export function ExerciseDetailSheet({ exercise, muscleGroup, guidance, recommendation, progressionAction: action, lastSession, onClose }: { exercise: PlannedExercise; muscleGroup?: string; guidance?: ExerciseGuidance; recommendation?: ReturnType<typeof recommendationFor>; progressionAction?: ReturnType<typeof progressionAction>; lastSession?: ExerciseSession; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const detail = guidance ?? { setup: 'Ajusta el asiento y la carga para que puedas moverte con control.', cues: ['Mantén una postura estable.', 'Mueve la carga sin impulso.', 'Detén el recorrido si pierdes el control.'], commonMistake: 'Usar más carga de la que permite una ejecución limpia.' };
  const alternatives = detail.alternatives ?? ['Reduce la carga y acorta el recorrido.', 'Prueba una variante que no provoque molestias.', 'Si persiste, anótalo para revisarlo con tu entrenador.'];
  const discomfortAdvice = detail.discomfortAdvice ?? 'Una molestia articular no es una señal para forzar. Para, registra lo que has notado y revisa el ajuste.';
  useFocusTrap(dialogRef, true, onClose);
  return <div className="exercise-detail-backdrop" role="presentation" onMouseDown={onClose}>
<section ref={dialogRef} className="exercise-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="exercise-detail-title" onMouseDown={(event) => event.stopPropagation()}>
  <div className="detail-sheet-topline">
    <p className="eyebrow">referencia de máquina</p>
      <button className="icon-button subtle" type="button" aria-label="Cerrar ficha" onClick={onClose}>
        <X size={19} />
      </button>
    </div>
    <ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} large />
    <h2 id="exercise-detail-title">{exercise.name}</h2>
      <div className="detail-facts">
        <span>{muscleGroup ?? 'Ejercicio'}</span>
          <span>{exercise.sets} series</span>
            <span>{exercise.repMin}-{exercise.repMax} reps</span>
            </div>
            <div className="detail-section">
              <p className="eyebrow">ajuste inicial</p>
                <p>{detail.setup}</p>
                </div>
                <div className="detail-section">
                  <p className="eyebrow">claves de ejecución</p>
                    <ol className="detail-steps">{detail.cues.map((cue) => <li key={cue}>{cue}</li>)}</ol>
                    </div>
                    <div className="detail-warning">
                      <strong>Error habitual</strong>
                        <span>{detail.commonMistake}</span>
                        </div>
                        <div className="detail-section">
                          <p className="eyebrow">si hay molestias</p>
                            <p>{discomfortAdvice}</p>
                              <ul className="detail-alternatives">{alternatives.map((alternative) => <li key={alternative}>{alternative}</li>)}</ul>
                              </div>{lastSession && <p className="detail-history">Último registro: {formatExerciseSummary(lastSession)}</p>}{action && <div className={`detail-action ${action.tone}`}>
                              <strong>{action.title}</strong>
                                <span>{action.detail}</span>
                                </div>}{recommendation && <p className={`detail-recommendation ${recommendation.tone}`}>
                                <Gauge size={15} /> {recommendation.label}: {recommendation.message}</p>}</section>
                                </div>;
}
