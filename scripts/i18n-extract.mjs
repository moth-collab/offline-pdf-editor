#!/usr/bin/env node
/**
 * Lists every UI string that needs a translation:
 *  - first argument of tr("...") calls in src/
 *  - labels of the module-level registries (commands, menus, ribbon, tabs,
 *    option lists) and MODE_LABELS, which are translated where rendered
 *  - static user-facing backend error messages (AppError(..., "message"))
 * Usage: node scripts/i18n-extract.mjs [--missing]   (prints JSON)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');

// tables whose strings are PDF names / identifiers, not UI text
const NON_UI_TABLES = new Set(['STAMPS', 'NOTE_ICONS', 'SHORTCUT_IDS', 'IMAGE_EXT', 'FORBIDDEN_KEYS']);

export function extractKeys() {
  const keys = new Set();
  const walk = (d, re) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return e.name === '.venv' || e.name === '__pycache__' ? [] : walk(p, re);
      return re.test(e.name) ? [p] : [];
    });
  for (const f of walk(path.join(root, 'src'), /\.tsx?$/)) {
    if (f.includes(`${path.sep}i18n${path.sep}`)) continue;
    const src = fs.readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const isModuleLevel = (n) => {
      for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return false;
      return true;
    };
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'tr') {
        const a = n.arguments[0];
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) keys.add(a.text);
      }
      // registry labels: label/title/tooltip properties at module level
      if (ts.isPropertyAssignment(n) && isModuleLevel(n)) {
        const k = n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : '';
        const v = n.initializer;
        if (['label', 'title', 'tooltip', 'description'].includes(k) && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && /[A-Za-z]{2}/.test(v.text)) keys.add(v.text);
      }
      // UPPER_CASE module-level tables of UI text (option lists, status maps, …)
      if (ts.isVariableDeclaration(n) && isModuleLevel(n) && /^[A-Z][A-Z0-9_]+$/.test(n.name.getText(sf)) && !NON_UI_TABLES.has(n.name.getText(sf)) && n.initializer) {
        const collect = (m) => {
          if ((ts.isStringLiteral(m) || ts.isNoSubstitutionTemplateLiteral(m)) && /^[A-Z][a-z]/.test(m.text) && !(m.parent && ts.isPropertyAssignment(m.parent) && m.parent.name === m)) keys.add(m.text);
          ts.forEachChild(m, collect);
        };
        collect(n.initializer);
      }
      // module-level Record<key, [label, ...]> tables (e.g. STATUS_BADGE)
      if (ts.isPropertyAssignment(n) && isModuleLevel(n) && ts.isArrayLiteralExpression(n.initializer)) {
        const first = n.initializer.elements[0];
        if (first && ts.isStringLiteral(first) && /^[A-Z][a-z]/.test(first.text) && n.initializer.elements.length === 2) keys.add(first.text);
      }
      // MODE_LABELS values and other Record<..., string> label maps
      if (ts.isVariableDeclaration(n) && /LABELS?$/.test(n.name.getText(sf)) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
        for (const p of n.initializer.properties) if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) keys.add(p.initializer.text);
      }
      // toolCmd('id', 'Label') helper used by the command registry
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(toolCmd|annotCmd|cmd)$/.test(n.expression.text)) {
        for (const a of n.arguments) if (ts.isStringLiteral(a) && /^[A-Z]/.test(a.text)) keys.add(a.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // backend messages (static strings only)
  for (const f of walk(path.join(root, 'backend'), /\.py$/)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/AppError\(\s*"[a-z_]+",\s*\n?\s*"((?:[^"\\]|\\.)+)"\s*[,)]/g)) keys.add(JSON.parse(`"${m[1]}"`));
    for (const m of src.matchAll(/(?:not_found|Conflict|bad_request)\(\s*"((?:[^"\\]|\\.)+)"\s*[,)]/g)) keys.add(JSON.parse(`"${m[1]}"`));
  }
  return [...keys].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  let keys = extractKeys();
  if (process.argv.includes('--missing')) {
    const th = fs.readFileSync(path.join(root, 'src/i18n/th.ts'), 'utf8');
    const have = new Set([...th.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)].map((m) => JSON.parse(m[1])));
    keys = keys.filter((k) => !have.has(k));
  }
  console.log(JSON.stringify(keys, null, 1));
  console.error(`${keys.length} keys`);
}
