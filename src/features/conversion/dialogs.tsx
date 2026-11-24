/* OCR, conversion and compression dialogs. */
import { useEffect, useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { DocumentInfo } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckRow, Input, Label, NumberInput, RadioGroup, Select } from '@/components/ui/controls';
import { bridge, call, errorMessage } from '@/lib/api';
import { cn, formatBytes, parsePageRanges, stripExt } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { applyInfo, snapshot } from '@/services/docService';
import { JobCancelled, disposeJob, runJob } from '@/services/jobs';
import { tr } from '@/i18n';

function useDoc(): DocState | null {
  return useDocuments((s) => (s.activeId ? s.docs[s.activeId] : null));
}

function PageScope({ doc, value, onChange, allowScanned }: { doc: DocState; value: { mode: string; range: string }; onChange: (v: { mode: string; range: string }) => void; allowScanned?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label>{tr("Pages")}</Label>
      <RadioGroup
        value={value.mode}
        onValueChange={(mode) => onChange({ ...value, mode })}
        options={[
          { value: 'all', label: tr("All pages ({0})", doc.info.page_count) },
          { value: 'current', label: tr("Current page ({0})", doc.currentPage + 1) },
          ...(allowScanned ? [{ value: 'scanned', label: tr("Scanned pages only ({0})", doc.scannedPages.length), disabled: !doc.scannedPages.length }] : []),
          { value: 'range', label: tr("Pages:") },
        ]}
      />
      {value.mode === 'range' && <Input value={value.range} onChange={(e) => onChange({ ...value, range: e.target.value })} placeholder="e.g. 1-3, 5" />}
    </div>
  );
}

function resolvePages(doc: DocState, v: { mode: string; range: string }): number[] | null | undefined {
  if (v.mode === 'all') return undefined;
  if (v.mode === 'current') return [doc.currentPage];
  if (v.mode === 'scanned') return doc.scannedPages;
  return parsePageRanges(v.range, doc.info.page_count);
}

// ---------------------------------------------------------------- OCR
interface OcrLine { id: string; text: string; conf: number; bbox: number[] }
interface OcrPage { index: number; lines: OcrLine[]; mean_conf: number; text: string }

export function OcrDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const settings = useUi((s) => s.settings);
  const [lang, setLang] = useState(settings.ocrLanguage || 'tha+eng');
  const [dpi, setDpi] = useState(String(settings.ocrDpi || 300));
  const [scope, setScope] = useState({ mode: doc?.scannedPages.length ? 'scanned' : 'all', range: '' });
  const [result, setResult] = useState<{ jobId: string; pages: OcrPage[] } | null>(null);
  const [caps, setCaps] = useState<any>(null);
  useEffect(() => {
    call('app.capabilities').then(setCaps).catch(() => undefined);
  }, []);
  if (!doc) return null;
  const run = async () => {
    const pages = resolvePages(doc, scope);
    if (pages === null) return toast('error', tr("Invalid page range"));
    try {
      const j = await runJob<{ pages: OcrPage[] }>('ocr', tr("Recognising text"), doc.id, { language: lang, dpi: parseInt(dpi, 10), ...(pages ? { pages } : {}) });
      setResult({ jobId: j.job_id, pages: j.result.pages });
    } catch (e) {
      if (!(e instanceof JobCancelled)) toast('error', tr("OCR failed"), errorMessage(e));
    }
  };
  const apply = async () => {
    if (!result) return;
    const before = snapshot(doc);
    try {
      useUi.getState().setBusy({ label: tr("Adding searchable text layer…") });
      const info = await call<DocumentInfo & { lines_written: number }>('ocr.apply', { doc_id: doc.id, job_id: result.jobId, pages: result.pages as unknown as Record<string, unknown>[], base_revision: doc.info.revision });
      applyInfo(doc.id, info);
      const after = snapshot(useDocuments.getState().docs[doc.id]);
      useDocuments.getState().update(doc.id, (d) => ({ undo: [...d.undo, { label: tr("Make searchable (OCR)"), before, after, ts: Date.now() }], redo: [], scannedPages: d.scannedPages.filter((p) => !result.pages.some((r) => r.index === p)) }));
      toast('success', tr("Text recognised on {0} page(s)", result.pages.length), tr("The document is now searchable. The scan itself is unchanged."));
      disposeJob(result.jobId);
      onClose();
    } catch (e) {
      toast('error', tr("Could not add the text layer"), errorMessage(e));
    } finally {
      useUi.getState().setBusy(null);
    }
  };
  const edit = (pi: number, li: number, text: string) =>
    setResult((r) => r && { ...r, pages: r.pages.map((p, i) => (i === pi ? { ...p, lines: p.lines.map((l, j) => (j === li ? { ...l, text } : l)) } : p)) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide className={result ? 'max-w-4xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{tr("Recognise text (OCR)")}</DialogTitle>
          <DialogDescription>{tr("Text recognition runs on this computer with Tesseract. Images and text are never uploaded.")}</DialogDescription>
        </DialogHeader>
        {!result ? (
          <>
            {caps && !caps.ocr?.available && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[12px]">{tr("The OCR engine was not found. Reinstall the application to restore it.")}</div>}
            <div className="grid grid-cols-2 gap-4">
              <PageScope doc={doc} value={scope} onChange={setScope} allowScanned />
              <div className="space-y-3">
                <div className="space-y-1"><Label>{tr("Language")}</Label><Select value={lang} onValueChange={setLang} options={[{ value: 'tha+eng', label: tr("Thai + English") }, { value: 'tha', label: tr("Thai") }, { value: 'eng', label: tr("English") }]} /></div>
                <div className="space-y-1"><Label>{tr("Quality")}</Label><Select value={dpi} onValueChange={setDpi} options={[{ value: '200', label: tr("Fast (200 dpi)") }, { value: '300', label: tr("Standard (300 dpi)") }, { value: '400', label: tr("Best (400 dpi)") }]} /></div>
                {caps?.ocr?.languages && <div className="text-[11px] text-muted-foreground">{tr("Installed language data:")} {caps.ocr.languages.join(', ')}</div>}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
              <Button onClick={run} disabled={caps && !caps.ocr?.available} data-testid="ocr-run">{tr("Recognise text")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="text-[12px] text-muted-foreground">{tr("Review the recognised text. Lines with low confidence are highlighted; correct them before accepting. Corrections become the searchable text.")}</div>
            <div className="max-h-[55vh] overflow-auto rounded-md border" data-testid="ocr-review">
              {result.pages.map((p, pi) => (
                <div key={p.index} className="border-b last:border-0">
                  <div className="sticky top-0 flex justify-between bg-muted px-2 py-1 text-[11.5px] font-semibold">
                    <span>{tr("Page")} {p.index + 1}</span>
                    <span className={cn(p.mean_conf >= 85 ? 'text-success' : p.mean_conf >= 60 ? 'text-warning' : 'text-destructive')}>{tr("Confidence")} {p.mean_conf}%</span>
                  </div>
                  {!p.lines.length && <div className="px-2 py-2 text-[12px] text-muted-foreground">{tr("No text found on this page.")}</div>}
                  {p.lines.map((l, li) => (
                    <div key={l.id} className="flex items-center gap-2 px-2 py-0.5">
                      <span className={cn('w-10 shrink-0 text-right text-[10.5px] tabular-nums', l.conf >= 85 ? 'text-success' : l.conf >= 60 ? 'text-warning' : 'text-destructive')}>{Math.round(l.conf)}%</span>
                      <Input value={l.text} onChange={(e) => edit(pi, li, e.target.value)} className={cn(l.conf < 60 && 'border-destructive/50 bg-destructive/5')} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResult(null)}>{tr("Back")}</Button>
              <Button variant="outline" onClick={onClose}>{tr("Discard")}</Button>
              <Button onClick={apply} data-testid="ocr-accept">{tr("Accept – make searchable")}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- conversion
const CONVERSIONS: Record<string, { title: string; ext?: 'docx' | 'xlsx' | 'pptx' | 'txt'; folder?: boolean; note: string }> = {
  docx: { title: 'Convert to Word', ext: 'docx', note: 'Text, paragraphs, tables and images are reconstructed. Complex layouts (multiple columns, floating graphics, forms) may need manual adjustment in Word.' },
  xlsx: { title: 'Convert to Excel', ext: 'xlsx', note: 'Tables are detected automatically and placed on separate sheets; pages without tables are exported as rows of text. Merged cells and formulas are not reconstructed.' },
  pptx: { title: 'Convert to PowerPoint', ext: 'pptx', note: 'Each page becomes a slide. With editable text, text boxes are placed over a background picture of the page; fonts not installed in PowerPoint are substituted.' },
  images: { title: 'Convert to Images', folder: true, note: 'Each page is rendered to an image file.' },
  text: { title: 'Extract Text', ext: 'txt', note: 'Plain UTF-8 text in reading order. Scanned pages need OCR first.' },
  'extract-images': { title: 'Extract Images', folder: true, note: 'Embedded images are saved in their original format where possible.' },
};

export function ConvertDialog({ onClose, mode }: { onClose: () => void; mode: string }) {
  const doc = useDoc();
  const raw = CONVERSIONS[mode];
  const conf = { ...raw, title: tr(raw.title), note: tr(raw.note) };
  const [scope, setScope] = useState({ mode: 'all', range: '' });
  const [fmt, setFmt] = useState<'png' | 'jpg'>('png');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(90);
  const [editable, setEditable] = useState(true);
  if (!doc || !conf) return null;
  const run = async () => {
    const pages = resolvePages(doc, scope);
    if (pages === null) return toast('error', tr("Invalid page range"));
    let target;
    if (conf.folder) target = await bridge().dialog.folder(tr("{0}: choose a folder", conf.title));
    else target = await bridge().dialog.save(conf.ext!, `${stripExt(doc.info.display_name)}.${conf.ext}`, conf.title);
    if (!target) return;
    const params: Record<string, unknown> = { mode: mode === 'images' ? fmt : mode, ...(pages ? { pages } : {}) };
    if (conf.folder) params.output_dir_token = target.token;
    else params.output_out_token = target.token;
    if (mode === 'images') Object.assign(params, { dpi, quality });
    if (mode === 'pptx') Object.assign(params, { editable });
    try {
      const j = await runJob<any>('convert', conf.title, doc.id, params);
      const count = j.result?.files?.length ?? j.result?.count;
      toast('success', tr("{0}: done", conf.title), count !== undefined ? tr("{0} file(s) in {1}", count, target.path) : target.path);
      bridge().app.showItemInFolder(target.token);
      disposeJob(j.job_id);
      onClose();
    } catch (e) {
      if (!(e instanceof JobCancelled)) toast('error', tr("{0} failed", conf.title), errorMessage(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{conf.title}</DialogTitle>
          <DialogDescription>{tr("Converted locally on this computer.")}</DialogDescription>
        </DialogHeader>
        <PageScope doc={doc} value={scope} onChange={setScope} />
        {mode === 'images' && (
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1"><Label>{tr("Format")}</Label><Select value={fmt} onValueChange={(v) => setFmt(v as 'png' | 'jpg')} options={[{ value: 'png', label: tr("PNG (lossless)") }, { value: 'jpg', label: tr("JPEG") }]} /></div>
            <div className="space-y-1"><Label>{tr("Resolution")}</Label><Select value={String(dpi)} onValueChange={(v) => setDpi(parseInt(v, 10))} options={[72, 96, 150, 200, 300, 600].map((d) => ({ value: String(d), label: tr("{0} dpi", d) }))} /></div>
            {fmt === 'jpg' && <div className="space-y-1"><Label>{tr("Quality")}</Label><NumberInput value={quality} onChange={(v) => setQuality(Math.round(v))} min={30} max={100} suffix="%" /></div>}
          </div>
        )}
        {mode === 'pptx' && <CheckRow checked={editable} onChange={setEditable} label={tr("Editable text")} hint={tr("Off: each slide is an exact picture of the page")} />}
        <p className="rounded-md bg-muted p-2 text-[11.5px] text-muted-foreground">{conf.note}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={run} data-testid="convert-run">{conf.folder ? <><FolderOpen className="h-3.5 w-3.5" /> {tr("Choose folder & convert")}</> : tr("Convert…")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- compression
const PRESETS = [
  { value: 'low', label: 'Low compression', hint: 'Lossless: removes duplicate objects and compresses the file structure. Quality unchanged.' },
  { value: 'recommended', label: 'Recommended', hint: 'Images above 150 dpi are reduced to 150 dpi (JPEG quality 75); fonts are subset. Best for sharing.' },
  { value: 'high', label: 'High compression', hint: 'Images reduced to 96 dpi (JPEG quality 55), metadata removed. Smallest file; images visibly softer.' },
];

export function CompressDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [preset, setPreset] = useState('recommended');
  const [res, setRes] = useState<{ jobId: string; original_size: number; new_size: number; no_gain: boolean } | null>(null);
  const pct = useMemo(() => (res ? Math.round((1 - res.new_size / res.original_size) * 100) : 0), [res]);
  if (!doc) return null;
  const analyse = async () => {
    try {
      const j = await runJob<any>('compress', tr("Compressing"), doc.id, { preset });
      setRes({ jobId: j.job_id, ...j.result });
    } catch (e) {
      if (!(e instanceof JobCancelled)) toast('error', tr("Compression failed"), errorMessage(e));
    }
  };
  const applyToDoc = async () => {
    if (!res) return;
    const before = snapshot(doc);
    try {
      const info = await call<DocumentInfo>('candidate.commit', { doc_id: doc.id, job_id: res.jobId, base_revision: doc.info.revision });
      applyInfo(doc.id, info);
      const after = snapshot(useDocuments.getState().docs[doc.id]);
      useDocuments.getState().update(doc.id, (d) => ({ undo: [...d.undo, { label: tr("Compress document"), before, after, ts: Date.now() }], redo: [] }));
      toast('success', tr("Compressed to {0}", formatBytes(res.new_size)), tr("Save the document to keep the smaller file."));
      onClose();
    } catch (e) {
      toast('error', tr("Could not apply"), errorMessage(e));
    }
  };
  const saveCopy = async () => {
    if (!res) return;
    const ref = await bridge().dialog.save('pdf', tr("{0}_compressed.pdf", stripExt(doc.info.display_name)), tr("Save compressed copy"));
    if (!ref) return;
    try {
      await call('candidate.saveAs', { doc_id: doc.id, job_id: res.jobId, target: ref.token });
      toast('success', tr("Compressed copy saved"), ref.path);
      onClose();
    } catch (e) {
      toast('error', tr("Could not save"), errorMessage(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Compress PDF")}</DialogTitle>
          <DialogDescription>{tr("Current size:")} {formatBytes(doc.info.file_size)}{doc.overlays.length ? tr(" (unsaved objects are not included)") : ''}{tr(". Your original file is not changed.")}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={preset} onValueChange={(v) => { setPreset(v); setRes(null); }} options={PRESETS} />
        {res && (
          <div className="rounded-md border p-3 text-[12.5px]" data-testid="compress-result">
            {res.no_gain ? (
              <span>{tr("This document is already well optimised – no further reduction is possible with this preset.")}</span>
            ) : (
              <span>
                <b>{formatBytes(res.original_size)}</b> → <b className="text-success">{formatBytes(res.new_size)}</b> ({pct}{tr("% smaller)")}
              </span>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          {!res ? (
            <Button onClick={analyse} data-testid="compress-run">{tr("Compress")}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={saveCopy} disabled={res.no_gain}>{tr("Save as copy…")}</Button>
              <Button onClick={applyToDoc} disabled={res.no_gain} data-testid="compress-apply">{tr("Apply to document")}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
