<template>
  <div class="datagrid-wrap" tabindex="0" @keydown="onKeydown">
    <div v-if="error" class="alert alert-error" style="margin: 12px;">{{ error }}</div>
    <div v-else-if="!columns.length" class="empty-state">
      <div class="empty-state-icon">📊</div>
      <div>No results</div>
    </div>
    <template v-else>
      <div class="datagrid-table-wrap" ref="tableWrap" :style="frozenCssVars">
        <table class="data-table datagrid-table" :class="{ 'datagrid-table-fixed': tableFixed }" :style="tableFixed ? { width: tableExplicitWidth + 'px' } : {}">
          <colgroup>
            <col v-if="showRowNumbers" data-rn-col :style="{ width: rnWidth + 'px', minWidth: '30px' }">
            <col
              v-for="col in displayCols"
              :key="col.origIdx"
              :data-orig-idx="col.origIdx"
              :style="colWidths[col.origIdx] ? { width: colWidths[col.origIdx] + 'px' } : {}"
            >
          </colgroup>
          <thead>
            <tr>
              <th v-if="showRowNumbers" class="rn-col rn-th">
                <span>#</span>
                <div class="col-resize-handle" @mousedown.stop.prevent="startRnResize($event)" @click.stop></div>
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
                    {{ activeSortCriteria[sortRankOf(col.origIdx)].dir === 'asc' ? '↑' : '↓' }}
                    <sup v-if="activeSortCriteria.length > 1" class="sort-rank">{{ sortRankOf(col.origIdx) + 1 }}</sup>
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
            <!--
              Virtual scroll spacer — maintains the correct scrollable height so the
              scrollbar thumb represents the full dataset, even though only a window
              of rows is rendered.  Gated on tableFixed so it never shows during the
              brief auto-layout snapshot phase.
            -->
            <tr v-if="paddingTopPx > 0" class="vspacer" aria-hidden="true" :style="{ height: paddingTopPx + 'px' }">
              <td :colspan="totalCols"></td>
            </tr>
            <tr
              v-for="(row, vi) in visibleRows"
              :key="scrollOffset + vi"
              :data-row-idx="scrollOffset + vi"
              :class="trClass(vi)"
              @mousedown="onRowMousedown(vi, $event)"
            >
              <td v-if="showRowNumbers" class="rn-col rn-td">{{ scrollOffset + vi + (externalOffset ?? 0) + 1 }}</td>
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
                @blur="editable ? onCellEdit(scrollOffset + vi + (externalOffset ?? 0), col.origIdx, ($event.target as HTMLElement).innerText) : undefined"
              ><em v-if="row[col.origIdx] === null || row[col.origIdx] === undefined" class="cell-null">&lt;null&gt;</em
              ><template v-else>{{ formatCell(row[col.origIdx]) }}</template></td>
            </tr>
            <!-- Virtual scroll bottom spacer -->
            <tr v-if="paddingBottomPx > 0" class="vspacer" aria-hidden="true" :style="{ height: paddingBottomPx + 'px' }">
              <td :colspan="totalCols"></td>
            </tr>
            <!-- "More rows" sentinel row shown when the grid has additional pages -->
            <tr v-if="hasMorePages" class="more-rows-row">
              <td :colspan="(showRowNumbers ? 1 : 0) + displayCols.length" class="more-rows-td">
                ↓ {{ (displayRowCount - ((externalOffset ?? 0) + rows.length)).toLocaleString() }} more rows — press <strong>Next</strong> to continue
              </td>
            </tr>
            <!-- Data-size truncation warning -->
            <tr v-if="isTruncated" class="truncated-rows-row">
              <td :colspan="(showRowNumbers ? 1 : 0) + displayCols.length" class="truncated-rows-td">
                ⚠ Display limit reached ({{ ((maxDataBytes ?? 104857600) / 1048576).toLocaleString(undefined, { maximumFractionDigits: 0 }) }} MB) — showing first {{ effectiveRows.length.toLocaleString() }} of {{ rows.length.toLocaleString() }} rows. Reduce page size or export to CSV to access the full data.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="datagrid-footer">
        <span v-if="selectedRowsMap.size > 0" class="footer-sel">{{ selectedRowsMap.size }} selected &middot;&nbsp;</span>
        <span>{{ displayRowCount.toLocaleString() }} row{{ displayRowCount !== 1 ? 's' : '' }}</span>
        <span v-if="durationMs !== undefined" style="margin-left: 8px; color: var(--text-muted)">{{ durationMs }}ms</span>
        <button
          v-if="onCopySubsetRows"
          class="btn btn-ghost btn-sm copy-csv-btn"
          @click="onCopySubsetRows"
        >{{ copySubsetRowsLabel ?? 'Copy subset' }}</button>
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
          :title="`Copy all ${displayRowCount.toLocaleString()} row${displayRowCount !== 1 ? 's' : ''} as CSV to clipboard`"
          @click="copyAllAsCsv"
        >
          <span v-if="copyAllFeedback">✓ Copied!</span>
          <span v-else-if="copyAllInProgress">
            <span class="spinner" style="width:10px;height:10px;border-width:1.5px;margin-right:4px;"></span>Copying…
          </span>
          <span v-else>Copy {{ displayRowCount.toLocaleString() }} row{{ displayRowCount !== 1 ? 's' : '' }}</span>
        </button>
        <!-- External pagination (server-side): parent owns the page state -->
        <div v-if="onPageChange && displayRowCount > rows.length" style="margin-left: auto; display:flex; gap:6px; align-items:center;">
          <button class="btn btn-ghost btn-sm" :disabled="(externalOffset ?? 0) === 0" @click="onPageChange(Math.max(0, (externalOffset ?? 0) - PAGE))">‹ Prev</button>
          <span style="font-size:12px;">{{ (externalOffset ?? 0) + 1 }}–{{ Math.min((externalOffset ?? 0) + rows.length, displayRowCount) }} / {{ displayRowCount.toLocaleString() }}</span>
          <button class="btn btn-ghost btn-sm" :disabled="(externalOffset ?? 0) + rows.length >= displayRowCount" @click="onPageChange((externalOffset ?? 0) + PAGE)">Next ›</button>
        </div>
        <!-- Internal pagination (client-side): DataGrid slices rows locally -->
        <div v-else-if="!onPageChange && rows.length > PAGE" style="margin-left: auto; display:flex; gap:6px; align-items:center;">
          <button class="btn btn-ghost btn-sm" :disabled="scrollOffset === 0" @click="scrollOffset = Math.max(0, scrollOffset - PAGE)">‹ Prev</button>
          <span style="font-size:12px;">{{ scrollOffset + 1 }}–{{ Math.min(scrollOffset + PAGE, rows.length) }}</span>
          <button class="btn btn-ghost btn-sm" :disabled="scrollOffset + PAGE >= rows.length" @click="scrollOffset = Math.min(rows.length - PAGE, scrollOffset + PAGE)">Next ›</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, reactive, onMounted, onUnmounted } from 'vue'
import type { SortCriterion } from '../../../shared/types'

const props = defineProps<{
  columns: string[]
  rows: unknown[][]
  error?: string
  durationMs?: number
  editable?: boolean
  showRowNumbers?: boolean
  pageSize?: number
  rowClass?: (idx: number) => string
  onCopySubsetRows?: () => void | Promise<void>
  copySubsetRowsLabel?: string
  onExportCsv?: () => void | Promise<void>
  exportingCsv?: boolean
  exportCsvLabel?: string
  onCopyAllRows?: () => Promise<void>
  totalRowCount?: number
  /** When set, enables external (server-side) pagination mode.
   *  The parent owns the page state and passes the current page in `rows`. */
  onPageChange?: (newOffset: number) => void
  /** The row index of the first row in the current page (0-based). */
  externalOffset?: number
  /**
   * When set together with `onSortChange`, enables server-side sort mode.
   * The parent owns the sort state; DataGrid shows indicators from this prop
   * and calls `onSortChange` instead of sorting locally.
   */
  externalSortCriteria?: SortCriterion[]
  /** Called when the user clicks a column header in server-side sort mode. */
  onSortChange?: (criteria: SortCriterion[]) => void
  /**
   * Maximum estimated byte size of the rows data allowed to render.
   * When the rows received exceed this limit, only the rows that fit are rendered
   * and a warning row is shown at the bottom.
   * Defaults to 100 MB (100 * 1024 * 1024).
   */
  maxDataBytes?: number
}>()

const emit = defineEmits<{ cellEdit: [row: number, col: number, value: string] }>()

// ── All refs declared first to avoid temporal dead zone in immediate watchers ──
const colOrder = ref<number[]>([])
const frozenCount = ref(0)
const colWidths = ref<number[]>([])
const rnWidth = ref(40)         // row-number column width, resizable
const tableFixed = ref(false)   // switches to fixed layout after first width snapshot

const internalSortCriteria = ref<SortCriterion[]>([])
/**
 * In internal pagination mode: the first row index of the current page within sortedRows.
 * In external pagination mode: the first row index of the current virtual window within
 * the delivered page (i.e. the virtual-scroll position within the page).
 * All selection, focus, and display logic uses `scrollOffset + vi` as the
 * page-relative row index, which is consistent across both modes.
 */
const scrollOffset = ref(0)

// ── Virtual scroll ─────────────────────────────────────────────────────────────
/** Max rows to render during the auto-layout snapshot (column auto-sizing) phase. */
const VSAMPLE = 200
/** Extra rows rendered above and below the visible viewport. */
const VBUFFER = 30
/** Measured height of a single data row in px.  Updated after first render. */
const vRowHeight = ref(28)
/** Measured client height of the table-wrap div.  Updated by ResizeObserver. */
const vWrapHeight = ref(500)
/** Number of rows that fit in the viewport. */
const vViewCount = computed(() => Math.ceil(vWrapHeight.value / Math.max(1, vRowHeight.value)) + 1)
/** Total column count (rn + data), used for spacer-row colspan. */
const totalCols = computed(() => (props.showRowNumbers ? 1 : 0) + displayCols.value.length)
/** Pixel height of the top spacer row (rows above the virtual window). */
const paddingTopPx = computed(() =>
  props.onPageChange && tableFixed.value ? scrollOffset.value * vRowHeight.value : 0
)
/** Pixel height of the bottom spacer row (rows below the virtual window). */
const paddingBottomPx = computed(() => {
  if (!props.onPageChange || !tableFixed.value) return 0
  const windowEnd = scrollOffset.value + vViewCount.value + 2 * VBUFFER
  return Math.max(0, (sortedRows.value.length - windowEnd) * vRowHeight.value)
})

/**
 * Row selection is stored in a reactive Map rather than a ref<Set> so that
 * each row's class binding depends only on its own key.  When one row is
 * selected/deselected, Vue only re-renders the rows whose key changed — O(1)
 * DOM updates instead of O(n) for the common single-row-click case.
 */
const selectedRowsMap = reactive(new Map<number, boolean>())
interface FocusedCell { rowIdx: number; origIdx: number }
const focusedCell = ref<FocusedCell | null>(null)
const tableWrap = ref<HTMLElement | null>(null)
let lastClickedRow: number | null = null

interface DisplayCol {
  origIdx: number
  frozen: boolean
  displayIdx: number
}

// ── Selection helpers ──────────────────────────────────────────────────────────
function clearSelection(): void {
  selectedRowsMap.clear()
}

function selectOnly(rowIdx: number): void {
  // Only set/clear the two rows that actually change, avoiding O(n) map clears
  // when the previous selection was a single row too.
  if (selectedRowsMap.size === 1 && selectedRowsMap.has(rowIdx)) return
  selectedRowsMap.clear()
  selectedRowsMap.set(rowIdx, true)
}

function addRangeToSelection(from: number, to: number): void {
  for (let i = from; i <= to; i++) {
    if (!selectedRowsMap.has(i)) selectedRowsMap.set(i, true)
  }
}

function setSelectionToRange(from: number, to: number): void {
  // Remove keys outside the new range
  for (const k of selectedRowsMap.keys()) {
    if (k < from || k > to) selectedRowsMap.delete(k)
  }
  // Add keys inside the new range
  for (let i = from; i <= to; i++) {
    if (!selectedRowsMap.has(i)) selectedRowsMap.set(i, true)
  }
}

function selectAll(indices: number[]): void {
  selectedRowsMap.clear()
  for (const i of indices) selectedRowsMap.set(i, true)
}

// ── Column ordering & freezing ─────────────────────────────────────────────────
watch(
  () => props.columns,
  async (cols) => {
    colOrder.value = cols.map((_, i) => i)
    frozenCount.value = 0
    colWidths.value = []          // clear so <col> has no explicit widths
    rnWidth.value = 40            // reset to default before auto-size
    tableFixed.value = false      // use auto layout for first render
    internalSortCriteria.value = []
    clearSelection()
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
  // Capture row-number column width
  const rnTh = tableWrap.value.querySelector<HTMLElement>('thead th.rn-th')
  if (rnTh) {
    rnWidth.value = rnTh.offsetWidth
  }
  // Capture data column widths
  const ths = tableWrap.value.querySelectorAll<HTMLElement>('thead th.dg-th')
  const widths: number[] = new Array(props.columns.length).fill(0)
  ths.forEach((th) => {
    const idx = Number(th.dataset.origIdx)
    if (!isNaN(idx)) widths[idx] = th.offsetWidth
  })
  colWidths.value = widths
  // Measure actual row height from the first data row (skip spacer rows).
  // All data rows are uniform height since cells use white-space: nowrap.
  const firstDataTr = tableWrap.value.querySelector<HTMLElement>('tbody tr:not(.vspacer)')
  if (firstDataTr && firstDataTr.offsetHeight > 0) {
    vRowHeight.value = firstDataTr.offsetHeight
  }
  // Now that widths are locked, switch to fixed layout so drag can shrink too
  tableFixed.value = true
}

watch(
  () => props.rows,
  () => {
    scrollOffset.value = 0
    clearSelection()
    focusedCell.value = null
    lastClickedRow = null
    // Reset DOM scroll position so the virtual window starts at the top.
    if (tableWrap.value) {
      tableWrap.value.scrollTop = 0
    }
  }
)

watch(
  () => props.externalOffset,
  () => {
    clearSelection()
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

/**
 * In server-side sort mode (`onSortChange` is set) the parent drives sort state
 * via `externalSortCriteria`.  Otherwise internal state is used.
 */
const activeSortCriteria = computed<SortCriterion[]>(() =>
  props.onSortChange ? (props.externalSortCriteria ?? []) : internalSortCriteria.value
)

function sortRankOf(origIdx: number): number {
  return activeSortCriteria.value.findIndex((c) => c.colIdx === origIdx)
}

const sortedRowIndices = computed<number[]>(() => {
  const rows = effectiveRows.value
  const indices = rows.map((_, i) => i)
  // In external sort mode the server already sorted; don't re-sort locally.
  if (props.onSortChange || internalSortCriteria.value.length === 0) {
    return indices
  }
  return [...indices].sort((a, b) => {
    for (const { colIdx, dir } of internalSortCriteria.value) {
      const va = rows[a][colIdx]
      const vb = rows[b][colIdx]
      if (va === null || va === undefined) { if (vb !== null && vb !== undefined) return 1; continue }
      if (vb === null || vb === undefined) return -1
      const na = Number(va), nb = Number(vb)
      const cmp = (!isNaN(na) && !isNaN(nb)) ? na - nb : String(va).localeCompare(String(vb))
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
    }
    return 0
  })
})

const sortedRows = computed(() => sortedRowIndices.value.map((i) => effectiveRows.value[i]))

function buildNewCriteria(current: SortCriterion[], origIdx: number, shift: boolean): SortCriterion[] {
  const rank = current.findIndex((c) => c.colIdx === origIdx)
  if (shift) {
    if (rank >= 0) {
      return current.map((c, i) =>
        i === rank ? { ...c, dir: c.dir === 'asc' ? 'desc' as const : 'asc' as const } : c
      )
    }
    return [...current, { colIdx: origIdx, dir: 'asc' }]
  }
  if (rank >= 0 && current.length === 1) {
    return [{ colIdx: origIdx, dir: current[0].dir === 'asc' ? 'desc' : 'asc' }]
  }
  return [{ colIdx: origIdx, dir: 'asc' }]
}

function onHeaderClick(origIdx: number, e: MouseEvent): void {
  const newCriteria = buildNewCriteria(activeSortCriteria.value, origIdx, e.shiftKey)
  if (props.onSortChange) {
    props.onSortChange(newCriteria)
  } else {
    internalSortCriteria.value = newCriteria
  }
  scrollOffset.value = 0
  clearSelection()
  lastClickedRow = null
}

// ── Data-size guard ────────────────────────────────────────────────────────────
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024  // 100 MB

/**
 * Finds the first row index at which the cumulative estimated byte size of the
 * rows data exceeds `maxDataBytes`.  Returns null when the data is within limits.
 * Estimate: 2 bytes per character (UTF-16) for each cell stringified.
 */
const truncatedAt = computed<number | null>(() => {
  const limit = props.maxDataBytes ?? DEFAULT_MAX_BYTES
  let total = 0
  for (let i = 0; i < props.rows.length; i++) {
    for (const cell of props.rows[i]) {
      if (cell !== null && cell !== undefined) {
        total += String(cell).length * 2
      }
    }
    if (total > limit) {
      return i  // keep rows 0..i-1; row i pushed us over
    }
  }
  return null
})

/** Rows actually rendered — potentially a subset of `props.rows` when size limit is exceeded. */
const effectiveRows = computed(() =>
  truncatedAt.value !== null ? props.rows.slice(0, truncatedAt.value) : props.rows
)

const isTruncated = computed(() => truncatedAt.value !== null)

// ── Pagination ─────────────────────────────────────────────────────────────────
const PAGE = computed(() => props.pageSize ?? 200)

/**
 * The rows actually rendered in the DOM.
 *
 * External mode (onPageChange set):
 *   - Auto-layout phase (!tableFixed): render only the first VSAMPLE rows so
 *     the browser can auto-size column widths without mounting 100k nodes.
 *   - Fixed layout: render a virtual window of rows centred around scrollOffset,
 *     padded by VBUFFER rows on each side.  Top and bottom spacer <tr> rows
 *     maintain the full scroll height for everything outside the window.
 *
 * Internal mode: slice a single page locally (unchanged behaviour).
 */
const visibleRows = computed(() => {
  if (props.onPageChange) {
    if (!tableFixed.value) {
      // Auto-layout sample: limit DOM size during the column-width snapshot phase.
      return sortedRows.value.slice(0, VSAMPLE)
    }
    const end = Math.min(sortedRows.value.length, scrollOffset.value + vViewCount.value + 2 * VBUFFER)
    return sortedRows.value.slice(scrollOffset.value, end)
  }
  return sortedRows.value.slice(scrollOffset.value, scrollOffset.value + PAGE.value)
})

// Total row count shown in the footer and "Copy N rows" button.
const displayRowCount = computed(() => props.totalRowCount ?? effectiveRows.value.length)

// True when the grid is in external pagination mode and there are pages beyond the current one.
// Uses props.rows.length (untruncated) so truncation alone does not suppress the Next indicator.
const hasMorePages = computed(() =>
  !!props.onPageChange && (props.externalOffset ?? 0) + props.rows.length < (props.totalRowCount ?? props.rows.length)
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

  if (!selectedRowsMap.has(rowIdx)) {
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
    addRangeToSelection(Math.min(lastClickedRow, rowIdx), Math.max(lastClickedRow, rowIdx))
    e.preventDefault()
    return
  }

  // Normal mousedown: select anchor row and start drag
  focusedCell.value = null
  selectOnly(rowIdx)
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
    setSelectionToRange(Math.min(rowIdx, hoverIdx), Math.max(rowIdx, hoverIdx))
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
    selectAll(sortedRows.value.map((_, i) => i))
    lastClickedRow = null
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
    if (target.isContentEditable) return
    if (focusedCell.value) return  // let browser copy the cell's selected text
    if (selectedRowsMap.size === 0) return
    e.preventDefault()
    copySelectionAsCsv()
  } else if (e.key === 'Escape') {
    if (focusedCell.value) {
      // First Escape: leave cell-focus mode, keep row selected
      focusedCell.value = null
      window.getSelection()?.removeAllRanges()
    } else {
      clearSelection()
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
  const bodyLines = [...selectedRowsMap.keys()]
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
    // selectedRowsMap.get(rowIdx) creates a per-key Vue dependency, so only the
    // specific rows whose selection state changes will re-render on click.
    'selected-row': selectedRowsMap.get(rowIdx) === true,
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

const frozenLeftOffsets = computed<number[]>(() => {
  const offsets: number[] = []
  let left = props.showRowNumbers ? rnWidth.value : 0
  for (let di = 0; di < frozenCount.value; di++) {
    offsets.push(left)
    left += colWidths.value[colOrder.value[di]] ?? 120
  }
  return offsets
})

/**
 * CSS custom properties applied to the table-wrap div.
 * Frozen cell `left` values are expressed as `var(--dg-fl-N)` so that updating
 * one CSS variable propagates to ALL cells via the CSS cascade — O(1) instead
 * of O(rows × frozenCount) individual style patches on every resize mousemove.
 */
const frozenCssVars = computed<Record<string, string>>(() => {
  const vars: Record<string, string> = {}
  frozenLeftOffsets.value.forEach((left, i) => {
    vars[`--dg-fl-${i}`] = left + 'px'
  })
  return vars
})

// Explicit pixel width for the table in fixed-layout mode.
// Summing all column widths (+ row-number col) and binding it to the <table>
// element prevents the browser from redistributing space when the wrapper is
// wider than the columns — only the dragged column grows, the rest stay put.
const tableExplicitWidth = computed(() => {
  const rnPxWidth = props.showRowNumbers ? rnWidth.value : 0
  const colSum = colWidths.value.reduce((acc, w) => acc + (w || 0), 0)
  // Also factor in the wrapper width so the table fills the container when
  // columns are narrower than the visible area (no unnecessary horizontal bar).
  const containerWidth = tableWrap.value?.clientWidth ?? 0
  return Math.max(rnPxWidth + colSum, containerWidth)
})

function colHeaderStyle(col: DisplayCol): Record<string, string> {
  if (!col.frozen) return {}
  return {
    position: 'sticky',
    top: '0',
    left: `var(--dg-fl-${col.displayIdx})`,
    zIndex: '4',  /* above regular sticky headers (z-index: 2) and frozen body cells (z-index: 1) */
    background: 'var(--surface2)'
  }
}

function frozenTdStyle(col: DisplayCol): Record<string, string> {
  return {
    position: 'sticky',
    left: `var(--dg-fl-${col.displayIdx})`,
    zIndex: '1',
    background: 'var(--surface)'
  }
}

// ── Virtual scroll event handling ─────────────────────────────────────────────

function onTableWrapScroll(): void {
  if (!props.onPageChange || !tableWrap.value) return
  const rawTop = Math.floor(tableWrap.value.scrollTop / Math.max(1, vRowHeight.value))
  const newOffset = Math.max(0, rawTop - VBUFFER)
  if (newOffset === scrollOffset.value) return
  scrollOffset.value = newOffset
  // Note: focusedCell is intentionally NOT cleared here.  Keeping it set means
  // the focused (expanded) row stays expanded while it remains in the virtual
  // window.  When it scrolls completely out of the window its <tr> is removed
  // from the DOM so it naturally collapses, and re-expands when scrolled back.
  // In non-editable mode @blur is bound to undefined so there is no risk of a
  // spurious onCellEdit being triggered when the element leaves the DOM.
}

let _resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!tableWrap.value) return
  tableWrap.value.addEventListener('scroll', onTableWrapScroll, { passive: true })
  _resizeObserver = new ResizeObserver((entries) => {
    vWrapHeight.value = entries[0]?.contentRect.height ?? 500
  })
  _resizeObserver.observe(tableWrap.value)
  vWrapHeight.value = tableWrap.value.clientHeight
})

onUnmounted(() => {
  if (tableWrap.value) {
    tableWrap.value.removeEventListener('scroll', onTableWrapScroll)
  }
  _resizeObserver?.disconnect()
  _resizeObserver = null
})

// ── Column resize ──────────────────────────────────────────────────────────────

/**
 * Directly update the CSS custom properties that drive frozen-cell `left`
 * positions, overriding `origIdx`'s width with `overrideWidth`.
 * Called during drag to avoid Vue reactive updates entirely — O(frozenCount).
 */
function applyFrozenOffsetsDOM(wrap: HTMLElement, overrideOrigIdx: number, overrideWidth: number): void {
  let left = props.showRowNumbers ? rnWidth.value : 0
  for (let di = 0; di < frozenCount.value; di++) {
    wrap.style.setProperty(`--dg-fl-${di}`, left + 'px')
    const origIdx = colOrder.value[di]
    left += origIdx === overrideOrigIdx ? overrideWidth : (colWidths.value[origIdx] ?? 120)
  }
}

function startResize(e: MouseEvent, origIdx: number): void {
  // Always read the actual rendered width so drag delta starts from reality.
  const th = tableWrap.value?.querySelector<HTMLElement>(`thead th[data-orig-idx="${origIdx}"]`)
  const startW = th ? th.offsetWidth : (colWidths.value[origIdx] ?? 120)
  const startX = e.clientX

  // Pre-locate DOM elements we'll patch directly during drag.
  const colEl = tableWrap.value?.querySelector<HTMLElement>(`col[data-orig-idx="${origIdx}"]`)
  const tableEl = tableWrap.value?.querySelector<HTMLTableElement>('table.datagrid-table')
  const diOfDragged = displayCols.value.findIndex(c => c.origIdx === origIdx)
  const isFrozen = diOfDragged >= 0 && diOfDragged < frozenCount.value

  // Inject a temporary <style> with !important so no child element can override
  // the cursor or trigger text-selection highlights during the drag.
  const dragStyle = document.createElement('style')
  dragStyle.textContent = '*, *::before, *::after { cursor: col-resize !important; user-select: none !important; }'
  document.head.appendChild(dragStyle)

  let currentW = startW

  const onMove = (ev: MouseEvent): void => {
    currentW = Math.max(40, startW + ev.clientX - startX)

    // Direct DOM updates — zero Vue reactive overhead during the drag.
    if (colEl) colEl.style.width = currentW + 'px'
    if (tableEl && tableFixed.value && tableWrap.value) {
      const rnPx = props.showRowNumbers ? rnWidth.value : 0
      const colSum = colWidths.value.reduce((acc, w, i) => acc + (i === origIdx ? currentW : (w || 0)), 0)
      tableEl.style.width = Math.max(rnPx + colSum, tableWrap.value.clientWidth) + 'px'
    }
    if (isFrozen && tableWrap.value) {
      applyFrozenOffsetsDOM(tableWrap.value, origIdx, currentW)
    }
  }

  const onUp = (): void => {
    document.head.removeChild(dragStyle)
    // Single reactive commit — triggers exactly one Vue re-render to sync state.
    colWidths.value[origIdx] = currentW
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function startRnResize(e: MouseEvent): void {
  const th = tableWrap.value?.querySelector<HTMLElement>('thead th.rn-th')
  const startW = th ? th.offsetWidth : rnWidth.value

  const rnColEl = tableWrap.value?.querySelector<HTMLElement>('col[data-rn-col]')
  const tableEl = tableWrap.value?.querySelector<HTMLTableElement>('table.datagrid-table')

  const dragStyle = document.createElement('style')
  dragStyle.textContent = '*, *::before, *::after { cursor: col-resize !important; user-select: none !important; }'
  document.head.appendChild(dragStyle)

  let currentW = startW

  const onMove = (ev: MouseEvent): void => {
    currentW = Math.max(30, startW + ev.clientX - e.clientX)

    if (rnColEl) rnColEl.style.width = currentW + 'px'
    if (tableEl && tableFixed.value && tableWrap.value) {
      const colSum = colWidths.value.reduce((acc, w) => acc + (w || 0), 0)
      tableEl.style.width = Math.max(currentW + colSum, tableWrap.value.clientWidth) + 'px'
    }
    // rnWidth shift moves ALL frozen column offsets — update CSS vars directly.
    if (frozenCount.value > 0 && tableWrap.value) {
      let left = currentW
      for (let di = 0; di < frozenCount.value; di++) {
        tableWrap.value.style.setProperty(`--dg-fl-${di}`, left + 'px')
        left += colWidths.value[colOrder.value[di]] ?? 120
      }
    }
  }

  const onUp = (): void => {
    document.head.removeChild(dragStyle)
    // Single reactive commit — triggers exactly one Vue re-render to sync state.
    rnWidth.value = currentW
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
  for (const row of effectiveRows.value) {
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
.cell-null { font-style: italic; color: var(--text-muted); }

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
  /* Width is set explicitly via :style binding (sum of col widths ≥ container width).
     This prevents the browser from redistributing space among columns when the wrapper
     is wider — only the dragged column changes, others stay fixed. */
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
  text-align: right;
  padding-right: 8px;
  color: var(--text-muted);
  flex-shrink: 0;
  overflow: hidden;
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

/* ── Virtual scroll spacer rows ── */
.vspacer {
  pointer-events: none;
}

.vspacer td {
  padding: 0;
  border: none;
  background: transparent;
}

/* ── More rows sentinel row ── */
.more-rows-row {
  cursor: default;
  pointer-events: none;
}

.more-rows-td {
  text-align: center;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
  border-top: 1px dashed var(--border);
  background: color-mix(in srgb, var(--primary) 4%, var(--surface));
}

/* ── Data-size truncation warning row ── */
.truncated-rows-row {
  cursor: default;
  pointer-events: none;
}

.truncated-rows-td {
  text-align: center;
  padding: 7px 12px;
  font-size: 12px;
  color: color-mix(in srgb, var(--warning, #b45309) 90%, var(--text));
  border-top: 2px solid color-mix(in srgb, var(--warning, #b45309) 40%, var(--border));
  background: color-mix(in srgb, var(--warning, #b45309) 6%, var(--surface));
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
