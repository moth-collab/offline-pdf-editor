#!/usr/bin/env node
/**
 * Windows lifecycle test of a packaged build (used by CI):
 *
 *   node scripts/windows-lifecycle-test.mjs <path-to-OfflinePDFEditor.exe> [--portable <portable.exe>]
 *
 * Checks what users actually do: start the app (with a PDF), close the window,
 * start it again, and start it again while it is still closing. After every
 * close no process of the app (Electron or the bundled Python engine and its
 * job processes) may be left running. Prints the timings (start → window
 * visible, close → all processes gone), so slow starts show up in the CI log.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = path.resolve(process.argv[2] ?? 'release/win-unpacked/OfflinePDFEditor.exe');
const portableIdx = process.argv.indexOf('--portable');
const portable = portableIdx > 0 ? path.resolve(process.argv[portableIdx + 1]) : null;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfed-life-'));
const env = { ...process.env, PDFED_USER_DATA: path.join(work, 'userdata') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function ps(script) {
  // "; exit 0": Get-Process sets a failing exit code when nothing matches
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${script}; exit 0`], { encoding: 'utf8' }).trim();
}

/** Processes of the app: Electron (by name) and Python/Tesseract started from its folders. */
function appProcesses() {
  const out = ps(
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'OfflinePDFEditor.exe' -or " +
      "(($_.Name -eq 'python.exe' -or $_.Name -eq 'tesseract.exe') -and $_.ExecutablePath -and " +
      "($_.ExecutablePath -like '*win-unpacked*' -or $_.ExecutablePath -like '*OfflinePDFEditor*')) } | " +
      "ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }",
  );
  return out ? out.split(/\r?\n/) : [];
}

function visibleWindows() {
  const out = ps(
    "Get-Process OfflinePDFEditor -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | " +
      'ForEach-Object { $_.Id }',
  );
  return out ? out.split(/\r?\n/) : [];
}

async function waitFor(what, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return (Date.now() - t0) / 1000;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${what}`);
}

function launch(file, args) {
  const child = spawn(file, args, { env, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    console.log('     processes:', appProcesses().join(', ') || '(none)');
    failures.push(name);
    ps("Get-Process OfflinePDFEditor -ErrorAction SilentlyContinue | Stop-Process -Force");
    await sleep(2000);
  }
}

async function closeAndCheck(label) {
  const t0 = Date.now();
  ps("Get-Process OfflinePDFEditor -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }");
  const secs = await waitFor(`${label}: all app processes gone`, () => appProcesses().length === 0, 30_000);
  console.log(`     ${label}: closed, every process gone after ${((Date.now() - t0) / 1000).toFixed(1)}s (${secs.toFixed(1)}s polling)`);
}

async function main() {
  if (!fs.existsSync(exe)) throw new Error(`not found: ${exe}`);
  // a small sample document, made with the bundled engine
  const pdf = path.join(work, 'sample.pdf');
  const py = path.join(path.dirname(exe), 'resources', 'python', 'python.exe');
  execFileSync(py, ['-c', `import pymupdf as f\nd=f.open()\nfor i in range(30):\n  p=d.new_page(); p.insert_text((72,72), f"Page {i+1}", fontsize=24)\nd.save(r"${pdf}")`]);

  if (appProcesses().length) throw new Error(`app already running: ${appProcesses().join(', ')}`);

  await step('first start shows a window', async () => {
    launch(exe, [pdf]);
    const s = await waitFor('window visible', () => visibleWindows().length > 0, 120_000);
    console.log(`     first start: window visible after ${s.toFixed(1)}s`);
    await waitFor('engine started', () => appProcesses().some((p) => p.endsWith('python.exe')), 60_000);
    await sleep(5000); // let the document open
  });
  await step('closing leaves no process behind', () => closeAndCheck('close 1'));

  await step('starting again after closing shows a window', async () => {
    launch(exe, [pdf]);
    const s = await waitFor('window visible again', () => visibleWindows().length > 0, 120_000);
    console.log(`     second start: window visible after ${s.toFixed(1)}s`);
    await sleep(5000);
  });

  await step('starting again while the app is still running focuses it (one window)', async () => {
    launch(exe, []);
    await sleep(4000);
    const wins = visibleWindows();
    if (wins.length !== 1) throw new Error(`expected 1 window, found ${wins.length}`);
  });

  await step('starting again while the app is closing opens it again', async () => {
    ps("Get-Process OfflinePDFEditor -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }");
    await sleep(150);
    launch(exe, []);
    const s = await waitFor('window visible after relaunch', () => visibleWindows().length > 0, 60_000);
    console.log(`     relaunch during close: window visible after ${s.toFixed(1)}s`);
    await sleep(4000);
  });
  await step('closing again leaves no process behind', () => closeAndCheck('close 2'));

  if (portable && fs.existsSync(portable)) {
    for (const n of [1, 2]) {
      await step(`portable start ${n} shows a window`, async () => {
        launch(portable, [pdf]);
        const s = await waitFor('portable window visible', () => visibleWindows().length > 0, 240_000);
        console.log(`     portable start ${n}: window visible after ${s.toFixed(1)}s (includes self-extraction)`);
        await sleep(5000);
      });
      await step(`portable close ${n} leaves no process behind`, () => closeAndCheck(`portable close ${n}`));
      await sleep(3000); // the portable launcher removes its extracted copy
    }
  }

  fs.rmSync(work, { recursive: true, force: true });
  if (failures.length) {
    console.log(`\n${failures.length} lifecycle check(s) failed`);
    process.exit(1);
  }
  console.log('\nall lifecycle checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
