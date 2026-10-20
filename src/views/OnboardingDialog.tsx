import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ChevronRight, CloudOff } from 'lucide-react';
import { DayPicker, EquipmentPicker, experienceOptions } from '../components/ProfilePickers';
import { numberOrUndefined, clampNumber } from '../lib/format';
import type { UserProfile } from '../types';

export function OnboardingDialog({ profile, onComplete }: { profile: UserProfile; onComplete: (profile: Partial<UserProfile>) => void }) {
  const [form, setForm] = useState({
    gym: profile.gym,
    goal: profile.goal,
    heightCm: profile.heightCm?.toString() ?? '',
    currentWeightKg: profile.currentWeightKg?.toString() ?? '',
    sessionMinutes: String(profile.sessionMinutes),
    experienceLevel: profile.experienceLevel,
    trainingDays: profile.trainingDays,
    availableEquipment: profile.availableEquipment,
  });
  const save = (): void => onComplete({
    gym: form.gym.trim(),
    goal: form.goal.trim(),
    heightCm: numberOrUndefined(form.heightCm),
    currentWeightKg: numberOrUndefined(form.currentWeightKg),
    sessionMinutes: clampNumber(form.sessionMinutes, 20, 180),
    experienceLevel: form.experienceLevel,
    trainingDays: form.trainingDays.length ? form.trainingDays : profile.trainingDays,
    availableEquipment: form.availableEquipment.length ? form.availableEquipment : profile.availableEquipment,
  });
  return <div className="onboarding-backdrop">
<section className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
  <div className="onboarding-kicker">
    <Sparkles size={16} /> primera configuración</div>
      <h2 id="onboarding-title">Vamos a dejarlo a tu medida.</h2>
        <p className="onboarding-lead">Unos datos básicos para que la rutina de Hoy encaje contigo desde el primer entrenamiento.</p>
          <form onSubmit={(event) => { event.preventDefault(); save(); }}>
            <label className="onboarding-field">¿Dónde entrenas?<input value={form.gym} onChange={(event) => setForm((current) => ({ ...current, gym: event.target.value }))} placeholder="Ej. Evanfit Picanya" />
          </label>
          <label className="onboarding-field">¿Qué quieres conseguir?<input value={form.goal} onChange={(event) => setForm((current) => ({ ...current, goal: event.target.value }))} placeholder="Ej. ganar fuerza" />
        </label>
        <div className="onboarding-grid">
          <label className="onboarding-field">Duración habitual<span>minutos</span>
            <input inputMode="numeric" value={form.sessionMinutes} onChange={(event) => setForm((current) => ({ ...current, sessionMinutes: event.target.value }))} />
          </label>
          <div className="onboarding-field">
            <span>¿Qué días entrenas?</span>
              <span>elige los tuyos</span>
                <DayPicker selected={form.trainingDays} onChange={(trainingDays) => setForm((current) => ({ ...current, trainingDays }))} />
              </div>
            </div>
            <div className="onboarding-field equipment-field">
              <span>¿Qué material tienes disponible?</span>
                <span>Las sustituciones y la biblioteca se adaptarán a esto</span>
                  <EquipmentPicker selected={form.availableEquipment} onChange={(availableEquipment) => setForm((current) => ({ ...current, availableEquipment }))} />
                </div>
                <fieldset className="experience-options">
                  <legend>Tu punto de partida</legend>{experienceOptions.map((option) => <label key={option.value} className={form.experienceLevel === option.value ? 'experience-option selected' : 'experience-option'}>
                    <input type="radio" name="experience" value={option.value} checked={form.experienceLevel === option.value} onChange={() => setForm((current) => ({ ...current, experienceLevel: option.value }))} />
                    <span>
                      <strong>{option.label}</strong>
                        <small>{option.description}</small>
                        </span>
                      </label>)}</fieldset>
                      <div className="onboarding-section">
                        <div className="onboarding-section-heading">
                          <span>Datos opcionales</span>
                            <small>No hacen falta para empezar</small>
                            </div>
                            <div className="onboarding-grid">
                              <label className="onboarding-field">Altura<span>cm · opcional</span>
                                <input inputMode="decimal" value={form.heightCm} onChange={(event) => setForm((current) => ({ ...current, heightCm: event.target.value }))} placeholder="-" />
                              </label>
                              <label className="onboarding-field">Peso actual<span>kg · opcional</span>
                                <input inputMode="decimal" value={form.currentWeightKg} onChange={(event) => setForm((current) => ({ ...current, currentWeightKg: event.target.value }))} placeholder="-" />
                              </label>
                            </div>
                            <p className="onboarding-privacy">
                              <CloudOff size={15} /> En modo local, los datos se guardan en este dispositivo. Si conectas una cuenta, la copia completa se almacena en D1 sin cifrado de extremo a extremo.</p>
                              </div>
                              <div className="onboarding-actions">
                                <button className="primary-button" type="submit">Guardar y empezar <ChevronRight size={17} />
                              </button>
                              <button className="secondary-button" type="button" onClick={() => onComplete({})}>Empezar sin completar</button>
                              </div>
                            </form>
                          </section>
                        </div>;
}
