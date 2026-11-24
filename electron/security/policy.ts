/**
 * Privacy & security hardening of the Electron session.
 *
 * - Blocks every network request from the renderer except the local app/doc
 *   protocols (and the Vite dev server while developing).
 * - Denies all permission requests (camera, geolocation, notifications ...).
 * - Prevents navigation and new windows; external links open only after
 *   user confirmation in the OS browser.
 * - Disables spellchecker dictionary downloads.
 */
import { app, session, shell, type WebContents } from 'electron';

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? '';

export function isAllowedUrl(url: string): boolean {
  if (url.startsWith('app://bundle/') || url.startsWith('appdoc://') || url.startsWith('devtools://')) return true;
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (DEV_URL && !app.isPackaged) {
    const u = new URL(DEV_URL);
    if (url.startsWith(`${u.protocol}//${u.host}`) || url.startsWith(`ws://${u.host}`)) return true;
  }
  return false;
}

export function applyCommandLineHardening(): void {
  app.commandLine.appendSwitch('dns-prefetch-disable');
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaRouter,DialMediaRouteProvider,OptimizationHints,Translate');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('no-pings');
}

export function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setSpellCheckerDictionaryDownloadURL('https://0.0.0.0/');
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = isAllowedUrl(details.url);
    if (!ok) console.warn(`[privacy] blocked network request: ${details.url.slice(0, 120)}`);
    cb({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
}

export function hardenWebContents(wc: WebContents): void {
  wc.on('will-navigate', (e, url) => {
    if (!isAllowedUrl(url) || url.startsWith('appdoc://')) e.preventDefault();
  });
  wc.on('will-redirect', (e, url) => {
    if (!isAllowedUrl(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

export async function openExternalSafely(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['https:', 'http:', 'mailto:'].includes(u.protocol)) return false;
  await shell.openExternal(u.toString());
  return true;
}
