/* Types shared between the Electron main process, preload and renderer. */

export interface PageInfo {
  index: number;
  /** unrotated crop box size in points */
  width: number;
  height: number;
  rotation: number;
  /** PDF user space [x0, y0, x1, y1] */
  mediabox: number[];
  cropbox: number[];
  origin: number[];
}

export interface Permissions {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fill_forms: boolean;
  assemble: boolean;
  print_high_quality: boolean;
}

export interface SecurityState {
  encrypt: boolean;
  has_user_password: boolean;
  has_owner_password: boolean;
  permissions: Partial<Permissions> | null;
  /** protection of the original file kept on save */
  preserved?: boolean;
  /** the original permissions password is unknown (opened with the user password) */
  owner_unknown?: boolean;
}

export interface DocumentInfo {
  doc_id: string;
  display_name: string;
  original_path: string | null;
  revision: number;
  revisions: number[];
  saved_revision: number | null;
  can_undo: boolean;
  can_redo: boolean;
  page_count: number;
  pages: PageInfo[];
  metadata: Record<string, string>;
  file_size: number;
  source_encrypted: boolean;
  permissions: Permissions | null;
  owner_authenticated: boolean;
  repaired: boolean;
  security: SecurityState | null;
  has_outline: boolean;
  has_signatures: boolean;
  page_map?: (number | null)[] | null;
  modified_pages?: number[] | null;
  ui_state?: unknown;
  [key: string]: unknown;
}

export interface FileRef {
  token: string;
  name: string;
  path: string;
  size?: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  token?: string;
  exists?: boolean;
}

export interface RecoverySession {
  session_id: string;
  display_name: string;
  original_path: string | null;
  updated: number;
  revisions: number;
  unsaved: boolean;
}

export interface AppSettings {
  language: 'en' | 'th';
  theme: 'light' | 'dark' | 'system';
  defaultSaveDir: string;
  recentLimit: number;
  autosaveEnabled: boolean;
  autosaveIntervalSec: number;
  makeBackups: boolean;
  defaultFont: string;
  defaultFontSize: number;
  defaultTextColor: string;
  defaultEditMode: 'select' | 'hand' | 'direct-text' | 'add-text';
  renderQuality: 'standard' | 'high' | 'maximum';
  cacheSizeMB: number;
  maxRevisions: number;
  cleanupTempOnExit: boolean;
  recoveryRetentionDays: number;
  ocrLanguage: string;
  ocrDpi: number;
  confirmExternalLinks: boolean;
  authorName: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'en',
  theme: 'light',
  defaultSaveDir: '',
  recentLimit: 15,
  autosaveEnabled: true,
  autosaveIntervalSec: 30,
  makeBackups: true,
  defaultFont: 'Noto Sans',
  defaultFontSize: 12,
  defaultTextColor: '#000000',
  defaultEditMode: 'select',
  renderQuality: 'high',
  cacheSizeMB: 256,
  maxRevisions: 60,
  cleanupTempOnExit: true,
  recoveryRetentionDays: 7,
  ocrLanguage: 'tha+eng',
  ocrDpi: 300,
  confirmExternalLinks: true,
  authorName: 'User',
};

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  userData: string;
  backend: BackendStatus;
  isPackaged: boolean;
  e2e?: boolean;
}

export interface BackendStatus {
  state: 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';
  message?: string;
  restarts: number;
}

export type DialogKind = 'pdf' | 'pdfs' | 'image' | 'images' | 'pfx' | 'any';
export type SaveKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt' | 'pfx' | 'any';

/** API exposed by the preload script on window.pdfApi */
export interface PdfApi {
  invoke<T = unknown>(op: string, payload?: Record<string, unknown>): Promise<ApiResult<T>>;
  dialog: {
    open(kind: DialogKind, title?: string): Promise<FileRef[]>;
    save(kind: SaveKind, suggestedName: string, title?: string): Promise<FileRef | null>;
    folder(title?: string): Promise<FileRef | null>;
    message(opts: { type?: 'none' | 'info' | 'error' | 'question' | 'warning'; title?: string; message: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number }): Promise<number>;
  };
  files: {
    registerDropped(paths: string[]): Promise<FileRef[]>;
    pathForFile(file: File): string;
  };
  recent: {
    list(): Promise<RecentFile[]>;
    remove(path: string): Promise<void>;
    clear(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  app: {
    info(): Promise<AppInfo>;
    print(): Promise<{ ok: boolean; error?: string }>;
    openExternal(url: string): Promise<boolean>;
    showItemInFolder(token: string): Promise<void>;
    /** Reveal the bundled complete source code and licence (AGPL-3.0). */
    showSourceCode(): Promise<boolean>;
    setTitleBarTheme(theme: 'light' | 'dark'): Promise<void>;
    readyToClose(): void;
    openDevTools(): void;
  };
  docUrl(docId: string, revision: number): string;
  assetUrl(assetId: string): string;
  on(channel: 'app:close-requested' | 'backend:status' | 'app:open-files', listener: (payload: any) => void): () => void;
}
