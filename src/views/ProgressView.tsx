import { memo, useMemo, useState } from 'react';
import { Activity, CalendarDays, Check, ChevronLeft, ChevronRight, Gauge, Info, Layers3, Plus, Share2, Sparkles, Sun, Trophy } from 'lucide-react';
import { buildProgressBuckets, type ProgressBucket, type ProgressRange } from '../lib/progressOverview';
import { buildCalendarCells } from '../lib/sessionCalendar';
import { dateKey, formatDate, normalizeTrainingDays, shortDayNames, weekKey } from '../lib/date';
import { displayWorkoutName, formatSessionDuration, formatVolume, formatWeight, changeLabel } from '../lib/format';
import { buildWeekDays, getLatestWorkoutStreak } from '../lib/trainingStats';
import { summarizeSession } from '../lib/sessionSummary';
import { exerciseTrendOptions, historySummary, muscleGroupVolumes, performanceRows, personalRecords } from '../lib/trainingStats';
import { PageHeader } from '../components/PageHeader';
import { CheckinForm, ExerciseProgressChart, ExerciseTrendCard, TrendRow, WeightChart } from './ProgressCharts';
import { NumberField } from '../components/NumberField';
import { buildWeeklySummary, weeklySummaryText } from '../lib/weeklySummary';
import type { AppData, ExerciseDefinition, ProgressEntry, WeeklyCheckin, WorkoutDay, WorkoutSession } from '../types';

export function ProgressView({ data, onAddProgress, onAddCheckin, onInfo, onToast }: { data: AppData; onAddProgress: (entry: Omit<ProgressEntry, 'id' | 'date'>) => void; onAddCheckin: (checkin: Omit<WeeklyCheckin, 'id' | 'createdAt' | 'weekKey'>) => void; onInfo: () => void; onToast: (message: string) => void }) {
  const [measureOpen, setMeasureOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [selectedExerciseId, setSelectedExerciseId] = useState('');
  const [progressRange, setProgressRange] = useState<ProgressRange>('month');
  const [form, setForm] = useState({ weightKg: '', waistCm: '', chestCm: '', armCm: '', hipCm: '' });
  const currentCheckin = data.checkins.find((item) => item.weekKey === weekKey());
  const weeklySummary = buildWeeklySummary(data);
  const scheduledTrainingDays = normalizeTrainingDays(data.profile.trainingDays).slice(0, data.plan.days.length);
  const weekDays = buildWeekDays(scheduledTrainingDays, data.sessions);
  const completedThisWeek = weekDays.filter((day) => day.completed).length;
  const weeklyTarget = Math.max(scheduledTrainingDays.length, 1);
  const performance = useMemo(() => performanceRows(data.sessions), [data.sessions]);
  const availableExercises = useMemo(() => exerciseTrendOptions(data), [data]);
  const sortedProgress = useMemo(() => [...data.progress].sort((a, b) => a.date.localeCompare(b.date)), [data.progress]);
  const weightEntries = useMemo(() => sortedProgress.filter((entry) => entry.weightKg !== undefined), [sortedProgress]);
  const waistEntries = useMemo(() => sortedProgress.filter((entry) => entry.waistCm !== undefined), [sortedProgress]);
  const lastWeight = weightEntries.at(-1);
  const previousWeight = weightEntries.at(-2);
  const lastWaist = waistEntries.at(-1);
  const previousWaist = waistEntries.at(-2);
  const saveMeasure = (event: React.FormEvent): void => { event.preventDefault(); onAddProgress(Object.fromEntries(Object.entries(form).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)])) as Omit<ProgressEntry, 'id' | 'date'>); setForm({ weightKg: '', waistCm: '', chestCm: '', armCm: '', hipCm: '' }); setMeasureOpen(false); };
  return <section className="view-section progress-view">
<PageHeader eyebrow="señales, no ruido" title="Progreso" action={<button className="icon-button subtle" type="button" aria-label="Información sobre las métricas" onClick={onInfo}>
  <Info size={19} />
</button>} />
<ProgressOverview data={data} range={progressRange} onRangeChange={setProgressRange} />
<div className="metric-grid">
  <MetricCard label="Peso actual" value={lastWeight?.weightKg !== undefined ? formatWeight(lastWeight.weightKg) : formatWeight(data.profile.currentWeightKg)} change={changeLabel(lastWeight?.weightKg, previousWeight?.weightKg)} icon={<Activity size={17} />} />
  <MetricCard label="Cintura" value={lastWaist?.waistCm !== undefined ? `${lastWaist.waistCm.toLocaleString('es-ES', { maximumFractionDigits: 1 })} cm` : 'Sin registro'} change={changeLabel(lastWaist?.waistCm, previousWaist?.waistCm, ' cm')} icon={<Gauge size={17} />} />
  <MetricCard label="Adherencia" value={`${Math.min(completedThisWeek, weeklyTarget)}/${weeklyTarget}`} change="esta semana" icon={<Check size={17} />} />
</div>
<section className="progress-card weekly-adherence-card">
  <div className="section-heading compact">
    <div>
      <p className="eyebrow">esta semana</p>
        <h2>Tu constancia</h2>
        </div>
        <strong className="weekly-score">{completedThisWeek}/{weeklyTarget}</strong>
        </div>
        <div className="week-strip" aria-label="Entrenamientos de la semana">{weekDays.map((day) => <div className={day.completed ? 'week-day completed' : day.planned ? 'week-day planned' : 'week-day'} key={day.key}>
          <span>{day.label}</span>
            <i aria-hidden="true">{day.completed ? '✓' : day.planned ? '·' : ''}</i>
            </div>)}</div>
            <p className="history-caption">{completedThisWeek === 0 ? 'Todavía no hay entrenamientos guardados esta semana.' : `${completedThisWeek} de ${weeklyTarget} sesiones previstas ya están guardadas.`}</p>
            </section>
            <section className="progress-card">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">historial</p>
                    <h2>Calendario</h2>
                    </div>
                  </div>
                  <SessionCalendar sessions={data.sessions} trainingDays={data.profile.trainingDays} exercises={data.exercises} workoutDays={data.plan.days} />
                </section>
                <section className="progress-card">
                  <div className="section-heading compact">
                    <div>
                      <p className="eyebrow">evolución corporal</p>
                        <h2>Medidas en el tiempo</h2>
                        </div>
                        <button className="text-button" onClick={() => setMeasureOpen((value) => !value)}>
                          <Plus size={16} /> Añadir</button>
                          </div>{measureOpen && <form className="measurement-form" onSubmit={saveMeasure}>
                          <NumberField label="Peso" unit="kg" value={form.weightKg} onChange={(value) => setForm((current) => ({ ...current, weightKg: value }))} />
                          <NumberField label="Cintura" unit="cm" value={form.waistCm} onChange={(value) => setForm((current) => ({ ...current, waistCm: value }))} />
                          <NumberField label="Pecho" unit="cm" value={form.chestCm} onChange={(value) => setForm((current) => ({ ...current, chestCm: value }))} />
                          <NumberField label="Brazo" unit="cm" value={form.armCm} onChange={(value) => setForm((current) => ({ ...current, armCm: value }))} />
                          <NumberField label="Cadera" unit="cm · opcional" value={form.hipCm} onChange={(value) => setForm((current) => ({ ...current, hipCm: value }))} />
                          <button className="primary-button small" type="submit">Guardar medidas</button>
                          </form>}<WeightChart entries={sortedProgress} />
                          <div className="trend-list">
                            <TrendRow label="Cintura" values={sortedProgress.map((item) => item.waistCm)} unit="cm" />
                          </div>{data.progress.length === 0 && <div className="empty-state">
                          <span className="empty-icon">
                            <Activity size={19} />
                          </span>
                          <strong>Aún no hay medidas</strong>
                            <p>Registra solo lo que te apetezca comparar. No hace falta hacerlo cada día.</p>
                            </div>}</section>{performance.length > 0 && <section className="progress-card performance-card">
                            <div className="section-heading compact">
                              <div>
                                <p className="eyebrow">señal de entrenamiento</p>
                                  <h2>Rendimiento reciente</h2>
                                  </div>
                                  <Gauge size={19} />
                                </div>
                                <div className="performance-list">{performance.map((item) => <div className="performance-row" key={item.exerciseId}>
                                  <div>
                                    <strong>{item.name}</strong>
                                      <span>{item.load !== undefined ? `${formatWeight(item.load)} · ${item.reps ?? '-'} reps` : 'Sin carga registrada'}</span>
                                      </div>
                                      <b>{formatVolume(item.volume)}</b>
                                      </div>)}</div>
                                    </section>}<section className="checkin-card">
                                    <div className="checkin-mark">
                                      <Sun size={21} />
                                    </div>
                                    <div className="checkin-copy">
                                      <p className="eyebrow">cierre semanal</p>
                                        <h2>{currentCheckin ? 'Check-in guardado' : '¿Cómo ha ido la semana?'}</h2>
                                          <p>{currentCheckin ? 'Puedes editarlo cuando quieras.' : 'Dos minutos para poner contexto a tus datos.'}</p>
                                          </div>
                                          <button className="text-button" onClick={() => setCheckinOpen((value) => !value)}>{currentCheckin ? 'Editar' : 'Hacer check-in'} <ChevronRight size={16} />
                                        </button>
                                      </section>{checkinOpen && <CheckinForm existing={currentCheckin} onSave={(value) => { onAddCheckin(value); setCheckinOpen(false); }} />}
    <details id="progress-details" className="progress-details">
<summary>Ver histórico detallado</summary>
  <div className="progress-details-body">
    <ExerciseTrendCard data={data} />
    <HistoryPanel data={data} />
    <WeeklyTrends summary={weeklySummary} />
    <TrainingSignalsCard signals={weeklySummary.signals} />
  </div>
</details>
<WeeklyReviewCard summary={weeklySummary} data={data} onToast={onToast} />
<section className="progress-card">
  <div className="section-heading compact">
    <div>
      <p className="eyebrow">por ejercicio</p>
        <h2>Progresión de carga</h2>
        </div>
      </div>
      <label className="exercise-progress-select-label">Ejercicio<select value={selectedExerciseId} onChange={(event) => setSelectedExerciseId(event.target.value)}>
        <option value="">Elige un ejercicio…</option>{availableExercises.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select>
        </label>{selectedExerciseId && <ExerciseProgressChart exerciseId={selectedExerciseId} sessions={data.sessions} />}</section>
      </section>;
}

function ProgressOverview({ data, range, onRangeChange }: { data: AppData; range: ProgressRange; onRangeChange: (range: ProgressRange) => void }) {
  const buckets = useMemo(() => buildProgressBuckets(data.sessions, range), [data.sessions, range]);
  const totals = buckets.reduce((sum, bucket) => ({ sessions: sum.sessions + bucket.sessions, volumeKg: sum.volumeKg + bucket.volumeKg, durationSeconds: sum.durationSeconds + bucket.durationSeconds }), { sessions: 0, volumeKg: 0, durationSeconds: 0 });
  const muscleGroups = useMemo(() => muscleGroupVolumes(data).slice(0, 3), [data]);
  const weekDays = buildWeekDays(data.profile.trainingDays, data.sessions);
  const streak = getLatestWorkoutStreak(data.profile.trainingDays, data.sessions);
  const labels: Record<ProgressRange, string> = { week: 'Semana', month: 'Mes', year: 'Año', all: 'Todo' };

  return <section className="progress-overview" aria-label="Resumen de actividad">
    <div className="progress-range-tabs" role="group" aria-label="Periodo del resumen">{(Object.keys(labels) as ProgressRange[]).map((item) => <button type="button" key={item} aria-pressed={range === item} className={range === item ? 'is-active' : ''} onClick={() => onRangeChange(item)}>{labels[item]}</button>)}</div>
    <div className="progress-overview-grid">
      <article className="progress-overview-card progress-training-card"><div className="progress-overview-heading"><h2>Entrenamientos</h2><ChevronRight size={17} aria-hidden="true" /></div><strong>{totals.sessions}</strong><span className="progress-overview-caption">{labels[range].toLowerCase()}</span><ProgressOverviewBars buckets={buckets} metric="sessions" tone="green" /></article>
      <ProgressOverviewMetric label="Volumen total" value={formatVolume(totals.volumeKg)} buckets={buckets} metric="volumeKg" tone="blue" />
      <ProgressOverviewMetric label="Tiempo total" value={totals.durationSeconds ? formatSessionDuration(totals.durationSeconds) : '0 min'} buckets={buckets} metric="durationSeconds" tone="purple" />
      <section className="progress-overview-card progress-muscle-card"><div className="progress-overview-heading"><h2>Grupos musculares</h2><a className="text-button" href="#progress-details">Ver más <ChevronRight size={15} aria-hidden="true" /></a></div>{muscleGroups.length ? <div className="progress-muscle-grid">{muscleGroups.map((group) => { const image = data.exercises.find((exercise) => exercise.muscleGroup === group.muscleGroup)?.imageUrl; return <article className="progress-muscle-tile" key={group.muscleGroup}>{image && <img src={image} alt="" loading="lazy" />}<strong>{group.muscleGroup}</strong><span>{formatVolume(group.volume)}</span></article>; })}</div> : <p className="progress-overview-empty">Completa sesiones para ver el volumen por grupo.</p>}</section>
      <article className="progress-overview-card progress-streak-card"><div className="progress-overview-heading"><h2>Racha de días</h2><Activity size={17} aria-hidden="true" /></div><strong>{streak}</strong><span className="progress-overview-caption">sesiones seguidas</span><div className="progress-overview-week" aria-label="Actividad de esta semana">{weekDays.map((day) => <span key={day.key} className={`${day.completed ? 'is-complete' : ''}${day.planned ? ' is-planned' : ''}`} title={`${day.label}: ${day.completed ? 'completado' : day.planned ? 'previsto' : 'descanso'}`} />)}</div></article>
    </div>
  </section>;
}

function ProgressOverviewMetric({ label, value, buckets, metric, tone }: { label: string; value: string; buckets: ProgressBucket[]; metric: 'volumeKg' | 'durationSeconds'; tone: 'blue' | 'purple' }) {
  return <article className={`progress-overview-card progress-metric-card ${tone}`}><div className="progress-overview-heading"><h2>{label}</h2></div><strong>{value}</strong><ProgressOverviewBars buckets={buckets} metric={metric} tone={tone} /></article>;
}

function ProgressOverviewBars({ buckets, metric, tone }: { buckets: ProgressBucket[]; metric: keyof Pick<ProgressBucket, 'sessions' | 'volumeKg' | 'durationSeconds'>; tone: 'green' | 'blue' | 'purple' }) {
  const max = Math.max(...buckets.map((bucket) => bucket[metric]), 0);
  const labelStep = Math.max(1, Math.ceil(buckets.length / 6));
  return <div className={`progress-overview-bars ${tone}`} role="img" aria-label={`${buckets.reduce((total, bucket) => total + bucket[metric], 0)} ${metric === 'sessions' ? 'entrenamientos' : metric === 'volumeKg' ? 'kilogramos de volumen' : 'segundos de entrenamiento'}`}>
    {buckets.map((bucket, index) => <span key={bucket.key} title={`${bucket.label}: ${bucket[metric]}`}>{bucket[metric] > 0 && <i style={{ height: `${Math.max(8, bucket[metric] / max * 100)}%` }} />}{index % labelStep === 0 || index === buckets.length - 1 ? <small>{bucket.label}</small> : <small aria-hidden="true">&nbsp;</small>}</span>)}
  </div>;
}

export function SessionCalendar({ sessions, trainingDays, exercises, workoutDays }: { sessions: WorkoutSession[]; trainingDays: number[]; exercises: ExerciseDefinition[]; workoutDays: WorkoutDay[] }) {
  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [sessionDetail, setSessionDetail] = useState<WorkoutSession>();
  const cells = useMemo(() => buildCalendarCells(viewMonth), [viewMonth]);
  const completedByDate = useMemo(() => new Map(sessions.filter((session) => session.status === 'completed').sort((a, b) => (a.completedAt ?? a.startedAt).localeCompare(b.completedAt ?? b.startedAt)).map((session) => [session.dateKey, session])), [sessions]);
  const plannedWeekdays = new Set(normalizeTrainingDays(trainingDays));
  const exerciseNames = new Map(exercises.map((exercise) => [exercise.id, exercise.name]));
  const today = dateKey();
  const monthIndex = viewMonth.getFullYear() * 12 + viewMonth.getMonth();
  const currentDate = new Date();
  const currentMonthIndex = currentDate.getFullYear() * 12 + currentDate.getMonth();
  const monthLabel = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(viewMonth);
  const changeMonth = (delta: number): void => {
    setSessionDetail(undefined);
    setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1, 12));
  };
  const detailDay = sessionDetail && workoutDays.find((day) => day.id === sessionDetail.workoutDayId);
  const completedExercises = sessionDetail?.plannedExercises.filter((exercise) => exercise.completed) ?? [];

  return <div className="session-calendar">
<div className="calendar-header">
  <h3 aria-live="polite">{monthLabel}</h3>
    <div className="calendar-nav">
      <button type="button" aria-label="Mes anterior" disabled={monthIndex <= currentMonthIndex - 12} onClick={() => changeMonth(-1)}>
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Mes siguiente" disabled={monthIndex >= currentMonthIndex} onClick={() => changeMonth(1)}>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  </div>
  <div className="calendar-grid" role="group" aria-label={`Calendario de ${monthLabel}`}>{shortDayNames.map((day, index) => <span className="calendar-weekday" key={`${day}-${index}`}>{day}</span>)}{cells.map((cell) => {
    const session = cell.inMonth ? completedByDate.get(cell.dateKey) : undefined;
    const isToday = cell.inMonth && cell.dateKey === today;
    const isPlanned = cell.inMonth && !session && cell.dateKey < today && plannedWeekdays.has(cell.date.getDay());
    const classes = ['calendar-day', !cell.inMonth && 'calendar-day--other-month', session && 'calendar-day--completed', isPlanned && 'calendar-day--planned', isToday && 'calendar-day--today'].filter(Boolean).join(' ');
    return session ? <button type="button" className={classes} key={cell.dateKey} aria-label={`${formatDate(cell.dateKey, { weekday: 'long', day: 'numeric', month: 'long' })}: entrenamiento completado`} aria-pressed={sessionDetail?.id === session.id} onClick={() => setSessionDetail(session)}>{cell.date.getDate()}</button> : <span className={classes} key={cell.dateKey}>{cell.date.getDate()}</span>;
  })}</div>{sessionDetail && <aside className="calendar-detail" aria-live="polite"><strong>{displayWorkoutName(detailDay?.name ?? sessionDetail.workoutDayId)}</strong><span>{formatDate(sessionDetail.dateKey, { day: 'numeric', month: 'long', year: 'numeric' })} · {formatSessionDuration(summarizeSession(sessionDetail, sessions).durationSeconds)}</span>{completedExercises.length > 0 && <ul>{completedExercises.map((exercise) => <li key={exercise.plannedExerciseId}>{exercise.name || exerciseNames.get(exercise.exerciseId)}</li>)}</ul>}</aside>}</div>;
}

function WeeklyTrends({ summary }: { summary: ReturnType<typeof buildWeeklySummary> }) {
  return <section className="progress-card"><h2>Últimas cuatro semanas</h2><p>La semana actual está en curso. La adherencia usa el objetivo de tu rutina actual.</p><div className="weekly-trends-table"><table><thead><tr><th>Desde</th><th>Sesiones</th><th>Adherencia</th><th>Volumen</th></tr></thead><tbody>{summary.trends.map((week) => <tr key={week.week}><td>{formatDate(week.week, { day: 'numeric', month: 'short' })}</td><td>{week.sessions}</td><td>{week.adherencePercent}%</td><td>{formatVolume(week.volumeKg)}</td></tr>)}</tbody></table></div><h3>Fuerza respecto a la semana anterior</h3><p>Carga comparada en el mismo ejercicio y con las mismas repeticiones.</p>{summary.strengthChanges.length ? <ul>{summary.strengthChanges.map((entry) => <li key={entry.exerciseId}>{entry.name}: {entry.previousKg} → {entry.currentKg} kg ({entry.changePercent > 0 ? '+' : ''}{entry.changePercent}%)</li>)}</ul> : <p>Aún no hay series comparables entre ambas semanas.</p>}</section>;
}

function WeeklyReviewCard({ summary, data, onToast }: { summary: ReturnType<typeof buildWeeklySummary>; data: AppData; onToast: (message: string) => void }) {
  const focusLabel = summary.focusTone === 'positive' ? 'Hay margen' : summary.focusTone === 'caution' ? 'Punto a revisar' : 'Siguiente paso';
  const share = (): void => {
    const text = weeklySummaryText(data);
    if (typeof navigator.share === 'function') {
      void navigator.share({ text }).catch(() => undefined);
      return;
    }
    const copy = navigator.clipboard?.writeText(text);
    if (!copy) {
      onToast('No se pudo copiar el resumen');
      return;
    }
    void copy.then(() => onToast('Resumen copiado')).catch(() => onToast('No se pudo copiar el resumen'));
  };
  return <section className="coach-card weekly-review-card"><div className="weekly-review-topline"><div><p className="eyebrow light">para revisar juntos</p><h2>Tu semana, en claro</h2></div><span className="weekly-review-period">{summary.periodLabel}</span></div><p className="weekly-review-feedback">{summary.feedback}</p><div className="weekly-review-facts" aria-label="Resumen de la semana"><div><strong>{summary.completedSessions}/{summary.targetSessions}</strong><span>sesiones</span></div><div><strong>{summary.completedExercises}</strong><span>ejercicios</span></div><div><strong>{formatVolume(summary.volumeKg)}</strong><span>volumen</span></div></div><div className={`weekly-review-focus ${summary.focusTone}`}><Gauge size={17} /><div><strong>{focusLabel}</strong><p>{summary.focus}</p></div></div>{summary.recommendations.length > 0 && <div className="weekly-review-recommendations" aria-label="Recomendaciones para la próxima semana"><p className="eyebrow light">recomendación por ejercicio</p><ul>{summary.recommendations.slice(0, 3).map((recommendation) => <li key={recommendation.exerciseId}><strong>{recommendation.name}</strong><span>{recommendation.title}. {recommendation.detail}</span></li>)}</ul></div>}{summary.energy && <p className="weekly-review-checkin"><Sun size={15} /> Energía {summary.energy === 'high' ? 'alta' : summary.energy === 'low' ? 'baja' : 'normal'}{summary.feeling ? ` · ${summary.feeling}` : ''}</p>}<button type="button" className="text-button" onClick={share}><Share2 size={15} /> Compartir</button></section>;
}

function TrainingSignalsCard({ signals }: { signals: ReturnType<typeof buildWeeklySummary>['signals'] }) {
  if (signals.length === 0) return null;
  return <section className="progress-card signal-card" aria-labelledby="training-signals-title"><div className="section-heading compact"><div><p className="eyebrow">detección temprana</p><h2 id="training-signals-title">Señales a revisar</h2></div><Gauge size={19} /></div><p className="section-description">No son diagnósticos: son patrones del historial para decidir el siguiente ajuste con calma.</p><div className="signal-list">{signals.slice(0, 4).map((signal) => <article className="signal-row" key={`${signal.kind}-${signal.exerciseId}`}><div><strong>{signal.name}</strong><span>{signal.title}</span></div><p>{signal.detail}</p><small>{signal.evidence.sessionCount} sesiones · {signal.evidence.latestDate}</small></article>)}</div></section>;
}

const MetricCard = memo(function MetricCard({ label, value, change, icon }: { label: string; value: string; change: string; icon: React.ReactNode }) { return <article className="metric-card"><div className="metric-label">{icon}<span>{label}</span></div><strong>{value}</strong><small>{change}</small></article>; });

function HistoryPanel({ data }: { data: AppData }) {
  const records = useMemo(() => personalRecords(data.sessions).slice(0, 3), [data.sessions]);
  const muscleVolumes = useMemo(() => muscleGroupVolumes(data).slice(0, 3), [data]);
  const summary = historySummary(data.sessions);
  return <section className="progress-card history-card"><div className="section-heading compact"><div><p className="eyebrow">historial avanzado</p><h2>Lo que está cambiando</h2></div><Trophy size={19} /></div><div className="history-stats"><div><CalendarDays size={16} /><strong>{summary.sessions30}</strong><span>sesiones · 30 días</span></div><div><Layers3 size={16} /><strong>{formatVolume(summary.volume30)}</strong><span>volumen · 30 días</span></div><div><Sparkles size={16} /><strong>{records.length}</strong><span>récords visibles</span></div></div><div className="history-columns"><div><p className="eyebrow">mejores cargas</p>{records.length ? <div className="history-list">{records.map((record) => <div className="history-list-row" key={record.exerciseId}><span>{record.name}</span><strong>{formatWeight(record.load)}{record.reps ? ` · ${record.reps} reps` : ''}</strong></div>)}</div> : <p className="history-empty">Registra peso y repeticiones para ver tus marcas.</p>}</div><div><p className="eyebrow">volumen por grupo</p>{muscleVolumes.length ? <div className="history-list">{muscleVolumes.map((item) => <div className="history-list-row" key={item.muscleGroup}><span>{item.muscleGroup}</span><strong>{formatVolume(item.volume)}</strong></div>)}</div> : <p className="history-empty">Aún no hay volumen calculable.</p>}</div></div><p className="history-caption">Este mes: {summary.currentMonth} sesiones · mes anterior: {summary.previousMonth}.</p></section>;
}
