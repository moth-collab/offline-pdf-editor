// Collects the open-source fonts (and, with --ocr, Tesseract language data)
// that are bundled with the application. Fonts are copied from the build
// machine's system font folders when present, otherwise downloaded once from
// the upstream repositories. All bundled fonts are under SIL OFL 1.1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.join(ROOT, 'assets/fonts');
const OCR = path.join(ROOT, 'assets/ocr/tessdata');
const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl';

const fonts = [
  // Thai + Latin (TH Sarabun New compatible design)
  ...['Regular', 'Bold', 'Italic', 'BoldItalic'].map((s) => ({ file: `Sarabun-${s}.ttf`, url: `${GF}/sarabun/Sarabun-${s}.ttf` })),
  // metric compatible with Arial / Times New Roman / Courier New
  ...['Sans', 'Serif', 'Mono'].flatMap((f) =>
    ['Regular', 'Bold', 'Italic', 'BoldItalic'].map((s) => ({ file: `Liberation${f}-${s}.ttf`, system: [`/usr/share/fonts/truetype/liberation2/Liberation${f}-${s}.ttf`, `/usr/share/fonts/truetype/liberation/Liberation${f}-${s}.ttf`] })),
  ),
  // Noto
  ...['NotoSans-Regular', 'NotoSans-Bold', 'NotoSans-Italic', 'NotoSans-BoldItalic', 'NotoSerif-Regular', 'NotoSerif-Bold', 'NotoSerif-Italic', 'NotoSansThai-Regular', 'NotoSansThai-Bold', 'NotoSerifThai-Regular', 'NotoSerifThai-Bold'].map((n) => ({
    file: `${n}.ttf`,
    system: [`/usr/share/fonts/truetype/noto/${n}.ttf`],
  })),
];

const licenses = [
  { file: 'OFL-Sarabun.txt', url: `${GF}/sarabun/OFL.txt` },
  { file: 'LICENSE-Liberation.txt', system: ['/usr/share/doc/fonts-liberation2/copyright', '/usr/share/doc/fonts-liberation/copyright'] },
  { file: 'LICENSE-Noto.txt', system: ['/usr/share/doc/fonts-noto-core/copyright'] },
];

const tessdata = ['eng', 'tha', 'osd'].map((l) => ({ file: `${l}.traineddata`, url: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${l}.traineddata`, system: [`/usr/share/tesseract-ocr/5/tessdata/${l}.traineddata`] }));

async function fetchTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function collect(items, dir, { preferDownload = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const it of items) {
    const dest = path.join(dir, it.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const local = (it.system ?? []).find((p) => fs.existsSync(p));
    if (local && !preferDownload) fs.copyFileSync(local, dest);
    else if (it.url) await fetchTo(it.url, dest);
    else if (local) fs.copyFileSync(local, dest);
    else {
      console.warn(`  ! ${it.file}: no source available on this machine`);
      continue;
    }
    console.log(`  + ${it.file} (${fs.statSync(dest).size} bytes)`);
  }
}

console.log('fonts →', FONTS);
await collect(fonts, FONTS);
await collect(licenses, FONTS);
if (process.argv.includes('--ocr')) {
  console.log('tessdata →', OCR);
  // tessdata_fast models: small and accurate for printed Thai/English
  await collect(tessdata, OCR, { preferDownload: true });
}
// sanity check: every font must parse as a TrueType/OpenType file
for (const f of fs.readdirSync(FONTS).filter((n) => n.endsWith('.ttf'))) {
  const head = fs.readFileSync(path.join(FONTS, f)).subarray(0, 4);
  const ok = head.equals(Buffer.from([0, 1, 0, 0])) || head.toString('latin1') === 'OTTO' || head.toString('latin1') === 'true';
  if (!ok) throw new Error(`${f} is not a font file`);
}
console.log('assets ready');
