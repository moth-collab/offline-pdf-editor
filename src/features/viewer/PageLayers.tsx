/* Interactive layers stacked over a rendered page. Each feature contributes a
 * layer; all positions are computed from PDF coordinates. */
import { useEffect, useState } from 'react';
import type { PageInfo } from '@shared/types';
import { bridge, call } from '@/lib/api';
import type { DocState } from '@/stores/documents';
import { useDocuments } from '@/stores/documents';
import { rectToView, type PageSlot } from './geometry';
import { viewerBus } from './viewerBus';
import { OverlayLayer } from '@/features/overlay-editor/OverlayLayer';
import { TextEditLayer } from '@/features/text-editor/TextEditLayer';
import { AnnotationLayer } from '@/features/annotations/AnnotationLayer';
import { FormLayer } from '@/features/forms/FormLayer';
import { ToolLayer } from './ToolLayer';
import type { Rect } from '@/types/editor';

interface Props {
  doc: DocState;
  pageIndex: number;
  info: PageInfo;
  zoom: number;
  slot: PageSlot;
}

interface LinkInfo {
  rect: Rect;
  kind: number;
  uri?: string;
  page?: number;
}

function LinkLayer({ doc, pageIndex, info, zoom }: Props) {
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const key = `${doc.info.revision}:${pageIndex}`;
  useEffect(() => {
    let alive = true;
    call<{ links: LinkInfo[] }>('doc.links', { doc_id: doc.id, page: pageIndex })
      .then((r) => alive && setLinks(r.links))
      .catch(() => alive && setLinks([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!links.length) return null;
  return (
    <>
      {links.map((l, i) => {
        const r = rectToView(info, zoom, l.rect);
        const title = l.uri ? l.uri : l.page !== undefined && l.page >= 0 ? `Go to page ${l.page + 1}` : undefined;
        if (!title) return null;
        return (
          <a
            key={i}
            title={title}
            className="absolute z-[3] cursor-pointer hover:bg-blue-500/10"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            onClick={(e) => {
              e.preventDefault();
              if (l.uri) bridge().app.openExternal(l.uri);
              else if (l.page !== undefined && l.page >= 0) {
                useDocuments.getState().update(doc.id, { currentPage: l.page });
                viewerBus.scrollTo({ docId: doc.id, page: l.page });
              }
            }}
          />
        );
      })}
    </>
  );
}

function SearchLayer({ doc, pageIndex, info, zoom }: Props) {
  const s = doc.search;
  if (!s || !s.hits.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[4]">
      {s.hits.map((h, i) => {
        if (h.page !== pageIndex) return null;
        const r = rectToView(info, zoom, h.rect);
        const active = i === s.index;
        return (
          <div
            key={i}
            className={active ? 'absolute rounded-[1px] bg-orange-500/45 outline outline-2 outline-orange-500' : 'absolute rounded-[1px] bg-yellow-300/45'}
            style={{ left: r.left - 1, top: r.top - 1, width: r.width + 2, height: r.height + 2 }}
          />
        );
      })}
    </div>
  );
}

export function PageLayers(props: Props) {
  const tool = props.doc.tool;
  const linksActive = tool === 'select' || tool === 'hand';
  return (
    <>
      {linksActive && <LinkLayer {...props} />}
      <SearchLayer {...props} />
      <AnnotationLayer {...props} />
      <FormLayer {...props} />
      <TextEditLayer {...props} />
      <OverlayLayer {...props} />
      <ToolLayer {...props} />
    </>
  );
}
