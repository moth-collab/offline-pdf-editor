/* Interactive form fields on a page.
 *
 *  - Fill mode (Select / Hand tools): native inputs over each widget. Values
 *    are committed on blur / Enter / change as one undoable step each.
 *  - Design mode (Edit Form Fields): select, move, resize and delete fields.
 *  - Creation tools (Text Field, Check Box, …): drag (or click) to place.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageInfo } from '@shared/types';
import { useDocuments, type DocState } from '@/stores/documents';
import { useUi } from '@/stores/ui';
import { rectToView, scaleOf, viewRectToPdf, viewToPdf, type PageSlot } from '@/features/viewer/geometry';
import { setTool } from '@/app/commands';
import { cn } from '@/lib/utils';
import type { Point, Rect, ToolId } from '@/types/editor';
import { tr } from '@/i18n';
import {
  createField,
  deleteWidgets,
  fieldByName,
  fillFields,
  formsKey,
  loadForms,
  updateField,
  useForms,
  type FieldType,
  type FieldValue,
  type FormField,
  type FormWidget,
  type FormsData,
} from './service';

interface Props {
  doc: DocState;
  pageIndex: number;
  info: PageInfo;
  zoom: number;
  slot: PageSlot;
}

export const FORM_CREATE_TOOLS: Partial<Record<ToolId, FieldType>> = {
  'form-text': 'text',
  'form-checkbox': 'checkbox',
  'form-radio': 'radio',
  'form-combo': 'combo',
  'form-list': 'list',
  'form-signature': 'signature',
};

const DEFAULT_SIZE: Record<FieldType, [number, number]> = {
  text: [160, 20],
  checkbox: [14, 14],
  radio: [14, 14],
  combo: [160, 20],
  list: [160, 64],
  signature: [180, 50],
};

export function FormLayer(props: Props) {
  const { doc } = props;
  const tool = doc.tool;
  const rev = doc.info.revision;
  const data = useForms((s) => s.cache[formsKey(doc.id, rev)]);
  useEffect(() => {
    loadForms(doc.id, rev).catch(() => undefined);
  }, [doc.id, rev]);
  if (FORM_CREATE_TOOLS[tool]) return <CreateLayer {...props} type={FORM_CREATE_TOOLS[tool]!} data={data} />;
  if (!data || !data.widgets.length) return null;
  if (tool === 'form-edit') return <DesignLayer {...props} data={data} />;
  if (tool === 'select' || tool === 'hand') return <FillLayer {...props} data={data} />;
  return null;
}

// ---------------------------------------------------------------- fill

function FillLayer({ doc, pageIndex, info, zoom, data }: Props & { data: FormsData }) {
  const highlight = useForms((s) => s.highlight);
  const widgets = useMemo(
    () =>
      data.widgets
        .filter((w) => w.page === pageIndex && !w.hidden)
        // natural tab order: top to bottom, then left to right
        .sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]),
    [data.widgets, pageIndex],
  );
  if (!widgets.length) return null;
  const scale = scaleOf(zoom);
  return (
    <div className="pointer-events-none absolute inset-0 z-[6]" data-testid="form-layer">
      {widgets.map((w) => {
        const f = fieldByName(data, w.field);
        if (!f) return null;
        const box = rectToView(info, zoom, w.rect);
        const disabled = !data.can_fill || f.readonly;
        return (
          <FieldInput
            key={`${w.id}:${JSON.stringify(f.value)}`}
            doc={doc}
            widget={w}
            field={f}
            box={box}
            scale={scale}
            disabled={disabled}
            highlight={highlight}
          />
        );
      })}
    </div>
  );
}

function fieldFontPx(f: FormField, boxH: number, scale: number, multiline: boolean): number {
  if (f.font_size > 0) return f.font_size * scale;
  return multiline ? 12 * scale : Math.max(6, Math.min(12 * scale, boxH * 0.7));
}

function FieldInput({
  doc,
  widget,
  field,
  box,
  scale,
  disabled,
  highlight,
}: {
  doc: DocState;
  widget: FormWidget;
  field: FormField;
  box: { left: number; top: number; width: number; height: number };
  scale: number;
  disabled: boolean;
  highlight: boolean;
}) {
  const commit = (v: FieldValue) => {
    if (JSON.stringify(v) === JSON.stringify(field.value)) return;
    fillFields(doc.id, { [field.name]: v });
  };
  const empty = field.value === '' || field.value === null || field.value === false || (Array.isArray(field.value) && !field.value.length);
  const style: React.CSSProperties = { left: box.left, top: box.top, width: box.width, height: box.height };
  const cls = cn(
    'pointer-events-auto absolute border outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30',
    highlight ? 'border-sky-400/60 bg-sky-100/90' : 'border-transparent bg-white',
    field.required && empty && 'border-red-400',
    disabled && 'pointer-events-none opacity-0',
  );
  const title = field.tooltip || field.name;
  const fontPx = fieldFontPx(field, box.height, scale, field.multiline);
  const common = {
    'data-testid': 'form-field',
    'data-field': field.name,
    title,
    'aria-label': title,
    'aria-required': field.required || undefined,
  };

  if (field.type === 'checkbox' || field.type === 'radio') {
    const checked = field.type === 'checkbox' ? field.value === true : field.value === widget.export;
    const size = Math.min(box.width, box.height);
    return (
      <button
        {...common}
        type="button"
        role={field.type}
        aria-checked={checked}
        disabled={disabled}
        className={cn(cls, 'flex items-center justify-center', field.type === 'radio' && 'rounded-full')}
        style={style}
        onClick={() => commit(field.type === 'checkbox' ? !checked : widget.export)}
      >
        {checked &&
          (field.type === 'checkbox' ? (
            <svg viewBox="0 0 10 10" width={size * 0.8} height={size * 0.8}>
              <path d="M1.6 5.2 4 7.6 8.6 2.4" fill="none" stroke="black" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <span className="block rounded-full bg-black" style={{ width: size * 0.45, height: size * 0.45 }} />
          ))}
      </button>
    );
  }

  if (field.type === 'signature') {
    if (field.signed) return null;
    return (
      <button
        {...common}
        type="button"
        disabled={disabled}
        className={cn(cls, 'flex items-center justify-center text-[11px] text-sky-800')}
        style={style}
        onClick={() => useUi.getState().openDialog('digital-sign', { field: field.name })}
      >
        {tr('Click to sign')}
      </button>
    );
  }

  if (field.type === 'combo') {
    const value = String(field.value ?? '');
    if (field.editable) {
      const listId = `dl-${widget.id}`;
      return (
        <>
          <TextBox {...common} className={cls} style={{ ...style, fontSize: fontPx }} value={value} list={listId} disabled={disabled} onCommit={commit} align={field.align} />
          <datalist id={listId}>
            {field.options.map(([e, d]) => (
              <option key={e} value={e}>
                {d}
              </option>
            ))}
          </datalist>
        </>
      );
    }
    return (
      <select
        {...common}
        disabled={disabled}
        className={cn(cls, 'px-0.5')}
        style={{ ...style, fontSize: fontPx }}
        value={value}
        onChange={(e) => commit(e.target.value)}
      >
        {!field.options.some(([e]) => e === value) && <option value={value}>{value}</option>}
        {field.options.map(([e, d]) => (
          <option key={e} value={e}>
            {d}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'list') {
    const values = Array.isArray(field.value) ? field.value : [];
    return (
      <select
        {...common}
        multiple
        disabled={disabled}
        className={cls}
        style={{ ...style, fontSize: field.font_size > 0 ? field.font_size * scale : 10 * scale }}
        value={values}
        onChange={(e) => {
          const sel = Array.from(e.target.selectedOptions).map((o) => o.value);
          commit(field.multiselect ? sel : sel.slice(-1));
        }}
      >
        {field.options.map(([e, d]) => (
          <option key={e} value={e}>
            {d}
          </option>
        ))}
      </select>
    );
  }

  // text
  return (
    <TextBox
      {...common}
      className={cls}
      style={{ ...style, fontSize: fontPx, letterSpacing: field.comb && field.maxlen ? `${box.width / field.maxlen - fontPx * 0.6}px` : undefined }}
      value={String(field.value ?? '')}
      multiline={field.multiline}
      password={field.password}
      maxLength={field.maxlen || undefined}
      disabled={disabled}
      align={field.align}
      onCommit={commit}
    />
  );
}

function TextBox({
  value,
  onCommit,
  multiline,
  password,
  align,
  className,
  style,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  password?: boolean;
  align?: 'left' | 'center' | 'right';
  className: string;
  style: React.CSSProperties;
  maxLength?: number;
  disabled?: boolean;
  list?: string;
  [k: string]: unknown;
}) {
  const [draft, setDraft] = useState(value);
  const done = () => draft !== value && onCommit(draft);
  const s = { ...style, textAlign: align, padding: multiline ? '1px 2px' : '0 2px' };
  if (multiline) {
    return (
      <textarea
        {...(rest as object)}
        className={cn(className, 'resize-none overflow-hidden leading-tight')}
        style={s}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setDraft(value);
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <input
      {...(rest as object)}
      type={password ? 'password' : 'text'}
      className={className}
      style={s}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
        e.stopPropagation();
      }}
    />
  );
}

// ---------------------------------------------------------------- design

type Drag = { mode: 'move' | 'resize'; handle?: string; x: number; y: number; w: FormWidget; active: boolean };

function DesignLayer({ doc, pageIndex, info, zoom, data }: Props & { data: FormsData }) {
  const [delta, setDelta] = useState<{ dx: number; dy: number; dw: number; dh: number; id: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const selected = doc.selection.kind === 'form' ? new Set(doc.selection.ids) : new Set<string>();
  const widgets = data.widgets.filter((w) => w.page === pageIndex);
  const editable = data.can_edit;

  const select = (w: FormWidget) =>
    useDocuments.getState().update(doc.id, { selection: { kind: 'form', ids: [w.id], page: pageIndex, field: w.field } });

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.active) {
      if (Math.hypot(dx, dy) < 4) return;
      d.active = true;
      layerRef.current?.setPointerCapture(e.pointerId);
    }
    if (d.mode === 'move') setDelta({ dx, dy, dw: 0, dh: 0, id: d.w.id });
    else {
      const h = d.handle!;
      setDelta({
        dx: h.includes('w') ? dx : 0,
        dy: h.includes('n') ? dy : 0,
        dw: h.includes('e') ? dx : h.includes('w') ? -dx : 0,
        dh: h.includes('s') ? dy : h.includes('n') ? -dy : 0,
        id: d.w.id,
      });
    }
  };
  const onUp = () => {
    const d = drag.current;
    const dl = delta;
    drag.current = null;
    setDelta(null);
    if (!d || !d.active || !dl) return;
    const box = rectToView(info, zoom, d.w.rect);
    const l = box.left + dl.dx;
    const t = box.top + dl.dy;
    const w = Math.max(8, box.width + dl.dw);
    const h = Math.max(8, box.height + dl.dh);
    const rect = viewRectToPdf(info, zoom, l, t, l + w, t + h);
    updateField(doc.id, d.w.field, { rect }, d.w.id, d.mode === 'move' ? tr('Move form field') : tr('Resize form field'));
  };

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-[6]"
      data-testid="form-design-layer"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) useDocuments.getState().update(doc.id, { selection: { kind: 'none', ids: [] } });
      }}
    >
      {widgets.map((w) => {
        const r = rectToView(info, zoom, w.rect);
        const dl = delta && delta.id === w.id ? delta : null;
        const isSel = selected.has(w.id);
        const left = r.left + (dl?.dx ?? 0);
        const top = r.top + (dl?.dy ?? 0);
        return (
          <div
            key={w.id}
            data-testid="form-design-field"
            data-field={w.field}
            className={cn(
              'absolute cursor-move border text-[10px]',
              isSel ? 'border-primary bg-primary/15 ring-1 ring-primary' : 'border-sky-500/70 bg-sky-200/50 hover:bg-sky-200/80',
            )}
            style={{ left, top, width: Math.max(8, r.width + (dl?.dw ?? 0)), height: Math.max(8, r.height + (dl?.dh ?? 0)) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              select(w);
              if (editable) drag.current = { mode: 'move', x: e.clientX, y: e.clientY, w, active: false };
            }}
          >
            <span className="pointer-events-none absolute -top-[15px] left-0 max-w-[220px] truncate rounded-sm bg-sky-700 px-1 leading-[14px] text-white">
              {w.field}
              {w.export ? ` = ${w.export}` : ''}
            </span>
            {isSel && editable &&
              ['nw', 'ne', 'sw', 'se'].map((h) => (
                <span
                  key={h}
                  data-handle={h}
                  className="absolute h-2 w-2 border border-primary bg-white"
                  style={{
                    left: h.includes('w') ? -4 : undefined,
                    right: h.includes('e') ? -4 : undefined,
                    top: h.includes('n') ? -4 : undefined,
                    bottom: h.includes('s') ? -4 : undefined,
                    cursor: `${h}-resize`,
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    drag.current = { mode: 'resize', handle: h, x: e.clientX, y: e.clientY, w, active: false };
                  }}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** Delete key removes selected fields in design mode (see featureCommands). */
export function deleteSelectedFields(doc: DocState): boolean {
  if (doc.tool !== 'form-edit' || doc.selection.kind !== 'form' || !doc.selection.ids.length) return false;
  deleteWidgets(doc.id, doc.selection.ids);
  return true;
}

// ---------------------------------------------------------------- create

function CreateLayer({ doc, pageIndex, info, zoom, type, data }: Props & { type: FieldType; data?: FormsData }) {
  const ref = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{ a: Point; b: Point } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const local = (e: React.PointerEvent): Point => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const finish = async (a: Point, b: Point) => {
    let rect: Rect;
    if (Math.abs(b[0] - a[0]) < 6 && Math.abs(b[1] - a[1]) < 6) {
      const [w, h] = DEFAULT_SIZE[type];
      const [x, y] = viewToPdf(info, zoom, a[0], a[1]);
      rect = [x, y - h, x + w, y];
    } else {
      rect = viewRectToPdf(info, zoom, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
    // a radio button joins the selected radio group, so groups are built by repeated clicks
    const sel = doc.selection;
    const group = type === 'radio' && sel.kind === 'form' && sel.field && fieldByName(data, sel.field)?.type === 'radio' ? sel.field : undefined;
    const options = type === 'combo' || type === 'list' ? [tr('Option 1'), tr('Option 2'), tr('Option 3')] : undefined;
    const created = await createField(doc.id, pageIndex, { type, rect, ...(group ? { name: group } : {}), ...(options ? { options } : {}) });
    if (created && type !== 'radio') setTool('form-edit');
  };
  return (
    <div
      ref={ref}
      className="absolute inset-0 z-[7] cursor-crosshair"
      data-testid="form-create-layer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const p = local(e);
        start.current = { x: p[0], y: p[1] };
        setBand({ a: p, b: p });
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => start.current && setBand({ a: [start.current.x, start.current.y], b: local(e) })}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        setBand(null);
        if (s) finish([s.x, s.y], local(e));
      }}
    >
      {band && (
        <div
          className="pointer-events-none absolute border border-dashed border-primary bg-primary/10"
          style={{
            left: Math.min(band.a[0], band.b[0]),
            top: Math.min(band.a[1], band.b[1]),
            width: Math.abs(band.b[0] - band.a[0]),
            height: Math.abs(band.b[1] - band.a[1]),
          }}
        />
      )}
    </div>
  );
}
