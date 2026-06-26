import { app, shell, BrowserWindow, dialog, session } from 'electron'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc-handlers'
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

  if (shellPathError) {
    // Wait for the window to be visible before showing the dialog
    const win = BrowserWindow.getAllWindows()[0]
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
