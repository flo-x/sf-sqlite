<template>
  <div class="query-view" v-if="conn.dbConnected">
    <div class="query-main" ref="queryMain">
      <!-- Tab bar -->
      <div class="tab-bar">
        <button class="tab-open-btn" @click="openSavedQueriesPanel" title="Open saved query">📂</button>
        <div
          v-for="tab in queryStore.tabs"
          :key="tab.key"
          class="tab-item"
          :class="{ active: queryStore.activeTabKey === tab.key }"
          @click="queryStore.setActiveTab(tab.key)"
          @dblclick.stop="startTabRename(tab.key)"
        >
          <span v-if="!renamingTab || renamingTab !== tab.key" class="tab-label">{{ tab.name }}</span>
          <input
            v-else
            :ref="(el) => { if(el) (el as HTMLInputElement).focus() }"
            v-model="renameValue"
            class="tab-rename-input"
            @keyup.enter="confirmTabRename(tab.key)"
            @keyup.escape="renamingTab = null"
            @blur="renamingTab = null"
            @click.stop
          />
          <span
            class="tab-save"
            :class="{ dirty: tab.sqlText !== tab.savedSqlText }"
            @click.stop="saveTab(tab.key)"
            title="Save"
          >💾</span>
          <span class="tab-close" @click.stop="closeTab(tab.key)">×</span>
        </div>
        <button class="btn btn-ghost btn-sm" @click="queryStore.newTab()" style="padding: 4px 10px; border-radius:0;">+</button>
      </div>

      <!-- Toolbar -->
      <div class="toolbar" v-if="activeTab">
        <div class="execute-group">
          <div class="execute-mode-toggle">
            <button
              class="mode-btn"
              :class="{ active: executingMode === 'sqlite' }"
              @click="executingMode = 'sqlite'"
              title="Execute against SQLite"
            >SQLite</button>
            <button
              class="mode-btn"
              :class="{ active: executingMode === 'soql' }"
              :disabled="!conn.sfConnected"
              :title="conn.sfConnected ? 'Execute against Salesforce' : 'Connect to Salesforce first'"
              @click="executingMode = 'soql'"
            >SOQL</button>
          </div>
          <button
            class="btn btn-primary btn-sm"
            :disabled="activeTab.executing || (executingMode === 'soql' && !conn.sfConnected)"
            @click="runQuery(executingMode)"
          >
            <span v-if="activeTab.executing" class="spinner" style="width:12px;height:12px;border-width:2px;"></span>
            ▶ Execute {{ executingMode === 'soql' ? 'SOQL' : 'SQLite' }}
          </button>
        </div>
        <span style="font-size:11px; color:var(--text-muted);">{{ isMac ? '⌘↵' : 'Ctrl+Enter' }}</span>
        <div class="toolbar-sep"></div>
        <button
          v-if="executingMode === 'sqlite'"
          class="btn btn-secondary btn-sm"
          :disabled="!conn.sfConnected"
          :title="conn.sfConnected ? 'Create an upload job from this query' : 'Connect to Salesforce first'"
          @click="sendToWriteback"
        >⬆ Upload to SF</button>
        <button
          v-if="executingMode === 'soql'"
          class="btn btn-secondary btn-sm"
          :disabled="!conn.sfConnected"
          :title="conn.sfConnected ? 'Create an extraction job from this query' : 'Connect to Salesforce first'"
          @click="sendToExtract"
        >⬇ Download</button>
        <div class="toolbar-right">
          <span v-if="activeTab.result" style="font-size:12px; color:var(--text-muted);">{{ activeTab.result.totalCount.toLocaleString() }} rows · {{ activeTab.result.durationMs }}ms</span>
          <button
            class="btn btn-secondary btn-sm ai-toggle-btn"
            :class="{ active: aiDrawerOpen }"
            title="AI Assistant"
            @click="aiDrawerOpen = !aiDrawerOpen"
          >AI</button>
        </div>
      </div>

      <!-- Editor area -->
      <div class="editor-area" :style="{ flexBasis: editorHeight + 'px' }" ref="editorArea" @dragover.prevent @drop="onEditorDrop">
        <div ref="monacoContainer" class="monaco-container"></div>
      </div>

      <!-- Horizontal drag divider -->
      <div class="h-split-divider" @mousedown.prevent="startEditorDrag"></div>

      <!-- Results -->
      <div class="results-area" v-if="activeTab?.result || activeTab?.executing">
        <div v-if="activeTab.executing" style="padding:16px; display:flex; align-items:center; gap:8px;">
          <span class="spinner"></span> Executing…
        </div>
        <div v-else-if="activeTab.result?.error" class="query-error">
          <span class="query-error-label">Error</span>
          <pre class="query-error-msg">{{ activeTab.result.error }}</pre>
        </div>
        <DataGrid
          v-else-if="activeTab.result"
          :columns="activeTab.result.columns"
          :rows="activeTab.result.rows"
          :durationMs="activeTab.result.durationMs"
          :showRowNumbers="true"
          :totalRowCount="activeTab.result.totalCount"
          :onPageChange="activeTab.result.sql ? navigateResultPage : undefined"
          :externalOffset="activeTab.result.offset"
          :pageSize="QUERY_PAGE_SIZE"
          :onExportCsv="exportCsv"
          :onSortChange="activeTab.result.sql ? handleSortChange : undefined"
          :externalSortCriteria="activeTab.result.sql ? activeTab.sortCriteria : undefined"
          style="height: 100%;"
        />
      </div>
    </div>

    <!-- Schema / AI browser -->
    <div class="schema-panel" ref="schemaPanel">
      <div class="schema-resize-handle" @mousedown="startPanelResize"></div>
      <div class="schema-tabs">
        <button
          class="schema-tab"
          :class="{ active: schemaTab === 'sqlite' }"
          @click="schemaTab = 'sqlite'"
        >SQLite</button>
        <button
          class="schema-tab"
          :class="{ active: schemaTab === 'sf' }"
          @click="schemaTab = 'sf'"
        >Salesforce</button>
      </div>
      <SchemaBrowser
        v-show="schemaTab === 'sqlite'"
        :tables="conn.dbTables"
        @insert="insertAtCursor"
        @openExplorer="(name) => $router.push('/explorer')"
      />
      <SFSchemaBrowser
        v-show="schemaTab === 'sf'"
        :objects="conn.sfObjects"
        @insert="insertAtCursor"
      />
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
      <AiChatPanel @insert-sql="insertSqlFromAi" @insert-js="openInScriptEditor" style="flex:1;min-height:0;overflow:hidden;" />
    </div>

    <!-- Unsaved dialog -->
    <div v-if="unsavedDialog" class="modal-backdrop">
      <div class="modal-box">
        <h3>Unsaved Changes</h3>
        <p>Save changes to "{{ unsavedDialog.name }}" before closing?</p>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
          <button class="btn btn-ghost btn-sm" @click="unsavedDialog = null">Cancel</button>
          <button class="btn btn-secondary btn-sm" @click="discardAndClose">Discard</button>
          <button class="btn btn-primary btn-sm" @click="saveAndClose">Save</button>
        </div>
      </div>
    </div>

    <!-- Open Saved Queries dialog -->
    <div v-if="openSavedDialog" class="modal-backdrop" @click.self="openSavedDialog = false">
      <div class="modal-box modal-box-lg">
        <h3>Saved Queries</h3>
        <div v-if="savedQueriesList.length === 0" style="color:var(--text-muted); font-size:13px; margin-top:8px;">
          No saved queries yet.
        </div>
        <div v-else class="saved-query-list">
          <div
            v-for="q in savedQueriesList"
            :key="q.id"
            class="saved-query-item"
            @click="openSavedQuery(q)"
            :title="q.sqlText"
          >
            <span class="saved-query-name">{{ q.name }}</span>
            <button class="btn btn-ghost btn-sm saved-query-del" @click.stop="showDeleteConfirm(q)" title="Delete this query">🗑</button>
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:16px;">
          <button class="btn btn-ghost btn-sm" @click="openSavedDialog = false">Close</button>
        </div>
      </div>
    </div>

    <!-- Delete saved query confirmation -->
    <div v-if="deleteConfirmDialog" class="modal-backdrop">
      <div class="modal-box">
        <h3>Delete Saved Query</h3>
        <p>Delete "{{ deleteConfirmDialog.name }}" permanently? <strong>This cannot be undone.</strong></p>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
          <button class="btn btn-ghost btn-sm" @click="deleteConfirmDialog = null">Cancel</button>
          <button class="btn btn-danger btn-sm" @click="doDeleteSavedQuery">Delete</button>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="empty-state" style="height:100%;">
    <div class="empty-state-icon">💻</div>
    <div>Open a SQLite database first</div>
    <router-link to="/connections" class="btn btn-primary btn-sm">Go to Connections</router-link>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onDeactivated, onUnmounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import * as monaco from 'monaco-editor'
import { EDITOR_BASE_OPTIONS } from '../utils/monaco'

const isMac = navigator.platform.startsWith('Mac')
import { useConnectionStore } from '../stores/connection'
import { useQueryStore } from '../stores/query'
import DataGrid from '../components/DataGrid.vue'
import SchemaBrowser from '../components/SchemaBrowser.vue'
import SFSchemaBrowser from '../components/SFSchemaBrowser.vue'
import AiChatPanel from '../components/AiChatPanel.vue'
import type { JobResult, SavedQuery, QueryDraft, PagedQueryResult, SortCriterion } from '../../../shared/types'

const QUERY_PAGE_SIZE = 100000

const conn = useConnectionStore()
const queryStore = useQueryStore()

const monacoContainer = ref<HTMLElement | null>(null)
const editorArea = ref<HTMLElement | null>(null)
const schemaPanel = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
const tabViewStates = new Map<string, monaco.editor.ICodeEditorViewState>()

const executingMode = ref<'sqlite' | 'soql'>('sqlite')
const schemaTab = ref<'sqlite' | 'sf'>('sqlite')
const aiDrawerOpen = ref(false)
const aiPanel = ref<HTMLElement | null>(null)
const AI_WIDTH_KEY = 'ai-panel-width'
const aiPanelWidth = ref(parseInt(localStorage.getItem(AI_WIDTH_KEY) ?? '400', 10))
const renamingTab = ref<string | null>(null)
const renameValue = ref('')
const router = useRouter()
const unsavedDialog = ref<{ key: string; name: string } | null>(null)
const openSavedDialog = ref(false)
const savedQueriesList = ref<SavedQuery[]>([])
const deleteConfirmDialog = ref<{ id: number; name: string } | null>(null)

interface UnsavedPending { key: string }
const pendingClose = ref<UnsavedPending | null>(null)

const activeTab = computed(() => queryStore.getActiveTab())

// Register SQLite language
function registerSQLite(): void {
  if (monaco.languages.getLanguages().some((l) => l.id === 'sqlite')) return
  monaco.languages.register({ id: 'sqlite' })
  monaco.languages.setMonarchTokensProvider('sqlite', {
    keywords: [
      'SELECT', 'FROM', 'WHERE', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
      'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP',
      'ALTER', 'INDEX', 'VIEW', 'TRIGGER', 'PRAGMA', 'VACUUM', 'ATTACH', 'DETACH',
      'REINDEX', 'EXPLAIN', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
      'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'ON', 'USING',
      'AS', 'DISTINCT', 'ALL', 'UNION', 'INTERSECT', 'EXCEPT', 'IN', 'NOT', 'AND', 'OR',
      'IS', 'NULL', 'TRUE', 'FALSE', 'LIKE', 'GLOB', 'REGEXP', 'MATCH', 'BETWEEN',
      'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'OVER', 'PARTITION', 'WINDOW',
      'ROWS', 'RANGE', 'WITHOUT', 'ROWID', 'STRICT', 'RETURNING',
    ],
    builtinFunctions: [
      'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'IFNULL', 'NULLIF', 'IIF',
      'CAST', 'TYPEOF', 'LENGTH', 'SUBSTR', 'REPLACE', 'TRIM', 'LTRIM', 'RTRIM',
      'UPPER', 'LOWER', 'INSTR', 'HEX', 'QUOTE', 'RANDOMBLOB', 'ZEROBLOB', 'RANDOM',
      'ABS', 'ROUND', 'FLOOR', 'CEIL', 'SIGN', 'MOD', 'POWER', 'SQRT', 'LOG',
      'DATE', 'TIME', 'DATETIME', 'JULIANDAY', 'STRFTIME', 'UNIXEPOCH',
      'JSON', 'JSON_ARRAY', 'JSON_OBJECT', 'JSON_EXTRACT', 'JSON_EACH', 'JSON_TREE',
      'JSON_INSERT', 'JSON_REPLACE', 'JSON_PATCH', 'JSON_REMOVE', 'JSON_QUOTE',
      'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
      'NTH_VALUE', 'NTILE', 'PERCENT_RANK', 'CUME_DIST',
    ],
    tokenizer: {
      root: [
        [/--.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/'[^']*'/, 'string'],
        [/"[^"]*"/, 'identifier'],
        [/`[^`]*`/, 'identifier'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[(),;.]/, 'delimiter'],
        [/[<>=!+\-*/%&|^~]/, 'operator'],
        [/\b([A-Za-z_][A-Za-z0-9_]*)\b/, {
          cases: {
            '@keywords': 'keyword',
            '@builtinFunctions': 'predefined',
            '@default': 'identifier'
          }
        }],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ]
    }
  })

  monaco.languages.registerCompletionItemProvider('sqlite', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position)
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      const textBefore = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column }).toUpperCase()

      const suggestions: monaco.languages.CompletionItem[] = []

      // Table names after FROM / JOIN
      if (/\b(FROM|JOIN|UPDATE|INTO)\s+\w*$/.test(textBefore)) {
        for (const t of conn.dbTables) {
          suggestions.push({ label: t.name, kind: monaco.languages.CompletionItemKind.Class, insertText: t.name, range })
        }
      }

      // Column names after tableName.
      const dotMatch = textBefore.match(/(\w+)\.\s*\w*$/)
      if (dotMatch) {
        const tbl = conn.dbTables.find((t) => t.name.toUpperCase() === dotMatch[1].toUpperCase())
        if (tbl) {
          for (const c of tbl.columns) {
            suggestions.push({ label: c.name, kind: monaco.languages.CompletionItemKind.Field, insertText: c.name, range })
          }
        }
      }

      // Always: table names + column names + keywords
      for (const t of conn.dbTables) {
        suggestions.push({ label: t.name, kind: monaco.languages.CompletionItemKind.Class, insertText: t.name, range, sortText: 'b' + t.name })
        for (const c of t.columns) {
          suggestions.push({ label: c.name, detail: t.name, kind: monaco.languages.CompletionItemKind.Field, insertText: c.name, range, sortText: 'c' + c.name })
        }
      }

      return { suggestions }
    }
  })
}

function syncEditorHeight(): void {
  if (editorArea.value) editorHeight.value = editorArea.value.offsetHeight
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    runQuery(executingMode.value)
  }
}

// ── Draft auto-save ────────────────────────────────────────────────────────────
const IDLE_DRAFT_MS = 60_000
let idleDraftTimer: ReturnType<typeof setTimeout> | null = null
let cleanupBeforeQuit: (() => void) | null = null

async function saveDraftAllTabs(): Promise<void> {
  // Ensure the active tab's current view state is captured before iterating
  if (editor && queryStore.activeTabKey) {
    const vs = editor.saveViewState()
    if (vs) {
      tabViewStates.set(queryStore.activeTabKey, vs)
    }
  }
  for (const [i, tab] of queryStore.tabs.entries()) {
    const vs = tabViewStates.get(tab.key)
    await window.api.upsertQueryDraft({
      tabKey: tab.key,
      savedId: tab.savedId,
      name: tab.name,
      sqlText: tab.sqlText,
      tabOrder: i,
      viewState: vs ? JSON.stringify(vs) : null
    } satisfies Omit<QueryDraft, 'updatedAt'>)
  }
}

function scheduleIdleDraft(): void {
  if (idleDraftTimer !== null) clearTimeout(idleDraftTimer)
  idleDraftTimer = setTimeout(() => { void saveDraftAllTabs() }, IDLE_DRAFT_MS)
}

function onWindowBlur(): void { void saveDraftAllTabs() }

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('blur', onWindowBlur)

  cleanupBeforeQuit = window.api.onBeforeQuit(async () => {
    await saveDraftAllTabs()
    await window.api.notifyDraftsQuitReady()
  })

  if (!conn.dbConnected) return
  if (!queryStore.initialized) {
    const [drafts, savedQueries] = await Promise.all([
      window.api.listQueryDrafts(),
      window.api.listSavedQueries()
    ])
    if (drafts.length > 0) {
      queryStore.loadFromDrafts(drafts, savedQueries)
    } else {
      queryStore.loadFromSaved(savedQueries)
    }
  }
  await nextTick()
  syncEditorHeight()
  initEditor()
})

onDeactivated(() => {
  if (editor && queryStore.activeTabKey) {
    const vs = editor.saveViewState()
    if (vs) {
      tabViewStates.set(queryStore.activeTabKey, vs)
    }
  }
})

onActivated(() => {
  if (!editor || !activeTab.value) return
  const model = editor.getModel()
  if (model && model.getValue() !== activeTab.value.sqlText) {
    model.setValue(activeTab.value.sqlText)
  }
  const savedKey = queryStore.activeTabKey
  nextTick(() => {
    syncEditorHeight()
    if (savedKey) {
      const vs = tabViewStates.get(savedKey)
      editor!.restoreViewState(vs ?? null)
    }
  })
})

function seedViewStatesFromStore(): void {
  for (const tab of queryStore.tabs) {
    if (tab.viewState) {
      try {
        tabViewStates.set(tab.key, JSON.parse(tab.viewState))
      } catch { /* ignore corrupt data */ }
    }
  }
}

function initEditor(): void {
  if (!monacoContainer.value) return
  registerSQLite()
  editor = monaco.editor.create(monacoContainer.value, {
    ...EDITOR_BASE_OPTIONS,
    value: activeTab.value?.sqlText ?? '',
    language: 'sqlite',
    suggestOnTriggerCharacters: true,
    dragAndDrop: false,
    dropIntoEditor: { enabled: false },
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runQuery(executingMode.value))
  editor.addCommand(monaco.KeyCode.F5, () => runQuery(executingMode.value))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveQuery())

  editor.onDidChangeModelContent(() => {
    const key = queryStore.activeTabKey
    if (key) queryStore.updateSql(key, editor!.getValue())
    scheduleIdleDraft()
  })

  // Seed the view-state map from whatever was loaded from the database, then
  // immediately apply the active tab's position so the first render is correct.
  seedViewStatesFromStore()
  if (queryStore.activeTabKey) {
    const vs = tabViewStates.get(queryStore.activeTabKey)
    if (vs) {
      editor.restoreViewState(vs)
    }
  }
}

watch(() => queryStore.activeTabKey, (newKey, oldKey) => {
  if (editor && activeTab.value) {
    if (oldKey) {
      const vs = editor.saveViewState()
      if (vs) {
        tabViewStates.set(oldKey, vs)
      }
    }
    const model = editor.getModel()
    if (model) {
      model.setValue(activeTab.value.sqlText)
    }
    const vs = newKey ? tabViewStates.get(newKey) : undefined
    editor.restoreViewState(vs ?? null)
  }
})

watch(executingMode, (mode) => {
  if (schemaTab.value !== 'ai') {
    schemaTab.value = mode === 'soql' ? 'sf' : 'sqlite'
  }
})

watch(() => conn.dbConnected, async (v) => {
  if (v) {
    const [drafts, savedQueries] = await Promise.all([
      window.api.listQueryDrafts(),
      window.api.listSavedQueries()
    ])
    if (drafts.length > 0) {
      queryStore.loadFromDrafts(drafts, savedQueries)
    } else {
      queryStore.loadFromSaved(savedQueries)
    }
    await nextTick()
    syncEditorHeight()
    if (!editor) initEditor()
  }
})

function insertAtCursor(text: string): void {
  if (!editor) return
  const pos = editor.getPosition()
  if (!pos) return
  editor.executeEdits('schema-browser', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text }])
  editor.focus()
}

function openInScriptEditor(code: string): void {
  router.push({ path: '/scripts', state: { pendingCode: code } })
}

function insertSqlFromAi(sql: string): void {
  if (!editor) return
  const model = editor.getModel()
  if (!model) return
  const currentValue = model.getValue().trim()
  if (currentValue === '') {
    // Replace entire content when editor is empty
    model.setValue(sql)
  } else {
    // Insert at cursor position
    const pos = editor.getPosition()
    if (!pos) return
    editor.executeEdits('ai-chat', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: sql }])
  }
  editor.focus()
}

function onEditorDrop(e: DragEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const text = e.dataTransfer?.getData('text/plain')
  if (!text || !editor) return
  const target = editor.getTargetAtClientPoint(e.clientX, e.clientY)
  if (!target?.position) return
  editor.executeEdits('dnd', [{ range: new monaco.Range(target.position.lineNumber, target.position.column, target.position.lineNumber, target.position.column), text }])
  editor.focus()
}

/**
 * Returns the text to execute:
 *  - If there is a non-empty selection, return that.
 *  - Else if the current line is non-empty, expand up and down to collect all
 *    adjacent non-empty lines (the "paragraph" / statement block), highlight
 *    that range in the editor, and return it.
 *  - Else return the full editor content.
 */
function getEffectiveQuery(): string {
  const tab = activeTab.value
  if (!editor || !tab) return tab?.sqlText ?? ''

  const model = editor.getModel()
  if (!model) return tab.sqlText

  const sel = editor.getSelection()
  if (sel && !sel.isEmpty()) {
    return model.getValueInRange(sel)
  }

  const pos = editor.getPosition()
  if (!pos) return tab.sqlText

  const currentLine = model.getLineContent(pos.lineNumber)
  if (!currentLine.trim()) {
    return tab.sqlText
  }

  // Expand to adjacent non-empty lines
  let start = pos.lineNumber
  let end = pos.lineNumber
  const total = model.getLineCount()
  while (start > 1 && model.getLineContent(start - 1).trim()) start--
  while (end < total && model.getLineContent(end + 1).trim()) end++

  const range = new monaco.Range(start, 1, end, model.getLineLength(end) + 1)
  editor.setSelection(range)
  return model.getValueInRange(range)
}

async function runQuery(mode: 'sqlite' | 'soql'): Promise<void> {
  const tab = activeTab.value
  if (!tab) return
  const queryText = getEffectiveQuery()
  if (!queryText.trim()) return

  void saveDraftAllTabs()  // draft on execute (fire-and-forget)
  executingMode.value = mode
  queryStore.setExecuting(tab.key, true)
  queryStore.updateSortCriteria(tab.key, [])
  try {
    let result: PagedQueryResult
    if (mode === 'soql') {
      const raw = await window.api.runSoqlQuery(queryText)
      result = {
        ...raw,
        totalCount: raw.rows.length,
        offset: 0,
        pageSize: raw.rows.length || QUERY_PAGE_SIZE,
        sql: ''  // empty sql = no server-side page navigation (SOQL is already fully loaded)
      }
    } else {
      const raw = await window.api.queryInit(queryText, QUERY_PAGE_SIZE)
      result = { ...raw, offset: 0, pageSize: QUERY_PAGE_SIZE, sql: raw.error ? '' : queryText }
    }
    queryStore.setResult(tab.key, result)
  } catch (err) {
    queryStore.setResult(tab.key, {
      columns: [], rows: [], durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
      totalCount: 0, offset: 0, pageSize: QUERY_PAGE_SIZE, sql: ''
    })
  } finally {
    queryStore.setExecuting(tab.key, false)
  }
}

async function navigateResultPage(newOffset: number): Promise<void> {
  const tab = activeTab.value
  if (!tab?.result?.sql) return
  try {
    const orderBy = sortCriteriaToOrderBy(tab)
    const { rows } = await window.api.queryPage(tab.result.sql, newOffset, QUERY_PAGE_SIZE, orderBy)
    queryStore.updateResultPage(tab.key, rows, newOffset)
  } catch {
    // Silently ignore — the current page stays displayed
  }
}

async function handleSortChange(criteria: SortCriterion[]): Promise<void> {
  const tab = activeTab.value
  if (!tab?.result?.sql) return
  queryStore.updateSortCriteria(tab.key, criteria)
  try {
    const orderBy = criteria.map((c) => ({
      column: tab.result!.columns[c.colIdx],
      dir: c.dir
    }))
    const { rows } = await window.api.queryPage(tab.result.sql, 0, QUERY_PAGE_SIZE, orderBy)
    queryStore.updateResultPage(tab.key, rows, 0)
  } catch {
    // Silently ignore — the current page stays displayed
  }
}

function sortCriteriaToOrderBy(tab: { result: PagedQueryResult | null; sortCriteria: SortCriterion[] }): { column: string; dir: 'asc' | 'desc' }[] | undefined {
  if (!tab.sortCriteria.length || !tab.result) return undefined
  return tab.sortCriteria.map((c) => ({
    column: tab.result!.columns[c.colIdx],
    dir: c.dir
  }))
}

function sendToExtract(): void {
  const queryText = getEffectiveQuery().trim()
  if (!queryText) return
  router.push({ path: '/jobs', state: { pendingSoql: queryText } })
}

function sendToWriteback(): void {
  const queryText = getEffectiveQuery().trim()
  if (!queryText) return
  router.push({ path: '/jobs', state: { pendingSql: queryText } })
}

async function saveTab(key: string): Promise<void> {
  const tab = queryStore.tabs.find((t) => t.key === key)
  if (!tab) return
  // Capture the current view state: use the live editor state for the active tab,
  // or whatever is already stored for background tabs.
  let viewState: string | null = null
  if (editor && key === queryStore.activeTabKey) {
    const vs = editor.saveViewState()
    viewState = vs ? JSON.stringify(vs) : null
  } else {
    const vs = tabViewStates.get(key)
    viewState = vs ? JSON.stringify(vs) : null
  }
  const saved = await window.api.saveQuery({
    id: tab.savedId ?? undefined,
    name: tab.name,
    sqlText: tab.sqlText,
    tabOrder: queryStore.tabs.indexOf(tab),
    viewState
  })
  queryStore.markSaved(tab.key, saved.id, saved.name, saved.sqlText)
}

async function saveQuery(): Promise<void> {
  if (activeTab.value) await saveTab(activeTab.value.key)
}

async function openSavedQueriesPanel(): Promise<void> {
  savedQueriesList.value = await window.api.listSavedQueries()
  openSavedDialog.value = true
}

function openSavedQuery(q: SavedQuery): void {
  const existing = queryStore.tabs.find((t) => t.savedId === q.id)
  if (existing) {
    queryStore.setActiveTab(existing.key)
  } else {
    const tab = queryStore.newTab(q.name, q.sqlText)
    queryStore.markSaved(tab.key, q.id, q.name, q.sqlText)
    if (q.viewState) {
      try {
        tabViewStates.set(tab.key, JSON.parse(q.viewState))
      } catch { /* ignore corrupt data */ }
    }
  }
  openSavedDialog.value = false
}

function showDeleteConfirm(q: SavedQuery): void {
  deleteConfirmDialog.value = { id: q.id, name: q.name }
}

async function doDeleteSavedQuery(): Promise<void> {
  if (!deleteConfirmDialog.value) return
  const { id } = deleteConfirmDialog.value
  deleteConfirmDialog.value = null
  const existingTab = queryStore.tabs.find((t) => t.savedId === id)
  if (existingTab) queryStore.closeTab(existingTab.key)
  await window.api.deleteQuery(id)
  savedQueriesList.value = await window.api.listSavedQueries()
}

function buildCsv(columns: string[], rows: unknown[][]): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s
  }
  return [columns.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n')
}

async function exportCsv(): Promise<void> {
  const tab = activeTab.value
  if (!tab?.result) return
  if (tab.result.sql) {
    // Server-side export: main process runs the full query and writes the CSV directly
    await window.api.exportQueryCsv(tab.result.sql)
  } else {
    // SOQL or error result: all rows are already in the renderer
    await window.api.exportToCsv(buildCsv(tab.result.columns, tab.result.rows))
  }
}

function closeTab(key: string): void {
  const tab = queryStore.tabs.find((t) => t.key === key)
  if (!tab) return
  if (tab.sqlText !== tab.savedSqlText) {
    unsavedDialog.value = { key, name: tab.name }
    pendingClose.value = { key }
    return
  }
  tabViewStates.delete(key)
  void window.api.deleteQueryDraft(key)
  queryStore.closeTab(key)
}

async function saveAndClose(): Promise<void> {
  if (!pendingClose.value || !unsavedDialog.value) return
  const key = pendingClose.value.key
  await saveTab(key)
  queryStore.closeTab(key)
  unsavedDialog.value = null
  pendingClose.value = null
}

function discardAndClose(): void {
  if (!pendingClose.value) return
  const key = pendingClose.value.key
  void window.api.deleteQueryDraft(key)
  queryStore.closeTab(key)
  unsavedDialog.value = null
  pendingClose.value = null
}

function startTabRename(key: string): void {
  const tab = queryStore.tabs.find((t) => t.key === key)
  if (!tab) return
  renamingTab.value = key
  renameValue.value = tab.name
}

function confirmTabRename(key: string): void {
  const tab = queryStore.tabs.find((t) => t.key === key)
  if (!tab) { renamingTab.value = null; return }
  const newName = renameValue.value.trim()
  renamingTab.value = null
  if (!newName || newName === tab.name) return
  tab.name = newName
  if (tab.savedId !== null) saveTab(key)
}


// Editor / results vertical split
const EDITOR_HEIGHT_KEY = 'query-editor-height'
const editorHeight = ref<number>(Number(localStorage.getItem(EDITOR_HEIGHT_KEY)) || 280)
const queryMain = ref<HTMLElement | null>(null)
const RESULTS_MIN = 80
const EDITOR_MIN = 80

function startEditorDrag(e: MouseEvent): void {
  const startY = e.clientY
  const startH = editorHeight.value
  const onMove = (ev: MouseEvent): void => {
    const containerH = queryMain.value?.offsetHeight ?? 0
    const maxH = containerH > 0 ? containerH - RESULTS_MIN : Infinity
    editorHeight.value = Math.min(maxH, Math.max(EDITOR_MIN, startH + (ev.clientY - startY)))
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    localStorage.setItem(EDITOR_HEIGHT_KEY, String(Math.round(editorHeight.value)))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// Schema panel resize
let resizing = false
let startX = 0
let startW = 0
function startPanelResize(e: MouseEvent): void {
  resizing = true
  startX = e.clientX
  startW = schemaPanel.value?.offsetWidth ?? 220
  const onMove = (ev: MouseEvent): void => {
    if (!resizing || !schemaPanel.value) return
    schemaPanel.value.style.width = Math.max(120, startW - (ev.clientX - startX)) + 'px'
  }
  const onUp = (): void => { resizing = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

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

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('blur', onWindowBlur)
  if (idleDraftTimer !== null) clearTimeout(idleDraftTimer)
  cleanupBeforeQuit?.()
  editor?.dispose()
})
</script>

<style scoped>
.query-view { display: flex; height: 100%; overflow: hidden; }
.query-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
.editor-area { flex-shrink: 1; flex-grow: 0; min-height: 80px; position: relative; }
.monaco-container { position: absolute; inset: 0; }
.h-split-divider { height: 5px; flex-shrink: 0; cursor: row-resize; position: relative; z-index: 1; background: transparent; }
.h-split-divider::after { content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); height: 3px; width: 48px; border-radius: 99px; background: var(--border); transition: background 0.15s, width 0.15s; }
.h-split-divider:hover::after, .h-split-divider:active::after { background: var(--primary); width: 64px; }
.results-area { flex: 1 0 80px; overflow: auto; }
.query-error { padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.query-error-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--error, #dc2626); }
.query-error-msg { margin: 0; font-family: monospace; font-size: 13px; color: var(--error, #dc2626); background: color-mix(in srgb, var(--error, #dc2626) 8%, transparent); border: 1px solid color-mix(in srgb, var(--error, #dc2626) 25%, transparent); border-radius: var(--radius-sm); padding: 10px 14px; white-space: pre-wrap; word-break: break-word; }
.schema-panel { width: 220px; flex-shrink: 0; border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; position: relative; overflow: hidden; }
.schema-resize-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 10; background: transparent; }
.schema-resize-handle::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px; border-radius: 99px; background: var(--border); transition: background 0.15s, height 0.15s; }
.schema-resize-handle:hover::after, .schema-resize-handle:active::after { background: var(--primary); height: 64px; }
.tab-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tab-save { font-size: 11px; opacity: 0.2; cursor: pointer; padding: 0 2px; transition: opacity 0.15s; flex-shrink: 0; }
.tab-save:hover { opacity: 0.6; }
.tab-save.dirty { opacity: 1; }
.tab-open-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 8px; opacity: 0.6; transition: opacity 0.15s; flex-shrink: 0; border-right: 1px solid var(--border); }
.tab-open-btn:hover { opacity: 1; }
.tab-rename-input { border: 1px solid var(--primary); border-radius: 2px; padding: 0 4px; font-size: 13px; width: 120px; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.modal-box { background: var(--surface); border-radius: var(--radius); padding: 24px; max-width: 360px; width: 100%; box-shadow: var(--shadow-md); }
.modal-box p { font-size: 13px; color: var(--text-muted); margin-top: 6px; }
.modal-box-lg { max-width: 520px; }
.saved-query-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; margin-top: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.saved-query-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; transition: background 0.1s; }
.saved-query-item:hover { background: var(--surface2); }
.saved-query-item + .saved-query-item { border-top: 1px solid var(--border); }
.saved-query-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.saved-query-del { opacity: 0.4; padding: 2px 6px !important; }
.saved-query-del:hover { opacity: 1; }
.execute-group { display: flex; align-items: center; gap: 0; }
.execute-mode-toggle { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; margin-right: 6px; }
.mode-btn { padding: 3px 10px; font-size: 11px; font-weight: 600; background: var(--surface); border: none; cursor: pointer; color: var(--text-muted); transition: background 0.15s, color 0.15s; }
.mode-btn + .mode-btn { border-left: 1px solid var(--border); }
.mode-btn.active { background: var(--primary); color: #fff; }
.mode-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.schema-tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.schema-tab { flex: 1; padding: 6px 4px; font-size: 12px; font-weight: 500; background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; color: var(--text-muted); transition: color 0.15s; }
.schema-tab:hover { color: var(--text); }
.schema-tab.active { color: var(--primary); border-bottom-color: var(--primary); }

/* AI toggle button */
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

/* AI panel */
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
