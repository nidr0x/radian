import { Play } from 'lucide-react';
import type { WorkoutSession } from '../types';

export function ResumeSessionBanner({ session, onResume }: { session: WorkoutSession; onResume: () => void }) {
  const exercise = session.plannedExercises[session.activeExerciseIndex];
  const completed = session.plannedExercises.filter((item) => item.completed).length;
  return <section className="resume-banner" aria-label="Sesión pendiente"><div><p className="eyebrow">sesión pendiente</p><strong>Continúa {exercise?.name ?? 'tu sesión'}</strong><span>{completed} de {session.plannedExercises.length} ejercicios · guardado en este dispositivo</span></div><button className="primary-button small" type="button" onClick={onResume}><Play size={15} fill="currentColor" /> Continuar</button></section>;
}
