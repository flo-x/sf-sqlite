import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import type {
  TableInfo,
  TableColumn,
  TableIndex,
  QueryResult,
  ExtractJob,
  ExtractJobInput,
  RunHistoryEntry,
  WritebackJob,
  WritebackJobInput,
  WritebackRunEntry,
  SavedQuery,
  QueryDraft,
  FieldDescriptor,
  SavedScript,
  SavedScriptInput
} from '../shared/types'

let db: Database.Database | null = null
let currentPath: string | null = null

export function openDatabase(filePath: string): { path: string } {
  if (db) {
    db.close()
    db = null
  }
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  currentPath = filePath
  initMetaTables()
  return { path: filePath }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
  currentPath = null
}

export function isOpen(): boolean {
  return db !== null
}

export function getPath(): string | null {
  return currentPath
}

export function getDb(): Database.Database {
  if (!db) throw new Error('No database open')
  return db
}

/** Safely quote a SQLite identifier, escaping any embedded double-quotes. */
function escapeId(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM _sf_bridge_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO _sf_bridge_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM _sf_bridge_settings WHERE key = ?').run(key)
}

function initMetaTables(): void {
  const d = getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS _sf_bridge_extract_jobs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT NOT NULL,
      sf_object           TEXT NOT NULL,
      fields              TEXT NOT NULL,
      custom_expressions  TEXT NOT NULL DEFAULT '[]',
      where_clause        TEXT,
      row_limit           INTEGER,
      dest_table          TEXT NOT NULL,
      write_mode          TEXT NOT NULL DEFAULT 'replace',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_run_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      INTEGER NOT NULL REFERENCES _sf_bridge_extract_jobs(id) ON DELETE CASCADE,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL DEFAULT 'running',
      rows_loaded INTEGER,
      duration_ms INTEGER,
      error_msg   TEXT
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_writeback_jobs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT NOT NULL,
      sql_query          TEXT NOT NULL DEFAULT '',
      sf_object          TEXT NOT NULL DEFAULT '',
      operation          TEXT NOT NULL DEFAULT 'insert',
      field_map          TEXT NOT NULL DEFAULT '[]',
      external_id_field  TEXT,
      batch_size         INTEGER,
      threads            INTEGER,
      distribution_key   TEXT,
      use_bulk_api       INTEGER NOT NULL DEFAULT 0,
      assignment_rule    INTEGER NOT NULL DEFAULT 0,
      allow_duplicates   INTEGER NOT NULL DEFAULT 0,
      trigger_all_flows  INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_writeback_run_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id         INTEGER NOT NULL REFERENCES _sf_bridge_writeback_jobs(id) ON DELETE CASCADE,
      started_at     TEXT NOT NULL,
      finished_at    TEXT,
      status         TEXT NOT NULL DEFAULT 'running',
      rows_sent      INTEGER,
      rows_succeeded INTEGER,
      rows_failed    INTEGER,
      duration_ms    INTEGER,
      error_msg      TEXT,
      use_bulk_api   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_queries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL DEFAULT 'Untitled',
      sql_text   TEXT NOT NULL DEFAULT '',
      tab_order  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_query_drafts (
      tab_key    TEXT PRIMARY KEY,
      saved_id   INTEGER,
      name       TEXT NOT NULL DEFAULT '',
      sql_text   TEXT NOT NULL DEFAULT '',
      tab_order  INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_scripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL DEFAULT 'Untitled Script',
      language    TEXT    NOT NULL DEFAULT 'javascript',
      code        TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT    NOT NULL,
      role            TEXT    NOT NULL,
      content         TEXT    NOT NULL,
      tool_name       TEXT,
      provider        TEXT    NOT NULL DEFAULT '',
      model           TEXT    NOT NULL DEFAULT '',
      created_at      TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_llm_http_log (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id      TEXT    NOT NULL,
      -- ID of the ai_chat_messages row for the assistant reply (set only on the
      -- final iteration; NULL for intermediate tool-call round-trips).
      chat_message_id      INTEGER,
      provider             TEXT    NOT NULL,
      model                TEXT    NOT NULL,
      -- 0 = first call in this turn, 1 = call after first tool result, etc.
      iteration            INTEGER NOT NULL DEFAULT 0,
      -- The system prompt text sent to the API this iteration.
      request_system_prompt TEXT,
      -- JSON: the conversation messages array (user/assistant/tool turns, no system message).
      request_messages     TEXT    NOT NULL,
      -- JSON: the tools array sent to the API (NULL when no tools were provided).
      request_tools        TEXT,
      -- Text content returned by the model (NULL when the turn was a pure tool call).
      response_content     TEXT,
      -- JSON: tool calls returned by the model (NULL when no tool calls were made).
      response_tool_calls  TEXT,
      duration_ms          INTEGER,
      -- HTTP status code from the provider response (e.g. 400, 429); NULL on success.
      http_status          INTEGER,
      error                TEXT,
      created_at           TEXT    NOT NULL
    );
  `)
  // Migrations for existing databases
  const extractCols = (d.prepare(`PRAGMA table_info("_sf_bridge_extract_jobs")`).all() as Array<{ name: string }>).map(c => c.name)
  if (!extractCols.includes('custom_expressions')) {
    d.exec(`ALTER TABLE _sf_bridge_extract_jobs ADD COLUMN custom_expressions TEXT NOT NULL DEFAULT '[]'`)
  }
  if (!extractCols.includes('soql_query')) {
    d.exec(`ALTER TABLE _sf_bridge_extract_jobs ADD COLUMN soql_query TEXT`)
  }
  if (!extractCols.includes('additional_indexes')) {
    d.exec(`ALTER TABLE _sf_bridge_extract_jobs ADD COLUMN additional_indexes TEXT NOT NULL DEFAULT '[]'`)
  }
  const wbCols = (d.prepare(`PRAGMA table_info("_sf_bridge_writeback_jobs")`).all() as Array<{ name: string }>).map(c => c.name)
  if (!wbCols.includes('custom_headers')) {
    d.exec(`ALTER TABLE _sf_bridge_writeback_jobs ADD COLUMN custom_headers TEXT`)
  }
  if (!wbCols.includes('distribution_key')) {
    d.exec(`ALTER TABLE _sf_bridge_writeback_jobs ADD COLUMN distribution_key TEXT`)
  }
  const runHistCols = (d.prepare(`PRAGMA table_info("_sf_bridge_run_history")`).all() as Array<{ name: string }>).map(c => c.name)
  if (!runHistCols.includes('duration_ms')) {
    d.exec(`ALTER TABLE _sf_bridge_run_history ADD COLUMN duration_ms INTEGER`)
  }
  const wbRunCols = (d.prepare(`PRAGMA table_info("_sf_bridge_writeback_run_history")`).all() as Array<{ name: string }>).map(c => c.name)
  if (!wbRunCols.includes('use_bulk_api')) {
    d.exec(`ALTER TABLE _sf_bridge_writeback_run_history ADD COLUMN use_bulk_api INTEGER NOT NULL DEFAULT 0`)
  }
  if (!wbRunCols.includes('duration_ms')) {
    d.exec(`ALTER TABLE _sf_bridge_writeback_run_history ADD COLUMN duration_ms INTEGER`)
  }
  const httpLogCols = (d.prepare(`PRAGMA table_info("ai_llm_http_log")`).all() as Array<{ name: string }>).map(c => c.name)
  if (httpLogCols.length > 0 && !httpLogCols.includes('http_status')) {
    d.exec(`ALTER TABLE ai_llm_http_log ADD COLUMN http_status INTEGER`)
  }
  if (httpLogCols.length > 0 && !httpLogCols.includes('request_system_prompt')) {
    d.exec(`ALTER TABLE ai_llm_http_log ADD COLUMN request_system_prompt TEXT`)
  }
}

export function getDatabaseInfo(): TableInfo[] {
  const d = getDb()
  const tables = d
    .prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE '_sf_bridge_%'
       ORDER BY type, name`
    )
    .all() as { name: string; type: string }[]

  return tables.map((t) => {
    const columns = d.prepare(`PRAGMA table_info(${escapeId(t.name)})`).all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    const indexList = d.prepare(`PRAGMA index_list(${escapeId(t.name)})`).all() as Array<{
      name: string
      unique: number
    }>

    const indexes: TableIndex[] = indexList.map((idx) => {
      const idxInfo = d.prepare(`PRAGMA index_info(${escapeId(idx.name)})`).all() as Array<{
        name: string
      }>
      return {
        name: idx.name,
        unique: idx.unique === 1,
        columns: idxInfo.map((c) => c.name)
      }
    })

    let rowCount = 0
    if (t.type === 'table') {
      const row = d.prepare(`SELECT COUNT(*) as cnt FROM ${escapeId(t.name)}`).get() as { cnt: number }
      rowCount = row.cnt
    }

    return {
      name: t.name,
      type: t.type as 'table' | 'view',
      rowCount,
      columns: columns.map(
        (c): TableColumn => ({
          name: c.name,
          type: c.type,
          notNull: c.notnull === 1,
          defaultValue: c.dflt_value,
          primaryKey: c.pk > 0
        })
      ),
      indexes
    }
  })
}

export function executeQuery(sql: string): QueryResult {
  const d = getDb()
  const start = Date.now()
  try {
    const stmt = d.prepare(sql)
    if (stmt.reader) {
      const columns = stmt.columns().map((c) => c.name)
      const rows = stmt.raw(true).all() as unknown[][]
      const durationMs = Date.now() - start
      return { columns, rows, durationMs }
    } else {
      const info = stmt.run()
      return {
        columns: ['changes', 'lastInsertRowid'],
        rows: [[info.changes, Number(info.lastInsertRowid)]],
        durationMs: Date.now() - start
      }
    }
  } catch (err: unknown) {
    return {
      columns: [],
      rows: [],
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export function renameTable(oldName: string, newName: string): void {
  getDb().exec(`ALTER TABLE ${escapeId(oldName)} RENAME TO ${escapeId(newName)}`)
}

export function renameColumn(table: string, oldName: string, newName: string): void {
  getDb().exec(`ALTER TABLE ${escapeId(table)} RENAME COLUMN ${escapeId(oldName)} TO ${escapeId(newName)}`)
}

export function dropTable(name: string): void {
  getDb().exec(`DROP TABLE IF EXISTS ${escapeId(name)}`)
}

export function exportToCsv(columns: string[], rows: unknown[][], filePath: string): void {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }
  const header = columns.map(escape).join(',')
  const body = rows.map((r) => r.map(escape).join(',')).join('\n')
  writeFileSync(filePath, header + '\n' + body, 'utf-8')
}

export function createTableFromFields(
  tableName: string,
  fields: FieldDescriptor[],
  writeMode: 'replace' | 'append'
): void {
  const d = getDb()
  if (writeMode === 'replace') {
    d.exec(`DROP TABLE IF EXISTS ${escapeId(tableName)}`)
  }
  const sfTypeToSqlite = (f: FieldDescriptor): string => {
    if (f.type === 'boolean' || f.type === 'int') return 'INTEGER'
    if (['double', 'currency', 'percent'].includes(f.type)) {
      // scale === 0 means the field is always a whole number → INTEGER; unknown → REAL
      return f.scale === 0 ? 'INTEGER' : 'REAL'
    }
    return 'TEXT'
  }
  const cols = fields
    .map((f) => `${escapeId(f.name)} ${sfTypeToSqlite(f)}`)
    .join(', ')
  d.exec(`CREATE TABLE IF NOT EXISTS ${escapeId(tableName)} (${cols})`)
}

/** Drop the target table before a raw-SOQL replace-mode job starts. */
export function dropTableIfExists(tableName: string): void {
  getDb().exec(`DROP TABLE IF EXISTS ${escapeId(tableName)}`)
}

/**
 * Create a staging table with all TEXT columns.
 * Used by raw-SOQL jobs to buffer data while we learn column types.
 */
export function createStagingTable(stagingName: string, columns: string[]): void {
  const cols = columns.map((c) => `${escapeId(c)} TEXT`).join(', ')
  getDb().exec(`CREATE TABLE IF NOT EXISTS ${escapeId(stagingName)} (${cols})`)
}

/**
 * Promote a staging table to the final destination table.
 *
 * Replace mode: drop dest → create with inferred types → bulk copy → drop staging.
 * Append mode: create dest if missing (with inferred types), add new cols, copy, drop staging.
 *
 * SQLite stores values with their actual type regardless of column affinity, so the
 * INSERT…SELECT correctly copies numbers that were stored in the TEXT staging columns.
 */
export function promoteSoqlStagingTable(
  stagingName: string,
  destTable: string,
  columnTypes: Map<string, string>,
  writeMode: 'replace' | 'append'
): void {
  const d = getDb()
  const stagingCols = (
    d.prepare(`PRAGMA table_info(${escapeId(stagingName)})`).all() as Array<{ name: string }>
  ).map((c) => c.name)

  if (writeMode === 'replace') {
    d.exec(`DROP TABLE IF EXISTS ${escapeId(destTable)}`)
    if (stagingCols.length > 0) {
      const colDefs = stagingCols.map((c) => `${escapeId(c)} ${columnTypes.get(c) ?? 'TEXT'}`).join(', ')
      d.exec(`CREATE TABLE ${escapeId(destTable)} (${colDefs})`)
      d.exec(`INSERT INTO ${escapeId(destTable)} SELECT * FROM ${escapeId(stagingName)}`)
    }
  } else {
    const existingCols = (
      d.prepare(`PRAGMA table_info(${escapeId(destTable)})`).all() as Array<{ name: string }>
    ).map((c) => c.name)

    if (existingCols.length === 0) {
      if (stagingCols.length > 0) {
        const colDefs = stagingCols.map((c) => `${escapeId(c)} ${columnTypes.get(c) ?? 'TEXT'}`).join(', ')
        d.exec(`CREATE TABLE ${escapeId(destTable)} (${colDefs})`)
      }
    } else {
      const existingSet = new Set(existingCols)
      for (const col of stagingCols) {
        if (!existingSet.has(col)) {
          d.exec(`ALTER TABLE ${escapeId(destTable)} ADD COLUMN ${escapeId(col)} TEXT`)
        }
      }
    }
    if (stagingCols.length > 0) {
      const cols = stagingCols.map((c) => escapeId(c)).join(', ')
      d.exec(`INSERT INTO ${escapeId(destTable)} (${cols}) SELECT ${cols} FROM ${escapeId(stagingName)}`)
    }
  }

  d.exec(`DROP TABLE IF EXISTS ${escapeId(stagingName)}`)
}

function toSqliteValue(v: unknown): number | string | bigint | Buffer | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v
  if (Buffer.isBuffer(v)) return v
  return JSON.stringify(v)
}

export function ensureColumns(tableName: string, columns: string[]): void {
  const d = getDb()
  const existing = (d.prepare(`PRAGMA table_info(${escapeId(tableName)})`).all() as Array<{ name: string }>).map((c) => c.name)
  const existingSet = new Set(existing)
  for (const col of columns) {
    if (!existingSet.has(col)) {
      d.exec(`ALTER TABLE ${escapeId(tableName)} ADD COLUMN ${escapeId(col)} TEXT`)
    }
  }
}

export function insertRows(tableName: string, columns: string[], rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return
  ensureColumns(tableName, columns)
  const d = getDb()
  const cols = columns.map((c) => escapeId(c)).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  const stmt = d.prepare(`INSERT INTO ${escapeId(tableName)} (${cols}) VALUES (${placeholders})`)
  const insertMany = d.transaction((items: Record<string, unknown>[]) => {
    for (const item of items) {
      stmt.run(columns.map((c) => toSqliteValue(item[c])))
    }
  })
  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    insertMany(rows.slice(i, i + BATCH))
  }
}

// ─── Extraction Jobs ─────────────────────────────────────────────────────────

export function listExtractJobs(): ExtractJob[] {
  return (getDb().prepare('SELECT * FROM _sf_bridge_extract_jobs ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>).map(rowToExtractJob)
}

export function saveExtractJob(job: ExtractJobInput): ExtractJob {
  const d = getDb()
  const now = new Date().toISOString()
  const customExprs = JSON.stringify(job.customExpressions ?? [])
  const existing = d.prepare('SELECT id FROM _sf_bridge_extract_jobs WHERE id = ?').get((job as ExtractJob).id ?? 0)
  if (existing) {
    d.prepare(
      `UPDATE _sf_bridge_extract_jobs SET name=?, sf_object=?, fields=?, custom_expressions=?, where_clause=?, row_limit=?, dest_table=?, write_mode=?, soql_query=?, additional_indexes=?, updated_at=? WHERE id=?`
    ).run(job.name, job.sfObject, JSON.stringify(job.fields), customExprs, job.whereClause ?? null, job.rowLimit ?? null, job.destTable, job.writeMode, job.soqlQuery ?? null, JSON.stringify(job.additionalIndexes ?? []), now, (job as ExtractJob).id)
    return rowToExtractJob(getDb().prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get((job as ExtractJob).id) as Record<string, unknown>)
  }
  const info = d.prepare(
    `INSERT INTO _sf_bridge_extract_jobs (name,sf_object,fields,custom_expressions,where_clause,row_limit,dest_table,write_mode,soql_query,additional_indexes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(job.name, job.sfObject, JSON.stringify(job.fields), customExprs, job.whereClause ?? null, job.rowLimit ?? null, job.destTable, job.writeMode, job.soqlQuery ?? null, JSON.stringify(job.additionalIndexes ?? []), now, now)
  return rowToExtractJob(d.prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get(info.lastInsertRowid) as Record<string, unknown>)
}

export function deleteExtractJob(jobId: number): void {
  getDb().prepare('DELETE FROM _sf_bridge_extract_jobs WHERE id=?').run(jobId)
}

export function duplicateExtractJob(jobId: number): ExtractJob {
  const src = getDb().prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get(jobId) as Record<string, unknown> | undefined
  if (!src) throw new Error(`Extract job ${jobId} not found`)
  const { id: _id, created_at: _c, updated_at: _u, name, ...rest } = src
  return saveExtractJob({ ...rowToExtractJob({ ...rest, name: String(name) + ' (copy)' }), id: undefined } as unknown as ExtractJobInput)
}

export function getRunHistory(jobId: number): RunHistoryEntry[] {
  return (getDb().prepare('SELECT * FROM _sf_bridge_run_history WHERE job_id=? ORDER BY started_at DESC').all(jobId) as Array<Record<string, unknown>>).map(rowToRunHistory)
}

export function startRunHistory(jobId: number): number {
  const info = getDb().prepare(
    `INSERT INTO _sf_bridge_run_history (job_id,started_at,status) VALUES (?,?,?)`
  ).run(jobId, new Date().toISOString(), 'running')
  return Number(info.lastInsertRowid)
}

export function finishRunHistory(runHistId: number, status: 'success' | 'error', rowsLoaded: number, durationMs: number, errorMsg?: string): void {
  getDb().prepare(
    `UPDATE _sf_bridge_run_history SET finished_at=?, status=?, rows_loaded=?, duration_ms=?, error_msg=? WHERE id=?`
  ).run(new Date().toISOString(), status, rowsLoaded, durationMs, errorMsg ?? null, runHistId)
}

// ─── Write-back Jobs ──────────────────────────────────────────────────────────

export function listWritebackJobs(): WritebackJob[] {
  return (getDb().prepare('SELECT * FROM _sf_bridge_writeback_jobs ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>).map(rowToWritebackJob)
}

export function saveWritebackJob(job: WritebackJobInput): WritebackJob {
  const d = getDb()
  const now = new Date().toISOString()
  const existing = d.prepare('SELECT id FROM _sf_bridge_writeback_jobs WHERE id=?').get((job as WritebackJob).id ?? 0)
  if (existing) {
    d.prepare(
      `UPDATE _sf_bridge_writeback_jobs SET name=?,sql_query=?,sf_object=?,operation=?,field_map=?,external_id_field=?,batch_size=?,threads=?,distribution_key=?,use_bulk_api=?,custom_headers=?,updated_at=? WHERE id=?`
    ).run(job.name, job.sqlQuery, job.sfObject, job.operation, JSON.stringify(job.fieldMap), job.externalIdField ?? null, job.batchSize ?? null, job.threads ?? null, job.distributionKey?.length ? JSON.stringify(job.distributionKey) : null, job.useBulkApi ? 1 : 0, job.customHeaders ?? null, now, (job as WritebackJob).id)
    return rowToWritebackJob(d.prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get((job as WritebackJob).id) as Record<string, unknown>)
  }
  const info = d.prepare(
    `INSERT INTO _sf_bridge_writeback_jobs (name,sql_query,sf_object,operation,field_map,external_id_field,batch_size,threads,distribution_key,use_bulk_api,custom_headers,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(job.name, job.sqlQuery, job.sfObject, job.operation, JSON.stringify(job.fieldMap), job.externalIdField ?? null, job.batchSize ?? null, job.threads ?? null, job.distributionKey?.length ? JSON.stringify(job.distributionKey) : null, job.useBulkApi ? 1 : 0, job.customHeaders ?? null, now, now)
  return rowToWritebackJob(d.prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get(info.lastInsertRowid) as Record<string, unknown>)
}

export function deleteWritebackJob(jobId: number): void {
  getDb().prepare('DELETE FROM _sf_bridge_writeback_jobs WHERE id=?').run(jobId)
}

export function duplicateWritebackJob(jobId: number): WritebackJob {
  const src = getDb().prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get(jobId) as Record<string, unknown> | undefined
  if (!src) throw new Error(`Writeback job ${jobId} not found`)
  const { id: _id, created_at: _c, updated_at: _u, name, ...rest } = src
  return saveWritebackJob({ ...rowToWritebackJob({ ...rest, name: String(name) + ' (copy)' }), id: undefined } as unknown as WritebackJobInput)
}

export function getWritebackRunHistory(jobId: number): WritebackRunEntry[] {
  return (getDb().prepare('SELECT * FROM _sf_bridge_writeback_run_history WHERE job_id=? ORDER BY started_at DESC').all(jobId) as Array<Record<string, unknown>>).map(rowToWritebackRun)
}

export function startWritebackRunHistory(jobId: number, useBulkApi: boolean): number {
  const info = getDb().prepare(
    `INSERT INTO _sf_bridge_writeback_run_history (job_id,started_at,status,use_bulk_api) VALUES (?,?,?,?)`
  ).run(jobId, new Date().toISOString(), 'running', useBulkApi ? 1 : 0)
  return Number(info.lastInsertRowid)
}

export function finishWritebackRunHistory(runHistId: number, status: 'success' | 'partial' | 'error', rowsSent: number, rowsSucceeded: number, rowsFailed: number, durationMs: number, errorMsg?: string): void {
  getDb().prepare(
    `UPDATE _sf_bridge_writeback_run_history SET finished_at=?,status=?,rows_sent=?,rows_succeeded=?,rows_failed=?,duration_ms=?,error_msg=? WHERE id=?`
  ).run(new Date().toISOString(), status, rowsSent, rowsSucceeded, rowsFailed, durationMs, errorMsg ?? null, runHistId)
}

function assertSelectOnly(sql: string): void {
  const first = sql.trim().replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim()
  if (!/^SELECT\b/i.test(first)) {
    throw new Error('Only SELECT queries are allowed here.')
  }
}

export function previewWritebackQuery(sql: string): { columns: string[]; rows: unknown[][] } {
  assertSelectOnly(sql)
  const d = getDb()
  try {
    const stmt = d.prepare(`SELECT * FROM (${sql}) LIMIT 50`)
    const columns = stmt.columns().map((c) => c.name)
    const rows = stmt.raw(true).all() as unknown[][]
    return { columns, rows }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/** Count the rows returned by a SELECT query. */
export function queryRowCount(sql: string): number {
  assertSelectOnly(sql)
  const d = getDb()
  try {
    const result = d.prepare(`SELECT COUNT(*) AS _cnt FROM (${sql}) AS _t`).get() as { _cnt: number }
    return result._cnt
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/** Return a page of rows from a SELECT query (LIMIT / OFFSET). */
export function queryPage(
  sql: string,
  offset: number,
  limit: number
): { columns: string[]; rows: unknown[][] } {
  assertSelectOnly(sql)
  const d = getDb()
  try {
    const stmt = d.prepare(`SELECT * FROM (${sql}) LIMIT ? OFFSET ?`)
    const columns = stmt.columns().map((c) => c.name)
    if (limit === 0) {
      return { columns, rows: [] }
    }
    const rows = stmt.raw(true).all(limit, offset) as unknown[][]
    return { columns, rows }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

// ─── Saved Queries ────────────────────────────────────────────────────────────

export function listSavedQueries(): SavedQuery[] {
  return (getDb().prepare('SELECT * FROM _sf_bridge_queries ORDER BY tab_order, id').all() as Array<Record<string, unknown>>).map(rowToSavedQuery)
}

export function saveQuery(q: { id?: number; name: string; sqlText: string; tabOrder: number }): SavedQuery {
  const d = getDb()
  const now = new Date().toISOString()
  if (q.id) {
    d.prepare('UPDATE _sf_bridge_queries SET name=?,sql_text=?,tab_order=?,updated_at=? WHERE id=?').run(q.name, q.sqlText, q.tabOrder, now, q.id)
    return rowToSavedQuery(d.prepare('SELECT * FROM _sf_bridge_queries WHERE id=?').get(q.id) as Record<string, unknown>)
  }
  const info = d.prepare('INSERT INTO _sf_bridge_queries (name,sql_text,tab_order,created_at,updated_at) VALUES (?,?,?,?,?)').run(q.name, q.sqlText, q.tabOrder, now, now)
  return rowToSavedQuery(d.prepare('SELECT * FROM _sf_bridge_queries WHERE id=?').get(info.lastInsertRowid) as Record<string, unknown>)
}

export function deleteQuery(id: number): void {
  getDb().prepare('DELETE FROM _sf_bridge_queries WHERE id=?').run(id)
}

export function reorderQueries(orderedIds: number[]): void {
  const d = getDb()
  const stmt = d.prepare('UPDATE _sf_bridge_queries SET tab_order=? WHERE id=?')
  const update = d.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id))
  })
  update()
}

// ─── Query Drafts ─────────────────────────────────────────────────────────────

export function listQueryDrafts(): QueryDraft[] {
  return (
    getDb()
      .prepare('SELECT * FROM _sf_bridge_query_drafts ORDER BY tab_order, rowid')
      .all() as Array<Record<string, unknown>>
  ).map(rowToQueryDraft)
}

export function upsertQueryDraft(draft: Omit<QueryDraft, 'updatedAt'>): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO _sf_bridge_query_drafts (tab_key, saved_id, name, sql_text, tab_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tab_key) DO UPDATE SET
         saved_id   = excluded.saved_id,
         name       = excluded.name,
         sql_text   = excluded.sql_text,
         tab_order  = excluded.tab_order,
         updated_at = excluded.updated_at`
    )
    .run(draft.tabKey, draft.savedId ?? null, draft.name, draft.sqlText, draft.tabOrder, now)
}

export function deleteQueryDraft(tabKey: string): void {
  getDb().prepare('DELETE FROM _sf_bridge_query_drafts WHERE tab_key = ?').run(tabKey)
}

export function clearQueryDrafts(): void {
  getDb().prepare('DELETE FROM _sf_bridge_query_drafts').run()
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function rowToExtractJob(r: Record<string, unknown>): ExtractJob {
  return {
    id: Number(r.id),
    name: r.name as string,
    sfObject: r.sf_object as string,
    fields: JSON.parse(r.fields as string),
    customExpressions: r.custom_expressions ? JSON.parse(r.custom_expressions as string) : [],
    whereClause: r.where_clause as string | null,
    rowLimit: r.row_limit != null ? Number(r.row_limit) : null,
    destTable: r.dest_table as string,
    writeMode: r.write_mode as 'replace' | 'append',
    soqlQuery: (r.soql_query as string | null) ?? null,
    additionalIndexes: r.additional_indexes ? JSON.parse(r.additional_indexes as string) : [],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}

function rowToRunHistory(r: Record<string, unknown>): RunHistoryEntry {
  return {
    id: Number(r.id),
    jobId: Number(r.job_id),
    startedAt: r.started_at as string,
    finishedAt: r.finished_at as string | null,
    status: r.status as 'running' | 'success' | 'error',
    rowsLoaded: r.rows_loaded != null ? Number(r.rows_loaded) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    errorMsg: r.error_msg as string | null
  }
}

function rowToWritebackJob(r: Record<string, unknown>): WritebackJob {
  return {
    id: Number(r.id),
    name: r.name as string,
    sqlQuery: r.sql_query as string,
    sfObject: r.sf_object as string,
    operation: r.operation as WritebackJob['operation'],
    fieldMap: JSON.parse(r.field_map as string),
    externalIdField: r.external_id_field as string | null,
    batchSize: r.batch_size != null ? Number(r.batch_size) : null,
    threads: r.threads != null ? Number(r.threads) : null,
    distributionKey: r.distribution_key ? JSON.parse(r.distribution_key as string) as string[] : null,
    useBulkApi: r.use_bulk_api === 1,
    customHeaders: (r.custom_headers as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}

function rowToWritebackRun(r: Record<string, unknown>): WritebackRunEntry {
  return {
    id: Number(r.id),
    jobId: Number(r.job_id),
    startedAt: r.started_at as string,
    finishedAt: r.finished_at as string | null,
    status: r.status as WritebackRunEntry['status'],
    rowsSent: r.rows_sent != null ? Number(r.rows_sent) : null,
    rowsSucceeded: r.rows_succeeded != null ? Number(r.rows_succeeded) : null,
    rowsFailed: r.rows_failed != null ? Number(r.rows_failed) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    errorMsg: r.error_msg as string | null,
    useBulkApi: Boolean(r.use_bulk_api)
  }
}

function rowToSavedQuery(r: Record<string, unknown>): SavedQuery {
  return {
    id: Number(r.id),
    name: r.name as string,
    sqlText: r.sql_text as string,
    tabOrder: Number(r.tab_order),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}

function rowToQueryDraft(r: Record<string, unknown>): QueryDraft {
  return {
    tabKey: r.tab_key as string,
    savedId: r.saved_id != null ? Number(r.saved_id) : null,
    name: r.name as string,
    sqlText: r.sql_text as string,
    tabOrder: Number(r.tab_order),
    updatedAt: r.updated_at as string
  }
}

// ─── CSV Import ───────────────────────────────────────────────────────────────

/** Minimal RFC-4180-compliant CSV parser. Returns an array of rows (each row is an array of strings). */
function parseCsv(content: string, separator = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuote = false
  const n = content.length

  for (let i = 0; i < n; i++) {
    const ch = content[i]
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < n && content[i + 1] === '"') { field += '"'; i++ }
        else inQuote = false
      } else {
        field += ch
      }
    } else {
      if (ch === '"') {
        inQuote = true
      } else if (ch === separator) {
        row.push(field); field = ''
      } else if (ch === '\r') {
        // skip bare CR
      } else if (ch === '\n') {
        row.push(field); field = ''
        rows.push(row); row = []
      } else {
        field += ch
      }
    }
  }
  // flush last field/row
  row.push(field)
  if (row.some((f) => f !== '')) rows.push(row)
  return rows
}

export interface CsvPreview {
  filePath: string
  headers: string[]
  rows: string[][]
  totalLines: number
}

export function previewCsvFile(filePath: string, maxRows = 200): CsvPreview {
  const content = readFileSync(filePath, 'utf-8')
  const all = parseCsv(content)
  const headers = all[0] ?? []
  const dataRows = all.slice(1)
  return {
    filePath,
    headers,
    rows: dataRows.slice(0, maxRows),
    totalLines: dataRows.length
  }
}

/** Import CSV/TSV from raw text (e.g. clipboard paste). separator defaults to comma; use '\t' for Excel/TSV. */
export function importCsvText(csvContent: string, tableName: string, ifExists: 'replace' | 'append' = 'replace', separator = ','): number {
  return _importParsed(parseCsv(csvContent, separator), tableName, ifExists)
}

function _importParsed(all: string[][], tableName: string, ifExists: 'replace' | 'append'): number {
  if (all.length < 1) return 0
  const d = getDb()
  const headers = all[0]
  const dataRows = all.slice(1).filter((r) => r.length > 0)
  const sanitize = (name: string): string => name.replace(/[^\w]/g, '_') || 'col'
  const cols = headers.map(sanitize)
  if (ifExists === 'replace') d.exec(`DROP TABLE IF EXISTS ${escapeId(tableName)}`)
  const colDefs = cols.map((c) => `${escapeId(c)} TEXT`).join(', ')
  d.exec(`CREATE TABLE IF NOT EXISTS ${escapeId(tableName)} (${colDefs})`)
  const placeholders = cols.map(() => '?').join(', ')
  const insert = d.prepare(`INSERT INTO ${escapeId(tableName)} (${cols.map((c) => escapeId(c)).join(', ')}) VALUES (${placeholders})`)
  const insertMany = d.transaction((rows: string[][]) => {
    for (const row of rows) insert.run(cols.map((_, i) => row[i] ?? null))
  })
  insertMany(dataRows)
  return dataRows.length
}

export function importCsvFile(filePath: string, tableName: string, ifExists: 'replace' | 'append' = 'replace'): number {
  return _importParsed(parseCsv(readFileSync(filePath, 'utf-8')), tableName, ifExists)
}

// ── Scripts ──────────────────────────────────────────────────────────────────

function rowToScript(r: Record<string, unknown>): SavedScript {
  return {
    id: r.id as number,
    name: r.name as string,
    language: (r.language as string ?? 'javascript') as SavedScript['language'],
    code: r.code as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  }
}

export function listScripts(): SavedScript[] {
  return (getDb()
    .prepare('SELECT * FROM _sf_bridge_scripts ORDER BY updated_at DESC')
    .all() as Record<string, unknown>[])
    .map(rowToScript)
}

export function saveScript(script: SavedScriptInput & { id?: number }): SavedScript {
  const d = getDb()
  const now = new Date().toISOString()
  if (script.id != null) {
    d.prepare(
      'UPDATE _sf_bridge_scripts SET name=?, language=?, code=?, updated_at=? WHERE id=?'
    ).run(script.name, script.language, script.code, now, script.id)
    return rowToScript(
      d.prepare('SELECT * FROM _sf_bridge_scripts WHERE id=?').get(script.id) as Record<string, unknown>
    )
  }
  const result = d.prepare(
    'INSERT INTO _sf_bridge_scripts (name, language, code, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run(script.name, script.language, script.code, now, now)
  return rowToScript(
    d.prepare('SELECT * FROM _sf_bridge_scripts WHERE id=?').get(result.lastInsertRowid) as Record<string, unknown>
  )
}

export function deleteScript(id: number): void {
  getDb().prepare('DELETE FROM _sf_bridge_scripts WHERE id=?').run(id)
}

// ── "Update table with IDs" helpers ──────────────────────────────────────────

export function getUserTableNames(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_sf_bridge_%' ORDER BY name`
      )
      .all() as { name: string }[]
  ).map((t) => t.name)
}

export function getTableColumnNames(tableName: string): string[] {
  return (
    getDb()
      .prepare(`PRAGMA table_info(${escapeId(tableName)})`)
      .all() as { name: string }[]
  ).map((c) => c.name)
}

/** Create indexes for a list of column names that don't already have one. */
export function ensureColumnIndexes(tableName: string, columnNames: string[]): void {
  const d = getDb()
  for (const col of columnNames) {
    if (!columnHasIndex(tableName, col)) {
      const safeName = `idx_${tableName}_${col}`.replace(/[^a-zA-Z0-9_]/g, '_')
      d.exec(`CREATE INDEX IF NOT EXISTS ${escapeId(safeName)} ON ${escapeId(tableName)} (${escapeId(col)})`)
    }
  }
}

export function dropIndex(indexName: string): void {
  getDb().exec(`DROP INDEX IF EXISTS ${escapeId(indexName)}`)
}

export function columnHasIndex(tableName: string, columnName: string): boolean {
  const d = getDb()
  const indexes = d.prepare(`PRAGMA index_list(${escapeId(tableName)})`).all() as { name: string }[]
  for (const idx of indexes) {
    const cols = d.prepare(`PRAGMA index_info(${escapeId(idx.name)})`).all() as { name: string }[]
    if (cols.some((c) => c.name === columnName)) return true
  }
  return false
}

export function updateTableWithIds(
  tableName: string,
  tableKeyColumn: string,
  idColumnName: string,
  pairs: Array<{ key: unknown; id: string }>
): { updated: number; idColCreated: boolean; indexCreated: boolean } {
  const d = getDb()

  const existingCols = (d.prepare(`PRAGMA table_info(${escapeId(tableName)})`).all() as { name: string }[]).map(
    (c) => c.name
  )
  const idColCreated = !existingCols.includes(idColumnName)
  if (idColCreated) {
    d.exec(`ALTER TABLE ${escapeId(tableName)} ADD COLUMN ${escapeId(idColumnName)} TEXT`)
  }

  // Create an index on the key column if one doesn't already exist — speeds up
  // the UPDATE ... WHERE keyCol = ? when the table is large.
  const indexCreated = !columnHasIndex(tableName, tableKeyColumn)
  if (indexCreated) {
    const safeName = `idx_${tableName}_${tableKeyColumn}`.replace(/[^a-zA-Z0-9_]/g, '_')
    d.exec(`CREATE INDEX IF NOT EXISTS ${escapeId(safeName)} ON ${escapeId(tableName)} (${escapeId(tableKeyColumn)})`)
  }

  const stmt = d.prepare(`UPDATE ${escapeId(tableName)} SET ${escapeId(idColumnName)} = ? WHERE ${escapeId(tableKeyColumn)} = ?`)
  let updated = 0
  const run = d.transaction(() => {
    for (const p of pairs) {
      updated += stmt.run(p.id, p.key).changes
    }
  })
  run()
  return { updated, idColCreated, indexCreated }
}

// ── AI Chat History ───────────────────────────────────────────────────────────

export interface AiChatMessageRow {
  conversationId: string
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  content: string
  toolName?: string
  provider: string
  model: string
}

/** Inserts a chat message row and returns its new primary-key ID. */
export function saveAiChatMessage(msg: AiChatMessageRow): number {
  const result = getDb()
    .prepare(
      `INSERT INTO ai_chat_messages
        (conversation_id, role, content, tool_name, provider, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      msg.conversationId,
      msg.role,
      msg.content,
      msg.toolName ?? null,
      msg.provider,
      msg.model,
      new Date().toISOString()
    )
  return Number(result.lastInsertRowid)
}

export interface AiLlmHttpLogRow {
  conversationId: string
  chatMessageId: number | null
  provider: string
  model: string
  iteration: number
  /** The system prompt text (schema + instructions). */
  requestSystemPrompt: string | null
  /** JSON array of conversation messages (user/assistant/tool turns only, no system message). */
  requestMessagesJson: string
  requestToolsJson: string | null
  responseContentJson: string | null
  responseToolCallsJson: string | null
  durationMs: number | null
  /** HTTP status code returned by the provider (e.g. 400, 429); null on success. */
  httpStatus: number | null
  error: string | null
}

export function saveAiLlmHttpLog(row: AiLlmHttpLogRow): void {
  getDb()
    .prepare(
      `INSERT INTO ai_llm_http_log
        (conversation_id, chat_message_id, provider, model, iteration,
         request_system_prompt, request_messages, request_tools,
         response_content, response_tool_calls,
         duration_ms, http_status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.conversationId,
      row.chatMessageId ?? null,
      row.provider,
      row.model,
      row.iteration,
      row.requestSystemPrompt ?? null,
      row.requestMessagesJson,
      row.requestToolsJson ?? null,
      row.responseContentJson ?? null,
      row.responseToolCallsJson ?? null,
      row.durationMs ?? null,
      row.httpStatus ?? null,
      row.error ?? null,
      new Date().toISOString()
    )
}

/**
 * Execute any DDL or DML statement directly, without a row-count return.
 * Throws on syntax or constraint errors so the caller can report them.
 */
export function executeRaw(sql: string): void {
  getDb().prepare(sql).run()
}
