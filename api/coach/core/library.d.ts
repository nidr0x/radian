export interface CoachLibraryExercise {
  id: string;
  n: string;
  bp: string;
  tg?: string;
  eq?: string;
  custom?: boolean;
}

export const LIBRARY: readonly CoachLibraryExercise[];
export const LIB_BY_ID: Map<string, CoachLibraryExercise>;
export const libraryHas: (id: string) => boolean;
export const libraryName: (id: string) => string | null;
export const equipmentAllows: (equipment: string[], id: string) => boolean;
