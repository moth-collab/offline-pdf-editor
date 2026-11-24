# Privacy Architecture

Offline PDF Editor is built so that **no document content, metadata or usage
information ever leaves the computer**. This document describes how that is
enforced and lists every place where the application stores data.

## Guarantees

| Guarantee | How it is enforced |
|---|---|
| No uploads, no cloud processing | All PDF processing (editing, OCR, conversion, compression, signing, redaction) runs in the bundled local Python backend and the bundled Tesseract binary. No code path sends document data over the network. |
| No telemetry, analytics or crash reporting | There is no telemetry SDK and the Electron crash reporter is never started. Errors are only shown in the UI and written to the local console. |
| No account, no sign-in, no licence server | There is none. |
| Works with no internet connection | All assets (fonts, OCR language data, PDF.js character maps, Thai dictionary, icons) are bundled. The E2E suite runs inside an isolated network namespace with no external interface (see [TESTING.md](TESTING.md)). |
| No update checks | No auto-updater is included (`publish: null` in `electron-builder.yml`, no `electron-updater` dependency). |
| External links never open silently | Links in documents open in the system browser only after an explicit confirmation (Preferences › Privacy › "Ask before opening web links", on by default). |

## Enforcement layers

1. **Renderer network lockdown** (`electron/security/policy.ts`).
   `session.webRequest.onBeforeRequest` cancels every request whose URL is
   not `app://`, `appdoc://`, `data:`/`blob:` or the per-launch local backend
   on `127.0.0.1`. Blocked attempts are logged locally with the prefix `[privacy]`.
   A strict Content-Security-Policy (`connect-src` limited to the app's own
   schemes and the local backend) is a second barrier.
2. **Chromium background networking disabled.** The app starts with
   `--disable-background-networking`, `--dns-prefetch-disable` and `--no-pings`,
   and with Translate, OptimizationHints and MediaRouter turned off. The
   spell-checker is off and its dictionary download URL points to an
   unroutable address.
3. **All permissions denied.** Camera, microphone, geolocation, notifications
   and similar requests are refused by the session's permission handlers.
4. **Navigation and new windows blocked.** The main window cannot navigate
   away from the app, and `window.open` is denied. External URLs go through
   a confirmation dialog and are then handed to the OS browser.
5. **Local-only backend.** The Python backend binds to `127.0.0.1` on a random
   port. Every request needs a random 256-bit per-launch token, which is passed
   through the child-process environment and never on the command line. The
   backend also rejects requests with a foreign `Host` header and any request
   carrying an `Origin` header, which defeats DNS rebinding and drive-by
   requests from web pages. It has no outbound HTTP client code.
6. **Bundled OCR.** Tesseract runs as a local child process on temporary image
   files in the app's private temp folder. Language data comes from
   `resources/assets/ocr/tessdata`.

## Data stored on disk

Everything lives under the per-user application data folder
(`%APPDATA%\Offline PDF Editor` on Windows), unless stated otherwise.

| Location | Contents | Lifetime |
|---|---|---|
| `sessions/<id>/rev-NNNNNN.pdf` | Working revisions of each open document (undo/redo history) | Deleted when the document is closed normally. Kept after a crash for recovery, then expired after *Recovery retention* days (default 7). |
| `sessions/<id>/session.json`, `ui-state.json` | Original file name and path, revision pointer, unsaved overlay edits (for crash recovery). **Passwords are never stored.** | Same as above. |
| `tmp/` | Short-lived files for OCR, conversion, preview and print | Removed on exit when *Clean temporary files on exit* is on (default), and always at the next start. |
| `cache/` | Font index (font names and paths only) | Rebuilt as needed. It can be cleared at any time. |
| `assets/` | Images inserted into documents and saved signature images (content-addressed copies) | Unreferenced files are removed automatically at start-up once no recovery sessions are pending. |
| `backups/` | When *Keep backup when overwriting* is on (default), the previous version of a file you overwrite with **Save**. The 5 most recent backups of each file name are kept. | You can delete them at any time. |
| `signatures.json` | Index of saved signatures (the images live in `assets/`) | Until you delete them in the signature manager. |
| `settings.json`, `recent.json` | Preferences and the recent-files list (paths only) | *Clear recent files* empties the list. |

Digital IDs (`.pfx` / `.p12`) you create are written only to the location you
choose. Their passwords are never stored.

## Original documents

- Opening a file reads it once into a private working copy. The original is
  never modified while you edit.
- **Save** replaces the original atomically: the app writes a temporary file
  next to it, validates it, then renames it. It keeps a backup first unless you
  turned backups off. **Save As** always writes a new file.
- Compression, OCR, conversion, redaction and signing produce a candidate
  result. You must confirm it, or save it under a new name, before it changes
  anything.

## Verifying offline operation yourself

- Disconnect from the network (or block the app in Windows Firewall). Every
  feature keeps working.
- Run the automated offline suite on Linux:
  `node tests/integration/run-e2e.mjs --offline`. It launches the real app
  inside a network namespace that has only a loopback interface.
