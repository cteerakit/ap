import { app, BrowserWindow, ipcMain, Menu, screen, shell, Tray } from 'electron'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { Poller, maxUsage, tooltipFor } from './poller'
import { colorForUsage, trayIcon } from './icon'
import type { ProviderResult } from './providers/types'

const POPUP_WIDTH = 380
const POPUP_MIN_HEIGHT = 80

let popup: BrowserWindow | null = null
let tray: Tray | null = null
let poller: Poller | null = null
let isQuitting = false
let blurTimer: NodeJS.Timeout | null = null

function sendSnapshot(snapshot: ProviderResult[]): void {
  popup?.webContents.send('usage:update', snapshot)
  setTimeout(() => {
    void fitPopupToContent()
  }, 50)
}

function applyTray(snapshot: ProviderResult[]): void {
  if (!tray) return
  const color = colorForUsage(maxUsage(snapshot))
  tray.setImage(trayIcon(color))
  tray.setToolTip(tooltipFor(snapshot))
}

function popupHeight(): number {
  return popup?.getContentSize()[1] ?? POPUP_MIN_HEIGHT
}

function maxPopupHeight(): number {
  const origin = popup?.getBounds() ?? { x: 0, y: 0 }
  return screen.getDisplayNearestPoint(origin).workArea.height - 16
}

function popupPosition(): { x: number; y: number } {
  const height = popupHeight()
  const trayBounds = tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x),
    y: Math.round(trayBounds.y)
  })
  const work = display.workArea
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPUP_WIDTH / 2)
  let y = Math.round(trayBounds.y - height)
  if (trayBounds.y < work.y + work.height / 2) {
    y = Math.round(trayBounds.y + trayBounds.height)
  }
  x = Math.min(Math.max(x, work.x + 8), work.x + work.width - POPUP_WIDTH - 8)
  y = Math.min(Math.max(y, work.y + 8), work.y + work.height - height - 8)
  return { x, y }
}

function contentHeightScript(): string {
  return `(() => {
    const app = document.querySelector('.app')
    if (!(app instanceof HTMLElement)) return 0
    return Math.ceil(Math.max(app.scrollHeight, app.getBoundingClientRect().height))
  })()`
}

function setPopupHeight(height: number): void {
  if (!popup || height < 1) return
  const maxH = maxPopupHeight()
  const desired = Math.round(Math.min(Math.max(height, POPUP_MIN_HEIGHT), maxH))
  const [, current] = popup.getContentSize()
  popup.setMinimumSize(POPUP_WIDTH, POPUP_MIN_HEIGHT)
  popup.setMaximumSize(POPUP_WIDTH, maxH)
  if (current !== desired) {
    popup.setContentSize(POPUP_WIDTH, desired)
    const [, contentH] = popup.getContentSize()
    if (contentH !== desired) {
      const [, windowH] = popup.getSize()
      popup.setSize(POPUP_WIDTH, desired + Math.max(0, windowH - contentH))
    }
  }
  const [w, h] = popup.getSize()
  popup.setMinimumSize(w, h)
  popup.setMaximumSize(w, h)
  if (popup.isVisible()) {
    const { x, y } = popupPosition()
    popup.setPosition(x, y, false)
  }
}

async function fitPopupToContent(): Promise<void> {
  if (!popup) return
  try {
    const height = await popup.webContents.executeJavaScript(contentHeightScript())
    if (typeof height === 'number' && height > 0) setPopupHeight(height)
  } catch {
    // Renderer may not be ready yet.
  }
}

function showPopup(): void {
  if (!popup) return
  if (blurTimer) {
    clearTimeout(blurTimer)
    blurTimer = null
  }
  void fitPopupToContent().then(() => {
    if (!popup) return
    const { x, y } = popupPosition()
    popup.setPosition(x, y, false)
    popup.show()
    popup.focus()
  })
}

function hidePopup(): void {
  popup?.hide()
}

function togglePopup(): void {
  if (popup?.isVisible()) hidePopup()
  else showPopup()
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Show', click: () => showPopup() },
    {
      label: 'Refresh',
      click: () => {
        void poller?.refresh()
      }
    },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true })
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
}

function createPopup(): BrowserWindow {
  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: 900,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setMenu(null)

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.on('blur', () => {
    blurTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isFocused()) win.hide()
    }, 150)
  })

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.on('did-finish-load', () => {
    if (poller) sendSnapshot(poller.snapshot)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showPopup())

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.cteerakit.ap')
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    poller = new Poller()

    if (process.argv.includes('--verify') || process.env.AP_VERIFY === '1') {
      const { writeFileSync } = await import('fs')
      const { join: joinPath } = await import('path')
      try {
        const snapshot = await poller.refresh()
        const text = JSON.stringify(snapshot, null, 2)
        writeFileSync(joinPath(process.cwd(), 'verify-out.json'), text)
        console.log(text)
      } catch (e) {
        writeFileSync(
          joinPath(process.cwd(), 'verify-out.json'),
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2)
        )
      }
      isQuitting = true
      app.exit(0)
      return
    }

    popup = createPopup()
    tray = new Tray(trayIcon('green'))
    tray.setToolTip('ap')
    tray.setContextMenu(buildMenu())
    tray.on('click', () => togglePopup())
    applyTray(poller.snapshot)

    poller.onChange = (snapshot) => {
      applyTray(snapshot)
      sendSnapshot(snapshot)
      tray?.setContextMenu(buildMenu())
    }

    ipcMain.handle('usage:refresh', () => poller!.refresh())
    ipcMain.handle('usage:get', () => poller!.snapshot)
    ipcMain.on('popup:height', (_e, height: number) => {
      if (typeof height === 'number' && Number.isFinite(height)) setPopupHeight(height)
    })

    poller.start()
  })

  app.on('window-all-closed', () => {
    // Stay in the tray until Quit is chosen.
  })

  app.on('before-quit', () => {
    isQuitting = true
    poller?.stop()
  })
}
