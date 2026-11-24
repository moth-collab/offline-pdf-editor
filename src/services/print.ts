/* Printing: pages are rendered locally with PDF.js into a print-only DOM and
 * the operating system print dialog is opened. Nothing leaves the computer. */
import { bridge } from '@/lib/api';
import type { DocState } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { getPdf, pdfjsLib } from '@/features/viewer/pdfjs';
import { tr } from '@/i18n';

const PRINT_DPI = 150;

export async function printDocument(d: DocState, pages?: number[]) {
  if (d.overlays.length) {
    toast('info', tr("Unsaved objects are printed as shown"), tr("Overlay objects are printed after you save the document."));
  }
  const pdf = await getPdf(d.id, d.info.revision);
  const list = pages ?? Array.from({ length: d.info.page_count }, (_, i) => i);
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.appendChild(root);
  }
  root.replaceChildren();
  let cancelled = false;
  const ui = useUi.getState();
  ui.setBusy({ label: tr("Preparing pages for printing…"), progress: 0, cancel: () => (cancelled = true) });
  const urls: string[] = [];
  try {
    for (let k = 0; k < list.length; k++) {
      if (cancelled) return;
      const page = await pdf.getPage(list[k] + 1);
      const viewport = page.getViewport({ scale: PRINT_DPI / 72, rotation: d.info.pages[list[k]].rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE, intent: 'print' } as any).promise;
      const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = document.createElement('img');
      img.src = url;
      root.appendChild(img);
      ui.setBusy({ label: tr("Preparing pages for printing… {0}/{1}", k + 1, list.length), progress: (k + 1) / list.length, cancel: () => (cancelled = true) });
    }
    await Promise.all([...root.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => (img.onload = r)))));
    ui.setBusy(null);
    const res = await bridge().app.print();
    if (!res.ok && res.error && res.error !== 'cancelled') toast('error', tr("Printing failed"), res.error);
  } finally {
    ui.setBusy(null);
    root.replaceChildren();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}
