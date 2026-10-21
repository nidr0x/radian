import type { Difficulty, ExerciseSession } from '../types';
import { isWorkSet } from './progression';

export const difficultyOptions: Array<{ value: Difficulty; label: string; hint: string }> = [
  { value: 'easy', label: 'Fácil', hint: 'Había margen' }, { value: 'good', label: 'Bien', hint: 'En su punto' },
  { value: 'hard', label: 'Difícil', hint: 'Costó bastante' }, { value: 'incomplete', label: 'No pude', hint: 'No completado' },
];

export const formatWeight = (value?: number): string => value === undefined ? 'Sin registro' : `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} kg`;
export const formatSessionDuration = (seconds: number): string => {
  if (seconds < 60) return '<1 min';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

export function formatVolume(value: number): string {
  if (value >= 1000) return `${(value / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}k kg`;
  return `${Math.round(value).toLocaleString('es-ES')} kg`;
}

export function displayWorkoutName(name: string): string { return name.replace(/\s*[·•]\s*/g, ', '); }

export function numberOrUndefined(value: string): number | undefined { if (!value.trim()) return undefined; const number = Number(value); return Number.isFinite(number) ? number : undefined; }

export function formatExerciseSummary(session: ExerciseSession): string { const completedSets = session.setLogs?.filter((set) => isWorkSet(set) && set.completed) ?? []; const lastSet = completedSets[completedSets.length - 1]; if (lastSet?.weightKg !== undefined && lastSet.actualReps !== undefined) return `${lastSet.weightKg.toLocaleString('es-ES', { maximumFractionDigits: 1 })} kg · ${lastSet.actualReps} reps`; if (session.actualWeightKg !== undefined && session.actualReps !== undefined) return `${session.actualWeightKg.toLocaleString('es-ES', { maximumFractionDigits: 1 })} kg · ${session.actualReps} reps`; return difficultyLabel(session.difficulty ?? 'good'); }

export function clampNumber(value: string, min: number, max: number): number { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min; }

export function changeLabel(current?: number, previous?: number, suffix = ' kg'): string { if (current === undefined || previous === undefined) return 'sin comparación'; const difference = current - previous; if (difference === 0) return 'estable'; return `${difference > 0 ? '+' : ''}${difference.toLocaleString('es-ES', { maximumFractionDigits: 1 })}${suffix}`; }

export function difficultyLabel(value: Difficulty): string { return difficultyOptions.find((option) => option.value === value)?.label ?? value; }

export function downloadFile(filename: string, contents: string, type: string): void { const blob = new Blob([contents], { type }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
