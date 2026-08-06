<template>
  <div v-if="conn.dbConnected" class="scripts-view">
    <!-- Sidebar -->
    <aside class="scripts-sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">Scripts</span>
        <button class="btn btn-primary btn-sm" @click="newScript" title="New script">+</button>
      </div>

      <div class="script-list">
        <div
          v-for="s in scripts"
          :key="s.id"
          class="script-item"
          :class="{ active: activeScript?.savedId === s.id }"
          @click="loadScript(s)"
          :title="s.name"
        >
          <span class="script-lang-badge">JS</span>
          <span class="script-name">{{ s.name }}</span>
          <button class="script-delete" @click.stop="deleteScript(s.id)" title="Delete">×</button>
        </div>
        <div v-if="scripts.length === 0" class="script-empty">No saved scripts</div>
      </div>

      <div class="sidebar-footer">
        <button class="btn btn-ghost btn-sm full-width" @click="showHelp = !showHelp">
          {{ showHelp ? '← Editor' : '? Help' }}
        </button>
      </div>
    </aside>

    <!-- Main area -->
    <div class="scripts-main">
      <!-- Toolbar -->
      <div class="toolbar">
        <input
          v-model="activeScript.name"
          class="script-name-input"
          placeholder="Script name"
          @blur="markDirty"
        />
        <span class="lang-badge">JavaScript</span>
        <div class="toolbar-sep" :class="{ 'toolbar-sep--active': progressValue !== null }">
          <template v-if="progressValue !== null">
            <div class="toolbar-progress-track">
              <div class="toolbar-progress-fill" :style="{ width: progressPct + '%' }"></div>
              <span class="toolbar-progress-label">{{ progressLabel || progressPct + '%' }}</span>
            </div>
          </template>
        </div>
        <button
          v-if="!running"
          class="btn btn-primary btn-sm"
          :disabled="!activeScript.code.trim()"
          @click="runScript"
        >▶ Run</button>
        <button
          v-else
          class="btn btn-danger btn-sm"
          @click="cancelScript"
        >■ Cancel</button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="!activeScript.code.trim() && !activeScript.name.trim()"
          @click="saveScript"
        >💾 Save</button>
        <span v-if="activeScript.dirty" class="dirty-dot" title="Unsaved changes">•</span>
        <button
          class="btn btn-secondary btn-sm ai-toggle-btn"
          :class="{ active: aiDrawerOpen }"
          title="AI Assistant"
          @click="aiDrawerOpen = !aiDrawerOpen"
        >AI</button>
      </div>

      <!-- Editor or Help panel -->
      <div class="editor-area" ref="editorArea">
        <!-- Monaco editor (always rendered, hidden when help shown) -->
        <div ref="monacoContainer" class="monaco-container" :style="{ display: showHelp ? 'none' : 'block' }"></div>

        <!-- Help panel -->
        <div v-if="showHelp" class="help-panel">
          <h2>Script API Reference</h2>

          <h3>Database methods</h3>
          <table class="api-table">
            <tbody>
              <tr>
                <td><code>db.query(sql, params?)</code></td>
                <td>Runs a SELECT and returns <code>{ columns, rows }</code>. <code>columns</code> is an ordered array of column names; each element of <code>rows</code> is a plain array of values in the same order. All rows are loaded into memory — use for small / medium result sets.</td>
              </tr>
              <tr>
                <td><code>db.query(sql, params?, { asObjects: true })</code></td>
                <td>Same as above, but returns an array of plain objects keyed by column name — <code>Record&lt;string, unknown&gt;[]</code>. Convenient when you want to access fields by name (<code>row.revenue</code>) rather than by index. The conversion happens locally after the query; there is no extra transport cost.</td>
              </tr>
              <tr>
                <td><code>db.iterate(sql, params?)</code></td>
                <td>Returns a lazy <code>IterableIterator</code> backed by SQLite's cursor. Fetches one row at a time — use for millions of rows (O(1) memory).</td>
              </tr>
              <tr>
                <td><code>db.execute(sql, params?)</code></td>
                <td>Runs INSERT / UPDATE / DELETE. Returns <code>{ changes, lastInsertRowid }</code>.</td>
              </tr>
              <tr>
                <td><code>db.transaction(fn)</code></td>
                <td>Wraps <code>fn()</code> in a single BEGIN/COMMIT. Batching writes in one transaction is 10–100× faster than individual commits.</td>
              </tr>
              <tr>
                <td><code>db.progress(value)</code></td>
                <td>Sets the toolbar progress bar to <code>value</code> % (0–100). The bar appears on first call and disappears when the script finishes.</td>
              </tr>
              <tr>
                <td><code>db.progress(value, total)</code></td>
                <td>Sets progress to <code>value / total × 100</code> %. Convenient when iterating — pass the loop counter and the total row count.</td>
              </tr>
              <tr>
                <td><code>db.progress(value, total, label)</code></td>
                <td>Same as above but also overlays a custom text label on the bar (e.g. <code>"Processing row 5 000 of 20 000"</code>). When omitted, the percentage is shown instead.</td>
              </tr>
            </tbody>
          </table>

          <h3>Job execution methods</h3>
          <p style="margin:0 0 8px;color:var(--text-muted);">Jobs are identified by their <strong>display label</strong> — the same string shown in the Jobs list (e.g. <code>"Account: extract"</code>, <code>"Contact: writeback"</code>, <code>"SOQL: monthly report"</code>). Use <code>jobs.list()</code> to discover available labels. Labels are matched case-insensitively.</p>
          <table class="api-table">
            <tbody>
              <tr>
                <td><code>jobs.list()</code></td>
                <td>Returns a promise that resolves to an array of all configured jobs. Each entry: <code>{ label, type, sfObject, destTable?, operation?, api? }</code>. Use <code>label</code> to call <code>runDownload</code> / <code>runWriteback</code>.</td>
              </tr>
              <tr>
                <td><code>jobs.runDownload(label)</code></td>
                <td>Runs the download job identified by <code>label</code>. Returns <code>{ status, rowsSource, rowsSucceeded }</code>. <code>rowsSource</code> = rows fetched from Salesforce; <code>rowsSucceeded</code> = rows written to the destination table. Throws if the job is not found, already running, fails, or is cancelled.</td>
              </tr>
              <tr>
                <td><code>jobs.runWriteback(label)</code></td>
                <td>Runs the writeback job identified by <code>label</code>. Returns <code>{ status, rowsSource, rowsSucceeded, rowsFailed, execTable }</code>. <code>rowsSource</code> = source rows; <code>execTable</code> = SQLite table name (queryable with <code>db.query()</code>) containing every row with its <code>__sf_id</code>, <code>__status</code>, and <code>__error</code> columns — <code>null</code> for Bulk jobs with no failures.</td>
              </tr>
              <tr>
                <td><code>jobs.getFailedRows(result)</code></td>
                <td>Lazily fetches row-level failure data for a completed writeback. Returns <code>{ failedRows, keyFields }</code>. <code>failedRows</code> is an array of <code>{ index, message, row }</code> objects. <code>keyFields</code> lists the SF fields available for <code>updateTableWithIds</code>. Must be called before 5 subsequent writeback jobs evict the run state.</td>
              </tr>
              <tr>
                <td><code>jobs.updateTableWithIds(result, opts)</code></td>
                <td>Writes the SF IDs created by an insert writeback back into a SQLite table. <code>opts</code>: <code>{ sfKeyField, targetTable, tableKeyCol, idColumnName }</code>. Returns <code>{ updated, idColCreated, indexCreated }</code>. Must be called before 5 subsequent writeback jobs evict the run state.</td>
              </tr>
            </tbody>
          </table>

          <h3>Example 1 — <code>for…of</code> loop with <code>db.iterate()</code></h3>
          <p>Idiomatic streaming iteration. SQLite never loads the full table into memory.</p>
          <pre class="code-example">// Process every row in a large table using a for-of loop.
// db.iterate() fetches one row at a time from SQLite's cursor,
// so the full table is never loaded into memory.

let count = 0

db.transaction(() => {
  for (const row of db.iterate('SELECT id, revenue FROM accounts')) {
    const tier = row.revenue > 100000 ? 'enterprise' : 'standard'
    db.execute('UPDATE accounts SET tier = ? WHERE id = ?', [tier, row.id])
    count++
    if (count % 100000 === 0) {
      console.log(`Processed ${count} rows...`)
    }
  }
})

console.log(`Done. Updated ${count} rows.`)</pre>

          <h3>Example 2 — manual <code>while</code> loop with an explicit iterator</h3>
          <p>Drives the iterator one record at a time — useful for fine-grained control, such as computing a running total that depends on the previous row.</p>
          <pre class="code-example">// You can drive the iterator manually, one record at a time.
// This is useful when you need to break out of the loop based
// on computed state, or interleave reads and writes precisely.
// Note that SQLite does not support having more than one iterators open at a time.

const iter = db.iterate('SELECT id, amount from transactions')

let { value: row, done } = iter.next()
let runningTotal = 0
let toUpdate = [ ];

while (!done) {
    runningTotal += row.amount;
    toUpdate.push([runningTotal, row.id]);
    ({ value: row, done } = iter.next());
}

console.log(`Final running total: ${runningTotal}`);

db.transaction(() => {
    for (const p of toUpdate) {
        db.execute('UPDATE transactions SET runningTotal = ? WHERE id = ?', p);
    }
});
console.log("Done");
</pre>

          <h3>Example 3 — progress bar while iterating</h3>
          <p>Count the rows first, then report progress every 1 000 rows while processing.</p>
          <pre class="code-example">// Get the total so we can compute a percentage.
// db.query() rows are arrays — destructure directly.
const { rows: [[total]] } = db.query('SELECT COUNT(*) AS n FROM accounts')

let i = 0
for (const row of db.iterate('SELECT id, revenue FROM accounts')) {
  const tier = row.revenue > 100_000 ? 'enterprise' : 'standard'
  db.execute('UPDATE accounts SET tier = ? WHERE id = ?', [tier, row.id])
  i++
  if (i % 1_000 === 0) {
    db.progress(i, total, `Updating row ${i.toLocaleString()} / ${Number(total).toLocaleString()}`)
  }
}
db.progress(total, total, 'Done ✓')
console.log(`Updated ${i} rows.`)</pre>

          <h3>Example 4 — list and run a download job</h3>
          <p>Discover available jobs, then run one and log how many rows were loaded.</p>
          <pre class="code-example">// List all configured jobs to find the right label
const allJobs = await jobs.list()
console.log(allJobs.map(j => `${j.type}: ${j.label}`).join('\n'))

// Run a specific download job using its display label
const result = await jobs.runDownload('Contact: extract')
console.log(`Fetched ${result.rowsSource} rows, inserted ${result.rowsSucceeded} rows`)</pre>

          <h3>Example 5 — run a writeback job</h3>
          <p>Start a saved writeback job, inspect the summary, and query the exec table for failed rows.</p>
          <pre class="code-example">const result = await jobs.runWriteback('Lead: writeback')
console.log(`Status: ${result.status} — Source: ${result.rowsSource}, Succeeded: ${result.rowsSucceeded}, Failed: ${result.rowsFailed}`)

// Option A — query the exec table directly for full row-level detail
if (result.execTable) {
  const { columns, rows } = db.query(
    `SELECT __status, __error, * FROM ${result.execTable} WHERE __status = 'error' LIMIT 100`
  )
  console.log(`First failed rows:`, JSON.stringify({ columns, rows }))
}

// Option B — use getFailedRows for structured access (must call before 5 more jobs run)
if (result.rowsFailed > 0) {
  const { failedRows } = await jobs.getFailedRows(result)
  for (const row of failedRows) {
    console.error(`Row ${row.index}: ${row.message}`)
  }
}</pre>

          <h3>Notes</h3>
          <ul>
            <li><code>params</code> are passed as a plain array: <code>db.query('SELECT * FROM t WHERE id = ?', [42])</code></li>
            <li>Rows returned by <code>db.iterate()</code> are always plain objects keyed by column name. Rows returned by <code>db.query()</code> are plain arrays by default — use the parallel <code>columns</code> array to look up field positions, or pass <code>{ asObjects: true }</code> as the third argument to get plain objects instead.</li>
            <li>Scripts run in a background thread — the UI stays responsive during long-running operations.</li>
            <li>Clicking <strong>Cancel</strong> immediately terminates the script; any uncommitted transaction is rolled back.</li>
            <li><code>console.log</code>, <code>console.warn</code>, and <code>console.error</code> stream live to the Logs panel below.</li>
            <li>The progress bar is hidden automatically when the script finishes or is cancelled. Call <code>db.progress(100)</code> at the end to show a full bar briefly before it disappears.</li>
            <li>Calling <code>db.progress()</code> too frequently (e.g. every row in a tight loop) adds negligible overhead — IPC messages are fire-and-forget. Every 1 000–10 000 rows is a reasonable interval for very large tables.</li>
            <li>Job labels are the same strings shown in the Jobs list (e.g. <code>"Account: extract"</code>). Matching is case-insensitive. Use <code>jobs.list()</code> to enumerate all available labels.</li>
            <li><code>jobs.runDownload</code> throws if the job fails or is cancelled. <code>jobs.runWriteback</code> always resolves — check <code>result.status</code> for <code>"error"</code> or <code>"cancelled"</code>.</li>
            <li>The writeback exec table (<code>result.execTable</code>) is kept in memory for the 5 most recent runs. Query it immediately after the job completes; it may be evicted if 5 more writeback jobs are started.</li>
            <li><code>jobs.runDownload</code> and <code>jobs.runWriteback</code> share the same 5-slot queue used by the UI. Starting a job that is already queued or running throws an error. Multiple jobs can be started concurrently with <code>Promise.all()</code> and they will queue automatically when all slots are full.</li>
          </ul>
        </div>
      </div>

      <!-- Drag divider -->
      <div class="h-split-divider" @mousedown.prevent="startDrag"></div>

      <!-- Output panel -->
      <div class="output-panel" :style="{ height: outputHeight + 'px' }">
        <div class="output-tabs">
          <button
            class="output-tab"
            :class="{ active: outputTab === 'logs' }"
            @click="outputTab = 'logs'"
          >Logs <span v-if="logs.length" class="log-count">{{ logs.length }}</span></button>
          <button
            class="output-tab"
            :class="{ active: outputTab === 'result' }"
            @click="outputTab = 'result'"
          >Result</button>
          <div style="display:flex; align-items:center; gap:6px; margin-left:auto;">
            <input type="checkbox" id="autoClearOutput" v-model="autoClearOutput" style="margin:0; cursor:pointer;" />
            <label for="autoClearOutput" style="font-size:12px; color:var(--text-muted); cursor:pointer; user-select:none; margin:0;">Auto-clear</label>
            <button class="btn btn-ghost btn-sm" style="font-size:11px;" @click="clearOutput">Clear</button>
          </div>
        </div>

        <div class="output-body">
          <!-- Logs -->
          <div v-if="outputTab === 'logs'" class="log-list" ref="logList">
            <div v-if="logs.length === 0" class="output-empty">No output yet.</div>
            <div
              v-for="(log, i) in logs"
              :key="i"
              class="log-entry"
              :class="'log-' + log.level"
            >
              <span class="log-ts">{{ formatTs(log.ts) }}</span>
              <span class="log-level">{{ log.level.toUpperCase() }}</span>
              <span class="log-text">{{ log.args.join(' ') }}</span>
            </div>
            <div v-if="running" class="log-entry log-running">
              <span class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;"></span>
              &nbsp;Running…
            </div>
          </div>

          <!-- Result -->
          <div v-if="outputTab === 'result'" class="result-body">
            <div v-if="!lastResult" class="output-empty">No result yet.</div>
            <template v-else>
              <div v-if="lastResult.error" class="result-error">
                <strong>Error:</strong> {{ lastResult.error }}
              </div>
              <div v-else class="result-success">
                Completed in {{ lastResult.durationMs }}ms
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- AI panel (always mounted to preserve chat state) -->
    <div
      class="ai-drawer"
      :class="{ open: aiDrawerOpen }"
      :style="aiDrawerOpen ? { width: aiPanelWidth + 'px' } : undefined"
      ref="aiPanel"
    >
      <div class="ai-resize-handle" @mousedown="startAiPanelResize"></div>
      <div class="ai-drawer-header">
        <span class="ai-drawer-title">AI Assistant</span>
        <button class="ai-drawer-close" title="Close" @click="aiDrawerOpen = false">✕</button>
      </div>
      <AiChatPanel @insert-js="insertJsFromAi" @insert-sql="openInQueryEditor" style="flex:1;min-height:0;overflow:hidden;" />
    </div>
  </div>

  <div v-else class="empty-state">
    <p>Open a database to use the script runner.</p>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import * as monaco from 'monaco-editor'
import { EDITOR_BASE_OPTIONS } from '../utils/monaco'
import { registerQuitHandler } from '../composables/useQuitHandlers'
import { useConnectionStore } from '../stores/connection'
import { useJobStore } from '../stores/job'
import AiChatPanel from '../components/AiChatPanel.vue'
import type { SavedScript, ScriptLog, ScriptComplete, ScriptDraft } from '../../../shared/types'

const conn = useConnectionStore()
const jobStore = useJobStore()
const router = useRouter()

// ── AI drawer ─────────────────────────────────────────────────────────────────
const aiDrawerOpen = ref(false)
const aiPanel = ref<HTMLElement | null>(null)
const AI_WIDTH_KEY = 'ai-panel-width'
const aiPanelWidth = ref(parseInt(localStorage.getItem(AI_WIDTH_KEY) ?? '400', 10))

function startAiPanelResize(e: MouseEvent): void {
  const startX = e.clientX
  const startW = aiPanel.value?.offsetWidth ?? aiPanelWidth.value
  aiPanel.value?.classList.add('is-resizing')
  const onMove = (ev: MouseEvent): void => {
    aiPanelWidth.value = Math.max(260, Math.min(900, startW - (ev.clientX - startX)))
  }
  const onUp = (): void => {
    aiPanel.value?.classList.remove('is-resizing')
    localStorage.setItem(AI_WIDTH_KEY, String(aiPanelWidth.value))
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function insertJsFromAi(code: string): void {
  if (!editor) {
    return
  }
  const model = editor.getModel()
  if (!model) {
    return
  }
  const currentValue = model.getValue().trim()
  if (currentValue === '') {
    model.setValue(code)
  } else {
    const pos = editor.getPosition()
    if (!pos) {
      return
    }
    editor.executeEdits('ai-chat', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: code }])
  }
  editor.focus()
}

function openInQueryEditor(sql: string): void {
  router.push({ path: '/query', state: { pendingSql: sql } })
}

// ── Script list ───────────────────────────────────────────────────────────────
const scripts = ref<SavedScript[]>([])

async function loadScripts(): Promise<void> {
  scripts.value = await window.api.listScripts()
}

// ── Per-script edit buffer ────────────────────────────────────────────────────
// Keyed by savedId (null = the "new script" slot). Stores unsaved edits so
// switching between scripts (or navigating away and back) never loses in-progress work.
interface EditBuffer { name: string; code: string }
const editBuffer = new Map<number | null, EditBuffer>()

function flushToBuffer(): void {
  editBuffer.set(activeScript.savedId, { name: activeScript.name, code: activeScript.code })
  if (editor) {
    const vs = editor.saveViewState()
    if (vs) {
      scriptViewStates.set(activeScript.savedId, vs)
    }
  }
}

// ── Active script state ───────────────────────────────────────────────────────
interface ActiveScript {
  savedId: number | null
  name: string
  language: 'javascript'
  code: string
  dirty: boolean
}

const activeScript = reactive<ActiveScript>({
  savedId: null,
  name: 'Untitled Script',
  language: 'javascript',
  code: '',
  dirty: false
})

function applyToEditor(code: string): void {
  if (editor) {
    editor.setValue(code)
    const vs = scriptViewStates.get(activeScript.savedId) ?? null
    editor.restoreViewState(vs)
    editor.focus()
  }
}

function newScript(): void {
  flushToBuffer()
  // Restore the "new" slot if it has buffered edits
  const buf = editBuffer.get(null)
  activeScript.savedId = null
  activeScript.name = buf?.name ?? 'Untitled Script'
  activeScript.language = 'javascript'
  activeScript.code = buf?.code ?? ''
  activeScript.dirty = buf != null
  showHelp.value = false
  applyToEditor(activeScript.code)
}

function loadScript(s: SavedScript): void {
  flushToBuffer()
  // Restore buffered edits for this script if they exist
  const buf = editBuffer.get(s.id)
  activeScript.savedId = s.id
  activeScript.name = buf?.name ?? s.name
  activeScript.language = s.language
  activeScript.code = buf?.code ?? s.code
  activeScript.dirty = buf != null
  showHelp.value = false
  applyToEditor(activeScript.code)
}

async function saveScript(): Promise<void> {
  const saved = await window.api.saveScript({
    id: activeScript.savedId ?? undefined,
    name: activeScript.name || 'Untitled Script',
    language: activeScript.language,
    code: activeScript.code
  })
  const oldKey = draftKey(activeScript.savedId)
  editBuffer.delete(activeScript.savedId)
  editBuffer.delete(saved.id)
  activeScript.savedId = saved.id
  activeScript.dirty = false
  void window.api.deleteScriptDraft(oldKey)
  await loadScripts()
}

async function deleteScript(id: number): Promise<void> {
  editBuffer.delete(id)
  scriptViewStates.delete(id)
  void window.api.deleteScriptDraft(draftKey(id))
  await window.api.deleteScript(id)
  if (activeScript.savedId === id) {
    newScript()
  }
  await loadScripts()
}

function markDirty(): void {
  activeScript.dirty = true
  flushToBuffer()
  scheduleIdleDraft()
}

// ── Draft autosave ────────────────────────────────────────────────────────────
const IDLE_DRAFT_MS = 60_000
let idleDraftTimer: ReturnType<typeof setTimeout> | null = null
let unregisterQuitHandler: (() => void) | null = null

function draftKey(savedId: number | null): string {
  return savedId === null ? 'new' : String(savedId)
}

async function saveDraftAll(): Promise<void> {
  flushToBuffer()
  for (const [key, buf] of editBuffer) {
    const vsRaw = scriptViewStates.get(key)
    await window.api.upsertScriptDraft({
      draftKey: draftKey(key),
      savedId: key,
      name: buf.name,
      code: buf.code,
      viewState: vsRaw ? JSON.stringify(vsRaw) : null
    })
  }
}

function scheduleIdleDraft(): void {
  if (idleDraftTimer !== null) {
    clearTimeout(idleDraftTimer)
  }
  idleDraftTimer = setTimeout(() => { void saveDraftAll() }, IDLE_DRAFT_MS)
}

function onWindowBlur(): void { void saveDraftAll() }

// ── Script execution ──────────────────────────────────────────────────────────
const running = ref(false)
const currentRunId = ref<string | null>(null)
const logs = ref<ScriptLog[]>([])
const lastResult = ref<ScriptComplete | null>(null)
const outputTab = ref<'logs' | 'result'>('logs')
const logList = ref<HTMLElement | null>(null)

let offScriptLog: (() => void) | null = null
let offScriptLogBatch: (() => void) | null = null
let offScriptComplete: (() => void) | null = null
let offScriptProgress: (() => void) | null = null

// Progress bar state — reset when a run starts, cleared when it ends
const progressValue = ref<number | null>(null)  // null = hidden; 0–100 = shown
const progressTotal = ref<number | null>(null)
const progressLabel = ref<string>('')
const progressPct = computed(() => {
  if (progressValue.value === null) return 0
  if (progressTotal.value != null && progressTotal.value > 0)
    return Math.min(100, Math.round(progressValue.value / progressTotal.value * 100))
  return Math.min(100, Math.round(progressValue.value))
})

function pushLog(level: ScriptLog['level'], ...args: string[]): void {
  logs.value.push({ level, args, ts: Date.now() })
  nextTick(() => {
    if (logList.value) logList.value.scrollTop = logList.value.scrollHeight
  })
}

function teardownListeners(): void {
  offScriptLog?.()
  offScriptLog = null
  offScriptLogBatch?.()
  offScriptLogBatch = null
  offScriptComplete?.()
  offScriptComplete = null
  offScriptProgress?.()
  offScriptProgress = null
}

async function runScript(): Promise<void> {
  if (!conn.dbPath) return

  if (autoClearOutput.value) {
    clearOutput()
  }

  const runId = crypto.randomUUID()
  currentRunId.value = runId
  running.value = true
  jobStore.setScriptRunning(true)
  lastResult.value = null
  outputTab.value = 'logs'
  progressValue.value = null
  progressTotal.value = null
  progressLabel.value = ''

  pushLog('log', '▶ Script started')

  // Logs arrive in batches (flushed every 50 ms) to reduce IPC round-trips.
  // Completion is still sent on the same ordered channel so it always arrives
  // after the final batch.
  offScriptLogBatch = window.api.onScriptLogBatch((batch) => {
    const relevant = batch.filter((e) => e.runId === runId)
    if (relevant.length === 0) {
      return
    }
    for (const e of relevant) {
      logs.value.push({ level: e.level, args: e.args, ts: e.ts })
    }
    nextTick(() => {
      if (logList.value) logList.value.scrollTop = logList.value.scrollHeight
    })
  })

  offScriptProgress = window.api.onScriptProgress((e) => {
    if (e.runId !== runId) return
    progressValue.value = e.value
    progressTotal.value = e.total ?? null
    progressLabel.value = e.label ?? ''
  })

  offScriptComplete = window.api.onScriptComplete((e) => {
    if (e.runId !== runId) return
    teardownListeners()
    lastResult.value = e
    running.value = false
    jobStore.setScriptRunning(false)
    currentRunId.value = null
    progressValue.value = null  // hide the bar on completion
    progressLabel.value = ''
    if (e.error) {
      pushLog('error', `✗ Script failed after ${e.durationMs}ms`)
    } else {
      pushLog('log', `✓ Script completed in ${e.durationMs}ms`)
    }
  })

  await window.api.runScript(activeScript.code, runId)
}

async function cancelScript(): Promise<void> {
  if (currentRunId.value) {
    await window.api.cancelScript(currentRunId.value)
    teardownListeners()
    running.value = false
    jobStore.setScriptRunning(false)
    currentRunId.value = null
    progressValue.value = null
    progressLabel.value = ''
    pushLog('warn', 'Script cancelled.')
  }
}

function clearOutput(): void {
  logs.value = []
  lastResult.value = null
}

const AUTOCLEAR_KEY = 'scriptsView:autoClearOutput'
const autoClearOutput = ref(localStorage.getItem(AUTOCLEAR_KEY) === 'true')
watch(autoClearOutput, (v) => localStorage.setItem(AUTOCLEAR_KEY, String(v)))

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── Help panel ────────────────────────────────────────────────────────────────
const showHelp = ref(false)

// ── Monaco editor ─────────────────────────────────────────────────────────────
const monacoContainer = ref<HTMLElement | null>(null)
const editorArea = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
const scriptViewStates = new Map<number | null, monaco.editor.ICodeEditorViewState>()

function initEditor(): void {
  if (!monacoContainer.value || editor) return
  editor = monaco.editor.create(monacoContainer.value, {
    ...EDITOR_BASE_OPTIONS,
    value: activeScript.code,
    language: 'javascript',
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    if (!running.value) runScript()
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveScript())

  editor.onDidChangeModelContent(() => {
    activeScript.code = editor!.getValue()
    activeScript.dirty = true
    flushToBuffer()
  })
}

// ── Output panel resize ────────────────────────────────────────────────────────
const outputHeight = ref(200)

function startDrag(e: MouseEvent): void {
  const startY = e.clientY
  const startH = outputHeight.value

  const onMove = (me: MouseEvent): void => {
    const delta = startY - me.clientY
    outputHeight.value = Math.max(80, Math.min(600, startH + delta))
  }

  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ── Keyboard shortcut ─────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (!running.value && activeScript.code.trim()) {
      e.preventDefault()
      runScript()
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
/**
 * If the user arrived via "Open in Script Editor" from the AI chat, consume
 * the pendingCode from history.state and open it as a new, distinctly-named
 * unsaved script.
 *
 * Key design choices:
 * - Uses history.replaceState to remove pendingCode immediately so that
 *   navigating away and back does not re-apply the same code.
 * - Does NOT call newScript() to avoid restoring previously-buffered unsaved
 *   content from the null-slot edit buffer.
 * - Sets a timestamped name so the script is clearly distinct from any
 *   "Untitled Script" the user may already have in progress.
 */
function applyPendingCode(): void {
  const state = history.state as Record<string, unknown>
  const pendingCode = state?.pendingCode
  if (typeof pendingCode !== 'string' || !pendingCode.trim()) {
    return
  }

  // Consume the state so re-activation does not re-apply the same code.
  history.replaceState({ ...state, pendingCode: undefined }, '')

  // Save whatever is currently displayed before switching away from it.
  flushToBuffer()

  // Open a fresh unsaved slot with a unique timestamped name.
  const ts = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
  activeScript.savedId = null
  activeScript.name = `AI Script — ${ts}`
  activeScript.language = 'javascript'
  activeScript.code = pendingCode
  activeScript.dirty = true
  showHelp.value = false
  applyToEditor(pendingCode)
}

/**
 * Loads all script drafts from the DB, populates editBuffer and scriptViewStates,
 * then makes the most-recently-updated draft the active script.
 * Called before initEditor() so the editor starts with the right code.
 *
 * Drafts whose content is identical to the already-saved script are silently
 * discarded (and removed from the DB) so they never cause a spurious dirty dot.
 */
async function restoreDrafts(): Promise<void> {
  const drafts = await window.api.listScriptDrafts()
  if (drafts.length === 0) {
    return
  }

  const dirtyDrafts: ScriptDraft[] = []
  for (const d of drafts) {
    if (d.savedId !== null) {
      const saved = scripts.value.find((x) => x.id === d.savedId)
      if (saved && saved.name === d.name && saved.code === d.code) {
        // Draft matches saved state — discard it.
        void window.api.deleteScriptDraft(d.draftKey)
        continue
      }
    }
    dirtyDrafts.push(d)
    editBuffer.set(d.savedId, { name: d.name, code: d.code })
    if (d.viewState) {
      try {
        scriptViewStates.set(d.savedId, JSON.parse(d.viewState) as monaco.editor.ICodeEditorViewState)
      } catch { /* ignore malformed state */ }
    }
  }

  if (dirtyDrafts.length === 0) {
    return
  }

  // Activate the most-recently-updated dirty draft (list is already ordered DESC by updated_at)
  const latest: ScriptDraft = dirtyDrafts[0]
  if (latest.savedId === null) {
    activeScript.savedId = null
    activeScript.name = latest.name
    activeScript.language = 'javascript'
    activeScript.code = latest.code
    activeScript.dirty = true
  } else {
    const s = scripts.value.find((x) => x.id === latest.savedId)
    if (s) {
      const buf = editBuffer.get(s.id)
      activeScript.savedId = s.id
      activeScript.name = buf?.name ?? s.name
      activeScript.language = s.language
      activeScript.code = buf?.code ?? s.code
      activeScript.dirty = true
    }
  }
}

onMounted(async () => {
  window.addEventListener('blur', onWindowBlur)

  unregisterQuitHandler = registerQuitHandler(() => saveDraftAll())

  if (!conn.dbConnected) return
  await loadScripts()
  await restoreDrafts()
  await nextTick()
  initEditor()
  // Restore view state for whatever script is now active
  const vs = scriptViewStates.get(activeScript.savedId) ?? null
  if (vs && editor) {
    editor.restoreViewState(vs)
  }
  applyPendingCode()
  // NOTE: window listener is managed by onActivated/onDeactivated (keep-alive).
})

// With <keep-alive>, onActivated/onDeactivated fire on every navigation in/out.
// Using them instead of onMounted/onBeforeUnmount ensures the global keydown
// listener is only active while this view is actually visible.
// applyPendingCode() is also called here so that subsequent "Open in Script
// Editor" clicks work correctly after the initial mount.
onActivated(() => {
  window.addEventListener('keydown', onKeydown)
  applyPendingCode()
  if (editor) {
    const vs = scriptViewStates.get(activeScript.savedId) ?? null
    editor.restoreViewState(vs)
  }
})

onDeactivated(() => {
  window.removeEventListener('keydown', onKeydown)
  if (editor) {
    const vs = editor.saveViewState()
    if (vs) {
      scriptViewStates.set(activeScript.savedId, vs)
    }
  }
})

onBeforeUnmount(() => {
  if (idleDraftTimer !== null) {
    clearTimeout(idleDraftTimer)
  }
  unregisterQuitHandler?.()
  window.removeEventListener('blur', onWindowBlur)
  editor?.dispose()
  editor = null
  teardownListeners()
  window.removeEventListener('keydown', onKeydown)  // safety cleanup
})

watch(() => conn.dbConnected, async (v) => {
  if (v) {
    await loadScripts()
    await restoreDrafts()
    await nextTick()
    if (!editor) {
      initEditor()
    } else {
      applyToEditor(activeScript.code)
    }
  }
})
</script>

<style scoped>
.scripts-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ── Sidebar ────────────────────────────────────────────────────────────────── */
.scripts-sidebar {
  width: 220px;
  min-width: 180px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--surface);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.sidebar-title {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.script-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.script-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  user-select: none;
}

.script-item:hover {
  background: var(--hover);
}

.script-item.active {
  background: var(--primary-light, #e8f0fe);
  color: var(--primary);
}

.script-lang-badge {
  font-size: 9px;
  font-weight: 700;
  background: var(--primary);
  color: white;
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}

.script-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-delete {
  opacity: 0;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;
  flex-shrink: 0;
}

.script-item:hover .script-delete {
  opacity: 1;
}

.script-delete:hover {
  color: var(--danger, #d32f2f);
}

.script-empty {
  padding: 12px 10px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.sidebar-footer {
  padding: 8px;
  border-top: 1px solid var(--border);
}

.full-width {
  width: 100%;
}

/* ── Main area ──────────────────────────────────────────────────────────────── */
.scripts-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── Toolbar ────────────────────────────────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

.script-name-input {
  flex: 1;
  max-width: 260px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 7px;
  font-size: 13px;
  background: var(--bg);
  color: var(--text);
}

.script-name-input:focus {
  outline: none;
  border-color: var(--primary);
}

.lang-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--border);
  padding: 2px 6px;
  border-radius: 4px;
}

.dirty-dot {
  color: var(--primary);
  font-size: 18px;
  line-height: 1;
}

.toolbar-sep {
  flex: 1;
}

.btn-danger {
  background: var(--danger, #d32f2f);
  color: white;
  border: none;
}

.btn-danger:hover {
  background: #b71c1c;
}

/* ── Toolbar progress bar (lives inside toolbar-sep) ────────────────────────── */
.toolbar-sep--active {
  display: flex;
  align-items: center;
  padding: 0 8px;
}

.toolbar-progress-track {
  position: relative;
  flex: 1;
  height: 18px;
  border-radius: 4px;
  background: var(--border);
  overflow: hidden;
}

.toolbar-progress-fill {
  position: absolute;
  inset: 0;
  width: 0;                     /* overridden by inline style */
  background: var(--primary);
  opacity: 0.55;
  border-radius: 4px;
  transition: width 0.15s ease;
}

.toolbar-progress-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  pointer-events: none;
}

/* ── Editor area ────────────────────────────────────────────────────────────── */
.editor-area {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.monaco-container {
  width: 100%;
  height: 100%;
}

/* ── Help panel ─────────────────────────────────────────────────────────────── */
.help-panel {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}

.help-panel h2 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
}

.help-panel h3 {
  margin: 20px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.help-panel p {
  margin: 0 0 8px;
  color: var(--text-muted);
}

.help-panel ul {
  margin: 0;
  padding-left: 20px;
}

.help-panel li {
  margin-bottom: 4px;
}

.api-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 8px;
  font-size: 12px;
}

.api-table td {
  padding: 6px 10px;
  border: 1px solid var(--border);
  vertical-align: top;
}

.api-table td:first-child {
  white-space: nowrap;
  font-family: monospace;
  background: var(--surface);
}

.code-example {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 14px;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
  margin: 0 0 8px;
}

/* ── Drag divider ───────────────────────────────────────────────────────────── */
.h-split-divider {
  height: 4px;
  cursor: ns-resize;
  background: var(--border);
  flex-shrink: 0;
}

.h-split-divider:hover {
  background: var(--primary);
}

/* ── Output panel ───────────────────────────────────────────────────────────── */
.output-panel {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
  overflow: hidden;
}

.output-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: 0 8px;
  flex-shrink: 0;
}

.output-tab {
  border: none;
  background: none;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.output-tab.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.log-count {
  background: var(--border);
  border-radius: 8px;
  padding: 0 5px;
  font-size: 10px;
  margin-left: 4px;
}

.output-body {
  flex: 1;
  overflow: hidden;
}

.log-list {
  height: 100%;
  overflow-y: auto;
  font-family: monospace;
  font-size: 12px;
  padding: 4px 0;
}

.log-entry {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 1px 10px;
  line-height: 1.6;
}

.log-entry.log-warn {
  color: var(--warning, #c07000);
}

.log-entry.log-error {
  color: var(--danger, #d32f2f);
}

.log-entry.log-running {
  color: var(--text-muted);
  font-style: italic;
}

.log-ts {
  color: var(--text-muted);
  flex-shrink: 0;
  font-size: 11px;
}

.log-level {
  font-weight: 700;
  font-size: 10px;
  flex-shrink: 0;
  opacity: 0.5;
}

.log-text {
  white-space: pre-wrap;
  word-break: break-all;
}

.output-empty {
  padding: 12px;
  color: var(--text-muted);
  font-size: 12px;
}

.result-body {
  padding: 10px 12px;
  font-size: 13px;
}

.result-error {
  color: var(--danger, #d32f2f);
}

.result-success {
  color: var(--text-muted);
}

/* ── Empty state ────────────────────────────────────────────────────────────── */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
}

/* ── Spinner (reuse existing animation from other views) ─────────────────────── */
.spinner {
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── AI toggle button ────────────────────────────────────────────────────────── */
.ai-toggle-btn {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #c4b5fd;
  border-color: #c4b5fd;
  background: transparent;
  box-shadow: 0 0 3px 0px rgba(167, 139, 250, 0.45), 0 0 7px 1px rgba(139, 92, 246, 0.2);
  transition: box-shadow 0.2s, background 0.2s, color 0.2s, border-color 0.2s;
}
.ai-toggle-btn:hover:not(.active) {
  color: #ddd6fe;
  border-color: #ddd6fe;
  box-shadow: 0 0 5px 1px rgba(167, 139, 250, 0.65), 0 0 11px 2px rgba(139, 92, 246, 0.3);
}
.ai-toggle-btn.active {
  background: #5b21b6;
  color: #ede9fe;
  border-color: #5b21b6;
  box-shadow: 0 0 4px 1px rgba(91, 33, 182, 0.5), 0 0 9px 2px rgba(91, 33, 182, 0.25);
}

/* ── AI drawer ───────────────────────────────────────────────────────────────── */
.ai-drawer {
  width: 0;
  min-width: 0;
  flex-shrink: 0;
  background: var(--surface);
  border-left: 0 solid var(--border);
  box-shadow: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              border-left-width 0.25s step-end,
              box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.ai-drawer.open {
  width: 400px;
  border-left-width: 1px;
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.08);
}
.ai-drawer.is-resizing { transition: none; }
.ai-resize-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 10; background: transparent; }
.ai-resize-handle::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px; border-radius: 99px; background: var(--border); transition: background 0.15s, height 0.15s; }
.ai-resize-handle:hover::after, .ai-resize-handle:active::after { background: var(--primary); height: 64px; }
.ai-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--surface);
}
.ai-drawer-title { font-size: 13px; font-weight: 600; color: var(--text); }
.ai-drawer-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}
.ai-drawer-close:hover { background: var(--surface2); color: var(--text); }
</style>
