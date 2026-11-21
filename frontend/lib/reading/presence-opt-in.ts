/**
 * Tiny pub/sub so the settings dialog can tell the reading screen immediately
 * that the parent turned the "nobody in frame" email on or off. The truth is
 * the server-side setting; this only avoids waiting for the next page load.
 */
type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();

export function announcePresenceOptIn(enabled: boolean): void {
  listeners.forEach((listener) => listener(enabled));
}

export function subscribePresenceOptIn(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
