import { describe, expect, it } from 'vitest';
import { bboxOf, center, reorder, rotatedBounds, snapMove, translate } from '../../src/features/overlay-editor/model';
import type { OverlayObject } from '../../src/types/editor';
import { remapOverlays } from '../../src/services/docService';

const rect = (id: string, page = 0, r: [number, number, number, number] = [0, 0, 10, 10]) =>
  ({ id, kind: 'rect', page, rect: r, rotation: 0, opacity: 1, stroke: '#000', strokeWidth: 1, fill: null, fillOpacity: 1, dash: null }) as OverlayObject;

describe('overlay model', () => {
  it('translates lines with their points', () => {
    const l = { id: 'l', kind: 'line', page: 0, rect: [0, 0, 10, 10], rotation: 0, opacity: 1, points: [[0, 0], [10, 10]], stroke: '#000', strokeWidth: 1, dash: null } as OverlayObject;
    const m = translate(l, 5, -2) as any;
    expect(m.rect).toEqual([5, -2, 15, 8]);
    expect(m.points).toEqual([[5, -2], [15, 8]]);
  });

  it('rotated bounds grow for 45 degrees', () => {
    const o = { ...rect('a'), rect: [0, 0, 100, 100], rotation: 45 } as OverlayObject;
    const b = rotatedBounds(o);
    expect(b[2] - b[0]).toBeCloseTo(141.42, 1);
    expect(center(b)).toEqual([50, 50]);
  });

  it('snaps to page centre and other objects', () => {
    const page = { index: 0, width: 600, height: 800, rotation: 0, mediabox: [0, 0, 600, 800], cropbox: [0, 0, 600, 800], origin: [0, 800] };
    const s = snapMove([295, 100, 303, 120], [], page, 5);
    expect(s.dx).toBeCloseTo(1); // centre 299 -> 300
    expect(s.guides[0]).toEqual({ axis: 'x', value: 300 });
    const s2 = snapMove([10, 498, 50, 520], [[100, 500, 200, 600]], page, 5);
    expect(s2.dy).toBeCloseTo(2);
  });

  it('z-order operations', () => {
    const list = [rect('a'), rect('b'), rect('c')];
    expect(reorder(list, ['a'], 'front').map((o) => o.id)).toEqual(['b', 'c', 'a']);
    expect(reorder(list, ['c'], 'back').map((o) => o.id)).toEqual(['c', 'a', 'b']);
    expect(reorder(list, ['a'], 'forward').map((o) => o.id)).toEqual(['b', 'a', 'c']);
    expect(reorder(list, ['c'], 'backward').map((o) => o.id)).toEqual(['a', 'c', 'b']);
  });

  it('remaps overlays after page operations', () => {
    const list = [rect('p0', 0), rect('p1', 1), rect('p2', 2)];
    // delete page 1, then pages are [0, 2]
    const out = remapOverlays(list, [0, 2]);
    expect(out.map((o) => [o.id, o.page])).toEqual([
      ['p0', 0],
      ['p2', 1],
    ]);
    // reorder
    expect(remapOverlays(list, [2, 0, 1]).map((o) => [o.id, o.page])).toEqual([
      ['p0', 1],
      ['p1', 2],
      ['p2', 0],
    ]);
    // identity map returns the same array (no history noise)
    expect(remapOverlays(list, [0, 1, 2])).toBe(list);
  });

  it('bbox of points', () => {
    expect(bboxOf([[5, 1], [-2, 9]])).toEqual([-2, 1, 5, 9]);
  });
});
