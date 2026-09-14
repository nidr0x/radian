import { describe, expect, it } from 'vitest';
import { completionActionHint, dataStateCopy, todayPrimaryAction } from '../src/lib/uiCopy';

describe('copy de acciones de interfaz', () => {
  it('prioriza empezar una sesión y explica qué ocurre después', () => {
    expect(todayPrimaryAction(false)).toEqual({
      label: 'Empezar sesión',
      hint: 'Puedes registrar solo lo imprescindible y guardar al terminar cada ejercicio.',
    });
  });

  it('permite iniciar otra sesión sin esconder el estado del día', () => {
    expect(todayPrimaryAction(true)).toEqual({
      label: 'Registrar otra sesión',
      hint: 'Ya tienes una sesión guardada hoy; puedes añadir otra si lo necesitas.',
    });
  });

  it('hace explícito que valorar el ejercicio guarda y avanza', () => {
    expect(completionActionHint).toBe('Guarda y pasa al siguiente ejercicio');
  });

  it('resume dónde viven los datos y si requieren atención', () => {
    expect(dataStateCopy({ authenticated: true, pendingChanges: true, cloudConflict: false, codeConnected: false })).toBe('Cuenta D1 · cambios locales pendientes');
    expect(dataStateCopy({ authenticated: false, pendingChanges: false, cloudConflict: false, codeConnected: true })).toBe('Código cifrado · sincronización opcional');
    expect(dataStateCopy({ authenticated: true, pendingChanges: false, cloudConflict: true, codeConnected: false })).toBe('Revisión pendiente · hay dos copias distintas');
  });
});
