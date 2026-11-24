/* Document workflows: open, mutate (command history), undo/redo, save, close.
 *
 * History model: every command records a before/after Snapshot
 *   { revision (backend working-copy revision), overlays, pageVersions }.
 * Undo/redo restore snapshots: the backend switches its revision pointer and
 * the overlay model is restored. Validation: a snapshot whose revision was
 * pruned by the backend can no longer be restored and is dropped. */
import type { DocumentInfo, FileRef } from '@shared/types';
import { ApiException, bridge, call, errorMessage } from '@/lib/api';
import { activeDoc, isDirty, useDocuments, type DocState } from '@/stores/documents';
import { askText } from '@/stores/prompt';
import { toast, useUi } from '@/stores/ui';
import type { HistoryEntry, OverlayObject, Snapshot } from '@/types/editor';
import { releasePdf } from '@/features/viewer/pdfjs';
import { prepareForSave } from '@/features/overlay-editor/model';
import { tr } from '@/i18n';

const MAX_HISTORY = 100;
let contentCounter = 1;
export const freshContentIds = (n: number) => Array.from({ length: n }, () => contentCounter++);

const getDoc = (id: string): DocState => {
  const d = useDocuments.getState().docs[id];
  if (!d) throw new Error(tr("Document is not open"));
  return d;
};

export function snapshot(d: DocState): Snapshot {
  return { revision: d.info.revision, overlays: d.overlays, pageVersions: d.pageVersions };
}

function pushHistory(id: string, entry: HistoryEntry) {
  useDocuments.getState().update(id, (d) => ({
    undo: [...d.undo.slice(-(MAX_HISTORY - 1)), entry],
    redo: [],
  }));
}

/** Remap overlays after a structural page operation. */
export function remapOverlays(overlays: OverlayObject[], pageMap: (number | null)[] | null | undefined, transforms?: Record<string, any>): OverlayObject[] {
  if (!pageMap) return overlays;
  const oldToNew = new Map<number, number>();
  pageMap.forEach((old, i) => {
    if (old !== null && old !== undefined && !oldToNew.has(old)) oldToNew.set(old, i);
  });
  let changed = false;
  const out: OverlayObject[] = [];
  for (const o of overlays) {
    const ni = oldToNew.get(o.page);
    if (ni === undefined) {
      changed = true;
      continue; // page deleted
    }
    let obj = o;
    if (ni !== o.page) {
      obj = { ...obj, page: ni };
      changed = true;
    }
    const t = transforms?.[String(o.page)];
    if (t && t.mode !== 'center') {
      const [w1, h1] = t.from;
      const [w2, h2] = t.to;
      let sx = w2 / w1;
      let sy = h2 / h1;
      let ox = 0;
      let oy = 0;
      if (t.mode === 'fit') {
        const s = Math.min(sx, sy);
        ox = (w2 - w1 * s) / 2;
        oy = (h2 - h1 * s) / 2;
        sx = sy = s;
      }
      const tr = (x: number, y: number): [number, number] => [x * sx + ox, y * sy + oy];
      const [a, b] = [tr(obj.rect[0], obj.rect[1]), tr(obj.rect[2], obj.rect[3])];
      obj = { ...obj, rect: [a[0], a[1], b[0], b[1]] } as OverlayObject;
      if (obj.kind === 'line' || obj.kind === 'arrow') obj = { ...obj, points: [tr(...obj.points[0]), tr(...obj.points[1])] };
      changed = true;
    }
    out.push(obj);
  }
  return changed ? out : overlays;
}

function remapVersions(old: number[], info: DocumentInfo): number[] {
  const pm = info.page_map;
  const modified = new Set(info.modified_pages ?? []);
  if (!pm) {
    if (old.length === info.page_count) return old.map((v, i) => (modified.has(i) ? contentCounter++ : v));
    return freshContentIds(info.page_count);
  }
  return pm.map((o, i) => (o === null || o === undefined || modified.has(i) || old[o] === undefined ? contentCounter++ : old[o]));
}

// ----------------------------------------------------------------------
// open / close
// ----------------------------------------------------------------------

export async function openDocument(ref: FileRef): Promise<string | null> {
  const existing = Object.values(useDocuments.getState().docs).find((d) => d.info.original_path === ref.path);
  if (existing) {
    useDocuments.getState().setActive(existing.id);
    return existing.id;
  }
  let password: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      useUi.getState().setBusy({ label: tr("Opening {0}…", ref.name) });
      const info = await call<DocumentInfo>('doc.open', { file: ref.token, ...(password !== undefined ? { password } : {}) });
      addOpened(info);
      import('@/features/forms/service').then((m) => m.announceForm(info.doc_id, info.revision)).catch(() => undefined);
      if (info.repaired) toast('warning', tr("The file was damaged and has been repaired"), tr("Review the document before saving it."));
      if (info.source_encrypted && !info.owner_authenticated)
        toast('info', tr("This document is protected against editing"), tr("Use Protect › Unlock editing with the permissions password to make changes."));
      return info.doc_id;
    } catch (e) {
      if (e instanceof ApiException && (e.code === 'password_required' || e.code === 'invalid_password')) {
        useUi.getState().setBusy(null);
        const pw = await askText({
          title: tr("Password required"),
          message: e.code === 'invalid_password' ? tr("The password is incorrect. Try again.") : tr("\"{0}\" is protected. Enter the password to open it.", ref.name),
          label: tr("Password"),
          password: true,
          okLabel: tr("Open"),
        });
        if (pw === null) return null;
        password = pw;
        continue;
      }
      toast('error', tr("Cannot open {0}", ref.name), errorMessage(e));
      return null;
    } finally {
      useUi.getState().setBusy(null);
    }
  }
  return null;
}

export function addOpened(info: DocumentInfo, extra?: Partial<DocState>) {
  const settings = useUi.getState().settings;
  const tool = settings.defaultEditMode === 'add-text' ? 'add-text' : settings.defaultEditMode;
  useDocuments.getState().addDoc(info, { pageVersions: freshContentIds(info.page_count), tool, ...extra });
  scheduleAnalysis(info.doc_id);
}

async function scheduleAnalysis(id: string) {
  try {
    const res = await call<{ pages: { index: number; scanned: boolean }[] }>('doc.analysis', { doc_id: id });
    const scanned = res.pages.filter((p) => p.scanned).map((p) => p.index);
    useDocuments.getState().update(id, { scannedPages: scanned });
    if (scanned.length && scanned.length === res.pages.length) {
      toast('info', tr("This looks like a scanned document"), tr("Its pages are images. Run OCR (Convert › OCR) to make the text searchable or editable."));
    }
  } catch {
    /* analysis is optional */
  }
}

export async function openFiles(refs: FileRef[]) {
  const pdfs = refs.filter((r) => r.name.toLowerCase().endsWith('.pdf'));
  const images = refs.filter((r) => !r.name.toLowerCase().endsWith('.pdf'));
  for (const r of pdfs) await openDocument(r);
  if (images.length) {
    useUi.getState().openDialog('images-to-pdf', { files: images });
  }
}

export async function openWithDialog() {
  const refs = await bridge().dialog.open('pdfs', tr("Open PDF"));
  if (refs.length) await openFiles(refs);
}

export async function closeDocument(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const d = useDocuments.getState().docs[id];
  if (!d) return true;
  if (!opts.force && isDirty(d)) {
    useDocuments.getState().setActive(id);
    const choice = await bridge().dialog.message({
      type: 'warning',
      title: tr("Unsaved changes"),
      message: tr("Save changes to \"{0}\" before closing?", d.info.display_name),
      detail: tr("Your changes will be lost if you don’t save them."),
      buttons: [tr("Save"), tr("Don’t Save"), tr("Cancel")],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 2) return false;
    if (choice === 0) {
      const ok = await save(id);
      if (!ok) return false;
    }
  }
  // release the viewer first so no late page/thumbnail request hits a deleted session
  releasePdf(id);
  useDocuments.getState().removeDoc(id);
  try {
    await call('doc.close', { doc_id: id, delete_session: true });
  } catch {
    /* the session folder is cleaned on next start anyway */
  }
  return true;
}

export async function closeAll(): Promise<boolean> {
  for (const id of [...useDocuments.getState().order]) {
    const ok = await closeDocument(id);
    if (!ok) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// mutations & history
// ----------------------------------------------------------------------

/** Apply new backend document info (after a mutation, undo, redo). */
export function applyInfo(id: string, info: DocumentInfo, overlays?: OverlayObject[], pageVersions?: number[]) {
  useDocuments.getState().update(id, (d) => {
    const pv = pageVersions ?? remapVersions(d.pageVersions, info);
    const ov = overlays ?? remapOverlays(d.overlays, info.page_map, (info as any).transforms);
    const selIds = new Set(ov.map((o) => o.id));
    return {
      info: { ...d.info, ...info, save_token: undefined },
      saveToken: (info as any).save_token ?? d.saveToken,
      pageVersions: pv,
      overlays: ov,
      currentPage: Math.min(d.currentPage, info.page_count - 1),
      selectedPages: d.selectedPages.filter((p) => p < info.page_count),
      selection: d.selection.kind === 'overlay' ? { ...d.selection, ids: d.selection.ids.filter((x) => selIds.has(x)) } : { kind: 'none', ids: [] },
      dataVersion: d.dataVersion + 1,
    };
  });
}

const warnedSigned = new Set<string>();
/** Changing a digitally signed document invalidates its signatures: say so once. */
export function warnIfSigned(id: string) {
  const d = useDocuments.getState().docs[id];
  if (d?.info.has_signatures && !warnedSigned.has(id)) {
    warnedSigned.add(id);
    toast('warning', tr("This document is digitally signed"), tr("Saving changes will invalidate the existing signatures."));
  }
}

/** Run a backend mutation as an undoable command. */
export async function runOp<T extends DocumentInfo = DocumentInfo>(id: string, label: string, op: string, payload: Record<string, unknown> = {}, opts: { silent?: boolean } = {}): Promise<T | null> {
  const d = getDoc(id);
  const before = snapshot(d);
  warnIfSigned(id);
  useDocuments.getState().update(id, { busy: label });
  try {
    const info = await call<T>(op, { doc_id: id, base_revision: d.info.revision, ...payload });
    applyInfo(id, info);
    const after = snapshot(getDoc(id));
    pushHistory(id, { label, before, after, ts: Date.now() });
    return info;
  } catch (e) {
    if (!opts.silent) toast('error', tr("{0} failed", label), errorMessage(e));
    if (e instanceof ApiException && e.code === 'revision_conflict') await refreshInfo(id);
    return null;
  } finally {
    useDocuments.getState().update(id, { busy: null });
  }
}

export async function refreshInfo(id: string) {
  const info = await call<DocumentInfo>('doc.info', { doc_id: id });
  applyInfo(id, { ...info, page_map: null, modified_pages: null }, undefined, getDoc(id).info.page_count === info.page_count ? undefined : freshContentIds(info.page_count));
}

/** Commit a change of the overlay model as one undoable command. */
export function commitOverlays(id: string, label: string, next: OverlayObject[], before?: OverlayObject[]) {
  const d = getDoc(id);
  warnIfSigned(id);
  const beforeSnap: Snapshot = { ...snapshot(d), overlays: before ?? d.overlays };
  useDocuments.getState().update(id, { overlays: next });
  pushHistory(id, { label, before: beforeSnap, after: { ...beforeSnap, overlays: next }, ts: Date.now() });
}

/** Update overlays without creating history (live drag); finish with commitOverlays. */
export function setOverlaysTransient(id: string, next: OverlayObject[]) {
  useDocuments.getState().update(id, { overlays: next });
}

async function restore(id: string, snap: Snapshot): Promise<boolean> {
  const d = getDoc(id);
  if (snap.revision !== d.info.revision) {
    if (!d.info.revisions.includes(snap.revision)) {
      toast('warning', tr("This step can no longer be undone"), tr("Older history was trimmed to save disk space."));
      return false;
    }
    const info = await call<DocumentInfo>('doc.revision', { doc_id: id, revision: snap.revision });
    applyInfo(id, { ...info, page_map: null, modified_pages: null }, snap.overlays, snap.pageVersions.length === info.page_count ? snap.pageVersions : freshContentIds(info.page_count));
  } else {
    useDocuments.getState().update(id, (cur) => ({
      overlays: snap.overlays,
      selection: { kind: cur.selection.kind, ids: cur.selection.ids.filter((x) => snap.overlays.some((o) => o.id === x)) },
    }));
  }
  return true;
}

let historyBusy = false;

export async function undo(id = activeDoc()?.id) {
  if (!id || historyBusy) return;
  const d = getDoc(id);
  const entry = d.undo[d.undo.length - 1];
  if (!entry) return;
  historyBusy = true;
  try {
    const ok = await restore(id, entry.before);
    useDocuments.getState().update(id, (cur) => ({
      undo: cur.undo.slice(0, -1),
      redo: ok ? [...cur.redo, entry] : cur.redo,
    }));
  } catch (e) {
    toast('error', tr("Undo failed"), errorMessage(e));
  } finally {
    historyBusy = false;
  }
}

export async function redo(id = activeDoc()?.id) {
  if (!id || historyBusy) return;
  const d = getDoc(id);
  const entry = d.redo[d.redo.length - 1];
  if (!entry) return;
  historyBusy = true;
  try {
    const ok = await restore(id, entry.after);
    useDocuments.getState().update(id, (cur) => ({
      redo: cur.redo.slice(0, -1),
      undo: ok ? [...cur.undo, entry] : cur.undo,
    }));
  } catch (e) {
    toast('error', tr("Redo failed"), errorMessage(e));
  } finally {
    historyBusy = false;
  }
}

// ----------------------------------------------------------------------
// saving
// ----------------------------------------------------------------------

export async function save(id = activeDoc()?.id): Promise<boolean> {
  if (!id) return false;
  const d = getDoc(id);
  if (!d.saveToken || !d.info.original_path) return saveAs(id);
  return saveTo(id, d.saveToken);
}

export async function saveAs(id = activeDoc()?.id): Promise<boolean> {
  if (!id) return false;
  const d = getDoc(id);
  const ref = await bridge().dialog.save('pdf', d.info.display_name.toLowerCase().endsWith('.pdf') ? d.info.display_name : tr("{0}.pdf", d.info.display_name), tr("Save PDF As"));
  if (!ref) return false;
  return saveTo(id, ref.token);
}

async function saveTo(id: string, token: string): Promise<boolean> {
  const d = getDoc(id);
  const overlaysAtSave = d.overlays;
  useUi.getState().setBusy({ label: tr("Saving {0}…", d.info.display_name) });
  try {
    const res = await call<{ path: string; size: number; info: DocumentInfo }>('doc.save', {
      doc_id: id,
      target: token,
      overlays: prepareForSave(overlaysAtSave) as unknown as Record<string, unknown>[],
      make_backup: useUi.getState().settings.makeBackups,
    });
    useDocuments.getState().update(id, (cur) => ({
      info: { ...cur.info, ...res.info, save_token: undefined },
      saveToken: (res.info as any).save_token ?? cur.saveToken,
      savedRevision: res.info.saved_revision,
      savedOverlays: overlaysAtSave,
    }));
    toast('success', tr("Saved"), res.path);
    persistUiState(id);
    return true;
  } catch (e) {
    toast('error', tr("Save failed – your original file was not changed"), errorMessage(e));
    return false;
  } finally {
    useUi.getState().setBusy(null);
  }
}

// ----------------------------------------------------------------------
// recovery state (autosave)
// ----------------------------------------------------------------------

export async function persistUiState(id: string) {
  const d = useDocuments.getState().docs[id];
  if (!d) return;
  try {
    await call('doc.uiState', {
      doc_id: id,
      state: {
        overlays: d.overlays,
        currentPage: d.currentPage,
        zoom: d.zoom,
        zoomMode: d.zoomMode,
        viewMode: d.viewMode,
        savedRevision: d.savedRevision,
        overlaysSaved: d.overlays === d.savedOverlays,
        ts: Date.now(),
      },
    });
  } catch {
    /* best effort */
  }
}

let autosaveTimer: number | undefined;
const lastPersisted = new Map<string, unknown>();

export function startAutosave() {
  window.clearInterval(autosaveTimer);
  const s = useUi.getState().settings;
  if (!s.autosaveEnabled) return;
  autosaveTimer = window.setInterval(() => {
    for (const d of Object.values(useDocuments.getState().docs)) {
      const key = d.overlays;
      if (lastPersisted.get(d.id) !== key || isDirty(d)) {
        lastPersisted.set(d.id, key);
        persistUiState(d.id);
      }
    }
  }, Math.max(5, s.autosaveIntervalSec) * 1000);
}

export async function recoverSession(sessionId: string): Promise<boolean> {
  try {
    const info = await call<DocumentInfo & { ui_state?: any }>('recovery.restore', { session_id: sessionId });
    const st = info.ui_state ?? {};
    const overlays: OverlayObject[] = Array.isArray(st.overlays) ? st.overlays : [];
    addOpened(info, {
      overlays,
      savedOverlays: st.overlaysSaved ? overlays : [],
      savedRevision: info.saved_revision,
      currentPage: Number.isInteger(st.currentPage) ? Math.min(st.currentPage, info.page_count - 1) : 0,
      zoom: typeof st.zoom === 'number' ? st.zoom : 1,
      zoomMode: st.zoomMode ?? 'fit-width',
      viewMode: st.viewMode ?? 'continuous',
    });
    return true;
  } catch (e) {
    toast('error', tr("Recovery failed"), errorMessage(e));
    return false;
  }
}
