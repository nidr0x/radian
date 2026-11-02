import type { PlannedExercise, SessionReadiness } from '../types';

export interface SessionAdaptation {
  mode: 'normal' | 'reduced' | 'recovery';
  label: string;
  detail: string;
  setsReduction: number;
  restIncreaseSeconds: number;
  useLowerRepTarget: boolean;
}

export const sessionAdaptation = (readiness?: SessionReadiness): SessionAdaptation => {
  if (!readiness || (readiness.energy === 'normal' && readiness.soreness === 'none')) {
    return { mode: 'normal', label: 'Sesión normal', detail: 'Sigo la programación prevista.', setsReduction: 0, restIncreaseSeconds: 0, useLowerRepTarget: false };
  }

  const recovery = readiness.soreness === 'high' || (readiness.energy === 'low' && readiness.soreness !== 'none');
  if (recovery) {
    return {
      mode: 'recovery',
      label: 'Sesión de recuperación',
      detail: readiness.soreness === 'high' ? 'Sesión de recuperación: hay molestias altas; una serie menos, rango bajo y más descanso.' : 'Sesión de recuperación: la energía está baja y hay molestias; reduce el volumen y prioriza el control.',
      setsReduction: 1,
      restIncreaseSeconds: 60,
      useLowerRepTarget: true,
    };
  }

  return {
    mode: 'reduced',
    label: 'Sesión ajustada',
    detail: readiness.energy === 'low' ? 'La energía está baja: una serie menos y más descanso.' : 'Hay algo de molestia: reduce una serie y cuida el recorrido.',
    setsReduction: 1,
    restIncreaseSeconds: 30,
    useLowerRepTarget: false,
  };
};

export const adaptPlannedExercise = (exercise: PlannedExercise, adaptation: SessionAdaptation): PlannedExercise => {
  if (adaptation.mode === 'normal') return exercise;
  return {
    ...exercise,
    sets: Math.max(1, exercise.sets - adaptation.setsReduction),
    repMax: adaptation.useLowerRepTarget ? exercise.repMin : exercise.repMax,
    restSeconds: exercise.restSeconds + adaptation.restIncreaseSeconds,
  };
};
