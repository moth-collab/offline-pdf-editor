/** IPC handlers. Every handler validates the sender frame origin first. */
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiResult, AppInfo, DialogKind, FileRef, SaveKind } from '../../shared/types';
import { backend } from '../services/backend';
import { issue, purgeExpired, resolve as resolveToken, validateDropped, IMAGE_EXT } from '../services/fileRegistry';
import { addRecent, clearRecent, getRecent, getSettings, removeRecent, setSettings } from '../services/store';
import { isAllowedUrl, openExternalSafely } from '../security/policy';
import { prepare } from './ops';
import { mtr } from '../i18n';

/**
 * Test-only automation of native dialogs. Active ONLY when running unpackaged
 * with PDFED_E2E_DIALOG_DIR set by the end-to-end test runner; never in the
 * installed application.
 */
const E2E_DIR = !app.isPackaged ? process.env.PDFED_E2E_DIALOG_DIR : undefined;
const e2eQueue = (): string[] => (process.env.PDFED_E2E_OPEN ?? '').split('|').filter(Boolean);
function e2eNextAnswer(fallback: number): number {
  const q = (process.env.PDFED_E2E_ANSWERS ?? '').split(',').filter(Boolean);
  if (!q.length) return fallback;
  process.env.PDFED_E2E_ANSWERS = q.slice(1).join(',');
  return parseInt(q[0], 10);
}

function assertSender(e: IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!isAllowedUrl(url) || url.startsWith('appdoc://')) throw new Error('Unauthorized IPC sender');
}

function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => any) {
  ipcMain.handle(channel, async (e, ...args) => {
    assertSender(e);
    return fn(e, ...args);
  });
}

const OPEN_FILTERS: Record<DialogKind, Electron.FileFilter[]> = {
  pdf: [{ name: 'PDF documents', extensions: ['pdf'] }],
  pdfs: [{ name: 'PDF documents', extensions: ['pdf'] }],
  image: [{ name: 'Images', extensions: IMAGE_EXT.map((e) => e.slice(1)) }],
  images: [{ name: 'Images', extensions: IMAGE_EXT.map((e) => e.slice(1)) }],
  pfx: [{ name: 'Digital ID (PKCS#12)', extensions: ['pfx', 'p12'] }],
  any: [{ name: 'All files', extensions: ['*'] }],
};

const SAVE_FILTERS: Record<SaveKind, Electron.FileFilter[]> = {
  pdf: [{ name: 'PDF document', extensions: ['pdf'] }],
  docx: [{ name: 'Word document', extensions: ['docx'] }],
  xlsx: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  pptx: [{ name: 'PowerPoint presentation', extensions: ['pptx'] }],
  txt: [{ name: 'Text file', extensions: ['txt'] }],
  pfx: [{ name: 'Digital ID (PKCS#12)', extensions: ['pfx'] }],
  any: [{ name: 'All files', extensions: ['*'] }],
};

const localizeFilters = (f: Electron.FileFilter[]) => f.map((x) => ({ ...x, name: mtr(x.name) }));

/** Enrich document info returned to the renderer with a save token for the original file. */
function decorateDocInfo(data: any): any {
  if (data && typeof data === 'object' && typeof data.doc_id === 'string') {
    backend.openDocs.add(data.doc_id);
    if (data.original_path && fs.existsSync(path.dirname(data.original_path))) {
      data.save_token = issue(data.original_path, 'write').token;
    }
    delete data.working_path;
  }
  return data;
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  handle('backend:invoke', async (_e, op: string, payload: unknown): Promise<ApiResult<unknown>> => {
    let call;
    try {
      call = prepare(op, payload);
    } catch (err) {
      return { ok: false, error: { code: 'invalid_request', message: String((err as Error).message ?? err) } };
    }
    const res = await backend.request(call.method, call.path, call.body, call.timeoutMs);
    if (res.ok) {
      const data: any = res.data;
      if (['doc.open', 'recovery.restore', 'doc.merge', 'doc.imagesToPdf', 'doc.save', 'doc.sign', 'doc.compare'].includes(op)) {
        if (op === 'doc.save') decorateDocInfo(data?.info);
        else decorateDocInfo(data);
      } else if (data && typeof data === 'object' && 'doc_id' in data) {
        delete data.working_path;
      }
      if (op === 'doc.open' && data?.original_path) addRecent(data.original_path);
      if (op === 'doc.save' && data?.path) addRecent(data.path);
      if (op === 'doc.sign' && data?.original_path) addRecent(data.original_path);
      if (op === 'doc.close') backend.openDocs.delete((payload as any).doc_id);
      if (op === 'recovery.discard') backend.openDocs.delete((payload as any).session_id);
    }
    return res;
  });

  handle('dialog:open', async (_e, kind: DialogKind, title?: string): Promise<FileRef[]> => {
    const win = getWindow();
    if (E2E_DIR) {
      const want = e2eQueue();
      return want.filter((p) => fs.existsSync(p)).filter((p) => (kind === 'pdf' || kind === 'pdfs' ? p.endsWith('.pdf') : kind === 'image' || kind === 'images' ? !p.endsWith('.pdf') : true)).map((p) => issue(p, 'read'));
    }
    const multi = kind === 'pdfs' || kind === 'images';
    const props: Electron.OpenDialogOptions['properties'] = ['openFile'];
    if (multi) props.push('multiSelections');
    const opts: Electron.OpenDialogOptions = { title, properties: props, filters: localizeFilters(OPEN_FILTERS[kind] ?? OPEN_FILTERS.any) };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled) return [];
    return res.filePaths.map((p) => issue(p, 'read'));
  });

  handle('dialog:save', async (_e, kind: SaveKind, suggestedName: string, title?: string): Promise<FileRef | null> => {
    const win = getWindow();
    const s = getSettings();
    if (E2E_DIR) return issue(path.join(E2E_DIR, String(suggestedName).replace(/[<>:"/\\|?*]/g, '_')), 'write');
    const base = s.defaultSaveDir && fs.existsSync(s.defaultSaveDir) ? s.defaultSaveDir : app.getPath('documents');
    const safeName = String(suggestedName || 'document').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
    const opts: Electron.SaveDialogOptions = { title, defaultPath: path.join(base, safeName), filters: localizeFilters(SAVE_FILTERS[kind] ?? SAVE_FILTERS.any) };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    let p = res.filePath;
    const ext = SAVE_FILTERS[kind]?.[0]?.extensions[0];
    if (ext && ext !== '*' && path.extname(p).toLowerCase() !== `.${ext}`) p += `.${ext}`;
    return issue(p, 'write');
  });

  handle('dialog:folder', async (_e, title?: string): Promise<FileRef | null> => {
    if (E2E_DIR) return issue(E2E_DIR, 'dir');
    const win = getWindow();
    const opts: Electron.OpenDialogOptions = { title, properties: ['openDirectory', 'createDirectory'] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    return issue(res.filePaths[0], 'dir');
  });

  handle('dialog:message', async (_e, o: any): Promise<number> => {
    if (E2E_DIR) return e2eNextAnswer(Number.isInteger(o?.defaultId) ? o.defaultId : 0);
    const win = getWindow();
    const opts: Electron.MessageBoxOptions = {
      type: ['none', 'info', 'error', 'question', 'warning'].includes(o?.type) ? o.type : 'info',
      title: String(o?.title ?? app.getName()).slice(0, 200),
      message: String(o?.message ?? '').slice(0, 2000),
      detail: o?.detail ? String(o.detail).slice(0, 4000) : undefined,
      buttons: Array.isArray(o?.buttons) ? o.buttons.slice(0, 6).map((b: unknown) => String(b).slice(0, 60)) : [mtr('OK')],
      defaultId: Number.isInteger(o?.defaultId) ? o.defaultId : 0,
      cancelId: Number.isInteger(o?.cancelId) ? o.cancelId : undefined,
      noLink: true,
    };
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return res.response;
  });

  handle('files:registerDropped', (_e, paths: unknown): FileRef[] => {
    if (!Array.isArray(paths)) return [];
    purgeExpired();
    return paths.slice(0, 500).map((p) => validateDropped(String(p))).filter((x): x is FileRef => !!x);
  });

  handle('recent:list', () =>
    getRecent().map((r) => {
      const exists = fs.existsSync(r.path);
      return { ...r, exists, token: exists ? issue(r.path, 'read').token : undefined };
    }),
  );
  handle('recent:remove', (_e, p: string) => removeRecent(String(p)));
  handle('recent:clear', () => clearRecent());

  handle('settings:get', () => getSettings());
  handle('settings:set', (_e, patch: Record<string, unknown>) => setSettings(patch));

  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userData: app.getPath('userData'),
    backend: backend.status,
    isPackaged: app.isPackaged,
    e2e: !!E2E_DIR,
  }) as AppInfo);

  handle('app:print', async () => {
    const win = getWindow();
    if (!win) return { ok: false, error: 'No window' };
    return new Promise((resolve) => {
      win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
        resolve({ ok: success, error: success ? undefined : failureReason });
      });
    });
  });

  handle('app:openExternal', async (_e, url: string) => {
    if (E2E_DIR) return false;
    const win = getWindow();
    if (getSettings().confirmExternalLinks) {
      const opts: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: [mtr('Open link'), mtr('Cancel')],
        defaultId: 1,
        cancelId: 1,
        message: mtr('Open this link in your web browser?'),
        detail: `${String(url).slice(0, 500)}\n\n${mtr('The document itself is not sent anywhere.')}`,
      };
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (res.response !== 0) return false;
    }
    return openExternalSafely(String(url));
  });

  handle('app:showSourceCode', () => {
    // packaged: resources/source/<archive>; development: the project folder itself
    const dir = app.isPackaged ? path.join(process.resourcesPath, 'source') : path.resolve(__dirname, '..');
    const archive = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('-source.zip')) : undefined;
    const target = archive ? path.join(dir, archive) : path.join(app.isPackaged ? process.resourcesPath : dir, 'LICENSE');
    if (!fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });

  handle('app:showItemInFolder', (_e, token: string) => {
    for (const mode of ['write', 'read', 'dir'] as const) {
      try {
        shell.showItemInFolder(resolveToken(token, mode));
        return;
      } catch {
        /* try next mode */
      }
    }
  });

  handle('app:setTitleBarTheme', (_e, theme: 'light' | 'dark') => {
    const win = getWindow();
    if (!win || process.platform === 'darwin') return;
    try {
      win.setTitleBarOverlay?.(theme === 'dark' ? { color: '#1f2329', symbolColor: '#e6e6e6' } : { color: '#f3f4f6', symbolColor: '#333333' });
    } catch {
      /* not supported on this platform */
    }
  });

  ipcMain.on('app:openDevTools', (e) => {
    assertSender(e);
    if (!app.isPackaged) getWindow()?.webContents.openDevTools({ mode: 'detach' });
  });
}
