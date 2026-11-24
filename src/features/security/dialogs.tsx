/* Protect tab dialogs: passwords, watermark, redaction, sanitising. */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import type { DocumentInfo } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox, CheckRow, ColorInput, Input, Label, NumberInput, RadioGroup, Select, Slider } from '@/components/ui/controls';
import { call, errorMessage } from '@/lib/api';
import { formatRanges, parsePageRanges } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { toast } from '@/stores/ui';
import { applyInfo, runOp } from '@/services/docService';
import { pickImageAsset } from '@/features/viewer/ToolLayer';
import { FontPicker } from '@/features/overlay-editor/OverlayProperties';
import { viewerBus } from '@/features/viewer/viewerBus';
import { tr } from '@/i18n';

function useDoc(): DocState | null {
  return useDocuments((s) => (s.activeId ? s.docs[s.activeId] : null));
}

const PERMS: [string, string][] = [
  ['print', 'Printing'],
  ['print_high_quality', 'High quality printing'],
  ['copy', 'Copying text and images'],
  ['modify', 'Changing the document'],
  ['annotate', 'Adding comments'],
  ['fill_forms', 'Filling in forms'],
  ['assemble', 'Inserting, deleting and rotating pages'],
];

export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [useOpen, setUseOpen] = useState(true);
  const [openPw, setOpenPw] = useState('');
  const [openPw2, setOpenPw2] = useState('');
  const [useOwner, setUseOwner] = useState(false);
  const [ownerPw, setOwnerPw] = useState('');
  const [ownerPw2, setOwnerPw2] = useState('');
  const [perms, setPerms] = useState<Record<string, boolean>>(() => Object.fromEntries(PERMS.map(([k]) => [k, true])));
  if (!doc) return null;
  const sec = doc.info.security;
  const error =
    (useOpen && openPw.length < 1 && tr('Enter the password to open the document')) ||
    (useOpen && openPw !== openPw2 && tr('The open passwords do not match')) ||
    (useOwner && ownerPw.length < 1 && tr('Enter the permissions password')) ||
    (useOwner && ownerPw !== ownerPw2 && tr('The permissions passwords do not match')) ||
    (useOpen && useOwner && openPw === ownerPw && tr('The two passwords must be different')) ||
    (!useOpen && !useOwner && tr('Choose at least one password')) ||
    '';
  const submit = async () => {
    try {
      const info = await call<DocumentInfo>('security.protect', {
        doc_id: doc.id,
        user_password: useOpen ? openPw : null,
        owner_password: useOwner ? ownerPw : null,
        permissions: useOwner ? perms : {},
      });
      applyInfo(doc.id, { ...info, page_map: null, modified_pages: [] }, undefined, doc.pageVersions);
      useDocuments.getState().update(doc.id, { savedRevision: -1 }); // mark dirty until saved
      toast('success', tr("Password protection set"), tr("It is applied (AES-256) when you save the document."));
      onClose();
    } catch (e) {
      toast('error', tr("Could not set the password"), errorMessage(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Password protection")}</DialogTitle>
          <DialogDescription>{tr("Encryption uses AES-256 and is applied when you save. Keep your passwords safe – they cannot be recovered.")}</DialogDescription>
        </DialogHeader>
        {sec && (
          <div className="rounded-md border bg-muted/50 p-2 text-[12px]">
            {tr("Currently:")} {sec.has_user_password ? tr("password required to open") : tr("no open password")}
            {sec.preserved ? tr(" – the protection of the original file is kept when saving.") : '.'}
            {sec.owner_unknown && ' The original permissions password is unknown; a new random one will be used.'}
          </div>
        )}
        <CheckRow checked={useOpen} onChange={setUseOpen} label={tr("Require a password to open the document")} />
        {useOpen && (
          <div className="grid grid-cols-2 gap-2 pl-6">
            <Input type="password" placeholder={tr("Password")} value={openPw} onChange={(e) => setOpenPw(e.target.value)} data-testid="pw-open" />
            <Input type="password" placeholder={tr("Confirm")} value={openPw2} onChange={(e) => setOpenPw2(e.target.value)} data-testid="pw-open2" />
          </div>
        )}
        <CheckRow checked={useOwner} onChange={setUseOwner} label={tr("Restrict printing, copying and editing")} hint={tr("Requires a separate permissions password to change these restrictions")} />
        {useOwner && (
          <div className="space-y-2 pl-6">
            <div className="grid grid-cols-2 gap-2">
              <Input type="password" placeholder={tr("Permissions password")} value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} />
              <Input type="password" placeholder={tr("Confirm")} value={ownerPw2} onChange={(e) => setOwnerPw2(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-x-3">
              {PERMS.map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 py-0.5 text-[12px]"><Checkbox checked={perms[k]} onCheckedChange={(v) => setPerms({ ...perms, [k]: v === true })} /> {tr("Allow {0}", tr(l).toLowerCase())}</label>
              ))}
            </div>
          </div>
        )}
        {error && <div className="text-[11.5px] text-warning">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} disabled={!!error} data-testid="pw-apply">{tr("Apply")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WatermarkDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [kind, setKind] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [font, setFont] = useState('Noto Sans');
  const [size, setSize] = useState(64);
  const [color, setColor] = useState('#c00000');
  const [opacity, setOpacity] = useState(20);
  const [rotation, setRotation] = useState(45);
  const [position, setPosition] = useState('center');
  const [behind, setBehind] = useState(false);
  const [asset, setAsset] = useState<{ asset_id: string } | null>(null);
  const [pages, setPages] = useState('');
  if (!doc) return null;
  const submit = async () => {
    const list = pages.trim() ? parsePageRanges(pages, doc.info.page_count) : null;
    if (pages.trim() && !list) return toast('error', tr("Invalid page range"));
    const spec: Record<string, unknown> = { opacity: opacity / 100, rotation, position, behind, ...(list ? { pages: list } : {}) };
    if (kind === 'text') Object.assign(spec, { text, font, size, color });
    else if (asset) spec.asset_id = asset.asset_id;
    else return toast('error', tr("Choose an image"));
    const res = await runOp(doc.id, tr("Add watermark"), 'doc.watermark', { spec });
    if (res) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Add watermark")}</DialogTitle>
          <DialogDescription>{tr("The watermark is placed in a separate “Watermark” layer and can be hidden in the Layers panel.")}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={kind} onValueChange={(v) => setKind(v as 'text' | 'image')} className="flex-row gap-4" options={[{ value: 'text', label: tr("Text") }, { value: 'image', label: tr("Image") }]} />
        {kind === 'text' ? (
          <div className="space-y-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tr("Watermark text")} />
            <div className="grid grid-cols-3 gap-2">
              <FontPicker value={font} onChange={setFont} />
              <NumberInput value={size} onChange={setSize} min={6} max={300} suffix="pt" />
              <ColorInput value={color} onChange={(v) => v && setColor(v)} />
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={async () => setAsset(await pickImageAsset())}>{asset ? tr("Image selected – change…") : tr("Choose image…")}</Button>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label>{tr("Opacity")} {opacity}%</Label><Slider value={[opacity]} min={5} max={100} onValueChange={([v]) => setOpacity(v)} /></div>
          <div className="space-y-1"><Label>{tr("Rotation")}</Label><NumberInput value={rotation} onChange={setRotation} min={-180} max={180} suffix="°" /></div>
          <div className="space-y-1"><Label>{tr("Position")}</Label><Select value={position} onValueChange={setPosition} options={[{ value: 'center', label: tr("Centre") }, { value: 'top', label: tr("Top") }, { value: 'bottom', label: tr("Bottom") }, { value: 'tile', label: tr("Tiled") }]} /></div>
          <div className="space-y-1"><Label>{tr("Pages (empty = all)")}</Label><Input value={pages} onChange={(e) => setPages(e.target.value)} placeholder="e.g. 1-3" /></div>
        </div>
        <CheckRow checked={behind} onChange={setBehind} label={tr("Place behind the page content")} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={submit} data-testid="watermark-apply">{tr("Add watermark")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Match { page: number; rect: number[]; text: string }

export function RedactSearchDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [mode, setMode] = useState<'text' | 'pattern'>('text');
  const [query, setQuery] = useState('');
  const [pattern, setPattern] = useState('email');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  if (!doc) return null;
  const search = async () => {
    try {
      const r = await call<{ matches: Match[] }>('redact.search', { doc_id: doc.id, ...(mode === 'text' ? { query } : { pattern }) });
      setMatches(r.matches);
      setSel(new Set(r.matches.map((_, i) => i)));
    } catch (e) {
      toast('error', tr("Search failed"), errorMessage(e));
    }
  };
  const mark = async () => {
    const items = (matches ?? []).filter((_, i) => sel.has(i)).map((m) => ({ page: m.page, rect: m.rect, text: m.text }));
    if (!items.length) return;
    const res = await runOp(doc.id, tr("Mark {0} for redaction", items.length), 'redact.mark', { items });
    if (res) {
      toast('info', tr("{0} areas marked for redaction", items.length), tr("Review them, then use Apply Redactions to remove the content permanently."));
      onClose();
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr("Search & redact")}</DialogTitle>
          <DialogDescription>{tr("Find sensitive text and mark every occurrence for redaction.")}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'text' | 'pattern')} className="flex-row gap-4" options={[{ value: 'text', label: tr("Words or phrases") }, { value: 'pattern', label: tr("Patterns") }]} />
        <div className="flex gap-2">
          {mode === 'text' ? (
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("Text to find")} onKeyDown={(e) => e.key === 'Enter' && search()} />
          ) : (
            <Select value={pattern} onValueChange={setPattern} options={[{ value: 'email', label: tr("E-mail addresses") }, { value: 'phone', label: tr("Phone numbers") }, { value: 'thai_id', label: tr("Thai national ID numbers") }, { value: 'credit_card', label: tr("Credit card numbers") }, { value: 'date', label: tr("Dates") }]} />
          )}
          <Button onClick={search} data-testid="redact-search">{tr("Search")}</Button>
        </div>
        {matches && (
          <div className="max-h-[45vh] overflow-auto rounded-md border">
            {!matches.length && <p className="p-4 text-center text-[12px] text-muted-foreground">{tr("No matches found.")}</p>}
            {matches.map((m, i) => (
              <label key={i} className="flex cursor-pointer items-center gap-2 border-b px-2 py-1 text-[12px] last:border-0 hover:bg-muted" onDoubleClick={() => viewerBus.scrollTo({ docId: doc.id, page: m.page, rect: m.rect as any })}>
                <Checkbox checked={sel.has(i)} onCheckedChange={(v) => setSel((s) => { const n = new Set(s); v ? n.add(i) : n.delete(i); return n; })} />
                <span className="w-14 text-muted-foreground">{tr("Page")} {m.page + 1}</span>
                <span className="font-mono">{m.text}</span>
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={mark} disabled={!sel.size} data-testid="redact-mark">{tr("Mark")} {sel.size || ''} {tr("for redaction")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApplyRedactionsDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [marks, setMarks] = useState<{ page: number; text: string }[] | null>(null);
  const [images, setImages] = useState('pixels');
  const [graphics, setGraphics] = useState('covered');
  const [fill, setFill] = useState(true);
  const [san, setSan] = useState({ metadata: true, attachments: false, javascript: true, hidden_text: false, links: false });
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<any>(null);
  useEffect(() => {
    if (doc) call<{ marks: { page: number; text: string }[] }>('redact.pending', { doc_id: doc.id }).then((r) => setMarks(r.marks)).catch(() => setMarks([]));
  }, [doc?.id, doc?.info.revision]);
  if (!doc) return null;
  const apply = async () => {
    const res = await runOp<DocumentInfo & { report?: any }>(doc.id, tr("Apply redactions"), 'redact.apply', { images, graphics, fill, sanitize: san });
    if (res) setReport(res.report);
  };
  if (report) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tr("Redaction complete")}</DialogTitle></DialogHeader>
          <div className="flex items-start gap-2 text-[12.5px]" data-testid="redact-report">
            {report.verified ? <CheckCircle2 className="h-5 w-5 text-success" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
            <div className="space-y-1">
              <div>{report.redacted_areas} {tr("areas redacted on")} {report.pages.length} {tr("page(s).")}</div>
              <div>{report.verified ? tr("Verified: no text can be extracted from the redacted areas.") : tr("Warning: text was still found in {0} area(s).", report.residual.length)}</div>
              {report.occurs_elsewhere?.length > 0 && <div className="text-warning">{tr("The following redacted text still appears elsewhere in the document (not marked):")} {report.occurs_elsewhere.join(', ')}</div>}
              {report.sanitized?.length > 0 && <div>{tr("Removed:")} {report.sanitized.join(', ')}.</div>}
              <div className="text-muted-foreground">{tr("Save the document to write the redacted file. Undo is possible until you close it.")}</div>
            </div>
          </div>
          <DialogFooter><Button onClick={onClose}>{tr("Close")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Apply redactions")}</DialogTitle>
          <DialogDescription>{marks === null ? tr("Loading…") : tr("{0} area(s) marked on page(s) {1}.", marks.length, formatRanges([...new Set(marks.map((m) => m.page))]))}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[12px]">
          <ShieldAlert className="h-5 w-5 shrink-0 text-destructive" />
          <div>{tr("The text, image pixels and graphics under the marks are")} <b>{tr("permanently removed")}</b> {tr("from the document – they are not just covered. This cannot be reversed once the document is saved and closed.")}</div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label>{tr("Images under marks")}</Label><Select value={images} onValueChange={setImages} options={[{ value: 'pixels', label: tr("Remove covered pixels") }, { value: 'remove', label: tr("Remove whole images") }, { value: 'none', label: tr("Keep images") }]} /></div>
          <div className="space-y-1"><Label>{tr("Vector graphics")}</Label><Select value={graphics} onValueChange={setGraphics} options={[{ value: 'covered', label: tr("Remove if fully covered") }, { value: 'touched', label: tr("Remove if touched") }, { value: 'none', label: tr("Keep") }]} /></div>
        </div>
        <CheckRow checked={fill} onChange={setFill} label={tr("Fill redacted areas with black")} />
        <div className="space-y-0.5">
          <Label>{tr("Also remove hidden information")}</Label>
          <CheckRow checked={san.metadata} onChange={(v) => setSan({ ...san, metadata: v })} label={tr("Document metadata (author, title, XMP)")} />
          <CheckRow checked={san.javascript} onChange={(v) => setSan({ ...san, javascript: v })} label={tr("JavaScript")} />
          <CheckRow checked={san.attachments} onChange={(v) => setSan({ ...san, attachments: v })} label={tr("Attached files")} />
          <CheckRow checked={san.hidden_text} onChange={(v) => setSan({ ...san, hidden_text: v })} label={tr("Hidden (invisible) text everywhere")} />
          <CheckRow checked={san.links} onChange={(v) => setSan({ ...san, links: v })} label={tr("Links")} />
        </div>
        <CheckRow checked={confirmed} onChange={setConfirmed} label={tr("I understand that the marked content will be permanently removed")} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button variant="destructive" onClick={apply} disabled={!confirmed || !marks?.length} data-testid="redact-apply">{tr("Apply redactions")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SanitizeDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [o, setO] = useState({ metadata: true, javascript: true, attachments: false, hidden_text: false, links: false });
  if (!doc) return null;
  const run = async () => {
    const res = await runOp(doc.id, tr("Sanitize document"), 'doc.sanitize', { options: o });
    if (res) {
      toast('success', tr("Hidden information removed"));
      onClose();
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Sanitize document")}</DialogTitle>
          <DialogDescription>{tr("Remove hidden information before sharing the document.")}</DialogDescription>
        </DialogHeader>
        <CheckRow checked={o.metadata} onChange={(v) => setO({ ...o, metadata: v })} label={tr("Metadata (author, title, keywords, XMP)")} />
        <CheckRow checked={o.javascript} onChange={(v) => setO({ ...o, javascript: v })} label={tr("JavaScript")} />
        <CheckRow checked={o.attachments} onChange={(v) => setO({ ...o, attachments: v })} label={tr("Attached files")} />
        <CheckRow checked={o.hidden_text} onChange={(v) => setO({ ...o, hidden_text: v })} label={tr("Hidden (invisible) text, e.g. OCR layers")} />
        <CheckRow checked={o.links} onChange={(v) => setO({ ...o, links: v })} label={tr("Links")} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={run}>{tr("Remove")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
