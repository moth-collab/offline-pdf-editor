/* Page / document organisation dialogs. */
import { useEffect, useMemo, useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DocumentInfo, FileRef } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NumberInput, RadioGroup, Select } from '@/components/ui/controls';
import { bridge, call, errorMessage, ApiException } from '@/lib/api';
import { formatBytes, formatRanges, parsePageRanges, stripExt } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { ThumbnailGrid } from './ThumbnailsPanel';
import { toast, useUi } from '@/stores/ui';
import { askText } from '@/stores/prompt';
import { addOpened, runOp } from '@/services/docService';
import { movePagesToDocument, targetPages } from '@/app/pageCommands';
import { tr } from '@/i18n';

const SIZES: Record<string, [number, number] | null> = {
  same: null,
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};

function useDoc(): DocState | null {
  return useDocuments((s) => (s.activeId ? s.docs[s.activeId] : null));
}

function PagesField({ doc, value, onChange }: { doc: DocState; value: string; onChange: (v: string) => void }) {
  const parsed = parsePageRanges(value, doc.info.page_count);
  return (
    <div className="space-y-1">
      <Label>{tr("Pages (e.g. 1-3, 5)")}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className={value && !parsed ? 'border-destructive' : ''} />
      <div className="text-[11px] text-muted-foreground">{parsed ? tr("{0} of {1} pages", parsed.length, doc.info.page_count) : tr("Enter page numbers between 1 and {0}", doc.info.page_count)}</div>
    </div>
  );
}

const SIDE_LABEL = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' } as const;

export function InsertBlankDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [where, setWhere] = useState('after');
  const [size, setSize] = useState('same');
  const [orientation, setOrientation] = useState('portrait');
  const [count, setCount] = useState(1);
  if (!doc) return null;
  const submit = async () => {
    const at = where === 'before' ? doc.currentPage : where === 'start' ? 0 : where === 'end' ? doc.info.page_count : doc.currentPage + 1;
    let dims = SIZES[size];
    if (dims && orientation === 'landscape') dims = [dims[1], dims[0]];
    const res = await runOp(doc.id, tr("Insert blank page"), 'pages.insertBlank', { at, count, ...(dims ? { width: dims[0], height: dims[1] } : {}) });
    if (res) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Insert blank pages")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>{tr("Position")}</Label>
            <RadioGroup value={where} onValueChange={setWhere} options={[
              { value: 'after', label: tr("After current page ({0})", doc.currentPage + 1) },
              { value: 'before', label: tr("Before current page") },
              { value: 'start', label: tr("At the beginning") },
              { value: 'end', label: tr("At the end") },
            ]} />
          </div>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>{tr("Page size")}</Label>
              <Select value={size} onValueChange={setSize} options={Object.keys(SIZES).map((k) => ({ value: k, label: k === 'same' ? tr("Same as current page") : k }))} />
            </div>
            <div className="space-y-1">
              <Label>{tr("Orientation")}</Label>
              <Select value={orientation} onValueChange={setOrientation} options={[{ value: 'portrait', label: tr("Portrait") }, { value: 'landscape', label: tr("Landscape") }]} disabled={size === 'same'} />
            </div>
            <div className="space-y-1">
              <Label>{tr("Number of pages")}</Label>
              <NumberInput value={count} onChange={(v) => setCount(Math.round(v))} min={1} max={500} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit}>{tr("Insert")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MovePagesDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const docs = useDocuments((s) => s.docs);
  const order = useDocuments((s) => s.order);
  const [pages, setPages] = useState(() => (doc ? formatRanges(targetPages(doc)) : ''));
  const [target, setTarget] = useState(() => doc?.id ?? '');
  const [position, setPosition] = useState(1);
  if (!doc) return null;
  const tdoc = docs[target];
  const parsed = parsePageRanges(pages, doc.info.page_count);
  const submit = async () => {
    if (!parsed || !tdoc) return;
    if (tdoc.id === doc.id) {
      const rest = doc.info.page_count - parsed.length;
      const to = Math.max(0, Math.min(rest, position - 1 - parsed.filter((p) => p < position - 1).length));
      await runOp(doc.id, tr("Move pages"), 'pages.move', { pages: parsed, to });
    } else {
      await movePagesToDocument(doc, tdoc.id, parsed, Math.max(0, Math.min(tdoc.info.page_count, position - 1)));
    }
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Move pages")}</DialogTitle>
          <DialogDescription>{tr("Move pages within this document or into another open document.")}</DialogDescription>
        </DialogHeader>
        <PagesField doc={doc} value={pages} onChange={setPages} />
        <div className="space-y-1">
          <Label>{tr("Destination document")}</Label>
          <Select value={target} onValueChange={setTarget} options={order.map((id) => ({ value: id, label: docs[id].info.display_name + (id === doc.id ? ' (this document)' : '') }))} />
        </div>
        <div className="space-y-1">
          <Label>{tr("Insert before page (1 –")} {(tdoc?.info.page_count ?? 0) + 1})</Label>
          <NumberInput value={position} onChange={(v) => setPosition(Math.round(v))} min={1} max={(tdoc?.info.page_count ?? 0) + 1} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} disabled={!parsed || !tdoc}>{tr("Move")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CropDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [pages, setPages] = useState(() => (doc ? formatRanges(targetPages(doc)) : ''));
  const [m, setM] = useState({ left: 36, right: 36, top: 36, bottom: 36 });
  if (!doc) return null;
  const parsed = parsePageRanges(pages, doc.info.page_count);
  const p = doc.info.pages[parsed?.[0] ?? doc.currentPage];
  const run = async (reset: boolean) => {
    if (!parsed) return;
    const res = await runOp(doc.id, reset ? tr("Reset crop") : tr("Crop pages"), 'pages.crop', reset ? { pages: parsed, reset: true } : { pages: parsed, margins: [m.left, m.bottom, m.right, m.top] });
    if (res) onClose();
  };
  const W = 150;
  const H = (W * p.height) / p.width;
  const s = W / p.width;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Crop pages")}</DialogTitle>
          <DialogDescription>{tr("Margins are measured inward from the current visible page area, in points (72 pt = 1 inch). Cropping hides content but does not delete it.")}</DialogDescription>
        </DialogHeader>
        <PagesField doc={doc} value={pages} onChange={setPages} />
        <div className="flex gap-4">
          <div className="grid flex-1 grid-cols-2 gap-2">
            {(['left', 'right', 'top', 'bottom'] as const).map((k) => (
              <div key={k} className="space-y-1">
                <Label>{tr(SIDE_LABEL[k])}</Label>
                <NumberInput value={m[k]} onChange={(v) => setM({ ...m, [k]: v })} min={0} max={2000} suffix="pt" />
              </div>
            ))}
          </div>
          <div className="relative border bg-white" style={{ width: W, height: H }}>
            <div className="absolute border-2 border-dashed border-primary bg-primary/5" style={{ left: m.left * s, right: m.right * s, top: m.top * s, bottom: m.bottom * s }} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => run(true)}>{tr("Remove crop")}</Button>
          <span className="flex-1" />
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={() => run(false)} disabled={!parsed}>{tr("Crop")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResizeDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [pages, setPages] = useState(() => (doc ? formatRanges(targetPages(doc)) : ''));
  const [size, setSize] = useState('A4');
  const [landscape, setLandscape] = useState(false);
  const [mode, setMode] = useState('fit');
  if (!doc) return null;
  const parsed = parsePageRanges(pages, doc.info.page_count);
  const submit = async () => {
    const dims = SIZES[size]!;
    const [w, h] = landscape ? [dims[1], dims[0]] : dims;
    const res = await runOp(doc.id, tr("Resize pages"), 'pages.resize', { pages: parsed, width: w, height: h, mode });
    if (res) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Resize pages")}</DialogTitle>
          <DialogDescription>{tr("The page content is scaled into the new page size. Text stays searchable.")}</DialogDescription>
        </DialogHeader>
        <PagesField doc={doc} value={pages} onChange={setPages} />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{tr("Size")}</Label>
            <Select value={size} onValueChange={setSize} options={Object.keys(SIZES).filter((k) => k !== 'same').map((k) => ({ value: k, label: k }))} />
          </div>
          <div className="space-y-1">
            <Label>{tr("Orientation")}</Label>
            <Select value={landscape ? 'l' : 'p'} onValueChange={(v) => setLandscape(v === 'l')} options={[{ value: 'p', label: tr("Portrait") }, { value: 'l', label: tr("Landscape") }]} />
          </div>
        </div>
        <RadioGroup value={mode} onValueChange={setMode} options={[
          { value: 'fit', label: tr("Scale to fit (keep proportions)") },
          { value: 'stretch', label: tr("Stretch to fill") },
          { value: 'center', label: tr("Do not scale (center)") },
        ]} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} disabled={!parsed}>{tr("Resize")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExtractDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [pages, setPages] = useState(() => (doc ? formatRanges(targetPages(doc)) : ''));
  const [remove, setRemove] = useState(false);
  if (!doc) return null;
  const parsed = parsePageRanges(pages, doc.info.page_count);
  const submit = async () => {
    if (!parsed) return;
    const ref = await bridge().dialog.save('pdf', tr("{0}_pages {1}.pdf", stripExt(doc.info.display_name), formatRanges(parsed).replace(/,\s*/g, '_')), tr("Save extracted pages"));
    if (!ref) return;
    try {
      const r = await call<{ path: string; pages: number; size: number }>('pages.extract', { doc_id: doc.id, pages: parsed, target: ref.token });
      toast('success', tr("Extracted {0} pages", r.pages), `${r.path} (${formatBytes(r.size)})`);
      if (remove && parsed.length < doc.info.page_count) await runOp(doc.id, tr("Remove extracted pages"), 'pages.delete', { pages: parsed });
      onClose();
    } catch (e) {
      toast('error', tr("Extraction failed"), errorMessage(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Extract pages")}</DialogTitle>
          <DialogDescription>{tr("Save the selected pages as a new PDF file.")}</DialogDescription>
        </DialogHeader>
        <PagesField doc={doc} value={pages} onChange={setPages} />
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> {tr("Delete the pages from this document after extracting")}
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} disabled={!parsed}>{tr("Extract…")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MergeItem {
  id: string;
  ref: FileRef;
  password?: string;
  pages: string;
}

function SortableRow({ item, onRemove, onPages }: { item: MergeItem; onRemove: () => void; onPages: (v: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="flex items-center gap-2 border-b bg-background px-2 py-1.5">
      <button {...attributes} {...listeners} className="cursor-grab text-muted-foreground" aria-label={tr("Drag to reorder")}>
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px]">{item.ref.name}</div>
        <div className="truncate text-[10.5px] text-muted-foreground">{item.ref.path} · {formatBytes(item.ref.size)}{item.password ? tr(" · password set") : ''}</div>
      </div>
      <Input value={item.pages} onChange={(e) => onPages(e.target.value)} placeholder={tr("All pages")} className="w-28" title={tr("Pages to include, e.g. 1-3, 5 (empty = all)")} />
      <button className="rounded p-1 hover:bg-muted" onClick={onRemove} aria-label={tr("Remove")}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function MergeDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<MergeItem[]>([]);
  const [name, setName] = useState('Merged.pdf');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const add = async () => {
    const refs = await bridge().dialog.open('pdfs', tr("Choose PDF files to merge"));
    setItems((cur) => [...cur, ...refs.map((r) => ({ id: r.token, ref: r, pages: '' }))]);
  };
  const submit = async () => {
    const payload: { file: string; password?: string; pages?: number[] }[] = [];
    for (const it of items) {
      let pages: number[] | undefined;
      if (it.pages.trim()) {
        const parsed = parsePageRanges(it.pages, 100000);
        if (!parsed) {
          toast('error', tr("Invalid page range for {0}", it.ref.name));
          return;
        }
        pages = parsed;
      }
      payload.push({ file: it.ref.token, ...(it.password ? { password: it.password } : {}), ...(pages ? { pages } : {}) });
    }
    useUi.getState().setBusy({ label: tr("Merging {0} files…", items.length) });
    try {
      const info = await call<DocumentInfo>('doc.merge', { items: payload, display_name: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf` });
      addOpened(info);
      toast('success', tr("Merged {0} files ({1} pages)", items.length, info.page_count), tr("Use Save As to store the merged document."));
      onClose();
    } catch (e) {
      if (e instanceof ApiException && e.code === 'password_required') {
        const path = (e.details as any)?.path;
        const it = items.find((x) => x.ref.path === path);
        if (it) {
          useUi.getState().setBusy(null);
          const pw = await askText({ title: tr("Password required"), message: tr("\"{0}\" is protected. Enter its password.", it.ref.name), password: true, label: tr("Password"), okLabel: tr("OK") });
          if (pw !== null) setItems((cur) => cur.map((x) => (x.id === it.id ? { ...x, password: pw } : x)));
          return;
        }
      }
      toast('error', tr("Merge failed"), errorMessage(e));
    } finally {
      useUi.getState().setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr("Merge files")}</DialogTitle>
          <DialogDescription>{tr("Combine several PDF files into one new document. Drag rows to change the order.")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] min-h-[140px] overflow-auto rounded-md border">
          {!items.length && <div className="p-6 text-center text-[12px] text-muted-foreground">{tr("No files added yet.")}</div>}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => {
            if (!e.over || e.active.id === e.over.id) return;
            setItems((cur) => arrayMove(cur, cur.findIndex((x) => x.id === e.active.id), cur.findIndex((x) => x.id === e.over!.id)));
          }}>
            <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              {items.map((it) => (
                <SortableRow key={it.id} item={it} onRemove={() => setItems((c) => c.filter((x) => x.id !== it.id))} onPages={(v) => setItems((c) => c.map((x) => (x.id === it.id ? { ...x, pages: v } : x)))} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="flex items-end gap-2">
          <Button variant="outline" onClick={add}><Plus className="h-3.5 w-3.5" /> {tr("Add files…")}</Button>
          <div className="ml-auto w-60 space-y-1">
            <Label>{tr("New document name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} disabled={items.length < 1}>{tr("Merge")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SplitDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [mode, setMode] = useState<'every' | 'ranges' | 'bookmarks' | 'size'>('every');
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState('');
  const [sizeMb, setSizeMb] = useState(5);
  const [pattern, setPattern] = useState('{name}_part{n}');
  const pageCount = doc?.info.page_count ?? 0;
  const parsedRanges = useMemo(() => {
    const groups = ranges.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    const out: number[][] = [];
    for (const g of groups) {
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(g);
      if (!m) return null;
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || b > pageCount || a > b) return null;
      out.push([a - 1, b - 1]);
    }
    return out.length ? out : null;
  }, [ranges, pageCount]);
  if (!doc) return null;
  const submit = async () => {
    const folder = await bridge().dialog.folder(tr("Choose the output folder"));
    if (!folder) return;
    useUi.getState().setBusy({ label: tr("Splitting document…") });
    try {
      const r = await call<{ files: { path: string; pages: number[] }[] }>('doc.split', {
        doc_id: doc.id,
        mode,
        output: folder.token,
        name_pattern: pattern,
        ...(mode === 'every' ? { every } : mode === 'ranges' ? { ranges: parsedRanges } : mode === 'size' ? { max_bytes: Math.round(sizeMb * 1024 * 1024) } : {}),
      });
      toast('success', tr("Created {0} files", r.files.length), folder.path);
      bridge().app.showItemInFolder(folder.token);
      onClose();
    } catch (e) {
      toast('error', tr("Split failed"), errorMessage(e));
    } finally {
      useUi.getState().setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Split document")}</DialogTitle>
          <DialogDescription>{tr("Create several PDF files from “")}{doc.info.display_name}{tr("”. The current document is not changed.")}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as any)} options={[
          { value: 'every', label: tr("Every N pages") },
          { value: 'ranges', label: tr("By page ranges"), hint: 'e.g. 1-3; 4-10; 11' },
          { value: 'bookmarks', label: tr("By top-level bookmarks"), disabled: !doc.info.has_outline },
          { value: 'size', label: tr("By maximum file size") },
        ]} />
        {mode === 'every' && <NumberInput value={every} onChange={(v) => setEvery(Math.max(1, Math.round(v)))} min={1} max={doc.info.page_count} suffix="pages" />}
        {mode === 'ranges' && <Input value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3; 4-10; 11" className={ranges && !parsedRanges ? 'border-destructive' : ''} />}
        {mode === 'size' && <NumberInput value={sizeMb} onChange={setSizeMb} min={0.1} max={2000} step={0.5} suffix="MB" />}
        <div className="space-y-1">
          <Label>{tr("File names")}</Label>
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} />
          <div className="text-[11px] text-muted-foreground">{tr("Placeholders:")} {tr("{name}")} {'{n}'} {tr("{start}")} {tr("{end}")}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} disabled={mode === 'ranges' && !parsedRanges}>{tr("Choose folder & split…")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImagesToPdfDialog({ onClose, files }: { onClose: () => void; files?: FileRef[] }) {
  const [items, setItems] = useState<FileRef[]>(files ?? []);
  const [size, setSize] = useState<'image' | 'a4' | 'letter'>('image');
  const [margin, setMargin] = useState(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  useEffect(() => setItems(files ?? []), [files]);
  const submit = async () => {
    useUi.getState().setBusy({ label: tr("Creating PDF from {0} images…", items.length) });
    try {
      const info = await call<DocumentInfo>('doc.imagesToPdf', { files: items.map((i) => i.token), page_size: size, margin, display_name: `${stripExt(items[0].name)}.pdf` });
      addOpened(info);
      onClose();
    } catch (e) {
      toast('error', tr("Could not create the PDF"), errorMessage(e));
    } finally {
      useUi.getState().setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Create PDF from images")}</DialogTitle>
          <DialogDescription>{tr("Each image becomes one page (multi-page TIFF files add all their pages).")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-56 overflow-auto rounded-md border">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => {
            if (!e.over || e.active.id === e.over.id) return;
            setItems((cur) => arrayMove(cur, cur.findIndex((x) => x.token === e.active.id), cur.findIndex((x) => x.token === e.over!.id)));
          }}>
            <SortableContext items={items.map((i) => i.token)} strategy={verticalListSortingStrategy}>
              {items.map((it) => (
                <SortableRow key={it.token} item={{ id: it.token, ref: it, pages: '' }} onRemove={() => setItems((c) => c.filter((x) => x.token !== it.token))} onPages={() => undefined} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <Button variant="outline" size="sm" className="self-start" onClick={async () => setItems([...items, ...(await bridge().dialog.open('images', tr("Add images")))])}>
          <Plus className="h-3.5 w-3.5" /> {tr("Add images…")}
        </Button>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{tr("Page size")}</Label>
            <Select value={size} onValueChange={(v) => setSize(v as any)} options={[{ value: 'image', label: tr("Same as image") }, { value: 'a4', label: 'A4' }, { value: 'letter', label: tr("Letter") }]} />
          </div>
          <div className="space-y-1">
            <Label>{tr("Margin")}</Label>
            <NumberInput value={margin} onChange={setMargin} min={0} max={144} suffix="pt" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} disabled={!items.length}>{tr("Create PDF")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PageOrganizer() {
  const doc = useDoc();
  const [size, setSize] = useState(150);
  if (!doc) return null;
  return (
    <div className="flex h-full flex-col bg-workspace" data-testid="page-organizer">
      <div className="flex items-center gap-3 border-b bg-background px-3 py-1.5 text-[12px]">
        <span className="font-semibold">{tr("Organize pages")}</span>
        <span className="text-muted-foreground">
          {doc.selectedPages.length ? tr("{0} selected ({1})", doc.selectedPages.length, formatRanges(doc.selectedPages)) : tr("Click to select · Ctrl/Shift for multiple · drag to reorder · right-click for actions")}
        </span>
        <span className="ml-auto text-muted-foreground">{tr("Size")}</span>
        <input type="range" min={90} max={300} value={size} onChange={(e) => setSize(parseInt(e.target.value, 10))} />
        <Button size="xs" variant="outline" onClick={() => useDocuments.getState().update(doc.id, { selectedPages: doc.info.pages.map((_, i) => i) })}>{tr("Select all")}</Button>
        <Button size="xs" onClick={() => useUi.getState().setOrganizerOpen(false)}>{tr("Done")}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ThumbnailGridLazy doc={doc} size={size} />
      </div>
    </div>
  );
}

function ThumbnailGridLazy({ doc, size }: { doc: DocState; size: number }) {
  return <ThumbnailGrid doc={doc} width={size} columns />;
}
