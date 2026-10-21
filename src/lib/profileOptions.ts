import type { ExperienceLevel } from '../types';

/** Experience level options for onboarding and profile.
Kept out of ProfilePickers.tsx so that file exports only components (fast refresh). */
export const experienceOptions: Array<{ value: ExperienceLevel; label: string; description: string }> = [
  { value: 'beginner', label: 'Estoy empezando', description: 'Quiero instrucciones sencillas y margen.' },
  { value: 'intermediate', label: 'Ya tengo base', description: 'Conozco las máquinas y registro cargas.' },
  { value: 'advanced', label: 'Tengo experiencia', description: 'Quiero centrarme en progresar.' },
];
