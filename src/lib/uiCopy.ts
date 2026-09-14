export interface TodayPrimaryAction {
  label: string;
  hint: string;
}

export const completionActionHint = 'Guarda y pasa al siguiente ejercicio';

export const todayPrimaryAction = (doneToday: boolean): TodayPrimaryAction => doneToday
  ? { label: 'Registrar otra sesión', hint: 'Ya tienes una sesión guardada hoy; puedes añadir otra si lo necesitas.' }
  : { label: 'Empezar sesión', hint: 'Puedes registrar solo lo imprescindible y guardar al terminar cada ejercicio.' };

export const dataStateCopy = ({ authenticated, pendingChanges, cloudConflict, codeConnected }: { authenticated: boolean; pendingChanges: boolean; cloudConflict: boolean; codeConnected: boolean }): string => {
  if (cloudConflict) return 'Revisión pendiente · hay dos copias distintas';
  const location = authenticated ? 'Cuenta D1' : codeConnected ? 'Código cifrado' : 'Solo este dispositivo';
  if (pendingChanges) return `${location} · cambios locales pendientes`;
  return authenticated ? `${location} · sincronizado` : codeConnected ? `${location} · sincronización opcional` : location;
};
