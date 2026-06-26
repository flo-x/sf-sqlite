<template>
  <div class="sf-sb-wrap">
    <div class="sf-sb-header">
      <input v-model="search" type="text" placeholder="Filter objects/fields…" class="sf-sb-search" />
      <button class="sf-sb-refresh" :disabled="refreshing" :title="refreshing ? 'Refreshing…' : 'Refresh objects'" @click="refresh">
        <span v-if="refreshing" class="spinner" style="width:10px;height:10px;border-width:2px;"></span>
        <span v-else>↻</span>
      </button>
    </div>

    <div v-if="!sfConn" class="empty-state" style="padding:24px 12px; font-size:12px;">
      Connect to Salesforce first
    </div>

    <div v-else class="sf-sb-tree">
      <template v-for="obj in filtered" :key="obj.name">
        <div
          class="sf-sb-obj-node"
          draggable="true"
          @dragstart="onDragStart($event, obj.name)"
          @click="toggle(obj.name)"
          @dblclick.stop="emit('insert', obj.name)"
        >
          <span class="sf-sb-chevron">{{ expanded.has(obj.name) ? '▼' : '▶' }}</span>
          <span class="sf-sb-icon">☁</span>
          <span class="sf-sb-oname" :title="obj.label">{{ obj.name }}</span>
        </div>
        <template v-if="expanded.has(obj.name)">
          <div v-if="loadingFields.has(obj.name)" class="sf-sb-loading">
            <span class="spinner" style="width:10px;height:10px;border-width:2px;"></span> Loading…
          </div>
          <template v-else>
            <div
              v-for="field in (fieldCache.get(obj.name) ?? [])"
              :key="field.name"
              class="sf-sb-field-node"
              draggable="true"
              @dragstart="onDragStart($event, field.name)"
              @dblclick.stop="emit('insert', field.name)"
            >
              <span class="sf-sb-col-badge badge" :class="fieldBadgeClass(field.type)">{{ shortType(field.type) }}</span>
              <span class="sf-sb-fname">{{ field.name }}</span>
              <span class="sf-sb-flabel">{{ field.label }}</span>
            </div>
          </template>
        </template>
      </template>
      <div v-if="filtered.length === 0" class="empty-state" style="padding:24px 12px; font-size:12px;">No objects</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useConnectionStore } from '../stores/connection'
import type { SObjectSummary, FieldDescriptor } from '../../../shared/types'

const props = defineProps<{ objects: SObjectSummary[] }>()
const emit = defineEmits<{ insert: [text: string] }>()

const conn = useConnectionStore()
const sfConn = computed(() => conn.sfConnected)
const refreshing = ref(false)

async function ensureObjectsLoaded(): Promise<void> {
  if (conn.sfConnected) await conn.loadSFObjects()
}

async function refresh(): Promise<void> {
  refreshing.value = true
  fieldCache.value = new Map()
  expanded.value = new Set()
  try {
    await conn.refreshSFObjects()
  } finally {
    refreshing.value = false
  }
}

onMounted(ensureObjectsLoaded)
watch(() => conn.sfConnected, ensureObjectsLoaded)

const search = ref('')
const expanded = ref<Set<string>>(new Set())
const fieldCache = ref<Map<string, FieldDescriptor[]>>(new Map())
const loadingFields = ref<Set<string>>(new Set())

const filtered = computed(() => {
  const q = search.value.toLowerCase()
  if (!q) return props.objects
  return props.objects.filter(
    (o) =>
      o.name.toLowerCase().includes(q) ||
      o.label.toLowerCase().includes(q) ||
      (fieldCache.value.get(o.name) ?? []).some(
        (f) => f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q)
      )
  )
})

async function toggle(name: string): Promise<void> {
  if (expanded.value.has(name)) {
    expanded.value.delete(name)
    return
  }
  expanded.value.add(name)
  if (!fieldCache.value.has(name)) {
    loadingFields.value.add(name)
    try {
      const fields = await window.api.describeObject(name)
      fieldCache.value.set(name, fields)
    } catch {
      fieldCache.value.set(name, [])
    } finally {
      loadingFields.value.delete(name)
    }
  }
}

function onDragStart(e: DragEvent, name: string): void {
  e.dataTransfer?.setData('text/plain', name)
}

function shortType(t: string): string {
  if (!t) return 'T'
  const u = t.toLowerCase()
  if (['int', 'double', 'currency', 'percent'].some((x) => u.includes(x))) return '#'
  if (u.includes('bool') || u === 'checkbox') return 'B'
  if (u.includes('date') || u.includes('time')) return 'D'
  if (u === 'id' || u.includes('reference')) return 'ID'
  return 'T'
}

function fieldBadgeClass(t: string): string {
  const s = shortType(t)
  if (s === '#') return 'badge-blue'
  if (s === 'B') return 'badge-purple'
  if (s === 'D') return 'badge-amber'
  if (s === 'ID') return 'badge-green'
  return 'badge-gray'
}
</script>

<style scoped>
.sf-sb-wrap { display: flex; flex-direction: column; height: 100%; }
.sf-sb-header { padding: 8px; border-bottom: 1px solid var(--border); display: flex; gap: 4px; align-items: center; }
.sf-sb-search { flex: 1; min-width: 0; font-size: 12px; padding: 5px 8px; }
.sf-sb-refresh { flex-shrink: 0; width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; font-size: 14px; color: var(--text-muted); }
.sf-sb-refresh:hover:not(:disabled) { background: var(--surface2); color: var(--text); }
.sf-sb-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.sf-sb-tree { flex: 1; overflow-y: auto; }
.sf-sb-obj-node { display: flex; align-items: center; gap: 4px; padding: 5px 8px; cursor: pointer; font-size: 13px; font-weight: 500; user-select: none; }
.sf-sb-obj-node:hover { background: var(--surface2); }
.sf-sb-chevron { font-size: 9px; color: var(--text-muted); width: 10px; }
.sf-sb-icon { font-size: 11px; color: var(--text-muted); }
.sf-sb-oname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf-sb-loading { display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 26px; font-size: 12px; color: var(--text-muted); }
.sf-sb-field-node { display: flex; align-items: center; gap: 5px; padding: 3px 8px 3px 26px; cursor: grab; font-size: 12px; }
.sf-sb-field-node:hover { background: var(--surface2); }
.sf-sb-col-badge { width: 16px; height: 16px; font-size: 9px; border-radius: 2px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.sf-sb-fname { font-family: monospace; white-space: nowrap; }
.sf-sb-flabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted); margin-left: 4px; }
</style>
