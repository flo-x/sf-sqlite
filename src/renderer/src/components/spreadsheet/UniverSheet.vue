<template>
  <div class="univer-sheet">
    <div v-if="loading" class="univer-loading">Loading spreadsheet…</div>
    <div v-if="loadError" class="alert alert-error" style="margin: 12px;">{{ loadError }}</div>
    <div ref="containerEl" class="univer-container"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * Univer Sheets (https://univer.ai), Apache-2.0 licensed.
 * Loaded lazily via dynamic import so its bundle is only fetched when this
 * view is actually opened, not on every app startup.
 *
 * Uses the "preset" API (createUniver), which is framework-agnostic — Univer
 * mounts itself into a plain container element. Note that Univer's own UI
 * (toolbar, menus, dialogs) is internally built with React; react/react-dom
 * are required peer dependencies of @univerjs/preset-sheets-core, not
 * something this app's own Vue code depends on directly.
 */
import { onMounted, onUnmounted, ref } from 'vue'

const containerEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const loadError = ref('')

// Kept outside refs — these are non-reactive third-party instances, not Vue state.
let univerInstance: { dispose: () => void } | null = null

onMounted(async () => {
  try {
    const [{ createUniver, LocaleType, mergeLocales }, sheetsCore, sheetsCoreEnUS] = await Promise.all([
      import('@univerjs/presets'),
      import('@univerjs/preset-sheets-core'),
      import('@univerjs/preset-sheets-core/locales/en-US'),
      import('@univerjs/preset-sheets-core/lib/index.css')
    ])

    if (!containerEl.value) return

    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: {
        [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS.default)
      },
      presets: [
        sheetsCore.UniverSheetsCorePreset({
          container: containerEl.value
        })
      ]
    })
    univerInstance = univer

    univerAPI.createWorkbook({
      name: 'sf-sqlite spreadsheet',
      sheets: {
        sheet1: {
          id: 'sheet1',
          name: 'Sheet1',
          cellData: {
            0: {
              0: { v: 'Column A' },
              1: { v: 'Column B' },
              2: { v: 'Formula (A2*B2)' }
            },
            1: {
              0: { v: 10 },
              1: { v: 5 },
              2: { f: '=A2*B2' }
            },
            2: {
              0: { v: 20 },
              1: { v: 3 },
              2: { f: '=A3*B3' }
            },
            3: {
              0: { v: 'Sum' },
              2: { f: '=SUM(C2:C3)' }
            }
          }
        }
      }
    })
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  univerInstance?.dispose()
  univerInstance = null
})
</script>

<style scoped>
.univer-sheet {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

.univer-container {
  flex: 1;
  min-height: 0;
}

.univer-loading {
  position: absolute;
  top: 12px;
  left: 12px;
  font-size: 13px;
  color: var(--text-muted);
  z-index: 10;
}
</style>
