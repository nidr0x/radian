export type Difficulty = 'easy' | 'good' | 'hard' | 'incomplete';
export type Energy = 'low' | 'normal' | 'high';
export type Soreness = 'none' | 'some' | 'high';
export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced';
export type Theme = 'system' | 'light' | 'dark';
export type View = 'today' | 'routine' | 'progress' | 'profile';
export type ProgressionPolicy = 'off' | 'double' | 'linear';
export type SetPhase = 'warmup' | 'work';
export type ExerciseEquipment = 'machine' | 'cable' | 'dumbbell' | 'barbell' | 'bodyweight';

export interface UserProfile {
  heightCm?: number;
  currentWeightKg?: number;
  goal: string;
  gym: string;
  trainingDays: number[];
  sessionMinutes: number;
  experienceLevel: ExperienceLevel;
  availableEquipment: ExerciseEquipment[];
  largeText: boolean;
  nutritionContext: string;
  theme: Theme;
}

export interface ExerciseDefinition {
  id: string;
  name: string;
  muscleGroup: string;
  equipment: ExerciseEquipment;
  aliases?: string[];
  imageUrl?: string;
  imagePosition?: string;
}

export interface ExerciseGuidance {
  setup: string;
  cues: string[];
  commonMistake: string;
  alternatives?: string[];
  discomfortAdvice?: string;
}

export interface SetLog {
  setNumber: number;
  phase?: SetPhase;
  targetReps: number;
  actualReps?: number;
  weightKg?: number;
  completed: boolean;
}

export interface PlannedExercise {
  id: string;
  exerciseId: string;
  name: string;
  sets: number;
  repMin: number;
  repMax: number;
  restSeconds: number;
  active: boolean;
  warmupSets?: number;
  progressionPolicy?: ProgressionPolicy;
  progressionIncrementKg?: number;
  imageUrl?: string;
  imagePosition?: string;
}

export interface WorkoutDay {
  id: string;
  weekday: number;
  shortLabel: string;
  name: string;
  focus: string;
  exercises: PlannedExercise[];
}

export interface WorkoutPlan {
  id: string;
  version: number;
  days: WorkoutDay[];
}

export interface ExerciseSession {
  plannedExerciseId: string;
  exerciseId: string;
  name: string;
  sets: number;
  repMin: number;
  repMax: number;
  restSeconds: number;
  warmupSets: number;
  progressionPolicy: ProgressionPolicy;
  progressionIncrementKg: number;
  progressionStatus?: 'start' | 'hold' | 'up' | 'rep' | 'deload' | 'blocked' | 'off';
  progressionReason?: string;
  imageUrl?: string;
  imagePosition?: string;
  completed: boolean;
  setLogs: SetLog[];
  difficulty?: Difficulty;
  actualWeightKg?: number;
  actualReps?: number;
  discomfort: boolean;
  discomfortNote?: string;
  deferredAt?: string;
  completedAt?: string;
}

export interface WorkoutSession {
  id: string;
  workoutDayId: string;
  dateKey: string;
  startedAt: string;
  completedAt?: string;
  status: 'in_progress' | 'completed';
  plannedExercises: ExerciseSession[];
  recoveryExercises?: PlannedExercise[];
  activeExerciseIndex: number;
  readiness?: SessionReadiness;
}

export interface SessionReadiness {
  energy: Energy;
  soreness: Soreness;
}

export interface ProgressEntry {
  id: string;
  date: string;
  weightKg?: number;
  waistCm?: number;
  chestCm?: number;
  armCm?: number;
  hipCm?: number;
}

export interface WeeklyCheckin {
  id: string;
  weekKey: string;
  createdAt: string;
  weightKg?: number;
  waistCm?: number;
  feeling: string;
  energy: Energy;
  completedWorkouts: number;
  note?: string;
}

export interface AppData {
  schemaVersion: number;
  onboardingComplete: boolean;
  profile: UserProfile;
  exercises: ExerciseDefinition[];
  plan: WorkoutPlan;
  sessions: WorkoutSession[];
  progress: ProgressEntry[];
  checkins: WeeklyCheckin[];
}

export interface Recommendation {
  tone: 'positive' | 'neutral' | 'caution';
  label: string;
  message: string;
}

export interface BackupPayload {
  app: 'radian';
  exportedAt: string;
  data: AppData;
}
