# Development progress & phase reports

Status legend: ✅ done and tested · 🟡 partial · ⬜ not started

| Phase | Status |
|---|---|
| 1 Foundation | ✅ |
| 2 Document management | ✅ |
| 3 Overlay editor | ✅ |
| 4 Direct text editor | ✅ |
| 5 Annotations | ✅ |
| 6 OCR / conversion / compression / security / signatures / redaction | ✅ |
| 7 Packaging & finalization | ✅ (Windows installer must be built and smoke-tested on Windows; see Phase 7) |

How to run all tests:

```
backend/.venv/bin/python -m pytest tests/backend -q      # backend (pytest)
npx vitest run                                            # frontend unit tests
npm run build && xvfb-run -a node tests/integration/run-e2e.mjs            # E2E (real Electron app)
node tests/integration/run-e2e.mjs --offline              # E2E inside a network namespace with NO network (Linux, root)
```

---

## Phase 1 – Foundation ✅

**Completed features**
- Electron main process: single instance, hardened window (contextIsolation, no nodeIntegration, renderer sandbox, no webview, devtools disabled when packaged), custom title bar.
- Managed Python backend (FastAPI/uvicorn) on 127.0.0.1 with random port and per-launch 256-bit token (env var, never argv); readiness (`ready` line + `/health` poll); crash detection, exponential backoff restart, re-attachment of open document sessions; parent-death watchdog (no orphan process); shutdown on quit.
- Secure IPC: explicit allowlist of operations (`electron/ipc/ops.ts`) with strict zod schemas; renderer never sends file paths — only opaque file tokens issued by native dialogs / validated drag & drop / recent list; IPC sender origin check.
- Privacy: renderer network blocked (webRequest + CSP), permissions denied, navigation/new windows blocked, spellchecker download disabled, DNS prefetch disabled, external links only after confirmation.
- Custom protocols: `app://` (renderer), `appdoc://doc/<id>/<rev>` (immutable working-copy revisions with HTTP Range support), `appdoc://asset/<id>`.
- Document Session Manager (`backend/services/document_manager.py`): per-document id, original path, revision files (working copies), serialised mutations (command queue), validation of every produced PDF with MuPDF **and** qpdf, redo truncation, pruning, `session.json` for crash recovery (no secrets written).
- Atomic save: temp file in destination folder → optional AES-256 encryption → dual validation → backup to local backups folder → `os.replace` → re-validation with restore on failure.
- React shell: menu bar (File/Edit/View/Document/Page/Comment/Convert/Protect/Tools/Help), ribbon (Home/Edit/Organize/Comment/Convert/Protect), document tabs, collapsible/resizable left sidebar, properties panel, status bar (page, total, zoom, size, save status, mode, engine state), light & dark themes.
- PDF.js viewer: local worker/CMaps/fonts/wasm, range-based lazy loading, virtualised page list (only pages near the viewport are mounted), prioritised render queue, canvas double buffering and release, high-resolution detail tile for deep zoom, text layer (selection/copy), links, search highlights, continuous/single/two-page modes, fit width/page, Ctrl+wheel zoom around cursor, hand tool.
- Open (dialog, drag & drop, command line / file association, recent files), password prompt, damaged-file repair warning, permission-restricted documents opened read-only until unlocked with the owner password, Save, Save As, close with unsaved-changes prompt, crash recovery dialog, autosave of recovery state, printing via the OS print dialog.
- Text engine foundation: HarfBuzz shaping, font fallback, Thai-aware line breaking, Type0/CIDFontType2 embedding with per-occurrence CIDs and correct ToUnicode (Thai extracts correctly in MuPDF and pypdf).

**Tests performed / results**
- Backend pytest: 30 passed (open/encrypted/restricted/corrupted/500 pages, revisions, atomic save verified with pypdf + pikepdf, encryption round-trip, recovery, auth middleware).
- Frontend vitest: 7 passed (coordinate conversion round-trips for all rotations, zooms and offset crop boxes; layout; zoom steps).
- E2E (real Electron app under Xvfb): 22/22 passed online **and** offline (network namespace without any network interface except loopback).

**Known limitations**
- Thai line wrapping uses syllable heuristics (no dictionary yet) – may break inside words when wrapping long lines.
- Text selection uses PDF.js; ActualText spans are not used by PDF.js for decomposed Thai SARA AM clusters (MuPDF search is used by the app's own Find).

## Phase 2 – Document management ✅

**Completed features**: multiple tabs (drag to reorder, middle-click close, dirty markers), recent files, page thumbnails with content-addressed cache (reorders/undo never re-render unchanged pages), page organizer (grid, Ctrl/Shift multi-select, dnd-kit drag & drop), delete / rotate / reorder / move / duplicate / reverse / insert blank / insert from file (password aware) / crop / reset crop / resize (fit/stretch/center) / extract / copy & paste pages between documents / move pages to another document, merge (drag-ordered list, page ranges, passwords, bookmarks per file), split (every N, ranges, bookmarks, max size), images → PDF (A4/Letter/image size, margins, multi-page TIFF), bookmarks panel (navigate, add, rename, delete), attachments panel (add, save, delete), layers panel (optional content visibility).

**Tests**: backend `tests/backend/test_pages.py` (all page operations verified with pypdf); E2E phase2 suite (organizer multi-select, insert, drag reorder + save verified with pypdf, cross-document paste, extract, split, merge, images → PDF).

**Known limitations**: annotations on pages that are *resized* are not carried over (flatten them first); cropping hides content without deleting it.

## Phase 3 – Overlay editor ✅

**Completed features**
- Structured overlay model (`src/types/editor.ts`) in PDF user space: text boxes, images, rectangles, ellipses, lines, arrows, links; per-object rotation, opacity, lock.
- Creation tools: Add Text (click or drag; upright on rotated pages), Add Image (file dialog or paste from clipboard), shapes (Shift = square/45°), Add Link (URL or page).
- Selection & transforms: click / Shift / Ctrl multi-select, move with snapping guides (page edges & centre, other objects; Alt disables), 8 resize handles computed in the object's rotated frame (aspect lock for images, Shift for others), rotate handle (Shift = 15° steps, magnet at 0/90/180/270), line endpoint editing, arrow-key nudge (Shift = 10 pt), duplicate, copy/cut/paste (also across pages/documents), delete, select all, z-order (front/back/forward/backward).
- In-place text editing with auto-growing boxes; properties panel: font (local + bundled fonts), size, colour, bold/italic/underline/strike, alignment incl. justify, line & character spacing, fill, border, padding, position/size, rotation, opacity, image crop (cropped pixels removed from the file), flip, replace, reset aspect, link target.
- **Edit Images**: existing PDF images can be detached into editable image objects (original pixels + alpha preserved, placement/rotation/flip derived from the image matrix), moved/resized/rotated/cropped/replaced/deleted and written back on save; shared images are refused with an explanation.
- Rendering into the PDF (`backend/services/overlay_editor.py` + `pdf_writer.py`): real text with embedded subset fonts (HarfBuzz shaping, Thai correct), vector shapes, image XObjects with soft masks, ExtGState opacity, Link annotations (only http/https/mailto allowed). WYSIWYG: the editor measures its own line breaks and the backend reproduces them exactly.
- Flatten objects into the page (undoable), objects otherwise stay editable through the whole session (saved files contain them as content).

**Tests**: backend `tests/backend/test_overlays.py` (9 tests: positions with offset crop boxes and rotated pages, Thai text extraction, rotated/styled text, explicit line breaks, image crop/alpha/JPEG pass-through, shapes, links incl. rejected `javascript:`, flatten + undo, invalid objects, existing image detach round trip); frontend `tests/frontend/overlay-model.test.ts`; E2E phase3 suite (9 tests incl. saved-position verification with MuPDF and pypdf).

**Known limitations**: thumbnails show the page without unsaved overlay objects; images used several times in a document cannot be edited individually.

## Phase 4 – Direct Text Editing Engine ✅

**Completed features**
- Text object extraction (blocks → lines → spans → glyphs) with geometry in PDF space, style (font, size, colour, bold/italic), font embedding status (embedded / subset / standard / missing / Type 3), invisible (OCR layer) detection, scanned page detection.
- Direct Edit mode: hover highlight, click to select, double-click to edit in place, drag to reposition, drag the right edge to reflow a paragraph, delete; formatting via the properties panel (font, size, colour, bold, italic, underline, strikethrough, alignment, line and character spacing).
- Safe replacement workflow (`backend/services/direct_text_editor.py`): analyse target & surroundings → detect collateral glyphs, invisible text, Type 3 fonts, image/graphics overlap, overflow vs. neighbouring content (optional shrink-to-fit) → plan the font → **remove only the original glyphs** (glyph-level redaction without fill; zero-width Thai marks handled) → write HarfBuzz-shaped text at the original baseline or reflowed in the paragraph box → verify by extraction (new text present, old text gone, every other line intact) → before/after preview → user confirmation → new revision (undoable). Nothing is written without confirmation; caution-level edits require explicit "Apply anyway"; unsupported cases are blocked and the explicit **Use Overlay mode instead** fallback is offered.
- Font handling: reuse of the original embedded font program when it contains every needed glyph (cmap rebuilt from the PDF ToUnicode/CIDToGIDMap; glyphs whose outlines were stripped by subsetting are detected), otherwise the same font installed locally, otherwise a metric-compatible substitute (Helvetica→Liberation Sans/Arial, Times→Liberation Serif, Courier→Liberation Mono, Angsana/Cordia/TH Sarabun→Sarabun …) with a visible warning; users can pick another font in the preview. Bundled OFL fonts: Sarabun, Noto Sans/Serif/Sans Thai/Serif Thai, Liberation Sans/Serif/Mono.
- Thai: HarfBuzz shaping (tone marks, upper/lower vowels, SARA AM), correct ToUnicode/ActualText so text stays searchable, dictionary-based word segmentation (ICU Thai word list) for line breaking, never splitting grapheme clusters.

**Tests**: `tests/backend/test_direct_text.py` (10: standard font with confirmation, embedded subset reuse and fallback, Thai shaping/extraction, combining marks fully replaced, background preserved with pixel check, delete & move, paragraph reflow, collateral/invisible/stale selection detection, overflow & shrink), `tests/backend/test_text_layout.py` (3); E2E phase4 (9: edit + save verified with pypdf, delete, formatting via panel verified with MuPDF span sizes/fonts, drag move, undo, mode switching keeps overlay objects, Thai edit, scanned page guidance).

**Known limitations**
- CFF (Type 1C) and Type 1 embedded fonts are not reused; a matching local font or metric-compatible substitute is used (with a warning).
- Vertical (CJK vertical writing) text and rotated multi-line paragraphs are edited line by line.
- Kerning/ligatures follow the font's shaping tables; text drawn character-by-character with custom spacing in the source may reflow slightly differently.

## Phase 5 – Annotation engine ✅

**Completed features**: highlight / underline / strikethrough / squiggly by selecting text (native selection feedback, engine computes per-line quads in reading order), sticky notes (icons), text comments (rich-text appearance renders Thai), callouts, freehand ink, rectangle, oval, line, arrow, 14 standard stamps, redaction marks; select / move / resize existing annotations (vector annotations are re-created with transformed vertices), edit contents, colour, fill, opacity, width, icon, line endings; Delete key; Comments sidebar (grouped by page, filter, jump to, delete); author name setting; flatten all comments into page content after a warning (blocked while redaction marks are pending); annotations stay standard PDF annotations with appearance streams so other readers show them; permission-aware (documents restricted against editing but allowing comments still accept comments).

**Tests**: `tests/backend/test_annotations.py` (5: markup from selection points, all types + save verified with pypdf incl. appearance streams and Thai contents, edit/move/resize/delete, flatten, document-wide listing); E2E phase5 (8).

**Known limitations**: replies/threads and review status are not implemented; markup annotations cannot be moved (re-create them instead).

## Phase 6 – Advanced processing ✅

**Completed features**
- **OCR** (Tesseract 5, bundled Thai + English `tessdata_fast` models): page scope (all / current / scanned only / ranges), language, quality (200/300/400 dpi), progress + cancel (separate process), per-line confidence review with inline correction, invisible correctly-encoded text layer over the untouched scan (searchable PDF, selectable text), undoable.
- **Conversion** (all local): PDF → Word (pdf2docx), Excel (table detection; text rows fallback), PowerPoint (exact picture or editable text over a text-free background), PNG/JPEG (dpi/quality), text (UTF-8), image extraction (original formats, alpha preserved); images → PDF (Phase 2). Each dialog explains the layout limitations.
- **Compression**: Low (lossless structure), Recommended (150 dpi, JPEG q75, font subsetting), High (96 dpi, q55, metadata removed); exact resulting size shown before anything changes; apply as an undoable revision or save as a copy; never returns a bigger file.
- **Security**: AES-256 open password and/or permissions password with print / high-quality print / copy / modify / comment / forms / page assembly restrictions (pikepdf/qpdf); protection of opened encrypted files is preserved on save by default; removal only with full (owner) access; unlock editing of restricted documents with the owner password.
- **Watermarks**: text (any installed font, Thai supported) or image; opacity, rotation, centre/top/bottom/tiled, page ranges, behind or over content; placed in an optional-content layer "Watermark" and tagged as a pagination artifact.
- **Redaction**: mark areas (tool) or search & redact (text or patterns: e-mail, phone, Thai national ID, credit card, dates); apply removes text glyphs, image pixels (or whole images) and vector graphics under the marks, optional metadata/XMP/JavaScript/attachment/hidden-text/link sanitising, full file rewrite (no recoverable remnants), verification report (nothing extractable from marked areas; warns if the text still occurs elsewhere unmarked). Separate "Sanitize document" command.
- **Signatures**: Fill & Sign with drawn / typed / image signatures saved locally and placed as objects; Digital ID creation (self-signed X.509, RSA-2048, PKCS#12); digital signing (pyHanko, PAdES, SHA-256, visible or invisible) producing a signed copy that opens in a new tab; offline validation (integrity, coverage, later modifications, signer/issuer/validity/serial, trust status); warning when a signed document is modified.

**Tests**: `tests/backend/test_advanced.py` (12) and the encryption-preservation regression test; E2E phase6 (9).

**Known limitations**
- Signature validation does not check revocation (OCSP/CRL) because the application is offline; trust is reported as "not verified" unless the certificate chains to a trusted root (no trust store management UI yet).
- Saving a signed document after edits rewrites the file (signatures become invalid; the user is warned). Incremental-save signing workflows are not supported.
- Word/Excel/PowerPoint conversions are approximations of the page layout (explained in the dialogs).

---

## Phase 7 – Finalization and Windows packaging ✅

**Completed**
- **Self-contained Windows runtime** (`scripts/prepare-win-runtime.mjs`):
  - CPython 3.13.9 x64 from the official nuget.org package, sha256-pinned,
    with the stdlib trimmed and paths locked by `python313._pth`;
  - pinned `win_amd64` wheels from `backend/requirements.txt`, precompiled to
    hash-based `.pyc`;
  - MSVC runtime DLLs next to `python.exe`;
  - Tesseract 5.5.4 from pinned conda-forge builds. Only the 30 DLLs it
    actually imports are shipped, found by a PE import-table walker, each
    with its licence;
  - a build-time **DLL closure check** of every `.exe`/`.dll`/`.pyd`, which
    fails the build if anything outside Windows itself is unresolved.
- **electron-builder config** (`electron-builder.yml`): NSIS installer
  (per-user, no admin rights, choice of directory, shortcuts, `.pdf`
  association) and a portable x64 build. The app archive contains no
  node_modules. Hardened **Electron fuses**: RunAsNode, NODE_OPTIONS and the
  inspector are off; asar integrity is on; the app loads only from the asar.
  There is no publish/update feed, and user data is kept on uninstall.
- **IPC hardening**: raw-path keys rejected anywhere in a payload, a
  job-parameter allow-list, and unit tests (`tests/electron/ipc-ops.test.ts`).
- **Disk budget for undo history**: 2 GB per document as well as the
  60-step limit (`max_revision_bytes`), with a regression test.
- **Shortcut fix**: Ctrl+D duplicates the selected objects and otherwise
  opens Document Properties. Before, Duplicate was unreachable.
- **Documentation**: README, USER_GUIDE, INSTALL, PRIVACY (data flows and
  every on-disk location), ARCHITECTURE, TESTING (requirement-to-test map
  and a Windows release checklist), THIRD_PARTY_NOTICES (licence audit of
  every bundled component), and the installer licence/privacy page.
- **App icon** (`assets/icons/icon.ico`, PNG sizes).

**Files created/modified**: `scripts/prepare-win-runtime.mjs`,
`scripts/make-icons.py`, `electron-builder.yml`, `backend/requirements*.txt`,
`assets/installer/license.txt`, `assets/icons/*`, `tests/perf/bench_large.py`,
`tests/electron/ipc-ops.test.ts`, `electron/ipc/ops.ts`, `electron/main.ts`
(AppUserModelID), `src/app/shortcuts.ts`,
`backend/services/document_manager.py`, `backend/core/config.py`,
`tsconfig.electron.json`, `vite.config.ts`, all docs.

**Tests performed and results**

| Check | Result |
|---|---|
| Backend pytest | 71 passed |
| Frontend/Electron vitest | 18 passed |
| Typecheck (renderer + Electron) | clean |
| **Full E2E suite, offline** (network namespace with loopback only) | **57/57 passed** |
| Packaged Linux build (`electron-builder --linux dir`), launched from the binary | PDF opened from argv, Thai text layer correct, backend started from `resources/`, OCR available, external `fetch` blocked |
| Fuses read back from the packaged binary | all as configured |
| `electron-builder --win dir --x64` (real Windows app folder) | built: `OfflinePDFEditor.exe` with version info, icon and asar-integrity resource, fuses applied, bundled `resources/python` and `resources/assets/ocr/tesseract`; 970 MB unpacked, 261 MB LZMA payload |
| DLL closure of the Windows runtime | 109 Python binaries plus tesseract.exe with 30 DLLs, all resolved |
| Windows wheel availability (PyPI, `win_amd64`, cp313) | all 59 packages available as binary wheels |
| Large scan benchmark (`tests/perf/bench_large.py`, 200 pages, 65 MB of unique JPEG pages) | open 244 ms · analysis 334 ms · render a page 78 ms · rotate 293 ms · delete 10 pages 280 ms · undo 95 ms · save-as 139 ms |

**Known limitations**
- **The NSIS installer and portable `.exe` were not produced in the
  development container.** electron-builder needs Wine to build the
  uninstaller on Linux, and Wine segfaults in this sandbox's kernel, even on
  `wineboot`. The full Windows app folder was built and inspected, but it has
  **not been run on real Windows**. Run `npm run dist:win` on a Windows
  machine (no Wine needed there) and follow the release checklist in
  [TESTING.md](TESTING.md).
- **Licensing**: PyMuPDF/MuPDF is AGPL-3.0. Distributing the app requires AGPL
  compliance or a commercial licence from Artifex (see THIRD_PARTY_NOTICES).
- The installer is large (about 260 MB) because of the bundled scientific
  stack. pdf2docx pulls in OpenCV, and PyMuPDF 2.x pulls in onnxruntime.
- Builds are unsigned until `CSC_LINK`/`CSC_KEY_PASSWORD` are provided, so
  SmartScreen warns on first run.
- Tesseract links libcurl (a conda-forge build choice). The app only passes
  local files to it.
- The HawkScan DAST scan could not run: no `HAWK_API_KEY` in this
  environment. The app exposes no web server beyond the token-protected
  loopback backend.

---

## Phase 8 – Thai interface, forms, page marks, batch, compare ✅

**Completed**
- **Thai / English interface.** 1,236 translated strings covering menus,
  ribbon, dialogs, messages and backend errors. Native dialogs are translated
  too. On first start the language follows the Windows locale. Switching in
  Preferences applies immediately and keeps open documents. An AST codemod
  and an extractor keep the catalogue complete; a unit test enforces it.
- **Forms (AcroForm).**
  - Fill text, check box, radio, dropdown (including editable), list
    (multi-select) and comb/password/multi-line fields.
  - Create every field type, rename, move/resize, edit options and flags,
    delete, reset, and flatten.
  - Sign an empty signature field with a Digital ID.
  - Restricted documents that allow form filling can be filled without the
    owner password.
  - Appearances are generated with our text engine (Thai correct in every
    reader).
  - Hybrid XFA forms are filled through their AcroForm part; the XFA part is
    removed.
- **Header & footer / page numbers / Bates numbering.**
  - Six positions; tokens for page, last page, date, file name and Bates.
  - Thai dates (Buddhist era), Thai digits, page ranges, start number.
  - Correct placement on rotated pages.
  - Applying again replaces the previous version; Remove deletes it. Marked
    as pagination artifacts.
- **Batch processing** (background job with progress and cancel): compress,
  OCR scanned pages, page/Bates numbers continuing across files, watermark,
  password, sanitize, flatten, convert to Word. Originals are never
  modified, outputs never overwritten, and errors are reported per file.
- **Compare documents.** Two-level diff: lines, then words, with Thai
  dictionary word segmentation. It produces a side-by-side comparison PDF
  with red/green highlights and a clickable change list. 100 pages take
  about 6 s.
- **Fixes found on the way.**
  - Operation results could overwrite document info keys; there is now a
    guard that fails loudly.
  - The ribbon now re-renders when form data loads.
  - Ctrl+D shortcut conflict (Phase 7).
  - E2E failures now save a screenshot automatically.

**Tests**: backend pytest **87 passed** (forms 7, header/footer 4, batch 3,
compare 2 new); vitest **25 passed** (i18n catalogue, IPC rules for the new
operations); typecheck clean; **full E2E suite offline: 72/72 passed**
(new suites `forms`, `marks`, `i18n`).

**Known limitations**
- Form field appearances ignore a widget's own `/MK /R` rotation (rare).
  JavaScript actions and calculations in forms are not executed: the app
  does not run document scripts, by design.
- Comparison covers text only (not images or formatting). A moved
  paragraph shows as deleted plus inserted.
- Batch "Convert to Word" uses the same engine as single conversion.
  Complex layouts may need manual adjustment.

---

## Licence change: open source (AGPL-3.0-or-later) ✅

- The application is now licensed under **GNU AGPL-3.0-or-later** (`LICENSE`,
  `package.json`). That matches PyMuPDF/MuPDF's AGPL licence, so no
  commercial licence is needed.
- Every build ships the complete corresponding source code
  (`resources/source/offline-pdf-editor-<version>-source.zip`, created by
  `scripts/make-source-archive.py` during `npm run dist:win`) and the licence
  text (`resources/LICENSE`). Verified in a packaged build.
- The About dialog shows the copyright, the licence and no-warranty notice
  (in Thai and English), with a *Source code & licence* button.
- README, THIRD_PARTY_NOTICES, INSTALL and the installer licence page have
  been updated.
