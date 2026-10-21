import { allExerciseEquipment, equipmentLabel } from '../lib/exercises';
import { dayNames, normalizeTrainingDays, shortDayNames } from '../lib/date';
import type { ExerciseEquipment } from '../types';

export function DayPicker({ selected, onChange }: { selected: number[]; onChange: (days: number[]) => void }) {
  const normalizedSelection = normalizeTrainingDays(selected).slice(0, 4);
  return <div className="day-picker" aria-label="Días de entrenamiento">{[1, 2, 3, 4, 5, 6, 0].map((day) => { const label = shortDayNames[day]; const dayName = dayNames[day]; const isSelected = normalizedSelection.includes(day); const selectionLimitReached = normalizedSelection.length >= 4 && !isSelected; return <button type="button" key={day} className={isSelected ? 'day-picker-button selected' : 'day-picker-button'} aria-label={dayName} aria-pressed={isSelected} disabled={selectionLimitReached} onClick={() => onChange(isSelected ? normalizedSelection.filter((item) => item !== day) : [...normalizedSelection, day].sort((a, b) => a - b))}>{label}</button>; })}</div>;
}

export function EquipmentPicker({ selected, onChange }: { selected: ExerciseEquipment[]; onChange: (equipment: ExerciseEquipment[]) => void }) {
  const toggle = (equipment: ExerciseEquipment): void => {
    const next = selected.includes(equipment) ? selected.filter((item) => item !== equipment) : [...selected, equipment];
    if (next.length > 0) onChange(next);
  };
  return <div className="equipment-picker" role="group" aria-label="Equipamiento disponible">{allExerciseEquipment.map((equipment) => <label key={equipment} className={selected.includes(equipment) ? 'equipment-option selected' : 'equipment-option'}><input type="checkbox" checked={selected.includes(equipment)} onChange={() => toggle(equipment)} /><span>{equipmentLabel(equipment)}</span></label>)}</div>;
}
