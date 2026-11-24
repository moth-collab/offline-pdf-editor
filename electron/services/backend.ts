/**
 * Supervises the local Python processing backend.
 *
 * - Starts the bundled Python runtime with a random per-launch auth token
 *   (passed via environment, never on the command line).
 * - Waits for the "ready" line and a successful /health check.
 * - Detects crashes and restarts with exponential backoff; open document
 *   sessions are re-attached from their on-disk session folders.
 * - Shuts the process down when the application quits.
 * The backend binds to 127.0.0.1 only.
 */
import { app } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ApiResult, BackendStatus } from '../../shared/types';
import { appPaths } from './paths';

const MAX_RESTARTS = 5;

export class BackendService extends EventEmitter {
  private proc: ChildProcess | null = null;
  private port = 0;
  private token = randomBytes(32).toString('hex');
  private stopping = false;
  private restartTimes: number[] = [];
  private readyPromise: Promise<void> | null = null;
  status: BackendStatus = { state: 'starting', restarts: 0 };
  /** doc ids of sessions to re-attach after a restart */
  readonly openDocs = new Set<string>();
  private stderrTail: string[] = [];

  private setStatus(s: Partial<BackendStatus>) {
    this.status = { ...this.status, ...s };
    this.emit('status', this.status);
  }

  private resolvePython(): { python: string; script: string } {
    const p = appPaths();
    if (app.isPackaged) {
      const python = path.join(p.resources, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
      return { python, script: path.join(p.resources, 'backend', 'main.py') };
    }
    const venv = path.join(p.root, 'backend', '.venv');
    const python =
      process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
    return { python: fs.existsSync(python) ? python : 'python3', script: path.join(p.root, 'backend', 'main.py') };
  }

  start(): Promise<void> {
    this.stopping = false;
    this.readyPromise = this.spawnOnce();
    return this.readyPromise;
  }

  private spawnOnce(): Promise<void> {
    const p = appPaths();
    const { python, script } = this.resolvePython();
    fs.mkdirSync(p.sessions, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: p.temp,
      TMP: p.temp,
      TMPDIR: p.temp,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PATH: process.env.PATH,
      PDFED_TOKEN: this.token,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: app.isPackaged ? '1' : undefined,
      TESSDATA_PREFIX: fs.existsSync(path.join(p.assets, 'ocr', 'tessdata')) ? path.join(p.assets, 'ocr', 'tessdata') : undefined,
    };
    fs.mkdirSync(p.temp, { recursive: true });
    const args = [
      script,
      '--sessions-root', p.sessions,
      '--assets', p.assets,
      '--cache-dir', p.cache,
      '--parent-pid', String(process.pid),
    ];
    this.setStatus({ state: this.status.restarts ? 'restarting' : 'starting' });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(msg));
      };
      const child = spawn(python, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(script) });
      this.proc = child;
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        if (settled) return;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'ready' && Number.isInteger(msg.port)) {
            this.port = msg.port;
            this.waitHealthy()
              .then(() => {
                settled = true;
                this.setStatus({ state: 'ready', message: undefined });
                resolve();
              })
              .catch((e) => fail(String(e)));
          } else if (msg.event === 'error') {
            fail(msg.message);
          }
        } catch {
          /* ignore non JSON output */
        }
      });
      child.stderr!.on('data', (d: Buffer) => {
        const text = d.toString('utf-8');
        this.stderrTail.push(text);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
        if (!app.isPackaged) process.stderr.write(`[backend] ${text}`);
      });
      child.on('error', (err) => fail(`Cannot start the processing engine: ${err.message}`));
      child.on('exit', (code, signal) => {
        this.proc = null;
        if (!settled) fail(`Processing engine exited during startup (code ${code}). ${this.stderrTail.join('').slice(-800)}`);
        else if (!this.stopping) this.handleCrash(code, signal);
      });
      setTimeout(() => fail('Timed out starting the processing engine'), 60_000);
    });
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await this.raw('GET', '/health', undefined, 2000);
        if (r.ok) return;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('The processing engine did not become healthy');
  }

  private handleCrash(code: number | null, signal: NodeJS.Signals | null) {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 120_000);
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.setStatus({ state: 'failed', message: `The processing engine keeps stopping (code ${code ?? signal}).` });
      return;
    }
    this.restartTimes.push(now);
    const delay = 500 * 2 ** (this.restartTimes.length - 1);
    this.setStatus({ state: 'restarting', restarts: this.status.restarts + 1, message: `Restarting processing engine (code ${code ?? signal})` });
    setTimeout(() => {
      this.readyPromise = this.spawnOnce()
        .then(() => this.reattachDocuments())
        .catch((e) => {
          this.setStatus({ state: 'failed', message: String(e) });
        });
    }, delay);
  }

  /** After a restart, reload sessions of documents that were open. */
  private async reattachDocuments() {
    for (const docId of this.openDocs) {
      await this.request('POST', '/recovery/restore', { session_id: docId });
    }
    this.emit('reattached', [...this.openDocs]);
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) throw new Error('Backend not started');
    await this.readyPromise;
  }

  private async raw(method: string, urlPath: string, body?: unknown, timeoutMs = 600_000): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(`http://127.0.0.1:${this.port}${urlPath}`, {
        method,
        headers: { 'X-PDFEd-Token': this.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  async request<T = unknown>(method: string, urlPath: string, body?: unknown, timeoutMs?: number): Promise<ApiResult<T>> {
    try {
      await this.ready();
    } catch (e) {
      return { ok: false, error: { code: 'backend_unavailable', message: String((e as Error).message ?? e) } };
    }
    try {
      const res = await this.raw(method, urlPath, body, timeoutMs);
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const err = json?.error ?? { code: `http_${res.status}`, message: text.slice(0, 300) || res.statusText };
        return { ok: false, error: err };
      }
      return { ok: true, data: json as T };
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'The operation timed out' : String((e as Error).message ?? e);
      return { ok: false, error: { code: 'backend_unreachable', message: msg } };
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(proc, true);
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (!killTree(proc, false)) {
        clearTimeout(timer);
        resolve();
      }
    });
    this.setStatus({ state: 'stopped' });
  }
}

/**
 * Stop the engine together with everything it started (job processes,
 * Tesseract). On Windows, killing only python.exe would leave its children
 * running; they would keep files of the app locked (the portable version then
 * cannot be extracted again) and keep using CPU in the background.
 */
function killTree(proc: ChildProcess, force: boolean): boolean {
  if (proc.exitCode !== null || !proc.pid) return false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
      if (r.status === 0) return true;
      proc.kill();
    } else {
      proc.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

export const backend = new BackendService();
