/**
 * Shared UI preference store, backed by localStorage.
 * A single reactive object is shared across all callers in the same session.
 */
import { reactive, watch } from 'vue'

const STORAGE_KEY = 'sf-sqlite-ui-prefs'

interface UiPrefs {
  /** When true, job list rows use the tighter vertical padding. */
  compactJobList: boolean
}

function load(): UiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiPrefs> & { relaxedJobList?: boolean }
      return {
        compactJobList: parsed.compactJobList ?? (typeof parsed.relaxedJobList === 'boolean' ? !parsed.relaxedJobList : false)
      }
    }
  } catch { /* ignore */ }
  return { compactJobList: false }
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
