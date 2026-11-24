/* Properties of the selected annotation, or defaults of the active annotation tool. */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColorInput, Label, NumberInput, Select, Slider, Textarea } from '@/components/ui/controls';
import { useDocuments, type DocState } from '@/stores/documents';
import { annotKey, deleteAnnots, NOTE_ICONS, STAMPS, toolDefaults, TYPE_LABEL, updateAnnot, useAnnots } from './service';
import { tr } from '@/i18n';

export function AnnotationToolDefaults({ tool }: { tool: string }) {
  const defs = useAnnots((s) => s.defaults[tool]);
  const setDefault = useAnnots((s) => s.setDefault);
  const d = { ...toolDefaults(tool), ...defs };
  const label = tool === 'redact-area' ? 'Redaction' : tool.replace('annot-', '');
  return (
    <div className="space-y-2 p-3" data-testid="annot-tool-defaults">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{tr("New")} {label} {tr("comments")}</div>
      {tool !== 'annot-stamp' && tool !== 'redact-area' && (
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Color")}</Label><ColorInput value={d.stroke} onChange={(v) => v && setDefault(tool, { stroke: v })} /></div>
      )}
      {['annot-rect', 'annot-circle', 'annot-freetext'].includes(tool) && (
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Fill")}</Label><ColorInput value={d.fill} onChange={(v) => setDefault(tool, { fill: v })} allowNone /></div>
      )}
      {['annot-rect', 'annot-circle', 'annot-line', 'annot-arrow', 'annot-ink', 'annot-freetext'].includes(tool) && (
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Width")}</Label><NumberInput value={d.border_width} onChange={(v) => setDefault(tool, { border_width: v })} min={0} max={20} step={0.5} suffix="pt" /></div>
      )}
      {['annot-freetext', 'annot-callout'].includes(tool) && (
        <div className="flex items-center gap-2"><Label className="w-16">{tr("Font size")}</Label><NumberInput value={d.font_size} onChange={(v) => setDefault(tool, { font_size: v })} min={4} max={72} suffix="pt" /></div>
      )}
      {tool === 'annot-stamp' && (
        <div className="space-y-1"><Label>{tr("Stamp")}</Label><Select value={d.stamp} onValueChange={(v) => setDefault(tool, { stamp: v })} options={STAMPS.map((s) => ({ value: s, label: s.replace(/([a-z])([A-Z])/g, '$1 $2') }))} /></div>
      )}
      {tool === 'annot-note' && (
        <div className="space-y-1"><Label>{tr("Icon")}</Label><Select value={d.icon} onValueChange={(v) => setDefault(tool, { icon: v })} options={NOTE_ICONS.map((s) => ({ value: s, label: s }))} /></div>
      )}
      {tool !== 'redact-area' && (
        <div className="flex items-center gap-2">
          <Label className="w-16">{tr("Opacity")}</Label>
          <Slider value={[Math.round(d.opacity * 100)]} min={10} max={100} onValueChange={([v]) => setDefault(tool, { opacity: v / 100 })} />
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        {tool.startsWith('annot-highlight') || ['annot-underline', 'annot-strikeout', 'annot-squiggly'].includes(tool)
          ? tr("Select text on the page with the mouse.")
          : tool === 'annot-ink'
            ? tr("Draw on the page with the mouse.")
            : tool === 'redact-area'
              ? tr("Drag over content to mark it. Marked content is removed only when you apply redactions.")
              : tr("Click or drag on the page.")}
      </p>
    </div>
  );
}

export function AnnotationProperties({ doc }: { doc: DocState }) {
  const page = doc.selection.page ?? doc.currentPage;
  const annots = useAnnots((s) => s.cache[annotKey(doc.id, doc.info.revision, page)]);
  const a = annots?.find((x) => doc.selection.ids.includes(x.id));
  const [contents, setContents] = useState(a?.contents ?? '');
  useEffect(() => setContents(a?.contents ?? ''), [a?.id, a?.contents]);
  if (!a) return null;
  const editable = doc.info.owner_authenticated !== false || !!doc.info.permissions?.annotate;
  const set = (spec: Record<string, unknown>, label?: string) => updateAnnot(doc.id, page, a.xref, spec, label);
  const hasFill = ['rect', 'circle', 'freetext', 'polygon'].includes(a.type);
  const hasWidth = ['rect', 'circle', 'line', 'ink', 'polygon', 'polyline', 'freetext'].includes(a.type);
  return (
    <div className="space-y-3 p-3" data-testid="annot-properties">
      <div className="flex items-center">
        <div className="flex-1">
          <div className="text-[12.5px] font-medium">{tr(TYPE_LABEL[a.type] ?? a.type)}</div>
          <div className="text-[11px] text-muted-foreground">
            {a.author || tr("Unknown author")}
            {a.modified ? ` · ${new Date(a.modified).toLocaleString()}` : ''}
          </div>
        </div>
        {editable && (
          <Button size="icon" variant="ghost" className="text-destructive" onClick={() => deleteAnnots(doc.id, page, [a.xref])} aria-label={tr("Delete comment")}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {a.type !== 'redact' && a.type !== 'stamp' && (
        <div className="space-y-1">
          <Label>{a.type === 'freetext' ? tr("Text") : tr("Comment")}</Label>
          <Textarea
            value={contents}
            disabled={!editable}
            rows={4}
            onChange={(e) => setContents(e.target.value)}
            onBlur={() => contents !== a.contents && set({ contents }, tr("Edit comment text"))}
            placeholder={tr("Type a comment…")}
            data-testid="annot-contents"
          />
        </div>
      )}
      {a.type === 'stamp' && <div className="text-[12px]">{tr("Stamp:")} <b>{a.stamp}</b></div>}
      {editable && a.type !== 'redact' && (
        <>
          {a.type !== 'stamp' && (
            <div className="flex items-center gap-2"><Label className="w-16">{tr("Color")}</Label><ColorInput value={a.stroke} onChange={(v) => v && set({ stroke: v }, tr("Change color"))} /></div>
          )}
          {hasFill && <div className="flex items-center gap-2"><Label className="w-16">{tr("Fill")}</Label><ColorInput value={a.fill} onChange={(v) => set({ fill: v }, tr("Change fill"))} allowNone /></div>}
          {hasWidth && <div className="flex items-center gap-2"><Label className="w-16">{tr("Width")}</Label><NumberInput value={a.border_width} onChange={(v) => set({ border_width: v }, tr("Change width"))} min={0} max={20} step={0.5} suffix="pt" /></div>}
          {a.type === 'note' && (
            <div className="flex items-center gap-2"><Label className="w-16">{tr("Icon")}</Label><Select value={a.icon ?? 'Note'} onValueChange={(v) => set({ icon: v }, tr("Change icon"))} options={NOTE_ICONS.map((s) => ({ value: s, label: s }))} /></div>
          )}
          {a.type === 'line' && (
            <div className="flex items-center gap-2"><Label className="w-16">{tr("End")}</Label><Select value={a.line_ends?.[1] ?? 'none'} onValueChange={(v) => set({ line_ends: [a.line_ends?.[0] ?? 'none', v] }, tr("Line ending"))} options={['none', 'open', 'closed', 'circle', 'square'].map((s) => ({ value: s, label: s }))} /></div>
          )}
          <div className="flex items-center gap-2">
            <Label className="w-16">{tr("Opacity")}</Label>
            <OpacitySlider value={a.opacity} onCommit={(v) => set({ opacity: v }, tr("Change opacity"))} />
          </div>
        </>
      )}
      {a.type === 'redact' && <p className="text-[11.5px] text-muted-foreground">{tr("This area is marked for redaction. Use Protect › Apply Redactions to permanently remove the content underneath.")}</p>}
      <Button size="sm" variant="outline" onClick={() => useDocuments.getState().update(doc.id, { selection: { kind: 'none', ids: [] } })}>{tr("Done")}</Button>
    </div>
  );
}

function OpacitySlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(Math.round(value * 100));
  useEffect(() => setV(Math.round(value * 100)), [value]);
  return (
    <>
      <Slider value={[v]} min={10} max={100} onValueChange={([x]) => setV(x)} onValueCommit={([x]) => onCommit(x / 100)} />
      <span className="w-9 text-right text-[11px]">{v}%</span>
    </>
  );
}
