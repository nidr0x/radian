import { useEffect, useState } from 'react';

/** One-second countdown shared by the active session header and the floating rest timer.
Kept out of RestFloating.tsx so that file exports only components (fast refresh). */
export function useRestCountdown(restUntil: number | null, pausedRemaining: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (restUntil === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [restUntil]);
  return restUntil === null ? pausedRemaining : Math.max(0, Math.ceil((restUntil - now) / 1000));
}
