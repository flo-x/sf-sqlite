<template>
  <div class="split-view" v-if="conn.dbConnected" ref="splitContainer">
    <!-- Left: table tree + CSV import (vertical split) -->
    <div class="split-left" :style="{ width: splitW + 'px' }">
      <!-- Table tree -->
      <div class="left-top" :style="{ flexBasis: leftTopH + 'px' }">
        <div class="section-title" style="padding: 10px 14px 4px; display:flex; align-items:center; justify-content:space-between;">
          <span>Tables ({{ tables.length }}) · Views ({{ views.length }})</span>
          <button
            class="btn btn-ghost btn-sm"
            :disabled="refreshing"
            @click="refreshSchema"
            title="Refresh schema"
            style="padding: 2px 6px; font-size:13px;"
          >{{ refreshing ? '…' : '↻' }}</button>
        </div>
        <div v-for="t in allItems" :key="t.name">
          <div
            class="tree-item"
            :class="{ selected: selectedTable?.name === t.name }"
            @click="selectTable(t)"
            @dblclick.stop="startRenameInline(t)"
            @contextmenu.prevent="showCtx($event, t)"
          >
            <span class="tree-icon">{{ t.type === 'view' ? '👁' : '▦' }}</span>
            <input
              v-if="renaming && selectedTableName === t.name"
              ref="tableRenameInput"
              v-model="renameValue"
              class="tree-rename-input"
              @keydown.enter.prevent="confirmRename"
              @keydown.escape.prevent="abortTableRename"
              @blur="confirmRename"
              @click.stop
            />
            <span v-else class="tree-name">{{ t.name }}</span>
            <span class="tree-count">{{ t.rowCount }}</span>
          </div>
        </div>
        <div v-if="!allItems.length" class="empty-state" style="padding: 24px 12px; font-size:13px;">
          No tables
        </div>
      </div>

      <!-- Horizontal drag divider -->
      <div class="left-h-divider" @mousedown.prevent="startLeftDrag" ref="leftDivider"></div>

      <!-- CSV drop zone (always visible, just triggers file selection) -->
      <div class="left-bottom">
        <div class="section-title" style="padding: 8px 14px 4px;">Import CSV</div>
        <div
          class="csv-drop-zone"
          :class="{ 'csv-drop-zone-over': csvDragOver, 'csv-drop-zone-active': csvPreview?.source === 'file' }"
          @dragover.prevent="csvDragOver = true"
          @dragleave="csvDragOver = false"
          @drop.prevent="onCsvDrop"
          @click="pickCsvFile"
        >
          <span style="font-size:20px;">📂</span>
          <span v-if="csvPreview?.source !== 'file'">Drop CSV or click to browse</span>
          <span v-else class="csv-drop-zone-filename">{{ csvPreview.filePath.split(/[\\/]/).pop() }}</span>
        </div>
        <textarea
          ref="csvPasteRef"
          class="csv-paste-area"
          :class="{ 'csv-paste-area-active': csvPreview?.source === 'paste' }"
          placeholder="Or paste CSV text here…"
          @paste.prevent="onCsvPaste"
        ></textarea>
      </div>
    </div>

    <!-- Draggable divider -->
    <div class="split-divider" @mousedown.prevent="startDrag"></div>

    <!-- Right: detail or CSV import -->
    <div class="split-right" style="padding: 0; display: flex; flex-direction: column;">

      <!-- CSV import panel -->
      <template v-if="csvPreview">
        <div class="toolbar">
          <span style="font-weight:600; font-size:15px;">Import CSV</span>
          <span class="badge badge-gray" style="margin-left:4px;">{{ csvPreview.totalLines.toLocaleString() }} rows · {{ csvPreview.headers.length }} cols</span>
          <div class="toolbar-right">
            <button class="btn btn-ghost btn-sm" @click="csvPreview = null; csvTableName = ''; csvError = ''; csvSuccess = ''">✕ Cancel</button>
          </div>
        </div>

        <!-- DataGrid preview — takes remaining height -->
        <DataGrid
          :columns="csvPreview.headers"
          :rows="csvDisplayRows"
          :showRowNumbers="true"
          style="flex: 1; min-height: 0;"
        />

        <!-- Form stays pinned at the bottom -->
        <div class="csv-right-body" style="flex: 0 0 auto;">
          <div class="csv-form">
            <label>Target table name</label>
            <input
              v-model="csvTableName"
              type="text"
              placeholder="Table name"
              @keydown.enter="importCsv"
            />
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:4px;cursor:pointer;">
              <input type="checkbox" v-model="csvReplace" style="margin:0;" />
              Replace table if it already exists
            </label>
            <div v-if="csvError" class="csv-error" style="margin-top:6px;">{{ csvError }}</div>
            <div v-if="csvSuccess" class="csv-success" style="margin-top:6px;">{{ csvSuccess }}</div>
            <button
              class="btn btn-primary"
              style="margin-top:12px; align-self:flex-start;"
              :disabled="!csvTableName.trim() || csvImporting"
              @click="importCsv"
            >
              <span v-if="csvImporting" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              Import {{ csvPreview.totalLines.toLocaleString() }} rows
            </button>
          </div>
        </div><!-- csv-right-body -->
      </template>

      <div v-else-if="!selectedTable" class="empty-state" style="height:100%;">
        <div class="empty-state-icon">▦</div>
        <div>Select a table to inspect</div>
      </div>

      <template v-else>
        <div class="toolbar">
          <span style="font-weight:600; font-size:15px;">{{ selectedTable.name }}</span>
          <span class="badge badge-gray" style="margin-left: 4px;">{{ selectedTable.rowCount.toLocaleString() }} rows</span>
          <div class="toolbar-right">
            <button class="btn btn-ghost btn-sm" @click="openInQuery">Open in Query Editor</button>
            <button class="btn btn-ghost btn-sm" @click="startRename">Rename</button>
            <button class="btn btn-danger btn-sm" @click="dropTable">Delete</button>
          </div>
        </div>

        <!-- Tabs -->
        <div class="tab-bar">
          <div class="tab-item" :class="{ active: activeTab === 'columns' }" @click="activeTab = 'columns'">Columns</div>
          <div class="tab-item" :class="{ active: activeTab === 'indexes' }" @click="activeTab = 'indexes'">Indexes</div>
          <div class="tab-item" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'; loadPreview()">Preview</div>
        </div>

        <!-- Columns tab -->
        <div v-if="activeTab === 'columns'" class="tab-content">
          <table class="data-table">
            <thead>
              <tr><th>Column <span style="font-weight:400; font-size:10px; opacity:0.6;">(double-click to rename)</span></th><th>Type</th><th>Not Null</th><th>Default</th><th>PK</th><th>Indexed</th></tr>
            </thead>
            <tbody>
              <tr v-for="col in selectedTable.columns" :key="col.name">
                <td class="col-name-cell" @dblclick="startColRename(col.name)">
                  <input
                    v-if="renamingCol === col.name"
                    ref="colRenameInput"
                    v-model="renameColValue"
                    class="col-rename-input"
                    @keydown.enter.prevent="confirmColRename"
                    @keydown.escape.prevent="abortColRename"
                    @blur="confirmColRename"
                    @click.stop
                  />
                  <strong v-else>{{ col.name }}</strong>
                </td>
                <td><code>{{ col.type || 'TEXT' }}</code></td>
                <td>{{ col.notNull ? '✓' : '' }}</td>
                <td style="color:var(--text-muted);">{{ col.defaultValue ?? '—' }}</td>
                <td>{{ col.primaryKey ? '★' : '' }}</td>
                <td class="idx-cell">
                  <span v-if="colIsIndexed(col.name)" class="idx-badge" title="This column has an index">Yes</span>
                  <button
                    v-else-if="!col.primaryKey"
                    class="btn btn-ghost btn-sm idx-add-btn"
                    :disabled="addingIndex === col.name"
                    title="Create index on this column"
                    @click="addIndex(col.name)"
                  >
                    <span v-if="addingIndex === col.name" class="spinner" style="width:10px;height:10px;border-width:1.5px;"></span>
                    <span v-else>+</span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Indexes tab -->
        <div v-if="activeTab === 'indexes'" class="tab-content">
          <div v-if="!selectedTable.indexes.length" class="empty-state" style="padding:24px;">No indexes</div>
          <table v-else class="data-table">
            <thead><tr><th>Name</th><th>Unique</th><th>Columns</th><th></th></tr></thead>
            <tbody>
              <tr v-for="idx in selectedTable.indexes" :key="idx.name">
                <td>{{ idx.name }}</td>
                <td>{{ idx.unique ? '✓' : '' }}</td>
                <td>{{ idx.columns.join(', ') }}</td>
                <td style="text-align:right; padding-right:10px;">
                  <button
                    class="btn btn-ghost btn-sm idx-drop-btn"
                    :disabled="droppingIndex === idx.name"
                    title="Delete index"
                    @click="dropIndex(idx.name)"
                  >
                    <span v-if="droppingIndex === idx.name" class="spinner" style="width:10px;height:10px;border-width:1.5px;"></span>
                    <span v-else>✕</span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Preview tab -->
        <div v-if="activeTab === 'preview'" class="tab-content" style="overflow:hidden; display:flex; flex-direction:column;">
          <div v-if="previewLoading" style="padding:24px; display:flex; align-items:center; gap:8px;">
            <span class="spinner"></span> Loading…
          </div>
          <DataGrid
            v-else
            :columns="previewCols"
            :rows="previewRows"
            :showRowNumbers="true"
            :onExportCsv="exportTableCsv"
            :exportingCsv="exportingCsv"
            style="flex:1;"
          />
        </div>
      </template>
    </div>

    <!-- Context menu -->
    <div v-if="ctxMenu" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }">
      <div class="ctx-item" @click="openInQueryCtx">Open in Query Editor</div>
      <div class="ctx-item" @click="startRenameCtx">Rename</div>
      <div class="ctx-item ctx-danger" @click="dropTableCtx">Delete</div>
    </div>
  </div>

  <div v-else class="empty-state" style="height:100%;">
    <div class="empty-state-icon">🗄</div>
    <div>Open a SQLite database first</div>
    <router-link to="/connections" class="btn btn-primary btn-sm">Go to Connections</router-link>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useConnectionStore } from '../stores/connection'
import { useQueryStore } from '../stores/query'
import DataGrid from '../components/DataGrid.vue'
import type { TableInfo, CsvPreview } from '../../../shared/types'

const conn = useConnectionStore()
const queryStore = useQueryStore()
const router = useRouter()

// ── Horizontal (left/right) split ─────────────────────────────────────────────
const SPLIT_KEY = 'explorer-split-w'
const splitW = ref<number>(Number(localStorage.getItem(SPLIT_KEY)) || 240)
const splitContainer = ref<HTMLElement | null>(null)

function startDrag(e: MouseEvent): void {
  const startX = e.clientX
  const startW = splitW.value
  const onMove = (ev: MouseEvent): void => {
    const containerW = splitContainer.value?.offsetWidth ?? 0
    splitW.value = Math.min(containerW - 200, Math.max(140, startW + (ev.clientX - startX)))
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(SPLIT_KEY, String(Math.round(splitW.value)))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── Vertical (top/bottom) split inside left panel ─────────────────────────────
const LEFT_SPLIT_KEY = 'explorer-left-top-h'
const leftTopH = ref<number>(Number(localStorage.getItem(LEFT_SPLIT_KEY)) || 260)
const leftDivider = ref<HTMLElement | null>(null)

function startLeftDrag(e: MouseEvent): void {
  const startY = e.clientY
  const startH = leftTopH.value
  const leftPanel = leftDivider.value?.closest('.split-left') as HTMLElement | null
  const onMove = (ev: MouseEvent): void => {
    const panelH = leftPanel?.offsetHeight ?? 0
    leftTopH.value = Math.min(panelH - 120, Math.max(80, startH + (ev.clientY - startY)))
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(LEFT_SPLIT_KEY, String(Math.round(leftTopH.value)))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── CSV Import ─────────────────────────────────────────────────────────────────
type CsvPreviewEx = CsvPreview & { source: 'file' | 'paste'; rawText?: string }

const csvPreview = ref<CsvPreviewEx | null>(null)
const csvTableName = ref('')
const csvReplace = ref(true)
const csvDragOver = ref(false)
const csvImporting = ref(false)
const csvError = ref('')
const csvSuccess = ref('')
const csvPasteRef = ref<HTMLTextAreaElement | null>(null)

async function pickCsvFile(): Promise<void> {
  const preview = await window.api.csvPickAndPreview()
  if (preview) loadCsvPreview(preview, 'file')
}

async function onCsvDrop(e: DragEvent): Promise<void> {
  csvDragOver.value = false
  const file = e.dataTransfer?.files[0]
  if (!file) return
  const filePath = (file as File & { path?: string }).path
  if (!filePath) return
  const preview = await window.api.csvPreviewPath(filePath)
  loadCsvPreview(preview, 'file')
}

function loadCsvPreview(preview: CsvPreview, source: 'file' | 'paste', rawText?: string): void {
  csvPreview.value = { ...preview, source, rawText }
  csvError.value = ''
  csvSuccess.value = ''
  if (source === 'file') {
    const base = preview.filePath.split(/[\\/]/).pop() ?? ''
    csvTableName.value = base.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').toLowerCase()
  }
}

// ── Paste CSV ──────────────────────────────────────────────────────────────────
function onCsvPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text') ?? ''
  if (!text.trim()) return
  // Clear the textarea so it doesn't accumulate text
  if (csvPasteRef.value) csvPasteRef.value.value = ''
  const parsed = parseCsvPreview(text)
  if (!parsed) return
  loadCsvPreview(
    { filePath: '', headers: parsed.headers, rows: parsed.rows, totalLines: parsed.totalLines },
    'paste',
    text
  )
}

/** Rows shown in the DataGrid: all parsed rows for paste, preview rows for file. */
const csvDisplayRows = computed<unknown[][]>(() => {
  if (!csvPreview.value) return []
  if (csvPreview.value.source === 'paste' && csvPreview.value.rawText) {
    const parsed = parseCsvAll(csvPreview.value.rawText)
    return parsed ? parsed.rows : csvPreview.value.rows
  }
  return csvPreview.value.rows
})

/** Minimal RFC-4180 CSV parser for client-side preview (no file I/O needed). */
function parseCsvPreview(text: string): { headers: string[]; rows: string[][]; totalLines: number } | null {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length === 0) return null

  function parseRow(line: string): string[] {
    const result: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (ch === ',' && !inQ) {
        result.push(cur); cur = ''
      } else {
        cur += ch
      }
    }
    result.push(cur)
    return result
  }

  const headers = parseRow(lines[0])
  const rows = lines.slice(1, 6).map(parseRow)
  return { headers, rows, totalLines: lines.length - 1 }
}

/** Same parser but returns ALL data rows (used for DataGrid display of pasted CSV). */
function parseCsvAll(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length === 0) return null

  function parseRow(line: string): string[] {
    const result: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (ch === ',' && !inQ) {
        result.push(cur); cur = ''
      } else {
        cur += ch
      }
    }
    result.push(cur)
    return result
  }

  const headers = parseRow(lines[0])
  const rows = lines.slice(1).filter((l) => l.trim()).map(parseRow)
  return { headers, rows }
}

async function importCsv(): Promise<void> {
  if (!csvPreview.value || !csvTableName.value.trim()) return
  csvError.value = ''
  csvSuccess.value = ''
  csvImporting.value = true
  try {
    const ifExists = csvReplace.value ? 'replace' as const : 'append' as const
    const tableName = csvTableName.value.trim()
    let count: number
    if (csvPreview.value.source === 'paste' && csvPreview.value.rawText) {
      count = await window.api.csvImportText(csvPreview.value.rawText, tableName, ifExists)
    } else {
      count = await window.api.csvImport(csvPreview.value.filePath, tableName, ifExists)
    }
    csvSuccess.value = `Imported ${count.toLocaleString()} rows into "${tableName}"`
    await conn.refreshDbInfo()
    await nextTick()
    csvPreview.value = null
    csvTableName.value = ''
  } catch (err) {
    csvError.value = err instanceof Error ? err.message : String(err)
  } finally {
    csvImporting.value = false
  }
}

// selectedTableName drives everything — selectedTable is derived reactively so
// any update to conn.dbTables (refresh, rename, drop, CSV import) is picked up
// automatically with no manual syncing.
const selectedTableName = ref<string | null>(null)
const selectedTable = computed(() =>
  selectedTableName.value
    ? (conn.dbTables.find((t) => t.name === selectedTableName.value) ?? null)
    : null
)
// Clear stale preview when the selected table's schema changes.
watch(selectedTable, () => { previewRows.value = [] })

const activeTab = ref<'columns' | 'indexes' | 'preview'>('columns')
const previewCols = ref<string[]>([])
const previewRows = ref<unknown[][]>([])
const previewLoading = ref(false)
const renaming = ref(false)
const renameValue = ref('')

// Table rename (inline in tree) — ref is inside v-for so Vue collects it as an array
const tableRenameInput = ref<HTMLInputElement[]>([])
let tableRenameAborted = false   // set on Escape to prevent blur from saving

// Column rename — same v-for caveat
const renamingCol = ref<string | null>(null)
const renameColValue = ref('')
const colRenameInput = ref<HTMLInputElement[]>([])
let colRenameAborted = false     // set on Escape to prevent blur from saving

interface CtxMenu { x: number; y: number; table: TableInfo }
const ctxMenu = ref<CtxMenu | null>(null)

const tables = computed(() => conn.dbTables.filter((t) => t.type === 'table'))
const views = computed(() => conn.dbTables.filter((t) => t.type === 'view'))
const allItems = computed(() => [...tables.value, ...views.value])

const refreshing = ref(false)
async function refreshSchema(): Promise<void> {
  refreshing.value = true
  try {
    await conn.refreshDbInfo()
    // selectedTable updates automatically via the computed — nothing extra needed.
  } finally {
    refreshing.value = false
  }
}

onMounted(() => { document.addEventListener('click', () => { ctxMenu.value = null }) })

function selectTable(t: TableInfo): void {
  selectedTableName.value = t.name
  activeTab.value = 'columns'
}

async function loadPreview(): Promise<void> {
  if (!selectedTable.value) return
  previewLoading.value = true
  try {
    const result = await window.api.executeQuery(`SELECT * FROM "${selectedTable.value.name}" LIMIT 100`)
    previewCols.value = result.columns
    previewRows.value = result.rows
  } finally {
    previewLoading.value = false
  }
}

const exportingCsv = ref(false)

async function exportTableCsv(): Promise<void> {
  if (!selectedTable.value) return
  exportingCsv.value = true
  try {
    const result = await window.api.executeQuery(`SELECT * FROM "${selectedTable.value.name}"`)
    if (result.error) throw new Error(result.error)
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s
    }
    const csv = [result.columns.map(escape).join(','), ...result.rows.map((r) => r.map(escape).join(','))].join('\n')
    await window.api.exportToCsv(csv)
  } finally {
    exportingCsv.value = false
  }
}

async function openInQuery(): Promise<void> {
  if (!selectedTable.value) return
  if (!queryStore.initialized) {
    const queries = await window.api.listSavedQueries()
    queryStore.loadFromSaved(queries)
  }
  queryStore.newTab(selectedTable.value.name, `SELECT * FROM "${selectedTable.value.name}" LIMIT 100`)
  router.push('/query')
}

function openInQueryCtx(): void {
  openInQuery()
  ctxMenu.value = null
}

function showCtx(e: MouseEvent, t: TableInfo): void {
  selectedTableName.value = t.name
  ctxMenu.value = { x: e.clientX, y: e.clientY, table: t }
}

function startRename(): void {
  if (!selectedTable.value) return
  tableRenameAborted = false
  renameValue.value = selectedTable.value.name
  renaming.value = true
  nextTick(() => tableRenameInput.value[0]?.select())
}

function startRenameInline(t: TableInfo): void {
  selectedTableName.value = t.name
  startRename()
}

function startRenameCtx(): void {
  startRename()
  ctxMenu.value = null
}

async function confirmRename(): Promise<void> {
  if (!renaming.value) return  // guard double-fire from blur after Enter
  if (tableRenameAborted) { tableRenameAborted = false; renaming.value = false; return }
  const oldName = selectedTable.value?.name
  const newName = renameValue.value.trim()
  renaming.value = false
  if (!oldName || !newName || newName === oldName) return
  await window.api.renameTable(oldName, newName)
  await conn.refreshDbInfo()
  selectedTableName.value = newName
}

function abortTableRename(): void {
  tableRenameAborted = true
  renaming.value = false
}

async function dropTable(): Promise<void> {
  if (!selectedTable.value || !confirm(`Delete table "${selectedTable.value.name}"?`)) return
  await window.api.dropTable(selectedTable.value.name)
  selectedTableName.value = null
  await conn.refreshDbInfo()
}

async function dropTableCtx(): Promise<void> {
  ctxMenu.value = null
  await dropTable()
}

function startColRename(colName: string): void {
  colRenameAborted = false
  renamingCol.value = colName
  renameColValue.value = colName
  nextTick(() => colRenameInput.value[0]?.select())
}

function abortColRename(): void {
  colRenameAborted = true
  renamingCol.value = null
}

const droppingIndex = ref<string | null>(null)

async function dropIndex(indexName: string): Promise<void> {
  if (!confirm(`Delete index "${indexName}"?`)) return
  droppingIndex.value = indexName
  try {
    await window.api.dropIndex(indexName)
    await conn.refreshDbInfo()
  } finally {
    droppingIndex.value = null
  }
}

function colIsIndexed(colName: string): boolean {
  return selectedTable.value?.indexes.some((idx) => idx.columns.includes(colName)) ?? false
}

const addingIndex = ref<string | null>(null)

async function addIndex(colName: string): Promise<void> {
  if (!selectedTable.value) return
  addingIndex.value = colName
  try {
    await window.api.createColumnIndex(selectedTable.value.name, colName)
    await conn.refreshDbInfo()
  } finally {
    addingIndex.value = null
  }
}

async function confirmColRename(): Promise<void> {
  if (!renamingCol.value) return  // guard double-fire from blur after Enter
  if (colRenameAborted) { colRenameAborted = false; renamingCol.value = null; return }
  const table = selectedTable.value
  const oldName = renamingCol.value
  const newName = renameColValue.value.trim()
  renamingCol.value = null  // close before async work to prevent double-fire on blur
  if (!table || !newName || newName === oldName) return
  await window.api.renameColumn(table.name, oldName, newName)
  await conn.refreshDbInfo()
}
</script>

<style scoped>
/* Left/right split */
.split-left { border-right: none !important; display: flex; flex-direction: column; overflow: hidden; }
.split-divider { width: 5px; flex-shrink: 0; cursor: col-resize; position: relative; z-index: 1; background: transparent; border-right: 1px solid var(--border); }
.split-divider::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px; border-radius: 99px; background: var(--border); transition: background 0.15s, height 0.15s; }
.split-divider:hover::after, .split-divider:active::after { background: var(--primary); height: 64px; }

/* Top/bottom split inside left panel */
.left-top { flex-shrink: 1; flex-grow: 0; min-height: 80px; overflow-y: auto; }
.left-h-divider { height: 5px; flex-shrink: 0; cursor: row-resize; position: relative; z-index: 1; background: transparent; border-top: 1px solid var(--border); }
.left-h-divider::after { content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); height: 3px; width: 36px; border-radius: 99px; background: var(--border); transition: background 0.15s, width 0.15s; }
.left-h-divider:hover::after, .left-h-divider:active::after { background: var(--primary); width: 48px; }
.left-bottom { flex: 1 0 100px; overflow-y: auto; border-top: none; display: flex; flex-direction: column; }

/* Left panel CSV drop zone */
.csv-drop-zone { margin: 8px 8px 4px; border: 2px dashed var(--border); border-radius: var(--radius-sm); padding: 12px 8px; display: flex; flex-direction: column; align-items: center; gap: 5px; cursor: pointer; font-size: 12px; color: var(--text-muted); transition: border-color 0.15s, background 0.15s; text-align: center; }
.csv-drop-zone:hover, .csv-drop-zone-over { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 5%, transparent); color: var(--primary); }
.csv-drop-zone-active { border-color: var(--primary); border-style: solid; background: color-mix(in srgb, var(--primary) 8%, transparent); color: var(--primary); }
.csv-drop-zone-filename { font-weight: 600; font-size: 11px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.csv-paste-area {
  display: block;
  margin: 0 8px 8px;
  width: calc(100% - 16px);
  height: 52px;
  resize: vertical;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}
.csv-paste-area::placeholder { color: var(--text-muted); opacity: 0.7; }
.csv-paste-area:focus { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 4%, var(--surface)); }
.csv-paste-area-active { border-color: var(--primary); border-style: solid; background: color-mix(in srgb, var(--primary) 8%, var(--surface)); color: var(--primary); }

/* Right panel CSV import form (pinned below DataGrid) */
.csv-right-body { overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); }
.csv-form { display: flex; flex-direction: column; gap: 6px; }
.csv-error { font-size: 12px; color: var(--danger); }
.csv-success { font-size: 12px; color: #166534; font-weight: 500; }
.tree-item { display: flex; align-items: center; gap: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.tree-item:hover { background: var(--surface2); }
.tree-item.selected { background: #eff6ff; font-weight: 600; }
.tree-icon { font-size: 13px; }
.tree-name { flex: 1; }
.tree-count { font-size: 11px; color: var(--text-muted); background: var(--surface2); padding: 1px 5px; border-radius: 999px; }
.tab-content { flex: 1; overflow: auto; }
.ctx-menu { position: fixed; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow-md); z-index: 500; min-width: 180px; }
.ctx-item { padding: 8px 14px; font-size: 13px; cursor: pointer; }
.ctx-item:hover { background: var(--surface2); }
.ctx-danger { color: var(--danger); }

.tree-item { position: relative; }
.tree-rename-input {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  padding: 0 4px;
  border: 1px solid var(--primary);
  border-radius: 3px;
  background: var(--surface);
  color: var(--text);
  outline: none;
  min-width: 0;
  box-sizing: border-box;
}

.idx-drop-btn { color: var(--danger); }
.idx-drop-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 10%, transparent); }
.idx-cell { width: 56px; text-align: center; }
.idx-badge { cursor: default; color: var(--primary); font-size: 13px; }
.idx-add-btn { padding: 1px 7px; font-size: 13px; line-height: 1; }
.col-name-cell { cursor: default; min-width: 120px; }
.col-name-cell:hover strong { text-decoration: underline dotted; text-underline-offset: 2px; }
.col-rename-input {
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  padding: 1px 5px;
  border: 1px solid var(--primary);
  border-radius: 3px;
  background: var(--surface);
  color: var(--text);
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
</style>
