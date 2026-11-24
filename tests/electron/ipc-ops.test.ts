import { describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/services/fileRegistry', () => ({
  resolve: (t: string, mode: string) => {
    if (t === 'a'.repeat(36) && mode === 'write') return '/safe/out.docx';
    if (t === 'b'.repeat(36) && mode === 'read') return '/safe/in.pdf';
    throw new Error('bad token');
  },
}));

const { prepare, assertNoRawPaths, resolveJobParams } = await import('../../electron/ipc/ops');
const DOC = '0123456789abcdef0123456789abcdef';

describe('IPC allowlist', () => {
  it('rejects unknown operations', () => {
    expect(() => prepare('fs.readFile', {})).toThrow(/not allowed/);
  });
  it('rejects raw paths anywhere in the payload', () => {
    expect(() => assertNoRawPaths({ a: { b: [{ output_path: '/etc/passwd' }] } })).toThrow(/not allowed/);
    expect(() => assertNoRawPaths({ pfx_path: 'x' })).toThrow();
    expect(() => assertNoRawPaths({ log_dir: 'x' })).toThrow();
    expect(() => prepare('jobs.start', { kind: 'convert', doc_id: DOC, params: { mode: 'docx', output_path: '/tmp/x.docx' } })).toThrow(/not allowed/);
  });
  it('only accepts known job parameters and resolves tokens', () => {
    expect(() => resolveJobParams({ source_path: '/x' })).toThrow();
    expect(() => resolveJobParams({ evil: 1 })).toThrow();
    expect(resolveJobParams({ mode: 'docx', output_out_token: 'a'.repeat(36) })).toEqual({ mode: 'docx', output_path: '/safe/out.docx' });
  });
  it('validates schemas strictly and maps tokens to paths', () => {
    expect(() => prepare('doc.open', { file: 'b'.repeat(36), extra: 1 })).toThrow();
    const call = prepare('doc.open', { file: 'b'.repeat(36) });
    expect(call).toEqual({ method: 'POST', path: '/documents/open', body: { path: '/safe/in.pdf' }, timeoutMs: undefined });
    expect(() => prepare('doc.info', { doc_id: '../../etc' })).toThrow();
    const r = prepare('pages.rotate', { doc_id: DOC, pages: [0], angle: 90 });
    expect(r.path).toBe(`/documents/${DOC}/pages/rotate`);
    expect(r.body).toEqual({ pages: [0], angle: 90 });
  });
  it('maps compare file tokens and never accepts raw paths', () => {
    const r = prepare('doc.compare', { old_doc_id: DOC, new_token: 'b'.repeat(36) });
    expect(r.body).toEqual({ old_doc_id: DOC, new_path: '/safe/in.pdf' });
    expect(() => prepare('doc.compare', { old_doc_id: DOC, new_path: '/etc/passwd' })).toThrow();
  });
  it('batch jobs resolve file and folder tokens only', () => {
    expect(() => prepare('jobs.start', { kind: 'batch', params: { mode: 'compress', files_paths: ['/etc/passwd'] } })).toThrow();
    expect(() => prepare('jobs.start', { kind: 'batch', params: { mode: 'compress', options: { output_dir: '/tmp' } } })).toThrow(/not allowed/);
    const r = prepare('jobs.start', { kind: 'batch', params: { mode: 'compress', files_in_tokens: ['b'.repeat(36)] } });
    expect((r.body as any).params).toEqual({ mode: 'compress', files_paths: ['/safe/in.pdf'] });
  });
  it('validates form operations strictly', () => {
    expect(() => prepare('forms.update', { doc_id: DOC, field: 'a', props: { evil: 1 } })).toThrow();
    expect(() => prepare('forms.delete', { doc_id: DOC, widget: '../x' })).toThrow();
    expect(prepare('forms.fill', { doc_id: DOC, values: { name: 'สมชาย', agree: true, langs: ['th'] } }).path).toBe(`/documents/${DOC}/forms/fill`);
  });
  it('rejects a write token used for reading-only purposes of another kind', () => {
    expect(() => prepare('doc.save', { doc_id: DOC, target: 'b'.repeat(36) })).toThrow(/bad token/);
  });
});
