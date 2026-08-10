import { ipcMain, dialog, BrowserWindow, safeStorage, app, net } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import * as db from './database'
import * as sf from './salesforce'
import * as recent from './recentDbs'
import * as scriptRunner from './script-runner'
import { scheduler } from './job-scheduler'
import { debugLog } from './debug-logger'
import { dbWorker } from './DbWorkerClient'
import {
  sendMessage,
  listModels,
  buildSystemPromptParts,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  getActiveModel,
  EXECUTE_SQL_TOOL,
  EXECUTE_DDL_TOOL,
  EXECUTE_JAVASCRIPT_TOOL,
  GET_EDITOR_CONTENT_TOOL,
  GET_EDITOR_SELECTION_TOOL,
  DEFAULT_SETTINGS,
  type LlmSettings,
  type ChatMessage
} from './llm'
import { applyExtraCaCert, clearExtraCaCert, disablePatch, enablePatch, isPatchDisabled, getShellCaCertPath, getActiveCaCertPath } from './tls-patch'
import type {
  ExtractJob,
  ExtractJobInput,
  WritebackJob,
  WritebackJobInput,
  FieldMapping,
  JobProgress,
  JobResult,
  JobListEntry,
  FieldDescriptor,
  SavedScriptInput,
  ScriptLog,
  ScriptComplete,
  ScriptProgress,
  TableInfo
} from '../shared/types'

function buildDdlSchema(tables: TableInfo[]): string {
  return tables
    .map(t => {
      const pkCols = t.columns.filter(c => c.primaryKey)
      const colLines = t.columns.map(c => {
        let def = `  "${c.name}" ${c.type || 'TEXT'}`
        if (c.notNull) {
          def += ' NOT NULL'
        }
        if (c.defaultValue !== null) {
          def += ` DEFAULT ${c.defaultValue}`
        }
        if (pkCols.length === 1 && c.primaryKey) {
          def += ' PRIMARY KEY'
        }
        return def
      })

      if (pkCols.length > 1) {
        colLines.push(`  PRIMARY KEY (${pkCols.map(c => `"${c.name}"`).join(', ')})`)
      }

      const keyword = t.type === 'view' ? 'VIEW' : 'TABLE'
      let ddl = `CREATE ${keyword} "${t.name}" (\n${colLines.join(',\n')}\n);`

      if (t.type === 'table') {
        const cnt = db.getTableRowCount(t.name)
        ddl += `\n-- ${cnt.toLocaleString()} rows`
      }

      for (const idx of t.indexes) {
        const unique = idx.unique ? 'UNIQUE INDEX' : 'INDEX'
        ddl += `\n-- ${unique} "${idx.name}" ON (${idx.columns.map(c => `"${c}"`).join(', ')})`
      }

      return ddl
    })
    .join('\n\n')
}

const activeJobs = new Map<string, AbortController>()

// Resolvers for in-flight DDL/DML confirmation requests, keyed by conversationId.
// Only one confirmation can be pending per conversation at a time.
const pendingConfirms = new Map<string, (approved: boolean) => void>()

// Cancel functions for in-flight LLM JavaScript executions, keyed by conversationId.
// Calling the function terminates the worker and resolves the runTool promise with an error.
const pendingToolCancels = new Map<string, () => void>()

/** Result of a get_editor_content / get_editor_selection tool call, supplied by whichever
 * renderer view (Query Editor or Script Editor) is currently active. */
interface EditorContentResponse {
  content: string
  source: 'query' | 'scripts'
  language: 'sql' | 'javascript'
  truncated: boolean
}

// Resolvers for in-flight "get editor content/selection" requests, keyed by conversationId.
// Only one such request can be pending per conversation at a time.
const pendingEditorRequests = new Map<string, (response: EditorContentResponse | null) => void>()

// ── Per-run writeback state ──────────────────────────────────────────────────
// Each REST API run creates a TEMP SQLite table (_wb_exec_<runId>) that holds
// all source rows plus __sf_id, __status, __error, __error_prefix columns.
// The in-memory state here only keeps lightweight counters and the error-prefix
// map (avoids O(N) scans of the exec table for live progress reporting).
interface WbRunState {
  sql: string
  columns: string[]        // source SQL column names (SF field names for Bulk API)
  totalRows: number        // total rows in the exec table (set after Phase 0 finishes)
  /** True while Phase 0 (loading source rows into exec table) is still running. */
  loadingPhase: boolean
  /** Number of rows currently in-flight to Salesforce across all concurrent workers. */
  inFlight: number
  /** In-memory tally of error-prefix → row count. Updated as batches complete. */
  distinctErrorCounts: Map<string, number>
  /**
   * True for Bulk API runs.  The exec table (if it exists) holds only failed rows
   * whose columns are Salesforce field names, not the source SQL column names.
   */
  isBulk?: boolean
}

/**
 * Returns the error prefix used for grouping/filtering.
 * - 2+ colons → text up to the second ':'
 * - 1 colon   → text up to the first ':'
 * - 0 colons  → the whole message
 */
function errorPrefix(msg: string): string {
  const first = msg.indexOf(':')
  if (first < 0) return msg
  const second = msg.indexOf(':', first + 1)
  return (second >= 0 ? msg.slice(0, second) : msg.slice(0, first)).trim()
}

/** Snapshot of the in-memory distinctErrorCounts for emitting to the renderer. */
function distinctErrorsSnapshot(state: WbRunState): Array<{ message: string; count: number }> {
  return [...state.distinctErrorCounts.entries()].map(([message, count]) => ({ message, count }))
}

const wbRunStates = new Map<string, WbRunState>()
const WB_RUN_STATE_CAP = 5
/** Rows per chunk when streaming data to the Bulk API upload. */
const CHUNK = 5000

function addWbRunState(runId: string, state: WbRunState): void {
  wbRunStates.set(runId, state)
  if (wbRunStates.size > WB_RUN_STATE_CAP) {
    // Map preserves insertion order — first key is always the oldest
    const evictedId = wbRunStates.keys().next().value as string
    wbRunStates.delete(evictedId)
    // Drop the exec table for the evicted run (frees temp storage)
    try { db.wbExecDropTable(evictedId) } catch { /* ignore */ }
    send('writeback:run-evicted', evictedId)
  }
}

function mapRowToRecord(
  row: unknown[],
  columns: string[],
  activeMappings: FieldMapping[],
  mode: 'rest' | 'bulk' = 'rest'
): Record<string, unknown> {
  const rec: Record<string, unknown> = {}
  const lowerColumns = columns.map((c) => c.toLowerCase())
  for (const m of activeMappings) {
    const colIdx = lowerColumns.indexOf(m.sqlCol.toLowerCase())
    if (colIdx < 0) continue
    if (m.useExternalId && m.relationshipName && m.externalIdFieldName) {
      if (mode === 'bulk') {
        // Bulk API 2.0 CSV: flat dot-notation header "RelationshipName.ExtIdField"
        rec[`${m.relationshipName}.${m.externalIdFieldName}`] = row[colIdx] ?? null
      } else {
        // REST API: nested object { RelationshipName: { ExtIdField: value } }
        rec[m.relationshipName] = { [m.externalIdFieldName]: row[colIdx] ?? null }
      }
    } else {
      rec[m.sfField] = row[colIdx] ?? null
    }
  }
  return rec
}

// Tracks an in-flight sf:list-cli-orgs call so tryAutoConnectSF can wait for it.
// listCliOrgs runs `sf org list` which may refresh tokens; auto-connect must not
// race against it or it may pick up a stale/expired token.
let pendingListOrgs: Promise<unknown> | null = null

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

const ALLOWED_CSV_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.dat'])

function assertCsvPath(filePath: string): void {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  if (!ALLOWED_CSV_EXTENSIONS.has(ext)) {
    throw new Error(`File type not allowed: only .csv, .tsv, and .txt files may be imported.`)
  }
}

function send(channel: string, data: unknown): void {
  getMainWindow()?.webContents.send(channel, data)
}

// Fire-and-forget: attempts to connect to the stored SF CLI org after a DB is
// opened.  Progress is communicated entirely via IPC events so the renderer is
// never blocked.
function autoConnectAfterDbOpen(): void {
  if (sf.isConnected()) return

  const username = db.getSetting('sf_cli_username')
  if (!username) return   // No stored org — nothing to auto-connect, no spinner

  // Tell the renderer to show the connecting spinner.
  send('sf:auto-connect-start', null)

  ;(async () => {
    try {
      // Wait for any in-flight sf org list to finish before touching credentials.
      // If no detection is running yet, kick one off now so tokens are fresh.
      if (!pendingListOrgs) {
        pendingListOrgs = sf.listCliOrgs().finally(() => { pendingListOrgs = null })
      }
      await pendingListOrgs
      const org = await sf.connectCliOrg(username)
      send('sf:auto-connected', org)
    } catch (err) {
      send('sf:auto-connect-failed', {
        username,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })()
}

// ── Script-callable job result types ─────────────────────────────────────────

export interface WritebackScriptResult {
  _runId: string
  status: 'success' | 'partial' | 'error' | 'cancelled'
  /** Total rows in the source SQL query. */
  rowsSource: number
  /** Rows successfully pushed to Salesforce. */
  rowsSucceeded: number
  /** Rows that failed to push to Salesforce. */
  rowsFailed: number
  /**
   * Name of the SQLite exec table that holds every source row with its
   * Salesforce outcome (__sf_id, __status, __error columns).
   * For REST API jobs the table always exists after the run.
   * For Bulk API jobs the table only exists when rowsFailed > 0 (failed rows only).
   * null when no exec table was created (e.g. the job was cancelled before Phase 0
   * completed, or a Bulk job had zero failures).
   */
  execTable: string | null
}

/** Bare table name (no SQL quoting) used for the writeback exec table. */
function wbExecTableName(runId: string): string {
  return `_wb_exec_${runId.replace(/-/g, '_')}`
}

export interface WritebackFailedRowsResult {
  failedRows: Array<{ index: number; message: string; row: Record<string, unknown> }>
  keyFields: Array<{ sfField: string; sqlCol: string; label: string }>
}

// ── Awaitable job-run helpers ─────────────────────────────────────────────────
// Both functions are called by the IPC handlers (fire-and-forget) and by the
// script executor path (awaited for full result).  They register the run with
// the scheduler so the MAX_PARALLEL limit is respected globally.

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && (err.message === 'The operation was aborted' || err.message === 'Cancelled'))
  )
}

async function startExtractRun(jobId: number, runId: string): Promise<JobResult> {
  const job = db.listExtractJobs().find((j) => j.id === jobId)
  if (!job) throw new Error(`Extract job ${jobId} not found`)

  // Verify (and if necessary refresh) the Salesforce session before starting.
  await sf.ensureConnected()

  const abortCtrl = new AbortController()
  activeJobs.set(runId, abortCtrl)
  scheduler.registerRun('extract', jobId, runId)
  const resultPromise = scheduler.awaitCompletion(runId)

  const runHistId = db.startRunHistory(jobId)
  const startTime = Date.now()
  let lastFetched = 0

  if (job.soqlQuery) {
    // ── Raw SOQL mode with staging table ──────────────────────────────────
    debugLog('jobQueries', `[SF→SQLite] job="${job.name}" (id=${jobId}) SOQL (raw):\n${job.soqlQuery}`)
    const stagingName = `_sf_bridge_soql_stage_${Date.now()}`
    const columnTypes = new Map<string, string>()
    const pendingCols = new Set<string>()
    let stagingCreated = false
    const priorIndexes = job.writeMode === 'replace'
      ? db.snapshotTableIndexes(job.destTable)
      : []

    function inferSqliteType(v: unknown): string {
      if (typeof v === 'boolean') return 'INTEGER'
      if (typeof v === 'number') return 'REAL'
      return 'TEXT'
    }

    function updateColumnTypes(records: Record<string, unknown>[]): void {
      let allResolved = false
      for (const record of records) {
        if (allResolved) break
        for (const col of Object.keys(record)) {
          if (!columnTypes.has(col) && !pendingCols.has(col)) {
            pendingCols.add(col)
          }
        }
        const resolved: string[] = []
        for (const col of pendingCols) {
          const val = record[col]
          if (val === null || val === undefined) continue
          columnTypes.set(col, inferSqliteType(val))
          resolved.push(col)
        }
        for (const col of resolved) pendingCols.delete(col)
        allResolved = pendingCols.size === 0 && columnTypes.size > 0
      }
    }

    ;(async () => {
      try {
        const total = await sf.extractSoql(
          job.soqlQuery!,
          (fetched, total) => {
            const elapsed = (Date.now() - startTime) / 1000
            const rps = elapsed > 0 ? Math.round(fetched / elapsed) : 0
            lastFetched = fetched
            send('job:progress', {
              runId, type: 'extract', fetched, total: total ?? undefined, rps
            } as JobProgress)
          },
          (records) => {
            if (records.length === 0) return
            updateColumnTypes(records)
            if (!stagingCreated) {
              db.createStagingTable(stagingName, Object.keys(records[0]))
              stagingCreated = true
            }
            db.insertRows(stagingName, Object.keys(records[0]), records)
          },
          abortCtrl.signal
        )

        if (stagingCreated) {
          for (const col of pendingCols) columnTypes.set(col, 'TEXT')
          db.promoteSoqlStagingTable(stagingName, job.destTable, columnTypes, job.writeMode)
          if (job.additionalIndexes?.length) {
            try { db.ensureColumnIndexes(job.destTable, job.additionalIndexes) } catch { /* ignore */ }
          }
          if (priorIndexes.length > 0) {
            db.restoreTableIndexes(job.destTable, priorIndexes)
          }
        } else if (job.writeMode === 'replace') {
          db.dropTableIfExists(job.destTable)
        }

        db.finishRunHistory(runHistId, 'success', total, Date.now() - startTime)
        const result: JobResult = { runId, type: 'extract', status: 'success', rowsLoaded: total }
        send('job:complete', result)
        scheduler.notifyComplete(result)
      } catch (err) {
        const cancelled = isAbortError(err)
        const msg = cancelled ? 'Cancelled by user' : (err instanceof Error ? err.message : String(err))
        if (stagingCreated) db.dropTableIfExists(stagingName)
        db.finishRunHistory(runHistId, cancelled ? 'cancelled' : 'error', lastFetched, Date.now() - startTime, cancelled ? undefined : msg)
        const result: JobResult = { runId, type: 'extract', status: cancelled ? 'cancelled' : 'error', errorMsg: cancelled ? undefined : msg }
        send('job:complete', result)
        scheduler.notifyComplete(result)
      } finally {
        activeJobs.delete(runId)
      }
    })()
  } else {
    // ── Structured mode ────────────────────────────────────────────────────
    const soqlPreview = [
      `SELECT ${[...job.fields, ...(job.customExpressions ?? [])].join(', ')} FROM ${job.sfObject}`,
      job.whereClause?.trim() ? `WHERE ${job.whereClause}` : '',
      job.rowLimit ? `LIMIT ${job.rowLimit}` : ''
    ].filter(Boolean).join(' ')
    debugLog('jobQueries', `[SF→SQLite] job="${job.name}" (id=${jobId}) SOQL (structured):\n${soqlPreview}`)
    const { fields } = await sf.describeObject(job.sfObject)
    const selectedFieldMeta = fields.filter((f) => job.fields.includes(f.name))

    const priorIndexes = job.writeMode === 'replace'
      ? db.snapshotTableIndexes(job.destTable)
      : []
    db.createTableFromFields(job.destTable, selectedFieldMeta as FieldDescriptor[], job.writeMode)

    const indexCols = [
      ...selectedFieldMeta.filter((f) => f.unique || f.externalId).map((f) => f.name),
      ...(selectedFieldMeta.some((f) => f.name === 'Id') ? ['Id'] : []),
      ...(job.additionalIndexes ?? [])
    ]
    if (indexCols.length > 0) {
      db.ensureColumnIndexes(job.destTable, indexCols)
    }
    if (priorIndexes.length > 0) {
      db.restoreTableIndexes(job.destTable, priorIndexes)
    }

    ;(async () => {
      try {
        const total = await sf.extractRecords(
          {
            sfObject: job.sfObject,
            fields: [...job.fields, ...(job.customExpressions ?? [])],
            whereClause: job.whereClause,
            rowLimit: job.rowLimit
          },
          (fetched, total) => {
            const elapsed = (Date.now() - startTime) / 1000
            const rps = elapsed > 0 ? Math.round(fetched / elapsed) : 0
            lastFetched = fetched
            const progress: JobProgress = { runId, type: 'extract', fetched, total: total ?? undefined, rps }
            send('job:progress', progress)
          },
          (records) => {
            db.insertRows(job.destTable, Object.keys(records[0] || {}), records)
          },
          abortCtrl.signal
        )
        db.finishRunHistory(runHistId, 'success', total, Date.now() - startTime)
        const result: JobResult = { runId, type: 'extract', status: 'success', rowsLoaded: total }
        send('job:complete', result)
        scheduler.notifyComplete(result)
      } catch (err) {
        const cancelled = isAbortError(err)
        const msg = cancelled ? 'Cancelled by user' : (err instanceof Error ? err.message : String(err))
        db.finishRunHistory(runHistId, cancelled ? 'cancelled' : 'error', lastFetched, Date.now() - startTime, cancelled ? undefined : msg)
        const result: JobResult = { runId, type: 'extract', status: cancelled ? 'cancelled' : 'error', errorMsg: cancelled ? undefined : msg }
        send('job:complete', result)
        scheduler.notifyComplete(result)
      } finally {
        activeJobs.delete(runId)
      }
    })()
  }

  return resultPromise
}

// ── Writeback SQL helpers (log-and-rethrow on error) ─────────────────────────

function wbReadBatch(
  runId: string,
  columns: string[],
  offset: number,
  limit: number,
  phase: string
): ReturnType<typeof db.wbExecReadBatch> {
  try {
    return db.wbExecReadBatch(runId, columns, offset, limit)
  } catch (err) {
    debugLog('wbSql', `[${runId}] ${phase} READ ERROR at offset=${offset}: ${String(err)}`)
    throw err
  }
}

function wbUpdateBatch(
  runId: string,
  updates: Parameters<typeof db.wbExecUpdateBatch>[1],
  phase: string
): void {
  try {
    db.wbExecUpdateBatch(runId, updates)
  } catch (err) {
    debugLog('wbSql', `[${runId}] ${phase} UPDATE ERROR (${updates.length} rows): ${String(err)}`)
    throw err
  }
}

async function wbRunLoad(opts: { id: string; sql: string; signal: AbortSignal }, phase: string): Promise<void> {
  try {
    await dbWorker.runLoad(opts)
  } catch (err) {
    debugLog('wbSql', `[${opts.id}] ${phase} db-worker ERROR: ${String(err)}`)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function startWritebackRun(jobId: number, runId: string): Promise<WritebackScriptResult> {
  const job = db.listWritebackJobs().find((j) => j.id === jobId)
  if (!job) throw new Error(`Writeback job ${jobId} not found`)

  // Verify (and if necessary refresh) the Salesforce session before starting.
  await sf.ensureConnected()

  const sql = job.sqlQuery
  debugLog('jobQueries', `[SQLite→SF] job="${job.name}" (id=${jobId}) SQL:\n${sql}`)

  // Start run history before executing SQL so we always have a record,
  // even if the query itself is invalid.
  const runHistId = db.startWritebackRunHistory(jobId, job.useBulkApi ?? false)

  let columns: string[]
  try {
    columns = db.queryPage(sql, 0, 0).columns
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    debugLog('wbSql', `[${runId}] SQL validation ERROR: ${msg}`)
    db.finishWritebackRunHistory(runHistId, 'error', 0, 0, 0, 0, msg)
    const jobResult: JobResult = { runId, type: 'writeback', status: 'error', errorMsg: msg }
    send('job:complete', jobResult)
    return { _runId: runId, status: 'error', rowsSource: 0, rowsSucceeded: 0, rowsFailed: 0, execTable: null }
  }

  const abortCtrl = new AbortController()
  activeJobs.set(runId, abortCtrl)

  const state: WbRunState = {
    sql, columns, totalRows: 0,
    loadingPhase: true, inFlight: 0,
    distinctErrorCounts: new Map()
  }
  addWbRunState(runId, state)
  scheduler.registerRun('writeback', jobId, runId)
  const completionPromise = scheduler.awaitCompletion(runId)

  const activeMappings = job.operation === 'delete'
    ? job.fieldMap.filter((m) => !m.excluded && m.sfField === 'Id')
    : job.fieldMap.filter((m) => !m.excluded)
  let parsedHeaders: Record<string, string> | undefined
  if (job.customHeaders) {
    try { parsedHeaders = JSON.parse(job.customHeaders) } catch { parsedHeaders = undefined }
  }

  const sfOpts = {
    sfObject: job.sfObject,
    operation: job.operation,
    externalIdField: job.externalIdField,
    batchSize: job.batchSize ?? 200,
    threads: job.threads ?? 1,
    customHeaders: parsedHeaders,
    useBulkApi: job.useBulkApi
  }

  if (job.useBulkApi) {
    // ── Bulk API 2.0 path ─────────────────────────────────────────────────────
    // Bulk API still uses the streaming approach; the exec table is REST-only.
    async function* makeChunks(): AsyncGenerator<Record<string, unknown>[]> {
      let offset = 0
      while (!abortCtrl.signal.aborted) {
        const { rows } = db.queryPage(sql, offset, CHUNK)
        if (rows.length === 0) break
        // Yield between chunks to keep the event loop responsive.
        await new Promise<void>((resolve) => setImmediate(resolve))
        yield rows.map((row) => mapRowToRecord(row as unknown[], columns, activeMappings, 'bulk'))
        offset += rows.length
        if (rows.length < CHUNK) break
      }
    }

    // Pipelined failed-row ingestion: table is created on the first batch and
    // rows are inserted in 10 000-row transactions as they arrive, so the full
    // list never needs to live in memory.
    let bulkExecTableCreated = false
    // Captures the first DB error across all batches; surfaced as a warning once
    // the job completes.  Subsequent batch errors are logged but don't overwrite
    // the first message.
    let bulkExecWarnMsg: string | null = null

    const onFailedBatch = (sfColumns: string[], batch: Array<{ message: string; row: unknown[] }>): void => {
      try {
        if (!bulkExecTableCreated) {
          db.wbExecCreateBulkFailed(runId, sfColumns)
          state.columns = sfColumns
          state.isBulk = true
          bulkExecTableCreated = true
        }
        db.wbExecInsertBulkFailed(
          runId,
          sfColumns,
          batch.map((e) => ({ message: e.message, errorPrefix: errorPrefix(e.message), row: e.row }))
        )
        for (const e of batch) {
          const prefix = errorPrefix(e.message)
          state.distinctErrorCounts.set(prefix, (state.distinctErrorCounts.get(prefix) ?? 0) + 1)
        }
        state.totalRows += batch.length
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr)
        debugLog('wbSql', `[${runId}] Bulk failed-rows batch insert: ${msg}`)
        // Record the first error so the renderer can show a warning.
        if (!bulkExecWarnMsg) {
          bulkExecWarnMsg = `Some failed rows could not be saved to the exec table: ${msg}`
        }
      }
    }

    ;(async () => {
      const startTime = Date.now()
      try {
        const result = await sf.writebackBulk2(
          sfOpts,
          makeChunks(),
          (progress) => {
            const elapsed = (Date.now() - startTime) / 1000
            send('job:progress', {
              runId,
              type: 'writeback',
              phase: progress.phase,
              bulkUploaded: progress.uploaded,
              succeeded: progress.phase === 'processing'
                ? (progress.processed ?? 0) - (progress.failed ?? 0)
                : undefined,
              failed: progress.failed,
              total: progress.phase === 'uploading' ? progress.uploaded : progress.processed,
              jobState: progress.jobState,
              elapsed
            } as JobProgress)
          },
          abortCtrl.signal,
          onFailedBatch
        )

        // sfColumns / isBulk are set inside onFailedBatch on first batch; set them
        // here too for the zero-failures case (where onFailedBatch is never called).
        if (result.sfColumns.length > 0 && !state.isBulk) {
          state.columns = result.sfColumns
          state.isBulk = true
        }

        const histStatus = result.failed === 0 ? 'success'
          : result.succeeded === 0 ? 'error' : 'partial'
        db.finishWritebackRunHistory(runHistId, histStatus, result.succeeded + result.failed, result.succeeded, result.failed, Date.now() - startTime)
        const jobResult: JobResult = {
          runId, type: 'writeback', status: histStatus,
          rowsSucceeded: result.succeeded, rowsFailed: result.failed,
          columns: result.sfColumns,
          warnMsg: bulkExecWarnMsg ?? undefined
        }
        send('job:complete', jobResult)
        scheduler.notifyComplete(jobResult)
      } catch (err) {
        const cancelled = isAbortError(err)
        const msg = cancelled ? 'Cancelled by user' : (err instanceof Error ? err.message : String(err))
        try {
          db.finishWritebackRunHistory(runHistId, cancelled ? 'cancelled' : 'error', 0, 0, 0, Date.now() - startTime, cancelled ? undefined : msg)
        } catch { /* ignore secondary DB error so job:complete always fires */ }
        const jobResult: JobResult = { runId, type: 'writeback', status: cancelled ? 'cancelled' : 'error', errorMsg: cancelled ? undefined : msg }
        send('job:complete', jobResult)
        scheduler.notifyComplete(jobResult)
      } finally {
        activeJobs.delete(runId)
      }
    })().catch((secondaryErr) => {
      console.error(`[writeback bulk] Unexpected secondary error in run ${runId}:`, secondaryErr)
    })
  } else {
    // ── REST Collections API path — exec-table architecture ───────────────────
    // Phase 0: load all source rows into a TEMP SQLite table.
    // Phase 1: probe (sequential, if threads > 1) — aborts early if all rows fail.
    // Phase 2: producer-consumer main loop with N concurrent workers.
    // The renderer polls writeback:exec-counts + writeback:exec-page instead of
    // listening to rowStatuses on job:progress events.

    ;(async () => {
      let succeeded = 0
      let failed = 0
      const startTime = Date.now()
      const signal = abortCtrl.signal
      try {
        // ── Phase 0: load source data via worker thread ───────────────────────
        // The worker executes a single CREATE TABLE AS SELECT statement so the
        // main event loop is never blocked during the load.
        const loadSql = db.wbExecBuildCreateSql(runId, sql)
        debugLog('wbSql', `[${runId}] Phase 0 — CREATE TABLE AS SELECT (→ db-worker):\n${loadSql}`)
        await wbRunLoad({ id: runId, sql: loadSql, signal }, 'Phase 0')
        state.totalRows = db.wbExecGetRowCount(runId)
        state.loadingPhase = false

        const batchSize = sfOpts.batchSize ?? 200
        const threads = Math.min(sfOpts.threads ?? 1, 10)

        // ── Phase 1: probe (multi-thread jobs only) ───────────────────────────
        // Probe thresholds mirror the existing writebackBatch logic.
        let probeOffset = 0
        if (threads > 1) {
          let zeroCount = 0
          let sub50Count = 0

          while (!signal.aborted) {
            const batch = wbReadBatch(runId, columns, probeOffset, batchSize, 'Phase 1 (probe)')
            if (!batch.length) break

            const records = batch.map((b) => mapRowToRecord(b.row, columns, activeMappings))
            state.inFlight += batch.length
            const results = await sf.writebackOneBatch(sfOpts, records, signal)
            state.inFlight -= batch.length

            const batchSucceeded = results.filter((r) => r.success).length
            succeeded += batchSucceeded
            failed += results.length - batchSucceeded
            probeOffset += batch.length

            const updates = results.map((r, i) => ({
              rowid: batch[i].rowid,
              sfId: r.id ?? null,
              status: (r.success ? 'success' : 'error') as 'success' | 'error',
              error: r.success ? null : (r.errors[0] ?? ''),
              errorPrefix: r.success ? null : errorPrefix(r.errors[0] ?? '')
            }))
            wbUpdateBatch(runId, updates, 'Phase 1 (probe)')

            for (const r of results) {
              if (!r.success) {
                const prefix = errorPrefix(r.errors[0] ?? '')
                state.distinctErrorCounts.set(prefix, (state.distinctErrorCounts.get(prefix) ?? 0) + 1)
              }
            }

            if (batchSucceeded === 0) {
              zeroCount++
              if (zeroCount >= 5) {
                throw new Error(
                  'Writeback aborted: 5 consecutive probe batches had 0% success. ' +
                  'All rows are failing — please check your data, field mappings, and Salesforce validation rules.'
                )
              }
              sub50Count++
            } else if (batchSucceeded < batch.length * 0.5) {
              sub50Count++
            }

            // Probe passes on first batch with ≥50% success, or after 10 sub-50% batches
            if (batchSucceeded >= batch.length * 0.5 || sub50Count >= 10) break
          }
        }

        // ── Phase 2: producer-consumer main loop ──────────────────────────────
        // All workers share a single offset counter (JS is single-threaded so
        // the increment before the first await is effectively atomic).
        let mainOffset = probeOffset
        const nWorkers = threads

        const worker = async (): Promise<void> => {
          while (!signal.aborted) {
            const myOffset = mainOffset
            const batch = wbReadBatch(runId, columns, myOffset, batchSize, 'Phase 2')
            if (!batch.length) break
            mainOffset += batch.length   // advance before first await

            state.inFlight += batch.length
            const records = batch.map((b) => mapRowToRecord(b.row, columns, activeMappings))
            const results = await sf.writebackOneBatch(sfOpts, records, signal)
            state.inFlight -= batch.length

            const p2ok = results.filter((r) => r.success).length
            const p2updates = results.map((r, i) => ({
              rowid: batch[i].rowid,
              sfId: r.id ?? null,
              status: (r.success ? 'success' : 'error') as 'success' | 'error',
              error: r.success ? null : (r.errors[0] ?? ''),
              errorPrefix: r.success ? null : errorPrefix(r.errors[0] ?? '')
            }))
            wbUpdateBatch(runId, p2updates, 'Phase 2')

            for (const r of results) {
              if (r.success) {
                succeeded++
              } else {
                failed++
                const prefix = errorPrefix(r.errors[0] ?? '')
                state.distinctErrorCounts.set(prefix, (state.distinctErrorCounts.get(prefix) ?? 0) + 1)
              }
            }
          }
        }

        await Promise.all(Array.from({ length: nWorkers }, () => worker()))

        const status = failed === 0 ? 'success' : succeeded === 0 ? 'error' : 'partial'
        try {
          db.finishWritebackRunHistory(runHistId, status, succeeded + failed, succeeded, failed, Date.now() - startTime)
        } catch { /* ignore secondary DB error so job:complete always fires */ }
        const jobResult: JobResult = { runId, type: 'writeback', status, rowsSucceeded: succeeded, rowsFailed: failed }
        send('job:complete', jobResult)
        scheduler.notifyComplete(jobResult)
      } catch (err) {
        const cancelled = isAbortError(err)
        const msg = cancelled ? 'Cancelled by user' : (err instanceof Error ? err.message : String(err))
        const errStatus = cancelled ? 'cancelled' : (succeeded > 0 ? 'partial' : 'error')
        try {
          db.finishWritebackRunHistory(runHistId, errStatus, succeeded + failed, succeeded, failed, Date.now() - startTime, cancelled ? undefined : msg)
        } catch { /* ignore secondary DB error so job:complete always fires */ }
        const jobResult: JobResult = { runId, type: 'writeback', status: cancelled ? 'cancelled' : 'error', errorMsg: cancelled ? undefined : msg, rowsSucceeded: succeeded, rowsFailed: failed }
        send('job:complete', jobResult)
        scheduler.notifyComplete(jobResult)
      } finally {
        activeJobs.delete(runId)
      }
    })().catch((secondaryErr) => {
      console.error(`[writeback rest] Unexpected secondary error in run ${runId}:`, secondaryErr)
    })
  }

  // Await the basic completion signal from the scheduler.
  const basicResult = await completionPromise
  const succeeded = basicResult.rowsSucceeded ?? 0
  const failed = basicResult.rowsFailed ?? 0
  // REST path: state.totalRows is set after Phase 0; Bulk path: it stays 0.
  const rowsSource = state.totalRows > 0 ? state.totalRows : succeeded + failed
  // REST path exec table always exists when Phase 0 completed (totalRows > 0).
  // Bulk path exec table exists only when there are failed rows.
  const execTable = (state.totalRows > 0 || failed > 0) ? wbExecTableName(runId) : null
  return {
    _runId: runId,
    status: basicResult.status as 'success' | 'partial' | 'error' | 'cancelled',
    rowsSource,
    rowsSucceeded: succeeded,
    rowsFailed: failed,
    execTable,
  }
}

// ── Network diagnostics helpers ───────────────────────────────────────────────

/**
 * Attempt a HEAD request to a URL within 5 s using Electron's net.fetch,
 * which runs through Chromium's network stack and therefore respects the
 * macOS Keychain (system CA certificates) and system proxy settings.
 * Returns null on success, or an error message string on failure.
 */
async function checkUrl(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    await net.fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' })
    return null
  } catch (err) {
    const isTimeout = controller.signal.aborted
    return isTimeout
      ? `Request timed out after 5 s`
      : err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }
}

function getProviderBaseUrl(settings: LlmSettings): string {
  switch (settings.provider) {
    case 'openai':    return 'https://api.openai.com'
    case 'anthropic': return 'https://api.anthropic.com'
    case 'mistral':   return 'https://api.mistral.ai'
    case 'ollama':    return settings.ollamaBaseUrl || 'http://localhost:11434'
    case 'litellm':   return settings.litellmBaseUrl || 'http://localhost:4000'
  }
}

// ── Module-level job executors (used by both IPC handlers and script runner) ──

/**
 * Compute the display label for a download job — the same string shown in the
 * UI job list and used by jobs.runDownload() to identify a job.
 * Format: "SOQL: <name>" | "SOQL" | "<SfObject>: <name>" | "<SfObject>"
 */
function extractJobLabel(j: ExtractJob): string {
  if (j.soqlQuery) {
    return j.name ? `SOQL: ${j.name}` : 'SOQL'
  }
  return j.name ? `${j.sfObject}: ${j.name}` : j.sfObject
}

/**
 * Compute the display label for a writeback job — the same string shown in the
 * UI job list and used by jobs.runWriteback() to identify a job.
 * Format: "<SfObject>: <name>" | "<SfObject>"
 */
function writebackJobLabel(j: WritebackJob): string {
  return j.name ? `${j.sfObject}: ${j.name}` : j.sfObject
}

function runExtractByName(label: string): Promise<JobResult> {
  const labelLower = label.toLowerCase()
  const job = db.listExtractJobs().find((j) => extractJobLabel(j).toLowerCase() === labelLower)
  if (!job) throw new Error(`Download job "${label}" not found`)
  // Pre-generate runId so the same value is used in startFn and in the
  // external event emitted to the renderer for UI badge synchronisation.
  const runId = randomUUID()
  return scheduler.schedule('extract', job.id, label, runId, () => startExtractRun(job.id, runId))
}

function runWritebackByName(label: string): Promise<WritebackScriptResult> {
  const labelLower = label.toLowerCase()
  const job = db.listWritebackJobs().find((j) => writebackJobLabel(j).toLowerCase() === labelLower)
  if (!job) throw new Error(`Writeback job "${label}" not found`)
  const runId = randomUUID()
  return scheduler.schedule('writeback', job.id, label, runId, () => startWritebackRun(job.id, runId))
}

function listJobs(): JobListEntry[] {
  const extractEntries: JobListEntry[] = db.listExtractJobs().map((j) => ({
    label: extractJobLabel(j),
    type: 'extract' as const,
    sfObject: j.soqlQuery ? 'SOQL' : j.sfObject,
    destTable: j.destTable,
  }))
  const writebackEntries: JobListEntry[] = db.listWritebackJobs().map((j) => ({
    label: writebackJobLabel(j),
    type: 'writeback' as const,
    sfObject: j.sfObject,
    operation: j.operation,
    api: j.useBulkApi ? 'Bulk' : 'REST',
  }))
  return [...extractEntries, ...writebackEntries]
}

/** Stub: "update table with IDs" will be re-implemented later. */
function runUpdateTableWithIds(
  _runId: string,
  _sfKeyField: string,
  _targetTable: string,
  _tableKeyCol: string,
  _idColumnName: string
): { updated: number; idColCreated: boolean; indexCreated: boolean } {
  throw new Error('Update table with IDs is not yet available in this version.')
}

/** Stub: script-runner compat — returns empty result. */
function getFailedRowsByRunId(_runId: string): WritebackFailedRowsResult {
  return { failedRows: [], keyFields: [] }
}

// ── SF CLI path settings ──────────────────────────────────────────────────────

function getSfSettingsFilePath(): string {
  return join(app.getPath('userData'), 'sf-settings.json')
}

interface SfSettings {
  sfCliPath?: string
  extraCaCertPath?: string
  disableCaCertPatch?: boolean
}

function readSfSettings(): SfSettings {
  try {
    return JSON.parse(readFileSync(getSfSettingsFilePath(), 'utf-8')) as SfSettings
  } catch {
    return {}
  }
}

function writeSfSettings(settings: SfSettings): void {
  writeFileSync(getSfSettingsFilePath(), JSON.stringify(settings, null, 2), 'utf-8')
}

export function registerIpcHandlers(): void {
  // Restore persisted sf CLI path so listCliOrgs uses it immediately.
  const sfSettings = readSfSettings()
  if (sfSettings.sfCliPath) {
    sf.setCustomSfPath(sfSettings.sfCliPath)
  }

  // ── Database ────────────────────────────────────────────────────────────────

  ipcMain.handle('db:open', async (_e, filePath?: string) => {
    if (filePath) {
      // A path is only supplied when reopening a recent database.  Validate it
      // against the stored list so the renderer cannot open arbitrary paths.
      const isKnownRecent = recent.listRecentDatabases().some((r) => r.path === filePath)
      if (!isKnownRecent) {
        filePath = undefined  // fall through to the file-picker below
      }
    }
    if (!filePath) {
      const result = await dialog.showOpenDialog({
        title: 'Open SQLite Database',
        filters: [{ name: 'SQLite', extensions: ['sqlite', 'db', 'sqlite3'] }],
        properties: ['openFile', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      filePath = result.filePaths[0]
    }
    const opened = db.openDatabase(filePath)
    recent.addRecentDatabase(filePath)
    void dbWorker.openDb(filePath)
    // Return the opened DB immediately so the UI is not blocked by SF CLI detection.
    // Auto-connect runs in the background; result arrives via the sf:auto-connected event.
    autoConnectAfterDbOpen()
    return opened
  })

  ipcMain.handle('db:open-new', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Create SQLite Database',
      filters: [{ name: 'SQLite', extensions: ['sqlite', 'db'] }]
    })
    if (result.canceled || !result.filePath) return null
    const opened = db.openDatabase(result.filePath)
    recent.addRecentDatabase(result.filePath)
    void dbWorker.openDb(result.filePath)
    autoConnectAfterDbOpen()
    return opened
  })

  ipcMain.handle('db:recent-list', () => recent.listRecentDatabases())
  ipcMain.handle('db:recent-remove', (_e, filePath: string) => recent.removeRecentDatabase(filePath))

  ipcMain.handle('db:info', () => db.getDatabaseInfo())
  ipcMain.handle('db:table-row-count', (_e, tableName: string) => db.getTableRowCount(tableName))

  ipcMain.handle('db:query', (_e, sql: string) => db.executeQuery(sql))

  // ── Server-side pagination for query results ───────────────────────────────
  ipcMain.handle('db:query-init', (_e, sql: string, pageSize: number) =>
    db.queryInit(sql, pageSize)
  )

  ipcMain.handle('db:query-page', (
    _e, sql: string, offset: number, limit: number,
    orderBy?: { column: string; dir: 'asc' | 'desc' }[]
  ) => db.queryPage(sql, offset, limit, orderBy))

  ipcMain.handle('db:export-query-csv', async (_e, sql: string) => {
    const saveResult = await dialog.showSaveDialog({
      title: 'Export to CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      defaultPath: 'export.csv'
    })
    if (saveResult.canceled || !saveResult.filePath) return null
    // Streams rows straight from the SQLite cursor to disk, so the full result
    // set is never held in memory at once (see streamQueryToCsv for details).
    const result = await db.streamQueryToCsv(sql, saveResult.filePath)
    if (result.error) return null
    return saveResult.filePath
  })

  ipcMain.handle('db:export-csv', async (_e, csvContent: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Export to CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      defaultPath: 'export.csv'
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, csvContent, 'utf-8')
    return result.filePath
  })

  ipcMain.handle('db:rename-table', (_e, oldName: string, newName: string) =>
    db.renameTable(oldName, newName)
  )

  ipcMain.handle('db:rename-column', (_e, table: string, oldName: string, newName: string) =>
    db.renameColumn(table, oldName, newName)
  )

  ipcMain.handle('db:drop-table', (_e, name: string) => db.dropTable(name))

  ipcMain.handle('db:waste-info', () => db.getDatabaseWasteInfo())

  ipcMain.handle('db:vacuum', () => db.vacuumDatabase())

  /** Files larger than this are refused in preview mode to prevent OOM. */
  const CSV_PREVIEW_SIZE_LIMIT = 200 * 1024 * 1024 // 200 MB

  ipcMain.handle('csv:pick-and-preview', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select CSV file',
      filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    if (statSync(filePath).size > CSV_PREVIEW_SIZE_LIMIT) {
      return { filePath, headers: [], rows: [], totalLines: 0, tooLarge: true as const }
    }
    return db.previewCsvFile(filePath)
  })

  ipcMain.handle('csv:preview-path', (_e, filePath: string) => {
    assertCsvPath(filePath)
    if (statSync(filePath).size > CSV_PREVIEW_SIZE_LIMIT) {
      return { filePath, headers: [], rows: [], totalLines: 0, tooLarge: true as const }
    }
    return db.previewCsvFile(filePath)
  })

  ipcMain.handle('csv:import', (_e, filePath: string, tableName: string, ifExists: 'replace' | 'append') => {
    assertCsvPath(filePath)
    return db.importCsvFile(filePath, tableName, ifExists)
  })

  ipcMain.handle('csv:import-text', (_e, csvContent: string, tableName: string, ifExists: 'replace' | 'append', separator: string) =>
    db.importCsvText(csvContent, tableName, ifExists, separator)
  )

  ipcMain.handle('csv:pick-direct', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select CSV file',
      filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  const directImportControllers = new Map<number, AbortController>()

  ipcMain.handle('csv:direct-import', (event, filePath: string, tableName: string, ifExists: 'replace' | 'append') => {
    assertCsvPath(filePath)
    const wc = event.sender
    const controller = new AbortController()
    directImportControllers.set(wc.id, controller)
    const PROGRESS_INTERVAL_MS = 500
    let lastSentAt = 0
    const onProgress = (rowsLoaded: number): void => {
      const now = Date.now()
      if (now - lastSentAt >= PROGRESS_INTERVAL_MS) {
        lastSentAt = now
        wc.send('csv:direct-import:progress', rowsLoaded)
      }
    }
    return db.importCsvFileStreaming(filePath, tableName, ifExists, 500, onProgress, controller.signal)
      .finally(() => { directImportControllers.delete(wc.id) })
  })

  ipcMain.handle('csv:direct-import:cancel', (event) => {
    directImportControllers.get(event.sender.id)?.abort()
  })

  // ── Saved Queries ────────────────────────────────────────────────────────────

  ipcMain.handle('query:list', () => db.listSavedQueries())
  ipcMain.handle('query:save', (_e, q) => db.saveQuery(q))
  ipcMain.handle('query:delete', (_e, id: number) => db.deleteQuery(id))
  ipcMain.handle('query:reorder', (_e, ids: number[]) => db.reorderQueries(ids))

  // ── Query Drafts ─────────────────────────────────────────────────────────────

  ipcMain.handle('query:drafts:list', () => db.listQueryDrafts())
  ipcMain.handle('query:drafts:upsert', (_e, draft) => db.upsertQueryDraft(draft))
  ipcMain.handle('query:drafts:delete', (_e, tabKey: string) => db.deleteQueryDraft(tabKey))

  // ── Script Drafts ─────────────────────────────────────────────────────────────

  ipcMain.handle('script:drafts:list', () => db.listScriptDrafts())
  ipcMain.handle('script:drafts:upsert', (_e, draft) => db.upsertScriptDraft(draft))
  ipcMain.handle('script:drafts:delete', (_e, draftKey: string) => db.deleteScriptDraft(draftKey))


  // ── Salesforce ───────────────────────────────────────────────────────────────

  ipcMain.handle('sf:connect-oauth', (_e, clientId: string, loginUrl: string) =>
    sf.connectOAuth(clientId, loginUrl)
  )
  ipcMain.handle('sf:disconnect', () => sf.disconnectSalesforce())

  ipcMain.handle('app:get-connection-status', () => ({
    sfOrg: sf.getOrgInfo(),
    dbPath: db.getPath()
  }))
  ipcMain.handle('sf:list-cli-orgs', () => {
    // Re-use an in-flight call if one is already running (e.g. auto-connect started it).
    // Both callers only need the resolved value, so sharing the promise is safe.
    if (!pendingListOrgs) {
      pendingListOrgs = sf.listCliOrgs().finally(() => { pendingListOrgs = null })
    }
    return pendingListOrgs
  })
  ipcMain.handle('sf:connect-cli-org', async (_e, username: string) => {
    const org = await sf.connectCliOrg(username)
    if (db.isOpen()) db.setSetting('sf_cli_username', username)
    return org
  })

  ipcMain.handle('sf:get-custom-path', (): string | null => {
    return sf.getCustomSfPath()
  })

  ipcMain.handle('sf:set-custom-path', (_e, path: string): void => {
    const trimmed = path.trim()
    sf.setCustomSfPath(trimmed || null)
    const current = readSfSettings()
    if (trimmed) {
      current.sfCliPath = trimmed
    } else {
      delete current.sfCliPath
    }
    writeSfSettings(current)
    // Invalidate any cached org-list so the next call uses the new path.
    pendingListOrgs = null
  })

  // ── Network / CA certificate settings ─────────────────────────────────────

  ipcMain.handle('sf:get-network-settings', (): {
    shellCaCertPath: string | null
    savedCaCertPath: string | null
    shellPath: string | null
    patchDisabled: boolean
  } => {
    const sfSettings = readSfSettings()
    return {
      shellCaCertPath: getShellCaCertPath(),
      savedCaCertPath: sfSettings.extraCaCertPath ?? null,
      shellPath: process.env.PATH ?? null,
      patchDisabled: sfSettings.disableCaCertPatch ?? false
    }
  })

  ipcMain.handle('sf:set-ca-cert-path', (_e, certPath: string | null, disabled: boolean): void => {
    const trimmed = certPath?.trim() || null
    const current = readSfSettings()

    if (disabled) {
      current.disableCaCertPatch = true
      delete current.extraCaCertPath
      disablePatch()
    } else {
      delete current.disableCaCertPatch
      enablePatch()
      if (trimmed) {
        current.extraCaCertPath = trimmed
        applyExtraCaCert(trimmed)
      } else {
        delete current.extraCaCertPath
        // Restore the shell-env cert if there is one; otherwise clear entirely.
        const shellPath = getShellCaCertPath()
        if (shellPath) {
          applyExtraCaCert(shellPath)
        } else {
          clearExtraCaCert()
        }
      }
    }
    writeSfSettings(current)
  })

  ipcMain.handle('sf:browse-ca-cert', async (): Promise<string | null> => {
    const win = getMainWindow() ?? BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select CA Certificate File',
      filters: [
        { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'ca-bundle'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('sf:get-active-ca-cert-path', (): string | null => {
    return getActiveCaCertPath()
  })

  ipcMain.handle('sf:list-objects', () => sf.listObjects())
  ipcMain.handle('sf:describe', (_e, name: string) => sf.describeObject(name))
  ipcMain.handle('sf:soql', (_e, soql: string) => sf.runSoqlQuery(soql))

  // ── Extract Jobs ─────────────────────────────────────────────────────────────

  ipcMain.handle('extract:list', () => db.listExtractJobs())
  ipcMain.handle('extract:save', (_e, job: ExtractJobInput) => db.saveExtractJob(job))
  ipcMain.handle('extract:delete', (_e, jobId: number) => db.deleteExtractJob(jobId))
  ipcMain.handle('extract:duplicate', (_e, jobId: number) => db.duplicateExtractJob(jobId))
  ipcMain.handle('extract:history', (_e, jobId: number) => db.getRunHistory(jobId))

  ipcMain.handle('extract:start', async (_e, jobId: number): Promise<string> => {
    const runId = randomUUID()
    startExtractRun(jobId, runId)  // fire-and-forget; scheduler.registerRun called inside
    return runId
  })

  // ── Write-back Jobs ──────────────────────────────────────────────────────────

  ipcMain.handle('writeback:list', () => db.listWritebackJobs())
  ipcMain.handle('writeback:save', (_e, job: WritebackJobInput) => db.saveWritebackJob(job))
  ipcMain.handle('writeback:delete', (_e, jobId: number) => db.deleteWritebackJob(jobId))
  ipcMain.handle('writeback:duplicate', (_e, jobId: number) => db.duplicateWritebackJob(jobId))
  ipcMain.handle('writeback:history', (_e, jobId: number) => db.getWritebackRunHistory(jobId))
  ipcMain.handle('writeback:preview', (_e, sql: string) => db.previewWritebackQuery(sql))

  // ── Exec-table access (REST API writeback) ────────────────────────────────────

  /** Returns aggregated counts from the exec table for live polling by the renderer. */
  ipcMain.handle('writeback:exec-counts', (_e, runId: string) => {
    const state = wbRunStates.get(runId)
    if (!state) return { total: 0, queued: 0, succeeded: 0, failed: 0, inFlight: 0, loadingPhase: false }
    try {
      const counts = db.wbExecGetStatusCounts(runId)
      return {
        total: state.totalRows,
        queued: counts.queued,
        succeeded: counts.succeeded,
        failed: counts.failed,
        inFlight: state.inFlight,
        loadingPhase: state.loadingPhase
      }
    } catch {
      return { total: state.totalRows, queued: 0, succeeded: 0, failed: 0, inFlight: state.inFlight, loadingPhase: state.loadingPhase }
    }
  })

  /** Returns the in-memory distinct error map for live filtering/display. */
  ipcMain.handle('writeback:exec-distinct-errors', (_e, runId: string) => {
    const state = wbRunStates.get(runId)
    if (!state) return []
    return distinctErrorsSnapshot(state)
  })

  /** Returns one page of exec-table rows for the DataGrid. */
  ipcMain.handle(
    'writeback:exec-page',
    (
      _e,
      runId: string,
      offset: number,
      limit: number,
      filter?: { statuses?: ('success' | 'error' | 'queued')[]; errorPrefix?: string }
    ) => {
      const state = wbRunStates.get(runId)
      if (!state) return { columns: [], rows: [] }
      try {
        return db.wbExecGetPage(runId, state.columns, offset, limit, filter)
      } catch {
        return { columns: state.columns, rows: [] }
      }
    }
  )

  /** Returns the total row count matching a filter (for pagination). */
  ipcMain.handle(
    'writeback:exec-count',
    (
      _e,
      runId: string,
      filter?: { statuses?: ('success' | 'error' | 'queued')[]; errorPrefix?: string }
    ) => {
      const state = wbRunStates.get(runId)
      if (!state) return 0
      try {
        return db.wbExecGetPageCount(runId, filter)
      } catch {
        return 0
      }
    }
  )

  ipcMain.handle('db:user-tables', () => db.getUserTableNames())
  ipcMain.handle('db:table-columns', (_e, tableName: string) => db.getTableColumnNames(tableName))
  ipcMain.handle('db:column-has-index', (_e, tableName: string, columnName: string) =>
    db.columnHasIndex(tableName, columnName)
  )

  ipcMain.handle('db:create-index', (_e, tableName: string, columnName: string) =>
    db.ensureColumnIndexes(tableName, [columnName])
  )

  ipcMain.handle('db:drop-index', (_e, indexName: string) =>
    db.dropIndex(indexName)
  )

  ipcMain.handle('writeback:start', async (_e, jobId: number): Promise<string> => {
    const runId = randomUUID()
    startWritebackRun(jobId, runId).catch((err) => {
      // Safety net: startWritebackRun should handle all errors internally,
      // but if something escapes (e.g. ensureConnected throws) at least notify the renderer.
      const msg = err instanceof Error ? err.message : String(err)
      const jobResult: JobResult = { runId, type: 'writeback', status: 'error', errorMsg: msg }
      send('job:complete', jobResult)
    })
    return runId
  })

  ipcMain.handle('writeback:retry', async (_e, prevRunId: string, jobId: number): Promise<string> => {
    const job = db.listWritebackJobs().find((j) => j.id === jobId)
    if (!job) throw new Error(`Writeback job ${jobId} not found`)

    const prevState = wbRunStates.get(prevRunId)
    if (!prevState) throw new Error('Previous run state not found — the run data may have been cleared.')

    // Read failed rows from the exec table
    let failedCount = 0
    try {
      failedCount = db.wbExecGetPageCount(prevRunId, { statuses: ['error'] })
    } catch {
      throw new Error('Failed to read error rows from exec table.')
    }
    if (failedCount === 0) throw new Error('No failed rows found for this run.')

    const { columns, isBulk } = prevState
    // For Bulk API exec tables, columns are already Salesforce field names so
    // mapRowToRecord is bypassed.  For REST exec tables, normal field-mapping applies.
    const activeMappings = isBulk
      ? []
      : job.operation === 'delete'
        ? job.fieldMap.filter((m) => !m.excluded && m.sfField === 'Id')
        : job.fieldMap.filter((m) => !m.excluded)
    let parsedHeadersRetry: Record<string, string> | undefined
    if (job.customHeaders) {
      try { parsedHeadersRetry = JSON.parse(job.customHeaders) } catch { parsedHeadersRetry = undefined }
    }

    const sfOpts = {
      sfObject: job.sfObject,
      operation: job.operation,
      externalIdField: job.externalIdField,
      batchSize: job.batchSize ?? 200,
      threads: job.threads ?? 1,
      customHeaders: parsedHeadersRetry
    }

    const newRunId = randomUUID()
    const abortCtrl = new AbortController()
    activeJobs.set(newRunId, abortCtrl)
    scheduler.registerRun('writeback', jobId, newRunId)

    const newState: WbRunState = {
      sql: prevState.sql,
      columns,
      totalRows: 0,
      loadingPhase: true, inFlight: 0,
      distinctErrorCounts: new Map(),
      isBulk
    }
    addWbRunState(newRunId, newState)
    const runHistId = db.startWritebackRunHistory(jobId, false)

    ;(async () => {
      let succeeded = 0
      let failed = 0
      const startTime = Date.now()
      const signal = abortCtrl.signal
      try {
        // Copy failed rows from the previous exec table into a new one via worker thread
        const retrySql = db.wbExecBuildRetrySql(newRunId, prevRunId, columns)
        debugLog('wbSql', `[${newRunId}] Retry Phase 0 — CREATE TABLE AS SELECT (→ db-worker):\n${retrySql}`)
        await wbRunLoad({ id: newRunId, sql: retrySql, signal }, 'Retry Phase 0')
        newState.totalRows = db.wbExecGetRowCount(newRunId)
        newState.loadingPhase = false

        const batchSize = sfOpts.batchSize ?? 200
        const threads = Math.min(sfOpts.threads ?? 1, 10)
        let mainOffset = 0

        const worker = async (): Promise<void> => {
          while (!signal.aborted) {
            const myOffset = mainOffset
            const batchRows = wbReadBatch(newRunId, columns, myOffset, batchSize, 'Retry Phase 2')
            if (!batchRows.length) break
            mainOffset += batchRows.length
            newState.inFlight += batchRows.length
            // For Bulk API retries, columns are already SF field names — build the
            // record directly without going through mapRowToRecord.
            // Columns that use the Bulk ext-ID dot-notation (e.g. "Account.AccountNumber")
            // must be converted to the REST nested-object shape ({ Account: { AccountNumber } }).
            const records = isBulk
              ? batchRows.map((b) => {
                  const rec: Record<string, unknown> = {}
                  for (let i = 0; i < columns.length; i++) {
                    const col = columns[i]
                    const value = b.row[i] ?? null
                    const dotIdx = col.indexOf('.')
                    if (dotIdx !== -1) {
                      rec[col.slice(0, dotIdx)] = { [col.slice(dotIdx + 1)]: value }
                    } else {
                      rec[col] = value
                    }
                  }
                  return rec
                })
              : batchRows.map((b) => mapRowToRecord(b.row, columns, activeMappings))
            const results = await sf.writebackOneBatch(sfOpts, records, signal)
            newState.inFlight -= batchRows.length
            const rtOk = results.filter((r) => r.success).length
            const rtUpdates = results.map((r, i) => ({
              rowid: batchRows[i].rowid,
              sfId: r.id ?? null,
              status: (r.success ? 'success' : 'error') as 'success' | 'error',
              error: r.success ? null : (r.errors[0] ?? ''),
              errorPrefix: r.success ? null : errorPrefix(r.errors[0] ?? '')
            }))
            wbUpdateBatch(newRunId, rtUpdates, 'Retry Phase 2')
            for (const r of results) {
              if (r.success) {
                succeeded++
              } else {
                failed++
                const prefix = errorPrefix(r.errors[0] ?? '')
                newState.distinctErrorCounts.set(prefix, (newState.distinctErrorCounts.get(prefix) ?? 0) + 1)
              }
            }
          }
        }

        await Promise.all(Array.from({ length: threads }, () => worker()))

        const status = failed === 0 ? 'success' : succeeded === 0 ? 'error' : 'partial'
        try {
          db.finishWritebackRunHistory(runHistId, status, succeeded + failed, succeeded, failed, Date.now() - startTime)
        } catch { /* ignore secondary DB error so job:complete always fires */ }
        const retryResult: JobResult = { runId: newRunId, type: 'writeback', status, rowsSucceeded: succeeded, rowsFailed: failed }
        send('job:complete', retryResult)
        scheduler.notifyComplete(retryResult)
      } catch (err) {
        const cancelled = isAbortError(err)
        const msg = cancelled ? 'Cancelled by user' : (err instanceof Error ? err.message : String(err))
        try {
          db.finishWritebackRunHistory(runHistId, cancelled ? 'cancelled' : 'error', succeeded + failed, succeeded, failed, Date.now() - startTime, cancelled ? undefined : msg)
        } catch { /* ignore secondary DB error so job:complete always fires */ }
        const retryResult: JobResult = { runId: newRunId, type: 'writeback', status: cancelled ? 'cancelled' : 'error', errorMsg: cancelled ? undefined : msg }
        send('job:complete', retryResult)
        scheduler.notifyComplete(retryResult)
      } finally {
        activeJobs.delete(newRunId)
      }
    })().catch((secondaryErr) => {
      console.error(`[writeback retry] Unexpected secondary error in run ${newRunId}:`, secondaryErr)
    })

    return newRunId
  })

  ipcMain.handle('job:cancel', (_e, runId: string) => {
    activeJobs.get(runId)?.abort()
    activeJobs.delete(runId)
  })

  // ── Job execution by name (used by renderer and script runner) ───────────────
  ipcMain.handle('job:run-extract-by-name', async (_e, name: string): Promise<{ rowsLoaded: number }> => {
    const result = await runExtractByName(name)
    return { rowsLoaded: result.rowsLoaded ?? 0 }
  })

  ipcMain.handle('job:run-writeback-by-name', (_e, name: string): Promise<WritebackScriptResult> => {
    return runWritebackByName(name)
  })

  ipcMain.handle('job:get-failed-rows', (_e, runId: string): WritebackFailedRowsResult => {
    return getFailedRowsByRunId(runId)
  })

  // Forward scheduler events to the renderer so JobsView can
  // show running/queued badges for script-triggered jobs.
  scheduler.onExternalEvent((e) => {
    send(`job:external-${e.event}`, { type: e.type, jobId: e.jobId })
  })

  // Register executors so the script runner can dispatch jobs from worker threads.
  scriptRunner.setJobExecutors(runExtractByName, runWritebackByName, runUpdateTableWithIds, getFailedRowsByRunId, listJobs)

  // ── Scripts ─────────────────────────────────────────────────────────────────
  ipcMain.handle('script:list', () => db.listScripts())

  ipcMain.handle('script:save', (_e, script: SavedScriptInput & { id?: number }) =>
    db.saveScript(script)
  )

  ipcMain.handle('script:delete', (_e, id: number) => db.deleteScript(id))

  // script:run returns the runId immediately. Logs and the final completion event
  // are both delivered via webContents.send so they share a single ordered channel,
  // eliminating the race condition where the ipcMain.handle reply could overtake
  // in-flight script:log messages.
  ipcMain.handle('script:run', (_e, { code, runId }: { code: string; runId: string }) => {
    // Always use the main-process DB path — never trust the renderer-supplied one.
    const openPath = db.getPath()
    if (!openPath) throw new Error('No database is open')
    const win = getMainWindow()

    // Batch log messages and flush at most every 50 ms so that tight console.log
    // loops don't generate one IPC round-trip per line.
    const logBuffer: Array<ScriptLog & { runId: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flushLogs = (): void => {
      flushTimer = null
      if (logBuffer.length === 0) {
        return
      }
      const batch = logBuffer.splice(0)
      win?.webContents.send('script:log-batch', batch)
    }

    scriptRunner.runScript(
      openPath,
      code,
      runId,
      (log: ScriptLog) => {
        logBuffer.push({ runId, ...log })
        if (!flushTimer) {
          flushTimer = setTimeout(flushLogs, 50)
        }
      },
      (result: ScriptComplete) => {
        // Flush any buffered logs before sending completion so the renderer
        // sees all output before the "done" banner appears.
        if (flushTimer) {
          clearTimeout(flushTimer)
        }
        flushLogs()
        win?.webContents.send('script:complete', result)
      },
      (p: ScriptProgress) => {
        win?.webContents.send('script:progress', p)
      }
    )
    return runId
  })

  ipcMain.handle('script:cancel', (_e, runId: string) => scriptRunner.cancelScript(runId))

  // ── LLM Settings ─────────────────────────────────────────────────────────────

  function getLlmSettingsFilePath(): string {
    return join(app.getPath('userData'), 'llm-settings.json')
  }

  function readLlmSettingsRaw(): Record<string, unknown> {
    const filePath = getLlmSettingsFilePath()
    if (!existsSync(filePath)) {
      return {}
    }
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  function decryptKey(value: unknown): string {
    if (typeof value !== 'string' || value === '') {
      return ''
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return value as string
    }
    try {
      const buf = Buffer.from(value as string, 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return ''
    }
  }

  function encryptKey(value: string): string {
    if (value === '') {
      return ''
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return value
    }
    return safeStorage.encryptString(value).toString('base64')
  }

  /** Read the settings file and return a fully decrypted LlmSettings object. */
  function loadDecryptedSettings(): LlmSettings {
    const raw = readLlmSettingsRaw()
    return {
      provider: (raw.provider as LlmSettings['provider']) ?? DEFAULT_SETTINGS.provider,
      openaiKey: decryptKey(raw.openaiKey),
      openaiModel: (raw.openaiModel as string) ?? DEFAULT_SETTINGS.openaiModel,
      openaiDeepReason: Boolean(raw.openaiDeepReason ?? DEFAULT_SETTINGS.openaiDeepReason),
      anthropicKey: decryptKey(raw.anthropicKey),
      anthropicModel: (raw.anthropicModel as string) ?? DEFAULT_SETTINGS.anthropicModel,
      anthropicExtendedThinking: Boolean(raw.anthropicExtendedThinking ?? DEFAULT_SETTINGS.anthropicExtendedThinking),
      mistralKey: decryptKey(raw.mistralKey),
      mistralModel: (raw.mistralModel as string) ?? DEFAULT_SETTINGS.mistralModel,
      ollamaBaseUrl: (raw.ollamaBaseUrl as string) ?? DEFAULT_SETTINGS.ollamaBaseUrl,
      ollamaModel: (raw.ollamaModel as string) ?? DEFAULT_SETTINGS.ollamaModel,
      litellmBaseUrl: (raw.litellmBaseUrl as string) ?? DEFAULT_SETTINGS.litellmBaseUrl,
      litellmApiKey: decryptKey(raw.litellmApiKey),
      litellmModel: (raw.litellmModel as string) ?? DEFAULT_SETTINGS.litellmModel,
      systemPromptTemplate: (raw.systemPromptTemplate as string) ?? ''
    }
  }

  ipcMain.handle('llm:get-settings', (): LlmSettings & { encryptionAvailable: boolean; openaiKeySet: boolean; anthropicKeySet: boolean; mistralKeySet: boolean; litellmKeySet: boolean; defaultSystemPromptTemplate: string } => {
    const raw = readLlmSettingsRaw()
    return {
      ...loadDecryptedSettings(),
      defaultSystemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      // True when an encrypted value exists in the file, regardless of whether
      // decryption succeeded (e.g. macOS keychain permission denied on restart).
      openaiKeySet: typeof raw.openaiKey === 'string' && raw.openaiKey !== '',
      anthropicKeySet: typeof raw.anthropicKey === 'string' && raw.anthropicKey !== '',
      mistralKeySet: typeof raw.mistralKey === 'string' && raw.mistralKey !== '',
      litellmKeySet: typeof raw.litellmApiKey === 'string' && raw.litellmApiKey !== ''
    }
  })

  ipcMain.handle('llm:save-settings', (_e, settings: LlmSettings): void => {
    // Read the existing file so we can preserve already-encrypted keys when the
    // caller sends an empty string (meaning "don't change this key").
    const existing = readLlmSettingsRaw()
    const toWrite = {
      provider: settings.provider,
      openaiKey: settings.openaiKey !== '' ? encryptKey(settings.openaiKey) : (existing.openaiKey ?? ''),
      openaiModel: settings.openaiModel,
      openaiDeepReason: settings.openaiDeepReason,
      anthropicKey: settings.anthropicKey !== '' ? encryptKey(settings.anthropicKey) : (existing.anthropicKey ?? ''),
      anthropicModel: settings.anthropicModel,
      anthropicExtendedThinking: settings.anthropicExtendedThinking,
      mistralKey: settings.mistralKey !== '' ? encryptKey(settings.mistralKey) : (existing.mistralKey ?? ''),
      mistralModel: settings.mistralModel,
      ollamaBaseUrl: settings.ollamaBaseUrl,
      ollamaModel: settings.ollamaModel,
      litellmBaseUrl: settings.litellmBaseUrl,
      litellmApiKey: settings.litellmApiKey !== '' ? encryptKey(settings.litellmApiKey) : (existing.litellmApiKey ?? ''),
      litellmModel: settings.litellmModel,
      systemPromptTemplate: settings.systemPromptTemplate ?? ''
    }
    writeFileSync(getLlmSettingsFilePath(), JSON.stringify(toWrite, null, 2), 'utf-8')
    getMainWindow()?.webContents.send('llm:settings-changed')
  })

  // ── LLM Test ─────────────────────────────────────────────────────────────────
  // Accepts plaintext settings straight from the renderer so the test always
  // uses exactly what the user sees on screen, with no file-system roundtrip.

  ipcMain.handle('llm:test', async (_e, settings: LlmSettings): Promise<void> => {
    // Step 1 — basic internet connectivity
    const googleErr = await checkUrl('https://www.google.com')
    if (googleErr) {
      throw new Error(
        `No internet connection detected: could not reach www.google.com.\n  ${googleErr}\n\n` +
        'Please check your network settings and try again.'
      )
    }

    // Step 2 — provider URL reachability
    const providerUrl = getProviderBaseUrl(settings)
    const providerErr = await checkUrl(providerUrl)
    if (providerErr) {
      throw new Error(
        'Internet is working (www.google.com is reachable).\n\n' +
        `However, the provider URL could not be reached:\n  ${providerUrl}\n  ${providerErr}\n\n` +
        'Your network or firewall may be blocking access to this address.'
      )
    }

    // Step 3 — actual LLM API call
    const result = await sendMessage({
      settings,
      systemPrompt: 'You are a test assistant.',
      systemPromptSchema: '',
      messages: [{ role: 'user', content: 'Reply with exactly: {"explanation":"ok","warnings":[]}' }],
      tools: [],
      runTool: async () => '',
      onChunk: () => {},
      onToolCall: () => {},
      onToolResult: () => {}
    })
    if (result.error) {
      throw new Error(
        'Network diagnostics passed:\n' +
        '  ✓ www.google.com is reachable\n' +
        `  ✓ ${providerUrl} is reachable\n\n` +
        `LLM API error:\n${result.error}`
      )
    }
  })

  // ── LLM List Models ───────────────────────────────────────────────────────────
  // Accepts plaintext settings straight from the renderer (no file-system roundtrip).

  ipcMain.handle('llm:list-models', async (_e, settings: LlmSettings): Promise<string[]> => {
    return listModels(settings)
  })

  // ── LLM DDL confirmation response ─────────────────────────────────────────────

  ipcMain.handle('llm:confirm-response', (_e, { conversationId, approved }: { conversationId: string; approved: boolean }): void => {
    const resolve = pendingConfirms.get(conversationId)
    if (resolve) {
      pendingConfirms.delete(conversationId)
      resolve(approved)
    }
  })

  // ── LLM editor content/selection response ─────────────────────────────────────
  // Whichever view (Query Editor or Script Editor) currently has its listener
  // registered (see onActivated/onDeactivated in QueryView.vue / ScriptsView.vue)
  // answers here in response to an 'llm:get-editor-request' push event.

  ipcMain.handle('llm:editor-response', (_e, { conversationId, response }: { conversationId: string; response: EditorContentResponse | null }): void => {
    const resolve = pendingEditorRequests.get(conversationId)
    if (resolve) {
      pendingEditorRequests.delete(conversationId)
      resolve(response)
    }
  })

  // ── LLM JavaScript cancel ──────────────────────────────────────────────────

  ipcMain.handle('llm:cancel-tool', (_e, cid: string): void => {
    const cancel = pendingToolCancels.get(cid)
    if (cancel) {
      pendingToolCancels.delete(cid)
      cancel()
    }
  })

  // ── LLM Chat ──────────────────────────────────────────────────────────────────

  ipcMain.handle(
    'llm:chat',
    async (
      _e,
      { conversationId, messages }: { conversationId: string; messages: ChatMessage[] }
    ): Promise<{ reply: string; contextTruncated: boolean }> => {
      const win = getMainWindow()
      const settings = loadDecryptedSettings()

      const model = getActiveModel(settings)

      // Build schema text for system prompt
      let schemaText = ''
      try {
        schemaText = buildDdlSchema(db.getDatabaseInfo())
      } catch {
        schemaText = '(No database open)'
      }

      // Split so the (large, DB-independent) instructions block can be kept
      // separate from the schema for Anthropic's cache_control breakpoints —
      // see the systemPromptSchema field passed to sendMessage below.
      const { instructions: systemPromptInstructions, schema: systemPromptSchema } = buildSystemPromptParts(schemaText, settings.systemPromptTemplate)
      const systemPrompt = systemPromptInstructions + systemPromptSchema

      // Save user messages to history
      const lastUserMsg = messages[messages.length - 1]
      if (lastUserMsg?.role === 'user' && db.isOpen()) {
        db.saveAiChatMessage({
          conversationId,
          role: 'user',
          content: lastUserMsg.content,
          provider: settings.provider,
          model
        })
      }

      // Track repeated SQL errors so the LLM can be told to change strategy
      // instead of retrying the same failing query indefinitely.
      const sqlErrorCounts = new Map<string, number>()

      const result = await sendMessage({
        settings,
        systemPrompt,
        systemPromptSchema,
        messages,
        tools: [EXECUTE_SQL_TOOL, EXECUTE_DDL_TOOL, EXECUTE_JAVASCRIPT_TOOL, GET_EDITOR_CONTENT_TOOL, GET_EDITOR_SELECTION_TOOL],
        runTool: async (name, args) => {
          if (name === 'execute_sql') {
            const ROW_CAP = 5000
            const rawQuery = (args.query as string) ?? ''

            // Strip trailing semicolons — better-sqlite3 treats a trailing ";"
            // as a second (empty) statement and throws "more than one statement".
            const query = rawQuery.trimEnd().replace(/;+$/, '').trimEnd()

            debugLog('llmSql', `execute_sql called — query (${query.length} chars): ${query.slice(0, 500)}`)

            // Reject multi-statement input (semicolon in the middle of the query).
            // Strip string literals first to avoid false positives.
            const queryNoStrings = query.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
            if (queryNoStrings.includes(';')) {
              debugLog('llmSql', 'Rejected: multi-statement query')
              return JSON.stringify({ error: 'Please send one SQL statement at a time — use a single SELECT query without semicolons.' })
            }

            // Safety: only SELECT (or WITH … SELECT CTE) statements allowed.
            // Strip single-line (--) and block (/* */) comments before checking
            // so that a leading comment cannot mask a write statement.
            const stripped = query
              .replace(/--[^\n]*/g, ' ')      // remove -- comments
              .replace(/\/\*[\s\S]*?\*\//g, ' ') // remove /* */ comments
              .trim()
            const firstKeyword = stripped.match(/^(\w+)/)?.[1]?.toUpperCase()
            if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
              debugLog('llmSql', `Rejected: first keyword is "${firstKeyword}", not SELECT/WITH`)
              return JSON.stringify({ error: 'Only SELECT queries are allowed.' })
            }
            // Even for WITH (CTE), reject if the query contains any write keywords
            // at the top level (i.e. outside a sub-select).  A simple keyword scan
            // is sufficient here because the LLM is told to issue SELECT-only queries.
            if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|ATTACH|DETACH|PRAGMA)\b/i.test(stripped)) {
              debugLog('llmSql', 'Rejected: write keyword detected in query')
              return JSON.stringify({ error: 'Only SELECT queries are allowed.' })
            }

            // Enforce ROW_CAP:
            //   • No LIMIT present  → append LIMIT 5000
            //   • Existing LIMIT ≤ 5000 → keep it unchanged
            //   • Existing LIMIT > 5000 → replace with 5000
            const limitMatch = query.match(/\bLIMIT\s+(\d+)/i)
            let safeQuery: string
            if (!limitMatch) {
              safeQuery = `${query} LIMIT ${ROW_CAP}`
            } else {
              const existing = parseInt(limitMatch[1], 10)
              if (existing > ROW_CAP) {
                safeQuery = query.replace(/\bLIMIT\s+\d+/i, `LIMIT ${ROW_CAP}`)
              } else {
                safeQuery = query
              }
            }

            debugLog('llmSql', `Running query (LIMIT applied: ${safeQuery !== query}): ${safeQuery.slice(0, 500)}`)
            const qr = db.executeQuery(safeQuery)

            if (qr.error) {
              const count = (sqlErrorCounts.get(qr.error) ?? 0) + 1
              sqlErrorCounts.set(qr.error, count)
              debugLog('llmSql', `Query error (occurrence #${count}): ${qr.error}`)
              if (count >= 3) {
                return JSON.stringify({
                  error: `${qr.error} — This SQL error has now occurred ${count} times. Stop retrying similar queries. Switch to a different approach or provide the user with SQL they can run manually.`
                })
              }
              return JSON.stringify({ error: qr.error })
            }

            // Exactly ROW_CAP rows → the result is most likely truncated.
            // Signal this so the assistant can fall back to providing the SQL
            // for the user to run directly instead of attempting inline analysis.
            if (qr.rows.length === ROW_CAP) {
              debugLog('llmSql', `Query hit ROW_CAP (${ROW_CAP}) — result truncated`)
              return JSON.stringify({ error: `Too many rows: the query returned ${ROW_CAP} rows, which is the maximum allowed for inline analysis. Switch to Intent B and provide SQL queries the user can run themselves to obtain the full result.` })
            }

            debugLog('llmSql', `Query OK — ${qr.columns.length} column(s), ${qr.rows.length} row(s)`)
            const rows = qr.rows.map(row => {
              const obj: Record<string, unknown> = {}
              qr.columns.forEach((col, i) => { obj[col] = row[i] })
              return obj
            })
            return JSON.stringify({ columns: qr.columns, rows })
          }

          if (name === 'execute_ddl') {
            const statement = (args.statement as string ?? '').trim()
            const reason = (args.reason as string ?? '')

            debugLog('llmDdl', `execute_ddl called — reason: "${reason}" | statement (${statement.length} chars): ${statement.slice(0, 500)}`)

            // Ask the renderer to show the confirmation modal and wait for the response.
            win?.webContents.send('llm:confirm-request', { conversationId, statement, reason })

            const approved = await new Promise<boolean>(resolve => {
              pendingConfirms.set(conversationId, resolve)
            })

            if (!approved) {
              debugLog('llmDdl', 'User declined execution')
              return JSON.stringify({ error: 'User declined to execute this statement.' })
            }

            debugLog('llmDdl', 'User approved — executing statement')
            try {
              db.executeRaw(statement)
              debugLog('llmDdl', 'Statement executed successfully')
              return JSON.stringify({ ok: true, message: 'Statement executed successfully.' })
            } catch (err) {
              debugLog('llmDdl', `Execution error: ${String(err)}`)
              return JSON.stringify({ error: String(err) })
            }
          }

          if (name === 'execute_javascript') {
            const code = (args.code as string ?? '').trim()
            const reason = (args.reason as string ?? '')

            debugLog('llmJavascript', `execute_javascript called — reason: "${reason}" | code (${code.length} chars): ${code.slice(0, 500)}`)

            // Show the confirmation modal in the renderer and wait for the user.
            win?.webContents.send('llm:confirm-request', { conversationId, statement: code, reason, type: 'javascript' })

            const approved = await new Promise<boolean>(resolve => {
              pendingConfirms.set(conversationId, resolve)
            })

            if (!approved) {
              debugLog('llmJavascript', 'User declined execution')
              return JSON.stringify({ error: 'User declined to run the script.' })
            }

            const openPath = db.getPath()
            if (!openPath) {
              debugLog('llmJavascript', 'Aborted: no database open')
              return JSON.stringify({ error: 'No database is open.' })
            }

            const logs: string[] = []
            const runId = randomUUID()

            debugLog('llmJavascript', `User approved — starting worker (runId: ${runId})`)

            // Notify the renderer that execution has actually started (distinct from
            // the confirmation step) so it can show a Cancel button.
            win?.webContents.send('llm:tool-executing', { conversationId })

            const outcome = await new Promise<{ durationMs: number; error?: string }>((resolve) => {
              const cancel = scriptRunner.runLlmScript(
                openPath,
                code,
                runId,
                (log) => {
                  const line = `[${log.level}] ${log.args.join(' ')}`
                  logs.push(line)
                  debugLog('llmJavascript', `Worker log: ${line}`)
                },
                (result) => {
                  pendingToolCancels.delete(conversationId)
                  resolve({ durationMs: result.durationMs, error: result.error })
                }
              )
              pendingToolCancels.set(conversationId, cancel)
            })

            if (outcome.error) {
              debugLog('llmJavascript', `Worker finished with error after ${outcome.durationMs}ms: ${outcome.error}`)
              return JSON.stringify({ error: outcome.error, output: logs })
            }
            debugLog('llmJavascript', `Worker finished OK in ${outcome.durationMs}ms — ${logs.length} log line(s)`)
            return JSON.stringify({ ok: true, output: logs, durationMs: outcome.durationMs })
          }

          if (name === 'get_editor_content' || name === 'get_editor_selection') {
            const kind = name === 'get_editor_content' ? 'content' : 'selection'
            debugLog('llmEditor', `${name} called`)

            win?.webContents.send('llm:get-editor-request', { conversationId, kind })

            const EDITOR_REQUEST_TIMEOUT_MS = 5000
            const response = await new Promise<EditorContentResponse | null>(resolve => {
              const timer = setTimeout(() => {
                pendingEditorRequests.delete(conversationId)
                resolve(null)
              }, EDITOR_REQUEST_TIMEOUT_MS)
              pendingEditorRequests.set(conversationId, (r) => {
                clearTimeout(timer)
                resolve(r)
              })
            })

            if (!response) {
              debugLog('llmEditor', `${name}: no editor responded in time`)
              return JSON.stringify({ error: 'No Query Editor or Script Editor is currently open, or it did not respond. Ask the user to paste the text instead.' })
            }

            debugLog('llmEditor', `${name} — source: ${response.source}, ${response.content.length} chars${response.truncated ? ' (truncated)' : ''}`)
            return JSON.stringify(response)
          }

          return JSON.stringify({ error: `Unknown tool: ${name}` })
        },
        onChunk: (text) => {
          win?.webContents.send('llm:chunk', text)
        },
        onToolCall: (name, args) => {
          if (db.isOpen()) {
            db.saveAiChatMessage({
              conversationId,
              role: 'tool_call',
              content: JSON.stringify(args),
              toolName: name,
              provider: settings.provider,
              model
            })
          }
          win?.webContents.send('llm:tool-call', { name, args })
        },
        onToolResult: (name, result) => {
          if (db.isOpen()) {
            db.saveAiChatMessage({
              conversationId,
              role: 'tool_result',
              content: result,
              toolName: name,
              provider: settings.provider,
              model
            })
          }
          win?.webContents.send('llm:tool-result', { name, result })
        }
      })

      // Save assistant reply to history only when the call succeeded.
      // Capture the new row ID so we can link the final HTTP log entry back.
      let assistantMessageId: number | null = null
      if (!result.error && db.isOpen()) {
        assistantMessageId = db.saveAiChatMessage({
          conversationId,
          role: 'assistant',
          content: result.reply,
          provider: settings.provider,
          model
        })
      }

      // Persist HTTP-level call log for every API round-trip made this turn,
      // including failed ones.  The last entry is the one that produced (or
      // attempted to produce) the assistant reply, so we link its chat_message_id.
      if (db.isOpen() && result.httpLog.length > 0) {
        result.httpLog.forEach((entry, idx) => {
          const isLast = idx === result.httpLog.length - 1
          db.saveAiLlmHttpLog({
            conversationId,
            chatMessageId: isLast ? assistantMessageId : null,
            provider: entry.provider,
            model: entry.model,
            iteration: entry.iteration,
            requestSystemPrompt: entry.requestSystemPrompt ?? null,
            requestMessagesJson: entry.requestMessagesJson,
            requestToolsJson: entry.requestToolsJson ?? null,
            responseContentJson: entry.responseContentJson ?? null,
            responseToolCallsJson: entry.responseToolCallsJson ?? null,
            durationMs: entry.durationMs,
            httpStatus: entry.httpStatus ?? null,
            error: entry.error ?? null
          })
        })
      }

      // Re-throw so the renderer still sees the error in the UI.
      if (result.error) {
        throw new Error(result.error)
      }

      return { reply: result.reply, contextTruncated: result.contextTruncated }
    }
  )
}
