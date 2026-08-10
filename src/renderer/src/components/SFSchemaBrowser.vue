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
            <template v-if="(relCache.get(obj.name) ?? []).length">
              <div class="sf-sb-section" @click.stop="toggleRels(obj.name)">
                <span class="sf-sb-chevron">{{ relExpanded.has(obj.name) ? '▼' : '▶' }}</span>
                Related via
                <span class="sf-sb-rel-count">({{ (relCache.get(obj.name) ?? []).length }})</span>
              </div>
              <template v-if="relExpanded.has(obj.name)">
                <div
                  v-for="rel in (relCache.get(obj.name) ?? [])"
                  :key="`${rel.childSObject}.${rel.field}`"
                  class="sf-sb-rel-node"
                  draggable="true"
                  @dragstart="onDragStart($event, relInsertText(rel))"
                  @dblclick.stop="emit('insert', relInsertText(rel))"
                  :title="relTitle(rel)"
                >
                  <span class="sf-sb-col-badge badge badge-green">↔</span>
                <span class="sf-sb-fname">{{ rel.relationshipName }}</span>
                <span class="sf-sb-flabel">{{ rel.childSObject }}.{{ rel.field }}</span>
                </div>
              </template>
            </template>
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
import type { SObjectSummary, FieldDescriptor, ChildRelationshipDescriptor } from '../../../shared/types'

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
  relCache.value = new Map()
  expanded.value = new Set()
  relExpanded.value = new Set()
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
const relExpanded = ref<Set<string>>(new Set())
const fieldCache = ref<Map<string, FieldDescriptor[]>>(new Map())
const relCache = ref<Map<string, ChildRelationshipDescriptor[]>>(new Map())
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
      ) ||
      (relCache.value.get(o.name) ?? []).some(
        (r) =>
          r.relationshipName.toLowerCase().includes(q) ||
          r.childSObject.toLowerCase().includes(q) ||
          r.field.toLowerCase().includes(q)
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
      const result = await window.api.describeObject(name)
      fieldCache.value.set(name, result.fields)
      relCache.value.set(name, result.childRelationships)
    } catch {
      fieldCache.value.set(name, [])
      relCache.value.set(name, [])
    } finally {
      loadingFields.value.delete(name)
    }
  }
}

function toggleRels(name: string): void {
  if (relExpanded.value.has(name)) {
    relExpanded.value.delete(name)
  } else {
    relExpanded.value.add(name)
  }
}

function onDragStart(e: DragEvent, name: string): void {
  e.dataTransfer?.setData('text/plain', name)
}

function relInsertText(rel: ChildRelationshipDescriptor): string {
  return rel.relationshipName
}

function relTitle(rel: ChildRelationshipDescriptor): string {
  return `${rel.relationshipName} — ${rel.childSObject}.${rel.field}`
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
.sf-sb-section { display: flex; align-items: center; gap: 4px; padding: 8px 8px 2px 26px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); cursor: pointer; user-select: none; }
.sf-sb-section:hover { color: var(--text); }
.sf-sb-rel-count { font-weight: 500; text-transform: none; letter-spacing: 0; }
.sf-sb-rel-node { display: flex; align-items: center; gap: 5px; padding: 3px 8px 3px 26px; cursor: grab; font-size: 12px; }
.sf-sb-rel-node:hover { background: var(--surface2); }
.sf-sb-col-badge { width: 16px; height: 16px; font-size: 9px; border-radius: 2px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.sf-sb-fname { font-family: monospace; white-space: nowrap; }
.sf-sb-flabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted); margin-left: 4px; }
</style>
