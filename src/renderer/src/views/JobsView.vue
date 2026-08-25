<template>
  <div class="split-view" v-if="conn.bothConnected" ref="splitContainer">
    <!-- ── Left: Unified job list ──────────────────────────────────────── -->
    <div class="split-left" :style="{ flexBasis: splitPct + '%' }">
      <div class="toolbar">
        <div class="new-job-wrap">
          <button class="btn btn-primary btn-sm new-job-btn" @click.stop="newJobMenuOpen = !newJobMenuOpen">
            + New Job <span style="font-size:10px; margin-left:2px;">▾</span>
          </button>
          <div v-if="newJobMenuOpen" class="new-job-menu" @click.stop>
            <button class="new-job-menu-item" @click="startNewExtractJob">
              <span class="type-icon-extract">⬇</span>
              Extraction Job
              <span class="new-job-menu-hint">SF → SQLite</span>
            </button>
            <button class="new-job-menu-item" @click="startNewWbJob">
              <span class="type-icon-wb">⬆</span>
              Write-back Job
              <span class="new-job-menu-hint">SQLite → SF</span>
            </button>
          </div>
        </div>
        <input v-model="search" type="text" placeholder="Search jobs…" style="flex:1; font-size:12px;" />
      </div>

      <div class="job-list-scroll">
      <div v-if="!filteredJobs.length" class="empty-state" style="padding: 32px 16px; gap:10px;">
        <div style="font-size:28px; line-height:1;">⬇⬆</div>
        <div>No jobs yet</div>
        <button class="btn btn-primary btn-sm" @click="startNewExtractJob">⬇ New Extraction Job</button>
        <button class="btn btn-secondary btn-sm" @click="startNewWbJob">⬆ New Write-back Job</button>
      </div>

      <div
        v-for="entry in filteredJobs"
        :key="entry.type + ':' + entry.id"
        class="job-row"
        :class="[
          entry.type === 'extract' ? 'job-row-extract' : 'job-row-wb',
          {
            selected: selectedJob?.type === entry.type && selectedJob?.id === entry.id,
            running: isEntryRunning(entry),
            'job-row-detailed': uiPrefs.showJobDetails
          }
        ]"
        @click="selectEntry(entry)"
      >
        <span class="job-row-icons">
          <span :class="entry.type === 'extract' ? 'type-icon-extract' : 'type-icon-wb'" class="job-row-icon">
            {{ entry.type === 'extract' ? '⬇' : '⬆' }}
          </span>
          <span v-if="entry.type === 'writeback'" class="type-icon-wb job-row-op-icon">{{ wbOpIcon(entry.operation) }}</span>
        </span>
        <span class="job-row-main">
          <span class="job-row-name-row">
            <span class="job-row-name">{{ entry.name }}</span>
            <button v-if="entry.comment" class="job-comment-icon" @click.stop="openCommentPopup(entry, $event)" title="Show comment">ⓘ</button>
          </span>
          <span v-if="uiPrefs.showJobDetails" class="job-row-subtitle">{{ entry.subtitle }}</span>
        </span>
        <span class="job-row-status">
          <span v-if="isEntryRunning(entry)" class="spinner job-row-spinner"></span>
          <span v-if="isEntryRunning(entry)" class="job-row-running-label">running</span>
          <span v-else-if="isEntryQueued(entry)" class="job-row-running-label job-row-queued-label">queued</span>
          <template v-else-if="entryLastRun(entry)">
            <span class="badge badge-icon" :class="runStatusBadge(entryLastRun(entry)!.status)" :title="entryLastRun(entry)!.status">{{ runStatusIcon(entryLastRun(entry)!.status) }}</span>
            <span v-if="entryRowCount(entry) != null" class="job-row-rows">{{ entryRowCount(entry)!.toLocaleString() }}</span>
          </template>
        </span>
        <button
          class="job-run-btn"
          :class="entry.type === 'extract' ? 'job-run-btn-extract' : 'job-run-btn-wb'"
          :disabled="isEntryRunning(entry) || isEntryQueued(entry)"
          :title="isEntryRunning(entry) ? 'Running…' : isEntryQueued(entry) ? 'Queued…' : 'Run job'"
          @click.stop="runEntry(entry)"
        >
          <span v-if="isEntryRunning(entry)" class="spinner" style="width:10px;height:10px;border-width:1.5px;"></span>
          <span v-else>▶</span>
        </button>
      </div>
      </div><!-- end job-list-scroll -->
    </div>

    <!-- Draggable divider -->
    <div class="split-divider" @mousedown.prevent="startDrag"></div>

    <!-- ── Right panel ────────────────────────────────────────────────── -->
    <div style="display:flex; flex:1; overflow:hidden; min-width:0;">
      <div class="split-right" style="padding:0; flex:1; overflow:hidden; min-width:0;">

        <!-- Nothing selected -->
        <div v-if="!selectedJob && !creating" class="empty-state" style="height:100%;">
          <div style="font-size:32px; line-height:1;">⬇⬆</div>
          <div>Select a job or create a new one</div>
        </div>

        <!-- ╔══════════════════════════════════════════════════╗ -->
        <!-- ║  EXTRACT – New job form                          ║ -->
        <!-- ╚══════════════════════════════════════════════════╝ -->
        <div v-else-if="creating === 'extract'" class="job-editor">
          <div class="toolbar">
            <span style="font-weight:600;">New Extraction Job</span>
            <div class="toolbar-right">
              <button class="btn btn-secondary btn-sm" @click="cancelCreating">Cancel</button>
              <button class="btn btn-secondary btn-sm" :disabled="exSaving" @click="exSave(false)">
                <span v-if="exSaving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
                Save
              </button>
              <button class="btn btn-primary btn-sm" :disabled="exSaving" @click="exSave(true)">Save &amp; Execute</button>
            </div>
          </div>
          <div class="editor-body">
            <div class="form-row-h">
              <div class="form-group">
                <label>Job Name Suffix</label>
                <input v-model="exEditForm.name" type="text" placeholder="extract" />
              </div>
              <div class="form-group">
                <label>Comment</label>
                <textarea v-model="exEditForm.comment" rows="2" placeholder="Optional note" class="comment-textarea" />
              </div>
            </div>
            <div class="form-group">
              <label>Mode</label>
              <div class="mode-toggle">
                <label class="mode-option" :class="{ active: exEditForm.mode === 'structured' }">
                  <input type="radio" v-model="exEditForm.mode" value="structured" />Structured
                </label>
                <label class="mode-option" :class="{ active: exEditForm.mode === 'soql' }">
                  <input type="radio" v-model="exEditForm.mode" value="soql" />Raw SOQL
                </label>
              </div>
            </div>
            <template v-if="exEditForm.mode === 'structured'">
              <div class="form-group">
                <label>Salesforce Object</label>
                <ObjectPicker v-model="exEditForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="exOnObjectChange" @refresh="refreshObjects" />
              </div>
              <div v-if="exLoadingFields" style="display:flex;align-items:center;gap:8px;color:var(--text-muted);"><span class="spinner"></span> Loading fields…</div>
              <template v-else-if="exEditForm.sfObject && exFields.length">
                <div class="field-accordion">
                  <button type="button" class="field-accordion-header" @click="exFieldPickerOpen = !exFieldPickerOpen">
                    <span class="field-accordion-title">Fields</span>
                    <span class="field-accordion-summary">{{ exFieldPickerLabel }}</span>
                    <span class="index-accordion-chevron" :class="{ open: exFieldPickerOpen }">▾</span>
                  </button>
                  <div v-if="exFieldPickerOpen" class="field-accordion-body">
                    <SObjectFieldList :fields="exFields" v-model="exEditForm.fields" v-model:customExpressions="exEditForm.customExpressions" />
                  </div>
                </div>
                <div class="form-group">
                  <label>WHERE Clause (optional)</label>
                  <textarea v-model="exEditForm.whereClause" placeholder="e.g. CreatedDate = TODAY" rows="2" class="where-textarea" />
                </div>
                <div class="form-group" style="flex:0 0 140px;">
                  <label>LIMIT (optional)</label>
                  <input v-model.number="exEditForm.rowLimit" type="number" placeholder="e.g. 10000" />
                </div>
              </template>
            </template>
            <template v-else>
              <div class="form-group">
                <label>SOQL Query</label>
                <textarea v-model="exEditForm.soqlQuery" placeholder="SELECT Id, Name FROM Account WHERE IsActive__c = true" rows="6" class="soql-textarea" spellcheck="false" />
                <div class="field-hint">Column names in the destination table are derived from the field names returned by the first batch of data.</div>
              </div>
            </template>
            <div class="index-accordion" v-if="exEditForm.mode === 'soql' || (exEditForm.sfObject && exFields.length)">
              <button type="button" class="index-accordion-header" @click="exIndexPickerOpen = !exIndexPickerOpen">
                <span class="index-accordion-title">Additional Indexes <span v-if="exEditForm.additionalIndexes.length" class="index-count-badge">{{ exEditForm.additionalIndexes.length }}</span></span>
                <span class="index-accordion-hint">{{ exEditForm.mode === 'structured' ? 'Id and unique/ExternalId fields are indexed automatically' : 'optional' }}</span>
                <span class="index-accordion-chevron" :class="{ open: exIndexPickerOpen }">▾</span>
              </button>
              <div v-if="exIndexPickerOpen" class="index-accordion-body">
                <div class="index-tags" v-if="exEditForm.additionalIndexes.length">
                  <span v-for="col in exEditForm.additionalIndexes" :key="col" class="index-tag">{{ col }}<button class="index-tag-remove" @click="exRemoveIndex(col)">✕</button></span>
                </div>
                <div class="index-input-wrap">
                  <input v-model="exAdditionalIndexInput" type="text" :placeholder="exEditForm.mode === 'structured' ? 'Filter columns…' : 'Type column name and press Enter…'" class="index-input" @keydown.enter.prevent="exAddIndexFromInput" @keydown.escape="exAdditionalIndexInput = ''" />
                  <ul v-if="exEditForm.mode === 'structured'" class="index-suggestions index-suggestions-static">
                    <li v-for="name in exIndexSuggestions" :key="name" @click="exAddIndex(name)">{{ name }}</li>
                    <li v-if="!exIndexSuggestions.length" class="index-suggestions-empty">{{ exAdditionalIndexInput ? 'No matching columns' : 'All columns already added' }}</li>
                  </ul>
                </div>
                <div class="field-hint" v-if="exEditForm.mode !== 'structured'">Press Enter to add each column name. These columns will be indexed after the job runs.</div>
              </div>
            </div>
            <div class="form-row" v-if="exEditForm.mode === 'soql' || (exEditForm.sfObject && exFields.length)">
              <div class="form-group">
                <label>Destination Table</label>
                <input v-model="exEditForm.destTable" type="text" :placeholder="exEditForm.mode === 'soql' ? 'sf_results' : exEditForm.sfObject" />
              </div>
              <div class="form-group" style="flex:0 0 160px;">
                <label>Write Mode</label>
                <select v-model="exEditForm.writeMode"><option value="replace">Replace</option><option value="append">Append</option></select>
              </div>
            </div>
            <div v-if="exSaveError" class="alert alert-error">{{ exSaveError }}</div>
          </div>
        </div>

        <!-- ╔══════════════════════════════════════════════════╗ -->
        <!-- ║  EXTRACT – Selected job (tabs)                   ║ -->
        <!-- ╚══════════════════════════════════════════════════╝ -->
        <div v-else-if="selectedJob?.type === 'extract'" class="job-detail">
          <div class="toolbar">
            <span style="font-weight:600;">{{ exSelectedJobData?.name }}</span>
            <button v-if="!exThisJobIsRunning && !exThisJobIsQueued" class="btn btn-primary btn-sm" :disabled="exExecuting" @click="exExecuteJob">
              <span v-if="exExecuting" class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></span>▶ Execute
            </button>
            <button v-else class="btn btn-danger btn-sm" @click="exCancelRun">■ Cancel</button>
            <div class="toolbar-right">
              <button class="btn btn-ghost btn-sm" @click="exDuplicateSelectedJob">Duplicate</button>
              <button class="btn btn-danger btn-sm" @click="exDeleteSelectedJob">Delete</button>
            </div>
          </div>
          <div class="tab-bar">
            <button class="tab-btn" :class="{ active: exDetailTab === 'definition' }" @click="exDetailTab = 'definition'">Definition</button>
            <button class="tab-btn" :class="{ active: exDetailTab === 'execution' }" @click="exDetailTab = 'execution'">
              Execution
              <span v-if="exThisJobIsRunning" class="spinner" style="width:8px;height:8px;border-width:1.5px;margin-left:4px;display:inline-block;vertical-align:middle;"></span>
              <span v-else-if="exThisJobIsQueued" style="margin-left:4px;font-size:10px;opacity:0.6;">queued</span>
            </button>
            <button class="tab-btn" :class="{ active: exDetailTab === 'history' }" @click="exDetailTab = 'history'">History</button>
          </div>

          <!-- Extract Definition tab -->
          <div v-if="exDetailTab === 'definition'" class="tab-panel definition-panel">
            <div class="form-actions">
              <button class="btn btn-ghost btn-sm" :disabled="exThisJobIsRunning" @click="exOpenRevertDialog">Revert</button>
              <button class="btn btn-secondary btn-sm" :disabled="exSaving || exThisJobIsRunning" @click="exSave(false)">
                <span v-if="exSaving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>Save
              </button>
              <button class="btn btn-secondary btn-sm" style="margin-left:auto;" @click="exClearDestTable">
                Clear table <strong>{{ exSelectedJobData?.destTable }}</strong>
              </button>
              <span v-if="exClearMsg" class="qs-msg" :class="exClearMsgError ? 'qs-msg-error' : 'qs-msg-ok'">{{ exClearMsg }}</span>
            </div>
            <div v-if="exSaveError" class="alert alert-error" style="margin-bottom:8px;">{{ exSaveError }}</div>
            <fieldset :disabled="exThisJobIsRunning" class="definition-fieldset">
            <div class="form-row-h">
              <div class="form-group"><label>Job Name Suffix</label><input v-model="exEditForm.name" type="text" placeholder="extract" /></div>
              <div class="form-group"><label>Comment</label><textarea v-model="exEditForm.comment" rows="2" placeholder="Optional note" class="comment-textarea" /></div>
            </div>
            <div class="form-group">
              <label>Mode</label>
              <div class="mode-toggle">
                <label class="mode-option" :class="{ active: exEditForm.mode === 'structured' }"><input type="radio" v-model="exEditForm.mode" value="structured" />Structured</label>
                <label class="mode-option" :class="{ active: exEditForm.mode === 'soql' }"><input type="radio" v-model="exEditForm.mode" value="soql" />Raw SOQL</label>
              </div>
            </div>
            <template v-if="exEditForm.mode === 'structured'">
              <div class="form-group">
                <label>Salesforce Object</label>
                <ObjectPicker v-model="exEditForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="exOnObjectChange" @refresh="refreshObjects" />
              </div>
              <div v-if="exLoadingFields" style="display:flex;align-items:center;gap:8px;color:var(--text-muted);"><span class="spinner"></span> Loading fields…</div>
              <template v-else-if="exEditForm.sfObject && exFields.length">
                <div class="field-accordion">
                  <button type="button" class="field-accordion-header" @click="exFieldPickerOpen = !exFieldPickerOpen">
                    <span class="field-accordion-title">Fields</span>
                    <span class="field-accordion-summary">{{ exFieldPickerLabel }}</span>
                    <span class="index-accordion-chevron" :class="{ open: exFieldPickerOpen }">▾</span>
                  </button>
                  <div v-if="exFieldPickerOpen" class="field-accordion-body">
                    <SObjectFieldList :fields="exFields" v-model="exEditForm.fields" v-model:customExpressions="exEditForm.customExpressions" />
                  </div>
                </div>
                <div class="form-group"><label>WHERE Clause (optional)</label><textarea v-model="exEditForm.whereClause" placeholder="e.g. CreatedDate = TODAY" rows="2" class="where-textarea" /></div>
                <div class="form-group" style="flex:0 0 140px;"><label>LIMIT (optional)</label><input v-model.number="exEditForm.rowLimit" type="number" placeholder="e.g. 10000" /></div>
              </template>
            </template>
            <template v-else>
              <div class="form-group">
                <label>SOQL Query</label>
                <textarea v-model="exEditForm.soqlQuery" placeholder="SELECT Id, Name FROM Account WHERE IsActive__c = true" rows="6" class="soql-textarea" spellcheck="false" />
                <div class="field-hint">Column names in the destination table are derived from the field names returned by the first batch of data.</div>
              </div>
            </template>
            <div class="index-accordion" v-if="exEditForm.mode === 'soql' || (exEditForm.sfObject && exFields.length)">
              <button type="button" class="index-accordion-header" @click="exIndexPickerOpen = !exIndexPickerOpen">
                <span class="index-accordion-title">Additional Indexes <span v-if="exEditForm.additionalIndexes.length" class="index-count-badge">{{ exEditForm.additionalIndexes.length }}</span></span>
                <span class="index-accordion-hint">{{ exEditForm.mode === 'structured' ? 'Id and unique/ExternalId fields are indexed automatically' : 'optional' }}</span>
                <span class="index-accordion-chevron" :class="{ open: exIndexPickerOpen }">▾</span>
              </button>
              <div v-if="exIndexPickerOpen" class="index-accordion-body">
                <div class="index-tags" v-if="exEditForm.additionalIndexes.length">
                  <span v-for="col in exEditForm.additionalIndexes" :key="col" class="index-tag">{{ col }}<button class="index-tag-remove" @click="exRemoveIndex(col)">✕</button></span>
                </div>
                <div class="index-input-wrap">
                  <input v-model="exAdditionalIndexInput" type="text" :placeholder="exEditForm.mode === 'structured' ? 'Filter columns…' : 'Type column name and press Enter…'" class="index-input" @keydown.enter.prevent="exAddIndexFromInput" @keydown.escape="exAdditionalIndexInput = ''" />
                  <ul v-if="exEditForm.mode === 'structured'" class="index-suggestions index-suggestions-static">
                    <li v-for="name in exIndexSuggestions" :key="name" @click="exAddIndex(name)">{{ name }}</li>
                    <li v-if="!exIndexSuggestions.length" class="index-suggestions-empty">{{ exAdditionalIndexInput ? 'No matching columns' : 'All columns already added' }}</li>
                  </ul>
                </div>
                <div class="field-hint" v-if="exEditForm.mode !== 'structured'">Press Enter to add each column name. These columns will be indexed after the job runs.</div>
              </div>
            </div>
            <div class="form-row" v-if="exEditForm.mode === 'soql' || (exEditForm.sfObject && exFields.length)">
              <div class="form-group"><label>Destination Table</label><input v-model="exEditForm.destTable" type="text" :placeholder="exEditForm.mode === 'soql' ? 'sf_results' : exEditForm.sfObject" /></div>
              <div class="form-group" style="flex:0 0 160px;"><label>Write Mode</label><select v-model="exEditForm.writeMode"><option value="replace">Replace</option><option value="append">Append</option></select></div>
            </div>
            </fieldset>
          </div>

          <!-- Extract History tab -->
          <div v-else-if="exDetailTab === 'history'" class="tab-panel history-panel">
            <div v-if="!exHistory.length" class="empty-state" style="padding:32px 16px;">No runs yet</div>
            <table v-else class="data-table history-table">
              <thead><tr><th>Started</th><th>Status</th><th style="text-align:right;">Rows</th><th style="text-align:right;">Duration</th><th style="text-align:right;">Rows/s</th><th></th></tr></thead>
              <tbody>
                <tr v-for="h in exHistory" :key="h.id">
                  <td style="white-space:nowrap;">{{ formatDate(h.startedAt) }}</td>
                  <td><span class="badge" :class="runStatusBadge(h.status)">{{ h.status }}</span></td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums;">{{ h.rowsLoaded?.toLocaleString() ?? '—' }}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">{{ formatDuration(h.durationMs) }}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums;">{{ h.durationMs && h.rowsLoaded ? Math.round(h.rowsLoaded / (h.durationMs / 1000)).toLocaleString() : '—' }}</td>
                  <td><span v-if="h.errorMsg" class="error-cell" @click.stop="exToggleErrorPopover(h.id, h.errorMsg!, $event)">{{ h.errorMsg.slice(0, 20) }}{{ h.errorMsg.length > 20 ? '…' : '' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Extract Execution tab -->
          <div v-else-if="exDetailTab === 'execution'" class="tab-panel execution-panel">
            <div v-if="exThisJobIsQueued" class="empty-state" style="padding:40px 16px;gap:12px;">
              <div style="font-size:28px;">⏳</div>
              <div style="font-weight:600;">Job is queued</div>
              <div style="color:var(--text-muted);font-size:13px;text-align:center;">
                {{ exActiveRuns.size }} of {{ MAX_PARALLEL }} slots in use.<br>
                Position in queue: {{ exJobQueue.indexOf(exSelectedJobId!) + 1 }}
              </div>
              <button class="btn btn-secondary btn-sm" @click="exCancelRun">Remove from queue</button>
            </div>
            <ProgressPanel
              v-else-if="exDisplayedJobData"
              type="extract"
              :fetched="exDisplayedJobData.fetched"
              :total="exDisplayedJobData.total"
              :rps="exDisplayedJobData.rps"
              :status="exDisplayedJobData.status"
              :errorMsg="exDisplayedJobData.errorMsg"
              :startTime="exSelectedRunStartTime"
            />
            <div v-else class="empty-state" style="padding:32px 16px;">
              <div>No execution yet</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Press ▶ Execute to start a run, or check the History tab for past runs.</div>
            </div>
          </div>

          <!-- Extract error popover -->
          <div v-if="exErrorPopover" class="error-popover" :style="{ top: exErrorPopover.y + 'px', left: exErrorPopover.x + 'px' }" @click.stop>
            <div class="error-popover-header"><span>Error</span><button class="btn-icon" @click="exErrorPopover = null">✕</button></div>
            <div class="error-popover-body">{{ exErrorPopover.msg }}</div>
          </div>
        </div>

        <!-- ╔══════════════════════════════════════════════════╗ -->
        <!-- ║  WRITEBACK – New job form                        ║ -->
        <!-- ╚══════════════════════════════════════════════════╝ -->
        <div v-else-if="creating === 'writeback'" class="job-editor">
          <div class="toolbar">
            <span style="font-weight:600;">New Write-back Job</span>
            <div class="toolbar-right">
              <button class="btn btn-secondary btn-sm" @click="cancelCreating">Cancel</button>
              <button class="btn btn-secondary btn-sm" :disabled="wbSaving" @click="wbSave(false)">
                <span v-if="wbSaving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>Save
              </button>
              <button class="btn btn-primary btn-sm" :disabled="wbSaving" @click="wbSave(true)">Save &amp; Execute</button>
            </div>
          </div>
          <div class="editor-body">
            <div class="form-row-h">
              <div class="form-group"><label>Job Name Suffix</label><input v-model="wbEditForm.name" type="text" placeholder="writeback" /></div>
              <div class="form-group"><label>Comment</label><textarea v-model="wbEditForm.comment" rows="2" placeholder="Optional note" class="comment-textarea" /></div>
            </div>
            <div class="form-group">
              <label>Operation</label>
              <div class="op-selector"><label v-for="op in wbOperations" :key="op" class="radio-label"><input type="radio" :value="op" v-model="wbEditForm.operation" /> {{ op }}</label></div>
            </div>
            <div class="form-group">
              <label>SQL Query (source data)</label>
              <textarea v-model="wbEditForm.sqlQuery" class="sql-query-textarea" placeholder="SELECT Id, Name, Industry FROM Account WHERE BillingCountry = 'FR'" />
              <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;">
                <button class="btn btn-secondary btn-sm" :disabled="wbPreviewLoading" @click="wbRunPreview">
                  <span v-if="wbPreviewLoading" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>Preview (first 50 rows)
                </button>
                <button class="btn btn-secondary btn-sm" :disabled="wbRowCountLoading" @click="wbRunRowCount">
                  <span v-if="wbRowCountLoading" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>Row count
                </button>
                <span v-if="wbRowCountResult !== null" class="row-count-result">{{ wbRowCountResult.toLocaleString() }} rows</span>
                <span v-if="wbRowCountError" class="row-count-error">{{ wbRowCountError }}</span>
              </div>
            </div>
            <div v-if="wbPreviewResult" class="form-group">
              <div style="height:180px;border:1px solid var(--border);border-radius:4px;overflow:hidden;">
                <DataGrid :columns="wbPreviewResult.columns" :rows="wbPreviewResult.rows" />
              </div>
            </div>
            <div v-if="wbPreviewError" class="alert alert-error">{{ wbPreviewError }}</div>
            <div class="form-group"><label>Target Salesforce Object</label><ObjectPicker v-model="wbEditForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="wbOnObjectChange" @refresh="refreshObjects" /></div>
            <template v-if="wbSfFields.length">
              <div class="form-group"><FieldMapper v-model="wbEditForm.fieldMap" :sfFields="wbSfFields" /></div>
              <div v-if="wbEditForm.operation === 'upsert'" class="form-group">
                <label>Use an External ID instead of the record ID</label>
                <select v-model="wbEditForm.externalIdField">
                  <option v-for="f in wbUpsertExtIdFields" :key="f.name" :value="f.name">{{ f.name }}{{ f.label && f.label !== f.name ? ` — ${f.label}` : '' }}</option>
                </select>
              </div>
            </template>
            <div v-else-if="wbEditForm.sfObject" style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Loading field list…</div>
            <div v-if="!wbEditForm.useBulkApi" class="form-row">
              <div class="form-group"><label>Batch Size</label><input v-model.number="wbEditForm.batchSize" type="number" placeholder="200" /></div>
              <div class="form-group"><label>Threads (1–10)</label><input v-model.number="wbEditForm.threads" type="number" min="1" max="10" placeholder="1" /></div>
            </div>
            <div v-if="!wbEditForm.useBulkApi && wbDistribKeyCols.length" class="form-group">
              <label>Distribution Key <span style="font-weight:400;color:var(--text-muted);font-size:11px;"><template v-if="(wbEditForm.threads ?? 1) > 1">(rows with same key always go to the same thread)</template><template v-else>(set Threads > 1 to enable)</template></span></label>
              <div class="distrib-key-input" :class="{ 'distrib-key-list--disabled': (wbEditForm.threads ?? 1) <= 1 }">
                <span v-for="col in (wbEditForm.distributionKey ?? [])" :key="col" class="distrib-key-tag">{{ col }}<button class="distrib-key-tag-remove" @mousedown.prevent="wbToggleDistribKey(col)">×</button></span>
                <input v-model="wbDistribKeySearch" type="text" class="distrib-key-search" placeholder="Add column…" @focus="wbDistribKeyDropdownOpen = true" @blur="wbHideDistribDropdownDelayed" @keydown.escape="wbDistribKeyDropdownOpen = false" />
                <div v-if="wbDistribKeyDropdownOpen && wbDistribKeyOptions.length" class="distrib-key-dropdown">
                  <div v-for="col in wbDistribKeyOptions" :key="col" class="distrib-key-option" @mousedown.prevent="wbSelectDistribKey(col)">{{ col }}</div>
                </div>
              </div>
            </div>
            <div class="form-group checkboxes-group">
              <label class="checkbox-label"><input type="checkbox" v-model="wbEditForm.useBulkApi" /> Use Bulk API 2.0 (for very large datasets)</label>
            </div>
            <div class="form-group">
              <label>Custom Headers <span style="font-weight:400;color:var(--text-muted);font-size:11px;">(JSON — ↓ for presets)</span></label>
              <div class="suggest-wrap">
                <textarea v-model="wbEditForm.customHeaders" rows="3" style="font-family:monospace;font-size:12px;width:100%;" placeholder='{"DuplicateRuleHeader": {"allowSave": true}}' @keydown="wbOnHeadersKeydown" @blur="wbHideSuggestionsDelayed"></textarea>
                <div v-if="wbShowHeaderSuggestions" class="suggest-list">
                  <div v-for="(s, i) in wbHeaderSuggestions" :key="i" class="suggest-item" :class="{ active: wbActiveSuggestion === i }" @mousedown.prevent="wbSelectHeaderSuggestion(i)">
                    <span class="suggest-name">{{ s.label }}</span><span class="suggest-preview">{{ s.preview }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="wbSaveError" class="alert alert-error">{{ wbSaveError }}</div>
          </div>
        </div>

        <!-- ╔══════════════════════════════════════════════════╗ -->
        <!-- ║  WRITEBACK – Selected job (tabs)                 ║ -->
        <!-- ╚══════════════════════════════════════════════════╝ -->
        <div v-else-if="selectedJob?.type === 'writeback'" class="job-detail">
          <div class="toolbar">
            <span style="font-weight:600;margin-right:4px;">{{ wbSelectedJobData?.name }}</span>
            <button v-if="!wbThisJobIsRunning && !wbThisJobIsQueued" class="btn btn-primary btn-sm" :disabled="wbExecuting" @click="wbExecuteJob">
              <span v-if="wbExecuting" class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></span>▶ Execute
            </button>
            <button v-else class="btn btn-danger btn-sm" @click="wbCancelRun">■ Cancel</button>
            <div class="toolbar-right">
              <button class="btn btn-ghost btn-sm" @click="wbDuplicateSelectedJob">Duplicate</button>
              <button class="btn btn-danger btn-sm" @click="wbDeleteSelectedJob">Delete</button>
            </div>
          </div>

          <div class="tab-bar">
            <button class="tab-btn" :class="{ active: wbDetailTab === 'definition' }" @click="wbDetailTab = 'definition'">Definition</button>
            <button class="tab-btn" :class="{ active: wbDetailTab === 'execution' }" @click="wbDetailTab = 'execution'">
              Execution
              <span v-if="wbThisJobIsRunning" class="spinner" style="width:8px;height:8px;border-width:1.5px;margin-left:4px;display:inline-block;vertical-align:middle;"></span>
              <span v-else-if="wbThisJobIsQueued" style="margin-left:4px;font-size:10px;opacity:0.6;">queued</span>
            </button>
            <button class="tab-btn" :class="{ active: wbDetailTab === 'history' }" @click="wbDetailTab = 'history'">History</button>
          </div>

          <!-- WB Definition tab -->
          <div v-if="wbDetailTab === 'definition'" class="tab-panel editor-body">
            <div class="form-actions">
              <button class="btn btn-ghost btn-sm" :disabled="wbThisJobIsRunning" @click="wbOpenRevertDialog">Revert</button>
              <button class="btn btn-secondary btn-sm" :disabled="wbSaving || wbThisJobIsRunning" @click="wbSave(false)">
                <span v-if="wbSaving" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>Save
              </button>
            </div>
            <div v-if="wbSaveError" class="alert alert-error" style="margin-bottom:8px;">{{ wbSaveError }}</div>
            <fieldset :disabled="wbThisJobIsRunning" class="definition-fieldset">
            <div class="form-row-h">
              <div class="form-group"><label>Job Name Suffix</label><input v-model="wbEditForm.name" type="text" placeholder="writeback" /></div>
              <div class="form-group"><label>Comment</label><textarea v-model="wbEditForm.comment" rows="2" placeholder="Optional note" class="comment-textarea" /></div>
            </div>
            <div class="form-group">
              <label>Operation</label>
              <div class="op-selector"><label v-for="op in wbOperations" :key="op" class="radio-label"><input type="radio" :value="op" v-model="wbEditForm.operation" /> {{ op }}</label></div>
            </div>
            <div class="form-group">
              <label>SQL Query (source data)</label>
              <textarea v-model="wbEditForm.sqlQuery" class="sql-query-textarea" placeholder="SELECT Id, Name, Industry FROM Account WHERE BillingCountry = 'FR'" />
              <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;">
                <button class="btn btn-secondary btn-sm" :disabled="wbPreviewLoading" @click="wbRunPreview">
                  <span v-if="wbPreviewLoading" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>Preview (first 50 rows)
                </button>
                <button class="btn btn-secondary btn-sm" :disabled="wbRowCountLoading" @click="wbRunRowCount">
                  <span v-if="wbRowCountLoading" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>Row count
                </button>
                <span v-if="wbRowCountResult !== null" class="row-count-result">{{ wbRowCountResult.toLocaleString() }} rows</span>
                <span v-if="wbRowCountError" class="row-count-error">{{ wbRowCountError }}</span>
              </div>
            </div>
            <div v-if="wbPreviewResult" class="form-group">
              <div style="height:180px;border:1px solid var(--border);border-radius:4px;overflow:hidden;">
                <DataGrid :columns="wbPreviewResult.columns" :rows="wbPreviewResult.rows" />
              </div>
            </div>
            <div v-if="wbPreviewError" class="alert alert-error">{{ wbPreviewError }}</div>
            <div class="form-group"><label>Target Salesforce Object</label><ObjectPicker v-model="wbEditForm.sfObject" :objects="conn.sfObjects" :refreshing="sfRefreshing" @update:modelValue="wbOnObjectChange" @refresh="refreshObjects" /></div>
            <template v-if="wbSfFields.length">
              <div class="form-group"><FieldMapper v-model="wbEditForm.fieldMap" :sfFields="wbSfFields" /></div>
              <div v-if="wbEditForm.operation === 'upsert'" class="form-group">
                <label>Use an External ID instead of the record ID</label>
                <select v-model="wbEditForm.externalIdField">
                  <option v-for="f in wbUpsertExtIdFields" :key="f.name" :value="f.name">{{ f.name }}{{ f.label && f.label !== f.name ? ` — ${f.label}` : '' }}</option>
                </select>
              </div>
            </template>
            <div v-else-if="wbEditForm.sfObject" style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Loading field list…</div>
            <div v-if="!wbEditForm.useBulkApi" class="form-row">
              <div class="form-group"><label>Batch Size</label><input v-model.number="wbEditForm.batchSize" type="number" placeholder="200" /></div>
              <div class="form-group"><label>Threads (1–10)</label><input v-model.number="wbEditForm.threads" type="number" min="1" max="10" placeholder="1" /></div>
            </div>
            <div v-if="!wbEditForm.useBulkApi && wbDistribKeyCols.length" class="form-group">
              <label>Distribution Key <span style="font-weight:400;color:var(--text-muted);font-size:11px;"><template v-if="(wbEditForm.threads ?? 1) > 1">(rows with same key always go to the same thread)</template><template v-else>(set Threads > 1 to enable)</template></span></label>
              <div class="distrib-key-input" :class="{ 'distrib-key-list--disabled': (wbEditForm.threads ?? 1) <= 1 }">
                <span v-for="col in (wbEditForm.distributionKey ?? [])" :key="col" class="distrib-key-tag">{{ col }}<button class="distrib-key-tag-remove" @mousedown.prevent="wbToggleDistribKey(col)">×</button></span>
                <input v-model="wbDistribKeySearch" type="text" class="distrib-key-search" placeholder="Add column…" @focus="wbDistribKeyDropdownOpen = true" @blur="wbHideDistribDropdownDelayed" @keydown.escape="wbDistribKeyDropdownOpen = false" />
                <div v-if="wbDistribKeyDropdownOpen && wbDistribKeyOptions.length" class="distrib-key-dropdown">
                  <div v-for="col in wbDistribKeyOptions" :key="col" class="distrib-key-option" @mousedown.prevent="wbSelectDistribKey(col)">{{ col }}</div>
                </div>
              </div>
              <p v-if="(wbEditForm.threads ?? 1) > 1 && wbEditForm.distributionKey?.length" class="distrib-key-hint">
                Tip: consider adding <code>ORDER BY</code> to the query, so that rows with the same distribution key are <strong>not</strong> clustered together.
              </p>
            </div>
            <div class="form-group checkboxes-group">
              <label class="checkbox-label"><input type="checkbox" v-model="wbEditForm.useBulkApi" /> Use Bulk API 2.0 (for very large datasets)</label>
            </div>
            <div class="form-group">
              <label>Custom Headers <span style="font-weight:400;color:var(--text-muted);font-size:11px;">(JSON — ↓ for presets)</span></label>
              <div class="suggest-wrap">
                <textarea v-model="wbEditForm.customHeaders" rows="3" style="font-family:monospace;font-size:12px;width:100%;" placeholder='{"DuplicateRuleHeader": {"allowSave": true}}' @keydown="wbOnHeadersKeydown" @blur="wbHideSuggestionsDelayed"></textarea>
                <div v-if="wbShowHeaderSuggestions" class="suggest-list">
                  <div v-for="(s, i) in wbHeaderSuggestions" :key="i" class="suggest-item" :class="{ active: wbActiveSuggestion === i }" @mousedown.prevent="wbSelectHeaderSuggestion(i)">
                    <span class="suggest-name">{{ s.label }}</span><span class="suggest-preview">{{ s.preview }}</span>
                  </div>
                </div>
              </div>
            </div>
            </fieldset>
          </div>

          <!-- WB History tab -->
          <div v-else-if="wbDetailTab === 'history'" class="tab-panel history-section">
            <div v-if="!wbHistory.length" class="empty-state" style="padding:32px 16px;">No runs yet</div>
            <table v-else class="data-table">
              <thead><tr><th>Started</th><th>Status</th><th>API</th><th>Sent</th><th>✓ OK</th><th>✗ Failed</th><th style="text-align:right;">Duration</th><th style="text-align:right;">Rows/s</th></tr></thead>
              <tbody>
                <tr v-for="h in wbHistory" :key="h.id">
                  <td>{{ formatDate(h.startedAt) }}</td>
                  <td><span class="badge" :class="runStatusBadge(h.status)">{{ h.status }}</span></td>
                  <td><span class="badge" :class="h.useBulkApi ? 'badge-bulk' : 'badge-rest'">{{ h.useBulkApi ? 'Bulk 2.0' : 'REST' }}</span></td>
                  <td>{{ h.rowsSent?.toLocaleString() ?? '—' }}</td>
                  <td>{{ h.rowsSucceeded?.toLocaleString() ?? '—' }}</td>
                  <td style="color:var(--danger)">{{ h.rowsFailed ? h.rowsFailed.toLocaleString() : '—' }}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">{{ formatDuration(h.durationMs) }}</td>
                  <td style="text-align:right;font-variant-numeric:tabular-nums;">{{ h.durationMs && h.rowsSent ? Math.round(h.rowsSent / (h.durationMs / 1000)).toLocaleString() : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- WB Execution tab -->
          <div v-else-if="wbDetailTab === 'execution'" class="tab-panel execution-section">
            <div v-if="wbThisJobIsQueued" class="empty-state" style="padding:40px 16px;gap:12px;">
              <div style="font-size:28px;">⏳</div>
              <div style="font-weight:600;">Job is queued</div>
              <div style="color:var(--text-muted);font-size:13px;text-align:center;">
                {{ wbActiveRuns.size }} of {{ MAX_PARALLEL }} slots in use.<br>
                Position in queue: {{ wbJobQueue.indexOf(wbSelectedJobId!) + 1 }}
              </div>
              <button class="btn btn-secondary btn-sm" @click="wbCancelRun">Remove from queue</button>
            </div>
            <div v-else-if="execError" class="exec-banner exec-banner-error">
              <span style="font-weight:600;">Job failed</span>
              <span style="white-space:pre-wrap;">{{ execError }}</span>
              <button class="btn btn-ghost btn-sm" style="margin-left:auto;flex-shrink:0;" @click="wbClearExecState">Dismiss</button>
            </div>
            <div v-else-if="execWarn" class="exec-banner exec-banner-warn">
              <span style="white-space:pre-wrap;">{{ execWarn }}</span>
              <button class="btn btn-ghost btn-sm" style="margin-left:auto;flex-shrink:0;" @click="execWarn = null">Dismiss</button>
            </div>
            <template v-if="!wbThisJobIsQueued && execIsBulkApi && !(execJobDone && wbFailedCount > 0)">
              <div v-if="!wbThisJobIsRunning && !execJobDone && !execError" class="empty-state" style="padding:32px 16px;">No execution data yet — click ▶ Execute to run this job.</div>
              <div v-else-if="wbThisJobIsRunning" class="bulk-phase-card">
                <div class="bulk-phase-row">
                  <span class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></span>
                  <template v-if="execBulkPhase === 'uploading'">Uploading to Salesforce… <strong>{{ execBulkUploaded.toLocaleString() }}</strong> rows sent</template>
                  <template v-else-if="execBulkPhase === 'processing'">Salesforce processing <span class="badge badge-gray" style="font-size:11px;">{{ execBulkJobState }}</span> — <strong>{{ execBulkProcessed.toLocaleString() }}</strong> / <strong>{{ execBulkUploaded.toLocaleString() }}</strong> processed, <span style="color:var(--danger);">{{ execFailed.toLocaleString() }}</span> failed</template>
                  <template v-else-if="execBulkPhase === 'downloading'">Downloading results from Salesforce…</template>
                  <template v-else>Starting Bulk API 2.0 job…</template>
                </div>
                <button class="btn btn-danger btn-sm" style="margin-top:12px;" @click="wbCancelRun">Cancel</button>
              </div>
              <template v-else-if="execJobDone">
                <div class="exec-stats">
                  <span><strong>{{ wbTotalRows.toLocaleString() }}</strong> rows</span>
                  <span style="color:var(--success);">✓ {{ wbSucceededCount.toLocaleString() }} succeeded</span>
                  <span style="color:var(--danger);">✗ {{ wbFailedCount.toLocaleString() }} failed</span>
                  <button class="btn btn-ghost btn-sm" style="margin-left:auto;" @click="wbClearExecState">Clear</button>
                </div>
              </template>
            </template>
            <template v-else-if="!wbThisJobIsQueued">
              <!-- No run yet -->
              <div v-if="!wbThisJobIsRunning && !execLoadingPhase && !wbTotalRows && !execJobDone && !execError" class="empty-state" style="padding:32px 16px;">No execution data yet — click ▶ Execute to run this job.</div>
              <template v-else>
                <!-- Row 1: status text (left) + pills (right, flushed) + Cancel button -->
                <div class="exec-phase-bar">
                  <div class="bulk-phase-row">
                    <template v-if="execLoadingPhase">
                      <span class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></span>
                      Loading source data into execution table…
                    </template>
                    <template v-else-if="execIsBulkApi && execJobDone">
                      Processed: <strong>{{ wbSucceededCount.toLocaleString() }}</strong> succeeded, <strong style="color:var(--danger);">{{ wbFailedCount.toLocaleString() }}</strong> failed — showing failed rows
                    </template>
                    <template v-else-if="wbTotalRows > 0">
                      <span v-if="wbThisJobIsRunning" class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></span>
                      {{ wbThisJobIsRunning ? 'Processing' : 'Processed' }} <strong>{{ (wbThisJobIsRunning ? wbTotalRows : (wbSucceededCount + wbFailedCount)).toLocaleString() }}</strong>
                      rows<template v-if="execInFlight > 0 && wbThisJobIsRunning">, <strong>{{ execInFlight.toLocaleString() }}</strong> in flight</template>
                      <template v-if="execRowsPerSec > 0">, <strong>{{ execRowsPerSec.toLocaleString() }}</strong> rows/sec</template>
                    </template>
                  </div>
                  <div v-if="wbTotalRows > 0 && !execIsBulkApi" class="exec-status-filter" style="margin-left:auto;">
                    <button class="exec-filter-pill" :class="{ active: wbAllFiltersOn }" @click="execFilterSuccess = execFilterError = execFilterPending = execFilterQueued = true; failedErrorFilter = ''">All <span class="exec-filter-count">{{ wbTotalRows.toLocaleString() }}</span></button>
                    <button class="exec-filter-pill" :class="{ active: execFilterSuccess, 'exec-filter-pill--ok': true }" @click="execFilterSuccess = !execFilterSuccess">✓ OK <span class="exec-filter-count">{{ wbSucceededCount.toLocaleString() }}</span></button>
                    <button class="exec-filter-pill" :class="{ active: execFilterError, 'exec-filter-pill--error': true }" @click="execFilterError = !execFilterError">✗ Error <span class="exec-filter-count">{{ wbFailedCount.toLocaleString() }}</span></button>
                    <button class="exec-filter-pill" :class="{ active: execFilterQueued, 'exec-filter-pill--queued': true }" @click="execFilterQueued = !execFilterQueued">◷ Queued <span class="exec-filter-count">{{ wbQueuedCount.toLocaleString() }}</span></button>
                  </div>
                  <button v-if="wbThisJobIsRunning" class="btn btn-danger btn-sm" @click="wbCancelRun">Cancel</button>
                </div>
                <!-- Row 2: error-type filter + Retry (after job) + Clear (after job) -->
                <div v-if="wbFailedCount > 0 || execJobDone" class="exec-error-bar">
                  <select v-if="wbDistinctErrors.length >= 1" v-model="failedErrorFilter" class="error-filter-select error-filter-inline">
                    <option value="">All error types</option>
                    <option v-for="err in wbDistinctErrors" :key="err" :value="err">{{ err.length > 60 ? err.slice(0, 60) + '…' : err }} ({{ wbErrorCounts.get(err) ?? 0 }})</option>
                  </select>
                  <button v-if="execJobDone && !wbThisJobIsRunning && wbFailedCount > 0" class="btn btn-secondary btn-sm" @click="wbRetryFailed">Retry Failed</button>
                  <button v-if="execJobDone && !wbThisJobIsRunning" class="btn btn-ghost btn-sm" style="margin-left:auto;" @click="wbClearExecState">Clear</button>
                </div>
                <!-- DataGrid -->
                <div style="flex:1;overflow:hidden;">
                  <DataGrid
                    :columns="wbExecVisibleCols"
                    :rows="wbVisibleExecRows"
                    :rowNumbers="wbVisibleExecRowNumbers"
                    :showRowNumbers="true"
                    :totalRowCount="wbEffectiveTotalCount"
                    :onPageChange="wbEffectiveTotalCount > EXEC_PAGE ? (off) => wbLoadExecPage(off) : undefined"
                    :externalOffset="execPageOffset"
                    :pageSize="EXEC_PAGE"
                    :onCopyAllRows="wbCopyAllExecRows"
                  />
                </div>
              </template>
            </template>
          </div>
        </div>
      </div><!-- /.split-right -->

      <!-- Schema panel (writeback only) -->
      <div v-if="selectedJob?.type === 'writeback' || creating === 'writeback'" class="wb-schema-panel" ref="schemaPanel">
        <div class="schema-resize-handle" @mousedown="wbStartSchemaResize"></div>
        <div class="schema-tabs">
          <button class="schema-tab" :class="{ active: schemaTab === 'sqlite' }" @click="schemaTab = 'sqlite'">SQLite</button>
          <button class="schema-tab" :class="{ active: schemaTab === 'sf' }" @click="schemaTab = 'sf'">Salesforce</button>
        </div>
        <SchemaBrowser v-show="schemaTab === 'sqlite'" :tables="conn.dbTables" @insert="() => {}" @openExplorer="() => $router.push('/explorer')" />
        <SFSchemaBrowser v-show="schemaTab === 'sf'" :objects="conn.sfObjects" @insert="() => {}" />
      </div>
    </div><!-- /.right panel + schema -->
  </div>

  <div v-else class="empty-state" style="height:100%;">
    <div class="empty-state-icon">🔌</div>
    <div>Connect to both Salesforce and a SQLite database first</div>
    <router-link to="/connections" class="btn btn-primary btn-sm">Go to Connections</router-link>
  </div>

  <!-- ── Revert-to-saved confirmation modal ─────────────────────────────── -->
  <Teleport to="body">
    <div v-if="revertDialog" class="modal-backdrop" @click.self="revertDialog = null">
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">Revert to saved version?</span>
          <button class="btn btn-ghost btn-sm" @click="revertDialog = null">✕</button>
        </div>
        <div class="modal-body">
          <p>
            This discards any changes made to <strong>{{ revertDialog.name }}</strong> since it was last saved on
            <strong>{{ formatDate(revertDialog.savedAt) }}</strong>, reloading the job definition from that saved version.
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary btn-sm" @click="revertDialog = null">Cancel</button>
          <button class="btn btn-danger btn-sm" @click="confirmRevert">Revert</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ── "Update table with created record IDs" modal ─────────────────── -->
  <Teleport to="body">
    <div v-if="wbUpdateIdsOpen" class="modal-backdrop" @click.self="wbUpdateIdsOpen = false">
      <div class="modal-box update-ids-modal">
        <div class="modal-header">
          <span class="modal-title">Update table with created record IDs</span>
          <button class="btn btn-ghost btn-sm" @click="wbUpdateIdsOpen = false">✕</button>
        </div>
        <template v-if="wbUpdateIdsResult">
          <div class="modal-body" style="gap:12px;">
            <div class="update-ids-success">
              <span style="font-size:22px;">✓</span>
              <div style="display:flex;flex-direction:column;gap:4px;">
                <div style="font-weight:600;font-size:14px;">Updated {{ wbUpdateIdsResult.updated.toLocaleString() }} rows</div>
                <div v-if="wbUpdateIdsResult.idColCreated" style="font-size:12px;color:var(--text-muted);">Column <code>{{ wbUpdateIdsIdColName }}</code> was added to <code>{{ wbUpdateIdsTargetTable }}</code>.</div>
                <div v-if="wbUpdateIdsResult.indexCreated" style="font-size:12px;color:var(--text-muted);">Index created on <code>{{ wbUpdateIdsTableKeyCol }}</code> in <code>{{ wbUpdateIdsTargetTable }}</code>.</div>
              </div>
            </div>
          </div>
          <div class="modal-footer"><button class="btn btn-primary btn-sm" @click="wbUpdateIdsOpen = false">Done</button></div>
        </template>
        <template v-else-if="wbUpdateIdsKeyFields.length === 0">
          <div class="modal-body"><div class="update-ids-error" style="background:color-mix(in srgb, var(--warning,#f59e0b) 12%, var(--surface));color:var(--text);border-color:color-mix(in srgb, var(--warning,#f59e0b) 25%, var(--border));">No unique or External ID fields were detected among the mapped columns for this insert job.</div></div>
          <div class="modal-footer"><button class="btn btn-secondary btn-sm" @click="wbUpdateIdsOpen = false">Close</button></div>
        </template>
        <template v-else>
          <div class="modal-body">
            <div v-if="wbUpdateIdsKeyFields.length > 1" class="form-row">
              <label class="form-label">Key field <span class="form-hint">(unique / External ID field used as the lookup key)</span></label>
              <select v-model="wbUpdateIdsSfKeyField" class="form-select">
                <option v-for="f in wbUpdateIdsKeyFields" :key="f.sfField" :value="f.sfField">{{ f.label }} ({{ f.sfField }}) — {{ f.valueCount.toLocaleString() }} values stored</option>
              </select>
            </div>
            <div v-else class="update-ids-info">Key field: <strong>{{ wbUpdateIdsKeyFields[0]?.label }}</strong> <span style="color:var(--text-muted);">({{ wbUpdateIdsKeyFields[0]?.sfField }})</span> — {{ wbUpdateIdsKeyFields[0]?.valueCount.toLocaleString() }} values stored</div>
            <div class="form-row">
              <label class="form-label">Target table</label>
              <select v-model="wbUpdateIdsTargetTable" class="form-select">
                <option value="">— select a table —</option>
                <option v-for="t in wbUpdateIdsTables" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>
            <div v-if="wbUpdateIdsTargetTable" class="form-row">
              <label class="form-label">Key column in table <span class="form-hint">(column whose values match the key field above)</span></label>
              <select v-model="wbUpdateIdsTableKeyCol" class="form-select">
                <option value="">— select a column —</option>
                <option v-for="c in wbUpdateIdsTableCols" :key="c" :value="c">{{ c }}</option>
              </select>
              <div v-if="wbUpdateIdsTableKeyCol && wbUpdateIdsKeyColNeedsIndex" class="update-ids-index-note">⚡ No index found on <strong>{{ wbUpdateIdsTableKeyCol }}</strong> — one will be created automatically.</div>
            </div>
            <div v-if="wbUpdateIdsTargetTable" class="form-row">
              <label class="form-label">ID column name <span class="form-hint">(will be created if missing)</span></label>
              <input v-model="wbUpdateIdsIdColName" class="form-input" placeholder="Id" />
            </div>
            <div v-if="wbUpdateIdsTargetTable && wbUpdateIdsTableKeyCol && wbUpdateIdsSfKeyField" class="update-ids-preview">
              Will set <strong>{{ wbUpdateIdsIdColName || 'Id' }}</strong> = Salesforce ID in <strong>{{ wbUpdateIdsTargetTable }}</strong> where <strong>{{ wbUpdateIdsTableKeyCol }}</strong> matches <strong>{{ wbUpdateIdsSfKeyField }}</strong>.
            </div>
            <div v-if="wbUpdateIdsError" class="update-ids-error">{{ wbUpdateIdsError }}</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary btn-sm" @click="wbUpdateIdsOpen = false">Cancel</button>
            <button class="btn btn-primary btn-sm" :disabled="wbUpdateIdsLoading || !wbUpdateIdsSfKeyField || !wbUpdateIdsTableKeyCol || !wbUpdateIdsTargetTable" @click="wbConfirmUpdateIds">
              <span v-if="wbUpdateIdsLoading">Updating…</span><span v-else>Update with IDs</span>
            </button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>

  <!-- ── Comment popup ──────────────────────────────────────────────────── -->
  <Teleport to="body">
    <template v-if="commentPopup">
      <div class="comment-overlay" @click.prevent.stop="commentPopup = null" @wheel.prevent.stop="commentPopup = null" />
      <div
        class="comment-popup"
        :style="{
          left: commentPopup.left + 'px',
          ...(commentPopup.top !== null ? { top: commentPopup.top + 'px' } : { bottom: commentPopup.bottom + 'px' })
        }"
        @click.stop
      >{{ commentPopup.comment }}</div>
    </template>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onDeactivated, onUnmounted, nextTick, toRaw } from 'vue'
import { useUiPrefs } from '../composables/useUiPrefs'
import { useConnectionStore } from '../stores/connection'
import { useJobStore } from '../stores/job'
import { registerQuitHandler } from '../composables/useQuitHandlers'
import ObjectPicker from '../components/ObjectPicker.vue'
import SObjectFieldList from '../components/SObjectFieldList.vue'
import FieldMapper from '../components/FieldMapper.vue'
import DataGrid from '../components/DataGrid.vue'
import SchemaBrowser from '../components/SchemaBrowser.vue'
import SFSchemaBrowser from '../components/SFSchemaBrowser.vue'
import ProgressPanel from '../components/ProgressPanel.vue'
import type {
  ExtractJob, ExtractJobInput, WritebackJob, WritebackJobInput,
  FieldDescriptor, FieldMapping,
  RunHistoryEntry, WritebackRunEntry,
  SortCriterion
} from '../../../shared/types'

const conn = useConnectionStore()
const jobs = useJobStore()
const uiPrefs = useUiPrefs()

// ── Shared state ─────────────────────────────────────────────────────────────
const sfRefreshing = ref(false)
async function refreshObjects(): Promise<void> {
  sfRefreshing.value = true
  try { await conn.refreshSFObjects() } finally { sfRefreshing.value = false }
}

const search = ref('')
const newJobMenuOpen = ref(false)
const MAX_PARALLEL = 5

// Unified selection: which job is selected (type + id)
interface SelectedJob { id: number; type: 'extract' | 'writeback' }
const selectedJob = ref<SelectedJob | null>(null)
// Which type of new job is being created (null = not creating)
const creating = ref<'extract' | 'writeback' | null>(null)

// ── Draft auto-save (existing jobs only — see exFlushDraft/wbFlushDraft) ──────
const IDLE_DRAFT_MS = 5_000
interface RevertDialog { type: 'extract' | 'writeback'; id: number; name: string; savedAt: string }
const revertDialog = ref<RevertDialog | null>(null)

/** Flushes the currently-selected job's draft (if any) — called whenever focus leaves it. */
async function flushSelectedJobDraft(): Promise<void> {
  const sel = selectedJob.value
  if (!sel) return
  if (sel.type === 'extract') await exFlushDraft(sel.id)
  else await wbFlushDraft(sel.id)
}

/** Discards the draft and reloads the form from the last explicitly-saved version. */
async function confirmRevert(): Promise<void> {
  const dlg = revertDialog.value
  if (!dlg) return
  revertDialog.value = null
  if (dlg.type === 'extract') {
    const job = await window.api.clearExtractJobDraft(dlg.id)
    exApplyDraftResult(job)
    if (exSelectedJobId.value === dlg.id) { exSyncEditForm(job); exSaveError.value = '' }
  } else {
    const job = await window.api.clearWritebackJobDraft(dlg.id)
    wbApplyDraftResult(job)
    if (wbSelectedJobId.value === dlg.id) { wbLoadJobIntoForm(job); wbSaveError.value = '' }
  }
}

// Resizable split
const SPLIT_KEY = 'jobs-split-pct'
const splitPct = ref<number>(Number(localStorage.getItem(SPLIT_KEY)) || 28)
const splitContainer = ref<HTMLElement | null>(null)

function startDrag(e: MouseEvent): void {
  const container = splitContainer.value
  if (!container) return
  const onMove = (ev: MouseEvent): void => {
    const rect = container.getBoundingClientRect()
    splitPct.value = Math.min(80, Math.max(15, ((ev.clientX - rect.left) / rect.width) * 100))
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(SPLIT_KEY, String(Math.round(splitPct.value * 10) / 10))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── Unified left panel list entry ─────────────────────────────────────────────
interface ListEntry {
  id: number
  type: 'extract' | 'writeback'
  name: string
  /** One-line detail shown below the name when uiPrefs.showJobDetails is on. */
  subtitle: string
  /** Raw SF object name (or 'SOQL') used for sorting. */
  sortObject: string
  /** Raw job name as entered by the user, used for sorting. */
  sortName: string
  /** Optional user comment, shown in the row when hovering. */
  comment: string | null
  /** Writeback jobs only: DML operation, shown as a second icon next to the arrow. */
  operation?: WritebackJob['operation']
}

const filteredJobs = computed((): ListEntry[] => {
  const q = search.value.toLowerCase()
  const exEntries: ListEntry[] = exJobs.value
    .filter((j) => !q || j.name.toLowerCase().includes(q) || j.sfObject.toLowerCase().includes(q) || (j.soqlQuery ?? '').toLowerCase().includes(q))
    .map((j): ListEntry => ({
      id: j.id,
      type: 'extract',
      name: j.soqlQuery
        ? (j.name ? `SOQL: ${j.name}` : 'SOQL')
        : (j.name ? `${j.sfObject}: ${j.name}` : j.sfObject),
      subtitle: j.soqlQuery
        ? `SOQL → ${j.destTable || 'sf_results'}`
        : `${j.sfObject} → ${j.destTable || j.sfObject}`,
      sortObject: j.soqlQuery ? 'SOQL' : j.sfObject,
      sortName: j.name,
      comment: j.comment
    }))
  const wbEntries: ListEntry[] = wbJobs.value
    .filter((j) => !q || j.name.toLowerCase().includes(q) || j.sfObject.toLowerCase().includes(q) || j.sqlQuery.toLowerCase().includes(q))
    .map((j): ListEntry => ({
      id: j.id,
      type: 'writeback',
      name: j.name ? `${j.sfObject}: ${j.name}` : j.sfObject,
      subtitle: `${j.sfObject}  ${j.operation}`,
      sortObject: j.sfObject,
      sortName: j.name,
      comment: j.comment,
      operation: j.operation
    }))
  return [...exEntries, ...wbEntries].sort((a, b) => {
    // 1) SF object name
    const objCmp = a.sortObject.localeCompare(b.sortObject, undefined, { sensitivity: 'base' })
    if (objCmp !== 0) return objCmp
    // 2) Extract before writeback
    if (a.type !== b.type) return a.type === 'extract' ? -1 : 1
    // 3) Job name (as entered by the user)
    return a.sortName.localeCompare(b.sortName, undefined, { sensitivity: 'base' })
  })
})

function isEntryRunning(e: ListEntry): boolean {
  return e.type === 'extract' ? exActiveRuns.value.has(e.id) : wbActiveRuns.value.has(e.id)
}
function isEntryQueued(e: ListEntry): boolean {
  return e.type === 'extract' ? exJobQueue.value.includes(e.id) : wbJobQueue.value.includes(e.id)
}
function entryLastRun(e: ListEntry): RunHistoryEntry | WritebackRunEntry | undefined {
  if (e.type === 'extract') return (exHistoryMap.value.get(e.id) ?? [])[0]
  return (wbHistoryMap.value.get(e.id) ?? [])[0]
}
function entryRowCount(e: ListEntry): number | null | undefined {
  const run = entryLastRun(e)
  if (!run) return undefined
  if (e.type === 'extract') return (run as RunHistoryEntry).rowsLoaded
  return (run as WritebackRunEntry).rowsSent
}

async function selectEntry(e: ListEntry): Promise<void> {
  if (e.type === 'extract') {
    await exSelectJob(e.id)
  } else {
    await wbSelectJob(e.id)
  }
  creating.value = null
}

function runEntry(e: ListEntry): void {
  if (e.type === 'extract') {
    exSelectJob(e.id).then(() => exExecuteJobById(e.id))
  } else {
    wbSelectJob(e.id).then(() => wbExecuteJobById(e.id))
  }
}

function startNewExtractJob(): void {
  newJobMenuOpen.value = false
  void flushSelectedJobDraft()
  selectedJob.value = null
  creating.value = 'extract'
  exEditForm.value = { name: '', comment: '', mode: 'structured', sfObject: '', fields: [], customExpressions: [], whereClause: '', rowLimit: null, destTable: '', writeMode: 'replace', soqlQuery: '', additionalIndexes: [] }
  exFields.value = []
  exSaveError.value = ''
}

function startNewWbJob(): void {
  newJobMenuOpen.value = false
  void flushSelectedJobDraft()
  selectedJob.value = null
  creating.value = 'writeback'
  wbEditForm.value = { name: '', comment: '', sqlQuery: '', sfObject: '', operation: 'insert', fieldMap: [], externalIdField: 'Id', batchSize: null, threads: null, distributionKey: null, useBulkApi: false, customHeaders: '' }
  wbPreviewResult.value = null
  wbPreviewError.value = ''
  wbRowCountResult.value = null
  wbRowCountError.value = ''
  wbSaveError.value = ''
  wbSfFields.value = []
}

function cancelCreating(): void {
  creating.value = null
  // Restore previous selection if any jobs exist
  const firstEntry = filteredJobs.value[0]
  if (firstEntry) {
    selectEntry(firstEntry)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ─── EXTRACT state & functions ───────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

const exJobs = ref<ExtractJob[]>([])
const exHistoryMap = ref<Map<number, RunHistoryEntry[]>>(new Map())
const exActiveRuns = ref<Map<number, string>>(new Map())
const exJobQueue = ref<number[]>([])
const exLastRunIds = ref<Map<number, string>>(new Map())
const exRunStartTimes = ref<Map<number, number>>(new Map())
const exDetailTab = ref<'definition' | 'history' | 'execution'>('definition')
const exSaving = ref(false)
const exExecuting = ref(false)
const exSaveError = ref('')
const exLoadingFields = ref(false)
const exFields = ref<FieldDescriptor[]>([])
const exClearMsg = ref('')
const exClearMsgError = ref(false)
const exFieldPickerOpen = ref(false)
const exAdditionalIndexInput = ref('')
const exIndexPickerOpen = ref(false)
const exErrorPopover = ref<{ id: number; msg: string; x: number; y: number } | null>(null)

// ── Comment popup ─────────────────────────────────────────────────────────────
interface CommentPopup { comment: string; left: number; top: number | null; bottom: number | null }
const commentPopup = ref<CommentPopup | null>(null)

function openCommentPopup(entry: ListEntry, e: MouseEvent): void {
  if (!entry.comment) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const flipUp = window.innerHeight - rect.bottom < 120
  commentPopup.value = {
    comment: entry.comment,
    left: rect.left,
    top: flipUp ? null : rect.bottom + 6,
    bottom: flipUp ? window.innerHeight - rect.top + 6 : null
  }
}

interface ExEditForm {
  id?: number
  name: string
  comment: string
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
const exEditForm = ref<ExEditForm>({
  name: '', comment: '', mode: 'structured', sfObject: '', fields: [], customExpressions: [], whereClause: '', rowLimit: null, destTable: '', writeMode: 'replace', soqlQuery: '', additionalIndexes: []
})

const exSelectedJobId = computed(() => selectedJob.value?.type === 'extract' ? selectedJob.value.id : null)
const exSelectedJobData = computed(() => exJobs.value.find((j) => j.id === exSelectedJobId.value))
const exHistory = computed(() => exHistoryMap.value.get(exSelectedJobId.value ?? -1) ?? [])
const exThisJobIsRunning = computed(() => exSelectedJobId.value != null && exActiveRuns.value.has(exSelectedJobId.value))
const exThisJobIsQueued = computed(() => exSelectedJobId.value != null && exJobQueue.value.includes(exSelectedJobId.value))
const exSelectedRunId = computed(() => exSelectedJobId.value != null ? exActiveRuns.value.get(exSelectedJobId.value) : undefined)
const exActiveJobData = computed(() => exSelectedRunId.value ? jobs.getJob(exSelectedRunId.value) : undefined)
const exLastRunId = computed(() => exSelectedJobId.value != null ? exLastRunIds.value.get(exSelectedJobId.value) : undefined)
const exLastJobData = computed(() => exLastRunId.value ? jobs.getJob(exLastRunId.value) : undefined)
const exDisplayedJobData = computed(() => exActiveJobData.value ?? exLastJobData.value)
const exSelectedRunStartTime = computed(() => exSelectedJobId.value != null ? (exRunStartTimes.value.get(exSelectedJobId.value) ?? 0) : 0)

const exFieldPickerLabel = computed(() => {
  const total = exFields.value.length
  const sel = exEditForm.value.fields.length
  const custom = exEditForm.value.customExpressions.length
  const customSuffix = custom ? ` + ${custom} custom` : ''
  if (!total) return 'Fields'
  if (sel === total && !custom) return `All ${total} fields selected`
  if (sel === 0 && !custom) return `0 of ${total} fields selected`
  return `${sel}${customSuffix} of ${total} selected`
})

const exIndexSuggestions = computed((): string[] => {
  const q = exAdditionalIndexInput.value.toLowerCase()
  const already = exEditForm.value.additionalIndexes
  const fromFields = exFields.value.map((f) => f.name).filter((name) => !already.includes(name) && (!q || name.toLowerCase().includes(q)))
  const fromCustom = exEditForm.value.customExpressions.filter((e) => !already.includes(e) && (!q || e.toLowerCase().includes(q)))
  return [...fromFields, ...fromCustom]
})

function exAddIndex(col: string): void {
  const name = col.trim()
  if (name && !exEditForm.value.additionalIndexes.includes(name)) exEditForm.value.additionalIndexes.push(name)
  exAdditionalIndexInput.value = ''
}
function exAddIndexFromInput(): void {
  const q = exAdditionalIndexInput.value.trim()
  if (!q) return
  if (exEditForm.value.mode === 'structured') {
    const exact = exIndexSuggestions.value.find((name) => name.toLowerCase() === q.toLowerCase())
    if (exact) { exAddIndex(exact); return }
    if (exIndexSuggestions.value.length === 1) { exAddIndex(exIndexSuggestions.value[0]); return }
  }
  exAddIndex(q)
}
function exRemoveIndex(col: string): void {
  const i = exEditForm.value.additionalIndexes.indexOf(col)
  if (i !== -1) exEditForm.value.additionalIndexes.splice(i, 1)
}

async function exLoadJobs(): Promise<void> {
  exJobs.value = await window.api.listExtractJobs()
  for (const j of exJobs.value) {
    exHistoryMap.value.set(j.id, await window.api.getRunHistory(j.id))
  }
}

// Set while exSyncEditForm assigns the form programmatically, so the exEditForm
// watcher below doesn't mistake a freshly-loaded job for a user edit and schedule
// a pointless idle autosave.
let exSuppressAutosave = false

function exSyncEditForm(j: ExtractJob): void {
  exSuppressAutosave = true
  exEditForm.value = {
    id: j.id, name: j.name, comment: j.comment ?? '', mode: j.soqlQuery ? 'soql' : 'structured',
    sfObject: j.sfObject, fields: [...j.fields],
    customExpressions: [...(j.customExpressions ?? [])],
    whereClause: j.whereClause ?? '', rowLimit: j.rowLimit,
    destTable: j.destTable, writeMode: j.writeMode,
    soqlQuery: j.soqlQuery ?? '', additionalIndexes: [...(j.additionalIndexes ?? [])]
  }
  if (!j.soqlQuery && j.sfObject) exOnObjectChange(j.sfObject, false)
  nextTick(() => { exSuppressAutosave = false })
}

function exOpenRevertDialog(): void {
  const j = exSelectedJobData.value
  if (!j) return
  revertDialog.value = { type: 'extract', id: j.id, name: j.name || j.sfObject || 'this job', savedAt: j.updatedAt }
}

async function exSelectJob(id: number): Promise<void> {
  if (selectedJob.value && (selectedJob.value.type !== 'extract' || selectedJob.value.id !== id)) {
    await flushSelectedJobDraft()
  }
  if (wbSelectedJobId.value != null) {
    wbCaptureExecState(wbSelectedJobId.value, true)
  }
  selectedJob.value = { id, type: 'extract' }
  exDetailTab.value = 'definition'
  exClearMsg.value = ''
  exSaveError.value = ''
  exHistoryMap.value.set(id, await window.api.getRunHistory(id))
  const j = exJobs.value.find((j) => j.id === id)
  if (j) exSyncEditForm(j)
}

async function exOnObjectChange(name: string, resetFields = true): Promise<void> {
  if (!name) return
  exLoadingFields.value = true
  try {
    exFields.value = (await window.api.describeObject(name)).fields
    if (resetFields) {
      exEditForm.value.fields = exFields.value.filter((f) => !f.name.includes('.')).map((f) => f.name)
      exEditForm.value.customExpressions = []
      exEditForm.value.destTable = name
    }
  } finally {
    exLoadingFields.value = false
  }
}

/** Builds the save/draft payload from the current form state. Name-trimming aside, this
 * never mutates the form — silent draft autosaves must not surprise the user by rewriting
 * what they typed (e.g. defaulting a blank name), unlike an explicit Save. */
function exBuildJobPayload(): ExtractJobInput {
  const isSoql = exEditForm.value.mode === 'soql'
  const validColumns = isSoql ? null : new Set([...exEditForm.value.fields, ...exEditForm.value.customExpressions])
  const cleanedIndexes = toRaw(exEditForm.value.additionalIndexes).filter((col) => validColumns === null || validColumns.has(col))
  return {
    name: exEditForm.value.name.trim(),
    comment: exEditForm.value.comment.trim() || null,
    sfObject: isSoql ? '' : exEditForm.value.sfObject,
    fields: isSoql ? [] : toRaw(exEditForm.value.fields).slice(),
    customExpressions: isSoql ? [] : toRaw(exEditForm.value.customExpressions).slice(),
    whereClause: isSoql ? null : (exEditForm.value.whereClause || null),
    rowLimit: isSoql ? null : (exEditForm.value.rowLimit != null && exEditForm.value.rowLimit !== ('' as unknown as null) ? Number(exEditForm.value.rowLimit) : null),
    destTable: exEditForm.value.destTable || (isSoql ? 'sf_results' : exEditForm.value.sfObject),
    writeMode: exEditForm.value.writeMode,
    soqlQuery: isSoql ? exEditForm.value.soqlQuery.trim() : null,
    additionalIndexes: cleanedIndexes
  }
}

/** Patches the in-memory job list with a fresh effective (draft-merged) job, e.g. after a draft save/clear. */
function exApplyDraftResult(job: ExtractJob): void {
  const idx = exJobs.value.findIndex((j) => j.id === job.id)
  if (idx !== -1) exJobs.value[idx] = job
  else exJobs.value = [...exJobs.value, job]
}

/**
 * Silently autosaves the current form into job `id`'s draft and validates it, without
 * surfacing errors. Returns null if there's nothing to flush (job isn't loaded in the
 * form, doesn't exist yet, or is currently running).
 */
async function exFlushDraft(id: number): Promise<{ valid: boolean; error: string | null } | null> {
  if (exEditForm.value.id !== id || exActiveRuns.value.has(id)) return null
  const result = await window.api.saveExtractJobDraft(id, exBuildJobPayload())
  exApplyDraftResult(result.job)
  return { valid: result.valid, error: result.error }
}

let exIdleDraftTimer: ReturnType<typeof setTimeout> | null = null
function exScheduleIdleDraft(): void {
  if (exIdleDraftTimer !== null) { clearTimeout(exIdleDraftTimer); exIdleDraftTimer = null }
  const id = exEditForm.value.id
  if (id == null || exActiveRuns.value.has(id)) return
  exIdleDraftTimer = setTimeout(() => { exIdleDraftTimer = null; void exFlushDraft(id) }, IDLE_DRAFT_MS)
}
watch(exEditForm, () => {
  if (exSuppressAutosave) return
  exScheduleIdleDraft()
}, { deep: true })
// Leaving the Definition tab for another tab on the same job is also a "switch away".
watch(exDetailTab, (newTab, oldTab) => {
  if (oldTab === 'definition' && newTab !== 'definition') void flushSelectedJobDraft()
})

async function exSave(andExecute: boolean): Promise<void> {
  exSaveError.value = ''
  if (!exEditForm.value.name.trim()) exEditForm.value.name = 'extract'
  exSaving.value = true
  try {
    const job = await window.api.saveExtractJob({
      ...exBuildJobPayload(),
      ...(exEditForm.value.id ? { id: exEditForm.value.id } : {})
    } as Parameters<typeof window.api.saveExtractJob>[0])
    creating.value = null
    await exLoadJobs()
    selectedJob.value = { id: job.id, type: 'extract' }
    const saved = exJobs.value.find((j) => j.id === job.id)
    if (saved) exSyncEditForm(saved)
    // The job was just explicitly saved (and thus already validated) — run it
    // directly rather than immediately re-flushing an unchanged draft on top of it.
    if (andExecute) await exQueueOrStart(job.id)
  } catch (e) {
    exSaveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    exSaving.value = false
  }
}

async function exClearDestTable(): Promise<void> {
  const j = exSelectedJobData.value
  if (!j) return
  if (!confirm(`Delete all rows from "${j.destTable}"?`)) return
  exClearMsg.value = ''
  try {
    await window.api.executeQuery(`DELETE FROM "${j.destTable}"`)
    exClearMsg.value = 'Table cleared.'
    exClearMsgError.value = false
    conn.refreshDbInfo()
  } catch (e) {
    exClearMsg.value = e instanceof Error ? e.message : String(e)
    exClearMsgError.value = true
  }
}

async function exExecuteJob(): Promise<void> {
  if (!exSelectedJobId.value) return
  await exExecuteJobById(exSelectedJobId.value)
}

async function exExecuteJobById(id: number): Promise<void> {
  if (exActiveRuns.value.has(id) || exJobQueue.value.includes(id)) return
  exExecuting.value = true
  try {
    // Flush current edits into the draft first (so Execute always runs what's on
    // screen), then re-validate — silently during the flush, but surfaced here.
    const flush = await exFlushDraft(id)
    const job = exJobs.value.find((j) => j.id === id)
    const valid = flush ? flush.valid : !(job?.hasDraft && job.draftValid === false)
    if (!valid) {
      exSaveError.value = (flush ? flush.error : job?.draftError) ?? 'This job has invalid settings.'
      if (exSelectedJobId.value === id) exDetailTab.value = 'definition'
      return
    }
  } finally {
    exExecuting.value = false
  }
  await exQueueOrStart(id)
}

/** Queues or starts a run for a job already known to be valid (skips the draft flush/validate step). */
async function exQueueOrStart(id: number): Promise<void> {
  if (exActiveRuns.value.has(id) || exJobQueue.value.includes(id)) return
  if (exActiveRuns.value.size >= MAX_PARALLEL) {
    exJobQueue.value = [...exJobQueue.value, id]
    if (exSelectedJobId.value === id) exDetailTab.value = 'execution'
    return
  }
  await exStartJobNow(id)
}

async function exStartJobNow(id: number): Promise<void> {
  if (exSelectedJobId.value === id) exDetailTab.value = 'execution'
  exRunStartTimes.value.set(id, Date.now())
  const runId = await window.api.startExtract(id)
  exActiveRuns.value.set(id, runId)
  exLastRunIds.value.set(id, runId)
  jobs.startJob(runId, 'extract', id)
  const off = window.api.onJobComplete((e) => {
    if (e.runId !== runId) return
    off()
    exActiveRuns.value.delete(id)
    exLoadJobs()
    conn.refreshDbInfo()
    if (exJobQueue.value.length > 0) {
      const nextId = exJobQueue.value[0]
      exJobQueue.value = exJobQueue.value.slice(1)
      exStartJobNow(nextId)
    }
  })
}

async function exCancelRun(): Promise<void> {
  if (!exSelectedJobId.value) return
  const id = exSelectedJobId.value
  const qIdx = exJobQueue.value.indexOf(id)
  if (qIdx !== -1) { exJobQueue.value = exJobQueue.value.filter((jid) => jid !== id); return }
  const runId = exActiveRuns.value.get(id)
  if (runId) { await window.api.cancelJob(runId); jobs.removeJob(runId) }
  exActiveRuns.value.delete(id)
  exLastRunIds.value.delete(id)
  exRunStartTimes.value.delete(id)
}

async function exDuplicateSelectedJob(): Promise<void> {
  if (!exSelectedJobId.value) return
  await window.api.duplicateExtractJob(exSelectedJobId.value)
  await exLoadJobs()
}

async function exDeleteSelectedJob(): Promise<void> {
  if (!exSelectedJobId.value) return
  if (!confirm('Delete this job?')) return
  await window.api.deleteExtractJob(exSelectedJobId.value)
  selectedJob.value = null
  await exLoadJobs()
}

function exToggleErrorPopover(id: number, msg: string, e: MouseEvent): void {
  if (exErrorPopover.value?.id === id) { exErrorPopover.value = null; return }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const viewRect = (e.currentTarget as HTMLElement).closest('.job-detail')!.getBoundingClientRect()
  exErrorPopover.value = { id, msg, x: Math.min(rect.left - viewRect.left, viewRect.width - 340), y: rect.bottom - viewRect.top + 4 }
}

watch(selectedJob, () => { exErrorPopover.value = null })

function exApplyPendingSoql(): void {
  const soql = (window.history.state as Record<string, unknown>)?.pendingSoql
  if (typeof soql === 'string' && soql.trim()) {
    window.history.replaceState({ ...window.history.state, pendingSoql: undefined }, '')
    void flushSelectedJobDraft()
    selectedJob.value = null
    creating.value = 'extract'
    exFields.value = []
    exEditForm.value = { name: '', comment: '', mode: 'soql', sfObject: '', fields: [], customExpressions: [], whereClause: '', rowLimit: null, destTable: '', writeMode: 'replace', soqlQuery: soql, additionalIndexes: [] }
  }
}

const offExternalQueued = window.api.onExternalJobQueued((e) => {
  if (e.type !== 'extract') return
  if (!exJobQueue.value.includes(e.jobId)) exJobQueue.value = [...exJobQueue.value, e.jobId]
})
const offExternalStarted = window.api.onExternalJobStarted((e) => {
  if (e.type !== 'extract') return
  exJobQueue.value = exJobQueue.value.filter((id) => id !== e.jobId)
  if (!exActiveRuns.value.has(e.jobId)) {
    exActiveRuns.value.set(e.jobId, e.runId)
    const off = window.api.onJobComplete((result) => {
      if (result.runId !== e.runId) return
      off()
      exActiveRuns.value.delete(e.jobId)
      exLoadJobs()
      conn.refreshDbInfo()
    })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// ─── WRITEBACK state & functions ─────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

const wbJobs = ref<WritebackJob[]>([])
const wbHistoryMap = ref<Map<number, WritebackRunEntry[]>>(new Map())
const wbActiveRuns = ref<Map<number, string>>(new Map())
const wbJobQueue = ref<number[]>([])
const wbDetailTab = ref<'definition' | 'history' | 'execution'>('definition')
const wbSaving = ref(false)
const wbExecuting = ref(false)
const wbSaveError = ref('')
const wbPreviewLoading = ref(false)
const wbPreviewResult = ref<{ columns: string[]; rows: unknown[][] } | null>(null)
const wbPreviewError = ref('')
const wbRowCountLoading = ref(false)
const wbRowCountResult = ref<number | null>(null)
const wbRowCountError = ref('')
const wbSfFields = ref<FieldDescriptor[]>([])
const schemaPanel = ref<HTMLElement | null>(null)
const schemaTab = ref<'sqlite' | 'sf'>('sqlite')
const wbOperations = ['insert', 'update', 'upsert', 'delete', 'undelete']

/**
 * Fields eligible as upsert match keys: Salesforce accepts the record Id, any custom
 * field marked External ID, or any field flagged `idLookup` (e.g. Contact.Email,
 * User.Username, or the Name field on custom objects) — not just `externalId` fields.
 */
const wbUpsertExtIdFields = computed(() =>
  wbSfFields.value.filter((f) => f.name === 'Id' || f.externalId || f.idLookup)
)

interface WbEditForm {
  id?: number
  name: string
  comment: string
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
const wbEditForm = ref<WbEditForm>({
  name: '', comment: '', sqlQuery: '', sfObject: '', operation: 'insert', fieldMap: [],
  externalIdField: 'Id', batchSize: null, threads: null, distributionKey: null,
  useBulkApi: false, customHeaders: ''
})

const wbSelectedJobId = computed(() => selectedJob.value?.type === 'writeback' ? selectedJob.value.id : null)
const wbSelectedJobData = computed(() => wbJobs.value.find((j) => j.id === wbSelectedJobId.value))
const wbHistory = computed(() => wbHistoryMap.value.get(wbSelectedJobId.value ?? -1) ?? [])
const wbThisJobIsRunning = computed(() => wbSelectedJobId.value != null && wbActiveRuns.value.has(wbSelectedJobId.value))
const wbThisJobIsQueued = computed(() => wbSelectedJobId.value != null && wbJobQueue.value.includes(wbSelectedJobId.value))
const wbActiveJobData = computed(() => {
  const runId = wbSelectedJobId.value != null ? wbActiveRuns.value.get(wbSelectedJobId.value) : undefined
  return runId ? jobs.getJob(runId) : undefined
})

// ── WB Custom Headers suggestions ─────────────────────────────────────────────
const wbHeaderSuggestions = [
  { label: 'OwnerChangeOptions', preview: 'KeepAccountTeam', value: '{"OwnerChangeOptions": {"options": [{"type": "KeepAccountTeam", "execute": true}]}}' },
  { label: 'AssignmentRuleHeader', preview: 'useDefaultRule: true', value: '{"AssignmentRuleHeader": {"useDefaultRule": true}}' },
  { label: 'DuplicateRuleHeader', preview: 'allowSave: true', value: '{"DuplicateRuleHeader": {"allowSave": true}}' }
]
const wbShowHeaderSuggestions = ref(false)
const wbActiveSuggestion = ref(-1)

function wbOnHeadersKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') { e.preventDefault(); wbShowHeaderSuggestions.value = true; wbActiveSuggestion.value = (wbActiveSuggestion.value + 1) % wbHeaderSuggestions.length }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (wbShowHeaderSuggestions.value) wbActiveSuggestion.value = (wbActiveSuggestion.value - 1 + wbHeaderSuggestions.length) % wbHeaderSuggestions.length }
  else if (e.key === 'Enter' && wbShowHeaderSuggestions.value && wbActiveSuggestion.value >= 0) { e.preventDefault(); wbSelectHeaderSuggestion(wbActiveSuggestion.value) }
  else if (e.key === 'Escape') { wbShowHeaderSuggestions.value = false; wbActiveSuggestion.value = -1 }
}
function wbSelectHeaderSuggestion(i: number): void { wbEditForm.value.customHeaders = wbHeaderSuggestions[i].value; wbShowHeaderSuggestions.value = false; wbActiveSuggestion.value = -1 }
function wbHideSuggestionsDelayed(): void { setTimeout(() => { wbShowHeaderSuggestions.value = false; wbActiveSuggestion.value = -1 }, 150) }

// ── Distribution key ──────────────────────────────────────────────────────────
const wbDistribKeyCols = computed(() => wbEditForm.value.fieldMap.map((m) => m.sqlCol).filter(Boolean))
const wbDistribKeySearch = ref('')
const wbDistribKeyDropdownOpen = ref(false)
const wbDistribKeyOptions = computed(() => {
  const selected = new Set(wbEditForm.value.distributionKey ?? [])
  const q = wbDistribKeySearch.value.toLowerCase()
  return wbDistribKeyCols.value.filter((col) => !selected.has(col) && (!q || col.toLowerCase().includes(q)))
})
function wbToggleDistribKey(col: string): void {
  if ((wbEditForm.value.threads ?? 1) <= 1) return
  const current = wbEditForm.value.distributionKey ?? []
  const next = current.includes(col) ? current.filter((c) => c !== col) : [...current, col]
  wbEditForm.value.distributionKey = next.length ? next : null
}
function wbSelectDistribKey(col: string): void {
  if ((wbEditForm.value.threads ?? 1) <= 1) return
  const current = wbEditForm.value.distributionKey ?? []
  if (!current.includes(col)) wbEditForm.value.distributionKey = [...current, col]
  wbDistribKeySearch.value = ''
  wbDistribKeyDropdownOpen.value = false
}
function wbHideDistribDropdownDelayed(): void { setTimeout(() => { wbDistribKeyDropdownOpen.value = false }, 150) }

// ── WB Execution display state ────────────────────────────────────────────────
const EXEC_PAGE = 10000
const execSql = ref('')
const execOperation = ref('')
const execColumns = ref<string[]>([])
const execTotalRows = ref(0)
const execSucceeded = ref(0)
const execFailed = ref(0)
const execRunId = ref<string | null>(null)
const execJobDone = ref(false)
const execIsBulkApi = ref(false)
const execBulkPhase = ref<'uploading' | 'processing' | 'downloading' | ''>('')
const execBulkUploaded = ref(0)
const execBulkProcessed = ref(0)
const execBulkJobState = ref('')
const execError = ref<string | null>(null)
const execWarn = ref<string | null>(null)
const execPageOffset = ref(0)
// execPageRows: rows from the exec table. Layout: [rowid, ...dataValues, __sf_id, __status, __error]
// rowid is at index 0, __sf_id at row.length-3, __status at row.length-2, __error at row.length-1.
const execPageRows = ref<unknown[][]>([])
const execFailedTotal = ref(0)
const execFailedDistinctErrors = ref<{ message: string; count: number }[]>([])
const failedErrorFilter = ref('')
const execFilterSuccess = ref(true)
const execFilterError = ref(true)
const execFilterPending = ref(true)
const execFilterQueued = ref(true)
const execLoadingPhase = ref(false)
const execInFlight = ref(0)

// Polling for REST writeback exec state (replaces rowStatuses IPC events)
let execPollTimer: ReturnType<typeof setInterval> | null = null
let execPollLastDone = -1
let rpsLastDone = 0
let rpsLastTime = 0
const execRowsPerSec = ref(0)

function startExecPoll(runId: string): void {
  stopExecPoll()
  execPollLastDone = -1
  rpsLastDone = 0
  rpsLastTime = 0
  execRowsPerSec.value = 0
  execLoadingPhase.value = true
  execPollTimer = setInterval(async () => {
    const rid = execRunId.value
    if (!rid || execJobDone.value) { stopExecPoll(); return }
    try {
      const counts = await window.api.wbExecCounts(rid)
      if (execRunId.value !== rid) return
      const wasLoading = execLoadingPhase.value
      execLoadingPhase.value = counts.loadingPhase
      execInFlight.value = counts.inFlight
      execTotalRows.value = counts.total
      execSucceeded.value = counts.succeeded
      execFailed.value = counts.failed
      const doneNow = counts.succeeded + counts.failed
      // Compute rows/sec (EMA, alpha=0.25) once out of loading phase
      if (!counts.loadingPhase) {
        const now = Date.now()
        if (rpsLastTime > 0) {
          const elapsed = now - rpsLastTime
          if (elapsed > 0) {
            const instant = ((doneNow - rpsLastDone) / elapsed) * 1000
            execRowsPerSec.value = Math.round(
              execRowsPerSec.value === 0 ? instant : 0.25 * instant + 0.75 * execRowsPerSec.value
            )
          }
        }
        rpsLastDone = doneNow
        rpsLastTime = now
      }
      // Refresh page when loading phase ends or when progress changes
      if (wasLoading && !counts.loadingPhase) {
        execPollLastDone = doneNow
        const de = await window.api.wbExecDistinctErrors(rid)
        if (execRunId.value !== rid) return
        execFailedDistinctErrors.value = de
        await wbRefreshExecPage()
      } else if (doneNow !== execPollLastDone) {
        execPollLastDone = doneNow
        const de = await window.api.wbExecDistinctErrors(rid)
        if (execRunId.value !== rid) return
        execFailedDistinctErrors.value = de
        await wbRefreshExecPage()
      }
    } catch { /* ignore during shutdown or job switch */ }
  }, 333)
}
function stopExecPoll(): void {
  if (execPollTimer !== null) { clearInterval(execPollTimer); execPollTimer = null }
}

const wbAllFiltersOn = computed(() => execFilterSuccess.value && execFilterError.value && execFilterQueued.value)
const wbShowOnlyFailed = computed(() => !execFilterSuccess.value && execFilterError.value && !execFilterQueued.value)
const wbTotalRows = computed(() => execTotalRows.value)
const wbSucceededCount = computed(() => execSucceeded.value)
const wbFailedCount = computed(() => execFailed.value)
/** Rows not yet processed (queued = total - succeeded - failed). */
const wbQueuedCount = computed(() => Math.max(0, execTotalRows.value - execSucceeded.value - execFailed.value))
const wbIsInsert = computed(() => execOperation.value === 'insert')
/** Mirrors the server-side errorPrefix logic for client-side grouping. */
function clientErrorPrefix(msg: string): string {
  const first = msg.indexOf(':')
  if (first < 0) return msg
  const second = msg.indexOf(':', first + 1)
  return (second >= 0 ? msg.slice(0, second) : msg.slice(0, first)).trim()
}

// execFailedDistinctErrors is updated from the in-memory distinctErrorCounts map via polling
// (wbExecDistinctErrors IPC call) and on job completion.
const wbDistinctErrors = computed(() => execFailedDistinctErrors.value.map((e) => e.message).slice(0, 100))
const wbErrorCounts = computed(() => new Map(execFailedDistinctErrors.value.map((e) => [e.message, e.count])))
const wbFilteredFailedTotal = computed(() => {
  if (!failedErrorFilter.value) return execFailedTotal.value
  return execFailedDistinctErrors.value.find((e) => e.message === failedErrorFilter.value)?.count ?? 0
})
/**
 * The total row count to display and use for pagination, accounting for all active filters.
 * - Prefix filter active → count for that prefix from distinctErrors
 * - Status pills partially active → sum of counts for the active statuses
 * - All pills on (no filter) → full total
 */
const wbEffectiveTotalCount = computed(() => {
  if (failedErrorFilter.value) return wbFilteredFailedTotal.value
  if (wbAllFiltersOn.value) return execTotalRows.value
  if (wbShowOnlyFailed.value) return execFailed.value
  let count = 0
  if (execFilterSuccess.value) count += execSucceeded.value
  if (execFilterError.value) count += execFailed.value
  if (execFilterQueued.value) count += wbQueuedCount.value
  return count
})
const wbExecDisplayColumns = computed((): string[] => {
  const fm = wbSelectedJobData.value?.fieldMap
  if (!fm?.length) return execColumns.value
  const lookup = new Map<string, string>()
  for (const m of fm) { if (!m.excluded && m.sqlCol && m.sfField) lookup.set(m.sqlCol.toLowerCase(), m.sfField) }
  return execColumns.value.map((col) => lookup.get(col.toLowerCase()) ?? col)
})
const wbExecVisibleCols = computed(() => wbIsInsert.value ? ['_Id', '_Status', ...wbExecDisplayColumns.value] : ['_Status', ...wbExecDisplayColumns.value])
const wbExecRowsAndNumbers = computed((): { rows: unknown[][]; rowNumbers: number[] } => {
  // Exec-table row layout from wbExecGetPage:
  // [rowid, ...dataValues, __sf_id, __status, __error]
  // rowid  → index 0 (= 1-based source row number)
  // __sf_id → row.length - 3
  // __status → row.length - 2
  // __error → row.length - 1
  // data values → slice(1, row.length - 3)
  const rawRows = execPageRows.value
  const isInsert = wbIsInsert.value
  const displayRows: unknown[][] = []
  const rowNums: number[] = []
  for (const row of rawRows) {
    const rowid = Number(row[0])
    const sfIdRaw = row[row.length - 3] as string | null
    const status = row[row.length - 2] as string
    const error = row[row.length - 1] as string | null
    const dataVals = (row as unknown[]).slice(1, row.length - 3)
    const statusDisplay = status === 'success' ? 'OK'
      : status === 'error' ? `Fail: ${error ?? ''}`
      : status  // 'queued'
    // Blank out the 18-zero placeholder that marks a row as not yet written to Salesforce
    const sfId = (sfIdRaw && sfIdRaw !== '000000000000000000') ? sfIdRaw : ''
    displayRows.push(isInsert ? [sfId, statusDisplay, ...dataVals] : [statusDisplay, ...dataVals])
    rowNums.push(rowid)
  }
  return { rows: displayRows, rowNumbers: rowNums }
})
const wbVisibleExecRows = computed(() => wbExecRowsAndNumbers.value.rows)
const wbVisibleExecRowNumbers = computed(() => wbExecRowsAndNumbers.value.rowNumbers)

// ── WB Exec state cache ───────────────────────────────────────────────────────
const MAX_EXEC_CACHE = 3
interface SavedExecState {
  cachedAt: number; sql: string; operation: string; columns: string[]; totalRows: number
  succeeded: number; failed: number; runId: string | null
  jobDone: boolean; isBulkApi: boolean; error: string | null; warn: string | null
  bulkPhase: 'uploading' | 'processing' | 'downloading' | ''; bulkUploaded: number; bulkProcessed: number; bulkJobState: string
  pageOffset: number; failedTotal: number
  distinctErrors: { message: string; count: number }[]
  filterSuccess: boolean; filterError: boolean; filterPending: boolean; filterQueued: boolean
}
const execStateCache = ref<Map<number, SavedExecState>>(new Map())

function wbCaptureExecState(jobId: number, force = false): void {
  if (!force && !execJobDone.value && !execError.value) return
  execStateCache.value.set(jobId, {
    cachedAt: Date.now(), sql: execSql.value, operation: execOperation.value,
    columns: execColumns.value.slice(), totalRows: execTotalRows.value,
    succeeded: execSucceeded.value, failed: execFailed.value,
    runId: execRunId.value, jobDone: execJobDone.value,
    isBulkApi: execIsBulkApi.value, error: execError.value, warn: execWarn.value,
    bulkPhase: execBulkPhase.value, bulkUploaded: execBulkUploaded.value,
    bulkProcessed: execBulkProcessed.value, bulkJobState: execBulkJobState.value,
    pageOffset: execPageOffset.value, failedTotal: execFailedTotal.value,
    distinctErrors: execFailedDistinctErrors.value.slice(),
    filterSuccess: execFilterSuccess.value, filterError: execFilterError.value,
    filterPending: execFilterPending.value, filterQueued: execFilterQueued.value
  })
}

async function wbRestoreExecState(jobId: number): Promise<void> {
  const s = execStateCache.value.get(jobId)
  if (!s) { wbClearExecState(); return }
  s.cachedAt = Date.now()
  execSql.value = s.sql; execOperation.value = s.operation; execColumns.value = s.columns
  execTotalRows.value = s.totalRows; execSucceeded.value = s.succeeded
  execFailed.value = s.failed; execRunId.value = s.runId
  execJobDone.value = s.jobDone; execIsBulkApi.value = s.isBulkApi
  execError.value = s.error; execWarn.value = s.warn
  execPageOffset.value = 0; failedErrorFilter.value = ''
  execFailedTotal.value = s.failedTotal; execFailedDistinctErrors.value = s.distinctErrors
  execFilterSuccess.value = s.filterSuccess; execFilterError.value = s.filterError
  execFilterPending.value = s.filterPending; execFilterQueued.value = s.filterQueued ?? true
  execBulkPhase.value = s.bulkPhase ?? ''; execBulkUploaded.value = s.bulkUploaded ?? 0
  execBulkProcessed.value = s.bulkProcessed ?? 0; execBulkJobState.value = s.bulkJobState ?? ''
  execPageRows.value = []
  // Restore the page data from the exec table if a run exists.
  // For Bulk API, the exec table only exists when there are failed rows.
  if (s.runId && (!s.isBulkApi || s.failed > 0)) {
    await wbLoadExecPage(0)
    // If job was still running, start polling to continue receiving updates
    if (!s.jobDone && !s.isBulkApi) startExecPoll(s.runId)
  }
}

function wbEvictOldExecStates(keepJobId: number): void {
  const cache = execStateCache.value
  if (cache.size <= MAX_EXEC_CACHE) return
  const sorted = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)
  for (const [id] of sorted) {
    if (cache.size <= MAX_EXEC_CACHE) break
    if (id !== keepJobId && !wbActiveRuns.value.has(id)) cache.delete(id)
  }
}

function wbClearExecState(): void {
  stopExecPoll()
  execSql.value = ''; execOperation.value = ''; execColumns.value = []; execTotalRows.value = 0
  execSucceeded.value = 0; execFailed.value = 0
  execRunId.value = null; execJobDone.value = false; execIsBulkApi.value = false; execBulkPhase.value = ''
  execBulkUploaded.value = 0; execBulkProcessed.value = 0; execBulkJobState.value = ''
  execError.value = null; execWarn.value = null; execPageOffset.value = 0; execPageRows.value = []
  execFailedTotal.value = 0; execFailedDistinctErrors.value = []; failedErrorFilter.value = ''
  execFilterSuccess.value = execFilterError.value = execFilterPending.value = execFilterQueued.value = true
  execLoadingPhase.value = false
  execInFlight.value = 0
  execRowsPerSec.value = 0
}

watch(failedErrorFilter, async (newVal) => {
  if (newVal) {
    execFilterSuccess.value = false
    execFilterQueued.value = false
  } else {
    execFilterSuccess.value = true
    execFilterQueued.value = true
  }
  await wbLoadExecPage(0)
})
watch([execFilterSuccess, execFilterError, execFilterQueued], () => {
  wbLoadExecPage(0)
})

async function wbLoadJobs(): Promise<void> {
  wbJobs.value = await window.api.listWritebackJobs()
  const histories = await Promise.all(wbJobs.value.map((j) => window.api.getWritebackRunHistory(j.id)))
  wbJobs.value.forEach((j, i) => wbHistoryMap.value.set(j.id, histories[i]))
}

// Set while wbLoadJobIntoForm assigns the form programmatically, so the wbEditForm
// watcher below doesn't mistake a freshly-loaded job for a user edit and schedule
// a pointless idle autosave.
let wbSuppressAutosave = false

function wbLoadJobIntoForm(j: WritebackJob): void {
  wbSuppressAutosave = true
  wbEditForm.value = {
    id: j.id, name: j.name, comment: j.comment ?? '', sqlQuery: j.sqlQuery, sfObject: j.sfObject,
    operation: j.operation, fieldMap: [...j.fieldMap.map((m) => ({ ...m }))],
    externalIdField: j.externalIdField || 'Id', batchSize: j.batchSize, threads: j.threads,
    distributionKey: j.distributionKey ? [...j.distributionKey] : null,
    useBulkApi: j.useBulkApi, customHeaders: j.customHeaders ?? ''
  }
  wbPreviewResult.value = null; wbPreviewError.value = ''; wbRowCountResult.value = null; wbRowCountError.value = ''
  wbSfFields.value = []
  if (j.sfObject) window.api.describeObject(j.sfObject).then((r) => { wbSfFields.value = r.fields })
  nextTick(() => { wbSuppressAutosave = false })
}

function wbOpenRevertDialog(): void {
  const j = wbSelectedJobData.value
  if (!j) return
  revertDialog.value = { type: 'writeback', id: j.id, name: j.name || j.sfObject || 'this job', savedAt: j.updatedAt }
}

async function wbSelectJob(id: number): Promise<void> {
  if (selectedJob.value && (selectedJob.value.type !== 'writeback' || selectedJob.value.id !== id)) {
    await flushSelectedJobDraft()
  }
  if (wbSelectedJobId.value != null && wbSelectedJobId.value !== id) {
    wbCaptureExecState(wbSelectedJobId.value, true)
  }
  selectedJob.value = { id, type: 'writeback' }
  wbDetailTab.value = wbActiveRuns.value.has(id) ? 'execution' : 'definition'
  await wbRestoreExecState(id)
  const j = wbJobs.value.find((x) => x.id === id)
  if (j) wbLoadJobIntoForm(j)
  wbHistoryMap.value.set(id, await window.api.getWritebackRunHistory(id))
}

async function wbRunPreview(): Promise<void> {
  wbPreviewError.value = ''; wbPreviewLoading.value = true
  try { wbPreviewResult.value = await window.api.previewWritebackQuery(wbEditForm.value.sqlQuery); wbInitFieldMap() }
  catch (e) { wbPreviewError.value = e instanceof Error ? e.message : String(e) }
  finally { wbPreviewLoading.value = false }
}

async function wbRunRowCount(): Promise<void> {
  wbRowCountError.value = ''; wbRowCountResult.value = null; wbRowCountLoading.value = true
  try { wbRowCountResult.value = await window.api.executeQuery(`SELECT COUNT(*) FROM (${wbEditForm.value.sqlQuery})`).then((r) => r.rows[0]?.[0] as number ?? 0) }
  catch (e) { wbRowCountError.value = e instanceof Error ? e.message : String(e) }
  finally { wbRowCountLoading.value = false }
}

async function wbOnObjectChange(name: string): Promise<void> {
  if (!name) return
  wbSfFields.value = (await window.api.describeObject(name)).fields
  wbInitFieldMap()
}

function wbInitFieldMap(): void {
  if (!wbPreviewResult.value) return
  const existing = new Map(wbEditForm.value.fieldMap.map((m) => [m.sqlCol.toLowerCase(), m]))
  wbEditForm.value.fieldMap = wbPreviewResult.value.columns.map((col) => {
    const prev = existing.get(col.toLowerCase())
    if (prev) return { ...prev, sqlCol: col }
    const match = wbSfFields.value.find((f) => f.name.toLowerCase() === col.toLowerCase())
    return { sqlCol: col, sfField: match?.name ?? '', excluded: !match }
  })
  if (wbEditForm.value.distributionKey?.length) {
    const validCols = new Set(wbEditForm.value.fieldMap.map((m) => m.sqlCol.toLowerCase()))
    const filtered = wbEditForm.value.distributionKey.filter((c) => validCols.has(c.toLowerCase()))
    wbEditForm.value.distributionKey = filtered.length ? filtered : null
  }
}

/** Builds the save/draft payload from the current form state. Name-trimming aside, this
 * never mutates the form — silent draft autosaves must not surprise the user by rewriting
 * what they typed (e.g. defaulting a blank name), unlike an explicit Save. */
function wbBuildJobPayload(): WritebackJobInput {
  return {
    name: wbEditForm.value.name.trim(),
    comment: wbEditForm.value.comment.trim() || null,
    sqlQuery: wbEditForm.value.sqlQuery, sfObject: wbEditForm.value.sfObject,
    operation: wbEditForm.value.operation as WritebackJob['operation'],
    fieldMap: toRaw(wbEditForm.value.fieldMap).map((m) => ({ ...toRaw(m) })),
    externalIdField: wbEditForm.value.externalIdField || null,
    batchSize: wbEditForm.value.batchSize, threads: wbEditForm.value.threads,
    distributionKey: wbEditForm.value.distributionKey?.length ? [...toRaw(wbEditForm.value.distributionKey)] : null,
    useBulkApi: wbEditForm.value.useBulkApi,
    customHeaders: wbEditForm.value.customHeaders.trim() || null
  }
}

/** Patches the in-memory job list with a fresh effective (draft-merged) job, e.g. after a draft save/clear. */
function wbApplyDraftResult(job: WritebackJob): void {
  const idx = wbJobs.value.findIndex((j) => j.id === job.id)
  if (idx !== -1) wbJobs.value[idx] = job
  else wbJobs.value = [...wbJobs.value, job]
}

/**
 * Silently autosaves the current form into job `id`'s draft and validates it, without
 * surfacing errors. Returns null if there's nothing to flush (job isn't loaded in the
 * form, doesn't exist yet, or is currently running).
 */
async function wbFlushDraft(id: number): Promise<{ valid: boolean; error: string | null } | null> {
  if (wbEditForm.value.id !== id || wbActiveRuns.value.has(id)) return null
  const result = await window.api.saveWritebackJobDraft(id, wbBuildJobPayload())
  wbApplyDraftResult(result.job)
  return { valid: result.valid, error: result.error }
}

let wbIdleDraftTimer: ReturnType<typeof setTimeout> | null = null
function wbScheduleIdleDraft(): void {
  if (wbIdleDraftTimer !== null) { clearTimeout(wbIdleDraftTimer); wbIdleDraftTimer = null }
  const id = wbEditForm.value.id
  if (id == null || wbActiveRuns.value.has(id)) return
  wbIdleDraftTimer = setTimeout(() => { wbIdleDraftTimer = null; void wbFlushDraft(id) }, IDLE_DRAFT_MS)
}
watch(wbEditForm, () => {
  if (wbSuppressAutosave) return
  wbScheduleIdleDraft()
}, { deep: true })
// Leaving the Definition tab for another tab on the same job is also a "switch away".
watch(wbDetailTab, (newTab, oldTab) => {
  if (oldTab === 'definition' && newTab !== 'definition') void flushSelectedJobDraft()
})

async function wbSave(andExecute: boolean): Promise<void> {
  wbSaveError.value = ''
  if (!wbEditForm.value.name.trim()) wbEditForm.value.name = 'writeback'
  wbSaving.value = true
  try {
    const job = await window.api.saveWritebackJob({
      ...wbBuildJobPayload(),
      ...(wbEditForm.value.id ? { id: wbEditForm.value.id } : {})
    } as Parameters<typeof window.api.saveWritebackJob>[0])
    creating.value = null
    await wbLoadJobs()
    selectedJob.value = { id: job.id, type: 'writeback' }
    wbLoadJobIntoForm(job)
    // The job was just explicitly saved (and thus already validated) — run it
    // directly rather than immediately re-flushing an unchanged draft on top of it.
    if (andExecute) await wbQueueOrStart(job.id)
  } catch (e) {
    wbSaveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    wbSaving.value = false
  }
}

async function wbExecuteJob(): Promise<void> {
  if (!wbSelectedJobId.value) return
  await wbExecuteJobById(wbSelectedJobId.value)
}

async function wbExecuteJobById(id: number): Promise<void> {
  if (wbActiveRuns.value.has(id) || wbJobQueue.value.includes(id)) return
  wbExecuting.value = true
  try {
    // Flush current edits into the draft first (so Execute always runs what's on
    // screen), then re-validate — silently during the flush, but surfaced here.
    const flush = await wbFlushDraft(id)
    const job = wbJobs.value.find((j) => j.id === id)
    const valid = flush ? flush.valid : !(job?.hasDraft && job.draftValid === false)
    if (!valid) {
      wbSaveError.value = (flush ? flush.error : job?.draftError) ?? 'This job has invalid settings.'
      if (wbSelectedJobId.value === id) wbDetailTab.value = 'definition'
      return
    }
  } finally {
    wbExecuting.value = false
  }
  await wbQueueOrStart(id)
}

/** Queues or starts a run for a job already known to be valid (skips the draft flush/validate step). */
async function wbQueueOrStart(id: number): Promise<void> {
  if (wbActiveRuns.value.has(id) || wbJobQueue.value.includes(id)) return
  if (wbActiveRuns.value.size >= MAX_PARALLEL) {
    wbJobQueue.value = [...wbJobQueue.value, id]
    if (wbSelectedJobId.value === id) wbDetailTab.value = 'execution'
    return
  }
  await wbStartJobNow(id)
}

async function wbStartJobNow(id: number): Promise<void> {
  const j = wbJobs.value.find((x) => x.id === id)
  if (!j) return
  execStateCache.value.delete(id)
  if (wbSelectedJobId.value === id) {
    wbDetailTab.value = 'execution'
    execSql.value = j.sqlQuery; execOperation.value = j.operation; execIsBulkApi.value = j.useBulkApi
    execBulkPhase.value = ''; execBulkUploaded.value = 0; execBulkProcessed.value = 0; execBulkJobState.value = ''
    execError.value = null; execWarn.value = null; execTotalRows.value = 0
    execSucceeded.value = 0; execFailed.value = 0; execPageOffset.value = 0
    execPageRows.value = []; execColumns.value = []; execFailedTotal.value = 0
    execFailedDistinctErrors.value = []; execJobDone.value = false
    execFilterSuccess.value = execFilterError.value = execFilterPending.value = execFilterQueued.value = true
    failedErrorFilter.value = ''
  }
  const runId = await window.api.startWriteback(id)
  if (wbSelectedJobId.value === id) {
    execRunId.value = runId
    // For REST jobs start polling; Bulk API uses job:progress events
    if (!j.useBulkApi) startExecPoll(runId)
  }
  wbActiveRuns.value.set(id, runId)
  jobs.startJob(runId, 'writeback', id)
  wbStartRunMonitor(id, runId)
}

function wbStartRunMonitor(jobId: number, runId: string): void {
  const isSelected = () => wbSelectedJobId.value === jobId
  // Progress events are only used for Bulk API (REST uses polling instead)
  const offProgress = window.api.onJobProgress((e) => {
    if (e.runId !== runId || !e.phase) return
    if (isSelected()) {
      execBulkPhase.value = e.phase
      if (e.bulkUploaded !== undefined) execBulkUploaded.value = e.bulkUploaded
      if (e.phase === 'processing') {
        if (e.total !== undefined) execBulkProcessed.value = e.total
        if (e.succeeded !== undefined) execSucceeded.value = e.succeeded
        if (e.failed !== undefined) execFailed.value = e.failed
        if (e.jobState) execBulkJobState.value = e.jobState
      }
    } else {
      // Job is running but not currently viewed — keep the cache up to date so
      // navigating back restores accurate progress instead of a blank phase card.
      const cached = execStateCache.value.get(jobId)
      if (cached) {
        cached.bulkPhase = e.phase
        if (e.bulkUploaded !== undefined) cached.bulkUploaded = e.bulkUploaded
        if (e.phase === 'processing') {
          if (e.total !== undefined) cached.bulkProcessed = e.total
          if (e.succeeded !== undefined) cached.succeeded = e.succeeded
          if (e.failed !== undefined) cached.failed = e.failed
          if (e.jobState) cached.bulkJobState = e.jobState
        }
      }
    }
  })
  const offComplete = window.api.onJobComplete(async (e) => {
    if (e.runId !== runId) return
    offProgress(); offComplete()
    stopExecPoll()
    wbActiveRuns.value.delete(jobId)
    if (isSelected()) {
      execBulkPhase.value = ''; execJobDone.value = true; execLoadingPhase.value = false
      if (e.status === 'cancelled') { execWarn.value = 'Job was cancelled by the user.' }
      else if (e.status === 'error') { execError.value = e.errorMsg ?? 'The job failed with an unknown error.' }
      else {
        execError.value = null; execWarn.value = null
      }
      if (e.columns && e.columns.length > 0) execColumns.value = e.columns
      // Fetch final counts + errors + page from exec table
      if (!execIsBulkApi.value) {
        try {
          const [counts, de] = await Promise.all([
            window.api.wbExecCounts(runId),
            window.api.wbExecDistinctErrors(runId)
          ])
          execTotalRows.value = counts.total
          execSucceeded.value = counts.succeeded
          execFailed.value = counts.failed
          execFailedTotal.value = counts.failed
          execFailedDistinctErrors.value = de
          if (counts.total === 0 && e.status !== 'error' && e.status !== 'cancelled') {
            execWarn.value = 'The job completed but 0 rows were processed. Check that your SQL query returns rows and that at least one field mapping is active.'
          }
          await wbLoadExecPage(execPageOffset.value)
        } catch { /* ignore */ }
      } else {
        // Bulk API: counts come from the job result event.
        const rowsOk = e.rowsSucceeded ?? 0
        const rowsFail = e.rowsFailed ?? 0
        execSucceeded.value = rowsOk
        execFailed.value = rowsFail
        execFailedTotal.value = rowsFail
        if (rowsOk + rowsFail === 0) {
          execWarn.value = 'The job completed but 0 rows were processed. Check that your SQL query returns rows and that at least one field mapping is active.'
        }
        // If there are failed rows, populate the DataGrid from the exec table.
        if (rowsFail > 0 && runId) {
          try {
            // exec table only holds failed rows — set totalRows to failed count
            execTotalRows.value = rowsFail
            // Pre-select only the error filter (no OK/queued rows in exec table)
            execFilterSuccess.value = false
            execFilterQueued.value = false
            execFilterError.value = true
            const de = await window.api.wbExecDistinctErrors(runId)
            execFailedDistinctErrors.value = de
            await wbLoadExecPage(0)
          } catch { /* ignore */ }
        }
      }
      // Surface any non-fatal warning from the main process (e.g. partial exec-table
      // write failure).  Appended so it does not erase a more specific prior warn.
      if (e.warnMsg) {
        execWarn.value = execWarn.value
          ? `${execWarn.value}\n${e.warnMsg}`
          : e.warnMsg
      }
      wbCaptureExecState(jobId)
    } else {
      const cached = execStateCache.value.get(jobId)
      if (cached) {
        cached.jobDone = true
        cached.error = (e.status === 'error') ? (e.errorMsg ?? 'Unknown error') : null
        if (e.status === 'cancelled') cached.warn = 'Job was cancelled by the user.'
        else if (e.status !== 'error') cached.warn = null
        if (e.rowsSucceeded !== undefined) cached.succeeded = e.rowsSucceeded
        if (e.rowsFailed !== undefined) { cached.failed = e.rowsFailed; cached.failedTotal = e.rowsFailed }
        if (e.rowsSucceeded !== undefined && e.rowsFailed !== undefined) {
          // For Bulk API the exec table only holds failed rows, so totalRows = failed count.
          cached.totalRows = cached.isBulkApi ? (e.rowsFailed ?? 0) : (e.rowsSucceeded + e.rowsFailed)
        }
        if (e.columns && e.columns.length > 0) cached.columns = e.columns
        cached.cachedAt = Date.now()
      }
    }
    wbLoadJobs()
    wbEvictOldExecStates(jobId)
    if (wbJobQueue.value.length > 0) {
      const nextId = wbJobQueue.value[0]
      wbJobQueue.value = wbJobQueue.value.slice(1)
      wbStartJobNow(nextId)
    }
  })
}

async function wbCancelRun(): Promise<void> {
  if (!wbSelectedJobId.value) return
  const id = wbSelectedJobId.value
  const qIdx = wbJobQueue.value.indexOf(id)
  if (qIdx !== -1) { wbJobQueue.value = wbJobQueue.value.filter((jid) => jid !== id); wbClearExecState(); return }
  const runId = wbActiveRuns.value.get(id)
  if (runId) { await window.api.cancelJob(runId); jobs.removeJob(runId) }
}

/** Build the exec-page filter from the current pill + prefix filter state. */
function buildExecFilter(): { statuses?: ('success' | 'error' | 'queued')[]; errorPrefix?: string } | undefined {
  const prefixFilter = failedErrorFilter.value || undefined

  const statuses: ('success' | 'error' | 'queued')[] = []
  if (execFilterSuccess.value) { statuses.push('success') }
  if (execFilterError.value) { statuses.push('error') }
  if (execFilterQueued.value) { statuses.push('queued') }

  const allOn = statuses.length === 3

  // When prefix filter is active it always restricts to errors only
  if (prefixFilter) {
    return { statuses: ['error'], errorPrefix: prefixFilter }
  }

  // All pills on, no prefix → no filter needed (show everything)
  if (allOn) { return undefined }

  return { statuses }
}

async function wbLoadExecPage(offset: number): Promise<void> {
  if (!execRunId.value) return
  execPageOffset.value = offset
  try {
    const filter = buildExecFilter()
    const result = await window.api.wbExecPage(execRunId.value, offset, EXEC_PAGE, filter)
    execPageRows.value = result.rows
    // Derive column names from exec-table response (strip __rowid and meta cols)
    if (result.columns.length > 3 && execColumns.value.length === 0) {
      execColumns.value = result.columns.slice(1, result.columns.length - 3)
    }
  } catch { /* ignore */ }
}

/** Refresh the current page in place (used by polling). */
async function wbRefreshExecPage(): Promise<void> {
  if (!execRunId.value || execJobDone.value) return
  await wbLoadExecPage(execPageOffset.value)
}


async function wbRetryFailed(): Promise<void> {
  if (!wbSelectedJobId.value || !execRunId.value) return
  const id = wbSelectedJobId.value
  execTotalRows.value = 0; execPageOffset.value = 0; execPageRows.value = []
  execSucceeded.value = 0; execFailed.value = 0; execFailedTotal.value = 0
  execFailedDistinctErrors.value = []; execJobDone.value = false
  execFilterSuccess.value = execFilterError.value = execFilterPending.value = execFilterQueued.value = true
  failedErrorFilter.value = ''
  execBulkPhase.value = ''; execBulkUploaded.value = 0; execBulkProcessed.value = 0; execBulkJobState.value = ''

  const { runId: newRunId, isBulk } = await window.api.retryFailed(execRunId.value, id)

  // Switch the UI into the correct mode for this retry.
  // Large Bulk retries (> 50 K failed rows) stay in Bulk mode and receive
  // job:progress phase events; smaller ones drop to REST and use polling.
  execIsBulkApi.value = isBulk
  execRunId.value = newRunId; wbActiveRuns.value.set(id, newRunId); jobs.startJob(newRunId, 'writeback', id)
  if (!isBulk) { startExecPoll(newRunId) }
  wbStartRunMonitor(id, newRunId)
}

async function wbCopyAllExecRows(): Promise<void> {
  if (!execRunId.value) return
  const csvEscape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r') ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const cols = wbExecVisibleCols.value
  const lines: string[] = [cols.map(csvEscape).join(',')]
  const filter = buildExecFilter()
  const total = wbEffectiveTotalCount.value
  const isInsert = wbIsInsert.value
  for (let offset = 0; offset < total; offset += EXEC_PAGE) {
    const result = await window.api.wbExecPage(execRunId.value, offset, EXEC_PAGE, filter)
    for (const row of result.rows) {
      const sfIdRaw = row[row.length - 3] as string | null
      const status = row[row.length - 2] as string
      const error = row[row.length - 1] as string | null
      const dataVals = (row as unknown[]).slice(1, row.length - 3)
      const statusDisplay = status === 'success' ? 'OK' : status === 'error' ? `Fail: ${error ?? ''}` : status
      const sfId = (sfIdRaw && sfIdRaw !== '000000000000000000') ? sfIdRaw : ''
      const fullRow = isInsert ? [sfId, statusDisplay, ...dataVals] : [statusDisplay, ...dataVals]
      lines.push(fullRow.map(csvEscape).join(','))
    }
  }
  await navigator.clipboard.writeText(lines.join('\n'))
}

async function wbDuplicateSelectedJob(): Promise<void> {
  if (!wbSelectedJobId.value) return
  await window.api.duplicateWritebackJob(wbSelectedJobId.value)
  await wbLoadJobs()
}

async function wbDeleteSelectedJob(): Promise<void> {
  if (!wbSelectedJobId.value || !confirm('Delete this job?')) return
  await window.api.deleteWritebackJob(wbSelectedJobId.value)
  selectedJob.value = null; wbClearExecState(); await wbLoadJobs()
}

function wbStartSchemaResize(e: MouseEvent): void {
  let resizing = true
  const startX = e.clientX; const startW = schemaPanel.value?.offsetWidth ?? 220
  const onMove = (ev: MouseEvent): void => { if (!resizing || !schemaPanel.value) return; schemaPanel.value.style.width = Math.max(120, startW - (ev.clientX - startX)) + 'px' }
  const onUp = (): void => { resizing = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
}

function wbApplyPendingSql(): void {
  const sql = (window.history.state as Record<string, unknown>)?.pendingSql
  if (typeof sql === 'string' && sql.trim()) {
    window.history.replaceState({ ...window.history.state, pendingSql: undefined }, '')
    void flushSelectedJobDraft()
    selectedJob.value = null; creating.value = 'writeback'
    wbPreviewResult.value = null; wbPreviewError.value = ''; wbSaveError.value = ''
    wbSfFields.value = []
    wbEditForm.value = { name: '', comment: '', sqlQuery: sql, sfObject: '', operation: 'insert', fieldMap: [], externalIdField: 'Id', batchSize: null, threads: null, distributionKey: null, useBulkApi: false, customHeaders: '' }
  }
}

// ── Update IDs modal ──────────────────────────────────────────────────────────
interface WbUpdateIdsKeyField { sfField: string; sqlCol: string; label: string; valueCount: number }
const wbUpdateIdsOpen = ref(false)
const wbUpdateIdsTables = ref<string[]>([])
const wbUpdateIdsTargetTable = ref('')
const wbUpdateIdsTableCols = ref<string[]>([])
const wbUpdateIdsTableKeyCol = ref('')
const wbUpdateIdsKeyFields = ref<WbUpdateIdsKeyField[]>([])
const wbUpdateIdsSfKeyField = ref('')
const wbUpdateIdsIdColName = ref('Id')
const wbUpdateIdsLoading = ref(false)
const wbUpdateIdsResult = ref<{ updated: number; idColCreated: boolean; indexCreated: boolean } | null>(null)
const wbUpdateIdsError = ref('')
const wbUpdateIdsKeyColNeedsIndex = ref(false)

watch(wbUpdateIdsTargetTable, async (tbl) => {
  wbUpdateIdsTableCols.value = tbl ? await window.api.getTableColumnNames(tbl) : []
  const sfField = wbUpdateIdsKeyFields.value.find((f) => f.sfField === wbUpdateIdsSfKeyField.value)
  wbUpdateIdsTableKeyCol.value = (sfField && wbUpdateIdsTableCols.value.includes(sfField.sqlCol)) ? sfField.sqlCol : ''
})
watch(wbUpdateIdsSfKeyField, () => {
  const sfField = wbUpdateIdsKeyFields.value.find((f) => f.sfField === wbUpdateIdsSfKeyField.value)
  wbUpdateIdsTableKeyCol.value = (sfField && wbUpdateIdsTableCols.value.includes(sfField.sqlCol)) ? sfField.sqlCol : ''
})
watch([wbUpdateIdsTargetTable, wbUpdateIdsTableKeyCol], async ([tbl, col]) => {
  wbUpdateIdsKeyColNeedsIndex.value = tbl && col ? !(await window.api.columnHasIndex(tbl, col)) : false
})

async function wbOpenUpdateIdsModal(): Promise<void> {
  // "Update table with IDs" will be re-implemented in a future version.
  alert('This feature will be available in a future version.')
}

async function wbConfirmUpdateIds(): Promise<void> {
  wbUpdateIdsLoading.value = true; wbUpdateIdsError.value = ''; wbUpdateIdsResult.value = null
  try { throw new Error('Not yet implemented.') }
  catch (err) { wbUpdateIdsError.value = err instanceof Error ? err.message : String(err) }
  finally { wbUpdateIdsLoading.value = false }
}

const offWbExternalQueued = window.api.onExternalJobQueued((e) => {
  if (e.type !== 'writeback') return
  if (!wbJobQueue.value.includes(e.jobId)) wbJobQueue.value = [...wbJobQueue.value, e.jobId]
})
const offWbExternalStarted = window.api.onExternalJobStarted((e) => {
  if (e.type !== 'writeback') return
  wbJobQueue.value = wbJobQueue.value.filter((id) => id !== e.jobId)
  if (!wbActiveRuns.value.has(e.jobId)) {
    wbActiveRuns.value.set(e.jobId, e.runId)
    const off = window.api.onJobComplete((result) => {
      if (result.runId !== e.runId) return
      off(); wbActiveRuns.value.delete(e.jobId); wbLoadJobs()
    })
  }
})

let offRunEvicted: (() => void) | null = null
let unregisterQuitHandler: (() => void) | null = null

// ═════════════════════════════════════════════════════════════════════════════
// ─── Shared lifecycle & utilities ────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

function formatDate(d: string): string { return new Date(d).toLocaleString() }
function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60); const rs = s % 60
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60); const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}
function runStatusBadge(s: string): string {
  if (s === 'success') return 'badge-green'
  if (s === 'error') return 'badge-red'
  if (s === 'partial') return 'badge-amber'
  if (s === 'running') return 'badge-blue'
  if (s === 'cancelled') return 'badge-gray'
  return 'badge-gray'
}
function runStatusIcon(s: string): string {
  if (s === 'success') return '✓'
  if (s === 'error') return '✗'
  if (s === 'partial') return '⚠'
  if (s === 'cancelled') return '⊘'
  return '?'
}
/** Short letter code shown next to the writeback arrow icon to indicate the DML operation. */
function wbOpIcon(op: WritebackJob['operation'] | undefined): string {
  if (op === 'insert') return 'I'
  if (op === 'update') return 'U'
  if (op === 'upsert') return 'IU'
  if (op === 'delete') return 'D'
  if (op === 'undelete') return 'UD'
  return ''
}

onMounted(async () => {
  if (conn.bothConnected) {
    await Promise.all([exLoadJobs(), wbLoadJobs(), conn.loadSFObjects()])
  }
  offRunEvicted = window.api.onWritebackRunEvicted((evictedRunId) => {
    for (const [jobId, state] of execStateCache.value.entries()) {
      if (state.runId === evictedRunId) { execStateCache.value.delete(jobId); break }
    }
    if (execRunId.value === evictedRunId) wbClearExecState()
  })
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown)
  unregisterQuitHandler = registerQuitHandler(() => flushSelectedJobDraft())
})

onActivated(async () => {
  await nextTick()
  exApplyPendingSoql()
  wbApplyPendingSql()
})

// Fires when navigating away to another route (e.g. Query, Explorer) — the whole
// router-view is kept alive, so this is our hook for "switched away from Jobs".
onDeactivated(() => {
  void flushSelectedJobDraft()
})

onUnmounted(() => {
  offRunEvicted?.(); offRunEvicted = null
  offExternalQueued(); offExternalStarted()
  offWbExternalQueued(); offWbExternalStarted()
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown)
  unregisterQuitHandler?.(); unregisterQuitHandler = null
})

// Initial connection (either side completes the pair false → true)
watch(() => conn.bothConnected, async (v) => {
  if (v) { await Promise.all([exLoadJobs(), wbLoadJobs(), conn.loadSFObjects()]) }
})

// Database switch: dbPath changes while both connections stay alive.
// oldPath being non-null distinguishes a switch from the initial open
// (which is already handled by the bothConnected watcher above).
watch(() => conn.dbPath, async (newPath, oldPath) => {
  if (!newPath) {
    // Database closed — clear job lists and reset selection
    exJobs.value = []
    wbJobs.value = []
    selectedJob.value = null
    creating.value = null
    return
  }
  if (oldPath && conn.sfConnected) {
    // Switching from one DB to another while SF is connected
    await flushSelectedJobDraft()
    selectedJob.value = null
    creating.value = null
    await Promise.all([exLoadJobs(), wbLoadJobs()])
  }
})

function onDocClick(): void { exErrorPopover.value = null; newJobMenuOpen.value = false; commentPopup.value = null }
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    exErrorPopover.value = null; newJobMenuOpen.value = false
    if (commentPopup.value) { commentPopup.value = null; return }
  }
}
</script>

<style scoped>
/* ── Split layout ──────────────────────────────────────────────────────────── */
.split-left { flex-shrink: 0; flex-grow: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.job-list-scroll { flex: 1; overflow-y: auto; min-height: 0; }
.split-right { flex: 1; overflow: hidden; min-width: 0; }
.split-divider { width: 5px; flex-shrink: 0; cursor: col-resize; position: relative; z-index: 1; background: transparent; }
.split-divider::after { content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px; border-radius: 99px; background: var(--border); transition: background 0.15s, height 0.15s; }
.split-divider:hover::after, .split-divider:active::after { background: var(--primary); height: 64px; }

/* ── New Job dropdown ──────────────────────────────────────────────────────── */
.new-job-wrap { position: relative; flex-shrink: 0; }
.new-job-btn { display: flex; align-items: center; gap: 2px; }
.new-job-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 50; min-width: 190px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 4px 16px rgba(0,0,0,.18); overflow: hidden;
}
.new-job-menu-item {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 9px 14px; border: none; background: none; cursor: pointer;
  font-size: 13px; font-weight: 500; color: var(--text); text-align: left;
  transition: background 0.1s;
}
.new-job-menu-item:hover { background: var(--surface2); }
.new-job-menu-hint { font-size: 11px; font-weight: 400; color: var(--text-muted); margin-left: auto; }

/* ── Type icons ────────────────────────────────────────────────────────────── */
.type-icon-extract { color: #005fa3; font-size: 13px; flex-shrink: 0; }
.type-icon-wb { color: #a80e00; font-size: 13px; flex-shrink: 0; }

/* ── Job rows ──────────────────────────────────────────────────────────────── */
.job-row {
  display: flex; flex-direction: row; align-items: center;
  padding: 2px 8px 2px 6px; cursor: pointer; gap: 5px;
  border-bottom: 1px solid var(--border);
}
.job-row-detailed { align-items: flex-start; padding-top: 4px; padding-bottom: 4px; }
.job-row-extract { border-left: 3px solid #0176d3; border-bottom-color: color-mix(in srgb, #0176d3 25%, var(--border)); }
.job-row-wb { border-left: 3px solid #166534; border-bottom-color: color-mix(in srgb, #166534 25%, var(--border)); }
.job-row:hover { background: var(--surface2); }
.job-row-extract.selected { background: color-mix(in srgb, #0176d3 10%, transparent); }
.job-row-wb.selected { background: color-mix(in srgb, #653016 10%, transparent); }
.job-row-extract.running { background: color-mix(in srgb, #0176d3 5%, transparent); }
.job-row-wb.running { background: color-mix(in srgb, #166534 5%, transparent); }
.job-row-extract.running.selected { background: color-mix(in srgb, #0176d3 15%, transparent); }
.job-row-wb.running.selected { background: color-mix(in srgb, #166534 15%, transparent); }
.job-row-icons { display: flex; align-items: center; flex-shrink: 0; width: 28px; }
.job-row-detailed .job-row-icons { align-self: flex-start; margin-top: 2px; }
.job-row-icon { font-size: 12px; flex-shrink: 0; width: 12px; text-align: center; box-sizing: border-box; }
.job-row-op-icon { font-family: Georgia, 'Times New Roman', Times, serif; font-size: 13px; font-weight: 700; line-height: 1; flex-shrink: 0; width: 16px; text-align: left; box-sizing: border-box; letter-spacing: -1px; }
.job-row-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.job-row-name-row { display: flex; align-items: center; gap: 3px; min-width: 0; }
.job-row-name { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); flex: 1; min-width: 0; }
.job-comment-icon { flex-shrink: 0; background: none; border: none; padding: 0 1px; font-size: 11px; line-height: 1; color: var(--text-muted); cursor: pointer; opacity: 0.6; }
.job-comment-icon:hover { opacity: 1; }
.job-row-subtitle { font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.form-row-h { display: flex; flex-direction: row; gap: 12px; }
.form-row-h .form-group { flex: 1; min-width: 0; }
.comment-textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: inherit; font-size: 13px; line-height: 1.4; }
.job-row-status { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.job-row-detailed .job-row-status { align-self: flex-start; margin-top: 2px; }
.badge-icon { padding: 1px 5px; font-size: 12px; line-height: 1; }
.job-row-spinner { width: 10px; height: 10px; border-width: 1.5px; flex-shrink: 0; }
.job-row-running-label { font-size: 10px; font-weight: 600; color: var(--primary); text-transform: uppercase; letter-spacing: 0.04em; }
.job-row-queued-label { color: var(--text-muted); }
.job-row-rows { font-size: 11px; color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.job-run-btn { width: 22px; height: 22px; padding: 0; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; font-size: 11px; flex-shrink: 0; }
.job-row-detailed .job-run-btn { align-self: flex-start; margin-top: 1px; }
.job-run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.job-run-btn-extract { border-color: color-mix(in srgb, #005fa3 40%, var(--border)); color: #005fa3; }
.job-run-btn-extract:hover:not(:disabled) { background: color-mix(in srgb, #005fa3 12%, transparent); }
.job-run-btn-wb { border-color: color-mix(in srgb, #a80e00 40%, var(--border)); color: #a80e00; }
.job-run-btn-wb:hover:not(:disabled) { background: color-mix(in srgb, #a80e00 12%, transparent); }

/* ── Right panel panels ────────────────────────────────────────────────────── */
.job-editor, .job-detail { height: 100%; display: flex; flex-direction: column; position: relative; }
.editor-body { padding: 16px; overflow-y: auto; flex: 1; }

/* ── Tab bar ───────────────────────────────────────────────────────────────── */
.tab-bar { display: flex; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.tab-btn { padding: 7px 16px; font-size: 13px; font-weight: 500; border: none; border-bottom: 2px solid transparent; background: none; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; gap: 4px; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; }
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); }

/* ── Tab panels ────────────────────────────────────────────────────────────── */
.tab-panel { flex: 1; overflow-y: auto; min-height: 0; }
.definition-panel { padding: 12px; }
.history-panel { }
.execution-panel { display: flex; flex-direction: column; overflow: hidden; }

/* ── Form elements ─────────────────────────────────────────────────────────── */
.form-actions { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
/* Wraps the Definition tab's fields so they can all be disabled at once while a job is running,
   without a <fieldset>'s default border/margin disrupting the surrounding flex/block layout.
   (display:contents drops the fieldset's own box, but the disabled state still cascades to
   descendant form controls per spec — the browser's default disabled styling applies to them.) */
.definition-fieldset { display: contents; border: none; margin: 0; padding: 0; }
.where-textarea { resize: vertical; min-height: 44px; line-height: 1.4; font-family: monospace; width: 100%; box-sizing: border-box; }
.soql-textarea { resize: vertical; min-height: 120px; line-height: 1.5; font-family: monospace; font-size: 12px; width: 100%; box-sizing: border-box; }
.sql-query-textarea { font-family: monospace; font-size: 12px; field-sizing: content; min-height: 96px; resize: vertical; width: 100%; }
.field-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.qs-msg { font-size: 11px; padding: 2px 0; }
.qs-msg-ok { color: var(--success, #16a34a); }
.qs-msg-error { color: var(--danger); }

/* ── Mode toggle ───────────────────────────────────────────────────────────── */
.mode-toggle { display: flex; gap: 6px; }
.mode-option { display: flex; align-items: center; gap: 5px; padding: 4px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; user-select: none; transition: background 0.12s, border-color 0.12s; }
.mode-option input[type="radio"] { display: none; }
.mode-option.active { background: color-mix(in srgb, #0176d3 12%, transparent); border-color: #0176d3; color: #0176d3; font-weight: 600; }
.mode-option:not(.active):hover { background: var(--surface2); }

/* ── Field & index accordions ──────────────────────────────────────────────── */
.field-accordion, .index-accordion { border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 2px; }
.field-accordion-header, .index-accordion-header { display: flex; align-items: center; gap: 6px; width: 100%; background: var(--surface2); border: none; border-radius: var(--radius-sm); padding: 6px 10px; cursor: pointer; text-align: left; font-size: 13px; font-weight: 500; color: var(--text-muted); transition: background 0.1s; }
.field-accordion-header:hover, .index-accordion-header:hover { background: var(--border); }
.field-accordion-title, .index-accordion-title { display: flex; align-items: center; gap: 6px; font-weight: 500; color: var(--text-muted); white-space: nowrap; }
.field-accordion-summary { flex: 1; font-size: 12px; color: var(--primary); font-weight: 500; padding-left: 8px; }
.field-accordion-body { padding: 6px 4px 8px; }
.index-accordion-body { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }
.index-accordion-hint { flex: 1; font-size: 11px; color: var(--text-muted); font-weight: 400; padding-left: 4px; }
.index-accordion-chevron { font-size: 14px; color: var(--text-muted); transition: transform 0.2s; }
.index-accordion-chevron.open { transform: rotate(180deg); }
.index-count-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; background: var(--primary); color: var(--primary-text); border-radius: 999px; font-size: 11px; font-weight: 700; line-height: 1; }
.index-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.index-tag { display: inline-flex; align-items: center; gap: 4px; background: var(--primary); color: var(--primary-text); padding: 2px 6px 2px 8px; border-radius: 999px; font-size: 12px; font-family: monospace; }
.index-tag-remove { background: none; border: none; color: inherit; cursor: pointer; padding: 0; line-height: 1; font-size: 11px; opacity: 0.75; }
.index-tag-remove:hover { opacity: 1; }
.index-input-wrap { position: relative; }
.index-input { width: 100%; box-sizing: border-box; font-size: 12px; }
.index-suggestions { position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 50; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; margin: 0; padding: 4px 0; list-style: none; max-height: 200px; overflow-y: auto; box-shadow: var(--shadow, 0 4px 12px rgba(0,0,0,.12)); color: var(--text); }
.index-suggestions.index-suggestions-static { position: static; box-shadow: none; margin-top: 4px; border-radius: var(--radius-sm); }
.index-suggestions li { padding: 5px 12px; font-size: 12px; font-family: monospace; cursor: pointer; color: var(--text); }
.index-suggestions li:hover { background: var(--surface2); }
.index-suggestions-empty { color: var(--text-muted) !important; cursor: default !important; font-style: italic; }
.index-suggestions-empty:hover { background: transparent !important; }

/* ── History ───────────────────────────────────────────────────────────────── */
.history-table { font-size: 12px; width: 100%; }
.history-table th, .history-table td { padding: 4px 12px; }
.history-section { flex: 1; overflow-y: auto; }
.error-cell { color: var(--danger); cursor: pointer; font-size: 13px; line-height: 1; opacity: 0.8; }
.error-cell:hover { opacity: 1; }
.error-popover { position: absolute; z-index: 100; width: 320px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 4px 16px rgba(0,0,0,0.18); font-size: 12px; }
.error-popover-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 11px; color: var(--danger); }
.error-popover-body { padding: 8px 10px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
.btn-icon { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-muted); padding: 0 2px; line-height: 1; }
.btn-icon:hover { color: var(--text); }

/* ── WB Execution ──────────────────────────────────────────────────────────── */
.execution-section { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.exec-phase-bar { padding: 6px 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); flex-shrink: 0; font-size: 13px; min-height: 34px; flex-wrap: wrap; }
.exec-stats { padding: 8px 12px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); font-size: 13px; flex-shrink: 0; flex-wrap: wrap; }
.exec-action-bar { padding: 4px 12px 6px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.exec-error-bar { padding: 4px 12px 6px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.exec-status-filter { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.exec-filter-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); font-size: 12px; cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s; }
.exec-filter-pill:hover { background: var(--surface-hover, var(--border)); color: var(--text); }
.exec-filter-pill.active { background: var(--surface-hover, var(--border)); color: var(--text); border-color: var(--text-muted); }
.exec-filter-pill--ok.active { background: color-mix(in srgb, var(--success) 25%, transparent); color: var(--success); border-color: var(--success); }
.exec-filter-pill--error.active { background: color-mix(in srgb, var(--danger) 25%, transparent); color: var(--danger); border-color: var(--danger); }
.exec-filter-pill--queued.active { background: color-mix(in srgb, #1a7fc4 25%, transparent); color: #1a7fc4; border-color: #1a7fc4; }
.exec-filter-count { font-variant-numeric: tabular-nums; }
.exec-banner { padding: 10px 14px; display: flex; align-items: flex-start; gap: 12px; font-size: 13px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.exec-banner-error { background: color-mix(in srgb, var(--danger) 12%, var(--surface)); color: var(--danger); }
.exec-banner-warn { background: color-mix(in srgb, var(--warning, #f59e0b) 12%, var(--surface)); color: var(--text); }
.failed-rows-header { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; }
.error-filter-bar { display: flex; align-items: center; gap: 6px; }
.error-filter-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.error-filter-select { font-size: 12px; padding: 2px 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); max-width: 480px; }
.error-filter-inline { font-size: 11px; padding: 1px 4px; max-width: 220px; border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.row-count-result { font-size: 13px; font-weight: 600; color: var(--text); }
.row-count-error { font-size: 12px; color: var(--danger, #dc2626); }
.bulk-phase-card { padding: 24px; display: flex; flex-direction: column; align-items: flex-start; }
.bulk-phase-row { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text); }

/* ── WB Custom headers ─────────────────────────────────────────────────────── */
.suggest-wrap { position: relative; }
.suggest-list { position: absolute; top: 100%; left: 0; right: 0; z-index: 50; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: 0 4px 12px rgba(0,0,0,0.15); overflow: hidden; margin-top: 2px; }
.suggest-item { display: flex; flex-direction: column; padding: 7px 10px; cursor: pointer; gap: 2px; border-bottom: 1px solid var(--border); }
.suggest-item:last-child { border-bottom: none; }
.suggest-item:hover, .suggest-item.active { background: color-mix(in srgb, var(--primary) 10%, transparent); }
.suggest-name { font-size: 13px; font-weight: 500; color: var(--text); }
.suggest-preview { font-size: 11px; color: var(--text-muted); font-family: monospace; }

/* ── WB Operation selector ─────────────────────────────────────────────────── */
.op-selector { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 4px; }
.radio-label { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 13px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; }
.checkboxes-group { display: flex; flex-direction: column; gap: 8px; }

/* ── Distribution key ──────────────────────────────────────────────────────── */
.distrib-key-input { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 34px; padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: text; position: relative; }
.distrib-key-tag { display: inline-flex; align-items: center; gap: 3px; padding: 2px 4px 2px 8px; background: color-mix(in srgb, var(--primary) 14%, transparent); border: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border)); border-radius: 10px; font-size: 12px; color: var(--primary); font-weight: 500; }
.distrib-key-tag-remove { background: none; border: none; cursor: pointer; color: var(--primary); padding: 0 2px; font-size: 15px; line-height: 1; opacity: 0.6; }
.distrib-key-tag-remove:hover { opacity: 1; }
.distrib-key-search { border: none; outline: none; background: transparent; font-size: 13px; color: var(--text); min-width: 90px; flex: 1; padding: 2px 0; }
.distrib-key-search::placeholder { color: var(--text-muted); }
.distrib-key-dropdown { position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 50; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-height: 180px; overflow-y: auto; }
.distrib-key-option { padding: 6px 10px; font-size: 13px; cursor: pointer; color: var(--text); }
.distrib-key-option:hover { background: color-mix(in srgb, var(--primary) 10%, transparent); }
.distrib-key-list--disabled { opacity: 0.4; pointer-events: none; }
.distrib-key-hint { margin: 6px 0 0; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.distrib-key-hint code { font-family: monospace; font-size: 11px; background: color-mix(in srgb, var(--primary) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--primary) 18%, var(--border)); border-radius: 3px; padding: 0 4px; }

/* ── Schema panel ──────────────────────────────────────────────────────────── */
.wb-schema-panel { width: 220px; flex-shrink: 0; border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; position: relative; overflow: hidden; }
.schema-resize-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 10; background: transparent; }
.schema-resize-handle::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px; border-radius: 99px; background: var(--border); transition: background 0.15s, height 0.15s; }
.schema-resize-handle:hover::after, .schema-resize-handle:active::after { background: var(--primary); height: 64px; }
.schema-tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.schema-tab { flex: 1; padding: 6px 4px; font-size: 12px; font-weight: 500; background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; color: var(--text-muted); transition: color 0.15s; }
.schema-tab:hover { color: var(--text); }
.schema-tab.active { color: var(--primary); border-bottom-color: var(--primary); }

/* ── Update IDs modal ──────────────────────────────────────────────────────── */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 200; display: flex; align-items: center; justify-content: center; }
.modal-box { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 32px rgba(0,0,0,0.25); display: flex; flex-direction: column; max-height: 90vh; overflow: hidden; width: 440px; }
.update-ids-modal { width: 520px; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-body { padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 14px; }
.modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); flex-shrink: 0; }
.form-row { display: flex; flex-direction: column; gap: 5px; }
.form-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.form-hint { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 11px; color: var(--text-muted); }
.form-select, .form-input { padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font-size: 13px; width: 100%; }
.update-ids-preview { background: color-mix(in srgb, var(--primary) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--primary) 20%, var(--border)); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px; line-height: 1.6; }
.update-ids-error { background: color-mix(in srgb, var(--danger) 12%, var(--surface)); color: var(--danger); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px; }
.update-ids-success { display: flex; align-items: flex-start; gap: 12px; background: color-mix(in srgb, var(--success) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--success) 25%, var(--border)); border-radius: var(--radius-sm); padding: 16px; color: var(--success); }
.update-ids-info { background: color-mix(in srgb, var(--primary) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--primary) 20%, var(--border)); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13px; }
.update-ids-index-note { margin-top: 5px; font-size: 12px; color: color-mix(in srgb, var(--warning, #f59e0b) 90%, var(--text)); background: color-mix(in srgb, var(--warning, #f59e0b) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 25%, var(--border)); border-radius: var(--radius-sm); padding: 6px 10px; }

/* ── Comment popup (rendered via Teleport, needs :global) ──────────────────── */
:global(.comment-overlay) {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
:global(.comment-popup) {
  position: fixed;
  z-index: 9999;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  max-width: 320px;
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: auto;
}
</style>
