/**
 * Shared UI preference store, backed by localStorage.
 * A single reactive object is shared across all callers in the same session.
 */
import { reactive, watch } from 'vue'

const STORAGE_KEY = 'sf-sqlite-ui-prefs'

interface UiPrefs {
  /** When true, show a subtitle line per job in the job list. */
  showJobDetails: boolean
}

function load(): UiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      return { showJobDetails: false, ...JSON.parse(raw) }
    }
  } catch { /* ignore */ }
  return { showJobDetails: false }
}

const prefs = reactive<UiPrefs>(load())

watch(
  () => ({ ...prefs }),
  (val) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(val)) } catch { /* ignore */ }
  },
  { deep: true }
)

export function useUiPrefs(): typeof prefs {
  return prefs
}
