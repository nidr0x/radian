export const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const shortDayNames = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

export const dateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const weekKey = (date = new Date()): string => {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return dateKey(copy);
};

export const formatDate = (value: string | Date, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('es-ES', options).format(typeof value === 'string' ? new Date(`${value}T12:00:00`) : value);

export const currentWeekday = (date = new Date()): number => date.getDay();

export const formatDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min`;
};
