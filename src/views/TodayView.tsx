import { memo, useMemo, useState } from 'react';
import { Activity, BarChart3, CalendarDays, Check, ChevronRight, Clipboard, Dumbbell, Gauge, Info, Layers3, MoreHorizontal, Pencil, Play, RotateCcw, Timer, Trophy } from 'lucide-react';
import { currentWeekday, dateKey, dayNames, formatDate } from '../lib/date';
import { exerciseGuidance } from '../data/initialPlan';
import { progressionCue, progressionAction, recommendationFor } from '../lib/recommendations';
import { bestRecordForExercise } from '../lib/records';
import { compatibleAlternatives } from '../lib/exercises';
import { summarizeSession, type SessionSummary } from '../lib/sessionSummary';
import { sessionAdaptation } from '../lib/sessionAdaptation';
import { todayPrimaryAction } from '../lib/uiCopy';
import { scheduledWorkoutDays } from '../lib/date';
import { buildWeekDays, getLatestWorkoutStreak, muscleGroupVolumes } from '../lib/trainingStats';
import { latestExercise } from '../lib/exerciseQueries';
import { displayWorkoutName, formatExerciseSummary, formatSessionDuration, formatVolume, formatWeight } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { ExercisePreview, type ExercisePreviewCue } from '../components/ExercisePreview';
import { ExerciseDetailSheet } from '../components/ExerciseDetailSheet';
import { ActiveSession } from './ActiveSession';
import { SessionCalendar } from './ProgressView';
import type { AppData, Energy, ExerciseDefinition, PlannedExercise, SessionReadiness, Soreness, View, WorkoutDay, WorkoutSession, ExerciseSession } from '../types';

export function TodayView({ data, todayDay, activeSession, onSelectExercise, onDeferExercise, restRemaining, restUntil, restExerciseName, onRestartRest, screenWakeLockActive, onStart, onDismissRestEnded, onComplete, onDraft, onSwapExercise, onQueueRecovery, onRemoveRecoveryExercise, onRest, onNavigate, onUndo, canUndo, onExit, onHelp }: {
  data: AppData;
  todayDay?: WorkoutDay;
  activeSession?: WorkoutSession;
  onSelectExercise: (sessionId: string, index: number) => void;
  onDeferExercise: (session: WorkoutSession) => void;
  restRemaining: number;
  restUntil: number | null;
  restExerciseName?: string;
  onRestartRest: () => void;
  screenWakeLockActive: boolean;
  onStart: (day: WorkoutDay, readiness?: SessionReadiness) => void;
  onDismissRestEnded: () => void;
  onComplete: (session: WorkoutSession, exercise: ExerciseSession, patch: Partial<ExerciseSession>, startRest: boolean) => void;
  onDraft: (sessionId: string, plannedExerciseId: string, patch: Partial<ExerciseSession>) => void;
  onSwapExercise: (sessionId: string, plannedExerciseId: string, replacement: ExerciseDefinition, reason: 'discomfort' | 'equipment') => void;
  onQueueRecovery: (sessionId: string) => void;
  onRemoveRecoveryExercise: (sessionId: string, recoveryExerciseId: string) => void;
  onRest: () => void;
  onNavigate: (view: View) => void;
  onUndo: () => void;
  canUndo: boolean;
  onExit: () => void;
  onHelp: () => void;
}) {
  const [detailExercise, setDetailExercise] = useState<PlannedExercise>();
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [readiness, setReadiness] = useState<SessionReadiness>({ energy: 'normal', soreness: 'none' });
  const [selectedWorkoutDayId, setSelectedWorkoutDayId] = useState<string>();
  const activeExerciseNumber = activeSession ? Math.min(activeSession.activeExerciseIndex + 1, activeSession.plannedExercises.length) : 0;
  const scheduledDays = scheduledWorkoutDays(data.plan.days, data.profile.trainingDays);
  const defaultWorkoutDay = todayDay ?? scheduledDays.find((item) => item.weekday > currentWeekday()) ?? scheduledDays[0];
  const selectedWorkoutDay = scheduledDays.find((item) => item.id === selectedWorkoutDayId);
  const workoutDay = activeSession
    ? data.plan.days.find((item) => item.id === activeSession.workoutDayId) ?? defaultWorkoutDay
    : selectedWorkoutDay ?? defaultWorkoutDay;
  const isAlternativeWorkout = !activeSession && workoutDay.id !== defaultWorkoutDay.id;
  const plannedExercises = workoutDay.exercises.filter((exercise) => exercise.active);
  const plannedSets = plannedExercises.reduce((total, exercise) => total + exercise.sets, 0);
  const displayedExerciseCount = activeSession?.plannedExercises.length ?? plannedExercises.length;
  const doneToday = data.sessions.some((session) => session.dateKey === dateKey() && session.status === 'completed');
  const latestCompletedToday = data.sessions.filter((session) => session.dateKey === dateKey() && session.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
  const completedSummary = latestCompletedToday ? summarizeSession(latestCompletedToday, data.sessions) : undefined;
  const completedExerciseComparisons = useMemo(() => latestCompletedToday ? sessionExerciseComparisons(latestCompletedToday, data.sessions) : [], [data.sessions, latestCompletedToday]);
  const pendingRecoveryItems = data.sessions.flatMap((session) => (session.recoveryExercises ?? []).map((exercise) => ({ sessionId: session.id, exercise })));
  const primaryAction = todayPrimaryAction(doneToday);

  const previousExercise = activeSession ? latestExercise(data.sessions, activeSession.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId) : undefined;
  const currentRecommendation = activeSession ? recommendationFor(activeSession.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId ?? '', data.sessions) : undefined;
  const currentExercise = activeSession?.plannedExercises[activeSession.activeExerciseIndex];
  const currentProgressionCue = activeSession && currentExercise ? progressionCue(currentExercise.exerciseId, data.sessions, currentExercise) : undefined;
  const currentProgressionAction = activeSession && currentExercise ? progressionAction(currentExercise.exerciseId, data.sessions, currentExercise) : undefined;
  const activeExerciseId = activeSession?.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId ?? '';
  const activeExerciseEquipment = data.exercises.find((exercise) => exercise.id === activeExerciseId)?.equipment;
  const currentAlternatives = activeSession ? alternativeExercises(data, activeExerciseId) : [];
  const equipmentAlternatives = activeSession ? alternativeExercises(data, activeExerciseId, true) : [];

  return <><section className={activeSession ? 'view-section today-view session-active-view' : 'view-section today-view'}>
    <PageHeader eyebrow={formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })} title={activeSession ? 'Sigue a tu ritmo.' : <><span>Lo que toca </span><em>hoy.</em></>} />
    <section className={activeSession ? 'today-hero session-active-hero' : 'today-hero'}>
      <div className="hero-art" aria-hidden="true"><img src={workoutDay.exercises[0]?.imageUrl ?? '/exercises/atlas-push.webp'} alt="" /></div>
      <div className="hero-orbit"><span>{data.profile.gym || 'TU GIMNASIO'}</span><Dumbbell size={29} /></div>
      <div className="hero-copy">
        <p className="eyebrow light">{activeSession ? 'sesión en curso' : isAlternativeWorkout ? 'sesión elegida para hoy' : doneToday ? 'hecho por hoy' : workoutDay.weekday === currentWeekday() ? 'entrenamiento de hoy' : 'siguiente sesión'}</p>
        <h2>{displayWorkoutName(workoutDay.name)}</h2>
        {!activeSession && <label className="today-workout-picker"><span>Entrenamiento para hoy</span><select value={workoutDay.id} onChange={(event) => setSelectedWorkoutDayId(event.currentTarget.value)}>{scheduledDays.map((dayOption) => <option key={dayOption.id} value={dayOption.id}>{displayWorkoutName(dayOption.name)}</option>)}</select></label>}
        <p>{workoutDay.focus} · {displayedExerciseCount} ejercicios / ~{data.profile.sessionMinutes} min</p>
      </div>
      <div className="hero-progress"><strong>{activeSession ? `${activeExerciseNumber}/${activeSession.plannedExercises.length}` : doneToday ? '✓' : String(plannedExercises.length)}</strong><span>{activeSession ? 'ejercicio actual' : doneToday ? 'sesión guardada' : 'bloques'}</span></div>
      <div className="hero-actions">{!activeSession && <button className="primary-button start-button" type="button" onClick={() => setReadinessOpen(true)}><Play size={18} fill="currentColor" /> {primaryAction.label}</button>}<button className="hero-icon-button" type="button" aria-label="Ver rutina" onClick={() => onNavigate('routine')}><Clipboard size={19} /></button><button className="hero-icon-button" type="button" aria-label="Ayuda" onClick={onHelp}><MoreHorizontal size={21} /></button></div>
    </section>
    {!activeSession && readinessOpen && <ReadinessPrompt value={readiness} onChange={setReadiness} onSkip={() => { setReadinessOpen(false); onDismissRestEnded(); onStart(workoutDay); }} onStart={() => { setReadinessOpen(false); onDismissRestEnded(); onStart(workoutDay, readiness); }} />}
    {!activeSession && <TodayStats sessions={data.sessions} exerciseCount={plannedExercises.length} setCount={plannedSets} sessionMinutes={data.profile.sessionMinutes} />}
    {activeSession ? <>
<SessionAdaptationNotice readiness={activeSession.readiness} />
<ActiveSession session={activeSession} restRemaining={restRemaining} restUntil={restUntil} restExerciseName={restExerciseName} onRestartRest={onRestartRest} screenWakeLockActive={screenWakeLockActive} previousExercise={previousExercise} bestRecord={bestRecordForExercise(data.sessions, activeSession.plannedExercises[activeSession.activeExerciseIndex]?.exerciseId ?? '')} recommendation={currentRecommendation} progression={currentProgressionCue} progressionAction={currentProgressionAction} alternatives={currentAlternatives} equipmentAlternatives={equipmentAlternatives} exerciseEquipment={activeExerciseEquipment} onSelectExercise={(index) => onSelectExercise(activeSession.id, index)} onDefer={() => onDeferExercise(activeSession)} onComplete={onComplete} onDraft={onDraft} onSwap={(replacement, reason) => onSwapExercise(activeSession.id, activeSession.plannedExercises[activeSession.activeExerciseIndex].plannedExerciseId, replacement, reason)} onRest={onRest} onUndo={onUndo} canUndo={canUndo} onExit={onExit} /> </> : <>
      {completedSummary && latestCompletedToday && <CompletedSessionSummary session={latestCompletedToday} summary={completedSummary} comparisons={completedExerciseComparisons} onQueueRecovery={onQueueRecovery} onViewProgress={() => onNavigate('progress')} />}
      {pendingRecoveryItems.length > 0 && <RecoveryQueueCard items={pendingRecoveryItems} onRemove={onRemoveRecoveryExercise} />}
      <section className="training-plan" aria-labelledby="training-plan-title">
      <div className="section-heading plan-heading">
        <div>
          <p className="eyebrow">el plan</p>
          <h2 id="training-plan-title">{isAlternativeWorkout ? 'Sesión elegida para hoy' : workoutDay.weekday === currentWeekday() ? 'Tu sesión' : 'Próximo entrenamiento'}</h2>
          <div className="plan-summary" aria-label="Resumen del entrenamiento">
            <span><Dumbbell size={16} aria-hidden="true" /> {plannedExercises.length} ejercicios</span>
            <span><Layers3 size={16} aria-hidden="true" /> {plannedSets} series</span>
            <span><Timer size={16} aria-hidden="true" /> ~{data.profile.sessionMinutes} min</span>
          </div>
        </div>
                    <button className="text-button plan-edit-button" type="button" onClick={() => onNavigate('routine')}>
                      <Pencil size={17} aria-hidden="true" /> Editar rutina <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  </div>
        <p className="today-start-hint plan-info"><Info size={17} aria-hidden="true" /><span>{primaryAction.hint}</span></p>
        <div className="exercise-list plan-exercise-list">{plannedExercises.map((exercise, index) => <ExercisePreview key={exercise.id} exercise={exercise} index={index} muscleGroup={data.exercises.find((item) => item.id === exercise.exerciseId)?.muscleGroup} cue={exercisePreviewCue(data, exercise)} onOpenDetails={() => setDetailExercise(exercise)} />)}</div>
      </section>
      <TodayDashboardAside data={data} onNavigate={onNavigate} />

    </>}
  </section>{detailExercise && <ExerciseDetailSheet exercise={detailExercise} muscleGroup={data.exercises.find((item) => item.id === detailExercise.exerciseId)?.muscleGroup} guidance={exerciseGuidance[detailExercise.exerciseId]} recommendation={recommendationFor(detailExercise.exerciseId, data.sessions)} progressionAction={progressionAction(detailExercise.exerciseId, data.sessions, detailExercise)} lastSession={latestExercise(data.sessions, detailExercise.exerciseId)} onClose={() => setDetailExercise(undefined)} />}</>;
}

function TodayStats({ sessions, exerciseCount, setCount, sessionMinutes }: { sessions: WorkoutSession[]; exerciseCount: number; setCount: number; sessionMinutes: number }) {
  const monthKey = dateKey().slice(0, 7);
  const monthSessions = sessions.filter((session) => session.status === 'completed' && session.dateKey.startsWith(monthKey));
  return <section className="dashboard-stats" aria-label="Resumen de actividad">
    <div className="stat-card"><span className="stat-icon"><Dumbbell size={19} /></span><strong>{exerciseCount}</strong><span>ejercicios hoy</span></div>
    <div className="stat-card"><span className="stat-icon"><Layers3 size={19} /></span><strong>{setCount}</strong><span>series en total</span></div>
    <div className="stat-card"><span className="stat-icon"><Timer size={19} /></span><strong>~{sessionMinutes} min</strong><span>tiempo estimado</span></div>
    <div className="stat-card"><span className="stat-icon"><BarChart3 size={19} /></span><strong>{monthSessions.length}</strong><span>entrenamientos este mes</span></div>
  </section>;
}

const TodayDashboardAside = memo(function TodayDashboardAside({ data, onNavigate }: { data: AppData; onNavigate: (view: View) => void }) {
  const monthSessions = useMemo(() => {
    const monthKey = dateKey().slice(0, 7);
    return data.sessions.filter((session) => session.status === 'completed' && session.dateKey.startsWith(monthKey));
  }, [data.sessions]);
  const monthSummary = useMemo(() => monthSessions.reduce((total, session) => {
    const summary = summarizeSession(session);
    return { volumeKg: total.volumeKg + summary.volumeKg, durationSeconds: total.durationSeconds + summary.durationSeconds };
  }, { volumeKg: 0, durationSeconds: 0 }), [monthSessions]);
  const weekDays = useMemo(() => buildWeekDays(data.profile.trainingDays, data.sessions), [data.sessions, data.profile.trainingDays]);
  const streak = useMemo(() => getLatestWorkoutStreak(data.profile.trainingDays, data.sessions), [data.sessions, data.profile.trainingDays]);
  const completedWeekdays = weekDays.filter((day) => day.completed).map((day) => dayNames[new Date(`${day.key}T12:00:00`).getDay()]);
  const completedWeekdayLabel = completedWeekdays.length === 0
    ? 'ningún entrenamiento completado'
    : `${completedWeekdays.length > 1 ? `${completedWeekdays.slice(0, -1).join(', ')} y ${completedWeekdays.at(-1)}` : completedWeekdays[0]} completado${completedWeekdays.length === 1 ? '' : 's'}`;
  const plannedDaysCount = weekDays.filter((day) => day.planned).length;
  return <aside className="today-dashboard-aside" aria-label="Resumen y calendario">
    <section className="progress-card home-streak-card">
      <div className="section-heading compact"><div><p className="eyebrow">constancia</p><h2>Racha de sesiones</h2></div><Activity size={19} /></div>
      <div className="home-streak-reading"><strong>{streak}</strong><span>sesiones seguidas</span></div>
      <div className="home-week-dots" role="img" aria-label={`Semana: ${completedWeekdayLabel} de ${plannedDaysCount} planificados`}>{weekDays.map((day) => <span key={day.key} className={`${day.completed ? 'is-complete' : ''}${day.planned ? ' is-planned' : ''}`} title={`${day.label}: ${day.completed ? 'completado' : day.planned ? 'previsto' : 'descanso'}`} />)}</div>
      <div className="home-week-labels" aria-hidden="true">{weekDays.map((day) => <span key={day.key}>{day.label}</span>)}</div>
    </section>
    <section className="progress-card home-month-card">
      <div className="section-heading compact"><div><p className="eyebrow">este mes</p><h2>Progreso del mes</h2></div><button type="button" className="text-button" onClick={() => onNavigate('progress')}>Ver detalle <ChevronRight size={15} /></button></div>
      <div className="home-month-metrics"><div><span>Entrenamientos</span><strong>{monthSessions.length}</strong></div><div><span>Volumen total</span><strong>{formatVolume(monthSummary.volumeKg)}</strong></div><div><span>Tiempo total</span><strong>{monthSummary.durationSeconds ? formatSessionDuration(monthSummary.durationSeconds) : '0 min'}</strong></div></div>
    </section>
    <HomeMuscleGroupsCard data={data} onNavigate={onNavigate} />
    <section className="progress-card home-calendar-card"><div className="section-heading compact"><div><p className="eyebrow">historial</p><h2>Calendario</h2></div><CalendarDays size={19} /></div><SessionCalendar sessions={data.sessions} trainingDays={data.profile.trainingDays} exercises={data.exercises} workoutDays={data.plan.days} /></section>
    <blockquote className="home-quote-card"><span aria-hidden="true">“</span><p>La disciplina de hoy<br />es la libertad de mañana.</p></blockquote>
  </aside>;
});

function HomeMuscleGroupsCard({ data, onNavigate }: { data: AppData; onNavigate: (view: View) => void }) {
  const muscleGroups = useMemo(() => muscleGroupVolumes(data).slice(0, 3), [data]);
  return <section className="progress-card home-muscle-card"><div className="section-heading compact"><div><p className="eyebrow">actividad</p><h2>Grupos musculares</h2></div><button type="button" className="text-button" onClick={() => onNavigate('progress')}>Ver más <ChevronRight size={15} /></button></div>{muscleGroups.length ? <div className="home-muscle-grid">{muscleGroups.map((group) => { const image = data.exercises.find((exercise) => exercise.muscleGroup === group.muscleGroup)?.imageUrl; return <article className="home-muscle-tile" key={group.muscleGroup}>{image && <img src={image} alt="" loading="lazy" />}<strong>{group.muscleGroup}</strong><span>{formatVolume(group.volume)}</span></article>; })}</div> : <p className="home-muscle-empty">Completa sesiones para ver el volumen por grupo.</p>}</section>;
}

function ReadinessPrompt({ value, onChange, onSkip, onStart }: { value: SessionReadiness; onChange: (value: SessionReadiness) => void; onSkip: () => void; onStart: () => void }) {
  const energyOptions: Array<{ value: Energy; label: string }> = [
    { value: 'low', label: 'Baja' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'Alta' },
  ];
  const sorenessOptions: Array<{ value: Soreness; label: string }> = [
    { value: 'none', label: 'Ninguna' }, { value: 'some', label: 'Algo' }, { value: 'high', label: 'Mucha' },
  ];
  const choices = (options: Array<{ value: Energy | Soreness; label: string }>, selected: Energy | Soreness, update: (value: Energy | Soreness) => void) => options.map((option) => <button key={option.value} className={selected === option.value ? 'readiness-choice selected' : 'readiness-choice'} type="button" aria-pressed={selected === option.value} onClick={() => update(option.value)}>{option.label}</button>);
  return <section className="readiness-panel" aria-labelledby="readiness-title">
<div>
  <p className="eyebrow">check-in rápido · opcional</p>
    <h3 id="readiness-title">¿Cómo llegas hoy?</h3>
      <p>Radian usará estas sensaciones para ajustar el volumen y el descanso de esta sesión.</p>
      </div>
      <div className="readiness-group">
        <span>Energía</span>
          <div className="readiness-choices">{choices(energyOptions, value.energy, (next) => onChange({ ...value, energy: next as Energy }))}</div>
          </div>
          <div className="readiness-group">
            <span>Molestias musculares</span>
              <div className="readiness-choices">{choices(sorenessOptions, value.soreness, (next) => onChange({ ...value, soreness: next as Soreness }))}</div>
              </div>
              <div className="readiness-actions">
                <button className="secondary-button small" type="button" onClick={onSkip}>Empezar sin responder</button>
                  <button className="primary-button small" type="button" onClick={onStart}>Guardar y empezar</button>
                  </div>
                </section>;
}

function SessionAdaptationNotice({ readiness }: { readiness?: SessionReadiness }) {
  const adaptation = sessionAdaptation(readiness);
  if (adaptation.mode === 'normal') return null;
  return <section className={`session-adaptation-notice ${adaptation.mode}`} role="status"><Gauge size={17} /><div><strong>{adaptation.label}</strong><span>{adaptation.detail}</span></div></section>;
}

interface SessionExerciseComparison {
  plannedExerciseId: string;
  exerciseId: string;
  name: string;
  previous?: { dateKey: string; result: string };
  currentResult: string;
  nextAction?: ReturnType<typeof progressionAction>;
}

interface RecoveryQueueItem { sessionId: string; exercise: PlannedExercise }

function RecoveryQueueCard({ items, onRemove }: { items: RecoveryQueueItem[]; onRemove: (sessionId: string, exerciseId: string) => void }) {
  return <section className="recovery-queue" aria-labelledby="recovery-queue-title">
    <div className="recovery-queue-heading"><div><p className="eyebrow">para tu próxima sesión</p><h2 id="recovery-queue-title">Ejercicios pendientes</h2></div><span>{items.length}</span></div>
    <p>Se añadirán al siguiente entrenamiento que empieces.</p>
    <ul>{items.map(({ sessionId, exercise }) => <li key={`${sessionId}-${exercise.id}`}><span>{exercise.name}</span><button className="text-button" type="button" onClick={() => onRemove(sessionId, exercise.id)}>Quitar</button></li>)}</ul>
  </section>;
}

function CompletedSessionSummary({ session, summary, comparisons, onQueueRecovery, onViewProgress }: { session: WorkoutSession; summary: SessionSummary; comparisons: SessionExerciseComparison[]; onQueueRecovery: (sessionId: string) => void; onViewProgress: () => void }) {
  const allExercisesCompleted = summary.completedExercises === summary.totalExercises;
  const pendingExercises = summary.totalExercises - summary.completedExercises - summary.skippedExercises.length;
  const skippedLabel = summary.skippedExercises.length === 1 ? '1 ejercicio saltado' : `${summary.skippedExercises.length} ejercicios saltados`;
  const statusMessage = allExercisesCompleted
    ? 'Sesión completa. Ya tienes una referencia para la próxima.'
    : summary.skippedExercises.length > 0
      ? `Sesión cerrada con ${skippedLabel}${pendingExercises > 0 ? ` y ${pendingExercises} pendiente${pendingExercises === 1 ? '' : 's'}` : ''}.`
      : `Sesión cerrada con ${pendingExercises} ejercicio${pendingExercises === 1 ? '' : 's'} pendiente${pendingExercises === 1 ? '' : 's'}.`;
  return <section className="completed-summary" aria-labelledby="completed-summary-title">
    <div className="completed-summary-heading"><div><p className="eyebrow">sesión guardada</p><h2 id="completed-summary-title">Buen trabajo.</h2></div><span className="completed-summary-mark"><Check size={18} /></span></div>
    <div className="session-summary-grid"><div><Timer size={16} /><strong>{formatSessionDuration(summary.durationSeconds)}</strong><span>duración</span></div><div><Dumbbell size={16} /><strong>{summary.completedExercises}/{summary.totalExercises}</strong><span>ejercicios</span></div><div><Check size={16} /><strong>{summary.completedWorkSets}</strong><span>series de trabajo</span></div><div><Layers3 size={16} /><strong>{summary.volumeKg > 0 ? formatVolume(summary.volumeKg) : 'Sin carga'}</strong><span>volumen estimado</span></div></div>
    {summary.skippedExercises.length > 0 && <div className="summary-skipped"><p className="eyebrow">ejercicios saltados</p><ul>{summary.skippedExercises.map((exercise) => <li key={exercise.exerciseId}>{exercise.name}</li>)}</ul></div>}
    {summary.skippedExercises.length > 0 && <div className="summary-recovery-action">{session.recoveryExercises?.length ? <p role="status">Guardados para la próxima sesión.</p> : <><p>¿Quieres recuperarlos en tu próximo entrenamiento?</p><button className="secondary-button small" type="button" onClick={() => onQueueRecovery(session.id)}><RotateCcw size={15} /> Añadir a próxima sesión</button></>}</div>}
    {summary.records.length > 0 && <div className="summary-records"><p className="eyebrow">marcas de hoy</p>{summary.records.map((record) => <div className="summary-record" key={record.exerciseId}><Trophy size={15} /><span><strong>{record.name}</strong>{record.event.kind === 'first' ? `Primera marca · ${formatWeight(record.event.weightKg)}` : record.event.kind === 'weight' ? `Nuevo peso · ${formatWeight(record.event.weightKg)}` : `Nuevo volumen · ${formatWeight(record.event.weightKg)}`}</span></div>)}</div>}
    {comparisons.length > 0 && <div className="summary-exercise-comparisons"><p className="eyebrow">comparación por ejercicio</p><ul>{comparisons.map((comparison) => <li className="summary-exercise-comparison" key={comparison.plannedExerciseId}><strong className="summary-exercise-name">{comparison.name}</strong><div className="summary-exercise-values"><p><span>Última vez{comparison.previous ? ` · ${formatDate(comparison.previous.dateKey, { day: 'numeric', month: 'short' })}` : ''}</span><strong>{comparison.previous?.result ?? 'Sin sesión previa'}</strong></p><p><span>Hoy</span><strong>{comparison.currentResult}</strong></p></div><div className="summary-exercise-next"><Gauge size={14} aria-hidden="true" /><span><small>Próxima sesión</small><strong>{comparison.nextAction?.title.replace(/^Próxima vez:\s*/, '') ?? 'Repite el rango previsto'}</strong>{comparison.nextAction && <span>{comparison.nextAction.detail}</span>}</span></div></li>)}</ul></div>}
    <div className="completed-summary-footer"><span>{statusMessage}</span><button className="text-button" type="button" onClick={onViewProgress}>Ver progreso <ChevronRight size={15} /></button></div>
  </section>;
}

function sessionExerciseComparisons(session: WorkoutSession, history: WorkoutSession[]): SessionExerciseComparison[] {
  const completedHistory = history.filter((item) => item.id !== session.id && item.status === 'completed').sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt));
  return session.plannedExercises.filter((exercise) => exercise.completed).map((exercise) => {
    const previousSession = completedHistory.find((item) => item.plannedExercises.some((previous) => previous.exerciseId === exercise.exerciseId && previous.completed));
    const previousExercise = previousSession?.plannedExercises.find((previous) => previous.exerciseId === exercise.exerciseId && previous.completed);
    return {
      plannedExerciseId: exercise.plannedExerciseId,
      exerciseId: exercise.exerciseId,
      name: exercise.name,
      previous: previousSession && previousExercise ? { dateKey: previousSession.dateKey, result: formatExerciseSummary(previousExercise) } : undefined,
      currentResult: formatExerciseSummary(exercise),
      nextAction: progressionAction(exercise.exerciseId, history, exercise),
    };
  });
}

function exercisePreviewCue(data: AppData, exercise: PlannedExercise): ExercisePreviewCue {
  const last = latestExercise(data.sessions, exercise.exerciseId);
  const action = progressionAction(exercise.exerciseId, data.sessions, exercise);
  return {
    last: last ? formatExerciseSummary(last) : undefined,
    next: action ? action.title.replace(/^Próxima vez:\s*/, '') : undefined,
    hint: action?.detail,
  };
}

function alternativeExercises(data: AppData, exerciseId: string, differentEquipment = false): ExerciseDefinition[] {
  const current = data.exercises.find((exercise) => exercise.id === exerciseId);
  if (!current) return [];
  const availableEquipment = differentEquipment
    ? data.profile.availableEquipment.filter((equipment) => equipment !== current.equipment)
    : data.profile.availableEquipment;
  return compatibleAlternatives(data.exercises, exerciseId, availableEquipment).slice(0, 3);
}
