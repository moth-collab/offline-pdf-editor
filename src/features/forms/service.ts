/* Interactive form fields: data cache (per document revision) and undoable operations. */
import { create } from 'zustand';
import type { DocumentInfo } from '@shared/types';
import { call } from '@/lib/api';
import { runOp } from '@/services/docService';
import { useDocuments } from '@/stores/documents';
import { toast } from '@/stores/ui';
import type { Rect } from '@/types/editor';
import { tr } from '@/i18n';

export type FieldType = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'signature';
export type FieldValue = string | boolean | string[] | null;

export interface FormField {
  name: string;
  type: FieldType;
  value: FieldValue;
  options: [string, string][];
  font_size: number;
  align: 'left' | 'center' | 'right';
  tooltip: string;
  maxlen: number;
  signed: boolean;
  readonly: boolean;
  required: boolean;
  multiline: boolean;
  password: boolean;
  comb: boolean;
  multiselect: boolean;
  editable: boolean;
}

export interface FormWidget {
  id: string;
  field: string;
  type: FieldType;
  page: number;
  rect: Rect;
  export: string | null;
  hidden: boolean;
}

export interface FormsData {
  fields: FormField[];
  widgets: FormWidget[];
  xfa: boolean;
  can_fill: boolean;
  can_edit: boolean;
}

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text field',
  checkbox: 'Check box',
  radio: 'Radio button',
  combo: 'Dropdown list',
  list: 'List box',
  signature: 'Signature field',
};

interface FormsState {
  cache: Record<string, FormsData>;
  /** highlight fillable fields (like other PDF readers) */
  highlight: boolean;
  put: (key: string, v: FormsData) => void;
  setHighlight: (v: boolean) => void;
}

export const useForms = create<FormsState>((set) => ({
  cache: {},
  highlight: true,
  put: (key, v) => set((s) => ({ cache: { ...s.cache, [key]: v } })),
  setHighlight: (highlight) => set({ highlight }),
}));

export const formsKey = (docId: string, rev: number) => `${docId}:${rev}`;
const inflight = new Map<string, Promise<FormsData>>();

export function loadForms(docId: string, rev: number): Promise<FormsData> {
  const key = formsKey(docId, rev);
  const hit = useForms.getState().cache[key];
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = call<FormsData>('forms.list', { doc_id: docId }).then((r) => {
      useForms.getState().put(key, r);
      return r;
    });
    p.finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export function currentForms(docId: string): FormsData | undefined {
  const d = useDocuments.getState().docs[docId];
  return d ? useForms.getState().cache[formsKey(docId, d.info.revision)] : undefined;
}

export function fieldByName(data: FormsData | undefined, name: string): FormField | undefined {
  return data?.fields.find((f) => f.name === name);
}

/* Form operations run one after another per document: quick successive
 * entries (type, then immediately tick a box) must each start from the
 * revision the previous one produced. */
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(docId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(docId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  queues.set(docId, next);
  next.finally(() => queues.get(docId) === next && queues.delete(docId)).catch(() => undefined);
  return next;
}

export async function fillFields(docId: string, values: Record<string, FieldValue>) {
  const n = Object.keys(values).length;
  if (!n) return null;
  return enqueue(docId, () => runOp(docId, n === 1 ? tr('Fill in form field') : tr('Fill in {0} form fields', n), 'forms.fill', { values }));
}

export async function resetForm(docId: string) {
  return enqueue(docId, () => runOp(docId, tr('Reset form'), 'forms.reset', {}));
}

export async function flattenForm(docId: string) {
  return enqueue(docId, () => runOp(docId, tr('Flatten form'), 'forms.flatten', {}));
}

export interface CreateSpec {
  type: FieldType;
  rect: Rect;
  name?: string;
  options?: string[];
  multiline?: boolean;
  export?: string;
}

export async function createField(docId: string, page: number, spec: CreateSpec) {
  const res = await enqueue(docId, () => runOp<DocumentInfo & { result?: { name: string; widget: string } }>(docId, tr('Add form field'), 'forms.create', { page, ...spec }));
  if (res?.result) {
    useDocuments.getState().update(docId, { selection: { kind: 'form', ids: [res.result.widget], page, field: res.result.name } });
  }
  return res?.result ?? null;
}

export async function updateField(docId: string, field: string, props: Record<string, unknown>, widget?: string, label?: string) {
  const res = await enqueue(docId, () =>
    runOp<DocumentInfo & { result?: { name: string } }>(
      docId,
      label ?? (Object.keys(props).length === 1 && 'rect' in props ? tr('Move form field') : tr('Change form field')),
      'forms.update',
      { field, props, ...(widget ? { widget } : {}) },
    ),
  );
  const sel = useDocuments.getState().docs[docId]?.selection;
  if (res?.result && sel?.kind === 'form' && sel.field === field) {
    useDocuments.getState().update(docId, { selection: { ...sel, field: res.result.name } });
  }
  return res;
}

export async function deleteWidgets(docId: string, widgetIds: string[]) {
  let res = null;
  // delete from the highest index down so the remaining positional ids stay valid
  for (const id of [...widgetIds].sort().reverse()) res = await enqueue(docId, () => runOp(docId, tr('Delete form field'), 'forms.delete', { widget: id }));
  useDocuments.getState().update(docId, { selection: { kind: 'none', ids: [] } });
  return res;
}

/** Tell the user when a freshly opened document contains a fillable form. */
export async function announceForm(docId: string, revision: number) {
  try {
    const data = await loadForms(docId, revision);
    const fillable = data.fields.filter((f) => !f.readonly && f.type !== 'signature').length;
    if (!fillable) return;
    toast('info', tr('This document contains a form'), data.xfa ? tr('Fill in the highlighted fields. (The XFA part of this form is not supported and is removed when you fill it in.)') : tr('Fill in the highlighted fields, then save.'));
  } catch {
    /* not essential */
  }
}

