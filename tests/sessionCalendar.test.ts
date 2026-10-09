import { describe, expect, it } from 'vitest';
import { buildCalendarCells } from '../src/lib/sessionCalendar';

describe('buildCalendarCells', () => {
  it('fills a Sunday-first month with previous and next month days', () => {
    const cells = buildCalendarCells(new Date(2026, 9, 9, 12));
    expect(cells).toHaveLength(35);
    expect(cells[0]).toMatchObject({ dateKey: '2026-09-27', inMonth: false });
    expect(cells[4]).toMatchObject({ dateKey: '2026-10-01', inMonth: true });
    expect(cells.at(-1)).toMatchObject({ dateKey: '2026-10-31', inMonth: true });
  });

  it('pads a month that starts on Sunday to a complete final week', () => {
    const cells = buildCalendarCells(new Date(2026, 2, 1, 12));
    expect(cells).toHaveLength(35);
    expect(cells[0]).toMatchObject({ dateKey: '2026-03-01', inMonth: true });
    expect(cells.at(-1)).toMatchObject({ dateKey: '2026-04-04', inMonth: false });
  });

  it('includes leap day', () => {
    const cells = buildCalendarCells(new Date(2024, 1, 1, 12));
    expect(cells.some((cell) => cell.dateKey === '2024-02-29' && cell.inMonth)).toBe(true);
  });
});
