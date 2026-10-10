import type { WorkoutSession } from '../types';
import { dateKey, shortDayNames } from './date';
import { summarizeSession } from './sessionSummary';

export type ProgressRange = 'week' | 'month' | 'year' | 'all';

export interface ProgressBucket {
  key: string;
  label: string;
  sessions: number;
  volumeKg: number;
  durationSeconds: number;
}

export const buildProgressBuckets = (sessions: WorkoutSession[], range: ProgressRange, referenceDate = new Date()): ProgressBucket[] => {
  const completed = sessions.filter((session) => session.status === 'completed' && /^\d{4}-\d{2}-\d{2}$/.test(session.dateKey));
  const year = referenceDate.getFullYear();
  let buckets: ProgressBucket[];

  if (range === 'week') {
    const monday = new Date(year, referenceDate.getMonth(), referenceDate.getDate(), 12);
    monday.setDate(monday.getDate() - (monday.getDay() || 7) + 1);
    buckets = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(monday);
      day.setDate(monday.getDate() + index);
      return { key: dateKey(day), label: shortDayNames[day.getDay()], sessions: 0, volumeKg: 0, durationSeconds: 0 };
    });
  } else if (range === 'month') {
    const daysInMonth = new Date(year, referenceDate.getMonth() + 1, 0).getDate();
    buckets = Array.from({ length: daysInMonth }, (_, index) => {
      const day = new Date(year, referenceDate.getMonth(), index + 1, 12);
      return { key: dateKey(day), label: String(index + 1), sessions: 0, volumeKg: 0, durationSeconds: 0 };
    });
  } else if (range === 'year') {
    buckets = Array.from({ length: 12 }, (_, month) => {
      const date = new Date(year, month, 1, 12);
      return { key: dateKey(date).slice(0, 7), label: new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(date), sessions: 0, volumeKg: 0, durationSeconds: 0 };
    });
  } else {
    const years = new Set(completed.map((session) => session.dateKey.slice(0, 4)));
    years.add(String(year));
    buckets = [...years].sort().map((item) => ({ key: item, label: item, sessions: 0, volumeKg: 0, durationSeconds: 0 }));
  }

  completed.forEach((session) => {
    const bucket = buckets.find(({ key }) => range === 'week' || range === 'month' ? key === session.dateKey : range === 'year' ? key === session.dateKey.slice(0, 7) : key === session.dateKey.slice(0, 4));
    if (!bucket) return;
    const summary = summarizeSession(session);
    bucket.sessions += 1;
    bucket.volumeKg += summary.volumeKg;
    bucket.durationSeconds += summary.durationSeconds;
  });

  return buckets.map((bucket) => ({ ...bucket, volumeKg: Math.round(bucket.volumeKg * 10) / 10 }));
};
