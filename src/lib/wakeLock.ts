export interface ScreenWakeLock {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request: (type: 'screen') => Promise<ScreenWakeLock>;
  };
}

export const requestScreenWakeLock = async (): Promise<ScreenWakeLock | undefined> => {
  const wakeLock = (navigator as unknown as NavigatorWithWakeLock).wakeLock;
  if (!wakeLock) return undefined;
  try {
    return await wakeLock.request('screen');
  } catch {
    return undefined;
  }
};
