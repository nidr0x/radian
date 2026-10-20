import { adaptPlanToEquipment } from '../lib/exercises';
import { dateKey, normalizeTrainingDays, weekKey } from '../lib/date';
import type { ExerciseDefinition, ProgressEntry, WeeklyCheckin, WorkoutDay, UserProfile, AppData } from '../types';

type UpdateData = (updater: (current: AppData) => AppData) => void;
type SetToast = (toast?: string) => void;

/** Routine, progress-entry and onboarding mutations, extracted verbatim from App.tsx. */
export function useRoutineActions(data: AppData, updateData: UpdateData, setToast: SetToast): RoutineActions {

  const updateRoutineDay = (dayId: string, updater: (day: WorkoutDay) => WorkoutDay): void => {
    updateData((current) => ({ ...current, plan: { ...current.plan, version: current.plan.version + 1, days: current.plan.days.map((day) => day.id === dayId ? updater(day) : day) } }));
  };

  const addRoutineExercise = (dayId: string, definition: ExerciseDefinition): void => {
    updateRoutineDay(dayId, (day) => ({
      ...day,
      exercises: [...day.exercises, {
        id: `${dayId}-${definition.id}-${Date.now()}`,
        exerciseId: definition.id,
        name: definition.name,
        sets: 3,
        repMin: 8,
        repMax: 12,
        restSeconds: 90,
        active: true,
        warmupSets: 0,
        progressionPolicy: 'double',
        progressionIncrementKg: 2.5,
        imageUrl: definition.imageUrl,
        imagePosition: definition.imagePosition,
      }],
    }));
    setToast(`${definition.name} añadido a la rutina`);
  };

  const removeRoutineExercise = (dayId: string, exerciseId: string): void => {
    const day = data.plan.days.find((item) => item.id === dayId);
    const exercise = day?.exercises.find((item) => item.id === exerciseId);
    if (!day || !exercise) return;
    updateRoutineDay(dayId, (current) => ({ ...current, exercises: current.exercises.filter((item) => item.id !== exerciseId) }));
    setToast('Ejercicio quitado de la rutina');
  };

  const addProgress = (entry: Omit<ProgressEntry, 'id' | 'date'>): void => {
    updateData((current) => {
      const nextEntry = { ...entry, id: `progress-${Date.now()}`, date: dateKey() };
      return { ...current, progress: [...current.progress, nextEntry], profile: entry.weightKg === undefined ? current.profile : { ...current.profile, currentWeightKg: entry.weightKg } };
    });
    setToast('Medida guardada');
  };

  const addCheckin = (checkin: Omit<WeeklyCheckin, 'id' | 'createdAt' | 'weekKey'>): void => {
    updateData((current) => ({ ...current, checkins: [...current.checkins.filter((item) => item.weekKey !== weekKey()), { ...checkin, id: `checkin-${Date.now()}`, createdAt: new Date().toISOString(), weekKey: weekKey() }] }));
    setToast('Check-in guardado');
  };

  const completeOnboarding = (profile: Partial<UserProfile>): void => {
    updateData((current) => {
      const nextProfile = { ...current.profile, ...profile, trainingDays: normalizeTrainingDays(profile.trainingDays ?? current.profile.trainingDays).slice(0, current.plan.days.length) };
      return {
        ...current,
        onboardingComplete: true,
        profile: nextProfile,
        plan: current.sessions.length === 0 ? adaptPlanToEquipment(current.plan, current.exercises, nextProfile.availableEquipment) : current.plan,
      };
    });
    setToast('Perfil inicial guardado');
  };

  const updateProfile = (profile: Partial<UserProfile>, adaptEquipmentPlan = false): void => {
    updateData((current) => ({
      ...current,
      profile: { ...current.profile, ...profile },
      plan: adaptEquipmentPlan
        ? adaptPlanToEquipment(current.plan, current.exercises, profile.availableEquipment ?? current.profile.availableEquipment)
        : current.plan,
    }));
  };

  return { updateRoutineDay, addRoutineExercise, removeRoutineExercise, addProgress, addCheckin, completeOnboarding, updateProfile };
}

interface RoutineActions {
  updateRoutineDay: (dayId: string, updater: (day: WorkoutDay) => WorkoutDay) => void;
  addRoutineExercise: (dayId: string, definition: ExerciseDefinition) => void;
  removeRoutineExercise: (dayId: string, exerciseId: string) => void;
  addProgress: (entry: Omit<ProgressEntry, 'id' | 'date'>) => void;
  addCheckin: (checkin: Omit<WeeklyCheckin, 'id' | 'createdAt' | 'weekKey'>) => void;
  completeOnboarding: (profile: Partial<UserProfile>) => void;
  updateProfile: (profile: Partial<UserProfile>, adaptEquipmentPlan?: boolean) => void;
}
