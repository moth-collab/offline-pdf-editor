/* Commands of the editing phases (overlay objects; later phases append). */
import type { DocumentInfo } from '@shared/types';
import { call, errorMessage } from '@/lib/api';
import { uid } from '@/lib/utils';
import { activeDoc, useDocuments, type DocState } from '@/stores/documents';
import { toast } from '@/stores/ui';
import { applyInfo, commitOverlays, snapshot } from '@/services/docService';
import type { OverlayObject, ToolId } from '@/types/editor';
import { createImage, prepareForSave, reorder, translate } from '@/features/overlay-editor/model';
import { useOverlayUi } from '@/features/overlay-editor/OverlayLayer';
import { imageRect } from '@/features/viewer/ToolLayer';
import { onToolChange, register, setTool } from './commands';
import { registerDialogs } from '@/components/dialogs/DialogHost';
import { TextEditPreviewDialog } from '@/features/text-editor/PreviewDialog';
import { useTextEdit } from '@/features/text-editor/service';
import { deleteAnnots } from '@/features/annotations/service';
import { bridge } from '@/lib/api';
import { runOp } from '@/services/docService';
import { useUi } from '@/stores/ui';
import { tr } from '@/i18n';
import { deleteSelectedFields } from '@/features/forms/FormLayer';

registerDialogs({ 'text-edit-preview': TextEditPreviewDialog });

const editable = () => {
  const d = activeDoc();
  return !!d && d.info.owner_authenticated !== false;
};
const selIds = (d: DocState) => (d.selection.kind === 'overlay' ? d.selection.ids : []);
const hasSel = () => {
  const d = activeDoc();
  return !!d && selIds(d).length > 0;
};
const toolCmd = (id: ToolId, label: string, shortcut?: string) => ({
  id: `tool.${id}`,
  label,
  shortcut,
  run: () => setTool(id),
  enabled: editable,
  checked: () => activeDoc()?.tool === id,
});

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

export function deleteSelected(d: DocState) {
  const ids = new Set(selIds(d));
  if (!ids.size) return;
  commitOverlays(d.id, ids.size > 1 ? tr("Delete {0} objects", ids.size) : tr("Delete object"), d.overlays.filter((o) => !ids.has(o.id)));
  useDocuments.getState().update(d.id, { selection: { kind: 'none', ids: [] } });
}

function duplicate(d: DocState) {
  const ids = new Set(selIds(d));
  const copies = d.overlays.filter((o) => ids.has(o.id)).map((o) => ({ ...translate(o, 10, -10), id: uid(o.kind) }) as OverlayObject);
  if (!copies.length) return;
  commitOverlays(d.id, tr("Duplicate"), [...d.overlays, ...copies]);
  useDocuments.getState().update(d.id, { selection: { kind: 'overlay', ids: copies.map((c) => c.id), page: copies[0].page } });
}

function copySelected(d: DocState, cut = false) {
  const ids = new Set(selIds(d));
  const items = d.overlays.filter((o) => ids.has(o.id));
  if (!items.length) return false;
  useDocuments.getState().setClipboard({ kind: 'overlays', items });
  if (cut) deleteSelected(d);
  return true;
}

function pasteOverlays(d: DocState) {
  const clip = useDocuments.getState().clipboard;
  if (!clip || clip.kind !== 'overlays') return false;
  const samePage = clip.items.every((o) => o.page === d.currentPage);
  const pasted = clip.items.map((o) => {
    let c = { ...o, id: uid(o.kind), page: d.currentPage } as OverlayObject;
    if (samePage) c = translate(c, 12, -12);
    return c;
  });
  commitOverlays(d.id, tr("Paste"), [...d.overlays, ...pasted]);
  useDocuments.getState().update(d.id, { selection: { kind: 'overlay', ids: pasted.map((p) => p.id), page: d.currentPage } });
  return true;
}

function arrange(op: 'front' | 'back' | 'forward' | 'backward') {
  const d = activeDoc();
  if (!d) return;
  const labels = { front: 'Bring to front', back: 'Send to back', forward: 'Bring forward', backward: 'Send backward' };
  commitOverlays(d.id, labels[op], reorder(d.overlays, selIds(d), op));
}

/** Permanently write overlay objects into the page content (undoable). */
export async function flattenOverlays(d: DocState, onlySelected: boolean) {
  const ids = new Set(selIds(d));
  const target = onlySelected && ids.size ? d.overlays.filter((o) => ids.has(o.id)) : d.overlays;
  if (!target.length) {
    toast('info', tr("There are no objects to flatten"));
    return;
  }
  const before = snapshot(d);
  try {
    useDocuments.getState().update(d.id, { busy: 'Flattening objects' });
    const info = await call<DocumentInfo & { warnings?: unknown[] }>('overlays.flatten', { doc_id: d.id, base_revision: d.info.revision, overlays: prepareForSave(target) as unknown as Record<string, unknown>[] });
    const keep = new Set(target.map((o) => o.id));
    const remaining = useDocuments.getState().docs[d.id].overlays.filter((o) => !keep.has(o.id));
    applyInfo(d.id, info, remaining);
    const after = snapshot(useDocuments.getState().docs[d.id]);
    useDocuments.getState().update(d.id, (cur) => ({ undo: [...cur.undo, { label: tr("Flatten objects"), before, after, ts: Date.now() }], redo: [], selection: { kind: 'none', ids: [] } }));
  } catch (e) {
    toast('error', tr("Flatten failed"), errorMessage(e));
  } finally {
    useDocuments.getState().update(d.id, { busy: null });
  }
}

register([
  toolCmd('direct-text', 'Edit Text (Direct Edit)', 'E'),
  toolCmd('add-text', 'Add Text', 'T'),
  toolCmd('add-image', 'Add Image'),
  toolCmd('edit-images', 'Edit Images'),
  toolCmd('shape-rect', 'Rectangle'),
  toolCmd('shape-ellipse', 'Ellipse'),
  toolCmd('shape-line', 'Line'),
  toolCmd('shape-arrow', 'Arrow'),
  toolCmd('add-link', 'Add Link'),
  toolCmd('edit-objects', 'Edit Objects', 'O'),
  {
    id: 'tool.escape',
    label: 'Cancel',
    shortcut: 'Escape',
    run: () => {
      const d = activeDoc();
      if (!d) return;
      if (useOverlayUi.getState().editingId || useTextEdit.getState().editing) return;
      if (d.selection.kind === 'text') useTextEdit.getState().setSelected(null);
      if (d.selection.ids.length) useDocuments.getState().update(d.id, { selection: { kind: 'none', ids: [] } });
      else if (d.tool !== 'select') setTool('select');
    },
  },
  { id: 'edit.delete', label: 'Delete', shortcut: 'Delete / Backspace', run: () => activeDoc() && deleteSelected(activeDoc()!), enabled: hasSel },
  { id: 'edit.duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', run: () => activeDoc() && duplicate(activeDoc()!), enabled: hasSel },
  { id: 'edit.copy', label: 'Copy', shortcut: 'Ctrl+C', run: () => activeDoc() && copySelected(activeDoc()!), enabled: hasSel },
  { id: 'edit.cut', label: 'Cut', shortcut: 'Ctrl+X', run: () => activeDoc() && copySelected(activeDoc()!, true), enabled: hasSel },
  {
    id: 'edit.paste',
    label: 'Paste',
    shortcut: 'Ctrl+V',
    run: () => activeDoc() && pasteOverlays(activeDoc()!),
    enabled: () => editable() && useDocuments.getState().clipboard?.kind === 'overlays',
  },
  {
    id: 'edit.selectAll',
    label: 'Select All Objects on Page',
    shortcut: 'Ctrl+A',
    run: () => {
      const d = activeDoc();
      if (!d) return;
      const ids = d.overlays.filter((o) => o.page === d.currentPage).map((o) => o.id);
      if (ids.length) useDocuments.getState().update(d.id, { selection: { kind: 'overlay', ids, page: d.currentPage }, tool: d.tool === 'select' ? 'edit-objects' : d.tool });
    },
    enabled: () => !!activeDoc()?.overlays.length,
  },
  { id: 'overlay.front', label: 'Bring to Front', shortcut: 'Ctrl+Shift+]', run: () => arrange('front'), enabled: hasSel },
  { id: 'overlay.back', label: 'Send to Back', shortcut: 'Ctrl+Shift+[', run: () => arrange('back'), enabled: hasSel },
  { id: 'overlay.forward', label: 'Bring Forward', shortcut: 'Ctrl+]', run: () => arrange('forward'), enabled: hasSel },
  { id: 'overlay.backward', label: 'Send Backward', shortcut: 'Ctrl+[', run: () => arrange('backward'), enabled: hasSel },
  toolCmd('annot-highlight', 'Highlight'),
  toolCmd('annot-underline', 'Underline'),
  toolCmd('annot-strikeout', 'Strikethrough'),
  toolCmd('annot-squiggly', 'Squiggly Underline'),
  toolCmd('annot-note', 'Sticky Note'),
  toolCmd('annot-freetext', 'Text Comment'),
  toolCmd('annot-callout', 'Callout'),
  toolCmd('annot-ink', 'Pencil (Drawing)'),
  toolCmd('annot-rect', 'Rectangle Comment'),
  toolCmd('annot-circle', 'Oval Comment'),
  toolCmd('annot-line', 'Line Comment'),
  toolCmd('annot-arrow', 'Arrow Comment'),
  toolCmd('annot-stamp', 'Stamp'),
  { id: 'comment.list', label: 'Comments List', run: () => useUi.getState().setSidebarTab('comments'), enabled: () => !!activeDoc() },
  {
    id: 'comment.flatten',
    label: 'Flatten Comments…',
    run: async () => {
      const d = activeDoc();
      if (!d) return;
      const choice = await bridge().dialog.message({
        type: 'warning',
        title: tr("Flatten comments"),
        message: tr("Flatten all comments into the page content?"),
        detail: tr("Flattened comments can no longer be edited, moved or deleted as comments. You can undo this until you close the document."),
        buttons: [tr("Flatten"), tr("Cancel")],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice !== 0) return;
      const res = await runOp<DocumentInfo & { flattened?: number }>(d.id, tr("Flatten comments"), 'annot.flatten');
      if (res) toast('success', tr("Flattened {0} comments", res.flattened ?? 0));
    },
    enabled: editable,
  },
  {
    id: 'overlay.flatten',
    label: 'Flatten Objects into Page',
    run: () => {
      const d = activeDoc();
      if (d) flattenOverlays(d, hasSel());
    },
    enabled: () => editable() && !!activeDoc()?.overlays.length,
  },
]);

// arrow keys nudge selected objects; Delete/Backspace remove them
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || isTyping() || document.querySelector('[role="dialog"]')) return;
  const ad = activeDoc();
  if (ad && (e.key === 'Delete' || e.key === 'Backspace') && deleteSelectedFields(ad)) {
    e.preventDefault();
    return;
  }
  if (ad && ad.selection.kind === 'annotation' && ad.selection.ids.length && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    deleteAnnots(ad.id, ad.selection.page ?? ad.currentPage, ad.selection.ids.map(Number));
    return;
  }
  const d = activeDoc();
  if (!d || !selIds(d).length || useOverlayUi.getState().editingId) return;
  const step = e.shiftKey ? 10 : 1;
  const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (delta[e.key]) {
    e.preventDefault();
    const ids = new Set(selIds(d));
    const page = d.info.pages[d.currentPage];
    // nudge in screen direction: account for page rotation
    let [dx, dy] = delta[e.key];
    const rot = page ? page.rotation % 360 : 0;
    if (rot === 90) [dx, dy] = [-dy, dx];
    else if (rot === 180) [dx, dy] = [-dx, -dy];
    else if (rot === 270) [dx, dy] = [dy, -dx];
    commitOverlays(d.id, tr("Nudge"), d.overlays.map((o) => (ids.has(o.id) && !o.locked ? translate(o, dx, dy) : o)));
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected(d);
  }
});

// paste images from the system clipboard as image objects
window.addEventListener('paste', async (e) => {
  if (isTyping()) return;
  const d = activeDoc();
  if (!d || d.info.owner_authenticated === false) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  try {
    const a = await call<{ asset_id: string; width: number; height: number }>('asset.addImage', { data_base64: btoa(bin) });
    const page = d.info.pages[d.currentPage];
    const cx = (page.cropbox[0] + page.cropbox[2]) / 2;
    const cy = (page.cropbox[1] + page.cropbox[3]) / 2;
    const r = imageRect([cx, cy], a.width, a.height, undefined, page);
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    const obj = createImage(d.currentPage, [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], a.asset_id, a.width, a.height);
    obj.rotation = (360 - page.rotation) % 360;
    const cur = useDocuments.getState().docs[d.id];
    commitOverlays(d.id, tr("Paste image"), [...cur.overlays, obj]);
    useDocuments.getState().update(d.id, { selection: { kind: 'overlay', ids: [obj.id], page: d.currentPage }, tool: 'edit-objects' });
  } catch (err) {
    toast('error', tr("Cannot paste the image"), errorMessage(err));
  }
});

onToolChange(() => useTextEdit.getState().setSelected(null));
