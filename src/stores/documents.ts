/* Renderer-side document session state. One entry per open tab. */
import { create } from 'zustand';
import type { DocumentInfo } from '@shared/types';
import type { HistoryEntry, OverlayObject, SearchHit, Selection, ToolId, ViewMode, ZoomMode } from '@/types/editor';

export interface DocState {
  id: string;
  info: DocumentInfo;
  /** write token for saving back to the original file (Ctrl+S) */
  saveToken?: string;
  currentPage: number;
  zoom: number;
  zoomMode: ZoomMode;
  viewMode: ViewMode;
  tool: ToolId;
  overlays: OverlayObject[];
  selection: Selection;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  savedRevision: number | null;
  savedOverlays: OverlayObject[] | null;
  /** bumps whenever page content changes, per page (cache keys) */
  pageVersions: number[];
  busy: string | null;
  search: { query: string; hits: SearchHit[]; index: number; total: number } | null;
  /** pages known to be scanned (image-only) */
  scannedPages: number[];
  /** monotonically increasing; forces annotation/text data refresh */
  dataVersion: number;
  hiddenLayers: string[];
  /** pages selected in the thumbnails panel / organizer */
  selectedPages: number[];
}

interface DocumentsStore {
  docs: Record<string, DocState>;
  order: string[];
  activeId: string | null;
  clipboard: { kind: 'pages'; docId: string; pages: number[] } | { kind: 'overlays'; items: OverlayObject[] } | null;
  addDoc: (info: DocumentInfo, opts?: Partial<DocState>) => void;
  removeDoc: (id: string) => void;
  setActive: (id: string | null) => void;
  update: (id: string, patch: Partial<DocState> | ((d: DocState) => Partial<DocState>)) => void;
  moveTab: (id: string, toIndex: number) => void;
  setClipboard: (c: DocumentsStore['clipboard']) => void;
}

export const useDocuments = create<DocumentsStore>((set) => ({
  docs: {},
  order: [],
  activeId: null,
  clipboard: null,
  addDoc: (info, opts) =>
    set((s) => {
      const d: DocState = {
        id: info.doc_id,
        info,
        saveToken: (info as any).save_token,
        currentPage: 0,
        zoom: 1,
        zoomMode: 'fit-width',
        viewMode: 'continuous',
        tool: 'select',
        overlays: [],
        selection: { kind: 'none', ids: [] },
        undo: [],
        redo: [],
        savedRevision: info.saved_revision,
        savedOverlays: null,
        pageVersions: new Array(info.page_count).fill(0),
        busy: null,
        search: null,
        scannedPages: [],
        dataVersion: 0,
        hiddenLayers: [],
        selectedPages: [],
        ...opts,
      };
      if (d.savedOverlays === null) d.savedOverlays = d.overlays;
      return { docs: { ...s.docs, [d.id]: d }, order: s.order.includes(d.id) ? s.order : [...s.order, d.id], activeId: d.id };
    }),
  removeDoc: (id) =>
    set((s) => {
      const docs = { ...s.docs };
      delete docs[id];
      const idx = s.order.indexOf(id);
      const order = s.order.filter((x) => x !== id);
      const activeId = s.activeId === id ? order[Math.min(idx, order.length - 1)] ?? null : s.activeId;
      const clipboard = s.clipboard?.kind === 'pages' && s.clipboard.docId === id ? null : s.clipboard;
      return { docs, order, activeId, clipboard };
    }),
  setActive: (activeId) => set({ activeId }),
  update: (id, patch) =>
    set((s) => {
      const cur = s.docs[id];
      if (!cur) return {};
      const p = typeof patch === 'function' ? patch(cur) : patch;
      return { docs: { ...s.docs, [id]: { ...cur, ...p } } };
    }),
  moveTab: (id, toIndex) =>
    set((s) => {
      const order = s.order.filter((x) => x !== id);
      order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, id);
      return { order };
    }),
  setClipboard: (clipboard) => set({ clipboard }),
}));

export function isDirty(d: DocState): boolean {
  return d.info.revision !== d.savedRevision || d.overlays !== d.savedOverlays;
}

export function activeDoc(): DocState | null {
  const s = useDocuments.getState();
  return s.activeId ? s.docs[s.activeId] ?? null : null;
}

export function useActiveDoc(): DocState | null {
  return useDocuments((s) => (s.activeId ? s.docs[s.activeId] ?? null : null));
}
