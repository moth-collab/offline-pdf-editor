/* Electronic signatures (draw/type/image, stored locally), digital
 * signatures (PKCS#12 Digital IDs) and validation. */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { BadgeCheck, CheckCircle2, Eraser, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import type { DocumentInfo, FileRef, PageInfo } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckRow, ColorInput, Input, Label, Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { bridge, call, errorMessage } from '@/lib/api';
import { cn, stripExt } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { addOpened, commitOverlays } from '@/services/docService';
import { createImage, prepareForSave } from '@/features/overlay-editor/model';
import { FontPicker } from '@/features/overlay-editor/OverlayProperties';
import { viewToPdf, type PageSlot } from '@/features/viewer/geometry';
import { tr } from '@/i18n';

function useDoc(): DocState | null {
  return useDocuments((s) => (s.activeId ? s.docs[s.activeId] : null));
}

interface SavedSig { id: string; asset_id: string; kind: string; width: number; height: number }

export const useSignaturePlacement = create<{ sig: SavedSig | null; set: (s: SavedSig | null) => void }>((set) => ({ sig: null, set: (sig) => set({ sig }) }));

function trimCanvas(src: HTMLCanvasElement): string | null {
  const ctx = src.getContext('2d')!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = 6;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1 + pad * 2;
  out.height = y1 - y0 + 1 + pad * 2;
  out.getContext('2d')!.drawImage(src, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function DrawPad({ color, onChange }: { color: string; onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const last = useRef<[number, number] | null>(null);
  const pos = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * ref.current!.width, ((e.clientY - r.top) / r.height) * ref.current!.height];
  };
  return (
    <div className="space-y-1">
      <canvas
        ref={ref}
        width={1000}
        height={300}
        className="h-[150px] w-full cursor-crosshair rounded-md border bg-white"
        data-testid="signature-pad"
        onPointerDown={(e) => {
          ref.current!.setPointerCapture(e.pointerId);
          last.current = pos(e);
        }}
        onPointerMove={(e) => {
          if (!last.current) return;
          const p = pos(e);
          const ctx = ref.current!.getContext('2d')!;
          ctx.strokeStyle = color;
          ctx.lineWidth = 5;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(...last.current);
          ctx.lineTo(...p);
          ctx.stroke();
          last.current = p;
        }}
        onPointerUp={() => {
          last.current = null;
          onChange(trimCanvas(ref.current!));
        }}
      />
      <Button size="xs" variant="ghost" onClick={() => {
        const c = ref.current!;
        c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
        onChange(null);
      }}><Eraser className="h-3 w-3" /> {tr("Clear")}</Button>
    </div>
  );
}

function renderTyped(text: string, font: string, color: string): string | null {
  if (!text.trim()) return null;
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 300;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = `italic 140px "${font}", cursive`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, 150);
  return trimCanvas(c);
}

export function SignatureDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [saved, setSaved] = useState<SavedSig[]>([]);
  const [tab, setTab] = useState('draw');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState('Sarabun');
  const [color, setColor] = useState('#1d3c8f');
  const [image, setImage] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const load = () => call<{ signatures: SavedSig[] }>('sig.saved').then((r) => setSaved(r.signatures)).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  if (!doc) return null;
  const place = (sig: SavedSig) => {
    useSignaturePlacement.getState().set(sig);
    useDocuments.getState().update(doc.id, { tool: 'signature', selection: { kind: 'none', ids: [] } });
    toast('info', tr("Click on the page where the signature should go"));
    onClose();
  };
  const useCurrent = async () => {
    const data = tab === 'draw' ? drawn : tab === 'type' ? renderTyped(typed, font, color) : image;
    if (!data) return toast('error', tr("Create a signature first"));
    try {
      const sig = await call<SavedSig>('sig.saveImage', { data_base64: data, kind: tab === 'draw' ? 'drawn' : tab === 'type' ? 'typed' : 'image' });
      if (!remember) call('sig.deleteSaved', { id: sig.id }).catch(() => undefined);
      place(sig);
    } catch (e) {
      toast('error', tr("Could not use the signature"), errorMessage(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr("Fill & Sign")}</DialogTitle>
          <DialogDescription>{tr("Create an electronic signature and place it on the document. Signatures are stored only on this computer.")}</DialogDescription>
        </DialogHeader>
        {saved.length > 0 && (
          <div className="space-y-1">
            <Label>{tr("Saved signatures")}</Label>
            <div className="flex flex-wrap gap-2">
              {saved.map((s) => (
                <div key={s.id} className="group relative">
                  <button className="h-16 w-40 rounded-md border bg-white p-1 hover:border-primary" onClick={() => place(s)} title={tr("Use this signature")}>
                    <img src={bridge().assetUrl(s.asset_id)} alt="signature" className="h-full w-full object-contain" />
                  </button>
                  <button className="absolute -right-1.5 -top-1.5 hidden rounded-full border bg-background p-0.5 group-hover:block" onClick={() => call('sig.deleteSaved', { id: s.id }).then(load)} aria-label={tr("Delete saved signature")}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="draw">{tr("Draw")}</TabsTrigger>
            <TabsTrigger value="type">{tr("Type")}</TabsTrigger>
            <TabsTrigger value="image">{tr("Image")}</TabsTrigger>
          </TabsList>
          <TabsContent value="draw" className="mt-2"><DrawPad color={color} onChange={setDrawn} /></TabsContent>
          <TabsContent value="type" className="mt-2 space-y-2">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={tr("Your name")} data-testid="signature-typed" />
            <div className="w-64"><FontPicker value={font} onChange={setFont} /></div>
            {typed && <div className="flex h-20 items-center rounded-md border bg-white px-3" style={{ fontFamily: `"${font}"`, fontStyle: 'italic', fontSize: 36, color }}>{typed}</div>}
          </TabsContent>
          <TabsContent value="image" className="mt-2 space-y-2">
            <Button variant="outline" onClick={async () => {
              const refs = await bridge().dialog.open('image', tr("Signature image"));
              if (!refs.length) return;
              const a = await call<{ asset_id: string }>('asset.addImage', { file: refs[0].token });
              const r = await fetch(bridge().assetUrl(a.asset_id));
              const blob = await r.blob();
              const reader = new FileReader();
              reader.onload = () => setImage(String(reader.result));
              reader.readAsDataURL(blob);
            }}>{tr("Choose image…")}</Button>
            {image && <img src={image} alt="signature" className="h-20 rounded-md border bg-white object-contain p-1" />}
          </TabsContent>
        </Tabs>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2"><Label>{tr("Color")}</Label><ColorInput value={color} onChange={(v) => v && setColor(v)} /></div>
          <CheckRow checked={remember} onChange={setRemember} label={tr("Save for later")} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={useCurrent} data-testid="signature-use">{tr("Place signature")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Tool layer: click on the page to place the chosen signature image. */
export function SignaturePlaceLayer({ doc, pageIndex, info, zoom }: { doc: DocState; pageIndex: number; info: PageInfo; zoom: number; slot: PageSlot }) {
  const sig = useSignaturePlacement((s) => s.sig);
  return (
    <div
      className="absolute inset-0 z-[5] cursor-copy"
      data-testid={`signature-layer-${pageIndex}`}
      onPointerDown={(e) => {
        if (!sig) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const [x, y] = viewToPdf(info, zoom, e.clientX - r.left, e.clientY - r.top);
        const w = 140;
        const h = (w * sig.height) / sig.width;
        const o = createImage(pageIndex, [x - w / 2, y - h / 2, x + w / 2, y + h / 2], sig.asset_id, sig.width, sig.height);
        o.rotation = (360 - info.rotation) % 360;
        const cur = useDocuments.getState().docs[doc.id];
        commitOverlays(doc.id, tr("Add signature"), [...cur.overlays, o]);
        useDocuments.getState().update(doc.id, { tool: 'edit-objects', selection: { kind: 'overlay', ids: [o.id], page: pageIndex } });
        useSignaturePlacement.getState().set(null);
      }}
    />
  );
}

// ---------------------------------------------------------------- digital signatures
/** `field`: sign into this empty signature field of the form instead of adding one. */
export function DigitalSignDialog({ onClose, field }: { onClose: () => void; field?: string }) {
  const doc = useDoc();
  const [pfx, setPfx] = useState<FileRef | null>(null);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('I approve this document');
  const [location, setLocation] = useState('');
  const [position, setPosition] = useState('bottom-right');
  if (!doc) return null;
  const page = doc.info.pages[doc.currentPage];
  const sign = async () => {
    if (!pfx) return toast('error', tr("Choose your Digital ID file"));
    const target = await bridge().dialog.save('pdf', tr("{0}_signed.pdf", stripExt(doc.info.display_name)), tr("Save signed document"));
    if (!target) return;
    const [cx0, cy0, cx1] = page.cropbox;
    const w = 200;
    const h = 60;
    const m = 36;
    const rect = field
      ? null
      : position === 'invisible'
        ? null : position === 'bottom-left' ? [cx0 + m, cy0 + m, cx0 + m + w, cy0 + m + h] : position === 'top-right' ? [cx1 - m - w, page.cropbox[3] - m - h, cx1 - m, page.cropbox[3] - m] : [cx1 - m - w, cy0 + m, cx1 - m, cy0 + m + h];
    useUi.getState().setBusy({ label: tr("Signing…") });
    try {
      const info = await call<DocumentInfo & { signature?: any }>('doc.sign', {
        doc_id: doc.id,
        pfx: pfx.token,
        password,
        target: target.token,
        page: doc.currentPage,
        rect,
        ...(field ? { field_name: field } : {}),
        reason,
        location,
        overlays: prepareForSave(doc.overlays) as unknown as Record<string, unknown>[],
      });
      addOpened(info);
      const sig = info.signature;
      toast(sig?.intact && sig?.valid ? 'success' : 'warning', tr("Document signed"), sig ? (sig.intact && sig.valid ? tr('{0} – signature verified', target.path) : tr('{0} – signature could not be verified', target.path)) : target.path);
      onClose();
    } catch (e) {
      toast('error', tr("Signing failed"), errorMessage(e));
    } finally {
      useUi.getState().setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Sign with a Digital ID")}</DialogTitle>
          <DialogDescription>{tr("Creates a signed copy (PAdES, SHA-256) of the document as it is now, including unsaved changes. The signed copy opens in a new tab; any later change invalidates the signature.")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label>{tr("Digital ID (.pfx / .p12)")}</Label>
          <div className="flex gap-2">
            <Input readOnly value={pfx?.name ?? ''} placeholder={tr("No Digital ID selected")} />
            <Button variant="outline" onClick={async () => setPfx((await bridge().dialog.open('pfx', tr("Choose Digital ID")))[0] ?? null)}>{tr("Browse…")}</Button>
          </div>
          <button className="text-[11.5px] text-primary hover:underline" onClick={() => useUi.getState().openDialog('create-id')}>{tr("Create a new self-signed Digital ID…")}</button>
        </div>
        <div className="space-y-1"><Label>{tr("Digital ID password")}</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="sign-password" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1"><Label>{tr("Reason")}</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="space-y-1"><Label>{tr("Location")}</Label><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={tr("e.g. Bangkok")} /></div>
        </div>
        {field ? (
          <div className="rounded-md border bg-muted/40 p-2 text-[12px]" data-testid="sign-field">{tr('The signature is placed in the form field “{0}”.', field)}</div>
        ) : (
          <div className="space-y-1">
            <Label>{tr("Visible signature on page")} {doc.currentPage + 1}</Label>
            <Select value={position} onValueChange={setPosition} options={[{ value: 'bottom-right', label: tr("Bottom right") }, { value: 'bottom-left', label: tr("Bottom left") }, { value: 'top-right', label: tr("Top right") }, { value: 'invisible', label: tr("Invisible signature") }]} />
          </div>
        )}
        {doc.info.security && <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-[12px]">{tr("Password protection must be removed before signing (Protect › Remove Security).")}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={sign} disabled={!pfx || !password} data-testid="sign-apply">{tr("Sign…")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateIdDialog({ onClose }: { onClose: () => void }) {
  const settings = useUi((s) => s.settings);
  const [name, setName] = useState(settings.authorName !== 'User' ? settings.authorName : '');
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState('');
  const [country, setCountry] = useState('TH');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const err = !name.trim() ? tr('Enter your name') : pw.length < 6 ? tr('The password needs at least 6 characters') : pw !== pw2 ? tr('The passwords do not match') : country && country.length !== 2 ? tr('Use a 2-letter country code') : '';
  const create = async () => {
    const target = await bridge().dialog.save('pfx', tr("{0}.pfx", name.trim().replace(/\s+/g, '_')), tr("Save Digital ID"));
    if (!target) return;
    try {
      await call('sig.createId', { target: target.token, name, email, organization: org, country, password: pw });
      toast('success', tr("Digital ID created"), tr("{0}. Keep this file and its password safe.", target.path));
      onClose();
    } catch (e) {
      toast('error', tr("Could not create the Digital ID"), errorMessage(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Create a self-signed Digital ID")}</DialogTitle>
          <DialogDescription>{tr("A self-signed ID proves that a document was not changed after signing. Recipients can only trust your identity if they trust your certificate (for legally binding signatures use an ID from a certification authority).")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2 space-y-1"><Label>{tr("Name")}</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label>{tr("E-mail")}</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="space-y-1"><Label>{tr("Organization")}</Label><Input value={org} onChange={(e) => setOrg(e.target.value)} /></div>
          <div className="space-y-1"><Label>{tr("Country")}</Label><Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} /></div>
          <div />
          <div className="space-y-1"><Label>{tr("Password")}</Label><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <div className="space-y-1"><Label>{tr("Confirm password")}</Label><Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
        </div>
        {err && <div className="text-[11.5px] text-warning">{err}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("Cancel")}</Button>
          <Button onClick={create} disabled={!!err}>{tr("Create & save…")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ValidateDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [items, setItems] = useState<any[] | null>(null);
  const [modified, setModified] = useState(false);
  useEffect(() => {
    if (doc) call<{ signatures: any[]; modified_since_open: boolean }>('sig.validate', { doc_id: doc.id }).then((r) => { setItems(r.signatures); setModified(r.modified_since_open); }).catch((e) => { toast('error', tr("Validation failed"), errorMessage(e)); setItems([]); });
  }, [doc?.id, doc?.info.revision]);
  if (!doc) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{tr("Signatures")}</DialogTitle>
          <DialogDescription>{tr("Validated offline: integrity and certificate details are checked locally; revocation servers are not contacted.")}</DialogDescription>
        </DialogHeader>
        {modified && <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-[12px]">{tr("The document has been changed in this session. Signatures are validated against the current (unsaved) state.")}</div>}
        <div className="max-h-[55vh] space-y-2 overflow-auto" data-testid="signature-list">
          {items === null && <div className="text-[12px] text-muted-foreground">{tr("Validating…")}</div>}
          {items?.length === 0 && <div className="text-[12px] text-muted-foreground">{tr("This document has no digital signatures.")}</div>}
          {items?.map((s, i) => {
            const ok = s.intact && s.valid;
            return (
              <div key={i} className="rounded-md border p-3 text-[12px]">
                <div className="flex items-center gap-2 font-medium">
                  {ok ? (s.trusted ? <BadgeCheck className="h-4 w-4 text-success" /> : <CheckCircle2 className="h-4 w-4 text-success" />) : <XCircle className="h-4 w-4 text-destructive" />}
                  {ok ? tr("The document has not been modified since this signature was applied") : tr("The signature is INVALID – the document was changed or the signature is damaged")}
                </div>
                <div className={cn('mt-1 flex items-center gap-1', s.trusted ? 'text-success' : 'text-warning')}>
                  {!s.trusted && <ShieldAlert className="h-3.5 w-3.5" />}
                  {s.trusted ? tr("Signer identity is trusted.") : s.self_signed ? tr("Signer identity is not verified (self-signed certificate).") : tr("Signer identity could not be verified (issuer not trusted on this computer).")}
                </div>
                <table className="mt-2 w-full">
                  <tbody>
                    {[
                      [tr('Signed by'), s.signer],
                      [tr('Issued by'), s.issuer],
                      [tr('Signing time'), s.signing_time && new Date(s.signing_time).toLocaleString()],
                      [tr('Certificate valid'), s.not_before && `${new Date(s.not_before).toLocaleDateString()} – ${new Date(s.not_after).toLocaleDateString()}`],
                      [tr('Coverage'), s.coverage === 'ENTIRE_FILE' ? tr('Entire document') : s.coverage],
                      [tr('Later changes'), s.modification_level === 'NONE' ? tr('None') : s.modification_level],
                      [tr('Serial number'), s.serial],
                      [tr('Field'), s.field],
                    ].filter(([, v]) => v).map(([k, v]) => (
                      <tr key={k as string}><td className="w-32 py-0.5 text-muted-foreground">{k}</td><td className="break-all">{v}</td></tr>
                    ))}
                  </tbody>
                </table>
                {s.error && <div className="mt-1 text-destructive">{s.error}</div>}
              </div>
            );
          })}
        </div>
        <DialogFooter><Button onClick={onClose}>{tr("Close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
