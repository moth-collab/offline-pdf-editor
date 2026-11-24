/* Coordinate conversion between PDF user space and view (CSS pixel) space.
 *
 *  PDF user space : points, origin bottom-left of MediaBox, y up, unrotated.
 *  Page space     : points, origin top-left of the CropBox, y down, unrotated.
 *  View space     : CSS pixels relative to the rendered page's top-left
 *                   corner, after page rotation and zoom.
 *
 * zoom 1.0 == 100% == 1pt rendered as 96/72 CSS px (same as Acrobat/Foxit).
 */
import type { PageInfo } from '@shared/types';
import type { Point, Rect } from '@/types/editor';

export const CSS_UNITS = 96 / 72;

export type PageGeom = Pick<PageInfo, 'width' | 'height' | 'rotation' | 'cropbox'>;

export function scaleOf(zoom: number): number {
  return zoom * CSS_UNITS;
}

export function normRotation(r: number): 0 | 90 | 180 | 270 {
  return ((((Math.round(r / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

/** Size of the rendered page in CSS px. */
export function viewSize(p: PageGeom, zoom: number): { width: number; height: number } {
  const s = scaleOf(zoom);
  const rot = normRotation(p.rotation);
  const w = p.width * s;
  const h = p.height * s;
  return rot === 90 || rot === 270 ? { width: h, height: w } : { width: w, height: h };
}

export function pdfToPage(p: PageGeom, x: number, y: number): Point {
  return [x - p.cropbox[0], p.cropbox[3] - y];
}

export function pageToPdf(p: PageGeom, u: number, v: number): Point {
  return [u + p.cropbox[0], p.cropbox[3] - v];
}

export function pdfToView(p: PageGeom, zoom: number, x: number, y: number): Point {
  const s = scaleOf(zoom);
  const [u, v] = pdfToPage(p, x, y);
  const W = p.width;
  const H = p.height;
  switch (normRotation(p.rotation)) {
    case 90:
      return [(H - v) * s, u * s];
    case 180:
      return [(W - u) * s, (H - v) * s];
    case 270:
      return [v * s, (W - u) * s];
    default:
      return [u * s, v * s];
  }
}

export function viewToPdf(p: PageGeom, zoom: number, sx: number, sy: number): Point {
  const s = scaleOf(zoom);
  const a = sx / s;
  const b = sy / s;
  const W = p.width;
  const H = p.height;
  let u: number;
  let v: number;
  switch (normRotation(p.rotation)) {
    case 90:
      u = b;
      v = H - a;
      break;
    case 180:
      u = W - a;
      v = H - b;
      break;
    case 270:
      u = W - b;
      v = a;
      break;
    default:
      u = a;
      v = b;
  }
  return pageToPdf(p, u, v);
}

/** Axis aligned view box of a PDF rect. */
export function rectToView(p: PageGeom, zoom: number, r: Rect): { left: number; top: number; width: number; height: number } {
  const a = pdfToView(p, zoom, r[0], r[1]);
  const b = pdfToView(p, zoom, r[2], r[3]);
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  return { left, top, width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
}

export function viewRectToPdf(p: PageGeom, zoom: number, x0: number, y0: number, x1: number, y1: number): Rect {
  const a = viewToPdf(p, zoom, x0, y0);
  const b = viewToPdf(p, zoom, x1, y1);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export function normRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/**
 * Frame of a (possibly rotated) object in view space: centre, unrotated size
 * in px, and the CSS rotation to apply (object rotation + page rotation).
 * The object's local width runs along the page's x axis.
 */
export function objectFrame(p: PageGeom, zoom: number, r: Rect, rotation: number) {
  const s = scaleOf(zoom);
  const cx = (r[0] + r[2]) / 2;
  const cy = (r[1] + r[3]) / 2;
  const [vx, vy] = pdfToView(p, zoom, cx, cy);
  return {
    cx: vx,
    cy: vy,
    w: Math.abs(r[2] - r[0]) * s,
    h: Math.abs(r[3] - r[1]) * s,
    angle: rotation + normRotation(p.rotation),
  };
}

/** Convert a view-space delta to a PDF-space delta. */
export function viewDeltaToPdf(p: PageGeom, zoom: number, dx: number, dy: number): Point {
  const o = viewToPdf(p, zoom, 0, 0);
  const q = viewToPdf(p, zoom, dx, dy);
  return [q[0] - o[0], q[1] - o[1]];
}

export function rotatePoint(x: number, y: number, cx: number, cy: number, deg: number): Point {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export interface PageSlot {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Layout {
  slots: PageSlot[];
  totalWidth: number;
  totalHeight: number;
}

export const PAGE_GAP = 14;
export const PAGE_PAD = 20;

/** Compute page positions for a view mode. */
export function computeLayout(pages: PageGeom[], zoom: number, mode: 'continuous' | 'single' | 'two-page', containerWidth: number, current: number): Layout {
  const sizes = pages.map((p) => viewSize(p, zoom));
  const slots: PageSlot[] = [];
  if (mode === 'single') {
    const i = Math.min(Math.max(current, 0), pages.length - 1);
    const s = sizes[i];
    const totalWidth = Math.max(containerWidth, s.width + PAGE_PAD * 2);
    slots.push({ index: i, top: PAGE_PAD, left: (totalWidth - s.width) / 2, width: s.width, height: s.height });
    return { slots, totalWidth, totalHeight: s.height + PAGE_PAD * 2 };
  }
  if (mode === 'two-page') {
    let top = PAGE_PAD;
    let maxRow = 0;
    const rows: number[][] = [];
    for (let i = 0; i < pages.length; i += 2) rows.push(i + 1 < pages.length ? [i, i + 1] : [i]);
    for (const row of rows) maxRow = Math.max(maxRow, row.reduce((acc, i) => acc + sizes[i].width, 0) + PAGE_GAP * (row.length - 1));
    const totalWidth = Math.max(containerWidth, maxRow + PAGE_PAD * 2);
    for (const row of rows) {
      const rowW = row.reduce((acc, i) => acc + sizes[i].width, 0) + PAGE_GAP * (row.length - 1);
      const rowH = Math.max(...row.map((i) => sizes[i].height));
      let left = (totalWidth - rowW) / 2;
      for (const i of row) {
        slots.push({ index: i, top: top + (rowH - sizes[i].height) / 2, left, width: sizes[i].width, height: sizes[i].height });
        left += sizes[i].width + PAGE_GAP;
      }
      top += rowH + PAGE_GAP;
    }
    return { slots, totalWidth, totalHeight: top - PAGE_GAP + PAGE_PAD };
  }
  const maxW = Math.max(0, ...sizes.map((s) => s.width));
  const totalWidth = Math.max(containerWidth, maxW + PAGE_PAD * 2);
  let top = PAGE_PAD;
  sizes.forEach((s, i) => {
    slots.push({ index: i, top, left: (totalWidth - s.width) / 2, width: s.width, height: s.height });
    top += s.height + PAGE_GAP;
  });
  return { slots, totalWidth, totalHeight: top - PAGE_GAP + PAGE_PAD };
}

/** Index into layout.slots of the first slot whose bottom is below y (binary search). */
export function firstVisibleSlot(slots: PageSlot[], y: number): number {
  let lo = 0;
  let hi = slots.length - 1;
  let ans = slots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].top + slots[mid].height >= y) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return Math.max(0, ans);
}

export function fitZoom(pages: PageGeom[], mode: 'fit-width' | 'fit-page', containerW: number, containerH: number, current: number, viewMode: 'continuous' | 'single' | 'two-page'): number {
  if (!pages.length) return 1;
  const ref = pages[Math.min(Math.max(current, 0), pages.length - 1)];
  const s1 = viewSize(ref, 1);
  let w = viewMode === 'two-page' ? s1.width * 2 + PAGE_GAP : Math.max(...pages.slice(0, 50).map((p) => viewSize(p, 1).width));
  if (mode === 'fit-page') w = viewMode === 'two-page' ? s1.width * 2 + PAGE_GAP : s1.width;
  const zw = (containerW - PAGE_PAD * 2 - 14) / w;
  if (mode === 'fit-width') return clampZoom(zw);
  const zh = (containerH - PAGE_PAD * 2) / s1.height;
  return clampZoom(Math.min(zw, zh));
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 64;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 12, 16, 24, 32, 64];

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 1e-3) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-3) ?? MIN_ZOOM;
}
