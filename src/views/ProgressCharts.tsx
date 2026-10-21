import { memo, useState } from 'react';
import { History, Save } from 'lucide-react';
import { isWorkSet } from '../lib/progression';
import { dateKey, formatDate } from '../lib/date';
import { buildSvgChart, type SvgChartPoint } from '../lib/progressChart';
import { exerciseTrend } from '../lib/exerciseHistory';
import { formatVolume } from '../lib/format';
import { exerciseTrendOptions } from '../lib/trainingStats';
import { NumberField } from '../components/NumberField';
import type { AppData, Energy, ProgressEntry, WeeklyCheckin, WorkoutSession } from '../types';

type SvgLineChartProps = {
  points: SvgChartPoint[];
  linePath: string;
  areaPath: string;
  width?: number;
  height?: number;
  gradientId: string;
  accentColor?: string;
  className?: string;
  areaClassName?: string;
  gridlines?: number[] | false;
  title: string;
  description: string;
  role?: 'group' | 'img';
  selectedIndex?: number;
  pointLabels?: string[];
  onSelectPoint?: (index: number) => void;
};

const SvgLineChart = memo(function SvgLineChart({ points, linePath, areaPath, width = 320, height = 140, gradientId, accentColor = 'var(--accent)', className = 'weight-chart-svg', areaClassName, gridlines = [14, 68, 122], title, description, role = 'img', selectedIndex, pointLabels, onSelectPoint }: SvgLineChartProps) {
  const titleId = `${gradientId}-title`;
  const descriptionId = `${gradientId}-description`;
  return <svg className={className} viewBox={`0 0 ${width} ${height}`} role={role} aria-labelledby={`${titleId} ${descriptionId}`} preserveAspectRatio="none">
    <title id={titleId}>{title}</title>
    <desc id={descriptionId}>{description}</desc>
    <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={accentColor} stopOpacity=".32" /><stop offset="100%" stopColor={accentColor} stopOpacity="0" /></linearGradient></defs>
    {gridlines && gridlines.map((y) => <line className="weight-chart-gridline" key={y} x1="0" x2={width} y1={y} y2={y} />)}
    {points.length > 1 && <path className={`weight-chart-area${areaClassName ? ` ${areaClassName}` : ''}`} d={areaPath} />}
    <path className="weight-chart-line" d={linePath} />
    {points.map((point, index) => <g key={`${point.date}-${index}`}>
      {onSelectPoint && <circle className="weight-chart-hit-area" cx={point.x} cy={point.y} r="12" fill="transparent" pointerEvents="all" role="button" tabIndex={0} aria-pressed={index === selectedIndex} aria-label={pointLabels?.[index] ?? `Seleccionar registro ${index + 1}`} onClick={() => onSelectPoint(index)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectPoint(index); } }} />}
      <circle className={`weight-chart-point${index === points.length - 1 ? ' is-latest' : ''}${index === selectedIndex ? ' is-selected' : ''}`} cx={point.x} cy={point.y} r={index === points.length - 1 ? 4.5 : 3} pointerEvents="none" />
    </g>)}
  </svg>;
});

export function ExerciseTrendCard({ data }: { data: AppData }) {
  const [selectedExerciseId, setSelectedExerciseId] = useState('');
  const [selectedPointIndex, setSelectedPointIndex] = useState<number>();
  const options = exerciseTrendOptions(data);
  const selected = options.find((option) => option.id === selectedExerciseId) ?? options[0];
  if (!selected) return null;
  const trend = exerciseTrend(selected.id, data.sessions);
  const weighted = trend.some((point) => point.maxWeightKg !== undefined);
  const chartPoints = trend.filter((point) => weighted ? point.maxWeightKg !== undefined : true);
  if (chartPoints.length === 0) return null;
  const latest = chartPoints.at(-1)!;
  const values = chartPoints.map((point) => weighted ? point.maxWeightKg! : point.volumeKg);
  const activeIndex = Math.min(selectedPointIndex ?? chartPoints.length - 1, chartPoints.length - 1);
  const selectedPoint = chartPoints[activeIndex]!;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, 1);
  const width = 320;
  const plotTop = 14;
  const plotBottom = 122;
  const points = chartPoints.map((point, index) => ({
    x: chartPoints.length === 1 ? width / 2 : 12 + (index / (chartPoints.length - 1)) * (width - 24),
    y: plotBottom - ((values[index] - minimum) / range) * (plotBottom - plotTop),
    date: point.date,
  }));
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${points.at(-1)!.x.toFixed(2)} ${plotBottom} L ${points[0].x.toFixed(2)} ${plotBottom} Z`;
  const scaleValues = [maximum, minimum + range / 2, minimum];
  const numberFormat = { maximumFractionDigits: 1 } as const;
  const displayValue = (value: number): string => weighted ? `${value.toLocaleString('es-ES', numberFormat)} kg` : formatVolume(value);
  const metricLabel = weighted ? 'carga máxima' : 'volumen';
  return <section className="progress-card exercise-trend-card" aria-labelledby="exercise-trend-heading">
    <div className="section-heading compact"><div><p className="eyebrow">histórico por ejercicio</p><h2 id="exercise-trend-heading">Tu evolución</h2></div><History size={19} /></div>
    <label className="exercise-trend-select" htmlFor="exercise-trend-picker"><span>Ejercicio</span><select id="exercise-trend-picker" value={selected.id} onChange={(event) => { setSelectedExerciseId(event.target.value); setSelectedPointIndex(undefined); }}>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
    <div className="weight-chart-reading exercise-trend-reading" aria-live="polite"><strong>{displayValue(values[activeIndex])}</strong><span>{metricLabel} · {formatDate(selectedPoint.date, { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
    <div className="weight-chart-body">
      <div className="weight-chart-scale" aria-hidden="true">{scaleValues.map((value, index) => <span key={`${value}-${index}`}>{weighted ? `${value.toLocaleString('es-ES', numberFormat)} kg` : formatVolume(value)}</span>)}</div>
      <SvgLineChart points={points} linePath={linePath} areaPath={areaPath} gradientId="exercise-trend-fill" areaClassName="exercise-trend-area" role="group" gridlines={[plotTop, (plotTop + plotBottom) / 2, plotBottom]} title={`Evolución de ${selected.name}`} description={`${metricLabel} registrado entre ${formatDate(chartPoints[0].date, { day: 'numeric', month: 'long', year: 'numeric' })} y ${formatDate(latest.date, { day: 'numeric', month: 'long', year: 'numeric' })}. Selecciona un punto para consultar su valor.`} selectedIndex={activeIndex} pointLabels={chartPoints.map((point, index) => `${formatDate(point.date, { day: 'numeric', month: 'long', year: 'numeric' })}: ${displayValue(values[index])}`)} onSelectPoint={setSelectedPointIndex} />
    </div>
    <div className="weight-chart-footer"><span>{formatDate(chartPoints[0].date, { month: 'short', year: 'numeric' })}</span><span>{chartPoints.length} {chartPoints.length === 1 ? 'registro' : 'registros'}</span><span>{formatDate(latest.date, { month: 'short', year: 'numeric' })}</span></div>
    {chartPoints.length === 1 ? <p className="weight-chart-note">Añade otra sesión con este ejercicio para ver la tendencia.</p> : <p className="weight-chart-note">Selecciona un punto para consultar esa sesión. La línea muestra {weighted ? 'la carga máxima registrada en una serie' : 'el volumen de trabajo registrado'}.</p>}
    {selectedPoint.discomfort && <p className="weight-chart-note exercise-trend-warning">Esta sesión incluye molestias; prioriza control y comodidad antes de progresar.</p>}
  </section>;
}

const weightChartRanges = [{ value: '3m', label: '3 meses' }, { value: '12m', label: '12 meses' }, { value: 'all', label: 'Todo' }] as const;

export function WeightChart({ entries }: { entries: ProgressEntry[] }) {
  const [range, setRange] = useState<(typeof weightChartRanges)[number]['value']>('12m');
  const [selectedEntryId, setSelectedEntryId] = useState<string>();
  const allWeightEntries = entries.filter((entry) => entry.weightKg !== undefined).sort((a, b) => a.date.localeCompare(b.date));
  if (!allWeightEntries.length) return null;

  const cutoff = new Date();
  const dayOfMonth = cutoff.getDate();
  cutoff.setHours(12, 0, 0, 0);
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - (range === '3m' ? 3 : 12));
  cutoff.setDate(Math.min(dayOfMonth, new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate()));
  const rangeStart = dateKey(cutoff);
  const weightEntries = range === 'all' ? allWeightEntries : allWeightEntries.filter((entry) => entry.date >= rangeStart);
  const rangeControls = <div className="weight-chart-ranges" role="group" aria-label="Periodo del gráfico">{weightChartRanges.map((option) => <button type="button" className="weight-chart-range" key={option.value} aria-pressed={range === option.value} onClick={() => { setRange(option.value); setSelectedEntryId(undefined); }}>{option.label}</button>)}</div>;
  if (!weightEntries.length) return <section className="weight-chart" aria-labelledby="weight-chart-title"><div><p className="eyebrow">peso corporal</p><h3 id="weight-chart-title">Evolución del peso</h3></div>{rangeControls}<p className="weight-chart-empty">No hay medidas en este periodo. Selecciona «Todo» para revisar el historial completo.</p></section>;

  const latest = weightEntries.at(-1)!;
  const foundIndex = weightEntries.findIndex((entry) => entry.id === selectedEntryId);
  const activeIndex = foundIndex >= 0 ? foundIndex : weightEntries.length - 1;
  const selected = weightEntries[activeIndex]!;
  const previous = weightEntries[activeIndex - 1]?.weightKg;
  const delta = previous === undefined ? undefined : selected.weightKg! - previous;
  const width = 320;
  const plotTop = 14;
  const plotBottom = 122;
  const { points, linePath, areaPath, minimum, maximum, rangeSize } = buildSvgChart(weightEntries.map((entry) => ({ date: entry.date, value: entry.weightKg! })), width, plotTop, plotBottom);
  const scaleValues = [maximum, minimum + rangeSize / 2, minimum];
  const numberFormat = { maximumFractionDigits: 1 } as const;
  return <section className="weight-chart" aria-labelledby="weight-chart-title">
    <div className="weight-chart-heading" aria-live="polite">
      <div>
        <p className="eyebrow">peso corporal</p>
        <div className="weight-chart-reading"><strong>{selected.weightKg!.toLocaleString('es-ES', numberFormat)}<small> kg</small></strong>{delta !== undefined && <span className={delta <= 0 ? 'is-positive' : 'is-caution'}>{delta > 0 ? '+' : ''}{delta.toLocaleString('es-ES', numberFormat)} kg</span>}</div>
      </div>
      <time dateTime={selected.date}>{formatDate(selected.date, { day: 'numeric', month: 'short', year: 'numeric' })}</time>
    </div>
    {rangeControls}
    <div className="weight-chart-body">
      <div className="weight-chart-scale" aria-hidden="true">{scaleValues.map((value, index) => <span key={`${value}-${index}`}>{value.toLocaleString('es-ES', numberFormat)}</span>)}</div>
      <SvgLineChart points={points} linePath={linePath} areaPath={areaPath} gradientId="weight-chart-fill" width={width} height={140} role="group" title="Evolución del peso" description={`Peso registrado entre ${formatDate(weightEntries[0].date, { day: 'numeric', month: 'long', year: 'numeric' })} y ${formatDate(latest.date, { day: 'numeric', month: 'long', year: 'numeric' })}. Selecciona un punto para consultar esa medición.`} selectedIndex={activeIndex} pointLabels={weightEntries.map((entry) => `${formatDate(entry.date, { day: 'numeric', month: 'long', year: 'numeric' })}: ${entry.weightKg!.toLocaleString('es-ES', numberFormat)} kg`)} onSelectPoint={(index) => setSelectedEntryId(weightEntries[index].id)} />
    </div>
    <table className="sr-only" aria-label="Datos del gráfico de peso"><thead><tr><th>Fecha</th><th>Peso (kg)</th></tr></thead><tbody>{weightEntries.map((entry) => <tr key={entry.id}><td>{formatDate(entry.date, { day: 'numeric', month: 'long', year: 'numeric' })}</td><td>{entry.weightKg!.toLocaleString('es-ES', numberFormat)}</td></tr>)}</tbody></table>
    <div className="weight-chart-footer"><span>{formatDate(weightEntries[0].date, { month: 'short', year: 'numeric' })}</span><span>{weightEntries.length} {weightEntries.length === 1 ? 'registro' : 'registros'}</span><span>{formatDate(latest.date, { month: 'short', year: 'numeric' })}</span></div>
    {weightEntries.length === 1 ? <p className="weight-chart-note">Añade otra medición para ver la tendencia.</p> : <p className="weight-chart-note">Selecciona un punto para consultar esa medición.</p>}
  </section>;
}

export function ExerciseProgressChart({ exerciseId, sessions }: { exerciseId: string; sessions: WorkoutSession[] }) {
  const entries = sessions.flatMap((session) => {
    if (session.status !== 'completed') return [];
    const weights = session.plannedExercises.filter((exercise) => exercise.exerciseId === exerciseId).flatMap((exercise) => exercise.setLogs.filter((set) => isWorkSet(set) && set.completed && set.weightKg !== undefined && Number.isFinite(set.weightKg)).map((set) => set.weightKg!));
    return weights.length ? [{ date: session.dateKey, value: Math.max(...weights) }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) return <p className="weight-chart-empty">Aún no hay series de trabajo con peso para este ejercicio.</p>;

  const name = sessions.find((session) => session.plannedExercises.some((exercise) => exercise.exerciseId === exerciseId))?.plannedExercises.find((exercise) => exercise.exerciseId === exerciseId)?.name ?? exerciseId;
  const latest = entries.at(-1)!;
  const { points, linePath, areaPath, minimum, maximum, rangeSize } = buildSvgChart(entries);
  const scaleValues = [maximum, minimum + rangeSize / 2, minimum];
  const numberFormat = { maximumFractionDigits: 1 } as const;
  return <div className="weight-chart exercise-progress-chart" aria-labelledby="exercise-progress-title">
    <div className="weight-chart-heading"><div><p className="eyebrow">carga máxima</p><div className="weight-chart-reading"><strong>{latest.value.toLocaleString('es-ES', numberFormat)}<small> kg</small></strong></div></div><time dateTime={latest.date}>{formatDate(latest.date, { day: 'numeric', month: 'short', year: 'numeric' })}</time></div>
    <div className="weight-chart-body">
<div className="weight-chart-scale" aria-hidden="true">{scaleValues.map((value, index) => <span key={`${value}-${index}`}>{value.toLocaleString('es-ES', numberFormat)}</span>)}</div>
  <SvgLineChart points={points} linePath={linePath} areaPath={areaPath} gradientId="exercise-progress-fill" areaClassName="exercise-progress-area" width={320} height={140} role="img" title={`Progresión de carga de ${name}`} description={`Carga máxima en series de trabajo registradas entre ${formatDate(entries[0].date, { day: 'numeric', month: 'long', year: 'numeric' })} y ${formatDate(latest.date, { day: 'numeric', month: 'long', year: 'numeric' })}.`} />
</div>
    <table className="sr-only" aria-label={`Datos de carga de ${name}`}><thead><tr><th>Fecha</th><th>Peso (kg)</th></tr></thead><tbody>{entries.map((entry, index) => <tr key={`${entry.date}-${index}`}><td>{formatDate(entry.date, { day: 'numeric', month: 'long', year: 'numeric' })}</td><td>{entry.value.toLocaleString('es-ES', numberFormat)}</td></tr>)}</tbody></table>
    <div className="weight-chart-footer"><span>{formatDate(entries[0].date, { month: 'short', year: 'numeric' })}</span><span>{entries.length} {entries.length === 1 ? 'registro' : 'registros'}</span><span>{formatDate(latest.date, { month: 'short', year: 'numeric' })}</span></div>
  </div>;
}

export function TrendRow({ label, values, unit }: { label: string; values: Array<number | undefined>; unit: string }) { const defined = values.filter((value): value is number => value !== undefined); const max = Math.max(...defined, 1); const min = Math.min(...defined, 0); return <div className="trend-row"><div><strong>{label}</strong><span>{defined.length ? `${defined[defined.length - 1].toLocaleString('es-ES')} ${unit}` : 'Sin datos'}</span></div><div className="trend-bars" aria-label={`Tendencia de ${label}`}>{defined.slice(-8).map((value, index) => { const height = defined.length > 1 ? Math.max(14, ((value - min) / Math.max(max - min, 1)) * 58 + 12) : 24; return <span key={`${value}-${index}`} style={{ height: `${height}px` }} />; })}</div></div>; }

export function CheckinForm({ existing, onSave }: { existing?: WeeklyCheckin; onSave: (checkin: Omit<WeeklyCheckin, 'id' | 'createdAt' | 'weekKey'>) => void }) { const [form, setForm] = useState({ weightKg: existing?.weightKg?.toString() ?? '', waistCm: existing?.waistCm?.toString() ?? '', feeling: existing?.feeling ?? '', energy: existing?.energy ?? 'normal' as Energy, completedWorkouts: existing?.completedWorkouts?.toString() ?? '4', note: existing?.note ?? '' }); return <form className="checkin-form" onSubmit={(event) => { event.preventDefault(); onSave({ weightKg: form.weightKg ? Number(form.weightKg) : undefined, waistCm: form.waistCm ? Number(form.waistCm) : undefined, feeling: form.feeling, energy: form.energy, completedWorkouts: Number(form.completedWorkouts), note: form.note || undefined }); }}>
<div className="form-grid">
  <NumberField label="Peso" unit="kg · opcional" value={form.weightKg} onChange={(value) => setForm((current) => ({ ...current, weightKg: value }))} />
  <NumberField label="Cintura" unit="cm · opcional" value={form.waistCm} onChange={(value) => setForm((current) => ({ ...current, waistCm: value }))} />
  <label>Entrenamientos completados<select value={form.completedWorkouts} onChange={(event) => setForm((current) => ({ ...current, completedWorkouts: event.target.value }))}>{[0, 1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select>
  </label>
  <label>Energía<select value={form.energy} onChange={(event) => setForm((current) => ({ ...current, energy: event.target.value as Energy }))}>
    <option value="low">Baja</option>
      <option value="normal">Normal</option>
        <option value="high">Alta</option>
        </select>
      </label>
    </div>
    <label>¿Cómo te has sentido?<textarea value={form.feeling} onChange={(event) => setForm((current) => ({ ...current, feeling: event.target.value }))} placeholder="Unas palabras sobre la semana" rows={2} />
  </label>
  <label>Comentario opcional<textarea value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} rows={2} />
</label>
<button className="primary-button small" type="submit">
  <Save size={16} /> Guardar check-in</button>
  </form>; }
