export interface OpenGymConversionSet {
  n?: number;
  r?: number;
  w?: number;
  done?: boolean;
  phase?: string;
  [key: string]: unknown;
}

export interface OpenGymConversionExercise {
  id?: string;
  sets: OpenGymConversionSet[];
  [key: string]: unknown;
}

export interface OpenGymConversionState {
  routines: Array<{ id?: string; ex: OpenGymConversionExercise[]; [key: string]: unknown }>;
  workouts: Array<{ id?: string; entries: OpenGymConversionExercise[]; start?: number; end?: number; [key: string]: unknown }>;
  bodyweight: Array<Record<string, unknown>>;
  measurements: Array<Record<string, unknown>>;
  customEx: Array<{ id?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export function convertRadianBackupState(input: unknown): OpenGymConversionState;
export function legacyPlannedSetCount(exercise: unknown): number;
