<template>
  <div class="split-view" v-if="conn.dbConnected" ref="splitContainer">
    <!-- Left: table tree + CSV import (vertical split) -->
    <div class="split-left" :style="{ width: splitW + 'px' }">
      <!-- Table tree -->
      <div class="left-top" :style="{ flexBasis: leftTopH + 'px' }">
        <div class="section-title left-top-header" style="padding: 10px 14px 4px; display:flex; align-items:center; justify-content:space-between;">
          <span>Tables ({{ tables.length }}) · Views ({{ views.length }})</span>
          <button
            class="btn btn-ghost btn-sm"
            :disabled="refreshing"
            @click="refreshSchema"
            title="Refresh schema"
            style="padding: 2px 6px; font-size:13px;"
          >{{ refreshing ? '…' : '↻' }}</button>
        </div>
        <div class="left-top-scroll">
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
            </div>
          </div>
          <div v-if="!allItems.length" class="empty-state" style="padding: 24px 12px; font-size:13px;">
            No tables
          </div>
        </div>
      </div>

      <!-- Horizontal drag divider -->
      <div class="left-h-divider" @mousedown.prevent="startLeftDrag" ref="leftDivider"></div>

      <!-- CSV drop zone (always visible, just triggers file selection) -->
      <div class="left-bottom">
        <div class="section-title" style="padding: 6px 14px; display:flex; align-items:center; justify-content:space-between;">
          <span>Database</span>
          <button
            class="btn btn-ghost btn-sm"
            :disabled="vacuumChecking || vacuuming"
            title="Compact the database file by reclaiming freed pages"
            @click="vacuumDb"
          >
            <span v-if="vacuumChecking || vacuuming" class="spinner" style="width:10px;height:10px;border-width:1.5px;margin-right:4px;"></span>
            {{ vacuuming ? 'Vacuuming…' : vacuumChecking ? 'Checking…' : 'Vacuum DB' }}
          </button>
        </div>
        <div v-if="vacuumSuccess" style="font-size:12px; color:var(--success,#4caf50); padding:0 14px 6px;">{{ vacuumSuccess }}</div>
        <div v-if="vacuumError" style="font-size:12px; color:var(--danger); padding:0 14px 6px;">{{ vacuumError }}</div>
        <div class="section-title" style="padding: 8px 14px 4px;">Import CSV</div>
        <label style="display:flex; align-items:center; gap:6px; font-size:12px; padding:0 14px 6px; cursor:pointer;">
          <input type="checkbox" v-model="csvDirectLoad" style="margin:0;" />
          Direct load (no preview)
        </label>
        <div
          class="csv-drop-zone"
          :class="{ 'csv-drop-zone-over': csvDragOver, 'csv-drop-zone-active': csvDirectLoad ? !!csvDirectFile : csvPreview?.source === 'file' }"
          @dragover.prevent="csvDragOver = true"
          @dragleave="csvDragOver = false"
          @drop.prevent="onCsvDrop"
          @click="pickCsvFile"
        >
          <span style="font-size:20px;">📂</span>
          <span v-if="csvDirectLoad ? !csvDirectFile : csvPreview?.source !== 'file'">Drop CSV or click to browse</span>
          <span v-else class="csv-drop-zone-filename">{{ csvDirectLoad ? csvDirectFile?.fileName : csvPreview?.filePath.split(/[\\/]/).pop() }}</span>
        </div>
        <template v-if="!csvDirectLoad">
          <div class="csv-format-toggle">
            <button
              class="csv-fmt-btn"
              :class="{ active: csvPasteFormat === 'csv' }"
              @click="csvPasteFormat = 'csv'"
            >CSV</button>
            <button
              class="csv-fmt-btn"
              :class="{ active: csvPasteFormat === 'excel' }"
              @click="csvPasteFormat = 'excel'"
            >Excel / TSV</button>
          </div>
          <textarea
            ref="csvPasteRef"
            class="csv-paste-area"
            :class="{ 'csv-paste-area-active': csvPreview?.source === 'paste' }"
            :placeholder="csvPasteFormat === 'excel' ? 'Or paste Excel / TSV text here…' : 'Or paste CSV text here…'"
            @paste.prevent="onCsvPaste"
          ></textarea>
        </template>
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
        <div v-if="csvPreview.totalLines > csvDisplayRows.length" class="csv-preview-notice">
          Showing first {{ csvDisplayRows.length.toLocaleString() }} of {{ csvPreview.totalLines.toLocaleString() }} rows — all rows will be imported.
        </div>

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

      <!-- Direct load panel -->
      <template v-else-if="csvDirectFile">
        <div class="toolbar">
          <span style="font-weight:600; font-size:15px;">Direct Load</span>
          <span class="badge badge-gray" style="margin-left:4px;">{{ csvDirectFile.fileName }}</span>
          <div class="toolbar-right">
            <button
              class="btn btn-ghost btn-sm"
              @click="cancelOrResetDirectImport"
            >✕ Cancel</button>
          </div>
        </div>
        <div style="flex:1; display:flex; align-items:flex-start; padding:16px;">
          <div class="csv-form">
            <label>Target table name</label>
            <input
              v-model="csvTableName"
              type="text"
              placeholder="Table name"
              @keydown.enter="directImportCsv"
            />
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:4px;cursor:pointer;">
              <input type="checkbox" v-model="csvReplace" style="margin:0;" />
              Replace table if it already exists
            </label>
            <div v-if="csvError" class="csv-error" style="margin-top:6px;">{{ csvError }}</div>
            <div v-if="csvCancelled" class="csv-cancelled" style="margin-top:6px;">{{ csvCancelled }}</div>
            <div v-if="csvSuccess" class="csv-success" style="margin-top:6px;">{{ csvSuccess }}</div>
            <button
              class="btn btn-primary"
              style="margin-top:12px; align-self:flex-start;"
              :disabled="!csvTableName.trim() || csvImporting"
              @click="directImportCsv"
            >
              <span v-if="csvImporting" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              {{ csvImporting ? `Importing… ${csvImportProgress.toLocaleString()} rows` : 'Import' }}
            </button>
          </div>
        </div>
      </template>

      <div v-else-if="!selectedTable" class="empty-state" style="height:100%;">
        <div class="empty-state-icon">▦</div>
        <div>Select a table to inspect</div>
      </div>

      <template v-else>
        <div class="toolbar">
          <span style="font-weight:600; font-size:15px;">{{ selectedTable.name }}</span>
          <span v-if="selectedRowCount !== null" class="badge badge-gray" style="margin-left: 4px;">{{ selectedRowCount.toLocaleString() }} rows</span>
          <span v-else-if="rowCountLoading" class="badge badge-gray" style="margin-left: 4px;">counting…</span>
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

        <div v-if="indexActionError" style="font-size:12px; color:var(--danger); padding:6px 14px; display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--surface-alt, rgba(220,53,69,0.08));">
          <span>{{ indexActionError }}</span>
          <button class="btn btn-ghost btn-sm" style="flex-shrink:0;" @click="indexActionError = ''">✕</button>
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
            :totalRowCount="previewTotal"
            :onPageChange="previewTotal > EXPLORER_PAGE_SIZE ? navigatePreviewPage : undefined"
            :externalOffset="previewOffset"
            :pageSize="EXPLORER_PAGE_SIZE"
            :onSortChange="previewTotal > EXPLORER_PAGE_SIZE ? handlePreviewSortChange : undefined"
            :externalSortCriteria="previewTotal > EXPLORER_PAGE_SIZE ? previewSort : undefined"
            :onExportCsv="exportTableCsv"
            exportCsvLabel="Export the full table as CSV"
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

    <!-- Vacuum confirmation modal -->
    <div v-if="vacuumConfirm" class="vacuum-overlay" @click.self="vacuumConfirm = null">
      <div class="vacuum-modal">
        <div class="vacuum-modal-title">Vacuum database?</div>
        <div class="vacuum-modal-body">
          <template v-if="vacuumConfirm.wastedBytes >= 1024 * 1024">
            <p>
              <strong>{{ formatMb(vacuumConfirm.wastedBytes) }} MB</strong> of freed pages
              (<strong>{{ Math.round(vacuumConfirm.wastedPct) }}%</strong> of the file) can be
              reclaimed by compacting the database.
            </p>
            <p style="margin-top:8px; color:var(--text-muted); font-size:12px;">
              The database will be temporarily locked while the vacuum runs.
            </p>
          </template>
          <template v-else>
            <p>No significant wasted space found
              ({{ formatMb(vacuumConfirm.wastedBytes) }} MB,
              {{ Math.round(vacuumConfirm.wastedPct) }}%).
            </p>
            <p style="margin-top:8px; color:var(--text-muted); font-size:12px;">
              You can still vacuum to defragment pages, but no space will be returned to the OS.
            </p>
          </template>
        </div>
        <div class="vacuum-modal-actions">
          <button class="btn btn-secondary" @click="vacuumConfirm = null">Cancel</button>
          <button class="btn btn-primary" @click="confirmVacuum">Vacuum</button>
        </div>
      </div>
    </div>

    <!-- CSV large-file warning modal -->
    <div v-if="csvLargeFileWarning" class="vacuum-overlay" @click.self="csvLargeFileWarning = false">
      <div class="vacuum-modal">
        <div class="vacuum-modal-title">File too large for preview</div>
        <div class="vacuum-modal-body">
          <p>This file exceeds the 200 MB limit for preview mode. Loading it would require several gigabytes of memory.</p>
          <p style="margin-top:8px;">Enable <strong>Direct load (no preview)</strong> to import large files efficiently, without loading the entire file into memory.</p>
        </div>
        <div class="vacuum-modal-actions">
          <button class="btn btn-secondary" @click="csvLargeFileWarning = false">Dismiss</button>
          <button class="btn btn-primary" @click="csvLargeFileWarning = false; csvDirectLoad = true">Switch to Direct load</button>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="empty-state" style="height:100%;">
    <div class="empty-state-icon">🗄</div>
    <div>Open a SQLite database first</div>
    <router-link to="/connections" class="btn btn-primary btn-sm">Go to Connections</router-link>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onDeactivated, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useConnectionStore } from '../stores/connection'
import { useQueryStore } from '../stores/query'
import DataGrid from '../components/DataGrid.vue'
import type { TableInfo, CsvPreview, SortCriterion } from '../../../shared/types'

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
const csvImportProgress = ref(0)
const csvError = ref('')
const csvSuccess = ref('')
const csvCancelled = ref('')
const csvPasteRef = ref<HTMLTextAreaElement | null>(null)
const csvPasteFormat = ref<'csv' | 'excel'>('csv')

const csvDirectLoad = ref(false)
type CsvDirectFile = { filePath: string; fileName: string }
const csvDirectFile = ref<CsvDirectFile | null>(null)
const csvLargeFileWarning = ref(false)

watch(csvDirectLoad, () => {
  csvPreview.value = null
  csvDirectFile.value = null
  csvError.value = ''
  csvSuccess.value = ''
})

// ── Vacuum ─────────────────────────────────────────────────────────────────────
type VacuumConfirmState = { wastedBytes: number; wastedPct: number } | null

const vacuumChecking = ref(false)
const vacuuming = ref(false)
const vacuumError = ref('')
const vacuumSuccess = ref('')
const vacuumConfirm = ref<VacuumConfirmState>(null)

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

async function vacuumDb(): Promise<void> {
  vacuumError.value = ''
  vacuumSuccess.value = ''
  vacuumChecking.value = true
  try {
    const info = await window.api.getDatabaseWasteInfo()
    vacuumConfirm.value = { wastedBytes: info.wastedBytes, wastedPct: info.wastedPct }
  } catch (err) {
    vacuumError.value = err instanceof Error ? err.message : String(err)
  } finally {
    vacuumChecking.value = false
  }
}

async function confirmVacuum(): Promise<void> {
  vacuumConfirm.value = null
  vacuuming.value = true
  vacuumError.value = ''
  vacuumSuccess.value = ''
  try {
    await window.api.vacuumDatabase()
    vacuumSuccess.value = 'Vacuum complete.'
    setTimeout(() => { vacuumSuccess.value = '' }, 5000)
  } catch (err) {
    vacuumError.value = err instanceof Error ? err.message : String(err)
  } finally {
    vacuuming.value = false
  }
}

// When the format toggle changes while paste data is loaded, re-parse headers and
// preview rows so the DataGrid column names and the import column names stay in sync.
watch(csvPasteFormat, (fmt) => {
  if (csvPreview.value?.source !== 'paste' || !csvPreview.value.rawText) return
  const sep = fmt === 'excel' ? '\t' : ','
  const parsed = parseCsvPreview(csvPreview.value.rawText, sep)
  if (!parsed) return
  csvPreview.value = { ...csvPreview.value, headers: parsed.headers, rows: parsed.rows, totalLines: parsed.totalLines }
})

async function pickCsvFile(): Promise<void> {
  if (csvDirectLoad.value) {
    const filePath = await window.api.csvPickDirect()
    if (filePath) {
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath
      csvDirectFile.value = { filePath, fileName }
      csvTableName.value = fileName.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').toLowerCase()
      csvError.value = ''
      csvSuccess.value = ''
    }
    return
  }
  const preview = await window.api.csvPickAndPreview()
  if (preview?.tooLarge) { csvLargeFileWarning.value = true; return }
  if (preview) loadCsvPreview(preview, 'file')
}

async function onCsvDrop(e: DragEvent): Promise<void> {
  csvDragOver.value = false
  const file = e.dataTransfer?.files[0]
  if (!file) return
  const filePath = (file as File & { path?: string }).path
  if (!filePath) return
  if (csvDirectLoad.value) {
    csvDirectFile.value = { filePath, fileName: file.name }
    csvTableName.value = file.name.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').toLowerCase()
    csvError.value = ''
    csvSuccess.value = ''
    return
  }
  if (file.size > 200 * 1024 * 1024) {
    csvLargeFileWarning.value = true
    return
  }
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
  const sep = csvPasteFormat.value === 'excel' ? '\t' : ','
  const parsed = parseCsvPreview(text, sep)
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
    const sep = csvPasteFormat.value === 'excel' ? '\t' : ','
    const parsed = parseCsvAll(csvPreview.value.rawText, sep)
    return parsed ? parsed.rows : csvPreview.value.rows
  }
  return csvPreview.value.rows
})

/** Minimal RFC-4180/TSV parser for client-side preview. separator is ',' for CSV, '\t' for Excel/TSV. */
function makeRowParser(sep: string): (line: string) => string[] {
  return function parseRow(line: string): string[] {
    const result: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (ch === sep && !inQ) {
        result.push(cur); cur = ''
      } else {
        cur += ch
      }
    }
    result.push(cur)
    return result
  }
}

function parseCsvPreview(text: string, sep = ','): { headers: string[]; rows: string[][]; totalLines: number } | null {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length === 0) return null
  const parseRow = makeRowParser(sep)
  const headers = parseRow(lines[0])
  const rows = lines.slice(1, 6).map(parseRow)
  return { headers, rows, totalLines: lines.length - 1 }
}

/** Same parser but returns ALL data rows (used for DataGrid display of pasted CSV/TSV). */
function parseCsvAll(text: string, sep = ','): { headers: string[]; rows: string[][] } | null {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length === 0) return null
  const parseRow = makeRowParser(sep)
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
      const sep = csvPasteFormat.value === 'excel' ? '\t' : ','
      count = await window.api.csvImportText(csvPreview.value.rawText, tableName, ifExists, sep)
    } else {
      count = await window.api.csvImport(csvPreview.value.filePath, tableName, ifExists)
    }
    csvSuccess.value = `Imported ${count.toLocaleString()} rows into "${tableName}"`
    rowCountCache.delete(tableName)
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

function cancelOrResetDirectImport(): void {
  if (csvImporting.value) {
    window.api.cancelCsvDirectImport()
    return
  }
  csvDirectFile.value = null
  csvError.value = ''
  csvSuccess.value = ''
  csvCancelled.value = ''
}

async function directImportCsv(): Promise<void> {
  if (!csvDirectFile.value || !csvTableName.value.trim()) return
  csvError.value = ''
  csvSuccess.value = ''
  csvCancelled.value = ''
  csvImporting.value = true
  csvImportProgress.value = 0
  const offProgress = window.api.onCsvDirectImportProgress((n) => {
    csvImportProgress.value = n
  })
  const tableName = csvTableName.value.trim()
  try {
    const ifExists = csvReplace.value ? 'replace' as const : 'append' as const
    const count = await window.api.csvDirectImport(csvDirectFile.value.filePath, tableName, ifExists)
    csvSuccess.value = `Imported ${count.toLocaleString()} rows into "${tableName}"`
    rowCountCache.delete(tableName)
    await conn.refreshDbInfo()
    await nextTick()
    csvDirectFile.value = null
    csvTableName.value = ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'Import aborted') {
      const committed = (err as { rowsCommitted?: number }).rowsCommitted ?? csvImportProgress.value
      csvCancelled.value = `Import cancelled — ${committed.toLocaleString()} rows were committed before stopping.`
      rowCountCache.delete(tableName)
      await conn.refreshDbInfo()
    } else {
      csvError.value = msg
    }
  } finally {
    offProgress()
    csvImportProgress.value = 0
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

// ── On-demand row count ────────────────────────────────────────────────────────
// Fetched only when a table is selected in this view; cached to avoid re-running
// COUNT(*) on subsequent visits to the same table within one Explorer session.
const rowCountCache = new Map<string, number>()
const selectedRowCount = ref<number | null>(null)
const rowCountLoading = ref(false)

async function fetchRowCount(tableName: string): Promise<void> {
  if (rowCountCache.has(tableName)) {
    selectedRowCount.value = rowCountCache.get(tableName)!
    return
  }
  rowCountLoading.value = true
  try {
    const count = await window.api.getTableRowCount(tableName)
    rowCountCache.set(tableName, count)
    if (selectedTableName.value === tableName) {
      selectedRowCount.value = count
    }
  } finally {
    rowCountLoading.value = false
  }
}

onDeactivated(() => {
  rowCountCache.clear()
  selectedRowCount.value = null
})

// Clear stale preview when the selected table changes.
watch(selectedTable, () => {
  previewRows.value = []
  previewCols.value = []
  previewTotal.value = 0
  previewOffset.value = 0
  previewSql.value = ''
  previewSort.value = []
  indexActionError.value = ''
})

const EXPLORER_PAGE_SIZE = 10000

const activeTab = ref<'columns' | 'indexes' | 'preview'>('columns')
const previewCols = ref<string[]>([])
const previewRows = ref<unknown[][]>([])
const previewTotal = ref(0)
const previewOffset = ref(0)
const previewSql = ref('')
const previewSort = ref<SortCriterion[]>([])
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

onMounted(() => {
  document.addEventListener('click', () => { ctxMenu.value = null })

  // When a job completes, the SQLite database may have changed (extract jobs write
  // new rows). Clear the row count cache and re-fetch for the currently selected table.
  const offJobComplete = window.api.onJobComplete(() => {
    rowCountCache.clear()
    if (selectedTableName.value && selectedTable.value?.type === 'table') {
      void fetchRowCount(selectedTableName.value)
    }
  })
  onUnmounted(() => offJobComplete())
})

function selectTable(t: TableInfo): void {
  selectedTableName.value = t.name
  selectedRowCount.value = rowCountCache.get(t.name) ?? null
  activeTab.value = 'columns'
  if (t.type === 'table') {
    void fetchRowCount(t.name)
  }
}

async function loadPreview(): Promise<void> {
  if (!selectedTable.value) return
  previewLoading.value = true
  previewSort.value = []
  previewOffset.value = 0
  previewSql.value = `SELECT * FROM ${escapePreviewId(selectedTable.value.name)}`
  try {
    const result = await window.api.queryInit(previewSql.value, EXPLORER_PAGE_SIZE)
    previewCols.value = result.columns
    previewRows.value = result.rows
    previewTotal.value = result.totalCount
  } finally {
    previewLoading.value = false
  }
}

function escapePreviewId(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

async function navigatePreviewPage(newOffset: number): Promise<void> {
  if (!previewSql.value) return
  const orderBy = previewSortToOrderBy()
  const { rows } = await window.api.queryPage(previewSql.value, newOffset, EXPLORER_PAGE_SIZE, orderBy)
  previewRows.value = rows
  previewOffset.value = newOffset
}

async function handlePreviewSortChange(criteria: SortCriterion[]): Promise<void> {
  previewSort.value = criteria
  if (!previewSql.value) return
  const orderBy = criteria.map((c) => ({ column: previewCols.value[c.colIdx], dir: c.dir }))
  const { rows } = await window.api.queryPage(previewSql.value, 0, EXPLORER_PAGE_SIZE, orderBy.length ? orderBy : undefined)
  previewRows.value = rows
  previewOffset.value = 0
}

function previewSortToOrderBy(): { column: string; dir: 'asc' | 'desc' }[] | undefined {
  if (!previewSort.value.length) return undefined
  return previewSort.value.map((c) => ({ column: previewCols.value[c.colIdx], dir: c.dir }))
}

const exportingCsv = ref(false)

async function exportTableCsv(): Promise<void> {
  if (!selectedTable.value) return
  exportingCsv.value = true
  try {
    await window.api.exportQueryCsv(`SELECT * FROM ${escapePreviewId(selectedTable.value.name)}`)
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
  rowCountCache.delete(oldName)
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
const indexActionError = ref('')

async function dropIndex(indexName: string): Promise<void> {
  if (!confirm(`Delete index "${indexName}"?`)) return
  droppingIndex.value = indexName
  indexActionError.value = ''
  try {
    await window.api.dropIndex(indexName)
    await conn.refreshDbInfo()
  } catch (err) {
    indexActionError.value = err instanceof Error ? err.message : String(err)
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
  indexActionError.value = ''
  try {
    await window.api.createColumnIndex(selectedTable.value.name, colName)
    await conn.refreshDbInfo()
  } catch (err) {
    indexActionError.value = err instanceof Error ? err.message : String(err)
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
.left-top { flex-shrink: 1; flex-grow: 0; min-height: 80px; overflow: hidden; display: flex; flex-direction: column; }
.left-top-header { flex-shrink: 0; }
.left-top-scroll { flex: 1; overflow-y: auto; }
.left-h-divider { height: 5px; flex-shrink: 0; cursor: row-resize; position: relative; z-index: 1; background: transparent; border-top: 1px solid var(--border); }
.left-h-divider::after { content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); height: 3px; width: 36px; border-radius: 99px; background: var(--border); transition: background 0.15s, width 0.15s; }
.left-h-divider:hover::after, .left-h-divider:active::after { background: var(--primary); width: 48px; }
.left-bottom { flex: 1 0 100px; overflow-y: auto; border-top: none; display: flex; flex-direction: column; }

/* Left panel CSV drop zone */
.csv-drop-zone { margin: 8px 8px 4px; border: 2px dashed var(--border); border-radius: var(--radius-sm); padding: 12px 8px; display: flex; flex-direction: column; align-items: center; gap: 5px; cursor: pointer; font-size: 12px; color: var(--text-muted); transition: border-color 0.15s, background 0.15s; text-align: center; }
.csv-drop-zone:hover, .csv-drop-zone-over { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 5%, transparent); color: var(--primary); }
.csv-drop-zone-active { border-color: var(--primary); border-style: solid; background: color-mix(in srgb, var(--primary) 8%, transparent); color: var(--primary); }
.csv-drop-zone-filename { font-weight: 600; font-size: 11px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.csv-format-toggle { display: flex; margin: 0 8px 4px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.csv-fmt-btn { flex: 1; padding: 3px 0; font-size: 11px; border: none; background: transparent; color: var(--text-muted); cursor: pointer; transition: background 0.12s, color 0.12s; }
.csv-fmt-btn:hover { background: var(--bg-hover, rgba(0,0,0,0.05)); color: var(--text); }
.csv-fmt-btn.active { background: var(--primary); color: #fff; font-weight: 600; }

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
.csv-cancelled { font-size: 12px; color: var(--text-muted); font-weight: 500; }
.csv-success { font-size: 12px; color: #166534; font-weight: 500; }
.csv-preview-notice { font-size: 12px; color: var(--text-muted); background: var(--bg-subtle, #f5f5f5); padding: 4px 12px; border-top: 1px solid var(--border); flex: 0 0 auto; }
.tree-item { display: flex; align-items: center; gap: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.tree-item:hover { background: var(--surface2); }
.tree-item.selected { background: #eff6ff; font-weight: 600; }
.tree-icon { font-size: 13px; }
.tree-name { flex: 1; }
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
.vacuum-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.vacuum-modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 22px 24px;
  max-width: 380px;
  width: calc(100% - 48px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
.vacuum-modal-title { font-weight: 600; font-size: 14px; margin-bottom: 10px; }
.vacuum-modal-body { font-size: 13px; line-height: 1.55; }
.vacuum-modal-actions { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
</style>
