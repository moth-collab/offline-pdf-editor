/* Overlay object model helpers: factories, geometry, snapping, z-order and
 * WYSIWYG line measurement. All geometry in PDF user space (points). */
import { uid } from '@/lib/utils';
import type { ImageOverlay, LineOverlay, LinkOverlay, OverlayObject, Point, Rect, ShapeOverlay, TextOverlay } from '@/types/editor';
import type { AppSettings, PageInfo } from '@shared/types';

export function textDefaults(s: AppSettings): Omit<TextOverlay, 'id' | 'page' | 'rect'> {
  return {
    kind: 'text',
    rotation: 0,
    opacity: 1,
    text: '',
    font: s.defaultFont || 'Noto Sans',
    fontSize: s.defaultFontSize || 12,
    color: s.defaultTextColor || '#000000',
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    align: 'left',
    lineHeight: 1.25,
    charSpacing: 0,
    background: null,
    borderColor: null,
    borderWidth: 0,
    padding: 2,
  };
}

export const shapeDefaults: Omit<ShapeOverlay, 'id' | 'page' | 'rect' | 'kind'> = {
  rotation: 0,
  opacity: 1,
  stroke: '#d92d20',
  strokeWidth: 2,
  fill: null,
  fillOpacity: 1,
  dash: null,
};

/** Defaults the user picked for new objects (properties panel without selection). */
export interface ShapeDefaults {
  stroke?: string | null;
  strokeWidth?: number;
  fill?: string | null;
  fillOpacity?: number;
  dash?: number[] | null;
  opacity?: number;
}
export const toolDefaults: { text: Partial<TextOverlay>; shape: ShapeDefaults } = { text: {}, shape: {} };

export function createText(page: number, rect: Rect, s: AppSettings): TextOverlay {
  return { ...textDefaults(s), ...toolDefaults.text, id: uid('txt'), page, rect } as TextOverlay;
}

export function createShape(kind: 'rect' | 'ellipse', page: number, rect: Rect): ShapeOverlay {
  return { ...shapeDefaults, ...toolDefaults.shape, kind, id: uid('shp'), page, rect } as ShapeOverlay;
}

export function createLine(kind: 'line' | 'arrow', page: number, a: Point, b: Point): LineOverlay {
  const d = toolDefaults.shape;
  return {
    kind,
    id: uid('ln'),
    page,
    rect: bboxOf([a, b]),
    rotation: 0,
    opacity: d.opacity ?? 1,
    points: [a, b],
    stroke: d.stroke ?? '#d92d20',
    strokeWidth: d.strokeWidth ?? 2,
    dash: d.dash ?? null,
  };
}

export function createImage(page: number, rect: Rect, assetId: string, w: number, h: number): ImageOverlay {
  return { kind: 'image', id: uid('img'), page, rect, rotation: 0, opacity: 1, assetId, naturalWidth: w, naturalHeight: h, crop: [0, 0, 0, 0], flipH: false, flipV: false, borderColor: null, borderWidth: 0 };
}

export function createLink(page: number, rect: Rect, target: LinkOverlay['target']): LinkOverlay {
  return { kind: 'link', id: uid('lnk'), page, rect, rotation: 0, opacity: 1, target };
}

export function bboxOf(pts: Point[]): Rect {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function translate(o: OverlayObject, dx: number, dy: number): OverlayObject {
  const rect: Rect = [o.rect[0] + dx, o.rect[1] + dy, o.rect[2] + dx, o.rect[3] + dy];
  if (o.kind === 'line' || o.kind === 'arrow') {
    return { ...o, rect, points: [[o.points[0][0] + dx, o.points[0][1] + dy], [o.points[1][0] + dx, o.points[1][1] + dy]] };
  }
  return { ...o, rect };
}

export function withCenterSize(o: OverlayObject, cx: number, cy: number, w: number, h: number): OverlayObject {
  const rect: Rect = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  return { ...o, rect } as OverlayObject;
}

export function center(r: Rect): Point {
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
}

export function size(r: Rect): [number, number] {
  return [Math.abs(r[2] - r[0]), Math.abs(r[3] - r[1])];
}

/** Axis aligned bounding box of a rotated object (PDF space). */
export function rotatedBounds(o: OverlayObject): Rect {
  if (!o.rotation) return o.rect;
  const [cx, cy] = center(o.rect);
  const [w, h] = size(o.rect);
  const t = (-o.rotation * Math.PI) / 180; // clockwise on screen = negative in y-up space
  const c = Math.cos(t);
  const s = Math.sin(t);
  const pts: Point[] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
  return bboxOf(pts);
}

// ---------------------------------------------------------------- snapping
export interface Guide {
  axis: 'x' | 'y';
  value: number; // PDF coordinate
}

/** Snap a moving bounding box to page edges/centre and other objects. */
export function snapMove(moving: Rect, others: Rect[], page: PageInfo, tolerance: number): { dx: number; dy: number; guides: Guide[] } {
  const cb = page.cropbox;
  const xTargets = [cb[0], cb[2], (cb[0] + cb[2]) / 2];
  const yTargets = [cb[1], cb[3], (cb[1] + cb[3]) / 2];
  for (const r of others) {
    xTargets.push(r[0], r[2], (r[0] + r[2]) / 2);
    yTargets.push(r[1], r[3], (r[1] + r[3]) / 2);
  }
  const xs = [moving[0], moving[2], (moving[0] + moving[2]) / 2];
  const ys = [moving[1], moving[3], (moving[1] + moving[3]) / 2];
  let best: { d: number; v: number } | null = null;
  for (const x of xs) for (const t of xTargets) if (Math.abs(t - x) <= tolerance && (!best || Math.abs(t - x) < Math.abs(best.d))) best = { d: t - x, v: t };
  let bestY: { d: number; v: number } | null = null;
  for (const y of ys) for (const t of yTargets) if (Math.abs(t - y) <= tolerance && (!bestY || Math.abs(t - y) < Math.abs(bestY.d))) bestY = { d: t - y, v: t };
  const guides: Guide[] = [];
  if (best) guides.push({ axis: 'x', value: best.v });
  if (bestY) guides.push({ axis: 'y', value: bestY.v });
  return { dx: best?.d ?? 0, dy: bestY?.d ?? 0, guides };
}

// ---------------------------------------------------------------- z-order
export function reorder(list: OverlayObject[], ids: string[], op: 'front' | 'back' | 'forward' | 'backward'): OverlayObject[] {
  const sel = new Set(ids);
  if (op === 'front') return [...list.filter((o) => !sel.has(o.id)), ...list.filter((o) => sel.has(o.id))];
  if (op === 'back') return [...list.filter((o) => sel.has(o.id)), ...list.filter((o) => !sel.has(o.id))];
  const out = [...list];
  if (op === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) {
      if (sel.has(out[i].id) && !sel.has(out[i + 1].id) && out[i + 1].page === out[i].page) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (sel.has(out[i].id) && !sel.has(out[i - 1].id) && out[i - 1].page === out[i].page) [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
  }
  return out;
}

// ---------------------------------------------------------------- text measurement
/** CSS used for text boxes, at an arbitrary px-per-pt scale. Shared by the
 * editor display and the measurement (so line breaks are identical). */
export function textCss(o: TextOverlay, scale: number): React.CSSProperties {
  return {
    fontFamily: `"${o.font}", "Noto Sans", "Noto Sans Thai", sans-serif`,
    fontSize: `${o.fontSize * scale}px`,
    lineHeight: `${o.fontSize * o.lineHeight * scale}px`,
    letterSpacing: o.charSpacing ? `${o.charSpacing * scale}px` : undefined,
    fontWeight: o.bold ? 700 : 400,
    fontStyle: o.italic ? 'italic' : 'normal',
    textDecoration: [o.underline ? 'underline' : '', o.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
    textAlign: o.align,
    color: o.color,
    padding: `${o.padding * scale}px`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: 'normal',
    lineBreak: 'auto',
  };
}

let measurer: HTMLDivElement | null = null;

/** Measure the exact line breaks the browser uses for a text box. */
export function measureLines(o: TextOverlay): { text: string; end: boolean }[] {
  const scale = 4; // measure at 4 px/pt for sub-point precision
  if (!measurer) {
    measurer = document.createElement('div');
    measurer.setAttribute('aria-hidden', 'true');
    Object.assign(measurer.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', boxSizing: 'border-box' });
    document.body.appendChild(measurer);
  }
  const el = measurer;
  const css = textCss(o, scale);
  el.removeAttribute('style');
  Object.assign(el.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', boxSizing: 'border-box' }, css as any);
  el.style.width = `${Math.abs(o.rect[2] - o.rect[0]) * scale}px`;
  el.textContent = o.text;
  const node = el.firstChild;
  const out: { text: string; end: boolean }[] = [];
  if (!node) return out;
  const text = o.text;
  const range = document.createRange();
  let lineStart = 0;
  let lastTop: number | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push({ text: text.slice(lineStart, i), end: true });
      lineStart = i + 1;
      lastTop = null;
      continue;
    }
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rects = range.getClientRects();
    if (!rects.length) continue;
    const top = rects[rects.length - 1].top;
    if (lastTop !== null && top > lastTop + 1) {
      out.push({ text: text.slice(lineStart, i), end: false });
      lineStart = i;
    }
    lastTop = top;
  }
  out.push({ text: text.slice(lineStart), end: true });
  return out;
}

/** Prepare overlays for saving/flattening: attach measured line breaks. */
export function prepareForSave(list: OverlayObject[]): OverlayObject[] {
  return list.map((o) => (o.kind === 'text' ? ({ ...o, lines: measureLines(o) } as unknown as OverlayObject) : o));
}

/** Height (pt) needed to show all text of a text box. */
export function neededTextHeight(o: TextOverlay): number {
  const lines = Math.max(1, measureLines(o).length);
  return lines * o.fontSize * o.lineHeight + o.padding * 2;
}
