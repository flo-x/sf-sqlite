import { contextBridge, ipcRenderer } from 'electron'
import type {
  TableInfo,
  QueryResult,
  CsvPreview,
  OrgInfo,
  CliOrg,
  CliOrgsResult,
  SObjectSummary,
  FieldDescriptor,
  ExtractJob,
  ExtractJobInput,
  RunHistoryEntry,
  WritebackJob,
  WritebackJobInput,
  WritebackRunEntry,
  SavedQuery,
  QueryDraft,
  ScriptDraft,
  JobProgress,
  JobResult,
  RecentDatabase,
  SavedScript,
  SavedScriptInput,
  ScriptLog,
  ScriptComplete,
  ScriptProgress,
  DatabaseWasteInfo
} from '../shared/types'

const api = {
  // ── Database ─────────────────────────────────────────────────────────────────
  openDatabase: (filePath?: string): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('db:open', filePath),

  openNewDatabase: (): Promise<{ path: string } | null> =>
    ipcRenderer.invoke('db:open-new'),

  getDatabaseInfo: (): Promise<TableInfo[]> =>
    ipcRenderer.invoke('db:info'),

  executeQuery: (sql: string): Promise<QueryResult> =>
    ipcRenderer.invoke('db:query', sql),

  // ── Server-side paginated query access ────────────────────────────────────
  queryInit: (sql: string, pageSize: number): Promise<{ columns: string[]; rows: unknown[][]; totalCount: number; durationMs: number; error?: string }> =>
    ipcRenderer.invoke('db:query-init', sql, pageSize),

  queryPage: (sql: string, offset: number, limit: number, orderBy?: { column: string; dir: 'asc' | 'desc' }[]): Promise<{ columns: string[]; rows: unknown[][] }> =>
    ipcRenderer.invoke('db:query-page', sql, offset, limit, orderBy),

  exportQueryCsv: (sql: string): Promise<string | null> =>
    ipcRenderer.invoke('db:export-query-csv', sql),

  exportToCsv: (csvContent: string): Promise<string | null> =>
    ipcRenderer.invoke('db:export-csv', csvContent),

  renameTable: (oldName: string, newName: string): Promise<void> =>
    ipcRenderer.invoke('db:rename-table', oldName, newName),

  renameColumn: (table: string, oldName: string, newName: string): Promise<void> =>
    ipcRenderer.invoke('db:rename-column', table, oldName, newName),

  dropTable: (name: string): Promise<void> =>
    ipcRenderer.invoke('db:drop-table', name),

  getDatabaseWasteInfo: (): Promise<DatabaseWasteInfo> =>
    ipcRenderer.invoke('db:waste-info'),

  vacuumDatabase: (): Promise<void> =>
    ipcRenderer.invoke('db:vacuum'),

  csvPickAndPreview: (): Promise<CsvPreview | null> =>
    ipcRenderer.invoke('csv:pick-and-preview'),

  csvPreviewPath: (filePath: string): Promise<CsvPreview> =>
    ipcRenderer.invoke('csv:preview-path', filePath),

  csvImport: (filePath: string, tableName: string, ifExists: 'replace' | 'append'): Promise<number> =>
    ipcRenderer.invoke('csv:import', filePath, tableName, ifExists),

  csvImportText: (csvContent: string, tableName: string, ifExists: 'replace' | 'append', separator = ','): Promise<number> =>
    ipcRenderer.invoke('csv:import-text', csvContent, tableName, ifExists, separator),

  csvPickDirect: (): Promise<string | null> =>
    ipcRenderer.invoke('csv:pick-direct'),

  csvDirectImport: (filePath: string, tableName: string, ifExists: 'replace' | 'append'): Promise<number> =>
    ipcRenderer.invoke('csv:direct-import', filePath, tableName, ifExists),

  onCsvDirectImportProgress: (cb: (rowsLoaded: number) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, rowsLoaded: number): void => cb(rowsLoaded)
    ipcRenderer.on('csv:direct-import:progress', handler)
    return () => ipcRenderer.removeListener('csv:direct-import:progress', handler)
  },

  cancelCsvDirectImport: (): Promise<void> =>
    ipcRenderer.invoke('csv:direct-import:cancel'),

  listRecentDatabases: (): Promise<RecentDatabase[]> =>
    ipcRenderer.invoke('db:recent-list'),

  removeRecentDatabase: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('db:recent-remove', filePath),

  // ── Saved Queries ─────────────────────────────────────────────────────────────
  listSavedQueries: (): Promise<SavedQuery[]> =>
    ipcRenderer.invoke('query:list'),

  saveQuery: (q: { id?: number; name: string; sqlText: string; tabOrder: number; viewState?: string | null }): Promise<SavedQuery> =>
    ipcRenderer.invoke('query:save', q),

  deleteQuery: (id: number): Promise<void> =>
    ipcRenderer.invoke('query:delete', id),

  reorderQueries: (ids: number[]): Promise<void> =>
    ipcRenderer.invoke('query:reorder', ids),

  // ── Query Drafts ──────────────────────────────────────────────────────────────
  listQueryDrafts: (): Promise<QueryDraft[]> =>
    ipcRenderer.invoke('query:drafts:list'),

  upsertQueryDraft: (draft: Omit<QueryDraft, 'updatedAt'>): Promise<void> =>
    ipcRenderer.invoke('query:drafts:upsert', draft),

  deleteQueryDraft: (tabKey: string): Promise<void> =>
    ipcRenderer.invoke('query:drafts:delete', tabKey),

  /** Call after all drafts are saved during before-quit. Triggers the actual app exit. */
  notifyDraftsQuitReady: (): Promise<void> =>
    ipcRenderer.invoke('query:drafts:quit-ready'),

  // ── Script Drafts ─────────────────────────────────────────────────────────────
  listScriptDrafts: (): Promise<ScriptDraft[]> =>
    ipcRenderer.invoke('script:drafts:list'),

  upsertScriptDraft: (draft: Omit<ScriptDraft, 'updatedAt'>): Promise<void> =>
    ipcRenderer.invoke('script:drafts:upsert', draft),

  deleteScriptDraft: (draftKey: string): Promise<void> =>
    ipcRenderer.invoke('script:drafts:delete', draftKey),

  /** Register a one-time listener for the main-process before-quit signal. Returns a cleanup fn. */
  onBeforeQuit: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('app:before-quit', handler)
    return () => ipcRenderer.removeListener('app:before-quit', handler)
  },

  // ── Salesforce ────────────────────────────────────────────────────────────────
  connectOAuth: (clientId: string, loginUrl: string): Promise<OrgInfo> =>
    ipcRenderer.invoke('sf:connect-oauth', clientId, loginUrl),

  disconnectSalesforce: (): Promise<void> =>
    ipcRenderer.invoke('sf:disconnect'),

  getConnectionStatus: (): Promise<{ sfOrg: OrgInfo | null; dbPath: string | null }> =>
    ipcRenderer.invoke('app:get-connection-status'),

  listCliOrgs: (): Promise<CliOrgsResult> =>
    ipcRenderer.invoke('sf:list-cli-orgs'),

  getSfCliPath: (): Promise<string | null> =>
    ipcRenderer.invoke('sf:get-custom-path'),

  setSfCliPath: (path: string): Promise<void> =>
    ipcRenderer.invoke('sf:set-custom-path', path),

  getNetworkSettings: (): Promise<{ shellCaCertPath: string | null; savedCaCertPath: string | null; shellPath: string | null; patchDisabled: boolean }> =>
    ipcRenderer.invoke('sf:get-network-settings'),

  setCaCertPath: (certPath: string | null, disabled: boolean): Promise<void> =>
    ipcRenderer.invoke('sf:set-ca-cert-path', certPath, disabled),

  browseCaCert: (): Promise<string | null> =>
    ipcRenderer.invoke('sf:browse-ca-cert'),

  getActiveCaCertPath: (): Promise<string | null> =>
    ipcRenderer.invoke('sf:get-active-ca-cert-path'),

  connectCliOrg: (username: string): Promise<OrgInfo> =>
    ipcRenderer.invoke('sf:connect-cli-org', username),

  listObjects: (): Promise<SObjectSummary[]> =>
    ipcRenderer.invoke('sf:list-objects'),

  describeObject: (name: string): Promise<FieldDescriptor[]> =>
    ipcRenderer.invoke('sf:describe', name),

  runSoqlQuery: (soql: string): Promise<QueryResult> =>
    ipcRenderer.invoke('sf:soql', soql),

  // ── Extraction Jobs ──────────────────────────────────────────────────────────
  listExtractJobs: (): Promise<ExtractJob[]> =>
    ipcRenderer.invoke('extract:list'),

  saveExtractJob: (job: ExtractJobInput): Promise<ExtractJob> =>
    ipcRenderer.invoke('extract:save', job),

  deleteExtractJob: (jobId: number): Promise<void> =>
    ipcRenderer.invoke('extract:delete', jobId),

  duplicateExtractJob: (jobId: number): Promise<ExtractJob> =>
    ipcRenderer.invoke('extract:duplicate', jobId),

  getRunHistory: (jobId: number): Promise<RunHistoryEntry[]> =>
    ipcRenderer.invoke('extract:history', jobId),

  startExtract: (jobId: number): Promise<string> =>
    ipcRenderer.invoke('extract:start', jobId),

  // ── Write-back Jobs ──────────────────────────────────────────────────────────
  listWritebackJobs: (): Promise<WritebackJob[]> =>
    ipcRenderer.invoke('writeback:list'),

  saveWritebackJob: (job: WritebackJobInput): Promise<WritebackJob> =>
    ipcRenderer.invoke('writeback:save', job),

  deleteWritebackJob: (jobId: number): Promise<void> =>
    ipcRenderer.invoke('writeback:delete', jobId),

  duplicateWritebackJob: (jobId: number): Promise<WritebackJob> =>
    ipcRenderer.invoke('writeback:duplicate', jobId),

  getWritebackRunHistory: (jobId: number): Promise<WritebackRunEntry[]> =>
    ipcRenderer.invoke('writeback:history', jobId),

  previewWritebackQuery: (sql: string): Promise<{ columns: string[]; rows: unknown[][] }> =>
    ipcRenderer.invoke('writeback:preview', sql),

  startWriteback: (jobId: number): Promise<string> =>
    ipcRenderer.invoke('writeback:start', jobId),

  // ── Exec-table access (REST writeback) ───────────────────────────────────────
  /** Polling endpoint: returns total/queued/succeeded/failed counts from the exec table. */
  wbExecCounts: (runId: string): Promise<{ total: number; queued: number; succeeded: number; failed: number; inFlight: number; loadingPhase: boolean }> =>
    ipcRenderer.invoke('writeback:exec-counts', runId),

  /** Returns the in-memory distinct error prefix list for live filtering. */
  wbExecDistinctErrors: (runId: string): Promise<{ message: string; count: number }[]> =>
    ipcRenderer.invoke('writeback:exec-distinct-errors', runId),

  /**
   * Returns one page of exec-table rows for the DataGrid.
   * Column order: [...userColumns, '__sf_id', '__status', '__error']
   */
  wbExecPage: (
    runId: string,
    offset: number,
    limit: number,
    filter?: { statuses?: ('success' | 'error' | 'queued')[]; errorPrefix?: string }
  ): Promise<{ columns: string[]; rows: unknown[][] }> =>
    ipcRenderer.invoke('writeback:exec-page', runId, offset, limit, filter),

  /** Returns the total row count matching a filter (used for pagination totals). */
  wbExecCount: (
    runId: string,
    filter?: { statuses?: ('success' | 'error' | 'queued')[]; errorPrefix?: string }
  ): Promise<number> =>
    ipcRenderer.invoke('writeback:exec-count', runId, filter),

  retryFailed: (runId: string, jobId: number): Promise<string> =>
    ipcRenderer.invoke('writeback:retry', runId, jobId),

  getUserTableNames: (): Promise<string[]> =>
    ipcRenderer.invoke('db:user-tables'),

  getTableColumnNames: (tableName: string): Promise<string[]> =>
    ipcRenderer.invoke('db:table-columns', tableName),

  columnHasIndex: (tableName: string, columnName: string): Promise<boolean> =>
    ipcRenderer.invoke('db:column-has-index', tableName, columnName),

  createColumnIndex: (tableName: string, columnName: string): Promise<void> =>
    ipcRenderer.invoke('db:create-index', tableName, columnName),

  dropIndex: (indexName: string): Promise<void> =>
    ipcRenderer.invoke('db:drop-index', indexName),

  cancelJob: (runId: string): Promise<void> =>
    ipcRenderer.invoke('job:cancel', runId),

  // ── Job control ───────────────────────────────────────────────────────────────
  onWritebackRunEvicted: (cb: (runId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, runId: string): void => cb(runId)
    ipcRenderer.on('writeback:run-evicted', handler)
    return () => ipcRenderer.removeListener('writeback:run-evicted', handler)
  },

  onExternalJobQueued: (cb: (e: { type: 'extract' | 'writeback'; jobId: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { type: 'extract' | 'writeback'; jobId: number }): void => cb(data)
    ipcRenderer.on('job:external-queued', handler)
    return () => ipcRenderer.removeListener('job:external-queued', handler)
  },

  onExternalJobStarted: (cb: (e: { type: 'extract' | 'writeback'; jobId: number; runId: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { type: 'extract' | 'writeback'; jobId: number; runId: string }): void => cb(data)
    ipcRenderer.on('job:external-started', handler)
    return () => ipcRenderer.removeListener('job:external-started', handler)
  },

  // ── IPC events ────────────────────────────────────────────────────────────────
  onJobProgress: (cb: (e: JobProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: JobProgress): void => cb(data)
    ipcRenderer.on('job:progress', handler)
    return () => ipcRenderer.removeListener('job:progress', handler)
  },

  onJobComplete: (cb: (e: JobResult) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: JobResult): void => cb(data)
    ipcRenderer.on('job:complete', handler)
    return () => ipcRenderer.removeListener('job:complete', handler)
  },

  // Fired by the main process when background SF auto-connect is about to start.
  onSfAutoConnectStart: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('sf:auto-connect-start', handler)
    return () => ipcRenderer.removeListener('sf:auto-connect-start', handler)
  },

  // Fired by the main process when background SF auto-connect succeeds after a db:open.
  onSfAutoConnected: (cb: (org: OrgInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, org: OrgInfo): void => cb(org)
    ipcRenderer.on('sf:auto-connected', handler)
    return () => ipcRenderer.removeListener('sf:auto-connected', handler)
  },

  // Fired by the main process when background SF auto-connect fails.
  onSfAutoConnectFailed: (cb: (info: { username: string; message: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { username: string; message: string }): void => cb(info)
    ipcRenderer.on('sf:auto-connect-failed', handler)
    return () => ipcRenderer.removeListener('sf:auto-connect-failed', handler)
  },

  // ── Scripts ────────────────────────────────────────────────────────────────
  listScripts: (): Promise<SavedScript[]> =>
    ipcRenderer.invoke('script:list'),

  saveScript: (script: SavedScriptInput & { id?: number }): Promise<SavedScript> =>
    ipcRenderer.invoke('script:save', script),

  deleteScript: (id: number): Promise<void> =>
    ipcRenderer.invoke('script:delete', id),

  // Returns the runId immediately. Listen to onScriptLog / onScriptComplete for
  // progress and completion — both travel via the same ordered IPC channel.
  runScript: (code: string, runId: string): Promise<string> =>
    ipcRenderer.invoke('script:run', { code, runId }),

  cancelScript: (runId: string): Promise<void> =>
    ipcRenderer.invoke('script:cancel', runId),

  onScriptLog: (cb: (e: ScriptLog & { runId: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ScriptLog & { runId: string }): void => cb(data)
    ipcRenderer.on('script:log', handler)
    return () => ipcRenderer.removeListener('script:log', handler)
  },

  onScriptLogBatch: (cb: (batch: Array<ScriptLog & { runId: string }>) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, batch: Array<ScriptLog & { runId: string }>): void => cb(batch)
    ipcRenderer.on('script:log-batch', handler)
    return () => ipcRenderer.removeListener('script:log-batch', handler)
  },

  onScriptComplete: (cb: (e: ScriptComplete) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ScriptComplete): void => cb(data)
    ipcRenderer.on('script:complete', handler)
    return () => ipcRenderer.removeListener('script:complete', handler)
  },

  onScriptProgress: (cb: (e: ScriptProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ScriptProgress): void => cb(data)
    ipcRenderer.on('script:progress', handler)
    return () => ipcRenderer.removeListener('script:progress', handler)
  },

  // ── LLM ───────────────────────────────────────────────────────────────────────
  llmChat: (payload: { conversationId: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<{ reply: string; contextTruncated: boolean }> =>
    ipcRenderer.invoke('llm:chat', payload),

  getLlmSettings: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('llm:get-settings'),

  saveLlmSettings: (settings: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('llm:save-settings', settings),

  // Sends the current in-memory settings (plaintext keys) directly to main for
  // connection testing — no file write or read involved.
  testLlmConnection: (settings: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('llm:test', settings),

  // Asks the provider API which models are available.
  listLlmModels: (settings: Record<string, unknown>): Promise<string[]> =>
    ipcRenderer.invoke('llm:list-models', settings),

  onLlmChunk: (cb: (text: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string): void => cb(text)
    ipcRenderer.on('llm:chunk', handler)
    return () => ipcRenderer.removeListener('llm:chunk', handler)
  },

  onLlmToolCall: (cb: (e: { name: string; args: Record<string, unknown> }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { name: string; args: Record<string, unknown> }): void => cb(data)
    ipcRenderer.on('llm:tool-call', handler)
    return () => ipcRenderer.removeListener('llm:tool-call', handler)
  },

  onLlmToolResult: (cb: (e: { name: string; result: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { name: string; result: string }): void => cb(data)
    ipcRenderer.on('llm:tool-result', handler)
    return () => ipcRenderer.removeListener('llm:tool-result', handler)
  },

  onLlmSettingsChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('llm:settings-changed', handler)
    return () => ipcRenderer.removeListener('llm:settings-changed', handler)
  },

  // ── Auto-update ────────────────────────────────────────────────────────────
  // `manual: true`  → macOS: open GitHub releases page for manual download
  // `manual: false` → Windows/Linux: trigger in-app download via electron-updater
  onUpdateAvailable: (cb: (info: { version: string; manual: boolean }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string; manual: boolean }): void => cb(info)
    ipcRenderer.on('update:available', handler)
    return () => ipcRenderer.removeListener('update:available', handler)
  },

  onUpdateProgress: (cb: (percent: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, percent: number): void => cb(percent)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },

  onUpdateDownloaded: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('update:downloaded', handler)
    return () => ipcRenderer.removeListener('update:downloaded', handler)
  },

  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  openReleasesPage: (): Promise<void> => ipcRenderer.invoke('update:open-releases-page'),

  getVersionInfo: (): Promise<{ appVersion: string; electronVersion: string; nodeVersion: string; platform: string }> =>
    ipcRenderer.invoke('app:get-version-info'),

  checkForUpdates: (): Promise<{ latestVersion: string; isNewer: boolean }> =>
    ipcRenderer.invoke('app:check-for-updates'),

  // ── Diagnostics / Debug ───────────────────────────────────────────────────
  getDebugFlags: (): Promise<{ sfCliExec: boolean; sfCliAuth: boolean; oauthFlow: boolean }> =>
    ipcRenderer.invoke('debug:get-flags'),

  setDebugFlags: (flags: { sfCliExec?: boolean; sfCliAuth?: boolean; oauthFlow?: boolean }): Promise<void> =>
    ipcRenderer.invoke('debug:set-flags', flags),

  getDebugLogs: (): Promise<string[]> =>
    ipcRenderer.invoke('debug:get-logs'),

  clearDebugLogs: (): Promise<void> =>
    ipcRenderer.invoke('debug:clear-logs'),

  onDebugLog: (cb: (line: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, line: string): void => cb(line)
    ipcRenderer.on('debug:log', handler)
    return () => ipcRenderer.removeListener('debug:log', handler)
  },

  onLlmConfirmRequest: (cb: (e: { conversationId: string; statement: string; reason: string; type?: 'ddl' | 'javascript' }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { conversationId: string; statement: string; reason: string; type?: 'ddl' | 'javascript' }): void => cb(data)
    ipcRenderer.on('llm:confirm-request', handler)
    return () => ipcRenderer.removeListener('llm:confirm-request', handler)
  },

  // Fired after the user approves a JavaScript execution and the worker actually starts.
  onLlmToolExecuting: (cb: (e: { conversationId: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { conversationId: string }): void => cb(data)
    ipcRenderer.on('llm:tool-executing', handler)
    return () => ipcRenderer.removeListener('llm:tool-executing', handler)
  },

  confirmLlmStatement: (conversationId: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke('llm:confirm-response', { conversationId, approved }),

  cancelTool: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke('llm:cancel-tool', conversationId),
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
