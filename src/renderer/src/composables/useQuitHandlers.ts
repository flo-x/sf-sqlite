/**
 * Central registry for before-quit save handlers.
 *
 * Views that need to persist state before the app exits call
 * registerQuitHandler() with an async function. App.vue listens for the
 * app:before-quit signal, runs all registered handlers in parallel, then
 * notifies the main process that it's safe to quit.
 *
 * This ensures quit is always fast: if a view was never mounted (e.g. the
 * Query tab was never visited), its handler is simply never registered, and
 * the app exits immediately without waiting for a fallback timeout.
 */

const handlers: Array<() => Promise<void>> = []

/**
 * Register a function to be called before the app quits.
 * Typically called from onMounted inside a view component.
 * Returns an unregister function to call from onUnmounted.
 */
export function registerQuitHandler(fn: () => Promise<void>): () => void {
  handlers.push(fn)
  return () => {
    const idx = handlers.indexOf(fn)
    if (idx !== -1) handlers.splice(idx, 1)
  }
}

/** Run all registered handlers in parallel. Called by App.vue. */
export async function runAllQuitHandlers(): Promise<void> {
  await Promise.all(handlers.map((fn) => fn()))
}
