/**
 * In-process debug logger for sf-sqlite.
 *
 * Enabled flags gate logging so there is zero overhead when disabled.
 * Log lines are kept in a ring buffer (MAX_ENTRIES) and forwarded to
 * the renderer window via IPC so they are visible in the Diagnostics panel
 * even in packaged builds where the DevTools console is not accessible.
 */
import type { BrowserWindow } from 'electron'

export interface DebugFlags {
  /** Logs every SF CLI command: resolved path, args, stdout, stderr, errors. */
  sfCliExec: boolean
  /** Logs credential extraction in connectCliOrg: token length, instanceUrl, source. */
  sfCliAuth: boolean
  /** Logs the full OAuth 2.0 flow: callback server port, auth URL, callback
   *  params, token exchange result, and jsforce identity call. */
  oauthFlow: boolean
  /** Logs LLM execute_sql tool calls: query text, row/column counts, errors. */
  llmSql: boolean
  /** Logs LLM execute_ddl tool calls: statement, approval result, execution outcome. */
  llmDdl: boolean
  /** Logs LLM execute_javascript tool calls: code length, log lines, duration, errors. */
  llmJavascript: boolean
  /** Logs LLM get_editor_content / get_editor_selection tool calls: which view
   *  answered, content length, truncation, or timeout. */
  llmEditor: boolean
  /** Logs the SQL query for SQLite→SF jobs and the SOQL query for SF→SQLite jobs
   *  at the moment the job starts. */
  jobQueries: boolean
  /** Logs every SQL statement executed during a writeback job run, including
   *  the CREATE TABLE AS SELECT sent to the DB worker, plus a summary line for
   *  each batch read and batch update applied to the exec table. */
  wbSql: boolean
}

const MAX_ENTRIES = 500

let flags: DebugFlags = {
  sfCliExec: false,
  sfCliAuth: false,
  oauthFlow: false,
  llmSql: false,
  llmDdl: false,
  llmJavascript: false,
  llmEditor: false,
  jobQueries: false,
  wbSql: false,
}
let rendererWindow: BrowserWindow | null = null

const entries: string[] = []

export function setDebugWindow(win: BrowserWindow): void {
  rendererWindow = win
}

export function getDebugFlags(): DebugFlags {
  return { ...flags }
}

export function setDebugFlags(f: Partial<DebugFlags>): void {
  flags = { ...flags, ...f }
}

export function debugLog(flag: keyof DebugFlags, message: string): void {
  if (!flags[flag]) {
    return
  }
  const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
  const line = `[${ts}] [${flag}] ${message}`
  entries.push(line)
  if (entries.length > MAX_ENTRIES) {
    entries.shift()
  }
  rendererWindow?.webContents.send('debug:log', line)
}

export function getDebugLogs(): string[] {
  return [...entries]
}

export function clearDebugLogs(): void {
  entries.length = 0
}
