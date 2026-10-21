import { useEffect, useRef } from 'react';

/**
 * Focuses an element when it mounts without the `autoFocus` attribute.
 * `autoFocus` moves focus during page load and is flagged as an accessibility
 * risk; this keeps the same "start typing here" affordance for controlled mounts
 * such as an inline rename field.
 */
export function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
