

export function NumberField({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange: (value: string) => void }) { return <label>{label}<span>{unit}</span><input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="-" /></label>; }
