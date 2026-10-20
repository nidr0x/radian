import { ChevronRight, Layers3, Timer } from 'lucide-react';
import { formatDuration } from '../lib/date';
import { ExerciseThumb } from './ExerciseThumb';
import type { PlannedExercise } from '../types';

export function ExercisePreview({ exercise, index, muscleGroup, onOpenDetails }: { exercise: PlannedExercise; index: number; muscleGroup?: string; onOpenDetails: () => void }) {
  return <button type="button" className="exercise-card preview-card" aria-label={`Abrir detalles de ${exercise.name}`} onClick={onOpenDetails}>
    <div className="exercise-index">{String(index + 1).padStart(2, '0')}</div>
    <ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} />
    <div className="exercise-main">
      <div className="exercise-preview-heading">
        <strong className="exercise-preview-name">{exercise.name}</strong>
      </div>
      <div className="exercise-meta" aria-label="Detalles del ejercicio"><span className="exercise-muscle-pill"><span className="exercise-muscle-dot" aria-hidden="true" />{muscleGroup ?? 'Ejercicio'}</span><span className="exercise-meta-value"><Layers3 size={15} aria-hidden="true" /> {exercise.sets} series</span><span className="exercise-meta-separator" aria-hidden="true">·</span><span className="exercise-meta-value">{exercise.repMin}–{exercise.repMax} reps</span><span className="exercise-meta-separator" aria-hidden="true">·</span><span className="exercise-meta-value"><Timer size={15} aria-hidden="true" /> {formatDuration(exercise.restSeconds)}</span></div>
    </div>
    <ChevronRight className="exercise-card-chevron" size={23} aria-hidden="true" />
  </button>;
}
