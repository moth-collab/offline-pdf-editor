/* Annotation data, tool defaults and undoable operations. */
import { create } from 'zustand';
import type { DocumentInfo } from '@shared/types';
import { call } from '@/lib/api';
import { useDocuments } from '@/stores/documents';
import { useUi } from '@/stores/ui';
import { runOp } from '@/services/docService';
import type { Rect } from '@/types/editor';
import { tr } from '@/i18n';

export interface Annot {
  id: string;
  xref: number;
  page: number;
  type: string;
  rect: Rect;
  stroke: string | null;
  fill: string | null;
  opacity: number;
  border_width: number;
  contents: string;
  author: string;
  subject: string;
  modified: string | null;
  created: string | null;
  editable: boolean;
  points?: [number, number][];
  strokes?: [number, number][][];
  line_ends?: string[];
  stamp?: string;
  icon?: string;
}

export const STAMPS = ['Approved', 'NotApproved', 'Draft', 'Final', 'Confidential', 'ForComment', 'AsIs', 'Departmental', 'Experimental', 'Expired', 'ForPublicRelease', 'NotForPublicRelease', 'Sold', 'TopSecret'];
export const NOTE_ICONS = ['Note', 'Comment', 'Key', 'Help', 'NewParagraph', 'Paragraph', 'Insert'];

export const TYPE_LABEL: Record<string, string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikethrough', squiggly: 'Squiggly', note: 'Sticky note', freetext: 'Text comment',
  rect: 'Rectangle', circle: 'Oval', line: 'Line', polygon: 'Polygon', polyline: 'Polyline', ink: 'Drawing', stamp: 'Stamp', redact: 'Redaction mark',
  widget: 'Form field', attachment: 'File attachment', caret: 'Caret',
};

export interface ToolDefaults {
  stroke: string;
  fill: string | null;
  opacity: number;
  border_width: number;
  font_size: number;
  stamp: string;
  icon: string;
}

const DEFAULT_COLOR: Record<string, string> = {
  'annot-highlight': '#ffd800', 'annot-underline': '#0066ff', 'annot-strikeout': '#e5191b', 'annot-squiggly': '#1a9a1a', 'annot-note': '#ffcc00',
  'annot-freetext': '#2563eb', 'annot-callout': '#333333', 'annot-ink': '#1d4ed8', 'annot-rect': '#d92d20', 'annot-circle': '#d92d20',
  'annot-line': '#d92d20', 'annot-arrow': '#d92d20', 'annot-stamp': '#d92d20', 'redact-area': '#e5191b',
};

interface AnnotState {
  cache: Record<string, Annot[]>;
  defaults: Record<string, Partial<ToolDefaults>>;
  put: (key: string, v: Annot[]) => void;
  setDefault: (tool: string, patch: Partial<ToolDefaults>) => void;
}

export const useAnnots = create<AnnotState>((set) => ({
  cache: {},
  defaults: {},
  put: (key, v) => set((s) => ({ cache: { ...s.cache, [key]: v } })),
  setDefault: (tool, patch) => set((s) => ({ defaults: { ...s.defaults, [tool]: { ...s.defaults[tool], ...patch } } })),
}));

export function toolDefaults(tool: string, defs: Record<string, Partial<ToolDefaults>> = useAnnots.getState().defaults): ToolDefaults {
  return {
    stroke: DEFAULT_COLOR[tool] ?? '#d92d20',
    fill: null,
    opacity: tool === 'annot-highlight' ? 0.6 : 1,
    border_width: tool === 'annot-ink' ? 2 : tool === 'annot-freetext' ? 0 : 2,
    font_size: 12,
    stamp: 'Approved',
    icon: 'Comment',
    ...defs[tool],
  };
}

export const annotKey = (docId: string, rev: number, page: number) => `${docId}:${rev}:${page}`;
const inflight = new Map<string, Promise<Annot[]>>();

export function loadAnnots(docId: string, rev: number, page: number): Promise<Annot[]> {
  const key = annotKey(docId, rev, page);
  const hit = useAnnots.getState().cache[key];
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = call<{ annotations: Annot[] }>('annot.list', { doc_id: docId, page }).then((r) => {
      useAnnots.getState().put(key, r.annotations);
      return r.annotations;
    });
    p.finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

const author = () => useUi.getState().settings.authorName || 'User';

export async function addAnnot(docId: string, page: number, spec: Record<string, unknown>, label?: string) {
  const res = await runOp<DocumentInfo & { annotation?: Annot }>(docId, label ?? tr("Add {0}", tr(TYPE_LABEL[String(spec.type)] ?? 'comment')), 'annot.add', { page, spec, author: author() });
  if (res?.annotation) useDocuments.getState().update(docId, { selection: { kind: 'annotation', ids: [String(res.annotation.xref)], page } });
  return res?.annotation ?? null;
}

export async function updateAnnot(docId: string, page: number, xref: number, spec: Record<string, unknown>, label = tr('Edit comment')) {
  const res = await runOp<DocumentInfo & { annotation?: Annot }>(docId, label, 'annot.update', { page, xref, spec });
  if (res?.annotation) useDocuments.getState().update(docId, { selection: { kind: 'annotation', ids: [String(res.annotation.xref)], page } });
  return res?.annotation ?? null;
}

export async function deleteAnnots(docId: string, page: number, xrefs: number[]) {
  const res = await runOp(docId, xrefs.length > 1 ? tr("Delete comments") : tr("Delete comment"), 'annot.delete', { page, xrefs });
  if (res) useDocuments.getState().update(docId, { selection: { kind: 'none', ids: [] } });
  return !!res;
}
