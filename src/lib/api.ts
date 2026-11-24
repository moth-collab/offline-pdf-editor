/* Thin typed wrapper around the preload bridge. */
import type { ApiError, PdfApi } from '@shared/types';
import { tr } from '@/i18n';

declare global {
  interface Window {
    pdfApi: PdfApi;
  }
}

export class ApiException extends Error {
  code: string;
  details?: unknown;
  constructor(err: ApiError) {
    super(err.message);
    this.code = err.code;
    this.details = err.details;
  }
}

export const bridge = (): PdfApi => {
  if (!window.pdfApi) throw new Error(tr("The application bridge is not available"));
  return window.pdfApi;
};

export async function call<T = any>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await bridge().invoke<T>(op, payload);
  if (!res.ok) throw new ApiException(res.error);
  return res.data;
}

export function errorMessage(e: unknown): string {
  // backend messages are English; translated when a catalogue entry exists
  if (e instanceof ApiException) return tr(e.message);
  if (e instanceof Error) return tr(e.message);
  return String(e);
}
