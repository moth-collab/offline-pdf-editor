/* Imperative viewer requests (scroll to page / rect) */
import type { Rect } from '@/types/editor';

export interface ScrollRequest {
  docId: string;
  page: number;
  rect?: Rect;
  smooth?: boolean;
}

type Listener = (r: ScrollRequest) => void;
const listeners = new Set<Listener>();

export const viewerBus = {
  scrollTo(r: ScrollRequest) {
    listeners.forEach((l) => l(r));
  },
  on(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
