import { app, shell, BrowserWindow, dialog, session, ipcMain } from 'electron'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerIpcHandlers } from './ipc-handlers'
import { applyExtraCaCert, setShellCaCertPath, disablePatch } from './tls-patch'
import * as db from './database'

// ── Fix PATH for packaged macOS/Linux apps ─────────────────────────────────────
// Packaged apps launched from Finder/Launchpad inherit a minimal PATH from
// launchd and never source the user's shell profile.  Spawn a login shell
// to capture the real PATH.  If that fails, warn the user — no silent fallback.
let shellPathError: string | null = null

;(function fixPath(): void {
  if (process.platform === 'win32') return

  const userShell = process.env.SHELL || '/bin/zsh'
  try {
    // -l  = login shell (sources ~/.zprofile / ~/.bash_profile / ~/.profile)
    // -c  = run one command and exit
    // fish uses space-separated PATH; all other common shells use colon-separated.
    // execFileSync (not execSync) spawns the binary directly — the shell path is
    // never interpolated into a shell command string, preventing injection via $SHELL.
    const shellArgs = userShell.endsWith('fish')
      ? ['-lc', 'string join : $PATH || true']
      : ['-lc', 'echo $PATH || true']

    const shellPath = execFileSync(userShell, shellArgs, {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()

    if (shellPath) {
      process.env.PATH = shellPath
    } else {
      shellPathError = `Login shell (${userShell}) returned an empty PATH.`
    }
  } catch (err) {
    shellPathError = `Could not spawn login shell (${userShell}): ${(err as Error).message}`
  }
})()

// ── Capture NODE_EXTRA_CA_CERTS from login shell ───────────────────────────────
// Same technique as fixPath above.  Non-fatal if it fails.
;(function captureShellCaCert(): void {
  if (process.platform === 'win32') return
  const userShell = process.env.SHELL || '/bin/zsh'
  try {
    const result = execFileSync(userShell, ['-lc', 'printf "%s" "$NODE_EXTRA_CA_CERTS"'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim()
    if (result) {
      setShellCaCertPath(result)
      // Also propagate into process.env so node internals that read
      // NODE_EXTRA_CA_CERTS directly also benefit.
      process.env.NODE_EXTRA_CA_CERTS = result
    }
  } catch {
    // non-fatal — if the shell fails we just have no auto-detected cert
  }
})()

// ── Apply TLS patch early ──────────────────────────────────────────────────────
// sf-settings.json (explicit user config) takes priority over the shell env.
// This runs before app.whenReady() so all LLM SDK calls inherit the patch.
;(function initTlsPatch(): void {
  const shellCert = process.env.NODE_EXTRA_CA_CERTS ?? null
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
    const certPath = sfSettings.extraCaCertPath || shellCert
    if (certPath) {
      applyExtraCaCert(certPath)
    }
  } catch {
    // sf-settings.json doesn't exist yet — try shell-captured path
    if (shellCert) {
      applyExtraCaCert(shellCert)
    }
  }
})()

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

// ── macOS: version check via GitHub API (no auto-update without notarization) ──
async function checkForUpdatesMac(win: BrowserWindow): Promise<void> {
  const https = await import('https')
  const response = await new Promise<string>((resolve, reject) => {
    const req = https.get(
      'https://api.github.com/repos/flo-x/sf-sqlite/releases/latest',
      { headers: { 'User-Agent': `sf-sqlite/${app.getVersion()}` } },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk })
        res.on('end', () => resolve(body))
      }
    )
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')) })
  })
  const release = JSON.parse(response) as { tag_name: string }
  const latestVersion = release.tag_name.replace(/^v/, '')
  if (isNewerVersion(latestVersion, app.getVersion())) {
    win.webContents.send('update:available', { version: latestVersion, manual: true })
  }
}

function setupAutoUpdater(win: BrowserWindow): void {
  if (is.dev) {
    return
  }

  if (process.platform === 'darwin') {
    // macOS: without notarization we can't auto-install, so just notify the user
    // and let them download the new DMG manually from the releases page.
    ipcMain.handle('update:open-releases-page', () =>
      shell.openExternal('https://github.com/flo-x/sf-sqlite/releases')
    )
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
  win.once('show', () => setupAutoUpdater(win))

  if (shellPathError) {
    win.once('show', () => {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Shell PATH unavailable',
        message: "Could not read your shell's PATH",
        detail:
          `SF-SQLite was unable to spawn a login shell to discover your PATH. ` +
          `The Salesforce CLI (sf / sfdx) may not be found and SF CLI features will be unavailable.\n\n` +
          `Error: ${shellPathError}\n\n` +
          `To fix this, ensure your shell starts without errors and that $SHELL points to your shell binary.`,
        buttons: ['OK']
      })
    })
  }

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
