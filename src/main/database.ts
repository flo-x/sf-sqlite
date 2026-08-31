import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync, writeFileSync, existsSync, readFileSync, createReadStream, createWriteStream } from 'fs'
import type { WriteStream } from 'fs'
import { rename, unlink } from 'fs/promises'
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
  ScriptDraft,
  FieldDescriptor,
  SavedScript,
  SavedScriptInput,
  DatabaseWasteInfo,
  ExtractDraftSaveResult,
  WritebackDraftSaveResult
} from '../shared/types'
import { validateExtractJobInput, validateWritebackJobInput, isDuplicateExtractJobName, isDuplicateWritebackJobName } from '../shared/jobValidation'

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
  cleanupAbandonedExecTables()
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
      view_state TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_query_drafts (
      tab_key    TEXT PRIMARY KEY,
      saved_id   INTEGER,
      name       TEXT NOT NULL DEFAULT '',
      sql_text   TEXT NOT NULL DEFAULT '',
      tab_order  INTEGER NOT NULL DEFAULT 0,
      view_state TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _sf_bridge_script_drafts (
      draft_key  TEXT PRIMARY KEY,
      saved_id   INTEGER,
      name       TEXT NOT NULL DEFAULT '',
      code       TEXT NOT NULL DEFAULT '',
      view_state TEXT,
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
  if (!extractCols.includes('comment')) {
    d.exec(`ALTER TABLE _sf_bridge_extract_jobs ADD COLUMN comment TEXT`)
  }
  if (!wbCols.includes('comment')) {
    d.exec(`ALTER TABLE _sf_bridge_writeback_jobs ADD COLUMN comment TEXT`)
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
  const queryCols = (d.prepare(`PRAGMA table_info("_sf_bridge_queries")`).all() as Array<{ name: string }>).map(c => c.name)
  if (!queryCols.includes('view_state')) {
    d.exec(`ALTER TABLE _sf_bridge_queries ADD COLUMN view_state TEXT`)
  }
  const draftCols = (d.prepare(`PRAGMA table_info("_sf_bridge_query_drafts")`).all() as Array<{ name: string }>).map(c => c.name)
  if (!draftCols.includes('view_state')) {
    d.exec(`ALTER TABLE _sf_bridge_query_drafts ADD COLUMN view_state TEXT`)
  }
  // Job drafts: an auto-saved, silently-validated snapshot of a job's editable fields,
  // kept separate from the explicitly-saved columns above until the user clicks Save.
  for (const col of ['draft_json TEXT', 'draft_updated_at TEXT', 'draft_valid INTEGER', 'draft_error TEXT']) {
    const [colName] = col.split(' ')
    if (!extractCols.includes(colName)) {
      d.exec(`ALTER TABLE _sf_bridge_extract_jobs ADD COLUMN ${col}`)
    }
    if (!wbCols.includes(colName)) {
      d.exec(`ALTER TABLE _sf_bridge_writeback_jobs ADD COLUMN ${col}`)
    }
  }
}

export function getDatabaseInfo(): TableInfo[] {
  const d = getDb()
  const tables = d
    .prepare(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE '_sf_bridge_%'
       ORDER BY type, name COLLATE NOCASE`
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

    return {
      name: t.name,
      type: t.type as 'table' | 'view',
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

export function getTableRowCount(tableName: string): number {
  const d = getDb()
  const row = d.prepare(`SELECT COUNT(*) as cnt FROM ${escapeId(tableName)}`).get() as { cnt: number }
  return row.cnt
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

/**
 * Cap on the estimated in-memory size of a single fetched page (queryInit/queryPage).
 * Keeps a single page from ballooning renderer/IPC memory when rows are very wide
 * (e.g. long text/BLOB columns), independent of the row-count page size.
 * Mirrors DataGrid.vue's DEFAULT_MAX_BYTES render guard — keep both in sync.
 */
const MAX_QUERY_PAGE_BYTES = 200 * 1024 * 1024 // 200 MB

/** Same rough heuristic as DataGrid.vue's truncatedAt: 2 bytes/char (UTF-16) per cell. */
function estimateRowBytes(row: unknown[]): number {
  let total = 0
  for (const cell of row) {
    if (cell !== null && cell !== undefined) {
      total += String(cell).length * 2
    }
  }
  return total
}

/**
 * Pulls up to `pageSize` rows from `pageStmt` one at a time, stopping early if the
 * running estimated byte size exceeds MAX_QUERY_PAGE_BYTES (always keeping at least
 * one row so a single oversized row can't produce an empty page).
 */
function fetchPageWithByteCap(
  pageStmt: Database.Statement,
  pageSize: number,
  offset: number
): { rows: unknown[][]; truncatedByBytes: boolean } {
  const rows: unknown[][] = []
  let bytes = 0
  let truncatedByBytes = false
  for (const row of pageStmt.raw(true).iterate(pageSize, offset) as IterableIterator<unknown[]>) {
    const rowBytes = estimateRowBytes(row)
    if (rows.length > 0 && bytes + rowBytes > MAX_QUERY_PAGE_BYTES) {
      truncatedByBytes = true
      break
    }
    rows.push(row)
    bytes += rowBytes
  }
  return { rows, truncatedByBytes }
}

/**
 * Execute a SQL statement and return only the first page of rows plus the total row count.
 * For SELECT statements this runs two queries (COUNT + LIMIT/OFFSET) in the same synchronous
 * call so that the renderer never needs all rows at once.
 * For DML statements the result is always a single row (changes + lastInsertRowid).
 */
export function queryInit(
  sql: string,
  pageSize: number
): { columns: string[]; rows: unknown[][]; totalCount: number; durationMs: number; error?: string; truncatedByBytes?: boolean } {
  const d = getDb()
  const start = Date.now()
  try {
    const stmt = d.prepare(sql)
    if (stmt.reader) {
      const countRow = d.prepare(`SELECT COUNT(*) AS _cnt FROM (${sql}) AS _t`).get() as { _cnt: number }
      const totalCount = countRow._cnt
      const pageStmt = d.prepare(`SELECT * FROM (${sql}) LIMIT ? OFFSET ?`)
      const columns = pageStmt.columns().map((c) => c.name)
      if (pageSize <= 0) {
        return { columns, rows: [], totalCount, durationMs: Date.now() - start }
      }
      const { rows, truncatedByBytes } = fetchPageWithByteCap(pageStmt, pageSize, 0)
      return { columns, rows, totalCount, durationMs: Date.now() - start, truncatedByBytes }
    } else {
      const info = stmt.run()
      return {
        columns: ['changes', 'lastInsertRowid'],
        rows: [[info.changes, Number(info.lastInsertRowid)]],
        totalCount: 1,
        durationMs: Date.now() - start
      }
    }
  } catch (err: unknown) {
    return {
      columns: [],
      rows: [],
      totalCount: 0,
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

function csvEscapeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s
}

/**
 * Writes the full result of `sql` to `filePath` as CSV, streaming rows one at a time
 * from the SQLite cursor so the process never holds more than a small write buffer
 * (plus one row) in memory, regardless of the result-set size.
 * Writes to a temp file and renames on success so a failed/cancelled export never
 * leaves a corrupt partial CSV at the destination path.
 */
export async function streamQueryToCsv(sql: string, filePath: string): Promise<{ error?: string }> {
  const d = getDb()
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const FLUSH_THRESHOLD = 10 * 1024 * 1024 // flush to disk roughly every 10 MB of CSV text

  const writeChunk = (stream: WriteStream, chunk: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (stream.write(chunk)) {
        resolve()
      } else {
        stream.once('drain', resolve)
        stream.once('error', reject)
      }
    })

  const endStream = (stream: WriteStream): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })

  try {
    const stmt = d.prepare(sql)
    if (!stmt.reader) {
      // Non-SELECT statement: same trivial single-row shape as executeQuery().
      const info = stmt.run()
      const csv = 'changes,lastInsertRowid\n' + `${info.changes},${Number(info.lastInsertRowid)}`
      writeFileSync(tmpPath, csv, 'utf-8')
    } else {
      const columns = stmt.columns().map((c) => c.name)
      const stream = createWriteStream(tmpPath)
      // Row iteration below is mostly synchronous (better-sqlite3 only yields to the
      // event loop at the `await writeChunk` backpressure points), so a stream error
      // firing outside of those windows wouldn't reach a `once('error', ...)` added
      // inline. Registering it up front on this wrapper promise catches it regardless
      // of when it fires, rather than crashing the process as an unhandled 'error' event.
      await new Promise<void>((resolve, reject) => {
        stream.once('error', reject)
        void (async () => {
          try {
            let buffer = columns.map(csvEscapeCell).join(',')
            for (const row of stmt.raw(true).iterate() as IterableIterator<unknown[]>) {
              buffer += '\n' + row.map(csvEscapeCell).join(',')
              if (buffer.length >= FLUSH_THRESHOLD) {
                await writeChunk(stream, buffer)
                buffer = ''
              }
            }
            if (buffer.length > 0) {
              await writeChunk(stream, buffer)
            }
            await endStream(stream)
            resolve()
          } catch (err) {
            reject(err)
          }
        })()
      })
    }
    await rename(tmpPath, filePath)
    return {}
  } catch (err: unknown) {
    await unlink(tmpPath).catch(() => {})
    return { error: err instanceof Error ? err.message : String(err) }
  }
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
  const existingId = (job as ExtractJob).id ?? null
  const validationError = validateExtractJobInput(job, existingId, listExtractJobs())
  if (validationError) throw new Error(validationError)
  const customExprs = JSON.stringify(job.customExpressions ?? [])
  const existing = existingId != null ? d.prepare('SELECT id FROM _sf_bridge_extract_jobs WHERE id = ?').get(existingId) : undefined
  if (existing) {
    // Explicit Save always promotes the current fields into the saved columns and
    // clears any draft, since the draft is now redundant with what was just saved.
    d.prepare(
      `UPDATE _sf_bridge_extract_jobs SET name=?, sf_object=?, fields=?, custom_expressions=?, where_clause=?, row_limit=?, dest_table=?, write_mode=?, soql_query=?, additional_indexes=?, comment=?, updated_at=?, draft_json=NULL, draft_updated_at=NULL, draft_valid=NULL, draft_error=NULL WHERE id=?`
    ).run(job.name, job.sfObject, JSON.stringify(job.fields), customExprs, job.whereClause ?? null, job.rowLimit ?? null, job.destTable, job.writeMode, job.soqlQuery ?? null, JSON.stringify(job.additionalIndexes ?? []), job.comment ?? null, now, existingId)
    return rowToExtractJob(getDb().prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get(existingId) as Record<string, unknown>)
  }
  const info = d.prepare(
    `INSERT INTO _sf_bridge_extract_jobs (name,sf_object,fields,custom_expressions,where_clause,row_limit,dest_table,write_mode,soql_query,additional_indexes,comment,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(job.name, job.sfObject, JSON.stringify(job.fields), customExprs, job.whereClause ?? null, job.rowLimit ?? null, job.destTable, job.writeMode, job.soqlQuery ?? null, JSON.stringify(job.additionalIndexes ?? []), job.comment ?? null, now, now)
  return rowToExtractJob(d.prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get(info.lastInsertRowid) as Record<string, unknown>)
}

/**
 * Autosaves the draft snapshot of an existing extract job's editable fields, separate
 * from its saved columns. Silently (re)computes and stores a validation stamp so
 * execution paths can cheaply check it without re-running validation every time.
 */
export function saveExtractJobDraft(jobId: number, draft: ExtractJobInput): ExtractDraftSaveResult {
  const d = getDb()
  const siblings = listExtractJobs().filter((j) => j.id !== jobId)
  const error = validateExtractJobInput(draft, jobId, siblings)
  const now = new Date().toISOString()
  d.prepare(
    `UPDATE _sf_bridge_extract_jobs SET draft_json=?, draft_updated_at=?, draft_valid=?, draft_error=? WHERE id=?`
  ).run(JSON.stringify(draft), now, error ? 0 : 1, error, jobId)
  const job = rowToExtractJob(d.prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get(jobId) as Record<string, unknown>)
  return { job, valid: !error, error }
}

/** Discards an extract job's draft, reverting the effective version back to what was last explicitly saved. */
export function clearExtractJobDraft(jobId: number): ExtractJob {
  getDb().prepare(`UPDATE _sf_bridge_extract_jobs SET draft_json=NULL, draft_updated_at=NULL, draft_valid=NULL, draft_error=NULL WHERE id=?`).run(jobId)
  return rowToExtractJob(getDb().prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get(jobId) as Record<string, unknown>)
}

export function deleteExtractJob(jobId: number): void {
  getDb().prepare('DELETE FROM _sf_bridge_extract_jobs WHERE id=?').run(jobId)
}

/** Finds the first "<name> (copy)", "<name> (copy2)", "<name> (copy3)", ... that `isDuplicate` accepts as free. */
function nextCopyName(baseName: string, isDuplicate: (candidate: string) => boolean): string {
  let candidate = `${baseName} (copy)`
  for (let n = 2; isDuplicate(candidate); n++) {
    candidate = `${baseName} (copy${n})`
  }
  return candidate
}

export function duplicateExtractJob(jobId: number): ExtractJob {
  const src = getDb().prepare('SELECT * FROM _sf_bridge_extract_jobs WHERE id=?').get(jobId) as Record<string, unknown> | undefined
  if (!src) throw new Error(`Extract job ${jobId} not found`)
  const { id: _id, created_at: _c, updated_at: _u, name, ...rest } = src
  const baseJob = rowToExtractJob({ ...rest, name: String(name) })
  const isSoql = !!baseJob.soqlQuery
  const siblings = listExtractJobs()
  const candidateName = nextCopyName(baseJob.name, (n) => isDuplicateExtractJobName(n, baseJob.sfObject, isSoql, null, siblings))
  return saveExtractJob({ ...baseJob, name: candidateName, id: undefined } as unknown as ExtractJobInput)
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

export function finishRunHistory(runHistId: number, status: 'success' | 'error' | 'cancelled', rowsLoaded: number, durationMs: number, errorMsg?: string): void {
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
  const existingId = (job as WritebackJob).id ?? null
  const validationError = validateWritebackJobInput(job, existingId, listWritebackJobs())
  if (validationError) throw new Error(validationError)
  const existing = existingId != null ? d.prepare('SELECT id FROM _sf_bridge_writeback_jobs WHERE id=?').get(existingId) : undefined
  if (existing) {
    // Explicit Save always promotes the current fields into the saved columns and
    // clears any draft, since the draft is now redundant with what was just saved.
    d.prepare(
      `UPDATE _sf_bridge_writeback_jobs SET name=?,sql_query=?,sf_object=?,operation=?,field_map=?,external_id_field=?,batch_size=?,threads=?,distribution_key=?,use_bulk_api=?,custom_headers=?,comment=?,updated_at=?,draft_json=NULL,draft_updated_at=NULL,draft_valid=NULL,draft_error=NULL WHERE id=?`
    ).run(job.name, job.sqlQuery, job.sfObject, job.operation, JSON.stringify(job.fieldMap), job.externalIdField ?? null, job.batchSize ?? null, job.threads ?? null, job.distributionKey?.length ? JSON.stringify(job.distributionKey) : null, job.useBulkApi ? 1 : 0, job.customHeaders ?? null, job.comment ?? null, now, existingId)
    return rowToWritebackJob(d.prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get(existingId) as Record<string, unknown>)
  }
  const info = d.prepare(
    `INSERT INTO _sf_bridge_writeback_jobs (name,sql_query,sf_object,operation,field_map,external_id_field,batch_size,threads,distribution_key,use_bulk_api,custom_headers,comment,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(job.name, job.sqlQuery, job.sfObject, job.operation, JSON.stringify(job.fieldMap), job.externalIdField ?? null, job.batchSize ?? null, job.threads ?? null, job.distributionKey?.length ? JSON.stringify(job.distributionKey) : null, job.useBulkApi ? 1 : 0, job.customHeaders ?? null, job.comment ?? null, now, now)
  return rowToWritebackJob(d.prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get(info.lastInsertRowid) as Record<string, unknown>)
}

/**
 * Autosaves the draft snapshot of an existing writeback job's editable fields, separate
 * from its saved columns. Silently (re)computes and stores a validation stamp so
 * execution paths can cheaply check it without re-running validation every time.
 */
export function saveWritebackJobDraft(jobId: number, draft: WritebackJobInput): WritebackDraftSaveResult {
  const d = getDb()
  const siblings = listWritebackJobs().filter((j) => j.id !== jobId)
  const error = validateWritebackJobInput(draft, jobId, siblings)
  const now = new Date().toISOString()
  d.prepare(
    `UPDATE _sf_bridge_writeback_jobs SET draft_json=?, draft_updated_at=?, draft_valid=?, draft_error=? WHERE id=?`
  ).run(JSON.stringify(draft), now, error ? 0 : 1, error, jobId)
  const job = rowToWritebackJob(d.prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get(jobId) as Record<string, unknown>)
  return { job, valid: !error, error }
}

/** Discards a writeback job's draft, reverting the effective version back to what was last explicitly saved. */
export function clearWritebackJobDraft(jobId: number): WritebackJob {
  getDb().prepare(`UPDATE _sf_bridge_writeback_jobs SET draft_json=NULL, draft_updated_at=NULL, draft_valid=NULL, draft_error=NULL WHERE id=?`).run(jobId)
  return rowToWritebackJob(getDb().prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get(jobId) as Record<string, unknown>)
}

export function deleteWritebackJob(jobId: number): void {
  getDb().prepare('DELETE FROM _sf_bridge_writeback_jobs WHERE id=?').run(jobId)
}

export function duplicateWritebackJob(jobId: number): WritebackJob {
  const src = getDb().prepare('SELECT * FROM _sf_bridge_writeback_jobs WHERE id=?').get(jobId) as Record<string, unknown> | undefined
  if (!src) throw new Error(`Writeback job ${jobId} not found`)
  const { id: _id, created_at: _c, updated_at: _u, name, ...rest } = src
  const baseJob = rowToWritebackJob({ ...rest, name: String(name) })
  const siblings = listWritebackJobs()
  const candidateName = nextCopyName(baseJob.name, (n) => isDuplicateWritebackJobName(n, baseJob.sfObject, null, siblings))
  return saveWritebackJob({ ...baseJob, name: candidateName, id: undefined } as unknown as WritebackJobInput)
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

export function finishWritebackRunHistory(runHistId: number, status: 'success' | 'partial' | 'error' | 'cancelled', rowsSent: number, rowsSucceeded: number, rowsFailed: number, durationMs: number, errorMsg?: string): void {
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

/** Return a page of rows from a SELECT query (LIMIT / OFFSET), with optional ORDER BY. */
export function queryPage(
  sql: string,
  offset: number,
  limit: number,
  orderBy?: { column: string; dir: 'asc' | 'desc' }[]
): { columns: string[]; rows: unknown[][]; truncatedByBytes?: boolean } {
  assertSelectOnly(sql)
  const d = getDb()
  try {
    const orderClause = orderBy?.length
      ? ' ORDER BY ' + orderBy.map((o) => `${escapeId(o.column)} ${o.dir === 'asc' ? 'ASC' : 'DESC'}`).join(', ')
      : ''
    const stmt = d.prepare(`SELECT * FROM (${sql})${orderClause} LIMIT ? OFFSET ?`)
    const columns = stmt.columns().map((c) => c.name)
    if (limit === 0) {
      return { columns, rows: [] }
    }
    const { rows, truncatedByBytes } = fetchPageWithByteCap(stmt, limit, offset)
    return { columns, rows, truncatedByBytes }
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

// ─── Saved Queries ────────────────────────────────────────────────────────────

export function listSavedQueries(): SavedQuery[] {
  return (getDb().prepare('SELECT * FROM _sf_bridge_queries ORDER BY tab_order, id').all() as Array<Record<string, unknown>>).map(rowToSavedQuery)
}

export function saveQuery(q: { id?: number; name: string; sqlText: string; tabOrder: number; viewState?: string | null }): SavedQuery {
  const d = getDb()
  const now = new Date().toISOString()
  if (q.id) {
    d.prepare('UPDATE _sf_bridge_queries SET name=?,sql_text=?,tab_order=?,view_state=?,updated_at=? WHERE id=?').run(q.name, q.sqlText, q.tabOrder, q.viewState ?? null, now, q.id)
    return rowToSavedQuery(d.prepare('SELECT * FROM _sf_bridge_queries WHERE id=?').get(q.id) as Record<string, unknown>)
  }
  const info = d.prepare('INSERT INTO _sf_bridge_queries (name,sql_text,tab_order,view_state,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(q.name, q.sqlText, q.tabOrder, q.viewState ?? null, now, now)
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
      `INSERT INTO _sf_bridge_query_drafts (tab_key, saved_id, name, sql_text, tab_order, view_state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tab_key) DO UPDATE SET
         saved_id   = excluded.saved_id,
         name       = excluded.name,
         sql_text   = excluded.sql_text,
         tab_order  = excluded.tab_order,
         view_state = excluded.view_state,
         updated_at = excluded.updated_at`
    )
    .run(draft.tabKey, draft.savedId ?? null, draft.name, draft.sqlText, draft.tabOrder, draft.viewState ?? null, now)
}

export function deleteQueryDraft(tabKey: string): void {
  getDb().prepare('DELETE FROM _sf_bridge_query_drafts WHERE tab_key = ?').run(tabKey)
}

export function clearQueryDrafts(): void {
  getDb().prepare('DELETE FROM _sf_bridge_query_drafts').run()
}

// ─── Script Drafts ────────────────────────────────────────────────────────────

export function listScriptDrafts(): ScriptDraft[] {
  return (
    getDb()
      .prepare('SELECT * FROM _sf_bridge_script_drafts ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>
  ).map(rowToScriptDraft)
}

export function upsertScriptDraft(draft: Omit<ScriptDraft, 'updatedAt'>): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO _sf_bridge_script_drafts (draft_key, saved_id, name, code, view_state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_key) DO UPDATE SET
         saved_id   = excluded.saved_id,
         name       = excluded.name,
         code       = excluded.code,
         view_state = excluded.view_state,
         updated_at = excluded.updated_at`
    )
    .run(draft.draftKey, draft.savedId ?? null, draft.name, draft.code, draft.viewState ?? null, now)
}

export function deleteScriptDraft(draftKey: string): void {
  getDb().prepare('DELETE FROM _sf_bridge_script_drafts WHERE draft_key = ?').run(draftKey)
}

function rowToScriptDraft(r: Record<string, unknown>): ScriptDraft {
  return {
    draftKey: r.draft_key as string,
    savedId: r.saved_id != null ? Number(r.saved_id) : null,
    name: r.name as string,
    code: r.code as string,
    viewState: (r.view_state as string | null) ?? null,
    updatedAt: r.updated_at as string
  }
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function rowToExtractJob(r: Record<string, unknown>): ExtractJob {
  const saved: ExtractJob = {
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
    comment: (r.comment as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    hasDraft: false,
    draftValid: null,
    draftError: null
  }
  const draftJson = r.draft_json as string | null
  if (!draftJson) return saved
  const draft = JSON.parse(draftJson) as ExtractJobInput
  return {
    ...saved,
    ...draft,
    id: saved.id,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    hasDraft: true,
    draftValid: r.draft_valid == null ? null : r.draft_valid === 1,
    draftError: (r.draft_error as string | null) ?? null
  }
}

function rowToRunHistory(r: Record<string, unknown>): RunHistoryEntry {
  return {
    id: Number(r.id),
    jobId: Number(r.job_id),
    startedAt: r.started_at as string,
    finishedAt: r.finished_at as string | null,
    status: r.status as 'running' | 'success' | 'error' | 'cancelled',
    rowsLoaded: r.rows_loaded != null ? Number(r.rows_loaded) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    errorMsg: r.error_msg as string | null
  }
}

function rowToWritebackJob(r: Record<string, unknown>): WritebackJob {
  const saved: WritebackJob = {
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
    comment: (r.comment as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    hasDraft: false,
    draftValid: null,
    draftError: null
  }
  const draftJson = r.draft_json as string | null
  if (!draftJson) return saved
  const draft = JSON.parse(draftJson) as WritebackJobInput
  return {
    ...saved,
    ...draft,
    id: saved.id,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    hasDraft: true,
    draftValid: r.draft_valid == null ? null : r.draft_valid === 1,
    draftError: (r.draft_error as string | null) ?? null
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
    viewState: (r.view_state as string | null) ?? null,
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
    viewState: (r.view_state as string | null) ?? null,
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

/**
 * Stateful RFC-4180 CSV parser that processes data chunk-by-chunk.
 * Handles quoted fields that span multiple lines and `""` escape sequences
 * even across chunk boundaries.
 */
class CsvStreamParser {
  private field = ''
  private row: string[] = []
  private inQuote = false
  /** True when we just saw a `"` inside a quoted field and haven't yet seen the next char. */
  private pendingClosingQuote = false
  readonly separator: string

  onRow?: (row: string[]) => void

  constructor(separator = ',') {
    this.separator = separator
  }

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]

      if (this.pendingClosingQuote) {
        this.pendingClosingQuote = false
        if (ch === '"') {
          // "" inside a quoted field → literal double-quote character
          this.field += '"'
          continue
        }
        // Closing quote followed by something else → end of quoted field
        this.inQuote = false
        // Fall through and process ch in the unquoted branch below
      }

      if (this.inQuote) {
        if (ch === '"') {
          this.pendingClosingQuote = true
        } else {
          this.field += ch
        }
      } else {
        if (ch === '"') {
          this.inQuote = true
        } else if (ch === this.separator) {
          this.row.push(this.field)
          this.field = ''
        } else if (ch === '\r') {
          // skip bare CR
        } else if (ch === '\n') {
          this.row.push(this.field)
          this.field = ''
          if (this.row.some((f) => f !== '')) {
            this.onRow?.(this.row)
          }
          this.row = []
        } else {
          this.field += ch
        }
      }
    }
  }

  /** Call after the stream ends to emit any final partial row (no trailing newline). */
  flush(): void {
    if (this.pendingClosingQuote) {
      this.pendingClosingQuote = false
      this.inQuote = false
    }
    this.row.push(this.field)
    if (this.row.some((f) => f !== '')) {
      this.onRow?.(this.row)
    }
  }
}

/**
 * Stream a CSV file directly into a SQLite table without loading the whole
 * file into memory. Handles multi-line quoted fields and `""` escapes.
 * Rows are committed in transactions of `batchSize`.
 */
export function importCsvFileStreaming(
  filePath: string,
  tableName: string,
  ifExists: 'replace' | 'append' = 'replace',
  batchSize = 500,
  onProgress?: (rowsLoaded: number) => void,
  signal?: AbortSignal
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8' })
    const parser = new CsvStreamParser()

    const d = getDb()
    let cols: string[] | null = null
    let stmt: ReturnType<typeof d.prepare> | null = null
    let batch: string[][] = []
    let totalCount = 0
    // Guard against settling the promise more than once (end + close can both fire).
    let settled = false
    const doResolve = (v: number): void => { if (!settled) { settled = true; resolve(v) } }
    const doReject  = (e: unknown): void  => { if (!settled) { settled = true; reject(e)  } }

    if (signal) {
      signal.addEventListener('abort', () => {
        stream.destroy()  // triggers 'close', suppresses 'end'
      }, { once: true })
    }

    function flushBatch(): void {
      if (!cols || !stmt || batch.length === 0) return
      const rows = batch.splice(0)
      const c = cols
      const s = stmt
      d.transaction((items: string[][]) => {
        for (const item of items) {
          s.run(c.map((_, i) => item[i] ?? null))
        }
      })(rows)
      totalCount += rows.length
      onProgress?.(totalCount)
    }

    parser.onRow = (row) => {
      if (!cols) {
        const sanitize = (name: string): string => name.replace(/[^\w]/g, '_') || 'col'
        cols = row.map(sanitize)
        if (ifExists === 'replace') {
          d.exec(`DROP TABLE IF EXISTS ${escapeId(tableName)}`)
        }
        const colDefs = cols.map((c) => `${escapeId(c)} TEXT`).join(', ')
        d.exec(`CREATE TABLE IF NOT EXISTS ${escapeId(tableName)} (${colDefs})`)
        const placeholders = cols.map(() => '?').join(', ')
        stmt = d.prepare(`INSERT INTO ${escapeId(tableName)} (${cols.map((c) => escapeId(c)).join(', ')}) VALUES (${placeholders})`)
        return
      }
      batch.push(row)
      if (batch.length >= batchSize) {
        flushBatch()
      }
    }

    stream.on('data', (chunk: string | Buffer) => {
      try {
        parser.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))
      } catch (err) {
        stream.destroy()
        doReject(err)
      }
    })

    stream.on('end', () => {
      try {
        parser.flush()
        flushBatch()
        doResolve(totalCount)
      } catch (err) {
        doReject(err)
      }
    })

    // 'close' fires after both normal end and destroy(). Only act when aborted.
    stream.on('close', () => {
      if (signal?.aborted) {
        doReject(Object.assign(new Error('Import aborted'), { rowsCommitted: totalCount }))
      }
    })

    stream.on('error', (err: Error) => doReject(err))
  })
}

// ── Maintenance ──────────────────────────────────────────────────────────────

export function getDatabaseWasteInfo(): DatabaseWasteInfo {
  const d = getDb()
  const pageCount = (d.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
  const freelistCount = (d.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
  const pageSize = (d.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
  const wastedBytes = freelistCount * pageSize
  const wastedPct = pageCount > 0 ? (freelistCount / pageCount) * 100 : 0
  return { pageCount, freelistCount, pageSize, wastedBytes, wastedPct }
}

export function vacuumDatabase(): void {
  getDb().exec('VACUUM')
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

/**
 * Create an index on a single column, used by the DB Browser's "+" button.
 * Unlike ensureColumnIndexes (which uses CREATE INDEX IF NOT EXISTS and silently
 * no-ops on a name collision), this surfaces the real underlying error — e.g. a
 * name collision with an existing index, or a SQLite error such as trying to
 * index a view — so the UI can show it to the user.
 */
export function createColumnIndex(tableName: string, columnName: string): void {
  const d = getDb()
  if (columnHasIndex(tableName, columnName)) return

  const safeName = `idx_${tableName}_${columnName}`.replace(/[^a-zA-Z0-9_]/g, '_')
  const existing = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`)
    .get(safeName) as { name: string } | undefined
  if (existing) {
    throw new Error(
      `Cannot create index: an index named "${safeName}" already exists (on a different column). Rename or drop it, then try again.`
    )
  }

  d.exec(`CREATE INDEX ${escapeId(safeName)} ON ${escapeId(tableName)} (${escapeId(columnName)})`)
}

export function dropIndex(indexName: string): void {
  getDb().exec(`DROP INDEX IF EXISTS ${escapeId(indexName)}`)
}

// ─── Index snapshot / restore ─────────────────────────────────────────────────

export interface IndexSnapshot {
  name: string
  unique: boolean
  columns: string[]
}

/**
 * Capture all user-created indexes (origin = 'c') on a table so they can be
 * recreated after the table is dropped and rebuilt. Returns an empty array if
 * the table does not exist.
 */
export function snapshotTableIndexes(tableName: string): IndexSnapshot[] {
  const d = getDb()
  const list = d.prepare(`PRAGMA index_list(${escapeId(tableName)})`).all() as {
    name: string
    unique: number
    origin: string
  }[]
  return list
    .filter((idx) => idx.origin === 'c')
    .map((idx) => {
      const cols = d
        .prepare(`PRAGMA index_info(${escapeId(idx.name)})`)
        .all() as { seqno: number; name: string }[]
      return {
        name: idx.name,
        unique: idx.unique === 1,
        columns: cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name)
      }
    })
}

/**
 * Recreate a set of index snapshots on a (possibly rebuilt) table.
 * Each index is attempted independently; errors are swallowed so that indexes
 * whose columns no longer exist in the new schema are silently skipped.
 */
export function restoreTableIndexes(tableName: string, snapshots: IndexSnapshot[]): void {
  const d = getDb()
  for (const snap of snapshots) {
    try {
      const unique = snap.unique ? 'UNIQUE ' : ''
      const safeName = `idx_${tableName}_${snap.columns.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_')
      const cols = snap.columns.map((c) => escapeId(c)).join(', ')
      d.exec(`CREATE ${unique}INDEX IF NOT EXISTS ${escapeId(safeName)} ON ${escapeId(tableName)} (${cols})`)
    } catch {
      /* column no longer exists or other schema mismatch — skip silently */
    }
  }
}

/**
 * Save a query result into a new (or replaced) SQLite table.
 *
 * When `sql` is provided the table is created directly via
 * `CREATE TABLE … AS <sql>`, which avoids loading all rows into JS.
 *
 * When `columns` + `rows` are provided (e.g. a SOQL result that is already
 * fully loaded in memory) the table is created with TEXT columns and rows
 * are inserted in a single transaction.
 *
 * In both cases, if `replace` is true and the table already exists its
 * indexes are snapshotted before the drop and recreated afterwards
 * (skipping any index whose columns no longer exist in the new schema).
 *
 * Returns the number of rows in the resulting table.
 */
export function saveQueryResultToTable(options: {
  tableName: string
  replace: boolean
  sql?: string
  columns?: string[]
  rows?: unknown[][]
}): number {
  const { tableName, replace, sql, columns, rows } = options
  const d = getDb()
  const priorIndexes = replace ? snapshotTableIndexes(tableName) : []
  if (replace) {
    d.exec(`DROP TABLE IF EXISTS ${escapeId(tableName)}`)
  }
  if (sql) {
    d.exec(`CREATE TABLE ${escapeId(tableName)} AS ${sql}`)
  } else if (columns && rows) {
    const sanitize = (name: string): string => name.replace(/[^\w]/g, '_') || 'col'
    const safeCols = columns.map(sanitize)
    const colDefs = safeCols.map((c) => `${escapeId(c)} TEXT`).join(', ')
    d.exec(`CREATE TABLE ${escapeId(tableName)} (${colDefs})`)
    const placeholders = safeCols.map(() => '?').join(', ')
    const stmt = d.prepare(
      `INSERT INTO ${escapeId(tableName)} (${safeCols.map((c) => escapeId(c)).join(', ')}) VALUES (${placeholders})`
    )
    const insertAll = d.transaction((dataRows: unknown[][]) => {
      for (const row of dataRows) {
        stmt.run(safeCols.map((_, i) => row[i] ?? null))
      }
    })
    insertAll(rows)
  } else {
    throw new Error('saveQueryResultToTable: provide either sql or columns+rows')
  }
  if (priorIndexes.length > 0) {
    restoreTableIndexes(tableName, priorIndexes)
  }
  const countRow = d.prepare(`SELECT COUNT(*) as cnt FROM ${escapeId(tableName)}`).get() as { cnt: number }
  return countRow.cnt
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

// ─── Writeback Exec Table ─────────────────────────────────────────────────────
//
// Each REST API writeback run gets a temporary SQLite table that holds all source
// rows plus three metadata columns:
//   __sf_id          — Salesforce record ID returned after a successful write
//   __status         — 'queued' | 'success' | 'error'
//   __error          — full error message (for 'error' rows)
//   __error_prefix   — server-side error prefix (for efficient filtering)
//
// The table lives in the TEMP schema (per-connection, auto-dropped on DB close).
// It is also explicitly dropped when the run state is evicted by addWbRunState.

function wbExecTn(runId: string): string {
  return `"_wb_exec_${runId.replace(/-/g, '_')}"`
}

/**
 * Drop any _wb_exec_* tables left over from a previous session (e.g. after a
 * crash before cleanup could run).  Called automatically when a database is
 * opened.
 */
function cleanupAbandonedExecTables(): void {
  const d = getDb()
  const tables = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_wb_exec_%'")
    .all() as { name: string }[]
  for (const { name } of tables) {
    try { d.exec(`DROP TABLE IF EXISTS ${escapeId(name)}`) } catch { /* ignore */ }
  }
}

/**
 * Build the SQL that the DB worker executes to create the exec table for an
 * initial writeback run.  The single CREATE TABLE AS SELECT statement runs
 * entirely in the worker thread so the main event loop stays responsive.
 *
 * Column order in the resulting table:
 *   __sf_id TEXT, __status TEXT, __error TEXT, __error_prefix TEXT,
 *   <all columns from userSql>
 */
export function wbExecBuildCreateSql(runId: string, userSql: string): string {
  const tn = wbExecTn(runId)
  return (
    `CREATE TABLE ${tn} AS ` +
    `SELECT '000000000000000000' AS __sf_id, 'queued' AS __status, ` +
    `NULL AS __error, NULL AS __error_prefix, * FROM (${userSql})`
  )
}

/**
 * Create the exec table for a Bulk API job that has failed rows.
 * The table holds one row per Salesforce-reported failure, with columns
 * matching the Salesforce field names that were uploaded.
 *
 * Column order: __sf_id TEXT, __status TEXT, __error TEXT, __error_prefix TEXT,
 *               <sfColumn1> TEXT, <sfColumn2> TEXT, …
 */
export function wbExecCreateBulkFailed(runId: string, sfColumns: string[]): void {
  const tn = wbExecTn(runId)
  const colDefs = sfColumns.map((c) => `${escapeId(c)} TEXT`).join(', ')
  getDb().exec(
    `CREATE TABLE ${tn} (__sf_id TEXT, __status TEXT, __error TEXT, __error_prefix TEXT` +
    (colDefs ? `, ${colDefs}` : '') +
    `)`
  )
}

/**
 * Insert failed rows returned by the Bulk API into the exec table.
 * Each entry must include the per-column values (in the same order as sfColumns)
 * plus the pre-computed error message and its prefix.
 */
export function wbExecInsertBulkFailed(
  runId: string,
  sfColumns: string[],
  entries: Array<{ message: string; errorPrefix: string; row: unknown[] }>
): void {
  if (!entries.length) return
  const tn = wbExecTn(runId)
  const d = getDb()
  const colNames = ['__sf_id', '__status', '__error', '__error_prefix', ...sfColumns.map(escapeId)].join(', ')
  const placeholders = Array(4 + sfColumns.length).fill('?').join(', ')
  const stmt = d.prepare(`INSERT INTO ${tn} (${colNames}) VALUES (${placeholders})`)
  const insertAll = d.transaction(
    (rows: Array<{ message: string; errorPrefix: string; row: unknown[] }>) => {
      for (const entry of rows) {
        stmt.run('', 'error', entry.message, entry.errorPrefix, ...entry.row)
      }
    }
  )
  insertAll(entries)
}

/**
 * Build the SQL that the DB worker executes to create the exec table for a
 * retry run.  Copies only the user-data columns from error rows of the
 * previous run, resetting the metadata columns to their initial values.
 */
export function wbExecBuildRetrySql(newRunId: string, prevRunId: string, columns: string[]): string {
  const tnNew = wbExecTn(newRunId)
  const tnPrev = wbExecTn(prevRunId)
  const colList = columns.map(escapeId).join(', ')
  return (
    `CREATE TABLE ${tnNew} AS ` +
    `SELECT '000000000000000000' AS __sf_id, 'queued' AS __status, ` +
    `NULL AS __error, NULL AS __error_prefix, ${colList} ` +
    `FROM ${tnPrev} WHERE __status = 'error'`
  )
}

/** Total number of rows in the exec table. */
export function wbExecGetRowCount(runId: string): number {
  const tn = wbExecTn(runId)
  return Number(getDb().prepare(`SELECT COUNT(*) FROM ${tn}`).pluck().get() ?? 0)
}

/** Aggregated status counts. */
export function wbExecGetStatusCounts(runId: string): { queued: number; succeeded: number; failed: number } {
  const tn = wbExecTn(runId)
  const rows = getDb()
    .prepare(`SELECT __status, COUNT(*) AS cnt FROM ${tn} GROUP BY __status`)
    .all() as { __status: string; cnt: number }[]
  const map = new Map(rows.map((r) => [r.__status, Number(r.cnt)]))
  return {
    queued: map.get('queued') ?? 0,
    succeeded: map.get('success') ?? 0,
    failed: map.get('error') ?? 0
  }
}

/**
 * Read a batch of raw source-column values for sending to Salesforce.
 * Returns rows ordered by rowid with their rowid included for later UPDATE.
 */
export function wbExecReadBatch(
  runId: string,
  columns: string[],
  offset: number,
  limit: number
): { rowid: number; row: unknown[] }[] {
  const tn = wbExecTn(runId)
  const colList = columns.map(escapeId).join(', ')
  const stmt = getDb()
    .prepare(`SELECT rowid, ${colList} FROM ${tn} ORDER BY rowid LIMIT ? OFFSET ?`)
    .raw(true)
  return (stmt.all(limit, offset) as unknown[][]).map((r) => ({
    rowid: Number(r[0]),
    row: r.slice(1)
  }))
}

export interface WbExecBatchUpdate {
  rowid: number
  sfId: string | null
  status: 'success' | 'error'
  error: string | null
  errorPrefix: string | null
}

/** Write results for one batch back to the exec table in a single transaction. */
export function wbExecUpdateBatch(runId: string, updates: WbExecBatchUpdate[]): void {
  if (!updates.length) return
  const tn = wbExecTn(runId)
  const stmt = getDb().prepare(
    `UPDATE ${tn} SET __sf_id = ?, __status = ?, __error = ?, __error_prefix = ? WHERE rowid = ?`
  )
  const run = getDb().transaction(() => {
    for (const u of updates) {
      stmt.run(u.sfId, u.status, u.error, u.errorPrefix, u.rowid)
    }
  })
  run()
}

export interface WbExecPageFilter {
  /** Subset of statuses to include. Omit (or pass all three) to include everything. */
  statuses?: ('success' | 'error' | 'queued')[]
  /** When set, further restrict errors to rows whose __error_prefix matches. */
  errorPrefix?: string
}

/**
 * Fetch one page of rows for the DataGrid.
 * Returned column list: ['__rowid', ...userColumns, '__sf_id', '__status', '__error']
 * Row layout: row[0] = rowid (1-based source row number), row[row.length-3] = __sf_id,
 *             row[row.length-2] = __status, row[row.length-1] = __error.
 * Data values are row.slice(1, row.length - 3).
 */
export function wbExecGetPage(
  runId: string,
  columns: string[],
  offset: number,
  limit: number,
  filter?: WbExecPageFilter
): { columns: string[]; rows: unknown[][] } {
  const tn = wbExecTn(runId)
  const colList = ['rowid', ...columns.map(escapeId), '__sf_id', '__status', '__error'].join(', ')
  const { where, params } = buildWbExecWhere(filter)
  const sql = `SELECT ${colList} FROM ${tn}${where} ORDER BY rowid LIMIT ? OFFSET ?`
  const rows = getDb()
    .prepare(sql)
    .raw(true)
    .all(...params, limit, offset) as unknown[][]
  return { columns: ['__rowid', ...columns, '__sf_id', '__status', '__error'], rows }
}

/** Count rows matching a filter (used for pagination totals). */
export function wbExecGetPageCount(runId: string, filter?: WbExecPageFilter): number {
  const tn = wbExecTn(runId)
  const { where, params } = buildWbExecWhere(filter)
  const sql = `SELECT COUNT(*) FROM ${tn}${where}`
  return Number(getDb().prepare(sql).pluck().get(...params) ?? 0)
}

function buildWbExecWhere(filter?: WbExecPageFilter): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter?.statuses !== undefined) {
    if (filter.statuses.length === 0) {
      conditions.push('1 = 0')
    } else {
      const placeholders = filter.statuses.map(() => '?').join(', ')
      conditions.push(`__status IN (${placeholders})`)
      params.push(...filter.statuses)
      if (filter.errorPrefix && filter.statuses.includes('error')) {
        conditions.push(`__error_prefix = ?`)
        params.push(filter.errorPrefix)
      }
    }
  } else if (filter?.errorPrefix) {
    conditions.push(`__status = 'error' AND __error_prefix = ?`)
    params.push(filter.errorPrefix)
  }
  return {
    where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

/** Drop the exec table (called during run-state eviction). Silently ignored if not found. */
export function wbExecDropTable(runId: string): void {
  try {
    getDb().exec(`DROP TABLE IF EXISTS ${wbExecTn(runId)}`)
  } catch {
    // Ignore errors (DB might be closed)
  }
}
