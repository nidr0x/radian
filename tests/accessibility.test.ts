import { describe, expect, it } from 'vitest';
import { textSizeToggleLabel, themeOptionLabel } from '../src/lib/accessibility';

describe('nombres accesibles de preferencias', () => {
  it('describe el estado accionable del texto grande', () => {
    expect(textSizeToggleLabel(false)).toBe('Activar texto grande');
    expect(textSizeToggleLabel(true)).toBe('Desactivar texto grande');
  });

  it('nombra cada opción de apariencia', () => {
    expect(themeOptionLabel('system')).toBe('Tema automático');
    expect(themeOptionLabel('light')).toBe('Tema claro');
    expect(themeOptionLabel('dark')).toBe('Tema oscuro');
  });
});
