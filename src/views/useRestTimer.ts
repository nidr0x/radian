import { useCallback, useEffect, useState } from 'react';

type RestToast = (toast?: string) => void;

/** Rest countdown state and controls, extracted verbatim from App.tsx. */
export function useRestTimer(setToast: RestToast): RestTimer {
  const [restRemaining, setRestRemaining] = useState(0);
  const [restEnded, setRestEnded] = useState(false);
  const [restUntil, setRestUntil] = useState<number | null>(null);
  const [restContext, setRestContext] = useState<{ exerciseName: string; seconds: number }>();
  const [restPaused, setRestPaused] = useState(false);


  useEffect(() => {
    if (restUntil === null) return undefined;
    const timer = window.setTimeout(() => {
      setRestRemaining(0);
      setRestUntil(null);
      setRestContext(undefined);
      setRestPaused(false);
      setRestEnded(true);
      if (typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200]);
      if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const notificationOptions: NotificationOptions & { renotify: boolean } = { body: 'Es hora de la siguiente serie.', tag: 'radian-rest', renotify: true };
        const notification = new Notification('Descanso terminado', notificationOptions);
        const closeNotificationOnReturn = (): void => {
          if (document.visibilityState === 'hidden') return;
          notification.close();
          document.removeEventListener('visibilitychange', closeNotificationOnReturn);
        };
        document.addEventListener('visibilitychange', closeNotificationOnReturn);
      }
      setToast('Descanso terminado');
    }, Math.max(0, restUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [restUntil, setToast]);

  const dismissRestEnded = useCallback(() => setRestEnded(false), []);

  const startRest = (seconds: number, exerciseName: string): void => {
    setRestContext({ exerciseName, seconds });
    setRestUntil(Date.now() + seconds * 1000);
    setRestRemaining(seconds);
    setRestPaused(false);
  };
  const restartRest = (): void => {
    if (restContext) startRest(restContext.seconds, restContext.exerciseName);
  };
  const currentRestRemaining = (): number => restUntil === null ? restRemaining : Math.max(0, Math.ceil((restUntil - Date.now()) / 1000));
  const pauseRest = (): void => {
    const remaining = currentRestRemaining();
    if (remaining <= 0) return;
    setRestRemaining(remaining);
    setRestUntil(null);
    setRestPaused(true);
  };
  const resumeRest = (): void => {
    const remaining = currentRestRemaining();
    if (remaining <= 0) return;
    setRestRemaining(remaining);
    setRestUntil(Date.now() + remaining * 1000);
    setRestPaused(false);
  };
  const adjustRest = (seconds: number): void => {
    const next = Math.max(1, currentRestRemaining() + seconds);
    setRestRemaining(next);
    setRestUntil(restPaused ? null : Date.now() + next * 1000);
  };

  // Same reset sequence as the RestFloating close control in the App shell.
  const resetRest = (): void => {
    setRestUntil(null);
    setRestRemaining(0);
    setRestContext(undefined);
    setRestPaused(false);
  };
  // Same reset sequence as confirmLeaveSession, which never cleared the exercise context.
  const stopRest = (): void => {
    setRestUntil(null);
    setRestRemaining(0);
    setRestPaused(false);
  };
  return {
    restRemaining, restEnded, restUntil, restContext, restPaused,
    startRest, restartRest, pauseRest, resumeRest, adjustRest,
    dismissRestEnded, resetRest, stopRest,
  };
}

interface RestTimer {
  restRemaining: number;
  restEnded: boolean;
  restUntil: number | null;
  restContext?: { exerciseName: string; seconds: number };
  restPaused: boolean;
  startRest: (seconds: number, exerciseName: string) => void;
  restartRest: () => void;
  pauseRest: () => void;
  resumeRest: () => void;
  adjustRest: (seconds: number) => void;
  dismissRestEnded: () => void;
  resetRest: () => void;
  stopRest: () => void;
}
