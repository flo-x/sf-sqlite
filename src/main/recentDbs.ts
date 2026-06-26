import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface RecentDatabase {
  path: string
  name: string   // basename of the file
  openedAt: string
}

const MAX_RECENT = 10

function getFilePath(): string {
  return join(app.getPath('userData'), 'recent-databases.json')
}

export function listRecentDatabases(): RecentDatabase[] {
  try {
    const p = getFilePath()
    if (!existsSync(p)) return []
    return JSON.parse(readFileSync(p, 'utf8')) as RecentDatabase[]
  } catch {
    return []
  }
}

export function addRecentDatabase(dbPath: string): void {
  const list = listRecentDatabases().filter((r) => r.path !== dbPath)
  const name = dbPath.split(/[\\/]/).pop() ?? dbPath
  list.unshift({ path: dbPath, name, openedAt: new Date().toISOString() })
  writeFileSync(getFilePath(), JSON.stringify(list.slice(0, MAX_RECENT), null, 2), 'utf8')
}

export function removeRecentDatabase(dbPath: string): void {
  const list = listRecentDatabases().filter((r) => r.path !== dbPath)
  writeFileSync(getFilePath(), JSON.stringify(list, null, 2), 'utf8')
}
