import { parentPort } from 'worker_threads'
import Database from 'better-sqlite3'

type InMessage =
  | { type: 'open'; path: string }
  | { type: 'close' }
  | { type: 'run'; id: string; sql: string }

let workerDb: Database.Database | null = null

parentPort!.on('message', (msg: InMessage) => {
  if (msg.type === 'open') {
    try {
      if (workerDb) {
        try { workerDb.close() } catch { /* ignore */ }
        workerDb = null
      }
      workerDb = new Database(msg.path)
      workerDb.pragma('journal_mode = WAL')
      parentPort!.postMessage({ type: 'opened' })
    } catch (e) {
      parentPort!.postMessage({ type: 'error', message: String(e) })
    }
  } else if (msg.type === 'close') {
    if (workerDb) {
      try { workerDb.close() } catch { /* ignore */ }
      workerDb = null
    }
    parentPort!.postMessage({ type: 'closed' })
  } else if (msg.type === 'run') {
    if (!workerDb) {
      parentPort!.postMessage({ type: 'error', id: msg.id, message: 'No database open in DB worker' })
      return
    }
    try {
      workerDb.exec(msg.sql)
      parentPort!.postMessage({ type: 'done', id: msg.id })
    } catch (e) {
      parentPort!.postMessage({ type: 'error', id: msg.id, message: String(e) })
    }
  }
})
