import { Activity, BarChart3, Dumbbell, UserRound } from 'lucide-react';
import type { View } from '../types';

/** Bottom navigation entries shared between the shell and the nav bar.
Kept out of BottomNav.tsx so that file exports only components (fast refresh). */
export const navItems: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: 'today', label: 'Hoy', icon: Activity }, { id: 'routine', label: 'Rutina', icon: Dumbbell },
  { id: 'progress', label: 'Progreso', icon: BarChart3 }, { id: 'profile', label: 'Perfil', icon: UserRound },
];
