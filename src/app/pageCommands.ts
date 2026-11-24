/* Page organisation commands (Phase 2). Operate on the selected pages, or the
 * current page when nothing is selected. */
import { bridge, call, errorMessage } from '@/lib/api';
import { formatRanges } from '@/lib/utils';
import { activeDoc, useDocuments, type DocState } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { askText } from '@/stores/prompt';
import { applyInfo, runOp, snapshot } from '@/services/docService';
import { register } from './commands';
import { tr } from '@/i18n';

export function targetPages(d: DocState): number[] {
  return d.selectedPages.length ? [...d.selectedPages].sort((a, b) => a - b) : [d.currentPage];
}

const editable = () => {
  const d = activeDoc();
  return !!d && d.info.owner_authenticated !== false;
};
const dialog = (type: string, props?: Record<string, unknown>) => () => useUi.getState().openDialog(type, props);

export async function deletePages(d: DocState, pages = targetPages(d)) {
  if (pages.length >= d.info.page_count) {
    toast('warning', tr("Cannot delete every page"), tr("A PDF must keep at least one page."));
    return;
  }
  const choice = await bridge().dialog.message({
    type: 'warning',
    title: tr("Delete pages"),
    message: tr("Delete {0}?", pages.length === 1 ? `page ${pages[0] + 1}` : `${pages.length} pages (${formatRanges(pages)})`),
    detail: tr("You can undo this with Ctrl+Z until you close the document."),
    buttons: [tr("Delete"), tr("Cancel")],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return;
  const res = await runOp(d.id, tr("Delete {0} page{1}", pages.length, pages.length > 1 ? 's' : ''), 'pages.delete', { pages });
  if (res) useDocuments.getState().update(d.id, { selectedPages: [] });
}

export async function rotatePages(d: DocState, angle: number, pages = targetPages(d)) {
  await runOp(d.id, angle === 180 ? tr("Rotate 180°") : angle > 0 ? tr("Rotate right") : tr("Rotate left"), 'pages.rotate', { pages, angle });
}

export async function movePages(d: DocState, pages: number[], to: number) {
  const res = await runOp(d.id, tr("Move pages"), 'pages.move', { pages, to });
  if (res) {
    const start = Math.min(to, res.page_count - pages.length);
    useDocuments.getState().update(d.id, { selectedPages: pages.map((_, i) => start + i) });
  }
}

export function copyPages(d: DocState) {
  const pages = targetPages(d);
  useDocuments.getState().setClipboard({ kind: 'pages', docId: d.id, pages });
  toast('info', tr("{0} page{1} copied", pages.length, pages.length > 1 ? 's' : ''), tr("Paste into this or another open document with Page › Paste Pages."));
}

export async function pastePages(d: DocState) {
  const clip = useDocuments.getState().clipboard;
  if (!clip || clip.kind !== 'pages') return;
  if (!useDocuments.getState().docs[clip.docId]) {
    toast('warning', tr("The source document was closed"));
    return;
  }
  await runOp(d.id, tr("Paste pages"), 'pages.copyFrom', { source_doc_id: clip.docId, pages: clip.pages, at: d.currentPage + 1 });
}

/** Move pages to another open document (copy + delete from the source). */
export async function movePagesToDocument(source: DocState, targetId: string, pages: number[], at: number) {
  if (pages.length >= source.info.page_count) {
    toast('warning', tr("Cannot move every page"), tr("The source document must keep at least one page."));
    return;
  }
  const ok = await runOp(targetId, tr("Receive pages"), 'pages.copyFrom', { source_doc_id: source.id, pages, at });
  if (!ok) return;
  await runOp(source.id, tr("Move pages to another document"), 'pages.delete', { pages });
  useDocuments.getState().update(source.id, { selectedPages: [] });
}

export async function insertFromFile(d: DocState, at = d.currentPage + 1) {
  const refs = await bridge().dialog.open('pdf', tr("Insert pages from PDF"));
  if (!refs.length) return;
  let password: string | undefined;
  for (let i = 0; i < 4; i++) {
    try {
      useDocuments.getState().update(d.id, { busy: 'Inserting pages' });
      const before = useDocuments.getState().docs[d.id];
      const info = await call<any>('pages.insertFile', { doc_id: d.id, base_revision: before.info.revision, at, file: refs[0].token, ...(password ? { password } : {}) });
      // record as an undoable command (same semantics as runOp)
      const snapBefore = snapshot(before);
      applyInfo(d.id, info);
      const after = snapshot(useDocuments.getState().docs[d.id]);
      useDocuments.getState().update(d.id, (cur) => ({ undo: [...cur.undo, { label: tr("Insert pages from file"), before: snapBefore, after, ts: Date.now() }], redo: [] }));
      return;
    } catch (e: any) {
      if (e?.code === 'password_required') {
        const pw = await askText({ title: tr("Password required"), message: tr("\"{0}\" is protected. Enter its password.", refs[0].name), password: true, label: tr("Password"), okLabel: tr("Insert") });
        if (pw === null) return;
        password = pw;
        continue;
      }
      toast('error', tr("Insert pages failed"), errorMessage(e));
      return;
    } finally {
      useDocuments.getState().update(d.id, { busy: null });
    }
  }
}

const withDoc = (fn: (d: DocState) => unknown) => () => {
  const d = activeDoc();
  if (d) return fn(d);
};

register([
  { id: 'page.organizer', label: 'Organize Pages', shortcut: 'Ctrl+Shift+O', run: () => useUi.getState().setOrganizerOpen(!useUi.getState().organizerOpen), enabled: () => !!activeDoc(), checked: () => useUi.getState().organizerOpen },
  { id: 'page.insertBlank', label: 'Insert Blank Page…', run: dialog('insert-blank'), enabled: editable },
  { id: 'page.insertFile', label: 'Insert Pages from File…', run: withDoc((d) => insertFromFile(d)), enabled: editable },
  { id: 'page.duplicate', label: 'Duplicate Pages', run: withDoc((d) => runOp(d.id, tr("Duplicate pages"), 'pages.duplicate', { pages: targetPages(d) })), enabled: editable },
  { id: 'page.delete', label: 'Delete Pages…', shortcut: 'Ctrl+Shift+D', run: withDoc((d) => deletePages(d)), enabled: editable },
  { id: 'page.rotateLeft', label: 'Rotate Left', shortcut: 'Ctrl+Shift+-', run: withDoc((d) => rotatePages(d, -90)), enabled: editable },
  { id: 'page.rotateRight', label: 'Rotate Right', shortcut: 'Ctrl+Shift+=', run: withDoc((d) => rotatePages(d, 90)), enabled: editable },
  { id: 'page.rotate180', label: 'Rotate 180°', run: withDoc((d) => rotatePages(d, 180)), enabled: editable },
  { id: 'page.copy', label: 'Copy Pages', run: withDoc(copyPages), enabled: () => !!activeDoc() },
  {
    id: 'page.paste',
    label: 'Paste Pages',
    run: withDoc(pastePages),
    enabled: () => editable() && useDocuments.getState().clipboard?.kind === 'pages',
  },
  { id: 'page.moveTo', label: 'Move Pages To…', run: dialog('move-pages'), enabled: editable },
  { id: 'page.reverse', label: 'Reverse Page Order', run: withDoc((d) => runOp(d.id, tr("Reverse pages"), 'pages.reverse', { pages: d.selectedPages.length > 1 ? targetPages(d) : [] })), enabled: editable },
  { id: 'page.crop', label: 'Crop Pages…', run: dialog('crop'), enabled: editable },
  { id: 'page.resize', label: 'Resize Pages…', run: dialog('resize'), enabled: editable },
  { id: 'doc.extract', label: 'Extract Pages…', run: dialog('extract'), enabled: () => !!activeDoc() },
  { id: 'doc.merge', label: 'Merge Files…', run: dialog('merge') },
  { id: 'doc.split', label: 'Split Document…', run: dialog('split'), enabled: () => !!activeDoc() },
  {
    id: 'file.createFromImages',
    label: 'Create PDF from Images…',
    run: async () => {
      const refs = await bridge().dialog.open('images', tr("Choose images"));
      if (refs.length) useUi.getState().openDialog('images-to-pdf', { files: refs });
    },
  },
  {
    id: 'doc.attachFile',
    label: 'Attach File…',
    run: withDoc(async (d) => {
      const refs = await bridge().dialog.open('any', tr("Attach file"));
      if (refs.length) {
        await runOp(d.id, tr("Attach file"), 'doc.addAttachment', { file: refs[0].token });
        useUi.getState().setSidebarTab('attachments');
      }
    }),
    enabled: editable,
  },
  {
    id: 'doc.addBookmark',
    label: 'Add Bookmark…',
    shortcut: 'Ctrl+B',
    run: withDoc(async (d) => {
      const title = await askText({ title: tr("Add bookmark"), label: tr("Title"), initial: `Page ${d.currentPage + 1}`, okLabel: tr("Add") });
      if (!title) return;
      const cur = await call<{ toc: [number, string, number][] }>('doc.outline', { doc_id: d.id });
      const toc = [...cur.toc];
      let idx = toc.findIndex((e) => e[2] > d.currentPage + 1);
      if (idx < 0) idx = toc.length;
      toc.splice(idx, 0, [1, title, d.currentPage + 1]);
      await runOp(d.id, tr("Add bookmark"), 'doc.setOutline', { toc });
      useUi.getState().setSidebarTab('bookmarks');
    }),
    enabled: editable,
  },
]);
