/**
 * Explicit allowlist of backend operations the renderer may invoke.
 *
 * Each op declares a strict zod schema (unknown keys are rejected), how it
 * maps to a backend endpoint, and which payload fields are *file tokens*
 * that main resolves to real paths (with mode checks). The renderer can never
 * send a raw filesystem path to the backend.
 */
import { z } from 'zod';
import { resolve as resolveToken, type FileMode } from '../services/fileRegistry';

const docId = z.string().regex(/^[0-9a-f]{32}$/);
const jobId = z.string().regex(/^[0-9a-f]{32}$/);
const token = z.string().regex(/^[0-9a-f]{36}$/);
const page = z.number().int().min(0).max(1_000_000);
const pages = z.array(page).max(100_000);
const baseRev = z.number().int().min(0).optional();
const num = z.number().finite();
const rect = z.array(num).length(4);
const shortStr = z.string().max(2000);
const anyObj = z.record(z.string(), z.unknown());
const overlays = z.array(anyObj).max(10_000);
const formValue = z.union([z.string().max(100_000), z.boolean(), z.null(), z.array(z.string().max(2000)).max(500)]);

export interface OpDef {
  method: 'GET' | 'POST';
  schema: z.ZodType<any>;
  path: (p: any) => string;
  /** token fields: payload key -> [backend key, mode] */
  files?: Record<string, [string, FileMode]>;
  /** keys that stay in the URL only and must not be sent in the body */
  urlKeys?: string[];
  timeoutMs?: number;
}

const D = (s: string) => (p: any) => `/documents/${p.doc_id}${s}`;

const pt = z.array(num).length(2);
const colorStr = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const annotSpec = z
  .object({
    type: z.enum(['highlight', 'underline', 'strikeout', 'squiggly', 'note', 'freetext', 'callout', 'rect', 'circle', 'line', 'arrow', 'ink', 'stamp', 'redact']).optional(),
    start: pt.optional(),
    stop: pt.optional(),
    quads: z.array(z.array(pt).length(4)).max(5000).optional(),
    point: pt.optional(),
    rect: rect.optional(),
    points: z.array(pt).max(2).optional(),
    strokes: z.array(z.array(pt).max(20000)).max(200).optional(),
    callout: z.array(pt).max(3).optional(),
    contents: z.string().max(100000).optional(),
    subject: z.string().max(500).optional(),
    stroke: colorStr.nullable().optional(),
    fill: colorStr.nullable().optional(),
    text_color: colorStr.optional(),
    opacity: num.min(0).max(1).optional(),
    border_width: num.min(0).max(100).optional(),
    font_size: num.min(1).max(200).optional(),
    icon: z.string().max(40).optional(),
    stamp: z.string().max(40).optional(),
    line_ends: z.array(z.string().max(20)).max(2).optional(),
  })
  .strict();

const textEdit = z
  .object({
    doc_id: docId,
    page,
    line_ids: z.array(z.string().regex(/^b\d{1,6}l\d{1,6}$/)).min(1).max(5000),
    new_text: z.string().max(20000),
    font_family: z.string().max(200).nullable().optional(),
    size: num.min(0.5).max(1000).nullable().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    bold: z.boolean().nullable().optional(),
    italic: z.boolean().nullable().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).nullable().optional(),
    line_height: num.min(0.3).max(10).nullable().optional(),
    char_spacing: num.min(-50).max(200).optional(),
    box: rect.nullable().optional(),
    offset: z.array(num).length(2).nullable().optional(),
    fit: z.enum(['overflow', 'shrink']).optional(),
    base_revision: baseRev,
    accept_warnings: z.boolean().optional(),
  })
  .strict();

export const OPS: Record<string, OpDef> = {
  // ---- general ---------------------------------------------------------------
  'app.capabilities': { method: 'GET', schema: z.object({}).strict(), path: () => '/capabilities' },
  'fonts.list': { method: 'GET', schema: z.object({}).strict(), path: () => '/fonts' },
  'fonts.rescan': { method: 'POST', schema: z.object({}).strict(), path: () => '/fonts/rescan' },
  'pages.sizes': { method: 'GET', schema: z.object({}).strict(), path: () => '/page-sizes' },
  'maintenance.cleanupAssets': { method: 'POST', schema: z.object({}).strict(), path: () => '/maintenance/cleanup-assets' },

  // ---- lifecycle ---------------------------------------------------------------
  'doc.open': {
    method: 'POST',
    schema: z.object({ file: token, password: z.string().max(1024).optional() }).strict(),
    path: () => '/documents/open',
    files: { file: ['path', 'read'] },
  },
  'doc.info': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D(''), urlKeys: ['doc_id'] },
  'doc.close': {
    method: 'POST',
    schema: z.object({ doc_id: docId, delete_session: z.boolean().default(true) }).strict(),
    path: D('/close'),
    urlKeys: ['doc_id'],
  },
  'doc.revision': {
    method: 'POST',
    schema: z.object({ doc_id: docId, revision: z.number().int().min(0) }).strict(),
    path: D('/revision'),
    urlKeys: ['doc_id'],
  },
  'doc.save': {
    method: 'POST',
    schema: z.object({ doc_id: docId, target: token, overlays: overlays.default([]), make_backup: z.boolean().default(true) }).strict(),
    path: D('/save'),
    urlKeys: ['doc_id'],
    files: { target: ['target_path', 'write'] },
  },
  'doc.uiState': {
    method: 'POST',
    schema: z.object({ doc_id: docId, state: anyObj }).strict(),
    path: D('/ui-state'),
    urlKeys: ['doc_id'],
  },
  'recovery.list': { method: 'GET', schema: z.object({}).strict(), path: () => '/recovery' },
  'recovery.restore': { method: 'POST', schema: z.object({ session_id: docId }).strict(), path: () => '/recovery/restore' },
  'recovery.discard': {
    method: 'POST',
    schema: z.object({ session_id: docId }).strict(),
    path: (p) => `/recovery/${p.session_id}/discard`,
    urlKeys: ['session_id'],
  },

  // ---- read only document data ---------------------------------------------------
  'doc.analysis': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/pages/analysis'), urlKeys: ['doc_id'] },
  'doc.search': {
    method: 'POST',
    schema: z.object({ doc_id: docId, query: z.string().max(1000), case_sensitive: z.boolean().optional(), whole_word: z.boolean().optional(), max_results: z.number().int().max(10000).optional() }).strict(),
    path: D('/search'),
    urlKeys: ['doc_id'],
  },
  'doc.links': {
    method: 'GET',
    schema: z.object({ doc_id: docId, page }).strict(),
    path: (p) => `/documents/${p.doc_id}/pages/${p.page}/links`,
    urlKeys: ['doc_id', 'page'],
  },
  'doc.outline': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/outline'), urlKeys: ['doc_id'] },
  'doc.setOutline': {
    method: 'POST',
    schema: z.object({ doc_id: docId, toc: z.array(z.tuple([z.number().int(), z.string().max(1000), z.number().int()])).max(20000), base_revision: baseRev }).strict(),
    path: D('/outline'),
    urlKeys: ['doc_id'],
  },
  'doc.attachments': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/attachments'), urlKeys: ['doc_id'] },
  'doc.addAttachment': {
    method: 'POST',
    schema: z.object({ doc_id: docId, file: token, description: shortStr.optional(), base_revision: baseRev }).strict(),
    path: D('/attachments/add'),
    urlKeys: ['doc_id'],
    files: { file: ['path', 'read'] },
  },
  'doc.deleteAttachment': {
    method: 'POST',
    schema: z.object({ doc_id: docId, name: shortStr, base_revision: baseRev }).strict(),
    path: D('/attachments/delete'),
    urlKeys: ['doc_id'],
  },
  'doc.extractAttachment': {
    method: 'POST',
    schema: z.object({ doc_id: docId, name: shortStr, target: token }).strict(),
    path: D('/attachments/extract'),
    urlKeys: ['doc_id'],
    files: { target: ['target_path', 'write'] },
  },
  'doc.fonts': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/fonts'), urlKeys: ['doc_id'] },
  'asset.addImage': {
    method: 'POST',
    schema: z.object({ file: token.optional(), data_base64: z.string().max(120_000_000).optional() }).strict(),
    path: () => '/assets/image',
    files: { file: ['path', 'read'] },
  },

  // ---- pages -------------------------------------------------------------------
  'pages.delete': { method: 'POST', schema: z.object({ doc_id: docId, pages, base_revision: baseRev }).strict(), path: D('/pages/delete'), urlKeys: ['doc_id'] },
  'pages.rotate': {
    method: 'POST',
    schema: z.object({ doc_id: docId, pages, angle: z.number().int(), base_revision: baseRev }).strict(),
    path: D('/pages/rotate'),
    urlKeys: ['doc_id'],
  },
  'pages.reorder': { method: 'POST', schema: z.object({ doc_id: docId, order: pages, base_revision: baseRev }).strict(), path: D('/pages/reorder'), urlKeys: ['doc_id'] },
  'pages.move': { method: 'POST', schema: z.object({ doc_id: docId, pages, to: page, base_revision: baseRev }).strict(), path: D('/pages/move'), urlKeys: ['doc_id'] },
  'pages.reverse': { method: 'POST', schema: z.object({ doc_id: docId, pages, base_revision: baseRev }).strict(), path: D('/pages/reverse'), urlKeys: ['doc_id'] },
  'pages.duplicate': { method: 'POST', schema: z.object({ doc_id: docId, pages, base_revision: baseRev }).strict(), path: D('/pages/duplicate'), urlKeys: ['doc_id'] },
  'pages.insertBlank': {
    method: 'POST',
    schema: z.object({ doc_id: docId, at: page, count: z.number().int().min(1).max(500).optional(), width: num.optional(), height: num.optional(), base_revision: baseRev }).strict(),
    path: D('/pages/insert-blank'),
    urlKeys: ['doc_id'],
  },
  'pages.insertFile': {
    method: 'POST',
    schema: z.object({ doc_id: docId, at: page, file: token, password: z.string().max(1024).optional(), pages: pages.optional(), base_revision: baseRev }).strict(),
    path: D('/pages/insert-file'),
    urlKeys: ['doc_id'],
    files: { file: ['path', 'read'] },
  },
  'pages.copyFrom': {
    method: 'POST',
    schema: z.object({ doc_id: docId, source_doc_id: docId, pages, at: page, base_revision: baseRev }).strict(),
    path: D('/pages/copy-from'),
    urlKeys: ['doc_id'],
  },
  'pages.crop': {
    method: 'POST',
    schema: z.object({ doc_id: docId, pages, box: rect.optional(), margins: rect.optional(), reset: z.boolean().optional(), base_revision: baseRev }).strict(),
    path: D('/pages/crop'),
    urlKeys: ['doc_id'],
  },
  'pages.resize': {
    method: 'POST',
    schema: z.object({ doc_id: docId, pages, width: num, height: num, mode: z.enum(['fit', 'stretch', 'center']).optional(), base_revision: baseRev }).strict(),
    path: D('/pages/resize'),
    urlKeys: ['doc_id'],
  },
  'pages.extract': {
    method: 'POST',
    schema: z.object({ doc_id: docId, pages, target: token }).strict(),
    path: D('/pages/extract'),
    urlKeys: ['doc_id'],
    files: { target: ['target_path', 'write'] },
  },
  'doc.split': {
    method: 'POST',
    schema: z
      .object({
        doc_id: docId,
        mode: z.enum(['ranges', 'every', 'bookmarks', 'size']),
        ranges: z.array(z.array(page).min(1).max(2)).max(10000).optional(),
        every: z.number().int().min(1).optional(),
        max_bytes: z.number().int().min(1).optional(),
        output: token,
        name_pattern: z.string().max(200).optional(),
      })
      .strict(),
    path: D('/split'),
    urlKeys: ['doc_id'],
    files: { output: ['output_dir', 'dir'] },
  },
  'doc.merge': {
    method: 'POST',
    schema: z
      .object({
        items: z.array(z.object({ file: token, password: z.string().max(1024).optional(), pages: pages.optional() }).strict()).min(1).max(500),
        display_name: z.string().max(260).optional(),
      })
      .strict(),
    path: () => '/merge',
  },
  'doc.imagesToPdf': {
    method: 'POST',
    schema: z
      .object({
        files: z.array(token).min(1).max(2000),
        page_size: z.enum(['image', 'a4', 'letter']).optional(),
        margin: num.optional(),
        display_name: z.string().max(260).optional(),
      })
      .strict(),
    path: () => '/images-to-pdf',
  },

  // ---- overlays ------------------------------------------------------------------
  'overlays.flatten': {
    method: 'POST',
    schema: z.object({ doc_id: docId, overlays, base_revision: baseRev }).strict(),
    path: D('/overlays/flatten'),
    urlKeys: ['doc_id'],
  },

  'doc.pageImages': {
    method: 'GET',
    schema: z.object({ doc_id: docId, page }).strict(),
    path: (p) => `/documents/${p.doc_id}/pages/${p.page}/images`,
    urlKeys: ['doc_id', 'page'],
  },
  'images.detach': {
    method: 'POST',
    schema: z.object({ doc_id: docId, page, xref: z.number().int().min(1), base_revision: baseRev }).strict(),
    path: D('/images/detach'),
    urlKeys: ['doc_id'],
  },

  // ---- direct text editing ----
  'text.objects': {
    method: 'GET',
    schema: z.object({ doc_id: docId, page }).strict(),
    path: (p) => `/documents/${p.doc_id}/pages/${p.page}/text-objects`,
    urlKeys: ['doc_id', 'page'],
  },
  'text.preview': { method: 'POST', schema: textEdit, path: D('/text/preview'), urlKeys: ['doc_id'], timeoutMs: 120_000 },
  'text.apply': { method: 'POST', schema: textEdit, path: D('/text/apply'), urlKeys: ['doc_id'], timeoutMs: 300_000 },

  // ---- annotations ----
  'annot.list': {
    method: 'GET',
    schema: z.object({ doc_id: docId, page }).strict(),
    path: (p) => `/documents/${p.doc_id}/pages/${p.page}/annotations`,
    urlKeys: ['doc_id', 'page'],
  },
  'annot.all': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/annotations'), urlKeys: ['doc_id'] },
  'annot.add': {
    method: 'POST',
    schema: z.object({ doc_id: docId, page, spec: annotSpec, author: z.string().max(200).optional(), base_revision: baseRev }).strict(),
    path: D('/annotations/add'),
    urlKeys: ['doc_id'],
  },
  'annot.update': {
    method: 'POST',
    schema: z.object({ doc_id: docId, page, xref: z.number().int().min(1), spec: annotSpec, author: z.string().max(200).optional(), base_revision: baseRev }).strict(),
    path: D('/annotations/update'),
    urlKeys: ['doc_id'],
  },
  'annot.delete': {
    method: 'POST',
    schema: z.object({ doc_id: docId, page, xrefs: z.array(z.number().int().min(1)).min(1).max(10000), base_revision: baseRev }).strict(),
    path: D('/annotations/delete'),
    urlKeys: ['doc_id'],
  },
  'annot.flatten': { method: 'POST', schema: z.object({ doc_id: docId, base_revision: baseRev }).strict(), path: D('/annotations/flatten'), urlKeys: ['doc_id'] },

  // ---- header & footer / page numbers / Bates ----
  'doc.headerFooter': {
    method: 'POST',
    schema: z.object({
      doc_id: docId,
      'top-left': z.string().max(300).optional(),
      'top-center': z.string().max(300).optional(),
      'top-right': z.string().max(300).optional(),
      'bottom-left': z.string().max(300).optional(),
      'bottom-center': z.string().max(300).optional(),
      'bottom-right': z.string().max(300).optional(),
      font: z.string().max(120).optional(),
      font_size: z.number().min(4).max(72).optional(),
      color: z.string().max(20).optional(),
      margins: z.object({ top: z.number().min(0).max(500), bottom: z.number().min(0).max(500), left: z.number().min(0).max(500), right: z.number().min(0).max(500) }).strict().optional(),
      pages: pages.optional(),
      count_selected_only: z.boolean().optional(),
      start_number: z.number().int().min(0).max(10_000_000).optional(),
      date_format: z.enum(['dmy', 'us', 'iso', 'thai', 'thai-short']).optional(),
      thai_digits: z.boolean().optional(),
      bates: z.object({ prefix: z.string().max(40), suffix: z.string().max(40), start: z.number().int().min(0).max(1e11), digits: z.number().int().min(1).max(12) }).strict().optional(),
      base_revision: baseRev,
    }).strict(),
    path: D('/header-footer'),
    urlKeys: ['doc_id'],
  },
  'doc.headerFooterRemove': { method: 'POST', schema: z.object({ doc_id: docId, base_revision: baseRev }).strict(), path: D('/header-footer/remove'), urlKeys: ['doc_id'] },
  'doc.headerFooterState': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/header-footer'), urlKeys: ['doc_id'] },

  // ---- compare documents ----
  'doc.compare': {
    method: 'POST',
    schema: z.object({
      old_doc_id: docId.optional(),
      old_token: token.optional(),
      new_doc_id: docId.optional(),
      new_token: token.optional(),
      old_overlays: overlays.optional(),
      new_overlays: overlays.optional(),
    }).strict(),
    path: () => '/compare',
    files: { old_token: ['old_path', 'read'], new_token: ['new_path', 'read'] },
    timeoutMs: 600_000,
  },

  // ---- interactive forms ----
  'forms.list': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/forms'), urlKeys: ['doc_id'] },
  'forms.data': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/forms/data'), urlKeys: ['doc_id'] },
  'forms.fill': {
    method: 'POST',
    schema: z.object({ doc_id: docId, values: z.record(z.string().max(300), formValue).refine((v) => Object.keys(v).length <= 2000), base_revision: baseRev }).strict(),
    path: D('/forms/fill'),
    urlKeys: ['doc_id'],
  },
  'forms.reset': { method: 'POST', schema: z.object({ doc_id: docId, names: z.array(z.string().max(300)).max(2000).optional(), base_revision: baseRev }).strict(), path: D('/forms/reset'), urlKeys: ['doc_id'] },
  'forms.create': {
    method: 'POST',
    schema: z.object({
      doc_id: docId,
      page,
      type: z.enum(['text', 'checkbox', 'radio', 'combo', 'list', 'signature']),
      rect,
      name: z.string().max(120).optional(),
      options: z.array(z.string().max(500)).max(500).optional(),
      multiline: z.boolean().optional(),
      font_size: z.number().min(0).max(200).optional(),
      required: z.boolean().optional(),
      readonly: z.boolean().optional(),
      tooltip: z.string().max(500).optional(),
      export: z.string().max(60).optional(),
      maxlen: z.number().int().min(0).max(10000).optional(),
      comb: z.boolean().optional(),
      password: z.boolean().optional(),
      multiselect: z.boolean().optional(),
      editable: z.boolean().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      value: formValue.optional(),
      base_revision: baseRev,
    }).strict(),
    path: D('/forms/create'),
    urlKeys: ['doc_id'],
  },
  'forms.update': {
    method: 'POST',
    schema: z.object({
      doc_id: docId,
      field: z.string().min(1).max(300),
      widget: z.string().regex(/^w\d+_\d+$/).optional(),
      props: z.object({
        name: z.string().min(1).max(120).optional(),
        tooltip: z.string().max(500).optional(),
        required: z.boolean().optional(),
        readonly: z.boolean().optional(),
        multiline: z.boolean().optional(),
        password: z.boolean().optional(),
        comb: z.boolean().optional(),
        multiselect: z.boolean().optional(),
        editable: z.boolean().optional(),
        maxlen: z.number().int().min(0).max(10000).optional(),
        font_size: z.number().min(0).max(200).optional(),
        align: z.enum(['left', 'center', 'right']).optional(),
        options: z.array(z.string().max(500)).min(1).max(500).optional(),
        rect: rect.optional(),
      }).strict(),
      base_revision: baseRev,
    }).strict(),
    path: D('/forms/update'),
    urlKeys: ['doc_id'],
  },
  'forms.delete': { method: 'POST', schema: z.object({ doc_id: docId, widget: z.string().regex(/^w\d+_\d+$/), base_revision: baseRev }).strict(), path: D('/forms/delete'), urlKeys: ['doc_id'] },
  'forms.flatten': { method: 'POST', schema: z.object({ doc_id: docId, names: z.array(z.string().max(300)).max(2000).optional(), base_revision: baseRev }).strict(), path: D('/forms/flatten'), urlKeys: ['doc_id'] },

  // ---- security, watermark, redaction ----
  'security.protect': {
    method: 'POST',
    schema: z.object({ doc_id: docId, user_password: z.string().max(127).nullable().optional(), owner_password: z.string().max(127).nullable().optional(), permissions: z.record(z.string(), z.boolean()).optional() }).strict(),
    path: D('/security/protect'),
    urlKeys: ['doc_id'],
  },
  'security.remove': { method: 'POST', schema: z.object({ doc_id: docId }).strict(), path: D('/security/remove'), urlKeys: ['doc_id'] },
  'security.unlock': { method: 'POST', schema: z.object({ doc_id: docId, password: z.string().max(1024) }).strict(), path: D('/security/unlock'), urlKeys: ['doc_id'] },
  'doc.watermark': {
    method: 'POST',
    schema: z.object({ doc_id: docId, spec: z.record(z.string(), z.unknown()), base_revision: baseRev }).strict(),
    path: D('/watermark'),
    urlKeys: ['doc_id'],
  },
  'redact.search': {
    method: 'POST',
    schema: z.object({ doc_id: docId, query: z.string().max(1000).nullable().optional(), pattern: z.enum(['email', 'phone', 'thai_id', 'credit_card', 'date']).nullable().optional(), case_sensitive: z.boolean().optional() }).strict(),
    path: D('/redact/search'),
    urlKeys: ['doc_id'],
  },
  'redact.mark': {
    method: 'POST',
    schema: z.object({ doc_id: docId, items: z.array(z.object({ page, rect, text: z.string().max(2000).optional() }).strict()).min(1).max(20000), base_revision: baseRev }).strict(),
    path: D('/redact/mark'),
    urlKeys: ['doc_id'],
  },
  'redact.pending': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/redact/pending'), urlKeys: ['doc_id'] },
  'redact.apply': {
    method: 'POST',
    schema: z.object({ doc_id: docId, images: z.enum(['pixels', 'remove', 'none']).optional(), graphics: z.enum(['touched', 'covered', 'none']).optional(), fill: z.boolean().optional(), sanitize: z.record(z.string(), z.boolean()).optional(), base_revision: baseRev }).strict(),
    path: D('/redact/apply'),
    urlKeys: ['doc_id'],
    timeoutMs: 600_000,
  },
  'doc.sanitize': {
    method: 'POST',
    schema: z.object({ doc_id: docId, options: z.record(z.string(), z.boolean()), base_revision: baseRev }).strict(),
    path: D('/sanitize'),
    urlKeys: ['doc_id'],
  },

  // ---- signatures ----
  'sig.createId': {
    method: 'POST',
    schema: z.object({ target: token, name: z.string().min(1).max(64), email: z.string().max(128).optional(), organization: z.string().max(64).optional(), country: z.string().max(2).optional(), password: z.string().min(6).max(256) }).strict(),
    path: () => '/signatures/create-id',
    files: { target: ['target_path', 'write'] },
  },
  'doc.sign': {
    method: 'POST',
    schema: z
      .object({ doc_id: docId, pfx: token, password: z.string().max(256), target: token, page, rect: rect.nullable().optional(), reason: z.string().max(500).optional(), location: z.string().max(200).optional(), contact: z.string().max(200).optional(), field_name: z.string().min(1).max(300).optional(), overlays: overlays.optional() })
      .strict(),
    path: D('/sign'),
    urlKeys: ['doc_id'],
    files: { pfx: ['pfx_path', 'read'], target: ['target_path', 'write'] },
    timeoutMs: 300_000,
  },
  'sig.validate': { method: 'GET', schema: z.object({ doc_id: docId }).strict(), path: D('/signatures'), urlKeys: ['doc_id'] },
  'sig.saved': { method: 'GET', schema: z.object({}).strict(), path: () => '/signatures/saved' },
  'sig.saveImage': { method: 'POST', schema: z.object({ data_base64: z.string().max(15_000_000), kind: z.string().max(20).optional() }).strict(), path: () => '/signatures/saved' },
  'sig.deleteSaved': { method: 'POST', schema: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).strict(), path: (p) => `/signatures/saved/${p.id}/delete`, urlKeys: ['id'] },

  // ---- job results ----
  'ocr.apply': {
    method: 'POST',
    schema: z.object({ doc_id: docId, job_id: jobId, pages: z.array(anyObj).max(100_000).optional(), base_revision: baseRev }).strict(),
    path: D('/ocr/apply'),
    urlKeys: ['doc_id'],
    timeoutMs: 600_000,
  },
  'candidate.commit': { method: 'POST', schema: z.object({ doc_id: docId, job_id: jobId, base_revision: baseRev }).strict(), path: D('/candidate/commit'), urlKeys: ['doc_id'] },
  'candidate.saveAs': {
    method: 'POST',
    schema: z.object({ doc_id: docId, job_id: jobId, target: token }).strict(),
    path: D('/candidate/save-as'),
    urlKeys: ['doc_id'],
    files: { target: ['target_path', 'write'] },
  },

  // ---- jobs ------------------------------------------------------------------------
  'jobs.start': {
    method: 'POST',
    schema: z.object({ kind: z.enum(['ocr', 'compress', 'convert', 'batch']), doc_id: docId.optional(), params: anyObj.default({}) }).strict(),
    path: () => '/jobs',
  },
  'jobs.get': { method: 'GET', schema: z.object({ job_id: jobId }).strict(), path: (p) => `/jobs/${p.job_id}`, urlKeys: ['job_id'] },
  'jobs.cancel': { method: 'POST', schema: z.object({ job_id: jobId }).strict(), path: (p) => `/jobs/${p.job_id}/cancel`, urlKeys: ['job_id'] },
  'jobs.dispose': { method: 'POST', schema: z.object({ job_id: jobId }).strict(), path: (p) => `/jobs/${p.job_id}/dispose`, urlKeys: ['job_id'] },
};

/** Keys that are never accepted from the renderer: paths come from tokens only.
 * Any key that looks like a path field (…_path, …_paths, …_dir, …_file) is
 * rejected as well, at any nesting depth. */
const FORBIDDEN_KEYS = new Set(['path', 'paths', 'target_path', 'output_dir', 'output_path', 'source_path', 'session_dir', 'pfx_path', 'dir', 'file_path']);
const PATHLIKE = /(_path|_paths|_dir|_file)$/i;

export function assertNoRawPaths(value: unknown, depth = 0): void {
  if (value === null || typeof value !== 'object') return;
  if (depth > 12) throw new Error('Request is nested too deeply');
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k) || PATHLIKE.test(k)) throw new Error(`Field "${k}" is not allowed; use a file token`);
    assertNoRawPaths(v, depth + 1);
  }
}

export interface PreparedCall {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

/** Validate a renderer request and translate it into a backend call. */
export function prepare(op: string, payload: unknown): PreparedCall {
  const def = OPS[op];
  if (!def) throw new Error(`Operation not allowed: ${op}`);
  assertNoRawPaths(payload);
  const parsed = def.schema.parse(payload ?? {}) as Record<string, any>;
  const body: Record<string, unknown> = { ...parsed };
  for (const [key, [backendKey, mode]] of Object.entries(def.files ?? {})) {
    if (body[key] !== undefined) {
      body[backendKey] = resolveToken(body[key], mode);
      delete body[key];
    }
  }
  // op specific token arrays
  if (op === 'doc.merge') {
    body.items = (parsed.items as any[]).map((it) => ({ path: resolveToken(it.file, 'read'), password: it.password, pages: it.pages }));
  }
  if (op === 'doc.imagesToPdf') {
    body.paths = (parsed.files as string[]).map((t) => resolveToken(t, 'read'));
    delete body.files;
  }
  if (op === 'jobs.start') {
    body.params = resolveJobParams(parsed.params as Record<string, unknown>);
  }
  const urlPath = def.path(parsed);
  for (const k of def.urlKeys ?? []) delete body[k];
  return { method: def.method, path: urlPath, body: def.method === 'GET' ? undefined : body, timeoutMs: def.timeoutMs };
}

/** Job params may carry tokens in *_token / *_tokens fields. */
const JOB_KEYS = /^(mode|pages|language|dpi|preset|options|editable|quality|format|output_out_token|output_dir_token|files_in_tokens)$/;

export function resolveJobParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!JOB_KEYS.test(k)) throw new Error(`Job parameter "${k}" is not allowed`);
    if (k.endsWith('_out_token')) out[k.replace(/_out_token$/, '_path')] = resolveToken(v, 'write');
    else if (k.endsWith('_dir_token')) out[k.replace(/_dir_token$/, '_dir')] = resolveToken(v, 'dir');
    else if (k.endsWith('_in_tokens') && Array.isArray(v)) out[k.replace(/_in_tokens$/, '_paths')] = v.map((t) => resolveToken(t, 'read'));
    else if (k.endsWith('_in_token')) out[k.replace(/_in_token$/, '_path')] = resolveToken(v, 'read');
    else out[k] = v;
  }
  return out;
}

export function registerOps(extra: Record<string, OpDef>): void {
  Object.assign(OPS, extra);
}
