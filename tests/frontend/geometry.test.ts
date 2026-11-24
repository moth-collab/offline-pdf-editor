import { describe, expect, it } from 'vitest';
import { computeLayout, CSS_UNITS, firstVisibleSlot, objectFrame, pdfToView, rectToView, stepZoom, viewSize, viewToPdf } from '../../src/features/viewer/geometry';

const page = (rotation: number, cropbox = [0, 0, 600, 800]) => ({
  width: cropbox[2] - cropbox[0],
  height: cropbox[3] - cropbox[1],
  rotation,
  cropbox,
});

describe('geometry', () => {
  it('maps PDF origin corners for each rotation', () => {
    // PDF top-left (0, 800)
    expect(pdfToView(page(0), 1, 0, 800)).toEqual([0, 0]);
    // rotated 90 cw: unrotated top-left goes to top-right
    const [x90, y90] = pdfToView(page(90), 1, 0, 800);
    expect(x90).toBeCloseTo(800 * CSS_UNITS);
    expect(y90).toBeCloseTo(0);
    const [x180, y180] = pdfToView(page(180), 1, 0, 800);
    expect(x180).toBeCloseTo(600 * CSS_UNITS);
    expect(y180).toBeCloseTo(800 * CSS_UNITS);
    const [x270, y270] = pdfToView(page(270), 1, 0, 800);
    expect(x270).toBeCloseTo(0);
    expect(y270).toBeCloseTo(600 * CSS_UNITS);
  });

  it('round-trips points for all rotations, zooms and offset crop boxes', () => {
    for (const rot of [0, 90, 180, 270]) {
      for (const zoom of [0.5, 1, 2.25]) {
        const p = page(rot, [50, 60, 500, 700]);
        for (const [x, y] of [
          [50, 60],
          [123.4, 456.7],
          [499, 699],
        ]) {
          const [sx, sy] = pdfToView(p, zoom, x, y);
          const [bx, by] = viewToPdf(p, zoom, sx, sy);
          expect(bx).toBeCloseTo(x, 6);
          expect(by).toBeCloseTo(y, 6);
        }
      }
    }
  });

  it('swaps view size for rotated pages', () => {
    expect(viewSize(page(90), 1)).toEqual({ width: 800 * CSS_UNITS, height: 600 * CSS_UNITS });
    expect(viewSize(page(0), 2).width).toBeCloseTo(1200 * CSS_UNITS);
  });

  it('crop box offset moves content', () => {
    const p = page(0, [50, 60, 500, 700]);
    // PDF point (100, 300) is 50pt from the crop left and 400pt from the crop top
    const [sx, sy] = pdfToView(p, 1, 100, 300);
    expect(sx).toBeCloseTo(50 * CSS_UNITS);
    expect(sy).toBeCloseTo(400 * CSS_UNITS);
  });

  it('rect and object frames', () => {
    const r = rectToView(page(0), 1, [100, 700, 200, 750]);
    expect(r.left).toBeCloseTo(100 * CSS_UNITS);
    expect(r.top).toBeCloseTo(50 * CSS_UNITS);
    expect(r.width).toBeCloseTo(100 * CSS_UNITS);
    const f = objectFrame(page(90), 1, [100, 700, 200, 750], 15);
    expect(f.angle).toBe(105);
    expect(f.w).toBeCloseTo(100 * CSS_UNITS);
  });

  it('layouts and visibility search', () => {
    const pages = Array.from({ length: 500 }, () => page(0));
    const lay = computeLayout(pages, 1, 'continuous', 1000, 0);
    expect(lay.slots).toHaveLength(500);
    const i = firstVisibleSlot(lay.slots, lay.slots[250].top + 5);
    expect(i).toBe(250);
    const two = computeLayout(pages.slice(0, 5), 1, 'two-page', 1000, 0);
    expect(two.slots[1].top).toBe(two.slots[0].top);
    expect(two.slots[2].top).toBeGreaterThan(two.slots[0].top);
    const single = computeLayout(pages, 1, 'single', 1000, 42);
    expect(single.slots).toHaveLength(1);
    expect(single.slots[0].index).toBe(42);
  });

  it('zoom steps', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(64, 1)).toBe(64);
  });
});
