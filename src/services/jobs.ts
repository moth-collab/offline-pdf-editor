/* Background job runner with progress UI and cancellation. */
import { call } from '@/lib/api';
import { useUi } from '@/stores/ui';
import { tr } from '@/i18n';

export interface JobState<T = any> {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  result: T;
  error: { code: string; message: string } | null;
}

export class JobCancelled extends Error {}

/** Start a job and wait for it, showing a progress overlay with Cancel. */
export async function runJob<T = any>(kind: 'ocr' | 'compress' | 'convert' | 'batch', label: string, docId: string | undefined, params: Record<string, unknown>): Promise<JobState<T>> {
  const ui = useUi.getState();
  const start = await call<JobState<T>>('jobs.start', { kind, ...(docId ? { doc_id: docId } : {}), params });
  let cancelRequested = false;
  const cancel = () => {
    cancelRequested = true;
    call('jobs.cancel', { job_id: start.job_id }).catch(() => undefined);
  };
  ui.setBusy({ label, progress: 0, cancel });
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 300));
      const j = await call<JobState<T>>('jobs.get', { job_id: start.job_id });
      ui.setBusy({ label: j.message ? `${label} – ${j.message}` : label, progress: j.progress, cancel });
      if (j.status === 'done') return j;
      if (j.status === 'cancelled' || cancelRequested) throw new JobCancelled(tr("Cancelled"));
      if (j.status === 'error') throw new Error(j.error?.message ?? tr("The operation failed"));
    }
  } finally {
    ui.setBusy(null);
  }
}

export function disposeJob(jobId: string) {
  call('jobs.dispose', { job_id: jobId }).catch(() => undefined);
}
