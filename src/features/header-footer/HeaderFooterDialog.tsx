/* Header & footer, page numbers and Bates numbering. */
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckRow, ColorInput, Input, Label, NumberInput, RadioGroup, Select } from '@/components/ui/controls';
import { parsePageRanges, stripExt } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { useUi } from '@/stores/ui';
import { runOp } from '@/services/docService';
import { FontPicker } from '@/features/overlay-editor/OverlayProperties';
import { getLanguage, tr } from '@/i18n';

export type HFPreset = 'page-numbers' | 'bates' | 'custom';
const SLOTS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
type Slot = (typeof SLOTS)[number];
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

function useDoc(): DocState | null {
  return useDocuments((s) => (s.activeId ? s.docs[s.activeId] : null));
}

function formatDate(fmt: string, d = new Date()): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  if (fmt === 'thai') return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
  if (fmt === 'thai-short') return `${dd}/${mm}/${d.getFullYear() + 543}`;
  if (fmt === 'iso') return `${d.getFullYear()}-${mm}-${dd}`;
  if (fmt === 'us') return `${mm}/${dd}/${d.getFullYear()}`;
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function initialText(preset: HFPreset): Partial<Record<Slot, string>> {
  const th = getLanguage() === 'th';
  if (preset === 'page-numbers') return { 'bottom-center': th ? 'หน้า {page} จาก {total}' : 'Page {page} of {total}' };
  if (preset === 'bates') return { 'bottom-right': '{bates}' };
  return {};
}

export function HeaderFooterDialog({ onClose, preset = 'custom' }: { onClose: () => void; preset?: HFPreset }) {
  const doc = useDoc();
  const settings = useUi((s) => s.settings);
  const [text, setText] = useState<Partial<Record<Slot, string>>>(() => initialText(preset));
  const [focused, setFocused] = useState<Slot>(preset === 'bates' ? 'bottom-right' : 'bottom-center');
  const inputs = useRef<Partial<Record<Slot, HTMLInputElement | null>>>({});
  const [font, setFont] = useState(getLanguage() === 'th' ? 'Sarabun' : settings.defaultFont || 'Noto Sans');
  const [size, setSize] = useState(10);
  const [color, setColor] = useState('#000000');
  const [margins, setMargins] = useState({ top: 28, bottom: 28, left: 36, right: 36 });
  const [scope, setScope] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState('');
  const [start, setStart] = useState(1);
  const [dateFormat, setDateFormat] = useState(getLanguage() === 'th' ? 'thai' : 'dmy');
  const [thaiDigits, setThaiDigits] = useState(false);
  const [bates, setBates] = useState({ prefix: '', start: 1, digits: 6, suffix: '' });
  const [busy, setBusy] = useState(false);
  const usesBates = Object.values(text).some((t) => t?.includes('{bates}'));

  const pages = useMemo(() => (doc && scope === 'range' ? parsePageRanges(range, doc.info.page_count) : null), [doc, scope, range]);
  if (!doc) return null;
  const total = doc.info.page_count;
  const rangeInvalid = scope === 'range' && !pages;
  const empty = !SLOTS.some((s) => text[s]?.trim());

  const insert = (token: string) => {
    const el = inputs.current[focused];
    const cur = text[focused] ?? '';
    const pos = el?.selectionStart ?? cur.length;
    const next = cur.slice(0, pos) + token + cur.slice(el?.selectionEnd ?? pos);
    setText({ ...text, [focused]: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + token.length, pos + token.length);
    });
  };

  const sample = (t: string) => {
    const first = (pages?.[0] ?? 0) + start;
    const last = start + (scope === 'range' && pages ? pages.length : total) - 1;
    let out = t
      .replace(/\{page\}/g, String(first))
      .replace(/\{total\}/g, String(last))
      .replace(/\{date\}/g, formatDate(dateFormat))
      .replace(/\{bates\}/g, `${bates.prefix}${String(bates.start).padStart(bates.digits, '0')}${bates.suffix}`);
    if (thaiDigits) out = out.replace(/[0-9]/g, (d) => THAI_DIGITS[+d]);
    return out.replace(/\{file\}/g, stripExt(doc.info.display_name));
  };

  const apply = async () => {
    setBusy(true);
    const res = await runOp(doc.id, tr('Header & footer'), 'doc.headerFooter', {
      ...Object.fromEntries(SLOTS.map((s) => [s, text[s] ?? ''])),
      font,
      font_size: size,
      color,
      margins,
      ...(scope === 'range' && pages ? { pages, count_selected_only: true } : {}),
      start_number: start,
      date_format: dateFormat,
      thai_digits: thaiDigits,
      bates,
    });
    setBusy(false);
    if (res) onClose();
  };

  const slotInput = (s: Slot) => (
    <Input
      key={s}
      ref={(el) => {
        inputs.current[s] = el;
      }}
      data-testid={`hf-${s}`}
      value={text[s] ?? ''}
      onFocus={() => setFocused(s)}
      onChange={(e) => setText({ ...text, [s]: e.target.value })}
      className={focused === s ? 'ring-1 ring-primary/40' : ''}
      placeholder={tr(s.endsWith('left') ? 'Left' : s.endsWith('right') ? 'Right' : 'Center')}
    />
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{preset === 'page-numbers' ? tr('Add page numbers') : preset === 'bates' ? tr('Bates numbering') : tr('Header & footer')}</DialogTitle>
          <DialogDescription>{tr('Text is added as real, searchable text. Applying again replaces the previous header and footer.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>{tr('Header')}</Label>
          <div className="grid grid-cols-3 gap-2">{SLOTS.slice(0, 3).map(slotInput)}</div>
          <Label>{tr('Footer')}</Label>
          <div className="grid grid-cols-3 gap-2">{SLOTS.slice(3).map(slotInput)}</div>
          <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11.5px]">
            <span className="text-muted-foreground">{tr('Insert:')}</span>
            {[
              ['{page}', tr('Page number')],
              ['{total}', tr('Last page number')],
              ['{date}', tr('Date')],
              ['{file}', tr('File name')],
              ['{bates}', tr('Bates number')],
            ].map(([t, l]) => (
              <Button key={t} size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => insert(t)}>
                {l}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label>{tr('Font')}</Label>
            <FontPicker value={font} onChange={setFont} />
          </div>
          <div className="space-y-1">
            <Label>{tr('Font size')}</Label>
            <NumberInput value={size} onChange={setSize} min={4} max={72} suffix="pt" />
          </div>
          <div className="space-y-1">
            <Label>{tr('Color')}</Label>
            <ColorInput value={color} onChange={(v) => v && setColor(v)} />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {(['top', 'bottom', 'left', 'right'] as const).map((k, i) => (
            <div key={k} className="space-y-1">
              <Label>{[tr('Top margin'), tr('Bottom margin'), tr('Left margin'), tr('Right margin')][i]}</Label>
              <NumberInput value={margins[k]} onChange={(v) => setMargins({ ...margins, [k]: v })} min={0} max={300} suffix="pt" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{tr('Pages')}</Label>
            <RadioGroup
              value={scope}
              onValueChange={(v) => setScope(v as 'all' | 'range')}
              options={[
                { value: 'all', label: tr('All pages ({0})', total) },
                { value: 'range', label: tr('Page range') },
              ]}
            />
            {scope === 'range' && <Input value={range} onChange={(e) => setRange(e.target.value)} placeholder={tr('e.g. 3-10')} className={rangeInvalid && range ? 'border-destructive' : ''} />}
            <div className="flex items-center gap-2 pt-1">
              <Label className="shrink-0">{tr('Start numbering at')}</Label>
              <NumberInput value={start} onChange={(v) => setStart(Math.max(0, Math.round(v)))} min={0} max={1000000} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{tr('Date format')}</Label>
            <Select
              value={dateFormat}
              onValueChange={setDateFormat}
              options={[
                { value: 'thai', label: formatDate('thai'), raw: true },
                { value: 'thai-short', label: formatDate('thai-short'), raw: true },
                { value: 'dmy', label: formatDate('dmy'), raw: true },
                { value: 'us', label: formatDate('us'), raw: true },
                { value: 'iso', label: formatDate('iso'), raw: true },
              ]}
            />
            <CheckRow checked={thaiDigits} onChange={setThaiDigits} label={tr('Use Thai digits (๑ ๒ ๓)')} />
          </div>
        </div>
        {usesBates && (
          <div className="grid grid-cols-4 gap-2 rounded-md border p-2">
            <div className="space-y-1">
              <Label>{tr('Prefix')}</Label>
              <Input value={bates.prefix} onChange={(e) => setBates({ ...bates, prefix: e.target.value })} placeholder="CASE-" data-testid="hf-bates-prefix" />
            </div>
            <div className="space-y-1">
              <Label>{tr('First number')}</Label>
              <NumberInput value={bates.start} onChange={(v) => setBates({ ...bates, start: Math.max(0, Math.round(v)) })} min={0} max={99999999999} />
            </div>
            <div className="space-y-1">
              <Label>{tr('Digits')}</Label>
              <NumberInput value={bates.digits} onChange={(v) => setBates({ ...bates, digits: Math.min(12, Math.max(1, Math.round(v))) })} min={1} max={12} />
            </div>
            <div className="space-y-1">
              <Label>{tr('Suffix')}</Label>
              <Input value={bates.suffix} onChange={(e) => setBates({ ...bates, suffix: e.target.value })} />
            </div>
          </div>
        )}
        {!empty && (
          <div className="rounded-md bg-muted/50 p-2 text-[12px]" data-testid="hf-preview">
            <div className="mb-1 text-[11px] text-muted-foreground">{tr('Preview (first page)')}</div>
            <div className="grid grid-cols-3 gap-2">
              {SLOTS.map((s) => (
                <div key={s} className={s.endsWith('center') ? 'text-center' : s.endsWith('right') ? 'text-right' : ''}>
                  {text[s] ? sample(text[s]!) : ' '}
                </div>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tr('Cancel')}
          </Button>
          <Button onClick={apply} disabled={busy || empty || rangeInvalid} data-testid="hf-apply">
            {tr('Apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
