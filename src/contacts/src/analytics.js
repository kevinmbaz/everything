// Thin, fail-safe wrapper around Plausible custom events (the script is loaded
// in index.html). Analytics is best-effort: if Plausible is blocked, offline,
// or absent, tracking is a silent no-op so it can never break a user action.
//
// We track only a small set of "value" moments — getting contacts in (added /
// imported) and putting stored data to use (copied) — not general activity.

/**
 * Record a product event.
 * @param {string} event   Event name, e.g. 'Contact Added'.
 * @param {Record<string, string|number>} [props] Optional custom properties.
 */
export function track(event, props) {
  if (import.meta.env.VITE_PRIVATE_STORAGE === '1') return
  try {
    if (typeof window !== 'undefined' && typeof window.plausible === 'function') {
      window.plausible(event, props ? { props } : undefined)
    }
  } catch (_e) {
    /* analytics must never throw into a user action */
  }
}
