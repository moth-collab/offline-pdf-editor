#!/usr/bin/env node
/**
 * Codemod: wraps user-visible English UI strings in `tr()` (src/i18n).
 *
 * Only *safe* contexts are rewritten, so program logic is never affected:
 *   - JSX text
 *   - string / template values of UI attributes (title, label, placeholder, …)
 *   - string arguments of UI functions (toast, row, runOp labels, dialogs, …)
 *   - `label` / `title` / `message` / … properties of object literals inside
 *     functions (module-level registries are translated where they render)
 * Template literals become tr('Text {0} more', a) so translators see whole
 * sentences. Idempotent: already wrapped strings are left alone.
 *
 * Usage: node scripts/i18n-wrap.mjs [--check] [files...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');

const UI_ATTRS = new Set([
  'title', 'label', 'placeholder', 'aria-label', 'description', 'content', 'hint', 'message', 'detail',
  'confirmLabel', 'cancelLabel', 'okLabel', 'heading', 'subtitle', 'emptyText', 'helpText', 'caption', 'alt', 'tooltip',
]);
const UI_PROPS = new Set(['label', 'title', 'message', 'detail', 'description', 'placeholder', 'content', 'hint', 'tooltip', 'confirmLabel', 'cancelLabel', 'okLabel', 'buttons', 'heading', 'caption']);
// function name -> which arguments carry UI text ('all' = every capitalised string arg)
const UI_CALLS = new Map([
  ['toast', 'all'], ['row', 'all'], ['runOp', 'all'], ['commitOverlays', 'all'], ['apply', 'all'], ['set', 'all'],
  ['askText', 'all'], ['askConfirm', 'all'], ['askChoice', 'all'], ['setBusy', 'all'], ['commitLive', 'all'], ['updateAnnot', 'all'],
  ['addAnnot', 'all'], ['open', 'all'], ['save', 'all'], ['folder', 'all'], ['message', 'all'], ['Error', 'all'],
  ['runJob', 'all'], ['confirmDialog', 'all'], ['notify', 'all'], ['section', 'all'], ['field', 'all'], ['JobCancelled', 'all'],
  ['warnIfSigned', 'all'], ['withBusy', 'all'], ['busy', 'all'], ['ApiException', 'all'], ['prompt', 'all'],
]);

const looksHuman = (s) => /[A-Za-z]/.test(s) && /^[\s(“"'…]*[A-Z0-9]/.test(s) && !/^[A-Z0-9_]+$/.test(s.trim()) && !/^[\w.-]+\.(pdf|png|jpe?g|docx|xlsx|pptx|txt|pfx)$/i.test(s) && !/^https?:/.test(s);
const looksHumanLoose = (s) => /[A-Za-z]{2}/.test(s) && !/^[a-z0-9_.:/-]+$/.test(s.trim()) && !/^https?:/.test(s);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}

function isInsideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
  }
  return false;
}

function isAlreadyWrapped(node) {
  const p = node.parent;
  return p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'tr';
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function transformFile(file, check) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];
  const quote = (s) => JSON.stringify(s);

  const wrapExpr = (expr, loose = false) => {
    // string literal / template / conditional / || / ?? branches
    if (!expr || isAlreadyWrapped(expr)) return;
    if (ts.isParenthesizedExpression(expr)) return wrapExpr(expr.expression, loose);
    if (ts.isConditionalExpression(expr)) {
      wrapExpr(expr.whenTrue, loose);
      wrapExpr(expr.whenFalse, loose);
      return;
    }
    if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
      wrapExpr(expr.right, loose);
      return;
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      const s = expr.text;
      if (!(loose ? looksHumanLoose(s) : looksHuman(s))) return;
      edits.push({ start: expr.getStart(sf), end: expr.getEnd(), text: `tr(${quote(s)})` });
      return;
    }
    if (ts.isTemplateExpression(expr)) {
      let key = expr.head.text;
      const args = [];
      expr.templateSpans.forEach((span, i) => {
        key += `{${i}}` + span.literal.text;
        args.push(span.expression.getText(sf));
      });
      if (!/[A-Za-z]{2}/.test(key.replace(/\{\d+\}/g, ''))) return;
      edits.push({ start: expr.getStart(sf), end: expr.getEnd(), text: `tr(${quote(key)}, ${args.join(', ')})` });
    }
  };

  const visit = (node) => {
    // 1. JSX text
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      const trimmed = decodeEntities(raw.replace(/\s+/g, ' ').trim());
      if (/[A-Za-z]{2}/.test(trimmed) && !/^[{}]/.test(trimmed)) {
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        const leadSpace = lead.length && !lead.includes('\n') ? ' ' : '';
        const trailSpace = trail.length && !trail.includes('\n') ? ' ' : '';
        const start = node.getStart(sf) + lead.length;
        const end = node.getEnd() - trail.length;
        edits.push({ start, end, text: `{${leadSpace ? '" " + ' : ''}tr(${quote(trimmed)})${trailSpace ? ' + " "' : ''}}` });
      }
      return;
    }
    // 2. JSX attributes
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (UI_ATTRS.has(name)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) {
          if (looksHumanLoose(init.text)) edits.push({ start: init.getStart(sf), end: init.getEnd(), text: `{tr(${quote(init.text)})}` });
        } else if (ts.isJsxExpression(init) && init.expression) {
          wrapExpr(init.expression, true);
        }
      }
    }
    // JSX children expressions: {cond ? 'A' : 'B'} / {`text ${x}`}
    if (ts.isJsxExpression(node) && node.expression && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      wrapExpr(node.expression, true);
    }
    // 3. UI function calls
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isInsideFunction(node)) {
      const name = calleeName(node);
      if (name && UI_CALLS.has(name)) {
        for (const a of node.arguments ?? []) {
          if (ts.isObjectLiteralExpression(a)) continue; // handled by rule 4
          wrapExpr(a);
        }
      }
    }
    // 4. object literal UI properties inside functions
    if (ts.isPropertyAssignment(node) && isInsideFunction(node)) {
      const key = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : null;
      if (key && UI_PROPS.has(key)) {
        if (ts.isArrayLiteralExpression(node.initializer)) node.initializer.elements.forEach((el) => wrapExpr(el, true));
        else wrapExpr(node.initializer, true);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) return 0;
  // apply from the end; drop overlapping (nested) edits keeping the outer one
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const e of edits) {
    const last = kept[kept.length - 1];
    if (last && e.start < last.end) continue;
    kept.push(e);
  }
  let out = src;
  for (const e of kept.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (!/import \{[^}]*\btr\b[^}]*\} from '@\/i18n'/.test(out)) {
    // insert after the last import
    const imports = [...out.matchAll(/^import [^;]+;\n/gm)];
    const at = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : 0;
    out = out.slice(0, at) + "import { tr } from '@/i18n';\n" + out.slice(at);
  }
  if (!check) fs.writeFileSync(file, out);
  return kept.length;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
let files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(tsx?|)$/.test(e.name) && /\.tsx?$/.test(e.name) ? [p] : [];
    });
  files = walk(path.join(root, 'src')).filter((f) => !f.includes(`${path.sep}i18n${path.sep}`) && !f.endsWith('.d.ts'));
}
let total = 0;
for (const f of files) {
  const n = transformFile(f, check);
  if (n) console.log(`${path.relative(root, f)}: ${n}`);
  total += n;
}
console.log(`${check ? 'would wrap' : 'wrapped'} ${total} strings`);
