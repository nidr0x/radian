import { useEffect } from 'react';

/**
 * Dismisses a dialog when the user presses on its backdrop.
 * The handler lives on the backdrop element itself instead of in JSX so the
 * backdrop stays a non-interactive presentational element (jsx-a11y), while
 * clicks inside the dialog keep working because `event.target` never equals it.
 */
export function useBackdropDismiss(ref: { readonly current: HTMLElement | null }, onDismiss: () => void) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const handler = (event: MouseEvent) => {
      if (event.target === element) onDismiss();
    };
    element.addEventListener('mousedown', handler);
    return () => element.removeEventListener('mousedown', handler);
  }, [ref, onDismiss]);
}
