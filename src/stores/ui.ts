import { create } from 'zustand';
import type { AppSettings, BackendStatus } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

export type RibbonTab = 'home' | 'edit' | 'organize' | 'comment' | 'forms' | 'convert' | 'protect';
export type SidebarTab = 'thumbnails' | 'bookmarks' | 'attachments' | 'layers' | 'comments' | 'search';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warning';
  title: string;
  detail?: string;
}

export interface BusyState {
  label: string;
  progress?: number | null;
  cancel?: () => void;
}

export interface DialogState {
  type: string;
  props?: Record<string, unknown>;
}

interface UiState {
  ribbonTab: RibbonTab;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  propertiesOpen: boolean;
  organizerOpen: boolean;
  settings: AppSettings;
  backend: BackendStatus;
  toasts: Toast[];
  busy: BusyState | null;
  dialog: DialogState | null;
  resolvedTheme: 'light' | 'dark';
  setRibbonTab: (t: RibbonTab) => void;
  toggleSidebar: (open?: boolean) => void;
  setSidebarTab: (t: SidebarTab) => void;
  setSidebarWidth: (w: number) => void;
  toggleProperties: (open?: boolean) => void;
  setOrganizerOpen: (o: boolean) => void;
  setSettings: (s: AppSettings) => void;
  setBackend: (b: BackendStatus) => void;
  toast: (kind: Toast['kind'], title: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  setBusy: (b: BusyState | null) => void;
  openDialog: (type: string, props?: Record<string, unknown>) => void;
  closeDialog: () => void;
  setResolvedTheme: (t: 'light' | 'dark') => void;
}

let toastId = 1;

export const useUi = create<UiState>((set) => ({
  ribbonTab: 'home',
  sidebarOpen: true,
  sidebarTab: 'thumbnails',
  sidebarWidth: 220,
  propertiesOpen: true,
  organizerOpen: false,
  settings: DEFAULT_SETTINGS,
  backend: { state: 'starting', restarts: 0 },
  toasts: [],
  busy: null,
  dialog: null,
  resolvedTheme: 'light',
  setRibbonTab: (ribbonTab) => set({ ribbonTab }),
  toggleSidebar: (open) => set((s) => ({ sidebarOpen: open ?? !s.sidebarOpen })),
  setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(160, Math.min(480, w)) }),
  toggleProperties: (open) => set((s) => ({ propertiesOpen: open ?? !s.propertiesOpen })),
  setOrganizerOpen: (organizerOpen) => set({ organizerOpen }),
  setSettings: (settings) => set({ settings }),
  setBackend: (backend) => set({ backend }),
  toast: (kind, title, detail) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, title, detail }] }));
    const ms = kind === 'error' ? 9000 : kind === 'success' ? 2500 : 5000;
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setBusy: (busy) => set({ busy }),
  openDialog: (type, props) => set({ dialog: { type, props } }),
  closeDialog: () => set({ dialog: null }),
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
}));

export const toast = (kind: Toast['kind'], title: string, detail?: string) => useUi.getState().toast(kind, title, detail);
