/**
 * Preload (sandboxed). Exposes a narrow, typed API on window.pdfApi.
 * No Node.js APIs are exposed to the renderer.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PdfApi } from '../shared/types';

const EVENTS = new Set(['app:close-requested', 'backend:status', 'app:open-files']);

const api: PdfApi = {
  invoke: (op, payload) => ipcRenderer.invoke('backend:invoke', op, payload ?? {}),
  dialog: {
    open: (kind, title) => ipcRenderer.invoke('dialog:open', kind, title),
    save: (kind, suggestedName, title) => ipcRenderer.invoke('dialog:save', kind, suggestedName, title),
    folder: (title) => ipcRenderer.invoke('dialog:folder', title),
    message: (opts) => ipcRenderer.invoke('dialog:message', opts),
  },
  files: {
    registerDropped: (paths) => ipcRenderer.invoke('files:registerDropped', paths),
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  recent: {
    list: () => ipcRenderer.invoke('recent:list'),
    remove: (p) => ipcRenderer.invoke('recent:remove', p),
    clear: () => ipcRenderer.invoke('recent:clear'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    print: () => ipcRenderer.invoke('app:print'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    showItemInFolder: (token) => ipcRenderer.invoke('app:showItemInFolder', token),
    showSourceCode: () => ipcRenderer.invoke('app:showSourceCode'),
    defaultPdfApp: () => ipcRenderer.invoke('app:defaultPdfApp'),
    makeDefaultPdfApp: () => ipcRenderer.invoke('app:makeDefaultPdfApp'),
    setTitleBarTheme: (theme) => ipcRenderer.invoke('app:setTitleBarTheme', theme),
    readyToClose: () => ipcRenderer.send('app:ready-to-close'),
    openDevTools: () => ipcRenderer.send('app:openDevTools'),
  },
  docUrl: (docId, revision) => `appdoc://doc/${docId}/${revision}`,
  assetUrl: (assetId) => `appdoc://asset/${assetId}`,
  on: (channel, listener) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('pdfApi', api);
