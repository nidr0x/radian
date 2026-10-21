import { memo } from 'react';
import { navItems } from './navigation';
import type { View } from '../types';

export const BottomNav = memo(function BottomNav({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return <nav className="bottom-nav" aria-label="Navegación principal">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'nav-item is-active' : 'nav-item'} aria-current={view === id ? 'page' : undefined} onClick={() => onChange(id)}><Icon size={20} strokeWidth={view === id ? 2.6 : 1.8} /><span>{label}</span></button>)}</nav>;
});
