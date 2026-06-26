<template>
  <div class="datagrid-wrap" tabindex="0" @keydown="onKeydown">
    <div v-if="error" class="alert alert-error" style="margin: 12px;">{{ error }}</div>
    <div v-else-if="!columns.length" class="empty-state">
      <div class="empty-state-icon">📊</div>
      <div>No results</div>
    </div>
    <template v-else>
      <div class="datagrid-table-wrap" ref="tableWrap">
        <table class="data-table datagrid-table" :class="{ 'datagrid-table-fixed': tableFixed }">
          <colgroup>
            <col v-if="showRowNumbers" style="width:40px;min-width:40px;">
            <col
              v-for="col in displayCols"
              :key="col.origIdx"
              :style="colWidths[col.origIdx] ? { width: colWidths[col.origIdx] + 'px' } : {}"
            >
          </colgroup>
          <thead>
            <tr>
              <th v-if="showRowNumbers" class="rn-col rn-th">
                <span>#</span>
              </th>
              <th
                v-for="col in displayCols"
                :key="col.origIdx"
                :data-orig-idx="col.origIdx"
                :class="['dg-th', { 'frozen-th': col.frozen, 'last-frozen-th': col.frozen && col.displayIdx === frozenCount - 1 }]"
                :style="colHeaderStyle(col)"
                @click="onHeaderClick(col.origIdx, $event)"
              >
                <span class="dg-th-inner">
                  <span class="sort-indicator" v-if="sortRankOf(col.origIdx) >= 0">
                    {{ sortCriteria[sortRankOf(col.origIdx)].dir === 'asc' ? '↑' : '↓' }}
                    <sup v-if="sortCriteria.length > 1" class="sort-rank">{{ sortRankOf(col.origIdx) + 1 }}</sup>
                  </span>
                  <span class="col-name">{{ columns[col.origIdx] }}</span>
                  <button
                    class="pin-btn"
                    :class="{ 'pin-active': col.frozen }"
                    :title="col.frozen ? 'Unfreeze column' : 'Freeze column'"
                    @click.stop="toggleFreeze(col)"
                  >⊢</button>
                </span>
                <div class="col-resize-handle" @mousedown.stop.prevent="startResize($event, col.origIdx)" @click.stop @dblclick.stop.prevent="autoFitColumn(col.origIdx)"></div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, vi) in visibleRows"
              :key="vi"
              :data-row-idx="vi + scrollOffset"
              :class="trClass(vi)"
              @mousedown="onRowMousedown(vi, $event)"
            >
              <td v-if="showRowNumbers" class="rn-col rn-td">{{ vi + scrollOffset + 1 }}</td>
              <td
                v-for="col in displayCols"
                :key="col.origIdx"
                :class="['dg-td', {
                  'frozen-td': col.frozen,
                  'last-frozen-td': col.frozen && col.displayIdx === frozenCount - 1,
                  'cell-focused': isCellFocused(vi, col.origIdx)
                }]"
                :style="col.frozen ? frozenTdStyle(col) : undefined"
                :contenteditable="editable ? 'true' : undefined"
                @mousedown="onCellMousedown(vi, col.origIdx, $event)"
                @blur="editable ? onCellEdit(vi + scrollOffset, col.origIdx, ($event.target as HTMLElement).innerText) : undefined"
              >{{ formatCell(row[col.origIdx]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="datagrid-footer">
        <span v-if="selectedRows.size > 0" class="footer-sel">{{ selectedRows.size }} selected &middot;&nbsp;</span>
        <span>{{ rows.length }} row{{ rows.length !== 1 ? 's' : '' }}</span>
        <span v-if="durationMs !== undefined" style="margin-left: 8px; color: var(--text-muted)">{{ durationMs }}ms</span>
        <button
          v-if="onExportCsv"
          class="btn btn-ghost btn-sm copy-csv-btn"
          :disabled="exportingCsv"
          @click="onExportCsv"
        >
          <span v-if="exportingCsv" class="spinner" style="width:10px;height:10px;border-width:1.5px;margin-right:4px;"></span>
          {{ exportCsvLabel ?? 'Export CSV' }}
        </button>
        <button
          class="btn btn-ghost btn-sm copy-csv-btn"
          :class="{ 'copy-csv-copied': copyAllFeedback }"
          :disabled="copyAllInProgress"
          :title="`Copy all ${(totalRowCount ?? rows.length).toLocaleString()} row${(totalRowCount ?? rows.length) !== 1 ? 's' : ''} as CSV to clipboard`"
          @click="copyAllAsCsv"
        >
          <span v-if="copyAllFeedback">✓ Copied!</span>
          <span v-else-if="copyAllInProgress">
            <span class="spinner" style="width:10px;height:10px;border-width:1.5px;margin-right:4px;"></span>Copying…
          </span>
          <span v-else>Copy {{ (totalRowCount ?? rows.length).toLocaleString() }} row{{ (totalRowCount ?? rows.length) !== 1 ? 's' : '' }}</span>
        </button>
        <div v-if="rows.length > PAGE" style="margin-left: auto; display:flex; gap:6px; align-items:center;">
          <button class="btn btn-ghost btn-sm" :disabled="scrollOffset === 0" @click="scrollOffset = Math.max(0, scrollOffset - PAGE)">‹ Prev</button>
          <span style="font-size:12px;">{{ scrollOffset + 1 }}–{{ Math.min(scrollOffset + PAGE, rows.length) }}</span>
          <button class="btn btn-ghost btn-sm" :disabled="scrollOffset + PAGE >= rows.length" @click="scrollOffset = Math.min(rows.length - PAGE, scrollOffset + PAGE)">Next ›</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'

const props = defineProps<{
  columns: string[]
  rows: unknown[][]
  error?: string
  durationMs?: number
  editable?: boolean
  showRowNumbers?: boolean
  pageSize?: number
  rowClass?: (idx: number) => string
  onExportCsv?: () => void | Promise<void>
  exportingCsv?: boolean
  exportCsvLabel?: string
  onCopyAllRows?: () => Promise<void>
  totalRowCount?: number
}>()

const emit = defineEmits<{ cellEdit: [row: number, col: number, value: string] }>()

// ── All refs declared first to avoid temporal dead zone in immediate watchers ──
const colOrder = ref<number[]>([])
const frozenCount = ref(0)
const colWidths = ref<number[]>([])
const tableFixed = ref(false)   // switches to fixed layout after first width snapshot

interface SortCriterion { colIdx: number; dir: 'asc' | 'desc' }
const sortCriteria = ref<SortCriterion[]>([])
const scrollOffset = ref(0)
const selectedRows = ref<Set<number>>(new Set())
interface FocusedCell { rowIdx: number; origIdx: number }
const focusedCell = ref<FocusedCell | null>(null)
const tableWrap = ref<HTMLElement | null>(null)
let lastClickedRow: number | null = null

interface DisplayCol {
  origIdx: number
  frozen: boolean
  displayIdx: number
}

// ── Column ordering & freezing ─────────────────────────────────────────────────
watch(
  () => props.columns,
  async (cols) => {
    colOrder.value = cols.map((_, i) => i)
    frozenCount.value = 0
    colWidths.value = []          // clear so <col> has no explicit widths
    tableFixed.value = false      // use auto layout for first render
    sortCriteria.value = []
    selectedRows.value = new Set()
    focusedCell.value = null
    scrollOffset.value = 0
    lastClickedRow = null
    // Let the browser auto-size columns by content, then snapshot those
    // natural widths and switch to fixed layout so resize can grow AND shrink.
    await nextTick()
    snapshotColWidths()
  },
  { immediate: true }
)

function snapshotColWidths(): void {
  if (!tableWrap.value) return
  const ths = tableWrap.value.querySelectorAll<HTMLElement>('thead th.dg-th')
  const widths: number[] = new Array(props.columns.length).fill(0)
  ths.forEach((th) => {
    const idx = Number(th.dataset.origIdx)
    if (!isNaN(idx)) widths[idx] = th.offsetWidth
  })
  colWidths.value = widths
  // Now that widths are locked, switch to fixed layout so drag can shrink too
  tableFixed.value = true
}

watch(
  () => props.rows,
  () => {
    scrollOffset.value = 0
    selectedRows.value = new Set()
    focusedCell.value = null
    lastClickedRow = null
  }
)

const displayCols = computed<DisplayCol[]>(() =>
  colOrder.value.map((origIdx, di) => ({
    origIdx,
    frozen: di < frozenCount.value,
    displayIdx: di
  }))
)

// ── Sorting ────────────────────────────────────────────────────────────────────

function sortRankOf(origIdx: number): number {
  return sortCriteria.value.findIndex((c) => c.colIdx === origIdx)
}

const sortedRowIndices = computed<number[]>(() => {
  const indices = props.rows.map((_, i) => i)
  if (sortCriteria.value.length === 0) return indices
  return [...indices].sort((a, b) => {
    for (const { colIdx, dir } of sortCriteria.value) {
      const va = props.rows[a][colIdx]
      const vb = props.rows[b][colIdx]
      if (va === null || va === undefined) { if (vb !== null && vb !== undefined) return 1; continue }
      if (vb === null || vb === undefined) return -1
      const na = Number(va), nb = Number(vb)
      const cmp = (!isNaN(na) && !isNaN(nb)) ? na - nb : String(va).localeCompare(String(vb))
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
    }
    return 0
  })
})

const sortedRows = computed(() => sortedRowIndices.value.map((i) => props.rows[i]))

function onHeaderClick(origIdx: number, e: MouseEvent): void {
  const rank = sortRankOf(origIdx)
  if (e.shiftKey) {
    // Add as additional sort criterion, or toggle its direction if already present
    if (rank >= 0) {
      const updated = sortCriteria.value.map((c, i) =>
        i === rank ? { ...c, dir: c.dir === 'asc' ? 'desc' as const : 'asc' as const } : c
      )
      sortCriteria.value = updated
    } else {
      sortCriteria.value = [...sortCriteria.value, { colIdx: origIdx, dir: 'asc' }]
    }
  } else {
    // Primary click: replace all criteria with just this column
    if (rank >= 0 && sortCriteria.value.length === 1) {
      // Toggle direction if it's already the sole sort column
      sortCriteria.value = [{ colIdx: origIdx, dir: sortCriteria.value[0].dir === 'asc' ? 'desc' : 'asc' }]
    } else {
      sortCriteria.value = [{ colIdx: origIdx, dir: 'asc' }]
    }
  }
  scrollOffset.value = 0
  selectedRows.value = new Set()
  lastClickedRow = null
}

// ── Pagination ─────────────────────────────────────────────────────────────────
const PAGE = computed(() => props.pageSize ?? 200)
const visibleRows = computed(() =>
  sortedRows.value.slice(scrollOffset.value, scrollOffset.value + PAGE.value)
)

// ── Cell text selection ────────────────────────────────────────────────────────
function isCellFocused(vi: number, origIdx: number): boolean {
  return (
    focusedCell.value !== null &&
    focusedCell.value.rowIdx === vi + scrollOffset.value &&
    focusedCell.value.origIdx === origIdx
  )
}

function selectCellText(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function onCellMousedown(vi: number, colOrigIdx: number, e: MouseEvent): void {
  if (props.editable) return  // leave editable cells alone
  const rowIdx = vi + scrollOffset.value

  if (!selectedRows.value.has(rowIdx)) {
    // Row not yet selected — clear cell focus and let row selection proceed
    focusedCell.value = null
    window.getSelection()?.removeAllRanges()
    return
  }

  // Row is already selected.

  // If this exact cell is already focused, let the browser handle it
  // normally (cursor placement, character-by-character drag-select).
  // Only stopPropagation to keep row selection from interfering.
  if (focusedCell.value?.rowIdx === rowIdx && focusedCell.value?.origIdx === colOrigIdx) {
    e.stopPropagation()
    return
  }

  const sameRowFocus = focusedCell.value === null || focusedCell.value.rowIdx === rowIdx
  if (sameRowFocus) {
    // No cell focused yet, or focused cell is in this same row
    // → enter cell-text-selection mode for the clicked cell
    e.stopPropagation()
    e.preventDefault()
    focusedCell.value = { rowIdx, origIdx: colOrigIdx }
    selectCellText(e.currentTarget as HTMLElement)
  } else {
    // A cell in a DIFFERENT row is focused
    // → clear cell focus and fall through to normal row selection (onRowMousedown)
    // Shift is also handled naturally by onRowMousedown
    focusedCell.value = null
    window.getSelection()?.removeAllRanges()
  }
}

// ── Row selection ──────────────────────────────────────────────────────────────
function onRowMousedown(vi: number, e: MouseEvent): void {
  if (e.button !== 0) return
  const target = e.target as HTMLElement
  if (target.isContentEditable) return

  const rowIdx = vi + scrollOffset.value

  // Shift-click: extend range, no drag needed
  if (e.shiftKey && lastClickedRow !== null) {
    const from = Math.min(lastClickedRow, rowIdx)
    const to = Math.max(lastClickedRow, rowIdx)
    const next = new Set(selectedRows.value)
    for (let i = from; i <= to; i++) next.add(i)
    selectedRows.value = next
    e.preventDefault()
    return
  }

  // Normal mousedown: select anchor row and start drag
  focusedCell.value = null
  selectedRows.value = new Set([rowIdx])
  lastClickedRow = rowIdx
  // Prevent browser text-selection highlight while dragging
  e.preventDefault()
  // Keep keyboard focus on the grid so Ctrl+A / Escape still work
  const wrap = (e.currentTarget as HTMLElement).closest('.datagrid-wrap') as HTMLElement | null
  wrap?.focus()

  const onMousemove = (ev: MouseEvent): void => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY)
    const tr = el?.closest('tr[data-row-idx]') as HTMLElement | null
    if (!tr) return
    const hoverIdx = Number(tr.dataset.rowIdx)
    if (isNaN(hoverIdx)) return
    const from = Math.min(rowIdx, hoverIdx)
    const to = Math.max(rowIdx, hoverIdx)
    const next = new Set<number>()
    for (let i = from; i <= to; i++) next.add(i)
    selectedRows.value = next
  }

  const onMouseup = (): void => {
    document.removeEventListener('mousemove', onMousemove)
    document.removeEventListener('mouseup', onMouseup)
  }

  document.addEventListener('mousemove', onMousemove)
  document.addEventListener('mouseup', onMouseup)
}

function onKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    if (target.isContentEditable) return
    e.preventDefault()
    focusedCell.value = null
    selectedRows.value = new Set(sortedRows.value.map((_, i) => i))
    lastClickedRow = null
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
    if (target.isContentEditable) return
    if (focusedCell.value) return  // let browser copy the cell's selected text
    if (selectedRows.value.size === 0) return
    e.preventDefault()
    copySelectionAsCsv()
  } else if (e.key === 'Escape') {
    if (focusedCell.value) {
      // First Escape: leave cell-focus mode, keep row selected
      focusedCell.value = null
      window.getSelection()?.removeAllRanges()
    } else {
      selectedRows.value = new Set()
      lastClickedRow = null
    }
  }
}

function csvEscape(v: unknown): string {
  const s = formatCell(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function copySelectionAsCsv(): void {
  const cols = displayCols.value
  const header = cols.map((c) => csvEscape(props.columns[c.origIdx])).join(',')
  const bodyLines = [...selectedRows.value]
    .sort((a, b) => a - b)
    .map((rowIdx) => {
      const row = sortedRows.value[rowIdx]
      return cols.map((c) => csvEscape(row?.[c.origIdx])).join(',')
    })
  const csv = [header, ...bodyLines].join('\n')
  navigator.clipboard.writeText(csv).catch(() => {/* ignore */})
}

const copyAllFeedback = ref(false)
const copyAllInProgress = ref(false)
let copyAllFeedbackTimer: ReturnType<typeof setTimeout> | null = null

async function copyAllAsCsv(): Promise<void> {
  if (copyAllInProgress.value) return
  copyAllInProgress.value = true
  try {
    if (props.onCopyAllRows) {
      await props.onCopyAllRows()
    } else {
      const cols = displayCols.value
      const header = cols.map((c) => csvEscape(props.columns[c.origIdx])).join(',')
      const bodyLines = sortedRows.value.map((row) =>
        cols.map((c) => csvEscape(row?.[c.origIdx])).join(',')
      )
      await navigator.clipboard.writeText([header, ...bodyLines].join('\n'))
    }
    copyAllFeedback.value = true
    if (copyAllFeedbackTimer !== null) {
      clearTimeout(copyAllFeedbackTimer)
    }
    copyAllFeedbackTimer = setTimeout(() => {
      copyAllFeedback.value = false
      copyAllFeedbackTimer = null
    }, 1500)
  } catch {
    // ignore clipboard errors
  } finally {
    copyAllInProgress.value = false
  }
}

// ── Row class helper ───────────────────────────────────────────────────────────
function trClass(vi: number): Record<string, boolean> {
  const rowIdx = vi + scrollOffset.value
  const origIdx = sortedRowIndices.value[rowIdx] ?? rowIdx
  const extra = props.rowClass?.(origIdx) ?? ''
  return {
    'selected-row': selectedRows.value.has(rowIdx),
    [extra]: !!extra
  }
}

// ── Column freezing ────────────────────────────────────────────────────────────
function toggleFreeze(col: DisplayCol): void {
  const order = [...colOrder.value]
  const di = col.displayIdx
  if (col.frozen) {
    order.splice(di, 1)
    frozenCount.value--
    order.splice(frozenCount.value, 0, col.origIdx)
  } else {
    order.splice(di, 1)
    order.splice(frozenCount.value, 0, col.origIdx)
    frozenCount.value++
  }
  colOrder.value = order
}

// ── Frozen column sticky positioning ─────────────────────────────────────────
const RN_WIDTH = 40

const frozenLeftOffsets = computed<number[]>(() => {
  const offsets: number[] = []
  let left = props.showRowNumbers ? RN_WIDTH : 0
  for (let di = 0; di < frozenCount.value; di++) {
    offsets.push(left)
    left += colWidths.value[colOrder.value[di]] ?? 120
  }
  return offsets
})

function colHeaderStyle(col: DisplayCol): Record<string, string> {
  if (!col.frozen) return {}
  return {
    position: 'sticky',
    top: '0',
    left: (frozenLeftOffsets.value[col.displayIdx] ?? 0) + 'px',
    zIndex: '4',  /* above regular sticky headers (z-index: 2) and frozen body cells (z-index: 1) */
    background: 'var(--surface2)'
  }
}

function frozenTdStyle(col: DisplayCol): Record<string, string> {
  return {
    position: 'sticky',
    left: (frozenLeftOffsets.value[col.displayIdx] ?? 0) + 'px',
    zIndex: '1',
    background: 'var(--surface)'
  }
}

// ── Column resize ──────────────────────────────────────────────────────────────
function startResize(e: MouseEvent, origIdx: number): void {
  // Always read the actual rendered width so drag delta starts from reality
  const th = tableWrap.value?.querySelector<HTMLElement>(`thead th[data-orig-idx="${origIdx}"]`)
  const startW = th ? th.offsetWidth : (colWidths.value[origIdx] ?? 120)
  colWidths.value[origIdx] = startW
  const startX = e.clientX

  // Inject a temporary <style> with !important so no child element can override
  // the cursor or trigger text-selection highlights during the drag.
  const dragStyle = document.createElement('style')
  dragStyle.textContent = '*, *::before, *::after { cursor: col-resize !important; user-select: none !important; }'
  document.head.appendChild(dragStyle)

  const onMove = (ev: MouseEvent): void => {
    colWidths.value[origIdx] = Math.max(40, startW + ev.clientX - startX)
  }
  const onUp = (): void => {
    document.head.removeChild(dragStyle)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ── Auto-fit column on double-click ───────────────────────────────────────────
let _measureCtx: CanvasRenderingContext2D | null = null

function measureText(text: string, font: string): number {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')!
  _measureCtx.font = font
  return Math.ceil(_measureCtx.measureText(text).width)
}

function autoFitColumn(origIdx: number): void {
  if (!tableWrap.value) return

  // Read fonts from rendered elements (fall back to sensible defaults)
  const anyTd = tableWrap.value.querySelector<HTMLElement>('tbody td.dg-td')
  const cellFont = anyTd ? getComputedStyle(anyTd).font : '13px system-ui, sans-serif'

  // Header needs extra room for sort arrow + pin button + resize handle
  const HEADER_EXTRA = 52
  const CELL_PADDING = 10  // 5px left + 5px right from .dg-td

  let maxW = measureText(props.columns[origIdx], cellFont) + HEADER_EXTRA

  // Measure every data row (canvas measureText is ~5M calls/s, so even 50k rows is fast)
  for (const row of props.rows) {
    const w = measureText(formatCell(row[origIdx]), cellFont) + CELL_PADDING
    if (w > maxW) maxW = w
  }

  // Cap at 2/3 of the visible table wrapper width
  const cap = Math.floor(tableWrap.value.clientWidth * (2 / 3))
  colWidths.value[origIdx] = Math.max(40, Math.min(maxW, cap))
}

// ── Formatting ─────────────────────────────────────────────────────────────────
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

function onCellEdit(row: number, col: number, value: string): void {
  emit('cellEdit', row, col, value)
}
</script>

<style scoped>
.datagrid-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--surface);
  outline: none;
}

.datagrid-table-wrap {
  flex: 1;
  overflow: auto;
}

.datagrid-table {
  table-layout: auto;
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

.datagrid-table-fixed {
  table-layout: fixed;
  width: max-content; /* expand beyond container when columns are wider than viewport */
  min-width: 100%;
}

/* clip cell content so fixed columns don't blow out their widths */
.dg-td {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 0; /* required for text-overflow to work in fixed-layout tables */
  border-right: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
}

.dg-th {
  border-right: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
}

/* cell in text-selection mode */
.dg-td.cell-focused {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
  white-space: normal;       /* allow text to wrap vertically */
  word-break: break-word;    /* break long words at column boundary */
  overflow-wrap: break-word;
  text-overflow: clip;       /* no ellipsis in focused mode */
  /* max-width: 0 and overflow: hidden are inherited from .dg-td —
     keeping max-width:0 is what makes table-layout:fixed honour the wrap point */
  user-select: text;
}

/* ── Header ── */
.dg-th {
  position: sticky;
  top: 0;
  z-index: 2;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  background: var(--surface2);
}

.dg-th:hover {
  background: color-mix(in srgb, var(--primary) 8%, var(--surface2));
}

.dg-th-inner {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 20px 0 8px; /* right padding for resize handle */
}

.sort-indicator {
  font-size: 11px;
  color: var(--primary);
  flex-shrink: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 1px;
}

.sort-rank {
  font-size: 8px;
  line-height: 1;
}

.col-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* pin button */
.pin-btn {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.1s, color 0.1s, background 0.1s;
  line-height: 1;
}

.dg-th:hover .pin-btn {
  opacity: 1;
}

.pin-btn:hover {
  background: color-mix(in srgb, var(--primary) 15%, transparent);
  color: var(--primary);
}

.pin-btn.pin-active {
  opacity: 1;
  color: var(--primary);
}

.pin-btn.pin-active:hover {
  color: var(--danger, #dc2626);
  background: color-mix(in srgb, var(--danger, #dc2626) 12%, transparent);
}

/* resize handle — 8px hit area fully inside the th, 1px visible line via ::after */
.col-resize-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 2;
}

.col-resize-handle::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 15%;
  bottom: 15%;
  width: 1px;
  transform: translateX(-50%);
  background: var(--border);
  transition: background 0.1s, width 0.1s;
}

.col-resize-handle:hover::after {
  background: var(--text-muted);
  width: 2px;
}

/* frozen column separator */
.last-frozen-th,
.last-frozen-td {
  border-right: 2px solid color-mix(in srgb, var(--primary) 40%, var(--border)) !important;
}

/* row number column */
.rn-col {
  width: 40px;
  min-width: 40px;
  text-align: right;
  padding-right: 8px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.rn-th,
.rn-td {
  position: sticky;
  left: 0;
  z-index: 3;
  background: var(--surface2);
}

.rn-th {
  top: 0;  /* stick to top as well as left */
}

.rn-td {
  z-index: 2;
  background: var(--surface);
}

/* ── Body rows ── */
tbody tr {
  cursor: pointer;
}

tbody tr:hover td {
  background: color-mix(in srgb, var(--primary) 5%, var(--surface));
}

tbody tr.selected-row td {
  background: color-mix(in srgb, var(--primary) 15%, var(--surface)) !important;
}

/* frozen body cells must match selected state */
tbody tr.selected-row .frozen-td {
  background: color-mix(in srgb, var(--primary) 15%, var(--surface)) !important;
}

tbody tr:hover .frozen-td {
  background: color-mix(in srgb, var(--primary) 5%, var(--surface)) !important;
}

/* frozen header styling */
.frozen-th {
  background: color-mix(in srgb, var(--primary) 6%, var(--surface2));
}

.frozen-th:hover {
  background: color-mix(in srgb, var(--primary) 12%, var(--surface2));
}

/* ── Footer ── */
.datagrid-footer {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
  background: var(--surface2);
  flex-shrink: 0;
}

.footer-sel {
  color: var(--primary);
  font-weight: 500;
}

.copy-csv-btn {
  margin-left: 10px;
  font-size: 12px;
  padding: 2px 8px;
  height: 22px;
  line-height: 1;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.copy-csv-btn:hover {
  color: var(--text);
  border-color: var(--text-muted);
}

.copy-csv-copied {
  color: var(--success, #16a34a) !important;
  border-color: var(--success, #16a34a) !important;
}
</style>
