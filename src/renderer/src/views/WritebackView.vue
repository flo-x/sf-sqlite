<template>
  <div class="split-view" v-if="conn.bothConnected" ref="splitContainer">
    <!-- Left: Job list -->
    <div class="split-left" :style="{ flexBasis: splitPct + '%' }">
      <div class="toolbar">
        <button class="btn btn-primary btn-sm" @click="newJob">+ New Job</button>
        <input v-model="search" type="text" placeholder="Search jobs…" style="flex:1; font-size:12px;" />
      </div>

      <div v-if="!filteredJobs.length" class="empty-state" style="padding: 32px 16px;">
        <div class="empty-state-icon">⬆️</div>
        <div>No write-back jobs yet</div>
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
          <span class="job-row-sub">
            <span class="badge" :class="opBadge(job.operation)" style="font-size:9px; padding: 1px 4px;">{{ job.operation }}</span>
            → {{ job.sfObject }}
          </span>
          <span class="job-row-right">
            <span v-if="activeRuns.has(job.id)" class="job-row-running-label">running</span>
            <span v-else-if="jobQueue.includes(job.id)" class="job-row-running-label" style="color:var(--text-muted);">queued</span>
            <template v-else-if="lastRun(job.id)">
              <span class="badge" :class="runStatusBadge(lastRun(job.id)!.status)">{{ lastRun(job.id)!.status }}</span>
              <span v-if="lastRun(job.id)!.rowsSent != null" class="job-row-rows">{{ lastRun(job.id)!.rowsSent!.toLocaleString() }}</span>
            </template>
            <button
              class="job-run-btn"
              :disabled="activeRuns.has(job.id) || jobQueue.includes(job.id)"
              :title="activeRuns.has(job.id) ? 'Running…' : jobQueue.includes(job.id) ? 'Queued…' : 'Run job'"
              @click.stop="selectJob(job.id); executeJobById(job.id)"
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

    <!-- Right panel -->
    <div class="split-right" style="padding: 0;">

      <!-- Empty state: nothing selected, not creating -->
      <div v-if="!selectedJobId && !editing" class="empty-state" style="height:100%;">
        <div class="empty-state-icon">⬆️</div>
        <div>Select a job or create a new one</div>
      </div>

      <!-- New Job form (no tabs — job doesn't exist yet) -->
      <div v-else-if="editing" class="job-editor">
        <div class="toolbar">
          <span style="font-weight:600;">New Job</span>
          <div class="toolbar-right">
            <button class="btn btn-secondary btn-sm" @click="cancelEdit">Cancel</button>
            <button class="btn btn-secondary btn-sm" :disabled="saving" @click="save(false)">
              <span v-if="saving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              Save
            </button>
            <button class="btn btn-primary btn-sm" :disabled="saving" @click="save(true)">Save &amp; Execute</button>
          </div>
        </div>
        <div class="editor-body">
          <div class="form-group">
            <label>Job Name</label>
            <input v-model="editForm.name" type="text" placeholder="e.g. Sync EU Accounts" />
          </div>
          <div class="form-group">
            <label>SQL Query (source data)</label>
            <textarea v-model="editForm.sqlQuery" rows="5" style="font-family:monospace; font-size:12px;" placeholder="SELECT Id, Name, Industry FROM Account WHERE BillingCountry = 'FR'" />
            <button class="btn btn-secondary btn-sm" style="margin-top:6px;" :disabled="previewLoading" @click="runPreview">
              <span v-if="previewLoading" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              Preview (first 50 rows)
            </button>
          </div>
          <div v-if="previewResult" class="form-group">
            <div style="height: 180px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden;">
              <DataGrid :columns="previewResult.columns" :rows="previewResult.rows" />
            </div>
          </div>
          <div v-if="previewError" class="alert alert-error">{{ previewError }}</div>
          <div class="form-group">
            <label>Target Salesforce Object</label>
            <ObjectPicker v-model="editForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="onObjectChange" @refresh="refreshObjects" />
          </div>
          <div class="form-group">
            <label>Operation</label>
            <div class="op-selector">
              <label v-for="op in operations" :key="op" class="radio-label">
                <input type="radio" :value="op" v-model="editForm.operation" /> {{ op }}
              </label>
            </div>
          </div>
          <template v-if="sfFields.length">
            <div class="form-group">
              <FieldMapper v-model="editForm.fieldMap" :sfFields="sfFields" :showKey="['update','upsert'].includes(editForm.operation)" />
            </div>
            <div v-if="editForm.operation === 'upsert'" class="form-group">
              <label>External ID Field (SF)</label>
              <input v-model="editForm.externalIdField" type="text" placeholder="External_Id__c" />
            </div>
          </template>
          <div v-else-if="editForm.sfObject" style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
            Loading field list…
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Batch Size</label>
              <input v-model.number="editForm.batchSize" type="number" placeholder="200" />
            </div>
            <div class="form-group">
              <label>Threads (1–10)</label>
              <input v-model.number="editForm.threads" type="number" min="1" max="10" placeholder="1" />
            </div>
          </div>
          <div v-if="!editForm.useBulkApi && distribKeyCols.length" class="form-group">
            <label>
              Distribution Key
              <span style="font-weight:400; color:var(--text-muted); font-size:11px;">
                <template v-if="(editForm.threads ?? 1) > 1">(rows with same key always go to the same thread — use this to ensure rows referencing the same parent record are always processed by one single thread)</template>
                <template v-else>(set Threads &gt; 1 to enable)</template>
              </span>
            </label>
            <div class="distrib-key-input" :class="{ 'distrib-key-list--disabled': (editForm.threads ?? 1) <= 1 }">
              <span v-for="col in (editForm.distributionKey ?? [])" :key="col" class="distrib-key-tag">
                {{ col }}
                <button class="distrib-key-tag-remove" @mousedown.prevent="toggleDistribKey(col)">×</button>
              </span>
              <input
                v-model="distribKeySearch"
                type="text"
                class="distrib-key-search"
                placeholder="Add column…"
                @focus="distribKeyDropdownOpen = true"
                @blur="hideDistribDropdownDelayed"
                @keydown.escape="distribKeyDropdownOpen = false"
              />
              <div v-if="distribKeyDropdownOpen && distribKeyOptions.length" class="distrib-key-dropdown">
                <div
                  v-for="col in distribKeyOptions"
                  :key="col"
                  class="distrib-key-option"
                  @mousedown.prevent="selectDistribKey(col)"
                >{{ col }}</div>
              </div>
            </div>
            <p v-if="(editForm.threads ?? 1) > 1 && editForm.distributionKey?.length" class="distrib-key-hint">
              Tip: consider adding <code>ORDER BY</code> to the query, so that rows with the same distribution key are <strong>not</strong> clustered together. For example, order by a record ID. Do not order by the distribution key itself — that is exactly what we want to avoid.
            </p>
          </div>
          <div class="form-group checkboxes-group">
            <label class="checkbox-label"><input type="checkbox" v-model="editForm.useBulkApi" /> Use Bulk API 2.0 (for very large datasets)</label>
          </div>
          <div class="form-group">
            <label>Custom Headers <span style="font-weight:400; color:var(--text-muted); font-size:11px;">(JSON — ↓ for presets)</span></label>
            <div class="suggest-wrap">
              <textarea
                v-model="editForm.customHeaders"
                rows="3"
                style="font-family:monospace; font-size:12px; width:100%;"
                placeholder='{"DuplicateRuleHeader": {"allowSave": true}}'
                @keydown="onHeadersKeydown"
                @blur="hideSuggestionsDelayed"
              ></textarea>
              <div v-if="showHeaderSuggestions" class="suggest-list">
                <div
                  v-for="(s, i) in headerSuggestions"
                  :key="i"
                  class="suggest-item"
                  :class="{ active: activeSuggestion === i }"
                  @mousedown.prevent="selectHeaderSuggestion(i)"
                >
                  <span class="suggest-name">{{ s.label }}</span>
                  <span class="suggest-preview">{{ s.preview }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-if="saveError" class="alert alert-error">{{ saveError }}</div>
        </div>
      </div>

      <!-- Job selected: tabbed view -->
      <div v-else-if="selectedJobId" class="job-detail">
        <!-- Toolbar -->
        <div class="toolbar">
          <span style="font-weight:600; margin-right:4px;">{{ selectedJob?.name }}</span>
          <template v-if="activeTab === 'definition'">
            <button v-if="!thisJobIsRunning && !thisJobIsQueued" class="btn btn-primary btn-sm" :disabled="saving" @click="save(true)">
              <span v-if="saving" class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></span>
              Save &amp; Execute
            </button>
            <button v-else class="btn btn-danger btn-sm" @click="cancelRun">■ Cancel</button>
          </template>
          <template v-else>
            <button v-if="!thisJobIsRunning && !thisJobIsQueued" class="btn btn-primary btn-sm" :disabled="saving" @click="executeJob">▶ Execute</button>
            <button v-else class="btn btn-danger btn-sm" @click="cancelRun">■ Cancel</button>
          </template>
          <div class="toolbar-right">
            <button class="btn btn-ghost btn-sm" @click="duplicateSelectedJob">Duplicate</button>
            <button class="btn btn-danger btn-sm" @click="deleteSelectedJob">Delete</button>
          </div>
        </div>

        <!-- Tab bar -->
        <div class="tab-bar">
          <button class="tab-btn" :class="{ active: activeTab === 'definition' }" @click="activeTab = 'definition'">Definition</button>
          <button class="tab-btn" :class="{ active: activeTab === 'execution' }" @click="activeTab = 'execution'">
            Execution
            <span v-if="thisJobIsRunning" class="spinner" style="width:8px;height:8px;border-width:1.5px;margin-left:4px;display:inline-block;vertical-align:middle;"></span>
            <span v-else-if="thisJobIsQueued" style="margin-left:4px;font-size:10px;opacity:0.6;">queued</span>
          </button>
          <button class="tab-btn" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">History</button>
        </div>

        <!-- Definition tab -->
        <div v-if="activeTab === 'definition'" class="tab-panel editor-body">
          <!-- Inline save/reset bar at the top of the tab -->
          <div class="form-actions">
            <button class="btn btn-ghost btn-sm" @click="resetDefinitionForm">Reset</button>
            <button class="btn btn-secondary btn-sm" :disabled="saving || thisJobIsRunning" :title="thisJobIsRunning ? 'Cannot save while this job is running' : ''" @click="save(false)">
              <span v-if="saving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              Save
            </button>
          </div>
          <div v-if="saveError" class="alert alert-error" style="margin-bottom:8px;">{{ saveError }}</div>

          <div class="form-group">
            <label>Job Name</label>
            <input v-model="editForm.name" type="text" placeholder="e.g. Sync EU Accounts" />
          </div>
          <div class="form-group">
            <label>SQL Query (source data)</label>
            <textarea v-model="editForm.sqlQuery" rows="5" style="font-family:monospace; font-size:12px;" placeholder="SELECT Id, Name, Industry FROM Account WHERE BillingCountry = 'FR'" />
            <button class="btn btn-secondary btn-sm" style="margin-top:6px;" :disabled="previewLoading" @click="runPreview">
              <span v-if="previewLoading" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
              Preview (first 50 rows)
            </button>
          </div>
          <div v-if="previewResult" class="form-group">
            <div style="height: 180px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden;">
              <DataGrid :columns="previewResult.columns" :rows="previewResult.rows" />
            </div>
          </div>
          <div v-if="previewError" class="alert alert-error">{{ previewError }}</div>
          <div class="form-group">
            <label>Target Salesforce Object</label>
            <ObjectPicker v-model="editForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="onObjectChange" @refresh="refreshObjects" />
          </div>
          <div class="form-group">
            <label>Operation</label>
            <div class="op-selector">
              <label v-for="op in operations" :key="op" class="radio-label">
                <input type="radio" :value="op" v-model="editForm.operation" /> {{ op }}
              </label>
            </div>
          </div>
          <template v-if="sfFields.length">
            <div class="form-group">
              <FieldMapper v-model="editForm.fieldMap" :sfFields="sfFields" :showKey="['update','upsert'].includes(editForm.operation)" />
            </div>
            <div v-if="editForm.operation === 'upsert'" class="form-group">
              <label>External ID Field (SF)</label>
              <input v-model="editForm.externalIdField" type="text" placeholder="External_Id__c" />
            </div>
          </template>
          <div v-else-if="editForm.sfObject" style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
            Loading field list…
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Batch Size</label>
              <input v-model.number="editForm.batchSize" type="number" placeholder="200" />
            </div>
            <div class="form-group">
              <label>Threads (1–10)</label>
              <input v-model.number="editForm.threads" type="number" min="1" max="10" placeholder="1" />
            </div>
          </div>
          <div v-if="!editForm.useBulkApi && distribKeyCols.length" class="form-group">
            <label>
              Distribution Key
              <span style="font-weight:400; color:var(--text-muted); font-size:11px;">
                <template v-if="(editForm.threads ?? 1) > 1">(rows with same key always go to the same thread — use this to ensure rows referencing the same parent record are always processed by one single thread)</template>
                <template v-else>(set Threads &gt; 1 to enable)</template>
              </span>
            </label>
            <div class="distrib-key-input" :class="{ 'distrib-key-list--disabled': (editForm.threads ?? 1) <= 1 }">
              <span v-for="col in (editForm.distributionKey ?? [])" :key="col" class="distrib-key-tag">
                {{ col }}
                <button class="distrib-key-tag-remove" @mousedown.prevent="toggleDistribKey(col)">×</button>
              </span>
              <input
                v-model="distribKeySearch"
                type="text"
                class="distrib-key-search"
                placeholder="Add column…"
                @focus="distribKeyDropdownOpen = true"
                @blur="hideDistribDropdownDelayed"
                @keydown.escape="distribKeyDropdownOpen = false"
              />
              <div v-if="distribKeyDropdownOpen && distribKeyOptions.length" class="distrib-key-dropdown">
                <div
                  v-for="col in distribKeyOptions"
                  :key="col"
                  class="distrib-key-option"
                  @mousedown.prevent="selectDistribKey(col)"
                >{{ col }}</div>
              </div>
            </div>
            <p v-if="(editForm.threads ?? 1) > 1 && editForm.distributionKey?.length" class="distrib-key-hint">
              Tip: consider adding <code>ORDER BY</code> to the query, so that rows with the same distribution key are <strong>not</strong> clustered together. For example, order by a record ID. Do not order by the distribution key itself — that is exactly what we want to avoid.
            </p>
          </div>
          <div class="form-group checkboxes-group">
            <label class="checkbox-label"><input type="checkbox" v-model="editForm.useBulkApi" /> Use Bulk API 2.0 (for very large datasets)</label>
          </div>
          <div class="form-group">
            <label>Custom Headers <span style="font-weight:400; color:var(--text-muted); font-size:11px;">(JSON — ↓ for presets)</span></label>
            <div class="suggest-wrap">
              <textarea
                v-model="editForm.customHeaders"
                rows="3"
                style="font-family:monospace; font-size:12px; width:100%;"
                placeholder='{"DuplicateRuleHeader": {"allowSave": true}}'
                @keydown="onHeadersKeydown"
                @blur="hideSuggestionsDelayed"
              ></textarea>
              <div v-if="showHeaderSuggestions" class="suggest-list">
                <div
                  v-for="(s, i) in headerSuggestions"
                  :key="i"
                  class="suggest-item"
                  :class="{ active: activeSuggestion === i }"
                  @mousedown.prevent="selectHeaderSuggestion(i)"
                >
                  <span class="suggest-name">{{ s.label }}</span>
                  <span class="suggest-preview">{{ s.preview }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- History tab -->
        <div v-else-if="activeTab === 'history'" class="tab-panel history-section">
          <div v-if="!history.length" class="empty-state" style="padding: 32px 16px;">No runs yet</div>
          <table v-else class="data-table">
            <thead><tr><th>Started</th><th>Status</th><th>API</th><th>Sent</th><th>✓ OK</th><th>✗ Failed</th><th style="text-align:right;">Duration</th><th style="text-align:right;">Rows/s</th></tr></thead>
            <tbody>
              <tr v-for="h in history" :key="h.id">
                <td>{{ formatDate(h.startedAt) }}</td>
                <td><span class="badge" :class="runStatusBadge(h.status)">{{ h.status }}</span></td>
                <td><span class="badge" :class="h.useBulkApi ? 'badge-bulk' : 'badge-rest'">{{ h.useBulkApi ? 'Bulk 2.0' : 'REST' }}</span></td>
                <td>{{ h.rowsSent?.toLocaleString() ?? '—' }}</td>
                <td>{{ h.rowsSucceeded?.toLocaleString() ?? '—' }}</td>
                <td style="color:var(--danger)">{{ h.rowsFailed ? h.rowsFailed.toLocaleString() : '—' }}</td>
                <td style="text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap;">{{ formatDuration(h.durationMs) }}</td>
                <td style="text-align:right; font-variant-numeric: tabular-nums;">{{ h.durationMs && h.rowsSent ? Math.round(h.rowsSent / (h.durationMs / 1000)).toLocaleString() : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Execution tab -->
        <div v-else-if="activeTab === 'execution'" class="tab-panel execution-section">

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

          <!-- Error / warning banners — shown for both REST and Bulk API modes -->
          <div v-else-if="execError" class="exec-banner exec-banner-error">
            <span style="font-weight:600;">Job failed</span>
            <span style="white-space:pre-wrap;">{{ execError }}</span>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto; flex-shrink:0;" @click="clearExecState">Dismiss</button>
          </div>
          <div v-else-if="execWarn" class="exec-banner exec-banner-warn">
            <span style="white-space:pre-wrap;">{{ execWarn }}</span>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto; flex-shrink:0;" @click="execWarn = null">Dismiss</button>
          </div>

          <!-- ── Bulk API 2.0 view ─────────────────────────────────────────── -->
          <template v-if="!thisJobIsQueued && execIsBulkApi">
            <div v-if="!thisJobIsRunning && !execJobDone && !execError" class="empty-state" style="padding: 32px 16px;">
              No execution data yet — click ▶ Execute to run this job.
            </div>

            <!-- Running: phase card -->
            <div v-else-if="thisJobIsRunning" class="bulk-phase-card">
              <div class="bulk-phase-row">
                <span class="spinner" style="width:14px;height:14px;border-width:2px; flex-shrink:0;"></span>
                <template v-if="execBulkPhase === 'uploading'">
                  Uploading to Salesforce…
                  <strong>{{ execBulkUploaded.toLocaleString() }}</strong>
                  <template v-if="execSourceRowCount !== null"> / {{ execSourceRowCount.toLocaleString() }}</template>
                  rows sent
                </template>
                <template v-else-if="execBulkPhase === 'processing'">
                  Salesforce processing
                  <span class="badge badge-gray" style="font-size:11px;">{{ execBulkJobState }}</span>
                  —
                  <strong>{{ execBulkProcessed.toLocaleString() }}</strong> processed,
                  <span style="color:var(--danger);">{{ execFailed.toLocaleString() }}</span> failed
                </template>
                <template v-else-if="execBulkPhase === 'downloading'">
                  Downloading results from Salesforce…
                </template>
                <template v-else>
                  Starting Bulk API 2.0 job…
                </template>
              </div>
              <button class="btn btn-danger btn-sm" style="margin-top:12px;" @click="cancelRun">Cancel</button>
            </div>

            <!-- Done: summary + optional failed rows grid -->
            <template v-else-if="execJobDone">
              <div class="exec-stats">
                <span v-if="execSourceRowCount !== null" style="color: var(--text-muted);">{{ execSourceRowCount.toLocaleString() }} total</span>
                <span><strong>{{ totalRows.toLocaleString() }}</strong> rows</span>
                <span style="color: var(--success);">✓ {{ succeededCount.toLocaleString() }} succeeded</span>
                <span style="color: var(--danger);">✗ {{ failedCount.toLocaleString() }} failed</span>
                <button class="btn btn-ghost btn-sm" style="margin-left: auto;" @click="clearExecState" title="Clear all execution data from memory">Clear</button>
              </div>
              <div v-if="failedCount > 0 && execFailedRows.length > 0" style="flex:1; overflow:hidden; display:flex; flex-direction:column;">
                <div class="failed-rows-header">
                  <span style="font-size:12px; color:var(--text-muted);">Failed records (echoed from Salesforce)</span>
                  <div v-if="distinctErrors.length > 1" class="error-filter-bar">
                    <label class="error-filter-label">Filter by error:</label>
                    <select v-model="failedErrorFilter" class="error-filter-select">
                      <option value="">All errors ({{ execFailedRows.length.toLocaleString() }})</option>
                      <option v-for="err in distinctErrors" :key="err" :value="err">
                        {{ err.length > 80 ? err.slice(0, 80) + '…' : err }} ({{ errorCounts.get(err) ?? 0 }})
                      </option>
                    </select>
                  </div>
                </div>
                <div v-if="filteredFailedRows.length > EXEC_PAGE" class="exec-pager">
                  <button class="btn btn-ghost btn-sm"
                    :disabled="execFailedPageOffset === 0"
                    @click="execFailedPageOffset = Math.max(0, execFailedPageOffset - EXEC_PAGE)">‹ Prev</button>
                  <span style="font-size:12px;">
                    {{ execFailedPageOffset + 1 }}–{{ Math.min(execFailedPageOffset + EXEC_PAGE, filteredFailedRows.length) }} / {{ filteredFailedRows.length.toLocaleString() }}
                  </span>
                  <button class="btn btn-ghost btn-sm"
                    :disabled="execFailedPageOffset + EXEC_PAGE >= filteredFailedRows.length"
                    @click="execFailedPageOffset = execFailedPageOffset + EXEC_PAGE">Next ›</button>
                </div>
                <div style="flex:1; overflow:hidden;">
                  <DataGrid
                    :columns="['_Error', ...execColumns]"
                    :rows="filteredFailedRows.slice(execFailedPageOffset, execFailedPageOffset + EXEC_PAGE).map((fr) => [fr.message, ...fr.row])"
                    :showRowNumbers="true"
                    :onExportCsv="exportFailed"
                    exportCsvLabel="Export Failed CSV"
                  />
                </div>
              </div>
            </template>
          </template>

          <!-- ── REST Collections API view (existing) ─────────────────────── -->
          <template v-else-if="!thisJobIsQueued">
            <div v-if="!thisJobIsRunning && !execPageRows.length && !execFailedRows.length && !execError" class="empty-state" style="padding: 32px 16px;">
              No execution data yet — click ▶ Execute to run this job.
            </div>
            <template v-else>
              <div class="exec-stats">
                <span v-if="execSourceRowCount !== null" style="color: var(--text-muted);">{{ execSourceRowCount.toLocaleString() }} total</span>
                <span><strong>{{ totalRows.toLocaleString() }}</strong> rows</span>
                <span style="color: var(--success);">✓ {{ succeededCount.toLocaleString() }}</span>
                <span style="color: var(--danger);">✗ {{ failedCount.toLocaleString() }}</span>
                <span style="color: var(--text-muted);">{{ activeJobData?.rps ?? 0 }} rec/s</span>
                <span v-if="thisJobIsRunning" style="color: var(--accent); font-size:12px;" title="Records submitted to Salesforce and awaiting a response">
                  ⟳ {{ execInFlight.toLocaleString() }} in flight
                </span>
                <label v-if="execJobDone && failedCount > 0" style="margin-left: auto; display:flex; align-items:center; gap:6px; font-weight:400;">
                  <input type="checkbox" v-model="showOnlyFailed" @change="execPageOffset = 0; execFailedPageOffset = 0" /> Show only failed
                </label>
                <button v-if="failedCount > 0 && !thisJobIsRunning" class="btn btn-secondary btn-sm" @click="retryFailed">Retry Failed</button>
                <button
                  v-if="execJobDone && isInsert && !execIsBulkApi && succeededCount > 0 && execRunId && !thisJobIsRunning"
                  class="btn btn-primary btn-sm"
                  @click="openUpdateIdsModal"
                  title="Write the Salesforce IDs of created records back to a SQLite table"
                >Update table with created record IDs</button>
                <button v-if="!thisJobIsRunning" class="btn btn-ghost btn-sm" style="margin-left: auto;" @click="clearExecState" title="Clear all execution data from memory">Clear</button>
              </div>
              <!-- Error filter (only when showing failed rows only) -->
              <div v-if="showOnlyFailed && execJobDone && distinctErrors.length > 1" class="failed-rows-header" style="padding: 4px 12px;">
                <div class="error-filter-bar">
                  <label class="error-filter-label">Filter by error:</label>
                  <select v-model="failedErrorFilter" class="error-filter-select">
                    <option value="">All errors ({{ execFailedRows.length.toLocaleString() }})</option>
                    <option v-for="err in distinctErrors" :key="err" :value="err">
                      {{ err.length > 80 ? err.slice(0, 80) + '…' : err }} ({{ errorCounts.get(err) ?? 0 }})
                    </option>
                  </select>
                </div>
              </div>
              <!-- Page navigation -->
              <div class="exec-pager" v-if="showOnlyFailed ? filteredFailedRows.length > EXEC_PAGE : execTotalRows > EXEC_PAGE">
                <button class="btn btn-ghost btn-sm"
                  :disabled="(showOnlyFailed ? execFailedPageOffset : execPageOffset) === 0"
                  @click="loadExecPage(Math.max(0, (showOnlyFailed ? execFailedPageOffset : execPageOffset) - EXEC_PAGE))">
                  ‹ Prev
                </button>
                <span style="font-size:12px;">
                  {{ (showOnlyFailed ? execFailedPageOffset : execPageOffset) + 1 }}–{{
                    showOnlyFailed
                      ? Math.min(execFailedPageOffset + EXEC_PAGE, filteredFailedRows.length)
                      : Math.min(execPageOffset + EXEC_PAGE, execTotalRows)
                  }} /
                  {{ showOnlyFailed ? filteredFailedRows.length.toLocaleString() : execTotalRows.toLocaleString() }}
                </span>
                <button class="btn btn-ghost btn-sm"
                  :disabled="showOnlyFailed
                    ? execFailedPageOffset + EXEC_PAGE >= filteredFailedRows.length
                    : execPageOffset + EXEC_PAGE >= execTotalRows"
                  @click="loadExecPage((showOnlyFailed ? execFailedPageOffset : execPageOffset) + EXEC_PAGE)">
                  Next ›
                </button>
              </div>
              <div style="flex: 1; overflow: hidden;">
                <DataGrid
                  :columns="execVisibleCols"
                  :rows="visibleExecRows"
                  :showRowNumbers="true"
                  :onExportCsv="failedCount > 0 && !thisJobIsRunning ? exportFailed : undefined"
                  exportCsvLabel="Export Failed CSV"
                  :onCopyAllRows="copyAllExecRows"
                  :totalRowCount="showOnlyFailed && execJobDone ? filteredFailedRows.length : execTotalRows"
                />
              </div>
            </template>
          </template>

        </div>
      </div>
    </div>
  </div>

  <div v-else class="empty-state" style="height:100%;">
    <div class="empty-state-icon">🔌</div>
    <div>Connect to both Salesforce and a SQLite database first</div>
    <router-link to="/connections" class="btn btn-primary btn-sm">Go to Connections</router-link>
  </div>

  <!-- ── "Update table with created record IDs" modal ──────────────────────── -->
  <Teleport to="body">
    <div v-if="updateIdsOpen" class="modal-backdrop" @click.self="updateIdsOpen = false">
      <div class="modal-box update-ids-modal">
        <div class="modal-header">
          <span class="modal-title">Update table with created record IDs</span>
          <button class="btn btn-ghost btn-sm" @click="updateIdsOpen = false">✕</button>
        </div>

        <!-- Result screen -->
        <template v-if="updateIdsResult">
          <div class="modal-body" style="gap:12px;">
            <div class="update-ids-success">
              <span style="font-size:22px;">✓</span>
              <div style="display:flex; flex-direction:column; gap:4px;">
                <div style="font-weight:600; font-size:14px;">Updated {{ updateIdsResult.updated.toLocaleString() }} rows</div>
                <div v-if="updateIdsResult.idColCreated" style="font-size:12px; color:var(--text-muted);">
                  Column <code>{{ updateIdsIdColName }}</code> was added to <code>{{ updateIdsTargetTable }}</code>.
                </div>
                <div v-if="updateIdsResult.indexCreated" style="font-size:12px; color:var(--text-muted);">
                  Index created on <code>{{ updateIdsTableKeyCol }}</code> in <code>{{ updateIdsTargetTable }}</code>.
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary btn-sm" @click="updateIdsOpen = false">Done</button>
          </div>
        </template>

        <!-- No unique fields detected -->
        <template v-else-if="updateIdsKeyFields.length === 0">
          <div class="modal-body">
            <div class="update-ids-error" style="background:color-mix(in srgb, var(--warning,#f59e0b) 12%, var(--surface)); color:var(--text); border-color:color-mix(in srgb, var(--warning,#f59e0b) 25%, var(--border));">
              No unique or External ID fields were detected among the mapped columns for this insert job.
              To use this feature, map at least one field that is marked as unique or External ID in Salesforce.
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary btn-sm" @click="updateIdsOpen = false">Close</button>
          </div>
        </template>

        <!-- Form screen -->
        <template v-else>
          <div class="modal-body">

            <div v-if="updateIdsKeyFields.length > 1" class="form-row">
              <label class="form-label">Key field <span class="form-hint">(unique / External ID field used as the lookup key)</span></label>
              <select v-model="updateIdsSfKeyField" class="form-select">
                <option v-for="f in updateIdsKeyFields" :key="f.sfField" :value="f.sfField">
                  {{ f.label }} ({{ f.sfField }}) — {{ f.valueCount.toLocaleString() }} values stored
                </option>
              </select>
            </div>
            <div v-else class="update-ids-info">
              Key field: <strong>{{ updateIdsKeyFields[0]?.label }}</strong>
              <span style="color:var(--text-muted);">({{ updateIdsKeyFields[0]?.sfField }})</span>
              — {{ updateIdsKeyFields[0]?.valueCount.toLocaleString() }} values stored
            </div>

            <div class="form-row">
              <label class="form-label">Target table</label>
              <select v-model="updateIdsTargetTable" class="form-select">
                <option value="">— select a table —</option>
                <option v-for="t in updateIdsTables" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>

            <div v-if="updateIdsTargetTable" class="form-row">
              <label class="form-label">
                Key column in table
                <span class="form-hint">(column whose values match the key field above)</span>
              </label>
              <select v-model="updateIdsTableKeyCol" class="form-select">
                <option value="">— select a column —</option>
                <option v-for="c in updateIdsTableCols" :key="c" :value="c">{{ c }}</option>
              </select>
              <div v-if="updateIdsTableKeyCol && updateIdsKeyColNeedsIndex" class="update-ids-index-note">
                ⚡ No index found on <strong>{{ updateIdsTableKeyCol }}</strong> — one will be created automatically to speed up the update.
              </div>
            </div>

            <div v-if="updateIdsTargetTable" class="form-row">
              <label class="form-label">ID column name <span class="form-hint">(will be created if missing)</span></label>
              <input v-model="updateIdsIdColName" class="form-input" placeholder="Id" />
            </div>

            <div v-if="updateIdsTargetTable && updateIdsTableKeyCol && updateIdsSfKeyField" class="update-ids-preview">
              Will set <strong>{{ updateIdsIdColName || 'Id' }}</strong> = Salesforce ID
              in <strong>{{ updateIdsTargetTable }}</strong>
              where <strong>{{ updateIdsTableKeyCol }}</strong> matches
              <strong>{{ updateIdsSfKeyField }}</strong>
              ({{ (updateIdsKeyFields.find(f => f.sfField === updateIdsSfKeyField)?.valueCount ?? 0).toLocaleString() }} rows).
            </div>

            <div v-if="updateIdsError" class="update-ids-error">{{ updateIdsError }}</div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-secondary btn-sm" @click="updateIdsOpen = false">Cancel</button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="updateIdsLoading || !updateIdsSfKeyField || !updateIdsTableKeyCol || !updateIdsTargetTable"
              @click="confirmUpdateIds"
            >
              <span v-if="updateIdsLoading">Updating…</span>
              <span v-else>Update with IDs</span>
            </button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, onActivated, nextTick, toRaw } from 'vue'
import { useConnectionStore } from '../stores/connection'
import { useJobStore } from '../stores/job'
import ObjectPicker from '../components/ObjectPicker.vue'
import FieldMapper from '../components/FieldMapper.vue'
import DataGrid from '../components/DataGrid.vue'
import type { WritebackJob, WritebackRunEntry, FieldDescriptor, FieldMapping } from '../../../shared/types'

const conn = useConnectionStore()
const jobs = useJobStore()
const sfRefreshing = ref(false)
async function refreshObjects(): Promise<void> {
  sfRefreshing.value = true
  try { await conn.refreshSFObjects() } finally { sfRefreshing.value = false }
}

// ── Resizable split ───────────────────────────────────────────────────────────
const SPLIT_KEY = 'writeback-split-pct'
const splitPct = ref<number>(Number(localStorage.getItem(SPLIT_KEY)) || 50)
const splitContainer = ref<HTMLElement | null>(null)

function startDrag(e: MouseEvent): void {
  const container = splitContainer.value
  if (!container) return
  const onMove = (ev: MouseEvent): void => {
    const rect = container.getBoundingClientRect()
    splitPct.value = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100))
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(SPLIT_KEY, String(Math.round(splitPct.value * 10) / 10))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

const search = ref('')
const allJobs = ref<WritebackJob[]>([])
const historyMap = ref<Map<number, WritebackRunEntry[]>>(new Map())
const selectedJobId = ref<number | null>(null)
const editing = ref(false)   // true only when creating a brand-new job
const saving = ref(false)
const saveError = ref('')
const previewLoading = ref(false)
const previewResult = ref<{ columns: string[]; rows: unknown[][] } | null>(null)
const previewError = ref('')
const sfFields = ref<FieldDescriptor[]>([])
const MAX_PARALLEL = 5
const activeRuns = ref<Map<number, string>>(new Map())  // jobId → runId
const jobQueue = ref<number[]>([])                       // jobIds waiting for a slot
const showOnlyFailed = ref(false)
const operations = ['insert', 'update', 'upsert', 'delete', 'undelete']

// ── Custom Headers suggestions ────────────────────────────────────────────────
const headerSuggestions = [
  {
    label: 'OwnerChangeOptions',
    preview: 'KeepAccountTeam',
    value: '{"OwnerChangeOptions": {"options": [{"type": "KeepAccountTeam", "execute": true}]}}'
  },
  {
    label: 'AssignmentRuleHeader',
    preview: 'useDefaultRule: true',
    value: '{"AssignmentRuleHeader": {"useDefaultRule": true}}'
  },
  {
    label: 'DuplicateRuleHeader',
    preview: 'allowSave: true',
    value: '{"DuplicateRuleHeader": {"allowSave": true}}'
  }
]
const showHeaderSuggestions = ref(false)
const activeSuggestion = ref(-1)

function onHeadersKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    showHeaderSuggestions.value = true
    activeSuggestion.value = (activeSuggestion.value + 1) % headerSuggestions.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (showHeaderSuggestions.value) {
      activeSuggestion.value = (activeSuggestion.value - 1 + headerSuggestions.length) % headerSuggestions.length
    }
  } else if (e.key === 'Enter' && showHeaderSuggestions.value && activeSuggestion.value >= 0) {
    e.preventDefault()
    selectHeaderSuggestion(activeSuggestion.value)
  } else if (e.key === 'Escape') {
    showHeaderSuggestions.value = false
    activeSuggestion.value = -1
  }
}

function selectHeaderSuggestion(i: number): void {
  editForm.value.customHeaders = headerSuggestions[i].value
  showHeaderSuggestions.value = false
  activeSuggestion.value = -1
}

function hideSuggestionsDelayed(): void {
  // Small delay so mousedown on a suggestion fires before blur hides the list.
  setTimeout(() => {
    showHeaderSuggestions.value = false
    activeSuggestion.value = -1
  }, 150)
}

// Active right-panel tab — only relevant when a job is selected.
const activeTab = ref<'definition' | 'history' | 'execution'>('definition')

// ── Per-job execution state cache ─────────────────────────────────────────────
// Keeps snapshots for up to MAX_EXEC_CACHE completed jobs so results survive
// job switching. When a new run starts, old entries beyond the limit are evicted.
const MAX_EXEC_CACHE = 3

interface SavedExecState {
  cachedAt: number       // timestamp used for LRU eviction
  sql: string
  operation: string
  columns: string[]
  totalRows: number
  sourceRowCount: number | null
  succeeded: number
  failed: number
  runId: string | null
  jobDone: boolean
  isBulkApi: boolean
  error: string | null
  warn: string | null
  pageRows: unknown[][]
  pageStatuses: Map<number, { status: 'success' | 'error'; message?: string }>
  pageIds: Map<number, string>
  failedRows: ExecFailedRow[]
  showOnlyFailed: boolean
}

const execStateCache = ref<Map<number, SavedExecState>>(new Map())

function captureExecState(jobId: number, force = false): void {
  if (!force && !execJobDone.value && !execError.value) return  // nothing worth keeping
  execStateCache.value.set(jobId, {
    cachedAt: Date.now(),
    sql: execSql.value,
    operation: execOperation.value,
    columns: execColumns.value.slice(),
    totalRows: execTotalRows.value,
    sourceRowCount: execSourceRowCount.value,
    succeeded: execSucceeded.value,
    failed: execFailed.value,
    runId: execRunId.value,
    jobDone: execJobDone.value,
    isBulkApi: execIsBulkApi.value,
    error: execError.value,
    warn: execWarn.value,
    pageRows: execPageRows.value.slice(),
    pageStatuses: new Map(execPageStatuses.value),
    pageIds: new Map(execPageIds.value),
    failedRows: execFailedRows.value.slice(),
    showOnlyFailed: showOnlyFailed.value
  })
}

function restoreExecState(jobId: number): void {
  const s = execStateCache.value.get(jobId)
  if (!s) { clearExecState(); return }
  s.cachedAt = Date.now()  // refresh LRU
  execSql.value = s.sql
  execOperation.value = s.operation
  execColumns.value = s.columns
  execTotalRows.value = s.totalRows
  execSourceRowCount.value = s.sourceRowCount
  execSucceeded.value = s.succeeded
  execFailed.value = s.failed
  execRunId.value = s.runId
  execJobDone.value = s.jobDone
  execIsBulkApi.value = s.isBulkApi
  execError.value = s.error
  execWarn.value = s.warn
  execPageRows.value = s.pageRows
  execPageStatuses.value = s.pageStatuses
  execPageIds.value = s.pageIds
  execFailedRows.value = s.failedRows
  showOnlyFailed.value = s.showOnlyFailed
  // runtime-only state
  execInFlight.value = 0
  execBulkPhase.value = ''
  execBulkUploaded.value = 0
  execBulkProcessed.value = 0
  execBulkJobState.value = ''
  execPageOffset.value = 0
  execFailedPageOffset.value = 0
  failedErrorFilter.value = ''
}

function evictOldExecStates(keepJobId: number): void {
  const cache = execStateCache.value
  if (cache.size <= MAX_EXEC_CACHE) return
  // Sort by cachedAt ascending (oldest first) and evict until within limit.
  // Never evict the pinned job or jobs that are currently running (their cache is live state).
  const sorted = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)
  for (const [id] of sorted) {
    if (cache.size <= MAX_EXEC_CACHE) break
    if (id !== keepJobId && !activeRuns.value.has(id)) cache.delete(id)
  }
}

// ── Execution display state ───────────────────────────────────────────────────
const EXEC_PAGE = 200

const execSql = ref('')
const execOperation = ref('')
const execColumns = ref<string[]>([])
const execTotalRows = ref(0)
const execSourceRowCount = ref<number | null>(null)
const execSucceeded = ref(0)
const execFailed = ref(0)
const execInFlight = ref(0)
const execRunId = ref<string | null>(null)
const execJobDone = ref(false)
// Bulk API 2.0 specific state
const execIsBulkApi = ref(false)
const execBulkPhase = ref<'uploading' | 'processing' | 'downloading' | ''>('')
const execBulkUploaded = ref(0)
const execBulkProcessed = ref(0)
const execBulkJobState = ref('')
// Error / warning from the last run
const execError = ref<string | null>(null)   // hard error (job failed)
const execWarn = ref<string | null>(null)    // warning (e.g. 0 rows processed)

const execPageOffset = ref(0)
const execPageRows = ref<unknown[][]>([])
const execPageStatuses = ref<Map<number, { status: 'success' | 'error'; message?: string }>>(new Map())
const execPageIds = ref<Map<number, string>>(new Map())

interface ExecFailedRow { index: number; message: string; row: unknown[] }
const execFailedRows = ref<ExecFailedRow[]>([])
const execFailedPageOffset = ref(0)
const failedErrorFilter = ref('')

// Up to 100 distinct error messages from the failed rows list.
const distinctErrors = computed((): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const fr of execFailedRows.value) {
    if (!seen.has(fr.message)) {
      seen.add(fr.message)
      result.push(fr.message)
      if (result.length >= 100) break
    }
  }
  return result
})

// Count of rows per distinct error message.
const errorCounts = computed((): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const fr of execFailedRows.value) {
    counts.set(fr.message, (counts.get(fr.message) ?? 0) + 1)
  }
  return counts
})

// Failed rows after applying the error-message filter (all rows if no filter).
const filteredFailedRows = computed((): ExecFailedRow[] =>
  failedErrorFilter.value
    ? execFailedRows.value.filter((fr) => fr.message === failedErrorFilter.value)
    : execFailedRows.value
)

// Reset page when the filter changes.
watch(failedErrorFilter, () => { execFailedPageOffset.value = 0 })

const execFailedMap = computed(() =>
  new Map(execFailedRows.value.map((fr) => [fr.index, fr]))
)

const totalRows = computed(() => execTotalRows.value)
const succeededCount = computed(() => execSucceeded.value)
const failedCount = computed(() => execFailed.value)

const isInsert = computed(() => execOperation.value === 'insert')

const visibleExecRows = computed(() => {
  if (showOnlyFailed.value && execJobDone.value) {
    return filteredFailedRows.value
      .slice(execFailedPageOffset.value, execFailedPageOffset.value + EXEC_PAGE)
      .map((fr) => isInsert.value
        ? ['', `✗ ${fr.message}`, ...fr.row]
        : [`✗ ${fr.message}`, ...fr.row]
      )
  }
  return execPageRows.value.map((r, pageIdx) => {
    const absIdx = execPageOffset.value + pageIdx
    let statusCell: string
    let idCell = execPageIds.value.get(absIdx) ?? ''
    if (execJobDone.value) {
      const failed = execFailedMap.value.get(absIdx)
      statusCell = failed ? `✗ ${failed.message}` : '✓'
      if (failed) idCell = ''
    } else {
      const st = execPageStatuses.value.get(absIdx)
      statusCell = st ? (st.status === 'success' ? '✓' : `✗ ${st.message ?? ''}`) : '—'
    }
    return isInsert.value
      ? [idCell, statusCell, ...(r as unknown[])]
      : [statusCell, ...(r as unknown[])]
  })
})

const execVisibleCols = computed(() =>
  isInsert.value
    ? ['_Id', '_Status', ...execColumns.value]
    : ['_Status', ...execColumns.value]
)

interface EditForm {
  id?: number
  name: string
  sqlQuery: string
  sfObject: string
  operation: string
  fieldMap: FieldMapping[]
  externalIdField: string
  batchSize: number | null
  threads: number | null
  distributionKey: string[] | null
  useBulkApi: boolean
  customHeaders: string
}

const editForm = ref<EditForm>({
  name: '', sqlQuery: '', sfObject: '', operation: 'insert', fieldMap: [],
  externalIdField: '', batchSize: null, threads: null, distributionKey: null,
  useBulkApi: false, customHeaders: ''
})

function applyPendingSql(): void {
  const sql = (window.history.state as Record<string, unknown>)?.pendingSql
  if (typeof sql === 'string' && sql.trim()) {
    window.history.replaceState({ ...window.history.state, pendingSql: undefined }, '')
    selectedJobId.value = null
    editing.value = true
    previewResult.value = null
    previewError.value = ''
    saveError.value = ''
    sfFields.value = []
    editForm.value = {
      name: '', sqlQuery: sql, sfObject: '', operation: 'insert', fieldMap: [],
      externalIdField: '', batchSize: null, threads: null, distributionKey: null,
      useBulkApi: false, customHeaders: ''
    }
  }
}

let offRunEvicted: (() => void) | null = null

onMounted(async () => {
  if (conn.bothConnected) { await loadJobs(); await conn.loadSFObjects() }

  offRunEvicted = window.api.onWritebackRunEvicted((evictedRunId) => {
    // Remove evicted run from renderer-side cache so display stays consistent
    for (const [jobId, state] of execStateCache.value.entries()) {
      if (state.runId === evictedRunId) {
        execStateCache.value.delete(jobId)
        break
      }
    }
    // If the evicted run is currently on screen, clear the display state
    if (execRunId.value === evictedRunId) {
      clearExecState()
    }
  })
})

onUnmounted(() => {
  offRunEvicted?.()
  offRunEvicted = null
  offWbExternalQueued()
  offWbExternalStarted()
})

// Sync script-triggered writeback jobs into the local queue/running maps so the
// UI shows the correct running/queued badges and executeJobById's guard fires.
const offWbExternalQueued = window.api.onExternalJobQueued((e) => {
  if (e.type !== 'writeback') return
  if (!jobQueue.value.includes(e.jobId)) {
    jobQueue.value = [...jobQueue.value, e.jobId]
  }
})

const offWbExternalStarted = window.api.onExternalJobStarted((e) => {
  if (e.type !== 'writeback') return
  jobQueue.value = jobQueue.value.filter((id) => id !== e.jobId)
  if (!activeRuns.value.has(e.jobId)) {
    activeRuns.value.set(e.jobId, e.runId)
    const off = window.api.onJobComplete((result) => {
      if (result.runId !== e.runId) return
      off()
      activeRuns.value.delete(e.jobId)
      loadJobs()
    })
  }
})

onActivated(async () => {
  await nextTick()
  applyPendingSql()
})

watch(() => conn.bothConnected, async (v) => { if (v) { await loadJobs(); await conn.loadSFObjects() } })

const filteredJobs = computed(() => {
  const q = search.value.toLowerCase()
  return allJobs.value
    .filter((j) => !q || j.name.toLowerCase().includes(q) || j.sfObject.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
})
const selectedJob = computed(() => allJobs.value.find((j) => j.id === selectedJobId.value))
const history = computed(() => historyMap.value.get(selectedJobId.value ?? -1) ?? [])
// True only when the *selected* job specifically has an active run.
const thisJobIsRunning = computed(() =>
  selectedJobId.value != null && activeRuns.value.has(selectedJobId.value)
)
const thisJobIsQueued = computed(() =>
  selectedJobId.value != null && jobQueue.value.includes(selectedJobId.value)
)
const activeJobData = computed(() => {
  const runId = selectedJobId.value != null ? activeRuns.value.get(selectedJobId.value) : undefined
  return runId ? jobs.getJob(runId) : undefined
})
function lastRun(jobId: number): WritebackRunEntry | undefined {
  return (historyMap.value.get(jobId) ?? [])[0]
}

async function loadJobs(): Promise<void> {
  allJobs.value = await window.api.listWritebackJobs()
  const histories = await Promise.all(allJobs.value.map(j => window.api.getWritebackRunHistory(j.id)))
  allJobs.value.forEach((j, i) => historyMap.value.set(j.id, histories[i]))
}

/** Load a job's data into the edit form (without switching tabs). */
function loadJobIntoForm(j: WritebackJob): void {
  editForm.value = {
    id: j.id, name: j.name, sqlQuery: j.sqlQuery, sfObject: j.sfObject,
    operation: j.operation, fieldMap: [...j.fieldMap.map((m) => ({ ...m }))],
    externalIdField: j.externalIdField ?? '', batchSize: j.batchSize, threads: j.threads,
    distributionKey: j.distributionKey ? [...j.distributionKey] : null,
    useBulkApi: j.useBulkApi,
    customHeaders: j.customHeaders ?? ''
  }
  previewResult.value = null
  sfFields.value = []
  if (j.sfObject) {
    window.api.describeObject(j.sfObject).then((f) => { sfFields.value = f })
  }
}

/** Revert any unsaved changes in the Definition tab back to the saved job. */
function resetDefinitionForm(): void {
  const j = selectedJob.value
  if (j) {
    loadJobIntoForm(j)
    previewError.value = ''
    saveError.value = ''
  }
}

async function selectJob(id: number): Promise<void> {
  // Save exec state of the job we're leaving before switching
  // Force-capture even for running jobs so navigating back shows recent progress
  if (selectedJobId.value != null && selectedJobId.value !== id) {
    captureExecState(selectedJobId.value, true)
  }
  selectedJobId.value = id
  editing.value = false
  activeTab.value = 'definition'
  restoreExecState(id)
  const j = allJobs.value.find((x) => x.id === id)
  if (j) {
    loadJobIntoForm(j)
  }
  historyMap.value.set(id, await window.api.getWritebackRunHistory(id))
}

function newJob(): void {
  selectedJobId.value = null
  editing.value = true
  previewResult.value = null
  previewError.value = ''
  saveError.value = ''
  sfFields.value = []
  editForm.value = {
    name: '', sqlQuery: '', sfObject: '', operation: 'insert', fieldMap: [],
    externalIdField: '', batchSize: null, threads: null, distributionKey: null,
    useBulkApi: false, customHeaders: ''
  }
}

function cancelEdit(): void {
  editing.value = false
  if (!selectedJobId.value) {
    selectedJobId.value = allJobs.value[0]?.id ?? null
    if (selectedJobId.value) {
      const j = allJobs.value.find((x) => x.id === selectedJobId.value)
      if (j) { loadJobIntoForm(j) }
    }
  }
}

async function runPreview(): Promise<void> {
  previewError.value = ''
  previewLoading.value = true
  try {
    previewResult.value = await window.api.previewWritebackQuery(editForm.value.sqlQuery)
    initFieldMap()
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

async function onObjectChange(name: string): Promise<void> {
  if (!name) return
  sfFields.value = await window.api.describeObject(name)
  initFieldMap()
  const idCol = previewResult.value?.columns.find((c) => /^id$/i.test(c))
  if (idCol && !editForm.value.sfObject) {
    editForm.value.sfObject = name
  }
}

function initFieldMap(): void {
  if (!previewResult.value) return
  const existing = new Map(editForm.value.fieldMap.map((m) => [m.sqlCol, m]))
  editForm.value.fieldMap = previewResult.value.columns.map((col) => {
    const prev = existing.get(col)
    if (prev) {
      return { ...prev }
    }
    const match = sfFields.value.find((f) => f.name.toLowerCase() === col.toLowerCase())
    return { sqlCol: col, sfField: match?.name ?? '', isKey: false, excluded: !match }
  })
  // Drop any distribution key columns that no longer exist in the new field map.
  if (editForm.value.distributionKey?.length) {
    const validCols = new Set(editForm.value.fieldMap.map((m) => m.sqlCol))
    const filtered = editForm.value.distributionKey.filter((c) => validCols.has(c))
    editForm.value.distributionKey = filtered.length ? filtered : null
  }
}

/** SQL columns available for use as distribution key (populated after preview). */
const distribKeyCols = computed(() =>
  editForm.value.fieldMap.map((m) => m.sqlCol).filter(Boolean)
)

const distribKeySearch = ref('')
const distribKeyDropdownOpen = ref(false)

const distribKeyOptions = computed(() => {
  const selected = new Set(editForm.value.distributionKey ?? [])
  const q = distribKeySearch.value.toLowerCase()
  return distribKeyCols.value.filter(
    (col) => !selected.has(col) && (!q || col.toLowerCase().includes(q))
  )
})

function toggleDistribKey(col: string): void {
  if ((editForm.value.threads ?? 1) <= 1) return
  const current = editForm.value.distributionKey ?? []
  const next = current.includes(col) ? current.filter((c) => c !== col) : [...current, col]
  editForm.value.distributionKey = next.length ? next : null
}

function selectDistribKey(col: string): void {
  if ((editForm.value.threads ?? 1) <= 1) return
  const current = editForm.value.distributionKey ?? []
  if (!current.includes(col)) {
    editForm.value.distributionKey = [...current, col]
  }
  distribKeySearch.value = ''
  distribKeyDropdownOpen.value = false
}

function hideDistribDropdownDelayed(): void {
  setTimeout(() => { distribKeyDropdownOpen.value = false }, 150)
}

// ── "Update table with created record IDs" modal ─────────────────────────────
interface UpdateIdsKeyField { sfField: string; sqlCol: string; label: string; valueCount: number }

const updateIdsOpen = ref(false)
const updateIdsTables = ref<string[]>([])
const updateIdsTargetTable = ref('')
const updateIdsTableCols = ref<string[]>([])
const updateIdsTableKeyCol = ref('')   // column in the target table (WHERE clause)
const updateIdsKeyFields = ref<UpdateIdsKeyField[]>([])   // unique/externalId fields from the run
const updateIdsSfKeyField = ref('')    // which SF field to use as the key
const updateIdsIdColName = ref('Id')
const updateIdsLoading = ref(false)
const updateIdsResult = ref<{ updated: number; idColCreated: boolean; indexCreated: boolean } | null>(null)
const updateIdsError = ref('')
const updateIdsKeyColNeedsIndex = ref(false)

// When the user picks a target table, load its columns and auto-propose the table key column.
watch(updateIdsTargetTable, async (tbl) => {
  updateIdsTableCols.value = tbl ? await window.api.getTableColumnNames(tbl) : []
  // Auto-propose the table key column: prefer a column whose name matches the sqlCol of the selected SF field.
  const sfField = updateIdsKeyFields.value.find((f) => f.sfField === updateIdsSfKeyField.value)
  if (sfField && updateIdsTableCols.value.includes(sfField.sqlCol)) {
    updateIdsTableKeyCol.value = sfField.sqlCol
  } else {
    updateIdsTableKeyCol.value = ''
  }
})

// When the SF key field changes, re-run the table key column auto-proposal.
watch(updateIdsSfKeyField, () => {
  const sfField = updateIdsKeyFields.value.find((f) => f.sfField === updateIdsSfKeyField.value)
  if (sfField && updateIdsTableCols.value.includes(sfField.sqlCol)) {
    updateIdsTableKeyCol.value = sfField.sqlCol
  } else {
    updateIdsTableKeyCol.value = ''
  }
})

// Check whether the selected key column already has an index so we can warn the user.
watch([updateIdsTargetTable, updateIdsTableKeyCol], async ([tbl, col]) => {
  if (tbl && col) {
    updateIdsKeyColNeedsIndex.value = !(await window.api.columnHasIndex(tbl, col))
  } else {
    updateIdsKeyColNeedsIndex.value = false
  }
})

async function openUpdateIdsModal(): Promise<void> {
  if (!execRunId.value) return
  const info = await window.api.wbGetIdUpdateInfo(execRunId.value)
  updateIdsKeyFields.value = info?.keyFields ?? []
  // Auto-select the first key field with stored values.
  const firstWithValues = updateIdsKeyFields.value.find((f) => f.valueCount > 0)
  updateIdsSfKeyField.value = firstWithValues?.sfField ?? (updateIdsKeyFields.value[0]?.sfField ?? '')
  updateIdsTables.value = await window.api.getUserTableNames()
  updateIdsTargetTable.value = ''
  updateIdsTableCols.value = []
  updateIdsTableKeyCol.value = ''
  updateIdsIdColName.value = 'Id'
  updateIdsResult.value = null
  updateIdsError.value = ''
  updateIdsLoading.value = false
  updateIdsOpen.value = true
}

async function confirmUpdateIds(): Promise<void> {
  if (!execRunId.value || !updateIdsSfKeyField.value || !updateIdsTableKeyCol.value || !updateIdsTargetTable.value) return
  const idColName = updateIdsIdColName.value.trim() || 'Id'
  updateIdsLoading.value = true
  updateIdsError.value = ''
  updateIdsResult.value = null
  try {
    const result = await window.api.wbUpdateTableWithIds(
      execRunId.value,
      updateIdsSfKeyField.value,
      updateIdsTargetTable.value,
      updateIdsTableKeyCol.value,
      idColName
    )
    updateIdsResult.value = result
  } catch (err) {
    updateIdsError.value = err instanceof Error ? err.message : String(err)
  } finally {
    updateIdsLoading.value = false
  }
}

/** Reset execution display state (called after saving a job definition). */
function clearExecState(): void {
  execSql.value = ''
  execOperation.value = ''
  execColumns.value = []
  execTotalRows.value = 0
  execSourceRowCount.value = null
  execSucceeded.value = 0
  execFailed.value = 0
  execInFlight.value = 0
  execRunId.value = null
  execJobDone.value = false
  execIsBulkApi.value = false
  execBulkPhase.value = ''
  execBulkUploaded.value = 0
  execBulkProcessed.value = 0
  execBulkJobState.value = ''
  execError.value = null
  execWarn.value = null
  execPageOffset.value = 0
  execPageRows.value = []
  execPageStatuses.value = new Map()
  execPageIds.value = new Map()
  execFailedRows.value = []
  execFailedPageOffset.value = 0
  failedErrorFilter.value = ''
  showOnlyFailed.value = false
}

async function save(andExecute: boolean): Promise<void> {
  saveError.value = ''

  // For delete operations, only the Id field should be mapped.
  if (editForm.value.operation === 'delete') {
    const badMappings = editForm.value.fieldMap.filter(
      (m) => !m.excluded && m.sfField && m.sfField !== 'Id'
    )
    if (badMappings.length > 0) {
      saveError.value =
        `Delete operations only send the Id field to Salesforce. ` +
        `Please uncheck or clear these extra mappings: ${badMappings.map((m) => m.sfField).join(', ')}.`
      return
    }
  }

  saving.value = true
  try {
    const job = await window.api.saveWritebackJob({
      ...(editForm.value.id ? { id: editForm.value.id } : {}),
      name: editForm.value.name || editForm.value.sfObject,
      sqlQuery: editForm.value.sqlQuery,
      sfObject: editForm.value.sfObject,
      operation: editForm.value.operation as WritebackJob['operation'],
      fieldMap: toRaw(editForm.value.fieldMap).map((m) => ({ ...toRaw(m) })),
      externalIdField: editForm.value.externalIdField || null,
      batchSize: editForm.value.batchSize,
      threads: editForm.value.threads,
      distributionKey: editForm.value.distributionKey?.length ? [...toRaw(editForm.value.distributionKey)] : null,
      useBulkApi: editForm.value.useBulkApi,
      customHeaders: editForm.value.customHeaders.trim() || null
    } as Parameters<typeof window.api.saveWritebackJob>[0])
    await loadJobs()
    selectedJobId.value = job.id
    loadJobIntoForm(job)   // keeps editForm.id in sync so subsequent saves do UPDATE not INSERT
    editing.value = false
    if (andExecute) {
      await executeJobById(job.id)
    }
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
    // Queue the job — show "Queued" in the execution tab
    jobQueue.value = [...jobQueue.value, id]
    if (selectedJobId.value === id) activeTab.value = 'execution'
    return
  }

  await _startJobNow(id)
}

async function _startJobNow(id: number): Promise<void> {
  const j = allJobs.value.find((x) => x.id === id)
  if (!j) return

  // Drop any stale cached state for this job
  execStateCache.value.delete(id)

  // If this job is selected, set up display state
  if (selectedJobId.value === id) {
    activeTab.value = 'execution'
    const sql = j.sqlQuery.replace(/LIMIT\s+\d+/i, '')
    execSql.value = sql
    execOperation.value = j.operation
    execIsBulkApi.value = j.useBulkApi
    execBulkPhase.value = ''
    execBulkUploaded.value = 0
    execBulkProcessed.value = 0
    execBulkJobState.value = ''
    execError.value = null
    execWarn.value = null
    execTotalRows.value = 0
    execSourceRowCount.value = null
    execSucceeded.value = 0
    execFailed.value = 0
    execInFlight.value = 0
    execPageOffset.value = 0
    execPageRows.value = []
    execPageStatuses.value = new Map()
    execPageIds.value = new Map()
    execFailedRows.value = []
    execFailedPageOffset.value = 0
    execJobDone.value = false
    showOnlyFailed.value = false

    // Fetch source row count in background — does not block job start
    window.api.wbRowCount(sql).then((count) => {
      if (execSql.value === sql) execSourceRowCount.value = count
    }).catch(() => {})

    if (j.useBulkApi) {
      execColumns.value = []
    } else {
      const firstPage = await window.api.wbPage(sql, 0, EXEC_PAGE)
      execColumns.value = firstPage.columns
      execPageRows.value = firstPage.rows
    }
  }

  const runId = await window.api.startWriteback(id)
  if (selectedJobId.value === id) execRunId.value = runId
  activeRuns.value.set(id, runId)
  jobs.startJob(runId, 'writeback', id)

  startRunMonitor(id, runId)
}

function startRunMonitor(jobId: number, runId: string): void {
  // Helper: returns true if this job is the one currently displayed
  const isSelected = () => selectedJobId.value === jobId

  const offProgress = window.api.onJobProgress((e) => {
    if (e.runId !== runId) return

    if (e.phase) {
      // Bulk API 2.0 progress
      if (isSelected()) {
        execBulkPhase.value = e.phase
        if (e.bulkUploaded !== undefined) { execBulkUploaded.value = e.bulkUploaded }
        if (e.phase === 'processing') {
          if (e.total !== undefined) { execBulkProcessed.value = e.total }
          if (e.succeeded !== undefined) { execSucceeded.value = e.succeeded }
          if (e.failed !== undefined) { execFailed.value = e.failed }
          if (e.jobState) { execBulkJobState.value = e.jobState }
        }
      }
    } else {
      // REST Collections API progress
      if (isSelected()) {
        if (e.succeeded !== undefined) { execSucceeded.value = e.succeeded }
        if (e.failed !== undefined) { execFailed.value = e.failed }
        if (e.inFlight !== undefined) { execInFlight.value = e.inFlight }
        if (e.total !== undefined && e.total > execTotalRows.value) { execTotalRows.value = e.total }
        if (e.rowStatuses) {
          const pageEnd = execPageOffset.value + EXEC_PAGE
          let statusChanged = false
          let idChanged = false
          for (const rs of e.rowStatuses) {
            if (rs.index >= execPageOffset.value && rs.index < pageEnd) {
              execPageStatuses.value.set(rs.index, { status: rs.status, message: rs.message })
              statusChanged = true
              if (rs.id) {
                execPageIds.value.set(rs.index, rs.id)
                idChanged = true
              }
            }
          }
          if (statusChanged) { execPageStatuses.value = new Map(execPageStatuses.value) }
          if (idChanged) { execPageIds.value = new Map(execPageIds.value) }
        }
      }
    }
    // Keep a fresh snapshot in the cache so navigating back shows recent progress
    if (isSelected()) captureExecState(jobId, true)
  })

  const offComplete = window.api.onJobComplete(async (e) => {
    if (e.runId !== runId) return
    offProgress()
    offComplete()
    activeRuns.value.delete(jobId)

    if (isSelected()) {
      execInFlight.value = 0
      execBulkPhase.value = ''
      execJobDone.value = true

      if (e.status === 'error') {
        execError.value = e.errorMsg ?? 'The job failed with an unknown error.'
      } else {
        execError.value = null
        if (e.rowsSucceeded !== undefined && e.rowsFailed !== undefined) {
          execTotalRows.value = e.rowsSucceeded + e.rowsFailed
          execSucceeded.value = e.rowsSucceeded
          execFailed.value = e.rowsFailed
          if (e.rowsSucceeded + e.rowsFailed === 0) {
            execWarn.value =
              'The job completed but 0 rows were processed. ' +
              'Check that your SQL query returns rows and that at least one field mapping is active.'
          }
        }
      }
      if (e.columns && e.columns.length > 0) { execColumns.value = e.columns }
      if (e.rowsFailed && e.rowsFailed > 0) {
        execFailedRows.value = await window.api.wbGetFailedRows(runId)
      }
      captureExecState(jobId)
    } else {
      // Job completed in background — save a minimal completion snapshot in the cache
      const cached = execStateCache.value.get(jobId)
      if (cached) {
        cached.jobDone = true
        cached.error = e.status === 'error' ? (e.errorMsg ?? 'Unknown error') : null
        if (e.rowsSucceeded !== undefined) cached.succeeded = e.rowsSucceeded
        if (e.rowsFailed !== undefined) cached.failed = e.rowsFailed
        if (e.rowsSucceeded !== undefined && e.rowsFailed !== undefined)
          cached.totalRows = e.rowsSucceeded + e.rowsFailed
        if (e.columns && e.columns.length > 0) cached.columns = e.columns
        if (e.rowsFailed && e.rowsFailed > 0) {
          window.api.wbGetFailedRows(runId).then((rows) => { cached.failedRows = rows })
        }
        cached.cachedAt = Date.now()
      }
    }

    loadJobs()
    evictOldExecStates(jobId)

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
    clearExecState()
    return
  }

  const runId = activeRuns.value.get(id)
  if (runId) await window.api.cancelJob(runId)
  // activeRuns will be cleaned up by the onJobComplete handler
}

async function loadExecPage(offset: number): Promise<void> {
  execPageOffset.value = offset
  execPageStatuses.value = new Map()
  execPageIds.value = new Map()
  if (showOnlyFailed.value) {
    execFailedPageOffset.value = offset
    return
  }
  const { rows } = await window.api.wbPage(execSql.value, offset, EXEC_PAGE)
  execPageRows.value = rows
  if (execJobDone.value && isInsert.value && execRunId.value) {
    const ids = await window.api.wbGetPageIds(execRunId.value, offset, EXEC_PAGE)
    execPageIds.value = new Map(Object.entries(ids).map(([k, v]) => [Number(k), v]))
  }
}

async function copyAllExecRows(): Promise<void> {
  const csvEscape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s
  }

  const cols = execVisibleCols.value
  const lines: string[] = [cols.map(csvEscape).join(',')]

  if (showOnlyFailed.value && execJobDone.value) {
    for (const fr of filteredFailedRows.value) {
      const row: unknown[] = isInsert.value
        ? ['', `✗ ${fr.message}`, ...fr.row]
        : [`✗ ${fr.message}`, ...fr.row]
      lines.push(row.map(csvEscape).join(','))
    }
  } else {
    const total = execTotalRows.value
    for (let offset = 0; offset < total; offset += EXEC_PAGE) {
      const { rows } = await window.api.wbPage(execSql.value, offset, EXEC_PAGE)
      let ids: Record<number, string> = {}
      if (isInsert.value && execRunId.value) {
        ids = await window.api.wbGetPageIds(execRunId.value, offset, EXEC_PAGE)
      }
      for (let i = 0; i < rows.length; i++) {
        const absIdx = offset + i
        const failed = execFailedMap.value.get(absIdx)
        const statusCell = failed ? `✗ ${failed.message}` : '✓'
        const idCell = failed ? '' : (ids[absIdx] ?? '')
        const rawRow = rows[i] as unknown[]
        const fullRow: unknown[] = isInsert.value
          ? [idCell, statusCell, ...rawRow]
          : [statusCell, ...rawRow]
        lines.push(fullRow.map(csvEscape).join(','))
      }
    }
  }

  await navigator.clipboard.writeText(lines.join('\n'))
}

async function retryFailed(): Promise<void> {
  if (!selectedJobId.value || !execRunId.value) return

  execTotalRows.value = execFailedRows.value.length
  execPageOffset.value = 0
  execPageRows.value = execFailedRows.value.slice(0, EXEC_PAGE).map((fr) => fr.row)
  execPageStatuses.value = new Map()
  execPageIds.value = new Map()
  execSucceeded.value = 0
  execFailed.value = 0
  execFailedRows.value = []
  execJobDone.value = false
  showOnlyFailed.value = false

  const id = selectedJobId.value
  const newRunId = await window.api.retryFailed(execRunId.value, id)
  execRunId.value = newRunId
  activeRuns.value.set(id, newRunId)
  jobs.startJob(newRunId, 'writeback', id)
  startRunMonitor(id, newRunId)
}

async function exportFailed(): Promise<void> {
  const columns = ['_ErrorMessage', ...execColumns.value]
  const csvEscape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s
  }
  const rows = execFailedRows.value.map((fr) =>
    [fr.message, ...fr.row].map(csvEscape).join(',')
  )
  const csv = [columns.map(csvEscape).join(','), ...rows].join('\n')
  await window.api.exportToCsv(csv)
}

async function duplicateSelectedJob(): Promise<void> {
  if (!selectedJobId.value) return
  await window.api.duplicateWritebackJob(selectedJobId.value)
  await loadJobs()
}

async function deleteSelectedJob(): Promise<void> {
  if (!selectedJobId.value || !confirm('Delete this job?')) return
  await window.api.deleteWritebackJob(selectedJobId.value)
  selectedJobId.value = null
  clearExecState()
  await loadJobs()
}

function opBadge(op: string): string {
  const m: Record<string, string> = { insert: 'badge-blue', update: 'badge-amber', upsert: 'badge-purple', delete: 'badge-red', undelete: 'badge-gray' }
  return m[op] ?? 'badge-gray'
}
function runStatusBadge(s: string): string {
  if (s === 'success') return 'badge-green'
  if (s === 'error') return 'badge-red'
  if (s === 'partial') return 'badge-amber'
  return 'badge-blue'
}
function formatDate(d: string): string { return new Date(d).toLocaleString() }

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
</script>

<style scoped>
/* Resizable split */
.split-left { flex-shrink: 0; flex-grow: 0; min-width: 0; overflow-y: auto; }
.split-right { flex: 1; overflow: hidden; min-width: 0; }
.split-divider {
  width: 5px; flex-shrink: 0; cursor: col-resize; position: relative; z-index: 1; background: transparent;
}
.split-divider::after {
  content: ''; position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: 3px; height: 48px; border-radius: 99px;
  background: var(--border); transition: background 0.15s, height 0.15s;
}
.split-divider:hover::after, .split-divider:active::after { background: var(--primary); height: 64px; }

/* Job rows */
.job-row {
  display: flex; flex-direction: column; justify-content: center;
  padding: 5px 12px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, #166534 25%, var(--border)); gap: 1px;
}
.job-row { border-left: 3px solid #166534; }
.job-row:hover { background: var(--surface2); }
.job-row.selected { background: color-mix(in srgb, #166534 10%, transparent); }
.job-row.running { background: color-mix(in srgb, #166534 5%, transparent); }
.job-row.running.selected { background: color-mix(in srgb, #166534 15%, transparent); }
.job-row-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px; }
.job-row-spinner { width: 10px; height: 10px; border-width: 1.5px; flex-shrink: 0; }
.job-row-running-label { font-size: 10px; font-weight: 600; color: var(--primary); text-transform: uppercase; letter-spacing: 0.04em; }
.job-row-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.job-row-sub { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.job-row-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.job-row-rows { font-size: 11px; color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.job-run-btn { width: 22px; height: 22px; padding: 0; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid color-mix(in srgb, #166534 40%, var(--border)); border-radius: var(--radius-sm); cursor: pointer; font-size: 11px; color: #166534; flex-shrink: 0; }
.job-run-btn:hover:not(:disabled) { background: color-mix(in srgb, #166534 12%, transparent); }
.job-run-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* Detail panels */
.job-editor, .job-detail { height: 100%; display: flex; flex-direction: column; }
.editor-body { padding: 16px; overflow-y: auto; flex: 1; }

/* Tab bar */
.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}
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
.tab-panel { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
.tab-panel.editor-body { overflow-y: auto; }

/* Form actions bar inside the Definition tab */
.form-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

/* History & execution sections */
.history-section { flex: 1; overflow-y: auto; }
.execution-section { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.exec-stats { padding: 8px 12px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid var(--border); font-size: 13px; flex-shrink: 0; }
.exec-pager { padding: 4px 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
.bulk-phase-card { padding: 24px; display: flex; flex-direction: column; align-items: flex-start; }
.bulk-phase-row { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text); }
.exec-banner { padding: 10px 14px; display: flex; align-items: flex-start; gap: 12px; font-size: 13px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.exec-banner-error { background: color-mix(in srgb, var(--danger) 12%, var(--surface)); color: var(--danger); }
.exec-banner-warn  { background: color-mix(in srgb, var(--warning, #f59e0b) 12%, var(--surface)); color: var(--text); }
.failed-rows-header { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; }
.error-filter-bar { display: flex; align-items: center; gap: 6px; }
.error-filter-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.error-filter-select { font-size: 12px; padding: 2px 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); max-width: 480px; }

.op-selector { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 4px; }
.radio-label { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 13px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; }
.checkboxes-group { display: flex; flex-direction: column; gap: 8px; }

/* Custom Headers suggestions */
.suggest-wrap { position: relative; }
.suggest-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  overflow: hidden;
  margin-top: 2px;
}
.suggest-item {
  display: flex;
  flex-direction: column;
  padding: 7px 10px;
  cursor: pointer;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}
.suggest-item:last-child { border-bottom: none; }
.suggest-item:hover, .suggest-item.active { background: color-mix(in srgb, var(--primary) 10%, transparent); }
.suggest-name { font-size: 13px; font-weight: 500; color: var(--text); }
.suggest-preview { font-size: 11px; color: var(--text-muted); font-family: monospace; }

/* ── "Update table with IDs" modal ── */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 200;
  display: flex; align-items: center; justify-content: center;
}
.modal-box {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 8px 32px rgba(0,0,0,0.25); display: flex; flex-direction: column;
  max-height: 90vh; overflow: hidden;
}
.update-ids-modal { width: 520px; }
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-body {
  padding: 16px; overflow-y: auto; flex: 1;
  display: flex; flex-direction: column; gap: 14px;
}
.modal-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--border); flex-shrink: 0;
}
.form-row { display: flex; flex-direction: column; gap: 5px; }
.form-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.form-hint { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 11px; color: var(--text-muted); }
.form-select, .form-input {
  padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--text); font-size: 13px; width: 100%;
}
.badge-auto {
  display: inline-block; font-size: 10px; font-weight: 600; padding: 1px 5px;
  border-radius: 3px; background: color-mix(in srgb, var(--primary) 15%, transparent);
  color: var(--primary); text-transform: none; letter-spacing: 0; margin-left: 6px;
}
.update-ids-preview {
  background: color-mix(in srgb, var(--primary) 8%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--primary) 20%, var(--border));
  border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px; line-height: 1.6;
}
.update-ids-error {
  background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  color: var(--danger); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px;
}
.update-ids-success {
  display: flex; align-items: flex-start; gap: 12px;
  background: color-mix(in srgb, var(--success) 10%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--success) 25%, var(--border));
  border-radius: var(--radius-sm); padding: 16px; color: var(--success);
}
.update-ids-info {
  background: color-mix(in srgb, var(--primary) 8%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--primary) 20%, var(--border));
  border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px;
}
.update-ids-index-note {
  margin-top: 5px; font-size: 12px;
  color: color-mix(in srgb, var(--warning, #f59e0b) 90%, var(--text));
  background: color-mix(in srgb, var(--warning, #f59e0b) 10%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 25%, var(--border));
  border-radius: var(--radius-sm); padding: 6px 10px;
}

/* Distribution key tag input */
.distrib-key-input {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: text;
  position: relative;
}
.distrib-key-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 4px 2px 8px;
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border));
  border-radius: 10px;
  font-size: 12px;
  color: var(--primary);
  font-weight: 500;
}
.distrib-key-tag-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--primary);
  padding: 0 2px;
  font-size: 15px;
  line-height: 1;
  opacity: 0.6;
}
.distrib-key-tag-remove:hover { opacity: 1; }
.distrib-key-search {
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--text);
  min-width: 90px;
  flex: 1;
  padding: 2px 0;
}
.distrib-key-search::placeholder { color: var(--text-muted); }
.distrib-key-dropdown {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  max-height: 180px;
  overflow-y: auto;
}
.distrib-key-option {
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text);
}
.distrib-key-option:hover { background: color-mix(in srgb, var(--primary) 10%, transparent); }
.distrib-key-list--disabled {
  opacity: 0.4;
  pointer-events: none;
}
.distrib-key-hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}
.distrib-key-hint code {
  font-family: monospace;
  font-size: 11px;
  background: color-mix(in srgb, var(--primary) 8%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--primary) 18%, var(--border));
  border-radius: 3px;
  padding: 0 4px;
}
</style>
