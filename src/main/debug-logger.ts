/**
 * In-process debug logger for sf-sqlite.
 *
 * Enabled flags gate logging so there is zero overhead when disabled.
 * Log lines are kept in a ring buffer (MAX_ENTRIES) and forwarded to
 * the renderer window via IPC so they are visible in the Diagnostics panel
 * even in packaged builds where the DevTools console is not accessible.
 */
import type { BrowserWindow } from 'electron'
import type { DebugFlags } from '../shared/types'

export type { DebugFlags }

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
