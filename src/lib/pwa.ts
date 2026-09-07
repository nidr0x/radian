let waitingWorker: ServiceWorker | undefined;
export const hasAppUpdate = (): boolean => Boolean(waitingWorker);
export const applyAppUpdate = (): void => waitingWorker?.postMessage({ type: 'SKIP_WAITING' });

export const registerAppWorker = async (): Promise<void> => {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  const announce = () => {
    waitingWorker = registration.waiting ?? undefined;
    if (waitingWorker) window.dispatchEvent(new Event('radian-update'));
  };
  announce();
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', announce);
  });
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!waitingWorker || refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) void registration.update().catch(() => undefined);
  });
};
