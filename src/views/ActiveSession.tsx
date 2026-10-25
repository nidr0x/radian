import { useEffect, useRef, useState } from 'react';
import { Check, Dumbbell, Gauge, History, Info, MoreHorizontal, Pause, Plus, RotateCcw, SkipForward, Timer, Trophy, X, ArrowDown } from 'lucide-react';
import { completionActionHint } from '../lib/uiCopy';
import { difficultyOptions, numberOrUndefined } from '../lib/format';
import { createSetLogs } from '../lib/storage';
import { isWorkSet } from '../lib/progression';
import { formatDuration } from '../lib/date';
import { formatExerciseSummary, formatWeight } from '../lib/format';
import { getNextSessionExerciseIndex, isSessionExerciseDeferred } from '../lib/sessionFlow';
import { useRestCountdown } from '../components/useRestCountdown';
import { ExerciseThumb } from '../components/ExerciseThumb';
import { recommendationFor, progressionAction } from '../lib/recommendations';
import type { ExerciseRecord } from '../lib/records';
import type { Difficulty, ExerciseEquipment, ExerciseDefinition, ExerciseSession, SetLog, WorkoutSession } from '../types';

const weightConventions: Record<ExerciseEquipment, string> = {
  dumbbell: 'Mancuernas: registra una sola mancuerna, no la suma de ambas.',
  barbell: 'Barra: registra el total, incluida la barra y los discos de ambos lados.',
  machine: 'Máquina: registra la carga de la pila; en unilateral, la del lado trabajado.',
  cable: 'Polea: registra la carga de un lado; no sumes ambas poleas.',
  bodyweight: 'Peso corporal: registra solo el lastre añadido; déjalo vacío si no añades carga.',
};

export function ActiveSession({ session, restRemaining, restUntil, restExerciseName, onRestartRest, screenWakeLockActive, previousExercise, bestRecord, recommendation, progression, progressionAction: action, alternatives, equipmentAlternatives, exerciseEquipment, onSelectExercise, onDefer, onComplete, onDraft, onSwap, onRest, onUndo, canUndo, onExit }: { session: WorkoutSession; restRemaining: number; restUntil: number | null; restExerciseName?: string; onRestartRest: () => void; screenWakeLockActive: boolean; previousExercise?: ExerciseSession; bestRecord?: ExerciseRecord; recommendation?: ReturnType<typeof recommendationFor>; progression?: string; progressionAction?: ReturnType<typeof progressionAction>; alternatives: ExerciseDefinition[]; equipmentAlternatives: ExerciseDefinition[]; exerciseEquipment?: ExerciseEquipment; onSelectExercise: (index: number) => void; onDefer: () => void; onComplete: (session: WorkoutSession, exercise: ExerciseSession, patch: Partial<ExerciseSession>, startRest: boolean) => void; onDraft: (sessionId: string, plannedExerciseId: string, patch: Partial<ExerciseSession>) => void; onSwap: (replacement: ExerciseDefinition, reason: 'discomfort' | 'equipment') => void; onRest: () => void; onUndo: () => void; canUndo: boolean; onExit: () => void }) {
  const visibleRestRemaining = useRestCountdown(restUntil, restRemaining);
  const exercise = session.plannedExercises[session.activeExerciseIndex];
  const [setLogs, setSetLogs] = useState<SetLog[]>([]);
  const [discomfort, setDiscomfort] = useState(false);
  const [note, setNote] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingDifficulty, setPendingDifficulty] = useState<Difficulty>();
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [equipmentAlternativesOpen, setEquipmentAlternativesOpen] = useState(false);
  const previousActiveIndex = useRef(session.activeExerciseIndex);

  useEffect(() => {
    if (!exercise) return;
    const hasRecordedInputs = exercise.setLogs.some((set) => set.completed || set.weightKg !== undefined || set.actualReps !== undefined);
    const source = hasRecordedInputs ? exercise.setLogs : previousExercise?.setLogs;
    const legacy = hasRecordedInputs ? exercise : previousExercise;
    setSetLogs(createSetLogs(exercise.sets, exercise.repMin, source, legacy, { warmupSets: exercise.warmupSets, defaultActualReps: previousExercise?.setLogs.map((set) => set.actualReps), copyCompleted: !previousExercise || hasRecordedInputs }));
    setDiscomfort(exercise?.discomfort ?? false);
    setNote(exercise?.discomfortNote ?? '');
    setPendingDifficulty(exercise?.difficulty);
    setDetailsOpen(Boolean(exercise?.discomfort || exercise?.discomfortNote));
    setEquipmentAlternativesOpen(false);
  // Reset the editor only when the planned exercise identity changes; depending on
  // the full `exercise` object would rebuild the drafts after each parent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise?.plannedExerciseId, exercise?.exerciseId, exercise?.sets, exercise?.repMin, previousExercise?.plannedExerciseId]);

  useEffect(() => {
    if (previousActiveIndex.current === session.activeExerciseIndex) return;
    previousActiveIndex.current = session.activeExerciseIndex;
    document.getElementById('active-exercise-title')?.focus();
  }, [session.activeExerciseIndex]);

  if (!exercise) return null;
  const completed = session.plannedExercises.filter((item) => item.completed).length;
  const currentExerciseNumber = Math.min(session.activeExerciseIndex + 1, session.plannedExercises.length);
  const progress = Math.round((completed / session.plannedExercises.length) * 100);
  const nextExerciseIndex = getNextSessionExerciseIndex(session);
  const updateSet = (setNumber: number, patch: Partial<SetLog>): void => {
    const nextLogs = setLogs.map((set) => set.setNumber === setNumber ? { ...set, ...patch } : set);
    setSetLogs(nextLogs);
    onDraft(session.id, exercise.plannedExerciseId, { setLogs: nextLogs });
    if (patch.completed === true) onRest();
  };
  const copyPrevious = (): void => {
    if (!previousExercise) return;
    const nextLogs = createSetLogs(exercise.sets, exercise.repMin, previousExercise.setLogs, previousExercise, { warmupSets: exercise.warmupSets, copyCompleted: false });
    setSetLogs(nextLogs);
    onDraft(session.id, exercise.plannedExerciseId, { setLogs: nextLogs });
  };
  const saveExercise = (difficulty: Difficulty): void => {
    setPendingDifficulty(difficulty);
    const completedSets = setLogs.filter((set) => isWorkSet(set) && set.completed);
    const lastSet = completedSets[completedSets.length - 1];
    onComplete(session, exercise, {
      completed: difficulty !== 'incomplete',
      difficulty,
      setLogs,
      actualWeightKg: lastSet?.weightKg,
      actualReps: lastSet?.actualReps,
      discomfort,
      discomfortNote: note || undefined,
    }, true);
  };
  const skipExercise = (): void => onComplete(session, exercise, { completed: false, difficulty: 'incomplete', setLogs, discomfort, discomfortNote: note || undefined }, false);

  return <div className="session-wrap">
<SessionExerciseNavigator session={session} onSelect={onSelectExercise} />
<div className="session-topline">
  <div>
    <p className="eyebrow">sesión en curso</p>
      <strong>Ejercicio {currentExerciseNumber} de {session.plannedExercises.length}</strong>
        <span className="session-completed-count">{completed} completados</span>
        </div>
        <div className="session-progress">
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="session-menu-wrap">
          <button className="icon-button subtle" aria-label="Opciones de la sesión" aria-expanded={sessionMenuOpen} onClick={() => setSessionMenuOpen((value) => !value)}>
            <MoreHorizontal size={19} />
          </button>{sessionMenuOpen && <div className="session-menu">
          <button type="button" onClick={() => { onUndo(); setSessionMenuOpen(false); }} disabled={!canUndo}>
            <RotateCcw size={15} /> Deshacer último</button>
              <button type="button" onClick={() => { skipExercise(); setSessionMenuOpen(false); }}>
                <SkipForward size={15} /> Saltar definitivamente</button>
                  <button type="button" className="danger-action" onClick={() => { setSessionMenuOpen(false); onExit(); }}>
                    <X size={15} /> Salir de la sesión</button>
                    </div>}</div>
                  </div>
    {visibleRestRemaining > 0 && <div className="rest-inline"><Timer size={16} /><span>{restExerciseName ? <>Descanso tras <strong>{restExerciseName}</strong>: {formatDuration(visibleRestRemaining)}.</> : <>Descansa {formatDuration(visibleRestRemaining)} antes del siguiente ejercicio.</>}</span><button onClick={onRestartRest}>Reiniciar</button></div>}
    <article className="active-exercise-card">
<div className="active-card-header">
  <span className="exercise-kicker">ejercicio {session.activeExerciseIndex + 1} / {session.plannedExercises.length}</span>
    <span className="active-status">
      <span className="status-dot" /> {screenWakeLockActive ? 'pantalla activa' : 'guardado en este dispositivo'}</span>
      </div>
      <div className="active-exercise-overview">
        <ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} large />
        <div className="active-exercise-summary">
          <h2 id="active-exercise-title" tabIndex={-1}>{exercise.name}</h2>
            <div className="target-row">
              <div>
                <strong>{exercise.sets}</strong>
                  <span>series de trabajo</span>
                  </div>{exercise.warmupSets > 0 && <div>
                  <strong>{exercise.warmupSets}</strong>
                    <span>calentamiento</span>
                    </div>}<div>
                    <strong>{exercise.repMin}-{exercise.repMax}</strong>
                      <span>repeticiones</span>
                      </div>
                      <div>
                        <strong>{formatDuration(exercise.restSeconds)}</strong>
                          <span>descanso</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="session-equipment-actions">
                      <button className="secondary-button small" type="button" onClick={onDefer}>
                        <Pause size={15} /> Aplazar ejercicio</button>
                          <button className="secondary-button small" type="button" aria-expanded={equipmentAlternativesOpen} aria-controls="session-equipment-alternatives" onClick={() => setEquipmentAlternativesOpen((open) => !open)}>
                            <Dumbbell size={15} /> {equipmentAlternativesOpen ? 'Ocultar alternativas' : 'Equipo ocupado · ver alternativas'}</button>
                            </div>
                            <section className="session-equipment-alternative-panel" hidden={!equipmentAlternativesOpen} id="session-equipment-alternatives" aria-label="Alternativas por equipo ocupado">
                              <strong>Alternativas para esta sesión</strong>
                                <p>El cambio solo afecta a esta sesión; tu rutina queda igual.</p>{equipmentAlternatives.length > 0 ? <div className="alternative-actions">{equipmentAlternatives.map((replacement) => <button type="button" className="secondary-button small" key={replacement.id} onClick={() => { onSwap(replacement, 'equipment'); setEquipmentAlternativesOpen(false); }}>{replacement.name}</button>)}</div> : <p>No hay otra variante de este grupo con el equipo disponible. Puedes aplazarlo y volver más tarde.</p>}</section>
                                  <div className="difficulty-prompt">
                                    <p>¿Cómo ha ido?<span>{completionActionHint}</span>
                                    </p>
                                    <div className="difficulty-grid">{difficultyOptions.map((option) => <button type="button" key={option.value} aria-label={`${option.label}: ${completionActionHint.toLowerCase()}`} className={pendingDifficulty === option.value ? `difficulty-button ${option.value} selected` : `difficulty-button ${option.value}`} onClick={() => saveExercise(option.value)}>
                                      <span>{option.label}</span>
                                        <small>{option.hint}</small>
                                        </button>)}</div>
                                      </div>
                                      <details className="active-insights">
                                        <summary>
                                          <Gauge size={15} /> Ver consejo, historial y marcas</summary>
                                            <div className="active-insights-body">{previousExercise && <p className="last-session-summary">
                                              <History size={14} /> Última vez: {previousExercise.sets} series · {formatExerciseSummary(previousExercise)}</p>}{bestRecord && <p className="personal-record-note">
                                                <Trophy size={14} /> Mejor marca: {formatWeight(bestRecord.maxWeightKg)}{bestRecord.maxWeightReps ? ` · ${bestRecord.maxWeightReps} reps` : ''}</p>}{action && <div className={`progression-note ${action.tone}`}>
                                                  <Gauge size={16} />
                                                  <div>
                                                    <strong>{action.title}</strong>
                                                      <span>{action.detail}</span>
                                                      </div>
                                                    </div>}{progression && !action && <div className={`progression-note ${recommendation?.tone ?? 'neutral'}`}>
                                                    <Gauge size={16} />
                                                    <span>{progression}</span>
                                                    </div>}</div>
                                                  </details>
                                                  <SetLogEditor logs={setLogs} repMin={exercise.repMin} repMax={exercise.repMax} exerciseEquipment={exerciseEquipment} hasPrevious={Boolean(previousExercise)} prefilled={Boolean(previousExercise && setLogs.some((set) => set.actualReps !== undefined || set.weightKg !== undefined))} onChange={updateSet} onCopy={copyPrevious} />
                                                  <button type="button" className="details-toggle" onClick={() => setDetailsOpen((value) => !value)}>
                                                    <Plus size={17} /> {detailsOpen ? 'Ocultar molestias y nota' : 'Añadir molestias o nota'}</button>{detailsOpen && <div className="optional-fields">
                                                      <div className="toggle-field">
                                                        <span>¿Alguna molestia?</span>
                                                          <button type="button" className={discomfort ? 'toggle on' : 'toggle'} aria-pressed={discomfort} onClick={() => { const next = !discomfort; setDiscomfort(next); onDraft(session.id, exercise.plannedExerciseId, { discomfort: next }); }}>
                                                            <span />
                                                          </button>
                                                        </div>
                                                        <label className="full-field">Nota breve <textarea value={note} onChange={(event) => { setNote(event.target.value); onDraft(session.id, exercise.plannedExerciseId, { discomfortNote: event.target.value || undefined }); }} placeholder="¿Qué has notado?" rows={2} />
                                                      </label>{discomfort && <div className="discomfort-panel">
                                                      <strong>Prueba otra variante</strong>
                                                        <span>La rutina original no cambia. Elige una opción del mismo grupo para continuar con menos dudas.</span>{alternatives.length > 0 ? <div className="alternative-actions">{alternatives.map((replacement) => <button type="button" className="secondary-button small" key={replacement.id} onClick={() => onSwap(replacement, 'discomfort')}>{replacement.name}</button>)}</div> : <p>No hay otra variante guardada para este grupo. Puedes bajar la carga o parar y anotar lo ocurrido.</p>}</div>}</div>}</article>
                                                          <div className="session-next">
                                                            <span>Después</span>
                                                              <strong>{nextExerciseIndex === undefined ? 'Fin de la sesión' : session.plannedExercises[nextExerciseIndex].name}</strong>
                                                                <ArrowDown size={17} />
                                                              </div>
                                                              <p className="session-note">
                                                                <Info size={14} /> Solo necesitas marcar cómo ha ido. El registro por series es opcional.</p>
                                                                </div>;
}

function SessionExerciseNavigator({ session, onSelect }: { session: WorkoutSession; onSelect: (index: number) => void }) {
  const activeStepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    activeStepRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [session.activeExerciseIndex]);
  const resolved = session.plannedExercises.filter((exercise) => exercise.completed || Boolean(exercise.completedAt)).length;
  const deferredExercises = session.plannedExercises
    .map((exercise, index) => ({ exercise, index }))
    .filter(({ exercise, index }) => index !== session.activeExerciseIndex && isSessionExerciseDeferred(exercise))
    .sort((a, b) => (a.exercise.deferredAt ?? '').localeCompare(b.exercise.deferredAt ?? ''));
  return <nav className="session-exercise-navigator" aria-label="Ejercicios de la sesión">
    <div className="session-exercise-navigator-heading"><div><strong>Ejercicios de la sesión</strong><span>{resolved} de {session.plannedExercises.length} con resultado</span></div>{deferredExercises.length > 0 && <button type="button" className="session-deferred-return" aria-label={'Volver a ' + deferredExercises[0].exercise.name + '. Hay ' + deferredExercises.length + ' ejercicios aplazados'} onClick={() => onSelect(deferredExercises[0].index)}><RotateCcw size={14} aria-hidden="true" /> Volver a aplazados · {deferredExercises.length}</button>}</div>
    <ol className="session-exercise-steps">{session.plannedExercises.map((exercise, index) => {
      const skipped = !exercise.completed && exercise.difficulty === 'incomplete' && Boolean(exercise.completedAt);
      const completed = exercise.completed && !skipped;
      const deferred = isSessionExerciseDeferred(exercise);
      const current = index === session.activeExerciseIndex;
      const status = current ? 'Ahora' : deferred ? 'Aplazado' : skipped ? 'Saltado' : completed ? 'Hecho' : 'Pendiente';
      return <li key={exercise.plannedExerciseId} aria-setsize={session.plannedExercises.length} aria-posinset={index + 1}>
        <button ref={current ? activeStepRef : undefined} type="button" className={`session-exercise-step${current ? ' is-active' : ''}${completed ? ' is-complete' : ''}${skipped ? ' is-skipped' : ''}${deferred ? ' is-deferred' : ''}`} aria-current={current ? 'step' : undefined} aria-label={`${exercise.name}: ${status}${current ? ', ejercicio actual' : ', seleccionar ejercicio'}`} onClick={() => onSelect(index)}>
          <span className="session-exercise-step-index">{completed ? <Check size={14} /> : skipped ? <SkipForward size={14} /> : deferred ? <Pause size={14} /> : index + 1}</span>
          <span className="session-exercise-step-copy"><span className="session-exercise-step-name">{exercise.name}</span><small>{status}</small></span>
        </button>
      </li>;
    })}</ol>
  </nav>;
}

function SetLogEditor({ logs, repMin, repMax, exerciseEquipment, hasPrevious, prefilled, onChange, onCopy }: { logs: SetLog[]; repMin: number; repMax: number; exerciseEquipment?: ExerciseEquipment; hasPrevious: boolean; prefilled: boolean; onChange: (setNumber: number, patch: Partial<SetLog>) => void; onCopy: () => void }) {
  const weightConvention = exerciseEquipment ? weightConventions[exerciseEquipment] : undefined;
  const nextSet = logs.find((set) => !set.completed);
  const completeNext = (): void => {
    if (!nextSet) return;
    onChange(nextSet.setNumber, { completed: true, actualReps: nextSet.actualReps ?? (nextSet.phase === 'warmup' ? repMin : repMax) });
  };
  const focusNextSetInput = (input: HTMLInputElement): void => {
    const row = input.closest('.set-log-row');
    const nextInput = input.dataset.setField === 'weight'
      ? row?.querySelector<HTMLInputElement>('[data-set-field="reps"]')
      : row?.nextElementSibling?.querySelector<HTMLInputElement>('[data-set-field="weight"]');
    if (nextInput) nextInput.focus();
    else input.blur();
  };
  return <section className="set-log-card">
<div className="set-log-heading">
  <div>
    <p className="eyebrow">registro de hoy</p>
      <strong>Calentamiento y series de trabajo</strong>{prefilled && <span className="prefill-note">
        <History size={13} /> Último registro cargado</span>}</div>
          <div className="set-log-heading-actions">{nextSet && <button className="set-quick-action" type="button" onClick={completeNext}>
            <Check size={14} /> Completar siguiente</button>}{hasPrevious && <button className="text-button" type="button" onClick={onCopy}>Repetir último</button>}</div>
            </div>{weightConvention && <p id="set-weight-convention" className="set-weight-convention" role="note">
            <Info size={14} aria-hidden="true" />{weightConvention}</p>}<div className="set-log-list">{logs.map((set, index) => { const warmup = set.phase === 'warmup'; return <div className={`${set.completed ? 'set-log-row is-complete' : 'set-log-row'}${warmup ? ' is-warmup' : ''}`} key={set.setNumber}>
              <span className="set-log-number">{String(set.setNumber).padStart(2, '0')}</span>
                <span className="set-log-target">{warmup ? 'Calentamiento' : 'Objetivo'}<strong>{warmup ? `${repMin} reps` : `${repMin}-${repMax}`}</strong>
                </span>
                <div className="set-weight-input-group" role="group" aria-label={`Peso de la serie ${set.setNumber}`}>
                  <label>Peso<input aria-label={`Peso serie ${set.setNumber}${warmup ? ' calentamiento' : ''}`} aria-describedby={weightConvention ? 'set-weight-convention' : undefined} inputMode="decimal" enterKeyHint="next" data-set-field="weight" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); focusNextSetInput(event.currentTarget); } }} value={set.weightKg ?? ''} onChange={(event) => onChange(set.setNumber, { weightKg: numberOrUndefined(event.target.value) })} placeholder="kg" />
                </label>
                <div className="set-weight-stepper">
                  <button type="button" aria-label={`Restar 2,5 kg al peso de la serie ${set.setNumber}`} disabled={(set.weightKg ?? 0) <= 0} onClick={() => onChange(set.setNumber, { weightKg: Math.max(0, (set.weightKg ?? 0) - 2.5) })}>−</button>
                    <button type="button" aria-label={`Sumar 2,5 kg al peso de la serie ${set.setNumber}`} onClick={() => onChange(set.setNumber, { weightKg: (set.weightKg ?? 0) + 2.5 })}>+</button>
                    </div>
                  </div>
                  <label>Reps<input aria-label={`Repeticiones serie ${set.setNumber}${warmup ? ' calentamiento' : ''}`} inputMode="numeric" enterKeyHint={index === logs.length - 1 ? 'done' : 'next'} data-set-field="reps" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); focusNextSetInput(event.currentTarget); } }} value={set.actualReps ?? ''} onChange={(event) => onChange(set.setNumber, { actualReps: numberOrUndefined(event.target.value) })} placeholder="reps" />
                </label>
                <button type="button" className={set.completed ? 'set-complete selected' : 'set-complete'} aria-label={set.completed ? `Desmarcar serie ${set.setNumber}` : `Marcar serie ${set.setNumber}`} aria-pressed={set.completed} onClick={() => onChange(set.setNumber, { completed: !set.completed })}>
                  <Check size={16} />
                </button>
              </div>; })}</div>
            </section>;
}
