import type { Theme } from '../types';

const themeLabels: Record<Theme, string> = {
  system: 'Tema automático',
  light: 'Tema claro',
  dark: 'Tema oscuro',
};

export const themeOptionLabel = (theme: Theme): string => themeLabels[theme];
export const textSizeToggleLabel = (largeText: boolean): string => largeText ? 'Desactivar texto grande' : 'Activar texto grande';
