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

async function shutdown(): Promise<void> {
  for (const id of [...backend.openDocs]) {
    await backend.request('POST', `/documents/${id}/close`, { delete_session: true }, 5000);
  }
  await backend.stop();
  if (getSettings().cleanupTempOnExit) {
    fs.rmSync(appPaths().temp, { recursive: true, force: true });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      sendOpenFiles(filesFromArgv(argv));
    }
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

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    shutdown().finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
