import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, ChevronDown, ChevronRight, Eye, EyeOff, FileSearch, Images, Layers, MessageSquare, Paperclip, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { Tooltip, Input, Checkbox } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { bridge, call, errorMessage } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { useDocuments, type DocState } from '@/stores/documents';
import { toast, useUi, type SidebarTab } from '@/stores/ui';
import { goToPage, getCommand, runCommand } from '@/app/commands';
import { runOp } from '@/services/docService';
import { askText } from '@/stores/prompt';
import { ThumbnailGrid } from '@/features/page-organizer/ThumbnailsPanel';
import { getPdf } from '@/features/viewer/pdfjs';
import { viewerBus } from '@/features/viewer/viewerBus';
import type { SearchHit } from '@/types/editor';
import { CommentsPanel } from '@/features/annotations/CommentsPanel';
import { tr } from '@/i18n';

const TABS: { id: SidebarTab; icon: typeof Images; label: string }[] = [
  { id: 'thumbnails', icon: Images, label: 'Page Thumbnails' },
  { id: 'bookmarks', icon: Bookmark, label: 'Bookmarks' },
  { id: 'attachments', icon: Paperclip, label: 'Attachments' },
  { id: 'layers', icon: Layers, label: 'Layers' },
  { id: 'comments', icon: MessageSquare, label: 'Comments' },
  { id: 'search', icon: FileSearch, label: 'Search' },
];

// ---------------------------------------------------------------- bookmarks
type TocEntry = [number, string, number];

function BookmarksPanel({ doc }: { doc: DocState }) {
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const editable = doc.info.owner_authenticated !== false;
  useEffect(() => {
    call<{ toc: TocEntry[] }>('doc.outline', { doc_id: doc.id }).then((r) => setToc(r.toc)).catch(() => setToc([]));
  }, [doc.id, doc.info.revision]);
  const save = (next: TocEntry[], label: string) => runOp(doc.id, label, 'doc.setOutline', { toc: next });
  const hidden = (i: number) => {
    // hidden if any ancestor collapsed
    let lvl = toc[i][0];
    for (let j = i - 1; j >= 0; j--) {
      if (toc[j][0] < lvl) {
        if (collapsed.has(j)) return true;
        lvl = toc[j][0];
      }
    }
    return false;
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <span className="flex-1 text-[11.5px] font-semibold">{tr("Bookmarks")}</span>
        {editable && (
          <Tooltip content={tr("Add bookmark for current page")}>
            <button className="rounded p-1 hover:bg-muted" onClick={() => runCommand('doc.addBookmark')} aria-label={tr("Add bookmark")}>
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="flex-1 overflow-auto py-1">
        {!toc.length && <p className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">{tr("This document has no bookmarks.")}</p>}
        {toc.map((e, i) => {
          if (hidden(i)) return null;
          const hasChildren = i + 1 < toc.length && toc[i + 1][0] > e[0];
          return (
            <div key={i} className="group flex items-center gap-0.5 py-[2px] pr-1 hover:bg-muted" style={{ paddingLeft: 4 + (e[0] - 1) * 14 }}>
              <button
                className={cn('rounded p-0.5', !hasChildren && 'invisible')}
                onClick={() => setCollapsed((s) => {
                  const n = new Set(s);
                  n.has(i) ? n.delete(i) : n.add(i);
                  return n;
                })}
              >
                {collapsed.has(i) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              <button className="min-w-0 flex-1 truncate text-left text-[12px]" onClick={() => e[2] > 0 && goToPage(e[2] - 1)} title={tr("{0} (page {1})", e[1], e[2])}>
                {e[1]}
              </button>
              {editable && (
                <span className="hidden gap-0.5 group-hover:flex">
                  <button className="rounded p-0.5 hover:bg-background" aria-label={tr("Rename")} onClick={async () => {
                    const t = await askText({ title: tr("Rename bookmark"), label: tr("Title"), initial: e[1], okLabel: tr("Rename") });
                    if (t) save(toc.map((x, k) => (k === i ? [x[0], t, x[2]] : x)) as TocEntry[], tr("Rename bookmark"));
                  }}>
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button className="rounded p-0.5 hover:bg-background" aria-label={tr("Delete")} onClick={() => {
                    let end = i + 1;
                    while (end < toc.length && toc[end][0] > e[0]) end++;
                    save([...toc.slice(0, i), ...toc.slice(end)], tr("Delete bookmark"));
                  }}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- attachments
interface Attachment {
  name: string;
  filename: string;
  size: number;
  description?: string;
}

function AttachmentsPanel({ doc }: { doc: DocState }) {
  const [items, setItems] = useState<Attachment[]>([]);
  useEffect(() => {
    call<{ attachments: Attachment[] }>('doc.attachments', { doc_id: doc.id }).then((r) => setItems(r.attachments)).catch(() => setItems([]));
  }, [doc.id, doc.info.revision]);
  const editable = doc.info.owner_authenticated !== false;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <span className="flex-1 text-[11.5px] font-semibold">{tr("Attachments")}</span>
        {editable && (
          <button className="rounded p-1 hover:bg-muted" onClick={() => runCommand('doc.attachFile')} aria-label={tr("Attach file")}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {!items.length && <p className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">{tr("No attached files.")}</p>}
        {items.map((a) => (
          <div key={a.name} className="group flex items-center gap-2 border-b px-2 py-1.5">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px]">{a.filename}</div>
              <div className="text-[10.5px] text-muted-foreground">{formatBytes(a.size)}{a.description ? ` · ${a.description}` : ''}</div>
            </div>
            <button className="rounded p-1 hover:bg-muted" title={tr("Save attachment as…")} onClick={async () => {
              const ref = await bridge().dialog.save('any', a.filename, tr("Save attachment"));
              if (!ref) return;
              try {
                await call('doc.extractAttachment', { doc_id: doc.id, name: a.name, target: ref.token });
                toast('success', tr("Attachment saved"), ref.path);
              } catch (e) {
                toast('error', tr("Could not save the attachment"), errorMessage(e));
              }
            }}>
              <Save className="h-3.5 w-3.5" />
            </button>
            {editable && (
              <button className="rounded p-1 hover:bg-muted" title={tr("Delete attachment")} onClick={() => runOp(doc.id, tr("Delete attachment"), 'doc.deleteAttachment', { name: a.name })}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- layers (optional content)
function LayersPanel({ doc }: { doc: DocState }) {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const update = useDocuments((s) => s.update);
  useEffect(() => {
    let alive = true;
    getPdf(doc.id, doc.info.revision)
      .then(async (pdf) => {
        const cfg = await pdf.getOptionalContentConfig();
        const out: { id: string; name: string }[] = [];
        for (const [id, g] of cfg) out.push({ id, name: (g as any).name ?? id });
        if (alive) setGroups(out);
      })
      .catch(() => alive && setGroups([]));
    return () => {
      alive = false;
    };
  }, [doc.id, doc.info.revision]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-2 py-1 text-[11.5px] font-semibold">{tr("Layers")}</div>
      <div className="flex-1 overflow-auto py-1">
        {!groups.length && <p className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">{tr("This document has no layers.")}</p>}
        {groups.map((g) => {
          const hidden = doc.hiddenLayers.includes(g.id);
          return (
            <button
              key={g.id}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] hover:bg-muted"
              onClick={() => update(doc.id, { hiddenLayers: hidden ? doc.hiddenLayers.filter((x) => x !== g.id) : [...doc.hiddenLayers, g.id] })}
            >
              {hidden ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" /> : <Eye className="h-3.5 w-3.5" />}
              <span className={cn('truncate', hidden && 'text-muted-foreground line-through')}>{g.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- search
export function SearchPanel({ doc }: { doc: DocState }) {
  const [query, setQuery] = useState(doc.search?.query ?? '');
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = useDocuments((s) => s.update);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const go = useCallback(
    (hits: SearchHit[], index: number) => {
      const h = hits[index];
      if (!h) return;
      update(doc.id, (d) => ({ search: d.search ? { ...d.search, index } : d.search, currentPage: h.page }));
      viewerBus.scrollTo({ docId: doc.id, page: h.page, rect: h.rect });
    },
    [doc.id, update],
  );
  const run = async () => {
    if (!query.trim()) {
      update(doc.id, { search: null });
      return;
    }
    setBusy(true);
    try {
      const r = await call<{ results: SearchHit[]; total: number }>('doc.search', { doc_id: doc.id, query, case_sensitive: caseSensitive, whole_word: wholeWord });
      update(doc.id, { search: { query, hits: r.results, index: 0, total: r.total } });
      if (r.results.length) go(r.results, 0);
    } catch (e) {
      toast('error', tr("Search failed"), errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const s = doc.search;
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1.5 border-b p-2">
        <div className="flex gap-1">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (s && s.query === query && s.hits.length) go(s.hits, (s.index + (e.shiftKey ? s.hits.length - 1 : 1)) % s.hits.length);
                else run();
              }
              if (e.key === 'Escape') update(doc.id, { search: null });
            }}
            placeholder={tr("Search text…")}
            data-testid="search-input"
          />
          {s && (
            <button className="rounded p-1 hover:bg-muted" onClick={() => { update(doc.id, { search: null }); setQuery(''); }} aria-label={tr("Clear search")}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11.5px]">
          <label className="flex items-center gap-1"><Checkbox checked={caseSensitive} onCheckedChange={(v) => setCase(v === true)} /> {tr("Match case")}</label>
          <label className="flex items-center gap-1"><Checkbox checked={wholeWord} onCheckedChange={(v) => setWhole(v === true)} /> {tr("Whole words")}</label>
        </div>
        <div className="flex items-center gap-1">
          <Button size="xs" onClick={run} disabled={busy}>{busy ? tr("Searching…") : tr("Search")}</Button>
          {s && s.hits.length > 0 && (
            <>
              <Button size="xs" variant="outline" onClick={() => go(s.hits, (s.index - 1 + s.hits.length) % s.hits.length)}>{tr("Previous")}</Button>
              <Button size="xs" variant="outline" onClick={() => go(s.hits, (s.index + 1) % s.hits.length)}>{tr("Next")}</Button>
            </>
          )}
        </div>
        {s && (
          <div className="text-[11.5px] text-muted-foreground" data-testid="search-count">
            {s.total === 0 ? tr("No matches") : tr("{0} of {1} matches", s.index + 1, s.total)}
            {s.total > s.hits.length ? tr(" (showing first {0})", s.hits.length) : ''}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {s?.hits.map((h, i) => (
          <button key={i} onClick={() => go(s.hits, i)} className={cn('block w-full border-b px-2 py-1.5 text-left hover:bg-muted', i === s.index && 'bg-accent')}>
            <div className="text-[10.5px] font-semibold text-muted-foreground">{tr("Page")} {h.page + 1}</div>
            <div className="line-clamp-2 text-[11.5px]">{h.context}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sidebar
export function Sidebar({ doc }: { doc: DocState }) {
  const open = useUi((s) => s.sidebarOpen);
  const tab = useUi((s) => s.sidebarTab);
  const width = useUi((s) => s.sidebarWidth);
  const setTab = useUi((s) => s.setSidebarTab);
  const toggle = useUi((s) => s.toggleSidebar);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const visibleTabs = TABS.filter((t) => t.id !== 'comments' || getCommand('comment.list'));
  return (
    <div className="flex h-full shrink-0 border-r bg-panel">
      <div className="flex w-9 flex-col items-center gap-0.5 border-r py-1.5">
        {visibleTabs.map((t) => (
          <Tooltip key={t.id} content={tr(t.label)} side="right">
            <button
              onClick={() => (open && tab === t.id ? toggle(false) : setTab(t.id))}
              className={cn('rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground', open && tab === t.id && 'bg-accent text-accent-foreground')}
              aria-label={tr(t.label)}
              data-testid={`sidebar-${t.id}`}
            >
              <t.icon className="h-4 w-4" />
            </button>
          </Tooltip>
        ))}
      </div>
      {open && (
        <div className="relative flex flex-col" style={{ width }}>
          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'thumbnails' && (
              <div className="h-full overflow-auto">
                <ThumbnailGrid doc={doc} width={Math.min(width - 60, 170)} />
              </div>
            )}
            {tab === 'bookmarks' && <BookmarksPanel doc={doc} />}
            {tab === 'attachments' && <AttachmentsPanel doc={doc} />}
            {tab === 'layers' && <LayersPanel doc={doc} />}
            {tab === 'comments' && <CommentsPanel doc={doc} />}
            {tab === 'search' && <SearchPanel doc={doc} />}
          </div>
          <div
            className="absolute right-[-3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-primary/30"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, w: width };
              (e.target as Element).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => drag.current && setWidth(drag.current.w + e.clientX - drag.current.x)}
            onPointerUp={() => (drag.current = null)}
          />
        </div>
      )}
    </div>
  );
}
