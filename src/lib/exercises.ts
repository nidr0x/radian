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

export interface PlanEquipmentGap {
  dayId: string;
  dayName: string;
  exerciseId: string;
  exerciseName: string;
  equipment: ExerciseEquipment;
  replacement?: ExerciseDefinition;
}

const replacementFor = (exercises: ExerciseDefinition[], exerciseId: string, availableEquipment: ExerciseEquipment[], usedExerciseIds: Set<string>): ExerciseDefinition | undefined => compatibleAlternatives(exercises, exerciseId, availableEquipment).find((exercise) => !usedExerciseIds.has(exercise.id));

export const planEquipmentGaps = (plan: WorkoutPlan, exercises: ExerciseDefinition[], availableEquipment: ExerciseEquipment[]): PlanEquipmentGap[] => plan.days.flatMap((day) => {
  const usedExerciseIds = new Set(day.exercises.filter((planned) => planned.active).map((planned) => planned.exerciseId));
  return day.exercises.flatMap((planned) => {
    const current = exercises.find((exercise) => exercise.id === planned.exerciseId);
    if (!current || availableEquipment.includes(current.equipment)) return [];
    usedExerciseIds.delete(planned.exerciseId);
    const replacement = replacementFor(exercises, current.id, availableEquipment, usedExerciseIds);
    if (replacement) usedExerciseIds.add(replacement.id);
    return [{
      dayId: day.id,
      dayName: day.name,
      exerciseId: current.id,
      exerciseName: current.name,
      equipment: current.equipment,
      replacement,
    }];
  });
});

export const adaptPlanToEquipment = (plan: WorkoutPlan, exercises: ExerciseDefinition[], availableEquipment: ExerciseEquipment[]): WorkoutPlan => ({
  ...plan,
  days: plan.days.map((day) => {
    const usedExerciseIds = new Set(day.exercises.filter((planned) => planned.active).map((planned) => planned.exerciseId));
    return {
      ...day,
      exercises: day.exercises.map((planned) => {
        const current = exercises.find((exercise) => exercise.id === planned.exerciseId);
        if (!current || availableEquipment.includes(current.equipment)) return planned;
        usedExerciseIds.delete(planned.exerciseId);
        const replacement = replacementFor(exercises, current.id, availableEquipment, usedExerciseIds);
        if (!replacement) return planned;
        usedExerciseIds.add(replacement.id);
        return { ...planned, exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition };
      }),
    };
  }),
});
