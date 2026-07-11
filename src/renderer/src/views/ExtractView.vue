<template>
  <div class="split-view" v-if="conn.bothConnected" ref="splitContainer">
    <!-- Left: Job list -->
    <div class="split-left" :style="{ flexBasis: splitPct + '%' }">
      <div class="toolbar">
        <button class="btn btn-primary btn-sm" @click="newJob">+ New Job</button>
        <input v-model="search" type="text" placeholder="Search jobs…" style="flex:1; font-size:12px;" />
      </div>

      <div v-if="!filteredJobs.length" class="empty-state" style="padding: 32px 16px;">
        <div class="empty-state-icon">⬇️</div>
        <div>No extraction jobs yet</div>
        <button class="btn btn-primary btn-sm" @click="newJob">Create First Job</button>
      </div>

      <div
        v-for="job in filteredJobs"
        :key="job.id"
        class="job-row"
        :class="{ selected: selectedJobId === job.id, running: activeRuns.has(job.id) }"
        @click="selectJob(job.id)"
      >
        <div class="job-row-name">
          <span class="spinner job-row-spinner" v-if="activeRuns.has(job.id)"></span>
          {{ job.name }}
        </div>
        <div class="job-row-meta">
          <span class="job-row-sub">{{ job.soqlQuery ? '(SOQL)' : job.sfObject }} → {{ job.destTable }} · {{ job.writeMode }}</span>
          <span class="job-row-right">
            <span v-if="activeRuns.has(job.id)" class="job-row-running-label">running</span>
            <span v-else-if="jobQueue.includes(job.id)" class="job-row-running-label" style="color:var(--text-muted);">queued</span>
            <template v-else-if="lastRun(job.id)">
              <span class="badge" :class="runStatusBadge(lastRun(job.id)!.status)">{{ lastRun(job.id)!.status }}</span>
              <span v-if="lastRun(job.id)!.rowsLoaded != null" class="job-row-rows">{{ lastRun(job.id)!.rowsLoaded!.toLocaleString() }}</span>
            </template>
            <button
              class="job-run-btn"
              :disabled="activeRuns.has(job.id) || jobQueue.includes(job.id)"
              :title="activeRuns.has(job.id) ? 'Running…' : jobQueue.includes(job.id) ? 'Queued…' : 'Run job'"
              @click.stop="executeJobById(job.id)"
            >
              <span v-if="activeRuns.has(job.id)" class="spinner" style="width:10px;height:10px;border-width:1.5px;"></span>
              <span v-else>▶</span>
            </button>
          </span>
        </div>
      </div>
    </div>

    <!-- Draggable divider -->
    <div class="split-divider" @mousedown.prevent="startDrag"></div>

    <!-- Right: editor or history -->
    <div class="split-right" style="padding: 0;">
      <!-- Nothing selected -->
      <div v-if="!selectedJobId && !editing" class="empty-state" style="height:100%;">
        <div class="empty-state-icon">⬇️</div>
        <div>Select a job or create a new one</div>
      </div>

      <!-- Job editor -->
      <div v-else-if="editing" class="job-editor">
        <div class="toolbar">
          <span style="font-weight:600;">{{ editForm.id ? 'Edit Job' : 'New Job' }}</span>
          <div class="toolbar-right">
            <button class="btn btn-secondary btn-sm" @click="cancelEdit">Cancel</button>
            <button class="btn btn-secondary btn-sm" :disabled="saving" @click="save(false)">
              <span v-if="saving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              Save
            </button>
            <button class="btn btn-primary btn-sm" :disabled="saving" @click="save(true)">
              Save &amp; Execute
            </button>
          </div>
        </div>
        <div class="editor-body">
          <div class="form-group">
            <label>Job Name</label>
            <input v-model="editForm.name" type="text" placeholder="e.g. Active Accounts EU" />
          </div>

          <!-- Mode toggle -->
          <div class="form-group">
            <label>Mode</label>
            <div class="mode-toggle">
              <label class="mode-option" :class="{ active: editForm.mode === 'structured' }">
                <input type="radio" v-model="editForm.mode" value="structured" />
                Structured
              </label>
              <label class="mode-option" :class="{ active: editForm.mode === 'soql' }">
                <input type="radio" v-model="editForm.mode" value="soql" />
                Raw SOQL
              </label>
            </div>
          </div>

          <!-- Structured mode fields -->
          <template v-if="editForm.mode === 'structured'">
            <div class="form-group">
              <label>Salesforce Object</label>
              <ObjectPicker v-model="editForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="onObjectChange" @refresh="refreshObjects" />
            </div>
            <div v-if="loadingFields" style="display:flex; align-items:center; gap:8px; color: var(--text-muted);">
              <span class="spinner"></span> Loading fields…
            </div>
            <template v-else-if="editForm.sfObject && fields.length">
              <div class="field-accordion">
                <button type="button" class="field-accordion-header" @click="fieldPickerOpen = !fieldPickerOpen">
                  <span class="field-accordion-title">Fields</span>
                  <span class="field-accordion-summary">{{ fieldPickerLabel }}</span>
                  <span class="index-accordion-chevron" :class="{ open: fieldPickerOpen }">▾</span>
                </button>
                <div v-if="fieldPickerOpen" class="field-accordion-body">
                  <SObjectFieldList :fields="fields" v-model="editForm.fields" v-model:customExpressions="editForm.customExpressions" />
                </div>
              </div>
              <div class="form-group">
                <label>WHERE Clause (optional)</label>
                <textarea v-model="editForm.whereClause" placeholder="e.g. CreatedDate = TODAY" rows="2" class="where-textarea" />
              </div>
              <div class="form-row">
                <div class="form-group" style="flex: 0 0 140px;">
                  <label>LIMIT (optional)</label>
                  <input v-model.number="editForm.rowLimit" type="number" placeholder="e.g. 10000" />
                </div>
              </div>
            </template>
          </template>

          <!-- Raw SOQL mode -->
          <template v-else>
            <div class="form-group">
              <label>SOQL Query</label>
              <textarea
                v-model="editForm.soqlQuery"
                placeholder="SELECT Id, Name FROM Account WHERE IsActive__c = true"
                rows="6"
                class="soql-textarea"
                spellcheck="false"
              />
              <div class="field-hint">Write the full SOQL query. Column names in the destination table are derived from the field names returned by the first batch of data.</div>
            </div>
          </template>

          <!-- Additional indexes accordion — unified for both modes -->
          <div class="index-accordion" v-if="editForm.mode === 'soql' || (editForm.sfObject && fields.length)">
            <button type="button" class="index-accordion-header" @click="indexPickerOpen = !indexPickerOpen">
              <span class="index-accordion-title">
                Additional Indexes
                <span v-if="editForm.additionalIndexes.length" class="index-count-badge">{{ editForm.additionalIndexes.length }}</span>
              </span>
              <span class="index-accordion-hint">
                {{ editForm.mode === 'structured' ? 'Id and unique/ExternalId fields are indexed automatically' : 'optional' }}
              </span>
              <span class="index-accordion-chevron" :class="{ open: indexPickerOpen }">▾</span>
            </button>
            <div v-if="indexPickerOpen" class="index-accordion-body">
              <div class="index-tags" v-if="editForm.additionalIndexes.length">
                <span v-for="col in editForm.additionalIndexes" :key="col" class="index-tag">
                  {{ col }}<button class="index-tag-remove" @click="removeIndex(col)" title="Remove">✕</button>
                </span>
              </div>
              <div class="index-input-wrap">
                <input
                  v-model="additionalIndexInput"
                  type="text"
                  :placeholder="editForm.mode === 'structured' ? 'Filter columns…' : 'Type column name and press Enter…'"
                  class="index-input"
                  @keydown.enter.prevent="addIndexFromInput"
                  @keydown.escape="additionalIndexInput = ''"
                />
                <ul v-if="editForm.mode === 'structured'" class="index-suggestions index-suggestions-static">
                  <li v-for="name in indexSuggestions" :key="name" @click="addIndex(name)">{{ name }}</li>
                  <li v-if="!indexSuggestions.length" class="index-suggestions-empty">{{ additionalIndexInput ? 'No matching columns' : 'All columns already added' }}</li>
                </ul>
              </div>
              <div class="field-hint" v-if="editForm.mode !== 'structured'">
                Press Enter to add each column name. These columns will be indexed after the job runs.
              </div>
            </div>
          </div>

          <!-- Common destination fields -->
          <div class="form-row" v-if="editForm.mode === 'soql' || (editForm.sfObject && fields.length)">
            <div class="form-group">
              <label>Destination Table</label>
              <input v-model="editForm.destTable" type="text" :placeholder="editForm.mode === 'soql' ? 'sf_results' : editForm.sfObject" />
            </div>
            <div class="form-group" style="flex: 0 0 160px;">
              <label>Write Mode</label>
              <select v-model="editForm.writeMode">
                <option value="replace">Replace</option>
                <option value="append">Append</option>
              </select>
            </div>
          </div>

          <div v-if="saveError" class="alert alert-error">{{ saveError }}</div>
        </div>
      </div>

      <!-- Job selected: tabs -->
      <div v-else-if="selectedJobId" class="job-detail">
        <div class="toolbar">
          <span style="font-weight:600;">{{ selectedJob?.name }}</span>
          <template v-if="detailTab === 'definition'">
            <button v-if="!thisJobIsRunning && !thisJobIsQueued" class="btn btn-primary btn-sm" :disabled="saving" @click="save(true)">
              <span v-if="saving" class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></span>
              Save &amp; Execute
            </button>
            <button v-else class="btn btn-danger btn-sm" @click="cancelRun">■ Cancel</button>
          </template>
          <template v-else>
            <button v-if="!thisJobIsRunning && !thisJobIsQueued" class="btn btn-primary btn-sm" @click="executeJob">▶ Execute</button>
            <button v-else class="btn btn-danger btn-sm" @click="cancelRun">■ Cancel</button>
          </template>
          <div class="toolbar-right">
            <button class="btn btn-ghost btn-sm" @click="duplicateSelectedJob">Duplicate</button>
            <button class="btn btn-danger btn-sm" @click="deleteSelectedJob">Delete</button>
          </div>
        </div>

        <!-- Tab bar -->
        <div class="tab-bar">
          <button class="tab-btn" :class="{ active: detailTab === 'definition' }" @click="detailTab = 'definition'">Definition</button>
          <button class="tab-btn" :class="{ active: detailTab === 'execution' }" @click="detailTab = 'execution'">
            Execution
            <span v-if="thisJobIsRunning" class="spinner" style="width:8px;height:8px;border-width:1.5px;margin-left:4px;display:inline-block;vertical-align:middle;"></span>
            <span v-else-if="thisJobIsQueued" style="margin-left:4px;font-size:10px;opacity:0.6;">queued</span>
          </button>
          <button class="tab-btn" :class="{ active: detailTab === 'history' }" @click="detailTab = 'history'">History</button>
        </div>

        <!-- Definition tab: inline editable form -->
        <div v-if="detailTab === 'definition'" class="tab-panel definition-panel">
          <!-- Form actions -->
          <div class="form-actions">
            <button class="btn btn-ghost btn-sm" @click="resetForm">Reset</button>
            <button class="btn btn-secondary btn-sm" :disabled="saving || thisJobIsRunning" :title="thisJobIsRunning ? 'Cannot save while this job is running' : ''" @click="save(false)">
              <span v-if="saving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              Save
            </button>
            <button class="btn btn-secondary btn-sm" style="margin-left:auto;" @click="clearDestTable">
              Clear table <strong>{{ selectedJob?.destTable }}</strong>
            </button>
            <span v-if="clearMsg" class="qs-msg" :class="clearMsgError ? 'qs-msg-error' : 'qs-msg-ok'">{{ clearMsg }}</span>
          </div>
          <div v-if="saveError" class="alert alert-error" style="margin-bottom:8px;">{{ saveError }}</div>

          <div class="form-group">
            <label>Job Name</label>
            <input v-model="editForm.name" type="text" placeholder="e.g. Active Accounts EU" />
          </div>

          <!-- Mode toggle -->
          <div class="form-group">
            <label>Mode</label>
            <div class="mode-toggle">
              <label class="mode-option" :class="{ active: editForm.mode === 'structured' }">
                <input type="radio" v-model="editForm.mode" value="structured" />
                Structured
              </label>
              <label class="mode-option" :class="{ active: editForm.mode === 'soql' }">
                <input type="radio" v-model="editForm.mode" value="soql" />
                Raw SOQL
              </label>
            </div>
          </div>

          <!-- Structured mode -->
          <template v-if="editForm.mode === 'structured'">
            <div class="form-group">
              <label>Salesforce Object</label>
              <ObjectPicker v-model="editForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="onObjectChange" @refresh="refreshObjects" />
            </div>
            <div v-if="loadingFields" style="display:flex; align-items:center; gap:8px; color: var(--text-muted);">
              <span class="spinner"></span> Loading fields…
            </div>
            <template v-else-if="editForm.sfObject && fields.length">
              <div class="field-accordion">
                <button type="button" class="field-accordion-header" @click="fieldPickerOpen = !fieldPickerOpen">
                  <span class="field-accordion-title">Fields</span>
                  <span class="field-accordion-summary">{{ fieldPickerLabel }}</span>
                  <span class="index-accordion-chevron" :class="{ open: fieldPickerOpen }">▾</span>
                </button>
                <div v-if="fieldPickerOpen" class="field-accordion-body">
                  <SObjectFieldList :fields="fields" v-model="editForm.fields" v-model:customExpressions="editForm.customExpressions" />
                </div>
              </div>
              <div class="form-group">
                <label>WHERE Clause (optional)</label>
                <textarea v-model="editForm.whereClause" placeholder="e.g. CreatedDate = TODAY" rows="2" class="where-textarea" />
              </div>
              <div class="form-row">
                <div class="form-group" style="flex: 0 0 140px;">
                  <label>LIMIT (optional)</label>
                  <input v-model.number="editForm.rowLimit" type="number" placeholder="e.g. 10000" />
                </div>
              </div>
            </template>
          </template>

          <!-- Raw SOQL mode -->
          <template v-else>
            <div class="form-group">
              <label>SOQL Query</label>
              <textarea
                v-model="editForm.soqlQuery"
                placeholder="SELECT Id, Name FROM Account WHERE IsActive__c = true"
                rows="6"
                class="soql-textarea"
                spellcheck="false"
              />
              <div class="field-hint">Column names in the destination table are derived from the field names returned by the first batch of data.</div>
            </div>
          </template>

          <!-- Additional indexes accordion — unified for both modes -->
          <div class="index-accordion" v-if="editForm.mode === 'soql' || (editForm.sfObject && fields.length)">
            <button type="button" class="index-accordion-header" @click="indexPickerOpen = !indexPickerOpen">
              <span class="index-accordion-title">
                Additional Indexes
                <span v-if="editForm.additionalIndexes.length" class="index-count-badge">{{ editForm.additionalIndexes.length }}</span>
              </span>
              <span class="index-accordion-hint">
                {{ editForm.mode === 'structured' ? 'Id and unique/ExternalId fields are indexed automatically' : 'optional' }}
              </span>
              <span class="index-accordion-chevron" :class="{ open: indexPickerOpen }">▾</span>
            </button>
            <div v-if="indexPickerOpen" class="index-accordion-body">
              <div class="index-tags" v-if="editForm.additionalIndexes.length">
                <span v-for="col in editForm.additionalIndexes" :key="col" class="index-tag">
                  {{ col }}<button class="index-tag-remove" @click="removeIndex(col)" title="Remove">✕</button>
                </span>
              </div>
              <div class="index-input-wrap">
                <input
                  v-model="additionalIndexInput"
                  type="text"
                  :placeholder="editForm.mode === 'structured' ? 'Filter columns…' : 'Type column name and press Enter…'"
                  class="index-input"
                  @keydown.enter.prevent="addIndexFromInput"
                  @keydown.escape="additionalIndexInput = ''"
                />
                <ul v-if="editForm.mode === 'structured'" class="index-suggestions index-suggestions-static">
                  <li v-for="name in indexSuggestions" :key="name" @click="addIndex(name)">{{ name }}</li>
                  <li v-if="!indexSuggestions.length" class="index-suggestions-empty">{{ additionalIndexInput ? 'No matching columns' : 'All columns already added' }}</li>
                </ul>
              </div>
              <div class="field-hint" v-if="editForm.mode !== 'structured'">
                Press Enter to add each column name. These columns will be indexed after the job runs.
              </div>
            </div>
          </div>

          <!-- Common: destination + write mode -->
          <div class="form-row" v-if="editForm.mode === 'soql' || (editForm.sfObject && fields.length)">
            <div class="form-group">
              <label>Destination Table</label>
              <input v-model="editForm.destTable" type="text" :placeholder="editForm.mode === 'soql' ? 'sf_results' : editForm.sfObject" />
            </div>
            <div class="form-group" style="flex: 0 0 160px;">
              <label>Write Mode</label>
              <select v-model="editForm.writeMode">
                <option value="replace">Replace</option>
                <option value="append">Append</option>
              </select>
            </div>
          </div>
        </div>

        <!-- History tab -->
        <div v-else-if="detailTab === 'history'" class="tab-panel history-panel">
          <div v-if="!history.length" class="empty-state" style="padding:32px 16px;">No runs yet</div>
          <table v-else class="data-table history-table">
            <thead><tr><th>Started</th><th>Status</th><th style="text-align:right;">Rows</th><th style="text-align:right;">Duration</th><th style="text-align:right;">Rows/s</th><th></th></tr></thead>
            <tbody>
              <tr v-for="h in history" :key="h.id">
                <td style="white-space:nowrap;">{{ formatDate(h.startedAt) }}</td>
                <td><span class="badge" :class="runStatusBadge(h.status)">{{ h.status }}</span></td>
                <td style="text-align:right; font-variant-numeric: tabular-nums;">{{ h.rowsLoaded?.toLocaleString() ?? '—' }}</td>
                <td style="text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap;">{{ formatDuration(h.durationMs) }}</td>
                <td style="text-align:right; font-variant-numeric: tabular-nums;">{{ h.durationMs && h.rowsLoaded ? Math.round(h.rowsLoaded / (h.durationMs / 1000)).toLocaleString() : '—' }}</td>
                <td>
                  <span
                    v-if="h.errorMsg"
                    class="error-cell"
                    @click.stop="toggleErrorPopover(h.id, h.errorMsg!, $event)"
                  >{{ h.errorMsg.slice(0, 20) }}{{ h.errorMsg.length > 20 ? '…' : '' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Execution tab -->
        <div v-else-if="detailTab === 'execution'" class="tab-panel execution-panel">
          <!-- Queued placeholder -->
          <div v-if="thisJobIsQueued" class="empty-state" style="padding: 40px 16px; gap: 12px;">
            <div style="font-size:28px;">⏳</div>
            <div style="font-weight:600;">Job is queued</div>
            <div style="color:var(--text-muted); font-size:13px; text-align:center;">
              {{ activeRuns.size }} of {{ MAX_PARALLEL }} slots in use.
              This job will start automatically when a slot becomes free.<br>
              Position in queue: {{ jobQueue.indexOf(selectedJobId!) + 1 }}
            </div>
            <button class="btn btn-secondary btn-sm" @click="cancelRun">Remove from queue</button>
          </div>
          <ProgressPanel
            v-else-if="displayedJobData"
            type="extract"
            :fetched="displayedJobData.fetched"
            :total="displayedJobData.total"
            :rps="displayedJobData.rps"
            :status="displayedJobData.status"
            :errorMsg="displayedJobData.errorMsg"
            :startTime="selectedRunStartTime"
          />
          <div v-else class="empty-state" style="padding:32px 16px;">
            <div>No execution yet</div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">Press ▶ Execute to start a run, or check the History tab for past runs.</div>
          </div>
        </div>

        <!-- Error popover (outside tabs so it isn't clipped) -->
        <div v-if="errorPopover" class="error-popover" :style="{ top: errorPopover.y + 'px', left: errorPopover.x + 'px' }" @click.stop>
          <div class="error-popover-header">
            <span>Error</span>
            <button class="btn-icon" @click="errorPopover = null">✕</button>
          </div>
          <div class="error-popover-body">{{ errorPopover.msg }}</div>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="empty-state" style="height:100%;">
    <div class="empty-state-icon">🔌</div>
    <div>Connect to both Salesforce and a SQLite database first</div>
    <router-link to="/connections" class="btn btn-primary btn-sm">Go to Connections</router-link>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onUnmounted, toRaw, nextTick } from 'vue'
import { useConnectionStore } from '../stores/connection'
import { useJobStore } from '../stores/job'
import ObjectPicker from '../components/ObjectPicker.vue'
import SObjectFieldList from '../components/SObjectFieldList.vue'
import ProgressPanel from '../components/ProgressPanel.vue'
import type { ExtractJob, FieldDescriptor, RunHistoryEntry } from '../../../shared/types'

const conn = useConnectionStore()
const sfRefreshing = ref(false)
async function refreshObjects(): Promise<void> {
  sfRefreshing.value = true
  try { await conn.refreshSFObjects() } finally { sfRefreshing.value = false }
}
const jobs = useJobStore()

const search = ref('')

// ── Resizable split ───────────────────────────────────────────────────────────
const SPLIT_KEY = 'extract-split-pct'
const splitPct = ref<number>(Number(localStorage.getItem(SPLIT_KEY)) || 50)
const splitContainer = ref<HTMLElement | null>(null)

function startDrag(e: MouseEvent): void {
  const container = splitContainer.value
  if (!container) return

  const onMove = (ev: MouseEvent): void => {
    const rect = container.getBoundingClientRect()
    const pct = ((ev.clientX - rect.left) / rect.width) * 100
    splitPct.value = Math.min(80, Math.max(20, pct))
  }

  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(SPLIT_KEY, String(Math.round(splitPct.value * 10) / 10))
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
const allJobs = ref<ExtractJob[]>([])
const historyMap = ref<Map<number, RunHistoryEntry[]>>(new Map())
const selectedJobId = ref<number | null>(null)
const detailTab = ref<'definition' | 'history' | 'execution'>('definition')
const editing = ref(false)
const saving = ref(false)
const saveError = ref('')
const loadingFields = ref(false)
const fields = ref<FieldDescriptor[]>([])
const MAX_PARALLEL = 5
const activeRuns = ref<Map<number, string>>(new Map())   // jobId → runId (cleared on finish)
const jobQueue = ref<number[]>([])                        // jobIds waiting for a slot
const lastRunIds = ref<Map<number, string>>(new Map())    // jobId → runId (kept after finish)
const runStartTimes = ref<Map<number, number>>(new Map()) // jobId → startTime (kept after finish)

interface EditForm {
  id?: number
  name: string
  mode: 'structured' | 'soql'
  sfObject: string
  fields: string[]
  customExpressions: string[]
  whereClause: string
  rowLimit: number | null
  destTable: string
  writeMode: 'replace' | 'append'
  soqlQuery: string
  additionalIndexes: string[]
}

const editForm = ref<EditForm>({
  name: '', mode: 'structured', sfObject: '', fields: [], customExpressions: [], whereClause: '', rowLimit: null, destTable: '', writeMode: 'replace', soqlQuery: '', additionalIndexes: []
})

// ── Fields accordion ─────────────────────────────────────────────────────────
const fieldPickerOpen = ref(false)

const fieldPickerLabel = computed(() => {
  const total = fields.value.length
  const sel = editForm.value.fields.length
  const custom = editForm.value.customExpressions.length
  const customSuffix = custom ? ` + ${custom} custom` : ''
  if (!total) return 'Fields'
  if (sel === total && !custom) return `All ${total} fields selected`
  if (sel === 0 && !custom) return `0 of ${total} fields selected`
  return `${sel}${customSuffix} of ${total} selected`
})

// ── Additional indexes picker ────────────────────────────────────────────────
const additionalIndexInput = ref('')
const indexPickerOpen = ref(false)

const indexSuggestions = computed((): string[] => {
  const q = additionalIndexInput.value.toLowerCase()
  const already = editForm.value.additionalIndexes
  const fromFields = fields.value
    .map((f) => f.name)
    .filter((name) => !already.includes(name) && (!q || name.toLowerCase().includes(q)))
  const fromCustom = editForm.value.customExpressions
    .filter((e) => !already.includes(e) && (!q || e.toLowerCase().includes(q)))
  return [...fromFields, ...fromCustom]
})

function addIndex(col: string): void {
  const name = col.trim()
  if (name && !editForm.value.additionalIndexes.includes(name)) {
    editForm.value.additionalIndexes.push(name)
  }
  additionalIndexInput.value = ''
}

function addIndexFromInput(): void {
  const q = additionalIndexInput.value.trim()
  if (!q) return
  if (editForm.value.mode === 'structured') {
    const exact = indexSuggestions.value.find((name) => name.toLowerCase() === q.toLowerCase())
    if (exact) { addIndex(exact); return }
    if (indexSuggestions.value.length === 1) { addIndex(indexSuggestions.value[0]); return }
  }
  addIndex(q)
}

function removeIndex(col: string): void {
  const i = editForm.value.additionalIndexes.indexOf(col)
  if (i !== -1) editForm.value.additionalIndexes.splice(i, 1)
}

function applyPendingSoql(): void {
  const soql = (window.history.state as Record<string, unknown>)?.pendingSoql
  if (typeof soql === 'string' && soql.trim()) {
    // Clear the state so a subsequent navigation here doesn't re-trigger this
    window.history.replaceState({ ...window.history.state, pendingSoql: undefined }, '')
    selectedJobId.value = null
    editing.value = true
    fields.value = []
    editForm.value = {
      name: '',
      mode: 'soql',
      sfObject: '',
      fields: [],
      customExpressions: [],
      whereClause: '',
      rowLimit: null,
      destTable: '',
      writeMode: 'replace',
      soqlQuery: soql,
      additionalIndexes: []
    }
  }
}

onMounted(async () => {
  if (conn.bothConnected) {
    await loadJobs()
    await conn.loadSFObjects()
  }
})

onActivated(async () => {
  await nextTick()
  applyPendingSoql()
})

watch(() => conn.bothConnected, async (v) => {
  if (v) { await loadJobs(); await conn.loadSFObjects() }
})

const filteredJobs = computed(() => {
  const q = search.value.toLowerCase()
  return allJobs.value
    .filter((j) => !q || j.name.toLowerCase().includes(q) || j.sfObject.toLowerCase().includes(q) || (j.soqlQuery ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const selectedJob = computed(() => allJobs.value.find((j) => j.id === selectedJobId.value))

const history = computed(() => historyMap.value.get(selectedJobId.value ?? -1) ?? [])

const selectedRunId = computed(() => selectedJobId.value != null ? activeRuns.value.get(selectedJobId.value) : undefined)
const activeJobData = computed(() => selectedRunId.value ? jobs.getJob(selectedRunId.value) : undefined)
const thisJobIsRunning = computed(() => selectedJobId.value != null && activeRuns.value.has(selectedJobId.value))
const thisJobIsQueued = computed(() => selectedJobId.value != null && jobQueue.value.includes(selectedJobId.value))
// Last run data — persists after the job finishes so the Execution tab stays populated
const lastRunId = computed(() => selectedJobId.value != null ? lastRunIds.value.get(selectedJobId.value) : undefined)
const lastJobData = computed(() => lastRunId.value ? jobs.getJob(lastRunId.value) : undefined)
const displayedJobData = computed(() => activeJobData.value ?? lastJobData.value)
const selectedRunStartTime = computed(() => selectedJobId.value != null ? (runStartTimes.value.get(selectedJobId.value) ?? 0) : 0)

function lastRun(jobId: number): RunHistoryEntry | undefined {
  return (historyMap.value.get(jobId) ?? [])[0]
}

async function loadJobs(): Promise<void> {
  allJobs.value = await window.api.listExtractJobs()
  for (const j of allJobs.value) {
    historyMap.value.set(j.id, await window.api.getRunHistory(j.id))
  }
}

async function selectJob(id: number): Promise<void> {
  selectedJobId.value = id
  editing.value = false
  detailTab.value = 'definition'
  clearMsg.value = ''
  saveError.value = ''
  historyMap.value.set(id, await window.api.getRunHistory(id))
  const j = allJobs.value.find((j) => j.id === id)
  if (j) syncEditForm(j)
}

function syncEditForm(j: ExtractJob): void {
  editForm.value = {
    id: j.id,
    name: j.name,
    mode: j.soqlQuery ? 'soql' : 'structured',
    sfObject: j.sfObject,
    fields: [...j.fields],
    customExpressions: [...(j.customExpressions ?? [])],
    whereClause: j.whereClause ?? '',
    rowLimit: j.rowLimit,
    destTable: j.destTable,
    writeMode: j.writeMode,
    soqlQuery: j.soqlQuery ?? '',
    additionalIndexes: [...(j.additionalIndexes ?? [])]
  }
  if (!j.soqlQuery && j.sfObject) onObjectChange(j.sfObject, false)
}

function resetForm(): void {
  const j = selectedJob.value
  if (j) { syncEditForm(j); saveError.value = '' }
}

const clearMsg = ref('')
const clearMsgError = ref(false)

async function clearDestTable(): Promise<void> {
  const j = selectedJob.value
  if (!j) return
  if (!confirm(`Delete all rows from "${j.destTable}"?`)) return
  clearMsg.value = ''
  try {
    await window.api.executeQuery(`DELETE FROM "${j.destTable}"`)
    clearMsg.value = 'Table cleared.'
    clearMsgError.value = false
    conn.refreshDbInfo()
  } catch (e) {
    clearMsg.value = e instanceof Error ? e.message : String(e)
    clearMsgError.value = true
  }
}

function newJob(): void {
  selectedJobId.value = null
  editing.value = true
  fields.value = []
  editForm.value = { name: '', mode: 'structured', sfObject: '', fields: [], customExpressions: [], whereClause: '', rowLimit: null, destTable: '', writeMode: 'replace', soqlQuery: '', additionalIndexes: [] }
}

function cancelEdit(): void {
  editing.value = false
  selectedJobId.value = allJobs.value[0]?.id ?? null
  if (selectedJobId.value) {
    const j = allJobs.value.find((x) => x.id === selectedJobId.value)
    if (j) syncEditForm(j)
  }
}

async function onObjectChange(name: string, resetFields = true): Promise<void> {
  if (!name) return
  loadingFields.value = true
  try {
    fields.value = await window.api.describeObject(name)
    if (resetFields) {
      editForm.value.fields = fields.value.filter((f) => !f.name.includes('.')).map((f) => f.name)
      editForm.value.customExpressions = []
      editForm.value.destTable = name
    }
  } finally {
    loadingFields.value = false
  }
}

async function save(andExecute: boolean): Promise<void> {
  saveError.value = ''
  if (!editForm.value.name.trim()) {
    saveError.value = 'Please enter a job name.'
    return
  }
  const candidateName = editForm.value.name.trim()
  const duplicate = allJobs.value.find(
    (j) => j.name.toLowerCase() === candidateName.toLowerCase() && j.id !== editForm.value.id
  )
  if (duplicate) {
    saveError.value = `A job named "${duplicate.name}" already exists.`
    return
  }
  saving.value = true
  try {
    const isSoql = editForm.value.mode === 'soql'
    if (isSoql && !editForm.value.soqlQuery.trim()) {
      saveError.value = 'Please enter a SOQL query.'
      saving.value = false
      return
    }
    const jobName = editForm.value.name.trim()
    // For structured jobs: remove any additional index that no longer corresponds to a
    // selected field or custom expression (field was deselected or expression removed).
    const validColumns = isSoql
      ? null  // raw SOQL — no known column set, keep all
      : new Set([...editForm.value.fields, ...editForm.value.customExpressions])
    const cleanedIndexes = toRaw(editForm.value.additionalIndexes)
      .filter((col) => validColumns === null || validColumns.has(col))
    const job = await window.api.saveExtractJob({
      name: jobName,
      sfObject: isSoql ? '' : editForm.value.sfObject,
      fields: isSoql ? [] : toRaw(editForm.value.fields).slice(),
      customExpressions: isSoql ? [] : toRaw(editForm.value.customExpressions).slice(),
      whereClause: isSoql ? null : (editForm.value.whereClause || null),
      rowLimit: isSoql ? null : (editForm.value.rowLimit != null && editForm.value.rowLimit !== ('' as unknown as null)
        ? Number(editForm.value.rowLimit)
        : null),
      destTable: editForm.value.destTable || (isSoql ? 'sf_results' : editForm.value.sfObject),
      writeMode: editForm.value.writeMode,
      soqlQuery: isSoql ? editForm.value.soqlQuery.trim() : null,
      additionalIndexes: cleanedIndexes,
      ...(editForm.value.id ? { id: editForm.value.id } : {})
    } as Parameters<typeof window.api.saveExtractJob>[0])
    await loadJobs()
    selectedJobId.value = job.id
    editing.value = false
    // Re-sync the form with the canonical saved version
    const saved = allJobs.value.find((j) => j.id === job.id)
    if (saved) syncEditForm(saved)
    if (andExecute) await executeJobById(job.id)
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function executeJob(): Promise<void> {
  if (!selectedJobId.value) return
  await executeJobById(selectedJobId.value)
}

async function executeJobById(id: number): Promise<void> {
  // Skip if already running or queued
  if (activeRuns.value.has(id) || jobQueue.value.includes(id)) return

  if (activeRuns.value.size >= MAX_PARALLEL) {
    jobQueue.value = [...jobQueue.value, id]
    if (selectedJobId.value === id) detailTab.value = 'execution'
    return
  }

  await _startJobNow(id)
}

async function _startJobNow(id: number): Promise<void> {
  if (selectedJobId.value === id) detailTab.value = 'execution'
  runStartTimes.value.set(id, Date.now())
  const runId = await window.api.startExtract(id)
  activeRuns.value.set(id, runId)
  lastRunIds.value.set(id, runId)
  jobs.startJob(runId, 'extract', id)

  const off = window.api.onJobComplete((e) => {
    if (e.runId !== runId) return
    off()
    activeRuns.value.delete(id)
    // Keep runStartTimes and lastRunIds so the Execution tab stays populated after the job ends
    loadJobs()
    conn.refreshDbInfo()

    // Dequeue next waiting job if any
    if (jobQueue.value.length > 0) {
      const nextId = jobQueue.value[0]
      jobQueue.value = jobQueue.value.slice(1)
      _startJobNow(nextId)
    }
  })
}

async function cancelRun(): Promise<void> {
  if (!selectedJobId.value) return
  const id = selectedJobId.value

  // If queued, just dequeue without touching the backend
  const qIdx = jobQueue.value.indexOf(id)
  if (qIdx !== -1) {
    jobQueue.value = jobQueue.value.filter((jid) => jid !== id)
    return
  }

  const runId = activeRuns.value.get(id)
  if (runId) {
    await window.api.cancelJob(runId)
    jobs.removeJob(runId)   // immediately clear the Pinia store so nav indicator stops
  }
  activeRuns.value.delete(id)
  // Also clear last-run display so the cancelled state doesn't linger
  lastRunIds.value.delete(id)
  runStartTimes.value.delete(id)
}

async function duplicateSelectedJob(): Promise<void> {
  if (!selectedJobId.value) return
  await window.api.duplicateExtractJob(selectedJobId.value)
  await loadJobs()
}

async function deleteSelectedJob(): Promise<void> {
  if (!selectedJobId.value) return
  if (!confirm('Delete this job?')) return
  await window.api.deleteExtractJob(selectedJobId.value)
  selectedJobId.value = null
  await loadJobs()
}

function formatDate(d: string): string {
  return new Date(d).toLocaleString()
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

function runStatusBadge(s: string): string {
  if (s === 'success') return 'badge-green'
  if (s === 'error') return 'badge-red'
  if (s === 'running') return 'badge-blue'
  return 'badge-gray'
}

const errorPopover = ref<{ id: number; msg: string; x: number; y: number } | null>(null)

function toggleErrorPopover(id: number, msg: string, e: MouseEvent): void {
  if (errorPopover.value?.id === id) { errorPopover.value = null; return }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const viewRect = (e.currentTarget as HTMLElement).closest('.job-detail')!.getBoundingClientRect()
  errorPopover.value = {
    id,
    msg,
    x: Math.min(rect.left - viewRect.left, viewRect.width - 340),
    y: rect.bottom - viewRect.top + 4
  }
}

watch(selectedJobId, () => { errorPopover.value = null })

function onDocClick(): void { errorPopover.value = null }
function onDocKeydown(e: KeyboardEvent): void { if (e.key === 'Escape') errorPopover.value = null }

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
  offExternalQueued()
  offExternalStarted()
})

// Sync script-triggered extract jobs into the local queue/running maps so the
// UI shows the correct running/queued badges and executeJobById's guard fires.
const offExternalQueued = window.api.onExternalJobQueued((e) => {
  if (e.type !== 'extract') return
  if (!jobQueue.value.includes(e.jobId)) {
    jobQueue.value = [...jobQueue.value, e.jobId]
  }
})

const offExternalStarted = window.api.onExternalJobStarted((e) => {
  if (e.type !== 'extract') return
  jobQueue.value = jobQueue.value.filter((id) => id !== e.jobId)
  if (!activeRuns.value.has(e.jobId)) {
    activeRuns.value.set(e.jobId, e.runId)
    const off = window.api.onJobComplete((result) => {
      if (result.runId !== e.runId) return
      off()
      activeRuns.value.delete(e.jobId)
      loadJobs()
      conn.refreshDbInfo()
    })
  }
})
</script>

<style scoped>
/* Resizable split */
.split-left { flex-shrink: 0; flex-grow: 0; min-width: 0; overflow-y: auto; }
.split-right { flex: 1; overflow: hidden; min-width: 0; }
.split-divider {
  width: 5px;
  flex-shrink: 0;
  cursor: col-resize;
  position: relative;
  z-index: 1;
  background: transparent;
}
.split-divider::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 48px;
  border-radius: 99px;
  background: var(--border);
  transition: background 0.15s, height 0.15s;
}
.split-divider:hover::after, .split-divider:active::after {
  background: var(--primary);
  height: 64px;
}

.job-editor, .job-detail { height: 100%; display: flex; flex-direction: column; position: relative; }
.editor-body { padding: 16px; overflow-y: auto; flex: 1; }

/* Single-line job rows */
.job-row {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 5px 12px;
  cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, #0176d3 25%, var(--border));
  gap: 1px;
}
.job-row { border-left: 3px solid #0176d3; }
.job-row:hover { background: var(--surface2); }
.job-row.selected { background: color-mix(in srgb, #0176d3 10%, transparent); }
.job-row.running { background: color-mix(in srgb, #0176d3 5%, transparent); }
.job-row.running.selected { background: color-mix(in srgb, #0176d3 15%, transparent); }
.job-row-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px; }
.job-row-spinner { width: 10px; height: 10px; border-width: 1.5px; flex-shrink: 0; }
.job-row-running-label { font-size: 10px; font-weight: 600; color: var(--primary); text-transform: uppercase; letter-spacing: 0.04em; }
.job-row-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.job-row-sub { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.job-row-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.job-row-rows { font-size: 11px; color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.job-run-btn { width: 22px; height: 22px; padding: 0; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid color-mix(in srgb, #0176d3 40%, var(--border)); border-radius: var(--radius-sm); cursor: pointer; font-size: 11px; color: #0176d3; flex-shrink: 0; }
.job-run-btn:hover:not(:disabled) { background: color-mix(in srgb, #0176d3 12%, transparent); }
.job-run-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Tab bar */
.tab-bar { display: flex; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.tab-btn {
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); }

/* Tab panels */
.tab-panel { flex: 1; overflow-y: auto; min-height: 0; }
.definition-panel { padding: 12px; }
.history-panel { }
.execution-panel { display: flex; flex-direction: column; }

/* Definition tab form actions */
.form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.where-textarea { resize: vertical; min-height: 44px; line-height: 1.4; font-family: monospace; width: 100%; box-sizing: border-box; }
.qs-msg { font-size: 11px; padding: 2px 0; }
.qs-msg-ok { color: var(--success, #16a34a); }
.qs-msg-error { color: var(--danger); }

/* Mode toggle */
.mode-toggle { display: flex; gap: 6px; }
.mode-option {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  user-select: none;
  transition: background 0.12s, border-color 0.12s;
}
.mode-option input[type="radio"] { display: none; }
.mode-option.active { background: color-mix(in srgb, #0176d3 12%, transparent); border-color: #0176d3; color: #0176d3; font-weight: 600; }
.mode-option:not(.active):hover { background: var(--surface2); }

/* SOQL textarea in editor */
.soql-textarea { resize: vertical; min-height: 120px; line-height: 1.5; font-family: monospace; font-size: 12px; width: 100%; box-sizing: border-box; }
.field-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.label-hint { font-weight: 400; font-size: 11px; color: var(--text-muted); }

/* ── Fields accordion ──────────────────────────────────────────────────── */
.field-accordion { border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 2px; }
.field-accordion-header {
  display: flex; align-items: center; gap: 6px; width: 100%;
  background: var(--surface2); border: none; border-radius: var(--radius-sm);
  padding: 6px 10px; cursor: pointer; text-align: left;
  font-size: 13px; font-weight: 500; color: var(--text-muted);
  transition: background 0.1s;
}
.field-accordion-header:hover { background: var(--border); }
.field-accordion-title { font-weight: 500; color: var(--text-muted); white-space: nowrap; }
.field-accordion-summary { flex: 1; font-size: 12px; color: var(--primary); font-weight: 500; padding-left: 8px; }
.field-accordion-body { padding: 6px 4px 8px; }

/* ── Additional indexes accordion ──────────────────────────────────────── */
.index-accordion { border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 2px; }
.index-accordion-header {
  display: flex; align-items: center; gap: 6px; width: 100%;
  background: var(--surface2); border: none; border-radius: var(--radius-sm);
  padding: 6px 10px; cursor: pointer; text-align: left;
  font-size: 13px; font-weight: 500; color: var(--text-muted);
  transition: background 0.1s;
}
.index-accordion-header:hover { background: var(--border); }
.index-accordion-title { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-weight: 500; }
.index-count-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 5px;
  background: var(--primary); color: var(--primary-text);
  border-radius: 999px; font-size: 11px; font-weight: 700; line-height: 1;
}
.index-accordion-hint { flex: 1; font-size: 11px; color: var(--text-muted); font-weight: 400; padding-left: 4px; }
.index-accordion-chevron { font-size: 14px; color: var(--text-muted); transition: transform 0.2s; }
.index-accordion-chevron.open { transform: rotate(180deg); }
.index-accordion-body { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }
.index-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.index-tag {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--primary); color: var(--primary-text);
  padding: 2px 6px 2px 8px; border-radius: 999px; font-size: 12px; font-family: monospace;
}
.index-tag-remove {
  background: none; border: none; color: inherit; cursor: pointer;
  padding: 0; line-height: 1; font-size: 11px; opacity: 0.75;
}
.index-tag-remove:hover { opacity: 1; }
.index-input-wrap { position: relative; }
.index-input { width: 100%; box-sizing: border-box; font-size: 12px; }
.index-suggestions {
  position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 50;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; margin: 0; padding: 4px 0; list-style: none;
  max-height: 200px; overflow-y: auto; box-shadow: var(--shadow, 0 4px 12px rgba(0,0,0,.12));
  color: var(--text);
}
.index-suggestions.index-suggestions-static {
  position: static; box-shadow: none; margin-top: 4px; border-radius: var(--radius-sm);
}
.index-suggestions li {
  padding: 5px 12px; font-size: 12px; font-family: monospace; cursor: pointer; color: var(--text);
}
.index-suggestions li:hover { background: var(--surface2); }
.index-suggestions-empty { color: var(--text-muted) !important; cursor: default !important; font-style: italic; }
.index-suggestions-empty:hover { background: transparent !important; }

/* SOQL preview in quick-settings */
.qs-soql-preview { margin-top: 8px; }
.qs-soql-code {
  font-family: monospace;
  font-size: 11px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  margin: 3px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 80px;
  overflow-y: auto;
  color: var(--text);
  line-height: 1.5;
}

/* History table */
.history-table { font-size: 12px; width: 100%; }
.history-table th, .history-table td { padding: 4px 12px; }
.error-cell { color: var(--danger); cursor: pointer; font-size: 13px; line-height: 1; opacity: 0.8; }
.error-cell:hover { opacity: 1; }

/* Error popover */
.error-popover {
  position: absolute;
  z-index: 100;
  width: 320px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 16px rgba(0,0,0,0.18);
  font-size: 12px;
}
.error-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: 11px;
  color: var(--danger);
}
.btn-icon { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-muted); padding: 0 2px; line-height: 1; }
.btn-icon:hover { color: var(--text); }
.error-popover-body { padding: 10px; white-space: pre-wrap; word-break: break-word; color: var(--text); line-height: 1.5; max-height: 200px; overflow-y: auto; }
</style>
