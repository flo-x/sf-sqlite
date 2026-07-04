import { app, shell, BrowserWindow, dialog, session, ipcMain } from 'electron'
import { join } from 'path'
import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerIpcHandlers } from './ipc-handlers'
import {
  applyExtraCaCert,
  setShellCaCertPath,
  disablePatch,
  isPatchDisabled,
  getActiveCaCertPath
} from './tls-patch'
import {
  setDebugWindow,
  getDebugFlags,
  setDebugFlags,
  getDebugLogs,
  clearDebugLogs
} from './debug-logger'
import * as db from './database'

// ── Apply TLS patch early ──────────────────────────────────────────────────────
// Only the explicit user config (sf-settings.json) is available at this point.
// The shell-captured NODE_EXTRA_CA_CERTS is applied later by initShellEnvironment.
;(function initTlsPatch(): void {
  try {
    const sfSettingsPath = join(app.getPath('userData'), 'sf-settings.json')
    const sfSettings = JSON.parse(readFileSync(sfSettingsPath, 'utf-8')) as {
      extraCaCertPath?: string
      disableCaCertPatch?: boolean
    }
    if (sfSettings.disableCaCertPatch) {
      disablePatch()
      return
    }
    if (sfSettings.extraCaCertPath) {
      applyExtraCaCert(sfSettings.extraCaCertPath)
    }
  } catch {
    // sf-settings.json doesn't exist yet — shell cert will be applied async below.
  }
})()

// ── Async shell environment init ───────────────────────────────────────────────
// Runs after the window is shown so it never blocks startup.  Uses execFile
// (async) with a generous timeout to handle heavy shell configs (nvm, conda…).
function initShellEnvironment(win: BrowserWindow): void {
  if (process.platform === 'win32') {
    return
  }

  const userShell = process.env.SHELL || '/bin/zsh'
  const TIMEOUT_MS = 10_000

  // ── PATH ────────────────────────────────────────────────────────────────────
  // -l  = login shell (sources ~/.zprofile / ~/.bash_profile / ~/.profile)
  // execFile (not execSync) spawns the binary directly — the shell path is
  // never interpolated into a shell command string, preventing injection via $SHELL.
  const pathArgs = userShell.endsWith('fish')
    ? ['-lc', 'string join : $PATH || true']
    : ['-lc', 'echo $PATH || true']

  execFile(userShell, pathArgs, { timeout: TIMEOUT_MS }, (err, stdout) => {
    if (err) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Shell PATH unavailable',
        message: "Could not read your shell's PATH",
        detail:
          `SF-SQLite was unable to spawn a login shell to discover your PATH. ` +
          `The Salesforce CLI (sf / sfdx) may not be found and SF CLI features will be unavailable.\n\n` +
          `Error: ${err.message}\n\n` +
          `To fix this, ensure your shell starts without errors and that $SHELL points to your shell binary.`,
        buttons: ['OK']
      })
      return
    }
    const shellPath = stdout.trim()
    if (shellPath) {
      process.env.PATH = shellPath
    }
  })

  // ── NODE_EXTRA_CA_CERTS ────────────────────────────────────────────────────
  execFile(
    userShell,
    ['-lc', 'printf "%s" "$NODE_EXTRA_CA_CERTS"'],
    { timeout: TIMEOUT_MS },
    (err, stdout) => {
      if (err) {
        return
      }
      const certPath = stdout.trim()
      if (certPath) {
        setShellCaCertPath(certPath)
        process.env.NODE_EXTRA_CA_CERTS = certPath
        // Apply only as fallback — sf-settings.json explicit cert takes priority.
        if (!isPatchDisabled() && getActiveCaCertPath() === null) {
          applyExtraCaCert(certPath)
        }
      }
    }
  )
}

// ── Version comparison helper ──────────────────────────────────────────────
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map(Number)
  const [la, lb, lc = 0] = parse(latest)
  const [ca, cb, cc = 0] = parse(current)
  if (la !== ca) {
    return la > ca
  }
  if (lb !== cb) {
    return lb > cb
  }
  return lc > cc
}

// ── GitHub release fetching ────────────────────────────────────────────────────
async function fetchLatestRelease(): Promise<{ tag_name: string }> {
  const https = await import('https')
  const { body, statusCode } = await new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
    const req = https.get(
      'https://api.github.com/repos/flo-x/sf-sqlite/releases/latest',
      { headers: { 'User-Agent': `sf-sqlite/${app.getVersion()}` } },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk })
        res.on('end', () => resolve({ body, statusCode: res.statusCode ?? 0 }))
      }
    )
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Request timed out')) })
  })
  const data = JSON.parse(body) as { tag_name?: string; message?: string }
  if (!data.tag_name) {
    const apiMessage = data.message ? `: ${data.message}` : ''
    throw new Error(`GitHub API returned HTTP ${statusCode}${apiMessage}`)
  }
  return data as { tag_name: string }
}

// ── macOS: version check via GitHub API (no auto-update without notarization) ──
async function checkForUpdatesMac(win: BrowserWindow): Promise<void> {
  const release = await fetchLatestRelease()
  const latestVersion = release.tag_name.replace(/^v/, '')
  if (isNewerVersion(latestVersion, app.getVersion())) {
    win.webContents.send('update:available', { version: latestVersion, manual: true })
  }
}

function setupAutoUpdater(win: BrowserWindow): void {
  // ── Debug / Diagnostics handlers ───────────────────────────────────────────
  setDebugWindow(win)
  ipcMain.handle('debug:get-flags', () => getDebugFlags())
  ipcMain.handle('debug:set-flags', (_e, f: Record<string, boolean>) => { setDebugFlags(f) })
  ipcMain.handle('debug:get-logs', () => getDebugLogs())
  ipcMain.handle('debug:clear-logs', () => { clearDebugLogs() })

  // ── Handlers available on all platforms ────────────────────────────────────
  // Version info for the About tab.
  ipcMain.handle('app:get-version-info', () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
  }))

  // On-demand GitHub release check used by the About tab (all platforms).
  // Throws on any network or parse failure so the renderer can display the
  // actual error message rather than a generic fallback.
  ipcMain.handle('app:check-for-updates', async () => {
    const release = await fetchLatestRelease()
    const latestVersion = release.tag_name.replace(/^v/, '')
    return { latestVersion, isNewer: isNewerVersion(latestVersion, app.getVersion()) }
  })

  // Opens the GitHub releases page — used by the About tab on all platforms
  // and by the macOS update banner.
  ipcMain.handle('update:open-releases-page', () =>
    shell.openExternal('https://github.com/flo-x/sf-sqlite/releases')
  )

  if (is.dev) {
    return
  }

  if (process.platform === 'darwin') {
    // macOS: without notarization we can't auto-install, so just notify the
    // user and let them download the new DMG manually from the releases page.
    setTimeout(() => checkForUpdatesMac(win).catch(() => {}), 5000)
    return
  }

  // Windows / Linux: full auto-update via electron-updater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    win.webContents.send('update:available', { version: info.version, manual: false })
  })

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('update:progress', Math.round(progress.percent))
  })

  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update:downloaded')
  })

  autoUpdater.on('error', () => {
    // Silent — updates are a best-effort background feature.
  })

  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate())
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())

  // Delay the first check so it doesn't compete with app startup I/O.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.sf-sqlite.app')

  // DevTools keyboard shortcuts (F12, Ctrl+Shift+I) are only registered in dev.
  // In production builds they would expose internals to end users.
  if (is.dev) {
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })
  }

  // Enforce Content Security Policy at the network layer, which is stronger
  // than the <meta> tag in index.html (meta tags cannot block navigation attacks).
  // Dev mode is more permissive to allow Vite HMR (unsafe-eval, ws:// connect).
  const prodCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "font-src 'self' data:"
  ].join('; ')
  const devCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws://localhost:*",
    "worker-src 'self' blob:",
    "font-src 'self' data:"
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [is.dev ? devCsp : prodCsp]
      }
    })
  })

  registerIpcHandlers()
  createWindow()

  const win = BrowserWindow.getAllWindows()[0]
  win.once('show', () => {
    initShellEnvironment(win)
    setupAutoUpdater(win)
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  db.closeDatabase()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
