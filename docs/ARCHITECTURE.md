# Architecture

```
┌──────────────────────────── Electron main process (Node) ───────────────────────────┐
│ main.ts           window, lifecycle, single instance, close handshake, temp cleanup │
│ security/policy   CSP, network lockdown, permission denial, navigation guards        │
│ services/backend  spawns + supervises Python (token, health, crash restart)         │
│ services/fileRegistry  opaque file tokens (renderer never sees raw paths)           │
│ services/protocols     app:// (UI) and appdoc:// (PDF bytes with Range support)     │
│ ipc/handlers + ipc/ops allow-listed, zod-validated operations → backend             │
└───────────────▲──────────────────────────────────────────────┬─────────────────────┘
                │ contextBridge (preload.ts: window.pdfApi)      │ HTTP 127.0.0.1:<random>
┌───────────────┴──────────── Renderer (sandboxed) ──────┐      │ X-PDFEd-Token
│ React 19 + TypeScript + Tailwind + Radix (shadcn-style) │      ▼
│ zustand stores, command registry, ribbon/menus          │ ┌──────────── Python backend (FastAPI) ───────────┐
│ PDF.js viewer (canvas + text layer, lazy render queue)  │ │ api/routes_*      thin HTTP layer               │
│ overlay / text-edit / annotation / tool layers          │ │ services/*        document processing layer     │
│ history (undo/redo snapshots)                           │ │   document_manager  sessions + revisions        │
└─────────────────────────────────────────────────────────┘ │   direct_text_editor, text_layout, pdf_writer   │
                                                            │   overlay_editor, annotations, page_manager     │
                                                            │   ocr (Tesseract), conversion, compression      │
                                                            │   security, redaction, signatures (pyHanko)     │
                                                            │ core/jobs   long tasks in separate processes    │
                                                            └─────────────────────────────────────────────────┘
```

## Processes and trust boundaries

| Process | Privileges | Notes |
|---|---|---|
| Main | Full Node.js | The only component that touches arbitrary file paths, through native dialogs, validated drag-and-drop and the recent list. |
| Renderer | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` | Talks to main only through `window.pdfApi` (preload). The CSP forbids remote content. |
| Backend | Python child process, `127.0.0.1` only | Requires the per-launch token. Rejects `Origin` headers and foreign `Host` headers. Exits when its parent process dies (watchdog). |
| Jobs | Spawned Python processes | OCR, compression and conversion run here so they can be cancelled (terminated) without blocking the backend. |
| Tesseract | Child process of a job | Reads local temp images and writes TSV. |

### IPC contract

- The renderer calls `pdfApi.invoke(op, params)`. Main accepts only operations
  listed in `electron/ipc/ops.ts`. Each one has a strict zod schema, so unknown
  keys are rejected.
- Raw paths are never accepted from the renderer. Any key such as `path`,
  `output_path` or `*_dir`, or anything matching `/(_path|_paths|_dir|_file)$/`,
  is refused (`assertNoRawPaths`). File access goes through opaque tokens that
  main issues (`fileRegistry`): `read` tokens for opened files, `write` tokens
  from a Save dialog, `dir` tokens from a folder picker. Main resolves tokens
  to paths before forwarding to the backend.
- Background-job parameters are checked against an allow-list (`JOB_KEYS`).

## Document model

- **Session.** Opening a PDF creates `sessions/<docId>/`, holding immutable
  revisions `rev-000001.pdf`, `rev-000002.pdf`, …
- **Mutation.** Each operation runs through `DocumentManager.mutate()`, which
  is serialized per document. It writes a new revision, validates it twice
  (MuPDF parse and qpdf/pikepdf structural check), and only then advances the
  revision pointer. A failed validation leaves the document untouched.
- **Undo/redo.** The frontend history stores snapshots of
  `{revision, overlays, pageVersions}`. Undo moves the backend revision pointer
  and restores the overlay state. A new operation truncates the redo branch.
  Revisions are pruned beyond the configured limit (default 60).
- **Overlays.** Text boxes, images, shapes and links stay editable objects
  (stored in `ui-state.json`) until saved. Saving bakes them into the page
  content stream as real text, with embedded subset fonts, so they stay
  searchable and selectable. Watermarks go into their own Optional Content
  Group ("Watermark"), marked as artifacts.
- **Saving.** `saving.build_output()` bakes overlays and re-applies the
  original encryption (owner and user passwords are preserved when known). It
  writes atomically: temp file, validate, back up the previous file, rename,
  re-validate. If the final step fails, the backup is restored.
- **Recovery.** After a crash, a session folder still present at start-up is
  offered in the Recovery dialog. The backend can also restart on its own
  (exponential backoff, up to 5 times in 2 minutes); main re-attaches open
  sessions through `/recovery/restore`.

## Coordinate contract

All API geometry is in **PDF user space** (y up, unrotated page). Converting to
MuPDF's top-left CropBox space happens in exactly one place
(`backend/core/coords.py`). Converting to screen pixels, including rotation
0/90/180/270 and zoom, happens in exactly one place
(`src/features/viewer/geometry.ts`, unit-tested).

## Text engine (direct editing)

1. `text_extraction` returns text objects (lines/blocks) with glyph boxes,
   fonts, colours and the font resource each run uses.
2. Font plan, in order of preference:
   - the **original embedded font**: its cmap is rebuilt from ToUnicode and
     CIDToGIDMap, and every required glyph must have an outline;
   - a matching **local font**;
   - a **metric-compatible substitute** (e.g. Arial → Liberation Sans);
   - a script **fallback** (Thai → Sarabun / Noto Sans Thai).

   Anything other than the original font produces a warning, which the user
   must accept.
3. Layout: HarfBuzz shaping (`uharfbuzz`), script itemization with per-run
   fallback, ICU-dictionary Thai word segmentation for line breaking, and
   cluster mapping for correct caret and ActualText.
4. Removal: glyph-level redaction of only the edited glyphs. It uses centred
   core boxes, does not fill, and leaves images and vector graphics untouched,
   so **no white boxes** appear. Zero-width Thai marks use degenerate boxes so
   no orphaned tone marks remain.
5. Writing: Type0/CIDFontType2 with per-occurrence CIDs, CIDToGIDMap and
   ToUnicode (copy/paste and search keep working). ActualText covers
   multi-glyph clusters. Fonts are subset with fontTools (`retain_gids`).
6. Preview first: the edit is rendered on a single-page copy for user
   confirmation. After applying, the text is extracted again and compared with
   the request.

## Localisation (Thai / English)

UI strings are English source text wrapped in `tr()` (`src/i18n`). The Thai
catalogue (`src/i18n/th.ts`) is keyed by that text; a missing entry falls
back to English. Module-level registries (commands, menus, ribbon) are
translated where they are rendered. `scripts/i18n-wrap.mjs` (an AST codemod)
wraps new UI strings in `tr()`, `scripts/i18n-extract.mjs` lists every key,
and a unit test fails when any key lacks a Thai translation. The few native
dialogs created by the main process use `electron/i18n.ts`.

## Forms

`backend/services/forms.py` works directly on the AcroForm with pikepdf.
Field appearances (`/AP`) for text and choice fields are generated with the
same HarfBuzz text engine as direct editing, so Thai values display in every
viewer. When a value needs non-Latin glyphs, the field's `/DA` points at the
embedded font, registered in `/AcroForm /DR`. Widget ids are positional
(`w<field>_<widget>`), because object numbers change whenever a revision is
written. Form operations from the UI are queued per document, so quick
successive entries never conflict.

## Long-running work

OCR, compression and conversion are jobs (`core/jobs.py`). Each runs in a
spawned process, reports progress, can be cancelled, and writes its output to
a *candidate* file. The user then commits the candidate into the session or
saves it as a new file. The original is never changed implicitly.

## Packaging layout (Windows)

```
Offline PDF Editor\
  OfflinePDFEditor.exe            Electron (fuses: no RunAsNode, no NODE_OPTIONS,
                                  no inspector, asar integrity, app only from asar)
  resources\app.asar              renderer (dist/) + main/preload (dist-electron/)
  resources\backend\              Python sources
  resources\python\               CPython 3.13 + site-packages (._pth-isolated)
  resources\assets\fonts\         bundled fonts + licences
  resources\assets\ocr\tessdata\  eng, tha, osd
  resources\assets\ocr\tesseract\ tesseract.exe + DLLs + licences
  resources\assets\dicts\         Thai dictionary (ICU)
```
