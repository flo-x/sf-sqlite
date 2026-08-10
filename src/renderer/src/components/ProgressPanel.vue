<template>
  <div class="progress-panel">
    <div class="progress-summary">
      <div class="progress-stat">
        <div class="progress-val">{{ fetched.toLocaleString() }}</div>
        <div class="progress-lbl">{{ type === 'extract' ? 'Fetched' : 'Sent' }}</div>
      </div>
      <div v-if="total" class="progress-stat">
        <div class="progress-val">{{ total.toLocaleString() }}</div>
        <div class="progress-lbl">Total</div>
      </div>
      <div class="progress-stat">
        <div class="progress-val">{{ rps }}</div>
        <div class="progress-lbl">rec/s</div>
      </div>
      <div class="progress-stat">
        <div class="progress-val">{{ elapsed }}s</div>
        <div class="progress-lbl">Elapsed</div>
      </div>
    </div>
    <div v-if="total" class="progress-bar-wrap" style="margin: 8px 0;">
      <div class="progress-bar" :style="{ width: pct + '%' }"></div>
    </div>
    <div v-if="status === 'error'" class="alert alert-error" style="margin-top: 8px;">{{ errorMsg }}</div>
    <div v-else-if="status === 'success'" class="alert alert-success" style="margin-top: 8px;">Completed successfully — {{ fetched.toLocaleString() }} records</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  type: 'extract' | 'writeback'
  fetched: number
  total?: number | null
  rps?: number
  status?: string
  errorMsg?: string
  startTime?: number
}>()

const TERMINAL = new Set(['success', 'error', 'partial'])

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer(): void {
  if (timer) { clearInterval(timer); timer = null }
}

onMounted(() => {
  if (!TERMINAL.has(props.status ?? '')) {
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  }
})
onUnmounted(stopTimer)

watch(() => props.status, (s) => {
  if (TERMINAL.has(s ?? '')) {
    now.value = Date.now()
    stopTimer()
  }
})

const elapsed = computed(() => Math.round((now.value - (props.startTime ?? now.value)) / 1000))
const pct = computed(() => props.total ? Math.round((props.fetched / props.total) * 100) : 0)
</script>

<style scoped>
.progress-panel { padding: 16px; }
.progress-summary { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
.progress-stat { text-align: center; }
.progress-val { font-size: 20px; font-weight: 700; }
.progress-lbl { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
</style>
