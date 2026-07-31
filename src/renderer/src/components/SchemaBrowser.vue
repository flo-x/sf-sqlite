<template>
  <div class="sb-wrap">
    <div class="sb-header">
      <input v-model="search" type="text" placeholder="Filter tables/columns…" class="sb-search" />
      <button class="sb-refresh" :disabled="refreshing" :title="refreshing ? 'Refreshing…' : 'Refresh schema'" @click="refresh">
        <span v-if="refreshing" class="spinner" style="width:10px;height:10px;border-width:2px;"></span>
        <span v-else>↻</span>
      </button>
    </div>
    <div class="sb-tree">
      <template v-for="table in filtered" :key="table.name">
        <div
          class="sb-table-node"
          draggable="true"
          @dragstart="onDragStart($event, table.name)"
          @click="toggle(table.name)"
          @dblclick.stop="emit('insert', quoteIfNeeded(table.name))"
          @contextmenu.prevent="showContextMenu($event, table)"
        >
          <span class="sb-chevron">{{ expanded.has(table.name) ? '▼' : '▶' }}</span>
          <span class="sb-icon">{{ table.type === 'view' ? '👁' : '▦' }}</span>
          <span class="sb-tname">{{ table.name }}</span>
        </div>
        <template v-if="expanded.has(table.name)">
          <div
            v-for="col in table.columns"
            :key="col.name"
            class="sb-col-node"
            draggable="true"
            @dragstart="onDragStart($event, col.name)"
            @dblclick.stop="emit('insert', quoteIfNeeded(col.name))"
          >
            <span class="sb-col-badge badge" :class="colBadgeClass(col.type)">{{ shortType(col.type) }}</span>
            <span class="sb-cname">{{ col.name }}</span>
          </div>
        </template>
      </template>
      <div v-if="!filtered.length" class="empty-state" style="padding: 24px 12px; font-size: 12px;">No tables</div>
    </div>

    <!-- Context menu -->
    <div v-if="ctxMenu" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }">
      <div class="ctx-item" @click="ctxSelectAll">SELECT * FROM {{ ctxMenu.table.name }}</div>
      <div class="ctx-item" @click="copyName">Copy name</div>
      <div class="ctx-item" @click="openInExplorer">Open in Explorer</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import type { TableInfo } from '../../../shared/types'
import { useConnectionStore } from '../stores/connection'

const props = defineProps<{ tables: TableInfo[] }>()
const emit = defineEmits<{ insert: [text: string]; openExplorer: [name: string] }>()

const conn = useConnectionStore()
const search = ref('')
const expanded = ref<Set<string>>(new Set())
const refreshing = ref(false)
const router = useRouter()

async function refresh(): Promise<void> {
  refreshing.value = true
  try {
    await conn.refreshDbInfo()
  } finally {
    refreshing.value = false
  }
}

const filtered = computed(() => {
  const q = search.value.toLowerCase()
  if (!q) return props.tables
  return props.tables.filter(
    (t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q))
  )
})

function toggle(name: string): void {
  if (expanded.value.has(name)) expanded.value.delete(name)
  else expanded.value.add(name)
}

function quoteIfNeeded(name: string): string {
  return /[^a-zA-Z0-9_]/.test(name) ? `"${name}"` : name
}

function onDragStart(e: DragEvent, name: string): void {
  e.dataTransfer?.setData('text/plain', quoteIfNeeded(name))
}

function shortType(t: string): string {
  if (!t) return 'T'
  const u = t.toUpperCase()
  if (['REAL', 'INTEGER', 'NUMERIC', 'FLOAT', 'DOUBLE'].some((x) => u.includes(x))) return '#'
  if (u.includes('BOOL')) return 'B'
  if (u.includes('DATE') || u.includes('TIME')) return 'D'
  return 'T'
}

function colBadgeClass(t: string): string {
  const s = shortType(t)
  if (s === '#') return 'badge-blue'
  if (s === 'B') return 'badge-purple'
  if (s === 'D') return 'badge-amber'
  return 'badge-gray'
}

// Context menu
interface CtxMenu { x: number; y: number; table: TableInfo }
const ctxMenu = ref<CtxMenu | null>(null)
function showContextMenu(e: MouseEvent, table: TableInfo): void {
  ctxMenu.value = { x: e.clientX, y: e.clientY, table }
}
function ctxSelectAll(): void {
  if (!ctxMenu.value) return
  emit('insert', `SELECT * FROM ${quoteIfNeeded(ctxMenu.value.table.name)}`)
  ctxMenu.value = null
}
function copyName(): void {
  if (!ctxMenu.value) return
  navigator.clipboard.writeText(ctxMenu.value.table.name)
  ctxMenu.value = null
}
function openInExplorer(): void {
  if (!ctxMenu.value) return
  emit('openExplorer', ctxMenu.value.table.name)
  router.push('/explorer')
  ctxMenu.value = null
}

const closeCtx = (): void => { ctxMenu.value = null }
onMounted(() => document.addEventListener('click', closeCtx))
onUnmounted(() => document.removeEventListener('click', closeCtx))
</script>

<style scoped>
.sb-wrap { display: flex; flex-direction: column; height: 100%; }
.sb-header { padding: 8px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 6px; }
.sb-search { flex: 1; min-width: 0; font-size: 12px; padding: 5px 8px; }
.sb-refresh { flex-shrink: 0; width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; font-size: 14px; color: var(--text-muted); }
.sb-refresh:hover:not(:disabled) { background: var(--surface2); color: var(--text); }
.sb-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.sb-tree { flex: 1; overflow-y: auto; }
.sb-table-node { display: flex; align-items: center; gap: 4px; padding: 5px 8px; cursor: pointer; font-size: 13px; font-weight: 500; user-select: none; }
.sb-table-node:hover { background: var(--surface2); }
.sb-chevron { font-size: 9px; color: var(--text-muted); width: 10px; }
.sb-icon { font-size: 13px; }
.sb-tname { flex: 1; }
.sb-col-node { display: flex; align-items: center; gap: 5px; padding: 3px 8px 3px 26px; cursor: grab; font-size: 12px; }
.sb-col-node:hover { background: var(--surface2); }
.sb-col-badge { width: 16px; height: 16px; font-size: 9px; border-radius: 2px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.sb-cname { flex: 1; font-family: monospace; }
.ctx-menu { position: fixed; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow-md); z-index: 500; min-width: 180px; }
.ctx-item { padding: 8px 14px; font-size: 13px; cursor: pointer; }
.ctx-item:hover { background: var(--surface2); }
</style>
