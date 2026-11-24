/* Creation gestures for the active tool (overlay objects, existing image
 * editing). Annotation tools add their own gestures in Phase 5. */
import { useEffect, useRef, useState } from 'react';
import type { DocumentInfo, PageInfo } from '@shared/types';
import { bridge, call, errorMessage } from '@/lib/api';
import { useDocuments, type DocState } from '@/stores/documents';
import { toast, useUi } from '@/stores/ui';
import { askText } from '@/stores/prompt';
import { applyInfo, commitOverlays, setOverlaysTransient, snapshot } from '@/services/docService';
import type { OverlayObject, Point, Rect } from '@/types/editor';
import { normRect, rectToView, viewToPdf, type PageSlot } from './geometry';
import { createImage, createLine, createLink, createShape, createText } from '@/features/overlay-editor/model';
import { useOverlayUi } from '@/features/overlay-editor/OverlayLayer';
import { AnnotationToolLayer, isAnnotTool } from '@/features/annotations/AnnotationTools';
import { SignaturePlaceLayer } from '@/features/signatures/dialogs';
import { tr } from '@/i18n';

interface Props {
  doc: DocState;
  pageIndex: number;
  info: PageInfo;
  zoom: number;
  slot: PageSlot;
}

const CREATION = new Set(['add-text', 'add-image', 'shape-rect', 'shape-ellipse', 'shape-line', 'shape-arrow', 'add-link']);

export async function pickImageAsset(): Promise<{ asset_id: string; width: number; height: number } | null> {
  const refs = await bridge().dialog.open('image', tr("Insert image"));
  if (!refs.length) return null;
  try {
    return await call('asset.addImage', { file: refs[0].token });
  } catch (e) {
    toast('error', tr("Cannot insert this image"), errorMessage(e));
    return null;
  }
}

/** Fit an image of natural size (px) into a target rect / around a point. */
export function imageRect(at: Point, natW: number, natH: number, box?: Rect, page?: PageInfo): Rect {
  let w = natW * 0.75; // assume 96 dpi
  let h = natH * 0.75;
  const maxW = page ? (page.cropbox[2] - page.cropbox[0]) * 0.6 : 300;
  if (box && box[2] - box[0] > 8 && box[3] - box[1] > 8) {
    const s = Math.min((box[2] - box[0]) / w, (box[3] - box[1]) / h);
    w *= s;
    h *= s;
    return [box[0], box[3] - h, box[0] + w, box[3]];
  }
  if (w > maxW) {
    h *= maxW / w;
    w = maxW;
  }
  return [at[0], at[1] - h, at[0] + w, at[1]];
}

export function ToolLayer(props: Props) {
  const { doc } = props;
  if (doc.tool === 'signature') return <SignaturePlaceLayer {...props} />;
  if (isAnnotTool(doc.tool) || doc.tool === 'redact-area') return <AnnotationToolLayer {...props} />;
  if (doc.tool === 'edit-images') return <EditImagesLayer {...props} />;
  if (!CREATION.has(doc.tool) || doc.info.owner_authenticated === false) return <DeselectLayer {...props} />;
  return <CreationLayer {...props} />;
}

/** Clicking empty page area in object mode clears the selection. */
function DeselectLayer({ doc }: Props) {
  if (doc.tool !== 'edit-objects') return null;
  return (
    <div
      className="absolute inset-0 z-[5]"
      onPointerDown={() => useDocuments.getState().update(doc.id, { selection: { kind: 'none', ids: [] } })}
    />
  );
}

function CreationLayer({ doc, pageIndex, info, zoom }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{ a: Point; b: Point } | null>(null);
  const settings = useUi((s) => s.settings);
  const tool = doc.tool;

  const pt = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const finish = async (a: Point, b0: Point, shift: boolean) => {
    let b = b0;
    if (shift && tool !== 'shape-line' && tool !== 'shape-arrow') {
      const d = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      b = [a[0] + Math.sign(b[0] - a[0] || 1) * d, a[1] + Math.sign(b[1] - a[1] || 1) * d];
    }
    const pa = viewToPdf(info, zoom, ...a);
    const pb = viewToPdf(info, zoom, ...b);
    const dragged = Math.hypot(b[0] - a[0], b[1] - a[1]) > 6;
    const rect = normRect([pa[0], pa[1], pb[0], pb[1]]);
    const cur = useDocuments.getState().docs[doc.id];
    const before = cur.overlays;
    const pageRot = info.rotation;
    let obj: OverlayObject | null = null;
    if (tool === 'add-text') {
      const t = createText(pageIndex, [0, 0, 0, 0], settings);
      const h = t.fontSize * t.lineHeight + t.padding * 2;
      if (dragged) t.rect = [rect[0], rect[3] - Math.max(h, rect[3] - rect[1]), rect[2], rect[3]];
      else t.rect = [pa[0], pa[1] - h, pa[0] + 200, pa[1]];
      t.rotation = (360 - pageRot) % 360; // appear upright on rotated pages
      if (!dragged && pageRot) {
        // keep the box anchored at the click point on rotated pages
        t.rect = [pa[0] - 100, pa[1] - h / 2, pa[0] + 100, pa[1] + h / 2];
      }
      setOverlaysTransient(doc.id, [...before, t]);
      useDocuments.getState().update(doc.id, { selection: { kind: 'overlay', ids: [t.id], page: pageIndex }, tool: 'add-text' });
      useOverlayUi.getState().setEditing(t.id, before);
      return;
    }
    if (tool === 'shape-rect' || tool === 'shape-ellipse') {
      if (!dragged) return;
      obj = createShape(tool === 'shape-rect' ? 'rect' : 'ellipse', pageIndex, rect);
    } else if (tool === 'shape-line' || tool === 'shape-arrow') {
      if (!dragged) return;
      let pb2 = pb;
      if (shift) {
        const ang = Math.round(Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        pb2 = [pa[0] + len * Math.cos(ang), pa[1] + len * Math.sin(ang)];
      }
      obj = createLine(tool === 'shape-line' ? 'line' : 'arrow', pageIndex, pa, pb2);
    } else if (tool === 'add-image') {
      const asset = await pickImageAsset();
      if (!asset) return;
      obj = createImage(pageIndex, imageRect(pa, asset.width, asset.height, dragged ? rect : undefined, info), asset.asset_id, asset.width, asset.height);
      obj.rotation = (360 - pageRot) % 360;
    } else if (tool === 'add-link') {
      if (!dragged) {
        toast('info', tr("Drag a rectangle over the area that should become a link"));
        return;
      }
      const target = await askText({ title: tr("Add link"), message: tr("Enter a web address (https://…) or a page number of this document."), label: tr("Link target"), okLabel: tr("Add link") });
      if (!target) return;
      const n = parseInt(target, 10);
      if (/^\d+$/.test(target.trim()) && n >= 1 && n <= cur.info.page_count) obj = createLink(pageIndex, rect, { type: 'page', page: n - 1 });
      else if (/^(https?:\/\/|mailto:)/i.test(target.trim())) obj = createLink(pageIndex, rect, { type: 'url', url: target.trim() });
      else if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(target.trim())) obj = createLink(pageIndex, rect, { type: 'url', url: `https://${target.trim()}` });
      else {
        toast('error', tr("Invalid link target"), tr("Use a web address starting with https:// or a page number."));
        return;
      }
    }
    if (!obj) return;
    const latest = useDocuments.getState().docs[doc.id].overlays;
    commitOverlays(doc.id, tr("Add {0}", obj.kind), [...latest, obj], latest);
    useDocuments.getState().update(doc.id, { selection: { kind: 'overlay', ids: [obj.id], page: pageIndex }, tool: 'edit-objects' });
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-[5]"
      style={{ cursor: tool === 'add-text' ? 'text' : 'crosshair' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const p = pt(e);
        setBand({ a: p, b: p });
        ref.current!.setPointerCapture(e.pointerId);
        useDocuments.getState().update(doc.id, { selection: { kind: 'none', ids: [] } });
      }}
      onPointerMove={(e) => band && setBand({ a: band.a, b: pt(e) })}
      onPointerUp={(e) => {
        if (!band) return;
        const { a } = band;
        setBand(null);
        finish(a, pt(e), e.shiftKey);
      }}
      data-testid={`tool-layer-${pageIndex}`}
    >
      {band && (tool === 'shape-line' || tool === 'shape-arrow' ? (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <line x1={band.a[0]} y1={band.a[1]} x2={band.b[0]} y2={band.b[1]} stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 3" />
        </svg>
      ) : (
        <div className="pointer-events-none absolute border border-dashed border-primary bg-primary/5"
          style={{ left: Math.min(band.a[0], band.b[0]), top: Math.min(band.a[1], band.b[1]), width: Math.abs(band.b[0] - band.a[0]), height: Math.abs(band.b[1] - band.a[1]) }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- existing images
interface PageImage {
  xref: number;
  bbox: Rect;
  rect: Rect;
  rotation: number;
  flipV: boolean;
  width: number;
  height: number;
  shared: boolean;
}

function EditImagesLayer({ doc, pageIndex, info, zoom }: Props) {
  const [images, setImages] = useState<PageImage[]>([]);
  useEffect(() => {
    let alive = true;
    call<{ images: PageImage[] }>('doc.pageImages', { doc_id: doc.id, page: pageIndex })
      .then((r) => alive && setImages(r.images.filter((i) => i.width > 1)))
      .catch(() => alive && setImages([]));
    return () => {
      alive = false;
    };
  }, [doc.id, doc.info.revision, pageIndex]);
  const detach = async (img: PageImage) => {
    if (img.shared) {
      toast('warning', tr("This image cannot be edited individually"), tr("It is used in several places of the document."));
      return;
    }
    const cur = useDocuments.getState().docs[doc.id];
    const before = snapshot(cur);
    try {
      const res = await call<DocumentInfo & { image: any }>('images.detach', { doc_id: doc.id, page: pageIndex, xref: img.xref, base_revision: cur.info.revision });
      applyInfo(doc.id, res);
      const im = res.image;
      const obj = createImage(pageIndex, im.rect, im.asset_id, im.natural_width, im.natural_height);
      obj.rotation = im.rotation;
      obj.flipV = !!im.flipV;
      const latest = useDocuments.getState().docs[doc.id];
      const overlays = [...latest.overlays, obj];
      useDocuments.getState().update(doc.id, (d) => ({
        overlays,
        undo: [...d.undo.filter((u) => u.after.revision !== res.revision), { label: tr("Edit image"), before, after: { ...snapshot(latest), overlays }, ts: Date.now() }],
        redo: [],
        selection: { kind: 'overlay', ids: [obj.id], page: pageIndex },
        tool: 'edit-objects',
      }));
    } catch (e) {
      toast('error', tr("Cannot edit this image"), errorMessage(e));
    }
  };
  return (
    <div className="absolute inset-0 z-[5]">
      {images.map((img) => {
        const r = rectToView(info, zoom, img.bbox);
        return (
          <button
            key={img.xref}
            title={img.shared ? tr("Shared image (cannot be edited individually)") : tr("Click to edit this image (move, resize, rotate, crop, replace, delete)")}
            className="absolute border-2 border-dashed border-primary/70 hover:bg-primary/10"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            onClick={() => detach(img)}
            data-testid="existing-image"
          />
        );
      })}
      {!images.length && <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white">{tr("No editable images on this page")}</div>}
    </div>
  );
}
