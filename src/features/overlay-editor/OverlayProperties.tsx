/* Properties of the selected overlay objects (or defaults for new ones). */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Bold, ChevronDown, ChevronUp, Copy, FlipHorizontal2, FlipVertical2, ImageUp, Italic,
  Lock, Strikethrough, Trash2, Underline, Unlock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColorInput, Input, Label, NumberInput, Select, Slider, Tooltip } from '@/components/ui/controls';
import { call } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { useUi } from '@/stores/ui';
import { commitOverlays, setOverlaysTransient } from '@/services/docService';
import { runCommand } from '@/app/commands';
import type { ImageOverlay, LineOverlay, LinkOverlay, OverlayObject, ShapeOverlay, TextOverlay } from '@/types/editor';
import { pickImageAsset } from '@/features/viewer/ToolLayer';
import { size, toolDefaults } from './model';
import { tr } from '@/i18n';

interface FontFamily {
  family: string;
  scripts: string[];
  bundled: boolean;
}

const useFonts = create<{ families: FontFamily[]; loaded: boolean; load: () => void }>((set, get) => ({
  families: [],
  loaded: false,
  load: () => {
    if (get().loaded) return;
    set({ loaded: true });
    call<{ families: FontFamily[] }>('fonts.list')
      .then((r) => set({ families: r.families }))
      .catch(() => set({ loaded: false }));
  },
}));

export function FontPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { families, load } = useFonts();
  useEffect(load, [load]);
  const list = families.length ? families : [{ family: value, scripts: [], bundled: false }];
  const hasValue = list.some((f) => f.family === value);
  return (
    <Select
      value={value}
      onValueChange={onChange}
      options={[...(hasValue ? [] : [{ value, label: tr("{0} (not installed)", value) }]), ...list.map((f) => ({ value: f.family, label: <span style={{ fontFamily: `"${f.family}"` }}>{f.family}{f.scripts.includes('thai') ? ' · ไทย' : ''}</span> }))]}
    />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-b px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function Toggle({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <button onClick={onClick} aria-label={label} aria-pressed={active} className={cn('flex h-7 w-7 items-center justify-center rounded-md border', active ? 'border-primary bg-accent text-accent-foreground' : 'border-input hover:bg-muted')}>
        {children}
      </button>
    </Tooltip>
  );
}

export function OverlayProperties({ doc, defaultsOnly }: { doc: DocState; defaultsOnly?: boolean }) {
  const settings = useUi((s) => s.settings);
  const [, force] = useState(0);
  const sliderBefore = useRef<OverlayObject[] | null>(null);
  const ids = doc.selection.kind === 'overlay' ? doc.selection.ids : [];
  const sel = doc.overlays.filter((o) => ids.includes(o.id));
  const o = sel[0];

  // defaults for the next objects (no selection)
  if (defaultsOnly || !o) {
    const isText = doc.tool === 'add-text';
    const t = { font: settings.defaultFont, fontSize: settings.defaultFontSize, color: settings.defaultTextColor, ...toolDefaults.text } as TextOverlay;
    const sh = { stroke: '#d92d20', strokeWidth: 2, fill: null, ...toolDefaults.shape } as ShapeOverlay;
    const setT = (p: Partial<TextOverlay>) => {
      Object.assign(toolDefaults.text, p);
      force((n) => n + 1);
    };
    const setS = (p: Partial<ShapeOverlay>) => {
      Object.assign(toolDefaults.shape, p);
      force((n) => n + 1);
    };
    return (
      <div>
        <div className="px-3 pt-2 text-[11.5px] text-muted-foreground">{tr("Settings for new")} {isText ? tr("text boxes") : 'shapes'}</div>
        {isText ? (
          <Section title={tr("Text")}>
            <FontPicker value={t.font} onChange={(v) => setT({ font: v })} />
            <div className="flex gap-2">
              <NumberInput value={t.fontSize} onChange={(v) => setT({ fontSize: v })} min={1} max={500} suffix="pt" className="w-24" />
              <ColorInput value={t.color} onChange={(v) => v && setT({ color: v })} />
            </div>
          </Section>
        ) : (
          <Section title={tr("Line & fill")}>
            <div className="flex items-center gap-2"><Label className="w-14">{tr("Stroke")}</Label><ColorInput value={sh.stroke} onChange={(v) => setS({ stroke: v })} allowNone /></div>
            <div className="flex items-center gap-2"><Label className="w-14">{tr("Width")}</Label><NumberInput value={sh.strokeWidth} onChange={(v) => setS({ strokeWidth: v })} min={0} max={50} step={0.5} suffix="pt" /></div>
            <div className="flex items-center gap-2"><Label className="w-14">{tr("Fill")}</Label><ColorInput value={sh.fill} onChange={(v) => setS({ fill: v })} allowNone /></div>
          </Section>
        )}
      </div>
    );
  }

  const apply = (patch: Partial<OverlayObject> | ((x: OverlayObject) => Partial<OverlayObject>), label = tr('Change properties')) => {
    const cur = useDocuments.getState().docs[doc.id];
    const next = cur.overlays.map((x) => (ids.includes(x.id) ? ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) } as OverlayObject) : x));
    commitOverlays(doc.id, label, next, cur.overlays);
  };
  const live = (patch: Partial<OverlayObject>) => {
    const cur = useDocuments.getState().docs[doc.id];
    if (!sliderBefore.current) sliderBefore.current = cur.overlays;
    setOverlaysTransient(doc.id, cur.overlays.map((x) => (ids.includes(x.id) ? ({ ...x, ...patch } as OverlayObject) : x)));
  };
  const commitLive = (label: string) => {
    const cur = useDocuments.getState().docs[doc.id];
    if (sliderBefore.current) commitOverlays(doc.id, label, cur.overlays, sliderBefore.current);
    sliderBefore.current = null;
  };

  const [w, h] = size(o.rect);
  const page = doc.info.pages[o.page];
  const left = Math.min(o.rect[0], o.rect[2]) - page.cropbox[0];
  const top = page.cropbox[3] - Math.max(o.rect[1], o.rect[3]);
  const setGeom = (nl: number, nt: number, nw: number, nh: number) => {
    const x0 = nl + page.cropbox[0];
    const y1 = page.cropbox[3] - nt;
    apply((x) => {
      const rect: [number, number, number, number] = [x0, y1 - nh, x0 + nw, y1];
      if (x.kind === 'line' || x.kind === 'arrow') {
        const sx = nw / Math.max(w, 0.01);
        const sy = nh / Math.max(h, 0.01);
        const ox = Math.min(o.rect[0], o.rect[2]);
        const oy = Math.min(o.rect[1], o.rect[3]);
        return { rect, points: x.points.map(([px, py]) => [x0 + (px - ox) * sx, y1 - nh + (py - oy) * sy]) as LineOverlay['points'] };
      }
      return { rect };
    }, tr("Move/resize object"));
  };

  return (
    <div data-testid="overlay-properties">
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <span className="flex-1 text-[12.5px] font-medium capitalize">{sel.length > 1 ? tr("{0} objects", sel.length) : o.kind === 'rect' ? tr("Rectangle") : o.kind}</span>
        <Tooltip content={tr("Duplicate (Ctrl+D)")}><button className="rounded p-1 hover:bg-muted" onClick={() => runCommand('edit.duplicate')} aria-label={tr("Duplicate")}><Copy className="h-3.5 w-3.5" /></button></Tooltip>
        <Tooltip content={o.locked ? tr("Unlock") : tr("Lock position")}><button className="rounded p-1 hover:bg-muted" onClick={() => apply({ locked: !o.locked }, o.locked ? tr("Unlock") : tr("Lock"))} aria-label={tr("Lock")}>{o.locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}</button></Tooltip>
        <Tooltip content={tr("Delete (Del)")}><button className="rounded p-1 text-destructive hover:bg-muted" onClick={() => runCommand('edit.delete')} aria-label={tr("Delete object")}><Trash2 className="h-3.5 w-3.5" /></button></Tooltip>
      </div>

      {o.kind === 'text' && <TextSection o={o} apply={apply} />}
      {o.kind === 'image' && <ImageSection o={o} apply={apply} live={live} commitLive={commitLive} />}
      {(o.kind === 'rect' || o.kind === 'ellipse') && <ShapeSection o={o} apply={apply} live={live} commitLive={commitLive} />}
      {(o.kind === 'line' || o.kind === 'arrow') && <LineSection o={o} apply={apply} />}
      {o.kind === 'link' && <LinkSection o={o} apply={apply} pageCount={doc.info.page_count} />}

      {sel.length === 1 && (
        <Section title={tr("Position & size (pt)")}>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>X</Label><NumberInput value={left} onChange={(v) => setGeom(v, top, w, h)} /></div>
            <div><Label>Y</Label><NumberInput value={top} onChange={(v) => setGeom(left, v, w, h)} /></div>
            <div><Label>{tr("Width")}</Label><NumberInput value={w} min={1} onChange={(v) => setGeom(left, top, v, h)} /></div>
            <div><Label>{tr("Height")}</Label><NumberInput value={h} min={1} onChange={(v) => setGeom(left, top, w, v)} /></div>
          </div>
          {o.kind !== 'line' && o.kind !== 'arrow' && o.kind !== 'link' && (
            <div className="flex items-center gap-2"><Label className="w-16">{tr("Rotation")}</Label><NumberInput value={o.rotation} onChange={(v) => apply({ rotation: ((v % 360) + 360) % 360 }, tr("Rotate object"))} suffix="°" /></div>
          )}
        </Section>
      )}

      {o.kind !== 'link' && (
        <Section title={tr("Appearance")}>
          <div className="flex items-center gap-2">
            <Label className="w-16">{tr("Opacity")}</Label>
            <Slider value={[Math.round(o.opacity * 100)]} min={5} max={100} step={1} onValueChange={([v]) => live({ opacity: v / 100 })} onValueCommit={() => commitLive(tr("Change opacity"))} />
            <span className="w-9 text-right text-[11px]">{Math.round(o.opacity * 100)}%</span>
          </div>
        </Section>
      )}

      <Section title={tr("Arrange")}>
        <div className="grid grid-cols-4 gap-1">
          <Tooltip content={tr("Bring to front")}><Button size="icon" variant="outline" onClick={() => runCommand('overlay.front')}><ArrowUpToLine className="h-3.5 w-3.5" /></Button></Tooltip>
          <Tooltip content={tr("Bring forward")}><Button size="icon" variant="outline" onClick={() => runCommand('overlay.forward')}><ChevronUp className="h-3.5 w-3.5" /></Button></Tooltip>
          <Tooltip content={tr("Send backward")}><Button size="icon" variant="outline" onClick={() => runCommand('overlay.backward')}><ChevronDown className="h-3.5 w-3.5" /></Button></Tooltip>
          <Tooltip content={tr("Send to back")}><Button size="icon" variant="outline" onClick={() => runCommand('overlay.back')}><ArrowDownToLine className="h-3.5 w-3.5" /></Button></Tooltip>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">{tr("Objects stay editable until you save; saving writes them into the PDF. Use Flatten to merge them into the page now.")}</p>
      </Section>
    </div>
  );
}

type Apply = (patch: Partial<OverlayObject> | ((x: OverlayObject) => Partial<OverlayObject>), label?: string) => void;

function TextSection({ o, apply }: { o: TextOverlay; apply: Apply }) {
  const set = (p: Partial<TextOverlay>, label = tr('Format text')) => apply(p as Partial<OverlayObject>, label);
  return (
    <>
      <Section title={tr("Text")}>
        <FontPicker value={o.font} onChange={(v) => set({ font: v }, tr("Change font"))} />
        <div className="flex gap-2">
          <NumberInput value={o.fontSize} onChange={(v) => set({ fontSize: v }, tr("Change font size"))} min={1} max={500} step={1} suffix="pt" className="w-24" />
          <ColorInput value={o.color} onChange={(v) => v && set({ color: v }, tr("Change text color"))} />
        </div>
        <div className="flex gap-1">
          <Toggle active={o.bold} onClick={() => set({ bold: !o.bold })} label={tr("Bold")}><Bold className="h-3.5 w-3.5" /></Toggle>
          <Toggle active={o.italic} onClick={() => set({ italic: !o.italic })} label={tr("Italic")}><Italic className="h-3.5 w-3.5" /></Toggle>
          <Toggle active={o.underline} onClick={() => set({ underline: !o.underline })} label={tr("Underline")}><Underline className="h-3.5 w-3.5" /></Toggle>
          <Toggle active={o.strike} onClick={() => set({ strike: !o.strike })} label={tr("Strikethrough")}><Strikethrough className="h-3.5 w-3.5" /></Toggle>
          <span className="w-2" />
          <Toggle active={o.align === 'left'} onClick={() => set({ align: 'left' })} label={tr("Align left")}><AlignLeft className="h-3.5 w-3.5" /></Toggle>
          <Toggle active={o.align === 'center'} onClick={() => set({ align: 'center' })} label={tr("Center")}><AlignCenter className="h-3.5 w-3.5" /></Toggle>
          <Toggle active={o.align === 'right'} onClick={() => set({ align: 'right' })} label={tr("Align right")}><AlignRight className="h-3.5 w-3.5" /></Toggle>
          <Toggle active={o.align === 'justify'} onClick={() => set({ align: 'justify' })} label={tr("Justify")}><AlignJustify className="h-3.5 w-3.5" /></Toggle>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{tr("Line spacing")}</Label><NumberInput value={o.lineHeight} onChange={(v) => set({ lineHeight: v }, tr("Line spacing"))} min={0.5} max={5} step={0.05} /></div>
          <div><Label>{tr("Char spacing")}</Label><NumberInput value={o.charSpacing} onChange={(v) => set({ charSpacing: v }, tr("Character spacing"))} min={-5} max={50} step={0.1} suffix="pt" /></div>
        </div>
      </Section>
      <Section title={tr("Box")}>
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Fill")}</Label><ColorInput value={o.background} onChange={(v) => set({ background: v }, tr("Background"))} allowNone /></div>
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Border")}</Label><ColorInput value={o.borderColor} onChange={(v) => set({ borderColor: v, borderWidth: v && !o.borderWidth ? 1 : o.borderWidth }, tr("Border"))} allowNone /></div>
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Width")}</Label><NumberInput value={o.borderWidth} onChange={(v) => set({ borderWidth: v }, tr("Border width"))} min={0} max={20} step={0.5} suffix="pt" /></div>
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Padding")}</Label><NumberInput value={o.padding} onChange={(v) => set({ padding: v }, tr("Padding"))} min={0} max={50} step={0.5} suffix="pt" /></div>
      </Section>
    </>
  );
}

function ImageSection({ o, apply, live, commitLive }: { o: ImageOverlay; apply: Apply; live: (p: Partial<OverlayObject>) => void; commitLive: (l: string) => void }) {
  const names = [tr('Left'), tr('Top'), tr('Right'), tr('Bottom')];
  return (
    <Section title={tr("Image")}>
      <div className="flex gap-1">
        <Toggle active={o.flipH} onClick={() => apply({ flipH: !o.flipH } as Partial<OverlayObject>, tr("Flip image"))} label={tr("Flip horizontally")}><FlipHorizontal2 className="h-3.5 w-3.5" /></Toggle>
        <Toggle active={o.flipV} onClick={() => apply({ flipV: !o.flipV } as Partial<OverlayObject>, tr("Flip image"))} label={tr("Flip vertically")}><FlipVertical2 className="h-3.5 w-3.5" /></Toggle>
        <Button size="sm" variant="outline" className="ml-auto" onClick={async () => {
          const a = await pickImageAsset();
          if (a) apply({ assetId: a.asset_id, naturalWidth: a.width, naturalHeight: a.height, crop: [0, 0, 0, 0] } as Partial<OverlayObject>, tr("Replace image"));
        }}><ImageUp className="h-3.5 w-3.5" /> {tr("Replace")}</Button>
      </div>
      <div className="text-[11px] text-muted-foreground">{tr("Crop (cropped parts are removed from the file)")}</div>
      {o.crop.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <Label className="w-12">{names[i]}</Label>
          <Slider value={[Math.round(c * 100)]} min={0} max={90} step={1}
            onValueChange={([v]) => {
              const crop = [...o.crop] as ImageOverlay['crop'];
              crop[i] = v / 100;
              if (crop[0] + crop[2] < 0.95 && crop[1] + crop[3] < 0.95) live({ crop } as Partial<OverlayObject>);
            }}
            onValueCommit={() => commitLive(tr("Crop image"))} />
          <span className="w-8 text-right text-[11px]">{Math.round(c * 100)}%</span>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => {
        const [w] = size(o.rect);
        const ratio = (o.naturalHeight * (1 - o.crop[1] - o.crop[3])) / (o.naturalWidth * (1 - o.crop[0] - o.crop[2]));
        const nh = w * ratio;
        const top = Math.max(o.rect[1], o.rect[3]);
        apply({ rect: [o.rect[0], top - nh, o.rect[2], top] }, tr("Reset aspect ratio"));
      }}>{tr("Reset aspect ratio")}</Button>
    </Section>
  );
}

const DASHES: Record<string, number[] | null> = { solid: null, dashed: [6, 3], dotted: [1.5, 2.5] };
const dashName = (d: number[] | null) => (!d ? 'solid' : d[0] > 2 ? 'dashed' : 'dotted');

function ShapeSection({ o, apply, live, commitLive }: { o: ShapeOverlay; apply: Apply; live: (p: Partial<OverlayObject>) => void; commitLive: (l: string) => void }) {
  return (
    <Section title={tr("Line & fill")}>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Border")}</Label><ColorInput value={o.stroke} onChange={(v) => apply({ stroke: v } as Partial<OverlayObject>, tr("Border color"))} allowNone /></div>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Width")}</Label><NumberInput value={o.strokeWidth} onChange={(v) => apply({ strokeWidth: v } as Partial<OverlayObject>, tr("Border width"))} min={0} max={50} step={0.5} suffix="pt" /></div>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Style")}</Label><Select value={dashName(o.dash)} onValueChange={(v) => apply({ dash: DASHES[v] } as Partial<OverlayObject>, tr("Line style"))} options={[{ value: 'solid', label: tr("Solid") }, { value: 'dashed', label: tr("Dashed") }, { value: 'dotted', label: tr("Dotted") }]} /></div>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Fill")}</Label><ColorInput value={o.fill} onChange={(v) => apply({ fill: v } as Partial<OverlayObject>, tr("Fill color"))} allowNone /></div>
      {o.fill && (
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Fill opacity")}</Label>
          <Slider value={[Math.round(o.fillOpacity * 100)]} min={0} max={100} onValueChange={([v]) => live({ fillOpacity: v / 100 } as Partial<OverlayObject>)} onValueCommit={() => commitLive(tr("Fill opacity"))} />
        </div>
      )}
    </Section>
  );
}

function LineSection({ o, apply }: { o: LineOverlay; apply: Apply }) {
  return (
    <Section title={tr("Line")}>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Color")}</Label><ColorInput value={o.stroke} onChange={(v) => v && apply({ stroke: v } as Partial<OverlayObject>, tr("Line color"))} /></div>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Width")}</Label><NumberInput value={o.strokeWidth} onChange={(v) => apply({ strokeWidth: v } as Partial<OverlayObject>, tr("Line width"))} min={0.25} max={50} step={0.5} suffix="pt" /></div>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Style")}</Label><Select value={dashName(o.dash)} onValueChange={(v) => apply({ dash: DASHES[v] } as Partial<OverlayObject>, tr("Line style"))} options={[{ value: 'solid', label: tr("Solid") }, { value: 'dashed', label: tr("Dashed") }, { value: 'dotted', label: tr("Dotted") }]} /></div>
      <div className="flex items-center gap-2"><Label className="w-16">{tr("Arrow")}</Label><Select value={o.kind} onValueChange={(v) => apply({ kind: v } as Partial<OverlayObject>, tr("Line ending"))} options={[{ value: 'line', label: tr("None") }, { value: 'arrow', label: tr("Arrow at end") }]} /></div>
    </Section>
  );
}

function LinkSection({ o, apply, pageCount }: { o: LinkOverlay; apply: Apply; pageCount: number }) {
  const [url, setUrl] = useState(o.target.type === 'url' ? o.target.url : '');
  return (
    <Section title={tr("Link target")}>
      <Select value={o.target.type} onValueChange={(v) => apply({ target: v === 'url' ? { type: 'url', url: url || 'https://' } : { type: 'page', page: 0 } } as Partial<OverlayObject>, tr("Link target"))}
        options={[{ value: 'url', label: tr("Web address") }, { value: 'page', label: tr("Page in this document") }]} />
      {o.target.type === 'url' ? (
        <Input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => /^(https?:\/\/|mailto:)/i.test(url) && apply({ target: { type: 'url', url } } as Partial<OverlayObject>, tr("Link target"))} placeholder="https://…" />
      ) : (
        <NumberInput value={o.target.page + 1} min={1} max={pageCount} onChange={(v) => apply({ target: { type: 'page', page: Math.round(v) - 1 } } as Partial<OverlayObject>, tr("Link target"))} />
      )}
    </Section>
  );
}
