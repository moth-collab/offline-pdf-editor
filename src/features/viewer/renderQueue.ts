/* Prioritised render queue: limits concurrent PDF.js renders, renders the
 * pages closest to the viewport first and supports cancellation. */

interface Job {
  prio: number;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
}

const MAX_CONCURRENT = 2;
let running = 0;
const queue: Job[] = [];

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    queue.sort((a, b) => a.prio - b.prio);
    const job = queue.shift()!;
    if (job.cancelled) {
      job.resolve();
      continue;
    }
    running++;
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

export function scheduleRender(prio: number, run: () => Promise<void>): { promise: Promise<void>; cancel: () => void } {
  let job!: Job;
  const promise = new Promise<void>((resolve, reject) => {
    job = { prio, run, resolve, reject, cancelled: false };
  });
  queue.push(job);
  queueMicrotask(pump);
  return {
    promise,
    cancel: () => {
      job.cancelled = true;
    },
  };
}

/** Maximum pixels for a full-page canvas; beyond that a detail tile is used. */
export const MAX_CANVAS_PIXELS = 4096 * 4096;
