/**
 * Electron main process: application lifecycle, window, protocols, backend
 * supervision and safe shutdown (unsaved-changes handshake with renderer).
 */
import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { registerIpc } from './ipc/handlers';
import { applyCommandLineHardening, hardenSession, hardenWebContents } from './security/policy';
import { backend } from './services/backend';
import { validateDropped } from './services/fileRegistry';
import { appPaths } from './services/paths';
import { APP_ORIGIN, registerProtocolHandlers, registerSchemes } from './services/protocols';
import { getSettings } from './services/store';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

if (process.env.PDFED_USER_DATA) app.setPath('userData', process.env.PDFED_USER_DATA);
applyCommandLineHardening();
registerSchemes();
// Must match electron-builder appId (taskbar grouping, jump lists).
if (process.platform === 'win32') app.setAppUserModelId('com.offlinepdfeditor.app');

let mainWindow: BrowserWindow | null = null;
let allowClose = false;
const pendingOpen: string[] = [];

function filesFromArgv(argv: string[]): string[] {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
}

function sendOpenFiles(paths: string[]) {
  const refs = paths.map((p) => validateDropped(p)).filter(Boolean);
  if (refs.length && mainWindow) mainWindow.webContents.send('app:open-files', refs);
}

function createWindow(): BrowserWindow {
  const dark = getSettings().theme === 'dark' || (getSettings().theme === 'system' && nativeTheme.shouldUseDarkColors);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: dark ? '#1b1e23' : '#f3f4f6',
    title: 'Offline PDF Editor',
    icon: path.join(appPaths().assets, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : dark ? { color: '#1f2329', symbolColor: '#e6e6e6', height: 34 } : { color: '#f3f4f6', symbolColor: '#333333', height: 34 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  hardenWebContents(win.webContents);
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!allowClose) {
      e.preventDefault();
      win.webContents.send('app:close-requested');
    }
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  if (DEV_URL && !app.isPackaged) win.loadURL(DEV_URL);
  else win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

/** Remove stale temporary data (never touches user documents). */
function cleanupTemp(): void {
  const p = appPaths();
  fs.rmSync(p.temp, { recursive: true, force: true });
  fs.mkdirSync(p.temp, { recursive: true });
  // expire recovery sessions older than the retention period
  const days = getSettings().recoveryRetentionDays;
  try {
    for (const d of fs.readdirSync(p.sessions)) {
      const dir = path.join(p.sessions, d);
      const st = fs.statSync(dir);
      if (st.isDirectory() && Date.now() - st.mtimeMs > days * 86400_000) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* no sessions folder yet */
  }
}

const SHUTDOWN_LIMIT_MS = 6000;

/**
 * Close sessions, stop the engine (with all its child processes) and clean
 * up. Bounded in time: the app process must never linger without a window,
 * because it holds the single-instance lock and a new launch would then do
 * nothing visible.
 */
async function shutdown(): Promise<void> {
  const graceful = async () => {
    // only talk to an engine that is up; never wait for a slow start here
    if (backend.status.state === 'ready') {
      await Promise.allSettled(
        [...backend.openDocs].map((id) => backend.request('POST', `/documents/${id}/close`, { delete_session: true }, 2500)),
      );
    }
  };
  await Promise.race([graceful(), new Promise((r) => setTimeout(r, 3000))]);
  await Promise.race([backend.stop(), new Promise((r) => setTimeout(r, SHUTDOWN_LIMIT_MS - 3000))]);
  if (getSettings().cleanupTempOnExit) {
    try {
      fs.rmSync(appPaths().temp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      /* a file still in use; removed at the next start */
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let quitting = false;
  let relaunch: string[] | null = null;

  app.on('second-instance', (_e, argv) => {
    if (quitting || allowClose) {
      // the user started the app again while this instance is closing:
      // start a fresh instance as soon as this one has exited
      relaunch = argv.slice(1);
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      allowClose = false;
      mainWindow = createWindow();
      const files = filesFromArgv(argv);
      mainWindow.webContents.once('did-finish-load', () => setTimeout(() => sendOpenFiles(files), 300));
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    sendOpenFiles(filesFromArgv(argv));
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    hardenSession();
    registerProtocolHandlers();
    cleanupTemp();
    registerIpc(() => mainWindow);
    backend.on('status', (s) => mainWindow?.webContents.send('backend:status', s));
    backend.on('reattached', () => mainWindow?.webContents.send('backend:status', { ...backend.status, reattached: true }));
    backend.start().catch((err) => console.error('[backend] failed to start:', err));
    pendingOpen.push(...filesFromArgv(process.argv));
    mainWindow = createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      if (pendingOpen.length) setTimeout(() => sendOpenFiles(pendingOpen.splice(0)), 300);
    });
  });

  ipcMain.on('app:ready-to-close', (e) => {
    if (e.sender !== mainWindow?.webContents) return;
    allowClose = true;
    mainWindow?.close();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    // hard limit, whatever happens during shutdown
    const force = setTimeout(() => finish(), SHUTDOWN_LIMIT_MS + 2000);
    const finish = () => {
      clearTimeout(force);
      if (relaunch) app.relaunch({ args: relaunch.filter((a) => !a.startsWith('--')) });
      app.exit(0);
    };
    shutdown().catch((err) => console.error('[shutdown]', err)).finally(finish);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
