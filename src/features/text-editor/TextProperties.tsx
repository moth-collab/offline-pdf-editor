/* Properties of the selected existing text (Direct Edit). Formatting changes
 * go through the same preview → confirm → apply workflow. */
import { useEffect, useState } from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, Strikethrough, Underline } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColorInput, Label, NumberInput } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import type { DocState } from '@/stores/documents';
import { FontPicker } from '@/features/overlay-editor/OverlayProperties';
import { Pencil, Trash2 } from 'lucide-react';
import { cacheKey, requestPreview, useTextEdit, type EditOptions } from './service';
import { tr } from '@/i18n';

const STATUS_BADGE: Record<string, [string, string]> = {
  embedded: ['Embedded', 'bg-success/10 text-success'],
  subset: ['Embedded subset', 'bg-success/10 text-success'],
  standard: ['Standard font', 'bg-accent text-accent-foreground'],
  missing: ['Not embedded', 'bg-warning/10 text-warning'],
  unsupported: ['Type 3 – not editable', 'bg-destructive/10 text-destructive'],
  unknown: ['Unknown', 'bg-muted text-muted-foreground'],
};

export function TextProperties({ doc }: { doc: DocState }) {
  const sel = useTextEdit((s) => s.selected);
  const objs = useTextEdit((s) => (sel ? s.cache[cacheKey(doc.id, doc.info.revision, sel.page)] : undefined));
  const block = objs?.blocks.find((b) => b.id === sel?.blockId);
  const st = block?.lines[0].style;
  const [opts, setOpts] = useState<EditOptions>({});
  useEffect(() => setOpts({}), [block?.id, doc.info.revision]);
  if (!sel || !block || !st) return null;
  const v = {
    family: opts.font_family ?? st.family,
    size: opts.size ?? st.size,
    color: opts.color ?? st.color,
    bold: opts.bold ?? st.bold,
    italic: opts.italic ?? st.italic,
  };
  const changed = Object.keys(opts).length > 0;
  const [rawLabel, cls] = STATUS_BADGE[st.font_status] ?? STATUS_BADGE.unknown;
  const label = tr(rawLabel);
  const toggle = (k: keyof EditOptions, cur: boolean) => setOpts({ ...opts, [k]: !cur });
  const btn = (active: boolean) => cn('flex h-7 w-7 items-center justify-center rounded-md border', active ? 'border-primary bg-accent text-accent-foreground' : 'border-input hover:bg-muted');
  return (
    <div className="space-y-3 p-3" data-testid="text-properties">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{tr("Existing text")}</div>
        <div className="mt-1 line-clamp-3 text-[12px]">{block.text}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
          <span className="truncate">{st.font}</span>
          <span className={cn('rounded px-1.5 py-[1px]', cls)}>{label}</span>
        </div>
        <div className="mt-2 flex gap-1">
          <Button size="xs" variant="outline" onClick={() => useTextEdit.getState().setEditing(true, block.lines.map((l) => l.text.replace(/\s+$/, '')).join('\n'))}><Pencil className="h-3 w-3" /> {tr("Edit text")}</Button>
          <Button size="xs" variant="outline" onClick={() => requestPreview({ docId: doc.id, page: sel.page, lineIds: sel.lineIds, newText: '', originalText: block.text })}><Trash2 className="h-3 w-3" /> {tr("Delete")}</Button>
        </div>
      </div>
      <div className="space-y-2">
        <Label>{tr("Font")}</Label>
        <FontPicker value={v.family} onChange={(f) => setOpts({ ...opts, font_family: f })} />
        <div className="flex gap-2">
          <NumberInput value={v.size} onChange={(n) => setOpts({ ...opts, size: n })} min={1} max={500} suffix="pt" className="w-24" />
          <ColorInput value={v.color} onChange={(c) => c && setOpts({ ...opts, color: c })} />
        </div>
        <div className="flex gap-1">
          <button className={btn(v.bold)} onClick={() => toggle('bold', v.bold)} aria-label={tr("Bold")}><Bold className="h-3.5 w-3.5" /></button>
          <button className={btn(v.italic)} onClick={() => toggle('italic', v.italic)} aria-label={tr("Italic")}><Italic className="h-3.5 w-3.5" /></button>
          <button className={btn(!!opts.underline)} onClick={() => setOpts({ ...opts, underline: !opts.underline })} aria-label={tr("Underline")}><Underline className="h-3.5 w-3.5" /></button>
          <button className={btn(!!opts.strike)} onClick={() => setOpts({ ...opts, strike: !opts.strike })} aria-label={tr("Strikethrough")}><Strikethrough className="h-3.5 w-3.5" /></button>
        </div>
        <div className="flex gap-1">
          {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight], ['justify', AlignJustify]] as const).map(([a, Icon]) => (
            <button key={a} className={btn(opts.align === a)} onClick={() => setOpts({ ...opts, align: a })} aria-label={tr("Align {0}", a)}><Icon className="h-3.5 w-3.5" /></button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>{tr("Line spacing")}</Label><NumberInput value={opts.line_height ?? 1.2} onChange={(n) => setOpts({ ...opts, line_height: n })} min={0.5} max={5} step={0.05} /></div>
          <div><Label>{tr("Char spacing")}</Label><NumberInput value={opts.char_spacing ?? 0} onChange={(n) => setOpts({ ...opts, char_spacing: n })} min={-5} max={50} step={0.1} suffix="pt" /></div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!changed}
          onClick={() => requestPreview({ docId: doc.id, page: sel.page, lineIds: sel.lineIds, newText: block.lines.map((l) => l.text.replace(/\s+$/, '')).join('\n'), originalText: block.text, ...opts })}
          data-testid="apply-text-format"
        >
          {tr("Preview formatting…")}
        </Button>
        {changed && <Button size="sm" variant="ghost" onClick={() => setOpts({})}>{tr("Reset")}</Button>}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{tr("Double-click the text to change it. Drag it to move it, or drag its right edge to reflow the paragraph.")}</p>
    </div>
  );
}
