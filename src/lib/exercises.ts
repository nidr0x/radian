import type { ExerciseDefinition, ExerciseEquipment, WorkoutPlan } from '../types';

export const equipmentLabels: Record<ExerciseEquipment, string> = {
  machine: 'Máquina',
  cable: 'Polea',
  dumbbell: 'Mancuernas',
  barbell: 'Barra',
  bodyweight: 'Peso corporal',
};

export const allExerciseEquipment: ExerciseEquipment[] = ['machine', 'cable', 'dumbbell', 'barbell', 'bodyweight'];

export const equipmentLabel = (equipment: ExerciseEquipment): string => equipmentLabels[equipment] ?? equipment;

const normalized = (value: string): string => value.toLocaleLowerCase('es-ES').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export const exerciseMatches = (exercise: ExerciseDefinition, query: string, muscleGroup: string, equipment: string): boolean => {
  const searchable = normalized([exercise.name, exercise.muscleGroup, equipmentLabel(exercise.equipment), ...(exercise.aliases ?? [])].join(' '));
  return (!query || searchable.includes(normalized(query)))
    && (!muscleGroup || exercise.muscleGroup === muscleGroup)
    && (!equipment || exercise.equipment === equipment);
};

export const compatibleAlternatives = (exercises: ExerciseDefinition[], exerciseId: string, availableEquipment?: ExerciseEquipment[]): ExerciseDefinition[] => {
  const current = exercises.find((exercise) => exercise.id === exerciseId);
  if (!current) return [];
  return exercises
    .filter((exercise) => exercise.id !== exerciseId && exercise.muscleGroup === current.muscleGroup && (!availableEquipment || availableEquipment.includes(exercise.equipment)))
    .sort((a, b) => Number(b.equipment === current.equipment) - Number(a.equipment === current.equipment) || a.name.localeCompare(b.name, 'es'))
    .slice(0, 4);
};

export const adaptPlanToEquipment = (plan: WorkoutPlan, exercises: ExerciseDefinition[], availableEquipment: ExerciseEquipment[]): WorkoutPlan => ({
  ...plan,
  days: plan.days.map((day) => ({
    ...day,
    exercises: day.exercises.map((planned) => {
      const current = exercises.find((exercise) => exercise.id === planned.exerciseId);
      if (!current || availableEquipment.includes(current.equipment)) return planned;
      const replacement = compatibleAlternatives(exercises, current.id, availableEquipment)[0];
      return replacement
        ? { ...planned, exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition }
        : planned;
    }),
  })),
});
