/* Direct text editing: data loading, pending edits and the preview → confirm →
 * apply workflow. Nothing is written before the user confirms the preview. */
import { create } from 'zustand';
import type { DocumentInfo } from '@shared/types';
import { call, errorMessage } from '@/lib/api';
import { useDocuments } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { runOp, commitOverlays } from '@/services/docService';
import { createText } from '@/features/overlay-editor/model';
import type { Rect } from '@/types/editor';
import { tr } from '@/i18n';

export interface TextLineStyle {
  font: string;
  family: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  font_status: 'embedded' | 'subset' | 'standard' | 'missing' | 'unsupported' | 'unknown';
  font_xref: number | null;
}

export interface TextLine {
  id: string;
  text: string;
  bbox: Rect;
  angle: number;
  origin: [number, number];
  invisible: boolean;
  style: TextLineStyle;
}

export interface TextBlock {
  id: string;
  bbox: Rect;
  lines: TextLine[];
  text: string;
}

export interface PageTextObjects {
  blocks: TextBlock[];
  scanned: boolean;
}

export interface EditOptions {
  font_family?: string | null;
  size?: number | null;
  color?: string | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean;
  strike?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify' | null;
  line_height?: number | null;
  char_spacing?: number;
  box?: Rect | null;
  offset?: [number, number] | null;
  fit?: 'overflow' | 'shrink';
}

export interface PendingEdit extends EditOptions {
  docId: string;
  page: number;
  lineIds: string[];
  newText: string;
  originalText: string;
}

export interface PreviewReport {
  level: 'safe' | 'caution' | 'unsupported';
  safe: boolean;
  warnings: { code: string; message: string; level: string }[];
  font: { original: string; family: string; status: string; plan: string; used: string | null; quality: string; reason: string; bold: boolean; italic: boolean };
  background: { overlaps_images: boolean; overlaps_graphics: boolean; painted_over: boolean };
  layout: Record<string, any>;
  collateral: string[];
  verification: { ok: boolean; new_text_found: boolean; old_text_removed: boolean; damaged_lines: string[] };
}

interface TextEditState {
  cache: Record<string, PageTextObjects>;
  /** selected block on a page */
  selected: { docId: string; page: number; blockId: string; lineIds: string[] } | null;
  editing: boolean;
  draft: string;
  setSelected: (s: TextEditState['selected']) => void;
  setEditing: (e: boolean, draft?: string) => void;
  setDraft: (d: string) => void;
  put: (key: string, v: PageTextObjects) => void;
  clearDoc: (docId: string) => void;
}

export const useTextEdit = create<TextEditState>((set) => ({
  cache: {},
  selected: null,
  editing: false,
  draft: '',
  setSelected: (selected) => set({ selected, editing: false }),
  setEditing: (editing, draft) => set((s) => ({ editing, draft: draft ?? s.draft })),
  setDraft: (draft) => set({ draft }),
  put: (key, v) => set((s) => ({ cache: { ...s.cache, [key]: v } })),
  clearDoc: (docId) => set((s) => ({ cache: Object.fromEntries(Object.entries(s.cache).filter(([k]) => !k.startsWith(docId))) })),
}));

export const cacheKey = (docId: string, revision: number, page: number) => `${docId}:${revision}:${page}`;

const inflight = new Map<string, Promise<PageTextObjects>>();

export function loadTextObjects(docId: string, revision: number, page: number): Promise<PageTextObjects> {
  const key = cacheKey(docId, revision, page);
  const hit = useTextEdit.getState().cache[key];
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = call<PageTextObjects>('text.objects', { doc_id: docId, page }).then((r) => {
      useTextEdit.getState().put(key, r);
      return r;
    });
    p.finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

function payload(e: PendingEdit, accept = false): Record<string, unknown> {
  const out: Record<string, unknown> = { page: e.page, line_ids: e.lineIds, new_text: e.newText };
  for (const k of ['font_family', 'size', 'color', 'bold', 'italic', 'underline', 'strike', 'align', 'line_height', 'char_spacing', 'box', 'offset', 'fit'] as const) {
    if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  }
  if (accept) out.accept_warnings = true;
  return out;
}

/** Ask the engine for a preview and open the confirmation dialog. */
export async function requestPreview(edit: PendingEdit) {
  const ui = useUi.getState();
  ui.setBusy({ label: tr("Preparing preview…") });
  try {
    const res = await call<{ report: PreviewReport; before: string; after: string | null }>('text.preview', { doc_id: edit.docId, ...payload(edit) });
    ui.openDialog('text-edit-preview', { edit, preview: res });
  } catch (e) {
    toast('error', tr("Cannot edit this text"), errorMessage(e));
  } finally {
    ui.setBusy(null);
  }
}

/** Apply a previewed edit (after the user confirmed). */
export async function applyEdit(edit: PendingEdit): Promise<boolean> {
  const label = edit.newText.trim() ? tr('Edit text') : tr('Delete text');
  const doc = useDocuments.getState().docs[edit.docId];
  if (!doc) return false;
  const res = await runOp<DocumentInfo & { report?: PreviewReport }>(edit.docId, label, 'text.apply', payload(edit, true));
  if (res) {
    useTextEdit.getState().setSelected(null);
    if (res.report && !res.report.verification?.ok) toast('warning', tr("The edit was applied but could not be fully verified"));
    return true;
  }
  return false;
}

/** Explicit fallback: put the new text in an overlay text box above the original. */
export function fallbackToOverlay(edit: PendingEdit, block: TextBlock | undefined, style: TextLineStyle | undefined) {
  const doc = useDocuments.getState().docs[edit.docId];
  if (!doc || !block) return;
  const settings = useUi.getState().settings;
  const t = createText(edit.page, block.bbox, settings);
  t.text = edit.newText;
  if (style) {
    t.fontSize = edit.size ?? style.size;
    t.color = edit.color ?? style.color;
    t.bold = edit.bold ?? style.bold;
    t.italic = edit.italic ?? style.italic;
  }
  t.background = '#ffffff';
  t.padding = 0;
  commitOverlays(edit.docId, tr("Add text (overlay)"), [...doc.overlays, t]);
  useDocuments.getState().update(edit.docId, { tool: 'edit-objects', selection: { kind: 'overlay', ids: [t.id], page: edit.page } });
  toast('info', tr("Added as an overlay text box"), tr("The original text is covered by a white box, not removed. Use Direct Edit to replace it permanently."));
}
