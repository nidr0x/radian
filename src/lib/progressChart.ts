export interface SvgChartEntry { date: string; value: number }
export interface SvgChartPoint { date: string; x: number; y: number }
export interface SvgChart { points: SvgChartPoint[]; linePath: string; areaPath: string; minimum: number; maximum: number; rangeSize: number }

export function buildSvgChart(entries: SvgChartEntry[], width = 320, plotTop = 14, plotBottom = 122): SvgChart {
  const values = entries.map((entry) => entry.value);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 0;
  const rangeSize = Math.max(maximum - minimum, 1);
  const points = entries.map(({ date, value }, index) => ({
    date,
    x: entries.length === 1 ? width / 2 : 12 + (index / (entries.length - 1)) * (width - 24),
    y: plotBottom - ((value - minimum) / rangeSize) * (plotBottom - plotTop),
  }));
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const areaPath = points.length ? `${linePath} L ${points.at(-1)!.x.toFixed(2)} ${plotBottom} L ${points[0].x.toFixed(2)} ${plotBottom} Z` : '';
  return { points, linePath, areaPath, minimum, maximum, rangeSize };
}
