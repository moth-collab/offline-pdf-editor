// Minimal end-to-end harness around playwright-core's Electron support.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIX = path.join(ROOT, 'tests/fixtures/generated');
export const WORK = process.env.E2E_WORK ?? path.join(ROOT, 'tests/integration/.work');
export const PY = path.join(ROOT, 'backend/.venv/bin/python');

export function freshDir(name) {
  const d = path.join(WORK, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export async function launch({ userData, files = [], outDir }) {
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', ROOT, ...files],
    cwd: ROOT,
    env: { ...process.env, PDFED_USER_DATA: userData, PDFED_E2E_DIALOG_DIR: outDir, PDFED_E2E_OPEN: '', PDFED_E2E_ANSWERS: '' },
    timeout: 60000,
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await win.waitForSelector('[data-testid=status-bar]');
  await win.waitForSelector('[data-testid=status-bar][data-engine=ready]', { timeout: 60000 });
  setFailureWindow(win);
  return { app, win, errors };
}

export async function setEnv(app, vars) {
  await app.evaluate((_e, v) => Object.assign(process.env, v), vars);
}

export async function openViaDialog(app, win, file) {
  await setEnv(app, { PDFED_E2E_OPEN: file });
  await win.keyboard.press('Control+O');
}

export async function waitRendered(win, pageIndex = 0) {
  await win.waitForSelector(`[data-page-index="${pageIndex}"] > div > canvas`, { timeout: 30000 });
}

export async function pageCount(win) {
  const t = await win.locator('[data-testid=page-count]').innerText();
  return parseInt(t.replace(/[^0-9]/g, ''), 10);
}

export async function runCmd(win, ribbonTab, cmd) {
  if (ribbonTab) await win.click(`[data-testid=ribbon-tab-${ribbonTab}]`);
  await win.click(`[data-testid="rb-${cmd}"]`);
}

/** Independent verification with pypdf (not MuPDF / pdf.js). */
export function pypdfInfo(file, password = '') {
  const code = `
import json, sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
if r.is_encrypted: r.decrypt(sys.argv[2])
print(json.dumps({"pages": len(r.pages), "rot": [int(p.get("/Rotate", 0) or 0) for p in r.pages], "text": [p.extract_text() for p in r.pages[:5]], "encrypted": r.is_encrypted, "annots": [len(p.get("/Annots", []) or []) for p in r.pages]}))`;
  return JSON.parse(execFileSync(PY, ['-c', code, file, password], { encoding: 'utf-8' }));
}

export function qpdfCheck(file) {
  try {
    execFileSync('qpdf', ['--check', file], { encoding: 'utf-8' });
    return true;
  } catch (e) {
    // exit code 3 = warnings only
    return e.status === 3;
  }
}

const results = [];
let currentWin = null;
/** Window to screenshot when a test fails (set by launch). */
export function setFailureWindow(win) {
  currentWin = win;
}

export async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e) });
    const where = String(e?.stack ?? '').split('\n').find((l) => l.includes('run-e2e.mjs')) ?? '';
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n').join('\n      ')}\n      ${where.trim()}`);
    if (currentWin) {
      const shot = path.join(WORK, `failure-${name.replace(/[^\w]+/g, '_').slice(0, 60)}.png`);
      await currentWin.screenshot({ path: shot }).then(() => console.log(`      screenshot: ${shot}`)).catch(() => undefined);
    }
  }
}

export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} end-to-end tests passed`);
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(results, null, 1));
  return failed.length === 0;
}

/** Open a top-level menu and choose an item (role based, exact labels). */
export async function menu(win, top, item) {
  await win.getByRole('menuitem', { name: top, exact: true }).click();
  await win.locator('[role=menuitem], [role=menuitemcheckbox]').filter({ hasText: item }).first().click();
}

/** Inspect a saved PDF with MuPDF: text rects (PDF space), images, drawings, links. */
export function mupdfProbe(file, page = 0, needles = []) {
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'backend'))})
import pymupdf as fitz
from core.coords import PageCoords
doc = fitz.open(sys.argv[1]); p = doc[int(sys.argv[2])]; c = PageCoords.for_page(p)
found = {}
for n in json.loads(sys.argv[3]):
    hits = p.search_for(n)
    found[n] = c.rect_to_pdf(hits[0]) if hits else None
imgs = [{"w": i["width"], "h": i["height"], "bbox": c.rect_to_pdf(i["bbox"])} for i in p.get_image_info()]
print(json.dumps({"text": p.get_text(), "found": found, "images": imgs, "drawings": len(p.get_drawings()), "links": [l.get("uri") or l.get("page") for l in p.get_links()]}))`;
  return JSON.parse(execFileSync(PY, ['-c', code, file, String(page), JSON.stringify(needles)], { encoding: 'utf-8' }));
}

/** Overlay objects of the active document (read from the renderer store via the DOM). */
export async function overlayIds(win) {
  return win.evaluate(() => [...document.querySelectorAll('[data-overlay-id]')].map((e) => e.getAttribute('data-overlay-id')));
}
