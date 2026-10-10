import { describe, expect, it } from 'vitest';
import { createSession } from '../src/lib/storage';
import { defaultData } from '../src/data/initialPlan';
import { buildProgressBuckets } from '../src/lib/progressOverview';

const session = (id: string, date: string, completed = true) => {
  const value = createSession(defaultData().plan.days[0], date, new Date(`${date}T10:00:00.000Z`));
  value.id = id;
  value.status = completed ? 'completed' : 'in_progress';
  value.completedAt = completed ? `${date}T11:00:00.000Z` : undefined;
  return value;
};

describe('buildProgressBuckets', () => {
  it('groups completed sessions by Monday-to-Sunday week and excludes adjacent dates', () => {
    const buckets = buildProgressBuckets([
      session('before', '2026-10-04'),
      session('monday', '2026-10-05'),
      session('saturday', '2026-10-10'),
      session('unfinished', '2026-10-09', false),
    ], 'week', new Date('2026-10-10T12:00:00'));

    expect(buckets).toHaveLength(7);
    expect(buckets.filter((bucket) => bucket.sessions > 0).map(({ label, sessions }) => [label, sessions])).toEqual([['L', 1], ['S', 1]]);
  });

  it('creates every day of the selected month and only counts its completed sessions', () => {
    const buckets = buildProgressBuckets([session('september', '2026-09-30'), session('october', '2026-10-10')], 'month', new Date('2026-10-10T12:00:00'));

    expect(buckets).toHaveLength(31);
    expect(buckets[0]).toMatchObject({ key: '2026-10-01', label: '1', sessions: 0 });
    expect(buckets[9]).toMatchObject({ key: '2026-10-10', label: '10', sessions: 1, durationSeconds: 3600 });
  });

  it('groups year totals into calendar months and all-time totals into years', () => {
    const sessions = [session('last-year', '2025-12-31'), session('current-year', '2026-10-10')];
    const year = buildProgressBuckets(sessions, 'year', new Date('2026-10-10T12:00:00'));
    const all = buildProgressBuckets(sessions, 'all', new Date('2026-10-10T12:00:00'));

    expect(year).toHaveLength(12);
    expect(year[9]).toMatchObject({ key: '2026-10', sessions: 1 });
    expect(all.map(({ key, sessions: count }) => [key, count])).toEqual([['2025', 1], ['2026', 1]]);
  });
});
