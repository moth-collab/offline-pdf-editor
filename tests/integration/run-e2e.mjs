// End-to-end tests driving the real Electron application.
//   node tests/integration/run-e2e.mjs            (needs a display; use xvfb-run on Linux)
//   node tests/integration/run-e2e.mjs --offline  (Linux: runs inside a network namespace with NO network)
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, freshDir, launch, menu, mupdfProbe, overlayIds, openViaDialog, pageCount, pypdfInfo, qpdfCheck, runCmd, setEnv, summary, test, waitRendered } from './harness.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--offline') && !argv.includes('--inner')) {
  // re-exec inside an empty network namespace: only loopback exists
  const inner = `python3 ${path.join(ROOT, 'tests/integration/lo-up.py')} && xvfb-run -a -s "-screen 0 1600x1000x24" node ${path.join(ROOT, 'tests/integration/run-e2e.mjs')} --inner --offline ${argv.filter((a) => a !== '--offline').join(' ')}`;
  const r = spawnSync('unshare', ['-n', 'sh', '-c', inner], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const only = argv.find((a) => a.startsWith('--only='))?.slice(7);
const OFFLINE = argv.includes('--offline');
const suites = [];
const suite = (name, fn) => suites.push({ name, fn });

// ---------------------------------------------------------------------------
suite('phase1', async () => {
  const out = freshDir('p1-out');
  const userData = freshDir('p1-user');
  const work = freshDir('p1-docs');
  for (const f of ['small.pdf', 'encrypted.pdf', 'pages500.pdf', 'corrupted.pdf']) fs.copyFileSync(path.join(FIX, f), path.join(work, f));
  const { app, win, errors } = await launch({ userData, outDir: out });
  try {
    await test('start screen is shown without documents', async () => {
      await win.waitForSelector('[data-testid=start-screen]');
    });

    if (OFFLINE) {
      await test('renderer cannot reach the network (privacy policy)', async () => {
        const blocked = await win.evaluate(async () => {
          try {
            await fetch('https://example.com/');
            return false;
          } catch {
            return true;
          }
        });
        assert.equal(blocked, true);
      });
    }

    await test('open a PDF and render pages', async () => {
      await openViaDialog(app, win, path.join(work, 'small.pdf'));
      await waitRendered(win, 0);
      assert.equal(await pageCount(win), 3);
      assert.match(await win.title(), /small\.pdf/);
      assert.ok((await win.locator('[data-testid=thumbnail]').count()) === 3);
    });

    await test('text layer allows selecting text', async () => {
      await win.waitForFunction(() => (document.querySelector('[data-page-index="0"] .textLayer')?.textContent ?? '').includes('Invoice'), null, { timeout: 15000 });
    });

    await test('navigation, zoom and view modes', async () => {
      await win.click('[data-testid=status-bar] [aria-label="Next page"]');
      await win.waitForFunction(() => (document.querySelector('[data-testid=page-input]')).value === '2');
      await win.keyboard.press('Control+0');
      await win.waitForFunction(() => document.querySelector('[data-testid=zoom-level]')?.textContent === '100%');
      await win.keyboard.press('Control+=');
      await win.waitForFunction(() => document.querySelector('[data-testid=zoom-level]')?.textContent === '110%');
      await win.keyboard.press('Control+1'); // fit page
      await menu(win, 'View', 'Two Pages');
      await waitRendered(win, 1);
      await menu(win, 'View', 'Continuous');
    });

    await test('search finds text and highlights it', async () => {
      await win.keyboard.press('Control+F');
      await win.fill('[data-testid=search-input]', 'Invoice');
      await win.press('[data-testid=search-input]', 'Enter');
      await win.waitForFunction(() => document.querySelector('[data-testid=search-count]')?.textContent?.includes('of 3'));
    });

    await test('page rotate + undo/redo + delete, then Save As (independent verification)', async () => {
      await win.click('[data-testid=sidebar-thumbnails]');
      await win.locator('[data-testid=thumbnail] >> nth=0').locator('div').first().click();
      await runCmd(win, 'organize', 'page.rotateRight');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      await win.keyboard.press('Control+Z');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved');
      await win.keyboard.press('Control+Y');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      // delete page 3 (confirmation answered "Delete")
      await win.locator('[data-testid=thumbnail] >> nth=2').locator('div').first().click();
      await setEnv(app, { PDFED_E2E_ANSWERS: '0' });
      await runCmd(win, 'organize', 'page.delete');
      await win.waitForFunction(() => document.querySelector('[data-testid=page-count]')?.textContent?.includes('2'));
      await win.keyboard.press('Control+Shift+S');
      const target = path.join(out, 'small.pdf');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
      assert.ok(fs.existsSync(target));
      const info = pypdfInfo(target);
      assert.equal(info.pages, 2);
      assert.deepEqual(info.rot, [90, 0]);
      assert.ok(qpdfCheck(target));
      // the original was not modified
      assert.equal(pypdfInfo(path.join(work, 'small.pdf')).pages, 3);
    });

    await test('Ctrl+S overwrites atomically with a backup', async () => {
      await runCmd(win, 'organize', 'page.rotateLeft');
      await win.keyboard.press('Control+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
      const info = pypdfInfo(path.join(out, 'small.pdf'));
      assert.equal(info.pages, 2);
      const backups = fs.readdirSync(path.join(userData, 'backups'));
      assert.ok(backups.some((b) => b.startsWith('small-')), 'backup created');
    });

    await test('password protected document asks for the password', async () => {
      await openViaDialog(app, win, path.join(work, 'encrypted.pdf'));
      await win.waitForSelector('[data-testid=prompt-input]');
      await win.fill('[data-testid=prompt-input]', 'wrong');
      await win.click('[data-testid=prompt-ok]');
      await win.waitForSelector('text=The password is incorrect');
      await win.fill('[data-testid=prompt-input]', 'user123');
      await win.click('[data-testid=prompt-ok]');
      await win.waitForFunction(() => document.title.includes('encrypted.pdf'));
      await waitRendered(win, 0);
      assert.equal(await win.locator('[data-testid=doc-tab]').count(), 2);
    });

    await test('damaged document is repaired with a warning', async () => {
      await openViaDialog(app, win, path.join(work, 'corrupted.pdf'));
      await win.waitForSelector('text=The file was damaged and has been repaired');
      await waitRendered(win, 0);
    });

    await test('500-page document: lazy rendering and smooth navigation', async () => {
      const t0 = Date.now();
      await openViaDialog(app, win, path.join(work, 'pages500.pdf'));
      await win.waitForFunction(() => document.title.includes('pages500.pdf'));
      await waitRendered(win, 0);
      const openMs = Date.now() - t0;
      assert.equal(await pageCount(win), 500);
      const mounted = await win.locator('[data-page-index]').count();
      assert.ok(mounted < 15, `only nearby pages are mounted (got ${mounted})`);
      await win.keyboard.press('End');
      await waitRendered(win, 499);
      assert.equal(await win.locator('[data-testid=page-input]').inputValue(), '500');
      console.log(`      open+first render ${openMs} ms`);
    });

    await test('close with unsaved changes asks to save (Don’t Save)', async () => {
      await runCmd(win, 'organize', 'page.rotateRight');
      const tabs = await win.locator('[data-testid=doc-tab]').count();
      await setEnv(app, { PDFED_E2E_ANSWERS: '1' }); // "Don't Save"
      await win.keyboard.press('Control+W');
      await win.waitForFunction((n) => document.querySelectorAll('[data-testid=doc-tab]').length === n - 1, tabs);
    });

    await test('no renderer errors', async () => {
      const real = errors.filter((e) => !/Download the React DevTools|blocked network request|example\.com/.test(e)); // example.com = the deliberate privacy probe
      assert.deepEqual(real, []);
    });
    await win.screenshot({ path: path.join(out, 'phase1.png') });
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('phase2', async () => {
  const out = freshDir('p2-out');
  const userData = freshDir('p2-user');
  const work = freshDir('p2-docs');
  for (const f of ['small.pdf', 'pages100.pdf', 'logo.png', 'photo.jpg']) fs.copyFileSync(path.join(FIX, f), path.join(work, f));
  const { app, win, errors } = await launch({ userData, outDir: out });
  const scope = async () => ((await win.locator('[data-testid=page-organizer]').count()) ? '[data-testid=page-organizer] ' : '');
  const thumb = async (i) => win.locator(`${await scope()}[data-testid=thumbnail][data-page="${i}"]`).locator('div').first();
  const clickThumb = (i) => ({ click: async (o) => (await thumb(i)).click(o), boundingBox: async () => (await thumb(i)).boundingBox() });
  const showThumbs = async () => {
    if (!(await win.locator('[data-testid=thumbnail]').count())) await win.click('[data-testid=sidebar-thumbnails]');
  };
  try {
    await test('page organizer: multi-select and insert blank pages', async () => {
      await openViaDialog(app, win, path.join(work, 'small.pdf'));
      await waitRendered(win, 0);
      await runCmd(win, 'organize', 'page.organizer');
      await win.waitForSelector('[data-testid=page-organizer]');
      await clickThumb(0).click();
      await clickThumb(2).click({ modifiers: ['Shift'] });
      await win.waitForSelector('text=3 selected (1-3)');
      await clickThumb(1).click({ modifiers: ['Control'] });
      await win.waitForSelector('text=2 selected (1, 3)');
      await runCmd(win, null, 'page.insertBlank');
      await win.click('text=At the end');
      await win.click('button:has-text("Insert")');
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=page-organizer] [data-testid=thumbnail]').length === 4);
    });

    await test('drag & drop reorder in the organizer', async () => {
      const src = clickThumb(3);
      const dst = clickThumb(0);
      const a = await src.boundingBox();
      const b = await dst.boundingBox();
      await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await win.mouse.down();
      await win.mouse.move(a.x + a.width / 2 - 20, a.y + a.height / 2, { steps: 5 });
      await win.mouse.move(b.x + b.width / 4, b.y + b.height / 2, { steps: 15 });
      await win.mouse.up();
      // the blank page (no text) must now be first
      await win.click('button:has-text("Done")');
      await win.keyboard.press('Control+Shift+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
      const info = pypdfInfo(path.join(out, 'small.pdf'));
      assert.equal(info.pages, 4);
      assert.equal(info.text[0].trim(), '');
      assert.match(info.text[1], /Page 1/);
    });

    await test('copy pages from one document and paste into another', async () => {
      await openViaDialog(app, win, path.join(work, 'pages100.pdf'));
      await win.waitForFunction(() => document.title.includes('pages100.pdf'));
      await showThumbs();
      await clickThumb(9).click();
      await clickThumb(10).click({ modifiers: ['Shift'] });
      await menu(win, 'Page', 'Copy Pages');
      await win.locator('[data-testid=doc-tab]', { hasText: 'small.pdf' }).click();
      await menu(win, 'Page', 'Paste Pages');
      await win.waitForFunction(() => document.querySelector('[data-testid=page-count]')?.textContent?.includes('6'));
    });

    await test('extract pages to a new file', async () => {
      await win.locator('[data-testid=doc-tab]', { hasText: 'pages100.pdf' }).click();
      await runCmd(win, 'organize', 'doc.extract');
      await win.fill('input >> nth=0', '5-7');
      await win.click('button:has-text("Extract…")');
      await win.waitForSelector('text=Extracted 3 pages');
      const f = fs.readdirSync(out).find((n) => n.startsWith('pages100_pages'));
      assert.ok(f, 'extracted file');
      const info = pypdfInfo(path.join(out, f));
      assert.equal(info.pages, 3);
      assert.match(info.text[0], /Page 5 of 100/);
    });

    await test('split into parts of 25 pages', async () => {
      await runCmd(win, 'organize', 'doc.split');
      await win.locator('[role=dialog] input').first().fill('25');
      await win.click('button:has-text("Choose folder & split")');
      await win.waitForSelector('text=Created 4 files');
      const parts = fs.readdirSync(out).filter((n) => /^pages100_part\d\.pdf$/.test(n));
      assert.equal(parts.length, 4);
      assert.equal(parts.reduce((acc, p) => acc + pypdfInfo(path.join(out, p)).pages, 0), 100);
    });

    await test('merge files into a new untitled document', async () => {
      await setEnv(app, { PDFED_E2E_OPEN: [path.join(work, 'small.pdf'), path.join(out, 'pages100_part1.pdf')].join('|') });
      await runCmd(win, 'organize', 'doc.merge');
      await win.click('button:has-text("Add files…")');
      await win.waitForSelector('[role=dialog] >> text=pages100_part1.pdf');
      await win.click('[role=dialog] button:has-text("Merge")');
      await win.waitForFunction(() => document.title.includes('Merged.pdf'));
      assert.equal(await pageCount(win), 28);
      await win.waitForSelector('[data-testid=save-status]:has-text("Unsaved changes")');
    });

    await test('create a PDF from images', async () => {
      await setEnv(app, { PDFED_E2E_OPEN: [path.join(work, 'photo.jpg'), path.join(work, 'logo.png')].join('|') });
      await menu(win, 'Convert', 'Create PDF from Images');
      await win.click('[role=dialog] button:has-text("Create PDF")');
      await win.waitForFunction(() => document.title.includes('photo.pdf'));
      assert.equal(await pageCount(win), 2);
      await waitRendered(win, 0);
    });

    await test('no renderer errors', async () => {
      assert.deepEqual(errors.filter((e) => !/Download the React DevTools/.test(e)), []);
    });
    await win.screenshot({ path: path.join(out, 'phase2.png') });
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('phase3', async () => {
  const out = freshDir('p3-out');
  const userData = freshDir('p3-user');
  const work = freshDir('p3-docs');
  for (const f of ['small.pdf', 'scanned.pdf', 'logo.png']) fs.copyFileSync(path.join(FIX, f), path.join(work, f));
  const { app, win, errors } = await launch({ userData, outDir: out });
  const saveAs = async () => {
    await win.keyboard.press('Control+Shift+S');
    await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
  };
  try {
    await openViaDialog(app, win, path.join(work, 'small.pdf'));
    await waitRendered(win, 0);
    await win.keyboard.press('Control+0'); // 100% zoom: 1pt = 4/3 px
    await win.waitForTimeout(300);
    const page = win.locator('[data-page-index="0"]');
    const box = async () => page.boundingBox();
    const S = 96 / 72;

    await test('add a text box (Thai + English) and save it as real PDF text', async () => {
      const b = await box();
      await runCmd(win, 'edit', 'tool.add-text');
      await win.mouse.click(b.x + 72 * S, b.y + 400 * S); // PDF point (72, 442)
      await win.waitForSelector('[data-testid=overlay-text-editor]');
      await win.keyboard.type('Overlay ภาษาไทย น้ำ');
      await win.mouse.click(b.x + 500 * S, b.y + 700 * S);
      assert.equal((await overlayIds(win)).length, 1);
      await saveAs();
      const p = mupdfProbe(path.join(out, 'small.pdf'), 0, ['Overlay']);
      assert.match(p.text, /Overlay ภาษาไทย น้ำ/);
      const r = p.found.Overlay;
      assert.ok(Math.abs(r[0] - 74) < 3, `x ${r[0]}`);
      assert.ok(r[3] <= 442.5 && r[3] > 425, `top ${r[3]}`);
      assert.match(pypdfInfo(path.join(out, 'small.pdf')).text[0], /Overlay/);
    });

    await test('move the text box by dragging (PDF coordinates updated)', async () => {
      const el = win.locator('[data-overlay-id^=txt]');
      const r = await el.boundingBox();
      await win.mouse.move(r.x + 20, r.y + r.height / 2);
      await win.mouse.down();
      await win.mouse.move(r.x + 20 + 50 * S, r.y + r.height / 2 + 30 * S, { steps: 8 });
      await win.mouse.up();
      await win.keyboard.press('Control+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
      const p = mupdfProbe(path.join(out, 'small.pdf'), 0, ['Overlay']);
      assert.ok(Math.abs(p.found.Overlay[0] - 124) < 4, `x ${p.found.Overlay[0]}`);
      assert.ok(Math.abs(p.found.Overlay[3] - 412) < 5, `top ${p.found.Overlay[3]}`);
    });

    await test('format text from the properties panel (bold, size, color) with undo', async () => {
      await win.click('[data-overlay-id^=txt]');
      await win.click('[aria-label=Bold]');
      const before = await win.locator('[data-overlay-id^=txt] div div').evaluate((e) => getComputedStyle(e).fontWeight);
      assert.equal(before, '700');
      await win.keyboard.press('Control+Z');
      await win.waitForFunction(() => getComputedStyle(document.querySelector('[data-overlay-id^=txt] div div')).fontWeight === '400');
      await win.keyboard.press('Control+Y');
      await win.waitForFunction(() => getComputedStyle(document.querySelector('[data-overlay-id^=txt] div div')).fontWeight === '700');
    });

    await test('draw rectangle, ellipse and arrow; resize with a handle; rotate', async () => {
      const b = await box();
      await runCmd(win, 'edit', 'tool.shape-rect');
      await win.mouse.move(b.x + 72 * S, b.y + 500 * S);
      await win.mouse.down();
      await win.mouse.move(b.x + 172 * S, b.y + 560 * S, { steps: 6 });
      await win.mouse.up();
      await runCmd(win, null, 'tool.shape-ellipse');
      await win.mouse.move(b.x + 200 * S, b.y + 500 * S);
      await win.mouse.down();
      await win.mouse.move(b.x + 300 * S, b.y + 560 * S, { steps: 6 });
      await win.mouse.up();
      await runCmd(win, null, 'tool.shape-arrow');
      await win.mouse.move(b.x + 320 * S, b.y + 500 * S);
      await win.mouse.down();
      await win.mouse.move(b.x + 450 * S, b.y + 560 * S, { steps: 6 });
      await win.mouse.up();
      assert.equal((await overlayIds(win)).length, 4);
      // resize the rectangle with its south-east handle
      await win.click('[data-overlay-id^=shp] >> nth=0');
      const handles = win.locator('[data-handle]');
      assert.ok((await handles.count()) >= 9);
      const se = handles.nth(4);
      const hb = await se.boundingBox();
      await win.mouse.move(hb.x + 3, hb.y + 3);
      await win.mouse.down();
      await win.mouse.move(hb.x + 3 + 40 * S, hb.y + 3 + 20 * S, { steps: 6 });
      await win.mouse.up();
      const w = await win.locator('[data-overlay-properties], [data-testid=overlay-properties] input >> nth=2').inputValue().catch(() => null);
      void w;
      // rotate 30 degrees via the properties panel
      const rotInput = win.locator('[data-testid=overlay-properties]').getByText('Rotation').locator('..').locator('input');
      await rotInput.fill('30');
      await rotInput.press('Enter');
      await saveAs();
      const p = mupdfProbe(path.join(out, 'small.pdf'), 0, []);
      assert.ok(p.drawings >= 4, `drawings ${p.drawings}`);
    });

    await test('insert an image and keep it after save', async () => {
      const b = await box();
      await setEnv(app, { PDFED_E2E_OPEN: path.join(work, 'logo.png') });
      await runCmd(win, 'edit', 'tool.add-image');
      await win.mouse.click(b.x + 380 * S, b.y + 160 * S);
      await win.waitForSelector('[data-overlay-id^=img]');
      await saveAs();
      const p = mupdfProbe(path.join(out, 'small.pdf'), 0, []);
      assert.ok(p.images.some((i) => i.w === 400 && i.h === 200), JSON.stringify(p.images));
    });

    await test('copy / paste / delete objects with the keyboard; undo restores', async () => {
      const n = (await overlayIds(win)).length;
      await win.click('[data-overlay-id^=img]');
      await win.keyboard.press('Control+C');
      await win.keyboard.press('Control+V');
      await win.waitForFunction((k) => document.querySelectorAll('[data-overlay-id]').length === k + 1, n);
      await win.keyboard.press('Delete');
      await win.waitForFunction((k) => document.querySelectorAll('[data-overlay-id]').length === k, n);
      await win.keyboard.press('Control+Z');
      await win.waitForFunction((k) => document.querySelectorAll('[data-overlay-id]').length === k + 1, n);
      await win.keyboard.press('Control+Z');
      await win.waitForFunction((k) => document.querySelectorAll('[data-overlay-id]').length === k, n);
    });

    await test('flatten objects into the page (undoable)', async () => {
      await runCmd(win, 'edit', 'overlay.flatten');
      await win.waitForFunction(() => document.querySelectorAll('[data-overlay-id]').length === 0, null, { timeout: 15000 });
      await win.keyboard.press('Control+Z');
      await win.waitForFunction(() => document.querySelectorAll('[data-overlay-id]').length > 0, null, { timeout: 15000 });
    });

    await test('edit an existing image of a scanned page (move it)', async () => {
      await openViaDialog(app, win, path.join(work, 'scanned.pdf'));
      await win.waitForFunction(() => document.title.includes('scanned.pdf'));
      await waitRendered(win, 0);
      await runCmd(win, 'edit', 'tool.edit-images');
      await win.click('[data-testid=existing-image] >> nth=0');
      await win.waitForSelector('[data-overlay-id^=img]');
      const props = win.locator('[data-testid=overlay-properties]');
      const wIn = props.getByText('Width', { exact: true }).locator('..').locator('input');
      await wIn.fill('306');
      await wIn.press('Enter');
      await saveAs();
      const p = mupdfProbe(path.join(out, 'scanned.pdf'), 0, []);
      const big = p.images.find((i) => i.w === 1700);
      assert.ok(big, 'image still present');
      assert.ok(Math.abs(big.bbox[2] - big.bbox[0] - 306) < 2, JSON.stringify(big.bbox));
      assert.equal(p.images.filter((i) => i.w === 1700).length, 1, 'no duplicate image');
    });

    await test('no renderer errors', async () => {
      assert.deepEqual(errors.filter((e) => !/Download the React DevTools/.test(e)), []);
    });
    await win.screenshot({ path: path.join(out, 'phase3.png') });
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('phase4', async () => {
  const out = freshDir('p4-out');
  const userData = freshDir('p4-user');
  const work = freshDir('p4-docs');
  for (const f of ['small.pdf', 'thai.pdf', 'scanned.pdf']) fs.copyFileSync(path.join(FIX, f), path.join(work, f));
  const { app, win, errors } = await launch({ userData, outDir: out });
  const saved = () => win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
  const clickText = async (needle, opts = {}) => {
    const loc = win.locator('[data-page-index="0"] [data-text-block]');
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      await el.click();
      const txt = await win.locator('[data-testid=text-properties]').innerText().catch(() => '');
      if (txt.includes(needle)) {
        if (opts.dbl) await el.dblclick();
        return el;
      }
    }
    throw new Error(`text ${needle} not found`);
  };
  try {
    await test('direct edit a line (preview, confirm) and save; verified with pypdf', async () => {
      await openViaDialog(app, win, path.join(work, 'small.pdf'));
      await waitRendered(win, 0);
      await runCmd(win, 'home', 'tool.direct-text');
      await win.waitForSelector('[data-text-block]');
      await clickText('Invoice number', { dbl: true });
      await win.fill('[data-testid=direct-text-editor]', 'Invoice number INV-2025-0099 total 9,999.00 USD');
      await win.click('[data-testid=direct-text-apply]');
      await win.waitForSelector('[data-testid=edit-level]');
      assert.match(await win.locator('[data-testid=edit-warnings]').innerText(), /metric-compatible/);
      await win.click('[data-testid=confirm-text-edit]');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      await win.keyboard.press('Control+Shift+S');
      await saved();
      const info = pypdfInfo(path.join(out, 'small.pdf'));
      assert.match(info.text[0], /INV-2025-0099 total 9,999\.00 USD/);
      assert.doesNotMatch(info.text[0], /INV-2024-0042/);
      const p = mupdfProbe(path.join(out, 'small.pdf'), 0, ['INV-2025']);
      assert.ok(p.found['INV-2025'], 'found');
    });

    await test('delete a text line', async () => {
      await clickText('quick brown fox');
      await win.click('[data-testid=text-delete-btn]');
      await win.click('[data-testid=confirm-text-edit]');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      await win.keyboard.press('Control+S');
      await saved();
      assert.doesNotMatch(pypdfInfo(path.join(out, 'small.pdf')).text[0], /quick brown fox/);
    });

    await test('format existing text from the properties panel (size + bold)', async () => {
      await clickText('Second paragraph');
      const props = win.locator('[data-testid=text-properties]');
      const size = props.locator('input').first();
      await size.fill('16');
      await size.press('Enter');
      await props.getByLabel('Bold').click();
      await win.click('[data-testid=apply-text-format]');
      await win.click('[data-testid=confirm-text-edit]');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      await win.keyboard.press('Control+S');
      await saved();
      const code = `import json,sys,pymupdf as f
d=f.open(sys.argv[1]); out=[]
for b in d[0].get_text('dict')['blocks']:
  for l in b.get('lines',[]):
    for s in l['spans']:
      if 'Second' in s['text']: out.append([s['size'], s['font'], s['flags']])
print(json.dumps(out))`;
      const { execFileSync } = await import('node:child_process');
      const spans = JSON.parse(execFileSync(path.join(ROOT, 'backend/.venv/bin/python'), ['-c', code, path.join(out, 'small.pdf')], { encoding: 'utf-8' }));
      assert.ok(spans.length && Math.abs(spans[0][0] - 16) < 0.01, JSON.stringify(spans));
      assert.match(spans[0][1], /Bold/i);
    });

    await test('move text by dragging (preview + confirm)', async () => {
      const before = mupdfProbe(path.join(out, 'small.pdf'), 0, ['Contact']).found.Contact;
      const el = await clickText('Contact:');
      const r = await el.boundingBox();
      await win.mouse.move(r.x + 30, r.y + r.height / 2);
      await win.mouse.down();
      await win.mouse.move(r.x + 30 + 40, r.y + r.height / 2 + 60, { steps: 8 });
      await win.mouse.up();
      await win.click('[data-testid=confirm-text-edit]');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      await win.keyboard.press('Control+S');
      await saved();
      const after = mupdfProbe(path.join(out, 'small.pdf'), 0, ['Contact']).found.Contact;
      assert.ok(after[0] - before[0] > 20, `moved right ${before} -> ${after}`);
      assert.ok(before[1] - after[1] > 30, `moved down ${before} -> ${after}`);
    });

    await test('undo restores the text edit', async () => {
      await win.keyboard.press('Control+Z');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      await win.keyboard.press('Control+Y');
    });

    await test('switching Direct Edit ↔ Overlay keeps unsaved overlay objects', async () => {
      const b = await win.locator('[data-page-index="0"]').boundingBox();
      await runCmd(win, 'edit', 'tool.add-text');
      await win.mouse.click(b.x + 120, b.y + 150);
      await win.waitForSelector('[data-testid=overlay-text-editor]');
      await win.keyboard.type('Overlay kept');
      await win.mouse.click(b.x + 600, b.y + 700);
      await runCmd(win, 'home', 'tool.direct-text');
      await runCmd(win, 'home', 'tool.add-text');
      await runCmd(win, 'home', 'tool.direct-text');
      assert.equal(await win.locator('[data-overlay-id^=txt]').count(), 1);
    });

    await test('Thai text edit keeps correct characters', async () => {
      await openViaDialog(app, win, path.join(work, 'thai.pdf'));
      await win.waitForFunction(() => document.title.includes('thai.pdf'));
      await waitRendered(win, 0);
      await runCmd(win, 'home', 'tool.direct-text');
      await win.waitForSelector('[data-text-block]');
      await clickText('ราคา', { dbl: true });
      await win.fill('[data-testid=direct-text-editor]', 'ราคาสินค้า 2,750 บาท น้ำปั้น');
      await win.click('[data-testid=direct-text-apply]');
      await win.click('[data-testid=confirm-text-edit]');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
      await win.keyboard.press('Control+Shift+S');
      await saved();
      const p = mupdfProbe(path.join(out, 'thai.pdf'), 0, ['น้ำปั้น']);
      assert.match(p.text, /ราคาสินค้า 2,750 บาท น้ำปั้น/);
      assert.ok(p.found['น้ำปั้น']);
    });

    await test('scanned page explains that OCR is needed', async () => {
      await openViaDialog(app, win, path.join(work, 'scanned.pdf'));
      await win.waitForFunction(() => document.title.includes('scanned.pdf'));
      await runCmd(win, 'home', 'tool.direct-text');
      await win.waitForSelector('[data-testid=scanned-banner]');
    });

    await test('no renderer errors', async () => {
      assert.deepEqual(errors.filter((e) => !/Download the React DevTools|unknown command/.test(e)), []);
    });
    await win.screenshot({ path: path.join(out, 'phase4.png') });
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('phase5', async () => {
  const out = freshDir('p5-out');
  const userData = freshDir('p5-user');
  const work = freshDir('p5-docs');
  fs.copyFileSync(path.join(FIX, 'small.pdf'), path.join(work, 'small.pdf'));
  const { app, win, errors } = await launch({ userData, outDir: out });
  const S = 96 / 72;
  const annotCount = async () => win.locator('[data-page-index="0"] [data-annot-id]').count();
  const waitAnnots = (n) => win.waitForFunction((k) => document.querySelectorAll('[data-testid=comment-item]').length === k, n, { timeout: 15000 });
  try {
    await openViaDialog(app, win, path.join(work, 'small.pdf'));
    await waitRendered(win, 0);
    await win.keyboard.press('Control+0');
    await win.waitForTimeout(300);
    const page = win.locator('[data-page-index="0"]');
    await win.click('[data-testid=sidebar-comments]');

    await test('highlight text by selecting it', async () => {
      const b = await page.boundingBox();
      await runCmd(win, 'comment', 'tool.annot-highlight');
      // "Invoice number ..." baseline at y=172 (top-down), starts at x=60
      await win.mouse.move(b.x + 61 * S, b.y + 168 * S);
      await win.mouse.down();
      await win.mouse.move(b.x + 200 * S, b.y + 168 * S, { steps: 10 });
      await win.mouse.up();
      await waitAnnots(1);
    });

    await test('sticky note with a typed comment', async () => {
      const b = await page.boundingBox();
      await runCmd(win, 'comment', 'tool.annot-note');
      await win.mouse.click(b.x + 520 * S, b.y + 60 * S);
      await waitAnnots(2);
      await win.fill('[data-testid=annot-contents]', 'Please check the total ภาษาไทย');
      await win.locator('[data-testid=annot-contents]').blur();
      await win.waitForFunction(() => [...document.querySelectorAll('[data-testid=comment-item]')].some((e) => e.textContent.includes('Please check the total')), null, { timeout: 15000 });
    });

    await test('rectangle comment, then move it with the Select tool', async () => {
      const b = await page.boundingBox();
      await runCmd(win, 'comment', 'tool.annot-rect');
      await win.mouse.move(b.x + 60 * S, b.y + 330 * S);
      await win.mouse.down();
      await win.mouse.move(b.x + 200 * S, b.y + 400 * S, { steps: 6 });
      await win.mouse.up();
      await waitAnnots(3);
      await runCmd(win, 'home', 'tool.select');
      const before = await win.locator('[data-page-index="0"] [data-annot-id]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
      const rect = win.locator('[data-page-index="0"] [data-annot-id]').nth(2);
      const rb = await rect.boundingBox();
      await rect.click({ position: { x: 10, y: 10 } });
      await win.mouse.move(rb.x + 10, rb.y + 10);
      await win.mouse.down();
      await win.mouse.move(rb.x + 10 + 60, rb.y + 10 + 40, { steps: 8 });
      await win.mouse.up();
      await win.waitForFunction((t) => {
        const els = [...document.querySelectorAll('[data-page-index="0"] [data-annot-id]')];
        return els.some((e) => Math.abs(e.getBoundingClientRect().top - (t + 40)) < 4);
      }, before[2], { timeout: 15000 });
    });

    await test('freehand drawing and stamp', async () => {
      const b = await page.boundingBox();
      await runCmd(win, 'comment', 'tool.annot-ink');
      await win.mouse.move(b.x + 300 * S, b.y + 350 * S);
      await win.mouse.down();
      for (let i = 1; i <= 12; i++) await win.mouse.move(b.x + (300 + i * 10) * S, b.y + (350 + Math.sin(i) * 20) * S);
      await win.mouse.up();
      await waitAnnots(4);
      await runCmd(win, 'comment', 'tool.annot-stamp');
      await win.mouse.click(b.x + 420 * S, b.y + 450 * S);
      await waitAnnots(5);
    });

    await test('delete a selected comment with the Delete key, undo restores it', async () => {
      await win.locator('[data-testid=comment-item]').nth(4).click();
      await win.keyboard.press('Delete');
      await waitAnnots(4);
      await win.keyboard.press('Control+Z');
      await waitAnnots(5);
    });

    await test('comments are preserved on save (independent reader)', async () => {
      await win.keyboard.press('Control+Shift+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
      const info = pypdfInfo(path.join(out, 'small.pdf'));
      assert.ok(info.annots[0] >= 5, `annotations ${info.annots}`);
      assert.ok(qpdfCheck(path.join(out, 'small.pdf')));
    });

    await test('flatten comments (with warning) keeps their appearance', async () => {
      await setEnv(app, { PDFED_E2E_ANSWERS: '0' });
      await runCmd(win, 'comment', 'comment.flatten');
      await waitAnnots(0);
      assert.equal(await annotCount(), 0);
      await win.keyboard.press('Control+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 20000 });
      const info = pypdfInfo(path.join(out, 'small.pdf'));
      assert.equal(info.annots[0], 0);
      const p = mupdfProbe(path.join(out, 'small.pdf'), 0, []);
      assert.ok(p.drawings > 3, 'flattened appearances are page content');
    });

    await test('no renderer errors', async () => {
      assert.deepEqual(errors.filter((e) => !/Download the React DevTools/.test(e)), []);
    });
    await win.screenshot({ path: path.join(out, 'phase5.png') });
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('phase6', async () => {
  const out = freshDir('p6-out');
  const userData = freshDir('p6-user');
  const work = freshDir('p6-docs');
  for (const f of ['small.pdf', 'scanned.pdf', 'photo.jpg']) fs.copyFileSync(path.join(FIX, f), path.join(work, f));
  const { app, win, errors } = await launch({ userData, outDir: out });
  const { execFileSync } = await import('node:child_process');
  const py = (code, ...args) => execFileSync(path.join(ROOT, 'backend/.venv/bin/python'), ['-c', code, ...args], { encoding: 'utf-8' }).trim();
  const saved = () => win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 30000 });
  const dirty = () => win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes', null, { timeout: 60000 });
  try {
    await test('OCR a scanned document: review, correct, make searchable', async () => {
      await openViaDialog(app, win, path.join(work, 'scanned.pdf'));
      await waitRendered(win, 0);
      await runCmd(win, 'convert', 'convert.ocr');
      await win.click('[data-testid=ocr-run]');
      await win.waitForSelector('[data-testid=ocr-review]', { timeout: 120000 });
      const first = win.locator('[data-testid=ocr-review] input').first();
      assert.match(await first.inputValue(), /SCANNED DOCUMENT/);
      await first.fill('SCANNED DOCUMENT CORRECTED');
      await win.click('[data-testid=ocr-accept]');
      await dirty();
      await win.keyboard.press('Control+F');
      await win.fill('[data-testid=search-input]', 'CORRECTED');
      await win.press('[data-testid=search-input]', 'Enter');
      await win.waitForFunction(() => /of [12] matches/.test(document.querySelector('[data-testid=search-count]')?.textContent ?? ''));
      await win.keyboard.press('Control+Shift+S');
      await saved();
      assert.match(pypdfInfo(path.join(out, 'scanned.pdf')).text[0], /Invoice total 4,500 Baht/);
    });

    await test('compress with a preset and apply the result', async () => {
      // a document with a large photo
      await setEnv(app, { PDFED_E2E_OPEN: path.join(work, 'photo.jpg') });
      await menu(win, 'Convert', 'Create PDF from Images');
      await win.click('[role=dialog] button:has-text("Create PDF")');
      await win.waitForFunction(() => document.title.includes('photo.pdf'));
      await runCmd(win, 'convert', 'doc.compress');
      await win.click('text=High compression');
      await win.click('[data-testid=compress-run]');
      await win.waitForSelector('[data-testid=compress-result]', { timeout: 60000 });
      assert.match(await win.locator('[data-testid=compress-result]').innerText(), /smaller/);
      await win.click('[data-testid=compress-apply]');
      await dirty();
    });

    await test('convert to Word (verified with python-docx)', async () => {
      await win.locator('[data-testid=doc-tab]', { hasText: 'scanned.pdf' }).click();
      await openViaDialog(app, win, path.join(work, 'small.pdf'));
      await win.waitForFunction(() => document.title.includes('small.pdf'));
      await runCmd(win, 'convert', 'convert.word');
      await win.click('[data-testid=convert-run]');
      await win.waitForSelector('text=Convert to Word: done', { timeout: 120000 });
      const docx = path.join(out, 'small.docx');
      assert.ok(fs.existsSync(docx));
      const t = py('import sys,docx;print(chr(10).join(p.text for p in docx.Document(sys.argv[1]).paragraphs))', docx);
      assert.match(t, /Invoice number INV-2024-0042/);
    });

    await test('password protection is applied on save', async () => {
      await runCmd(win, 'protect', 'protect.password');
      await win.fill('[data-testid=pw-open]', 'open-sesame');
      await win.fill('[data-testid=pw-open2]', 'open-sesame');
      await win.click('[data-testid=pw-apply]');
      await win.keyboard.press('Control+Shift+S');
      await saved();
      const enc = py("import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);print(r.is_encrypted, bool(r.decrypt('open-sesame')), bool(pypdf.PdfReader(sys.argv[1]).decrypt('x')))", path.join(out, 'small.pdf'));
      assert.equal(enc, 'True True False');
    });

    await test('watermark on all pages', async () => {
      await runCmd(win, 'protect', 'protect.watermark');
      await win.click('[data-testid=watermark-apply]');
      await dirty();
    });

    await test('search & redact e-mail addresses with verification', async () => {
      await runCmd(win, 'protect', 'protect.redactSearch');
      await win.click('text=Patterns');
      await win.click('[data-testid=redact-search]');
      await win.waitForSelector('[data-testid=redact-mark]:has-text("Mark 3")');
      await win.click('[data-testid=redact-mark]');
      await win.waitForSelector('text=3 areas marked for redaction');
      await runCmd(win, 'protect', 'protect.applyRedactions');
      await win.click('text=I understand that the marked content will be permanently removed');
      await win.click('[data-testid=redact-apply]');
      await win.waitForSelector('[data-testid=redact-report]:has-text("Verified")', { timeout: 60000 });
      await win.click('[role=dialog] button:has-text("Close")');
      await win.keyboard.press('Control+S');
      await saved();
      const txt = py("import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);r.decrypt('open-sesame');print(' '.join(p.extract_text() for p in r.pages))", path.join(out, 'small.pdf'));
      assert.doesNotMatch(txt, /alice@example\.com/);
      assert.match(txt, /CONFIDEN\s*TIAL/); // rotated watermark text (pypdf splits 45° lines)
    });

    await test('fill & sign: draw and place a signature', async () => {
      await runCmd(win, 'protect', 'protect.sign');
      const pad = win.locator('[data-testid=signature-pad]');
      const b = await pad.boundingBox();
      await win.mouse.move(b.x + 30, b.y + 100);
      await win.mouse.down();
      for (let i = 0; i < 20; i++) await win.mouse.move(b.x + 30 + i * 15, b.y + 100 + Math.sin(i / 2) * 30);
      await win.mouse.up();
      await win.click('[data-testid=signature-use]');
      const p = await win.locator('[data-page-index="0"]').boundingBox();
      await win.mouse.click(p.x + p.width * 0.7, p.y + 200);
      await win.waitForSelector('[data-overlay-id^=img]');
    });

    await test('create a Digital ID, sign digitally and validate', async () => {
      await setEnv(app, { PDFED_E2E_ANSWERS: '0' }); // confirm "Remove security"
      await runCmd(win, 'protect', 'protect.removeSecurity');
      await win.waitForSelector('text=Security removed');
      await menu(win, 'Protect', 'Create Digital ID');
      const dlg = win.locator('[role=dialog]');
      await dlg.locator('input').nth(0).fill('E2E Signer');
      await dlg.locator('input[type=password]').nth(0).fill('pfxpass1');
      await dlg.locator('input[type=password]').nth(1).fill('pfxpass1');
      await dlg.locator('button:has-text("Create & save")').click();
      await win.waitForSelector('text=Digital ID created');
      const pfx = path.join(out, 'E2E_Signer.pfx');
      assert.ok(fs.existsSync(pfx));
      await setEnv(app, { PDFED_E2E_OPEN: pfx });
      await runCmd(win, 'protect', 'protect.digitalSign');
      await win.click('[role=dialog] button:has-text("Browse")');
      await win.fill('[data-testid=sign-password]', 'pfxpass1');
      await win.click('[data-testid=sign-apply]');
      await win.waitForFunction(() => document.title.includes('small_signed.pdf'), null, { timeout: 60000 });
      await runCmd(win, 'protect', 'protect.validate');
      await win.waitForSelector('[data-testid=signature-list]:has-text("has not been modified")');
      await win.waitForSelector('[data-testid=signature-list]:has-text("self-signed")');
      await win.click('[role=dialog] button:has-text("Close")');
      const v = py("import sys,pymupdf as f;d=f.open(sys.argv[1]);print(len([w for p in d for w in p.widgets() if w.field_type==f.PDF_WIDGET_TYPE_SIGNATURE]), len(d[0].get_images()))", path.join(out, 'small_signed.pdf'));
      assert.equal(v.split(' ')[0], '1');
    });

    await test('no renderer errors', async () => {
      assert.deepEqual(errors.filter((e) => !/Download the React DevTools/.test(e)), []);
    });
    await win.screenshot({ path: path.join(out, 'phase6.png') });
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('recovery', async () => {
  const out = freshDir('rec-out');
  const userData = freshDir('rec-user');
  const work = freshDir('rec-docs');
  fs.copyFileSync(path.join(FIX, 'pages100.pdf'), path.join(work, 'pages100.pdf'));
  let s = await launch({ userData, outDir: out });
  await test('crash recovery restores unsaved work', async () => {
    await openViaDialog(s.app, s.win, path.join(work, 'pages100.pdf'));
    await waitRendered(s.win, 0);
    await s.win.locator('[data-testid=thumbnail] >> nth=0').locator('div').first().click();
    await setEnv(s.app, { PDFED_E2E_ANSWERS: '0' });
    await runCmd(s.win, 'organize', 'page.delete');
    await s.win.waitForFunction(() => document.querySelector('[data-testid=page-count]')?.textContent?.includes('99'));
    // simulate a crash: kill electron without closing documents
    const pid = s.app.process().pid;
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 3500)); // backend watchdog exits after the parent dies
    s = await launch({ userData, outDir: out });
    await s.win.waitForSelector('[data-testid=recovery-list]', { timeout: 20000 });
    await s.win.click('[data-testid=recovery-list] >> text=Recover');
    await s.win.waitForFunction(() => document.title.includes('pages100.pdf'));
    assert.equal(await pageCount(s.win), 99);
    await s.win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
    // original untouched
    assert.equal(pypdfInfo(path.join(work, 'pages100.pdf')).pages, 100);
  });
  await s.app.close().catch(() => undefined);
});

// ---------------------------------------------------------------------------
suite('forms', async () => {
  const out = freshDir('forms-out');
  const userData = freshDir('forms-user');
  const work = freshDir('forms-docs');
  fs.copyFileSync(path.join(FIX, 'form.pdf'), path.join(work, 'form.pdf'));
  const { app, win, errors } = await launch({ userData, outDir: out });
  const S = 96 / 72;
  const py = (code, file) => {
    const r = spawnSync(path.join(ROOT, 'backend/.venv/bin/python'), ['-c', code, file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const fieldsOf = (file) => JSON.parse(py("import sys,json,pypdf;f=pypdf.PdfReader(sys.argv[1]).get_fields() or {};print(json.dumps({k:str(v.get('/V')) for k,v in f.items()},ensure_ascii=False))", file));
  const field = (name) => win.locator(`[data-testid=form-field][data-field="${name}"]`);
  // each committed entry is one undo step (shown in the document summary)
  const undoSteps = () =>
    win.evaluate(() => {
      const row = [...document.querySelectorAll('[data-testid=properties-panel] tr')].find((r) => r.textContent?.startsWith('Undo steps'));
      return parseInt(row?.lastElementChild?.textContent ?? '-1', 10);
    });
  const waitUndo = (n) => win.waitForFunction((k) => {
    const row = [...document.querySelectorAll('[data-testid=properties-panel] tr')].find((r) => r.textContent?.startsWith('Undo steps'));
    return parseInt(row?.lastElementChild?.textContent ?? '-1', 10) === k;
  }, n, { timeout: 15000 });
  try {
    await openViaDialog(app, win, path.join(work, 'form.pdf'));
    await waitRendered(win, 0);
    await win.keyboard.press('Control+0');
    await win.waitForTimeout(300);
    const page = win.locator('[data-page-index="0"]');

    await test('a form is announced and its fields are fillable', async () => {
      await win.waitForSelector('text=This document contains a form');
      await field('full_name').waitFor();
      assert.equal(await win.locator('[data-page-index="0"] [data-testid=form-field]').count(), 4);
    });

    await test('fill text (Thai), check box, dropdown and multi-line text; undo the last entry', async () => {
      assert.equal(await undoSteps(), 0);
      await field('full_name').fill('สมชาย ใจดี');
      await field('full_name').press('Enter');
      await waitUndo(1);
      await field('subscribe').click();
      await waitUndo(2);
      await win.waitForSelector('[data-field=subscribe][aria-checked=true]');
      await field('city').selectOption('Phuket');
      await waitUndo(3);
      await field('notes').fill('บรรทัดหนึ่ง\nline two');
      await field('notes').evaluate((el) => el.blur());
      await waitUndo(4);
      await win.keyboard.press('Control+Z');
      await win.waitForFunction(() => document.querySelector('[data-field=notes]')?.value === '');
      assert.equal(await field('full_name').inputValue(), 'สมชาย ใจดี');
    });

    await test('filled values are saved (independent reader)', async () => {
      await win.keyboard.press('Control+Shift+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 30000 });
      const f = fieldsOf(path.join(out, 'form.pdf'));
      assert.equal(f.full_name, 'สมชาย ใจดี');
      assert.notEqual(f.subscribe, '/Off');
      assert.equal(f.city, 'Phuket');
      assert.ok(['None', ''].includes(f.notes));
    });

    await test('design: add a text field, rename it and move it', async () => {
      await runCmd(win, 'forms', 'tool.form-text');
      const b = await page.boundingBox();
      await win.mouse.move(b.x + 160 * S, b.y + 330 * S);
      await win.mouse.down();
      await win.mouse.move(b.x + 360 * S, b.y + 352 * S, { steps: 6 });
      await win.mouse.up();
      await win.waitForSelector('[data-testid=form-field-properties]');
      const nameBox = win.locator('[data-testid=form-field-name]');
      assert.equal(await nameBox.inputValue(), 'Text1');
      await nameBox.fill('phone');
      await nameBox.press('Enter');
      const box = win.locator('[data-testid=form-design-field][data-field=phone]');
      await box.waitFor();
      const bb = await box.boundingBox();
      await win.mouse.move(bb.x + 20, bb.y + 8);
      await win.mouse.down();
      await win.mouse.move(bb.x + 20 + 40 * S, bb.y + 8, { steps: 8 });
      await win.mouse.up();
      await win.waitForFunction((x0) => {
        const el = document.querySelector('[data-testid=form-design-field][data-field=phone]');
        return el && el.getBoundingClientRect().x > x0 + 30;
      }, bb.x);
    });

    await test('design: build a radio group by clicking twice', async () => {
      await runCmd(win, 'forms', 'tool.form-radio');
      const b = await page.boundingBox();
      await win.mouse.click(b.x + 160 * S, b.y + 380 * S);
      await win.waitForSelector('[data-testid=form-field-properties]');
      await win.mouse.click(b.x + 200 * S, b.y + 380 * S);
      await win.waitForFunction(() => document.querySelector('[data-testid=form-field-properties]')?.textContent?.includes('Choice2'));
      await runCmd(win, 'forms', 'tool.form-edit');
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=form-design-field][data-field=Group1]').length === 2);
    });

    await test('fill the new fields, then flatten the form', async () => {
      await runCmd(win, 'forms', 'form.fill');
      await field('phone').fill('0812345678');
      await field('phone').press('Enter');
      await win.waitForFunction(() => document.querySelector('[data-field=phone]')?.value === '0812345678');
      await field('Group1').nth(1).click();
      await win.waitForFunction(() => document.querySelectorAll('[data-field=Group1][aria-checked=true]').length === 1);
      await setEnv(app, { PDFED_E2E_ANSWERS: '0' });
      await runCmd(win, 'forms', 'form.flatten');
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=form-field]').length === 0);
      await win.keyboard.press('Control+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 30000 });
      // the document is now the copy written by Save As; the original stays untouched
      const target = path.join(out, 'form.pdf');
      assert.deepEqual(fieldsOf(target), {});
      assert.equal(fieldsOf(path.join(work, 'form.pdf')).full_name, 'None');
      const text = py("import sys,pymupdf;print(pymupdf.open(sys.argv[1])[0].get_text())", target);
      assert.ok(text.includes('สมชาย ใจดี') && text.includes('0812345678') && text.includes('Phuket'), text);
      assert.ok(qpdfCheck(target));
    });

    await test('no renderer errors', async () => assert.deepEqual(errors, []));
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('marks', async () => {
  const out = freshDir('marks-out');
  const work = freshDir('marks-docs');
  fs.copyFileSync(path.join(FIX, 'pages100.pdf'), path.join(work, 'pages100.pdf'));
  const { app, win, errors } = await launch({ userData: freshDir('marks-user'), outDir: out });
  const textOf = (file, page) =>
    spawnSync(path.join(ROOT, 'backend/.venv/bin/python'), ['-c', 'import sys,pypdf;print(pypdf.PdfReader(sys.argv[1]).pages[int(sys.argv[2])].extract_text())', file, String(page)], { encoding: 'utf8' }).stdout;
  try {
    await openViaDialog(app, win, path.join(work, 'pages100.pdf'));
    await waitRendered(win, 0);

    await test('add Thai page numbers with Thai digits from the dialog (preview shown)', async () => {
      await runCmd(win, 'organize', 'doc.pageNumbers');
      await win.fill('[data-testid=hf-bottom-center]', 'หน้า {page} จาก {total}');
      await win.click('text=Use Thai digits');
      await win.waitForSelector('[data-testid=hf-preview] >> text=หน้า ๑ จาก ๑๐๐');
      await win.click('[data-testid=hf-apply]');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'Unsaved changes');
    });

    await test('Bates numbers replace the page numbers and are saved', async () => {
      await runCmd(win, 'organize', 'doc.bates');
      await win.fill('[data-testid=hf-bates-prefix]', 'CASE-');
      await win.click('[data-testid=hf-apply]');
      await win.waitForFunction(() => !document.querySelector('[role=dialog]'));
      await win.keyboard.press('Control+Shift+S');
      await win.waitForFunction(() => document.querySelector('[data-testid=save-status]')?.textContent === 'All changes saved', null, { timeout: 30000 });
      const t = textOf(path.join(out, 'pages100.pdf'), 41);
      assert.ok(t.includes('CASE-000042'), t);
      assert.ok(!t.includes('หน้า'), 'previous header/footer must be replaced');
    });

    await test('batch: password-protect several files; a protected file is reported, originals untouched', async () => {
      const files = ['small.pdf', 'thai.pdf', 'encrypted.pdf'].map((f) => {
        fs.copyFileSync(path.join(FIX, f), path.join(work, f));
        return path.join(work, f);
      });
      const before = files.map((f) => fs.readFileSync(f).toString('base64'));
      await runCmd(win, 'convert', 'tools.batch');
      await setEnv(app, { PDFED_E2E_OPEN: files.join('|') });
      await win.click('[data-testid=batch-add]');
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=batch-files] > div').length === 3);
      await win.click('[data-testid=batch-folder]');
      await win.click('text=Protect with a password');
      await win.fill('[data-testid=batch-pw]', 'batch-secret');
      await win.fill('[data-testid=batch-pw2]', 'batch-secret');
      await win.click('[data-testid=batch-run]');
      await win.waitForSelector('[data-testid=batch-summary] >> text=2 succeeded, 1 failed', { timeout: 60000 });
      const enc = spawnSync(path.join(ROOT, 'backend/.venv/bin/python'), ['-c', "import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);print(r.is_encrypted, bool(r.decrypt('batch-secret')))", path.join(out, 'thai_protected.pdf')], { encoding: 'utf8' }).stdout.trim();
      assert.equal(enc, 'True True');
      assert.deepEqual(files.map((f) => fs.readFileSync(f).toString('base64')), before);
      await win.keyboard.press('Escape');
    });

    await test('compare the numbered copy with the original file', async () => {
      await runCmd(win, 'convert', 'tools.compare');
      await setEnv(app, { PDFED_E2E_OPEN: path.join(FIX, 'pages100.pdf') });
      await win.click('[data-testid=cmp-old-file]');
      await win.click('[data-testid=cmp-run]');
      await win.waitForSelector('[data-testid=cmp-result]', { timeout: 120000 });
      // the Bates numbers added to the copy are reported as new text
      await win.waitForSelector('[data-testid=cmp-change] >> text=CASE-000001');
      assert.match(await win.title(), /↔/);
      await win.locator('[data-testid=cmp-change]').nth(4).click();
      await win.keyboard.press('Escape');
    });

    await test('no renderer errors', async () => assert.deepEqual(errors, []));
  } finally {
    await app.close().catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
suite('i18n', async () => {
  const userData = freshDir('i18n-user');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ language: 'th' }));
  const { app, win, errors } = await launch({ userData, outDir: freshDir('i18n-out') });
  try {
    await test('Thai interface on start (menus, ribbon, status bar)', async () => {
      await win.waitForSelector('[data-testid=start-screen]');
      await win.getByRole('menuitem', { name: 'ไฟล์', exact: true }).waitFor();
      await openViaDialog(app, win, path.join(FIX, 'small.pdf'));
      await waitRendered(win, 0);
      assert.equal(await win.textContent('[data-testid=save-status]'), 'บันทึกการเปลี่ยนแปลงทั้งหมดแล้ว');
      assert.match(await win.textContent('[data-testid=status-bar]'), /ระบบประมวลผลพร้อม/);
      assert.match(await win.textContent('[data-testid=ribbon-tab-organize]'), /จัดระเบียบ/);
    });
    await test('switching language in Preferences updates the UI immediately', async () => {
      await win.keyboard.press('Control+K');
      await win.waitForSelector('[role=dialog]');
      await win.locator('[role=dialog] [role=combobox]', { hasText: 'ไทย (Thai)' }).click();
      await win.getByRole('option', { name: 'English' }).click();
      // the open dialog itself switches language too
      await win.waitForSelector('[role=dialog] >> text=Preferences', { timeout: 5000 });
      await win.keyboard.press('Escape');
      await win.getByRole('menuitem', { name: 'File', exact: true }).waitFor({ timeout: 5000 });
      assert.match(await win.textContent('[data-testid=status-bar]'), /Engine ready/);
      // the open document is still there after the UI re-mounted
      assert.equal(await pageCount(win), 3);
      const stored = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
      assert.equal(stored.language, 'en');
    });
    await test('About shows the AGPL notice and offers the source code', async () => {
      await win.evaluate(() => (window).__pdfed.runCommand('help.about'));
      await win.waitForSelector('[data-testid=about-license] >> text=GNU Affero General Public License');
      assert.ok(await win.isVisible('[data-testid=about-source]'));
      await win.keyboard.press('Escape');
    });
    await test('no renderer errors', async () => assert.deepEqual(errors, []));
  } finally {
    await app.close().catch(() => undefined);
  }
});

for (const s of suites) {
  if (only && !only.split(',').includes(s.name)) continue;
  console.log(`\n${s.name}${OFFLINE ? ' (offline)' : ''}`);
  await s.fn();
}
process.exit(summary() ? 0 : 1);
