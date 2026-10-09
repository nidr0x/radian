import { dateKey } from './date';

export interface CalendarCell { date: Date; dateKey: string; inMonth: boolean }

export function buildCalendarCells(month: Date): CalendarCell[] {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1, 12).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0, 12).getDate();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(year, monthIndex, index - firstWeekday + 1, 12);
    return { date, dateKey: dateKey(date), inMonth: date.getMonth() === monthIndex };
  });
}
