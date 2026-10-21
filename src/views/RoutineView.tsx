import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Dumbbell, Gauge, History, Layers3, Maximize2, Minimize2, MoreHorizontal, Pencil, Play, Plus, Save, Search, Timer, Trash2, X } from 'lucide-react';
import { useAutoFocus } from '../lib/useAutoFocus';
import { currentWeekday } from '../lib/date';
import { compatibleAlternatives, equipmentLabel, exerciseMatches, unresolvedPlanEquipmentGaps, type PlanEquipmentGap } from '../lib/exercises';
import { exerciseGuidance } from '../data/initialPlan';
import { progressionAction, recommendationFor } from '../lib/recommendations';
import { routineEditDraftFrom, routineEditPatch, type RoutineEditDraft } from '../lib/routineEditor';
import { latestExercise } from '../lib/exerciseQueries';
import { clampNumber, displayWorkoutName, formatExerciseSummary } from '../lib/format';
import { ExerciseDetailSheet } from '../components/ExerciseDetailSheet';
import { ExercisePreview } from '../components/ExercisePreview';
import { ExerciseThumb } from '../components/ExerciseThumb';
import { PageHeader } from '../components/PageHeader';
import type { AppData, ExerciseDefinition, ExerciseGuidance, ExerciseEquipment, ExerciseSession, PlannedExercise, WorkoutDay } from '../types';

export function RoutineView({ data, days, activeDay, onDayChange, onUpdateDay, onAddExercise, onRemoveExercise, onStart, searchRequest, onSearchRequestHandled }: { data: AppData; days: WorkoutDay[]; activeDay: WorkoutDay; onDayChange: (id: string) => void; onUpdateDay: (dayId: string, updater: (day: WorkoutDay) => WorkoutDay) => void; onAddExercise: (dayId: string, exercise: ExerciseDefinition) => void; onRemoveExercise: (dayId: string, exerciseId: string) => void; onStart: (day: WorkoutDay) => void; searchRequest?: { query: string }; onSearchRequestHandled: () => void }) {
  const [editingRoutine, setEditingRoutine] = useState(false);
  const [planSection, setPlanSection] = useState<'next' | 'all'>('next');
  const [selectedPlanDayId, setSelectedPlanDayId] = useState<string>();
  const [detailExercise, setDetailExercise] = useState<PlannedExercise>();
  const [editingName, setEditingName] = useState(false);
  const [expandedExerciseId, setExpandedExerciseId] = useState<string | undefined>(() => activeDay.exercises.find((exercise) => exercise.active)?.id);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryInitialQuery, setLibraryInitialQuery] = useState<string>();
  const [libraryTargetId, setLibraryTargetId] = useState<string>();
  const titleInputRef = useAutoFocus<HTMLInputElement>();
  // The expanded exercise resets on day change on purpose: reacting to
  // `activeDay.exercises` would collapse the editor after every field edit.
  useEffect(() => {
    setExpandedExerciseId(activeDay.exercises.find((exercise) => exercise.active)?.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDay.id]);
  useEffect(() => {
    if (!searchRequest) return;
    setEditingRoutine(true);
    setLibraryTargetId(activeDay.exercises.find((exercise) => exercise.active)?.id);
    setLibraryInitialQuery(searchRequest.query);
    setLibraryOpen(true);
    onSearchRequestHandled();
  }, [searchRequest, activeDay.exercises, onSearchRequestHandled]);
  const openLibrary = (targetId = activeDay.exercises.find((exercise) => exercise.active)?.id): void => {
    setLibraryInitialQuery(undefined);
    setLibraryTargetId(targetId);
    setLibraryOpen(true);
  };
  const replaceFromLibrary = (targetId: string, replacement: ExerciseDefinition): void => {
    onUpdateDay(activeDay.id, (day) => ({ ...day, exercises: day.exercises.map((item) => item.id === targetId ? { ...item, exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition } : item) }));
    setLibraryOpen(false);
  };
  const manualGaps = unresolvedPlanEquipmentGaps(data.plan, data.exercises, data.profile.availableEquipment).filter((gap) => gap.dayId === activeDay.id);
  const nextPlanDay = days.find((day) => day.weekday === currentWeekday()) ?? days.find((day) => day.weekday > currentWeekday()) ?? days[0] ?? activeDay;
  const planDay = days.find((day) => day.id === selectedPlanDayId) ?? nextPlanDay;
  const planExercises = planDay.exercises.filter((exercise) => exercise.active);
  const planSets = planExercises.reduce((total, exercise) => total + exercise.sets, 0);
  const planDayNumber = days.findIndex((day) => day.id === planDay.id) + 1;
  if (!editingRoutine) return <>
    <section className="view-section routine-plan-view">
      <div className="page-header routine-plan-header"><h1>El plan</h1><button type="button" className="plan-edit-button" onClick={() => { onDayChange(planDay.id); setEditingRoutine(true); }}><Pencil size={16} aria-hidden="true" /> Editar</button></div>
      <div className="routine-plan-tabs" role="group" aria-label="Vista del plan">
        <button type="button" aria-pressed={planSection === 'next'} className={planSection === 'next' ? 'is-active' : ''} onClick={() => setPlanSection('next')}>Próximo entrenamiento</button>
        <button type="button" aria-pressed={planSection === 'all'} className={planSection === 'all' ? 'is-active' : ''} onClick={() => setPlanSection('all')}>Todas las rutinas</button>
      </div>
      <section className="routine-plan-content" aria-label={planSection === 'next' ? 'Próximo entrenamiento' : 'Todas las rutinas'}>
        {planSection === 'next' ? <>
          <section className="routine-plan-feature" aria-labelledby="routine-plan-title">
            <div className="routine-plan-art" aria-hidden="true"><img src={planExercises[0]?.imageUrl ?? '/exercises/atlas-push.webp'} alt="" /></div>
            <div className="routine-plan-copy"><span className="routine-plan-day">Día {planDayNumber}</span><h2 id="routine-plan-title">{displayWorkoutName(planDay.name)}</h2><div className="plan-summary" aria-label="Resumen del entrenamiento"><span><Dumbbell size={16} aria-hidden="true" /> {planExercises.length} ejercicios</span><span><Layers3 size={16} aria-hidden="true" /> {planSets} series</span><span><Timer size={16} aria-hidden="true" /> ~{data.profile.sessionMinutes} min</span></div></div>
            <button className="primary-button routine-plan-start" type="button" onClick={() => onStart(planDay)}><Play size={17} fill="currentColor" aria-hidden="true" /> Empezar entrenamiento</button>
          </section>
          <div className="exercise-list plan-exercise-list">{planExercises.map((exercise, index) => <ExercisePreview key={exercise.id} exercise={exercise} index={index} muscleGroup={data.exercises.find((item) => item.id === exercise.exerciseId)?.muscleGroup} onOpenDetails={() => setDetailExercise(exercise)} />)}</div>
        </> : <div className="routine-all-days">{days.map((day, index) => {
          const exercises = day.exercises.filter((exercise) => exercise.active);
          const sets = exercises.reduce((total, exercise) => total + exercise.sets, 0);
          return <button type="button" className="routine-day-card" key={day.id} onClick={() => { setSelectedPlanDayId(day.id); setPlanSection('next'); }}><span className="routine-plan-day">Día {index + 1}</span><strong>{displayWorkoutName(day.name)}</strong><span>{exercises.length} ejercicios · {sets} series · ~{data.profile.sessionMinutes} min</span><ChevronRight size={19} aria-hidden="true" /></button>;
        })}</div>}
      </section>
    </section>
    {detailExercise && <ExerciseDetailSheet exercise={detailExercise} muscleGroup={data.exercises.find((item) => item.id === detailExercise.exerciseId)?.muscleGroup} guidance={exerciseGuidance[detailExercise.exerciseId]} recommendation={recommendationFor(detailExercise.exerciseId, data.sessions)} progressionAction={progressionAction(detailExercise.exerciseId, data.sessions, detailExercise)} lastSession={latestExercise(data.sessions, detailExercise.exerciseId)} onClose={() => setDetailExercise(undefined)} />}
  </>;
  return <section className="view-section">
<PageHeader eyebrow="programación" title="Editar rutina" action={<button className="icon-button subtle" aria-label="Abrir biblioteca de ejercicios" onClick={() => openLibrary()}>
  <Search size={19} />
</button>} />
<button type="button" className="text-button routine-back-button" onClick={() => setEditingRoutine(false)}>
  <ChevronLeft size={16} aria-hidden="true" /> Volver al plan</button>
    <div className="day-tabs" role="tablist" aria-label="Días programados">{days.map((day) => <button key={day.id} id={`routine-tab-${day.id}`} role="tab" aria-selected={activeDay.id === day.id} aria-controls="routine-panel" tabIndex={activeDay.id === day.id ? 0 : -1} className={activeDay.id === day.id ? 'day-tab selected' : 'day-tab'} onClick={() => { onDayChange(day.id); setEditingName(false); }} onKeyDown={(event) => { const index = days.findIndex((item) => item.id === day.id); const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? days.length - 1 - index : 0; if (!delta) return; event.preventDefault(); const next = days[(index + delta + days.length) % days.length]; onDayChange(next.id); window.requestAnimationFrame(() => document.getElementById(`routine-tab-${next.id}`)?.focus()); }}>
      <span>{day.shortLabel}</span>
        <small>{displayWorkoutName(day.name).split(',')[0]}</small>
        </button>)}</div>
        <section className="routine-intro" id="routine-panel" role="tabpanel" aria-labelledby={`routine-tab-${activeDay.id}`}>
          <div>{editingName ? <input ref={titleInputRef} className="title-input" value={activeDay.name} onChange={(event) => onUpdateDay(activeDay.id, (day) => ({ ...day, name: event.target.value }))} onBlur={() => setEditingName(false)} /> : <h2>{displayWorkoutName(activeDay.name)}</h2>}<p>{activeDay.focus} · ~{data.profile.sessionMinutes} min</p>
          </div>
          <button className="icon-button subtle" aria-label="Editar nombre del entrenamiento" onClick={() => setEditingName(true)}>
            <MoreHorizontal size={19} />
          </button>
        </section>{manualGaps.length > 0 && <EquipmentReviewCard gaps={manualGaps} onReview={(gap) => { const planned = activeDay.exercises.find((exercise) => exercise.exerciseId === gap.exerciseId); if (planned) openLibrary(planned.id); }} />}{libraryOpen && <ExerciseLibrary exercises={data.exercises} availableEquipment={data.profile.availableEquipment} plannedExercises={activeDay.exercises} targetId={libraryTargetId} onTargetChange={setLibraryTargetId} onSelect={replaceFromLibrary} onAdd={(exercise) => { onAddExercise(activeDay.id, exercise); setLibraryOpen(false); }} onClose={() => setLibraryOpen(false)} initialQuery={libraryInitialQuery} />}<div className="routine-list">{activeDay.exercises.map((exercise, index) => <RoutineExercise key={exercise.id} exercise={exercise} index={index} canMoveDown={index < activeDay.exercises.length - 1} exerciseOptions={data.exercises} alternatives={compatibleAlternatives(data.exercises, exercise.exerciseId, data.profile.availableEquipment)} guidance={exerciseGuidance[exercise.exerciseId]} lastSession={latestExercise(data.sessions, exercise.exerciseId)} progressionAction={progressionAction(exercise.exerciseId, data.sessions, exercise)} expanded={expandedExerciseId === exercise.id} onOpenLibrary={() => openLibrary(exercise.id)} onToggle={() => setExpandedExerciseId((current) => current === exercise.id ? undefined : exercise.id)} onChange={(patch) => onUpdateDay(activeDay.id, (day) => ({ ...day, exercises: day.exercises.map((item) => item.id === exercise.id ? { ...item, ...patch } : item) }))} onMove={(direction) => onUpdateDay(activeDay.id, (day) => ({ ...day, exercises: moveExercise(day.exercises, index, direction) }))} onRemove={() => onRemoveExercise(activeDay.id, exercise.id)} />)}</div>
        <button type="button" className="secondary-button routine-add-button" onClick={() => openLibrary()}>
          <Plus size={16} /> Añadir ejercicio</button>
            <p className="history-note">
              <History size={15} /> Las sesiones guardadas conservan la rutina que tenían al empezar.</p>
              </section>;
}

function EquipmentReviewCard({ gaps, onReview }: { gaps: PlanEquipmentGap[]; onReview: (gap: PlanEquipmentGap) => void }) {
  return <aside className="routine-equipment-review" aria-labelledby="routine-equipment-review-title"><div className="routine-equipment-review-heading"><div><p className="eyebrow">revisión pendiente</p><h3 id="routine-equipment-review-title">Hay ejercicios por ajustar</h3></div><span>{gaps.length}</span></div><p>Estos ejercicios necesitan material que ya no figura como disponible. Elige una variante para dejar la sesión lista.</p><ul>{gaps.map((gap) => <li key={`${gap.dayId}-${gap.exerciseId}`}><div><strong>{gap.exerciseName}</strong><span>Necesita {equipmentLabel(gap.equipment)}</span></div><button type="button" className="secondary-button small" aria-label={`Elegir sustitución para ${gap.exerciseName}`} onClick={() => onReview(gap)}><Search size={14} /> Elegir sustitución</button></li>)}</ul></aside>;
}

function ExerciseLibrary({ exercises, availableEquipment, plannedExercises, targetId, onTargetChange, onSelect, onAdd, onClose, initialQuery }: { exercises: ExerciseDefinition[]; availableEquipment: ExerciseEquipment[]; plannedExercises: PlannedExercise[]; targetId?: string; onTargetChange: (id: string) => void; onSelect: (targetId: string, replacement: ExerciseDefinition) => void; onAdd: (exercise: ExerciseDefinition) => void; onClose: () => void; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery ?? '');
  useEffect(() => { if (initialQuery !== undefined) setQuery(initialQuery); }, [initialQuery]);
  const [muscleGroup, setMuscleGroup] = useState('');
  const [equipment, setEquipment] = useState('');
  const target = targetId ?? plannedExercises[0]?.id;
  const muscles = Array.from(new Set(exercises.map((exercise) => exercise.muscleGroup))).sort((a, b) => a.localeCompare(b, 'es'));
  const equipmentOptions = Array.from(new Set(exercises.map((exercise) => exercise.equipment))).sort();
  const results = exercises.filter((exercise) => availableEquipment.includes(exercise.equipment) && exerciseMatches(exercise, query, muscleGroup, equipment)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const hasActiveFilters = Boolean(query || muscleGroup || equipment);
  return <section className="exercise-library" aria-label="Biblioteca de ejercicios">
<div className="exercise-library-header">
  <div>
    <p className="eyebrow">biblioteca personal</p>
      <h2>Encuentra una variante</h2>
        <p>Filtra por zona o material. Puedes sustituir un bloque o añadir uno nuevo.</p>
        </div>
        <button className="icon-button subtle" type="button" aria-label="Cerrar biblioteca" onClick={onClose}>
          <X size={19} />
        </button>
      </div>{plannedExercises.length > 0 && <label className="library-target">Cambiar ejercicio de<select value={target ?? ''} onChange={(event) => onTargetChange(event.target.value)}>{plannedExercises.map((exercise) => <option key={exercise.id} value={exercise.id}>{exercise.name}</option>)}</select>
    </label>}<div className="library-filters">
    <label className="library-search">
      <Search size={16} />
      <span className="sr-only">Buscar ejercicio</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar press, polea, dorsal…" />
      </label>
      <label>
        <span className="sr-only">Filtrar por músculo</span>
          <select value={muscleGroup} onChange={(event) => setMuscleGroup(event.target.value)}>
            <option value="">Todos los músculos</option>{muscles.map((muscle) => <option key={muscle} value={muscle}>{muscle}</option>)}</select>
            </label>
            <label>
              <span className="sr-only">Filtrar por material</span>
                <select value={equipment} onChange={(event) => setEquipment(event.target.value)}>
                  <option value="">Todo el material</option>{equipmentOptions.map((item) => <option key={item} value={item}>{equipmentLabel(item as ExerciseDefinition['equipment'])}</option>)}</select>
                  </label>
                </div>
                <p className="library-results-count">{results.length} ejercicios disponibles</p>
                  <div className="library-results">{results.map((exercise) => <div className="library-result-row" key={exercise.id}>
                    <button type="button" className="library-result" disabled={!target} onClick={() => target && onSelect(target, exercise)}>
                      <ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} />
                      <span>
                        <strong>{exercise.name}</strong>
                          <small>{equipmentLabel(exercise.equipment)} · {target ? 'sustituir' : 'seleccionar'}</small>
                          </span>
                        </button>
                        <button type="button" className="library-add-button" onClick={() => onAdd(exercise)}>
                          <Plus size={14} /> Añadir</button>
                          </div>)}</div>{results.length === 0 && <div className="library-empty-state">
                          <p className="library-empty">No hay ejercicios con estos filtros.</p>{hasActiveFilters && <button className="text-button" type="button" onClick={() => { setQuery(''); setMuscleGroup(''); setEquipment(''); }}>Limpiar búsqueda y filtros</button>}</div>}</section>;
}

function RoutineExercise({ exercise, index, canMoveDown, exerciseOptions, alternatives, guidance, lastSession, progressionAction: action, expanded, onOpenLibrary, onToggle, onChange, onMove, onRemove }: { exercise: PlannedExercise; index: number; canMoveDown: boolean; exerciseOptions: ExerciseDefinition[]; alternatives: ExerciseDefinition[]; guidance?: ExerciseGuidance; lastSession?: ExerciseSession; progressionAction?: ReturnType<typeof progressionAction>; expanded: boolean; onOpenLibrary: () => void; onToggle: () => void; onChange: (patch: Partial<PlannedExercise>) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void }) {
  const detail = guidance ?? { cues: ['Mantén una postura estable.', 'Mueve la carga sin impulso.', 'Controla el regreso.'] };
  const [editOpen, setEditOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draft, setDraft] = useState<RoutineEditDraft>(() => routineEditDraftFrom(exercise));

  const updateDraft = (patch: Partial<RoutineEditDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const cancelEdit = (): void => {
    setDraft(routineEditDraftFrom(exercise));
    setEditOpen(false);
  };
  const saveEdit = (): void => {
    onChange(routineEditPatch(draft));
    setEditOpen(false);
  };

  return <article className={exercise.active ? 'routine-exercise' : 'routine-exercise is-off'}>
    <div className="routine-number">{String(index + 1).padStart(2, '0')}</div>
    <button type="button" className="routine-thumb-button" onClick={onToggle} aria-label={`${expanded ? 'Ocultar' : 'Ver'} imagen grande de ${exercise.name}`} aria-expanded={expanded}><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Referencia de ${exercise.name}`} /></button>
    <div className="routine-exercise-content">
      <div className="routine-exercise-title">
        <div className="routine-exercise-name">
          <select className="exercise-select" value={exercise.exerciseId} aria-label={`Cambiar ${exercise.name}`} onChange={(event) => { const replacement = exerciseOptions.find((item) => item.id === event.target.value); if (replacement) onChange({ exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition }); }}>
            <option value={exercise.exerciseId}>{exercise.name}</option>
            {exerciseOptions.filter((item) => item.id !== exercise.exerciseId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <p>{exercise.active ? 'Activo en la sesión' : 'Pausado'}</p>
          <button type="button" className="routine-library-button" onClick={onOpenLibrary}><Search size={13} /> Buscar en biblioteca</button>
        </div>
        <div className="routine-title-actions">
          <button type="button" className="routine-image-trigger" onClick={onToggle} aria-expanded={expanded}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}<span>{expanded ? 'Ocultar imagen' : 'Ver imagen'}</span></button>
          <button type="button" className={exercise.active ? 'toggle on' : 'toggle'} aria-label={exercise.active ? `Desactivar ${exercise.name}` : `Activar ${exercise.name}`} aria-pressed={exercise.active} onClick={() => onChange({ active: !exercise.active })}><span /></button>
        </div>
      </div>
      <div className="routine-order-actions" role="group" aria-label={`Orden de ${exercise.name}`}>
        <button type="button" onClick={() => { if (editOpen) saveEdit(); onMove(-1); }} disabled={index === 0} aria-label={`Subir ${exercise.name}`}><ArrowUp size={14} /> Subir</button>
        <button type="button" onClick={() => { if (editOpen) saveEdit(); onMove(1); }} disabled={!canMoveDown} aria-label={`Bajar ${exercise.name}`}><ArrowDown size={14} /> Bajar</button>
      </div>
      {expanded && <div className="routine-visual-guide"><ExerciseThumb src={exercise.imageUrl} position={exercise.imagePosition} alt={`Imagen ampliada de ${exercise.name}`} large /><div className="routine-cues"><p className="eyebrow">cómo hacerlo</p><ol>{detail.cues.map((cue, cueIndex) => <li key={cue}><span>{cueIndex + 1}</span>{cue}</li>)}</ol></div></div>}
      <details className="routine-edit-details" open={editOpen} onToggle={(event) => { const nextOpen = event.currentTarget.open; setEditOpen(nextOpen); if (nextOpen) setDraft(routineEditDraftFrom(exercise)); }}>
        <summary>Editar parámetros del ejercicio</summary>
        <p className="routine-edit-note"><Check size={13} /> Edita sin tocar la rutina hasta guardar los cambios.</p>
        <div className="routine-fields">
          <label>Series<input inputMode="numeric" value={draft.sets} onChange={(event) => updateDraft({ sets: clampNumber(event.target.value, 1, 8) })} /></label>
          <label>Reps<input inputMode="numeric" value={`${draft.repMin}-${draft.repMax}`} onChange={(event) => { const [min, max] = event.target.value.split(/[–-]/).map(Number); if (Number.isFinite(min) && Number.isFinite(max)) updateDraft({ repMin: min, repMax: max }); }} /></label>
          <label>Descanso<input inputMode="numeric" value={draft.restSeconds / 60} onChange={(event) => updateDraft({ restSeconds: clampNumber(event.target.value, 0.5, 4) * 60 })} /></label>
        </div>
        <div className="routine-progression-fields">
          <label>Calentamiento<select value={draft.warmupSets} onChange={(event) => updateDraft({ warmupSets: clampNumber(event.target.value, 0, 3) })}><option value="0">Ninguno</option><option value="1">1 serie</option><option value="2">2 series</option><option value="3">3 series</option></select></label>
          <label>Regla de progresión<select value={draft.progressionPolicy} onChange={(event) => updateDraft({ progressionPolicy: event.target.value as RoutineEditDraft['progressionPolicy'] })}><option value="double">Doble progresión</option><option value="linear">Lineal</option><option value="off">Manual</option></select></label>
          <label>Salto de carga<input inputMode="decimal" value={draft.progressionIncrementKg} onChange={(event) => updateDraft({ progressionIncrementKg: clampNumber(event.target.value, 0.5, 10) })} /></label>
        </div>
        {alternatives.length > 0 && <div className="routine-alternatives"><span>Alternativas compatibles</span><div>{alternatives.slice(0, 3).map((replacement) => <button type="button" key={replacement.id} onClick={() => updateDraft({ exerciseId: replacement.id, name: replacement.name, imageUrl: replacement.imageUrl, imagePosition: replacement.imagePosition })}>{replacement.name}</button>)}</div></div>}
        {lastSession && <p className="routine-history"><History size={14} /> Última vez: {formatExerciseSummary(lastSession)}</p>}
        {action && <div className={`routine-next-action ${action.tone}`}><Gauge size={14} /><div><strong>{action.title}</strong><span>{action.detail}</span></div></div>}
        <div className="routine-remove-actions">{confirmRemove ? <div className="routine-remove-confirm" role="group" aria-label={`Confirmar que quieres quitar ${exercise.name}`}><p>¿Quitar {exercise.name} de esta rutina?</p><div><button type="button" className="secondary-button small" onClick={() => setConfirmRemove(false)}>Cancelar</button><button type="button" className="routine-remove-confirm-button" onClick={onRemove}>Quitar</button></div></div> : <button type="button" className="routine-remove-button" onClick={() => setConfirmRemove(true)}><Trash2 size={14} /> Quitar ejercicio</button>}</div>
        <div className="routine-edit-actions"><button type="button" className="secondary-button small" onClick={cancelEdit}>Cancelar</button><button type="button" className="primary-button small" onClick={saveEdit}><Save size={15} /> Guardar cambios</button></div>
      </details>
    </div>
  </article>;
}

function moveExercise(exercises: PlannedExercise[], index: number, direction: -1 | 1): PlannedExercise[] { const nextIndex = index + direction; if (nextIndex < 0 || nextIndex >= exercises.length) return exercises; const copy = [...exercises]; [copy[index], copy[nextIndex]] = [copy[nextIndex], copy[index]]; return copy; }
