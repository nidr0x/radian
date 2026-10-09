import { describe, expect, it } from 'vitest';
import { buildSvgChart } from '../src/lib/progressChart';

describe('buildSvgChart', () => {
  it('returns empty geometry for no entries', () => {
    expect(buildSvgChart([])).toEqual({ points: [], linePath: '', areaPath: '', minimum: 0, maximum: 0, rangeSize: 1 });
  });

  it('centers one entry in a custom chart size', () => {
    const chart = buildSvgChart([{ date: '2026-10-09', value: 72 }], 240, 10, 90);
    expect(chart.points).toEqual([{ date: '2026-10-09', x: 120, y: 90 }]);
    expect(chart.linePath).toBe('M 120.00 90.00');
  });

  it('keeps flat values on one line and spaces multiple entries across the width', () => {
    const chart = buildSvgChart([{ date: 'a', value: 50 }, { date: 'b', value: 50 }, { date: 'c', value: 50 }]);
    expect(chart.rangeSize).toBe(1);
    expect(chart.points.map(({ x, y }) => [x, y])).toEqual([[12, 122], [160, 122], [308, 122]]);
    expect(chart.areaPath).toContain(' Z');
  });
});
